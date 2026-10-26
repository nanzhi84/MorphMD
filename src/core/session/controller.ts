import { visit } from 'unist-util-visit';
import type { Element, Root } from 'hast';
import { AssetStore } from '../assets/store';
import type { AssetRecord } from '../assets/types';
import type { CompileOptions } from '../ast/types';
import type { CardsPaginationOptions } from '../cards/types';
import type { DesignTokens } from '../style/tokens';
import {
  buildDeliverySnapshot,
  createDeliverySnapshotSync,
  type SnapshotOptions,
} from '../snapshot/builder';
import type {
  AdapterCapabilities,
  DeliverySnapshot,
  SnapshotVersion,
  TargetId,
} from '../snapshot/types';
import type {
  SessionControllerOptions,
  SessionRenderListener,
  SnapshotBuilderFn,
  StyleUpdateOptions,
} from './types';

function extractAssetIdsFromHast(hast: Root): Set<string> {
  const ids = new Set<string>();
  visit(hast as Root, 'element', (node: Element) => {
    const props = (node.properties || {}) as Record<string, unknown>;
    const attrId =
      typeof props.dataMorphAssetId === 'string'
        ? props.dataMorphAssetId
        : typeof props['data-morph-asset-id'] === 'string'
        ? (props['data-morph-asset-id'] as string)
        : undefined;

    if (attrId) {
      ids.add(attrId);
      return;
    }

    if (node.tagName === 'img' && typeof props.src === 'string' && props.src.startsWith('morph-asset://')) {
      const parsedId = props.src.replace('morph-asset://', '').split('?')[0].split('#')[0];
      if (parsedId) {
        ids.add(parsedId);
      }
    }
  });
  return ids;
}

function createProvisionalUnreadySnapshot(base: DeliverySnapshot): DeliverySnapshot {
  if (!base.ready) {
    return base;
  }
  const cloned: DeliverySnapshot = {
    version: { ...base.version },
    targetId: base.targetId,
    ready: false,
    hast: base.hast,
    html: base.html,
    diagnostics: [
      ...base.diagnostics,
      {
        code: 'snapshot/async-compile-pending',
        message: 'Asynchronous snapshot compilation is in progress.',
        severity: 'info',
      },
    ],
    sourceMap: base.sourceMap,
  };
  return Object.freeze(cloned);
}

/**
 * Stateful Editor Session & Version Controller.
 */
export class EditorSessionController {
  private readonly assetStore: AssetStore;
  private targetId: TargetId;
  private customCss?: string;
  private tokens?: Partial<DesignTokens>;
  private capabilities?: AdapterCapabilities;
  private compileOptions?: CompileOptions;
  private cardsOptions?: CardsPaginationOptions;
  private readonly debounceMs: number;
  private readonly undoGracePeriodMs: number;
  private readonly maxHistoryEntries: number;
  private readonly snapshotBuilder: SnapshotBuilderFn;
  private readonly scheduleFrameFn: (cb: (timestamp: number) => void) => number;
  private readonly cancelFrameFn: (handle: number) => void;

  private draftMarkdown = '';
  private committedMarkdown = '';
  private hasCommittedDoc = false;
  private undoStack: string[] = [];
  private redoStack: string[] = [];

  private version: { doc: number; style: number; assets: number };
  private latestRequestSeq = 0;
  private latestCommittedSeq = 0;
  private inFlightPromises = new Set<Promise<DeliverySnapshot>>();

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceResolvers: Array<{
    resolve: (snapshot: DeliverySnapshot) => void;
    reject: (err: unknown) => void;
  }> = [];

  private currentSnapshot: DeliverySnapshot | null = null;
  private stagedSnapshot: DeliverySnapshot | null = null;
  private renderedSnapshot: DeliverySnapshot | null = null;
  private droppedSnapshots: DeliverySnapshot[] = [];
  private pendingFrameHandle: number | null = null;
  private renderListeners = new Set<SessionRenderListener>();

