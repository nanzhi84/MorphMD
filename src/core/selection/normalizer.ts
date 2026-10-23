import type { DeliverySnapshot, DiagnosticItem } from '../snapshot/types';
import type { AssetStore } from '../assets/store';
import type { ClipboardPayload } from './types';
import { parseDocument } from '../dom/env';

function isValidRemoteHttpsUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  if (/[\s"'<>]/.test(url)) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function findMathAtom(node: Node | null): HTMLElement | null {
  let curr: Node | null = node;
  while (curr && curr.nodeType !== 1) curr = curr.parentElement;
  while (curr && curr.nodeType === 1) {
    if ((curr as HTMLElement).hasAttribute('data-math-tex')) {
      return curr as HTMLElement;
    }
    curr = curr.parentElement;
  }
  return null;
}

/**
 * Extracts plain text from DOM while preserving math TeX expressions, image alt text,
 * explicit <br> line breaks, source newlines in <pre>/<code>, and user-selected boundary whitespace.
 */
export function extractPlainTextFromDom(node: Node): string {
  const BLOCK_SEP = '\0BLOCK_SEP\0';
  let text = '';

  function walk(curr: Node) {
    if (curr.nodeType === 3) {
      text += curr.textContent || '';
      return;
    }

    if (curr.nodeType === 1) {
      const el = curr as HTMLElement;
      const tag = el.tagName.toLowerCase();

      if (tag === 'br') {
        text += '\n';
        return;
      }

      const mathTex = el.getAttribute('data-math-tex');
      if (mathTex) {
        const isDisplay = el.classList.contains('morph-math-display');
        if (isDisplay) {
          text += `\n$$\n${mathTex}\n$$\n`;
        } else {
          text += `$${mathTex}$`;
        }
        return;
      }

      if (tag === 'img') {
        const alt = el.getAttribute('alt');
        text += alt ? `[Image: ${alt}]` : '[Image]';
        return;
      }

      const isBlock = /^(div|p|h[1-6]|blockquote|li|tr|pre|table|header|footer|section)$/.test(tag);
      if (isBlock && text.length > 0 && !text.endsWith(BLOCK_SEP)) {
        text += BLOCK_SEP;
      }

      for (let child = el.firstChild; child; child = child.nextSibling) {
        walk(child);
      }

      if (isBlock && text.length > 0 && !text.endsWith(BLOCK_SEP)) {
        text += BLOCK_SEP;
      }
    }
  }

  walk(node);
  return text
    .replace(/^(?:\0BLOCK_SEP\0)+/, '')
    .replace(/(?:\0BLOCK_SEP\0)+$/, '')
    .replace(/(?:\0BLOCK_SEP\0)+/g, '\n');
}

function replaceAssetsAndFormulas(
  root: Element,
  doc: Document,
  snapshot: DeliverySnapshot,
  assetStore: AssetStore,
  unresolvedAssetIds: string[],
  diagnostics: DiagnosticItem[]
): void {
  root.querySelectorAll('img').forEach((img) => {
    const snapshotSrc = img.getAttribute('data-morph-snapshot-src');
    if (snapshotSrc && (snapshotSrc.startsWith('data:image/') || isValidRemoteHttpsUrl(snapshotSrc))) {
      img.setAttribute('src', snapshotSrc);
      return;
    }
    const currentSrc = img.getAttribute('src');
    if (currentSrc && (currentSrc.startsWith('data:image/') || isValidRemoteHttpsUrl(currentSrc))) {
      return;
    }
    const assetId = img.getAttribute('data-morph-asset-id');
    const src = img.getAttribute('src');
    const delivery = resolveAssetUrl(assetId, src, snapshot, assetStore, unresolvedAssetIds, diagnostics);
    if (delivery) {
      img.setAttribute('src', delivery);
    }
  });

  root.querySelectorAll('[data-morph-asset-id][data-math-tex]').forEach((mathEl) => {
    if (mathEl.tagName.toLowerCase() === 'img') {
      const frozen = mathEl.getAttribute('data-morph-snapshot-src') || mathEl.getAttribute('src');
      if (frozen && (frozen.startsWith('data:image/') || isValidRemoteHttpsUrl(frozen))) {
        mathEl.setAttribute('src', frozen);
        return;
      }
    }
    const existingImg = mathEl.querySelector('img[data-morph-snapshot-src]');
    if (existingImg) return;
    const assetId = mathEl.getAttribute('data-morph-asset-id');
    const tex = mathEl.getAttribute('data-math-tex') || '';
    const delivery = resolveAssetUrl(assetId, null, snapshot, assetStore, unresolvedAssetIds, diagnostics);
    if (delivery) {
      const img = doc.createElement('img');
      img.setAttribute('src', delivery);
      img.setAttribute('alt', tex);
      img.setAttribute('data-math-tex', tex);
      mathEl.replaceChildren(img);
    }
  });
}

function resolveAssetUrl(
  assetId: string | null | undefined,
  currentSrc: string | null | undefined,
  snapshot: DeliverySnapshot,
  assetStore: AssetStore,
  unresolvedAssetIds: string[],
  diagnostics: DiagnosticItem[]
): string | undefined {
  let id = assetId;

  if (!id && currentSrc?.startsWith('morph-asset://')) {
    id = currentSrc.replace('morph-asset://', '').split('?')[0].split('#')[0];
  }

  if (!id && currentSrc?.startsWith('blob:')) {
    const rec = assetStore.getByBlobUrl(currentSrc);
    if (rec) id = rec.id;
  }

  if (id) {
    const record = assetStore.get(id);
    if (record) {
      if (record.status === 'delivery-ready') {
        let deliverable: string | undefined;
        if (snapshot.targetId === 'x-article') {
          if (record.remoteUrl && isValidRemoteHttpsUrl(record.remoteUrl)) {
            deliverable = record.remoteUrl;
          } else if (record.dataUrl) {
            deliverable = record.dataUrl;
          }
        } else {
          if (record.dataUrl) {
            deliverable = record.dataUrl;
          } else if (record.remoteUrl && isValidRemoteHttpsUrl(record.remoteUrl)) {
            deliverable = record.remoteUrl;
          }
        }

        if (deliverable) return deliverable;

        unresolvedAssetIds.push(id);
        diagnostics.push({
          code: 'asset/missing-representation',
          message: `Asset "${id}" lacks deliverable URL representation.`,
          severity: 'error',
          assetId: id,
        });
        return undefined;
      }
      unresolvedAssetIds.push(id);
      diagnostics.push({
        code: 'asset/not-delivery-ready',
        message: `Asset "${id}" is not delivery ready.`,
        severity: 'warning',
        assetId: id,
      });
    } else {
      unresolvedAssetIds.push(id);
      diagnostics.push({
        code: 'asset/not-found',
        message: `Asset "${id}" was not found in AssetStore.`,
        severity: 'error',
        assetId: id,
      });
    }
  }

  return undefined;
}

export function normalizeSelectionRange(
  range: Range,
  rootContainer: HTMLElement,
  snapshot: DeliverySnapshot,
  assetStore: AssetStore
): ClipboardPayload {
  if (range.collapsed) {
    return { html: '', plainText: '', unresolvedAssetIds: [], diagnostics: [] };
  }

  if (!rootContainer.contains(range.startContainer) || !rootContainer.contains(range.endContainer)) {
    return { html: '', plainText: '', unresolvedAssetIds: [], diagnostics: [] };
  }

  const doc = rootContainer.ownerDocument;

  // 1. Calculate visible marker numbers for all <ol> <li> elements in rootContainer
  const liMarkerMap = new Map<HTMLElement, number>();
  const allOls = Array.from(rootContainer.querySelectorAll('ol'));

  allOls.forEach((ol) => {
    const hasExplicitStart = ol.hasAttribute('start');
    const isReversed = ol.hasAttribute('reversed');
    const directLis = Array.from(ol.children).filter((c) => c.tagName.toLowerCase() === 'li') as HTMLElement[];
    const baseStart = hasExplicitStart
      ? parseInt(ol.getAttribute('start')!, 10)
      : (isReversed ? directLis.length : 1);
    let currentMarker = baseStart;

    for (const li of directLis) {
      if (li.hasAttribute('value')) {
        const val = parseInt(li.getAttribute('value')!, 10);
        if (!isNaN(val)) currentMarker = val;
      }
      liMarkerMap.set(li, currentMarker);
      if (isReversed) currentMarker--;
      else currentMarker++;
    }

    let firstIntersectingLi: HTMLElement | null = null;
    for (const li of directLis) {
      let intersects = false;
      try {
        intersects = range.intersectsNode(li);
      } catch {
        intersects = true;
      }
      if (intersects) {
        firstIntersectingLi = li;
        break;
      }
    }

    if (firstIntersectingLi) {
      const marker = liMarkerMap.get(firstIntersectingLi);
      if (marker !== undefined) {
        ol.setAttribute('data-morph-start-marker', String(marker));
      }
    }
  });

  try {
    let workingRange = range;
    const startMath = findMathAtom(range.startContainer);
    const endMath = findMathAtom(range.endContainer);
    if (startMath || endMath) {
      workingRange = range.cloneRange();
      if (startMath) workingRange.setStartBefore(startMath);
      if (endMath) workingRange.setEndAfter(endMath);
    }

    const fragment = workingRange.cloneContents();
    const tempContainer = doc.createElement('div');
    tempContainer.appendChild(fragment);

    // 2. Reconstruct ancestor tree
    let common: Node | null = workingRange.commonAncestorContainer;
    if (common.nodeType === 3) {
      common = common.parentElement;
    }

    if (common && common !== rootContainer && common.nodeType === 1) {
      const ancestors: HTMLElement[] = [];
      let p: HTMLElement | null = common as HTMLElement;
      while (p && p !== rootContainer) {
        if (!p.classList.contains('morph-card-page')) {
          ancestors.push(p);
        }
        p = p.parentElement;
      }

      if (ancestors.length > 0) {
        let currentWrapper: HTMLElement | null = null;
        let innermostWrapper: HTMLElement | null = null;
        const pendingAfterPseudos: { wrapper: HTMLElement; pseudoNode: Node }[] = [];

        for (const anc of ancestors) {
          const clone = anc.cloneNode(false) as HTMLElement;

          const beforePseudo = Array.from(anc.children).find(
            (c) => c.getAttribute('data-morph-pseudo') === 'before'
          );
          const afterPseudo = Array.from(anc.children).find(
            (c) => c.getAttribute('data-morph-pseudo') === 'after'
          );

          if (beforePseudo && !tempContainer.querySelector('[data-morph-pseudo="before"]')) {
            clone.appendChild(beforePseudo.cloneNode(true));
          }

          if (afterPseudo && !tempContainer.querySelector('[data-morph-pseudo="after"]')) {
            pendingAfterPseudos.push({ wrapper: clone, pseudoNode: afterPseudo.cloneNode(true) });
          }

          if (!innermostWrapper || !currentWrapper) {
            innermostWrapper = clone;
            currentWrapper = clone;
          } else {
            clone.appendChild(currentWrapper);
            currentWrapper = clone;
          }
        }

        if (currentWrapper && innermostWrapper) {
          while (tempContainer.firstChild) {
            innermostWrapper.appendChild(tempContainer.firstChild);
          }
          for (const { wrapper, pseudoNode } of pendingAfterPseudos) {
            wrapper.appendChild(pseudoNode);
          }
          tempContainer.appendChild(currentWrapper);
        }
      }
    }

    // 3. Wrap loose <li> if not inside <ul> or <ol>
    const directLi = Array.from(tempContainer.children).filter(
      (c) => c.tagName.toLowerCase() === 'li'
    );
    if (directLi.length > 0) {
      const wrapperOl = doc.createElement('ol');
      wrapperOl.className = 'morph-list';
      for (const li of directLi) {
        wrapperOl.appendChild(li);
      }
      tempContainer.appendChild(wrapperOl);
    }

    // 4. Update <ol> start attribute for all <ol> in the resulting container
    const outputOls = tempContainer.querySelectorAll('ol');
    outputOls.forEach((ol) => {
      const markerAttr = ol.getAttribute('data-morph-start-marker');
      if (markerAttr) {
        const m = parseInt(markerAttr, 10);
        ol.setAttribute('start', String(m));
        (ol as HTMLOListElement).start = m;
        ol.removeAttribute('data-morph-start-marker');
      }
    });

    // 5. Table wrapper reconstruction
    const directTd = Array.from(tempContainer.children).filter(
      (c) => c.tagName.toLowerCase() === 'td' || c.tagName.toLowerCase() === 'th'
    );
    if (directTd.length > 0) {
      const tr = doc.createElement('tr');
      for (const td of directTd) tr.appendChild(td);
      tempContainer.appendChild(tr);
    }

    const directTr = Array.from(tempContainer.children).filter(
      (c) => c.tagName.toLowerCase() === 'tr'
    );
    if (directTr.length > 0) {
      const table = doc.createElement('table');
      table.className = 'morph-table';
      const tbody = doc.createElement('tbody');
      table.appendChild(tbody);
      for (const tr of directTr) tbody.appendChild(tr);
      tempContainer.appendChild(table);
    }

    // 6. Strip generated card chrome & unwrap pages
    tempContainer.querySelectorAll('[data-morph-generated]').forEach((el) => el.remove());
    tempContainer.querySelectorAll('.morph-card-page, section.morph-card-page').forEach((page) => {
      while (page.firstChild) page.parentElement?.insertBefore(page.firstChild, page);
      page.remove();
    });

    // 7. Asset & formula replacement
    const unresolvedAssetIds: string[] = [];
    const diagnostics: DiagnosticItem[] = [];
    replaceAssetsAndFormulas(tempContainer, doc, snapshot, assetStore, unresolvedAssetIds, diagnostics);

    // 8. Preserve rootContainer's inherited typography and layout styles
    const rootStyle = rootContainer.style;
    const inheritableProps = [
      'font-size',
      'color',
      'font-family',
      'line-height',
      'text-align',
      'letter-spacing',
      'font-weight',
      'font-style',
      'word-spacing',
      'text-indent',
      'text-transform',
    ];

    Array.from(tempContainer.children).forEach((child) => {
      if (child.nodeType === 1) {
        const el = child as HTMLElement;
        for (const prop of inheritableProps) {
          const rootVal = rootStyle.getPropertyValue(prop);
          if (rootVal && !el.style.getPropertyValue(prop)) {
            el.style.setProperty(prop, rootVal);
          }
        }
      }
    });

    const html = tempContainer.innerHTML;
    const plainText = extractPlainTextFromDom(tempContainer);

    return { html, plainText, unresolvedAssetIds, diagnostics };
  } finally {
    allOls.forEach((ol) => ol.removeAttribute('data-morph-start-marker'));
  }
}

export function serializeFullSnapshot(
  snapshot: DeliverySnapshot,
  assetStore: AssetStore
): ClipboardPayload {
  const { doc, cleanup } = parseDocument(snapshot.html);

  try {
    const container = doc.querySelector('.morph-doc') || doc.body;

    // Strip generated elements
    container.querySelectorAll('[data-morph-generated]').forEach((el) => el.remove());

    // Unwrap card pages
    container.querySelectorAll('.morph-card-page, section.morph-card-page').forEach((page) => {
      while (page.firstChild) page.parentElement?.insertBefore(page.firstChild, page);
      page.remove();
    });

    const unresolvedAssetIds: string[] = [];
    const diagnostics: DiagnosticItem[] = [...snapshot.diagnostics];
    replaceAssetsAndFormulas(container, doc, snapshot, assetStore, unresolvedAssetIds, diagnostics);

    const html = (container.classList && container.classList.contains('morph-doc'))
      ? container.outerHTML
      : container.innerHTML;

    const plainText = extractPlainTextFromDom(container);

    return { html, plainText, unresolvedAssetIds, diagnostics };
  } finally {
    cleanup();
  }
}
