import type { AdapterCapabilities, DiagnosticItem, TargetId } from '../snapshot/types';
import { splitSelectorList, computeSelectorSpecificity, tokenizeLayerNames, resolveHierarchicalLayerOrder, compareLayerOrder } from './analyzer';
import { decodeCssEscapes } from '../ast/sanitize';

export const DEFAULT_ALLOWED_STYLE_PROPS = new Set([
  'color',
  'background',
  'background-color',
  'font-size',
  'font-weight',
  'font-style',
  'font-family',
  'line-height',
  'letter-spacing',
  'text-align',
  'text-decoration',
  'padding', 'padding-top', 'padding-bottom', 'padding-left', 'padding-right',
  'margin', 'margin-top', 'margin-bottom', 'margin-left', 'margin-right',
  'border', 'border-top', 'border-bottom', 'border-left', 'border-right',
  'border-color', 'border-width', 'border-style', 'border-radius', 'border-collapse',
  'box-sizing',
  'display',
  'width',
  'max-width',
  'height',
  'max-height',
  'vertical-align',
  'word-break',
  'overflow-wrap',
  'box-shadow',
  'opacity',
]);

export function getDefaultCapabilities(targetId: TargetId): AdapterCapabilities {
  switch (targetId) {
    case 'wechat':
      return {
        targetId: 'wechat',
        allowInlineStyles: true,
        allowedStyleProps: DEFAULT_ALLOWED_STYLE_PROPS,
        supportedElements: new Set([
          'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
          'p', 'blockquote', 'ul', 'ol', 'li', 'table',
          'thead', 'tbody', 'tr', 'th', 'td', 'pre', 'code',
          'span', 'strong', 'em', 'del', 'a', 'img', 'hr', 'br',
        ]),
        rasterizeBlocks: new Set(['math', 'svg']),
        imageTransport: 'inline-data-url',
      };

    case 'x-article':
      return {
        targetId: 'x-article',
        allowInlineStyles: false,
        allowedStyleProps: undefined,
        supportedElements: new Set([
          'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
          'p', 'blockquote', 'ul', 'ol', 'li', 'pre', 'code',
          'span', 'strong', 'em', 'a', 'img', 'hr', 'br',
        ]),
        rasterizeBlocks: new Set(['table', 'math', 'code', 'svg']),
        imageTransport: 'remote-https',
      };

    case 'cards':
      return {
        targetId: 'cards',
        allowInlineStyles: true,
        allowedStyleProps: DEFAULT_ALLOWED_STYLE_PROPS,
        supportedElements: new Set([
          'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
          'p', 'blockquote', 'ul', 'ol', 'li', 'table',
          'thead', 'tbody', 'tr', 'th', 'td', 'pre', 'code',
          'span', 'strong', 'em', 'del', 'a', 'img', 'hr', 'br',
          'header', 'footer', 'section',
        ]),
        rasterizeBlocks: new Set(['math', 'svg']),
        imageTransport: 'inline-data-url',
      };
  }
}

export function guardTargetCapabilities(
  _customCssAstProps: Set<string>,
  capabilities: AdapterCapabilities,
  tokensOverride?: Record<string, string>
): DiagnosticItem[] {
  const diagnostics: DiagnosticItem[] = [];

  if (!capabilities.allowInlineStyles) {
    if (tokensOverride && Object.keys(tokensOverride).length > 0) {
      diagnostics.push({
        code: 'style/platform-unsupported-tokens',
        message: `Custom design tokens cannot take effect on native text in ${capabilities.targetId}.`,
        severity: 'info',
        targetId: capabilities.targetId,
      });
    }
  }

  return diagnostics;
}

export interface LayerCandidate {
  value: string;
  layerOrder: string;
  important: boolean;
}

type VarEvalResult = { ok: true; value: string } | { ok: false; cycleTarget?: string };

export function trimCssWhitespace(val: string): string {
  return val.replace(/^(?:[ \t\r\n\f]|\/\*[\s\S]*?\*\/)+|(?:[ \t\r\n\f]|\/\*[\s\S]*?\*\/)+$/g, '');
}