  private currentReferencedAssetIds = new Set<string>();
  private everBoundAssetIds = new Set<string>();
  private pendingReleaseTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private unsubscribeAssetStore: (() => void) | null = null;
  private disposed = false;

  constructor(options: SessionControllerOptions = {}) {
    this.assetStore = options.assetStore ?? new AssetStore();
    this.targetId = options.targetId ?? 'wechat';
    this.customCss = options.customCss;
    this.tokens = options.tokens ? { ...options.tokens } : undefined;
    this.capabilities = options.capabilities;
    this.compileOptions = options.compileOptions;
    this.cardsOptions = options.cardsOptions;
    this.debounceMs = options.debounceMs ?? 150;
    this.undoGracePeriodMs = options.undoGracePeriodMs ?? 30_000;
    this.maxHistoryEntries = options.maxHistoryEntries ?? 50;
    this.snapshotBuilder = options.snapshotBuilder ?? buildDeliverySnapshot;

    this.scheduleFrameFn =
      options.requestAnimationFrame ??
      (typeof globalThis.requestAnimationFrame === 'function'
        ? (cb) => globalThis.requestAnimationFrame(cb)
        : (cb) => setTimeout(() => cb(Date.now()), 16) as unknown as number);

    this.cancelFrameFn =
      options.cancelAnimationFrame ??
      (typeof globalThis.cancelAnimationFrame === 'function'
        ? (handle) => globalThis.cancelAnimationFrame(handle)
        : (handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>));

    this.version = {
      doc: options.initialVersion?.doc ?? 0,
      style: options.initialVersion?.style ?? 1,
      assets: options.initialVersion?.assets ?? 1,
    };

    this.unsubscribeAssetStore = this.assetStore.subscribe((record) => {
      this.handleAssetStoreUpdate(record);
    });

    if (options.initialMarkdown !== undefined) {
      this.draftMarkdown = options.initialMarkdown;
      void this.commitDoc(options.initialMarkdown);
    }
  }

