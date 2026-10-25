import { deflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import type { Page } from 'playwright';

function chunk(type: string, data: Buffer): Buffer {
  const payload = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of payload) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, payload, checksum]);
}

// Complete, decodable PNGs, including pixels and correct CRCs, not header stubs.
export function png(seed = 1, width = 3, height = 2): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 1; x <= width * 3; x++) rows[y * (width * 3 + 1) + x] = (seed * 31 + x * 7 + y) % 256;
  }
  return new Uint8Array(Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0)),
  ]));
}

// A real 3x2 JPEG with a minimal valid EXIF orientation segment prepended.
export function jpeg(orientation = 1, littleEndian = true): Uint8Array {
  const original = readFileSync(new URL('../fixtures/landscape.jpg', import.meta.url));
  const exif = Buffer.from('45786966000049492a0008000000010012010300010000000100000000000000', 'hex');
  if (littleEndian) exif.writeUInt16LE(orientation, 24);
  else {
    exif.set(Buffer.from('4d4d002a0000000800010112000300000001', 'hex'), 6);
    exif.writeUInt16BE(orientation, 24);
  }
  const segment = Buffer.alloc(4);
  segment.writeUInt16BE(0xffe1, 0);
  segment.writeUInt16BE(exif.length + 2, 2);
  return new Uint8Array(Buffer.concat([original.subarray(0, 2), segment, exif, original.subarray(2)]));
}

// Minimal valid GIF89a with global color table and LZW image data block.
export function gif(width = 4, height = 3): Uint8Array {
  const buf = Buffer.alloc(35);
  buf.write('GIF89a', 0, 'ascii');
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  buf[10] = 0x80; // GCT present, 2 colors
  buf[11] = 0x00;
  buf[12] = 0x00;
  // 2-color GCT: black & white
  buf.set([0x00, 0x00, 0x00, 0xff, 0xff, 0xff], 13);
  // Image Descriptor
  buf[19] = 0x2c;
  buf.writeUInt16LE(0, 20);
  buf.writeUInt16LE(0, 22);
  buf.writeUInt16LE(width, 24);
  buf.writeUInt16LE(height, 26);
  buf[28] = 0x00;
  // LZW image data
  buf.set([0x02, 0x02, 0x44, 0x01, 0x00, 0x3b], 29);
  return new Uint8Array(buf);
}

// Minimal valid lossless WebP (VP8L) container.
export function webp(width = 5, height = 4): Uint8Array {
  const vp8lPayload = Buffer.from([
    0x2f,
    (width - 1) & 0xff,
    (((width - 1) >> 8) & 0x3f) | (((height - 1) & 0x03) << 6),
    ((height - 1) >> 2) & 0xff,
    ((height - 1) >> 10) & 0x0f,
    0x10, 0x07, 0x10, 0x11, 0x11, 0x88, 0x88, 0xfe, 0x07, 0x00,
  ]);
  const riffSize = 4 + 8 + vp8lPayload.length;
  const header = Buffer.alloc(20);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(riffSize, 4);
  header.write('WEBP', 8, 'ascii');
  header.write('VP8L', 12, 'ascii');
  header.writeUInt32LE(vp8lPayload.length, 16);
  return new Uint8Array(Buffer.concat([header, vp8lPayload]));
}

// Minimal valid SVG UTF-8 bytes with explicit width and height.
export function svg(width = 6, height = 4): Uint8Array {
  const markup = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#0969da"/></svg>`;
  return new TextEncoder().encode(markup);
}

// Decode a bitmap data: URL inside a real Chromium Page and return its natural pixel dimensions.
export async function decodeBitmapDataUrl(
  page: Page,
  src: string,
): Promise<{ decoded: boolean; width: number; height: number }> {
  if (!/^data:image\/(png|webp);base64,[A-Za-z0-9+/=]+$/i.test(src)) {
    return { decoded: false, width: 0, height: 0 };
  }
  return await page.evaluate(async (dataUrl) => {
    const img = new Image();
    img.src = dataUrl;
    try {
      await img.decode();
      return {
        decoded: img.naturalWidth > 0 && img.naturalHeight > 0,
        width: img.naturalWidth,
        height: img.naturalHeight,
      };
    } catch {
      return { decoded: false, width: 0, height: 0 };
    }
  }, src);
}
