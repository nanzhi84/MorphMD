import * as fs from 'node:fs';
import * as path from 'node:path';
import { JSDOM } from 'jsdom';
import { jpeg, png } from '../tests/support/fixtures';
import {
  AssetStore,
  buildDeliverySnapshot,
  compileMarkdown,
  getDefaultCapabilities,
  globalHeavyBlockCache,
  normalizeSelectionRange,
  serializeFullSnapshot,
} from '../src/index';

async function main() {
  console.log('=== MorphMD Core Verification Execution ===');

  const workDir = process.env.HARNESS_WORK_DIR || path.resolve(process.cwd(), 'work');
  const artifactsDir = process.env.HARNESS_ARTIFACTS_DIR || path.resolve(process.cwd(), 'artifacts');

  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(artifactsDir, { recursive: true });

  console.log(`Work Dir: ${workDir}`);
  console.log(`Artifacts Dir: ${artifactsDir}`);

  // 1. Construct binary images (Real PNG + Real JPEG with EXIF orientation 6)
  // 1.1 PNG (100x100 valid PNG)
  const pngBytes = png(1, 100, 100);

  // 1.2 Real decodable JPEG with EXIF orientation 6 (Natural: 3x2 -> Visual: 2x3)
  const jpegBytes = jpeg(6);

  fs.writeFileSync(path.join(workDir, 'input-diagram.png'), pngBytes);
  fs.writeFileSync(path.join(workDir, 'input-hero.jpg'), jpegBytes);

  // 2. Ingest into AssetStore and verify state machine
  const assetStore = new AssetStore({ maxEntries: 50, maxBytes: 10 * 1024 * 1024 });

  const pngRecord = await assetStore.ingest(pngBytes, {
    fileName: 'diagram.png',
    remoteUrl: 'https://cdn.example.com/diagram.png',
  });
  const jpegRecord = await assetStore.ingest(jpegBytes, { fileName: 'hero.jpg', remoteUrl: 'https://cdn.example.com/hero.jpg' });

  console.log(`PNG Asset: ${pngRecord.id}, Status: ${pngRecord.status}, Width: ${pngRecord.width}, Height: ${pngRecord.height}`);
  console.log(`JPEG Asset: ${jpegRecord.id}, Status: ${jpegRecord.status}, Visual Dimensions: ${jpegRecord.width}x${jpegRecord.height}`);

  if (jpegRecord.width !== 2 || jpegRecord.height !== 3) {
    throw new Error(`EXIF orientation 6 did not swap dimensions! Expected 2x3, got ${jpegRecord.width}x${jpegRecord.height}`);
  }

  const pngHistory = assetStore.getTransitionHistory(pngRecord.id);
  console.log(`PNG Transition History: ${pngHistory.join(' -> ')}`);
  if (pngHistory.join(',') !== 'received,metadata-ready,preview-ready,delivery-ready') {
    throw new Error(`Unexpected transition history: ${pngHistory.join(',')}`);
  }

  // Deduplication check
  const dupRecord = await assetStore.ingest(pngBytes);
  if (dupRecord.id !== pngRecord.id || dupRecord.refCount !== 2) {
    throw new Error('Deduplication failed to reuse asset ID or increment refCount!');
  }
  assetStore.release(dupRecord.id);

  // Lock protection check
  const unlock = assetStore.acquireLock(pngRecord.id);
  assetStore.release(pngRecord.id); // refCount is now 0, but activeLocks is 1
  if (!pngRecord.blobUrl) {
    throw new Error('Blob URL was prematurely revoked while lock was active!');
  }
  unlock(); // activeLocks is now 0, refCount is 0 -> clean up

  // 3. Construct rich Markdown source
  const sourceMarkdown = `# MorphMD Core Engine Demo

A unified multi-target markdown delivery pipeline with isomorphic snapshots.

## Key Architecture Sections

> [!NOTE] Design Principle
> All platform adapters derive their view DOM from the exact same semantic AST.

> [!WARNING] Platform Capabilities
> X Articles will strip inline styles on native paragraphs, falling back to clean text.

### Mathematical Proof

The Gaussian integral satisfies:
$$
\\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}
$$
and mass-energy equivalence is given by $E = mc^2$.

### Syntax Highlighting with Shiki

\`\`\`typescript
export function computeHash(data: Uint8Array): string {
  return "hash_" + data.byteLength;
}
\`\`\`

### Matrix Feature Comparison

| Target View | Inline CSS | Rasterized Math | Image Transport |
| :--- | :---: | :---: | :--- |
| WeChat | Supported | Yes | Inline Data URL |
| X Article | Unsupported | Yes | Remote HTTPS |
| Cards | Supported | Yes | Inline Data URL |

### Asset Embedding

Here is the hero image via cross-block reference definition:

![Hero Image][hero-ref]

And the system diagram:

![Architecture Diagram](morph-asset://${pngRecord.id})

### Ordered Execution Steps

1. Parse markdown into unified AST
2. Extract CSS AST property whitelist
3. Resolve image assets to delivery representations
4. Reconstruct selection context for clipboard delivery

[hero-ref]: morph-asset://${jpegRecord.id} "Hero Image"
[malicious-link](javascript:alert("exploit"))
`;

  fs.writeFileSync(path.join(workDir, 'source.md'), sourceMarkdown);

  // 4. Custom CSS
  const customCss = `
    @import url("https://malicious.example.com/evil.css");

    .morph-h1 {
      color: var(--morph-accent);
      border-bottom: 2px solid var(--morph-accent);
      padding-bottom: 8px;
    }

    .morph-h2::before {
      content: "§ ";
      color: var(--morph-accent);
    }

    .morph-callout-note {
      background-color: #f0f7ff;
      border-left: 4px solid var(--morph-accent);
      padding: 12px;
    }

    .morph-callout-warning {
      background-color: #fff8e6;
      border-left: 4px solid #f08800;
      padding: 12px;
    }

    .bad-position {
      position: fixed;
      top: 0;
    }

    .bad-url {
      background-image: url(javascript:alert(1));
    }

    body {
      background: yellow;
    }
  `;

  fs.writeFileSync(path.join(workDir, 'custom.css'), customCss);

  // 5. Heavy Block Cache verification
  globalHeavyBlockCache.clear();
  console.log('Testing HeavyBlockCache warm-up...');
  await compileMarkdown(sourceMarkdown, { themeKey: 'github-light' });
  const stats1 = globalHeavyBlockCache.getStats();
  console.log(`Cache stats after compile 1: hits=${stats1.hits}, misses=${stats1.misses}, size=${stats1.size}`);

  await compileMarkdown(sourceMarkdown, { themeKey: 'github-light' });
  const stats2 = globalHeavyBlockCache.getStats();
  console.log(`Cache stats after compile 2: hits=${stats2.hits}, misses=${stats2.misses}, size=${stats2.size}`);

  if (stats2.hits < 1) {
    throw new Error('HeavyBlockCache did not record hits on re-compilation!');
  }

  // 6. Build Delivery Snapshots
  console.log('Building WeChat delivery snapshot...');
  const wechatSnapshot = await buildDeliverySnapshot(sourceMarkdown, 'wechat', assetStore, {
    customCss,
    tokens: {
      '--morph-accent': '#0969da',
    },
  });

  console.log('Building X-Article delivery snapshot...');
  const xSnapshot = await buildDeliverySnapshot(sourceMarkdown, 'x-article', assetStore, {
    customCss,
    tokens: {
      '--morph-accent': '#0969da',
    },
  });

  fs.writeFileSync(path.join(artifactsDir, 'snapshot-wechat.html'), wechatSnapshot.html);
  fs.writeFileSync(path.join(artifactsDir, 'snapshot-x-article.html'), xSnapshot.html);

  // 7. Verify Selection Normalizer
  console.log('Testing Selection Context Normalizer...');
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${wechatSnapshot.html}</body></html>`);
  const doc = dom.window.document;
  const rootContainer = doc.querySelector('.morph-doc') as HTMLElement;

  // 7.1 Selection 1: Heading partial text selection inside <h2>
  const h2Element = rootContainer.querySelector('.morph-h2') as HTMLElement;
  const rangeHeading = doc.createRange();
  // Select "Key Architecture Sections"
  rangeHeading.selectNodeContents(h2Element.lastChild || h2Element);
  const payloadHeading = normalizeSelectionRange(rangeHeading, rootContainer, wechatSnapshot, assetStore);
  fs.writeFileSync(path.join(artifactsDir, 'selection-heading.html'), payloadHeading.html);
  console.log('Selection 1 (Heading) Reconstructed HTML:\n', payloadHeading.html);

  if (!payloadHeading.html.includes('morph-h2') || !payloadHeading.html.includes('data-morph-pseudo="before"')) {
    throw new Error('Heading selection failed to reconstruct ancestor h2 tag and ::before pseudo-element!');
  }

  // 7.2 Selection 2: Ordered List partial selection starting at item #3
  const olElement = rootContainer.querySelector('ol') as HTMLOListElement;
  const liElements = olElement.querySelectorAll('li');
  const thirdLi = liElements[2]; // "3. Resolve image assets..."
  const fourthLi = liElements[3]; // "4. Reconstruct selection context..."
  const rangeList = doc.createRange();
  rangeList.setStart(thirdLi.firstChild || thirdLi, 0);
  rangeList.setEnd(fourthLi.firstChild || fourthLi, fourthLi.textContent?.length || 0);

  const payloadList = normalizeSelectionRange(rangeList, rootContainer, wechatSnapshot, assetStore);
  fs.writeFileSync(path.join(artifactsDir, 'selection-list.html'), payloadList.html);
  console.log('Selection 2 (List) Reconstructed HTML:\n', payloadList.html);

  if (!payloadList.html.includes('start="3"')) {
    throw new Error('Mid-list selection failed to reconstruct <ol start="3">!');
  }

  // 7.3 Selection 3: Cross-Page selection in cards view
  const cardsHtml = `
    <div class="morph-doc">
      <div class="morph-card-page" data-page="1">
        <header class="morph-card-header" data-morph-generated="header"><span>MorphMD Daily</span></header>
        <p class="morph-p">Card Page 1 paragraph content.</p>
        <footer class="morph-card-footer" data-morph-generated="footer"><span>Page 1 of 2</span></footer>
      </div>
      <div class="morph-card-page" data-page="2">
        <header class="morph-card-header" data-morph-generated="header"><span>MorphMD Daily</span></header>
        <p class="morph-p">Card Page 2 paragraph content.</p>
        <footer class="morph-card-footer" data-morph-generated="footer"><span>Page 2 of 2</span></footer>
      </div>
    </div>
  `;
  const cardsDom = new JSDOM(`<!DOCTYPE html><html><body>${cardsHtml}</body></html>`);
  const cardsDoc = cardsDom.window.document;
  const cardsRoot = cardsDoc.querySelector('.morph-doc') as HTMLElement;
  const p1 = cardsRoot.querySelectorAll('p')[0];
  const p2 = cardsRoot.querySelectorAll('p')[1];

  const cardsRange = cardsDoc.createRange();
  cardsRange.setStart(p1.firstChild || p1, 0);
  cardsRange.setEnd(p2.firstChild || p2, p2.textContent?.length || 0);

  const cardsCapabilities = getDefaultCapabilities('cards');
  const cardsSnapshot = await buildDeliverySnapshot(sourceMarkdown, 'cards', assetStore, {
    capabilities: cardsCapabilities,
  });

  if (!wechatSnapshot.ready || !xSnapshot.ready || !cardsSnapshot.ready) {
    throw new Error('Snapshot not ready! WeChat, X-Article, or Cards snapshot has errors preventing delivery readiness.');
  }

  const payloadCards = normalizeSelectionRange(cardsRange, cardsRoot, cardsSnapshot, assetStore);
  fs.writeFileSync(path.join(artifactsDir, 'selection-cross-page.html'), payloadCards.html);
  console.log('Selection 3 (Cards Cross-Page) Reconstructed HTML:\n', payloadCards.html);

  if (payloadCards.html.includes('data-morph-generated') || payloadCards.html.includes('morph-card-page')) {
    throw new Error('Cross-page selection failed to strip generated headers/footers or unwrap card page containers!');
  }

  // 7.4 Full Snapshot Serialization
  const fullPayload = serializeFullSnapshot(wechatSnapshot, assetStore);

  // 8. Asset package manifest export
  const manifest = assetStore.exportPackageManifest(sourceMarkdown);
  fs.writeFileSync(
    path.join(artifactsDir, 'asset-manifest.json'),
    JSON.stringify(
      {
        rewrittenContentSnippet: manifest.rewrittenContent.slice(0, 300) + '...',
        assets: manifest.assets.map((a) => ({
          assetId: a.assetId,
          originalUri: a.originalUri,
          exportPath: a.exportPath,
          mimeType: a.mimeType,
          byteLength: a.data.byteLength,
          remoteUrl: assetStore.get(a.assetId)?.remoteUrl,
        })),
      },
      null,
      2
    )
  );

  // 9. Write diagnostics & payloads
  const allDiagnostics = [
    ...wechatSnapshot.diagnostics,
    ...xSnapshot.diagnostics,
    ...payloadHeading.diagnostics,
    ...payloadList.diagnostics,
    ...payloadCards.diagnostics,
  ];

  fs.writeFileSync(path.join(artifactsDir, 'diagnostics.json'), JSON.stringify(allDiagnostics, null, 2));

  fs.writeFileSync(
    path.join(artifactsDir, 'clipboard-payloads.json'),
    JSON.stringify(
      {
        headingSelection: {
          html: payloadHeading.html,
          plainText: payloadHeading.plainText,
        },
        listSelection: {
          html: payloadList.html,
          plainText: payloadList.plainText,
        },
        crossPageCardsSelection: {
          html: payloadCards.html,
          plainText: payloadCards.plainText,
        },
        fullWechatSnapshot: {
          htmlSnippet: fullPayload.html.slice(0, 500) + '...',
          plainTextSnippet: fullPayload.plainText.slice(0, 300) + '...',
        },
      },
      null,
      2
    )
  );

  const summary = {
    timestamp: new Date().toISOString(),
    status: 'PASS',
    wechatSnapshotLength: wechatSnapshot.html.length,
    xSnapshotLength: xSnapshot.html.length,
    assetsCount: manifest.assets.length,
    cacheStats: globalHeavyBlockCache.getStats(),
    diagnosticsCount: allDiagnostics.length,
    diagnosticsSample: allDiagnostics.slice(0, 5),
  };

  fs.writeFileSync(path.join(artifactsDir, 'summary.json'), JSON.stringify(summary, null, 2));

  console.log('=== All Verifications Succeeded Cleanly ===');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error('Verification failed with error:', err);
  process.exit(1);
});