function normalizeCssKeyword(val: string): string {
  return decodeCssEscapes(trimCssWhitespace(val)).toLowerCase();
}

function evalCandidateProperty(
  prop: string,
  rawLocal: Record<string, string>,
  inherited: Record<string, string>,
  computedLookup: ((name: string) => string) | undefined,
  stack: string[],
  rawLocalLayers?: Record<string, LayerCandidate[]>
): VarEvalResult {
  const candidates: LayerCandidate[] =
    rawLocalLayers?.[prop] ||
    (rawLocal[prop] !== undefined ? [{ value: rawLocal[prop], layerOrder: 'unlayered', important: false }] : []);
  const rejectedLayers = new Set<string>();
  let minRejectedImportantLayer = '';
  for (const cand of candidates) {
    if (rejectedLayers.has(cand.layerOrder)) continue;
    if (minRejectedImportantLayer !== '' && compareLayerOrder(cand.layerOrder, minRejectedImportantLayer) >= 0) {
      continue;
    }
    const kw = normalizeCssKeyword(cand.value);
    if (kw === 'revert-layer') {
      rejectedLayers.add(cand.layerOrder);
      if (cand.important) {
        minRejectedImportantLayer =
          minRejectedImportantLayer === '' || compareLayerOrder(cand.layerOrder, minRejectedImportantLayer) < 0
            ? cand.layerOrder
            : minRejectedImportantLayer;
      }
      continue;
    }
    if (kw === 'initial') return { ok: false };
    if (kw === 'inherit' || kw === 'unset' || kw === 'revert') {
      return Object.prototype.hasOwnProperty.call(inherited, prop)
        ? { ok: true, value: inherited[prop] }
        : { ok: false };
    }
    const sub = evalVarExpression(cand.value, rawLocal, inherited, computedLookup, [...stack, prop], rawLocalLayers);
    if (!sub.ok) {
      return sub.cycleTarget === prop ? { ok: false } : sub;
    }
    const subKw = normalizeCssKeyword(sub.value);
    if (subKw === 'revert-layer') {
      rejectedLayers.add(cand.layerOrder);
      if (cand.important) {
        minRejectedImportantLayer =
          minRejectedImportantLayer === '' || compareLayerOrder(cand.layerOrder, minRejectedImportantLayer) < 0
            ? cand.layerOrder
            : minRejectedImportantLayer;
      }
      continue;
    }
    if (subKw === 'initial') return { ok: false };
    if (subKw === 'inherit' || subKw === 'unset' || subKw === 'revert') {
      return Object.prototype.hasOwnProperty.call(inherited, prop)
        ? { ok: true, value: inherited[prop] }
        : { ok: false };
    }
    return sub;
  }
  return Object.prototype.hasOwnProperty.call(inherited, prop)
    ? { ok: true, value: inherited[prop] }
    : { ok: false };
}

