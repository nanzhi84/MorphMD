import { visit } from 'unist-util-visit';
import { fromHtml } from 'hast-util-from-html';
import katex from 'katex';
import { createHighlighter, type HighlighterGeneric, type BundledTheme, type BundledLanguage } from 'shiki';
import type { Root, Element } from 'hast';
import type { DiagnosticItem } from '../snapshot/types';
import { hashString, globalHeavyBlockCache } from './cache';
import type { CompileOptions } from './types';

let cachedHighlighter: HighlighterGeneric<BundledLanguage, BundledTheme> | null = null;
let highlighterPromise: Promise<HighlighterGeneric<BundledLanguage, BundledTheme>> | null = null;

const SUPPORTED_LANGS: BundledLanguage[] = [
  'javascript', 'typescript', 'python', 'html', 'css', 'json',
  'markdown', 'bash', 'sh', 'yaml', 'sql', 'go', 'rust', 'diff',
];

const SUPPORTED_THEMES: BundledTheme[] = [
  'github-light',
  'github-dark',
  'vitesse-light',
  'rose-pine-dawn',
  'gruvbox-light-soft',
];

export async function initHighlighter(): Promise<HighlighterGeneric<BundledLanguage, BundledTheme>> {
  if (cachedHighlighter) return cachedHighlighter;
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      langs: SUPPORTED_LANGS,
      themes: SUPPORTED_THEMES,
    }).then((hl) => {
      cachedHighlighter = hl;
      return hl;
    });
  }
  return highlighterPromise;
}

export function getLoadedHighlighter(): HighlighterGeneric<BundledLanguage, BundledTheme> | null {
  return cachedHighlighter;
}

function extractRawText(node: any): string {
  if (!node) return '';
  if (node.type === 'text') return node.value || '';
  if (Array.isArray(node.children)) {
    return node.children.map(extractRawText).join('');
  }
  return '';
}

function stripDescendantPositions(el: Element): void {
  for (const child of el.children) {
    if (child.type === 'element') {
      delete child.position;
      if (child.properties) {
        delete child.properties.dataNodeId;
        delete child.properties.dataSourceRange;
        if (typeof child.properties.style === 'string') {
          child.properties.style = child.properties.style.replace(
            /#([0-9a-fA-F]{6})[0-9a-fA-F]{2}\b/g,
            '#$1'
          );
        }
      }
      stripDescendantPositions(child);
    }
  }
}

