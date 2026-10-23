import type {
  AssetRecord,
  AssetStatus,
  AssetPackageManifest,
  AssetStoreOptions,
  IngestOptions,
} from './types';
export type { AssetStoreOptions, IngestOptions };
import { parseImageMetadata } from './metadata';
import { exportPackageManifestImpl } from './package-export';
import { validateMetadataUpdate } from './validator';
import {
  bytesToBase64,
  hashBytes,
  createReadOnlyRecordView,
  createBlobUrl,
  cleanUpBlobUrl,
  STATUS_RANKS,
  type InternalAssetRecord,
} from './helpers';
export { bytesToBase64, hashBytes };

export class AssetStore {
  private records = new Map<string, InternalAssetRecord>();
  private lockedRecords = new Map<string, InternalAssetRecord>();
  private binaryData = new Map<string, Uint8Array>();
  private hashToId = new Map<string, string>();
  private transitionHistory = new Map<string, AssetStatus[]>();
  private removedIds = new Set<string>();
  private accessOrder: string[] = [];
  private inFlightIngests = new Map<string, Promise<AssetRecord>>();
  private inFlightRecords = new Map<string, InternalAssetRecord>();
  private generation = 0;

  private maxEntries: number;
  private maxBytes: number;
  private currentBytes = 0;

  constructor(options: AssetStoreOptions = {}) {
    this.maxEntries = options.maxEntries ?? 200;
    this.maxBytes = options.maxBytes ?? 100 * 1024 * 1024;
  }

  public get(id: string): AssetRecord | undefined {
    const record = this.records.get(id);
    if (record) {
      this.touch(id);
      return createReadOnlyRecordView(record);
    }
    return undefined;
  }

  public getByUri(uri: string): AssetRecord | undefined {
    const id = uri.startsWith('morph-asset://') ? uri.replace('morph-asset://', '') : uri;
    return this.get(id);
  }

  public getByBlobUrl(blobUrl: string): AssetRecord | undefined {
    for (const record of this.records.values()) {
      if (record.blobUrl === blobUrl) {
        return createReadOnlyRecordView(record);
      }
    }
    return undefined;
  }

  public has(id: string): boolean {
    return this.records.has(id);
  }

  public getBinary(id: string): Uint8Array | undefined {
    const buf = this.binaryData.get(id);
    return buf ? buf.slice() : undefined;
  }

  public getTransitionHistory(id: string): AssetStatus[] {
    return [...(this.transitionHistory.get(id) || [])];
  }

  public retain(id: string): void {
    const record = this.records.get(id);
    if (record) {
      record.refCount++;
    }
  }

  public release(id: string): void {
    const record = this.records.get(id);
    if (!record) return;

    record.refCount = Math.max(0, record.refCount - 1);
    if (record.refCount === 0 && record.activeLocks === 0) {
      cleanUpBlobUrl(record);
    }
  }

  public acquireLock(id: string): () => void {
    const record = this.records.get(id) || this.lockedRecords.get(id);
    if (record) {
      record.activeLocks++;
      this.lockedRecords.set(id, record);
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (record) {
        record.activeLocks = Math.max(0, record.activeLocks - 1);
        if (record.activeLocks === 0) {
          this.lockedRecords.delete(id);
          if (record.pendingRemoval) {
            cleanUpBlobUrl(record);
            record.blobUrl = undefined;
            record.dataUrl = undefined;
            this.transitionHistory.delete(id);
            const isInFlight = Boolean(record.contentHash && this.inFlightIngests.has(record.contentHash));
            if (!isInFlight) {
              this.removedIds.delete(id);
            }
          } else if (record.refCount === 0) {
            cleanUpBlobUrl(record);
            record.blobUrl = undefined;
          }
        }
      }
    };
  }