function evalVarExpression(
  expr: string,
  rawLocal: Record<string, string>,
  inherited: Record<string, string>,
  computedLookup: ((name: string) => string) | undefined,
  stack: string[],
  rawLocalLayers?: Record<string, LayerCandidate[]>
): VarEvalResult {
  if (expr === undefined || expr === null) return { ok: false };
  if (!expr.includes('var(')) return { ok: true, value: expr };
  let out = '';
  let i = 0;
  while (i < expr.length) {
    const idx = expr.indexOf('var(', i);
    if (idx === -1) {
      out += expr.slice(i);
      break;
    }
    out += expr.slice(i, idx);
    let depth = 1;
    let j = idx + 4;
    while (j < expr.length && depth > 0) {
      if (expr[j] === '(') depth++;
      else if (expr[j] === ')') depth--;
      j++;
    }
    if (depth !== 0) return { ok: false };
    const inner = expr.slice(idx + 4, j - 1);
    const commaIdx = inner.indexOf(',');
    const varName = trimCssWhitespace(commaIdx === -1 ? inner : inner.slice(0, commaIdx));
    if (!varName.startsWith('--')) return { ok: false };
    const hasFallback = commaIdx !== -1;
    const rawFallback = hasFallback ? trimCssWhitespace(inner.slice(commaIdx + 1)) : '';

    let varRes: VarEvalResult;
    if (stack.includes(varName)) {
      varRes = { ok: false, cycleTarget: varName };
    } else if (Object.prototype.hasOwnProperty.call(rawLocal, varName)) {
      varRes = evalCandidateProperty(varName, rawLocal, inherited, computedLookup, stack, rawLocalLayers);
    } else if (Object.prototype.hasOwnProperty.call(inherited, varName)) {
      varRes = { ok: true, value: inherited[varName] };
    } else {
      const inhVal = computedLookup ? computedLookup(varName) : '';
      varRes = inhVal ? { ok: true, value: inhVal } : { ok: false };
    }

    if (varRes.ok) {
      out += varRes.value;
    } else if (varRes.cycleTarget) {
      return varRes;
    } else if (hasFallback) {
      if (rawFallback) {
        const fbRes = evalVarExpression(rawFallback, rawLocal, inherited, computedLookup, stack, rawLocalLayers);
        if (!fbRes.ok) return fbRes;
        out += fbRes.value;
      }
    } else {
      return { ok: false };
    }
    i = j;
  }
  return { ok: true, value: out };
}

export function resolveScopeCustomProperties(
  rawLocal: Record<string, string>,
  inherited: Record<string, string>,
  rawLocalLayers?: Record<string, LayerCandidate[]>
): Record<string, string> {
  const nextScope: Record<string, string> = { ...inherited };
  for (const prop of Object.keys(rawLocal)) {
    const res = evalCandidateProperty(prop, rawLocal, inherited, undefined, [prop], rawLocalLayers);
    if (res.ok) {
      nextScope[prop] = res.value;
    } else {
      delete nextScope[prop];
    }
  }
  return nextScope;
}

export function resolveCssVariables(
  val: string,
  vars: Record<string, string>,
  computedLookup?: (name: string) => string
): string {
  if (!val || !val.includes('var(')) return val;
  const res = evalVarExpression(val, vars, {}, computedLookup, []);
  return res.ok ? res.value : '';
}

