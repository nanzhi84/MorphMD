import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import { visit, SKIP } from 'unist-util-visit';
import { toHtml } from 'hast-util-to-html';
import type { Root, Element } from 'hast';
import type { DiagnosticItem, SourceRangeEntry } from '../snapshot/types';
import { hashString } from './cache';
import type { CompileOptions, CompileResult } from './types';
export type { CompileOptions, CompileResult };
import { sanitizeHast } from './sanitize';
import { transformCallouts } from './callout';
import { initHighlighter, getLoadedHighlighter, transformMathAndCode } from './math-code';

function ensureClass(props: Record<string, unknown>, className: string): void {
  const current = props.className;
  if (Array.isArray(current)) {
    if (!current.includes(className)) {
      current.push(className);
    }
  } else if (typeof current === 'string') {
    const list = current.split(/\s+/).filter(Boolean);
    if (!list.includes(className)) {
      list.push(className);
    }
    props.className = list;
  } else {
    props.className = [className];
  }
}

function computeSemanticSignature(node: any): string {
  if (node?.type === 'element') {
    const topProps = node.properties || {};
    const mathTex = topProps['data-math-tex'] !== undefined ? topProps['data-math-tex'] : topProps.dataMathTex;
    if (mathTex !== undefined) {
      return `<${node.tagName} data-math-tex="${String(mathTex)}"></${node.tagName}>`;
    }
  }
  let sig = '';
  function walk(n: any) {
    if (!n) return;
    if (n.type === 'text') {
      sig += n.value;
      return;
    }
    if (n.type === 'element') {
      sig += `<${n.tagName}`;
      const props = n.properties || {};
      for (const [kebab, camel] of [
        ['href', 'href'],
        ['src', 'src'],
        ['alt', 'alt'],
        ['data-math-tex', 'dataMathTex'],
        ['data-code-lang', 'dataCodeLang'],
        ['data-morph-asset-id', 'dataMorphAssetId'],
      ]) {
        const val = props[kebab] !== undefined ? props[kebab] : props[camel];
        if (val !== undefined) {
          sig += ` ${kebab}="${String(val)}"`;
        }
      }
      sig += '>';
      for (const child of n.children || []) {
        walk(child);
      }
      sig += `</${n.tagName}>`;
    }
  }
  walk(node);
  return sig;
}

export async function compileMarkdown(
  markdown: string,
  options: CompileOptions = {}
): Promise<CompileResult> {
  const highlighter = await initHighlighter();
  return runCompile(markdown, options, highlighter, false);
}

export function compileMarkdownSync(
  markdown: string,
  options: CompileOptions = {}
): CompileResult {
  const highlighter = getLoadedHighlighter();
  return runCompile(markdown, options, highlighter, highlighter === null);
}

function normalizeOrphanTableHtml() {
  return (tree: any) => {
    let tableDepth = 0;
    visit(tree, 'html', (node: { value?: string }) => {
      const val = typeof node.value === 'string' ? node.value : '';
      if (!val) return;
      const openTables = (val.match(/<table\b/gi) || []).length;
      const closeTables = (val.match(/<\/table\s*>/gi) || []).length;
      if (tableDepth === 0 && openTables === 0) {
        if (/^\s*<(?:thead|tbody|tfoot|tr)\b/i.test(val)) {
          node.value = `<table>${val}</table>`;
        } else if (/^\s*<(?:td|th)\b/i.test(val)) {
          node.value = `<table><tbody><tr>${val}</tr></tbody></table>`;
        }
      }
      tableDepth = Math.max(0, tableDepth + openTables - closeTables);
    });
  };
}

function isCjkOrFullwidthCode(code: number | null): boolean {
  if (code === null || code < 0) return false;
  const ch = String.fromCodePoint(code);
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303F\uFF00-\uFFEF\u2000-\u206F]/u.test(
    ch
  );
}

function isPunctuationOrSymbolCode(code: number | null): boolean {
  if (code === null || code < 0) return false;
  const ch = String.fromCodePoint(code);
  return /[\p{P}\p{S}]/u.test(ch);
}

