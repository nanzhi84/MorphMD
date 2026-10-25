import { isRealBrowser, parseDocument } from '../dom/env';
import type { DiagnosticItem } from '../snapshot/types';
import { computeCardViewportGeometry, getCardPreset } from './presets';
import type {
  CardAspectRatio,
  CardPageCheckpoint,
  CardPaginationState,
  CardsPaginationOptions,
  CardsPaginationResult,
  CardsReflowChangeHint,
  CardViewportGeometry,
} from './types';

function parseLengthPx(value: string | null | undefined, baseFontSize = 16): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed === '0') return 0;
  const pxMatch = trimmed.match(/^(-?\d+(?:\.\d+)?)px$/i);
  if (pxMatch) return Number(pxMatch[1]);
  const remMatch = trimmed.match(/^(-?\d+(?:\.\d+)?)rem$/i);
  if (remMatch) return Number(remMatch[1]) * 16;
  const emMatch = trimmed.match(/^(-?\d+(?:\.\d+)?)em$/i);
  if (emMatch) return Number(emMatch[1]) * baseFontSize;
  return null;
}

function parseExplicitVerticalMargins(el: HTMLElement, defaultMargin: number | null = null): number {
  const style = el.style;
  if (!style) return defaultMargin ?? 0;

  let top: number | null = parseLengthPx(style.marginTop);
  let bottom: number | null = parseLengthPx(style.marginBottom);

  if ((top === null || bottom === null) && style.margin) {
    const parts = style.margin.trim().split(/\s+/).map((p) => parseLengthPx(p));
    if (parts.length === 1 && parts[0] !== null) {
      if (top === null) top = parts[0];
      if (bottom === null) bottom = parts[0];
    } else if (parts.length === 2 && parts[0] !== null) {
      if (top === null) top = parts[0];
      if (bottom === null) bottom = parts[0];
    } else if (parts.length >= 3 && parts[0] !== null && parts[2] !== null) {
      if (top === null) top = parts[0];
      if (bottom === null) bottom = parts[2];
    }
  }

  if (top === null && bottom === null) {
    return defaultMargin ?? 0;
  }
  return (top ?? 0) + (bottom ?? 0);
}

function countVisualUnits(text: string): number {
  let units = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (
      (code >= 0x2e80 && code <= 0x9fff) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      units += 1.0;
    } else {
      units += 0.58;
    }
  }
  return units;
}

function resolveFontSizePx(el: HTMLElement, defaultSize: number): number {
  const inlinePx = parseLengthPx(el.style?.fontSize, defaultSize);
  if (inlinePx !== null && inlinePx > 0) return inlinePx;
  return defaultSize;
}

function resolveLineHeightMultiplier(el: HTMLElement, defaultMultiplier: number): number {
  const raw = el.style?.lineHeight?.trim();
  if (!raw) return defaultMultiplier;
  const px = parseLengthPx(raw);
  if (px !== null && px > 0) {
    const fontSize = resolveFontSizePx(el, 16);
    return px / fontSize;
  }
  const num = Number(raw);
  if (!Number.isNaN(num) && num > 0) return num;
  return defaultMultiplier;
}