export function computeElementVarScope(
  el: Element,
  rootContainer: Element,
  _doc: Document,
  rules: CSSStyleRule[],
  allTokens: Record<string, string>
): Record<string, string> {
  const chain: Element[] = [];
  let currEl: Element | null = el;
  while (currEl && currEl.tagName.toLowerCase() !== 'body') {
    chain.unshift(currEl);
    if (currEl === rootContainer) break;
    currEl = currEl.parentElement;
  }
  if (_doc?.documentElement && !chain.includes(_doc.documentElement)) {
    chain.unshift(_doc.documentElement);
  }

  let currentScope: Record<string, string> = resolveScopeCustomProperties(allTokens, {});

  for (const ancestor of chain) {
    const customByLayer = new Map<
      string,
      Map<string, { value: string; priority: { important: boolean; isInline?: boolean; layerOrder?: string; specificity: [number, number, number]; sourceOrder: number } }>
    >();

    for (let ruleIdx = 0; ruleIdx < rules.length; ruleIdx++) {
      const cr = rules[ruleIdx] as any;
      if (!cr.selectorText || !cr.style) continue;
      try {
        if (ancestor.matches(cr.selectorText)) {
          let matchedSpec: [number, number, number] = [0, 0, 0];
          const branches = splitSelectorList(cr.selectorText);
          for (const branch of branches) {
            try {
              if (ancestor.matches(branch.trim())) {
                const spec = computeSelectorSpecificity(branch.trim());
                if (
                  comparePriority(
                    { important: false, specificity: spec, sourceOrder: 0 },
                    { important: false, specificity: matchedSpec, sourceOrder: 0 }
                  ) > 0
                ) {
                  matchedSpec = spec;
                }
              }
            } catch {}
          }

          const layerOrder: string = cr.__morphLayerOrder ?? 'unlayered';
          for (let k = 0; k < cr.style.length; k++) {
            const prop = cr.style[k];
            if (prop.startsWith('--')) {
              const important = cr.style.getPropertyPriority(prop) === 'important';
              const key = `${layerOrder}_${important ? 1 : 0}`;
              const candPriority = { important, isInline: false, layerOrder, specificity: matchedSpec, sourceOrder: ruleIdx };
              if (!customByLayer.has(prop)) customByLayer.set(prop, new Map());
              const layerDecls = customByLayer.get(prop)!;
              const existing = layerDecls.get(key);
              if (!existing || comparePriority(candPriority, existing.priority) >= 0) {
                layerDecls.set(key, { value: trimCssWhitespace(cr.style.getPropertyValue(prop)), priority: candPriority });
              }
            }
          }
        }
      } catch {}
    }

    const s = (ancestor as HTMLElement).style;
    if (s) {
      for (let k = 0; k < s.length; k++) {
        const prop = s[k];
        if (prop.startsWith('--')) {
          const important = s.getPropertyPriority(prop) === 'important';
          const layerOrder = 'inline';
          const key = `${layerOrder}_${important ? 1 : 0}`;
          const candPriority = { important, isInline: true, layerOrder, specificity: [1000, 0, 0] as [number, number, number], sourceOrder: 999999 };
          if (!customByLayer.has(prop)) customByLayer.set(prop, new Map());
          const layerDecls = customByLayer.get(prop)!;
          const existing = layerDecls.get(key);
          if (!existing || comparePriority(candPriority, existing.priority) >= 0) {
            layerDecls.set(key, { value: trimCssWhitespace(s.getPropertyValue(prop)), priority: candPriority });
          }
        }
      }
    }

    const rawLocal: Record<string, string> = {};
    const rawLocalLayers: Record<string, LayerCandidate[]> = {};
    for (const [prop, layerDecls] of customByLayer.entries()) {
      const sorted = Array.from(layerDecls.values())
        .sort((a, b) => comparePriority(b.priority, a.priority));
      rawLocalLayers[prop] = sorted.map((x) => ({
        value: x.value,
        layerOrder: x.priority.layerOrder ?? 'unlayered',
        important: x.priority.important,
      }));
      rawLocal[prop] = sorted[0].value;
    }
    currentScope = resolveScopeCustomProperties(rawLocal, currentScope, rawLocalLayers);
  }

  return currentScope;
}

export function isRasterBlockOrDescendant(el: Element, capabilities: AdapterCapabilities): boolean {
  if (!capabilities.rasterizeBlocks || capabilities.rasterizeBlocks.size === 0) {
    return false;
  }
  let curr: Element | null = el;
  while (curr && curr.tagName.toLowerCase() !== 'body') {
    const tagName = curr.tagName.toLowerCase();
    const classList = Array.from(curr.classList);
    if (tagName === 'table' && capabilities.rasterizeBlocks.has('table')) return true;
    if ((tagName === 'pre' || classList.includes('morph-code')) && capabilities.rasterizeBlocks.has('code')) return true;
    if (classList.includes('morph-math') && capabilities.rasterizeBlocks.has('math')) return true;
    if (tagName === 'svg' && capabilities.rasterizeBlocks.has('svg')) return true;
    curr = curr.parentElement;
  }
  return false;
}

export function comparePriority(
  a: { important: boolean; isInline?: boolean; layerOrder?: string; specificity: [number, number, number]; sourceOrder: number },
  b: { important: boolean; isInline?: boolean; layerOrder?: string; specificity: [number, number, number]; sourceOrder: number }
): number {
  if (a.important !== b.important) return a.important ? 1 : -1;
  if (Boolean(a.isInline) !== Boolean(b.isInline)) return a.isInline ? 1 : -1;
  const la = a.layerOrder ?? 'unlayered';
  const lb = b.layerOrder ?? 'unlayered';
  if (la !== lb) {
    const cmp = compareLayerOrder(la, lb);
    if (cmp !== 0) return a.important ? -cmp : cmp;
  }
  if (a.specificity[0] !== b.specificity[0]) return a.specificity[0] - b.specificity[0];
  if (a.specificity[1] !== b.specificity[1]) return a.specificity[1] - b.specificity[1];
  if (a.specificity[2] !== b.specificity[2]) return a.specificity[2] - b.specificity[2];
  return a.sourceOrder - b.sourceOrder;
}

