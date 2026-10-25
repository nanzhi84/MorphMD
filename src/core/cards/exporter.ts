import { deflateSync, inflateRawSync } from 'node:zlib';
import type { AssetStore } from '../assets/store';
import { parseDocument } from '../dom/env';
import type { DeliverySnapshot, DiagnosticItem } from '../snapshot/types';
import { paginateDom } from './paginator';
import { CARD_RATIO_PRESETS, getCardPreset } from './presets';
import type {
  CardAspectRatio,
  CardPagePngArtifact,
  CardsExportManifest,
  CardsExportOptions,
  CardsRasterizeResult,
  CardsZipExportResult,
  ZipEntryRecord,
} from './types';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function computeCrc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.byteLength; i++) {
    crc = CRC32_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function hashFnv1a32(input: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

type RgbTuple = [number, number, number];

function parseColorRgb(raw: string | undefined | null, fallback: RgbTuple): RgbTuple {
  if (!raw) return fallback;
  const cleaned = raw.trim();
  const hex6 = cleaned.match(/^#([0-9a-fA-F]{6})(?:[0-9a-fA-F]{2})?$/);
  if (hex6) {
    const val = parseInt(hex6[1], 16);
    return [(val >> 16) & 0xff, (val >> 8) & 0xff, val & 0xff];
  }
  const hex3 = cleaned.match(/^#([0-9a-fA-F]{3})(?:[0-9a-fA-F])?$/);
  if (hex3) {
    const r = parseInt(hex3[1][0] + hex3[1][0], 16);
    const g = parseInt(hex3[1][1] + hex3[1][1], 16);
    const b = parseInt(hex3[1][2] + hex3[1][2], 16);
    return [r, g, b];
  }
  const rgbMatch = cleaned.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i);
  if (rgbMatch) {
    return [
      Math.min(255, parseInt(rgbMatch[1], 10)),
      Math.min(255, parseInt(rgbMatch[2], 10)),
      Math.min(255, parseInt(rgbMatch[3], 10)),
    ];
  }
  return fallback;
}

function mixRgb(a: RgbTuple, b: RgbTuple, weightB: number): RgbTuple {
  const wB = Math.max(0, Math.min(1, weightB));
  const wA = 1 - wB;
  return [
    Math.round(a[0] * wA + b[0] * wB) & 0xff,
    Math.round(a[1] * wA + b[1] * wB) & 0xff,
    Math.round(a[2] * wA + b[2] * wB) & 0xff,
  ];
}

function isValidRatio(value: unknown): value is CardAspectRatio {
  return typeof value === 'string' && value in CARD_RATIO_PRESETS;
}

function buildPngChunk(type: string, payload: Buffer): Buffer {
  const len = payload.byteLength;
  const out = Buffer.allocUnsafe(12 + len);
  out.writeUInt32BE(len, 0);
  out.write(type, 4, 4, 'ascii');
  if (len > 0) {
    payload.copy(out, 8);
  }
  const crc = computeCrc32(out.subarray(4, 8 + len));
  out.writeUInt32BE(crc, 8 + len);
  return out;
}

function encodeRgbPng(width: number, height: number, rawRows: Buffer): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8-bit per channel
  ihdr[9] = 2; // Truecolor RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const compressed = deflateSync(rawRows, { level: 1 });
  const pngBuffer = Buffer.concat([
    PNG_MAGIC,
    buildPngChunk('IHDR', ihdr),
    buildPngChunk('IDAT', compressed),
    buildPngChunk('IEND', Buffer.alloc(0)),
  ]);

  return new Uint8Array(pngBuffer.buffer, pngBuffer.byteOffset, pngBuffer.byteLength);
}

interface ExtractedBlockDescriptor {
  tag: string;
  text: string;
  attrSignature: string;
  hasAssetOrImage: boolean;
}

function extractPageVisualModel(
  cardPageEl: HTMLElement,
  options?: CardsExportOptions,
): {
  bgColor: RgbTuple;
  textColor: RgbTuple;
  accentColor: RgbTuple;
  headerText: string;
  footerText: string;
  blocks: ExtractedBlockDescriptor[];
  signatureHash1: number;
  signatureHash2: number;
} {
  const tokens = options?.tokens ?? {};
  const docRoot = cardPageEl.closest('.morph-doc') as HTMLElement | null;

  const rawBg =
    tokens['--morph-bg'] ||
    tokens['background-color'] ||
    cardPageEl.style?.backgroundColor ||
    docRoot?.style?.backgroundColor ||
    '#ffffff';
  const rawText =
    tokens['--morph-text'] ||
    tokens['--morph-ink'] ||
    tokens['color'] ||
    cardPageEl.style?.color ||
    docRoot?.style?.color ||
    '#1f2937';
  const rawAccent =
    tokens['--morph-accent'] ||
    tokens['--morph-primary'] ||
    '#2563eb';

  const bgColor = parseColorRgb(rawBg, [255, 255, 255]);
  const textColor = parseColorRgb(rawText, [31, 41, 55]);
  const accentColor = parseColorRgb(rawAccent, [37, 99, 235]);

  const headerEl = cardPageEl.querySelector<HTMLElement>(
    '[data-morph-generated="header"], .morph-card-header',
  );
  const footerEl = cardPageEl.querySelector<HTMLElement>(
    '[data-morph-generated="footer"], .morph-card-footer',
  );

  const headerText =
    options?.headerText ??
    (headerEl?.textContent || '').trim() ??
    'MorphMD';
  const footerText = (footerEl?.textContent || '').trim() || '01 / 01';

  const bodyContainer =
    cardPageEl.querySelector<HTMLElement>('.morph-card-body, [data-morph-card-body]') ??
    cardPageEl;

  const rawChildren = Array.from(bodyContainer.children).filter(
    (el) => !el.hasAttribute('data-morph-generated'),
  ) as HTMLElement[];

  const blocks: ExtractedBlockDescriptor[] = [];
  for (const child of rawChildren) {
    const tag = child.tagName.toLowerCase();
    const text = (child.textContent || '').replace(/\s+/g, ' ').trim();
    const imgs = [
      ...(tag === 'img' ? [child] : []),
      ...Array.from(child.querySelectorAll('img')),
    ];
    const assetAttrs = imgs
      .map(
        (img) =>
          `${img.getAttribute('data-morph-asset-id') || ''}:${(img.getAttribute('src') || '').slice(0, 96)}:${img.getAttribute('alt') || ''}`,
      )
      .join('|');
    const mathTex =
      child.getAttribute('data-math-tex') ||
      child.querySelector('[data-math-tex]')?.getAttribute('data-math-tex') ||
      '';
    const nodeId = child.getAttribute('data-node-id') || '';
    const inlineColor = child.style?.color || '';
    const inlineBg = child.style?.backgroundColor || '';

    blocks.push({
      tag,
      text,
      attrSignature: `${nodeId};${assetAttrs};${mathTex};${inlineColor};${inlineBg}`,
      hasAssetOrImage: imgs.length > 0 || child.hasAttribute('data-morph-asset-id'),
    });
  }

  if (blocks.length === 0) {
    const fallbackText = (cardPageEl.textContent || '').replace(/\s+/g, ' ').trim();
    blocks.push({
      tag: 'p',
      text: fallbackText || headerText,
      attrSignature: '',
      hasAssetOrImage: Boolean(cardPageEl.querySelector('img, [data-morph-asset-id]')),
    });
  }

  const tokenPairs = Object.entries(tokens)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(';');

  const fullSignatureString = [
    `bg=${bgColor.join(',')}`,
    `text=${textColor.join(',')}`,
    `accent=${accentColor.join(',')}`,
    `tokens=${tokenPairs}`,
    `css=${options?.customCss || ''}`,
    `header=${headerText}`,
    `footer=${footerText}`,
    ...blocks.map((b) => `${b.tag}[${b.attrSignature}]:${b.text}`),
  ].join('\n');

  const signatureHash1 = hashFnv1a32(fullSignatureString, 0x811c9dc5);
  const signatureHash2 = hashFnv1a32(fullSignatureString, 0x9e3779b9);

  return {
    bgColor,
    textColor,
    accentColor,
    headerText,
    footerText,
    blocks,
    signatureHash1,
    signatureHash2,
  };
}

export async function rasterizeCardPage(
  cardPageEl: HTMLElement,
  options?: CardsExportOptions & {
    pageNumber?: number;
    totalPages?: number;
    fileName?: string;
  },
): Promise<CardPagePngArtifact> {
  const attrRatio = cardPageEl.getAttribute('data-ratio');
  const ratio: CardAspectRatio = isValidRatio(options?.ratio)
    ? options.ratio
    : isValidRatio(attrRatio)
    ? attrRatio
    : '3:4';

  const preset = getCardPreset(ratio);
  const layoutWidth = preset.layoutWidth;
  const layoutHeight = preset.layoutHeight;

  // Strictly isolate export resolution from preview CSS transform and hostDevicePixelRatio
  const exportScale =
    typeof options?.scaleOverride === 'number' &&
    Number.isFinite(options.scaleOverride) &&
    options.scaleOverride > 0
      ? options.scaleOverride
      : preset.exportScale;

  const width = Math.max(1, Math.round(layoutWidth * exportScale));
  const height = Math.max(1, Math.round(layoutHeight * exportScale));

  const pageNumber =
    options?.pageNumber ??
    Math.max(1, parseInt(cardPageEl.getAttribute('data-page') || '1', 10) || 1);
  const totalPages =
    options?.totalPages ??
    Math.max(1, parseInt(cardPageEl.getAttribute('data-total-pages') || '1', 10) || 1);

  const padLen = Math.max(2, String(totalPages).length);
  const prefix = (options?.filePrefix || 'card').trim() || 'card';
  const fileName =
    options?.fileName ?? `${prefix}-${String(pageNumber).padStart(padLen, '0')}.png`;

  const model = extractPageVisualModel(cardPageEl, options);
  const { bgColor, textColor, accentColor, headerText, footerText, blocks, signatureHash1, signatureHash2 } =
    model;

  const borderColor = mixRgb(bgColor, textColor, 0.16);
  const dividerColor = mixRgb(bgColor, textColor, 0.24);
  const surfaceColor = mixRgb(bgColor, accentColor, 0.14);
  const codeSurfaceColor = mixRgb(bgColor, textColor, 0.1);
  const mutedTextColor = mixRgb(bgColor, textColor, 0.55);

  const rowStride = width * 3 + 1;
  const rawRows = Buffer.allocUnsafe(rowStride * height);

  const borderPx = Math.max(2, Math.round(2 * exportScale));
  const topAccentH = Math.max(4, Math.round(6 * exportScale));

  // Build reusable scanline templates for ultra-fast memory copy
  const borderRow = Buffer.allocUnsafe(rowStride);
  borderRow[0] = 0;
  for (let x = 0; x < width; x++) {
    const off = 1 + x * 3;
    borderRow[off] = borderColor[0];
    borderRow[off + 1] = borderColor[1];
    borderRow[off + 2] = borderColor[2];
  }

  const accentRow = Buffer.allocUnsafe(rowStride);
  accentRow[0] = 0;
  for (let x = 0; x < width; x++) {
    const off = 1 + x * 3;
    const isEdge = x < borderPx || x >= width - borderPx;
    const c = isEdge ? borderColor : accentColor;
    accentRow[off] = c[0];
    accentRow[off + 1] = c[1];
    accentRow[off + 2] = c[2];
  }

  const bgRow = Buffer.allocUnsafe(rowStride);
  bgRow[0] = 0;
  for (let x = 0; x < width; x++) {
    const off = 1 + x * 3;
    const isEdge = x < borderPx || x >= width - borderPx;
    const c = isEdge ? borderColor : bgColor;
    bgRow[off] = c[0];
    bgRow[off + 1] = c[1];
    bgRow[off + 2] = c[2];
  }

  for (let y = 0; y < height; y++) {
    const destOffset = y * rowStride;
    if (y < borderPx || y >= height - borderPx) {
      borderRow.copy(rawRows, destOffset);
    } else if (y < borderPx + topAccentH) {
      accentRow.copy(rawRows, destOffset);
    } else {
      bgRow.copy(rawRows, destOffset);
    }
  }

  const fillRect = (
    x0: number,
    y0: number,
    rectW: number,
    rectH: number,
    color: RgbTuple,
  ): void => {
    const startX = Math.max(borderPx, Math.min(width - borderPx, Math.round(x0)));
    const endX = Math.max(startX, Math.min(width - borderPx, Math.round(x0 + rectW)));
    const startY = Math.max(borderPx, Math.min(height - borderPx, Math.round(y0)));
    const endY = Math.max(startY, Math.min(height - borderPx, Math.round(y0 + rectH)));
    if (startX >= endX || startY >= endY) return;

    const firstRowStart = startY * rowStride + 1 + startX * 3;
    for (let x = startX; x < endX; x++) {
      const off = startY * rowStride + 1 + x * 3;
      rawRows[off] = color[0];
      rawRows[off + 1] = color[1];
      rawRows[off + 2] = color[2];
    }
    const byteLen = (endX - startX) * 3;
    for (let y = startY + 1; y < endY; y++) {
      rawRows.copy(rawRows, y * rowStride + 1 + startX * 3, firstRowStart, firstRowStart + byteLen);
    }
  };

  const padLeft = Math.round(preset.padding.left * exportScale);
  const padRight = Math.round(preset.padding.right * exportScale);
  const padTop = Math.round(preset.padding.top * exportScale);
  const padBottom = Math.round(preset.padding.bottom * exportScale);
  const headerH = Math.round(preset.headerHeight * exportScale);
  const footerH = Math.round(preset.footerHeight * exportScale);
  const contentWidth = Math.max(32, width - padLeft - padRight);

  // Header band & separator
  const headerY = padTop;
  const headerBarH = Math.max(6, Math.round(10 * exportScale));
  const headerTextW = Math.min(
    Math.round(contentWidth * 0.55),
    Math.max(48, headerText.length * Math.round(9 * exportScale)),
  );
  fillRect(padLeft, headerY + Math.round((headerH - headerBarH) / 2), headerTextW, headerBarH, mutedTextColor);

  // Deterministic content + token signature strip in header right
  for (let bit = 0; bit < 16; bit++) {
    const bit1 = (signatureHash1 >>> (bit * 2)) & 0x3;
    const bit2 = (signatureHash2 >>> (bit * 2)) & 0x3;
    const stripColor: RgbTuple =
      bit1 === 0
        ? accentColor
        : bit1 === 1
        ? textColor
        : bit1 === 2
        ? surfaceColor
        : [
            (accentColor[0] ^ ((signatureHash1 >>> bit) & 0x7f)) & 0xff,
            (textColor[1] ^ ((signatureHash2 >>> bit) & 0x7f)) & 0xff,
            (bgColor[2] ^ (((signatureHash1 ^ signatureHash2) >>> bit) & 0x7f)) & 0xff,
          ];
    const barW = Math.max(4, Math.round(6 * exportScale));
    const bx = width - padRight - (16 - bit) * (barW + 2);
    const bh = Math.max(4, Math.round((6 + bit2 * 2) * exportScale));
    fillRect(bx, headerY + Math.round((headerH - bh) / 2), barW, bh, stripColor);
  }

  // Header divider line
  const dividerH = Math.max(2, Math.round(2 * exportScale));
  fillRect(padLeft, padTop + headerH - dividerH, contentWidth, dividerH, dividerColor);

  // Render content blocks inside body
  let cursorY = padTop + headerH + Math.round(16 * exportScale);
  const maxBodyY = height - padBottom - footerH - Math.round(12 * exportScale);

  for (let idx = 0; idx < blocks.length; idx++) {
    if (cursorY >= maxBodyY) break;
    const block = blocks[idx];
    const blockSeed = hashFnv1a32(`${idx}:${block.tag}:${block.attrSignature}:${block.text}`, signatureHash1);

    if (/^h[1-6]$/.test(block.tag)) {
      const hLevel = parseInt(block.tag.slice(1), 10) || 1;
      const barH = Math.max(10, Math.round((24 - hLevel * 2) * exportScale));
      const pillW = Math.max(6, Math.round(8 * exportScale));
      fillRect(padLeft, cursorY, pillW, barH, accentColor);
      const titleW = Math.min(
        contentWidth - pillW * 2,
        Math.max(
          Math.round(contentWidth * 0.35),
          ((block.text.length * 16 + (blockSeed & 0x3f)) % Math.max(64, contentWidth - pillW * 3)) +
            Math.round(contentWidth * 0.25),
        ),
      );
      fillRect(padLeft + pillW * 2, cursorY + Math.round(barH * 0.15), titleW, Math.round(barH * 0.7), textColor);
      cursorY += barH + Math.round(18 * exportScale);
      continue;
    }

    if (block.hasAssetOrImage || block.tag === 'img' || block.tag === 'figure') {
      const boxH = Math.min(Math.round(140 * exportScale), Math.max(32, maxBodyY - cursorY));
      fillRect(padLeft, cursorY, contentWidth, boxH, surfaceColor);
      const stripeW = Math.max(8, Math.round(12 * exportScale));
      fillRect(padLeft, cursorY, stripeW, boxH, accentColor);
      const innerW = Math.max(24, Math.round(contentWidth * (0.3 + ((blockSeed & 0xff) / 255) * 0.5)));
      fillRect(
        padLeft + stripeW * 2,
        cursorY + Math.round(boxH * 0.3),
        Math.min(contentWidth - stripeW * 3, innerW),
        Math.max(8, Math.round(boxH * 0.4)),
        textColor,
      );
      cursorY += boxH + Math.round(16 * exportScale);
      continue;
    }

    if (block.tag === 'blockquote') {
      const boxH = Math.min(Math.round(76 * exportScale), Math.max(24, maxBodyY - cursorY));
      fillRect(padLeft, cursorY, contentWidth, boxH, surfaceColor);
      const barW = Math.max(4, Math.round(6 * exportScale));
      fillRect(padLeft, cursorY, barW, boxH, accentColor);
      const lineH = Math.max(6, Math.round(10 * exportScale));
      fillRect(
        padLeft + barW * 3,
        cursorY + Math.round(boxH * 0.28),
        Math.round(contentWidth * 0.78),
        lineH,
        textColor,
      );
      cursorY += boxH + Math.round(16 * exportScale);
      continue;
    }

    if (block.tag === 'pre' || block.tag === 'code') {
      const boxH = Math.min(Math.round(84 * exportScale), Math.max(24, maxBodyY - cursorY));
      fillRect(padLeft, cursorY, contentWidth, boxH, codeSurfaceColor);
      const lineH = Math.max(6, Math.round(9 * exportScale));
      fillRect(
        padLeft + Math.round(16 * exportScale),
        cursorY + Math.round(boxH * 0.25),
        Math.round(contentWidth * 0.65),
        lineH,
        accentColor,
      );
      fillRect(
        padLeft + Math.round(16 * exportScale),
        cursorY + Math.round(boxH * 0.58),
        Math.round(contentWidth * 0.48),
        lineH,
        textColor,
      );
      cursorY += boxH + Math.round(16 * exportScale);
      continue;
    }

    // Standard paragraph / list / table block
    const lineCount = Math.min(4, Math.max(1, Math.ceil((block.text.length || 12) / 28)));
    const lineH = Math.max(6, Math.round(10 * exportScale));
    const lineGap = Math.max(6, Math.round(9 * exportScale));
    for (let lineIdx = 0; lineIdx < lineCount; lineIdx++) {
      if (cursorY + lineH >= maxBodyY) break;
      const ratioW =
        lineIdx === lineCount - 1
          ? 0.45 + (((blockSeed >>> (lineIdx * 4)) & 0xf) / 15) * 0.4
          : 0.88 + (((blockSeed >>> (lineIdx * 3)) & 0x7) / 7) * 0.1;
      const lineW = Math.round(contentWidth * ratioW);
      fillRect(padLeft, cursorY, lineW, lineH, textColor);
      cursorY += lineH + lineGap;
    }
    cursorY += Math.round(10 * exportScale);
  }

  // Footer divider & page number bar
  const footerTopY = height - padBottom - footerH;
  fillRect(padLeft, footerTopY, contentWidth, dividerH, dividerColor);
  const footerBarH = Math.max(6, Math.round(9 * exportScale));
  const footerBarW = Math.max(36, Math.min(contentWidth, footerText.length * Math.round(8 * exportScale)));
  fillRect(
    width - padRight - footerBarW,
    footerTopY + Math.round((footerH - footerBarH) / 2),
    footerBarW,
    footerBarH,
    mutedTextColor,
  );

  const pngData = encodeRgbPng(width, height, rawRows);
  const crc32 = computeCrc32(pngData);
  const base64 = Buffer.from(pngData.buffer, pngData.byteOffset, pngData.byteLength).toString('base64');

  return {
    pageNumber,
    totalPages,
    fileName,
    ratio,
    layoutWidth,
    layoutHeight,
    width,
    height,
    exportScale,
    mimeType: 'image/png',
    data: pngData,
    dataUrl: `data:image/png;base64,${base64}`,
    crc32,
  };
}

function isDeliverySnapshot(
  source: DeliverySnapshot | string | HTMLElement,
): source is DeliverySnapshot {
  return (
    typeof source === 'object' &&
    source !== null &&
    'html' in source &&
    'targetId' in source &&
    typeof (source as DeliverySnapshot).html === 'string'
  );
}

export async function rasterizeCards(
  source: DeliverySnapshot | string | HTMLElement,
  assetStore?: AssetStore,
  options?: CardsExportOptions,
): Promise<CardsRasterizeResult> {
  const diagnostics: DiagnosticItem[] = [];

  if (isDeliverySnapshot(source)) {
    for (const d of source.diagnostics) {
      diagnostics.push(d);
    }
    if (source.targetId !== 'cards') {
      diagnostics.push({
        code: 'cards/invalid-target',
        message: `Cards rasterizer requires a snapshot with targetId "cards", but received "${source.targetId}".`,
        severity: 'error',
        targetId: source.targetId,
      });
    }
  }

  const parsed =
    typeof source === 'string'
      ? parseDocument(source)
      : isDeliverySnapshot(source)
      ? parseDocument(source.html)
      : null;

  const releaseCallbacks: Array<() => void> = [];
  const lockedAssetIds = new Set<string>();

  try {
    const rootContainer: HTMLElement = parsed
      ? ((parsed.doc.querySelector('.morph-doc') ||
          parsed.doc.body.firstElementChild ||
          parsed.doc.body) as HTMLElement)
      : (source as HTMLElement);

    // Inspect and lock referenced assets in AssetStore during export
    const assetCandidateElements = Array.from(
      rootContainer.querySelectorAll<HTMLElement>('[data-morph-asset-id], img[src^="morph-asset://"]'),
    );

    const reportedMissingAssets = new Set<string>(
      diagnostics.filter((d) => d.code === 'asset/not-found' && d.assetId).map((d) => d.assetId!),
    );
    const reportedUnreadyAssets = new Set<string>(
      diagnostics
        .filter((d) => d.code === 'asset/not-delivery-ready' && d.assetId)
        .map((d) => d.assetId!),
    );

    for (const el of assetCandidateElements) {
      let assetId = el.getAttribute('data-morph-asset-id') || '';
      const src = el.getAttribute('src') || '';
      if (!assetId && src.startsWith('morph-asset://')) {
        assetId = src.replace('morph-asset://', '').split('?')[0].split('#')[0];
      }
      if (!assetId || !assetStore) continue;

      const record = assetStore.get(assetId);
      if (!record) {
        if (!reportedMissingAssets.has(assetId)) {
          reportedMissingAssets.add(assetId);
          diagnostics.push({
            code: 'asset/not-found',
            message: `Referenced asset "${assetId}" was not found in AssetStore during cards export.`,
            severity: 'error',
            assetId,
            targetId: 'cards',
          });
        }
        continue;
      }

      if (!lockedAssetIds.has(assetId)) {
        lockedAssetIds.add(assetId);
        releaseCallbacks.push(assetStore.acquireLock(assetId));
      }

      if (record.status !== 'delivery-ready' && !reportedUnreadyAssets.has(assetId)) {
        reportedUnreadyAssets.add(assetId);
        diagnostics.push({
          code: 'asset/not-delivery-ready',
          message: `Asset "${assetId}" is not delivery-ready during cards export (status: ${record.status}).`,
          severity: 'warning',
          assetId,
          targetId: 'cards',
        });
      }

      if (record.dataUrl && el.tagName.toLowerCase() === 'img') {
        el.setAttribute('src', record.dataUrl);
      }
    }

    let pageElements = Array.from(
      rootContainer.querySelectorAll<HTMLElement>('section.morph-card-page, .morph-card-page'),
    );
    if (
      pageElements.length === 0 &&
      rootContainer.classList.contains('morph-card-page')
    ) {
      pageElements = [rootContainer];
    }

    if (pageElements.length === 0) {
      paginateDom(rootContainer, diagnostics, {
        ratio: options?.ratio ?? '3:4',
        headerText: options?.headerText,
        ...options?.paginationOptions,
      });
      pageElements = Array.from(
        rootContainer.querySelectorAll<HTMLElement>('section.morph-card-page, .morph-card-page'),
      );
    }

    const totalPages = pageElements.length;
    const padLen = Math.max(2, String(totalPages).length);
    const prefix = (options?.filePrefix || 'card').trim() || 'card';

    const requestedPageNumbers: number[] = [];
    if (options?.pageNumbers !== undefined) {
      for (const pageNum of options.pageNumbers) {
        if (!Number.isInteger(pageNum) || pageNum < 1 || pageNum > totalPages) {
          diagnostics.push({
            code: 'cards/page-out-of-range',
            message: `Requested card page ${String(pageNum)} is outside valid page range 1..${totalPages}.`,
            severity: 'warning',
            targetId: 'cards',
          });
        } else if (!requestedPageNumbers.includes(pageNum)) {
          requestedPageNumbers.push(pageNum);
        }
      }
    } else {
      for (let i = 1; i <= totalPages; i++) {
        requestedPageNumbers.push(i);
      }
    }

    const pages: CardPagePngArtifact[] = [];
    for (const pageNum of requestedPageNumbers) {
      const pageEl = pageElements[pageNum - 1];
      if (!pageEl) continue;
      const fileName = `${prefix}-${String(pageNum).padStart(padLen, '0')}.png`;
      const artifact = await rasterizeCardPage(pageEl, {
        ...options,
        pageNumber: pageNum,
        totalPages,
        fileName,
      });
      pages.push(artifact);
    }

    return {
      pages,
      diagnostics,
    };
  } finally {
    for (const release of releaseCallbacks) {
      try {
        release();
      } catch {
        // Ensure all remaining asset locks are released cleanly
      }
    }
    if (parsed) {
      parsed.cleanup();
    }
  }
}

function validateSafeZipEntryPath(entryPath: string): string {
  if (typeof entryPath !== 'string' || entryPath.trim().length === 0) {
    throw new Error('ZIP entry path must be a non-empty string.');
  }
  if (entryPath.includes('\0')) {
    throw new Error('ZIP entry path must not contain null bytes.');
  }
  if (entryPath.startsWith('/') || entryPath.startsWith('\\') || /^[a-zA-Z]:/.test(entryPath)) {
    throw new Error(`Unsafe absolute or drive-prefixed ZIP entry path: "${entryPath}"`);
  }
  const normalized = entryPath.replace(/\\/g, '/');
  const segments = normalized.split('/');
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..') {
      throw new Error(`Unsafe relative traversal segment in ZIP entry path: "${entryPath}"`);
    }
  }
  return normalized;
}

