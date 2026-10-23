import type { AssetRecord, AssetStatus } from './types';

export interface InternalAssetRecord extends AssetRecord {
  pendingRemoval?: boolean;
}

export const STATUS_RANKS: Record<AssetStatus, number> = {
  received: 0,
  'metadata-ready': 1,
  'preview-ready': 2,
  'delivery-ready': 3,
  failed: 4,
};

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function hashBytes(bytes: Uint8Array): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < bytes.length; i++) {
    const ch = bytes[i];
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hashHex = (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(16, '0');
  return `${bytes.length.toString(16)}-${hashHex}`;
}

export function createReadOnlyRecordView(record: AssetRecord): AssetRecord {
  return new Proxy(record, {
    get(target, prop, receiver) {
      return Reflect.get(target, prop, receiver);
    },
    set() {
      throw new TypeError('AssetRecord is read-only');
    },
    deleteProperty() {
      throw new TypeError('AssetRecord is read-only');
    },
    defineProperty() {
      throw new TypeError('AssetRecord is read-only');
    },
    setPrototypeOf() {
      throw new TypeError('AssetRecord is read-only');
    },
  });
}

export function isValidRemoteHttpsUrl(url: unknown): boolean {
  if (typeof url !== 'string' || !url.startsWith('https://')) return false;
  if (/[\s"'<>]/.test(url)) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

export function createBlobUrl(data: Uint8Array, mimeType: string, _id?: string): string {
  if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    try {
      const blob = new Blob([data as unknown as BlobPart], { type: mimeType });
      return URL.createObjectURL(blob);
    } catch {}
  }
  return `data:${mimeType};base64,${bytesToBase64(data)}`;
}

export function cleanUpBlobUrl(record: InternalAssetRecord): void {
  if (record.blobUrl) {
    if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function' && record.blobUrl.startsWith('blob:')) {
      try {
        URL.revokeObjectURL(record.blobUrl);
      } catch {}
    }
    record.blobUrl = undefined;
  }
}

export function computeCrc32(data: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (-(crc & 1) & 0xedb88320);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function parseSvgDimension(dimStr: string | null | undefined): number | 'percent' | 'invalid' | null {
  if (!dimStr) return null;
  const trimmed = dimStr.trim();
  if (/^[+-]?(?:\d+|\d*\.\d+)(?:e[+-]?\d+)?%$/i.test(trimmed)) {
    const pct = parseFloat(trimmed);
    return Number.isNaN(pct) || pct <= 0 ? 'invalid' : 'percent';
  }
  const match = trimmed.match(/^([+-]?(?:\d+|\d*\.\d+)(?:e[+-]?\d+)?)\s*(px|in|cm|mm|pt|pc)?$/i);
  if (!match) return null;
  const val = parseFloat(match[1]);
  if (Number.isNaN(val) || val <= 0) return 'invalid';
  const unit = (match[2] || 'px').toLowerCase();
  switch (unit) {
    case 'px': return val;
    case 'in': return val * 96;
    case 'cm': return val * (96 / 2.54);
    case 'mm': return val * (96 / 25.4);
    case 'pt': return val * (96 / 72);
    case 'pc': return val * 16;
    default: return val;
  }
}

export function isValidXmlEntityText(str: string): boolean {
  const entityRegex = /&([^;]*);|&/g;
  let entMatch: RegExpExecArray | null;
  while ((entMatch = entityRegex.exec(str)) !== null) {
    if (entMatch[0] === '&') return false;
    const name = entMatch[1];
    if (name === 'amp' || name === 'lt' || name === 'gt' || name === 'quot' || name === 'apos') {
      continue;
    }
    const dec = name.match(/^#(\d+)$/);
    if (dec) {
      const cp = parseInt(dec[1], 10);
      if (cp === 0x09 || cp === 0x0a || cp === 0x0d || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff)) {
        continue;
      }
      return false;
    }
    const hex = name.match(/^#x([0-9a-fA-F]+)$/);
    if (hex) {
      const cp = parseInt(hex[1], 16);
      if (cp === 0x09 || cp === 0x0a || cp === 0x0d || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff)) {
        continue;
      }
      return false;
    }
    return false;
  }
  return true;
}

export function isValidQName(name: string): boolean {
  const parts = name.split(':');
  return parts.length <= 2 && parts.every((p) => /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(p));
}

export function decodeXmlEntities(str: string): string {
  return str.replace(/&([^;]+);/g, (match, name) => {
    if (name === 'amp') return '&';
    if (name === 'lt') return '<';
    if (name === 'gt') return '>';
    if (name === 'quot') return '"';
    if (name === 'apos') return "'";
    const dec = name.match(/^#(\d+)$/);
    if (dec) {
      try { return String.fromCodePoint(parseInt(dec[1], 10)); } catch { return match; }
    }
    const hex = name.match(/^#x([0-9a-fA-F]+)$/);
    if (hex) {
      try { return String.fromCodePoint(parseInt(hex[1], 16)); } catch { return match; }
    }
    return match;
  });
}

export function parseSvgRootAttributes(svgText: string): Map<string, string> | null {
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/.test(svgText)) return null;
  const text = svgText.startsWith('\uFEFF') ? svgText.slice(1) : svgText;

  const stack: string[] = [];
  const nsStack: Array<Map<string, string>> = [new Map([['xml', 'http://www.w3.org/XML/1998/namespace']])];
  let rootCount = 0;
  let hasDoctype = false;
  let rootAttrs: Map<string, string> | null = null;
  let pos = 0;

  while (pos < text.length) {
    const lt = text.indexOf('<', pos);
    const chunk = lt === -1 ? text.slice(pos) : text.slice(pos, lt);
    if (chunk.length > 0) {
      if (stack.length === 0) {
        if (!/^[ \t\r\n]*$/.test(chunk)) return null;
      } else {
        if (chunk.includes(']]>') || !isValidXmlEntityText(chunk)) return null;
      }
    }
    if (lt === -1) break;
    pos = lt;

    if (text.startsWith('<!--', pos)) {
      const close = text.indexOf('-->', pos + 4);
      if (close === -1) return null;
      const body = text.slice(pos + 4, close);
      if (body.includes('--') || body.endsWith('-')) return null;
      pos = close + 3;
      continue;
    }

    if (text.startsWith('<![CDATA[', pos)) {
      if (stack.length === 0) return null;
      const close = text.indexOf(']]>', pos + 9);
      if (close === -1) return null;
      pos = close + 3;
      continue;
    }

    if (text.startsWith('<?', pos)) {
      const close = text.indexOf('?>', pos + 2);
      if (close === -1) return null;
      const body = text.slice(pos + 2, close);
      const targetMatch = body.match(/^([A-Za-z_][A-Za-z0-9_.-]*)(?:([ \t\r\n][\s\S]*)|$)/);
      if (!targetMatch) return null;
      const target = targetMatch[1];
      const rest = targetMatch[2] || '';
      if (target.toLowerCase() === 'xml') {
        if (pos !== 0 || target !== 'xml') return null;
        if (!/^[ \t\r\n]+version[ \t\r\n]*=[ \t\r\n]*(?:"1\.[0-9]+"|'1\.[0-9]+')(?:[ \t\r\n]+encoding[ \t\r\n]*=[ \t\r\n]*(?:"[A-Za-z][A-Za-z0-9._-]*"|'[A-Za-z][A-Za-z0-9._-]*'))?(?:[ \t\r\n]+standalone[ \t\r\n]*=[ \t\r\n]*(?:"(?:yes|no)"|'(?:yes|no)'))?[ \t\r\n]*$/.test(rest)) return null;
      }
      pos = close + 2;
      continue;
    }

    if (/^<!DOCTYPE\b/i.test(text.slice(pos))) {
      if (hasDoctype || stack.length > 0 || rootCount > 0 || !text.startsWith('<!DOCTYPE', pos)) return null;
      hasDoctype = true;
      const dtMatch = text
        .slice(pos)
        .match(
          /^<!DOCTYPE[ \t\r\n]+([A-Za-z_:][A-Za-z0-9_.:-]*)(?:[ \t\r\n]+(?:SYSTEM[ \t\r\n]+(?:"[^"]*"|'[^']*')|PUBLIC[ \t\r\n]+(?:"[ \r\na-zA-Z0-9-'()+,./:=?;!*#@$_%]*"|'[ \r\na-zA-Z0-9-()+,./:=?;!*#@$_%]*')[ \t\r\n]+(?:"[^"]*"|'[^']*')))?[ \t\r\n]*>/
        );
      if (!dtMatch || !isValidQName(dtMatch[1])) return null;
      pos += dtMatch[0].length;
      continue;
    }

    if (text.startsWith('<!', pos)) return null;

    const tagMatch = text.slice(pos).match(/^<(\/?)([A-Za-z_:][A-Za-z0-9_.:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)(\/?)>/);
    if (!tagMatch) return null;
    pos += tagMatch[0].length;

    const isClosing = tagMatch[1] === '/';
    const tagName = tagMatch[2];
    const rawAttrs = tagMatch[3];
    const isSelfClosing = tagMatch[4] === '/' || rawAttrs.endsWith('/');

    if (!isValidQName(tagName) || tagName === 'xmlns' || tagName.startsWith('xmlns:')) return null;

    if (isClosing) {
      if (!/^[ \t\r\n]*$/.test(rawAttrs) || isSelfClosing) return null;
      if (stack.length === 0) return null;
      const popped = stack.pop();
      nsStack.pop();
      if (popped !== tagName) return null;
      continue;
    }

    const parentNs = nsStack[nsStack.length - 1];
    const currentNs = new Map(parentNs);
    const seenAttrs = new Set<string>();
    const rawAttrsList: Array<{ name: string; value: string }> = [];

    let remainingAttrs = isSelfClosing && rawAttrs.endsWith('/') ? rawAttrs.slice(0, -1) : rawAttrs;
    if (remainingAttrs.length > 0 && !/^[ \t\r\n]/.test(remainingAttrs)) return null;

    while (remainingAttrs.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '').length > 0) {
      const attrMatch = remainingAttrs.match(
        /^[ \t\r\n]+([A-Za-z_:][A-Za-z0-9_.:-]*)[ \t\r\n]*=[ \t\r\n]*(?:"([^"]*)"|'([^']*)')/
      );
      if (!attrMatch) return null;
      const attrName = attrMatch[1];
      if (!isValidQName(attrName)) return null;

      const rawVal = attrMatch[2] !== undefined ? attrMatch[2] : attrMatch[3];
      if (rawVal.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '').includes('<')) return null;
      if (!isValidXmlEntityText(rawVal)) return null;

      const attrValue = decodeXmlEntities(rawVal);
      if (seenAttrs.has(attrName)) return null;
      seenAttrs.add(attrName);
      rawAttrsList.push({ name: attrName, value: attrValue });

      if (attrName === 'xmlns') {
        if (attrValue === 'http://www.w3.org/XML/1998/namespace' || attrValue === 'http://www.w3.org/2000/xmlns/') return null;
        currentNs.set('', attrValue);
      } else if (attrName.startsWith('xmlns:')) {
        const pfx = attrName.slice(6);
        if (!pfx || !attrValue) return null;
        if (pfx === 'xml' && attrValue !== 'http://www.w3.org/XML/1998/namespace') return null;
        if (pfx === 'xmlns' || attrValue === 'http://www.w3.org/2000/xmlns/') return null;
        currentNs.set(pfx, attrValue);
      }

      remainingAttrs = remainingAttrs.slice(attrMatch[0].length);
    }

    const seenExpanded = new Set<string>();
    for (const { name: attrName } of rawAttrsList) {
      if (attrName.includes(':') && !attrName.startsWith('xmlns:')) {
        const [pfx, local] = attrName.split(':');
        const uri = currentNs.get(pfx);
        if (!uri) return null;
        const expanded = `{${uri}}${local}`;
        if (seenExpanded.has(expanded)) return null;
        seenExpanded.add(expanded);
      }
    }

    if (stack.length === 0) {
      rootCount++;
      if (rootCount > 1) return null;
      if (tagName.includes(':')) {
        const [pfx, local] = tagName.split(':');
        if (local !== 'svg' || currentNs.get(pfx) !== 'http://www.w3.org/2000/svg') return null;
      } else {
        if (tagName !== 'svg' || currentNs.get('') !== 'http://www.w3.org/2000/svg') return null;
      }
      rootAttrs = new Map(rawAttrsList.map((a) => [a.name, a.value]));
    }

    if (tagName.includes(':')) {
      const pfx = tagName.split(':')[0];
      if (!currentNs.get(pfx)) return null;
    }

    if (!isSelfClosing) {
      stack.push(tagName);
      nsStack.push(currentNs);
    }
  }

  return rootCount === 1 && stack.length === 0 ? rootAttrs : null;
}

export function validateSvgXml(svgText: string): boolean {
  return parseSvgRootAttributes(svgText) !== null;
}
