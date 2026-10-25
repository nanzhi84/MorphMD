import type { DeliverySnapshot, DiagnosticItem } from '../snapshot/types';
import type { AssetStore } from '../assets/store';

export interface ClipboardPayload {
  html: string;
  plainText: string;
  unresolvedAssetIds: string[];
  diagnostics: DiagnosticItem[];
}

export type NormalizeSelectionRangeFn = (
  range: Range,
  rootContainer: HTMLElement,
  snapshot: DeliverySnapshot,
  assetStore: AssetStore
) => ClipboardPayload;

export type SerializeFullSnapshotFn = (
  snapshot: DeliverySnapshot,
  assetStore: AssetStore
) => ClipboardPayload;