function isWhitespaceOrNullCode(code: number | null): boolean {
  if (code === null || code < 0) return true;
  const ch = String.fromCodePoint(code);
  return /\s/u.test(ch);
}

function remarkCjkFriendly(this: any) {
  const data = this.data();
  const micromarkExtensions = data.micromarkExtensions || (data.micromarkExtensions = []);

  const findBaseConstruct = (context: any, code: number, name: string) => {
    const list = context.parser?.constructs?.text?.[code];
    if (!Array.isArray(list)) return null;
    return list.find((item: any) => item && item.name === name) ?? null;
  };

  const cjkAttention = {
    name: 'cjkAttention',
    resolveAll(events: any[], context: any) {
      const base = findBaseConstruct(context, 42, 'attention');
      return base && typeof base.resolveAll === 'function'
        ? base.resolveAll(events, context)
        : events;
    },
    tokenize(this: any, effects: any, ok: any, nok: any) {
      const self = this;
      const previous = self.previous;
      return (code: number) => {
        const base = findBaseConstruct(self, code, 'attention');
        if (!base) return nok(code);
        const marker = code;
        return base.tokenize.call(
          self,
          effects,
          (afterCode: number | null) => {
            const lastEvent = self.events[self.events.length - 1];
            const token = lastEvent?.[1];
            if (token && token.type === 'attentionSequence') {
              if (isCjkOrFullwidthCode(previous) || isCjkOrFullwidthCode(afterCode)) {
                const beforeClass = isWhitespaceOrNullCode(previous)
                  ? 1
                  : isPunctuationOrSymbolCode(previous)
                    ? 2
                    : 0;
                const afterClass = isWhitespaceOrNullCode(afterCode)
                  ? 1
                  : isPunctuationOrSymbolCode(afterCode)
                    ? 2
                    : 0;
                const open = Boolean(token._open) || afterClass === 2;
                const close = Boolean(token._close) || beforeClass === 2;
                token._open = Boolean(
                  marker === 42 ? open : open && (beforeClass > 0 || !close)
                );
                token._close = Boolean(
                  marker === 42 ? close : close && (afterClass > 0 || !open)
                );
              }
            }
            return ok(afterCode);
          },
          nok
        )(code);
      };
    },
  };

  const cjkStrikethrough = {
    name: 'cjkStrikethrough',
    resolveAll(events: any[], context: any) {
      const base = findBaseConstruct(context, 126, 'strikethrough');
      return base && typeof base.resolveAll === 'function'
        ? base.resolveAll(events, context)
        : events;
    },
    tokenize(this: any, effects: any, ok: any, nok: any) {
      const self = this;
      const previous = self.previous;
      return (code: number) => {
        const base = findBaseConstruct(self, 126, 'strikethrough');
        if (!base) return nok(code);
        return base.tokenize.call(
          self,
          effects,
          (afterCode: number | null) => {
            const lastEvent = self.events[self.events.length - 1];
            const token = lastEvent?.[1];
            if (token && token.type === 'strikethroughSequenceTemporary') {
              if (isCjkOrFullwidthCode(previous) || isCjkOrFullwidthCode(afterCode)) {
                if (isPunctuationOrSymbolCode(afterCode)) {
                  token._open = true;
                }
                if (isPunctuationOrSymbolCode(previous)) {
                  token._close = true;
                }
              }
            }
            return ok(afterCode);
          },
          nok
        )(code);
      };
    },
  };

  micromarkExtensions.push({
    text: {
      42: cjkAttention,
      95: cjkAttention,
      126: cjkStrikethrough,
    },
    insideSpan: {
      null: [cjkAttention, cjkStrikethrough],
    },
  });
}

