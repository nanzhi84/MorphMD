import type { DiagnosticItem } from '../snapshot/types';
import { deleteNestNode } from './verify-engine/nest';

const BLOCK_ELEMENT_SELECTOR = 'section, div, p, h1, h2, h3, h4, h5, h6, ul, ol, li, table, blockquote, pre';
const DISALLOWED_NODELEAF_CHILD_TAGS = new Set([
  'section', 'div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'blockquote', 'pre',
]);

function hasVisibleText(el: Element): boolean {
  const raw = el.textContent || '';
  return raw.replace(/[\u200B\s]/g, '').length > 0;
}

function hasDirectVisibleText(el: Element): boolean {
  for (let i = 0; i < el.childNodes.length; i++) {
    const child = el.childNodes[i];
    if (child.nodeType === 3 && (child.textContent || '').replace(/[\u200B\s]/g, '').length > 0) {
      return true;
    }
  }
  return false;
}

function isInsideSvgContext(el: Element): boolean {
  let curr: Element | null = el;
  while (curr) {
    const tag = curr.tagName.toLowerCase();
    if (tag === 'svg' || curr.getAttribute('data-mode') === 'svg') {
      return true;
    }
    curr = curr.parentElement;
  }
  return false;
}

function isInsideKatexLayout(el: Element): boolean {
  let curr: Element | null = el;
  while (curr) {
    if (curr.classList && (curr.classList.contains('katex') || curr.classList.contains('katex-html') || curr.classList.contains('katex-mathml'))) {
      return true;
    }
    curr = curr.parentElement;
  }
  return false;
}

function isOverlappingLineHeight(lhRaw: string, fontSizePx: number): boolean {
  const lh = lhRaw.trim();
  if (!lh || /^normal$/i.test(lh)) return false;
  if (/^0(?:px|em|rem|%|pt)?$/i.test(lh)) return true;

  if (/^\d*\.?\d+$/.test(lh)) {
    const mult = parseFloat(lh);
    return Number.isFinite(mult) && mult < 1;
  }
  if (/^\d*\.?\d+%$/.test(lh)) {
    const pct = parseFloat(lh);
    return Number.isFinite(pct) && pct < 100;
  }
  if (/^\d*\.?\d+em$/i.test(lh) || /^\d*\.?\d+rem$/i.test(lh)) {
    const em = parseFloat(lh);
    return Number.isFinite(em) && em < 1;
  }
  if (/^\d*\.?\d+px$/i.test(lh)) {
    const px = parseFloat(lh);
    return Number.isFinite(px) && px < fontSizePx * 0.96;
  }
  if (/^\d*\.?\d+pt$/i.test(lh)) {
    const ptPx = parseFloat(lh) * (4 / 3);
    return Number.isFinite(ptPx) && ptPx < fontSizePx * 0.96;
  }
  return false;
}

function isExcessiveHorizontalMargin(valRaw: string): boolean {
  const val = valRaw.trim();
  if (!val || /^(0|auto)$/i.test(val)) return false;
  if (/^-/.test(val)) return true;
  if (/^\d*\.?\d+px$/i.test(val)) return parseFloat(val) >= 100;
  if (/^\d*\.?\d+pt$/i.test(val)) return parseFloat(val) >= 75;
  if (/^\d*\.?\d+(?:em|rem)$/i.test(val)) return parseFloat(val) >= 6;
  if (/^\d*\.?\d+%$/i.test(val)) return parseFloat(val) >= 30;
  return false;
}

function parseColorRgb(colorStr: string): [number, number, number] | null {
  const s = colorStr.trim().toLowerCase();
  if (!s) return null;
  const hex6 = s.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (hex6) {
    return [parseInt(hex6[1], 16), parseInt(hex6[2], 16), parseInt(hex6[3], 16)];
  }
  const hex3 = s.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (hex3) {
    return [parseInt(hex3[1] + hex3[1], 16), parseInt(hex3[2] + hex3[2], 16), parseInt(hex3[3] + hex3[3], 16)];
  }
  const rgb = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
  if (rgb) {
    if (rgb[4] !== undefined && parseFloat(rgb[4]) === 0) return null;
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  }
  return null;
}