  public inputDoc(markdown: string): Promise<DeliverySnapshot> {
    this.draftMarkdown = markdown;

    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    return new Promise<DeliverySnapshot>((resolve, reject) => {
      this.debounceResolvers.push({ resolve, reject });
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        const resolvers = this.debounceResolvers.splice(0);
        const buildPromise = this.executeDocCommit(this.draftMarkdown, true);
        buildPromise.then(
          (snap) => {
            for (const r of resolvers) r.resolve(snap);
          },
          (err) => {
            for (const r of resolvers) r.reject(err);
          }
        );
      }, this.debounceMs);
    });
  }

  public scheduleDocUpdate(markdown: string): Promise<DeliverySnapshot> {
    return this.inputDoc(markdown);
  }

  public commitDoc(markdown?: string): Promise<DeliverySnapshot> {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    const pendingResolvers = this.debounceResolvers.splice(0);
    const targetMarkdown = markdown !== undefined ? markdown : this.draftMarkdown;
    this.draftMarkdown = targetMarkdown;

    const buildPromise = this.executeDocCommit(targetMarkdown, true);
    if (pendingResolvers.length > 0) {
      buildPromise.then(
        (snap) => {
          for (const r of pendingResolvers) r.resolve(snap);
        },
        (err) => {
          for (const r of pendingResolvers) r.reject(err);
        }
      );
    }

    return buildPromise;
  }

  public flush(): Promise<DeliverySnapshot> {
    return this.commitDoc();
  }

  public updateStyle(update: StyleUpdateOptions): Promise<DeliverySnapshot> {
    if ('customCss' in update) this.customCss = update.customCss;
    if ('tokens' in update) {
      this.tokens = update.tokens ? { ...this.tokens, ...update.tokens } : undefined;
    }
    if ('capabilities' in update) this.capabilities = update.capabilities;
    if ('cardsOptions' in update) this.cardsOptions = update.cardsOptions;
    if ('compileOptions' in update) this.compileOptions = update.compileOptions;

    if (!this.hasCommittedDoc) {
      this.hasCommittedDoc = true;
      this.committedMarkdown = this.draftMarkdown;
      this.version = {
        doc: Math.max(1, this.version.doc),
        style: this.version.style + 1,
        assets: this.version.assets,
      };
    } else {
      this.version = {
        ...this.version,
        style: this.version.style + 1,
      };
    }

    return this.runSnapshotBuild(this.committedMarkdown, { ...this.version });
  }

  public setTarget(targetId: TargetId, capabilities?: AdapterCapabilities): Promise<DeliverySnapshot> {
    this.targetId = targetId;
    this.capabilities = capabilities;

    if (!this.hasCommittedDoc) {
      this.hasCommittedDoc = true;
      this.committedMarkdown = this.draftMarkdown;
      this.version = {
        doc: Math.max(1, this.version.doc),
        style: this.version.style + 1,
        assets: this.version.assets,
      };
    } else {
      this.version = {
        ...this.version,
        style: this.version.style + 1,
      };
    }

    return this.runSnapshotBuild(this.committedMarkdown, { ...this.version });
  }

  public notifyAssetsChanged(): Promise<DeliverySnapshot> {
    if (!this.hasCommittedDoc) {
      this.hasCommittedDoc = true;
      this.committedMarkdown = this.draftMarkdown;
      this.version = {
        doc: Math.max(1, this.version.doc),
        style: this.version.style,
        assets: this.version.assets + 1,
      };
    } else {
      this.version = {
        ...this.version,
        assets: this.version.assets + 1,
      };
    }

    return this.runSnapshotBuild(this.committedMarkdown, { ...this.version });
  }

  public undo(): Promise<DeliverySnapshot | null> {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.undoStack.length === 0) {
      return Promise.resolve(null);
    }

    const previousMarkdown = this.undoStack.pop()!;
    this.redoStack.push(this.committedMarkdown);
    this.draftMarkdown = previousMarkdown;
    this.committedMarkdown = previousMarkdown;
    this.version = {
      ...this.version,
      doc: this.version.doc + 1,
    };

    return this.runSnapshotBuild(this.committedMarkdown, { ...this.version });
  }

  public redo(): Promise<DeliverySnapshot | null> {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.redoStack.length === 0) {
      return Promise.resolve(null);
    }

    const nextMarkdown = this.redoStack.pop()!;
    this.undoStack.push(this.committedMarkdown);
    this.draftMarkdown = nextMarkdown;
    this.committedMarkdown = nextMarkdown;
    this.version = {
      ...this.version,
      doc: this.version.doc + 1,
    };

    return this.runSnapshotBuild(this.committedMarkdown, { ...this.version });
  }

  public canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  public canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  public getDraftMarkdown(): string {
    return this.draftMarkdown;
  }

  public getCommittedMarkdown(): string {
    return this.committedMarkdown;
  }

  public getVersion(): SnapshotVersion {
    return Object.freeze({ ...this.version });
  }

  public getSnapshot(): DeliverySnapshot | null {
    return this.currentSnapshot;
  }

  public getRenderedSnapshot(): DeliverySnapshot | null {
    return this.renderedSnapshot;
  }

  public getStagedSnapshot(): DeliverySnapshot | null {
    return this.stagedSnapshot;
  }

  public getDroppedSnapshots(): readonly DeliverySnapshot[] {
    return [...this.droppedSnapshots];
  }

  public getReferencedAssetIds(): readonly string[] {
    return [...this.currentReferencedAssetIds];
  }

  public getPendingReleaseAssetIds(): readonly string[] {
    return [...this.pendingReleaseTimers.keys()];
  }

  public flushPendingReleases(): void {
    for (const [assetId, timer] of this.pendingReleaseTimers.entries()) {
      clearTimeout(timer);
      this.pendingReleaseTimers.delete(assetId);
      this.assetStore.release(assetId);
    }
  }

  public flushRenderFrame(): void {
    if (this.pendingFrameHandle !== null) {
      this.cancelFrameFn(this.pendingFrameHandle);
      this.pendingFrameHandle = null;
    }
    if (this.stagedSnapshot && this.renderedSnapshot !== this.stagedSnapshot) {
      this.renderedSnapshot = this.stagedSnapshot;
      this.notifyRenderListeners(this.renderedSnapshot);
    }
  }

  public isReady(): boolean {
    return (
      this.debounceTimer === null &&
      this.inFlightPromises.size === 0 &&
      this.currentSnapshot !== null &&
      this.currentSnapshot.ready === true
    );
  }

  public async waitForIdle(): Promise<DeliverySnapshot | null> {
    while (this.debounceTimer !== null || this.inFlightPromises.size > 0) {
      if (this.debounceTimer !== null) {
        await new Promise<void>((resolve) => {
          const check = () => {
            if (this.debounceTimer === null) resolve();
            else setTimeout(check, 5);
          };
          check();
        });
      }
      if (this.inFlightPromises.size > 0) {
        await Promise.allSettled([...this.inFlightPromises]);
      }
    }
    return this.currentSnapshot;
  }

  public subscribe(listener: SessionRenderListener): () => void {
    this.renderListeners.add(listener);
    return () => {
      this.renderListeners.delete(listener);
    };
  }

  public dispose(): void {
    this.disposed = true;
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.debounceResolvers.splice(0);

    if (this.pendingFrameHandle !== null) {
      this.cancelFrameFn(this.pendingFrameHandle);
      this.pendingFrameHandle = null;
    }

    if (this.unsubscribeAssetStore) {
      this.unsubscribeAssetStore();
      this.unsubscribeAssetStore = null;
    }

    this.flushPendingReleases();
    this.renderListeners.clear();
  }

  private executeDocCommit(markdown: string, recordHistory: boolean): Promise<DeliverySnapshot> {
    if (!this.hasCommittedDoc) {
      this.hasCommittedDoc = true;
      this.committedMarkdown = markdown;
      this.version = {
        ...this.version,
        doc: this.version.doc + 1,
      };
    } else {
      if (recordHistory && markdown !== this.committedMarkdown) {
        this.undoStack.push(this.committedMarkdown);
        if (this.undoStack.length > this.maxHistoryEntries) {
          this.undoStack.shift();
        }
        this.redoStack = [];
      }
      this.committedMarkdown = markdown;
      this.version = {
        ...this.version,
        doc: this.version.doc + 1,
      };
    }

    return this.runSnapshotBuild(this.committedMarkdown, { ...this.version });
  }

  private runSnapshotBuild(
    markdown: string,
    targetVersion: SnapshotVersion
  ): Promise<DeliverySnapshot> {
    const requestSeq = ++this.latestRequestSeq;
    const currentTargetId = this.targetId;
    const snapshotOptions: SnapshotOptions = {
      version: { ...targetVersion },
      customCss: this.customCss,
      tokens: this.tokens ? { ...this.tokens } : undefined,
      capabilities: this.capabilities,
      compileOptions: this.compileOptions,
      cardsOptions: this.cardsOptions,
    };

    // Synchronously compute provisional snapshot & update AST asset reference counts
    const syncSnapshot = createDeliverySnapshotSync(
      markdown,
      currentTargetId,
      this.assetStore,
      snapshotOptions
    );
    const nextAssetIds = extractAssetIdsFromHast(syncSnapshot.hast as Root);
    this.reconcileAssetReferences(nextAssetIds);

    // Expose synchronous provisional snapshot (with ready: false) if no newer committed snapshot exists
    if (requestSeq >= this.latestCommittedSeq) {
      this.currentSnapshot = createProvisionalUnreadySnapshot(syncSnapshot);
    }

    const buildPromise = (async (): Promise<DeliverySnapshot> => {
      const builtSnapshot = await this.snapshotBuilder(
        markdown,
        currentTargetId,
        this.assetStore,
        snapshotOptions
      );

      if (this.disposed) {
        return builtSnapshot;
      }

      // Race Condition Guard: drop stale snapshots when a newer version is already expected or committed
      const isStale =
        builtSnapshot.version.doc < this.version.doc ||
        requestSeq < this.latestCommittedSeq ||
        requestSeq < this.latestRequestSeq;

      if (isStale) {
        console.debug(`Drop stale snapshot: ${builtSnapshot.version.doc}`);
        if (builtSnapshot.version.doc < this.version.doc || requestSeq < this.latestCommittedSeq) {
          this.droppedSnapshots.push(builtSnapshot);
        }
        return this.currentSnapshot ?? builtSnapshot;
      }

      this.latestCommittedSeq = requestSeq;
      this.currentSnapshot = builtSnapshot;
      this.stagedSnapshot = builtSnapshot;
      this.scheduleRenderFrame();

      return builtSnapshot;
    })();

    this.inFlightPromises.add(buildPromise);
    void buildPromise.finally(() => {
      this.inFlightPromises.delete(buildPromise);
    });

    return buildPromise;
  }

  private reconcileAssetReferences(nextAssetIds: Set<string>): void {
    // 1. Retain newly added or restored assets
    for (const assetId of nextAssetIds) {
      if (!this.currentReferencedAssetIds.has(assetId)) {
        const pendingTimer = this.pendingReleaseTimers.get(assetId);
        if (pendingTimer !== undefined) {
          clearTimeout(pendingTimer);
          this.pendingReleaseTimers.delete(assetId);
          const record = this.assetStore.get(assetId);
          if (record && record.refCount === 0) {
            this.assetStore.retain(assetId);
          }
        } else {
          const record = this.assetStore.get(assetId);
          if (record) {
            if (!this.everBoundAssetIds.has(assetId)) {
              this.everBoundAssetIds.add(assetId);
              if (record.refCount === 0) {
                this.assetStore.retain(assetId);
              }
            } else {
              this.assetStore.retain(assetId);
            }
          }
        }
      }
    }

    // 2. Schedule or execute release for removed assets
    for (const prevId of this.currentReferencedAssetIds) {
      if (!nextAssetIds.has(prevId)) {
        if (this.undoGracePeriodMs <= 0) {
          this.assetStore.release(prevId);
        } else if (!this.pendingReleaseTimers.has(prevId)) {
          const timer = setTimeout(() => {
            this.pendingReleaseTimers.delete(prevId);
            this.assetStore.release(prevId);
          }, this.undoGracePeriodMs);
          this.pendingReleaseTimers.set(prevId, timer);
        }
      }
    }

    this.currentReferencedAssetIds = new Set(nextAssetIds);
  }

  private handleAssetStoreUpdate(record: AssetRecord): void {
    if (this.disposed) return;
    if (!this.currentReferencedAssetIds.has(record.id)) return;

    this.version = {
      doc: Math.max(1, this.version.doc),
      style: this.version.style,
      assets: this.version.assets + 1,
    };
    void this.runSnapshotBuild(this.committedMarkdown, { ...this.version });
  }

  private scheduleRenderFrame(): void {
    if (this.pendingFrameHandle !== null) {
      return;
    }
    this.pendingFrameHandle = this.scheduleFrameFn(() => {
      this.pendingFrameHandle = null;
      if (this.disposed) return;
      if (this.stagedSnapshot && this.renderedSnapshot !== this.stagedSnapshot) {
        this.renderedSnapshot = this.stagedSnapshot;
        this.notifyRenderListeners(this.renderedSnapshot);
      }
    });
  }

  private notifyRenderListeners(snapshot: DeliverySnapshot): void {
    for (const listener of [...this.renderListeners]) {
      try {
        listener(snapshot);
      } catch {
        // Ignore subscriber callback errors
      }
    }
  }
}

export function createEditorSession(options: SessionControllerOptions = {}): EditorSessionController {
  return new EditorSessionController(options);
}
