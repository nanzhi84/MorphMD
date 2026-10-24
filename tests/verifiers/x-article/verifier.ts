import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { xArticlePropertyRules } from './rules-text';
import type {
  DraftBlockType,
  DraftInlineStyle,
  DraftJsEntityRange,
  DraftJsInlineStyleRange,
  DraftJsSimulatedBlock,
  DraftJsSimulatedEntity,
  XArticleRuleKey,
  XArticleVerifyOpts,
  XArticleVerifyResult,
  XArticleViolationEntry,
  XArticleViolationItem,
} from './types';

let cachedJSDOM: any = null;

function parseHtmlDocumentStandalone(html: string): { doc: Document; cleanup: () => void } {
  if (typeof window !== 'undefined' && typeof document !== 'undefined' && document.implementation) {
    const doc = document.implementation.createHTMLDocument('');
    doc.body.innerHTML = html;
    return { doc, cleanup: () => {} };
  }

  if (!cachedJSDOM) {
    const proc = (globalThis as any).process;
    const req =
      proc?.getBuiltinModule?.('module')?.createRequire(import.meta.url) ||
      (typeof require !== 'undefined' ? require : null);
    if (!req) {
      throw new Error('JSDOM is required in Node environment for X-Article verification.');
    }
    cachedJSDOM = req('jsdom').JSDOM;
  }

  const dom = new cachedJSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://x.com/compose/article',
  });
  dom.window.document.body.innerHTML = html;
  return {
    doc: dom.window.document,
    cleanup: () => {
      try {
        dom.window.close();
      } catch {}
    },
  };
}

/**
 * Computes Draft.js `UnicodeUtils.strlen` (Unicode code point count) so surrogate pairs
 * (e.g., emoji, mathematical alphanumeric symbols) produce accurate RawDraftContentState
 * `offset` and `length` values without splitting astral symbols.
 */
function unicodeStrlen(str: string): number {
  let count = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
      }
    }
    count++;
  }
  return count;
}

const ALLOWED_X_ARTICLE_TAGS = new Set([
  'div',
  'h1',
  'h2',
  'p',
  'blockquote',
  'ul',
  'ol',
  'li',
  'pre',
  'code',
  'span',
  'strong',
  'b',
  'em',
  'i',
  'del',
  's',
  'strike',
  'u',
  'a',
  'img',
  'hr',
  'br',
  'figure',
  'figcaption',
]);

const HEADING_VIOLATION_TAGS = new Set(['h3', 'h4', 'h5', 'h6']);
const TABLE_TAGS = new Set([
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'caption',
  'colgroup',
  'col',
]);
const MATH_SELECTOR =
  '.morph-math, .morph-math-display, :not(img)[data-math-tex], math, .katex, .katex-display, .katex-mathml, .katex-html, mjx-container, .MathJax';
const EMPTY_CHECK_BLOCK_TAGS = new Set([
  'h1',
  'h2',
  'p',
  'blockquote',
  'pre',
  'ul',
  'ol',
  'li',
  'figure',
  'figcaption',
  'div',
]);

function hasVisibleText(str: string): boolean {
  return str.replace(/[\s\u200B-\u200D\uFEFF\uFFFC]+/g, '').length > 0;
}

const BLOCK_ELEMENT_TAGS = new Set([
  'div',
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'ul',
  'ol',
  'li',
  'pre',
  'hr',
  'figure',
  'figcaption',
  'section',
  'article',
  'aside',
  'nav',
  'header',
  'footer',
  'main',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'details',
  'fieldset',
  'form',
]);

const DISALLOWED_BLOCK_IN_LI = new Set([
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'pre',
  'hr',
  'table',
]);

function truncateOuterHtml(html: string, maxLen = 280): string {
  const sanitized = html.replace(
    /(data:image\/[a-z0-9.+-]+;base64,)[A-Za-z0-9+/=]{64,}/gi,
    (_, prefix: string) => `${prefix}...[truncated]`
  );
  if (sanitized.length <= maxLen) return sanitized;
  return `${sanitized.slice(0, maxLen)}...`;
}

