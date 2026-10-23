/**
 * Static Asset Store types and contracts.
 * Matches docs/spec/issue#2/spec.md Section 2.2.
 */

export type AssetStatus =
  | 'received'
  | 'metadata-ready'
  | 'preview-ready'
  | 'delivery-ready'
  | 'failed';

export interface AssetRecord {
  id: string;
  uri: string;
  mimeType: string;
  status: AssetStatus;
  width?: number;
  height?: number;
  blobUrl?: string;
  dataUrl?: string;
  remoteUrl?: string;
  refCount: number;
  activeLocks: number;
  error?: string;
  exifOrientation?: number;
  contentHash?: string;
  byteSize?: number;
  fileName?: string;
}

export interface AssetExportEntry {
  assetId: string;
  originalUri: string;
  exportPath: string;
  mimeType: string;
  data: Uint8Array;
}

export interface AssetStoreOptions {
  maxEntries?: number;
  maxBytes?: number;
}

export interface IngestOptions {
  fileName?: string;
  mimeType?: string;
  remoteUrl?: string;
}

export interface AssetPackageManifest {
  rewrittenContent: string;
  assets: AssetExportEntry[];
}
