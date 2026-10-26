import * as csstree from 'css-tree';
import type { DiagnosticItem, TargetId } from '../snapshot/types';
import { decodeCssEscapes } from '../ast/sanitize';

export interface PseudoRuleDescriptor {
  baseSelector: string;
  pseudo: 'before' | 'after';
  content: string | null;
  hasContentDeclaration: boolean;
  contentImportant: boolean;
  styles: Record<string, string>;
  declarations: Record<string, { value: string; important: boolean }>;
  specificity: [number, number, number];
  sourceOrder: number;
  layerOrder?: string;
  mediaConditions?: string[];
  supportsConditions?: string[];
}

export interface StyleAnalysisResult {
  sanitizedCss: string; propertyWhitelist: Set<string>; pseudoRules: PseudoRuleDescriptor[];
  diagnostics: DiagnosticItem[]; customProperties: Map<string, string>;
}

const DANGEROUS_PROTOCOLS = ['javascript:', 'vbscript:', 'data:text/html'];

const VALID_PSEUDO_CLASSES = new Set([
  'root', 'empty', 'first-child', 'last-child', 'only-child', 'first-of-type', 'last-of-type', 'only-of-type',
  'nth-child', 'nth-last-child', 'nth-of-type', 'nth-last-of-type', 'not', 'is', 'where', 'has', 'hover', 'active',
  'focus', 'focus-within', 'focus-visible', 'target', 'checked', 'disabled', 'enabled', 'required', 'optional',
  'valid', 'invalid', 'read-only', 'read-write', 'link', 'visited', 'any-link', 'before', 'after',
]);

function isDangerousCssValue(val: string): boolean {
  const decoded = decodeCssEscapes(val).toLowerCase().replace(/[\x00-\x1f\s]/g, '');
  return DANGEROUS_PROTOCOLS.some((proto) => decoded.includes(proto)) || decoded.includes('expression(') || decoded.includes('-moz-binding');
}

export function tokenizeLayerNames(input: string): string[][] | null {
  const names: string[][] = [];
  let current: string[] = [];
  let state: number = 0;
  csstree.tokenize(input, (type, start, end) => {
    if (state === -1 || type === csstree.tokenTypes.Comment) return;
    if (type === csstree.tokenTypes.WhiteSpace) {
      if (state === 1) state = 3;
      else if (state === 2) state = -1;
      return;
    }
    if (type === csstree.tokenTypes.Comma) {
      if (state === 1 || state === 3) {
        names.push(current);
        current = [];
        state = 0;
      } else state = -1;
      return;
    }
    const raw = input.slice(start, end);
    if ((state === 0 || state === 2) && type === csstree.tokenTypes.Ident) {
      current.push(`name:${decodeCssEscapes(raw)}`);
      state = 1;
    } else if (state === 1 && type === csstree.tokenTypes.Delim && raw === '.') {
      state = 2;
    } else state = -1;
  });
  if (state === -1 || state === 2 || (state === 0 && names.length > 0)) return null;
  if (state === 1 || state === 3) names.push(current);
  return names;
}

function extractLayerPreludeNames(prelude: csstree.CssNode | null): string[][] | null {
  if (!prelude) return [];
  if (prelude.type === 'Raw') return tokenizeLayerNames(prelude.value);
  const names: string[][] = [];
  let valid = true;
  csstree.walk(prelude, (child: any) => {
    if (child.type === 'Layer') {
      const parsed = tokenizeLayerNames(child.name);
      if (!parsed || parsed.length !== 1) valid = false;
      else names.push(parsed[0]);
    } else if (child.type === 'Raw') {
      const parsed = tokenizeLayerNames(child.value);
      if (!parsed) valid = false;
      else names.push(...parsed);
    }
  });
  return valid ? names : null;
}

export function resolveHierarchicalLayerOrder(
  layerPath: string[],
  layerMap: Map<string, number>,
  nextOrder: { val: number }
): string {
  if (layerPath.length === 0) return 'unlayered';
  const flatSegments = layerPath.flatMap((p) => {
    if (p.startsWith('@anon:') || p.startsWith('name:')) return [p];
    const parsed = tokenizeLayerNames(p);
    return parsed && parsed.length === 1 ? parsed[0] : [];
  });
  if (flatSegments.length === 0) return 'unlayered';
  const indices: number[] = [];
  let prefix = '';
  for (const seg of flatSegments) {
    prefix = prefix ? `${prefix}\0${seg}` : seg;
    if (!layerMap.has(prefix)) layerMap.set(prefix, nextOrder.val++);
    indices.push(layerMap.get(prefix)!);
  }
  return indices.join('.');
}

