import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { AssetStore } from './core/assets';
import type { TargetId } from './core/snapshot';

interface NotionBundlePayload {
  title: string;
  markdown: string;
  images: string[];
}

const LAST_TARGET_STORAGE_KEY = 'morphmd:last-target-id';

function getInitialTargetId(): TargetId {
  try {
    const saved = window.localStorage.getItem(LAST_TARGET_STORAGE_KEY);
    if (saved === 'wechat' || saved === 'x-article' || saved === 'cards') {
      return saved;
    }
  } catch {
    // Ignore storage access errors
  }
  return 'x-article';
}

window.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement | null)?.closest?.('[data-target]');
  const nextTarget = target?.getAttribute('data-target');
  if (nextTarget === 'wechat' || nextTarget === 'x-article' || nextTarget === 'cards') {
    try {
      window.localStorage.setItem(LAST_TARGET_STORAGE_KEY, nextTarget);
    } catch {
      // Ignore storage access errors
    }
  }
});

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

const rootElement = document.getElementById('root');
if (rootElement) {
  const root = ReactDOM.createRoot(rootElement);
  const initialTargetId = getInitialTargetId();

  void (async () => {
    try {
      const res = await fetch('/work/notion-vibe-coder-net-1.json', { cache: 'no-store' });
      if (res.ok) {
        const bundle = (await res.json()) as NotionBundlePayload;
        if (bundle && typeof bundle.markdown === 'string' && Array.isArray(bundle.images)) {
          const store = new AssetStore();
          let md = bundle.markdown;
          for (let i = 0; i < bundle.images.length; i++) {
            const bytes = base64ToUint8Array(bundle.images[i]);
            const rec = store.ingestSync(bytes, {
              fileName: `mindmap-${i + 1}.png`,
              mimeType: 'image/png',
            });
            md = md.replace(`__MORPH_NOTION_ASSET_${i + 1}__`, rec.uri);
          }
          document.documentElement.setAttribute('data-surface', 'workbench');
          root.render(
            <React.StrictMode>
              <App
                key={`notion-${md.length}`}
                assetStore={store}
                initialMarkdown={md}
                initialTargetId={initialTargetId}
              />
            </React.StrictMode>
          );
          return;
        }
      }
    } catch {
      // Fallback to default showcase
    }

    root.render(
      <React.StrictMode>
        <App initialTargetId={initialTargetId} />
      </React.StrictMode>
    );
  })();
}
