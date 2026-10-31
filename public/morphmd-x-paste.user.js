// ==UserScript==
// @name         MorphMD X Articles 图文一体粘贴助手
// @namespace    https://morphmd.dev/
// @version      1.1.0
// @description  在 X Articles (x.com/compose/article) 粘贴 MorphMD 富文本时，自动处理行内公式 Unicode 转换、Callout 换行、代码块高清卡片化，并按逆序队列触发 X 原生 upload.x.com 接口逐图原位上传。
// @author       MorphMD
// @match        https://x.com/*
// @match        https://twitter.com/*
// @match        http://localhost:*/*
// @match        http://127.0.0.1:*/*
// @match        https://*.morphmd.dev/*
// @match        https://*.github.io/*
// @run-at       document-start
// @grant        unsafeWindow
// ==/UserScript==

(function () {
  'use strict';

  const pageWindow = typeof unsafeWindow !== 'undefined' && unsafeWindow ? unsafeWindow : window;

  /**
   * 1. Handshake with MorphMD Workbench
   * Sets global flag and dispatches custom event so the workbench Status Dot pill
   * transitions from amber (uninstalled) to emerald green (ready).
   */
  function notifyWorkbenchReady() {
    try {
      window.__MORPHMD_USERSCRIPT_READY__ = true;
      pageWindow.__MORPHMD_USERSCRIPT_READY__ = true;
      if (document.documentElement) {
        document.documentElement.setAttribute('data-morphmd-userscript', 'ready');
      }
      const readyEvent = new CustomEvent('morphmd:userscript-ready', {
        detail: { version: '1.1.0' },
      });
      window.dispatchEvent(readyEvent);
      if (pageWindow !== window && typeof pageWindow.dispatchEvent === 'function') {
        pageWindow.dispatchEvent(
          new pageWindow.CustomEvent('morphmd:userscript-ready', {
            detail: { version: '1.1.0' },
          })
        );
      }
    } catch {
      // Ignore cross-context access errors
    }
  }

  notifyWorkbenchReady();
  window.addEventListener('DOMContentLoaded', notifyWorkbenchReady);
  window.addEventListener('load', notifyWorkbenchReady);

  /**
   * 2. X Articles (`x.com/compose/article`) Rich-Text + Image Upload Pipeline
   */
  const isXHost = /^(?:www\.)?(?:x|twitter)\.com$/i.test(window.location.hostname);
  if (!isXHost) {
    return;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Issue #7 Fix 1: Convert inline LaTeX math into clean Unicode mathematical text
   * so inline formulas do not split paragraphs or become block-level atomic images in X Articles.
   */
  const LATEX_SYMBOL_MAP = {
    '\\alpha': 'α',
    '\\beta': 'β',
    '\\gamma': 'γ',
    '\\delta': 'δ',
    '\\epsilon': 'ε',
    '\\varepsilon': 'ε',
    '\\zeta': 'ζ',
    '\\eta': 'η',
    '\\theta': 'θ',
    '\\vartheta': 'θ',
    '\\iota': 'ι',
    '\\kappa': 'κ',
    '\\lambda': 'λ',
    '\\mu': 'μ',
    '\\nu': 'ν',
    '\\xi': 'ξ',
    '\\pi': 'π',
    '\\rho': 'ρ',
    '\\sigma': 'σ',
    '\\tau': 'τ',
    '\\upsilon': 'υ',
    '\\phi': 'φ',
    '\\varphi': 'φ',
    '\\chi': 'χ',
    '\\psi': 'ψ',
    '\\omega': 'ω',
    '\\Gamma': 'Γ',
    '\\Delta': 'Δ',
    '\\Theta': 'Θ',
    '\\Lambda': 'Λ',
    '\\Xi': 'Ξ',
    '\\Pi': 'Π',
    '\\Sigma': 'Σ',
    '\\Phi': 'Φ',
    '\\Psi': 'Ψ',
    '\\Omega': 'Ω',
    '\\le': '≤',
    '\\leq': '≤',
    '\\ge': '≥',
    '\\geq': '≥',
    '\\neq': '≠',
    '\\ne': '≠',
    '\\approx': '≈',
    '\\cong': '≅',
    '\\equiv': '≡',
    '\\sim': '∼',
    '\\pm': '±',
    '\\mp': '∓',
    '\\times': '×',
    '\\cdot': '·',
    '\\div': '÷',
    '\\in': '∈',
    '\\notin': '∉',
    '\\subset': '⊂',
    '\\subseteq': '⊆',
    '\\cup': '∪',
    '\\cap': '∩',
    '\\to': '→',
    '\\rightarrow': '→',
    '\\leftarrow': '←',
    '\\Rightarrow': '⇒',
    '\\Leftrightarrow': '⇔',
    '\\forall': '∀',
    '\\exists': '∃',
    '\\partial': '∂',
    '\\nabla': '∇',
    '\\infty': '∞',
    '\\sum': '∑',
    '\\prod': '∏',
    '\\int': '∫',
    '\\sqrt': '√',
    '\\%': '%',
  };

  const SUPERSCRIPT_MAP = {
    '0': '⁰',
    '1': '¹',
    '2': '²',
    '3': '³',
    '4': '⁴',
    '5': '⁵',
    '6': '⁶',
    '7': '⁷',
    '8': '⁸',
    '9': '⁹',
    '+': '⁺',
    '-': '⁻',
    '=': '⁼',
    '(': '⁽',
    ')': '⁾',
    n: 'ⁿ',
    i: 'ⁱ',
  };

  const SUBSCRIPT_MAP = {
    '0': '₀',
    '1': '₁',
    '2': '₂',
    '3': '₃',
    '4': '₄',
    '5': '₅',
    '6': '₆',
    '7': '₇',
    '8': '₈',
    '9': '₉',
    '+': '₊',
    '-': '₋',
    '=': '₌',
    '(': '₍',
    ')': '₎',
    a: 'ₐ',
    e: 'ₑ',
    i: 'ᵢ',
    j: 'ⱼ',
    k: 'ₖ',
    n: 'ₙ',
    o: 'ₒ',
    r: 'ᵣ',
    s: 'ₛ',
    t: 'ₜ',
    u: 'ᵤ',
    v: 'ᵥ',
    x: 'ₓ',
  };

  function texToInlineUnicode(rawTex) {
    let out = String(rawTex || '').trim();
    if (!out) return '';

    out = out
      .replace(/\\(?:text|mathrm|mathbf|mathit|mathsf|mathtt)\{([^{}]*)\}/g, '$1')
      .replace(/\\mathcal\{S\}/g, '𝒮')
      .replace(/\\mathbb\{I\}/g, '𝕀')
      .replace(/\\mathbb\{R\}/g, 'ℝ')
      .replace(/\\mathbb\{N\}/g, 'ℕ')
      .replace(/\\mathbb\{Z\}/g, 'ℤ')
      .replace(/\\mathbb\{E\}/g, '𝔼')
      .replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, '($1)/($2)')
      .replace(/\\(?:left|right|big|Big|bigg|Bigg)\b/g, '');

    const sortedCommands = Object.keys(LATEX_SYMBOL_MAP).sort((a, b) => b.length - a.length);
    for (const cmd of sortedCommands) {
      const escaped = cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(escaped + '(?![a-zA-Z])', 'g'), LATEX_SYMBOL_MAP[cmd]);
    }

    out = out.replace(/\^\{([^{}]+)\}|\^([0-9+\-=()ni])/g, (_, grp, single) => {
      const str = grp !== undefined ? grp : single;
      const mapped = Array.from(str).map((ch) => SUPERSCRIPT_MAP[ch] || '').join('');
      return mapped.length === str.length ? mapped : `^(${str})`;
    });

    out = out.replace(/_\{([^{}]+)\}|_([0-9+\-=()aeijknorstuvx])/g, (_, grp, single) => {
      const str = grp !== undefined ? grp : single;
      const mapped = Array.from(str).map((ch) => SUBSCRIPT_MAP[ch] || '').join('');
      return mapped.length === str.length ? mapped : `_${str}`;
    });

    out = out.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
    return out;
  }

  /**
   * Issue #7 Fix 2: Normalize multi-paragraph blockquotes / Callouts for X Articles
   * X's DraftPasteProcessor strips inner <p> tags inside <blockquote> without inserting line breaks,
   * gluing Callout titles onto the body text. Unwrapping <p> and inserting <br> preserves soft line breaks.
   */
  function normalizeBlockquotesForX(doc) {
    const blockquotes = Array.from(doc.querySelectorAll('blockquote'));
    for (const bq of blockquotes) {
      const blockChildren = Array.from(bq.children).filter(
        (el) => el.tagName === 'P' || el.tagName === 'DIV'
      );
      if (blockChildren.length === 0) continue;

      const frag = doc.createDocumentFragment();
      let emittedBlockCount = 0;

      for (const child of Array.from(bq.childNodes)) {
        if (
          child.nodeType === 1 &&
          (child.tagName === 'P' || child.tagName === 'DIV')
        ) {
          const hasContent =
            (child.textContent || '').trim().length > 0 ||
            Boolean(child.querySelector && child.querySelector('img, br'));
          if (!hasContent) continue;

          if (emittedBlockCount > 0) {
            frag.appendChild(doc.createElement('br'));
          }
          while (child.firstChild) {
            frag.appendChild(child.firstChild);
          }
          emittedBlockCount++;
        } else if (child.nodeType === 3) {
          if ((child.textContent || '').trim().length > 0) {
            frag.appendChild(child.cloneNode(true));
          }
        } else if (child.nodeType === 1) {
          frag.appendChild(child.cloneNode(true));
        }
      }

      while (bq.firstChild) {
        bq.removeChild(bq.firstChild);
      }
      bq.appendChild(frag);
    }
  }

  function unwrapElementInDoc(el) {
    const parent = el.parentNode;
    if (!parent) return;
    while (el.firstChild) {
      parent.insertBefore(el.firstChild, el);
    }
    parent.removeChild(el);
  }

  /**
   * Unwrap <section>/<p>/<div> inside <li> and flatten nested <ul> inside <li>
   * into <br>- sub-items so Draft.js never inserts double newlines or drops first-item line breaks.
   */
  function normalizeListsForX(doc) {
    for (const li of Array.from(doc.querySelectorAll('li'))) {
      for (const wrapper of Array.from(li.children)) {
        if (/^(section|p|div)$/i.test(wrapper.tagName)) {
          unwrapElementInDoc(wrapper);
        }
      }
    }

    const nestedUls = Array.from(doc.querySelectorAll('li ul')).reverse();
    for (const nestedUl of nestedUls) {
      const parentContainer = nestedUl.parentNode;
      if (!parentContainer) continue;

      while (
        nestedUl.previousSibling &&
        nestedUl.previousSibling.nodeType === 3 &&
        (nestedUl.previousSibling.textContent || '').trim().length === 0
      ) {
        parentContainer.removeChild(nestedUl.previousSibling);
      }
      if (nestedUl.previousSibling && nestedUl.previousSibling.nodeType === 3) {
        nestedUl.previousSibling.nodeValue = (nestedUl.previousSibling.nodeValue || '').replace(
          /[\r\n\s]+$/,
          ''
        );
      } else if (
        nestedUl.previousSibling &&
        nestedUl.previousSibling.nodeType === 1 &&
        /^(p|div|section)$/i.test(nestedUl.previousSibling.tagName)
      ) {
        unwrapElementInDoc(nestedUl.previousSibling);
      }

      const childLis = Array.from(nestedUl.children).filter(
        (c) => c.tagName.toLowerCase() === 'li'
      );

      for (const childLi of childLis) {
        for (const wrapper of Array.from(childLi.querySelectorAll('p, div, section'))) {
          if (!childLi.contains(wrapper)) continue;
          if (
            wrapper.previousSibling &&
            (wrapper.previousSibling.textContent || '').trim().length > 0
          ) {
            wrapper.parentNode.insertBefore(doc.createElement('br'), wrapper);
          }
          unwrapElementInDoc(wrapper);
        }

        while (
          childLi.firstChild &&
          childLi.firstChild.nodeType === 3 &&
          (childLi.firstChild.textContent || '').trim().length === 0
        ) {
          childLi.removeChild(childLi.firstChild);
        }
        while (
          childLi.lastChild &&
          childLi.lastChild.nodeType === 3 &&
          (childLi.lastChild.textContent || '').trim().length === 0
        ) {
          childLi.removeChild(childLi.lastChild);
        }

        const hasContent =
          (childLi.textContent || '').trim().length > 0 ||
          Boolean(childLi.querySelector && childLi.querySelector('img, hr'));
        if (!hasContent) continue;

        const existingLeadText = (childLi.textContent || '').trimStart();
        if (!/^-\s/.test(existingLeadText)) {
          if (childLi.firstChild && childLi.firstChild.nodeType === 3) {
            childLi.firstChild.nodeValue = `- ${(childLi.firstChild.nodeValue || '').replace(/^\s+/, '')}`;
          } else {
            childLi.insertBefore(doc.createTextNode('- '), childLi.firstChild);
          }
        }

        const prev = nestedUl.previousSibling;
        const hasPrecedingContent =
          prev !== null &&
          !(prev.nodeType === 1 && prev.tagName.toLowerCase() === 'br');
        if (hasPrecedingContent) {
          parentContainer.insertBefore(doc.createElement('br'), nestedUl);
        }

        while (childLi.firstChild) {
          parentContainer.insertBefore(childLi.firstChild, nestedUl);
        }
      }

      while (
        nestedUl.nextSibling &&
        nestedUl.nextSibling.nodeType === 3 &&
        (nestedUl.nextSibling.textContent || '').trim().length === 0
      ) {
        parentContainer.removeChild(nestedUl.nextSibling);
      }

      nestedUl.remove();
    }
  }

  /**
   * Issue #7 Fix 3: Rasterize <pre><code> blocks into 2x Retina Syntax-Highlighted Code Card PNGs
   * X's HTML paste pipeline strips <pre> into plain unstyled paragraphs and drops inline Shiki colors.
   */
  function extractCodeLinesWithTokens(preEl) {
    const codeEl = preEl.querySelector('code') || preEl;
    const lineEls = Array.from(codeEl.querySelectorAll('.line'));

    if (lineEls.length > 0) {
      return lineEls.map((lineEl) => {
        const tokens = [];
        const walk = (node, inheritedColor) => {
          if (node.nodeType === 3) {
            const text = (node.nodeValue || '').replace(/\r?\n/g, '');
            if (text.length > 0) {
              tokens.push({ text, color: inheritedColor || '#24292f' });
            }
            return;
          }
          if (node.nodeType === 1) {
            const styleAttr = node.getAttribute('style') || '';
            const colorMatch = /(?:^|;)\s*color\s*:\s*([^;]+)/i.exec(styleAttr);
            const nextColor = colorMatch ? colorMatch[1].trim() : inheritedColor;
            for (const child of Array.from(node.childNodes)) {
              walk(child, nextColor);
            }
          }
        };
        walk(lineEl, '#24292f');
        return tokens;
      });
    }

    const rawText = (codeEl.textContent || '').replace(/\r\n/g, '\n').replace(/\n$/, '');
    const rawLines = rawText.split('\n');
    const keywordRe =
      /\b(export|import|from|interface|type|const|let|var|function|return|async|await|class|extends|implements|if|else|for|while|switch|case|break|continue|new|try|catch|finally|def|pass|lambda|yield|pub|fn|struct|enum|impl|package|func|boolean|string|number|void|any|unknown|never|Record)\b/g;

    return rawLines.map((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('#')) {
        return [{ text: line, color: '#6e7781' }];
      }
      const tokens = [];
      let lastIdx = 0;
      const tokenRe =
        /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b(?:export|import|from|interface|type|const|let|var|function|return|async|await|class|extends|implements|if|else|for|while|switch|case|break|continue|new|try|catch|finally|def|pass|lambda|yield|pub|fn|struct|enum|impl|package|func)\b|\b(?:boolean|string|number|void|any|unknown|never|Record)\b|\b\d+(?:\.\d+)?\b)/g;
      let match;
      while ((match = tokenRe.exec(line)) !== null) {
        if (match.index > lastIdx) {
          tokens.push({ text: line.slice(lastIdx, match.index), color: '#24292f' });
        }
        const tok = match[0];
        let color = '#24292f';
        if (tok.startsWith('"') || tok.startsWith("'") || tok.startsWith('`')) {
          color = '#0a3069';
        } else if (/^\d/.test(tok)) {
          color = '#0550ae';
        } else if (/^(?:boolean|string|number|void|any|unknown|never|Record)$/.test(tok)) {
          color = '#953800';
        } else if (keywordRe.test(tok)) {
          color = '#cf222e';
        }
        keywordRe.lastIndex = 0;
        tokens.push({ text: tok, color });
        lastIdx = match.index + tok.length;
      }
      if (lastIdx < line.length) {
        tokens.push({ text: line.slice(lastIdx), color: '#24292f' });
      }
      return tokens.length > 0 ? tokens : [{ text: '', color: '#24292f' }];
    });
  }

  function renderCodeBlockToDataUrl(preEl, doc) {
    try {
      const ownerDoc = doc || document;
      const canvas = ownerDoc.createElement('canvas');
      if (!canvas || typeof canvas.getContext !== 'function') return null;

      const codeEl = preEl.querySelector('code');
      const classAttr =
        (codeEl && codeEl.getAttribute('class')) || preEl.getAttribute('class') || '';
      const langMatch = /language-([a-zA-Z0-9_-]+)/.exec(classAttr);
      const rawLang =
        preEl.getAttribute('data-code-lang') || (langMatch ? langMatch[1] : '') || 'code';
      const langLabel = rawLang.toUpperCase();

      const tokenLines = extractCodeLinesWithTokens(preEl);
      const dpr = 2;
      const cssWidth = 680;
      const outerPadX = 20;
      const outerPadY = 18;
      const headerHeight = 36;
      const codePadTop = 14;
      const codePadBottom = 16;
      const lineHeight = 22;
      const gutterWidth = 44;

      const cardContentHeight =
        headerHeight + codePadTop + Math.max(1, tokenLines.length) * lineHeight + codePadBottom;
      // Enforce minimum CSS height >= 176 so width/height <= 3.86 (< 5.0 X crop threshold)
      const cssHeight = Math.max(cardContentHeight + outerPadY * 2, 176);
      const cardTop = Math.round((cssHeight - cardContentHeight) / 2);
      const cardLeft = outerPadX;
      const cardWidth = cssWidth - outerPadX * 2;

      canvas.width = Math.round(cssWidth * dpr);
      canvas.height = Math.round(cssHeight * dpr);

      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.scale(dpr, dpr);

      // 1. White outer canvas background
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, cssWidth, cssHeight);

      // 2. Rounded code card container
      const radius = 12;
      ctx.fillStyle = '#f8fafc';
      ctx.strokeStyle = '#e2e8f0';
      ctx.lineWidth = 1;
      if (typeof ctx.roundRect === 'function') {
        ctx.beginPath();
        ctx.roundRect(cardLeft, cardTop, cardWidth, cardContentHeight, radius);
        ctx.fill();
        ctx.stroke();
      } else {
        ctx.fillRect(cardLeft, cardTop, cardWidth, cardContentHeight);
        ctx.strokeRect(cardLeft, cardTop, cardWidth, cardContentHeight);
      }

      // 3. Top window bar
      ctx.fillStyle = '#f1f5f9';
      if (typeof ctx.roundRect === 'function') {
        ctx.beginPath();
        ctx.roundRect(cardLeft, cardTop, cardWidth, headerHeight, [radius, radius, 0, 0]);
        ctx.fill();
      } else {
        ctx.fillRect(cardLeft, cardTop, cardWidth, headerHeight);
      }
      ctx.strokeStyle = '#e2e8f0';
      ctx.beginPath();
      ctx.moveTo(cardLeft, cardTop + headerHeight);
      ctx.lineTo(cardLeft + cardWidth, cardTop + headerHeight);
      ctx.stroke();

      // macOS window control dots
      const dotColors = ['#ff5f56', '#ffbd2e', '#27c93f'];
      dotColors.forEach((color, idx) => {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(cardLeft + 18 + idx * 16, cardTop + headerHeight / 2, 5, 0, Math.PI * 2);
        ctx.fill();
      });

      // Language label on right of header
      ctx.fillStyle = '#64748b';
      ctx.font = '600 11px "SFMono-Regular", Menlo, Monaco, Consolas, monospace';
      ctx.textBaseline = 'middle';
      const labelWidth = ctx.measureText(langLabel).width || langLabel.length * 7;
      ctx.fillText(langLabel, cardLeft + cardWidth - labelWidth - 16, cardTop + headerHeight / 2);

      // 4. Render line numbers + syntax-highlighted code lines
      const monoFont = '400 13.5px "SFMono-Regular", Menlo, Monaco, Consolas, "PingFang SC", monospace';
      for (let i = 0; i < tokenLines.length; i++) {
        const lineY = cardTop + headerHeight + codePadTop + i * lineHeight + lineHeight / 2;

        // Line number
        ctx.fillStyle = '#94a3b8';
        ctx.font = '400 12px "SFMono-Regular", Menlo, Monaco, Consolas, monospace';
        const lineNumStr = String(i + 1);
        const numW = ctx.measureText(lineNumStr).width || lineNumStr.length * 7;
        ctx.fillText(lineNumStr, cardLeft + gutterWidth - numW - 10, lineY);

        // Code tokens
        ctx.font = monoFont;
        let cursorX = cardLeft + gutterWidth + 6;
        const maxCursorX = cardLeft + cardWidth - 16;
        for (const token of tokenLines[i]) {
          if (!token.text) continue;
          ctx.fillStyle = token.color || '#24292f';
          ctx.fillText(token.text, cursorX, lineY);
          const tokW = ctx.measureText(token.text).width || token.text.length * 8;
          cursorX += tokW;
          if (cursorX >= maxCursorX) break;
        }
      }

      const dataUrl = canvas.toDataURL('image/png');
      if (!dataUrl || !dataUrl.startsWith('data:image/png')) return null;
      return { dataUrl, cssWidth, cssHeight };
    } catch {
      return null;
    }
  }

  function dataUrlToFile(dataUrl, index) {
    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/.exec(dataUrl || '');
    if (!match) return null;
    const mimeType = match[1].toLowerCase();
    const base64 = match[2].replace(/\s+/g, '');
    try {
      const binaryStr = atob(base64);
      const len = binaryStr.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      const ext =
        mimeType.includes('jpeg') || mimeType.includes('jpg')
          ? 'jpg'
          : mimeType.includes('webp')
            ? 'webp'
            : mimeType.includes('gif')
              ? 'gif'
              : 'png';
      return new File([bytes], `morphmd-figure-${index + 1}.${ext}`, { type: mimeType });
    } catch {
      return null;
    }
  }

  /**
   * Ensures any wide/short image has an aspect ratio <= 4.0:1 so X Articles' media container
   * (which center-crops images wider than 5.0:1) never crops left/right edges.
   */
  async function ensureXSafeImageFile(src, index) {
    const fallbackFile = dataUrlToFile(src, index);
    if (!fallbackFile) return null;

    try {
      const img = new Image();
      const loaded = await new Promise((resolve) => {
        img.onload = () => resolve(true);
        img.onerror = () => resolve(false);
        img.src = src;
      });
      if (!loaded) return fallbackFile;

      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if (w <= 0 || h <= 0 || w / h <= 4.0) {
        return fallbackFile;
      }

      const targetW = Math.max(1360, w);
      const targetH = Math.max(Math.ceil(targetW / 3.85), h + 64);
      const canvas = document.createElement('canvas');
      canvas.width = targetW;
      canvas.height = targetH;
      const ctx = canvas.getContext('2d');
      if (!ctx) return fallbackFile;

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, targetW, targetH);
      const drawX = Math.round((targetW - w) / 2);
      const drawY = Math.round((targetH - h) / 2);
      ctx.drawImage(img, drawX, drawY);

      const paddedDataUrl = canvas.toDataURL('image/png');
      return dataUrlToFile(paddedDataUrl, index) || fallbackFile;
    } catch {
      return fallbackFile;
    }
  }

  let toastEl = null;
  let toastTimer = null;

  function showProgressToast(text, state) {
    if (!document.body) return;
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.style.cssText = [
        'position: fixed',
        'top: 20px',
        'right: 20px',
        'z-index: 999999',
        'display: inline-flex',
        'align-items: center',
        'gap: 8px',
        'padding: 8px 14px',
        'border-radius: 999px',
        'background: rgba(255, 255, 255, 0.96)',
        'border: 1px solid rgba(55, 53, 47, 0.16)',
        'box-shadow: 0 8px 24px rgba(15, 15, 15, 0.12)',
        'color: #37352f',
        'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif',
        'font-size: 12.5px',
        'font-weight: 500',
        'pointer-events: none',
        'transition: opacity 0.2s ease',
      ].join(';');
      const dot = document.createElement('span');
      dot.className = 'morph-toast-dot';
      dot.style.cssText = 'width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;';
      const label = document.createElement('span');
      label.className = 'morph-toast-label';
      toastEl.appendChild(dot);
      toastEl.appendChild(label);
      document.body.appendChild(toastEl);
    }

    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }

    toastEl.style.opacity = '1';
    const dot = toastEl.querySelector('.morph-toast-dot');
    const label = toastEl.querySelector('.morph-toast-label');
    if (dot) {
      dot.style.backgroundColor = state === 'done' ? '#10b981' : '#f59e0b';
      dot.style.boxShadow =
        state === 'done' ? '0 0 6px rgba(16, 185, 129, 0.4)' : '0 0 6px rgba(245, 158, 11, 0.35)';
    }
    if (label) {
      label.textContent = text;
    }

    if (state === 'done') {
      toastTimer = setTimeout(() => {
        if (toastEl) {
          toastEl.style.opacity = '0';
        }
      }, 2600);
    }
  }

  function findTextNodeContaining(root, token) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    let current = walker.nextNode();
    while (current) {
      if (current.nodeValue && current.nodeValue.includes(token)) {
        return current;
      }
      current = walker.nextNode();
    }
    return null;
  }

  function countEditorMediaNodes(editorEl) {
    if (!editorEl || typeof editorEl.querySelectorAll !== 'function') return 0;
    return editorEl.querySelectorAll(
      '[data-testid="tweetPhoto"], figure, [data-block="true"] img, video'
    ).length;
  }

  function isEditorUploadInProgress(editorEl) {
    if (!editorEl || typeof editorEl.querySelector !== 'function') return false;
    return Boolean(
      editorEl.querySelector('[role="progressbar"], [aria-busy="true"], [data-testid="mask"]')
    );
  }

  async function waitForMediaBlockInsertion(editorEl, previousCount, timeoutMs) {
    const maxLoops = Math.max(1, Math.ceil((timeoutMs || 8000) / 80));
    let mounted = false;
    for (let step = 0; step < maxLoops; step++) {
      if (countEditorMediaNodes(editorEl) > previousCount) {
        mounted = true;
        if (!isEditorUploadInProgress(editorEl)) {
          break;
        }
      }
      await sleep(80);
    }
    // Wait for upload.x.com media_id commit to settle in Draft.js EditorState
    await sleep(mounted ? 950 : 400);
    return mounted;
  }

  async function selectAndClearToken(editorEl, token) {
    const textNode = findTextNodeContaining(editorEl, token);
    if (!textNode || !textNode.nodeValue) return false;

    const startOffset = textNode.nodeValue.indexOf(token);
    if (startOffset < 0) return false;

    if (textNode.parentElement && typeof textNode.parentElement.scrollIntoView === 'function') {
      try {
        textNode.parentElement.scrollIntoView({ block: 'center', behavior: 'instant' });
      } catch {
        // Ignore scroll errors in headless environments
      }
    }

    editorEl.focus();
    const selection = window.getSelection();
    if (!selection) return false;

    const range = document.createRange();
    range.setStart(textNode, startOffset);
    range.setEnd(textNode, startOffset + token.length);
    selection.removeAllRanges();
    selection.addRange(range);

    // Notify Draft.js of the updated selection so internal SelectionState syncs
    document.dispatchEvent(new Event('selectionchange', { bubbles: true }));
    editorEl.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await sleep(80);

    try {
      document.execCommand('delete', false);
    } catch {
      // Fallback if execCommand is restricted
    }
    await sleep(80);
    return true;
  }

  function dispatchSyntheticTextPaste(editorEl, html, plainText) {
    const dt = new DataTransfer();
    dt.setData('text/html', html);
    dt.setData('text/plain', plainText);

    const pasteEvt = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: dt,
    });
    Object.defineProperty(pasteEvt, '__morphSynthetic', { value: true });
    editorEl.dispatchEvent(pasteEvt);
  }

  function dispatchSyntheticFilePaste(editorEl, file) {
    const dt = new DataTransfer();
    dt.items.add(file);

    const pasteEvt = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: dt,
    });
    Object.defineProperty(pasteEvt, '__morphSynthetic', { value: true });
    editorEl.dispatchEvent(pasteEvt);
  }

  document.addEventListener(
    'paste',
    async function (event) {
      if (event.__morphSynthetic) return;

      const target = event.target;
      const editorEl =
        target && typeof target.closest === 'function'
          ? target.closest('.public-DraftEditor-content, [contenteditable="true"]')
          : null;
      if (!editorEl) return;

      const clip = event.clipboardData;
      if (!clip) return;

      const rawHtml = clip.getData('text/html') || '';
      if (
        !rawHtml ||
        (!rawHtml.includes('data:image/') &&
          !rawHtml.includes('<pre') &&
          !rawHtml.includes('morph-'))
      ) {
        return;
      }

      const parser = new DOMParser();
      const doc = parser.parseFromString(rawHtml, 'text/html');

      // Step A: Convert inline math <img> nodes into in-place Unicode text so paragraphs never break
      const allInitialImgs = Array.from(doc.querySelectorAll('img'));
      for (const img of allInitialImgs) {
        const rasterType = img.getAttribute('data-raster-type') || '';
        const mathDisplay = img.getAttribute('data-math-display') || '';
        const parent = img.parentElement;
        const parentHasOtherText =
          parent &&
          Array.from(parent.childNodes).some(
            (n) => n !== img && (n.textContent || '').trim().length > 0
          );

        if (rasterType === 'math' && (mathDisplay === 'inline' || parentHasOtherText)) {
          const rawTex = img.getAttribute('data-math-tex') || img.getAttribute('alt') || '';
          const unicodeMath = texToInlineUnicode(rawTex);
          const textNode = doc.createTextNode(unicodeMath || rawTex);
          if (img.parentNode) {
            img.parentNode.replaceChild(textNode, img);
          }
        }
      }

      // Step B: Normalize Callouts / multi-paragraph <blockquote> and nested <ul> lists with <br> line breaks
      normalizeBlockquotesForX(doc);
      normalizeListsForX(doc);

      // Step C: Rasterize <pre> code blocks into 2x Retina Syntax-Highlighted Code Card PNGs
      const preBlocks = Array.from(doc.querySelectorAll('pre'));
      for (const preEl of preBlocks) {
        const rendered = renderCodeBlockToDataUrl(preEl, doc);
        if (!rendered || !preEl.parentNode) continue;
        const codeP = doc.createElement('p');
        codeP.setAttribute('data-morph-raster-container', 'code');
        const codeImg = doc.createElement('img');
        codeImg.setAttribute('data-morph-rasterized', 'true');
        codeImg.setAttribute('data-raster-type', 'code');
        codeImg.setAttribute('width', String(rendered.cssWidth));
        codeImg.setAttribute('height', String(rendered.cssHeight));
        codeImg.setAttribute('alt', (preEl.textContent || 'code').slice(0, 120));
        codeImg.setAttribute('src', rendered.dataUrl);
        codeP.appendChild(codeImg);
        preEl.parentNode.replaceChild(codeP, preEl);
      }

      // Step D: Collect remaining block-level images (illustrations, tables, code cards, block math, SVGs)
      const imgs = Array.from(doc.querySelectorAll('img')).filter((img) => {
        const src = img.getAttribute('src') || '';
        return src.startsWith('data:image/');
      });

      if (imgs.length === 0) return;

      event.preventDefault();
      event.stopImmediatePropagation();

      const rawTasks = [];
      imgs.forEach((img, idx) => {
        const src = img.getAttribute('src') || '';
        const token = `XIMGPH_${idx}_END`;
        rawTasks.push({ index: idx, token, src });

        const parent = img.parentElement;
        const isStandalone =
          parent &&
          (parent.tagName === 'P' || parent.tagName === 'FIGURE' || parent.tagName === 'DIV') &&
          parent.querySelectorAll('img').length === 1 &&
          (parent.textContent || '').trim().length === 0;

        const placeholderP = doc.createElement('p');
        placeholderP.textContent = token;

        if (isStandalone && parent.parentNode) {
          parent.parentNode.replaceChild(placeholderP, parent);
        } else if (img.parentNode) {
          img.parentNode.replaceChild(placeholderP, img);
        }
      });

      const tasks = [];
      for (const item of rawTasks) {
        const file = await ensureXSafeImageFile(item.src, item.index);
        if (file) {
          tasks.push({ index: item.index, token: item.token, file });
        }
      }

      if (tasks.length === 0) return;

      const sanitizedHtml = doc.body.innerHTML;
      const sanitizedPlain = (doc.body.textContent || '').trim();

      showProgressToast(`MorphMD · 正在写入排版并准备上传 (${tasks.length} 张图表)`, 'progress');

      // Step 1: Paste all rich-text formatting with XIMGPH_i_END placeholder tokens
      dispatchSyntheticTextPaste(editorEl, sanitizedHtml, sanitizedPlain);
      await sleep(180);

      // Step 2: Upload images in REVERSE order (bottom-to-top) so inserting atomic media blocks
      // never shifts or invalidates DOM nodes/offsets of earlier placeholders above!
      let uploadedCount = 0;
      for (let i = tasks.length - 1; i >= 0; i--) {
        const task = tasks[i];
        uploadedCount++;
        showProgressToast(
          `MorphMD · 正在上传图片 (${uploadedCount}/${tasks.length})`,
          'progress'
        );

        const beforeMediaCount = countEditorMediaNodes(editorEl);
        await selectAndClearToken(editorEl, task.token);
        await sleep(50);

        dispatchSyntheticFilePaste(editorEl, task.file);
        await waitForMediaBlockInsertion(editorEl, beforeMediaCount, 3000);
      }

      showProgressToast(`MorphMD · 已完成 ${tasks.length} 张图表原位上传`, 'done');
    },
    true
  );
})();