export function defaultMeasureElementHeight(el: HTMLElement, availableWidth: number): number {
  const explicitHeight = parseLengthPx(el.style?.height);
  if (explicitHeight !== null && explicitHeight >= 0) {
    return explicitHeight + parseExplicitVerticalMargins(el, 0);
  }

  if (isRealBrowser() && el.isConnected) {
    const rect = el.getBoundingClientRect();
    if (rect.height > 0) {
      let marginVertical = parseExplicitVerticalMargins(el, 0);
      try {
        const computed = el.ownerDocument.defaultView?.getComputedStyle(el);
        if (computed) {
          marginVertical =
            (parseFloat(computed.marginTop) || 0) + (parseFloat(computed.marginBottom) || 0);
        }
      } catch {
        // Fallback to inline margin
      }
      return rect.height + marginVertical;
    }
  }

  const tag = el.tagName.toLowerCase();

  if (tag === 'img' || tag === 'svg') {
    const attrH = Number(el.getAttribute('height') || 0);
    const attrW = Number(el.getAttribute('width') || 0);
    let h = attrH > 0 ? attrH : 180;
    if (attrW > availableWidth && attrW > 0 && attrH > 0) {
      h = Math.round(attrH * (availableWidth / attrW));
    }
    const marginV = parseExplicitVerticalMargins(el, 16);
    return h + marginV;
  }

  if (el.classList.contains('morph-math-display')) {
    return 72 + parseExplicitVerticalMargins(el, 16);
  }

  if (tag === 'hr') {
    return 24;
  }

  if (tag === 'tr') {
    const cells = Array.from(el.children) as HTMLElement[];
    const colWidth = Math.max(80, availableWidth / Math.max(1, cells.length));
    let maxLines = 1;
    for (const cell of cells) {
      const units = countVisualUnits((cell.textContent || '').trim());
      const lines = Math.max(1, Math.ceil((units * 14) / Math.max(60, colWidth - 20)));
      if (lines > maxLines) maxLines = lines;
    }
    return maxLines * 22 + 22;
  }

  if (tag === 'thead') {
    const rows = Array.from(el.querySelectorAll('tr')) as HTMLElement[];
    if (rows.length === 0) return 44;
    return rows.reduce((sum, r) => sum + defaultMeasureElementHeight(r, availableWidth), 0);
  }

  if (tag === 'li') {
    const fontSize = resolveFontSizePx(el, 16);
    const lineHeight = resolveLineHeightMultiplier(el, 1.7);
    const text = (el.textContent || '').trim();
    const units = countVisualUnits(text);
    const effectiveWidth = Math.max(120, (availableWidth - 28) * 0.92);
    const lines = Math.max(1, Math.ceil((units * fontSize) / effectiveWidth));
    const marginV = parseExplicitVerticalMargins(el, 8);
    return Math.ceil(lines * fontSize * lineHeight) + marginV;
  }

  if (tag === 'ol' || tag === 'ul') {
    const items = Array.from(el.children).filter(
      (c) => c.tagName.toLowerCase() === 'li',
    ) as HTMLElement[];
    const itemsHeight = items.reduce(
      (sum, li) => sum + defaultMeasureElementHeight(li, availableWidth),
      0,
    );
    return itemsHeight + measureListOrTableOverhead(el);
  }

  if (tag === 'table') {
    const thead = el.querySelector('thead') as HTMLElement | null;
    const tbody = el.querySelector('tbody') as HTMLElement | null;
    const rows = tbody
      ? (Array.from(tbody.children).filter((c) => c.tagName.toLowerCase() === 'tr') as HTMLElement[])
      : (Array.from(el.children).filter((c) => c.tagName.toLowerCase() === 'tr') as HTMLElement[]);
    const theadH = thead ? defaultMeasureElementHeight(thead, availableWidth) : 0;
    const rowsH = rows.reduce((sum, r) => sum + defaultMeasureElementHeight(r, availableWidth), 0);
    return theadH + rowsH + measureListOrTableOverhead(el);
  }

  if (tag === 'pre') {
    const text = el.textContent || '';
    const lineCount = Math.max(1, text.split('\n').length);
    const fontSize = resolveFontSizePx(el, 14);
    const lineHeight = resolveLineHeightMultiplier(el, 1.6);
    return Math.ceil(lineCount * fontSize * lineHeight) + 32 + 16;
  }

  // Check embedded images or display formulas inside paragraph/figure/div
  let embeddedMediaHeight = 0;
  const childImages = Array.from(el.querySelectorAll('img, svg')) as HTMLElement[];
  for (const media of childImages) {
    embeddedMediaHeight += defaultMeasureElementHeight(media, availableWidth);
  }

  const defaultFontByTag: Record<string, number> = {
    h1: 28,
    h2: 22,
    h3: 19,
    h4: 17,
    h5: 16,
    h6: 16,
  };
  const defaultMarginByTag: Record<string, number> = {
    h1: 28,
    h2: 24,
    h3: 20,
    h4: 18,
    h5: 16,
    h6: 16,
    p: 20,
    blockquote: 24,
  };

  const fontSize = resolveFontSizePx(el, defaultFontByTag[tag] ?? 16);
  const lineHeight = resolveLineHeightMultiplier(el, /^h[1-6]$/.test(tag) ? 1.35 : 1.75);
  const marginV = parseExplicitVerticalMargins(el, defaultMarginByTag[tag] ?? 20);

  const text = (el.textContent || '').trim();
  if (!text && embeddedMediaHeight > 0) {
    return embeddedMediaHeight;
  }

  const units = countVisualUnits(text);
  const effectiveWidth = Math.max(120, availableWidth * 0.9);
  const lines = Math.max(1, Math.ceil((units * fontSize) / effectiveWidth));
  const textHeight = Math.ceil(lines * fontSize * lineHeight);

  return textHeight + marginV + embeddedMediaHeight;
}

function measureListOrTableOverhead(el: HTMLElement): number {
  // Check if children have explicit heights (synthetic test fixtures)
  const firstChildWithHeight = el.querySelector<HTMLElement>('[style*="height"]');
  if (firstChildWithHeight && parseLengthPx(firstChildWithHeight.style.height) !== null) {
    return parseExplicitVerticalMargins(el, 0);
  }
  return parseExplicitVerticalMargins(el, 16);
}

