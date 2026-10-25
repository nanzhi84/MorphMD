import type { DiagnosticItem } from '../snapshot/types';

export type CardAspectRatio = '3:4' | '4:5' | '1:1' | '16:9';

export interface CardPadding {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export interface CardPresetConfig {
  readonly ratio: CardAspectRatio;
  readonly label: string;
  readonly exportWidth: number;
  readonly exportHeight: number;
  readonly layoutWidth: number;
  readonly layoutHeight: number;
  readonly exportScale: number;
  readonly padding: CardPadding;
  readonly headerHeight: number;
  readonly footerHeight: number;
}

export interface CardViewportGeometry {
  readonly ratio: CardAspectRatio;
  readonly layoutWidth: number;
  readonly layoutHeight: number;
  readonly exportWidth: number;
  readonly exportHeight: number;
  readonly exportScale: number;
  readonly previewScale: number;
  readonly previewWidth: number;
  readonly previewHeight: number;
  readonly availableContentWidth: number;
  readonly availableContentHeight: number;
  readonly padding: CardPadding;
  readonly headerHeight: number;
  readonly footerHeight: number;
}

export interface CardViewportOptions {
  containerWidth?: number;
  containerHeight?: number;
  maxPreviewScale?: number;
  minPreviewScale?: number;
  renderAtExportSize?: boolean;
  contentHeightOverride?: number;
}

export interface CardPageCheckpoint {
  readonly pageNumber: number;
  readonly firstBlockSignature: string;
  readonly lastBlockSignature: string;
  readonly nodeIds: readonly string[];
  readonly usedHeight: number;
  readonly availableHeight: number;
}

export interface CardPaginationState {
  readonly ratio: CardAspectRatio;
  readonly totalPages: number;
  readonly geometry: CardViewportGeometry;
  readonly checkpoints: readonly CardPageCheckpoint[];
  readonly reflowStartPage: number;
  readonly convergedAtPage: number | null;
  readonly reusedPageNumbers: readonly number[];
  readonly oversizePageNumbers: readonly number[];
}

export interface CardsPaginationOptions {
  ratio?: CardAspectRatio;
  headerText?: string;
  footerFormat?: 'number-slash-total' | ((pageNumber: number, totalPages: number) => string);
  containerWidth?: number;
  containerHeight?: number;
  contentHeightOverride?: number;
  measureElementHeight?: (el: HTMLElement, availableWidth: number) => number;
}

export interface CardsReflowChangeHint {
  dirtyPageNumber?: number;
  dirtyNodeIds?: readonly string[];
}

export interface CardsPaginationResult {
  readonly html: string;
  readonly state: CardPaginationState;
  readonly diagnostics: readonly DiagnosticItem[];
}

export interface CardPagePngArtifact {
  readonly pageNumber: number;
  readonly totalPages: number;
  readonly fileName: string;
  readonly ratio: CardAspectRatio;
  readonly layoutWidth: number;
  readonly layoutHeight: number;
  readonly width: number;
  readonly height: number;
  readonly exportScale: number;
  readonly mimeType: 'image/png';
  readonly data: Uint8Array;
  readonly dataUrl: string;
  readonly crc32: number;
}

export interface CardsExportOptions {
  ratio?: CardAspectRatio;
  filePrefix?: string;
  scaleOverride?: number;
  hostDevicePixelRatio?: number;
  pageNumbers?: readonly number[];
  includeManifest?: boolean;
  headerText?: string;
  tokens?: Record<string, string>;
  customCss?: string;
  paginationOptions?: CardsPaginationOptions;
}

export interface CardsRasterizeResult {
  readonly pages: readonly CardPagePngArtifact[];
  readonly diagnostics: readonly DiagnosticItem[];
}

export interface ZipEntryRecord {
  readonly path: string;
  readonly data: Uint8Array;
  readonly crc32: number;
  readonly compressionMethod: 0 | 8;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
}

export interface CardsExportManifest {
  readonly ratio: CardAspectRatio;
  readonly totalPages: number;
  readonly exportedPages: number;
  readonly exportWidth: number;
  readonly exportHeight: number;
  readonly layoutWidth: number;
  readonly layoutHeight: number;
  readonly exportScale: number;
  readonly pages: ReadonlyArray<{
    readonly pageNumber: number;
    readonly fileName: string;
    readonly width: number;
    readonly height: number;
    readonly byteLength: number;
    readonly crc32: number;
  }>;
}

export interface CardsZipExportResult {
  readonly zipFileName: string;
  readonly mimeType: 'application/zip';
  readonly zipData: Uint8Array;
  readonly pages: readonly CardPagePngArtifact[];
  readonly manifest: CardsExportManifest;
  readonly diagnostics: readonly DiagnosticItem[];
}