function stripTableInternalWhitespace() {
  return (tree: any) => {
    if (Array.isArray(tree.children)) {
      tree.children = tree.children.filter(
        (child: any) =>
          !(child.type === 'text' && typeof child.value === 'string' && child.value.trim() === '')
      );
    }
    visit(tree, 'element', (node: any) => {
      if (
        [
          'table',
          'thead',
          'tbody',
          'tfoot',
          'tr',
          'colgroup',
          'blockquote',
          'ul',
          'ol',
          'figure',
        ].includes(node.tagName) &&
        Array.isArray(node.children)
      ) {
        node.children = node.children.filter(
          (child: any) =>
            !(child.type === 'text' && typeof child.value === 'string' && child.value.trim() === '')
        );
      }
    });
  };
}

function isWhitespaceText(node: any): boolean {
  return node?.type === 'text' && typeof node.value === 'string' && node.value.trim() === '';
}

function extractNodePlainText(node: any): string {
  if (!node) return '';
  if (node.type === 'text') return typeof node.value === 'string' ? node.value : '';
  if (Array.isArray(node.children)) {
    return node.children.map(extractNodePlainText).join('');
  }
  return '';
}

function containsImgElement(node: any): boolean {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'element' && node.tagName === 'img') return true;
  if (Array.isArray(node.children)) {
    return node.children.some(containsImgElement);
  }
  return false;
}