  public remove(id: string): void {
    const record = this.records.get(id);
    if (!record) {
      let isInFlight = false;
      for (const rec of this.inFlightRecords.values()) {
        if (rec.id === id) {
          isInFlight = true;
          break;
        }
      }
      if (isInFlight) {
        this.removedIds.add(id);
      }
      return;
    }

    record.pendingRemoval = true;
    const isInFlight = Boolean(record.contentHash && this.inFlightRecords.has(record.contentHash));
    if (isInFlight || record.activeLocks > 0) {
      this.removedIds.add(id);
    } else {
      this.removedIds.delete(id);
    }

    if (record.activeLocks > 0) {
      this.lockedRecords.set(id, record);
    } else {
      cleanUpBlobUrl(record);
      record.blobUrl = undefined;
      record.dataUrl = undefined;
      if (!isInFlight) {
        this.transitionHistory.delete(id);
      }
    }

    const data = this.binaryData.get(id);
    if (data) {
      this.currentBytes -= data.byteLength;
      this.binaryData.delete(id);
    }
    if (record.contentHash) {
      this.hashToId.delete(record.contentHash);
      this.inFlightIngests.delete(record.contentHash);
      this.inFlightRecords.delete(record.contentHash);
    }
    this.records.delete(id);
    this.accessOrder = this.accessOrder.filter((item) => item !== id);
  }

  public clear(): void {
    this.generation++;
    for (const record of this.records.values()) {
      if (record.activeLocks > 0) {
        record.pendingRemoval = true;
        this.lockedRecords.set(record.id, record);
      } else {
        cleanUpBlobUrl(record);
      }
    }
    this.records.clear();
    this.binaryData.clear();
    this.hashToId.clear();
    this.accessOrder = [];
    this.currentBytes = 0;
    this.inFlightIngests.clear();
    this.inFlightRecords.clear();
    this.transitionHistory.clear();
    this.removedIds.clear();
  }

  public ingestSync(data: Uint8Array, options: IngestOptions = {}): AssetRecord {
    const cloned = data.slice();
    const contentHash = hashBytes(cloned);
    const existingId = this.hashToId.get(contentHash);

    if (existingId) {
      const existing = this.records.get(existingId);
      if (existing && existing.status !== 'failed') {
        existing.refCount++;
        if (!existing.blobUrl && existing.status === 'delivery-ready') {
          existing.blobUrl = createBlobUrl(cloned, existing.mimeType, existingId);
        }
        this.touch(existingId);
        return createReadOnlyRecordView(existing);
      }
    }

    const record = this.runPipeline(cloned, options, false) as InternalAssetRecord;
    return createReadOnlyRecordView(record);
  }

  public async ingest(data: Uint8Array, options: IngestOptions = {}): Promise<AssetRecord> {
    const cloned = data.slice();
    const contentHash = hashBytes(cloned);
    const currentGen = this.generation;

    // Check existing ready asset synchronously before any microtask
    const existingId = this.hashToId.get(contentHash);
    if (existingId) {
      const existing = this.records.get(existingId);
      if (existing && existing.status !== 'failed') {
        existing.refCount++;
        if (!existing.blobUrl && existing.status === 'delivery-ready') {
          existing.blobUrl = createBlobUrl(cloned, existing.mimeType, existingId);
        }
        this.touch(existingId);
        return Promise.resolve(createReadOnlyRecordView(existing));
      }
    }

    if (this.inFlightIngests.has(contentHash)) {
      const pendingRec = this.inFlightRecords.get(contentHash);
      if (pendingRec) pendingRec.refCount++;
      return this.inFlightIngests.get(contentHash)!;
    }

    const promise = (async () => {
      const rec = (await (this.runPipeline(cloned, options, true) as Promise<AssetRecord>)) as InternalAssetRecord;
      if (this.generation !== currentGen || rec.pendingRemoval || this.removedIds.has(rec.id)) {
        cleanUpBlobUrl(rec);
        rec.blobUrl = undefined;
        rec.dataUrl = undefined;
        this.transitionHistory.delete(rec.id);
        if (rec.activeLocks === 0) {
          this.removedIds.delete(rec.id);
        }
      }
      return createReadOnlyRecordView(rec);
    })();

    this.inFlightIngests.set(contentHash, promise);
    try {
      return await promise;
    } finally {
      this.inFlightIngests.delete(contentHash);
      this.inFlightRecords.delete(contentHash);
    }
  }

