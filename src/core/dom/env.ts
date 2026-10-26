/**
 * Cross-environment DOM abstraction.
 * Ensures zero static bundling of JSDOM in real browsers to avoid crashing Vite / Chromium.
 */

let cachedJSDOM: any = null;

function getJSDOMConstructor(): any {
  if (cachedJSDOM) return cachedJSDOM;
  if (typeof window === 'undefined') {
    try {
      const proc = (globalThis as any).process;
      const req = proc?.getBuiltinModule?.('module')?.createRequire(import.meta.url)
        || (typeof require !== 'undefined' ? require : null);
      if (req) {
        cachedJSDOM = req('jsdom').JSDOM;
      }
    } catch {
      // JSDOM unavailable
    }
  }
  return cachedJSDOM;
}

export function isRealBrowser(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined' && !!document.body;
}

export interface SandboxContext {
  doc: Document;
  win: Window;
  root: HTMLElement;
  cleanup: () => void;
}

let browserSandboxIframe: HTMLIFrameElement | null = null;
let browserSandboxStyleEl: HTMLStyleElement | null = null;
let browserSandboxContainer: HTMLElement | null = null;
let browserSandboxLastCss: string | null = null;
let browserSandboxInUse = false;

function ensureBrowserSandbox(): {
  doc: Document;
  win: Window;
  styleEl: HTMLStyleElement;
  container: HTMLElement;
} | null {
  if (
    browserSandboxIframe &&
    browserSandboxIframe.isConnected &&
    browserSandboxIframe.contentDocument &&
    browserSandboxIframe.contentWindow &&
    browserSandboxStyleEl &&
    browserSandboxContainer
  ) {
    return {
      doc: browserSandboxIframe.contentDocument,
      win: browserSandboxIframe.contentWindow,
      styleEl: browserSandboxStyleEl,
      container: browserSandboxContainer,
    };
  }

  const iframe = document.createElement('iframe');
  iframe.setAttribute('data-morph-sandbox', 'true');
  iframe.setAttribute('sandbox', 'allow-same-origin');
  iframe.style.cssText =
    'position:fixed;left:-99999px;top:-99999px;width:1024px;height:768px;visibility:hidden;pointer-events:none;border:0;';
  (document.body || document.documentElement).appendChild(iframe);

  const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
  const iframeWin = iframe.contentWindow;
  if (!iframeDoc || !iframeWin) {
    iframe.remove();
    return null;
  }

  iframeDoc.open();
  iframeDoc.write('<!DOCTYPE html><html><head></head><body><div data-morph-sandbox></div></body></html>');
  iframeDoc.close();

  const styleEl = iframeDoc.createElement('style');
  iframeDoc.head.appendChild(styleEl);
  const container = iframeDoc.querySelector('[data-morph-sandbox]') as HTMLElement;

  browserSandboxIframe = iframe;
  browserSandboxStyleEl = styleEl;
  browserSandboxContainer = container;
  browserSandboxLastCss = null;

  return { doc: iframeDoc, win: iframeWin, styleEl, container };
}

let nodeSandboxDom: any = null;
let nodeSandboxStyleEl: HTMLStyleElement | null = null;
let nodeSandboxContainer: HTMLElement | null = null;
let nodeSandboxLastCss: string | null = null;
let nodeSandboxInUse = false;

function ensureNodeSandbox(): {
  doc: Document;
  win: Window;
  styleEl: HTMLStyleElement;
  container: HTMLElement;
} {
  if (nodeSandboxDom && nodeSandboxStyleEl && nodeSandboxContainer) {
    return {
      doc: nodeSandboxDom.window.document,
      win: nodeSandboxDom.window as unknown as Window,
      styleEl: nodeSandboxStyleEl,
      container: nodeSandboxContainer,
    };
  }
  const JSDOM = getJSDOMConstructor();
  if (!JSDOM) {
    throw new Error('JSDOM is required in Node environment for style computation.');
  }
  const dom = new JSDOM(
    '<!DOCTYPE html><html><head></head><body><div data-morph-sandbox></div></body></html>',
    { url: 'https://morph.test/' }
  );
  const doc = dom.window.document as Document;
  const styleEl = doc.createElement('style');
  doc.head.appendChild(styleEl);
  const container = doc.querySelector('[data-morph-sandbox]') as HTMLElement;

  nodeSandboxDom = dom;
  nodeSandboxStyleEl = styleEl;
  nodeSandboxContainer = container;
  nodeSandboxLastCss = null;

  return {
    doc,
    win: dom.window as unknown as Window,
    styleEl,
    container,
  };
}

function clearElementAttributes(el: Element | null | undefined): void {
  if (!el) return;
  while (el.attributes.length > 0) {
    el.removeAttribute(el.attributes[0].name);
  }
}

/**
 * Executes a callback within a DOM sandbox where CSS cascade and computed styles can be evaluated.
 */