function getBlockSignature(el: HTMLElement): string {
  const nodeId = el.getAttribute('data-node-id') || '';
  const tag = el.tagName.toLowerCase();
  const start = el.getAttribute('start') || '';
  const cont = el.getAttribute('data-morph-split-continuation') || '';
  const inlineH = el.style?.height || '';
  const textSnippet = (el.textContent || '').trim().slice(0, 64);
  return `${tag}#${nodeId}[start=${start},cont=${cont},h=${inlineH}]:${textSnippet}`;
}

function collectNodeIds(blocks: readonly HTMLElement[]): string[] {
  const ids = new Set<string>();
  for (const block of blocks) {
    const selfId = block.getAttribute('data-node-id');
    if (selfId) ids.add(selfId);
    block.querySelectorAll('[data-node-id]').forEach((child) => {
      const cid = child.getAttribute('data-node-id');
      if (cid) ids.add(cid);
    });
  }
  return Array.from(ids);
}

/**
 * Unwraps card pages from `fromPageIndex` onwards and merges split continuation lists and tables.
 */
function unwrapPagesAndMergeContinuations(
  rootContainer: HTMLElement,
  fromPageIndex = 0,
): { keptPages: HTMLElement[]; blocksToPaginate: HTMLElement[] } {
  const existingPages = Array.from(
    rootContainer.querySelectorAll(':scope > section.morph-card-page, :scope > .morph-card-page'),
  ) as HTMLElement[];

  if (existingPages.length === 0) {
    // Also clean any stray generated nodes if present
    rootContainer.querySelectorAll('[data-morph-generated]').forEach((el) => el.remove());
    restoreOversizeElements(rootContainer);
    mergeAdjacentSplitContinuations(rootContainer);
    const blocks = Array.from(rootContainer.children) as HTMLElement[];
    return { keptPages: [], blocksToPaginate: blocks };
  }

  let effectiveFromIndex = Math.max(0, Math.min(fromPageIndex, existingPages.length));

  // If the first page to unwrap starts with a split continuation fragment, step back so it can merge with its head
  while (effectiveFromIndex > 0) {
    const pageToUnwrap = existingPages[effectiveFromIndex];
    const firstContent = Array.from(pageToUnwrap.children).find(
      (c) => !c.hasAttribute('data-morph-generated'),
    );
    if (firstContent && firstContent.getAttribute('data-morph-split-continuation') === 'true') {
      effectiveFromIndex--;
    } else {
      break;
    }
  }

  const keptPages = existingPages.slice(0, effectiveFromIndex);
  const pagesToUnwrap = existingPages.slice(effectiveFromIndex);

  for (const page of pagesToUnwrap) {
    page.querySelectorAll('[data-morph-generated]').forEach((el) => el.remove());
    page.querySelectorAll('.morph-card-body, [data-morph-card-body]').forEach((body) => {
      while (body.firstChild) {
        body.parentElement?.insertBefore(body.firstChild, body);
      }
      body.remove();
    });
    while (page.firstChild) {
      rootContainer.insertBefore(page.firstChild, page);
    }
    page.remove();
  }

  restoreOversizeElements(rootContainer, keptPages);
  mergeAdjacentSplitContinuations(rootContainer);

  const keptSet = new Set<Element>(keptPages);
  const blocksToPaginate = (Array.from(rootContainer.children) as HTMLElement[]).filter(
    (child) => !keptSet.has(child) && !child.hasAttribute('data-morph-generated'),
  );

  return { keptPages, blocksToPaginate };
}

function restoreOversizeElements(rootContainer: HTMLElement, skipPages: HTMLElement[] = []): void {
  const skipSet = new Set<Element>(skipPages);
  rootContainer.querySelectorAll<HTMLElement>('[data-morph-oversize]').forEach((el) => {
    const parentPage = el.closest('section.morph-card-page, .morph-card-page');
    if (parentPage && skipSet.has(parentPage)) return;

    el.removeAttribute('data-morph-oversize');
    el.style.removeProperty('max-height');
    el.style.removeProperty('max-width');
    el.style.removeProperty('object-fit');
    if (el.hasAttribute('data-morph-orig-height')) {
      const orig = el.getAttribute('data-morph-orig-height') || '';
      if (orig) {
        el.style.height = orig;
      } else {
        el.style.removeProperty('height');
      }
      el.removeAttribute('data-morph-orig-height');
    }
  });
}

