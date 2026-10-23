import type { AssetRecord } from './types';
import { parseImageMetadata } from './metadata';
import { isValidRemoteHttpsUrl } from './helpers';

function decodeBase64Bytes(base64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

export function validateMetadataUpdate(metadata: Partial<AssetRecord>): void {
  if ('width' in metadata && metadata.width !== undefined) {
    if (typeof metadata.width !== 'number' || !Number.isFinite(metadata.width) || metadata.width <= 0) {
      throw new Error('Invalid width in metadata update');
    }
  }
  if ('height' in metadata && metadata.height !== undefined) {
    if (typeof metadata.height !== 'number' || !Number.isFinite(metadata.height) || metadata.height <= 0) {
      throw new Error('Invalid height in metadata update');
    }
  }
  if ('remoteUrl' in metadata && metadata.remoteUrl !== undefined) {
    if (typeof metadata.remoteUrl !== 'string' || !isValidRemoteHttpsUrl(metadata.remoteUrl)) {
      throw new Error('Invalid remoteUrl in metadata update');
    }
  }
  if ('dataUrl' in metadata && metadata.dataUrl !== undefined) {
    if (typeof metadata.dataUrl !== 'string') {
      throw new Error('Invalid dataUrl format');
    }
    if (metadata.dataUrl.includes('#')) {
      throw new Error('Unescaped hash fragment in dataUrl');
    }
    const commaIdx = metadata.dataUrl.indexOf(',');
    if (commaIdx === -1) {
      throw new Error('Invalid image dataUrl format');
    }
    const header = metadata.dataUrl.slice(0, commaIdx);
    const payload = metadata.dataUrl.slice(commaIdx + 1);
    const headerMatch = header.match(/^data:image\/([a-zA-Z0-9.+-]+)((?:;[a-zA-Z0-9.+=-]+)*)$/i);
    if (!headerMatch) {
      throw new Error('Invalid image dataUrl format');
    }
    const rawSubtype = headerMatch[1].toLowerCase();
    const claimedMime = rawSubtype === 'jpg' ? 'image/jpeg' : `image/${rawSubtype}`;
    const params = headerMatch[2].split(';').filter(Boolean);
    const isBase64 = params.length > 0 && params[params.length - 1].toLowerCase() === 'base64';
    let bytes: Uint8Array;
    if (isBase64) {
      if (/[^\t\n\f\r A-Za-z0-9+/=]/.test(payload)) {
        throw new Error('Invalid characters in base64 dataUrl');
      }
      const cleaned = payload.replace(/[\t\n\f\r ]+/g, '');
      if (
        cleaned.length === 0 ||
        cleaned.length % 4 !== 0 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(cleaned)
      ) {
        throw new Error('Invalid base64 padding or length in dataUrl');
      }
      bytes = decodeBase64Bytes(cleaned);
    } else {
      try {
        bytes = new TextEncoder().encode(decodeURIComponent(payload));
      } catch {
        throw new Error('Invalid percent-encoding in dataUrl');
      }
    }
    const meta = parseImageMetadata(bytes);
    if (!meta || meta.width <= 0 || meta.height <= 0 || meta.mimeType !== claimedMime) {
      throw new Error('Invalid image payload or MIME mismatch in dataUrl');
    }
  }
}
