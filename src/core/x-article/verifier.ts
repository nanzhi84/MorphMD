import { parseDocument } from '../dom/env';
import { xArticlePropertyRules } from './rules-text';
import type {
  DraftBlockType,
  DraftInlineStyle,
  DraftJsEntityRange,
  DraftJsInlineStyleRange,
  DraftJsSimulatedBlock,
  DraftJsSimulatedEntity,
  XArticleVerifyOpts,
  XArticleVerifyResult,
  XArticleViolationEntry,
  XArticleViolationItem,
} from './types';

const ALLOWED_X_ARTICLE_TAGS = new Set([
  'div',
  'h1',
  'h2',
  'p',
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
  'u',
  'a',
  'img',
  'hr',
  'br',
  'figure',
  'figcaption',
]);

const HEADING_VIOLATION_TAGS = new Set(['h3', 'h4', 'h5', 'h6']);
const TABLE_TAGS = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td']);

function isInsideAllowedStyledBlock(el: Element, allowCodeBlockStyles: boolean): boolean {
  let curr: Element | null = el;
  while (curr) {
    if (curr.getAttribute('data-morph-rasterized') === 'true') {
      return true;
    }
    const tag = curr.tagName.toLowerCase();
    if (allowCodeBlockStyles && (tag === 'pre' || curr.classList?.contains('morph-code'))) {
      return true;
    }
    curr = curr.parentElement;
  }
  return false;
}