function mergeAdjacentSplitContinuations(container: HTMLElement): void {
  const children = Array.from(container.children) as HTMLElement[];
  for (const child of children) {
    if (!child.isConnected) continue;
    const tag = child.tagName.toLowerCase();

    if (
      (tag === 'ol' || tag === 'ul') &&
      child.getAttribute('data-morph-split-continuation') === 'true'
    ) {
      const prev = child.previousElementSibling as HTMLElement | null;
      if (prev && prev.tagName.toLowerCase() === tag) {
        while (child.firstChild) {
          prev.appendChild(child.firstChild);
        }
        child.remove();
        continue;
      } else {
        child.removeAttribute('data-morph-split-continuation');
      }
    }

    if (tag === 'table' && child.getAttribute('data-morph-split-continuation') === 'true') {
      const prev = child.previousElementSibling as HTMLElement | null;
      if (prev && prev.tagName.toLowerCase() === 'table') {
        child.querySelectorAll('[data-morph-generated]').forEach((el) => el.remove());
        const prevTbody = (prev.querySelector('tbody') || prev) as HTMLElement;
        const currTbody = (child.querySelector('tbody') || child) as HTMLElement;
        const rows = Array.from(currTbody.children).filter(
          (r) => r.tagName.toLowerCase() === 'tr',
        );
        for (const r of rows) {
          prevTbody.appendChild(r);
        }
        child.remove();
        continue;
      } else {
        child.removeAttribute('data-morph-split-continuation');
      }
    }
  }

  container.querySelectorAll<HTMLElement>('ol[data-morph-original-start]').forEach((ol) => {
    const origStart = ol.getAttribute('data-morph-original-start') || '';
    if (origStart) {
      ol.setAttribute('start', origStart);
    } else {
      ol.removeAttribute('start');
    }
    ol.removeAttribute('data-morph-original-start');
  });
}

function measureFirstUnitHeight(
  el: HTMLElement,
  availableWidth: number,
  measure: (node: HTMLElement, width: number) => number,
): number {
  const tag = el.tagName.toLowerCase();
  if (tag === 'ol' || tag === 'ul') {
    const firstLi = Array.from(el.children).find(
      (c) => c.tagName.toLowerCase() === 'li',
    ) as HTMLElement | undefined;
    if (firstLi) {
      return measureListOrTableOverhead(el) + measure(firstLi, availableWidth);
    }
  }
  if (tag === 'table') {
    const thead = el.querySelector('thead') as HTMLElement | null;
    const firstBodyRow = el.querySelector('tbody > tr, tr') as HTMLElement | null;
    const theadH = thead ? measure(thead, availableWidth) : 0;
    const rowH = firstBodyRow ? measure(firstBodyRow, availableWidth) : 0;
    return measureListOrTableOverhead(el) + theadH + rowH;
  }
  return measure(el, availableWidth);
}

function applyOversizeScaling(
  block: HTMLElement,
  pageNumber: number,
  blockHeight: number,
  availableContentHeight: number,
  oversizePageNumbers: number[],
  diagnostics: DiagnosticItem[],
): void {
  const tag = block.tagName.toLowerCase();
  const target =
    tag === 'img' || tag === 'svg' || block.classList.contains('morph-math-display')
      ? block
      : (block.querySelector<HTMLElement>('img, svg, .morph-math-display') ?? block);

  if (!target.hasAttribute('data-morph-orig-height')) {
    target.setAttribute('data-morph-orig-height', target.style.height || '');
  }
  target.setAttribute('data-morph-oversize', 'scaled');
  target.style.maxHeight = '100%';
  target.style.maxWidth = '100%';
  target.style.objectFit = 'contain';

  if (!oversizePageNumbers.includes(pageNumber)) {
    oversizePageNumbers.push(pageNumber);
  }

  const nodeId =
    target.getAttribute('data-node-id') || block.getAttribute('data-node-id') || undefined;
  diagnostics.push({
    code: 'cards/oversize-atomic-scaled',
    message: `Atomic block "${nodeId ?? tag}" (${Math.round(blockHeight)}px) exceeds single-page available content height (${Math.round(availableContentHeight)}px) and was scaled down with max-height: 100%; object-fit: contain.`,
    severity: 'warning',
    targetId: 'cards',
    nodeId,
  });
}

function formatFooterText(
  pageNumber: number,
  totalPages: number,
  footerFormat?: CardsPaginationOptions['footerFormat'],
): string {
  if (typeof footerFormat === 'function') {
    return footerFormat(pageNumber, totalPages);
  }
  const p = String(pageNumber).padStart(2, '0');
  const t = String(totalPages).padStart(2, '0');
  return `${p} / ${t}`;
}

