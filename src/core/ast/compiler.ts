import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import { visit } from 'unist-util-visit';
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

function runCompile(
  markdown: string,
  options: CompileOptions,
  highlighter: any,
  isSyncFallback: boolean
): CompileResult {
  const diagnostics: DiagnosticItem[] = [];
  const sourceMap: SourceRangeEntry[] = [];

  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .use(normalizeOrphanTableHtml)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw);

  const rawHast = processor.runSync(processor.parse(markdown)) as Root;

  // 1. Sanitize raw HTML and dangerous attributes
  sanitizeHast(rawHast, diagnostics);

  // 2. Transform GitHub-style Callouts
  transformCallouts(rawHast);

  // 3. Transform KaTeX math and Shiki code blocks
  transformMathAndCode(rawHast, options, highlighter, diagnostics, isSyncFallback);

  // 4. Map semantic classes & images
  visit(rawHast, 'element', (node: Element) => {
    const props = (node.properties || (node.properties = {})) as Record<string, unknown>;

    if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(node.tagName)) {
      ensureClass(props, `morph-${node.tagName}`);
    } else if (node.tagName === 'p') {
      ensureClass(props, 'morph-p');
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