function computeCrc32(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let b = 0; b < 8; b++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export interface RasterValidationResult {
  valid: boolean;
  reason?: string;
  width?: number;
  height?: number;
  hasContentPixels?: boolean;
  pixelDigest?: string;
}

/**
 * Validates that a `data:image/(png|jpeg|webp);base64,...` URI contains a real,
 * structurally decodable bitmap with positive dimensions, and (when `requireContentPixels`
 * is true for rasterized tables/math/SVG) non-blank foreground content pixels.
 */
export function inspectRasterDataUrl(
  src: string,
  requireContentPixels = false
): RasterValidationResult {
  const match = src.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/i);
  if (!match) {
    return { valid: false, reason: '非法的 Data URL 格式或不支持的图像 MIME 类型' };
  }

  const mime = match[1].toLowerCase();
  const b64 = match[2];
  if (b64.length < 16 || b64.length % 4 !== 0) {
    return { valid: false, reason: 'Base64 载荷长度非法或截断' };
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(b64, 'base64');
  } catch {
    return { valid: false, reason: 'Base64 解码失败' };
  }

  if (mime === 'png') {
    const pngSig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (bytes.length < 45) {
      return { valid: false, reason: 'PNG 字节长度不足最小合法头' };
    }
    for (let i = 0; i < 8; i++) {
      if (bytes[i] !== pngSig[i]) {
        return { valid: false, reason: 'PNG 魔数签名损坏' };
      }
    }

    const allowedBitDepths: Record<number, number[]> = {
      0: [1, 2, 4, 8, 16],
      2: [8, 16],
      3: [1, 2, 4, 8],
      4: [8, 16],
      6: [8, 16],
    };

    let offset = 8;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    let interlaceMethod = 0;
    let sawIhdr = false;
    let sawPlte = false;
    let pltePalette: Buffer | null = null;
    let sawIend = false;
    const idatChunks: Buffer[] = [];

    while (offset + 8 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const type = bytes.toString('ascii', offset + 4, offset + 8);
      const dataStart = offset + 8;
      const dataEnd = dataStart + length;
      const crcEnd = dataEnd + 4;
      if (crcEnd > bytes.length) {
        return { valid: false, reason: `PNG ${type} chunk 越界截断` };
      }

      const expectedCrc = bytes.readUInt32BE(dataEnd);
      const actualCrc = computeCrc32(bytes.subarray(offset + 4, dataEnd));
      if (expectedCrc !== actualCrc) {
        return { valid: false, reason: `PNG ${type} chunk CRC 校验失败` };
      }

      if (!sawIhdr) {
        if (type !== 'IHDR' || length !== 13) {
          return { valid: false, reason: 'PNG 首块必须为 13 字节 IHDR' };
        }
        width = bytes.readUInt32BE(dataStart);
        height = bytes.readUInt32BE(dataStart + 4);
        bitDepth = bytes[dataStart + 8];
        colorType = bytes[dataStart + 9];
        const compressionMethod = bytes[dataStart + 10];
        const filterMethod = bytes[dataStart + 11];
        interlaceMethod = bytes[dataStart + 12];
        if (width <= 0 || height <= 0 || width > 16384 || height > 16384) {
          return { valid: false, reason: `PNG 尺寸非法 (${width}x${height})` };
        }
        const validDepths = allowedBitDepths[colorType];
        if (!validDepths || !validDepths.includes(bitDepth)) {
          return {
            valid: false,
            reason: `PNG colorType=${colorType} 与 bitDepth=${bitDepth} 组合非法`,
          };
        }
        if (
          compressionMethod !== 0 ||
          filterMethod !== 0 ||
          (interlaceMethod !== 0 && interlaceMethod !== 1)
        ) {
          return { valid: false, reason: 'PNG IHDR 压缩/滤波/隔行扫描参数非法' };
        }
        sawIhdr = true;
      } else if (type === 'PLTE') {
        if (length === 0 || length % 3 !== 0 || length > 256 * 3) {
          return { valid: false, reason: 'PNG PLTE 调色板长度非法' };
        }
        sawPlte = true;
        pltePalette = bytes.subarray(dataStart, dataEnd);
      } else if (type === 'IDAT') {
        idatChunks.push(bytes.subarray(dataStart, dataEnd));
      } else if (type === 'IEND') {
        if (length !== 0) {
          return { valid: false, reason: 'PNG IEND chunk 长度必须为 0' };
        }
        sawIend = true;
        break;
      }

      offset = crcEnd;
    }

    if (!sawIhdr || !sawIend || idatChunks.length === 0) {
      return { valid: false, reason: 'PNG 缺失必要的 IHDR / IDAT / IEND 块' };
    }
    if (colorType === 3 && !sawPlte) {
      return { valid: false, reason: 'PNG 索引色模式 (colorType=3) 缺失必要的 PLTE 调色板块' };
    }

    let rawScanlines: Buffer;
    try {
      rawScanlines = inflateSync(Buffer.concat(idatChunks));
    } catch {
      return { valid: false, reason: 'PNG IDAT zlib 解压失败' };
    }

    if (rawScanlines.length === 0) {
      return { valid: false, reason: 'PNG 解压扫描线为空' };
    }

    const channelsByColorType: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
    const channels = channelsByColorType[colorType];
    if (!channels) {
      return { valid: false, reason: `PNG colorType=${colorType} 非法` };
    }

    const bitsPerPixel = channels * bitDepth;
    const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));

    const readPixelSample = (
      rowBuf: Buffer,
      rowStart: number,
      x: number
    ): number | string => {
      if (bitDepth === 8) {
        const px = rowStart + x * channels;
        if (colorType === 3 && pltePalette) {
          const idx = rowBuf[px];
          if (idx * 3 + 2 < pltePalette.length) {
            return (
              (pltePalette[idx * 3] << 16) |
              (pltePalette[idx * 3 + 1] << 8) |
              pltePalette[idx * 3 + 2]
            );
          }
          return idx;
        }
        if (channels === 4) {
          return (
            ((rowBuf[px] << 24) |
              (rowBuf[px + 1] << 16) |
              (rowBuf[px + 2] << 8) |
              rowBuf[px + 3]) >>>
            0
          );
        }
        if (channels === 3) {
          return (rowBuf[px] << 16) | (rowBuf[px + 1] << 8) | rowBuf[px + 2];
        }
        if (channels === 2) {
          return (rowBuf[px] << 8) | rowBuf[px + 1];
        }
        return rowBuf[px];
      }
      if (bitDepth === 16) {
        const px = rowStart + x * channels * 2;
        if (channels === 1) {
          return (rowBuf[px] << 8) | rowBuf[px + 1];
        }
        if (channels === 2) {
          return (
            ((rowBuf[px] << 24) |
              (rowBuf[px + 1] << 16) |
              (rowBuf[px + 2] << 8) |
              rowBuf[px + 3]) >>>
            0
          );
        }
        return rowBuf.subarray(px, px + channels * 2).toString('hex');
      }
      // Sub-byte depth: 1, 2, or 4 bits per pixel (channels === 1)
      const bitOffset = x * bitDepth;
      const byteIdx = rowStart + (bitOffset >> 3);
      const shift = 8 - bitDepth - (bitOffset & 7);
      const mask = (1 << bitDepth) - 1;
      const sample = (rowBuf[byteIdx] >> shift) & mask;
      if (colorType === 3 && pltePalette && sample * 3 + 2 < pltePalette.length) {
        return (
          (pltePalette[sample * 3] << 16) |
          (pltePalette[sample * 3 + 1] << 8) |
          pltePalette[sample * 3 + 2]
        );
      }
      return sample;
    };

    const yStart = width > 24 && height > 8 ? 1 : 0;
    const yEnd = width > 24 && height > 8 ? height - 1 : height;
    const xStart = width > 24 && height > 8 ? 24 : 0;
    const xEnd = width > 24 && height > 8 ? width - 1 : width;

    let unfilteredData: Buffer;
    const distinctColors = new Set<number | string>();

    if (interlaceMethod === 0) {
      const rowBytes = Math.ceil((width * bitsPerPixel) / 8);
      const expectedStride = 1 + rowBytes;
      if (rawScanlines.length < expectedStride * height) {
        return { valid: false, reason: 'PNG IDAT 扫描线数据长度不足或截断' };
      }

      unfilteredData = Buffer.alloc(rowBytes * height);
      for (let y = 0; y < height; y++) {
        const srcRowStart = y * expectedStride;
        const filterType = rawScanlines[srcRowStart];
        if (filterType > 4) {
          return { valid: false, reason: `PNG 第 ${y} 行滤波类型非法 (filter=${filterType})` };
        }
        const dstRowStart = y * rowBytes;
        const prevRowStart = (y - 1) * rowBytes;
        for (let i = 0; i < rowBytes; i++) {
          const rawByte = rawScanlines[srcRowStart + 1 + i];
          const a = i >= bpp ? unfilteredData[dstRowStart + i - bpp] : 0;
          const b = y > 0 ? unfilteredData[prevRowStart + i] : 0;
          const c = y > 0 && i >= bpp ? unfilteredData[prevRowStart + i - bpp] : 0;
          let recon = rawByte;
          if (filterType === 1) {
            recon = (rawByte + a) & 0xff;
          } else if (filterType === 2) {
            recon = (rawByte + b) & 0xff;
          } else if (filterType === 3) {
            recon = (rawByte + ((a + b) >> 1)) & 0xff;
          } else if (filterType === 4) {
            recon = (rawByte + paethPredictor(a, b, c)) & 0xff;
          }
          unfilteredData[dstRowStart + i] = recon;
        }
      }

      if (requireContentPixels && !(width <= 1 && height <= 1)) {
        for (let y = yStart; y < yEnd; y++) {
          const rowStart = y * rowBytes;
          for (let x = xStart; x < xEnd; x++) {
            distinctColors.add(readPixelSample(unfilteredData, rowStart, x));
            if (distinctColors.size >= 2) break;
          }
          if (distinctColors.size >= 2) break;
        }
      }
    } else {
      // Adam7 interlaceMethod === 1
      const x0 = [0, 4, 0, 2, 0, 1, 0];
      const dx = [8, 8, 4, 4, 2, 2, 1];
      const y0 = [0, 0, 4, 0, 2, 0, 1];
      const dy = [8, 8, 8, 4, 4, 2, 2];
      const passBuffers: Buffer[] = [];
      let scanOffset = 0;

      for (let p = 0; p < 7; p++) {
        const passW = Math.ceil((width - x0[p]) / dx[p]);
        const passH = Math.ceil((height - y0[p]) / dy[p]);
        if (passW <= 0 || passH <= 0) continue;
        const passRowBytes = Math.ceil((passW * bitsPerPixel) / 8);
        const passStride = 1 + passRowBytes;
        if (scanOffset + passStride * passH > rawScanlines.length) {
          return { valid: false, reason: 'PNG Adam7 隔行扫描数据长度不足或截断' };
        }
        const passUnfiltered = Buffer.alloc(passRowBytes * passH);
        for (let py = 0; py < passH; py++) {
          const srcRowStart = scanOffset + py * passStride;
          const filterType = rawScanlines[srcRowStart];
          if (filterType > 4) {
            return {
              valid: false,
              reason: `PNG Adam7 pass=${p} 行滤波类型非法 (filter=${filterType})`,
            };
          }
          const dstRowStart = py * passRowBytes;
          const prevRowStart = (py - 1) * passRowBytes;
          for (let i = 0; i < passRowBytes; i++) {
            const rawByte = rawScanlines[srcRowStart + 1 + i];
            const a = i >= bpp ? passUnfiltered[dstRowStart + i - bpp] : 0;
            const b = py > 0 ? passUnfiltered[prevRowStart + i] : 0;
            const c = py > 0 && i >= bpp ? passUnfiltered[prevRowStart + i - bpp] : 0;
            let recon = rawByte;
            if (filterType === 1) {
              recon = (rawByte + a) & 0xff;
            } else if (filterType === 2) {
              recon = (rawByte + b) & 0xff;
            } else if (filterType === 3) {
              recon = (rawByte + ((a + b) >> 1)) & 0xff;
            } else if (filterType === 4) {
              recon = (rawByte + paethPredictor(a, b, c)) & 0xff;
            }
            passUnfiltered[dstRowStart + i] = recon;
          }

          if (requireContentPixels && !(width <= 1 && height <= 1) && distinctColors.size < 2) {
            const fullY = y0[p] + py * dy[p];
            if (fullY >= yStart && fullY < yEnd) {
              for (let px = 0; px < passW; px++) {
                const fullX = x0[p] + px * dx[p];
                if (fullX >= xStart && fullX < xEnd) {
                  distinctColors.add(readPixelSample(passUnfiltered, dstRowStart, px));
                  if (distinctColors.size >= 2) break;
                }
              }
            }
          }
        }
        passBuffers.push(passUnfiltered);
        scanOffset += passStride * passH;
      }
      unfilteredData = Buffer.concat(passBuffers);
    }

    const digestHasher = createHash('sha256').update(unfilteredData);
    if (pltePalette) {
      digestHasher.update(pltePalette);
    }
    const pixelDigest = digestHasher.digest('hex').slice(0, 24);

    let hasContentPixels = true;
    if (requireContentPixels) {
      hasContentPixels = !(width <= 1 && height <= 1) && distinctColors.size >= 2;
      if (!hasContentPixels) {
        return {
          valid: false,
          width,
          height,
          hasContentPixels: false,
          pixelDigest,
          reason: '光栅化 PNG 内容区域仅含纯色背景占位，未绘制真实文本或图形像素',
        };
      }
    }

    return { valid: true, width, height, hasContentPixels, pixelDigest };
  }

  if (mime === 'jpeg') {
    if (bytes.length < 20 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
      return { valid: false, reason: 'JPEG SOI 魔数头非法' };
    }
    let width = 0;
    let height = 0;
    let sawSof = false;
    let sawSos = false;
    let sawEoi = bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
    let offset = 2;

    while (offset < bytes.length) {
      if (bytes[offset] !== 0xff) {
        return { valid: false, reason: 'JPEG 段标记损坏' };
      }
      while (offset < bytes.length && bytes[offset] === 0xff) {
        offset++;
      }
      if (offset >= bytes.length) break;
      const marker = bytes[offset++];
      if (marker === 0xd9) {
        sawEoi = true;
        break;
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        continue;
      }
      if (offset + 2 > bytes.length) {
        return { valid: false, reason: 'JPEG 段长度越界截断' };
      }
      const segLen = bytes.readUInt16BE(offset);
      if (segLen < 2 || offset + segLen > bytes.length) {
        return { valid: false, reason: 'JPEG 段数据长度非法或截断' };
      }
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        if (segLen < 8) {
          return { valid: false, reason: 'JPEG SOF 帧头长度不足' };
        }
        height = bytes.readUInt16BE(offset + 3);
        width = bytes.readUInt16BE(offset + 5);
        sawSof = true;
      }
      if (marker === 0xda) {
        sawSos = true;
        for (let i = offset + segLen; i + 1 < bytes.length; i++) {
          if (bytes[i] === 0xff && bytes[i + 1] === 0xd9) {
            sawEoi = true;
            break;
          }
        }
        break;
      }
      offset += segLen;
    }

    if (
      !sawSof ||
      !sawSos ||
      !sawEoi ||
      width <= 0 ||
      height <= 0 ||
      width > 16384 ||
      height > 16384
    ) {
      return { valid: false, reason: 'JPEG 缺失有效的 SOF/SOS/EOI 结构或尺寸非法' };
    }
    const pixelDigest = createHash('sha256').update(bytes).digest('hex').slice(0, 24);
    if (requireContentPixels && width <= 1 && height <= 1) {
      return {
        valid: false,
        width,
        height,
        hasContentPixels: false,
        pixelDigest,
        reason: '光栅化 JPEG 尺寸为 1x1 占位像素，未包含有效内容',
      };
    }
    return { valid: true, width, height, hasContentPixels: true, pixelDigest };
  }

  if (mime === 'webp') {
    if (
      bytes.length < 20 ||
      bytes.toString('ascii', 0, 4) !== 'RIFF' ||
      bytes.toString('ascii', 8, 12) !== 'WEBP'
    ) {
      return { valid: false, reason: 'WebP RIFF/WEBP 容器头非法' };
    }
    const riffSize = bytes.readUInt32LE(4);
    if (riffSize < 12 || riffSize + 8 > bytes.length) {
      return { valid: false, reason: 'WebP RIFF 载荷长度非法或截断' };
    }
    const chunkType = bytes.toString('ascii', 12, 16);
    const chunkSize = bytes.readUInt32LE(16);
    if (20 + chunkSize > bytes.length) {
      return { valid: false, reason: `WebP ${chunkType} chunk 长度越界截断` };
    }

    let width = 0;
    let height = 0;
    if (chunkType === 'VP8 ') {
      if (
        chunkSize < 10 ||
        bytes.length < 30 ||
        (bytes[20] & 1) !== 0 ||
        bytes[23] !== 0x9d ||
        bytes[24] !== 0x01 ||
        bytes[25] !== 0x2a
      ) {
        return { valid: false, reason: 'WebP VP8 帧头签名非法' };
      }
      width = bytes.readUInt16LE(26) & 0x3fff;
      height = bytes.readUInt16LE(28) & 0x3fff;
    } else if (chunkType === 'VP8L') {
      if (chunkSize < 5 || bytes.length < 25 || bytes[20] !== 0x2f) {
        return { valid: false, reason: 'WebP VP8L 无损帧头签名非法' };
      }
      const b0 = bytes[21];
      const b1 = bytes[22];
      const b2 = bytes[23];
      const b3 = bytes[24];
      width = 1 + (((b1 & 0x3f) << 8) | b0);
      height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
    } else if (chunkType === 'VP8X') {
      if (chunkSize < 10 || bytes.length < 30) {
        return { valid: false, reason: 'WebP VP8X 扩展帧头长度非法' };
      }
      width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
      height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
    } else {
      return { valid: false, reason: `WebP 首块类型非法 (${chunkType})` };
    }

    if (width <= 0 || height <= 0 || width > 16384 || height > 16384) {
      return { valid: false, reason: `WebP 尺寸非法 (${width}x${height})` };
    }
    const pixelDigest = createHash('sha256').update(bytes).digest('hex').slice(0, 24);
    if (requireContentPixels && width <= 1 && height <= 1) {
      return {
        valid: false,
        width,
        height,
        hasContentPixels: false,
        pixelDigest,
        reason: '光栅化 WebP 尺寸为 1x1 占位像素，未包含有效内容',
      };
    }
    return { valid: true, width, height, hasContentPixels: true, pixelDigest };
  }

  return { valid: false, reason: '未知图像格式' };
}