export function compareLayerOrder(a: string = 'unlayered', b: string = 'unlayered'): number {
  if (a === b) return 0;
  if (a === 'inline' || b === 'inline') return a === 'inline' ? 1 : -1;
  if (a === 'unlayered' || b === 'unlayered') return a === 'unlayered' ? 1 : -1;
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = i < pa.length ? pa[i] : Infinity;
    const vb = i < pb.length ? pb[i] : Infinity;
    if (va !== vb) return va < vb ? -1 : 1;
  }
  return 0;
}

const splitSelectorCache = new Map<string, string[]>();
const specificityCache = new Map<string, [number, number, number]>();
const analyzeStylesCache = new Map<string, StyleAnalysisResult>();

export function splitSelectorList(selector: string): string[] {
  const cached = splitSelectorCache.get(selector);
  if (cached) return cached;
  const parts: string[] = [];
  let current = '', parenDepth = 0, bracketDepth = 0, inQuote: string | null = null;
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];
    if (inQuote) {
      current += ch;
      if (ch === '\\' && i + 1 < selector.length) current += selector[++i];
      else if (ch === inQuote) inQuote = null;
    } else if (ch === '\\' && i + 1 < selector.length) {
      current += ch + selector[++i];
    } else if (ch === '"' || ch === "'") {
      inQuote = ch; current += ch;
    } else if (ch === '(') { parenDepth++; current += ch; }
    else if (ch === ')') { parenDepth--; current += ch; }
    else if (ch === '[') { bracketDepth++; current += ch; }
    else if (ch === ']') { bracketDepth--; current += ch; }
    else if (ch === ',' && parenDepth === 0 && bracketDepth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  if (splitSelectorCache.size >= 1024) {
    const firstKey = splitSelectorCache.keys().next().value;
    if (firstKey !== undefined) splitSelectorCache.delete(firstKey);
  }
  splitSelectorCache.set(selector, parts);
  return parts;
}

export function compareSpecificity(a: [number, number, number], b: [number, number, number]): number {
  return a[0] !== b[0] ? a[0] - b[0] : a[1] !== b[1] ? a[1] - b[1] : a[2] - b[2];
}

export function computeSelectorSpecificity(rawSelector: string): [number, number, number] {
  const cached = specificityCache.get(rawSelector);
  if (cached) return cached;
  let ast: csstree.CssNode;
  try {
    ast = csstree.parse(rawSelector, { context: 'selector' });
  } catch {
    return [0, 0, 0];
  }
  let a = 0, b = 0, c = 0;
  csstree.walk(ast, {
    enter(node: any) {
      if (node.type === 'IdSelector') a += 1;
      else if (node.type === 'ClassSelector') b += 1;
      else if (node.type === 'AttributeSelector') { b += 1; return csstree.walk.skip; }
      else if (node.type === 'TypeSelector') {
        if (node.name !== '*') c += 1;
      } else if (node.type === 'PseudoElementSelector') {
        c += 1;
        return csstree.walk.skip;
      } else if (node.type === 'PseudoClassSelector') {
        const name = node.name.toLowerCase();
        if (name === 'where') {
          return csstree.walk.skip;
        }
        if (name === 'is' || name === 'not' || name === 'has' || name === 'matches') {
          let maxSpec: [number, number, number] = [0, 0, 0];
          if (node.children) {
            node.children.forEach((child: any) => {
              if (child.type === 'Raw') {
                const subSels = csstree.generate(child).split(',');
                for (const s of subSels) {
                  const spec = computeSelectorSpecificity(s.trim());
                  if (compareSpecificity(spec, maxSpec) > 0) maxSpec = spec;
                }
              } else if (child.type === 'SelectorList') {
                child.children.forEach((selNode: any) => {
                  const spec = computeSelectorSpecificity(csstree.generate(selNode));
                  if (compareSpecificity(spec, maxSpec) > 0) maxSpec = spec;
                });
              } else if (child.type === 'Selector') {
                const spec = computeSelectorSpecificity(csstree.generate(child));
                if (compareSpecificity(spec, maxSpec) > 0) maxSpec = spec;
              }
            });
          }
          a += maxSpec[0];
          b += maxSpec[1];
          c += maxSpec[2];
          return csstree.walk.skip;
        }
        if (name === 'before' || name === 'after' || name === 'first-line' || name === 'first-letter') {
          c += 1;
          return csstree.walk.skip;
        }
        b += 1;
        if (node.children) {
          node.children.forEach((child: any) => {
            if (child.type === 'Nth' && (child as any).selector) {
              const branches = splitSelectorList(csstree.generate((child as any).selector));
              let maxSpec: [number, number, number] = [0, 0, 0];
              for (const b of branches) {
                const spec = computeSelectorSpecificity(b.trim());
                if (compareSpecificity(spec, maxSpec) > 0) maxSpec = spec;
              }
              a += maxSpec[0];
              b += maxSpec[1];
              c += maxSpec[2];
            }
          });
        }
        return csstree.walk.skip;
      }
    },
  });

  const specResult: [number, number, number] = [a, b, c];
  if (specificityCache.size >= 1024) {
    const firstKey = specificityCache.keys().next().value;
    if (firstKey !== undefined) specificityCache.delete(firstKey);
  }
  specificityCache.set(rawSelector, specResult);
  return specResult;
}