export function transformMathAndCode(
  tree: Root,
  options: CompileOptions,
  highlighter: HighlighterGeneric<BundledLanguage, BundledTheme> | null,
  diagnostics: DiagnosticItem[],
  isSyncFallback: boolean
): void {
  const cache = options.cache !== undefined ? options.cache : globalHeavyBlockCache;
  const themeKey = options.themeKey || 'github-light';
  const targetCapabilityVersion = options.targetCapabilityVersion || 'v1';

  // 1. Math formulas
  visit(tree, 'element', (node: Element, index, parent) => {
    if (parent && typeof index === 'number') {
      const classList = (Array.isArray(node.properties?.className)
        ? node.properties?.className
        : typeof node.properties?.className === 'string'
        ? [node.properties.className]
        : []) as string[];

      const isInlineMath = classList.includes('math-inline');
      const isDisplayMath =
        classList.includes('math-display') ||
        (node.tagName === 'pre' &&
          node.children.length === 1 &&
          node.children[0].type === 'element' &&
          ((node.children[0].properties?.className as string[]) || []).includes('math-display'));

      if (isInlineMath || isDisplayMath) {
        const displayMode = isDisplayMath;
        const rawTex = extractRawText(node).trim();
        const contentHash = hashString(rawTex);
        const modeKey = displayMode ? 'display' : 'inline';

        let mathHast: Element | undefined = cache?.get<Element>(
          'math',
          contentHash,
          modeKey,
          themeKey,
          targetCapabilityVersion
        );

        if (!mathHast) {
          let hasRenderError = false;
          let renderedHtml = '';
          try {
            renderedHtml = katex.renderToString(rawTex, {
              displayMode,
              throwOnError: true,
              output: 'mathml',
            });
          } catch (err) {
            hasRenderError = true;
            diagnostics.push({
              code: 'math/invalid-formula',
              message: `Invalid KaTeX formula: ${(err as Error).message}`,
              severity: 'warning',
              sourceRange: node.position ? [node.position.start.line, node.position.end.line] : undefined,
            });
            try {
              renderedHtml = katex.renderToString(rawTex, {
                displayMode,
                throwOnError: false,
                output: 'mathml',
              });
            } catch {
              renderedHtml = `<span class="katex-error">${rawTex}</span>`;
            }
          }

          const fragment = fromHtml(renderedHtml, { fragment: true });
          mathHast = {
            type: 'element',
            tagName: displayMode ? 'div' : 'span',
            properties: {
              className: ['morph-math', displayMode ? 'morph-math-display' : 'morph-math-inline'],
              dataMathTex: rawTex,
            },
            children: fragment.children as Element[],
          };
          stripDescendantPositions(mathHast);

          if (cache && !hasRenderError) {
            cache.set('math', contentHash, modeKey, themeKey, targetCapabilityVersion, mathHast);
          }
        }

        const mathNodeClone: Element = {
          ...mathHast,
          properties: {
            ...mathHast.properties,
            className: Array.isArray(mathHast.properties?.className)
              ? [...mathHast.properties.className]
              : mathHast.properties?.className,
          },
          children: [...mathHast.children],
          position: node.position,
        };

        parent.children[index] = mathNodeClone;
      }
    }
  });

  // 2. Code blocks
  visit(tree, 'element', (node: Element, index, parent) => {
    if (node.tagName === 'pre' && parent && typeof index === 'number') {
      const codeChild = node.children.find(
        (c): c is Element => c.type === 'element' && c.tagName === 'code'
      );
      if (codeChild) {
        const classList = (Array.isArray(codeChild.properties?.className)
          ? codeChild.properties.className
          : typeof codeChild.properties?.className === 'string'
          ? [codeChild.properties.className]
          : []) as string[];

        if (classList.includes('math-display')) return;

        const langMatch = classList.find((c) => c.startsWith('language-'));
        const lang = langMatch ? langMatch.replace('language-', '') : '';
        const rawCode = extractRawText(node);
        const extraMediaChildren = node.children.filter(
          (c): c is Element => c.type === 'element' && c.tagName === 'img'
        );
        const contentHash = hashString(rawCode);

        const isSupportedTheme = SUPPORTED_THEMES.includes(themeKey as BundledTheme);
        const supportedTheme = isSupportedTheme ? (themeKey as BundledTheme) : 'github-light';
        const isSupportedLang = SUPPORTED_LANGS.includes(lang as BundledLanguage);

        const startLine = node.position?.start?.line ?? 1;
        const endLine = node.position?.end?.line ?? startLine;
        const nodeId = typeof node.properties?.dataNodeId === 'string' ? node.properties.dataNodeId : undefined;

        if (lang && !isSupportedLang) {
          diagnostics.push({
            code: 'code/unknown-language',
            message: `Unknown code language "${lang}".`,
            severity: 'warning',
            sourceRange: [startLine, endLine],
            nodeId,
          });
        }

        if (themeKey && !isSupportedTheme) {
          diagnostics.push({
            code: 'code/unknown-theme',
            message: `Unknown code theme "${themeKey}". Falling back to github-light.`,
            severity: 'warning',
            sourceRange: [startLine, endLine],
            nodeId,
          });
        }

        let codeHast: Element | undefined = cache?.get<Element>(
          'code',
          contentHash,
          lang || 'text',
          themeKey,
          targetCapabilityVersion
        );

        if (!codeHast) {
          if (highlighter && isSupportedLang) {
            try {
              const hlTree = highlighter.codeToHast(rawCode, {
                lang: lang as BundledLanguage,
                theme: supportedTheme,
              });
              const preElement = hlTree.children[0] as Element;

              // Merge properties.class and properties.className to avoid duplicate class attribute
              const existingClasses = (
                Array.isArray(preElement.properties.className)
                  ? preElement.properties.className
                  : typeof preElement.properties.className === 'string'
                  ? [preElement.properties.className]
                  : typeof preElement.properties.class === 'string'
                  ? preElement.properties.class.split(/\s+/)
                  : []
              ) as string[];

              if (!existingClasses.includes('morph-code')) {
                existingClasses.push('morph-code');
              }
              preElement.properties.className = existingClasses;
              delete preElement.properties.class;
              preElement.properties.dataCodeLang = lang || 'text';
              stripDescendantPositions(preElement);

              codeHast = preElement;
              if (cache) {
                cache.set('code', contentHash, lang || 'text', themeKey, targetCapabilityVersion, codeHast);
              }
            } catch (err: any) {
              diagnostics.push({
                code: 'code/highlight-failed',
                message: err?.message || 'Code highlighting failed; degraded to plain code block.',
                severity: 'warning',
                sourceRange: [startLine, endLine],
                nodeId,
              });
            }
          }

          if (!codeHast) {
            // Synchronous fallback
            codeHast = {
              type: 'element',
              tagName: 'pre',
              properties: {
                className: ['morph-code'],
                dataCodeLang: lang || 'text',
              },
              children: [
                {
                  type: 'element',
                  tagName: 'code',
                  properties: {
                    className: [lang ? `language-${lang}` : 'language-text'],
                  },
                  children: [{ type: 'text', value: rawCode }],
                },
              ],
            };
            // R20: Do NOT cache plain fallback if Shiki highlighter was unavailable during sync compile!
            if (cache && !isSyncFallback) {
              cache.set('code', contentHash, lang || 'text', themeKey, targetCapabilityVersion, codeHast);
            }
          }
        }

        const codeNodeClone: Element = {
          ...codeHast,
          properties: {
            ...codeHast.properties,
            className: Array.isArray(codeHast.properties?.className)
              ? [...codeHast.properties.className]
              : codeHast.properties?.className,
          },
          children: extraMediaChildren.length > 0
            ? [...codeHast.children, ...extraMediaChildren]
            : [...codeHast.children],
          position: node.position,
        };
        parent.children[index] = codeNodeClone;
      }
    }
  });
}
