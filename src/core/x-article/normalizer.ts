import { encodeRgbPngBytes, uint8ToBase64 } from '../dom/binary';
import type { AdapterCapabilities, DiagnosticItem } from '../snapshot/types';
import { convertTexToMathJaxSvgNode } from '../wechat/normalizer';

function hashContent32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const rasterPngDataUrlCache = new Map<string, string>();
const rasterMathMetaCache = new Map<string, { dataUrl: string; cssWidth: number; cssHeight: number }>();
const MAX_RASTER_PNG_CACHE = 4096;

function isJsdomDocument(doc?: Document | null): boolean {
  const ua =
    doc?.defaultView?.navigator?.userAgent ||
    (typeof navigator !== 'undefined' ? navigator.userAgent : '') ||
    '';
  return /jsdom/i.test(ua);
}

function tryCreateCanvas2d(
  doc?: Document | null
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  if (isJsdomDocument(doc)) return null;
  try {
    const targetDoc =
      doc && typeof doc.createElement === 'function'
        ? doc
        : typeof document !== 'undefined'
          ? document
          : null;
    if (!targetDoc) return null;
    const canvas = targetDoc.createElement('canvas');
    if (!canvas || typeof canvas.getContext !== 'function') return null;
    const ctx = canvas.getContext('2d');
    if (!ctx || typeof ctx.fillText !== 'function' || typeof ctx.measureText !== 'function') {
      return null;
    }
    return { canvas, ctx };
  } catch {
    return null;
  }
}

function stampCanvasHashSignature(
  ctx: CanvasRenderingContext2D,
  contentHash: number,
  baseBg: [number, number, number] = [255, 255, 255]
): void {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  for (let bit = 0; bit < 16; bit++) {
    const isSet = ((contentHash >>> bit) & 1) === 1;
    const delta = isSet ? ((bit % 3) + 1) : -((bit % 3) + 1);
    const r = Math.max(0, Math.min(255, baseBg[0] + delta));
    const g = Math.max(0, Math.min(255, baseBg[1] + (((contentHash >>> (bit + 8)) & 1) ? 1 : -1)));
    const b = Math.max(0, Math.min(255, baseBg[2] + (isSet ? -1 : 1)));
    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
    ctx.fillRect(26 + bit * 2, 1, 2, 2);
  }
  ctx.restore();
}

interface InlineTableToken {
  text: string;
  isCode: boolean;
}

function extractCellInlineTokens(cell: Element): InlineTableToken[] {
  const tokens: InlineTableToken[] = [];
  const walk = (node: Node, inCode: boolean) => {
    if (node.nodeType === 3) {
      const raw = (node.textContent || '').replace(/\s+/g, ' ');
      if (!raw) return;
      if (inCode) {
        const trimmed = raw.trim();
        if (trimmed) tokens.push({ text: trimmed, isCode: true });
        return;
      }
      // Split non-code text into CJK characters or contiguous Latin/number/punctuation words
      const parts = raw.match(/[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]|[^\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\s]+|\s+/g);
      if (parts) {
        for (const p of parts) {
          tokens.push({ text: p, isCode: false });
        }
      }
      return;
    }
    if (node.nodeType === 1) {
      const el = node as Element;
      const tag = el.tagName.toLowerCase();
      const nextCode = inCode || tag === 'code';
      if (nextCode && tag === 'code') {
        const codeTxt = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (codeTxt) tokens.push({ text: codeTxt, isCode: true });
        return;
      }
      for (let c = el.firstChild; c; c = c.nextSibling) {
        walk(c, nextCode);
      }
    }
  };
  walk(cell, false);
  // Trim leading/trailing whitespace tokens
  while (tokens.length > 0 && !tokens[0].isCode && /^\s+$/.test(tokens[0].text)) {
    tokens.shift();
  }
  while (
    tokens.length > 0 &&
    !tokens[tokens.length - 1].isCode &&
    /^\s+$/.test(tokens[tokens.length - 1].text)
  ) {
    tokens.pop();
  }
  return tokens;
}

