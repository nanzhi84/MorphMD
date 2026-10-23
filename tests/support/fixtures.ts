import { deflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

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