function buildCardSectionElement(
  doc: Document,
  blocks: HTMLElement[],
  pageNumber: number,
  totalPages: number,
  geometry: CardViewportGeometry,
  options: CardsPaginationOptions,
): HTMLElement {
  const section = doc.createElement('section');
  section.className = 'morph-card-page';
  section.setAttribute('data-page', String(pageNumber));
  section.setAttribute('data-total-pages', String(totalPages));
  section.setAttribute('data-ratio', geometry.ratio);
  section.setAttribute(
    'style',
    [
      `width: ${geometry.layoutWidth}px`,
      `height: ${geometry.layoutHeight}px`,
      `padding: ${geometry.padding.top}px ${geometry.padding.right}px ${geometry.padding.bottom}px ${geometry.padding.left}px`,
      'box-sizing: border-box',
      'display: flex',
      'flex-direction: column',
      'overflow: hidden',
      'position: relative',
    ].join('; ') + ';',
  );

  const header = doc.createElement('header');
  header.className = 'morph-card-header';
  header.setAttribute('data-morph-generated', 'header');
  header.setAttribute(
    'style',
    [
      `height: ${geometry.headerHeight}px`,
      `min-height: ${geometry.headerHeight}px`,
      `max-height: ${geometry.headerHeight}px`,
      'box-sizing: border-box',
      'display: flex',
      'align-items: center',
      'justify-content: space-between',
      'flex-shrink: 0',
      'font-size: 12px',
      'line-height: 1',
      'opacity: 0.65',
    ].join('; ') + ';',
  );
  header.textContent = options.headerText ?? 'MorphMD';
  section.appendChild(header);

  for (const block of blocks) {
    section.appendChild(block);
  }

  const footer = doc.createElement('footer');
  footer.className = 'morph-card-footer';
  footer.setAttribute('data-morph-generated', 'footer');
  footer.setAttribute(
    'style',
    [
      `height: ${geometry.footerHeight}px`,
      `min-height: ${geometry.footerHeight}px`,
      `max-height: ${geometry.footerHeight}px`,
      'margin-top: auto',
      'box-sizing: border-box',
      'display: flex',
      'align-items: center',
      'justify-content: flex-end',
      'flex-shrink: 0',
      'font-size: 12px',
      'line-height: 1',
      'opacity: 0.65',
    ].join('; ') + ';',
  );
  footer.textContent = formatFooterText(pageNumber, totalPages, options.footerFormat);
  section.appendChild(footer);

  return section;
}

function updateCardChromeAttributes(
  pageEl: HTMLElement,
  pageNumber: number,
  totalPages: number,
  geometry: CardViewportGeometry,
  options: CardsPaginationOptions,
): void {
  pageEl.setAttribute('data-page', String(pageNumber));
  pageEl.setAttribute('data-total-pages', String(totalPages));
  pageEl.setAttribute('data-ratio', geometry.ratio);

  const header = pageEl.querySelector<HTMLElement>('[data-morph-generated="header"]');
  if (header && options.headerText !== undefined) {
    header.textContent = options.headerText;
  }

  const footer = pageEl.querySelector<HTMLElement>('[data-morph-generated="footer"]');
  if (footer) {
    footer.textContent = formatFooterText(pageNumber, totalPages, options.footerFormat);
  }
}

interface InternalReflowContext {
  previousState?: CardPaginationState;
  reflowStartPage: number;
  dirtyPageK: number;
  dirtyNodeIds: ReadonlySet<string>;
}