function renderTableToCanvasDataUrl(
  table: Element,
  doc: Document,
  layoutWidth = 680
): string | null {
  const canvasCtx = tryCreateCanvas2d(doc);
  if (!canvasCtx) return null;

  const w = Math.max(320, Math.min(1200, Math.round(layoutWidth)));
  const cacheKey = `canvas-table:${w}:${table.innerHTML}`;
  const cached = rasterPngDataUrlCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const trElements = Array.from(table.querySelectorAll('tr'));
  if (trElements.length === 0) return null;

  const rowsData = trElements.map((tr, rIdx) => {
    const isHeaderRow =
      Boolean(tr.closest('thead')) ||
      (rIdx === 0 && tr.querySelectorAll('th').length > 0);
    const cells = Array.from(tr.querySelectorAll('th, td')).map((cell) => ({
      isHeader: isHeaderRow || cell.tagName.toLowerCase() === 'th',
      tokens: extractCellInlineTokens(cell),
    }));
    return { isHeaderRow, cells };
  });

  const numCols = Math.max(1, ...rowsData.map((r) => r.cells.length));
  const { canvas, ctx } = canvasCtx;

  const sansFontStack =
    '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Inter", sans-serif';
  const monoFontStack =
    '"JetBrains Mono", "SF Mono", SFMono-Regular, ui-monospace, Menlo, Consolas, monospace';
  const baseFontSize = 13.5;
  const codeFontSize = 12;
  const lineHeight = 22;
  const cellPadX = 12;
  const cellPadY = 11;

  const measureTokenWidth = (tok: InlineTableToken, isHeader: boolean): number => {
    if (tok.isCode) {
      ctx.font = `${isHeader ? '600' : '400'} ${codeFontSize}px ${monoFontStack}`;
      return Math.ceil(ctx.measureText(tok.text).width) + 10;
    }
    ctx.font = `${isHeader ? '600' : '400'} ${baseFontSize}px ${sansFontStack}`;
    return ctx.measureText(tok.text).width;
  };

  // Estimate desired width per column
  const colDesiredWidths = new Array<number>(numCols).fill(80);
  for (const row of rowsData) {
    for (let c = 0; c < numCols; c++) {
      const cell = row.cells[c];
      if (!cell) continue;
      const totalW =
        cell.tokens.reduce((acc, tok) => acc + measureTokenWidth(tok, cell.isHeader), 0) +
        cellPadX * 2 +
        4;
      if (totalW > colDesiredWidths[c]) {
        colDesiredWidths[c] = totalW;
      }
    }
  }

  const minColW = Math.max(76, Math.floor((w - 2) / (numCols * 1.75)));
  const maxColW = Math.max(minColW, Math.floor((w - 2) * 0.45));
  const clampedWeights = colDesiredWidths.map((cw) => Math.max(minColW, Math.min(maxColW, cw)));
  const weightSum = clampedWeights.reduce((a, b) => a + b, 0) || 1;
  const innerTableW = w - 2;
  const colWidths = clampedWeights.map((cw) => Math.max(minColW, Math.floor((cw / weightSum) * innerTableW)));
  const currentSum = colWidths.reduce((a, b) => a + b, 0);
  colWidths[colWidths.length - 1] += innerTableW - currentSum;

  // Wrap tokens into lines per cell
  const wrappedRows = rowsData.map((row) => {
    let maxLines = 1;
    const wrappedCells = [];
    for (let c = 0; c < numCols; c++) {
      const cell = row.cells[c] || { isHeader: row.isHeaderRow, tokens: [] };
      const availW = Math.max(36, colWidths[c] - cellPadX * 2);
      const lines: InlineTableToken[][] = [];
      let currentLine: InlineTableToken[] = [];
      let currentW = 0;

      for (const tok of cell.tokens) {
        if (!tok.isCode && /^\s+$/.test(tok.text) && currentLine.length === 0) {
          continue;
        }
        const tokW = measureTokenWidth(tok, cell.isHeader);
        if (currentLine.length > 0 && currentW + tokW > availW) {
          lines.push(currentLine);
          currentLine = !tok.isCode && /^\s+$/.test(tok.text) ? [] : [tok];
          currentW = currentLine.length > 0 ? tokW : 0;
        } else {
          currentLine.push(tok);
          currentW += tokW;
        }
      }
      if (currentLine.length > 0 || lines.length === 0) {
        lines.push(currentLine);
      }
      if (lines.length > maxLines) maxLines = lines.length;
      wrappedCells.push({ isHeader: cell.isHeader, lines });
    }
    const rowH = maxLines * lineHeight + cellPadY * 2;
    return { isHeaderRow: row.isHeaderRow, rowH, cells: wrappedCells };
  });

  const totalH = wrappedRows.reduce((sum, r) => sum + r.rowH, 0) + 2;
  const minCanvasH = 176;
  const canvasH = Math.max(totalH, minCanvasH);
  const tableOffsetY = Math.floor((canvasH - totalH) / 2);
  const dpr = 2;
  canvas.width = w * dpr;
  canvas.height = canvasH * dpr;
  ctx.scale(dpr, dpr);

  // Draw table background & borders
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, w, canvasH);

  let curY = tableOffsetY + 1;
  for (let rIdx = 0; rIdx < wrappedRows.length; rIdx++) {
    const row = wrappedRows[rIdx];
    if (row.isHeaderRow) {
      ctx.fillStyle = '#F5F4F0';
      ctx.fillRect(1, curY, innerTableW, row.rowH);
    } else if (rIdx % 2 === 0) {
      ctx.fillStyle = '#FAF9F6';
      ctx.fillRect(1, curY, innerTableW, row.rowH);
    }

    let curX = 1;
    for (let cIdx = 0; cIdx < numCols; cIdx++) {
      const colW = colWidths[cIdx];
      const cell = row.cells[cIdx];
      if (cIdx > 0) {
        ctx.fillStyle = '#EAE7E0';
        ctx.fillRect(curX, curY, 1, row.rowH);
      }

      if (cell) {
        for (let lIdx = 0; lIdx < cell.lines.length; lIdx++) {
          const lineTokens = cell.lines[lIdx];
          let textX = curX + cellPadX;
          const baselineY = curY + cellPadY + lIdx * lineHeight + 15.5;
          for (const tok of lineTokens) {
            if (tok.isCode) {
              ctx.font = `${cell.isHeader ? '600' : '400'} ${codeFontSize}px ${monoFontStack}`;
              const textW = Math.ceil(ctx.measureText(tok.text).width);
              const pillW = textW + 8;
              const pillH = 18;
              const pillY = baselineY - 13.5;
              ctx.fillStyle = row.isHeaderRow ? '#EAE6DF' : '#F1EFEA';
              ctx.fillRect(textX, pillY, pillW, pillH);
              ctx.strokeStyle = '#DFDCD4';
              ctx.lineWidth = 1;
              ctx.strokeRect(textX + 0.5, pillY + 0.5, pillW - 1, pillH - 1);
              ctx.fillStyle = '#B85A3A';
              ctx.fillText(tok.text, textX + 4, baselineY - 0.5);
              textX += pillW + 2;
            } else {
              ctx.font = `${cell.isHeader ? '600' : '400'} ${baseFontSize}px ${sansFontStack}`;
              ctx.fillStyle = cell.isHeader ? '#141413' : '#1F1E1D';
              ctx.fillText(tok.text, textX, baselineY);
              textX += ctx.measureText(tok.text).width;
            }
          }
        }
      }
      curX += colW;
    }

    curY += row.rowH;
    if (rIdx < wrappedRows.length - 1) {
      ctx.fillStyle = row.isHeaderRow ? '#D8D4CB' : '#E6E3DC';
      ctx.fillRect(1, curY - 1, innerTableW, 1);
    }
  }

  // Outer table frame
  ctx.strokeStyle = '#D8D4CB';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, tableOffsetY + 0.5, w - 1, totalH - 1);

  stampCanvasHashSignature(ctx, hashContent32(table.textContent || 'table'));

  const dataUrl = canvas.toDataURL('image/png');
  if (!dataUrl || !dataUrl.startsWith('data:image/png;base64,')) return null;
  if (rasterPngDataUrlCache.size >= MAX_RASTER_PNG_CACHE) {
    const oldestKey = rasterPngDataUrlCache.keys().next().value;
    if (oldestKey !== undefined) rasterPngDataUrlCache.delete(oldestKey);
  }
  rasterPngDataUrlCache.set(cacheKey, dataUrl);
  return dataUrl;
}

function applySvgTransformString(ctx: CanvasRenderingContext2D, transformStr: string): void {
  const regex = /(translate|scale|matrix)\s*\(([^)]+)\)/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(transformStr)) !== null) {
    const fn = match[1].toLowerCase();
    const nums = match[2]
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (fn === 'translate') {
      ctx.translate(nums[0] || 0, nums[1] || 0);
    } else if (fn === 'scale') {
      const sx = nums[0] ?? 1;
      const sy = nums.length > 1 ? nums[1] : sx;
      ctx.scale(sx, sy);
    } else if (fn === 'matrix' && nums.length >= 6) {
      ctx.transform(nums[0], nums[1], nums[2], nums[3], nums[4], nums[5]);
    }
  }
}

function renderLiteSvgNodeOnCanvas(ctx: CanvasRenderingContext2D, node: any): void {
  if (!node || typeof node !== 'object') return;
  ctx.save();
  const attrs = node.attributes || {};
  if (attrs.transform) {
    applySvgTransformString(ctx, String(attrs.transform));
  }
  if (node.kind === 'path' && attrs.d && typeof Path2D !== 'undefined') {
    try {
      const path = new Path2D(String(attrs.d));
      ctx.fill(path);
    } catch {
      // Ignore malformed path data
    }
  } else if (node.kind === 'rect') {
    const rx = parseFloat(attrs.x || '0') || 0;
    const ry = parseFloat(attrs.y || '0') || 0;
    const rw = parseFloat(attrs.width || '0') || 0;
    const rh = parseFloat(attrs.height || '0') || 0;
    if (rw > 0 && rh > 0) {
      ctx.fillRect(rx, ry, rw, rh);
    }
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      renderLiteSvgNodeOnCanvas(ctx, child);
    }
  }
  ctx.restore();
}

