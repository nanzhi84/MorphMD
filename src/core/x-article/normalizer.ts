import { encodeRgbPngBytes, uint8ToBase64 } from '../dom/binary';
import type { AdapterCapabilities, DiagnosticItem } from '../snapshot/types';

function hashContent32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const rasterPngDataUrlCache = new Map<string, string>();
const MAX_RASTER_PNG_CACHE = 4096;

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
      const dataUrl = createRasterPngDataUrl(lines, 680);

      const img = doc.createElement('img');
      img.className = 'morph-img morph-raster-img';
      img.setAttribute('data-morph-rasterized', 'true');
      img.setAttribute('data-raster-type', 'table');
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
      const isDisplay =
        mathEl.classList.contains('morph-math-display') ||
        mathEl.tagName.toLowerCase() === 'div' ||
        Boolean(mathEl.querySelector('.katex-display'));

      const dataUrl = createRasterPngDataUrl([tex || 'math'], isDisplay ? 600 : Math.max(120, (tex.length || 4) * 12 + 32));
      const img = doc.createElement('img');
      img.className = 'morph-img morph-raster-img';
      img.setAttribute('data-morph-rasterized', 'true');
      img.setAttribute('data-raster-type', 'math');
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
