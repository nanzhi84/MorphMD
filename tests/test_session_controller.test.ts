import { build } from 'esbuild';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { buildDeliverySnapshot } from '../src/core/snapshot';
import type { DeliverySnapshot } from '../src/core/snapshot';
import { getDefaultCapabilities } from '../src/core/style';
import { createEditorSession, EditorSessionController } from '../src/core/session';
import { assetStore, documentOf, evidence } from './support/contracts';
import { png } from './support/fixtures';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function bundleMorphMdForBrowser(): Promise<string> {
  const result = await build({
    entryPoints: ['src/index.ts'],
    bundle: true,
    format: 'iife',
    globalName: 'MorphMD',
    platform: 'browser',
    target: 'es2022',
    write: false,
    external: ['jsdom'],
    logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}

describe('TestEditorSessionController', () => {
  it('test_input_doc_updates_draft_markdown_immediately_without_advancing_doc_version_before_debounce', async () => {
    const store = assetStore();
    const session = createEditorSession({
      assetStore: store,
      debounceMs: 120,
    });

    expect(session).toBeInstanceOf(EditorSessionController);
    expect(session.getDraftMarkdown()).toBe('');
    expect(session.getCommittedMarkdown()).toBe('');
    expect(session.getVersion()).toEqual({ doc: 0, style: 1, assets: 1 });
    expect(session.getSnapshot()).toBeNull();

    const pendingFirst = session.inputDoc('# Heading');
    expect(session.getDraftMarkdown()).toBe('# Heading');
    expect(session.getCommittedMarkdown()).toBe('');
    expect(session.getVersion().doc).toBe(0);

    const pendingSecond = session.scheduleDocUpdate('# Heading\n\nUpdated paragraph');
    expect(session.getDraftMarkdown()).toBe('# Heading\n\nUpdated paragraph');
    expect(session.getCommittedMarkdown()).toBe('');
    expect(session.getVersion().doc).toBe(0);

    const committed = await Promise.all([pendingFirst, pendingSecond]);
    expect(committed[1].version).toEqual({ doc: 1, style: 1, assets: 1 });
    expect(session.getCommittedMarkdown()).toBe('# Heading\n\nUpdated paragraph');
    expect(documentOf(committed[1].html).querySelector('h1')!.textContent).toBe('Heading');
    expect(documentOf(committed[1].html).querySelector('p')!.textContent).toBe('Updated paragraph');

    session.dispose();
  });

  it('test_rapid_keystrokes_within_debounce_window_coalesce_into_single_doc_increment_and_snapshot', async () => {
    const store = assetStore();
    const builtInputs: Array<{ markdown: string; doc: number }> = [];

    const session = createEditorSession({
      assetStore: store,
      debounceMs: 80,
      snapshotBuilder: async (markdown, targetId, currentStore, options) => {
        builtInputs.push({
          markdown,
          doc: options.version?.doc ?? 0,
        });
        return buildDeliverySnapshot(markdown, targetId, currentStore, options);
      },
    });

    const targetText = 'Hello World';
    const keystrokePromises: Array<Promise<DeliverySnapshot>> = [];

    for (let i = 1; i <= targetText.length; i++) {
      keystrokePromises.push(session.inputDoc(targetText.slice(0, i)));
      if (i === 5 || i === 9) {
        // Pause 45ms (< 80ms debounce window) to verify each keystroke resets the debounce timer
        await delay(45);
        expect(session.getVersion().doc).toBe(0);
        expect(builtInputs).toHaveLength(0);
      }
    }

    expect(session.getDraftMarkdown()).toBe('Hello World');
    expect(session.getVersion().doc).toBe(0);
    expect(builtInputs).toHaveLength(0);

    const snapshots = await Promise.all(keystrokePromises);
    const finalSnapshot = snapshots[snapshots.length - 1];
    evidence('session-debounce-batching', {
      builtInputs,
      version: finalSnapshot.version,
      html: finalSnapshot.html,
    });

    expect(builtInputs).toEqual([{ markdown: 'Hello World', doc: 1 }]);
    expect(session.getVersion()).toEqual({ doc: 1, style: 1, assets: 1 });
    expect(session.getCommittedMarkdown()).toBe('Hello World');
    expect(documentOf(finalSnapshot.html).querySelector('p')!.textContent).toBe('Hello World');

    session.dispose();
  });

  it('test_commit_doc_and_flush_cancel_pending_debounce_and_commit_immediately', async () => {
    const store = assetStore();
    const builtInputs: string[] = [];

    const session = createEditorSession({
      assetStore: store,
      debounceMs: 150,
      snapshotBuilder: async (markdown, targetId, currentStore, options) => {
        builtInputs.push(markdown);
        return buildDeliverySnapshot(markdown, targetId, currentStore, options);
      },
    });

    const debouncedPromise = session.inputDoc('Immediate flush content');
    expect(session.getVersion().doc).toBe(0);

    const flushedSnapshot = await session.flush();
    const resolvedFromInput = await debouncedPromise;

    expect(flushedSnapshot.version.doc).toBe(1);
    expect(resolvedFromInput.version.doc).toBe(1);
    expect(builtInputs).toEqual(['Immediate flush content']);
    expect(documentOf(flushedSnapshot.html).querySelector('p')!.textContent).toBe('Immediate flush content');

    // Wait past the original 150ms debounce window to ensure the cancelled timer does not fire a duplicate commit
    await delay(180);
    expect(session.getVersion().doc).toBe(1);
    expect(builtInputs).toEqual(['Immediate flush content']);

    session.dispose();
  });

  it('test_multiple_snapshot_updates_within_single_animation_frame_coalesce_into_single_rendered_frame', async () => {
    const store = assetStore();
    const pendingFrameCallbacks: Array<(timestamp: number) => void> = [];
    let nextHandle = 1;

    const session = createEditorSession({
      assetStore: store,
      requestAnimationFrame: (cb) => {
        pendingFrameCallbacks.push(cb);
        return nextHandle++;
      },
      cancelAnimationFrame: () => {},
    });

    const renderedNotifications: DeliverySnapshot[] = [];
    const unsubscribe = session.subscribe((snapshot) => {
      renderedNotifications.push(snapshot);
    });

    const firstSnap = await session.commitDoc('First draft');
    expect(session.getStagedSnapshot()?.version).toEqual({ doc: 1, style: 1, assets: 1 });
    expect(firstSnap.version).toEqual({ doc: 1, style: 1, assets: 1 });
    expect(renderedNotifications).toHaveLength(0);

    const secondSnap = await session.commitDoc('Second draft');
    expect(session.getStagedSnapshot()?.version).toEqual({ doc: 2, style: 1, assets: 1 });
    expect(secondSnap.version).toEqual({ doc: 2, style: 1, assets: 1 });
    expect(renderedNotifications).toHaveLength(0);

    const thirdSnap = await session.updateStyle({
      customCss: '.morph-p { color: rgb(220, 38, 38); }',
    });
    expect(session.getStagedSnapshot()?.version).toEqual({ doc: 2, style: 2, assets: 1 });
    expect(thirdSnap.version).toEqual({ doc: 2, style: 2, assets: 1 });
    expect(renderedNotifications).toHaveLength(0);

    // Execute the animation frame boundary
    const callbacksToRun = pendingFrameCallbacks.splice(0);
    for (const cb of callbacksToRun) {
      cb(16.6);
    }

    evidence('session-raf-coalescing', {
      notificationCount: renderedNotifications.length,
      renderedVersion: session.getRenderedSnapshot()?.version,
    });

    expect(renderedNotifications).toHaveLength(1);
    expect(renderedNotifications[0].version).toEqual({ doc: 2, style: 2, assets: 1 });
    expect(session.getRenderedSnapshot()).toEqual(thirdSnap);

    const renderedDom = documentOf(session.getRenderedSnapshot()!.html);
    const paragraph = renderedDom.querySelector<HTMLElement>('p')!;
    expect(paragraph.textContent).toBe('Second draft');
    expect(paragraph.style.color).toBe('rgb(220, 38, 38)');

    unsubscribe();
    session.dispose();
  });

  it('test_doc_style_and_assets_versions_increment_monotonically_across_independent_mutations', async () => {
    const store = assetStore();
    const asset = await store.ingest(png(1));

    const session = createEditorSession({
      assetStore: store,
      initialMarkdown: `## Initial\n\n![chart](${asset.uri})`,
    });

    const initialSnapshot = await session.waitForIdle();
    expect(initialSnapshot).not.toBeNull();
    expect(session.getVersion()).toEqual({ doc: 1, style: 1, assets: 1 });

    const doc2 = await session.commitDoc(`## Second\n\n![chart](${asset.uri})`);
    expect(doc2.version).toEqual({ doc: 2, style: 1, assets: 1 });

    const doc3 = await session.commitDoc(`## Third\n\n![chart](${asset.uri})`);
    expect(doc3.version).toEqual({ doc: 3, style: 1, assets: 1 });

    const style2 = await session.updateStyle({
      tokens: { '--morph-body-size': '18px' },
    });
    expect(style2.version).toEqual({ doc: 3, style: 2, assets: 1 });

    const style3 = await session.setTarget('cards', undefined);
    expect(style3.version).toEqual({ doc: 3, style: 3, assets: 1 });
    expect(style3.targetId).toBe('cards');

    const assets2 = await session.notifyAssetsChanged();
    expect(assets2.version).toEqual({ doc: 3, style: 3, assets: 2 });

    const assets3 = await session.notifyAssetsChanged();
    expect(assets3.version).toEqual({ doc: 3, style: 3, assets: 3 });

    session.dispose();
  });

  it('test_slow_stale_compilation_finishing_after_newer_fast_commit_is_dropped_without_overwriting_snapshot', async () => {
    const store = assetStore();

    const session = createEditorSession({
      assetStore: store,
      snapshotBuilder: async (markdown, targetId, currentStore, options) => {
        if (markdown.includes('def slow_pipeline')) {
          await delay(60);
        } else {
          await delay(5);
        }
        return buildDeliverySnapshot(markdown, targetId, currentStore, options);
      },
    });

    const renderedHistory: DeliverySnapshot[] = [];
    session.subscribe((snap) => {
      renderedHistory.push(snap);
    });

    // Step 1: Submit doc: 1 with slow Python code block (~60ms)
    const slowCommitPromise = session.commitDoc(
      '```python\ndef slow_pipeline():\n    return "stale_code_block"\n```'
    );

    // Step 2: At ~15ms, delete the code block and commit doc: 2 with plain text (~5ms)
    await delay(15);
    const fastCommitPromise = session.commitDoc('Clean plain text replacement');

    const fastSnapshot = await fastCommitPromise;
    expect(fastSnapshot.version.doc).toBe(2);
    expect(session.getSnapshot()?.version.doc).toBe(2);
    expect(documentOf(session.getSnapshot()!.html).body.textContent).toContain('Clean plain text replacement');
    expect(documentOf(session.getSnapshot()!.html).body.textContent).not.toContain('slow_pipeline');

    // Step 3: Wait for slow doc: 1 compilation to finish at ~60ms
    await slowCommitPromise;
    await session.waitForIdle();
    session.flushRenderFrame();

    const dropped = session.getDroppedSnapshots();
    evidence('session-race-condition-guard', {
      activeVersion: session.getSnapshot()?.version,
      renderedVersion: session.getRenderedSnapshot()?.version,
      droppedVersions: dropped.map((s) => s.version),
      activeHtml: session.getSnapshot()?.html,
    });

    expect(dropped).toHaveLength(1);
    expect(dropped[0].version.doc).toBe(1);
    expect(session.getSnapshot()?.version.doc).toBe(2);
    expect(session.getRenderedSnapshot()?.version.doc).toBe(2);

    const activeDom = documentOf(session.getSnapshot()!.html);
    expect(activeDom.querySelector('pre, code')).toBeNull();
    expect(activeDom.querySelector('p')!.textContent).toBe('Clean plain text replacement');

    // Verify rendered notifications never regressed to doc: 1 after doc: 2
    const renderedDocs = renderedHistory.map((s) => s.version.doc);
    for (let i = 1; i < renderedDocs.length; i++) {
      expect(renderedDocs[i]).toBeGreaterThanOrEqual(renderedDocs[i - 1]);
    }

    session.dispose();
  });

  it('test_ast_asset_reference_tracking_retains_referenced_assets_and_ignores_code_literals', async () => {
    const store = assetStore();
    const firstAsset = await store.ingest(png(1));
    const secondAsset = await store.ingest(png(2));

    // Drop secondAsset refCount to 0 before session references it to verify retain() is invoked when referenced
    store.release(secondAsset.id);
    expect(store.get(secondAsset.id)!.refCount).toBe(0);

    const session = createEditorSession({
      assetStore: store,
      undoGracePeriodMs: 30000,
    });

    await session.commitDoc(
      `![primary](${firstAsset.uri})\n\nUse literal \`${secondAsset.uri}\` in inline code.`
    );

    expect(session.getReferencedAssetIds()).toEqual([firstAsset.id]);
    expect(store.get(firstAsset.id)!.refCount).toBeGreaterThanOrEqual(1);
    expect(store.get(secondAsset.id)!.refCount).toBe(0);

    // Now reference secondAsset in an actual AST image node
    await session.commitDoc(
      `![primary](${firstAsset.uri})\n\n![secondary](${secondAsset.uri})`
    );

    expect(new Set(session.getReferencedAssetIds())).toEqual(
      new Set([firstAsset.id, secondAsset.id])
    );
    expect(store.get(secondAsset.id)!.refCount).toBeGreaterThanOrEqual(1);

    session.dispose();
  });

  it('test_deleted_asset_enters_undo_grace_period_and_restores_intact_blob_url_on_undo_or_reinsert', async () => {
    const store = assetStore();
    const asset = await store.ingest(png(1));
    const originalBlobUrl = asset.blobUrl!;
    expect((await fetch(originalBlobUrl)).ok).toBe(true);

    const session = createEditorSession({
      assetStore: store,
      undoGracePeriodMs: 5000,
    });

    await session.commitDoc(`# Document with Image\n\n![diagram](${asset.uri})`);
    expect(session.getReferencedAssetIds()).toEqual([asset.id]);
    expect(session.getPendingReleaseAssetIds()).toEqual([]);
    expect(session.canUndo()).toBe(false);

    // Delete the image from the document
    await session.commitDoc('# Document without Image\n\nImage was removed.');
    expect(session.getReferencedAssetIds()).toEqual([]);
    expect(session.getPendingReleaseAssetIds()).toEqual([asset.id]);
    expect(session.canUndo()).toBe(true);

    // During the Undo Grace Period, refCount remains >= 1 and blobUrl stays readable
    expect(store.get(asset.id)!.refCount).toBeGreaterThanOrEqual(1);
    expect(store.get(asset.id)!.blobUrl).toBe(originalBlobUrl);
    expect((await fetch(originalBlobUrl)).ok).toBe(true);

    // Press Undo within the grace period
    const undoneSnapshot = await session.undo();
    expect(undoneSnapshot).not.toBeNull();
    expect(session.getPendingReleaseAssetIds()).toEqual([]);
    expect(session.getReferencedAssetIds()).toEqual([asset.id]);
    expect(store.get(asset.id)!.refCount).toBeGreaterThanOrEqual(1);
    expect(store.get(asset.id)!.blobUrl).toBe(originalBlobUrl);
    expect((await fetch(originalBlobUrl)).ok).toBe(true);
    expect(documentOf(undoneSnapshot!.html).querySelector('img')!.getAttribute('src')).toBe(
      asset.dataUrl
    );

    // Press Redo to remove the image again, then re-insert manually within the grace period
    expect(session.canRedo()).toBe(true);
    const redoneSnapshot = await session.redo();
    expect(redoneSnapshot).not.toBeNull();
    expect(session.getPendingReleaseAssetIds()).toEqual([asset.id]);
    expect((await fetch(originalBlobUrl)).ok).toBe(true);

    await session.commitDoc(`![restored](${asset.uri})`);
    expect(session.getPendingReleaseAssetIds()).toEqual([]);
    expect(session.getReferencedAssetIds()).toEqual([asset.id]);
    expect((await fetch(originalBlobUrl)).ok).toBe(true);

    session.dispose();
  });

  it('test_expired_undo_grace_period_or_explicit_flush_releases_asset_and_revokes_blob_url', async () => {
    const store = assetStore();
    const timedAsset = await store.ingest(png(1));
    const flushedAsset = await store.ingest(png(2));
    const timedBlobUrl = timedAsset.blobUrl!;
    const flushedBlobUrl = flushedAsset.blobUrl!;

    const session = createEditorSession({
      assetStore: store,
      undoGracePeriodMs: 50,
    });

    await session.commitDoc(`![first](${timedAsset.uri})`);
    expect(session.getReferencedAssetIds()).toEqual([timedAsset.id]);

    // Delete timedAsset and let the 50ms grace period expire naturally
    await session.commitDoc('Removed first asset');
    expect(session.getPendingReleaseAssetIds()).toEqual([timedAsset.id]);
    expect(store.get(timedAsset.id)!.refCount).toBe(1);

    await delay(80);
    expect(session.getPendingReleaseAssetIds()).toEqual([]);
    expect(store.get(timedAsset.id)!.refCount).toBe(0);
    expect(store.get(timedAsset.id)!.blobUrl).toBeUndefined();
    await expect(fetch(timedBlobUrl)).rejects.toThrow();

    // Now test explicit flushPendingReleases() before timer expiry
    await session.commitDoc(`![second](${flushedAsset.uri})`);
    await session.commitDoc('Removed second asset');
    expect(session.getPendingReleaseAssetIds()).toEqual([flushedAsset.id]);
    expect(store.get(flushedAsset.id)!.refCount).toBe(1);

    session.flushPendingReleases();
    expect(session.getPendingReleaseAssetIds()).toEqual([]);
    expect(store.get(flushedAsset.id)!.refCount).toBe(0);
    expect(store.get(flushedAsset.id)!.blobUrl).toBeUndefined();
    await expect(fetch(flushedBlobUrl)).rejects.toThrow();

    session.dispose();
  });

  it('test_provisional_snapshot_and_pending_asset_transition_from_unready_to_ready_when_resolved', async () => {
    const store = assetStore();

    // 1. Verify in-flight async compilation exposes provisional ready: false then transitions to ready: true
    const session = createEditorSession({
      assetStore: store,
      targetId: 'x-article',
      capabilities: {
        ...getDefaultCapabilities('x-article'),
        imageTransport: 'remote-https',
      },
      snapshotBuilder: async (markdown, targetId, currentStore, options) => {
        await delay(30);
        return buildDeliverySnapshot(markdown, targetId, currentStore, options);
      },
    });

    const commitPromise = session.commitDoc('## Async compilation heading');
    const provisionalSnapshot = session.getSnapshot();
    expect(provisionalSnapshot).not.toBeNull();
    expect(provisionalSnapshot!.ready).toBe(false);
    expect(session.isReady()).toBe(false);

    const completedSnapshot = await commitPromise;
    expect(completedSnapshot.ready).toBe(true);
    expect(session.isReady()).toBe(true);

    // 2. Verify referenced asset lacking remote-https delivery representation starts ready: false
    // and automatically increments version.assets and transitions to ready: true when advanceStatus completes
    const localOnlyAsset = await store.ingest(png(3));
    const unreadyAssetSnap = await session.commitDoc(`![upload-pending](${localOnlyAsset.uri})`);
    expect(unreadyAssetSnap.ready).toBe(false);
    expect(session.isReady()).toBe(false);
    const assetsVersionBefore = session.getVersion().assets;

    store.advanceStatus(localOnlyAsset.id, 'delivery-ready', {
      remoteUrl: 'https://cdn.morph.test/uploaded-image.png',
    });

    const readyAssetSnap = await session.waitForIdle();
    evidence('session-readiness-coordination', {
      unreadyVersion: unreadyAssetSnap.version,
      readyVersion: readyAssetSnap?.version,
      ready: readyAssetSnap?.ready,
    });

    expect(readyAssetSnap).not.toBeNull();
    expect(readyAssetSnap!.ready).toBe(true);
    expect(session.isReady()).toBe(true);
    expect(readyAssetSnap!.version.assets).toBeGreaterThan(assetsVersionBefore);
    expect(documentOf(readyAssetSnap!.html).querySelector('img')!.getAttribute('src')).toBe(
      'https://cdn.morph.test/uploaded-image.png'
    );

    // 3. Verify in-flight async asset ingest decoding starts ready: false and transitions to ready: true
    await session.setTarget('wechat');
    const pendingIngest = store.ingest(png(4));
    const inFlightRecord = store.ingestSync(png(4));
    expect(inFlightRecord.status).toBe('received');

    const commitDuringDecode = session.commitDoc(`![decoding](${inFlightRecord.uri})`);
    expect(session.getSnapshot()?.ready).toBe(false);

    await pendingIngest;
    await commitDuringDecode;
    const decodedSnap = await session.waitForIdle();
    expect(decodedSnap?.ready).toBe(true);
    expect(session.isReady()).toBe(true);
    expect(documentOf(decodedSnap!.html).querySelector('img')!.getAttribute('src')).toMatch(
      /^data:image\/png;base64,/
    );

    session.dispose();
  });

  it(
    'test_browser_bundle_executes_session_and_all_targets_without_node_globals',
    async () => {
      const bundleCode = await bundleMorphMdForBrowser();
      const pngBytes = Array.from(png(1, 32, 24));
      const browser = await chromium.launch({ headless: true });

      try {
        const page = await browser.newPage();
        await page.setContent(
          '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="preview"></div></body></html>'
        );
        await page.addScriptTag({ content: bundleCode });

        const result = await page.evaluate(async (rawPng: number[]) => {
          const MorphMD = (window as unknown as Record<string, any>).MorphMD;
          const hasGlobalBuffer = typeof (window as unknown as Record<string, any>).Buffer !== 'undefined';

          const store = new MorphMD.AssetStore();
          const asset = await store.ingest(new Uint8Array(rawPng), { fileName: 'hero.png' });

          const doc = [
            '# Browser Native Bundle Verification',
            '',
            `![Hero Banner](${asset.uri})`,
            '',
            '| Target | Transport | Status |',
            '| --- | --- | --- |',
            '| WeChat | Inline HTML | Ready |',
            '| X Article | Draft.js Safe | Ready |',
            '| Cards | Multi-page PNG/ZIP | Ready |',
            '',
            '> [!NOTE]',
            '> Executing inside real headless Chromium without Node Buffer or node:zlib.',
            '',
            '```ts',
            'export function verifyBrowserBundle(x: number): number {',
            '  return x * 2;',
            '}',
            '```',
            '',
            'Inline math $E = mc^2$ and display math:',
            '',
            '$$',
            '\\int_0^1 x^2 \\, dx = \\frac{1}{3}',
            '$$',
          ].join('\n');

          const customCss = `
            :root { --accent-color: #0f766e; }
            .morph-h1 { color: var(--accent-color); }
          `;

          const previewEl = document.getElementById('preview')!;
          const session = MorphMD.createEditorSession({
            assetStore: store,
            initialMarkdown: doc,
            targetId: 'wechat',
            customCss,
          });

          const wechatSnap = await session.waitForIdle();
          previewEl.innerHTML = wechatSnap?.html ?? '';

          const xSnap = await session.setTarget('x-article');
          previewEl.innerHTML = xSnap.html;

          const cardsSnap = await session.setTarget('cards');
          previewEl.innerHTML = cardsSnap.html;

          const zipPkg = await MorphMD.exportCardsZipPackage(cardsSnap, store, {
            ratio: '3:4',
            filePrefix: 'browser-bundle',
          });
          const zipEntries = MorphMD.parseZipArchive(zipPkg.zipData);

          session.dispose();

          return {
            hasGlobalBuffer,
            wechatReady: wechatSnap?.ready === true,
            wechatHtmlLength: wechatSnap?.html.length ?? 0,
            xArticleReady: xSnap.ready === true,
            xArticleHtmlLength: xSnap.html.length,
            cardsReady: cardsSnap.ready === true,
            cardsPageCount: zipPkg.pages.length,
            zipByteLength: zipPkg.zipData.byteLength,
            zipEntryPaths: zipEntries.map((e: { path: string }) => e.path),
          };
        }, pngBytes);

        evidence('browser-native-bundle-execution', result);

        expect(result.hasGlobalBuffer).toBe(false);
        expect(result.wechatReady).toBe(true);
        expect(result.wechatHtmlLength).toBeGreaterThan(200);
        expect(result.xArticleReady).toBe(true);
        expect(result.xArticleHtmlLength).toBeGreaterThan(200);
        expect(result.cardsReady).toBe(true);
        expect(result.cardsPageCount).toBeGreaterThanOrEqual(1);
        expect(result.zipByteLength).toBeGreaterThan(100);
        expect(result.zipEntryPaths).toContain('manifest.json');
        expect(result.zipEntryPaths.some((p: string) => p.endsWith('.png'))).toBe(true);
      } finally {
        await browser.close();
      }
    },
    30000
  );

  it(
    'test_browser_incremental_typing_and_multi_target_rendering_meet_latency_budget',
    async () => {
      const bundleCode = await bundleMorphMdForBrowser();
      const pngBytes = Array.from(png(2, 64, 48));
      const browser = await chromium.launch({ headless: true });

      try {
        const page = await browser.newPage();
        await page.setContent(
          '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="preview"></div></body></html>'
        );
        await page.addScriptTag({ content: bundleCode });

        const metrics = await page.evaluate(async (rawPng: number[]) => {
          const MorphMD = (window as unknown as Record<string, any>).MorphMD;
          const store = new MorphMD.AssetStore();
          const asset = await store.ingest(new Uint8Array(rawPng), { fileName: 'diagram.png' });

          const sections = Array.from({ length: 8 }, (_, idx) =>
            [
              `## Section ${idx + 1}: Architecture & Performance Analysis`,
              '',
              `In section ${idx + 1}, we evaluate multi-target Markdown rendering with **bold emphasis**, *italic notes*, \`inlineCode(${idx})\`, and inline math $O(1)$ complexity.`,
              '',
              idx === 0
                ? `![Architecture Diagram](${asset.uri})`
                : `Paragraph ${idx + 1}.2: Isomorphic delivery snapshots ensure right-pane preview and clipboard export remain 100% consistent.`,
              '',
              '| Target | Cold Render | Incremental Budget | Status |',
              '| :--- | :---: | :---: | :--- |',
              `| WeChat | 120ms | < 35ms | Active ${idx + 1} |`,
              `| X Article | 180ms | < 45ms | Verified ${idx + 1} |`,
              `| Cards 3:4 | 95ms | < 35ms | Paginated ${idx + 1} |`,
              '',
              '> [!TIP]',
              '> Keeping AST parsing and style inlining fast ensures 60fps typing responsiveness.',
              '',
              '```ts',
              `export function computeMetric_${idx}(values: number[]): number {`,
              `  return values.reduce((acc, v) => acc + v * ${idx + 1}, 0);`,
              '}',
              '```',
              '',
              '$$',
              `\\mathcal{L}_{${idx}}(\\theta) = \\sum_{i=1}^{n} (y_i - \\hat{y}_i)^2 + \\lambda \\|\\theta\\|_2^2`,
              '$$',
              '',
              `- Primary item ${idx + 1}.1`,
              `  - Nested detail ${idx + 1}.1.a`,
              `  - Nested detail ${idx + 1}.1.b`,
              `- Secondary item ${idx + 1}.2`,
            ].join('\n')
          ).join('\n\n');

          const baseDoc = `# MorphMD Real-Time Typing Benchmark\n\n${sections}`;
          const lineCount = baseDoc.split('\n').length;

          const customCss = `
            :root {
              --brand-color: #2563eb;
              --card-bg: #f8fafc;
            }
            .morph-h2 {
              color: var(--brand-color);
              border-bottom: 2px solid var(--brand-color);
            }
            .morph-blockquote {
              background-color: var(--card-bg);
            }
            .morph-h2::before {
              content: "§ ";
              color: var(--brand-color);
            }
          `;

          const previewEl = document.getElementById('preview')!;
          const session = MorphMD.createEditorSession({
            assetStore: store,
            debounceMs: 60,
            initialMarkdown: baseDoc,
            targetId: 'wechat',
            customCss,
          });

          session.subscribe((snap: { html: string }) => {
            previewEl.innerHTML = snap.html;
          });

          await session.waitForIdle();
          session.flushRenderFrame();

          // 1. Measure 20 rapid synchronous inputDoc keystrokes
          const inputSyncTimes: number[] = [];
          let currentDoc = baseDoc + '\n\nTyping: ';
          for (let i = 1; i <= 20; i++) {
            currentDoc += String.fromCharCode(97 + (i % 26));
            const t0 = performance.now();
            session.inputDoc(currentDoc);
            const t1 = performance.now();
            inputSyncTimes.push(t1 - t0);
          }
          await session.flush();
          session.flushRenderFrame();

          // 2. Measure warm incremental commitDoc turnaround on wechat
          await session.commitDoc(`${currentDoc} [wechat-warmup]`);
          session.flushRenderFrame();
          const wechatTimes: number[] = [];
          for (let i = 1; i <= 5; i++) {
            const nextDoc = `${currentDoc} [wechat-edit-${i}]`;
            const t0 = performance.now();
            await session.commitDoc(nextDoc);
            session.flushRenderFrame();
            const t1 = performance.now();
            wechatTimes.push(t1 - t0);
          }

          // 3. Measure warm incremental commitDoc turnaround on cards
          await session.setTarget('cards');
          session.flushRenderFrame();
          await session.commitDoc(`${currentDoc} [cards-warmup]`);
          session.flushRenderFrame();
          const cardsTimes: number[] = [];
          for (let i = 1; i <= 5; i++) {
            const nextDoc = `${currentDoc} [cards-edit-${i}]`;
            const t0 = performance.now();
            await session.commitDoc(nextDoc);
            session.flushRenderFrame();
            const t1 = performance.now();
            cardsTimes.push(t1 - t0);
          }

          // 4. Measure warm incremental commitDoc turnaround on x-article (editing text while keeping tables/math unchanged)
          await session.setTarget('x-article');
          session.flushRenderFrame();
          await session.commitDoc(`${currentDoc} [x-warmup]`);
          session.flushRenderFrame();
          const xArticleTimes: number[] = [];
          for (let i = 1; i <= 5; i++) {
            const nextDoc = `${currentDoc} [x-edit-${i}]`;
            const t0 = performance.now();
            await session.commitDoc(nextDoc);
            session.flushRenderFrame();
            const t1 = performance.now();
            xArticleTimes.push(t1 - t0);
          }

          session.dispose();

          const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
          return {
            lineCount,
            inputAvgMs: avg(inputSyncTimes),
            inputMaxMs: Math.max(...inputSyncTimes),
            wechatIncrementalAvgMs: avg(wechatTimes),
            cardsIncrementalAvgMs: avg(cardsTimes),
            xArticleIncrementalAvgMs: avg(xArticleTimes),
          };
        }, pngBytes);

        evidence('browser-session-latency-benchmark', metrics);

        expect(metrics.lineCount).toBeGreaterThanOrEqual(220);
        expect(metrics.inputAvgMs).toBeLessThan(0.5);
        expect(metrics.inputMaxMs).toBeLessThan(2);
        expect(metrics.wechatIncrementalAvgMs).toBeLessThan(35);
        expect(metrics.cardsIncrementalAvgMs).toBeLessThan(35);
        expect(metrics.xArticleIncrementalAvgMs).toBeLessThan(45);
      } finally {
        await browser.close();
      }
    },
    30000
  );
});