export function matchesSupports(cond: string | undefined, win: any, doc: Document): boolean {
  if (!cond) return true;
  if (win?.CSS?.supports) {
    try {
      return win.CSS.supports(cond);
    } catch {}
  }
  const trimmed = cond.trim();
  if (trimmed.startsWith('not ') || trimmed.startsWith('not(')) {
    const inner = trimmed.replace(/^not\s*\(?/, '').replace(/\)$/, '').trim();
    return !matchesSupports(inner, win, doc);
  }
  const m = trimmed.match(/^\s*\(\s*([a-zA-Z0-9_-]+)\s*:\s*(.+?)\s*\)\s*$/);
  if (m) {
    const prop = m[1];
    const val = m[2];
    const testEl = doc.createElement('div');
    try {
      testEl.style.setProperty(prop, val);
      return Boolean(testEl.style.getPropertyValue(prop));
    } catch {
      return false;
    }
  }
  return false;
}

export function flattenRules(
  ruleList: CSSRuleList | CSSRule[],
  win: any,
  doc: Document,
  layerMap = new Map<string, number>(),
  nextOrder = { val: 1 },
  parentPath: string[] = []
): CSSStyleRule[] {
  const result: CSSStyleRule[] = [];
  const currentLayerOrder = resolveHierarchicalLayerOrder(parentPath, layerMap, nextOrder);
  for (let i = 0; i < ruleList.length; i++) {
    const r = ruleList[i] as any;
    if ('nameList' in r && Array.isArray(r.nameList)) {
      for (const n of r.nameList) {
        const parsed = tokenizeLayerNames(n);
        if (parsed && parsed.length === 1) {
          resolveHierarchicalLayerOrder([...parentPath, ...parsed[0]], layerMap, nextOrder);
        }
      }
      continue;
    }
    if (r.type === 1) {
      r.__morphLayerOrder = currentLayerOrder;
      result.push(r as CSSStyleRule);
    } else if ('cssRules' in r && r.cssRules) {
      if (r.type === 4 || 'media' in r || r.constructor?.name === 'CSSMediaRule') {
        const mediaText = r.media?.mediaText || r.conditionText;
        if (mediaText && win.matchMedia?.(mediaText)?.matches === false) continue;
        result.push(...flattenRules(r.cssRules, win, doc, layerMap, nextOrder, parentPath));
      } else if (r.type === 12 || r.constructor?.name === 'CSSSupportsRule' || 'conditionText' in r) {
        const condition = r.conditionText;
        if (!matchesSupports(condition, win, doc)) continue;
        result.push(...flattenRules(r.cssRules, win, doc, layerMap, nextOrder, parentPath));
      } else if ('name' in r || r.constructor?.name === 'CSSLayerBlockRule') {
        let rawName = typeof r.name === 'string' ? r.name : '';
        if (typeof r.name !== 'string' && typeof r.cssText === 'string') {
          const m = r.cssText.match(/^@layer\b([^{]*)\{/i);
          if (m) rawName = m[1];
        }
        const parsed = rawName ? tokenizeLayerNames(rawName) : [];
        const segs = parsed && parsed.length === 1 ? parsed[0] : [`@anon:${nextOrder.val++}`];
        const nextPath = [...parentPath, ...segs];
        resolveHierarchicalLayerOrder(nextPath, layerMap, nextOrder);
        result.push(...flattenRules(r.cssRules, win, doc, layerMap, nextOrder, nextPath));
      } else {
        result.push(...flattenRules(r.cssRules, win, doc, layerMap, nextOrder, parentPath));
      }
    }
  }
  return result;
}