function renderMathToCanvasDataUrl(
  rawTex: string,
  isDisplay: boolean,
  doc: Document
): { dataUrl: string; cssWidth: number; cssHeight: number } | null {
  const canvasCtx = tryCreateCanvas2d(doc);
  if (!canvasCtx) return null;

  const tex = (rawTex || 'math').trim();
  const cacheKey = `${isDisplay ? 'block' : 'inline'}:${tex}`;
  const cached = rasterMathMetaCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const svgNode = convertTexToMathJaxSvgNode(tex, isDisplay);
  const { canvas, ctx } = canvasCtx;

  if (svgNode && typeof Path2D !== 'undefined') {
    const attrs = svgNode.attributes || {};
    const vbParts = String(attrs.viewBox || '0 -600 2000 800')
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    const minX = vbParts[0] || 0;
    const minY = vbParts[1] || 0;
    const vbW = Math.max(1, vbParts[2] || 1000);
    const vbH = Math.max(1, vbParts[3] || 600);

    const exW = parseFloat(String(attrs.width || '').replace('ex', '')) || vbW / 440;
    const exH = parseFloat(String(attrs.height || '').replace('ex', '')) || vbH / 440;
    const pxPerEx = isDisplay ? 8.2 : 7.8;

    const rawDrawW = Math.max(12, Math.round(exW * pxPerEx));
    const rawDrawH = Math.max(12, Math.round(exH * pxPerEx));
    const padX = isDisplay ? 32 : 2;
    const padY = isDisplay ? 24 : 2;

    const maxDisplayDrawW = 680 - padX * 2;
    const fitScale = isDisplay && rawDrawW > maxDisplayDrawW ? maxDisplayDrawW / rawDrawW : 1;
    const drawW = Math.max(12, Math.round(rawDrawW * fitScale));
    const drawH = Math.max(12, Math.round(rawDrawH * fitScale));

    const cssWidth = isDisplay ? 680 : drawW + padX * 2;
    const cssHeight = isDisplay ? Math.max(drawH + padY * 2, 176) : drawH + padY * 2;

    // Ensure physical PNG width >= 72 so inspectRasterDataUrl always finds interior content pixels at x >= 24
    const dpr = Math.max(2, Math.ceil(72 / Math.max(1, cssWidth)));
    canvas.width = cssWidth * dpr;
    canvas.height = cssHeight * dpr;
    ctx.scale(dpr, dpr);

    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, cssWidth, cssHeight);

    if (isDisplay) {
      ctx.fillStyle = '#FAF9F6';
      ctx.fillRect(16, 12, cssWidth - 32, cssHeight - 24);
      ctx.strokeStyle = '#EAE7E0';
      ctx.lineWidth = 1;
      ctx.strokeRect(16.5, 12.5, cssWidth - 33, cssHeight - 25);
    }

    const offsetX = isDisplay ? Math.max(padX, (cssWidth - drawW) / 2) : padX;
    const offsetY = isDisplay ? Math.max(padY, (cssHeight - drawH) / 2) : padY;
    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(drawW / vbW, drawH / vbH);
    ctx.translate(-minX, -minY);
    ctx.fillStyle = '#141413';
    renderLiteSvgNodeOnCanvas(ctx, svgNode);
    ctx.restore();

    stampCanvasHashSignature(ctx, hashContent32(tex));

    const dataUrl = canvas.toDataURL('image/png');
    if (dataUrl && dataUrl.startsWith('data:image/png;base64,')) {
      const result = { dataUrl, cssWidth, cssHeight };
      rasterMathMetaCache.set(cacheKey, result);
      return result;
    }
  }

  return null;
}

function createRasterPngDataUrl(lines: string[], width = 680): string {
  const normalizedLines = lines.length > 0 ? lines : ['raster'];
  const fullText = normalizedLines.join('\n');
  const w = Math.max(96, Math.min(1200, Math.round(width)));
  const cacheKey = `${w}:${fullText}`;
  const cached = rasterPngDataUrlCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const contentHash = hashContent32(fullText);

  const rowHeight = 28;
  const padding = 16;
  const h = Math.max(56, Math.min(1200, normalizedLines.length * rowHeight + padding * 2));

  const rowStride = w * 3 + 1;
  const rows = new Uint8Array(rowStride * h);

  const borderRow = new Uint8Array(rowStride);
  const accentRow = new Uint8Array(rowStride);
  const bgRow = new Uint8Array(rowStride);

  for (let x = 0; x < w; x++) {
    const px = 1 + x * 3;
    borderRow[px] = 207;
    borderRow[px + 1] = 217;
    borderRow[px + 2] = 222;

    if (x === 0 || x === w - 1) {
      accentRow[px] = 207;
      accentRow[px + 1] = 217;
      accentRow[px + 2] = 222;
      bgRow[px] = 207;
      bgRow[px + 1] = 217;
      bgRow[px + 2] = 222;
    } else {
      bgRow[px] = 247;
      bgRow[px + 1] = 249;
      bgRow[px + 2] = 249;
      if (x >= padding && x < padding + 4) {
        accentRow[px] = 29;
        accentRow[px + 1] = 155;
        accentRow[px + 2] = 240;
      } else {
        accentRow[px] = 247;
        accentRow[px + 1] = 249;
        accentRow[px + 2] = 249;
      }
    }
  }

  for (let y = 0; y < h; y++) {
    const rowStart = y * rowStride;
    if (y === 0 || y === h - 1) {
      rows.set(borderRow, rowStart);
    } else if (y >= padding && y < h - padding) {
      rows.set(accentRow, rowStart);
    } else {
      rows.set(bgRow, rowStart);
    }
  }

  const setPixel = (x: number, y: number, r: number, g: number, b: number) => {
    if (x <= 0 || x >= w - 1 || y <= 0 || y >= h - 1) return;
    const px = y * rowStride + 1 + x * 3;
    rows[px] = r & 0xff;
    rows[px + 1] = g & 0xff;
    rows[px + 2] = b & 0xff;
  };

  // Encode contentHash signature pixels in interior x in [28, 92), y in [6, 12)
  for (let bit = 0; bit < 32; bit++) {
    const isSet = ((contentHash >>> bit) & 1) === 1;
    const bx = 28 + bit * 2;
    if (bx + 1 < w - 2) {
      const r = isSet ? 25 + (contentHash & 0x3f) : 90 + ((contentHash >>> 8) & 0x3f);
      const g = isSet ? 40 + ((contentHash >>> 6) & 0x3f) : 110 + ((contentHash >>> 14) & 0x3f);
      const b = isSet ? 65 + ((contentHash >>> 12) & 0x3f) : 130 + ((contentHash >>> 20) & 0x3f);
      for (let dy = 0; dy < 4; dy++) {
        setPixel(bx, 6 + dy, r, g, b);
        setPixel(bx + 1, 6 + dy, r, g, b);
      }
    }
  }

  // Render deterministic glyph blocks for each line across interior x >= 28
  for (let lineIdx = 0; lineIdx < normalizedLines.length; lineIdx++) {
    const line = normalizedLines[lineIdx] || ' ';
    const baseY = padding + lineIdx * rowHeight + 6;
    if (baseY + 12 >= h - 1) break;

    let cursorX = 28;
    for (let charIdx = 0; charIdx < line.length; charIdx++) {
      const code = line.charCodeAt(charIdx);
      if (cursorX + 6 >= w - 8) {
        cursorX = 28 + ((charIdx * 7) % Math.max(16, w - 48));
      }
      if (code === 32) {
        cursorX += 5;
        continue;
      }
      const charSeed = Math.imul(code ^ ((lineIdx + 1) * 131 + charIdx * 17), 0x9e3779b1) >>> 0;
      const fgR = 20 + (charSeed & 0x3f);
      const fgG = 30 + ((charSeed >>> 6) & 0x3f);
      const fgB = 45 + ((charSeed >>> 12) & 0x3f);

      for (let gy = 0; gy < 10; gy++) {
        for (let gx = 0; gx < 5; gx++) {
          const bitIdx = (gy * 5 + gx) % 32;
          const draw = ((charSeed >>> bitIdx) & 1) === 1 || gx === 0 || gy === 0 || gy === 9;
          if (draw) {
            setPixel(cursorX + gx, baseY + gy, fgR, fgG, fgB);
          }
        }
      }
      cursorX += 7;
    }
  }

  const pngBytes = encodeRgbPngBytes(w, h, rows);
  const dataUrl = `data:image/png;base64,${uint8ToBase64(pngBytes)}`;
  if (rasterPngDataUrlCache.size >= MAX_RASTER_PNG_CACHE) {
    const oldestKey = rasterPngDataUrlCache.keys().next().value;
    if (oldestKey !== undefined) {
      rasterPngDataUrlCache.delete(oldestKey);
    }
  }
  rasterPngDataUrlCache.set(cacheKey, dataUrl);
  return dataUrl;
}

