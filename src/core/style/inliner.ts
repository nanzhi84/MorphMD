import type { AdapterCapabilities, DiagnosticItem } from '../snapshot/types';
import { runInDomSandbox } from '../dom/env';
import { analyzeStyles } from './analyzer';
import {
  guardTargetCapabilities, getDefaultCapabilities, DEFAULT_ALLOWED_STYLE_PROPS,
  resolveCssVariables, isRasterBlockOrDescendant, comparePriority, matchesSupports, flattenRules,
  resolveScopeCustomProperties, computeElementVarScope, type LayerCandidate,
} from './guard';
import { DEFAULT_DESIGN_TOKENS, type DesignTokens } from './tokens';
import { normalizeWeChatStructureAndStyles } from '../wechat/normalizer';

export interface InlineStyleOptions {
  customCss?: string;
  tokens?: Partial<DesignTokens>;
  capabilities?: AdapterCapabilities;
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
    .morph-h1 { font-family: var(--morph-font-serif); }
    .morph-h2 { font-family: var(--morph-font-serif); }
    .morph-h3 { font-family: var(--morph-font-serif); }
    .morph-p { margin-bottom: var(--morph-block-gap); line-height: var(--morph-line-height); }
    .morph-code { font-family: var(--morph-font-mono); overflow-x: auto; }
    ${analysis.sanitizedCss}
  `;

  // 3. Run computation inside isolated sandbox
  return runInDomSandbox(html, fullCss, (rootContainer, doc, win) => {
    const sheet = doc.styleSheets[doc.styleSheets.length - 1];
    const rules = sheet && sheet.cssRules ? flattenRules(sheet.cssRules, win, doc) : [];

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
          const hostScope = computeElementVarScope(el, rootContainer, doc, rules, allTokens);
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
    const elementsWithStyle = [rootContainer, ...Array.from(rootContainer.querySelectorAll('[style]'))];
    elementsWithStyle.forEach((el) => {
      const isRaster = isRasterBlockOrDescendant(el, capabilities);
      if (!capabilities.allowInlineStyles && !isRaster) {
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

    // 3.3 Two-Phase Inlining: Phase 1: Compute styles without mutating el.style
    const computedStylesMap = new Map<Element, Map<string, string>>();

    for (const rule of rules) {
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
          const isRaster = isRasterBlockOrDescendant(el, capabilities);
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

          // Build element-scoped custom properties map for JSDOM fallback
          const elScopedVariables = computeElementVarScope(el, rootContainer, doc, rules, allTokens);

          const computed = win.getComputedStyle(el);

          // Border shorthand preservation
          const ruleBorder = rule.style.getPropertyValue('border');
          if (ruleBorder) {
            const computedBorder = computed.getPropertyValue('border') || ruleBorder;
            elStyleMap.set('border', computedBorder);
          }

          for (let i = 0; i < rule.style.length; i++) {
            const prop = rule.style[i];
            if (prop.startsWith('--')) continue;

            let val = computed.getPropertyValue(prop) || rule.style.getPropertyValue(prop);

            if (prop === 'position' && /\bfixed\b/i.test(val)) {
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
              const parentFontSize = el.parentElement ? win.getComputedStyle(el.parentElement).fontSize : '16px';
              const parentPx = parseFloat(parentFontSize) || 16;
              val = `${multiplier * parentPx}px`;
            }

            val = resolveCssVariables(val, elScopedVariables);
            if (val) {
              elStyleMap.set(prop, val);
            }
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
    for (const [el, styleMap] of computedStylesMap.entries()) {
      const htmlEl = el as HTMLElement;
      for (const [prop, val] of styleMap.entries()) {
        htmlEl.style.setProperty(prop, val);
      }
    }

    // 3.4 Disallowed fixed position check across all elements with style
    const allElements = [rootContainer, ...Array.from(rootContainer.querySelectorAll<HTMLElement>('[style], *'))];
    for (const el of allElements) {
      if (!(el as HTMLElement).style) continue;
      let computedPos: string | undefined;
      try {
        computedPos = win.getComputedStyle(el)?.position;
      } catch {}
      const inlinePos = (el as HTMLElement).style.position;
      if (computedPos === 'fixed' || inlinePos === 'fixed' || /\bfixed\b/i.test(inlinePos || '')) {
        allDiagnostics.push({
          code: 'style/forbidden-fixed-position',
          message: 'position: fixed is disallowed.',
          severity: 'error',
          property: 'position',
        });
        (el as HTMLElement).style.removeProperty('position');
      }
    }

    // Resolve any remaining inline CSS variables before filtering allowedStyleProps
    const allStyled = [rootContainer, ...Array.from(rootContainer.querySelectorAll<HTMLElement>('[style]'))];
    for (const el of allStyled) {
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
            const vars = computeElementVarScope(el, rootContainer, doc, rules, allTokens);
            resolved = resolveCssVariables(val, vars);
          }
          if (resolved) {
            el.style.setProperty(p, resolved);
          }
        }
      }
    }

    // 3.45 WeChat article structure & style compliance guard (wechatjs/verify-article-structure-spec)
    if (capabilities.targetId === 'wechat') {
      normalizeWeChatStructureAndStyles(rootContainer, allDiagnostics, capabilities.allowedStyleProps);
    }

    // 3.5 Ensure strict compliance with allowedStyleProps across all styled elements
    const allStyledFinal = [rootContainer, ...Array.from(rootContainer.querySelectorAll<HTMLElement>('[style]'))];
    for (const el of allStyledFinal) {
      if (!el.getAttribute('style')) continue;
      const isRaster = isRasterBlockOrDescendant(el, capabilities);
      const allowed = isRaster
        ? (capabilities.allowedStyleProps && capabilities.allowedStyleProps.size > 0
            ? capabilities.allowedStyleProps
            : DEFAULT_ALLOWED_STYLE_PROPS)
        : capabilities.allowedStyleProps;

      if (allowed) {
        const currentProps: string[] = [];
        for (let i = 0; i < el.style.length; i++) {
          currentProps.push(el.style[i]);
        }
        for (const p of currentProps) {
          const isPropAllowed =
            allowed.has(p) || (allowed.has('border') && (p === 'border' || p.startsWith('border-')));
          if (!isPropAllowed) {
            el.style.removeProperty(p);
          }
        }
        if (el.style.length === 0) {
          el.removeAttribute('style');
        }
      }
    }

    const finalHtml = rootContainer.outerHTML;

    return {
      html: finalHtml,
      diagnostics: allDiagnostics,
    };
  });
}
