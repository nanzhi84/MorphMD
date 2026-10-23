/**
 * Binary Image Metadata and EXIF Parser.
 * Validates integrity of PNG, JPEG, GIF, WebP, SVG.
 * Rejects truncated, corrupted, or undecodable binary candidates.
 */

import { computeCrc32, parseSvgDimension, parseSvgRootAttributes } from './helpers';

export interface ImageMetadata {
  mimeType: string;
  width: number;
  height: number;
  naturalWidth: number;
  naturalHeight: number;
  exifOrientation?: number;
}

export function parseImageMetadata(data: Uint8Array): ImageMetadata | null {
  if (!data || data.length < 8) return null;

  // 1. PNG Validation
  if (
    data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47 &&
    data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a
  ) {
    if (data.length < 33) return null;

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let offset = 8;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    let interlace = 0;
    let hasIhdr = false;
    let hasIend = false;
    const idatChunks: Uint8Array[] = [];

    while (offset + 8 <= data.length) {
      const chunkLen = view.getUint32(offset, false);
      const chunkType = String.fromCharCode(
        data[offset + 4], data[offset + 5], data[offset + 6], data[offset + 7]
      );

      const chunkTotalLen = 8 + chunkLen + 4;
      if (offset + chunkTotalLen > data.length) return null;

      const expectedCrc = view.getUint32(offset + 8 + chunkLen, false);
      const actualCrc = computeCrc32(data, offset + 4, offset + 8 + chunkLen);
      if (expectedCrc !== actualCrc) return null;

      if (chunkType === 'IHDR') {
        if (hasIhdr || chunkLen !== 13) return null;
        width = view.getUint32(offset + 8, false);
        height = view.getUint32(offset + 12, false);
        if (width === 0 || height === 0) return null;

        bitDepth = data[offset + 16];
        colorType = data[offset + 17];
        const compression = data[offset + 18];
        const filter = data[offset + 19];
        interlace = data[offset + 20];

        if (compression !== 0 || filter !== 0 || (interlace !== 0 && interlace !== 1)) {
          return null;
        }

        const validDepths: Record<number, number[]> = {
          0: [1, 2, 4, 8, 16],
          2: [8, 16],
          3: [1, 2, 4, 8],
          4: [8, 16],
          6: [8, 16],
        };
        if (!validDepths[colorType] || !validDepths[colorType].includes(bitDepth)) {
          return null;
        }

        hasIhdr = true;
      } else if (chunkType === 'IDAT') {
        if (!hasIhdr) return null;
        if (chunkLen > 0) {
          idatChunks.push(data.subarray(offset + 8, offset + 8 + chunkLen));
        }
      } else if (chunkType === 'IEND') {
        if (!hasIhdr || idatChunks.length === 0) return null;
        hasIend = true;
        offset += chunkTotalLen;
        if (offset !== data.length) return null;
        break;
      }

      offset += chunkTotalLen;
    }

    if (!hasIhdr || idatChunks.length === 0 || !hasIend) {
      return null;
    }

    // Validate IDAT zlib payload
    let totalIdatLen = 0;
    for (const c of idatChunks) totalIdatLen += c.length;
    const combinedIdat = new Uint8Array(totalIdatLen);
    let idatPos = 0;
    for (const c of idatChunks) {
      combinedIdat.set(c, idatPos);
      idatPos += c.length;
    }

    if (combinedIdat.length < 2) return null;
    const cmf = combinedIdat[0];
    const flg = combinedIdat[1];
    const isZlib = (cmf & 0x0f) === 8 && (cmf >> 4) <= 7 && ((cmf << 8) + flg) % 31 === 0;
    if (!isZlib) return null;

    if (typeof process !== 'undefined' && typeof (process as any).getBuiltinModule === 'function') {
      try {
        const zlib = (process as any).getBuiltinModule('node:zlib');
        const inflated = zlib.inflateSync(combinedIdat);
        const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType] || 1;
        const scanlineBytes = 1 + Math.ceil((width * bitDepth * channels) / 8);
        if (inflated.byteLength < height * scanlineBytes) {
          return null;
        }
        if (interlace === 0) {
          for (let y = 0; y < height; y++) {
            if (inflated[y * scanlineBytes] > 4) {
              return null;
            }
          }
        }
      } catch {
        return null;
      }
    }

    return {
      mimeType: 'image/png',
      width,
      height,
      naturalWidth: width,
      naturalHeight: height,
    };
  }

  // 2. JPEG Validation
  if (data[0] === 0xff && data[1] === 0xd8) {
    if (data.length < 4) return null;
    if (data[data.length - 2] !== 0xff || data[data.length - 1] !== 0xd9) {
      return null;
    }

    let offset = 2;
    let naturalWidth = 0;
    let naturalHeight = 0;
    let exifOrientation: number | undefined;
    let hasSos = false;
    let hasScan = false;
    let hasDqt = false;

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    while (offset < data.length - 1) {
      if (data[offset] !== 0xff) {
        offset++;
        continue;
      }

      while (offset < data.length && data[offset] === 0xff) {
        offset++;
      }
      if (offset >= data.length) break;

      const marker = data[offset++];
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
        continue;
      }

      if (marker === 0xdb) {
        hasDqt = true;
      }

      if (marker === 0xda) {
        hasSos = true;
        if (offset + 2 > data.length) return null;
        const sosLen = view.getUint16(offset, false);
        const scanStart = offset + sosLen;
        if (scanStart < data.length - 2) {
          hasScan = true;
        }
        break;
      }

      if (marker === 0xd9) break;

      if (offset + 2 > data.length) return null;
      const length = view.getUint16(offset, false);
      if (length < 2 || offset + length > data.length) return null;

      // APP1: EXIF
      if (marker === 0xe1 && length >= 14) {
        if (
          data[offset + 2] === 0x45 && data[offset + 3] === 0x78 &&
          data[offset + 4] === 0x69 && data[offset + 5] === 0x66 &&
          data[offset + 6] === 0x00 && data[offset + 7] === 0x00
        ) {
          const tiffOffset = offset + 8;
          const isLittle = data[tiffOffset] === 0x49 && data[tiffOffset + 1] === 0x49;
          const isBig = data[tiffOffset] === 0x4d && data[tiffOffset + 1] === 0x4d;

          if (isLittle || isBig) {
            const little = isLittle;
            const tiffMagic = view.getUint16(tiffOffset + 2, little);
            if (tiffMagic === 0x002a) {
              const ifdOffset = view.getUint32(tiffOffset + 4, little);
              const firstIfd = tiffOffset + ifdOffset;

              if (firstIfd + 2 <= offset + length) {
                const numEntries = view.getUint16(firstIfd, little);
                for (let i = 0; i < numEntries; i++) {
                  const entryOffset = firstIfd + 2 + i * 12;
                  if (entryOffset + 12 > offset + length) break;
                  const tag = view.getUint16(entryOffset, little);
                  const type = view.getUint16(entryOffset + 2, little);
                  const count = view.getUint32(entryOffset + 4, little);
                  if (tag === 0x0112 && type === 3 && count === 1) {
                    const val = view.getUint16(entryOffset + 8, little);
                    if (val >= 1 && val <= 8) {
                      exifOrientation = val;
                    }
                    break;
                  }
                }
              }
            }
          }
        }
      }

      // SOF Markers
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        if (offset + 7 <= data.length) {
          naturalHeight = view.getUint16(offset + 3, false);
          naturalWidth = view.getUint16(offset + 5, false);
        }
      }

      offset += length;
    }

    if (!hasDqt || !hasSos || !hasScan || naturalWidth <= 0 || naturalHeight <= 0) {
      return null;
    }

    let visualWidth = naturalWidth;
    let visualHeight = naturalHeight;
    if (exifOrientation && exifOrientation >= 5 && exifOrientation <= 8) {
      visualWidth = naturalHeight;
      visualHeight = naturalWidth;
    }

    return {
      mimeType: 'image/jpeg',
      width: visualWidth,
      height: visualHeight,
      naturalWidth,
      naturalHeight,
      exifOrientation,
    };
  }

  // 3. GIF Validation
  if (
    data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 &&
    data[3] === 0x38 && (data[4] === 0x37 || data[4] === 0x39) && data[5] === 0x61
  ) {
    if (data.length >= 14 && data[data.length - 1] === 0x3b) {
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const width = view.getUint16(6, true);
      const height = view.getUint16(8, true);
      if (width <= 0 || height <= 0) return null;

      const gctSize = (data[10] & 0x80) ? 3 * (1 << ((data[10] & 0x07) + 1)) : 0;
      let offset = 13 + gctSize;
      let hasImageDescriptor = false;

      while (offset < data.length) {
        const blockType = data[offset];
        if (blockType === 0x3b) break;
        if (blockType === 0x21) {
          offset += 2;
          while (offset < data.length && data[offset] !== 0) {
            offset += 1 + data[offset];
          }
          offset++;
          continue;
        }
        if (blockType === 0x2c) {
          if (offset + 10 > data.length) return null;
          const imgW = view.getUint16(offset + 5, true);
          const imgH = view.getUint16(offset + 7, true);
          if (imgW <= 0 || imgH <= 0) return null;
          const lctSize = (data[offset + 9] & 0x80) ? 3 * (1 << ((data[offset + 9] & 0x07) + 1)) : 0;
          offset += 10 + lctSize;
          if (offset >= data.length) return null;
          const lzwMin = data[offset++];
          if (lzwMin < 2 || lzwMin > 8) return null;
          let hasSubBlock = false;
          while (offset < data.length && data[offset] !== 0) {
            const subLen = data[offset];
            if (subLen > 0) hasSubBlock = true;
            offset += 1 + subLen;
          }
          if (!hasSubBlock || offset >= data.length || data[offset] !== 0) return null;
          offset++;
          hasImageDescriptor = true;
          break;
        }
        return null;
      }

      if (hasImageDescriptor) {
        return {
          mimeType: 'image/gif',
          width,
          height,
          naturalWidth: width,
          naturalHeight: height,
        };
      }
    }
    return null;
  }

  // 4. WebP Validation
  if (
    data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
    data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50
  ) {
    if (data.length >= 30) {
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const riffSize = view.getUint32(4, true);
      if (riffSize + 8 > data.length) return null;

      const chunkHeader = String.fromCharCode(data[12], data[13], data[14], data[15]);

      if (chunkHeader === 'VP8X') {
        const width = 1 + view.getUint8(24) + (view.getUint8(25) << 8) + (view.getUint8(26) << 16);
        const height = 1 + view.getUint8(27) + (view.getUint8(28) << 8) + (view.getUint8(29) << 16);
        let subOffset = 30;
        let hasBitstream = false;

        while (subOffset + 8 <= data.length) {
          const subType = String.fromCharCode(
            data[subOffset], data[subOffset + 1], data[subOffset + 2], data[subOffset + 3]
          );
          const subLen = view.getUint32(subOffset + 4, true);
          const chunkDataOffset = subOffset + 8;
          if (chunkDataOffset + subLen > data.length) return null;

          if (subType === 'VP8 ') {
            if (subLen >= 10 && data[chunkDataOffset + 3] === 0x9d && data[chunkDataOffset + 4] === 0x01 && data[chunkDataOffset + 5] === 0x2a) {
              hasBitstream = true;
              break;
            }
          } else if (subType === 'VP8L') {
            if (subLen >= 5 && data[chunkDataOffset] === 0x2f) {
              hasBitstream = true;
              break;
            }
          }
          subOffset += 8 + subLen + (subLen & 1);
        }

        if (!hasBitstream) return null;
        return { mimeType: 'image/webp', width, height, naturalWidth: width, naturalHeight: height };
      }
      if (chunkHeader === 'VP8L' && data[20] === 0x2f) {
        const b0 = data[21], b1 = data[22], b2 = data[23], b3 = data[24];
        const width = 1 + (((b1 & 0x3f) << 8) | b0);
        const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
        return { mimeType: 'image/webp', width, height, naturalWidth: width, naturalHeight: height };
      }
      if (chunkHeader === 'VP8 ' && data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a) {
        const width = view.getUint16(26, true) & 0x3fff;
        const height = view.getUint16(28, true) & 0x3fff;
        return { mimeType: 'image/webp', width, height, naturalWidth: width, naturalHeight: height };
      }
    }
    return null;
  }

  // 5. SVG
  let fullSvg: string;
  try {
    fullSvg = new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return null;
  }
  const rootAttrs = parseSvgRootAttributes(fullSvg);
  if (rootAttrs) {
    const widthStr = rootAttrs.get('width') ?? null;
    const heightStr = rootAttrs.get('height') ?? null;
    const viewBoxStr = rootAttrs.get('viewBox') ?? null;

    let vbW = 0;
    let vbH = 0;
    if (viewBoxStr) {
      const rawParts = viewBoxStr.trim().split(/\s*(?:,\s*|\s+)/);
      if (
        rawParts.length === 4 &&
        rawParts.every((p) => /^[+-]?(?:\d+|\d*\.\d+)(?:e[+-]?\d+)?$/i.test(p))
      ) {
        const parts = rawParts.map(Number);
        if (parts[2] > 0 && parts[3] > 0) {
          vbW = parts[2];
          vbH = parts[3];
        }
      }
    }

    const parsedW = parseSvgDimension(widthStr);
    const parsedH = parseSvgDimension(heightStr);
    if (parsedW === 'invalid' || parsedH === 'invalid') return null;

    let width = typeof parsedW === 'number' ? parsedW : 0;
    let height = typeof parsedH === 'number' ? parsedH : 0;

    if (vbW > 0 && vbH > 0) {
      const r = vbW / vbH;
      if (!width && !height) {
        if (r >= 300 / 150) {
          width = 300;
          height = Math.round(300 / r);
        } else {
          height = 150;
          width = Math.round(150 * r);
        }
      } else if (width && !height) {
        height = Math.round(width / r);
      } else if (!width && height) {
        width = Math.round(height * r);
      }
    } else {
      if (!width) width = 300;
      if (!height) height = 150;
    }

    if (width > 0 && height > 0) {
      return {
        mimeType: 'image/svg+xml',
        width,
        height,
        naturalWidth: width,
        naturalHeight: height,
      };
    }
  }

  return null;
}