  public advanceStatus(id: string, targetStatus: AssetStatus, metadata?: Partial<AssetRecord>): AssetRecord {
    const record = this.records.get(id);
    if (!record) {
      throw new Error(`Asset not found: ${id}`);
    }

    const currentRank = STATUS_RANKS[record.status];
    const targetRank = STATUS_RANKS[targetStatus];
    if (targetRank < currentRank) {
      throw new Error(`Illegal status regression from ${record.status} to ${targetStatus}`);
    }

    if (metadata) {
      validateMetadataUpdate(metadata);
      if ('width' in metadata) record.width = metadata.width;
      if ('height' in metadata) record.height = metadata.height;
      if ('exifOrientation' in metadata) record.exifOrientation = metadata.exifOrientation;
      if ('blobUrl' in metadata) record.blobUrl = metadata.blobUrl;
      if ('dataUrl' in metadata) record.dataUrl = metadata.dataUrl;
      if ('remoteUrl' in metadata) record.remoteUrl = metadata.remoteUrl;
      if ('error' in metadata) record.error = metadata.error;
    }

    this.setStatus(record, targetStatus);
    return createReadOnlyRecordView(record);
  }

  private runPipeline(
    data: Uint8Array,
    options: IngestOptions,
    isAsync: boolean
  ): Promise<InternalAssetRecord> | InternalAssetRecord {
    const contentHash = hashBytes(data);
    const existingId = this.hashToId.get(contentHash);

    // Reuse existing ready asset
    if (existingId) {
      const existing = this.records.get(existingId);
      if (existing && existing.status !== 'failed') {
        existing.refCount++;
        if (!existing.blobUrl && existing.status === 'delivery-ready') {
          existing.blobUrl = createBlobUrl(data, existing.mimeType, existingId);
        }
        this.touch(existingId);
        return isAsync ? Promise.resolve(existing) : existing;
      }
    }

    // Single asset budget rejection
    if (data.byteLength > this.maxBytes) {
      const failedRecord: InternalAssetRecord = {
        id: this.generateId(),
        uri: 'morph-asset://failed',
        mimeType: options.mimeType || 'application/octet-stream',
        status: 'failed',
        refCount: 0,
        activeLocks: 0,
        byteSize: data.byteLength,
        error: 'Single asset larger than maxBytes budget',
      };
      return isAsync ? Promise.resolve(failedRecord) : failedRecord;
    }

    // Capacity eviction
    const admitted = this.evictIfNeeded(data.byteLength);
    if (!admitted) {
      const failedRecord: InternalAssetRecord = {
        id: this.generateId(),
        uri: 'morph-asset://failed',
        mimeType: options.mimeType || 'application/octet-stream',
        status: 'failed',
        refCount: 0,
        activeLocks: 0,
        byteSize: data.byteLength,
        error: 'AssetStore capacity exceeded; no evictable assets available',
      };
      return isAsync ? Promise.resolve(failedRecord) : failedRecord;
    }

    const id = this.generateId();
    const uri = `morph-asset://${id}`;
    const record: InternalAssetRecord = {
      id,
      uri,
      mimeType: options.mimeType || 'image/png',
      status: 'received',
      refCount: 1,
      activeLocks: 0,
      contentHash,
      byteSize: data.byteLength,
      fileName: options.fileName,
      remoteUrl: options.remoteUrl,
    };

    this.records.set(id, record);
    this.binaryData.set(id, data);
    this.hashToId.set(contentHash, id);
    this.currentBytes += data.byteLength;
    this.recordTransition(id, 'received');
    this.touch(id);
    if (isAsync) {
      this.inFlightRecords.set(contentHash, record);
    }

    const currentGen = this.generation;

    const stepMetadata = () => {
      if (this.generation !== currentGen || record.pendingRemoval || this.removedIds.has(id)) return false;
      const parsed = parseImageMetadata(data);
      if (!parsed) {
        record.error = 'Invalid, truncated, or unrecognized image format';
        this.setStatus(record, 'failed');
        return false;
      }
      record.mimeType = parsed.mimeType;
      record.width = parsed.width;
      record.height = parsed.height;
      record.exifOrientation = parsed.exifOrientation;
      this.setStatus(record, 'metadata-ready');
      return true;
    };

    const stepPreview = () => {
      if (this.generation !== currentGen || record.pendingRemoval || this.removedIds.has(id)) return false;
      if (record.refCount > 0 || record.activeLocks > 0) {
        record.blobUrl = createBlobUrl(data, record.mimeType, id);
      }
      this.setStatus(record, 'preview-ready');
      return true;
    };

    const stepDelivery = () => {
      if (this.generation !== currentGen || record.pendingRemoval || this.removedIds.has(id)) return false;
      record.dataUrl = `data:${record.mimeType};base64,${bytesToBase64(data)}`;
      this.setStatus(record, 'delivery-ready');
      return true;
    };

    if (!isAsync) {
      if (stepMetadata() && stepPreview()) {
        stepDelivery();
      }
      return record;
    }

    return (async () => {
      await Promise.resolve();
      if (this.generation !== currentGen || record.pendingRemoval || this.removedIds.has(id)) return record;
      if (!stepMetadata()) return record;

      await Promise.resolve();
      if (this.generation !== currentGen || record.pendingRemoval || this.removedIds.has(id)) return record;
      if (!stepPreview()) return record;

      await Promise.resolve();
      if (this.generation !== currentGen || record.pendingRemoval || this.removedIds.has(id)) return record;
      if (!stepDelivery()) return record;

      if (this.generation !== currentGen || record.pendingRemoval || this.removedIds.has(id)) {
        cleanUpBlobUrl(record);
        return record;
      }

      if (record.refCount === 0 && record.activeLocks === 0) {
        cleanUpBlobUrl(record);
      }

      return record;
    })();
  }

