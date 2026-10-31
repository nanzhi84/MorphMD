import type { AdapterCapabilities, DiagnosticItem } from '../snapshot/types';
import { runInDomSandbox } from '../dom/env';
import { analyzeStyles } from './analyzer';
import {
  guardTargetCapabilities, getDefaultCapabilities, DEFAULT_ALLOWED_STYLE_PROPS,
  resolveCssVariables, isRasterBlockOrDescendant, comparePriority, matchesSupports, flattenRules,
  resolveScopeCustomProperties, computeElementVarScope, type LayerCandidate,
} from './guard';
import { DEFAULT_DESIGN_TOKENS, type DesignTokens } from './tokens';
import { expandExternalLinksToInlineText, normalizeWeChatStructureAndStyles } from '../wechat/normalizer';

export interface InlineStyleOptions {
  customCss?: string;
  tokens?: Partial<DesignTokens>;
  capabilities?: AdapterCapabilities;
  afterInline?: (rootContainer: HTMLElement, doc: Document, diagnostics: DiagnosticItem[]) => void;
}

export interface InlineStyleResult {
  html: string;
  diagnostics: DiagnosticItem[];
}

export function inlineStyles(html: string, options: InlineStyleOptions = {}): InlineStyleResult {
  const customCss = options.customCss || '';
  const tokens = options.tokens;
  const capabilities = options.capabilities || getDefaultCapabilities('wechat');

  // 1. Analyze custom CSS
  const analysis = analyzeStyles(customCss, capabilities.targetId);

  const tokenRecord: Record<string, string> = {};
  for (const [k, v] of Object.entries(tokens || {})) {
    if (!/^--[a-zA-Z0-9_-]+$/.test(k)) {
      analysis.diagnostics.push({
        code: 'style/invalid-token-key',
        message: `Invalid token key "${k}".`,
        severity: 'error',
        property: k,
      });
      continue;
    }
    if (typeof v === 'string') {
      if (/[{};]/.test(v) || /url\s*\(\s*javascript:/i.test(v) || /expression\s*\(/i.test(v)) {
        analysis.diagnostics.push({
          code: 'style/invalid-token-value',
          message: `Invalid or dangerous token value for "${k}".`,
          severity: 'error',
          property: k,
        });
        continue;
      }
      tokenRecord[k] = v;
    }
  }

  const guardDiagnostics = guardTargetCapabilities(analysis.propertyWhitelist, capabilities, tokenRecord);
  const allDiagnostics = [...analysis.diagnostics, ...guardDiagnostics];

  // 2. Prepare tokens map
  const allTokens: Record<string, string> = {
    ...DEFAULT_DESIGN_TOKENS,
    ...tokenRecord,
  };

  const tokenCssLines = Object.entries(allTokens)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join('\n');

  const fullCss = `
    :root {
${tokenCssLines}
    }
    .morph-doc {
      background-color: var(--morph-bg);
      color: var(--morph-ink);
      font-family: var(--morph-font-sans);
      font-size: var(--morph-body-size);
      line-height: var(--morph-line-height);
    }
    .morph-h1 {
      font-family: var(--morph-font-serif);
      font-size: 28px;
      line-height: 1.38;
      font-weight: 700;
      margin-top: 0px;
      margin-bottom: 22px;
    }
    .morph-h2 {
      font-family: var(--morph-font-serif);
      font-size: 22px;
      line-height: 1.4;
      font-weight: 600;
      margin-top: 28px;
      margin-bottom: 16px;
    }
    .morph-h3 {
      font-family: var(--morph-font-serif);
      font-size: 18px;
      line-height: 1.42;
      font-weight: 600;
      margin-top: 22px;
      margin-bottom: 12px;
    }
    .morph-h4 {
      font-family: var(--morph-font-serif);
      font-size: 16px;
      line-height: 1.45;
      font-weight: 600;
      margin-top: 16px;
      margin-bottom: 8px;
    }
    .morph-p {
      font-family: var(--morph-font-sans);
      font-size: var(--morph-body-size);
      line-height: var(--morph-line-height);
      color: var(--morph-ink);
      text-align: left;
      margin-top: 0px;
      margin-bottom: var(--morph-block-gap);
    }
    em {
      font-family: "LXGW WenKai", "Kaiti SC", "STKaiti", "KaiTi", "Newsreader", Georgia, serif;
      font-style: normal;
      color: #32383F;
    }
    .morph-link-url,
    .link-url {
      color: #8C857B;
      font-size: 0.85em;
      font-family: var(--morph-font-mono);
      font-weight: 400;
      font-style: normal;
    }
    .morph-list {
      font-family: var(--morph-font-sans);
      font-size: var(--morph-body-size);
      line-height: var(--morph-line-height);
      color: var(--morph-ink);
      text-align: left;
      margin-top: 0px;
      margin-bottom: 16px;
      padding-left: 22px;
    }
    .morph-list li {
      font-family: var(--morph-font-sans);
      font-size: var(--morph-body-size);
      line-height: var(--morph-line-height);
      color: var(--morph-ink);
      text-align: left;
      margin-top: 0px;
      margin-bottom: 6px;
      padding-left: 4px;
    }
    .morph-quote {
      text-align: left;
      margin-top: 0px;
      margin-right: 0px;
      margin-bottom: 20px;
      margin-left: 0px;
    }
    .morph-quote .morph-p,
    .morph-quote p {
      text-align: left;
      margin-top: 0px;
      margin-bottom: 0px;
    }
    .morph-quote .morph-p + .morph-p,
    .morph-quote p + p {
      margin-top: 8px;
    }
    .morph-img {
      max-width: 100%;
      height: auto;
      display: block;
      border-radius: 8px;
      margin-top: 0px;
      margin-bottom: 16px;
    }
    .morph-p > .morph-img {
      margin-bottom: 0px;
    }
    .morph-p.morph-figure-media,
    .morph-figure-media {
      margin-top: 0px;
      margin-bottom: 6px;
    }
    .morph-caption,
    figcaption {
      font-family: var(--morph-font-sans);
      font-size: 13px;
      line-height: 1.5;
      color: #787774;
      text-align: left;
      margin-top: 0px;
      margin-bottom: 16px;
    }
    .morph-math-display {
      display: block;
      text-align: center;
      margin-top: 0px;
      margin-bottom: 16px;
      overflow-x: auto;
    }
    .morph-callout {
      background-color: #f7f7f5;
      border-left: 3px solid var(--morph-accent);
      border-radius: 0px 8px 8px 0px;
      padding: 14px 16px 14px 18px;
      margin-top: 0px;
      margin-bottom: 16px;
      font-family: var(--morph-font-sans);
      font-size: 14.5px;
      line-height: 1.65;
      color: var(--morph-ink);
      text-align: left;
    }
    .morph-callout-title {
      font-family: var(--morph-font-sans);
      font-weight: 600;
      font-size: 14.5px;
      line-height: 1.9;
      margin-top: 0px;
      margin-bottom: 6px;
      color: var(--morph-ink);
    }
    .morph-callout-body {
      font-family: var(--morph-font-sans);
      font-size: 14.5px;
      line-height: 1.65;
      color: var(--morph-ink);
      margin: 0px;
      padding: 0px;
    }
    .morph-callout-body p,
    .morph-callout-body .morph-p {
      font-family: var(--morph-font-sans);
      font-size: 14.5px;
      line-height: 1.65;
      color: var(--morph-ink);
      margin-top: 0px;
      margin-bottom: 0px;
    }
    .morph-code {
      font-family: var(--morph-font-mono);
      overflow-x: auto;
      white-space: pre;
      text-align: left;
      word-break: normal;
      overflow-wrap: normal;
    }
    ${analysis.sanitizedCss}
  `;

  // 3. Run computation inside isolated sandbox
  return runInDomSandbox(html, fullCss, (rootContainer, doc, win) => {
    const sheet = doc.styleSheets[doc.styleSheets.length - 1];
    const rules = sheet && sheet.cssRules ? flattenRules(sheet.cssRules, win, doc) : [];
    const phase1ScopeCache = new WeakMap<Element, Record<string, string>>();

    // 3.1 Materialize simple decorative pseudo elements (::before / ::after) with full cascade
    const elementsWithPseudos = new Set<Element>();
    for (const pseudo of analysis.pseudoRules) {
      if (pseudo.mediaConditions && pseudo.mediaConditions.some((c) => win.matchMedia && !win.matchMedia(c).matches)) {
        continue;
      }
      try {
        const matched = Array.from(rootContainer.querySelectorAll(pseudo.baseSelector));
        if (rootContainer.matches(pseudo.baseSelector)) {
          matched.push(rootContainer);
        }
        matched.forEach((el) => elementsWithPseudos.add(el));
      } catch {}
    }

    const pendingPseudos: Array<{ el: Element; pseudoType: 'before' | 'after'; span: HTMLElement }> = [];

    for (const el of elementsWithPseudos) {
      const isRaster = isRasterBlockOrDescendant(el, capabilities);
      const allowStyles = capabilities.allowInlineStyles || isRaster;

      for (const pseudoType of ['before', 'after'] as const) {
        const matchingRules = analysis.pseudoRules.filter((r) => {
          if (r.pseudo !== pseudoType) return false;
          if (r.supportsConditions && r.supportsConditions.some((c) => !matchesSupports(c, win, doc))) return false;
          if (r.mediaConditions && r.mediaConditions.some((c) => win.matchMedia && !win.matchMedia(c).matches)) return false;
          try {
            return el.matches(r.baseSelector);
          } catch {
            return false;
          }
        });
        if (matchingRules.length === 0) continue;

        let activeContent: {
          value: string | null;
          priority: { important: boolean; layerOrder?: string; specificity: [number, number, number]; sourceOrder: number };
        } | null = null;

        const activeStyles = new Map<
          string,
          { value: string; priority: { important: boolean; layerOrder?: string; specificity: [number, number, number]; sourceOrder: number } }
        >();

        const customByLayer = new Map<
          string,
          Map<string, { value: string; priority: { important: boolean; layerOrder?: string; specificity: [number, number, number]; sourceOrder: number } }>
        >();

        for (const rule of matchingRules) {
          const layerOrder = rule.layerOrder ?? 'unlayered';
          if (rule.hasContentDeclaration) {
            const candPriority = {
              important: rule.contentImportant,
              layerOrder,
              specificity: rule.specificity,
              sourceOrder: rule.sourceOrder,
            };
            if (!activeContent || comparePriority(candPriority, activeContent.priority) >= 0) {
              activeContent = { value: rule.content, priority: candPriority };
            }
          }

          for (const [prop, decl] of Object.entries(rule.declarations || {})) {
            const candPriority = {
              important: decl.important,
              layerOrder,
              specificity: rule.specificity,
              sourceOrder: rule.sourceOrder,
            };
            const existing = activeStyles.get(prop);
            if (!existing || comparePriority(candPriority, existing.priority) >= 0) {
              activeStyles.set(prop, { value: decl.value, priority: candPriority });
            }
            if (prop.startsWith('--')) {
              if (!customByLayer.has(prop)) customByLayer.set(prop, new Map());
              const layerDecls = customByLayer.get(prop)!;
              const key = `${layerOrder}_${decl.important ? 1 : 0}`;
              const existingLayer = layerDecls.get(key);
              if (!existingLayer || comparePriority(candPriority, existingLayer.priority) >= 0) {
                layerDecls.set(key, { value: decl.value, priority: candPriority });
              }
            }
          }
        }

        const finalContent = activeContent ? activeContent.value : null;
        if (finalContent === null || finalContent === '') {
          continue;
        }

        const span = doc.createElement('span');
        span.setAttribute('data-morph-pseudo', pseudoType);
        span.textContent = finalContent;

        if (allowStyles) {
          const inlineStylesList: string[] = [];
          const hostScope = computeElementVarScope(el, rootContainer, doc, rules, allTokens, phase1ScopeCache);
          const pseudoRawLocal: Record<string, string> = {};
          const pseudoRawLocalLayers: Record<string, LayerCandidate[]> = {};
          for (const [prop, layerDecls] of customByLayer.entries()) {
            const sorted = Array.from(layerDecls.values()).sort((a, b) => comparePriority(b.priority, a.priority));
            pseudoRawLocal[prop] = sorted[0].value;
            pseudoRawLocalLayers[prop] = sorted.map((s) => ({
              value: s.value,
              layerOrder: s.priority.layerOrder ?? 'unlayered',
              important: s.priority.important,
            }));
          }
          const pseudoScope = resolveScopeCustomProperties(pseudoRawLocal, hostScope, pseudoRawLocalLayers);

          for (const [prop, decl] of activeStyles.entries()) {
            if (prop.startsWith('--')) continue;
            if (capabilities.allowedStyleProps && !capabilities.allowedStyleProps.has(prop)) {
              continue;
            }
            const resolvedVal = resolveCssVariables(decl.value, pseudoScope);
            if (resolvedVal) {
              inlineStylesList.push(`${prop}: ${resolvedVal}`);
            }
          }
          if (inlineStylesList.length > 0) {
            span.setAttribute('style', inlineStylesList.join('; '));
          }
        }

        pendingPseudos.push({ el, pseudoType, span });
      }
    }

    // 3.2 Sanitize / Filter pre-existing inline styles (clean native blocks on x-article)
    if (!capabilities.allowInlineStyles) {
      const elementsWithStyle = [rootContainer, ...Array.from(rootContainer.querySelectorAll('[style]'))];
      elementsWithStyle.forEach((el) => {
        const isRaster = isRasterBlockOrDescendant(el, capabilities);
        if (!isRaster) {
          const nodeId = el.getAttribute('data-node-id') || undefined;
          const rangeStr = el.getAttribute('data-source-range');
          const sourceRange = rangeStr ? (rangeStr.split('-').map(Number) as [number, number]) : undefined;
          el.removeAttribute('style');
          allDiagnostics.push({
            code: 'style/platform-unsupported-inlining',
            message: 'Inline style attribute on native block removed in x-article.',
            severity: 'info',
            targetId: capabilities.targetId,
            nodeId,
            sourceRange,
          });
        }
      });
    }

    // 3.3 Two-Phase Inlining: Phase 1: Compute styles without mutating el.style
    const computedStylesMap = new Map<Element, Map<string, string>>();
    const computedDeclCache = new WeakMap<Element, CSSStyleDeclaration>();
    const rasterCache = new WeakMap<Element, boolean>();
    const getIsRaster = (el: Element): boolean => {
      if (rasterCache.has(el)) return rasterCache.get(el)!;
      const res = isRasterBlockOrDescendant(el, capabilities);
      rasterCache.set(el, res);
      return res;
    };
    const getComputedDecl = (el: Element): CSSStyleDeclaration => {
      let decl = computedDeclCache.get(el);
      if (!decl) {
        decl = win.getComputedStyle(el);
        computedDeclCache.set(el, decl);
      }
      return decl;
    };

    const hasPositionalOrAttrSelectors = /(:nth|:first|:last|:only|:empty|:has|\+|~|\[)/i.test(
      analysis.sanitizedCss
    );
    const profileKeyCache = new WeakMap<Element, string | null>();
    const getElementProfileKey = (el: Element): string | null => {
      if (hasPositionalOrAttrSelectors || el === rootContainer) return null;
      if (profileKeyCache.has(el)) return profileKeyCache.get(el)!;
      if (el.id || el.getAttribute('style')) {
        profileKeyCache.set(el, null);
        return null;
      }
      const parent = el.parentElement;
      if (!parent) {
        profileKeyCache.set(el, null);
        return null;
      }
      const parentKey = parent === rootContainer ? 'ROOT' : getElementProfileKey(parent);
      if (parentKey === null) {
        profileKeyCache.set(el, null);
        return null;
      }
      const key = `${parentKey}>${el.tagName}.${el.getAttribute('class') || ''}`;
      profileKeyCache.set(el, key);
      return key;
    };
    const ruleProfilePropsCache = new Map<string, Array<[string, string]>>();

    for (let ruleIdx = 0; ruleIdx < rules.length; ruleIdx++) {
        const rule = rules[ruleIdx];
        if (!rule.selectorText || !rule.style) continue;

        let matched: Element[];
        try {
          matched = Array.from(rootContainer.querySelectorAll(rule.selectorText));
          if (rootContainer.matches(rule.selectorText)) {
            matched.push(rootContainer);
          }
        } catch {
          allDiagnostics.push({
            code: 'style/unsupported-selector',
            message: `Unsupported or invalid selector "${rule.selectorText}".`,
            severity: 'warning',
            selector: rule.selectorText,
          });
          continue;
        }

        for (const el of matched) {
          const isRaster = getIsRaster(el);
          const allowInline = capabilities.allowInlineStyles || isRaster;
          if (!allowInline) {
            const nodeId = el.getAttribute('data-node-id') || undefined;
            const rangeStr = el.getAttribute('data-source-range');
            const sourceRange = rangeStr ? (rangeStr.split('-').map(Number) as [number, number]) : undefined;
            for (let i = 0; i < rule.style.length; i++) {
              const prop = rule.style[i];
              if (prop.startsWith('--')) continue;
              allDiagnostics.push({
                code: 'style/platform-unsupported-inlining',
                message: `Property "${prop}" cannot be inlined on native blocks in ${capabilities.targetId}.`,
                severity: 'info',
                targetId: capabilities.targetId,
                property: prop,
                nodeId,
                sourceRange,
              });
            }
            continue;
          }

          let elStyleMap = computedStylesMap.get(el);
          if (!elStyleMap) {
            elStyleMap = new Map<string, string>();
            computedStylesMap.set(el, elStyleMap);
          }

          const profileKey = getElementProfileKey(el);
          const ruleCacheKey = profileKey !== null ? `${ruleIdx}|${profileKey}` : null;
          if (ruleCacheKey !== null) {
            const cachedProps = ruleProfilePropsCache.get(ruleCacheKey);
            if (cachedProps !== undefined) {
              for (let i = 0; i < cachedProps.length; i++) {
                elStyleMap.set(cachedProps[i][0], cachedProps[i][1]);
              }
              continue;
            }
          }

          const recordedProps: Array<[string, string]> | null = ruleCacheKey !== null ? [] : null;
          let hadRuleDiagnostic = false;
          let elScopedVariables: Record<string, string> | null = null;
          const computed = getComputedDecl(el);

          // Border shorthand preservation
          const ruleBorder = rule.style.getPropertyValue('border');
          if (ruleBorder) {
            const computedBorder = computed.getPropertyValue('border') || ruleBorder;
            elStyleMap.set('border', computedBorder);
            if (recordedProps) recordedProps.push(['border', computedBorder]);
          }

          // white-space shorthand preservation (modern Chromium expands white-space into white-space-collapse & text-wrap-mode)
          const ruleWhiteSpace = rule.style.getPropertyValue('white-space');
          if (ruleWhiteSpace) {
            const computedWhiteSpace = computed.getPropertyValue('white-space') || ruleWhiteSpace;
            elStyleMap.set('white-space', computedWhiteSpace);
            if (recordedProps) recordedProps.push(['white-space', computedWhiteSpace]);
          }

          // text-decoration shorthand preservation (modern Chromium expands text-decoration into text-decoration-line/style/color)
          const ruleTextDecoration = rule.style.getPropertyValue('text-decoration');
          if (ruleTextDecoration) {
            elStyleMap.set('text-decoration', ruleTextDecoration);
            if (recordedProps) recordedProps.push(['text-decoration', ruleTextDecoration]);
          }

          // border-radius shorthand preservation (modern Chromium expands border-radius into border-top-left-radius etc.)
          const ruleBorderRadius = rule.style.getPropertyValue('border-radius');
          if (ruleBorderRadius) {
            const computedBorderRadius = computed.getPropertyValue('border-radius') || ruleBorderRadius;
            elStyleMap.set('border-radius', computedBorderRadius);
            if (recordedProps) recordedProps.push(['border-radius', computedBorderRadius]);
          }

          // padding shorthand preservation (modern Chromium expands padding into padding-top/right/bottom/left)
          const rulePadding = rule.style.getPropertyValue('padding');
          if (rulePadding) {
            const computedPadding = computed.getPropertyValue('padding') || rulePadding;
            elStyleMap.set('padding', computedPadding);
            if (recordedProps) recordedProps.push(['padding', computedPadding]);
          }

          for (let i = 0; i < rule.style.length; i++) {
            const prop = rule.style[i];
            if (prop.startsWith('--')) continue;

            const authoredVal = rule.style.getPropertyValue(prop);
            let val =
              ((prop === 'width' ||
                prop === 'height' ||
                prop === 'max-width' ||
                prop === 'max-height' ||
                (prop === 'line-height' && /^\d*\.?\d+$/.test(authoredVal.trim()))) &&
                authoredVal) ||
              (authoredVal && authoredVal.includes('var('))
                ? authoredVal
                : computed.getPropertyValue(prop) || authoredVal;

            if (prop === 'position' && /\bfixed\b/i.test(val)) {
              hadRuleDiagnostic = true;
              allDiagnostics.push({
                code: 'style/forbidden-fixed-position',
                message: 'position: fixed is disallowed.',
                severity: 'error',
                property: 'position',
              });
              continue;
            }

            if (!isRaster && capabilities.allowedStyleProps && !capabilities.allowedStyleProps.has(prop)) {
              if (!(capabilities.allowedStyleProps.has('border') && (prop === 'border' || prop.startsWith('border-')))) {
                continue;
              }
            }

            if (isRaster && capabilities.allowedStyleProps && capabilities.allowedStyleProps.size > 0 && !capabilities.allowedStyleProps.has(prop)) {
              if (!(capabilities.allowedStyleProps.has('border') && (prop === 'border' || prop.startsWith('border-')))) {
                continue;
              }
            }

            if (val && val.endsWith('em') && prop === 'font-size') {
              const multiplier = parseFloat(val);
              const parentFontSize = el.parentElement ? getComputedDecl(el.parentElement).fontSize : '16px';
              const parentPx = parseFloat(parentFontSize) || 16;
              val = `${multiplier * parentPx}px`;
            }

            if (val && val.includes('var(')) {
              if (!elScopedVariables) {
                elScopedVariables = computeElementVarScope(el, rootContainer, doc, rules, allTokens, phase1ScopeCache);
              }
              val = resolveCssVariables(val, elScopedVariables);
            }
            if (val) {
              elStyleMap.set(prop, val);
              if (recordedProps) recordedProps.push([prop, val]);
            }
          }

          if (ruleCacheKey !== null && recordedProps && !hadRuleDiagnostic) {
            ruleProfilePropsCache.set(ruleCacheKey, recordedProps);
          }
        }
      }

    // Include rootContainer computed defaults if .morph-doc
    if (capabilities.allowInlineStyles && rootContainer.classList.contains('morph-doc')) {
      const computedRoot = win.getComputedStyle(rootContainer);
      let rootMap = computedStylesMap.get(rootContainer);
      if (!rootMap) {
        rootMap = new Map<string, string>();
        computedStylesMap.set(rootContainer, rootMap);
      }
      for (const p of ['background-color', 'color', 'font-family', 'font-size', 'line-height']) {
        if (!rootMap.has(p)) {
          const val = computedRoot.getPropertyValue(p);
          if (val) rootMap.set(p, val);
        }
      }
    }

    // Materialize pending pseudo elements after Phase 1 selector matching
    for (const { el, pseudoType, span } of pendingPseudos) {
      if (pseudoType === 'before') {
        el.insertBefore(span, el.firstChild);
      } else {
        el.appendChild(span);
      }
    }

    // Phase 2: Apply recorded styles to elements
    const profileNormalizedStyleAttrCache = new Map<string, string>();
    for (const [el, styleMap] of computedStylesMap.entries()) {
      const htmlEl = el as HTMLElement;
      const profileKey = profileKeyCache.get(el) ?? null;
      if (profileKey !== null) {
        const cachedAttr = profileNormalizedStyleAttrCache.get(profileKey);
        if (cachedAttr !== undefined) {
          if (cachedAttr) {
            htmlEl.setAttribute('style', cachedAttr);
          }
          continue;
        }
        for (const [prop, val] of styleMap.entries()) {
          htmlEl.style.setProperty(prop, val);
        }
        profileNormalizedStyleAttrCache.set(profileKey, htmlEl.getAttribute('style') || '');
      } else {
        for (const [prop, val] of styleMap.entries()) {
          htmlEl.style.setProperty(prop, val);
        }
      }
    }

    // 3.4 Disallowed fixed position check across elements
    const hasPositionRules = analysis.propertyWhitelist.has('position');
    const positionCandidates = hasPositionRules
      ? [rootContainer, ...Array.from(rootContainer.querySelectorAll<HTMLElement>('[style], *'))]
      : [rootContainer, ...Array.from(rootContainer.querySelectorAll<HTMLElement>('[style*="position" i], [style*="position"]'))];
    for (const el of positionCandidates) {
      const styleObj = (el as HTMLElement).style;
      if (!styleObj) continue;
      const inlinePos = styleObj.position;
      let computedPos: string | undefined;
      if (hasPositionRules || inlinePos) {
        try {
          computedPos = win.getComputedStyle(el)?.position;
        } catch {}
      }
      if (computedPos === 'fixed' || inlinePos === 'fixed' || /\bfixed\b/i.test(inlinePos || '')) {
        allDiagnostics.push({
          code: 'style/forbidden-fixed-position',
          message: 'position: fixed is disallowed.',
          severity: 'error',
          property: 'position',
        });
        styleObj.removeProperty('position');
      }
    }

    // Resolve any remaining inline CSS variables before filtering allowedStyleProps
    const postPhase2ScopeCache = new WeakMap<Element, Record<string, string>>();
    const allStyledWithVar = [
      ...(rootContainer.getAttribute('style')?.includes('var(') ? [rootContainer] : []),
      ...Array.from(rootContainer.querySelectorAll<HTMLElement>('[style*="var("]')),
    ];
    for (const el of allStyledWithVar) {
      if (!el.getAttribute('style')) continue;
      const currentProps: string[] = [];
      for (let i = 0; i < el.style.length; i++) {
        currentProps.push(el.style[i]);
      }
      for (const p of currentProps) {
        const val = el.style.getPropertyValue(p);
        if (val && val.includes('var(')) {
          let resolved = '';
          try {
            resolved = win.getComputedStyle(el).getPropertyValue(p);
          } catch {}
          if (!resolved || resolved.includes('var(')) {
            const vars = computeElementVarScope(el, rootContainer, doc, rules, allTokens, postPhase2ScopeCache);
            resolved = resolveCssVariables(val, vars);
          }
          if (resolved) {
            el.style.setProperty(p, resolved);
          }
        }
      }
    }

    // 3.42 Apply proportional margin-bottom spacing for extra blank lines between blocks
    const allowsMarginBottom =
      !capabilities.allowedStyleProps ||
      capabilities.allowedStyleProps.size === 0 ||
      capabilities.allowedStyleProps.has('margin-bottom');
    if (allowsMarginBottom) {
      const parseLengthPx = (raw: string, refFontSizePx: number, fallbackPx: number): number => {
        const trimmed = (raw || '').trim().toLowerCase();
        if (!trimmed) return fallbackPx;
        const num = parseFloat(trimmed);
        if (!Number.isFinite(num)) return fallbackPx;
        if (trimmed.endsWith('rem')) return num * 16;
        if (trimmed.endsWith('em')) return num * refFontSizePx;
        return num;
      };

      const rootFsRaw = rootContainer.style.getPropertyValue('font-size');
      const rootFsPx = parseLengthPx(rootFsRaw, 16, 16);
      const rootLhRaw = rootContainer.style.getPropertyValue('line-height');
      const extraBlankEls = Array.from(
        rootContainer.querySelectorAll<HTMLElement>('[data-extra-blank-lines]')
      );
      if (extraBlankEls.length > 0) {
        for (const blockEl of Array.from(
          rootContainer.querySelectorAll<HTMLElement>('[style*="margin-bottom"]')
        )) {
          const mbRaw = blockEl.style.getPropertyValue('margin-bottom').trim().toLowerCase();
          if (mbRaw.endsWith('rem') || mbRaw.endsWith('em')) {
            const fsRaw = blockEl.style.getPropertyValue('font-size') || rootFsRaw;
            const fsPx = parseLengthPx(fsRaw, rootFsPx, rootFsPx);
            const mbPx = Math.round(parseLengthPx(mbRaw, fsPx, 16));
            blockEl.style.setProperty('margin-bottom', `${mbPx}px`);
          }
        }
      }

      for (const el of extraBlankEls) {
        const extraLines = parseInt(el.getAttribute('data-extra-blank-lines') || '0', 10);
        if (!Number.isFinite(extraLines) || extraLines <= 0) continue;

        const fsRaw = el.style.getPropertyValue('font-size') || rootFsRaw;
        const fsPx = parseLengthPx(fsRaw, rootFsPx, 15);

        const baseMbRaw = el.style.getPropertyValue('margin-bottom');
        const baseMb = parseLengthPx(baseMbRaw, fsPx, 16);

        const lhRaw = (el.style.getPropertyValue('line-height') || rootLhRaw || '').trim();
        let lineHeightPx = Math.round(fsPx * 1.75);
        if (lhRaw.endsWith('px') || lhRaw.endsWith('rem') || lhRaw.endsWith('em')) {
          const parsedPx = parseLengthPx(lhRaw, fsPx, lineHeightPx);
          if (Number.isFinite(parsedPx) && parsedPx > 0) {
            lineHeightPx = Math.round(parsedPx);
          }
        } else if (lhRaw) {
          const parsedMult = parseFloat(lhRaw);
          if (Number.isFinite(parsedMult) && parsedMult > 0) {
            lineHeightPx = Math.round(fsPx * parsedMult);
          }
        }

        const nextMb = Math.round(baseMb + extraLines * lineHeightPx);
        el.style.setProperty('margin-bottom', `${nextMb}px`);
      }
    }

    // 3.45 WeChat article structure & style compliance guard (wechatjs/verify-article-structure-spec)
    // and social media cards external link expansion
    if (capabilities.targetId === 'wechat') {
      normalizeWeChatStructureAndStyles(rootContainer, allDiagnostics, capabilities.allowedStyleProps);
    } else if (capabilities.targetId === 'cards') {
      expandExternalLinksToInlineText(rootContainer, allDiagnostics, 'cards', capabilities.allowedStyleProps);
    }

    // 3.5 Ensure strict compliance with allowedStyleProps across all styled elements
    const hasExplicitAllowedProps = Boolean(capabilities.allowedStyleProps && capabilities.allowedStyleProps.size > 0);
    const allowsColor = hasExplicitAllowedProps ? capabilities.allowedStyleProps!.has('color') : true;
    const verifiedExplicitStyleAttrs = new Set<string>();
    const verifiedDefaultStyleAttrs = new Set<string>();
    const allStyledFinal = [rootContainer, ...Array.from(rootContainer.querySelectorAll<HTMLElement>('[style]'))];
    for (const el of allStyledFinal) {
      const styleAttr = el.getAttribute('style');
      if (!styleAttr) continue;
      if (allowsColor && /^color:\s*#[0-9a-fA-F]{3,8}\s*;?$/.test(styleAttr)) {
        continue;
      }
      const isDefaultRaster = !hasExplicitAllowedProps && getIsRaster(el);
      const allowed = hasExplicitAllowedProps
        ? capabilities.allowedStyleProps
        : isDefaultRaster
        ? DEFAULT_ALLOWED_STYLE_PROPS
        : capabilities.allowedStyleProps;

      if (allowed) {
        const verifiedSet = isDefaultRaster ? verifiedDefaultStyleAttrs : verifiedExplicitStyleAttrs;
        if (verifiedSet.has(styleAttr)) {
          continue;
        }
        let removedAny = false;
        const currentProps: string[] = [];
        for (let i = 0; i < el.style.length; i++) {
          currentProps.push(el.style[i]);
        }
        for (const p of currentProps) {
          const isPropAllowed =
            allowed.has(p) ||
            (allowed.has('border') && (p === 'border' || p.startsWith('border-'))) ||
            (allowed.has('text-decoration') &&
              (p === 'text-decoration' ||
                p.startsWith('text-decoration-') ||
                p === 'text-underline-offset')) ||
            (allowed.has('white-space') &&
              (p === 'white-space' ||
                p === 'white-space-collapse' ||
                p === 'text-wrap-mode' ||
                p === 'text-wrap'));
          if (!isPropAllowed) {
            el.style.removeProperty(p);
            removedAny = true;
          }
        }
        if (!removedAny) {
          verifiedSet.add(styleAttr);
        } else if (el.style.length === 0) {
          el.removeAttribute('style');
        }
      }
    }

    if (options.afterInline) {
      options.afterInline(rootContainer, doc, allDiagnostics);
    }

    const finalHtml = rootContainer.outerHTML;

    return {
      html: finalHtml,
      diagnostics: allDiagnostics,
    };
  });
}