export function runInDomSandbox<T>(
  html: string,
  css: string,
  callback: (root: HTMLElement, doc: Document, win: Window) => T
): T {
  if (isRealBrowser()) {
    if (!browserSandboxInUse) {
      const sb = ensureBrowserSandbox();
      if (sb) {
        browserSandboxInUse = true;
        try {
          if (browserSandboxLastCss !== css) {
            sb.styleEl.textContent = css;
            browserSandboxLastCss = css;
          }
          sb.container.innerHTML = html;
          const root = (sb.container.querySelector('.morph-doc') ||
            sb.container.firstElementChild ||
            sb.container) as HTMLElement;
          return callback(root, sb.doc, sb.win);
        } finally {
          sb.container.innerHTML = '';
          clearElementAttributes(sb.doc.documentElement);
          clearElementAttributes(sb.doc.body);
          browserSandboxInUse = false;
        }
      }
    }

    // Fallback for re-entrant calls
    const iframe = document.createElement('iframe');
    iframe.setAttribute('data-morph-sandbox', 'true');
    iframe.setAttribute('sandbox', 'allow-same-origin');
    iframe.style.cssText =
      'position:fixed;left:-99999px;top:-99999px;width:1024px;height:768px;visibility:hidden;pointer-events:none;border:0;';
    (document.body || document.documentElement).appendChild(iframe);

    try {
      const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
      const iframeWin = iframe.contentWindow;
      if (!iframeDoc || !iframeWin) {
        throw new Error('Failed to access iframe document or window');
      }

      iframeDoc.open();
      iframeDoc.write('<!DOCTYPE html><html><head></head><body><div data-morph-sandbox></div></body></html>');
      iframeDoc.close();

      const styleEl = iframeDoc.createElement('style');
      styleEl.textContent = css;
      iframeDoc.head.appendChild(styleEl);

      const container = iframeDoc.querySelector('[data-morph-sandbox]') as HTMLElement;
      container.innerHTML = html;

      const root = (container.querySelector('.morph-doc') || container.firstElementChild || container) as HTMLElement;
      return callback(root, iframeDoc, iframeWin);
    } finally {
      iframe.remove();
    }
  }

  // Node environment via lazily loaded JSDOM
  if (!nodeSandboxInUse) {
    const sb = ensureNodeSandbox();
    nodeSandboxInUse = true;
    try {
      if (nodeSandboxLastCss !== css) {
        sb.styleEl.textContent = css;
        nodeSandboxLastCss = css;
      }
      sb.container.innerHTML = html;
      const root = (sb.container.querySelector('.morph-doc') ||
        sb.container.firstElementChild ||
        sb.container) as HTMLElement;
      return callback(root, sb.doc, sb.win);
    } finally {
      sb.container.innerHTML = '';
      clearElementAttributes(sb.doc.documentElement);
      clearElementAttributes(sb.doc.body);
      nodeSandboxInUse = false;
    }
  }

  const JSDOM = getJSDOMConstructor();
  if (!JSDOM) {
    throw new Error('JSDOM is required in Node environment for style computation.');
  }

  const dom = new JSDOM(
    '<!DOCTYPE html><html><head></head><body><div data-morph-sandbox></div></body></html>',
    { url: 'https://morph.test/' }
  );

  const doc = dom.window.document;
  const styleEl = doc.createElement('style');
  styleEl.textContent = css;
  doc.head.appendChild(styleEl);

  const container = doc.querySelector('[data-morph-sandbox]') as HTMLElement;
  container.innerHTML = html;
  const root = (container.querySelector('.morph-doc') || container.firstElementChild || container) as HTMLElement;

  try {
    return callback(root, doc, dom.window as unknown as Window);
  } finally {
    dom.window.close();
  }
}

let browserReusableParseDoc: Document | null = null;
let browserParseDocInUse = false;

let nodeReusableParseDom: any = null;
let nodeParseDocInUse = false;

/**
 * Creates a standalone document without attached styles.
 */
export function parseDocument(html: string): { doc: Document; cleanup: () => void } {
  if (isRealBrowser()) {
    if (!browserParseDocInUse) {
      if (!browserReusableParseDoc) {
        browserReusableParseDoc = document.implementation.createHTMLDocument('');
      }
      browserParseDocInUse = true;
      const doc = browserReusableParseDoc;
      doc.body.innerHTML = html;
      return {
        doc,
        cleanup: () => {
          doc.body.innerHTML = '';
          browserParseDocInUse = false;
        },
      };
    }

    const doc = document.implementation.createHTMLDocument('');
    doc.body.innerHTML = html;
    return { doc, cleanup: () => {} };
  }

  const JSDOM = getJSDOMConstructor();
  if (!JSDOM) {
    throw new Error('JSDOM is required in Node environment.');
  }

  if (!nodeParseDocInUse) {
    if (!nodeReusableParseDom) {
      nodeReusableParseDom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
        url: 'https://morph.test/',
      });
    }
    nodeParseDocInUse = true;
    const doc = nodeReusableParseDom.window.document as Document;
    doc.body.innerHTML = html;
    return {
      doc,
      cleanup: () => {
        doc.body.innerHTML = '';
        nodeParseDocInUse = false;
      },
    };
  }

  const dom = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`, { url: 'https://morph.test/' });
  return {
    doc: dom.window.document,
    cleanup: () => {
      try {
        dom.window.close();
      } catch {}
    },
  };
}
