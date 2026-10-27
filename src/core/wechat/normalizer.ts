import './mathjax-env';
import { HTMLHandler } from 'mathjax-full/js/handlers/html/HTMLHandler.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { SVG } from 'mathjax-full/js/output/svg.js';
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js';
import { AllPackages } from 'mathjax-full/js/input/tex/AllPackages.js';
import type { DiagnosticItem } from '../snapshot/types';

let mjAdaptor: any = null;
let mjDocument: any = null;
const wechatMathSvgCache = new Map<string, string>();
const MAX_WECHAT_MATH_SVG_CACHE = 512;

function getMathJaxDocument(): { adaptor: any; doc: any } {
  if (!mjDocument || !mjAdaptor) {
    mjAdaptor = liteAdaptor();
    const handler = new HTMLHandler(mjAdaptor);
    const texInput = new TeX({ packages: AllPackages });
    const svgOutput = new SVG({ fontCache: 'none' });
    mjDocument = handler.create('', { InputJax: texInput, OutputJax: svgOutput });
  }
  return { adaptor: mjAdaptor, doc: mjDocument };
}

function flattenLiteSvgNode(node: any): void {
  if (!node || typeof node !== 'object' || !Array.isArray(node.children)) return;
  for (let i = 0; i < node.children.length; i++) {
    flattenLiteSvgNode(node.children[i]);
  }
  const newChildren: any[] = [];
  for (const child of node.children) {
    if (child && child.kind === 'g') {
      const attrs = child.attributes || {};
      delete attrs['data-mml-node'];
      delete attrs['data-mjx-texclass'];
      delete attrs['data-c'];
      const keys = Object.keys(attrs);
      if (keys.length === 0 && Array.isArray(child.children)) {
        newChildren.push(...child.children);
        continue;
      }
    } else if (child && child.attributes) {
      delete child.attributes['data-mml-node'];
      delete child.attributes['data-mjx-texclass'];
      delete child.attributes['data-c'];
    }
    newChildren.push(child);
  }
  node.children = newChildren;
}

function renderTexToWeChatSvg(rawTex: string, displayMode: boolean): string | null {
  const tex = rawTex.trim();
  if (!tex) return null;
  const cacheKey = `${displayMode ? '1' : '0'}:${tex}`;
  const cached = wechatMathSvgCache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const { adaptor, doc } = getMathJaxDocument();
    const container = doc.convert(tex, { display: displayMode });
    flattenLiteSvgNode(container);
    const svgNode = container?.children?.[0];
    if (!svgNode || svgNode.kind !== 'svg') return null;

    const attrs = svgNode.attributes || (svgNode.attributes = {});
    const w = attrs.width || '';
    const h = attrs.height || '';
    const existingStyle = attrs.style || '';
    delete attrs.role;
    delete attrs.focusable;
    const blockCenterStyle = displayMode
      ? ' display: block; margin-top: 0px; margin-bottom: 0px; margin-left: auto; margin-right: auto;'
      : '';
    attrs.style = `${existingStyle}${blockCenterStyle}${w ? ` width: ${w};` : ''}${h ? ` height: ${h};` : ''} max-width: 100%;`.trim();

    const firstG = Array.isArray(svgNode.children)
      ? svgNode.children.find((c: any) => c && c.kind === 'g')
      : null;
    if (firstG) {
      const gAttrs = firstG.attributes || (firstG.attributes = {});
      gAttrs.fill = 'currentColor';
      gAttrs.stroke = 'currentColor';
    }

    const svgHtml = adaptor.innerHTML(container);
    if (wechatMathSvgCache.size >= MAX_WECHAT_MATH_SVG_CACHE) {
      const oldestKey = wechatMathSvgCache.keys().next().value;
      if (oldestKey !== undefined) wechatMathSvgCache.delete(oldestKey);
    }
    wechatMathSvgCache.set(cacheKey, svgHtml);
    return svgHtml;
  } catch {
    return null;
  }
}

const BLOCK_ELEMENT_SELECTOR = 'section, div, p, h1, h2, h3, h4, h5, h6, ul, ol, li, table, blockquote, pre';
const DISALLOWED_NODELEAF_CHILD_TAGS = new Set([
  'section', 'div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'blockquote', 'pre',
]);
const SPECIAL_NEST_TAGS = /iframe|video|audio|cps|mp|img|animateTransform|hr|path|br|svg|^g$|^a$/i;