function transformImageCaptionsInContainer(children: any[]): any[] {
  // First pass: split same-paragraph `<p><img ...>\nCaption</p>` and unwrap `<figure>`
  const expanded: any[] = [];
  for (const node of children) {
    if (node?.type === 'element' && node.tagName === 'figure' && Array.isArray(node.children)) {
      let mediaImg: Element | null = null;
      let captionChildren: any[] | null = null;
      let captionPos: any = undefined;
      for (const child of node.children) {
        if (child?.type === 'element' && child.tagName === 'img' && !mediaImg) {
          mediaImg = child;
        } else if (child?.type === 'element' && child.tagName === 'p' && !mediaImg) {
          const nonWs = (child.children || []).filter((c: any) => !isWhitespaceText(c));
          if (nonWs.length === 1 && nonWs[0].type === 'element' && nonWs[0].tagName === 'img') {
            mediaImg = nonWs[0];
          }
        } else if (child?.type === 'element' && child.tagName === 'figcaption') {
          captionChildren = child.children || [];
          captionPos = child.position || node.position;
        }
      }
      if (mediaImg && captionChildren && extractNodePlainText({ children: captionChildren }).trim().length > 0) {
        expanded.push({
          type: 'element',
          tagName: 'p',
          properties: { className: ['morph-p', 'morph-figure-media'] },
          children: [mediaImg],
          position: mediaImg.position || node.position,
        });
        expanded.push({
          type: 'element',
          tagName: 'p',
          properties: { className: ['morph-caption'] },
          children: captionChildren,
          position: captionPos,
        });
        continue;
      }
    }

    if (node?.type === 'element' && node.tagName === 'p' && Array.isArray(node.children)) {
      const kids = node.children;
      let firstIdx = 0;
      while (firstIdx < kids.length && isWhitespaceText(kids[firstIdx])) {
        firstIdx++;
      }
      const firstChild = kids[firstIdx];
      if (firstChild?.type === 'element' && firstChild.tagName === 'img') {
        const rest = kids.slice(firstIdx + 1);
        let captionRest: any[] | null = null;
        if (rest.length > 0) {
          if (rest[0]?.type === 'text' && typeof rest[0].value === 'string') {
            const nlMatch = rest[0].value.match(/^[^\S\r\n]*\r?\n([\s\S]*)$/);
            if (nlMatch) {
              const trimmedFirst = nlMatch[1].replace(/^[\s\u3000]+/, '');
              captionRest = [
                ...(trimmedFirst ? [{ ...rest[0], value: trimmedFirst }] : []),
                ...rest.slice(1),
              ];
            }
          } else {
            let brIdx = 0;
            while (brIdx < rest.length && isWhitespaceText(rest[brIdx])) {
              brIdx++;
            }
            if (rest[brIdx]?.type === 'element' && rest[brIdx].tagName === 'br') {
              const afterBr = rest.slice(brIdx + 1);
              if (afterBr[0]?.type === 'text' && typeof afterBr[0].value === 'string') {
                const trimmed = afterBr[0].value.replace(/^[\s\u3000]+/, '');
                captionRest = [
                  ...(trimmed ? [{ ...afterBr[0], value: trimmed }] : []),
                  ...afterBr.slice(1),
                ];
              } else {
                captionRest = afterBr;
              }
            }
          }
        }

        if (
          captionRest &&
          !captionRest.some(containsImgElement) &&
          extractNodePlainText({ children: captionRest }).trim().length > 0
        ) {
          const imgPos = firstChild.position;
          const nodePos = node.position;
          const capStartLine = imgPos
            ? Math.min(nodePos?.end.line ?? imgPos.end.line + 1, imgPos.end.line + 1)
            : nodePos?.start.line ?? 1;
          expanded.push({
            type: 'element',
            tagName: 'p',
            properties: {
              ...(node.properties || {}),
              className: ['morph-p', 'morph-figure-media'],
            },
            children: [firstChild],
            position: imgPos || nodePos,
          });
          expanded.push({
            type: 'element',
            tagName: 'p',
            properties: {
              className: ['morph-caption'],
            },
            children: captionRest,
            position: nodePos
              ? {
                  start: {
                    line: capStartLine,
                    column: 1,
                    offset:
                      imgPos?.end.offset !== undefined
                        ? imgPos.end.offset + 1
                        : nodePos.start.offset,
                  },
                  end: { ...nodePos.end },
                }
              : undefined,
          });
          continue;
        }
      }
    }

    expanded.push(node);
  }

  // Second pass: pair standalone `<p><img ...></p>` with adjacent caption block or image `title`
  const out: any[] = [];
  for (let i = 0; i < expanded.length; i++) {
    const node = expanded[i];
    if (node?.type === 'element' && node.tagName === 'p' && Array.isArray(node.children)) {
      const props = (node.properties || (node.properties = {})) as Record<string, unknown>;
      const clsList = Array.isArray(props.className) ? props.className : [];
      const nonWs = node.children.filter((c: any) => !isWhitespaceText(c));
      if (
        !clsList.includes('morph-figure-media') &&
        !clsList.includes('morph-caption') &&
        nonWs.length === 1 &&
        nonWs[0]?.type === 'element' &&
        nonWs[0].tagName === 'img'
      ) {
        const imgNode = nonWs[0] as Element;
        let nextIdx = i + 1;
        while (nextIdx < expanded.length && isWhitespaceText(expanded[nextIdx])) {
          nextIdx++;
        }
        const nextNode = expanded[nextIdx];
        let matchedAdjacentCaption = false;

        if (nextNode?.type === 'element' && !containsImgElement(nextNode)) {
          if (nextNode.tagName === 'figcaption') {
            ensureClass(props, 'morph-p');
            ensureClass(props, 'morph-figure-media');
            nextNode.tagName = 'p';
            nextNode.properties = {
              ...(nextNode.properties || {}),
              className: ['morph-caption'],
            };
            matchedAdjacentCaption = true;
          } else if (nextNode.tagName === 'p' && Array.isArray(nextNode.children)) {
            const nextProps = (nextNode.properties || {}) as Record<string, unknown>;
            const nextCls = Array.isArray(nextProps.className) ? nextProps.className : [];
            if (!nextCls.includes('morph-caption')) {
              const nextNonWs = nextNode.children.filter((c: any) => !isWhitespaceText(c));
              const nextPlain = extractNodePlainText(nextNode).trim();
              if (
                nextNonWs.length === 1 &&
                nextNonWs[0]?.type === 'element' &&
                nextNonWs[0].tagName === 'em' &&
                nextPlain.length > 0
              ) {
                ensureClass(props, 'morph-p');
                ensureClass(props, 'morph-figure-media');
                nextNode.children = nextNonWs[0].children || [];
                nextNode.properties = {
                  ...nextProps,
                  className: ['morph-caption'],
                };
                matchedAdjacentCaption = true;
              }
            }
          }
        }

        if (!matchedAdjacentCaption) {
          const imgProps = (imgNode.properties || {}) as Record<string, unknown>;
          const titleText = typeof imgProps.title === 'string' ? imgProps.title.trim() : '';
          const altText = typeof imgProps.alt === 'string' ? imgProps.alt.trim() : '';
          const captionText = titleText || altText;
          if (captionText.length > 0) {
            ensureClass(props, 'morph-p');
            ensureClass(props, 'morph-figure-media');
            out.push(node);
            out.push({
              type: 'element',
              tagName: 'p',
              properties: {
                className: ['morph-caption'],
              },
              children: [{ type: 'text', value: captionText }],
              position: imgNode.position || node.position,
            });
            continue;
          }
        }
      }
    }
    out.push(node);
  }

  return out;
}