export function createZipArchive(
  entries: ReadonlyArray<{ path: string; data: Uint8Array }>,
): Uint8Array {
  const encoder = new TextEncoder();
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let currentOffset = 0;

  for (const entry of entries) {
    const safePath = validateSafeZipEntryPath(entry.path);
    const nameBytes = Buffer.from(encoder.encode(safePath));
    const payload = Buffer.from(entry.data.buffer, entry.data.byteOffset, entry.data.byteLength);
    const crc = computeCrc32(entry.data);
    const size = payload.byteLength;

    // Local File Header (30 bytes + filename)
    const localHeader = Buffer.alloc(30 + nameBytes.byteLength);
    localHeader.writeUInt32LE(0x04034b50, 0); // PK\x03\x04
    localHeader.writeUInt16LE(20, 4); // version needed to extract (2.0)
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    localHeader.writeUInt16LE(0, 8); // compression method: 0 (Store)
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0x2100, 12); // mod date
    localHeader.writeUInt32LE(crc, 14); // crc-32
    localHeader.writeUInt32LE(size, 18); // compressed size
    localHeader.writeUInt32LE(size, 22); // uncompressed size
    localHeader.writeUInt16LE(nameBytes.byteLength, 26); // filename length
    localHeader.writeUInt16LE(0, 28); // extra field length
    nameBytes.copy(localHeader, 30);

    localParts.push(localHeader, payload);

    // Central Directory File Header (46 bytes + filename)
    const centralHeader = Buffer.alloc(46 + nameBytes.byteLength);
    centralHeader.writeUInt32LE(0x02014b50, 0); // PK\x01\x02
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed to extract
    centralHeader.writeUInt16LE(0x0800, 8); // UTF-8 flag
    centralHeader.writeUInt16LE(0, 10); // compression method: 0 (Store)
    centralHeader.writeUInt16LE(0, 12); // mod time
    centralHeader.writeUInt16LE(0x2100, 14); // mod date
    centralHeader.writeUInt32LE(crc, 16); // crc-32
    centralHeader.writeUInt32LE(size, 20); // compressed size
    centralHeader.writeUInt32LE(size, 24); // uncompressed size
    centralHeader.writeUInt16LE(nameBytes.byteLength, 28); // filename length
    centralHeader.writeUInt16LE(0, 30); // extra field length
    centralHeader.writeUInt16LE(0, 32); // file comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal file attributes
    centralHeader.writeUInt32LE(0, 38); // external file attributes
    centralHeader.writeUInt32LE(currentOffset, 42); // relative offset of local header
    nameBytes.copy(centralHeader, 46);

    centralParts.push(centralHeader);
    currentOffset += localHeader.byteLength + size;
  }

  const centralDirOffset = currentOffset;
  const centralDirBuffer = Buffer.concat(centralParts);
  const centralDirSize = centralDirBuffer.byteLength;

  // End of Central Directory Record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // PK\x05\x06
  eocd.writeUInt16LE(0, 4); // number of this disk
  eocd.writeUInt16LE(0, 6); // disk where central directory starts
  eocd.writeUInt16LE(entries.length, 8); // central directory records on this disk
  eocd.writeUInt16LE(entries.length, 10); // total central directory records
  eocd.writeUInt32LE(centralDirSize, 12); // size of central directory
  eocd.writeUInt32LE(centralDirOffset, 16); // offset of start of central directory
  eocd.writeUInt16LE(0, 20); // comment length

  const archive = Buffer.concat([...localParts, centralDirBuffer, eocd]);
  return new Uint8Array(archive.buffer, archive.byteOffset, archive.byteLength);
}