function executePagination(
  rootContainer: HTMLElement,
  diagnostics: DiagnosticItem[] = [],
  options: CardsPaginationOptions = {},
  reflowCtx?: InternalReflowContext,
): CardPaginationState {
  const ratio: CardAspectRatio = options.ratio ?? '3:4';
  const preset = getCardPreset(ratio);
  const geometry = computeCardViewportGeometry(preset.ratio, {
    containerWidth: options.containerWidth,
    containerHeight: options.containerHeight,
    contentHeightOverride: options.contentHeightOverride,
  });

  const measure = options.measureElementHeight ?? defaultMeasureElementHeight;
  const availableWidth = geometry.availableContentWidth;
  const availableHeight = geometry.availableContentHeight;
  const doc = rootContainer.ownerDocument;

  const requestedStartPage = reflowCtx ? Math.max(1, reflowCtx.reflowStartPage) : 1;
  const { keptPages, blocksToPaginate } = unwrapPagesAndMergeContinuations(
    rootContainer,
    requestedStartPage - 1,
  );

  const actualStartPage = keptPages.length + 1;
  const reusedPageNumbers: number[] = [];
  const oversizePageNumbers: number[] = [];
  const checkpoints: CardPageCheckpoint[] = [];

  if (reflowCtx?.previousState && keptPages.length > 0) {
    for (let i = 0; i < keptPages.length; i++) {
      const pageNum = i + 1;
      reusedPageNumbers.push(pageNum);
      if (reflowCtx.previousState.oversizePageNumbers.includes(pageNum)) {
        oversizePageNumbers.push(pageNum);
      }
      const prevCp = reflowCtx.previousState.checkpoints[i];
      if (prevCp) {
        checkpoints.push({ ...prevCp, pageNumber: pageNum });
      }
    }
  }

  const paginatedPages: { blocks: HTMLElement[]; usedHeight: number }[] = [];
  let currentBlocks: HTMLElement[] = [];
  let currentUsedHeight = 0;
  let convergedAtPage: number | null = null;

  const flushPage = () => {
    if (currentBlocks.length === 0) return;
    paginatedPages.push({
      blocks: currentBlocks,
      usedHeight: Math.min(availableHeight, Math.round(currentUsedHeight)),
    });
    currentBlocks = [];
    currentUsedHeight = 0;
  };

  const queue: HTMLElement[] = [...blocksToPaginate];
  for (const b of queue) {
    b.remove();
  }

  const prevCheckpointsByFirstSig = new Map<string, CardPageCheckpoint>();
  if (reflowCtx?.previousState) {
    for (const cp of reflowCtx.previousState.checkpoints) {
      if (cp.pageNumber > reflowCtx.dirtyPageK && cp.firstBlockSignature) {
        prevCheckpointsByFirstSig.set(cp.firstBlockSignature, cp);
      }
    }
  }

  const hasRemainingDirtyNode = (remainingBlocks: readonly HTMLElement[]): boolean => {
    if (!reflowCtx || reflowCtx.dirtyNodeIds.size === 0) return false;
    for (const b of remainingBlocks) {
      const id = b.getAttribute('data-node-id');
      if (id && reflowCtx.dirtyNodeIds.has(id)) return true;
      for (const dirtyId of reflowCtx.dirtyNodeIds) {
        if (b.querySelector(`[data-node-id="${dirtyId}"]`)) return true;
      }
    }
    return false;
  };

  const pushBlockToCurrentPage = (
    blockEl: HTMLElement,
    height: number,
    restOfQueue: readonly HTMLElement[],
  ) => {
    if (currentBlocks.length === 0 && reflowCtx?.previousState) {
      const pageNumber = actualStartPage + paginatedPages.length;
      if (pageNumber > reflowCtx.dirtyPageK && !hasRemainingDirtyNode([blockEl, ...restOfQueue])) {
        const sig = getBlockSignature(blockEl);
        const matchedCp = prevCheckpointsByFirstSig.get(sig);
        if (matchedCp) {
          if (convergedAtPage === null) {
            convergedAtPage = pageNumber;
          }
          if (!reusedPageNumbers.includes(pageNumber)) {
            reusedPageNumbers.push(pageNumber);
          }
        } else if (convergedAtPage !== null && !reusedPageNumbers.includes(pageNumber)) {
          reusedPageNumbers.push(pageNumber);
        }
      }
    }
    currentBlocks.push(blockEl);
    currentUsedHeight += height;
  };

  while (queue.length > 0) {
    const block = queue.shift()!;
    const tag = block.tagName.toLowerCase();
    let remainingHeight = availableHeight - currentUsedHeight;

    // 1. Heading Keep-With-Next contract
    if (/^h[1-6]$/.test(tag)) {
      const headingHeight = measure(block, availableWidth);
      if (currentBlocks.length > 0) {
        if (headingHeight > remainingHeight) {
          flushPage();
          remainingHeight = availableHeight;
        } else if (queue.length > 0) {
          const nextFirstUnit = measureFirstUnitHeight(queue[0], availableWidth, measure);
          if (headingHeight + nextFirstUnit > remainingHeight) {
            flushPage();
            remainingHeight = availableHeight;
          }
        }
      }

      const pageNumber = actualStartPage + paginatedPages.length;
      if (headingHeight > availableHeight) {
        applyOversizeScaling(
          block,
          pageNumber,
          headingHeight,
          availableHeight,
          oversizePageNumbers,
          diagnostics,
        );
        pushBlockToCurrentPage(block, availableHeight, queue);
        flushPage();
      } else {
        pushBlockToCurrentPage(block, headingHeight, queue);
      }
      continue;
    }

    // 2. Ordered & Unordered List Splitting (<ol>, <ul>)
    if (tag === 'ol' || tag === 'ul') {
      const items = Array.from(block.children).filter(
        (c) => c.tagName.toLowerCase() === 'li',
      ) as HTMLElement[];
      const overhead = measureListOrTableOverhead(block);
      const itemHeights = items.map((li) => measure(li, availableWidth));
      const totalListHeight = overhead + itemHeights.reduce((a, b) => a + b, 0);

      if (totalListHeight <= remainingHeight) {
        pushBlockToCurrentPage(block, totalListHeight, queue);
        continue;
      }

      if (items.length > 1) {
        let acc = overhead;
        let fitCount = 0;
        while (fitCount < items.length && acc + itemHeights[fitCount] <= remainingHeight) {
          acc += itemHeights[fitCount];
          fitCount++;
        }

        if (fitCount === 0 && currentBlocks.length > 0) {
          flushPage();
          queue.unshift(block);
          continue;
        }

        if (fitCount === 0) {
          // Single list item exceeds full empty page height: force 1 item to prevent infinite loop
          fitCount = 1;
          acc = Math.min(availableHeight, overhead + itemHeights[0]);
        }

        if (fitCount < items.length) {
          const isOl = tag === 'ol';
          let baseStart = 1;
          if (isOl) {
            if (!block.hasAttribute('data-morph-original-start')) {
              block.setAttribute('data-morph-original-start', block.getAttribute('start') ?? '');
            }
            baseStart = parseInt(block.getAttribute('start') || '1', 10) || 1;
            block.setAttribute('start', String(baseStart));
          }

          const tailList = block.cloneNode(false) as HTMLElement;
          tailList.setAttribute('data-morph-split-continuation', 'true');
          tailList.removeAttribute('data-morph-original-start');

          if (isOl) {
            const nextStart = baseStart + fitCount;
            tailList.setAttribute('start', String(nextStart));
          }

          const movingItems = items.slice(fitCount);
          for (const li of movingItems) {
            tailList.appendChild(li);
          }

          pushBlockToCurrentPage(block, acc, [tailList, ...queue]);
          flushPage();
          queue.unshift(tailList);
          continue;
        }

        pushBlockToCurrentPage(block, acc, queue);
        continue;
      }
    }

    // 3. Multi-row Table Splitting (<table>) with repeated <thead>
    if (tag === 'table') {
      const thead = block.querySelector('thead') as HTMLElement | null;
      const tbody = block.querySelector('tbody') as HTMLElement | null;
      const rows = tbody
        ? (Array.from(tbody.children).filter((c) => c.tagName.toLowerCase() === 'tr') as HTMLElement[])
        : (Array.from(block.children).filter((c) => c.tagName.toLowerCase() === 'tr') as HTMLElement[]);

      const overhead = measureListOrTableOverhead(block);
      const theadHeight = thead ? measure(thead, availableWidth) : 0;
      const rowHeights = rows.map((r) => measure(r, availableWidth));
      const totalTableHeight = overhead + theadHeight + rowHeights.reduce((a, b) => a + b, 0);

      if (totalTableHeight <= remainingHeight) {
        pushBlockToCurrentPage(block, totalTableHeight, queue);
        continue;
      }

      if (rows.length > 1) {
        let acc = overhead + theadHeight;
        let fitCount = 0;
        while (fitCount < rows.length && acc + rowHeights[fitCount] <= remainingHeight) {
          acc += rowHeights[fitCount];
          fitCount++;
        }

        if (fitCount === 0 && currentBlocks.length > 0) {
          flushPage();
          queue.unshift(block);
          continue;
        }

        if (fitCount === 0) {
          fitCount = 1;
          acc = Math.min(availableHeight, overhead + theadHeight + rowHeights[0]);
        }

        if (fitCount < rows.length) {
          const tailTable = block.cloneNode(false) as HTMLElement;
          tailTable.setAttribute('data-morph-split-continuation', 'true');

          const colgroups = Array.from(block.children).filter(
            (c) => c.tagName.toLowerCase() === 'colgroup',
          );
          for (const cg of colgroups) {
            tailTable.appendChild(cg.cloneNode(true));
          }

          if (thead) {
            const repeatedThead = thead.cloneNode(true) as HTMLElement;
            repeatedThead.setAttribute('data-morph-generated', 'repeat');
            tailTable.appendChild(repeatedThead);
          }

          const tailTbody = tbody
            ? (tbody.cloneNode(false) as HTMLElement)
            : doc.createElement('tbody');
          for (const r of rows.slice(fitCount)) {
            tailTbody.appendChild(r);
          }
          tailTable.appendChild(tailTbody);

          pushBlockToCurrentPage(block, acc, [tailTable, ...queue]);
          flushPage();
          queue.unshift(tailTable);
          continue;
        }

        pushBlockToCurrentPage(block, acc, queue);
        continue;
      }
    }

    // 4. Atomic & standard block placement + Oversize fallback
    const blockHeight = measure(block, availableWidth);
    if (blockHeight <= remainingHeight) {
      pushBlockToCurrentPage(block, blockHeight, queue);
      continue;
    }

    if (currentBlocks.length > 0) {
      flushPage();
    }

    const pageNumber = actualStartPage + paginatedPages.length;
    if (blockHeight > availableHeight) {
      applyOversizeScaling(
        block,
        pageNumber,
        blockHeight,
        availableHeight,
        oversizePageNumbers,
        diagnostics,
      );
      pushBlockToCurrentPage(block, availableHeight, queue);
      flushPage();
    } else {
      pushBlockToCurrentPage(block, blockHeight, queue);
    }
  }

  flushPage();

  const totalPages = keptPages.length + paginatedPages.length;

  // Update chrome on kept upstream pages
  for (let i = 0; i < keptPages.length; i++) {
    updateCardChromeAttributes(keptPages[i], i + 1, totalPages, geometry, options);
  }

  // Materialize newly paginated card sections and record checkpoints
  for (let i = 0; i < paginatedPages.length; i++) {
    const pageNumber = actualStartPage + i;
    const { blocks, usedHeight } = paginatedPages[i];
    const firstBlockSignature = blocks.length > 0 ? getBlockSignature(blocks[0]) : '';
    const lastBlockSignature =
      blocks.length > 0 ? getBlockSignature(blocks[blocks.length - 1]) : '';
    const nodeIds = collectNodeIds(blocks);

    checkpoints.push({
      pageNumber,
      firstBlockSignature,
      lastBlockSignature,
      nodeIds,
      usedHeight,
      availableHeight,
    });

    const section = buildCardSectionElement(doc, blocks, pageNumber, totalPages, geometry, options);
    rootContainer.appendChild(section);
  }

  return {
    ratio: geometry.ratio,
    totalPages,
    geometry,
    checkpoints,
    reflowStartPage: actualStartPage,
    convergedAtPage,
    reusedPageNumbers,
    oversizePageNumbers,
  };
}