function transformImageCaptions(tree: Root): void {
  if (Array.isArray(tree.children)) {
    tree.children = transformImageCaptionsInContainer(tree.children);
  }
}

function annotateExtraBlankLinesInContainer(children: Root['children'], markdown: string): void {
  const elements = children.filter((child): child is Element => child.type === 'element');
  for (const el of elements) {
    if (Array.isArray(el.children) && el.children.length > 0) {
      if (el.tagName === 'blockquote' || el.tagName === 'div') {
        annotateExtraBlankLinesInContainer(el.children as Root['children'], markdown);
      }
    }
  }

  for (let i = 0; i < elements.length - 1; i++) {
    const prevEl = elements[i];
    const nextEl = elements[i + 1];
    const prevEnd = prevEl.position?.end;
    const nextStart = nextEl.position?.start;
    if (!prevEnd || !nextStart) continue;

    let extraBlankLines = 0;
    if (
      typeof prevEnd.offset === 'number' &&
      typeof nextStart.offset === 'number' &&
      nextStart.offset > prevEnd.offset
    ) {
      const gapSlice = markdown.slice(prevEnd.offset, nextStart.offset);
      const lines = gapSlice.split(/\r?\n/);
      const middleLines = lines.slice(1, -1);
      const isPureBlankOrQuoteGap =
        middleLines.length >= 2 && middleLines.every((line) => /^[ \t\u3000]*>?[ \t\u3000]*$/.test(line));
      if (isPureBlankOrQuoteGap) {
        const newlineCount = lines.length - 1;
        extraBlankLines = Math.max(0, newlineCount - 2);
      }
    } else if (nextStart.line - prevEnd.line >= 3) {
      extraBlankLines = nextStart.line - prevEnd.line - 2;
    }

    if (extraBlankLines > 0) {
      const props = (prevEl.properties || (prevEl.properties = {})) as Record<string, unknown>;
      props.dataExtraBlankLines = String(extraBlankLines);
    }
  }
}

function annotateExtraBlankLines(tree: Root, markdown: string): void {
  if (Array.isArray(tree.children)) {
    annotateExtraBlankLinesInContainer(tree.children, markdown);
  }
}

const BASE_PROCESSOR = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkCjkFriendly)
  .use(normalizeOrphanTableHtml)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(stripTableInternalWhitespace)
  .use(rehypeRaw)
  .freeze();