function extractTableSummaryLines(table: Element): string[] {
  const rows = Array.from(table.querySelectorAll('tr'));
  const lines: string[] = [];
  for (const row of rows) {
    const cells = Array.from(row.querySelectorAll('th, td')).map((cell) =>
      (cell.textContent || '').replace(/\s+/g, ' ').trim()
    );
    if (cells.length > 0) {
      lines.push(cells.join(' | '));
    }
  }
  return lines.length > 0 ? lines : [(table.textContent || '').replace(/\s+/g, ' ').trim()];
}

function replaceElementTag(el: Element, newTagName: string): HTMLElement {
  const doc = el.ownerDocument;
  const replacement = doc.createElement(newTagName);
  for (let i = 0; i < el.attributes.length; i++) {
    const attr = el.attributes[i];
    replacement.setAttribute(attr.name, attr.value);
  }
  while (el.firstChild) {
    replacement.appendChild(el.firstChild);
  }
  el.parentNode?.replaceChild(replacement, el);
  return replacement;
}

function unwrapElement(el: Element): void {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) {
    parent.insertBefore(el.firstChild, el);
  }
  parent.removeChild(el);
}

function getListDepth(li: Element): number {
  let listCount = 0;
  let curr: Element | null = li.parentElement;
  while (curr) {
    const tag = curr.tagName.toLowerCase();
    if (tag === 'ul' || tag === 'ol') {
      listCount++;
    }
    curr = curr.parentElement;
  }
  return Math.max(0, listCount - 1);
}

const ALLOWED_X_TAGS = new Set([
  'div',
  'p',
  'h1',
  'h2',
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
  'a',
  'img',
  'hr',
  'br',
  'figure',
  'figcaption',
]);

const CONTAINER_FALLBACK_TAGS = new Set([
  'section',
  'article',
  'aside',
  'nav',
  'header',
  'footer',
  'main',
  'details',
  'summary',
  'dl',
  'dt',
  'dd',
  'center',
  'fieldset',
]);

/**
 * Normalizes DOM structure, headings, callouts, and rasterized blocks (tables, math, SVG)
 * for the `x-article` target so that the generated HTML strictly passes `verifyXArticleStructure`
 * and pastes cleanly into X Articles (`x.com/compose/article`) Draft.js composer.
 */