function isValidHttpsImageSrc(src: string): boolean {
  if (!src || /[\s"'<>]/.test(src)) return false;
  try {
    const parsed = new URL(src);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isValidRasterDataUrl(src: string): boolean {
  return /^data:image\/(?:svg\+xml|png|jpeg|webp)[;,]/i.test(src);
}

function isSafeLinkHref(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('#') || trimmed.startsWith('/')) return true;
  if (/^(?:javascript|vbscript|data):/i.test(trimmed)) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' || parsed.protocol === 'mailto:';
  } catch {
    return false;
  }
}

/**
 * Simulates X Articles' Draft.js `convertFromHTML` DOM-to-ContentState parser,
 * producing structured `ContentBlock[]` and `entityMap`.
 */
export function simulateDraftJsConvertFromHtml(rootContainer: Element): {
  blocks: DraftJsSimulatedBlock[];
  entityMap: Record<number, DraftJsSimulatedEntity>;
} {
  const blocks: DraftJsSimulatedBlock[] = [];
  const entityMap: Record<number, DraftJsSimulatedEntity> = {};
  let nextEntityKey = 0;
  let nextBlockIdx = 0;

  function allocateEntity(entity: DraftJsSimulatedEntity): number {
    const key = nextEntityKey++;
    entityMap[key] = entity;
    return key;
  }

  function collectInlineContent(
    node: Node,
    activeStyles: Set<DraftInlineStyle>,
    outText: { value: string },
    styleRanges: DraftJsInlineStyleRange[],
    entityRanges: DraftJsEntityRange[]
  ): void {
    if (node.nodeType === 3) {
      const txt = node.textContent || '';
      if (!txt) return;
      const start = outText.value.length;
      outText.value += txt;
      for (const st of activeStyles) {
        styleRanges.push({ offset: start, length: txt.length, style: st });
      }
      return;
    }

    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();

    if (tag === 'br') {
      outText.value += '\n';
      return;
    }

    if (tag === 'img') {
      const start = outText.value.length;
      outText.value += '\uFFFC';
      const entityKey = allocateEntity({
        type: 'IMAGE',
        mutability: 'IMMUTABLE',
        data: {
          src: el.getAttribute('src') || '',
          alt: el.getAttribute('alt') || '',
          rasterized: el.getAttribute('data-morph-rasterized') === 'true',
        },
      });
      entityRanges.push({ offset: start, length: 1, key: entityKey });
      return;
    }

    const nextStyles = new Set(activeStyles);
    if (tag === 'strong' || tag === 'b') nextStyles.add('BOLD');
    if (tag === 'em' || tag === 'i') nextStyles.add('ITALIC');
    if (tag === 'del' || tag === 's') nextStyles.add('STRIKETHROUGH');
    if (tag === 'code') nextStyles.add('CODE');

    const startOffset = outText.value.length;
    for (let child = el.firstChild; child; child = child.nextSibling) {
      collectInlineContent(child, nextStyles, outText, styleRanges, entityRanges);
    }
    const len = outText.value.length - startOffset;

    if (tag === 'a' && len > 0) {
      const entityKey = allocateEntity({
        type: 'LINK',
        mutability: 'MUTABLE',
        data: {
          url: el.getAttribute('href') || '',
        },
      });
      entityRanges.push({ offset: startOffset, length: len, key: entityKey });
    }
  }

  function emitBlock(type: DraftBlockType, el: Element, depth = 0): void {
    if (type === 'atomic' && el.tagName.toLowerCase() === 'hr') {
      const entityKey = allocateEntity({
        type: 'DIVIDER',
        mutability: 'IMMUTABLE',
        data: {},
      });
      blocks.push({
        key: `blk_${nextBlockIdx++}`,
        type: 'atomic',
        text: ' ',
        depth: 0,
        inlineStyleRanges: [],
        entityRanges: [{ offset: 0, length: 1, key: entityKey }],
      });
      return;
    }

    const outText = { value: '' };
    const styleRanges: DraftJsInlineStyleRange[] = [];
    const entityRanges: DraftJsEntityRange[] = [];
    collectInlineContent(el, new Set(), outText, styleRanges, entityRanges);

    blocks.push({
      key: `blk_${nextBlockIdx++}`,
      type,
      text: outText.value,
      depth,
      inlineStyleRanges: styleRanges,
      entityRanges,
    });
  }

  function walkList(listEl: Element, listDepth: number): void {
    const listTag = listEl.tagName.toLowerCase();
    const itemType: DraftBlockType = listTag === 'ul' ? 'unordered-list-item' : 'ordered-list-item';
    for (const li of Array.from(listEl.children)) {
      if (li.tagName.toLowerCase() === 'li') {
        const nestedLists = Array.from(li.children).filter((c) => /^(ul|ol)$/i.test(c.tagName));
        if (nestedLists.length > 0) {
          const clone = li.cloneNode(true) as Element;
          Array.from(clone.children)
            .filter((c) => /^(ul|ol)$/i.test(c.tagName))
            .forEach((c) => c.remove());
          emitBlock(itemType, clone, listDepth);
          for (const nl of nestedLists) {
            walkList(nl, listDepth + 1);
          }
        } else {
          emitBlock(itemType, li, listDepth);
        }
      }
    }
  }

  function walkBlockContainer(container: Element, listDepth = 0): void {
    const children = Array.from(container.children);
    if (children.length === 0) {
      if ((container.textContent || '').trim().length > 0) {
        emitBlock('unstyled', container, 0);
      }
      return;
    }

    for (const child of children) {
      const tag = child.tagName.toLowerCase();
      if (tag === 'h1') {
        emitBlock('header-one', child, 0);
      } else if (tag === 'h2') {
        emitBlock('header-two', child, 0);
      } else if (HEADING_VIOLATION_TAGS.has(tag)) {
        // Unnormalized h3-h6 degrades to unstyled in X Articles
        emitBlock('unstyled', child, 0);
      } else if (tag === 'p') {
        const onlyImg =
          child.children.length === 1 &&
          child.children[0].tagName.toLowerCase() === 'img' &&
          (child.textContent || '').trim() === '';
        emitBlock(onlyImg ? 'atomic' : 'unstyled', child, 0);
      } else if (tag === 'pre') {
        emitBlock('code-block', child, 0);
      } else if (tag === 'hr') {
        emitBlock('atomic', child, 0);
      } else if (tag === 'img') {
        emitBlock('atomic', child, 0);
      } else if (tag === 'blockquote') {
        const bqChildren = Array.from(child.children);
        const hasBlockChildren = bqChildren.some((c) => /^(p|div|h[1-6]|ul|ol|pre|blockquote)$/i.test(c.tagName));
        if (hasBlockChildren) {
          for (const sub of bqChildren) {
            emitBlock('blockquote', sub, 0);
          }
        } else {
          emitBlock('blockquote', child, 0);
        }
      } else if (tag === 'ul' || tag === 'ol') {
        walkList(child, listDepth);
      } else if (tag === 'div' || tag === 'figure' || tag === 'section' || tag === 'article') {
        walkBlockContainer(child, listDepth);
      } else {
        emitBlock('unstyled', child, listDepth);
      }
    }
  }

  const rootTag = rootContainer.tagName.toLowerCase();
  if (rootTag === 'body' || rootContainer.classList?.contains('morph-doc')) {
    walkBlockContainer(rootContainer, 0);
  } else {
    walkBlockContainer(rootContainer, 0);
  }

  return { blocks, entityMap };
}

/**
 * Verifies an HTML DOM container against the X Articles (`x.com/compose/article`)
 * Draft.js structure, media, and style capability specification.
 */
export function verifyXArticleStructure(
  articleBody: Element,
  opts: XArticleVerifyOpts = {}
): XArticleVerifyResult {
  const allowCodeBlockStyles = opts.allowCodeBlockStyles ?? true;
  const root = articleBody.querySelector('.morph-doc') || articleBody;
  const inValidInfo: Record<string, XArticleViolationEntry> = {};

  function addViolation(key: keyof typeof xArticlePropertyRules, item: XArticleViolationItem): void {
    const ruleDesc = xArticlePropertyRules[key] || key;
    if (!inValidInfo[key]) {
      inValidInfo[key] = {
        violateRules: ruleDesc,
        items: [],
      };
    }
    inValidInfo[key].items.push(item);
  }

  const topBlocks = Array.from(root.children);
  function resolveBlockIndex(node: Element): number {
    let curr: Element | null = node;
    while (curr && curr.parentElement && curr.parentElement !== root) {
      curr = curr.parentElement;
    }
    return curr ? topBlocks.indexOf(curr) : -1;
  }

  // 1. #1.1 heading-level: h3 ~ h6
  root.querySelectorAll('h3, h4, h5, h6').forEach((heading) => {
    addViolation('heading-level', {
      blockIndex: resolveBlockIndex(heading),
      outerHTML: heading.outerHTML,
      tagName: heading.tagName.toLowerCase(),
      rules: xArticlePropertyRules['heading-level'],
    });
  });

  // 2. #1.2 callout-structure: div.morph-callout not converted to blockquote
  root.querySelectorAll('div.morph-callout').forEach((callout) => {
    addViolation('callout-structure', {
      blockIndex: resolveBlockIndex(callout),
      outerHTML: callout.outerHTML,
      tagName: 'div',
      rules: xArticlePropertyRules['callout-structure'],
    });
  });

  // 3. #1.3 unrasterized-table: raw <table> or orphan table cells
  root.querySelectorAll('table').forEach((table) => {
    addViolation('unrasterized-table', {
      blockIndex: resolveBlockIndex(table),
      outerHTML: table.outerHTML,
      tagName: 'table',
      rules: xArticlePropertyRules['unrasterized-table'],
    });
  });

  // 4. #2.1 unrasterized-math: raw <math>, .katex, .katex-mathml, .katex-html
  const mathContainers = new Set<Element>();
  root.querySelectorAll('math, .katex, .katex-mathml, .katex-html').forEach((mathNode) => {
    const container = mathNode.closest('.morph-math') || mathNode.closest('.katex') || mathNode;
    mathContainers.add(container);
  });
  for (const mathEl of mathContainers) {
    addViolation('unrasterized-math', {
      blockIndex: resolveBlockIndex(mathEl),
      outerHTML: mathEl.outerHTML,
      tagName: mathEl.tagName.toLowerCase(),
      rules: xArticlePropertyRules['unrasterized-math'],
    });
  }

  // 5. #2.2 unrasterized-svg: raw <svg> outside math (or standalone)
  root.querySelectorAll('svg').forEach((svg) => {
    if (svg.closest('.morph-math') || svg.closest('.katex')) return;
    addViolation('unrasterized-svg', {
      blockIndex: resolveBlockIndex(svg),
      outerHTML: svg.outerHTML,
      tagName: 'svg',
      rules: xArticlePropertyRules['unrasterized-svg'],
    });
  });

  // 6. #1.4 unsupported-element & #3.1 native-inline-style & #2.3/#3.3 unsafe-media-or-link
  const allElements = Array.from(root.querySelectorAll('*'));
  for (const el of allElements) {
    const tag = el.tagName.toLowerCase();

    // Skip internals of already-flagged table/math/svg subtrees to avoid duplicate noise
    if (TABLE_TAGS.has(tag)) continue;
    if (tag === 'math' || el.closest('math') || el.closest('.katex')) continue;
    if (tag === 'svg' || el.closest('svg')) continue;

    if (HEADING_VIOLATION_TAGS.has(tag)) {
      // Already reported under heading-level
    } else if (!ALLOWED_X_ARTICLE_TAGS.has(tag)) {
      addViolation('unsupported-element', {
        blockIndex: resolveBlockIndex(el),
        outerHTML: el.outerHTML,
        tagName: tag,
        rules: `不支持的标签 <${tag}>：${xArticlePropertyRules['unsupported-element']}`,
      });
    } else if (tag === 'li') {
      const parentTag = el.parentElement?.tagName.toLowerCase();
      if (parentTag !== 'ul' && parentTag !== 'ol') {
        addViolation('unsupported-element', {
          blockIndex: resolveBlockIndex(el),
          outerHTML: el.outerHTML,
          tagName: 'li',
          rules: `孤立 <li> 节点未包裹在 <ul> 或 <ol> 内：${xArticlePropertyRules['unsupported-element']}`,
        });
      }
    }

    // #3.1 native-inline-style
    const styleAttr = el.getAttribute('style');
    if (styleAttr && styleAttr.trim().length > 0 && !isInsideAllowedStyledBlock(el, allowCodeBlockStyles)) {
      addViolation('native-inline-style', {
        blockIndex: resolveBlockIndex(el),
        outerHTML: el.outerHTML,
        tagName: tag,
        rules: xArticlePropertyRules['native-inline-style'],
      });
    }

    // #2.3 unsafe-media-or-link on <img>
    if (tag === 'img') {
      const src = (el.getAttribute('src') || '').trim();
      const isRasterized = el.getAttribute('data-morph-rasterized') === 'true';
      const valid = isRasterized
        ? isValidRasterDataUrl(src) || isValidHttpsImageSrc(src)
        : isValidHttpsImageSrc(src);

      if (!valid) {
        addViolation('unsafe-media-or-link', {
          blockIndex: resolveBlockIndex(el),
          outerHTML: el.outerHTML,
          tagName: 'img',
          rules: `图片 src 协议不满足 X Articles 交付要求 (${src.slice(0, 48)})：${xArticlePropertyRules['unsafe-media-or-link']}`,
        });
      }
    }

    // #3.3 unsafe-media-or-link on <a>
    if (tag === 'a') {
      const href = el.getAttribute('href') || '';
      if (!isSafeLinkHref(href)) {
        addViolation('unsafe-media-or-link', {
          blockIndex: resolveBlockIndex(el),
          outerHTML: el.outerHTML,
          tagName: 'a',
          rules: `超链接 href 协议不安全 (${href.slice(0, 48)})：${xArticlePropertyRules['unsafe-media-or-link']}`,
        });
      }
    }
  }

  const draftState = simulateDraftJsConvertFromHtml(root);
  const isValid = Object.keys(inValidInfo).length === 0;

  return {
    isValid,
    inValidInfo,
    draftState,
  };
}

/**
 * Convenience helper to verify an HTML string against the X Articles
 * Draft.js structure and capability specification.
 */
export function verifyXArticleHtml(
  html: string,
  opts: XArticleVerifyOpts = {}
): XArticleVerifyResult {
  const { doc, cleanup } = parseDocument(html);
  try {
    const root = doc.querySelector('.morph-doc') || doc.body;
    return verifyXArticleStructure(root, opts);
  } finally {
    cleanup();
  }
}
