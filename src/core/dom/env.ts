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

/**
 * Executes a callback within a DOM sandbox where CSS cascade and computed styles can be evaluated.
 */
export function runInDomSandbox<T>(
  html: string,
  css: string,
  callback: (root: HTMLElement, doc: Document, win: Window) => T
): T {
  if (isRealBrowser()) {
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

/**
 * Creates a standalone document without attached styles.
 */
export function parseDocument(html: string): { doc: Document; cleanup: () => void } {
  if (isRealBrowser()) {
    const template = document.createElement('template');
    template.innerHTML = html;
    const doc = document.implementation.createHTMLDocument('');
    doc.body.appendChild(template.content.cloneNode(true));
    return { doc, cleanup: () => {} };
  }

  const JSDOM = getJSDOMConstructor();
  if (!JSDOM) {
    throw new Error('JSDOM is required in Node environment.');
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
