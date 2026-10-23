import { afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { fromHtml } from 'hast-util-from-html';
import { AssetStore } from '../../src/core/assets';
import type { DeliverySnapshot, TargetId } from '../../src/core/snapshot';

const windows: JSDOM[] = [];
const stores: AssetStore[] = [];
afterEach(() => {
  windows.splice(0).forEach(dom => dom.window.close());
  stores.splice(0).forEach(store => store.clear());
});

export function documentOf(html: string): Document {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: 'https://morph.test/' });
  windows.push(dom);
  return dom.window.document;
}

export function assetStore(options?: ConstructorParameters<typeof AssetStore>[0]): AssetStore {
  const store = new AssetStore(options);
  stores.push(store);
  return store;
}

export function snapshotOf(html: string, targetId: TargetId = 'wechat'): DeliverySnapshot {
  return {
    version: { doc: 1, style: 1, assets: 1 }, targetId, ready: true, html,
    hast: fromHtml(html, { fragment: true }), diagnostics: [], sourceMap: [],
  };
}

export function selectionFixture(content: string, targetId: TargetId = 'wechat') {
  const html = `<div class="morph-doc">${content}</div>`;
  const doc = documentOf(html);
  return { doc, root: doc.querySelector<HTMLElement>('.morph-doc')!, snapshot: snapshotOf(html, targetId) };
}

export function evidence(_name: string, _value: unknown): void {
  // No-op in standard unit tests
}
