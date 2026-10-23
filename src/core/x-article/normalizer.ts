import type { AdapterCapabilities, DiagnosticItem } from '../snapshot/types';

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function createTextCardSvgDataUrl(lines: string[], width = 680): string {
  const rowHeight = 28;
  const padding = 16;
  const height = Math.max(56, lines.length * rowHeight + padding * 2);
  const textNodes = lines
    .map(
      (line, idx) =>
        `<text x="${padding}" y="${padding + 20 + idx * rowHeight}" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="14" fill="#0f1419">${escapeXml(
          line.slice(0, 120)
        )}</text>`
    )
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" rx="8" fill="#f7f9f9" stroke="#cfd9de" stroke-width="1"/>${textNodes}</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
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
  const allowCodeBlockStyles = !capabilities?.rasterizeBlocks || capabilities.rasterizeBlocks.has('code');

  // 1. #1.2 Callout containers: convert <div class="morph-callout"> to <blockquote>
  const callouts = Array.from(rootContainer.querySelectorAll('div.morph-callout'));
  for (const callout of callouts) {
    const bq = doc.createElement('blockquote');
    bq.className = `morph-quote ${callout.className}`.trim();
    const calloutType = callout.getAttribute('data-callout-type');
    if (calloutType) bq.setAttribute('data-callout-type', calloutType);
    const nodeId = callout.getAttribute('data-node-id');
    if (nodeId) bq.setAttribute('data-node-id', nodeId);
    const sourceRange = callout.getAttribute('data-source-range');
    if (sourceRange) bq.setAttribute('data-source-range', sourceRange);

    const titleEl = callout.querySelector(':scope > .morph-callout-title') || callout.querySelector('.morph-callout-title');
    const bodyEl = callout.querySelector(':scope > .morph-callout-body') || callout.querySelector('.morph-callout-body');

    if (titleEl && (titleEl.textContent || '').trim().length > 0) {
      const titleP = doc.createElement('p');
      titleP.className = 'morph-p';
      const strong = doc.createElement('strong');
      strong.textContent = (titleEl.textContent || '').trim();
      titleP.appendChild(strong);
      bq.appendChild(titleP);
    }

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

  // 2. #1.1 Heading levels: downgrade h3 ~ h6 to h2 (X Articles only supports header-one and header-two)
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

  // 3. #1.3 Tables: rasterize <table> into <img data-morph-rasterized="true">
  if (rasterizeTable) {
    const tables = Array.from(rootContainer.querySelectorAll('table'));
    for (const table of tables) {
      const nodeId = table.getAttribute('data-node-id');
      const sourceRange = table.getAttribute('data-source-range');
      const lines = extractTableSummaryLines(table);
      const altText = lines.join(' ; ');
      const dataUrl = createTextCardSvgDataUrl(lines, 680);

      const wrapperP = doc.createElement('p');
      wrapperP.className = 'morph-p';
      wrapperP.setAttribute('data-morph-raster-container', 'table');
      if (nodeId) wrapperP.setAttribute('data-node-id', nodeId);
      if (sourceRange) wrapperP.setAttribute('data-source-range', sourceRange);

      const img = doc.createElement('img');
      img.className = 'morph-img morph-raster-img';
      img.setAttribute('data-morph-rasterized', 'true');
      img.setAttribute('data-raster-type', 'table');
      img.setAttribute('src', dataUrl);
      img.setAttribute('data-morph-snapshot-src', dataUrl);
      img.setAttribute('alt', altText);
      wrapperP.appendChild(img);

      table.parentNode?.replaceChild(wrapperP, table);
      diagnostics.push({
        code: 'structure/x-article-table-rasterized',
        message: 'Rasterized <table> into an atomic image block for X Articles delivery (#1.3).',
        severity: 'info',
        targetId: 'x-article',
        nodeId: nodeId || undefined,
      });
    }
  }

  // 4. #2.1 Math formulas: rasterize un-replaced .morph-math / <math> / .katex into <img data-morph-rasterized="true">
  if (rasterizeMath) {
    const mathContainers = new Set<Element>();
    rootContainer.querySelectorAll('.morph-math, math, .katex').forEach((node) => {
      const outer = node.closest('.morph-math') || node.closest('.katex') || node;
      mathContainers.add(outer);
    });

    for (const mathEl of mathContainers) {
      if (!rootContainer.contains(mathEl)) continue;
      // Skip if already replaced by an AssetStore delivery <img> without raw <math>/.katex children
      const hasRawMathDom =
        mathEl.tagName.toLowerCase() === 'math' ||
        mathEl.classList.contains('katex') ||
        Boolean(mathEl.querySelector('math, .katex, .katex-mathml, .katex-html'));
      if (!hasRawMathDom) {
        const existingImg = mathEl.querySelector('img');
        if (existingImg) {
          existingImg.setAttribute('data-morph-rasterized', 'true');
        }
        continue;
      }

      const nodeId = mathEl.getAttribute('data-node-id') || undefined;
      const tex =
        mathEl.getAttribute('data-math-tex') ||
        mathEl.querySelector('annotation')?.textContent ||
        (mathEl.textContent || '').trim();
      const isDisplay =
        mathEl.classList.contains('morph-math-display') ||
        mathEl.tagName.toLowerCase() === 'div' ||
        Boolean(mathEl.querySelector('.katex-display'));

      const dataUrl = createTextCardSvgDataUrl([tex], isDisplay ? 600 : Math.max(120, tex.length * 12 + 32));
      const img = doc.createElement('img');
      img.className = 'morph-img morph-raster-img';
      img.setAttribute('data-morph-rasterized', 'true');
      img.setAttribute('data-raster-type', 'math');
      if (tex) img.setAttribute('data-math-tex', tex);
      img.setAttribute('alt', tex || 'math');
      img.setAttribute('src', dataUrl);
      img.setAttribute('data-morph-snapshot-src', dataUrl);

      if (mathEl.classList.contains('morph-math')) {
        mathEl.removeAttribute('style');
        mathEl.replaceChildren(img);
        if (mathEl.tagName.toLowerCase() === 'div') {
          replaceElementTag(mathEl, 'p');
        }
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
      const serialized = svg.outerHTML;
      const dataUrl = `data:image/svg+xml;utf8,${encodeURIComponent(serialized)}`;
      const alt = svg.getAttribute('aria-label') || 'SVG Graphic';
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

  // 6. #1.4 Unsupported structural tags & orphan <li>
  const unsupportedContainers = Array.from(rootContainer.querySelectorAll('section, article, aside, nav, header, footer'));
  for (const el of unsupportedContainers) {
    replaceElementTag(el, 'div');
  }

  const allLis = Array.from(rootContainer.querySelectorAll('li'));
  for (const li of allLis) {
    const parentTag = li.parentElement?.tagName.toLowerCase();
    if (parentTag !== 'ul' && parentTag !== 'ol') {
      const ul = doc.createElement('ul');
      ul.className = 'morph-list';
      li.parentNode?.insertBefore(ul, li);
      ul.appendChild(li);
    }
  }

  // 7. #3.1 Strip inline styles on native non-rasterized blocks
  const styledNodes = [rootContainer, ...Array.from(rootContainer.querySelectorAll('[style]'))];
  for (const el of styledNodes) {
    if (!el.hasAttribute('style')) continue;
    let allowed = false;
    let curr: Element | null = el;
    while (curr) {
      if (curr.getAttribute('data-morph-rasterized') === 'true') {
        allowed = true;
        break;
      }
      const tag = curr.tagName.toLowerCase();
      if (allowCodeBlockStyles && (tag === 'pre' || curr.classList?.contains('morph-code'))) {
        allowed = true;
        break;
      }
      curr = curr.parentElement;
    }
    if (!allowed) {
      el.removeAttribute('style');
    }
  }
}