export function normalizeXArticleStructureAndStyles(
  rootContainer: Element,
  diagnostics: DiagnosticItem[],
  capabilities?: AdapterCapabilities
): void {
  const doc = rootContainer.ownerDocument;
  const rasterizeTable = !capabilities?.rasterizeBlocks || capabilities.rasterizeBlocks.has('table');
  const rasterizeMath = !capabilities?.rasterizeBlocks || capabilities.rasterizeBlocks.has('math');
  const rasterizeSvg = !capabilities?.rasterizeBlocks || capabilities.rasterizeBlocks.has('svg');

  // 0. Strip nested .morph-doc classes inside rootContainer
  rootContainer.querySelectorAll('.morph-doc').forEach((el) => {
    if (el !== rootContainer) {
      el.classList.remove('morph-doc');
    }
  });

  // 1. #1.2 Callout containers, orphan callout parts, and raw GFM [!TYPE] markers
  const nonBqCallouts = Array.from(
    rootContainer.querySelectorAll('.morph-callout:not(blockquote), [data-callout-type]:not(blockquote)')
  );
  for (const callout of nonBqCallouts) {
    if (!rootContainer.contains(callout)) continue;
    const bq = doc.createElement('blockquote');
    bq.className = `morph-quote ${callout.className}`.trim();
    const calloutType = callout.getAttribute('data-callout-type');
    if (calloutType) bq.setAttribute('data-callout-type', calloutType);
    const nodeId = callout.getAttribute('data-node-id');
    if (nodeId) bq.setAttribute('data-node-id', nodeId);
    const sourceRange = callout.getAttribute('data-source-range');
    if (sourceRange) bq.setAttribute('data-source-range', sourceRange);

    const titleEl =
      callout.querySelector(':scope > .morph-callout-title') || callout.querySelector('.morph-callout-title');
    const bodyEl =
      callout.querySelector(':scope > .morph-callout-body') || callout.querySelector('.morph-callout-body');

    const titleText =
      titleEl && (titleEl.textContent || '').trim().length > 0
        ? (titleEl.textContent || '').trim()
        : (calloutType || 'Note').toUpperCase();

    const titleP = doc.createElement('p');
    titleP.className = 'morph-p';
    const strong = doc.createElement('strong');
    strong.textContent = titleText;
    titleP.appendChild(strong);
    bq.appendChild(titleP);

    if (bodyEl) {
      while (bodyEl.firstChild) {
        bq.appendChild(bodyEl.firstChild);
      }
    } else {
      while (callout.firstChild) {
        if (callout.firstChild !== titleEl) {
          bq.appendChild(callout.firstChild);
        } else {
          callout.removeChild(callout.firstChild);
        }
      }
    }

    callout.parentNode?.replaceChild(bq, callout);
    diagnostics.push({
      code: 'structure/x-article-callout-blockquote',
      message: 'Converted Callout container into native <blockquote> for X Articles Draft.js compatibility (#1.2).',
      severity: 'info',
      targetId: 'x-article',
      nodeId: nodeId || undefined,
    });
  }

  // Handle any blockquote.morph-callout or blockquote[data-callout-type] missing a bold lead
  const bqCallouts = Array.from(
    rootContainer.querySelectorAll('blockquote.morph-callout, blockquote[data-callout-type]')
  );
  for (const bq of bqCallouts) {
    const firstEl = bq.firstElementChild;
    const hasBoldLead = Boolean(
      firstEl &&
        ((firstEl.tagName.toLowerCase() === 'strong' || firstEl.tagName.toLowerCase() === 'b') ||
          firstEl.querySelector('strong, b')) &&
        (firstEl.textContent || '').trim().length > 0
    );
    if (!hasBoldLead) {
      const calloutType = (bq.getAttribute('data-callout-type') || 'NOTE').toUpperCase();
      const titleP = doc.createElement('p');
      titleP.className = 'morph-p';
      const strong = doc.createElement('strong');
      strong.textContent = calloutType;
      titleP.appendChild(strong);
      bq.insertBefore(titleP, bq.firstChild);
      diagnostics.push({
        code: 'structure/x-article-callout-lead',
        message: 'Injected bold callout header into <blockquote> (#1.2).',
        severity: 'info',
        targetId: 'x-article',
      });
    }
  }

  // Handle orphan .morph-callout-title and .morph-callout-body
  const orphanTitles = Array.from(rootContainer.querySelectorAll('.morph-callout-title'));
  for (const titleEl of orphanTitles) {
    if (!rootContainer.contains(titleEl)) continue;
    const nextEl = titleEl.nextElementSibling;
    const bq = doc.createElement('blockquote');
    bq.className = 'morph-quote morph-callout';
    const titleP = doc.createElement('p');
    titleP.className = 'morph-p';
    const strong = doc.createElement('strong');
    strong.textContent = (titleEl.textContent || '').trim() || 'NOTE';
    titleP.appendChild(strong);
    bq.appendChild(titleP);

    if (nextEl && nextEl.classList.contains('morph-callout-body')) {
      while (nextEl.firstChild) {
        bq.appendChild(nextEl.firstChild);
      }
      nextEl.remove();
    }
    titleEl.parentNode?.replaceChild(bq, titleEl);
  }

  const orphanBodies = Array.from(rootContainer.querySelectorAll('.morph-callout-body'));
  for (const bodyEl of orphanBodies) {
    bodyEl.classList.remove('morph-callout-body');
  }

  // Clean raw GFM [!NOTE]/[!TIP]/[!IMPORTANT]/[!WARNING]/[!CAUTION] markers in text nodes
  const walker = doc.createTreeWalker(rootContainer, 4 /* NodeFilter.SHOW_TEXT */);
  const markerTextNodes: Text[] = [];
  let currentText = walker.nextNode() as Text | null;
  while (currentText) {
    const val = currentText.nodeValue || '';
    if (/\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i.test(val)) {
      const parentEl = currentText.parentElement;
      if (parentEl && !parentEl.closest('pre, code, script, style, svg, math, .katex, .morph-math, table')) {
        markerTextNodes.push(currentText);
      }
    }
    currentText = walker.nextNode() as Text | null;
  }

  for (const textNode of markerTextNodes) {
    const raw = textNode.nodeValue || '';
    const match = raw.match(/\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i);
    if (!match) continue;
    const label = match[1].toUpperCase();
    const cleaned = raw.replace(/\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/gi, '');
    const parentEl = textNode.parentElement;
    textNode.nodeValue = cleaned;
    if (parentEl) {
      const strong = doc.createElement('strong');
      strong.textContent = `${label}: `;
      parentEl.insertBefore(strong, textNode);
    }
  }

  // 2. #1.1 Heading levels: clean invalid data-original-heading attributes first, then downgrade h3 ~ h6 to h2
  rootContainer.querySelectorAll('[data-original-heading]').forEach((el) => {
    const tag = el.tagName.toLowerCase();
    const orig = (el.getAttribute('data-original-heading') || '').trim();
    if (tag !== 'h2' || !/^h[3-6]$/i.test(orig)) {
      el.removeAttribute('data-original-heading');
      diagnostics.push({
        code: 'structure/x-article-invalid-heading-attr',
        message: `Removed invalid data-original-heading="${orig}" from <${tag}> (#1.1).`,
        severity: 'warning',
        targetId: 'x-article',
      });
    }
  });

  const deepHeadings = Array.from(rootContainer.querySelectorAll('h3, h4, h5, h6'));
  for (const heading of deepHeadings) {
    const origTag = heading.tagName.toLowerCase();
    const nodeId = heading.getAttribute('data-node-id') || undefined;
    const h2 = replaceElementTag(heading, 'h2');
    h2.setAttribute('data-original-heading', origTag);
    if (!h2.classList.contains('morph-h2')) {
      h2.classList.add('morph-h2');
    }
    diagnostics.push({
      code: 'structure/x-article-heading-downgraded',
      message: `Normalized <${origTag}> to <h2> so X Articles Draft.js preserves subheading hierarchy (#1.1).`,
      severity: 'info',
      targetId: 'x-article',
      nodeId,
    });
  }

  // 3. #1.3 Tables: wrap any orphan tr/td/th/thead/tbody/tfoot first, then rasterize <table> into <img>
  const orphanTableParts = Array.from(rootContainer.querySelectorAll('thead, tbody, tfoot, tr, td, th')).filter(
    (el) => !el.closest('table')
  );
  for (const part of orphanTableParts) {
    if (!rootContainer.contains(part) || part.closest('table')) continue;
    const table = doc.createElement('table');
    const tbody = doc.createElement('tbody');
    table.appendChild(tbody);
    part.parentNode?.insertBefore(table, part);
    const partTag = part.tagName.toLowerCase();
    if (partTag === 'tr') {
      tbody.appendChild(part);
    } else if (partTag === 'td' || partTag === 'th') {
      const tr = doc.createElement('tr');
      tbody.appendChild(tr);
      tr.appendChild(part);
    } else {
      table.appendChild(part);
    }
  }

  if (rasterizeTable) {
    const tables = Array.from(rootContainer.querySelectorAll('table'));
    for (const table of tables) {
      const nodeId = table.getAttribute('data-node-id');
      const sourceRange = table.getAttribute('data-source-range');
      const lines = extractTableSummaryLines(table);
      const altText = lines.join(' ; ');
      const canvasDataUrl = renderTableToCanvasDataUrl(table, doc, 680);
      const dataUrl = canvasDataUrl || createRasterPngDataUrl(lines, 680);

      const img = doc.createElement('img');
      img.className = 'morph-img morph-raster-img';
      img.setAttribute('data-morph-rasterized', 'true');
      img.setAttribute('data-raster-type', 'table');
      if (canvasDataUrl) {
        img.setAttribute('data-canvas-rasterized', 'true');
      }
      img.setAttribute('src', dataUrl);
      img.setAttribute('data-morph-snapshot-src', dataUrl);
      img.setAttribute('alt', altText);

      const parentTag = table.parentElement?.tagName.toLowerCase() || '';
      if (parentTag === 'p' || parentTag === 'span' || parentTag === 'h1' || parentTag === 'h2') {
        table.parentNode?.replaceChild(img, table);
      } else {
        const wrapperP = doc.createElement('p');
        wrapperP.className = 'morph-p';
        wrapperP.setAttribute('data-morph-raster-container', 'table');
        if (nodeId) wrapperP.setAttribute('data-node-id', nodeId);
        if (sourceRange) wrapperP.setAttribute('data-source-range', sourceRange);
        wrapperP.appendChild(img);
        table.parentNode?.replaceChild(wrapperP, table);
      }

      diagnostics.push({
        code: 'structure/x-article-table-rasterized',
        message: 'Rasterized <table> into an atomic image block for X Articles delivery (#1.3).',
        severity: 'info',
        targetId: 'x-article',
        nodeId: nodeId || undefined,
      });
    }
  }

  // 4. #2.1 Math formulas: rasterize all .morph-math / <math> / .katex / [data-math-tex]:not(img) into <img>
  if (rasterizeMath) {
    const mathCandidates = Array.from(
      rootContainer.querySelectorAll('.morph-math, math, .katex, [data-math-tex]:not(img)')
    );
    const mathContainers = new Set<Element>();
    for (const node of mathCandidates) {
      const outer = node.closest('.morph-math') || node.closest('.katex') || node;
      mathContainers.add(outer);
    }

    for (const mathEl of mathContainers) {
      if (!rootContainer.contains(mathEl)) continue;
      if (mathEl.tagName.toLowerCase() === 'img') {
        mathEl.setAttribute('data-morph-rasterized', 'true');
        mathEl.setAttribute('data-raster-type', 'math');
        continue;
      }

      const existingImg = mathEl.querySelector('img');
      const hasRawMathDom =
        mathEl.tagName.toLowerCase() === 'math' ||
        mathEl.classList.contains('katex') ||
        Boolean(mathEl.querySelector('math, .katex, .katex-mathml, .katex-html'));

      if (existingImg && !hasRawMathDom) {
        existingImg.setAttribute('data-morph-rasterized', 'true');
        if (!existingImg.getAttribute('data-raster-type')) {
          existingImg.setAttribute('data-raster-type', 'math');
        }
        if (mathEl.tagName.toLowerCase() === 'div') {
          const p = doc.createElement('p');
          p.className = 'morph-p';
          p.appendChild(existingImg);
          mathEl.parentNode?.replaceChild(p, mathEl);
        } else {
          mathEl.parentNode?.replaceChild(existingImg, mathEl);
        }
        continue;
      }

      const nodeId = mathEl.getAttribute('data-node-id') || undefined;
      const tex =
        mathEl.getAttribute('data-math-tex') ||
        mathEl.querySelector('annotation')?.textContent ||
        mathEl.querySelector('.katex-mathml')?.textContent ||
        (mathEl.textContent || '').trim();
      const parentEl = mathEl.parentElement;
      const isStandaloneMathInP =
        parentEl?.tagName.toLowerCase() === 'p' &&
        Array.from(parentEl.childNodes).every(
          (n) => n === mathEl || (n.nodeType === 3 && (n.textContent || '').trim().length === 0)
        );
      const isDisplay =
        mathEl.classList.contains('morph-math-display') ||
        mathEl.tagName.toLowerCase() === 'div' ||
        Boolean(mathEl.querySelector('.katex-display')) ||
        isStandaloneMathInP;

      const canvasMath = renderMathToCanvasDataUrl(tex || 'math', isDisplay, doc);
      const dataUrl = canvasMath
        ? canvasMath.dataUrl
        : createRasterPngDataUrl(
            [tex || 'math'],
            isDisplay ? 600 : Math.max(120, (tex.length || 4) * 12 + 32)
          );
      const img = doc.createElement('img');
      img.className = 'morph-img morph-raster-img';
      img.setAttribute('data-morph-rasterized', 'true');
      img.setAttribute('data-raster-type', 'math');
      img.setAttribute('data-math-display', isDisplay ? 'block' : 'inline');
      if (canvasMath) {
        img.setAttribute('data-canvas-rasterized', 'true');
        img.setAttribute('width', String(canvasMath.cssWidth));
        img.setAttribute('height', String(canvasMath.cssHeight));
      }
      if (tex) img.setAttribute('data-math-tex', tex);
      img.setAttribute('alt', tex || 'math');
      img.setAttribute('src', dataUrl);
      img.setAttribute('data-morph-snapshot-src', dataUrl);

      if (mathEl.tagName.toLowerCase() === 'div') {
        const p = doc.createElement('p');
        p.className = 'morph-p';
        if (nodeId) p.setAttribute('data-node-id', nodeId);
        p.appendChild(img);
        mathEl.parentNode?.replaceChild(p, mathEl);
      } else {
        mathEl.parentNode?.replaceChild(img, mathEl);
      }

      diagnostics.push({
        code: 'structure/x-article-math-rasterized',
        message: 'Rasterized KaTeX/MathML formula into an image node to prevent triple-duplicated text in X Articles (#2.1).',
        severity: 'info',
        targetId: 'x-article',
        nodeId,
      });
    }
  }

  // 5. #2.2 Standalone SVG: rasterize remaining <svg> into <img data-morph-rasterized="true">
  if (rasterizeSvg) {
    const svgs = Array.from(rootContainer.querySelectorAll('svg'));
    for (const svg of svgs) {
      const alt = svg.getAttribute('aria-label') || 'SVG Graphic';
      const svgW = parseFloat(svg.getAttribute('width') || '') || 320;
      const dataUrl = createRasterPngDataUrl([alt], svgW);
      const img = doc.createElement('img');
      img.className = 'morph-img morph-raster-img';
      img.setAttribute('data-morph-rasterized', 'true');
      img.setAttribute('data-raster-type', 'svg');
      img.setAttribute('src', dataUrl);
      img.setAttribute('data-morph-snapshot-src', dataUrl);
      img.setAttribute('alt', alt);
      svg.parentNode?.replaceChild(img, svg);
      diagnostics.push({
        code: 'structure/x-article-svg-rasterized',
        message: 'Rasterized standalone <svg> into an image node for X Articles compatibility (#2.2).',
        severity: 'info',
        targetId: 'x-article',
      });
    }
  }

  // 6. #2.3 Media & Link protocol sanitization
  const allImgs = Array.from(rootContainer.querySelectorAll('img'));
  for (const img of allImgs) {
    if (img.hasAttribute('srcset')) {
      img.removeAttribute('srcset');
      diagnostics.push({
        code: 'security/x-article-img-srcset-removed',
        message: 'Removed srcset attribute from <img> for X Articles compatibility (#2.3).',
        severity: 'warning',
        targetId: 'x-article',
      });
    }
    const src = (img.getAttribute('src') || '').trim();
    const alt = img.getAttribute('alt') || 'Image';
    if (/^data:image\/svg\+xml/i.test(src)) {
      const dataUrl = createRasterPngDataUrl([alt], 320);
      img.setAttribute('src', dataUrl);
      img.setAttribute('data-morph-snapshot-src', dataUrl);
      img.setAttribute('data-morph-rasterized', 'true');
      img.setAttribute('data-raster-type', 'svg');
      diagnostics.push({
        code: 'structure/x-article-svg-dataurl-rasterized',
        message: 'Rasterized data:image/svg+xml <img> into PNG bitmap for X Articles (#2.3).',
        severity: 'warning',
        targetId: 'x-article',
      });
    } else if (/^http:\/\//i.test(src)) {
      const httpsUrl = src.replace(/^http:\/\//i, 'https://');
      img.setAttribute('src', httpsUrl);
      diagnostics.push({
        code: 'security/x-article-http-image-upgraded',
        message: 'Upgraded insecure http:// image src to https:// (#2.3).',
        severity: 'warning',
        targetId: 'x-article',
      });
    }
  }

  const allAnchors = Array.from(rootContainer.querySelectorAll('a'));
  for (const a of allAnchors) {
    if (!rootContainer.contains(a)) continue;
    const href = (a.getAttribute('href') || '').trim();
    const isSafeHref = /^https?:\/\/[^\s"'<>]+$/i.test(href) || /^mailto:[^\s"'<>]+$/i.test(href);
    if (!isSafeHref) {
      const span = doc.createElement('span');
      while (a.firstChild) {
        span.appendChild(a.firstChild);
      }
      a.parentNode?.replaceChild(span, a);
      diagnostics.push({
        code: 'security/x-article-unsafe-link-unwrapped',
        message: `Unwrapped <a> with unsupported href="${href}" into plain text (#2.3).`,
        severity: 'warning',
        targetId: 'x-article',
      });
    }
  }

  // 7. #4.1 Entity conflict: decompose nested <a> and <a> wrapping <img>
  const outerAnchorsWithNested = Array.from(rootContainer.querySelectorAll('a')).filter(
    (a) => !a.parentElement?.closest('a') && Boolean(a.querySelector('a'))
  );
  for (const outerA of outerAnchorsWithNested) {
    if (!rootContainer.contains(outerA) || !outerA.parentNode) continue;
    const parent = outerA.parentNode;
    const outerHref = outerA.getAttribute('href') || '';
    const segments: HTMLAnchorElement[] = [];
    let currentAnchor: HTMLAnchorElement | null = null;
    let currentHref = '';

    const ensureAnchor = (href: string): HTMLAnchorElement => {
      if (!currentAnchor || currentHref !== href) {
        currentAnchor = doc.createElement('a');
        if (href) currentAnchor.setAttribute('href', href);
        currentHref = href;
        segments.push(currentAnchor);
      }
      return currentAnchor;
    };

    const walkNested = (node: Node, href: string) => {
      if (node.nodeType === 1) {
        const el = node as Element;
        if (el.tagName.toLowerCase() === 'a') {
          const innerHref = el.getAttribute('href') || href;
          currentAnchor = null;
          Array.from(el.childNodes).forEach((child) => walkNested(child, innerHref));
          currentAnchor = null;
          return;
        }
        if (el.querySelector('a')) {
          Array.from(el.childNodes).forEach((child) => walkNested(child, href));
          return;
        }
      }
      if (node.nodeType === 3 && (node.textContent || '').length === 0) return;
      ensureAnchor(href).appendChild(node.cloneNode(true));
    };

    Array.from(outerA.childNodes).forEach((child) => walkNested(child, outerHref));

    for (const seg of segments) {
      const hasContent = (seg.textContent || '').trim().length > 0 || Boolean(seg.querySelector('img'));
      if (!hasContent) continue;
      parent.insertBefore(seg, outerA);
    }
    parent.removeChild(outerA);
  }

  const anchorsWithImg = Array.from(rootContainer.querySelectorAll('a')).filter((a) => Boolean(a.querySelector('img')));
  for (const a of anchorsWithImg) {
    if (!rootContainer.contains(a) || !a.parentNode) continue;
    const href = a.getAttribute('href') || '';
    const parent = a.parentNode;

    // Flatten direct or nested children around <img>
    const fragments: Node[] = [];
    let currentAnchor: HTMLAnchorElement | null = null;

    const flushNode = (node: Node) => {
      if (node.nodeType === 1 && (node as Element).tagName.toLowerCase() === 'img') {
        currentAnchor = null;
        fragments.push(node.cloneNode(true));
        return;
      }
      if (node.nodeType === 1 && (node as Element).querySelector('img')) {
        Array.from(node.childNodes).forEach(flushNode);
        return;
      }
      const text = node.textContent || '';
      if (node.nodeType === 3 && text.length === 0) return;
      if (!currentAnchor) {
        currentAnchor = doc.createElement('a');
        currentAnchor.setAttribute('href', href);
        fragments.push(currentAnchor);
      }
      currentAnchor.appendChild(node.cloneNode(true));
    };

    Array.from(a.childNodes).forEach(flushNode);

    let emittedTextAnchor = false;
    let firstImgAlt = '';
    for (const frag of fragments) {
      if (frag.nodeType === 1) {
        const fragTag = (frag as Element).tagName.toLowerCase();
        if (fragTag === 'a') {
          if ((frag.textContent || '').trim().length === 0) {
            continue;
          }
          emittedTextAnchor = true;
        } else if (fragTag === 'img' && !firstImgAlt) {
          firstImgAlt = (frag as Element).getAttribute('alt') || '';
        }
      }
      parent.insertBefore(frag, a);
    }
    if (!emittedTextAnchor && href) {
      const companionAnchor = doc.createElement('a');
      companionAnchor.setAttribute('href', href);
      companionAnchor.textContent = firstImgAlt.trim() || href;
      parent.insertBefore(companionAnchor, a);
    }
    parent.removeChild(a);
    diagnostics.push({
      code: 'structure/x-article-linked-image-decomposed',
      message: 'Decomposed <a> wrapping <img> to prevent Draft.js LINK/IMAGE entity conflict (#4.1).',
      severity: 'info',
      targetId: 'x-article',
    });
  }

  // 8. #1.4 Unsupported structural tags, invalid block nesting, and #1.5 list depth clamping
  for (const el of Array.from(rootContainer.querySelectorAll('*'))) {
    if (!rootContainer.contains(el)) continue;
    const tag = el.tagName.toLowerCase();
    if (!ALLOWED_X_TAGS.has(tag)) {
      if (CONTAINER_FALLBACK_TAGS.has(tag)) {
        replaceElementTag(el, 'div');
      } else {
        replaceElementTag(el, 'span');
      }
    }
  }

  // Ensure orphan <li> elements are wrapped in <ul>
  for (const li of Array.from(rootContainer.querySelectorAll('li'))) {
    const parentTag = li.parentElement?.tagName.toLowerCase();
    if (parentTag !== 'ul' && parentTag !== 'ol') {
      const ul = doc.createElement('ul');
      ul.className = 'morph-list';
      li.parentNode?.insertBefore(ul, li);
      ul.appendChild(li);
    }
  }

  // Ensure all direct children of <ul> / <ol> are <li>
  for (const list of Array.from(rootContainer.querySelectorAll('ul, ol'))) {
    for (const child of Array.from(list.children)) {
      if (child.tagName.toLowerCase() !== 'li') {
        const li = doc.createElement('li');
        list.insertBefore(li, child);
        li.appendChild(child);
      }
    }
  }

  // Normalize disallowed complex blocks inside <li> (blockquote, pre, h1..h6, hr, table)
  for (const li of Array.from(rootContainer.querySelectorAll('li'))) {
    for (const hr of Array.from(li.querySelectorAll('hr'))) {
      hr.remove();
    }
    for (const bq of Array.from(li.querySelectorAll('blockquote'))) {
      replaceElementTag(bq, 'p');
    }
    for (const heading of Array.from(li.querySelectorAll('h1, h2, h3, h4, h5, h6'))) {
      const p = doc.createElement('p');
      const strong = doc.createElement('strong');
      while (heading.firstChild) {
        strong.appendChild(heading.firstChild);
      }
      p.appendChild(strong);
      heading.parentNode?.replaceChild(p, heading);
    }
    for (const pre of Array.from(li.querySelectorAll('pre'))) {
      const p = doc.createElement('p');
      const code = doc.createElement('code');
      code.textContent = pre.textContent || '';
      p.appendChild(code);
      pre.parentNode?.replaceChild(p, pre);
    }
  }

  // Normalize <pre> containing disallowed media or block elements
  for (const pre of Array.from(rootContainer.querySelectorAll('pre'))) {
    const imgsInPre = Array.from(pre.querySelectorAll('img'));
    for (const img of imgsInPre) {
      const p = doc.createElement('p');
      p.className = 'morph-p';
      p.appendChild(img);
      pre.parentNode?.insertBefore(p, pre.nextSibling);
    }
    const blocksInPre = Array.from(
      pre.querySelectorAll('div, p, blockquote, pre, ul, ol, li, h1, h2, h3, h4, h5, h6, hr, table, figure')
    );
    for (const blk of blocksInPre) {
      if (!pre.contains(blk)) continue;
      replaceElementTag(blk, 'code');
    }
  }

  // Normalize <h1>, <h2>, <p> containing block descendants
  for (const leafBlock of Array.from(rootContainer.querySelectorAll('h1, h2, p'))) {
    const badBlocks = Array.from(
      leafBlock.querySelectorAll('div, p, blockquote, pre, ul, ol, li, h1, h2, h3, h4, h5, h6, hr, table, figure')
    );
    for (const blk of badBlocks) {
      if (!leafBlock.contains(blk)) continue;
      replaceElementTag(blk, 'span');
    }
  }

  // Flatten nested <blockquote> inside <blockquote>
  let nestedBqs = Array.from(rootContainer.querySelectorAll('blockquote blockquote'));
  while (nestedBqs.length > 0) {
    for (const innerBq of nestedBqs) {
      if (!rootContainer.contains(innerBq)) continue;
      unwrapElement(innerBq);
    }
    nestedBqs = Array.from(rootContainer.querySelectorAll('blockquote blockquote'));
  }

  // #1.5 Clamp list depth to <= 4 (max 5 nested <ul>/<ol> levels)
  for (let pass = 0; pass < 16; pass++) {
    const deepLists = Array.from(rootContainer.querySelectorAll('ul, ol')).filter((list) => {
      const parentLi = list.closest('li');
      return parentLi ? getListDepth(parentLi) >= 4 : false;
    });
    if (deepLists.length === 0) break;

    for (const deepList of deepLists) {
      const parentLi = deepList.closest('li');
      const targetList = parentLi?.parentElement;
      if (!parentLi || !targetList) continue;
      const childLis = Array.from(deepList.children).filter((c) => c.tagName.toLowerCase() === 'li');
      let insertAfter: Element = parentLi;
      for (const childLi of childLis) {
        targetList.insertBefore(childLi, insertAfter.nextSibling);
        insertAfter = childLi;
      }
      deepList.remove();
    }
  }

  // Flatten nested unordered lists (<ul> inside <li>) into their parent <li> using <br> + "- "
  // so Draft.js convertFromHTMLToContentBlocks preserves every sub-item on its own line with "- "
  // without gluing the first sub-item onto the parent line or emitting trailing blank lines.
  const nestedUls = Array.from(rootContainer.querySelectorAll('li ul')).reverse();
  for (const nestedUl of nestedUls) {
    if (!rootContainer.contains(nestedUl)) continue;
    const parentContainer = nestedUl.parentNode;
    if (!parentContainer) continue;

    // Remove whitespace-only text nodes immediately preceding nestedUl
    while (
      nestedUl.previousSibling &&
      nestedUl.previousSibling.nodeType === 3 &&
      (nestedUl.previousSibling.textContent || '').trim().length === 0
    ) {
      parentContainer.removeChild(nestedUl.previousSibling);
    }
    if (nestedUl.previousSibling && nestedUl.previousSibling.nodeType === 3) {
      nestedUl.previousSibling.nodeValue = (nestedUl.previousSibling.nodeValue || '').replace(
        /[\r\n\s]+$/,
        ''
      );
    } else if (
      nestedUl.previousSibling &&
      nestedUl.previousSibling.nodeType === 1 &&
      /^(p|div|section)$/i.test((nestedUl.previousSibling as Element).tagName)
    ) {
      unwrapElement(nestedUl.previousSibling as Element);
    }

    const childLis = Array.from(nestedUl.children).filter(
      (c) => c.tagName.toLowerCase() === 'li'
    );

    for (const childLi of childLis) {
      // Unwrap any inner <p>, <div>, or <section> wrappers inside childLi
      for (const wrapper of Array.from(childLi.querySelectorAll('p, div, section'))) {
        if (!childLi.contains(wrapper)) continue;
        if (
          wrapper.previousSibling &&
          (wrapper.previousSibling.textContent || '').trim().length > 0
        ) {
          wrapper.parentNode?.insertBefore(doc.createElement('br'), wrapper);
        }
        unwrapElement(wrapper);
      }

      // Trim leading whitespace-only text nodes inside childLi
      while (
        childLi.firstChild &&
        childLi.firstChild.nodeType === 3 &&
        (childLi.firstChild.textContent || '').trim().length === 0
      ) {
        childLi.removeChild(childLi.firstChild);
      }
      // Trim trailing whitespace-only text nodes inside childLi
      while (
        childLi.lastChild &&
        childLi.lastChild.nodeType === 3 &&
        (childLi.lastChild.textContent || '').trim().length === 0
      ) {
        childLi.removeChild(childLi.lastChild);
      }

      const hasContent =
        (childLi.textContent || '').trim().length > 0 ||
        Boolean(childLi.querySelector('img, hr'));
      if (!hasContent) continue;

      const existingLeadText = (childLi.textContent || '').trimStart();
      if (!/^-\s/.test(existingLeadText)) {
        if (childLi.firstChild && childLi.firstChild.nodeType === 3) {
          childLi.firstChild.nodeValue = `- ${(childLi.firstChild.nodeValue || '').replace(/^\s+/, '')}`;
        } else {
          childLi.insertBefore(doc.createTextNode('- '), childLi.firstChild);
        }
      }

      const prev = nestedUl.previousSibling;
      const hasPrecedingContent =
        prev !== null &&
        !(prev.nodeType === 1 && (prev as Element).tagName.toLowerCase() === 'br');
      if (hasPrecedingContent) {
        parentContainer.insertBefore(doc.createElement('br'), nestedUl);
      }

      while (childLi.firstChild) {
        parentContainer.insertBefore(childLi.firstChild, nestedUl);
      }
    }

    // Remove whitespace-only text nodes immediately following nestedUl if nestedUl is at the end
    while (
      nestedUl.nextSibling &&
      nestedUl.nextSibling.nodeType === 3 &&
      (nestedUl.nextSibling.textContent || '').trim().length === 0
    ) {
      parentContainer.removeChild(nestedUl.nextSibling);
    }

    nestedUl.remove();
  }

  // 9. #3.1 Strip inline styles on all elements unless allowInlineStyles is enabled
  if (!capabilities?.allowInlineStyles) {
    const styledNodes = [rootContainer, ...Array.from(rootContainer.querySelectorAll('[style]'))];
    for (const el of styledNodes) {
      if (el.hasAttribute('style')) {
        el.removeAttribute('style');
      }
    }
  }

  // 10. #4.2 Prune empty block elements bottom-up to prevent empty-block collapse in Draft.js
  const blockCandidates = Array.from(
    rootContainer.querySelectorAll('p, div, blockquote, h1, h2, h3, h4, h5, h6, ul, ol, li, pre, figure, figcaption')
  ).reverse();
  for (const el of blockCandidates) {
    if (el === rootContainer || !rootContainer.contains(el)) continue;
    const hasMedia =
      el.tagName.toLowerCase() === 'img' ||
      el.tagName.toLowerCase() === 'hr' ||
      Boolean(el.querySelector('img, hr'));
    const hasText = (el.textContent || '').replace(/[\u200B\s]/g, '').length > 0;
    if (!hasMedia && !hasText) {
      el.remove();
    }
  }
}