export function parseZipArchive(zipData: Uint8Array): ZipEntryRecord[] {
  if (!(zipData instanceof Uint8Array) || zipData.byteLength < 22) {
    throw new Error('Invalid or truncated ZIP archive buffer.');
  }

  const view = new DataView(zipData.buffer, zipData.byteOffset, zipData.byteLength);
  const decoder = new TextDecoder('utf-8');

  // Locate End of Central Directory Record (PK\x05\x06 = 0x06054b50)
  let eocdOffset = -1;
  const minEocdOffset = Math.max(0, zipData.byteLength - 65557);
  for (let pos = zipData.byteLength - 22; pos >= minEocdOffset; pos--) {
    if (view.getUint32(pos, true) === 0x06054b50) {
      eocdOffset = pos;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error('End of Central Directory signature (PK\\x05\\x06) not found in ZIP archive.');
  }

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const centralDirSize = view.getUint32(eocdOffset + 12, true);
  const centralDirOffset = view.getUint32(eocdOffset + 16, true);

  if (centralDirOffset + centralDirSize > eocdOffset) {
    throw new Error('Corrupted ZIP central directory bounds.');
  }

  const records: ZipEntryRecord[] = [];
  let cdCursor = centralDirOffset;

  for (let i = 0; i < totalEntries; i++) {
    if (cdCursor + 46 > eocdOffset) {
      throw new Error('Truncated Central Directory header in ZIP archive.');
    }
    const cdSig = view.getUint32(cdCursor, true);
    if (cdSig !== 0x02014b50) {
      throw new Error(`Invalid Central Directory header signature: 0x${cdSig.toString(16)}`);
    }

    const compressionMethodRaw = view.getUint16(cdCursor + 10, true);
    if (compressionMethodRaw !== 0 && compressionMethodRaw !== 8) {
      throw new Error(`Unsupported ZIP compression method: ${compressionMethodRaw}`);
    }
    const compressionMethod = compressionMethodRaw as 0 | 8;
    const expectedCrc32 = view.getUint32(cdCursor + 16, true) >>> 0;
    const compressedSize = view.getUint32(cdCursor + 20, true);
    const uncompressedSize = view.getUint32(cdCursor + 24, true);
    const fileNameLen = view.getUint16(cdCursor + 28, true);
    const extraLen = view.getUint16(cdCursor + 30, true);
    const commentLen = view.getUint16(cdCursor + 32, true);
    const localHeaderOffset = view.getUint32(cdCursor + 42, true);

    const rawPath = decoder.decode(
      zipData.subarray(cdCursor + 46, cdCursor + 46 + fileNameLen),
    );
    const safePath = validateSafeZipEntryPath(rawPath);

    cdCursor += 46 + fileNameLen + extraLen + commentLen;

    if (localHeaderOffset + 30 > centralDirOffset) {
      throw new Error(`Local File Header out of bounds for entry "${safePath}".`);
    }
    const localSig = view.getUint32(localHeaderOffset, true);
    if (localSig !== 0x04034b50) {
      throw new Error(`Invalid Local File Header signature for entry "${safePath}".`);
    }

    const localNameLen = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;

    if (dataEnd > centralDirOffset) {
      throw new Error(`Truncated entry payload for "${safePath}".`);
    }

    const compressedSlice = zipData.subarray(dataStart, dataEnd);
    const extractedData =
      compressionMethod === 0
        ? compressedSlice.slice()
        : new Uint8Array(inflateRawSync(compressedSlice));

    if (extractedData.byteLength !== uncompressedSize) {
      throw new Error(
        `Uncompressed size mismatch for "${safePath}": expected ${uncompressedSize}, got ${extractedData.byteLength}.`,
      );
    }

    const actualCrc32 = computeCrc32(extractedData);
    if (actualCrc32 !== expectedCrc32) {
      throw new Error(
        `ZIP CRC-32 integrity check failed for "${safePath}": expected 0x${expectedCrc32.toString(16)}, got 0x${actualCrc32.toString(16)}.`,
      );
    }

    records.push({
      path: safePath,
      data: extractedData,
      crc32: actualCrc32,
      compressionMethod,
      compressedSize,
      uncompressedSize,
    });
  }

  return records;
}

export async function exportCardsZipPackage(
  source: DeliverySnapshot | string | HTMLElement,
  assetStore?: AssetStore,
  options?: CardsExportOptions,
): Promise<CardsZipExportResult> {
  const rasterResult = await rasterizeCards(source, assetStore, options);
  const { pages, diagnostics } = rasterResult;

  const firstPage = pages[0];
  const ratio: CardAspectRatio =
    firstPage?.ratio ?? (isValidRatio(options?.ratio) ? options.ratio : '3:4');
  const preset = getCardPreset(ratio);

  const exportScale =
    firstPage?.exportScale ??
    (typeof options?.scaleOverride === 'number' && options.scaleOverride > 0
      ? options.scaleOverride
      : preset.exportScale);
  const layoutWidth = firstPage?.layoutWidth ?? preset.layoutWidth;
  const layoutHeight = firstPage?.layoutHeight ?? preset.layoutHeight;
  const exportWidth = firstPage?.width ?? Math.round(layoutWidth * exportScale);
  const exportHeight = firstPage?.height ?? Math.round(layoutHeight * exportScale);
  const totalPages = firstPage?.totalPages ?? pages.length;

  const manifest: CardsExportManifest = {
    ratio,
    totalPages,
    exportedPages: pages.length,
    exportWidth,
    exportHeight,
    layoutWidth,
    layoutHeight,
    exportScale,
    pages: pages.map((p) => ({
      pageNumber: p.pageNumber,
      fileName: p.fileName,
      width: p.width,
      height: p.height,
      byteLength: p.data.byteLength,
      crc32: p.crc32,
    })),
  };

  const zipEntries: Array<{ path: string; data: Uint8Array }> = pages.map((p) => ({
    path: p.fileName,
    data: p.data,
  }));

  if (options?.includeManifest !== false) {
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
    zipEntries.push({
      path: 'manifest.json',
      data: manifestBytes,
    });
  }

  const zipData = createZipArchive(zipEntries);
  const prefix = (options?.filePrefix || 'card').trim() || 'card';
  const zipFileName = `${prefix}-${ratio.replace(':', 'x')}-cards.zip`;

  return {
    zipFileName,
    mimeType: 'application/zip',
    zipData,
    pages,
    manifest,
    diagnostics,
  };
}
