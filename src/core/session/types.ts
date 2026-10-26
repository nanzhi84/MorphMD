import type { AssetStore } from '../assets/store';
import type { CompileOptions } from '../ast/types';
import type { CardsPaginationOptions } from '../cards/types';
import type { DesignTokens } from '../style/tokens';
import type { SnapshotOptions } from '../snapshot/builder';
import type {
  AdapterCapabilities,
  DeliverySnapshot,
  SnapshotVersion,
  TargetId,
} from '../snapshot/types';

export type SnapshotBuilderFn = (
  markdown: string,
  targetId: TargetId,
  assetStore: AssetStore,
  options: SnapshotOptions
) => Promise<DeliverySnapshot>;

export type SessionRenderListener = (snapshot: DeliverySnapshot) => void;

export interface StyleUpdateOptions {
  customCss?: string;
  tokens?: Partial<DesignTokens>;
  capabilities?: AdapterCapabilities;
  cardsOptions?: CardsPaginationOptions;
  compileOptions?: CompileOptions;
}

export interface SessionControllerOptions {
  /**
   * Static asset store instance used for resolving `morph-asset://` URIs
   * and managing `retain` / `release` reference counts.
   * Defaults to a new `AssetStore` instance if omitted.
   */
  assetStore?: AssetStore;
  /**
   * Active target view identifier. Defaults to `'wechat'`.
   */
  targetId?: TargetId;
  /**
   * Optional initial Markdown content.
   * When provided, an initial commit (`doc: 1`) is triggered immediately upon construction.
   * When omitted, `doc` starts at `0` before the first commit, and the first committed
   * document edit advances `doc` to `1`.
   */
  initialMarkdown?: string;
  /**
   * Optional initial version counters override.
   */
  initialVersion?: Partial<SnapshotVersion>;
  /**
   * Debounce batching window in milliseconds for continuous editor typing (`inputDoc`).
   * Defaults to `150` ms.
   */
  debounceMs?: number;
  /**
   * Grace period in milliseconds before calling `AssetStore.release(id)` after an asset
   * disappears from the document AST, protecting against broken Blob URLs on `Cmd/Ctrl + Z` Undo.
   * Defaults to `30000` ms (30 seconds). Set to `0` for immediate release.
   */
  undoGracePeriodMs?: number;
  /**
   * Maximum number of committed document states retained in the undo stack.
   * Defaults to `50`.
   */
  maxHistoryEntries?: number;
  customCss?: string;
  tokens?: Partial<DesignTokens>;
  capabilities?: AdapterCapabilities;
  compileOptions?: CompileOptions;
  cardsOptions?: CardsPaginationOptions;
  /**
   * Optional custom async snapshot builder function (defaults to `buildDeliverySnapshot`).
   */
  snapshotBuilder?: SnapshotBuilderFn;
  /**
   * Optional custom `requestAnimationFrame` implementation for Layer 3 double-buffered rendering.
   */
  requestAnimationFrame?: (callback: (timestamp: number) => void) => number;
  /**
   * Optional custom `cancelAnimationFrame` implementation.
   */
  cancelAnimationFrame?: (handle: number) => void;
}