function getElementChildren(node: any): any[] {
  if (!node || !node.children) return [];
  const children = node.children;
  if (typeof children.item === 'function') return children;
  return children.filter((c: any) => !!c.tagName);
}

function hasOtherSignificantContent(node: any, excludeChild: any): boolean {
  if (!node) return false;
  if (node.childNodes && typeof node.childNodes.item === 'function') {
    for (let i = 0; i < node.childNodes.length; i++) {
      const child = node.childNodes[i];
      if (child === excludeChild) continue;
      if (child.nodeType === 3 && child.textContent && child.textContent.trim()) return true;
      if (child.nodeType === 1) return true;
    }
    return false;
  }
  if (node.children && Array.isArray(node.children)) {
    for (let j = 0; j < node.children.length; j++) {
      const c = node.children[j];
      if (c === excludeChild) continue;
      if (!c.tagName && c.data && c.data.trim()) return true;
      if (c.tagName) return true;
    }
    return false;
  }
  return false;
}

function deleteNestNode({ root, isNeedDelete = false, isTest = false }: { root: any; isNeedDelete?: boolean; isTest?: boolean }): any[] | undefined {
  const MAX_STYLE_LEVEL = 15;
  const hasNestedNode: any[] = [];
  const willBeDeletedNodes: any[] = [];
  const willBeDeletedSet = new Set<any>();
  const pushWillBeDeleted = (node: any): boolean => {
    if (!node || willBeDeletedSet.has(node)) return false;
    willBeDeletedSet.add(node);
    willBeDeletedNodes.push(node);
    return true;
  };

  const getTag = (node: any): string => ((node && node.tagName) || '').toLowerCase();
  const getStyle = (node: any): string => {
    if (!node) return '';
    if (node.attrs && typeof node.attrs.style === 'string') return node.attrs.style;
    if (typeof node.getAttribute === 'function') return node.getAttribute('style') || '';
    return '';
  };

  const clearTempMarkers = (node: any) => {
    if (!node) return;
    delete node.isNeedEmpty;
    const children = getElementChildren(node);
    for (let i = 0; i < children.length; i++) clearTempMarkers(children[i]);
  };

  const depth1 = (node: any, currentLevel: number) => {
    if (node === null) return;
    if (node.children) {
      if (currentLevel >= MAX_STYLE_LEVEL) {
        hasNestedNode.push(node);
        return;
      }
    }
    const children = getElementChildren(node);
    for (let i = 0; i < children.length; i++) depth1(children[i], currentLevel + 1);
  };
  depth1(root, 1);

  if (hasNestedNode.length === 0) {
    return isTest ? willBeDeletedNodes : undefined;
  }

  if (hasNestedNode.length > 0 && (isNeedDelete || isTest)) {
    hasNestedNode.forEach(item => {
      let deleteLevel = MAX_STYLE_LEVEL - 2;
      let currentNode = item;

      let tagList: string[] = [];
      let styleDetailList: string[] = [];
      let parentStyleDetailList: string[] = [];

      const parentHasTag = (tagName: string): boolean => {
        let result = true;
        if (!tagList.includes(tagName)) {
          tagList.push(tagName);
          result = false;
        }
        return result;
      };

      const parentHasStyle = (str: string = '', isParentNode = false): boolean => {
        const allStyle = str.split(';');
        let result = true;
        if (isParentNode) {
          allStyle.forEach(s => {
            if (!parentStyleDetailList.includes(s)) {
              result = false;
              parentStyleDetailList.push(s);
            }
          });
        } else {
          allStyle.forEach(s => {
            if (!styleDetailList.includes(s) && !parentStyleDetailList.includes(s)) {
              result = false;
              styleDetailList.push(s);
            }
          });
        }
        return result;
      };

      while (deleteLevel) {
        const grandParent = currentNode.parentNode && currentNode.parentNode.parentNode;
        const gpChildren = grandParent ? getElementChildren(grandParent) : [];
        const gpChildrenLen = gpChildren.length;

        if (currentNode.parentNode && grandParent && gpChildrenLen === 1) {
          const nodeTagName = getTag(currentNode.parentNode);
          const nodeStyle = getStyle(currentNode.parentNode);

          if (!parentHasTag(nodeTagName) || (parentHasTag(nodeTagName) && !parentHasStyle(nodeStyle, true))) {
            currentNode = currentNode.parentNode;
          } else {
            if (!SPECIAL_NEST_TAGS.test(nodeTagName)) {
              if (!isTest) {
                const deletedNode = currentNode.parentNode;
                if (hasOtherSignificantContent(deletedNode, currentNode)) {
                  currentNode = currentNode.parentNode;
                  deleteLevel -= 1;
                  continue;
                }
                const grandParentNode = currentNode.parentNode.parentNode;
                if (grandParentNode.replaceChild) {
                  grandParentNode.replaceChild(currentNode, deletedNode);
                } else {
                  currentNode.parentNode = grandParentNode;
                  grandParentNode.children[grandParentNode.children.indexOf(deletedNode)] = currentNode;
                }
              } else {
                pushWillBeDeleted(currentNode.parentNode);
                return;
              }
            }
          }
        }
        deleteLevel -= 1;
      }

      currentNode = item;
      const stack: any[] = [currentNode];

      while (stack.length) {
        const downNode = stack.pop();
        if (downNode.isNeedEmpty) {
          tagList = [];
          styleDetailList = [];
        }
        const downChildren = getElementChildren(downNode);
        const downChildrenLen = downChildren.length;

        if (downChildrenLen === 1) {
          const child = downChildren[0];
          const childChildren = getElementChildren(child);
          const childChildrenLen = childChildren.length;

          if (childChildrenLen === 1) {
            const grandChild = childChildren[0];
            const gcChildren = getElementChildren(grandChild);
            const gcChildrenLen = gcChildren.length;

            if (gcChildrenLen > 0) {
              const nodeTagName = getTag(child);
              const nodeStyle = getStyle(child);
              if (!parentHasTag(nodeTagName) || (parentHasTag(nodeTagName) && !parentHasStyle(nodeStyle))) {
                stack.push(child);
              } else {
                if (!SPECIAL_NEST_TAGS.test(nodeTagName)) {
                  if (!isTest) {
                    if (hasOtherSignificantContent(child, childChildren[0])) {
                      stack.push(child);
                      continue;
                    }
                    const tmp = childChildren[0];
                    if (downNode.replaceChild) {
                      downNode.replaceChild(tmp, child);
                    } else {
                      downNode.children[downNode.children.indexOf(child)] = tmp;
                      tmp.parentNode = downNode;
                    }
                    stack.push(downNode);
                  } else {
                    pushWillBeDeleted(child);
                    return;
                  }
                }
              }
            }
          } else if (childChildrenLen > 1) {
            for (let i = childChildrenLen - 1; i >= 0; i--) {
              childChildren[i].isNeedEmpty = true;
              stack.push(childChildren[i]);
            }
          }
        } else if (downChildrenLen > 1) {
          for (let i = downChildrenLen - 1; i >= 0; i--) {
            downChildren[i].isNeedEmpty = true;
            stack.push(downChildren[i]);
          }
        }
      }
    });
  }

  clearTempMarkers(root);
  if (isTest) return willBeDeletedNodes;
}

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