function runCompile(
  markdown: string,
  options: CompileOptions,
  highlighter: any,
  isSyncFallback: boolean
): CompileResult {
  const diagnostics: DiagnosticItem[] = [];
  const sourceMap: SourceRangeEntry[] = [];

  const rawHast = BASE_PROCESSOR.runSync(BASE_PROCESSOR.parse(markdown)) as Root;

  // 1. Sanitize raw HTML and dangerous attributes
  sanitizeHast(rawHast, diagnostics);

  // 2. Transform GitHub-style Callouts
  transformCallouts(rawHast);

  // 3. Transform KaTeX math and Shiki code blocks
  transformMathAndCode(rawHast, options, highlighter, diagnostics, isSyncFallback);

  // 3.5. Transform Notion-style image captions
  transformImageCaptions(rawHast);

  // 3.6. Annotate extra blank lines between blocks
  annotateExtraBlankLines(rawHast, markdown);

  // 4. Map semantic classes & images
  visit(rawHast, 'element', (node: Element) => {
    const props = (node.properties || (node.properties = {})) as Record<string, unknown>;

    if (props.dataMathTex !== undefined || props['data-math-tex'] !== undefined) {
      return SKIP;
    }

    if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(node.tagName)) {
      ensureClass(props, `morph-${node.tagName}`);
    } else if (node.tagName === 'p') {
      const clsList = Array.isArray(props.className) ? props.className : [];
      if (!clsList.includes('morph-caption')) {
        ensureClass(props, 'morph-p');
      }
    } else if (node.tagName === 'blockquote') {
      ensureClass(props, 'morph-quote');
    } else if (node.tagName === 'ul' || node.tagName === 'ol') {
      ensureClass(props, 'morph-list');
    } else if (node.tagName === 'table') {
      ensureClass(props, 'morph-table');
    } else if (node.tagName === 'img') {
      ensureClass(props, 'morph-img');
      const src = typeof props.src === 'string' ? props.src : '';
      if (src.startsWith('morph-asset://')) {
        const assetId = src.replace('morph-asset://', '').split('?')[0].split('#')[0];
        props.dataMorphAssetId = assetId;
      }
    } else if (node.tagName === 'pre') {
      for (const child of node.children) {
        if (child.type === 'element' && child.tagName === 'img') {
          const imgProps = (child.properties || (child.properties = {})) as Record<string, unknown>;
          ensureClass(imgProps, 'morph-img');
          const src = typeof imgProps.src === 'string' ? imgProps.src : '';
          if (src.startsWith('morph-asset://')) {
            const assetId = src.replace('morph-asset://', '').split('?')[0].split('#')[0];
            imgProps.dataMorphAssetId = assetId;
          }
        }
      }
      return SKIP;
    }
  });

  // 5. Deterministic Node Identity & Source Range Mapping
  const occurrenceMap: Record<string, number> = {};

  visit(rawHast, 'element', (node: Element) => {
    const props = (node.properties || (node.properties = {})) as Record<string, unknown>;

    const isSemanticBlock = [
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'p', 'blockquote', 'div', 'pre', 'ul', 'ol', 'li', 'table', 'img', 'span',
    ].includes(node.tagName);

    if (isSemanticBlock && !props.dataNodeId) {
      const sig = computeSemanticSignature(node).trim() || node.tagName;
      const digest = hashString(sig).split('-')[1] || hashString(sig);
      const key = `${node.tagName}-${digest}`;
      const count = (occurrenceMap[key] = (occurrenceMap[key] || 0) + 1);
      const nodeId = `node-${node.tagName}-${digest}-${count}`;
      props.dataNodeId = nodeId;

      if (node.position) {
        const startLine = node.position.start.line;
        const endLine = node.position.end.line;
        props.dataSourceRange = `${startLine}-${endLine}`;

        sourceMap.push({
          nodeId,
          tagName: node.tagName,
          startLine,
          endLine,
          startOffset: node.position.start.offset,
          endOffset: node.position.end.offset,
        });
      }
    }

    if (node.tagName === 'pre' || props.dataMathTex !== undefined || props['data-math-tex'] !== undefined) {
      return SKIP;
    }
  });

  // Wrap in root container .morph-doc
  const wrappedHast: Root = {
    type: 'root',
    children: [
      {
        type: 'element',
        tagName: 'div',
        properties: {
          className: ['morph-doc'],
          dataNodeId: 'doc-root',
        },
        children: rawHast.children as Element[],
      },
    ],
  };

  const html = toHtml(wrappedHast);

  return {
    hast: wrappedHast,
    html,
    diagnostics,
    sourceMap,
  };
}