  private setStatus(record: InternalAssetRecord, status: AssetStatus): void {
    record.status = status;
    this.recordTransition(record.id, status);
  }

  private recordTransition(id: string, status: AssetStatus): void {
    let history = this.transitionHistory.get(id);
    if (!history) {
      history = [];
      this.transitionHistory.set(id, history);
    }
    history.push(status);
  }

  private generateId(): string {
    return 'ast_' + Math.random().toString(36).substring(2, 10) + Date.now().toString(36).substring(4);
  }

  private touch(id: string): void {
    const rec = this.records.get(id);
    if (rec) {
      this.records.delete(id);
      this.records.set(id, rec);
    }
    this.accessOrder = this.accessOrder.filter((item) => item !== id);
    this.accessOrder.push(id);
  }

  private evictIfNeeded(incomingBytes: number): boolean {
    while (
      (this.records.size >= this.maxEntries || this.currentBytes + incomingBytes > this.maxBytes) &&
      this.accessOrder.length > 0
    ) {
      const candidateId = this.accessOrder.find((id) => {
        const rec = this.records.get(id);
        return rec && rec.refCount === 0 && rec.activeLocks === 0;
      });

      if (!candidateId) {
        return false;
      }

      this.remove(candidateId);
    }

    return this.records.size < this.maxEntries && this.currentBytes + incomingBytes <= this.maxBytes;
  }

  public exportPackageManifest(content: string): AssetPackageManifest {
    return exportPackageManifestImpl(content, this.records, this.binaryData);
  }
}

export const globalAssetStore = new AssetStore();