function isUnsafeFixedWidth(wRaw: string): boolean {
  const w = wRaw.trim();
  if (!w || /^(auto|100%)$/i.test(w)) return false;
  if (/^(\d+(?:\.\d+)?|\.\d+)%$/.test(w)) {
    const pct = parseFloat(w);
    return !Number.isFinite(pct) || pct <= 0 || pct > 100;
  }
  if (/^(\d+(?:\.\d+)?|\.\d+)px$/i.test(w)) {
    const px = parseFloat(w);
    return !Number.isFinite(px) || px <= 0 || px >= 375;
  }
  if (/^(\d+(?:\.\d+)?|\.\d+)pt$/i.test(w)) {
    const px = parseFloat(w) * (4 / 3);
    return !Number.isFinite(px) || px <= 0 || px >= 375;
  }
  return true;
}

function getEffectiveOverflowAxis(style: CSSStyleDeclaration, axis: 'x' | 'y'): string {
  const direct = style.getPropertyValue(`overflow-${axis}`).trim().toLowerCase();
  if (direct) return direct;
  const shorthand = style.getPropertyValue('overflow').trim().toLowerCase();
  if (!shorthand) return '';
  const tokens = shorthand.split(/\s+/).filter(Boolean);
  if (tokens.length === 1) return tokens[0];
  if (tokens.length >= 2) return axis === 'x' ? tokens[0] : tokens[1];
  return '';
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

function findEffectiveBgRgb(
  el: Element,
  rootContainer: Element,
  bgCache?: WeakMap<Element, [number, number, number] | null>
): [number, number, number] | null {
  if (bgCache?.has(el)) {
    return bgCache.get(el)!;
  }
  const s = (el as HTMLElement).style;
  if (s) {
    const bgColor = s.getPropertyValue('background-color') || s.getPropertyValue('background');
    const parsed = parseColorRgb(bgColor);
    if (parsed) {
      bgCache?.set(el, parsed);
      return parsed;
    }
  }
  if (el === rootContainer || !el.parentElement) {
    bgCache?.set(el, null);
    return null;
  }
  const parentBg = findEffectiveBgRgb(el.parentElement, rootContainer, bgCache);
  bgCache?.set(el, parentBg);
  return parentBg;
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

  if (rootContainer.hasAttribute('data-nest-level')) {
    rootContainer.removeAttribute('data-nest-level');
  }
  if (rootContainer.querySelector('[data-nest-level]')) {
    rootContainer.querySelectorAll('[data-nest-level]').forEach((el) => {
      el.removeAttribute('data-nest-level');
    });
  }

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

  // 0.1 Wrap consecutive inline children of <li> inside <section> so WeChat ProseMirror
  // does not split bold leads (e.g. <li><strong>Title</strong>：Body</li>) onto separate lines
  rootContainer.querySelectorAll('li').forEach((li) => {
    const doc = li.ownerDocument;
    if (!doc) return;
    let currentSection: HTMLElement | null = null;
    const childNodes = Array.from(li.childNodes);
    for (const node of childNodes) {
      const isBlockEl =
        node.nodeType === 1 &&
        /^(?:section|p|div|ul|ol|blockquote|pre|table|h[1-6]|figure|hr)$/i.test(
          (node as Element).tagName
        );
      if (isBlockEl) {
        currentSection = null;
        continue;
      }
      if (!currentSection) {
        if (node.nodeType === 3 && !(node.textContent || '').trim()) {
          continue;
        }
        currentSection = doc.createElement('section');
        li.insertBefore(currentSection, node);
      }
      currentSection.appendChild(node);
    }
  });

  // 0.2 Render math formulas ([data-math-tex]) to WeChat-compatible vector <svg>
  // to avoid ProseMirror stripping <math> and dumping raw <annotation> LaTeX text
  rootContainer
    .querySelectorAll<HTMLElement>('[data-math-tex]:not([data-morph-asset-id]):not(img)')
    .forEach((mathEl) => {
      const tex = mathEl.getAttribute('data-math-tex') || '';
      const isDisplay =
        mathEl.classList.contains('morph-math-display') ||
        mathEl.tagName.toLowerCase() === 'div' ||
        mathEl.tagName.toLowerCase() === 'section';
      const svgHtml = renderTexToWeChatSvg(tex, isDisplay);
      if (svgHtml) {
        mathEl.innerHTML = svgHtml;
        if (isDisplay) {
          if (canSetProp('display')) mathEl.style.setProperty('display', 'block');
          if (canSetProp('text-align')) mathEl.style.setProperty('text-align', 'center');
          if (canSetProp('margin-top') && !mathEl.style.getPropertyValue('margin-top')) {
            mathEl.style.setProperty('margin-top', '0px');
          }
          if (canSetProp('margin-bottom') && !mathEl.style.getPropertyValue('margin-bottom')) {
            mathEl.style.setProperty('margin-bottom', '20px');
          }
          if (canSetProp('overflow-x')) mathEl.style.setProperty('overflow-x', 'auto');
        }
      }
    });

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

  // 2.5 Structure Rule #2.4: redundant-node (> 20 children with > 15 empty children)
  const checkRedundantChildren = (container: Element) => {
    if (container.children.length > 20) {
      const children = Array.from(container.children);
      const emptyChildren = children.filter((child) => {
        const tag = child.tagName.toLowerCase();
        if (/^(?:img|svg|hr|br|video|audio|iframe|canvas|mp|cps)$/.test(tag)) return false;
        if (hasVisibleText(child)) return false;
        if (child.querySelector('img, svg, hr, br, video, audio, iframe, canvas, mp, cps')) return false;
        return true;
      });
      if (emptyChildren.length > 15) {
        for (const emptyChild of emptyChildren) {
          emptyChild.remove();
        }
        diagnostics.push({
          code: 'structure/wechat-redundant-empty-nodes',
          message: `Removed ${emptyChildren.length} redundant empty child nodes from <${container.tagName.toLowerCase()}> (#2.4 redundant-node).`,
          severity: 'warning',
          targetId: 'wechat',
        });
      }
    }
    for (let i = 0; i < container.children.length; i++) {
      const child = container.children[i];
      if (child.children.length > 0) {
        checkRedundantChildren(child);
      }
    }
  };
  checkRedundantChildren(rootContainer);

  // 3. Dark Mode Rule #4.5.1: data-no-dark whitelist attribute
  if (rootContainer.hasAttribute('data-no-dark')) {
    rootContainer.removeAttribute('data-no-dark');
    diagnostics.push({
      code: 'structure/wechat-darkmode-whitelist',
      message: 'Removed data-no-dark attribute to avoid WeChat Dark Mode whitelist warning (#4.5.1).',
      severity: 'warning',
      targetId: 'wechat',
    });
  }
  rootContainer.querySelectorAll('[data-no-dark]').forEach((el) => {
    el.removeAttribute('data-no-dark');
    diagnostics.push({
      code: 'structure/wechat-darkmode-whitelist',
      message: 'Removed data-no-dark attribute to avoid WeChat Dark Mode whitelist warning (#4.5.1).',
      severity: 'warning',
      targetId: 'wechat',
    });
  });

  // #1.8 <pre> horizontal scroll safeguard
  if (canSetProp('overflow-x')) {
    rootContainer.querySelectorAll<HTMLElement>('pre').forEach((preEl) => {
      if (hasVisibleText(preEl)) {
        const style = preEl.style;
        const ox = getEffectiveOverflowAxis(style, 'x');
        const ws = style.getPropertyValue('white-space').trim().toLowerCase();
        if (ox !== 'auto' && ox !== 'scroll' && ws !== 'pre-wrap' && ws !== 'normal') {
          style.setProperty('overflow-x', 'auto');
        }
      }
    });
  }

  // #1.7 SVG animate/animateTransform/animateMotion begin="touchstart" safeguard
  rootContainer.querySelectorAll('animate[begin], animateTransform[begin], animateMotion[begin]').forEach((el) => {
    const tag = el.tagName.toLowerCase();
    const beginAttr = el.getAttribute('begin');
    if (beginAttr && /\btouchstart\b/i.test(beginAttr) && !/\bclick\b/i.test(beginAttr)) {
      const normalizedBegin = `${beginAttr.trim().replace(/;+\s*$/, '')}; click`;
      el.setAttribute('begin', normalizedBegin);
      diagnostics.push({
        code: 'structure/wechat-animate-begin-click',
        message: `Appended click trigger to SVG <${tag} begin="${beginAttr}"> for WeChat PC compatibility (#1.7 begin).`,
        severity: 'warning',
        targetId: 'wechat',
      });
    }
  });

  const bgRgbCache = new WeakMap<Element, [number, number, number] | null>();
  const contrastSafeCache = new Map<string, boolean>();
  const katexOrSvgCache = new WeakMap<Element, boolean>();
  const isInsideKatexOrSvgCached = (el: Element): boolean => {
    if (katexOrSvgCache.has(el)) return katexOrSvgCache.get(el)!;
    const tag = el.tagName.toLowerCase();
    const cl = el.classList;
    if (
      tag === 'svg' ||
      el.getAttribute('data-mode') === 'svg' ||
      (cl && (cl.contains('katex') || cl.contains('katex-html') || cl.contains('katex-mathml')))
    ) {
      katexOrSvgCache.set(el, true);
      return true;
    }
    const parentRes = el.parentElement && el !== rootContainer ? isInsideKatexOrSvgCached(el.parentElement) : false;
    katexOrSvgCache.set(el, parentRes);
    return parentRes;
  };

  // 4. CSS & Layout Rules (#1.1 - #1.6, #3, #4.1.1, #4.1.2) across styled elements only
  const verifiedSafeElementStyles = new Set<string>();
  const styledElements = [rootContainer, ...Array.from(rootContainer.querySelectorAll<HTMLElement>('[style]'))];
  for (const el of styledElements) {
    if (!el.isConnected) continue;
    const rawStyleAttr = el.getAttribute('style');
    if (!rawStyleAttr) continue;

    // Fast-path for simple hex color spans (e.g. Shiki syntax tokens: style="color:#24292E")
    if (
      rawStyleAttr.charCodeAt(0) === 99 /* 'c' */ &&
      /^color:\s*#[0-9a-fA-F]{3,8}\s*;?$/.test(rawStyleAttr) &&
      !el.hasAttribute('data-ignore-dm')
    ) {
      const bgRgb = findEffectiveBgRgb(el, rootContainer, bgRgbCache);
      if (bgRgb) {
        const colorHex = rawStyleAttr.slice(6).replace(';', '').trim();
        const cacheKey = `${colorHex}|${bgRgb[0]},${bgRgb[1]},${bgRgb[2]}`;
        let isLowContrast = contrastSafeCache.get(cacheKey);
        if (isLowContrast === undefined) {
          const textRgb = parseColorRgb(colorHex);
          isLowContrast = Boolean(textRgb && computeContrastRatio(textRgb, bgRgb) < 1.5);
          contrastSafeCache.set(cacheKey, isLowContrast);
        }
        if (isLowContrast && hasDirectVisibleText(el)) {
          el.removeAttribute('style');
          diagnostics.push({
            code: 'style/wechat-low-contrast',
            message: 'Removed low-contrast text color (contrast < 1.5) for WeChat Dark Mode readability (#4.1.1).',
            severity: 'warning',
            targetId: 'wechat',
            property: 'color',
          });
        }
      }
      continue;
    }

    const htmlEl = el as HTMLElement;
    const tag = el.tagName.toLowerCase();
    const rawStyleLower = rawStyleAttr.toLowerCase();
    const ignoreDmAttr = el.getAttribute('data-ignore-dm');
    const canCacheSafeStyle =
      el !== rootContainer &&
      !ignoreDmAttr &&
      !el.hasAttribute('data-ignore-width') &&
      !rawStyleLower.includes('height') &&
      !rawStyleLower.includes('gradient') &&
      !isInsideKatexOrSvgCached(el);
    const effectiveBgForKey =
      canCacheSafeStyle && rawStyleLower.includes('color')
        ? findEffectiveBgRgb(el, rootContainer, bgRgbCache)
        : null;
    const safeStyleKey = canCacheSafeStyle
      ? `${tag}|${rawStyleAttr}|${effectiveBgForKey ? `${effectiveBgForKey[0]},${effectiveBgForKey[1]},${effectiveBgForKey[2]}` : ''}`
      : null;
    if (safeStyleKey !== null && verifiedSafeElementStyles.has(safeStyleKey)) {
      continue;
    }

    const style = htmlEl.style;
    let styleMutated = false;

    // #1.1 img opacity: 0
    if (tag === 'img' && rawStyleLower.includes('opacity')) {
      const op = style.getPropertyValue('opacity').trim();
      if ((op !== '' && (/^0(?:\.0+)?$/.test(op) || parseFloat(op) === 0)) || /opacity\s*:\s*0\b/i.test(rawStyleAttr)) {
        style.removeProperty('opacity');
        styleMutated = true;
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
    if (rawStyleLower.includes('caret-color')) {
      const caret = style.getPropertyValue('caret-color').trim();
      if (caret && (/^transparent$/i.test(caret) || /rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/i.test(caret.replace(/\s+/g, '')))) {
        style.removeProperty('caret-color');
        styleMutated = true;
        diagnostics.push({
          code: 'style/wechat-transparent-caret',
          message: 'Removed transparent caret-color to comply with WeChat spec (#1.2 caret-color).',
          severity: 'warning',
          targetId: 'wechat',
          property: 'caret-color',
        });
      }
    }

    // #1.6 text-align: start | end
    if (rawStyleLower.includes('text-align')) {
      const textAlign = style.getPropertyValue('text-align').trim().toLowerCase();
      if (textAlign === 'start' || textAlign === 'end') {
        const normalized = textAlign === 'start' ? 'left' : 'right';
        if (canSetProp('text-align')) {
          style.setProperty('text-align', normalized);
        } else {
          style.removeProperty('text-align');
        }
        styleMutated = true;
        diagnostics.push({
          code: 'style/wechat-text-align-normalized',
          message: `Normalized text-align: ${textAlign} to ${normalized} for WeChat cross-device compatibility (#1.6 text-align).`,
          severity: 'warning',
          targetId: 'wechat',
          property: 'text-align',
        });
      }
    }

    // #3 font-family: ensure WeChat-compatible system font prefix unless it is a recognized editorial/code stack
    if (rawStyleLower.includes('font-family')) {
      const ff = style.getPropertyValue('font-family').trim();
      if (ff) {
        const normalizedFf = ff.replace(/["']/g, '').replace(/\s+/g, ' ').trim();
        const wechatFontPrefix = 'mp-quote, PingFang SC, system-ui, -apple-system';
        const isRecognizedEditorialOrCodeFont =
          /\b(?:Newsreader|Iowan Old Style|Palatino|Noto Serif SC|Songti SC|STSong|Source Serif 4|Georgia|Inter|PingFang SC|JetBrains Mono|SF Mono|SFMono-Regular|Consolas|Liberation Mono|Menlo|Fira Code|ui-monospace|monospace)\b/i.test(
            normalizedFf
          );
        if (!normalizedFf.startsWith(wechatFontPrefix) && !isRecognizedEditorialOrCodeFont) {
          if (canSetProp('font-family')) {
            style.setProperty('font-family', `"mp-quote", PingFang SC, system-ui, -apple-system, ${ff}`);
          } else {
            style.removeProperty('font-family');
          }
          styleMutated = true;
          diagnostics.push({
            code: 'style/wechat-font-family-normalized',
            message: `Normalized font-family (${ff}) to WeChat-compatible system font stack (#3 font-family).`,
            severity: 'warning',
            targetId: 'wechat',
            property: 'font-family',
          });
        }
      }
    }

    // #1.3 line-height overlap
    if (rawStyleLower.includes('line-height') && tag !== 'svg' && !isInsideKatexOrSvgCached(el)) {
      const lh = style.getPropertyValue('line-height').trim();
      if (lh) {
        const fsRaw = style.getPropertyValue('font-size').trim();
        const fontSizePx = fsRaw && fsRaw.endsWith('px') ? (parseFloat(fsRaw) || 16) : 16;
        if (isOverlappingLineHeight(lh, fontSizePx) && hasVisibleText(el)) {
          if (el === rootContainer && canSetProp('line-height')) {
            style.setProperty('line-height', '1.75');
          } else {
            style.removeProperty('line-height');
          }
          styleMutated = true;
          diagnostics.push({
            code: 'style/wechat-line-height-overlap',
            message: `Removed overlapping line-height (${lh}) on text element (#1.3 line-height).`,
            severity: 'warning',
            targetId: 'wechat',
            property: 'line-height',
          });
        }
      }
    }

    // #1.4 width & horizontal overflow on non-img/non-svg elements (unless data-ignore-width)
    if ((rawStyleLower.includes('width') || rawStyleLower.includes('margin')) && tag !== 'img' && tag !== 'svg' && !isInsideKatexOrSvgCached(el)) {
      const w = style.getPropertyValue('width').trim();
      const ml = style.getPropertyValue('margin-left').trim();
      const mr = style.getPropertyValue('margin-right').trim();
      if (w || ml || mr) {
        const ignoresWidth = typeof el.closest === 'function'
          ? Boolean(el.closest('[data-ignore-width]'))
          : el.hasAttribute('data-ignore-width');

        if (!ignoresWidth) {
          if (w && isUnsafeFixedWidth(w)) {
            style.removeProperty('width');
            styleMutated = true;
            diagnostics.push({
              code: 'style/wechat-fixed-width',
              message: `Removed fixed width (${w}) on <${tag}> to prevent multi-screen width/centering variance (#1.4 width).`,
              severity: 'warning',
              targetId: 'wechat',
              property: 'width',
            });
          }

          for (const [mProp, mVal] of [['margin-left', ml], ['margin-right', mr]] as const) {
            if (mVal && isExcessiveHorizontalMargin(mVal)) {
              style.removeProperty(mProp);
              styleMutated = true;
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
      }
    }

    // #1.5 height: 0 and fixed height overflow on text/content containers
    if (rawStyleLower.includes('height') && tag !== 'img' && tag !== 'svg' && !isInsideKatexOrSvgCached(el)) {
      const h = style.getPropertyValue('height').trim();
      if (h && !/^auto$/i.test(h)) {
        const isZeroHeight = /^0(?:px|em|rem|%|pt)?$/i.test(h);
        const overflowY = getEffectiveOverflowAxis(style, 'y');
        const canScrollY = overflowY === 'auto' || overflowY === 'scroll';
        if ((isZeroHeight && hasVisibleText(el)) || (!isZeroHeight && !canScrollY && (el.children.length > 0 || hasVisibleText(el)))) {
          style.removeProperty('height');
          styleMutated = true;
          diagnostics.push({
            code: 'style/wechat-unsafe-height',
            message: `Removed fixed height (${h}) on <${tag}> to prevent text clipping/hiding on mobile (#1.5 height).`,
            severity: 'warning',
            targetId: 'wechat',
            property: 'height',
          });
        }
      }
    }

    // #4.1.2 Dark Mode text background gradient
    const ignoreDm = ignoreDmAttr ? ignoreDmAttr.split(/\s+/) : [];
    if (!ignoreDm.includes('text-bg-gradient') && rawStyleLower.includes('gradient')) {
      const bgImg = style.getPropertyValue('background-image').trim();
      const bg = style.getPropertyValue('background').trim();
      if ((/gradient\s*\(/i.test(bgImg) || /gradient\s*\(/i.test(bg) || /gradient\s*\(/i.test(rawStyleAttr)) && hasVisibleText(el)) {
        style.removeProperty('background-image');
        style.removeProperty('background');
        styleMutated = true;
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
    if (!ignoreDm.includes('low-contrast') && rawStyleLower.includes('color') && hasDirectVisibleText(el)) {
      const isSimpleHexColor = /^color:\s*(#[0-9a-fA-F]{3,8})\s*;?$/.exec(rawStyleAttr);
      const colorProp = isSimpleHexColor ? isSimpleHexColor[1] : style.getPropertyValue('color');
      if (colorProp) {
        const bgRgb = effectiveBgForKey ?? findEffectiveBgRgb(el, rootContainer, bgRgbCache);
        if (bgRgb) {
          const cacheKey = `${colorProp}|${bgRgb[0]},${bgRgb[1]},${bgRgb[2]}`;
          let isLowContrast = contrastSafeCache.get(cacheKey);
          if (isLowContrast === undefined) {
            const textRgb = parseColorRgb(colorProp);
            isLowContrast = Boolean(textRgb && computeContrastRatio(textRgb, bgRgb) < 1.5);
            contrastSafeCache.set(cacheKey, isLowContrast);
          }
          if (isLowContrast) {
            style.removeProperty('color');
            styleMutated = true;
            diagnostics.push({
              code: 'style/wechat-low-contrast',
              message: 'Removed low-contrast text color (contrast < 1.5) for WeChat Dark Mode readability (#4.1.1).',
              severity: 'warning',
              targetId: 'wechat',
              property: 'color',
            });
          }
        }
      }
    }

    if (styleMutated && style.length === 0) {
      el.removeAttribute('style');
    } else if (
      safeStyleKey !== null &&
      !styleMutated &&
      (!rawStyleLower.includes('line-height') || hasVisibleText(el)) &&
      (!rawStyleLower.includes('color') || hasDirectVisibleText(el))
    ) {
      verifiedSafeElementStyles.add(safeStyleKey);
    }
  }

  // 5. Structure Rule #2.1: Redundant nesting deduplication (>= 15 levels)
  dedupeWeChatNesting(rootContainer, diagnostics);
}