function computeContrastRatio(rgb1: [number, number, number], rgb2: [number, number, number]): number {
  const lum = ([r, g, b]: [number, number, number]) => {
    const chan = (c: number) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
  };
  const l1 = lum(rgb1);
  const l2 = lum(rgb2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function findEffectiveBgRgb(el: Element, rootContainer: Element): [number, number, number] | null {
  let curr: Element | null = el;
  while (curr) {
    const s = (curr as HTMLElement).style;
    if (s) {
      const bgColor = s.getPropertyValue('background-color') || s.getPropertyValue('background');
      const parsed = parseColorRgb(bgColor);
      if (parsed) return parsed;
    }
    if (curr === rootContainer) break;
    curr = curr.parentElement;
  }
  return null;
}

/**
 * Deduplicates redundant DOM nesting layers (>= 15 levels) according to
 * WeChat verify-article-structure-spec (#2.1 嵌套层级限制) and strips temporary
 * `data-nest-level` bookkeeping attributes.
 */
export function dedupeWeChatNesting(rootContainer: Element, diagnostics?: DiagnosticItem[]): number {
  const wrapper = rootContainer.parentElement || rootContainer;
  let removedCount = 0;

  for (let pass = 0; pass < 10; pass++) {
    const detected = deleteNestNode({ root: wrapper, isTest: true }) || [];
    if (detected.length === 0) break;
    removedCount += detected.length;
    deleteNestNode({ root: wrapper, isNeedDelete: true });
  }

  if (removedCount > 0 && diagnostics) {
    diagnostics.push({
      code: 'structure/wechat-redundant-nesting',
      message: `Simplified ${removedCount} redundant DOM nesting layer(s) exceeding WeChat 15-level limit (#2.1).`,
      severity: 'info',
      targetId: 'wechat',
    });
  }

  rootContainer.removeAttribute('data-nest-level');
  rootContainer.querySelectorAll('[data-nest-level]').forEach((el) => {
    el.removeAttribute('data-nest-level');
  });

  return removedCount;
}

/**
 * Normalizes DOM structure and inline styles for the `wechat` target so that
 * generated HTML strictly passes `wechatjs/verify-article-structure-spec`.
 */
export function normalizeWeChatStructureAndStyles(
  rootContainer: Element,
  diagnostics: DiagnosticItem[],
  allowedStyleProps?: ReadonlySet<string>
): void {
  const canSetProp = (prop: string) => !allowedStyleProps || allowedStyleProps.has(prop);

  // 1. Structure Rule #2.2: span[leaf] must not wrap block-level elements (or be left empty after HTML5 block-in-p splitting)
  rootContainer.querySelectorAll('span[leaf]').forEach((span) => {
    if (span.querySelector(BLOCK_ELEMENT_SELECTOR) || span.childNodes.length === 0) {
      span.removeAttribute('leaf');
      diagnostics.push({
        code: 'structure/wechat-span-leaf-block',
        message: 'Removed [leaf] attribute from <span> containing block-level descendants (#2.2 span[leaf]).',
        severity: 'warning',
        targetId: 'wechat',
      });
    }
  });

  // 2. Structure Rule #2.3: section[nodeleaf] must only wrap img or official components
  rootContainer.querySelectorAll('section[nodeleaf]').forEach((sec) => {
    const hasInvalidChild = Array.from(sec.children).some((child) =>
      DISALLOWED_NODELEAF_CHILD_TAGS.has(child.tagName.toLowerCase())
    );
    if (hasInvalidChild) {
      sec.removeAttribute('nodeleaf');
      diagnostics.push({
        code: 'structure/wechat-section-nodeleaf',
        message: 'Removed [nodeleaf] attribute from <section> containing block children (#2.3 section[nodeleaf]).',
        severity: 'warning',
        targetId: 'wechat',
      });
    }
  });

  // 3. Dark Mode Rule #4.5.1: data-no-dark whitelist attribute
  const allElements = [rootContainer, ...Array.from(rootContainer.querySelectorAll('*'))];
  for (const el of allElements) {
    if (el.hasAttribute('data-no-dark')) {
      el.removeAttribute('data-no-dark');
      diagnostics.push({
        code: 'structure/wechat-darkmode-whitelist',
        message: 'Removed data-no-dark attribute to avoid WeChat Dark Mode whitelist warning (#4.5.1).',
        severity: 'warning',
        targetId: 'wechat',
      });
    }
  }

  // 4. CSS & Layout Rules (#1.1 - #1.8, #4.1.1, #4.1.2)
  for (const el of allElements) {
    const htmlEl = el as HTMLElement;
    const tag = el.tagName.toLowerCase();
    const style = htmlEl.style;

    // #1.8 <pre> horizontal scroll safeguard
    if (tag === 'pre' && hasVisibleText(el) && canSetProp('overflow-x')) {
      const ox = style.getPropertyValue('overflow-x').trim().toLowerCase();
      const ws = style.getPropertyValue('white-space').trim().toLowerCase();
      if (ox !== 'auto' && ox !== 'scroll' && ws !== 'pre-wrap' && ws !== 'normal') {
        style.setProperty('overflow-x', 'auto');
      }
    }

    if (!el.getAttribute('style')) continue;

    // #1.1 img opacity: 0
    if (tag === 'img') {
      const op = style.getPropertyValue('opacity').trim();
      const rawStyle = el.getAttribute('style') || '';
      if ((op !== '' && (/^0(?:\.0+)?$/.test(op) || parseFloat(op) === 0)) || /opacity\s*:\s*0\b/i.test(rawStyle)) {
        style.removeProperty('opacity');
        diagnostics.push({
          code: 'style/wechat-img-opacity-zero',
          message: 'Removed opacity: 0 from <img> to comply with WeChat spec (#1.1 opacity).',
          severity: 'warning',
          targetId: 'wechat',
          property: 'opacity',
        });
      }
    }

    // #1.2 caret-color: transparent / rgba(0,0,0,0)
    const caret = style.getPropertyValue('caret-color').trim();
    if (caret && (/^transparent$/i.test(caret) || /rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/i.test(caret.replace(/\s+/g, '')))) {
      style.removeProperty('caret-color');
      diagnostics.push({
        code: 'style/wechat-transparent-caret',
        message: 'Removed transparent caret-color to comply with WeChat spec (#1.2 caret-color).',
        severity: 'warning',
        targetId: 'wechat',
        property: 'caret-color',
      });
    }

    // #1.6 text-align: start | end
    const textAlign = style.getPropertyValue('text-align').trim().toLowerCase();
    if (textAlign === 'start' || textAlign === 'end') {
      const normalized = textAlign === 'start' ? 'left' : 'right';
      if (canSetProp('text-align')) {
        style.setProperty('text-align', normalized);
      } else {
        style.removeProperty('text-align');
      }
      diagnostics.push({
        code: 'style/wechat-text-align-normalized',
        message: `Normalized text-align: ${textAlign} to ${normalized} for WeChat cross-device compatibility (#1.6 text-align).`,
        severity: 'warning',
        targetId: 'wechat',
        property: 'text-align',
      });
    }

    // #1.3 line-height overlap
    const lh = style.getPropertyValue('line-height').trim();
    if (lh && tag !== 'svg' && !isInsideSvgContext(el) && !isInsideKatexLayout(el) && hasVisibleText(el)) {
      const fsRaw = style.getPropertyValue('font-size').trim();
      const fontSizePx = fsRaw && fsRaw.endsWith('px') ? (parseFloat(fsRaw) || 16) : 16;
      if (isOverlappingLineHeight(lh, fontSizePx)) {
        if (el === rootContainer && canSetProp('line-height')) {
          style.setProperty('line-height', '1.75');
        } else {
          style.removeProperty('line-height');
        }
        diagnostics.push({
          code: 'style/wechat-line-height-overlap',
          message: `Removed overlapping line-height (${lh}) on text element (#1.3 line-height).`,
          severity: 'warning',
          targetId: 'wechat',
          property: 'line-height',
        });
      }
    }

    // #1.4 width & horizontal overflow on non-img/non-svg elements (unless data-ignore-width)
    const ignoresWidth = typeof el.closest === 'function'
      ? Boolean(el.closest('[data-ignore-width]'))
      : el.hasAttribute('data-ignore-width');

    if (!ignoresWidth && tag !== 'img' && tag !== 'svg' && !isInsideSvgContext(el) && !isInsideKatexLayout(el)) {
      const w = style.getPropertyValue('width').trim();
      if (w && !/^(auto|100%)$/i.test(w)) {
        style.removeProperty('width');
        diagnostics.push({
          code: 'style/wechat-fixed-width',
          message: `Removed fixed width (${w}) on <${tag}> to prevent multi-screen width/centering variance (#1.4 width).`,
          severity: 'warning',
          targetId: 'wechat',
          property: 'width',
        });
      }

      for (const mProp of ['margin-left', 'margin-right'] as const) {
        const mVal = style.getPropertyValue(mProp).trim();
        if (mVal && isExcessiveHorizontalMargin(mVal)) {
          style.removeProperty(mProp);
          diagnostics.push({
            code: 'style/wechat-overflow-margin',
            message: `Removed excessive ${mProp} (${mVal}) to prevent mobile horizontal overflow (#1.4.2 width).`,
            severity: 'warning',
            targetId: 'wechat',
            property: mProp,
          });
        }
      }
    }

    // #1.5 height: 0 and fixed height overflow on text/content containers
    const h = style.getPropertyValue('height').trim();
    if (h && !/^auto$/i.test(h) && tag !== 'img' && tag !== 'svg' && !isInsideSvgContext(el) && !isInsideKatexLayout(el)) {
      const isZeroHeight = /^0(?:px|em|rem|%|pt)?$/i.test(h);
      const overflowY = style.getPropertyValue('overflow-y').trim().toLowerCase();
      const canScrollY = overflowY === 'auto' || overflowY === 'scroll';
      if ((isZeroHeight && hasVisibleText(el)) || (!isZeroHeight && !canScrollY && (hasVisibleText(el) || el.children.length > 0))) {
        style.removeProperty('height');
        diagnostics.push({
          code: 'style/wechat-unsafe-height',
          message: `Removed fixed height (${h}) on <${tag}> to prevent text clipping/hiding on mobile (#1.5 height).`,
          severity: 'warning',
          targetId: 'wechat',
          property: 'height',
        });
      }
    }

    // #4.1.2 Dark Mode text background gradient
    const ignoreDm = (el.getAttribute('data-ignore-dm') || '').split(/\s+/);
    if (!ignoreDm.includes('text-bg-gradient') && hasVisibleText(el)) {
      const bgImg = style.getPropertyValue('background-image').trim();
      const bg = style.getPropertyValue('background').trim();
      const rawStyle = el.getAttribute('style') || '';
      if (/gradient\s*\(/i.test(bgImg) || /gradient\s*\(/i.test(bg) || /gradient\s*\(/i.test(rawStyle)) {
        style.removeProperty('background-image');
        style.removeProperty('background');
        diagnostics.push({
          code: 'style/wechat-text-gradient-bg',
          message: 'Removed gradient background on text container for WeChat Dark Mode compliance (#4.1.2).',
          severity: 'warning',
          targetId: 'wechat',
          property: 'background-image',
        });
      }
    }

    // #4.1.1 Dark Mode low contrast text vs background
    if (!ignoreDm.includes('low-contrast') && hasDirectVisibleText(el)) {
      const textRgb = parseColorRgb(style.getPropertyValue('color'));
      const bgRgb = findEffectiveBgRgb(el, rootContainer);
      if (textRgb && bgRgb && computeContrastRatio(textRgb, bgRgb) < 1.5) {
        style.removeProperty('color');
        diagnostics.push({
          code: 'style/wechat-low-contrast',
          message: 'Removed low-contrast text color (contrast < 1.5) for WeChat Dark Mode readability (#4.1.1).',
          severity: 'warning',
          targetId: 'wechat',
          property: 'color',
        });
      }
    }

    if (style.length === 0) {
      el.removeAttribute('style');
    }
  }

  // 5. Structure Rule #2.1: Redundant nesting deduplication (>= 15 levels)
  dedupeWeChatNesting(rootContainer, diagnostics);
}
