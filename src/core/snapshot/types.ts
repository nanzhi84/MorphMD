import type { Root } from 'hast';

export type TargetId = 'wechat' | 'x-article' | 'cards';

export type ImageTransportMode = 'inline-data-url' | 'remote-https' | 'platform-upload';

export interface AdapterCapabilities {
  targetId: TargetId;
  allowInlineStyles: boolean;
  allowedStyleProps?: ReadonlySet<string>;
  supportedElements: ReadonlySet<string>;
  rasterizeBlocks: ReadonlySet<'table' | 'math' | 'code' | 'svg'>;
  imageTransport: ImageTransportMode;
}

export type DiagnosticSeverity = 'info' | 'warning' | 'error';

export interface DiagnosticItem {
  readonly code: string;
  readonly message: string;
  readonly severity: DiagnosticSeverity;
  readonly nodeId?: string;
  readonly sourceRange?: readonly [number, number];
  readonly targetId?: TargetId;
  readonly property?: string;
  readonly selector?: string;
  readonly assetId?: string;
}

export interface SourceRangeEntry {
  readonly nodeId: string;
  readonly tagName: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly startOffset?: number;
  readonly endOffset?: number;
}

/**
 * Delivery snapshot version counters.
 *
 * `buildDeliverySnapshot` and `createDeliverySnapshotSync` are pure, stateless builders.
 * When `options.version` is omitted, the snapshot version defaults to `{ doc: 1, style: 1, assets: 1 }`.
 * The caller (upper-layer editor, state machine, or session controller) is responsible for
 * monotonically advancing `doc`, `style`, and `assets` version counters across document edits,
 * style/theme adjustments, and asset mutations.
 */
export interface SnapshotVersion {
  readonly doc: number;
  readonly style: number;
  readonly assets: number;
}

export type DeepReadonly<T> = T extends Function | boolean | number | string | symbol | null | undefined
  ? T
  : T extends ReadonlyArray<infer U>
  ? ReadonlyArray<DeepReadonly<U>>
  : T extends Map<infer K, infer V>
  ? ReadonlyMap<DeepReadonly<K>, DeepReadonly<V>>
  : T extends Set<infer U>
  ? ReadonlySet<DeepReadonly<U>>
  : { readonly [K in keyof T]: DeepReadonly<T[K]> };

export interface DeliverySnapshot {
  readonly version: SnapshotVersion;
  readonly targetId: TargetId;
  readonly ready: boolean;
  readonly hast: DeepReadonly<Root>;
  readonly html: string;
  readonly diagnostics: readonly DiagnosticItem[];
  readonly sourceMap: readonly SourceRangeEntry[];
}
