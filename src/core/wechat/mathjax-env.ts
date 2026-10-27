// Ensure MathJax's browser version check (`typeof PACKAGE_VERSION === 'undefined'`)
// does not fall back to `eval('require')('path')` when bundled for the browser.
if (
  typeof globalThis !== 'undefined' &&
  typeof (globalThis as Record<string, unknown>).PACKAGE_VERSION === 'undefined'
) {
  (globalThis as Record<string, unknown>).PACKAGE_VERSION = '3.2.2';
}