/**
 * Checks whether an element is inside an allowed syntax-highlighted `<pre>` block
 * within the current verification `root` boundary.
 */
function isInsideAllowedStyledBlock(
  el: Element,
  root: Element,
  allowCodeBlockStyles: boolean
): boolean {
  if (!allowCodeBlockStyles) return false;
  let curr: Element | null = el;
  while (curr) {
    const tag = curr.tagName.toLowerCase();
    if (tag === 'pre') {
      return true;
    }
    if (curr === root) break;
    curr = curr.parentElement;
  }
  return false;
}

function isValidHttpsImageSrc(src: string): boolean {
  if (!src || /[\s"'<>]/.test(src)) return false;
  try {
    const parsed = new URL(src);
    return parsed.protocol === 'https:' && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

function isSafeLinkHref(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('//')) return false;
  if (trimmed.startsWith('#') || trimmed.startsWith('/')) return true;
  if (/^(?:javascript|vbscript|data|blob|morph-asset):/i.test(trimmed)) return false;
  try {
    const parsed = new URL(trimmed);
    return (
      parsed.protocol === 'https:' ||
      parsed.protocol === 'http:' ||
      parsed.protocol === 'mailto:'
    );
  } catch {
    return false;
  }
}

function resolveVerificationRoot(articleBody: Element): {
  root: Element;
  hasNestedMorphDoc: boolean;
  nestedMorphDocs: Element[];
} {
  let root = articleBody;
  if (!articleBody.classList?.contains('morph-doc')) {
    const tag = articleBody.tagName.toLowerCase();
    if (tag === 'body') {
      const children = Array.from(articleBody.children);
      const hasDirectText = Array.from(articleBody.childNodes).some(
        (n) => n.nodeType === 3 && (n.textContent || '').trim().length > 0
      );
      if (
        children.length === 1 &&
        children[0].classList?.contains('morph-doc') &&
        !hasDirectText
      ) {
        root = children[0];
      }
    }
  }

  const nestedMorphDocs = Array.from(root.querySelectorAll('.morph-doc')).filter(
    (el) => el !== root
  );
  return {
    root,
    hasNestedMorphDoc: nestedMorphDocs.length > 0,
    nestedMorphDocs,
  };
}

function mergeAdjacentInlineStyleRanges(
  ranges: DraftJsInlineStyleRange[]
): DraftJsInlineStyleRange[] {
  if (ranges.length <= 1) return ranges;
  const sorted = [...ranges].sort((a, b) =>
    a.style !== b.style ? a.style.localeCompare(b.style) : a.offset - b.offset
  );
  const merged: DraftJsInlineStyleRange[] = [];
  for (const r of sorted) {
    const prev = merged[merged.length - 1];
    if (prev && prev.style === r.style && prev.offset + prev.length >= r.offset) {
      const end = Math.max(prev.offset + prev.length, r.offset + r.length);
      prev.length = end - prev.offset;
    } else {
      merged.push({ ...r });
    }
  }
  return merged.sort((a, b) => a.offset - b.offset || a.style.localeCompare(b.style));
}

function isStandaloneImageParagraph(el: Element): boolean {
  const imgs = el.querySelectorAll('img');
  if (imgs.length !== 1) return false;
  if (
    el.querySelector(
      'a, br, code, strong, b, em, i, del, s, strike, u, p, div, figure, figcaption, h1, h2, h3, h4, h5, h6, ul, ol, li, blockquote, pre, hr'
    )
  ) {
    return false;
  }
  return !hasVisibleText(el.textContent || '');
}

const GFM_RAW_CALLOUT_MARKER_RE = /\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i;
const GFM_ONLY_CALLOUT_MARKER_RE = /^\s*\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i;

function hasValidCalloutLeadTitle(bq: Element): boolean {
  const firstEl = bq.firstElementChild;
  if (!firstEl) return false;

  for (let n = bq.firstChild; n && n !== firstEl; n = n.nextSibling) {
    if (n.nodeType === 3 && hasVisibleText(n.textContent || '')) {
      return false;
    }
  }

  const firstTag = firstEl.tagName.toLowerCase();
  if (firstTag === 'strong' || firstTag === 'b') {
    const txt = firstEl.textContent || '';
    return hasVisibleText(txt) && !GFM_ONLY_CALLOUT_MARKER_RE.test(txt);
  }

  if (firstTag === 'p') {
    let firstMeaningfulChild: Node | null = null;
    for (let child = firstEl.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 8) continue;
      if (child.nodeType === 3 && !hasVisibleText(child.textContent || '')) continue;
      firstMeaningfulChild = child;
      break;
    }
    if (!firstMeaningfulChild || firstMeaningfulChild.nodeType !== 1) {
      return false;
    }
    const leadEl = firstMeaningfulChild as Element;
    const leadTag = leadEl.tagName.toLowerCase();
    if (leadTag !== 'strong' && leadTag !== 'b') {
      return false;
    }
    const txt = leadEl.textContent || '';
    return hasVisibleText(txt) && !GFM_ONLY_CALLOUT_MARKER_RE.test(txt);
  }

  return false;
}

function findOrphanTableTagInRawHtml(html: string): string | null {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, '');
  const tagRegex = /<([a-zA-Z][a-zA-Z0-9:-]*)(?:\s+(?:[^>"']|"[^"]*"|'[^']*')*)?\s*\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(withoutComments)) !== null) {
    const tagName = match[1].toLowerCase();
    if (TABLE_TAGS.has(tagName)) {
      return tagName;
    }
  }
  return null;
}

function hasNestedAnchorInRawHtml(html: string): boolean {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, '');
  const tagRegex = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)(?:\s+(?:[^>"']|"[^"]*"|'[^']*')*)?\s*\/?>/g;
  let openAnchorDepth = 0;
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(withoutComments)) !== null) {
    const isClosing = match[1] === '/';
    const tagName = match[2].toLowerCase();
    if (tagName !== 'a') continue;
    if (isClosing) {
      openAnchorDepth = Math.max(0, openAnchorDepth - 1);
    } else {
      if (openAnchorDepth > 0) {
        return true;
      }
      openAnchorDepth++;
    }
  }
  return false;
}

function collectVisibleDomText(node: Node): string {
  if (node.nodeType === 3) {
    return node.textContent || '';
  }
  if (node.nodeType !== 1) return '';
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (tag === 'script' || tag === 'style') return '';
  let acc = '';
  for (let child = el.firstChild; child; child = child.nextSibling) {
    acc += collectVisibleDomText(child);
  }
  return acc;
}

function simulateDraftJsWithSources(rootContainer: Element): {
  blocks: DraftJsSimulatedBlock[];
  entityMap: Record<number, DraftJsSimulatedEntity>;
  blockElements: Element[];
} {
  const blocks: DraftJsSimulatedBlock[] = [];
  const blockElements: Element[] = [];
  const entityMap: Record<number, DraftJsSimulatedEntity> = {};
  let nextEntityKey = 0;
  let nextBlockIdx = 0;

  function allocateEntity(entity: DraftJsSimulatedEntity): number {
    const key = nextEntityKey++;
    entityMap[key] = entity;
    return key;
  }

  function collectInlineContent(
    node: Node,
    activeStyles: Set<DraftInlineStyle>,
    outText: { value: string },
    styleRanges: DraftJsInlineStyleRange[],
    entityRanges: DraftJsEntityRange[],
    inCodeBlock = false
  ): void {
    if (node.nodeType === 3) {
      const rawTxt = node.textContent || '';
      const txt = rawTxt.replace(/\r\n?/g, '\n');
      if (!txt) return;
      const start = unicodeStrlen(outText.value);
      const cpLen = unicodeStrlen(txt);
      outText.value += txt;
      for (const st of activeStyles) {
        styleRanges.push({ offset: start, length: cpLen, style: st });
      }
      return;
    }

    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();

    if (tag === 'script' || tag === 'style') return;

    if (tag === 'br') {
      outText.value += '\n';
      return;
    }

    if (tag === 'img') {
      const start = unicodeStrlen(outText.value);
      outText.value += '\uFFFC';
      for (const st of activeStyles) {
        styleRanges.push({ offset: start, length: 1, style: st });
      }
      const entityKey = allocateEntity({
        type: 'IMAGE',
        mutability: 'IMMUTABLE',
        data: {
          src: el.getAttribute('src') || '',
          alt: el.getAttribute('alt') || '',
          rasterized: el.getAttribute('data-morph-rasterized') === 'true',
          rasterType: el.getAttribute('data-raster-type') || undefined,
        },
      });
      entityRanges.push({ offset: start, length: 1, key: entityKey });
      return;
    }

    const nextStyles = new Set(activeStyles);
    if (!inCodeBlock) {
      if (tag === 'strong' || tag === 'b') nextStyles.add('BOLD');
      if (tag === 'em' || tag === 'i') nextStyles.add('ITALIC');
      if (tag === 'u') nextStyles.add('UNDERLINE');
      if (tag === 'del' || tag === 's' || tag === 'strike') nextStyles.add('STRIKETHROUGH');
      if (tag === 'code') nextStyles.add('CODE');
    }

    const startOffset = unicodeStrlen(outText.value);
    for (let child = el.firstChild; child; child = child.nextSibling) {
      collectInlineContent(child, nextStyles, outText, styleRanges, entityRanges, inCodeBlock);
    }
    const len = unicodeStrlen(outText.value) - startOffset;

    if (tag === 'a' && len > 0) {
      const entityKey = allocateEntity({
        type: 'LINK',
        mutability: 'MUTABLE',
        data: {
          url: el.getAttribute('href') || '',
        },
      });
      entityRanges.push({ offset: startOffset, length: len, key: entityKey });
    }
  }

  function emitBlockFromNodes(
    type: DraftBlockType,
    nodes: Node[],
    depth = 0,
    inCodeBlock = false,
    sourceEl: Element = rootContainer
  ): void {
    const outText = { value: '' };
    const styleRanges: DraftJsInlineStyleRange[] = [];
    const entityRanges: DraftJsEntityRange[] = [];

    for (const n of nodes) {
      collectInlineContent(n, new Set(), outText, styleRanges, entityRanges, inCodeBlock);
    }

    let finalText = outText.value;
    let leadingTrimCp = 0;
    if (inCodeBlock && finalText.endsWith('\n')) {
      finalText = finalText.slice(0, -1);
    } else if (!inCodeBlock && type !== 'atomic') {
      const leadingMatch = finalText.match(/^\n+/);
      if (leadingMatch) {
        leadingTrimCp = unicodeStrlen(leadingMatch[0]);
        finalText = finalText.slice(leadingMatch[0].length);
      }
      finalText = finalText.replace(/\n+$/g, '');
    }

    const finalCpLen = unicodeStrlen(finalText);
    const shiftedStyles = styleRanges
      .map((r) => {
        const start = Math.max(0, r.offset - leadingTrimCp);
        const end = Math.min(finalCpLen, Math.max(0, r.offset + r.length - leadingTrimCp));
        return { style: r.style, offset: start, length: Math.max(0, end - start) };
      })
      .filter((r) => r.length > 0);
    const clampedStyles = mergeAdjacentInlineStyleRanges(shiftedStyles);

    const clampedEntities = entityRanges
      .map((r) => {
        const start = Math.max(0, r.offset - leadingTrimCp);
        const end = Math.min(finalCpLen, Math.max(0, r.offset + r.length - leadingTrimCp));
        return { key: r.key, offset: start, length: Math.max(0, end - start) };
      })
      .filter((r) => r.length > 0)
      .sort((a, b) => a.offset - b.offset || a.length - b.length);

    blocks.push({
      key: `blk_${nextBlockIdx++}`,
      type,
      text: finalText,
      depth,
      inlineStyleRanges: clampedStyles,
      entityRanges: clampedEntities,
    });
    blockElements.push(sourceEl);
  }

  function emitElementBlock(type: DraftBlockType, el: Element, depth = 0): void {
    const tag = el.tagName.toLowerCase();
    if (type === 'atomic' && tag === 'hr') {
      const entityKey = allocateEntity({
        type: 'DIVIDER',
        mutability: 'IMMUTABLE',
        data: {},
      });
      blocks.push({
        key: `blk_${nextBlockIdx++}`,
        type: 'atomic',
        text: ' ',
        depth: 0,
        inlineStyleRanges: [],
        entityRanges: [{ offset: 0, length: 1, key: entityKey }],
      });
      blockElements.push(el);
      return;
    }

    if (type === 'atomic') {
      const imgEl = tag === 'img' ? el : el.querySelector('img');
      if (imgEl) {
        emitBlockFromNodes('atomic', [imgEl], 0, false, el);
        return;
      }
    }

    if (tag === 'img') {
      emitBlockFromNodes(type, [el], depth, false, el);
      return;
    }

    const isCode = type === 'code-block' || tag === 'pre';
    const childNodes = isCode
      ? Array.from(el.childNodes)
      : trimBoundaryWhitespaceNodes(Array.from(el.childNodes));
    emitBlockFromNodes(type, childNodes, depth, isCode, el);
  }

  function hasMeaningfulInlineRun(nodes: Node[]): boolean {
    for (const n of nodes) {
      if (n.nodeType === 3 && hasVisibleText(n.textContent || '')) {
        return true;
      }
      if (n.nodeType === 1) {
        const el = n as Element;
        const tag = el.tagName.toLowerCase();
        if (tag === 'img' || tag === 'br') return true;
        if (el.querySelector('img, br') || hasVisibleText(el.textContent || '')) {
          return true;
        }
      }
    }
    return false;
  }

  function trimBoundaryWhitespaceNodes(nodes: Node[]): Node[] {
    const list = [...nodes];
    while (
      list.length > 0 &&
      list[0].nodeType === 3 &&
      !hasVisibleText(list[0].textContent || '')
    ) {
      list.shift();
    }
    while (
      list.length > 0 &&
      list[list.length - 1].nodeType === 3 &&
      !hasVisibleText(list[list.length - 1].textContent || '')
    ) {
      list.pop();
    }
    return list;
  }

  function walkListItem(li: Element, itemType: DraftBlockType, listDepth: number): void {
    let inlineBuffer: Node[] = [];
    let emittedAny = false;

    function flushLiBuffer(): void {
      if (!hasMeaningfulInlineRun(inlineBuffer)) {
        inlineBuffer = [];
        return;
      }
      const trimmed = trimBoundaryWhitespaceNodes(inlineBuffer);
      inlineBuffer = [];
      if (trimmed.length === 0) return;
      emitBlockFromNodes(itemType, trimmed, listDepth, false, li);
      emittedAny = true;
    }

    function walkLiNodes(nodes: Node[]): void {
      for (const n of nodes) {
        if (n.nodeType === 1) {
          const el = n as Element;
          const tag = el.tagName.toLowerCase();
          if (tag === 'ul' || tag === 'ol') {
            flushLiBuffer();
            walkList(el, listDepth + 1);
            emittedAny = true;
            continue;
          }
          if (BLOCK_ELEMENT_TAGS.has(tag)) {
            flushLiBuffer();
            if (el.querySelector('ul, ol, hr')) {
              walkLiNodes(Array.from(el.childNodes));
            } else if (tag === 'hr') {
              emitElementBlock('atomic', el, 0);
              emittedAny = true;
            } else {
              emitElementBlock(itemType, el, listDepth);
              emittedAny = true;
            }
            continue;
          }
        }
        inlineBuffer.push(n);
      }
    }

    walkLiNodes(Array.from(li.childNodes));
    flushLiBuffer();

    if (!emittedAny) {
      emitElementBlock(itemType, li, listDepth);
    }
  }

  function walkList(listEl: Element, listDepth: number): void {
    const listTag = listEl.tagName.toLowerCase();
    const itemType: DraftBlockType =
      listTag === 'ul' ? 'unordered-list-item' : 'ordered-list-item';
    let strayInlineBuffer: Node[] = [];

    function flushStrayInline(): void {
      if (!hasMeaningfulInlineRun(strayInlineBuffer)) {
        strayInlineBuffer = [];
        return;
      }
      const trimmed = trimBoundaryWhitespaceNodes(strayInlineBuffer);
      strayInlineBuffer = [];
      if (trimmed.length > 0) {
        const srcEl = (trimmed.find((n) => n.nodeType === 1) as Element | undefined) ?? listEl;
        emitBlockFromNodes(itemType, trimmed, listDepth, false, srcEl);
      }
    }

    for (const child of Array.from(listEl.childNodes)) {
      if (child.nodeType === 1) {
        const el = child as Element;
        const tag = el.tagName.toLowerCase();
        if (tag === 'li') {
          flushStrayInline();
          walkListItem(el, itemType, listDepth);
        } else if (tag === 'ul' || tag === 'ol') {
          flushStrayInline();
          walkList(el, listDepth + 1);
        } else if (BLOCK_ELEMENT_TAGS.has(tag)) {
          flushStrayInline();
          emitElementBlock(itemType, el, listDepth);
        } else {
          strayInlineBuffer.push(child);
        }
      } else {
        strayInlineBuffer.push(child);
      }
    }
    flushStrayInline();
  }

  function walkBlockquote(bqEl: Element): void {
    let inlineBuffer: Node[] = [];
    let emittedAny = false;

    function flushBqInline(): void {
      if (!hasMeaningfulInlineRun(inlineBuffer)) {
        inlineBuffer = [];
        return;
      }
      const trimmed = trimBoundaryWhitespaceNodes(inlineBuffer);
      inlineBuffer = [];
      if (trimmed.length > 0) {
        emitBlockFromNodes('blockquote', trimmed, 0, false, bqEl);
        emittedAny = true;
      }
    }

    for (const node of Array.from(bqEl.childNodes)) {
      if (node.nodeType === 1) {
        const el = node as Element;
        const tag = el.tagName.toLowerCase();
        if (
          tag === 'blockquote' ||
          tag === 'div' ||
          tag === 'figure' ||
          tag === 'section' ||
          tag === 'article'
        ) {
          flushBqInline();
          walkBlockquote(el);
          emittedAny = true;
        } else if (tag === 'ul' || tag === 'ol') {
          flushBqInline();
          walkList(el, 0);
          emittedAny = true;
        } else if (tag === 'hr') {
          flushBqInline();
          emitElementBlock('atomic', el, 0);
          emittedAny = true;
        } else if (BLOCK_ELEMENT_TAGS.has(tag)) {
          flushBqInline();
          emitElementBlock('blockquote', el, 0);
          emittedAny = true;
        } else {
          inlineBuffer.push(node);
        }
      } else {
        inlineBuffer.push(node);
      }
    }
    flushBqInline();

    if (!emittedAny && hasVisibleText(bqEl.textContent || '')) {
      emitElementBlock('blockquote', bqEl, 0);
    }
  }

  function walkBlockContainer(container: Element, listDepth = 0): void {
    const rootTag = container.tagName.toLowerCase();
    if (rootTag === 'h1') {
      emitElementBlock('header-one', container, 0);
      return;
    }
    if (rootTag === 'h2') {
      emitElementBlock('header-two', container, 0);
      return;
    }
    if (HEADING_VIOLATION_TAGS.has(rootTag)) {
      emitElementBlock('unstyled', container, 0);
      return;
    }
    if (
      rootTag === 'p' ||
      rootTag === 'figcaption' ||
      (rootTag === 'figure' && isStandaloneImageParagraph(container))
    ) {
      emitElementBlock(
        isStandaloneImageParagraph(container) ? 'atomic' : 'unstyled',
        container,
        0
      );
      return;
    }
    if (rootTag === 'pre') {
      emitElementBlock('code-block', container, 0);
      return;
    }
    if (rootTag === 'blockquote') {
      walkBlockquote(container);
      return;
    }
    if (rootTag === 'ul' || rootTag === 'ol') {
      walkList(container, listDepth);
      return;
    }
    if (rootTag === 'hr' || rootTag === 'img') {
      emitElementBlock('atomic', container, 0);
      return;
    }

    let inlineBuffer: Node[] = [];

    function flushInlineBuffer(): void {
      if (!hasMeaningfulInlineRun(inlineBuffer)) {
        inlineBuffer = [];
        return;
      }
      const trimmed = trimBoundaryWhitespaceNodes(inlineBuffer);
      inlineBuffer = [];
      if (trimmed.length === 0) return;

      if (
        trimmed.length === 1 &&
        trimmed[0].nodeType === 1 &&
        ((trimmed[0] as Element).tagName.toLowerCase() === 'img' ||
          isStandaloneImageParagraph(trimmed[0] as Element))
      ) {
        emitElementBlock('atomic', trimmed[0] as Element, 0);
        return;
      }

      const srcEl = (trimmed.find((n) => n.nodeType === 1) as Element | undefined) ?? container;
      emitBlockFromNodes('unstyled', trimmed, listDepth, false, srcEl);
    }

    for (const child of Array.from(container.childNodes)) {
      if (child.nodeType === 1) {
        const el = child as Element;
        const tag = el.tagName.toLowerCase();

        if (tag === 'h1') {
          flushInlineBuffer();
          emitElementBlock('header-one', el, 0);
        } else if (tag === 'h2') {
          flushInlineBuffer();
          emitElementBlock('header-two', el, 0);
        } else if (HEADING_VIOLATION_TAGS.has(tag)) {
          flushInlineBuffer();
          emitElementBlock('unstyled', el, 0);
        } else if (
          tag === 'p' ||
          tag === 'figcaption' ||
          (tag === 'figure' && isStandaloneImageParagraph(el))
        ) {
          flushInlineBuffer();
          emitElementBlock(isStandaloneImageParagraph(el) ? 'atomic' : 'unstyled', el, 0);
        } else if (tag === 'pre') {
          flushInlineBuffer();
          emitElementBlock('code-block', el, 0);
        } else if (tag === 'hr') {
          flushInlineBuffer();
          emitElementBlock('atomic', el, 0);
        } else if (tag === 'blockquote') {
          flushInlineBuffer();
          walkBlockquote(el);
        } else if (tag === 'ul' || tag === 'ol') {
          flushInlineBuffer();
          walkList(el, listDepth);
        } else if (
          tag === 'div' ||
          tag === 'figure' ||
          tag === 'section' ||
          tag === 'article' ||
          tag === 'aside' ||
          tag === 'nav' ||
          tag === 'header' ||
          tag === 'footer' ||
          tag === 'main'
        ) {
          flushInlineBuffer();
          walkBlockContainer(el, listDepth);
        } else if (TABLE_TAGS.has(tag)) {
          flushInlineBuffer();
          emitElementBlock('unstyled', el, listDepth);
        } else if (tag === 'li') {
          flushInlineBuffer();
          emitElementBlock('unstyled', el, listDepth);
        } else {
          // Inline element (strong, em, span, a, code, img, br, etc.)
          inlineBuffer.push(child);
        }
      } else {
        inlineBuffer.push(child);
      }
    }

    flushInlineBuffer();
  }

  walkBlockContainer(rootContainer, 0);

  return { blocks, entityMap, blockElements };
}

/**
 * Simulates X Articles' Draft.js `convertFromHTML` DOM-to-ContentState parser,
 * producing structured `ContentBlock[]` and `entityMap`.
 */
export function simulateDraftJsConvertFromHtml(rootContainer: Element): {
  blocks: DraftJsSimulatedBlock[];
  entityMap: Record<number, DraftJsSimulatedEntity>;
} {
  const { blocks, entityMap } = simulateDraftJsWithSources(rootContainer);
  return { blocks, entityMap };
}

/**
 * Verifies an HTML DOM container against the X Articles (`x.com/compose/article`)
 * Draft.js structure, media, and style capability specification.
 */
export function verifyXArticleStructure(
  articleBody: Element,
  opts: XArticleVerifyOpts = {}
): XArticleVerifyResult {
  const allowCodeBlockStyles = opts.allowCodeBlockStyles ?? true;
  const maxListDepth = opts.maxListDepth ?? 4;
  const { root, hasNestedMorphDoc, nestedMorphDocs } = resolveVerificationRoot(articleBody);
  const inValidInfo: Record<string, XArticleViolationEntry> = {};

  function addViolation(key: XArticleRuleKey, item: XArticleViolationItem): void {
    const ruleDesc = xArticlePropertyRules[key] || key;
    if (!inValidInfo[key]) {
      inValidInfo[key] = {
        violateRules: ruleDesc,
        items: [],
      };
    }
    inValidInfo[key].items.push({
      ...item,
      outerHTML: truncateOuterHtml(item.outerHTML),
      nodeId: item.nodeId,
      sourceRange: item.sourceRange,
    });
  }

  const topBlocks = Array.from(root.children);
  function resolveBlockIndex(node: Element): number {
    if (node === root || node === articleBody) return 0;
    let curr: Element | null = node;
    while (curr && curr.parentElement && curr.parentElement !== root) {
      curr = curr.parentElement;
    }
    return curr ? topBlocks.indexOf(curr) : -1;
  }

  function resolveInheritedAttr(node: Element, attrName: string): string | undefined {
    let curr: Element | null = node;
    while (curr) {
      const val = curr.getAttribute(attrName);
      if (val) return val;
      if (curr === root || curr === articleBody) break;
      curr = curr.parentElement;
    }
    return undefined;
  }

  function buildItemMeta(node: Element, rules: string, tagName?: string): XArticleViolationItem {
    return {
      blockIndex: resolveBlockIndex(node),
      outerHTML: node.outerHTML,
      tagName: tagName ?? node.tagName.toLowerCase(),
      nodeId: resolveInheritedAttr(node, 'data-node-id'),
      sourceRange: resolveInheritedAttr(node, 'data-source-range'),
      rules,
    };
  }

  if (articleBody !== root) {
    const bodyTag = articleBody.tagName.toLowerCase();
    const bodyStyle = articleBody.getAttribute('style');
    if (bodyStyle && bodyStyle.trim().length > 0) {
      addViolation(
        'native-inline-style',
        buildItemMeta(articleBody, xArticlePropertyRules['native-inline-style'], bodyTag)
      );
    }
    const bodyAttrs =
      typeof articleBody.getAttributeNames === 'function' ? articleBody.getAttributeNames() : [];
    for (const attrName of bodyAttrs) {
      if (/^on[a-z]+/i.test(attrName)) {
        addViolation(
          'unsafe-media-or-link',
          buildItemMeta(
            articleBody,
            `危险的内联事件属性 ${attrName}：${xArticlePropertyRules['unsafe-media-or-link']}`,
            bodyTag
          )
        );
      }
    }
  }

  // Flag nested .morph-doc container spoofing
  if (hasNestedMorphDoc) {
    for (const nested of nestedMorphDocs) {
      addViolation(
        'unsupported-element',
        buildItemMeta(
          nested,
          `检测到嵌套的 .morph-doc 根容器，可能导致校验范围被截断：${xArticlePropertyRules['unsupported-element']}`,
          nested.tagName.toLowerCase()
        )
      );
    }
  }

  // 1. #1.1 heading-level: h3 ~ h6 (including root if root itself is h3~h6) and invalid [data-original-heading]
  const reportedHeadings = new Set<Element>();
  const headingNodes = [
    ...(HEADING_VIOLATION_TAGS.has(root.tagName.toLowerCase()) ? [root] : []),
    ...Array.from(root.querySelectorAll('h3, h4, h5, h6')),
  ];
  for (const heading of headingNodes) {
    reportedHeadings.add(heading);
    addViolation(
      'heading-level',
      buildItemMeta(heading, xArticlePropertyRules['heading-level'])
    );
  }

  const origHeadingNodes = [
    ...(root.hasAttribute('data-original-heading') ? [root] : []),
    ...Array.from(root.querySelectorAll('[data-original-heading]')),
  ];
  for (const el of origHeadingNodes) {
    if (reportedHeadings.has(el)) continue;
    const tag = el.tagName.toLowerCase();
    const origVal = (el.getAttribute('data-original-heading') || '').trim();
    if (tag !== 'h2' || !/^h[3-6]$/i.test(origVal)) {
      reportedHeadings.add(el);
      addViolation(
        'heading-level',
        buildItemMeta(
          el,
          `data-original-heading 属性仅允许挂载在归一化后的 <h2> 上且值必须为 h3~h6（当前为 <${tag} data-original-heading="${origVal}">）：${xArticlePropertyRules['heading-level']}`,
          tag
        )
      );
    }
  }

  // 2. #1.2 callout-structure: div.morph-callout, malformed blockquote.morph-callout, or uncleaned GFM [!NOTE] markers
  const rawCalloutSelector =
    'div.morph-callout, .morph-callout:not(blockquote), [data-callout-type]:not(blockquote), .morph-callout-title, .morph-callout-body';
  const rawCallouts = [
    ...(root.matches?.(rawCalloutSelector) ? [root] : []),
    ...Array.from(root.querySelectorAll(rawCalloutSelector)),
  ];
  const reportedCallouts = new Set<Element>();
  for (const calloutNode of rawCallouts) {
    const container =
      calloutNode.closest(
        'div.morph-callout, .morph-callout:not(blockquote), [data-callout-type]:not(blockquote), blockquote.morph-callout, blockquote[data-callout-type]'
      ) || calloutNode;
    const bounded = root.contains(container) ? container : calloutNode;
    if (reportedCallouts.has(bounded)) continue;
    reportedCallouts.add(bounded);
    addViolation(
      'callout-structure',
      buildItemMeta(bounded, xArticlePropertyRules['callout-structure'])
    );
  }

  const bqCallouts = [
    ...(root.matches?.('blockquote.morph-callout, blockquote[data-callout-type]') ? [root] : []),
    ...Array.from(root.querySelectorAll('blockquote.morph-callout, blockquote[data-callout-type]')),
  ];
  for (const bq of bqCallouts) {
    if (reportedCallouts.has(bq)) continue;
    if (!hasValidCalloutLeadTitle(bq)) {
      reportedCallouts.add(bq);
      addViolation(
        'callout-structure',
        buildItemMeta(
          bq,
          `Callout 转换后的 <blockquote> 缺少非空加粗首段标题：${xArticlePropertyRules['callout-structure']}`,
          'blockquote'
        )
      );
    }
  }

  // Scan text nodes for uncleaned GFM callout markers ([!NOTE], [!TIP], [!IMPORTANT], [!WARNING], [!CAUTION])
  function scanForRawGfmCalloutMarkers(node: Node): void {
    if (node.nodeType === 3) {
      const txt = node.textContent || '';
      if (GFM_RAW_CALLOUT_MARKER_RE.test(txt)) {
        const parentEl = node.parentElement;
        if (!parentEl) return;
        if (
          parentEl.closest(
            'pre, code, script, style, svg, math, .katex, .morph-math, .morph-math-display, table'
          )
        ) {
          return;
        }
        const target =
          parentEl.closest('blockquote') ||
          parentEl.closest('p, div, li, h1, h2, h3, h4, h5, h6') ||
          parentEl;
        const boundedTarget = root.contains(target) ? target : root;
        for (const existing of reportedCallouts) {
          if (existing === boundedTarget || existing.contains(boundedTarget)) {
            return;
          }
        }
        reportedCallouts.add(boundedTarget);
        addViolation(
          'callout-structure',
          buildItemMeta(
            boundedTarget,
            `检测到未清洗的 GFM Callout 原始标记（如 [!NOTE]/[!WARNING]）：${xArticlePropertyRules['callout-structure']}`
          )
        );
      }
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (
      tag === 'pre' ||
      tag === 'code' ||
      tag === 'script' ||
      tag === 'style' ||
      tag === 'svg' ||
      tag === 'math' ||
      tag === 'table'
    ) {
      return;
    }
    for (let child = el.firstChild; child; child = child.nextSibling) {
      scanForRawGfmCalloutMarkers(child);
    }
  }
  scanForRawGfmCalloutMarkers(root);

  // 3. #1.3 unrasterized-table: raw <table> or orphan table cells
  const tableContainers = new Set<Element>();
  const rawTableNodes = [
    ...(TABLE_TAGS.has(root.tagName.toLowerCase()) ? [root] : []),
    ...Array.from(
      root.querySelectorAll('table, thead, tbody, tfoot, tr, th, td, caption, colgroup, col')
    ),
  ];
  for (const tableNode of rawTableNodes) {
    const container =
      tableNode.closest('table') ||
      tableNode.closest('thead, tbody, tfoot, colgroup') ||
      tableNode.closest('tr') ||
      tableNode;
    tableContainers.add(root.contains(container) ? container : tableNode);
  }
  for (const tableEl of tableContainers) {
    addViolation(
      'unrasterized-table',
      buildItemMeta(tableEl, xArticlePropertyRules['unrasterized-table'])
    );
  }

  // 4. #2.1 unrasterized-math: raw <math>, .katex, .katex-mathml, .katex-html, or unrasterized .morph-math
  const rawMathContainers = new Set<Element>();
  const mathCandidates = [
    ...(root.matches?.(MATH_SELECTOR) ? [root] : []),
    ...Array.from(root.querySelectorAll(MATH_SELECTOR)),
  ];
  for (const mathNode of mathCandidates) {
    const closestContainer =
      mathNode.closest('.morph-math, .morph-math-display, :not(img)[data-math-tex]') ||
      mathNode.closest('.katex-display') ||
      mathNode.closest('.katex') ||
      mathNode.closest('mjx-container') ||
      mathNode.closest('.MathJax') ||
      mathNode.closest('math') ||
      mathNode;
    const container = root.contains(closestContainer) ? closestContainer : mathNode;
    const tag = container.tagName.toLowerCase();
    const isMorphMathWrapper =
      container.classList.contains('morph-math') ||
      container.classList.contains('morph-math-display') ||
      (container.hasAttribute('data-math-tex') && tag !== 'img');

    if (
      !isMorphMathWrapper &&
      (tag === 'math' ||
        tag === 'mjx-container' ||
        container.classList.contains('katex') ||
        container.classList.contains('katex-display') ||
        container.classList.contains('MathJax'))
    ) {
      rawMathContainers.add(container);
      continue;
    }
    if (isMorphMathWrapper) {
      const hasRawSubtree = Boolean(
        container.querySelector(
          'math, .katex, .katex-display, .katex-mathml, .katex-html, mjx-container, .MathJax, svg'
        )
      );
      const rasterImgs = Array.from(
        container.querySelectorAll('img[data-morph-rasterized="true"]')
      );
      const firstImg = rasterImgs[0];
      const validRasterType =
        Boolean(firstImg) &&
        (!firstImg.hasAttribute('data-raster-type') ||
          firstImg.getAttribute('data-raster-type') === 'math');
      const isCleanRasterContainer =
        !hasRawSubtree &&
        rasterImgs.length === 1 &&
        container.children.length === 1 &&
        container.firstElementChild === firstImg &&
        validRasterType &&
        !hasVisibleText(container.textContent || '');
      if (!isCleanRasterContainer) {
        rawMathContainers.add(container);
      }
    } else {
      rawMathContainers.add(container);
    }
  }

  const mathContainers = new Set<Element>();
  for (const candidate of rawMathContainers) {
    let hasFlaggedAncestor = false;
    for (const other of rawMathContainers) {
      if (other !== candidate && other.contains(candidate)) {
        hasFlaggedAncestor = true;
        break;
      }
    }
    if (!hasFlaggedAncestor) {
      mathContainers.add(candidate);
    }
  }

  for (const mathEl of mathContainers) {
    addViolation(
      'unrasterized-math',
      buildItemMeta(mathEl, xArticlePropertyRules['unrasterized-math'])
    );
  }

  // 5. #2.2 unrasterized-svg: raw <svg> (skip if inside mathContainers or nested inside another <svg>)
  const svgNodes = [
    ...(root.tagName.toLowerCase() === 'svg' ? [root] : []),
    ...Array.from(root.querySelectorAll('svg')),
  ];
  for (const svg of svgNodes) {
    const parentSvg = svg === root ? null : svg.parentElement?.closest('svg');
    if (parentSvg && root.contains(parentSvg)) continue;

    let coveredByFlaggedMath = false;
    for (const mathEl of mathContainers) {
      if (mathEl.contains(svg)) {
        coveredByFlaggedMath = true;
        break;
      }
    }
    if (coveredByFlaggedMath) continue;
    addViolation(
      'unrasterized-svg',
      buildItemMeta(svg, xArticlePropertyRules['unrasterized-svg'], 'svg')
    );
  }

  // Track rasterized bitmap digests to catch static placeholder reuse across distinct semantic content
  const rasterDigestMap = new Map<
    string,
    { alt: string; rasterType: string; mathTex: string }
  >();

  // 6. Inspect root + all descendants for unsupported elements, styles, links/media, and entity conflicts
  const allElements = [root, ...Array.from(root.querySelectorAll('*'))];
  for (const el of allElements) {
    const tag = el.tagName.toLowerCase();
    const isRootContainer = el === root && (tag === 'body' || tag === 'div');

    // Inline event handler attributes (onclick, onerror, onload, etc.) must be checked on ALL elements
    const attrNames = typeof el.getAttributeNames === 'function' ? el.getAttributeNames() : [];
    for (const attrName of attrNames) {
      if (/^on[a-z]+/i.test(attrName)) {
        addViolation(
          'unsafe-media-or-link',
          buildItemMeta(
            el,
            `危险的内联事件属性 ${attrName}：${xArticlePropertyRules['unsafe-media-or-link']}`,
            tag
          )
        );
      }
    }

    // Skip internals of already-flagged table/math/svg subtrees to avoid duplicate noise
    if (TABLE_TAGS.has(tag)) continue;
    let insideFlaggedMath = false;
    for (const mathEl of mathContainers) {
      if (mathEl === el || mathEl.contains(el)) {
        insideFlaggedMath = true;
        break;
      }
    }
    if (insideFlaggedMath) continue;
    if (tag === 'svg' || el.closest('svg')) continue;

    if (!isRootContainer) {
      if (HEADING_VIOLATION_TAGS.has(tag)) {
        // Already reported under heading-level
      } else if (!ALLOWED_X_ARTICLE_TAGS.has(tag)) {
        addViolation(
          'unsupported-element',
          buildItemMeta(
            el,
            `不支持的标签 <${tag}>：${xArticlePropertyRules['unsupported-element']}`,
            tag
          )
        );
      } else if (tag === 'li') {
        const parentTag = el === root ? undefined : el.parentElement?.tagName.toLowerCase();
        if (parentTag !== 'ul' && parentTag !== 'ol') {
          addViolation(
            'unsupported-element',
            buildItemMeta(
              el,
              `孤立 <li> 节点未包裹在 <ul> 或 <ol> 内：${xArticlePropertyRules['unsupported-element']}`,
              'li'
            )
          );
        }
        // Check for disallowed complex block elements inside <li> (direct or wrapped)
        for (const descEl of Array.from(
          el.querySelectorAll('h1, h2, h3, h4, h5, h6, blockquote, pre, hr, table')
        )) {
          if (descEl.closest('li') !== el) continue;
          const descTag = descEl.tagName.toLowerCase();
          if (DISALLOWED_BLOCK_IN_LI.has(descTag)) {
            addViolation(
              'unsupported-element',
              buildItemMeta(
                descEl,
                `列表项 <li> 内部不允许嵌套复杂块级元素 <${descTag}>：${xArticlePropertyRules['unsupported-element']}`,
                descTag
              )
            );
          }
        }
      } else if (tag === 'h1' || tag === 'h2') {
        const blockSelector = Array.from(BLOCK_ELEMENT_TAGS).join(', ');
        for (const descEl of Array.from(el.querySelectorAll('*'))) {
          const descTag = descEl.tagName.toLowerCase();
          if (BLOCK_ELEMENT_TAGS.has(descTag)) {
            const parentBlock = descEl.parentElement?.closest(blockSelector);
            if (parentBlock && parentBlock !== el && el.contains(parentBlock)) {
              continue;
            }
            addViolation(
              'unsupported-element',
              buildItemMeta(
                descEl,
                `标题 <${tag}> 内部不允许嵌套块级元素 <${descTag}>：${xArticlePropertyRules['unsupported-element']}`,
                descTag
              )
            );
          }
        }
      } else if (tag === 'pre') {
        const preDisallowedSelector = [...BLOCK_ELEMENT_TAGS, 'img'].join(', ');
        for (const descEl of Array.from(el.querySelectorAll('*'))) {
          const descTag = descEl.tagName.toLowerCase();
          if (BLOCK_ELEMENT_TAGS.has(descTag) || descTag === 'img') {
            const parentDisallowed = descEl.parentElement?.closest(preDisallowedSelector);
            if (parentDisallowed && parentDisallowed !== el && el.contains(parentDisallowed)) {
              continue;
            }
            addViolation(
              'unsupported-element',
              buildItemMeta(
                descEl,
                `代码块 <pre> 内部仅允许纯文本与行内修饰标签，不允许嵌套 <${descTag}>：${xArticlePropertyRules['unsupported-element']}`,
                descTag
              )
            );
          }
        }
      } else if (tag === 'ul' || tag === 'ol') {
        for (const childEl of Array.from(el.children)) {
          if (childEl.tagName.toLowerCase() !== 'li') {
            addViolation(
              'unsupported-element',
              buildItemMeta(
                childEl,
                `列表 <${tag}> 的直接子元素必须为 <li>（检测到 <${childEl.tagName.toLowerCase()}>）：${xArticlePropertyRules['unsupported-element']}`,
                childEl.tagName.toLowerCase()
              )
            );
          }
        }
      } else if (tag === 'blockquote') {
        const parentBq = el.parentElement?.closest('blockquote');
        if (parentBq && root.contains(parentBq)) {
          addViolation(
            'unsupported-element',
            buildItemMeta(
              el,
              `X Articles 不支持嵌套 <blockquote> 引用层级：${xArticlePropertyRules['unsupported-element']}`,
              'blockquote'
            )
          );
        }
      }
    }

    // #3.1 native-inline-style (including on root itself)
    const styleAttr = el.getAttribute('style');
    if (
      styleAttr &&
      styleAttr.trim().length > 0 &&
      !isInsideAllowedStyledBlock(el, root, allowCodeBlockStyles)
    ) {
      addViolation(
        'native-inline-style',
        buildItemMeta(el, xArticlePropertyRules['native-inline-style'], tag)
      );
    }

    // #2.3 unsafe-media-or-link on <img>
    if (tag === 'img') {
      const rawSrc = el.getAttribute('src') || '';
      const hasSrcWhitespace = /\s/.test(rawSrc);
      const src = rawSrc.trim();
      const hasExplicitRasterAttr = el.getAttribute('data-morph-rasterized') === 'true';
      const rasterContainer = el.closest(
        '.morph-math, .morph-math-display, [data-morph-raster-container]'
      );
      const hasImplicitRasterSignals =
        el.hasAttribute('data-raster-type') ||
        el.hasAttribute('data-math-tex') ||
        el.classList.contains('morph-raster-img') ||
        Boolean(rasterContainer && root.contains(rasterContainer));
      const isRasterized = hasExplicitRasterAttr || hasImplicitRasterSignals;
      const alt = (el.getAttribute('alt') || '').trim();
      let validSrc = false;
      let failureDetail = '';
      let pixelDigest: string | undefined;

      if (!rawSrc || hasSrcWhitespace) {
        validSrc = false;
        failureDetail = hasSrcWhitespace
          ? `图片 src 包含非法空白字符 (${src.slice(0, 48)})`
          : '图片缺失有效的 src 属性';
      } else if (/^data:/i.test(src)) {
        const rasterCheck = inspectRasterDataUrl(src, isRasterized);
        validSrc = rasterCheck.valid;
        pixelDigest = rasterCheck.pixelDigest;
        if (!validSrc) {
          failureDetail = rasterCheck.reason || 'Data URL 位图校验失败';
        }
      } else if (isValidHttpsImageSrc(src)) {
        validSrc = true;
      } else {
        failureDetail = `图片 src 协议不满足 X Articles 交付要求 (${src.slice(0, 48)})`;
      }

      if (!validSrc) {
        addViolation(
          'unsafe-media-or-link',
          buildItemMeta(
            el,
            `${failureDetail}：${xArticlePropertyRules['unsafe-media-or-link']}`,
            'img'
          )
        );
      }

      if (hasImplicitRasterSignals && !hasExplicitRasterAttr) {
        addViolation(
          'unsafe-media-or-link',
          buildItemMeta(
            el,
            `光栅化降级图片缺失必选属性 data-morph-rasterized="true"：${xArticlePropertyRules['unsafe-media-or-link']}`,
            'img'
          )
        );
      }

      if (isRasterized) {
        const rasterType =
          el.getAttribute('data-raster-type') ||
          rasterContainer?.getAttribute('data-morph-raster-container') ||
          (el.hasAttribute('data-math-tex') || rasterContainer?.classList.contains('morph-math')
            ? 'math'
            : '');
        const mathTex = (
          el.getAttribute('data-math-tex') ||
          rasterContainer?.getAttribute('data-math-tex') ||
          ''
        ).trim();
        const digestKey = pixelDigest || src;

        if (!hasVisibleText(alt)) {
          addViolation(
            'unsafe-media-or-link',
            buildItemMeta(
              el,
              `光栅化降级图片 [data-morph-rasterized="true"] 缺失非空 alt 原始替代文本，违反原稿语义零篡改契约：${xArticlePropertyRules['unsafe-media-or-link']}`,
              'img'
            )
          );
        } else if (validSrc && digestKey) {
          const prevEntry = rasterDigestMap.get(digestKey);
          if (
            prevEntry !== undefined &&
            (prevEntry.alt !== alt ||
              (prevEntry.rasterType && rasterType && prevEntry.rasterType !== rasterType) ||
              (prevEntry.mathTex && mathTex && prevEntry.mathTex !== mathTex))
          ) {
            addViolation(
              'unsafe-media-or-link',
              buildItemMeta(
                el,
                `不同语义内容的光栅化节点 ("${(prevEntry.mathTex || prevEntry.alt).slice(0, 24)}" vs "${(mathTex || alt).slice(0, 24)}") 复用了完全相同的静态位图载荷，疑似伪造占位图：${xArticlePropertyRules['unsafe-media-or-link']}`,
                'img'
              )
            );
          } else if (!prevEntry) {
            rasterDigestMap.set(digestKey, { alt, rasterType, mathTex });
          }
        }
      }

      if (el.hasAttribute('srcset')) {
        addViolation(
          'unsafe-media-or-link',
          buildItemMeta(
            el,
            `<img> 携带 srcset 属性可能导致预览与 X 粘贴交付源不一致：${xArticlePropertyRules['unsafe-media-or-link']}`,
            'img'
          )
        );
      }

      const enclosingLink = el.closest('a');
      if (enclosingLink && root.contains(enclosingLink)) {
        addViolation(
          'entity-conflict',
          buildItemMeta(
            enclosingLink,
            `<a> 内部嵌套 <img> 会导致同一字符位置上 LINK 与 IMAGE 实体重叠冲突：${xArticlePropertyRules['entity-conflict']}`,
            'a'
          )
        );
      }
    }

    // #2.3 / #4.1 unsafe-media-or-link & entity-conflict on <a>
    if (tag === 'a') {
      const href = el.getAttribute('href') || '';
      if (!isSafeLinkHref(href)) {
        addViolation(
          'unsafe-media-or-link',
          buildItemMeta(
            el,
            `超链接 href 协议不安全或无效 (${href.slice(0, 48)})：${xArticlePropertyRules['unsafe-media-or-link']}`,
            'a'
          )
        );
      }
      const parentLink = el.parentElement?.closest('a');
      if (parentLink && root.contains(parentLink)) {
        addViolation(
          'entity-conflict',
          buildItemMeta(
            el,
            `<a> 内部不允许嵌套 <a>，会导致同一字符位置上多个 LINK 实体重叠冲突：${xArticlePropertyRules['entity-conflict']}`,
            'a'
          )
        );
      }
    }
  }

  // 7. Run Draft.js convertFromHTML simulation and validate ContentState invariants
  const { blocks, entityMap, blockElements } = simulateDraftJsWithSources(root);
  const draftState = { blocks, entityMap };

  for (let bIdx = 0; bIdx < draftState.blocks.length; bIdx++) {
    const blk = draftState.blocks[bIdx];
    const blkEl = blockElements[bIdx] || root;
    const blkCpLen = unicodeStrlen(blk.text);

    // #1.5 list-depth-exceeded
    if (
      (blk.type === 'unordered-list-item' || blk.type === 'ordered-list-item') &&
      blk.depth > maxListDepth
    ) {
      addViolation(
        'list-depth-exceeded',
        buildItemMeta(
          blkEl,
          `列表项嵌套深度 depth=${blk.depth} 超出上限 ${maxListDepth}：${xArticlePropertyRules['list-depth-exceeded']}`,
          'li'
        )
      );
    }

    // #4.1 entity-conflict & range bounds validation
    const sortedEntities = [...blk.entityRanges].sort(
      (a, b) => a.offset - b.offset || a.length - b.length
    );
    for (let i = 0; i < sortedEntities.length; i++) {
      const er = sortedEntities[i];
      if (
        er.offset < 0 ||
        er.length <= 0 ||
        er.offset + er.length > blkCpLen ||
        !draftState.entityMap[er.key]
      ) {
        addViolation(
          'entity-conflict',
          buildItemMeta(
            blkEl,
            `Draft.js EntityRange 越界或引用了不存在的实体 key=${er.key}：${xArticlePropertyRules['entity-conflict']}`
          )
        );
      }
      if (i > 0) {
        const prev = sortedEntities[i - 1];
        if (prev.offset + prev.length > er.offset) {
          addViolation(
            'entity-conflict',
            buildItemMeta(
              blkEl,
              `Draft.js 块 ${blk.key} 内存在重叠的 EntityRange ([${prev.offset},${prev.offset + prev.length}) 与 [${er.offset},${er.offset + er.length}))：${xArticlePropertyRules['entity-conflict']}`
            )
          );
        }
      }
    }
  }

  // #4.2 content-loss: verify non-empty input produces blocks and preserves all visible text & images
  const domNonWs = collectVisibleDomText(root).replace(/[\s\u200B-\u200D\uFEFF\uFFFC]+/g, '');
  const draftNonWs = draftState.blocks
    .map((b) => b.text)
    .join('')
    .replace(/[\s\u200B-\u200D\uFEFF\uFFFC]+/g, '');
  const domImgs = [
    ...(root.tagName.toLowerCase() === 'img' ? [root] : []),
    ...Array.from(root.querySelectorAll('img')),
  ];
  const domHrs = [
    ...(root.tagName.toLowerCase() === 'hr' ? [root] : []),
    ...Array.from(root.querySelectorAll('hr')),
  ];
  const draftImgEntities = Object.values(draftState.entityMap).filter((e) => e.type === 'IMAGE');
  const draftDividerEntities = Object.values(draftState.entityMap).filter(
    (e) => e.type === 'DIVIDER'
  );
  const hasMediaInDom = domImgs.length > 0 || domHrs.length > 0;

  if ((domNonWs.length > 0 || hasMediaInDom) && draftState.blocks.length === 0) {
    addViolation(
      'content-loss',
      buildItemMeta(
        root,
        `输入 DOM 含有效正文或媒体，但转换后 Draft.js blocks 为空：${xArticlePropertyRules['content-loss']}`
      )
    );
  } else {
    if (domNonWs !== draftNonWs) {
      addViolation(
        'content-loss',
        buildItemMeta(
          root,
          `Draft.js 转换后可见字符序列不一致（DOM 字符数=${domNonWs.length}，Draft 字符数=${draftNonWs.length}）：${xArticlePropertyRules['content-loss']}`
        )
      );
    }
    if (domImgs.length !== draftImgEntities.length) {
      addViolation(
        'content-loss',
        buildItemMeta(
          root,
          `Draft.js 转换后图片实体数量不一致（DOM img=${domImgs.length}，Draft IMAGE=${draftImgEntities.length}）：${xArticlePropertyRules['content-loss']}`
        )
      );
    }
    if (domHrs.length !== draftDividerEntities.length) {
      addViolation(
        'content-loss',
        buildItemMeta(
          root,
          `Draft.js 转换后分割线实体数量不一致（DOM hr=${domHrs.length}，Draft DIVIDER=${draftDividerEntities.length}）：${xArticlePropertyRules['content-loss']}`
        )
      );
    }
  }

  // Detect collapsed empty semantic blocks (e.g., empty <h1>, <p>, <blockquote>, <pre>, <ul>, <li>, <figure>)
  const reportedEmptyBlocks = new Set<Element>();
  for (const el of allElements) {
    if (el === root) continue;
    const tag = el.tagName.toLowerCase();
    if (!EMPTY_CHECK_BLOCK_TAGS.has(tag)) continue;
    if (TABLE_TAGS.has(tag)) continue;
    if (el.closest('svg, math, .katex, .morph-math, .morph-math-display, table')) {
      continue;
    }
    let insideFlaggedContainer = false;
    for (const flaggedCallout of reportedCallouts) {
      if (flaggedCallout === el || flaggedCallout.contains(el)) {
        insideFlaggedContainer = true;
        break;
      }
    }
    if (!insideFlaggedContainer) {
      for (const mathEl of mathContainers) {
        if (mathEl === el || mathEl.contains(el)) {
          insideFlaggedContainer = true;
          break;
        }
      }
    }
    if (insideFlaggedContainer) continue;

    if (
      el.querySelector(
        'img, hr, svg, math, .katex, .katex-display, .katex-mathml, .katex-html, .morph-math, .morph-math-display, mjx-container, .MathJax, table, thead, tbody, tfoot, tr, th, td'
      )
    ) {
      continue;
    }
    if (hasVisibleText(el.textContent || '')) continue;

    let hasReportedEmptyAncestor = false;
    for (const prevEmpty of reportedEmptyBlocks) {
      if (prevEmpty.contains(el)) {
        hasReportedEmptyAncestor = true;
        break;
      }
    }
    if (hasReportedEmptyAncestor) continue;

    reportedEmptyBlocks.add(el);
    addViolation(
      'content-loss',
      buildItemMeta(
        el,
        `块级节点 <${tag}> 内容为空或发生空块坍塌：${xArticlePropertyRules['content-loss']}`,
        tag
      )
    );
  }

  if (
    !inValidInfo['content-loss'] &&
    (draftState.blocks.length === 0 || (!hasVisibleText(root.textContent || '') && !hasMediaInDom)) &&
    rawTableNodes.length === 0 &&
    mathContainers.size === 0 &&
    svgNodes.length === 0
  ) {
    addViolation(
      'content-loss',
      buildItemMeta(
        root,
        `文档转换后未生成任何有效 Draft.js 内容块（空文档坍塌）：${xArticlePropertyRules['content-loss']}`
      )
    );
  }

  const isValid = Object.keys(inValidInfo).length === 0;

  return {
    isValid,
    inValidInfo,
    draftState,
  };
}

/**
 * Convenience helper to verify an HTML string against the X Articles
 * Draft.js structure and capability specification.
 */
export function verifyXArticleHtml(
  html: string,
  opts: XArticleVerifyOpts = {}
): XArticleVerifyResult {
  const { doc, cleanup } = parseHtmlDocumentStandalone(html);
  try {
    const result = verifyXArticleStructure(doc.body, opts);

    // Detect orphan table tags (<tr>, <td>, <th>, <thead>, <tbody>, <tfoot>) that HTML5 <body> parser may strip
    if (!result.inValidInfo['unrasterized-table']) {
      const orphanTableTag = findOrphanTableTagInRawHtml(html);
      if (orphanTableTag) {
        const ruleDesc = xArticlePropertyRules['unrasterized-table'];
        result.inValidInfo['unrasterized-table'] = {
          violateRules: ruleDesc,
          items: [
            {
              blockIndex: 0,
              outerHTML: truncateOuterHtml(html.trim()),
              tagName: orphanTableTag,
              rules: `检测到未包裹在 <table> 内的孤立表格标签 <${orphanTableTag}>：${ruleDesc}`,
            },
          ],
        };
        result.isValid = false;
      }
    }

    // Detect nested <a>...<a>...</a></a> in raw HTML that HTML5 <body> parser auto-closes
    if (!result.inValidInfo['entity-conflict'] && hasNestedAnchorInRawHtml(html)) {
      const ruleDesc = xArticlePropertyRules['entity-conflict'];
      result.inValidInfo['entity-conflict'] = {
        violateRules: ruleDesc,
        items: [
          {
            blockIndex: 0,
            outerHTML: truncateOuterHtml(html.trim()),
            tagName: 'a',
            rules: `<a> 内部不允许嵌套 <a>，会导致同一字符位置上多个 LINK 实体重叠冲突：${ruleDesc}`,
          },
        ],
      };
      result.isValid = false;
    }

    return result;
  } finally {
    cleanup();
  }
}