export function analyzeStyles(
  cssText: string,
  targetId?: TargetId
): StyleAnalysisResult {
  const cacheKey = `${targetId ?? ''}::${cssText}`;
  const cached = analyzeStylesCache.get(cacheKey);
  if (cached) {
    return {
      sanitizedCss: cached.sanitizedCss,
      propertyWhitelist: new Set(cached.propertyWhitelist),
      pseudoRules: [...cached.pseudoRules],
      diagnostics: cached.diagnostics.map((d) => ({ ...d })),
      customProperties: new Map(cached.customProperties),
    };
  }

  const diagnostics: DiagnosticItem[] = [];
  const propertyWhitelist = new Set<string>();
  const pseudoRules: PseudoRuleDescriptor[] = [];
  const customProperties = new Map<string, string>();

  let ast: csstree.CssNode;
  try {
    ast = csstree.parse(cssText, { parseAtrulePrelude: false, parseValue: true, parseCustomProperty: true });
  } catch (err) {
    diagnostics.push({ code: 'style/syntax-error', message: `CSS syntax error: ${(err as Error).message}`, severity: 'error' });
    return { sanitizedCss: '', propertyWhitelist, pseudoRules, diagnostics, customProperties };
  }

  // First pass: AtRules (@import, etc.)
  csstree.walk(ast, {
    visit: 'Atrule',
    enter(node, item, list) {
      const atName = decodeCssEscapes(node.name).toLowerCase();
      if (atName === 'import') {
        diagnostics.push({ code: 'style/disallowed-import', message: '@import rules are blocked in custom CSS.', severity: 'error' });
        list.remove(item);
      }
    },
  });

  // Second pass: Rules (scope checks & pseudo element extraction)
  const mediaStack: string[] = [];
  const supportsStack: string[] = [];
  const layerMap = new Map<string, number>();
  const nextOrder = { val: 1 };
  const layerPathStack: string[][] = [];
  let ruleOrder = 0;

  csstree.walk(ast, {
    enter(node: any, item: any, list: any) {
      if (node.type === 'Atrule') {
        const atName = decodeCssEscapes(node.name).toLowerCase();
        if (atName === 'media') {
          const cond = node.prelude ? csstree.generate(node.prelude).trim() : '';
          if (cond) mediaStack.push(cond);
        } else if (atName === 'supports') {
          const cond = node.prelude ? csstree.generate(node.prelude).trim() : '';
          if (cond) supportsStack.push(cond);
        } else if (atName === 'layer') {
          node.name = 'layer';
          const parsed = extractLayerPreludeNames(node.prelude);
          if (!node.block) {
            if (!parsed || parsed.length === 0) { list.remove(item); return csstree.walk.skip; }
            const base = layerPathStack.flat();
            for (const segs of parsed) resolveHierarchicalLayerOrder([...base, ...segs], layerMap, nextOrder);
          } else {
            if (!parsed || parsed.length > 1) { list.remove(item); return csstree.walk.skip; }
            const segs = parsed.length === 1 ? parsed[0] : [`@anon:${nextOrder.val++}`];
            layerPathStack.push(segs);
            resolveHierarchicalLayerOrder(layerPathStack.flat(), layerMap, nextOrder);
          }
        }
      }
      if (node.type === 'Rule') {
        ruleOrder++;
        const rawSelector = csstree.generate(node.prelude);

        // Check selector AST for out-of-scope elements (body, html, #app) and invalid pseudos
        let isOutOfScope = false;
        let isInvalidSelector = false;
        csstree.walk(node.prelude, (selNode) => {
          if (selNode.type === 'TypeSelector') {
            const name = decodeCssEscapes(selNode.name).toLowerCase();
            if (name === 'body' || name === 'html') isOutOfScope = true;
          } else if (selNode.type === 'IdSelector') {
            if (decodeCssEscapes(selNode.name).toLowerCase() === 'app') isOutOfScope = true;
          } else if (selNode.type === 'PseudoClassSelector') {
            if (!VALID_PSEUDO_CLASSES.has(decodeCssEscapes(selNode.name).toLowerCase())) isInvalidSelector = true;
          }
        });

        if (typeof document !== 'undefined' && typeof document.querySelector === 'function') {
          try { document.querySelector(rawSelector); } catch { isInvalidSelector = true; }
        }

        if (isInvalidSelector) {
          diagnostics.push({ code: 'style/unsupported-selector', message: `Unsupported or invalid selector "${rawSelector}".`, severity: 'warning', selector: rawSelector });
          list.remove(item);
          return;
        }

        if (isOutOfScope) {
          diagnostics.push({ code: 'style/out-of-scope-selector', message: `Selector "${rawSelector}" targets global document elements outside MorphMD content.`, severity: 'warning', selector: rawSelector });
          list.remove(item);
          return;
        }

        // Check for ::before or ::after pseudo elements across selector branches
        const selectors = splitSelectorList(rawSelector);
        const pseudoBranches: Array<{ match: RegExpMatchArray; sel: string }> = [];
        const normalBranches: string[] = [];
        for (const sel of selectors) {
          const m = sel.match(/^(.*?)(?:::|:)(before|after)$/i);
          if (m) pseudoBranches.push({ match: m, sel });
          else normalBranches.push(sel);
        }

        if (pseudoBranches.length > 0) {
          let hasContentDeclaration = false;
          let content: string | null = null;
          let contentImportant = false;
          const styles: Record<string, string> = {};
          const declarations: Record<string, { value: string; important: boolean }> = {};

          csstree.walk(node.block, {
            visit: 'Declaration',
            enter(decl) {
              const rawProp = decl.property;
              const prop = rawProp.startsWith('--') ? rawProp : decodeCssEscapes(rawProp).toLowerCase();
              const val = csstree.generate(decl.value).replace(/^[ \t\r\n\f]+|[ \t\r\n\f]+$/g, '');
              const decodedVal = decodeCssEscapes(val).replace(/^[ \t\r\n\f]+|[ \t\r\n\f]+$/g, '');
              const important = Boolean(decl.important);

              if (prop === 'content') {
                hasContentDeclaration = true;
                if (contentImportant && !important) return;
                contentImportant = important;
                const stringRegex = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g;
                let extracted = '';
                let matchStr: RegExpExecArray | null;
                let foundString = false;
                while ((matchStr = stringRegex.exec(val)) !== null) {
                  foundString = true;
                  const raw = matchStr[1] !== undefined ? matchStr[1] : matchStr[2];
                  extracted += decodeCssEscapes(raw);
                }
                if (foundString) content = extracted;
                else if (/^(none|normal)$/i.test(decodedVal)) content = null;
                else content = decodeCssEscapes(decodedVal.replace(/^["']|["']$/g, ''));
                return;
              }

              if (isDangerousCssValue(val)) {
                diagnostics.push({ code: 'style/dangerous-url', message: `Dangerous value in pseudo-element property "${prop}".`, severity: 'error', property: prop });
                return;
              }

              if (prop === 'position' && /\bfixed\b/i.test(decodedVal)) {
                diagnostics.push({ code: 'style/disallowed-position', message: 'position: fixed is disallowed on pseudo-elements.', severity: 'error', property: prop });
                return;
              }

              if (declarations[prop] && declarations[prop].important && !important) return;

              styles[prop] = val;
              declarations[prop] = { value: val, important };
              propertyWhitelist.add(prop);
            },
          });

          for (const { match: m } of pseudoBranches) {
            const baseSelector = m[1].trim() || '*';
            pseudoRules.push({
              baseSelector, pseudo: m[2].toLowerCase() as 'before' | 'after', content,
              hasContentDeclaration, contentImportant, styles: { ...styles }, declarations: { ...declarations },
              specificity: computeSelectorSpecificity(baseSelector), sourceOrder: ruleOrder,
              layerOrder: resolveHierarchicalLayerOrder(layerPathStack.flat(), layerMap, nextOrder),
              mediaConditions: [...mediaStack], supportsConditions: [...supportsStack],
            });
          }

          if (normalBranches.length > 0) {
            node.prelude = csstree.parse(normalBranches.join(', '), { context: 'selectorList' });
          } else {
            list.remove(item);
            return;
          }
        }
      }
    },
    leave(node: any) {
      if (node.type === 'Atrule') {
        const atName = decodeCssEscapes(node.name).toLowerCase();
        if (atName === 'media') mediaStack.pop();
        else if (atName === 'supports') supportsStack.pop();
        else if (atName === 'layer' && node.block) layerPathStack.pop();
      }
    },
  });

  // Third pass: Declarations on retained valid rules
  csstree.walk(ast, {
    visit: 'Declaration',
    enter(node, item, list) {
      const isCustomProp = node.property.startsWith('--');
      const prop = isCustomProp ? node.property : decodeCssEscapes(node.property).toLowerCase();
      node.property = prop;
      const val = csstree.generate(node.value).replace(/^[ \t\r\n\f]+|[ \t\r\n\f]+$/g, '');
      const decodedVal = decodeCssEscapes(val).replace(/^[ \t\r\n\f]+|[ \t\r\n\f]+$/g, '');

      // Custom properties (--*)
      if (isCustomProp) {
        if (isDangerousCssValue(val)) {
          diagnostics.push({ code: 'style/dangerous-url', message: `Dangerous URL in custom property "${prop}".`, severity: 'error', property: prop });
          list.remove(item);
          return;
        }
        customProperties.set(prop, val);
        return;
      }

      // Dangerous values (javascript, expression, etc.)
      if (isDangerousCssValue(val)) {
        diagnostics.push({ code: 'style/dangerous-url', message: `Dangerous URL or expression in property "${prop}".`, severity: 'error', property: prop });
        list.remove(item);
        return;
      }

      // position: fixed
      if (prop === 'position' && /\bfixed\b/i.test(decodedVal)) {
        diagnostics.push({ code: 'style/disallowed-position', message: 'position: fixed is disallowed.', severity: 'error', property: prop });
        list.remove(item);
        return;
      }

      // cards overflow: hidden / clip (including two-axis overflow: hidden visible)
      if (targetId === 'cards' && (prop === 'overflow' || prop === 'overflow-x' || prop === 'overflow-y') && /\b(hidden|clip)\b/i.test(decodedVal)) {
        diagnostics.push({ code: 'style/unauthorized-overflow', message: 'Unauthorized overflow: hidden in cards view can cause content clipping.', severity: 'warning', property: prop });
        list.remove(item);
        return;
      }

      propertyWhitelist.add(prop);
    },
  });

  const sanitizedCss = csstree.generate(ast);
  const result: StyleAnalysisResult = {
    sanitizedCss,
    propertyWhitelist,
    pseudoRules,
    diagnostics,
    customProperties,
  };
  if (analyzeStylesCache.size >= 256) {
    const firstKey = analyzeStylesCache.keys().next().value;
    if (firstKey !== undefined) analyzeStylesCache.delete(firstKey);
  }
  analyzeStylesCache.set(cacheKey, {
    sanitizedCss,
    propertyWhitelist: new Set(propertyWhitelist),
    pseudoRules: [...pseudoRules],
    diagnostics: diagnostics.map((d) => ({ ...d })),
    customProperties: new Map(customProperties),
  });
  return result;
}