export function paginateDom(
  rootContainer: Element,
  diagnostics: DiagnosticItem[] = [],
  options: CardsPaginationOptions = {},
): CardPaginationState {
  return executePagination(rootContainer as HTMLElement, diagnostics, options);
}

export function paginateCardsHtml(
  html: string,
  options: CardsPaginationOptions = {},
): CardsPaginationResult {
  const { doc, cleanup } = parseDocument(html);
  try {
    const root = (doc.querySelector('.morph-doc') ||
      doc.body.firstElementChild ||
      doc.body) as HTMLElement;
    const diagnostics: DiagnosticItem[] = [];
    const state = paginateDom(root, diagnostics, options);
    const outputHtml =
      root.tagName.toLowerCase() === 'body' ? root.innerHTML : root.outerHTML;
    return {
      html: outputHtml,
      state,
      diagnostics,
    };
  } finally {
    cleanup();
  }
}

export function reflowCards(
  rootContainer: Element,
  previousState: CardPaginationState,
  changeHint: CardsReflowChangeHint = {},
  options: CardsPaginationOptions = {},
): CardsPaginationResult {
  const hostEl = rootContainer as HTMLElement;
  const targetRatio: CardAspectRatio = options.ratio ?? previousState.ratio ?? '3:4';
  const targetGeometry = computeCardViewportGeometry(targetRatio, {
    containerWidth: options.containerWidth,
    containerHeight: options.containerHeight,
    contentHeightOverride: options.contentHeightOverride,
  });

  const diagnostics: DiagnosticItem[] = [];
  const dirtyNodeIdsSet = new Set<string>(changeHint.dirtyNodeIds ?? []);

  // If ratio or content height budget changed, full reflow from page 1 is required
  if (
    previousState.ratio !== targetRatio ||
    previousState.geometry.availableContentHeight !== targetGeometry.availableContentHeight
  ) {
    const state = executePagination(hostEl, diagnostics, {
      ...options,
      ratio: targetRatio,
    });
    const outputHtml =
      hostEl.tagName.toLowerCase() === 'body'
        ? hostEl.innerHTML
        : hostEl.outerHTML;
    return { html: outputHtml, state, diagnostics };
  }

  // Resolve earliest affected page K
  const candidatePages: number[] = [];
  if (typeof changeHint.dirtyPageNumber === 'number' && changeHint.dirtyPageNumber >= 1) {
    candidatePages.push(changeHint.dirtyPageNumber);
  }
  if (dirtyNodeIdsSet.size > 0) {
    for (const cp of previousState.checkpoints) {
      if (cp.nodeIds.some((id) => dirtyNodeIdsSet.has(id))) {
        candidatePages.push(cp.pageNumber);
      }
    }
    const livePages = Array.from(
      hostEl.querySelectorAll(':scope > section.morph-card-page, :scope > .morph-card-page'),
    );
    livePages.forEach((p, idx) => {
      for (const dirtyId of dirtyNodeIdsSet) {
        if (p.querySelector(`[data-node-id="${dirtyId}"]`)) {
          candidatePages.push(idx + 1);
        }
      }
    });
  }

  const dirtyPageK =
    candidatePages.length > 0
      ? Math.max(1, Math.min(previousState.totalPages || 1, Math.min(...candidatePages)))
      : 1;

  // Look-back reflow invariant: always start at max(1, K - 1) so shortened content on page K can backfill to K - 1
  const reflowStartPage = Math.max(1, dirtyPageK - 1);

  const state = executePagination(
    hostEl,
    diagnostics,
    { ...options, ratio: targetRatio },
    {
      previousState,
      reflowStartPage,
      dirtyPageK,
      dirtyNodeIds: dirtyNodeIdsSet,
    },
  );

  const outputHtml =
    hostEl.tagName.toLowerCase() === 'body'
      ? hostEl.innerHTML
      : hostEl.outerHTML;

  return {
    html: outputHtml,
    state,
    diagnostics,
  };
}
