import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AssetStore,
  buildDeliverySnapshot,
  CARD_RATIO_PRESETS,
  paginateCardsHtml,
  rasterizeCardPage,
  rasterizeCards,
  exportCardsZipPackage,
  createZipArchive,
  parseZipArchive,
  type CardAspectRatio,
  type CardPagePngArtifact,
  type CardsExportOptions,
  type CardsExportManifest,
  type CardsZipExportResult,
  type ZipEntryRecord,
} from '../src/index';
import { assetStore, documentOf, evidence, snapshotOf } from './support/contracts';
import { decodeBitmapDataUrl, png } from './support/fixtures';

const PNG_MAGIC_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function readPngHeaderDimensions(data: Uint8Array): { width: number; height: number } {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    width: view.getUint32(16, false),
    height: view.getUint32(20, false),
  };
}

describe('TestCardPagePngRasterizer', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
  });

  afterAll(async () => {
    if (browser) {
      await browser.close();
    }
  });

  it('test_all_preset_ratios_rasterize_to_exact_export_pixel_dimensions_and_valid_png_bitmaps', async () => {
    const store = assetStore();
    expect(store).toBeInstanceOf(AssetStore);
    const coverRecord = await store.ingest(png(3, 180, 120), { fileName: 'preset-cover.png' });

    const markdown = [
      '# 多比例高清卡片导出验证',
      '',
      `![封面配图](${coverRecord.uri})`,
      '',
      '验证 3:4、4:5、1:1 与 16:9 四种预设画布比例均能稳定光栅化为目标像素分辨率的高清 PNG 位图。',
    ].join('\n');

    const ratios: CardAspectRatio[] = ['3:4', '4:5', '1:1', '16:9'];
    const summary: Array<Record<string, unknown>> = [];

    for (const ratio of ratios) {
      const preset = CARD_RATIO_PRESETS[ratio];
      const snapshot = await buildDeliverySnapshot(markdown, 'cards', store, {
        cardsOptions: { ratio, headerText: `MorphMD ${ratio}` },
      });

      const exportOptions: CardsExportOptions = { ratio, filePrefix: 'preset' };
      const exportResult = await rasterizeCards(snapshot, store, exportOptions);

      expect(exportResult.pages.length).toBeGreaterThanOrEqual(1);
      expect(exportResult.diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);

      for (const pageArtifact of exportResult.pages) {
        const artifact: CardPagePngArtifact = pageArtifact;
        expect(artifact.mimeType).toBe('image/png');
        expect(artifact.ratio).toBe(ratio);
        expect(artifact.width).toBe(preset.exportWidth);
        expect(artifact.height).toBe(preset.exportHeight);
        expect(artifact.layoutWidth).toBe(preset.layoutWidth);
        expect(artifact.layoutHeight).toBe(preset.layoutHeight);
        expect(artifact.exportScale).toBe(preset.exportScale);
        expect(artifact.pageNumber).toBeGreaterThanOrEqual(1);
        expect(artifact.totalPages).toBe(exportResult.pages.length);

        expect(artifact.data).toBeInstanceOf(Uint8Array);
        expect(artifact.data.byteLength).toBeGreaterThan(64);
        expect(Array.from(artifact.data.slice(0, 8))).toEqual(PNG_MAGIC_BYTES);

        const ihdr = readPngHeaderDimensions(artifact.data);
        expect(ihdr).toEqual({
          width: preset.exportWidth,
          height: preset.exportHeight,
        });

        expect(artifact.dataUrl).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
        expect(typeof artifact.crc32).toBe('number');
        expect(artifact.crc32).toBeGreaterThanOrEqual(0);

        const decoded = await decodeBitmapDataUrl(page, artifact.dataUrl);
        expect(decoded).toEqual({
          decoded: true,
          width: preset.exportWidth,
          height: preset.exportHeight,
        });

        summary.push({
          ratio,
          fileName: artifact.fileName,
          width: artifact.width,
          height: artifact.height,
          layoutWidth: artifact.layoutWidth,
          layoutHeight: artifact.layoutHeight,
          exportScale: artifact.exportScale,
          byteLength: artifact.data.byteLength,
          crc32: artifact.crc32,
        });
      }
    }

    evidence('cards-export-preset-ratios', summary);
  });

  it('test_preview_scale_transform_and_host_device_pixel_ratio_do_not_corrupt_export_resolution', async () => {
    const html = [
      '<div class="morph-doc">',
      '  <h1 class="morph-h1" data-node-id="iso-h1">预览缩放与导出倍率严格隔离</h1>',
      '  <p class="morph-p" data-node-id="iso-p">即使预览容器因窄屏被赋予 transform: scale(0.5)，或宿主窗口处于不同 devicePixelRatio，导出的 PNG 像素尺寸仍严格锁定在 1440x1920。</p>',
      '</div>',
    ].join('\n');

    const paginated = paginateCardsHtml(html, {
      ratio: '3:4',
      headerText: 'Isolation Check',
    });

    const doc = documentOf(paginated.html);
    const cardPageEl = doc.querySelector<HTMLElement>('section.morph-card-page')!;
    expect(cardPageEl).not.toBeNull();

    // Simulate preview container CSS transform scaling down to 0.5x on a narrow screen
    cardPageEl.setAttribute(
      'style',
      'width: 720px; height: 960px; transform: scale(0.5); transform-origin: top left;',
    );

    const artifactDpr3 = await rasterizeCardPage(cardPageEl, {
      hostDevicePixelRatio: 3,
    });
    const artifactDpr1 = await rasterizeCardPage(cardPageEl, {
      hostDevicePixelRatio: 1,
    });

    expect(artifactDpr3.width).toBe(1440);
    expect(artifactDpr3.height).toBe(1920);
    expect(artifactDpr3.layoutWidth).toBe(720);
    expect(artifactDpr3.layoutHeight).toBe(960);
    expect(artifactDpr3.exportScale).toBe(2);

    expect(artifactDpr1.width).toBe(1440);
    expect(artifactDpr1.height).toBe(1920);
    expect(artifactDpr1.crc32).toBe(artifactDpr3.crc32);

    const decodedDpr3 = await decodeBitmapDataUrl(page, artifactDpr3.dataUrl);
    const decodedDpr1 = await decodeBitmapDataUrl(page, artifactDpr1.dataUrl);
    expect(decodedDpr3).toEqual({ decoded: true, width: 1440, height: 1920 });
    expect(decodedDpr1).toEqual({ decoded: true, width: 1440, height: 1920 });

    // Explicit scaleOverride: 1 must rasterize at layout resolution (720x960)
    const artifactScale1 = await rasterizeCardPage(cardPageEl, {
      scaleOverride: 1,
      hostDevicePixelRatio: 2.5,
    });
    expect(artifactScale1.width).toBe(720);
    expect(artifactScale1.height).toBe(960);
    expect(artifactScale1.exportScale).toBe(1);

    const decodedScale1 = await decodeBitmapDataUrl(page, artifactScale1.dataUrl);
    expect(decodedScale1).toEqual({ decoded: true, width: 720, height: 960 });
  });

  it('test_distinct_card_contents_and_design_tokens_produce_distinct_non_blank_png_pixel_data', async () => {
    const store = assetStore();
    const imgRecord = await store.ingest(png(9, 200, 120), { fileName: 'chart-a.png' });

    const markdownA = [
      '# 深色极客主题卡片',
      '',
      `![系统架构图](${imgRecord.uri})`,
      '',
      '采用深色背景与高对比度天蓝强调色渲染。',
    ].join('\n');

    const markdownB = [
      '# 暖色人文杂志卡片',
      '',
      '> 卡片样式由共享 Design Tokens 驱动，不同主题与内容必须呈现截然不同的位图输出。',
      '',
      '```ts',
      'const theme = "warm-editorial";',
      '```',
    ].join('\n');

    const snapshotA = await buildDeliverySnapshot(markdownA, 'cards', store, {
      cardsOptions: { ratio: '1:1', headerText: 'Theme Dark' },
    });
    const snapshotB = await buildDeliverySnapshot(markdownB, 'cards', store, {
      cardsOptions: { ratio: '1:1', headerText: 'Theme Warm' },
    });

    const resultA = await rasterizeCards(snapshotA, store, {
      ratio: '1:1',
      tokens: {
        '--morph-bg': '#0f172a',
        '--morph-text': '#f8fafc',
        '--morph-accent': '#38bdf8',
      },
    });
    const resultB = await rasterizeCards(snapshotB, store, {
      ratio: '1:1',
      tokens: {
        '--morph-bg': '#fffbeb',
        '--morph-text': '#1c1917',
        '--morph-accent': '#d97706',
      },
    });

    expect(resultA.pages.length).toBe(1);
    expect(resultB.pages.length).toBe(1);

    const cardA = resultA.pages[0];
    const cardB = resultB.pages[0];

    expect(cardA.crc32).not.toBe(cardB.crc32);
    expect(Buffer.from(cardA.data).equals(Buffer.from(cardB.data))).toBe(false);

    // Inspect decoded pixel diversity in real Chromium to prove neither image is a uniform blank canvas
    for (const card of [cardA, cardB]) {
      const colorStats = await page.evaluate(async (dataUrl) => {
        const img = new Image();
        img.src = dataUrl;
        await img.decode();
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0);
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const uniqueColors = new Set<string>();
        // Sample across a grid of pixels
        for (let i = 0; i < data.length; i += 64) {
          uniqueColors.add(`${data[i]},${data[i + 1]},${data[i + 2]},${data[i + 3]}`);
          if (uniqueColors.size >= 4) break;
        }
        return { uniqueColorCount: uniqueColors.size };
      }, card.dataUrl);

      expect(colorStats.uniqueColorCount).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('TestCardsBatchRasterizationAndAssetLifecycle', () => {
  it('test_multi_page_snapshot_with_embedded_assets_locks_assets_during_export_and_releases_afterward', async () => {
    const store = assetStore();
    const imgRecord = await store.ingest(png(11, 220, 140), { fileName: 'diagram.png' });

    const markdown = [
      '# 资产引用计数与生命周期守卫',
      '',
      `![核心流程图](${imgRecord.uri})`,
      '',
      '包含行内公式 $E = mc^2$ 与多段正文以确保跨越多页。',
      '',
      '1. 导出启动时自动对快照内引用的资产加锁',
      '2. 批量光栅化期间防止后台 GC 误回收正在渲染的位图资源',
      '3. 全部页面导出完毕后在 finally 块中成对释放引用锁',
      '',
      '| 阶段 | 锁状态 |',
      '| :--- | :--- |',
      '| 导出前 | 0 |',
      '| 导出中 | >= 1 |',
      '| 导出后 | 0 |',
    ].join('\n');

    const snapshot = await buildDeliverySnapshot(markdown, 'cards', store, {
      cardsOptions: {
        ratio: '3:4',
        headerText: 'Asset Lock Lifecycle',
        contentHeightOverride: 240,
      },
    });

    expect(store.get(imgRecord.id)?.activeLocks).toBe(0);

    const exportResult = await rasterizeCards(snapshot, store, {
      ratio: '3:4',
      filePrefix: 'lifecycle',
    });

    expect(exportResult.pages.length).toBeGreaterThanOrEqual(2);
    expect(exportResult.diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);

    const afterRecord = store.get(imgRecord.id);
    expect(afterRecord).toBeDefined();
    expect(afterRecord!.status).toBe('delivery-ready');
    expect(afterRecord!.activeLocks).toBe(0);
  });

  it('test_page_number_filtering_exports_only_requested_pages_and_diagnoses_out_of_range_pages', async () => {
    const store = assetStore();
    const paragraphs = Array.from(
      { length: 12 },
      (_, idx) =>
        `第 ${idx + 1} 段分页筛选测试内容：用于生成至少三页的图文卡片序列，并验证指定页码导出与越界页码告警。`,
    ).join('\n\n');

    const markdown = `# 指定页码子集导出\n\n${paragraphs}`;
    const snapshot = await buildDeliverySnapshot(markdown, 'cards', store, {
      cardsOptions: {
        ratio: '3:4',
        contentHeightOverride: 240,
      },
    });

    const doc = documentOf(snapshot.html);
    const totalPages = doc.querySelectorAll('section.morph-card-page').length;
    expect(totalPages).toBeGreaterThanOrEqual(3);

    const singleResult = await rasterizeCards(snapshot, store, {
      pageNumbers: [2],
      filePrefix: 'slide',
    });

    expect(singleResult.pages).toHaveLength(1);
    expect(singleResult.pages[0].pageNumber).toBe(2);
    expect(singleResult.pages[0].totalPages).toBe(totalPages);
    expect(singleResult.pages[0].fileName).toBe('slide-02.png');

    const outOfRangeResult = await rasterizeCards(snapshot, store, {
      pageNumbers: [1, 99],
      filePrefix: 'slide',
    });

    expect(outOfRangeResult.pages).toHaveLength(1);
    expect(outOfRangeResult.pages[0].pageNumber).toBe(1);
    expect(outOfRangeResult.pages[0].fileName).toBe('slide-01.png');

    const rangeWarnings = outOfRangeResult.diagnostics.filter(
      (d) => d.code === 'cards/page-out-of-range',
    );
    expect(rangeWarnings.length).toBeGreaterThanOrEqual(1);
    expect(rangeWarnings[0].severity).toBe('warning');
  });

  it('test_unready_or_missing_assets_and_non_cards_snapshot_emit_explicit_diagnostics', async () => {
    const store = assetStore();

    const wechatSnapshot = await buildDeliverySnapshot('# 公众号长文快照', 'wechat', store);
    const invalidTargetResult = await rasterizeCards(wechatSnapshot, store);

    expect(
      invalidTargetResult.diagnostics.some((d) => d.code === 'cards/invalid-target'),
    ).toBe(true);

    const brokenCardsHtml = [
      '<div class="morph-doc">',
      '  <section class="morph-card-page" data-page="1" data-total-pages="1" data-ratio="3:4">',
      '    <div class="morph-card-body" data-morph-card-body="true">',
      '      <p class="morph-p">包含缺失资产引用的卡片页</p>',
      '      <img class="morph-img" data-morph-asset-id="missing-id" src="morph-asset://missing-id" alt="丢失的配图" />',
      '    </div>',
      '  </section>',
      '</div>',
    ].join('\n');

    const missingAssetSnapshot = snapshotOf(brokenCardsHtml, 'cards');
    const missingAssetResult = await rasterizeCards(missingAssetSnapshot, store);

    expect(
      missingAssetResult.diagnostics.some((d) => d.code === 'asset/not-found'),
    ).toBe(true);
  });
});

describe('TestCardsZipBatchExporter', () => {
  it('test_export_cards_zip_package_bundles_sequential_pngs_and_manifest_into_valid_zip_archive', async () => {
    const store = assetStore();
    const badgeRecord = await store.ingest(png(15, 120, 120), { fileName: 'badge.png' });

    const sections = Array.from(
      { length: 8 },
      (_, idx) =>
        `## 核心章节 ${idx + 1}\n\n这是第 ${idx + 1} 节的详细阐述文本，用于测试多页 4:5 图文卡片在批量打包为 ZIP 归档时的序号命名、CRC-32 完整性校验与导出清单 manifest.json。`,
    ).join('\n\n');

    const markdown = [
      '# MorphMD 多页卡片 ZIP 发布包',
      '',
      `![徽章配图](${badgeRecord.uri})`,
      '',
      sections,
    ].join('\n');

    const snapshot = await buildDeliverySnapshot(markdown, 'cards', store, {
      cardsOptions: {
        ratio: '4:5',
        headerText: 'MorphMD Deck',
        contentHeightOverride: 280,
      },
    });

    const result: CardsZipExportResult = await exportCardsZipPackage(snapshot, store, {
      ratio: '4:5',
      filePrefix: 'deck',
      headerText: 'MorphMD Deck',
    });

    evidence('cards-zip-export-manifest', result.manifest);

    expect(result.mimeType).toBe('application/zip');
    expect(result.zipFileName).toBe('deck-4x5-cards.zip');
    expect(result.pages.length).toBeGreaterThanOrEqual(2);

    const manifest: CardsExportManifest = result.manifest;
    expect(manifest.ratio).toBe('4:5');
    expect(manifest.exportWidth).toBe(1440);
    expect(manifest.exportHeight).toBe(1800);
    expect(manifest.layoutWidth).toBe(720);
    expect(manifest.layoutHeight).toBe(900);
    expect(manifest.exportScale).toBe(2);
    expect(manifest.totalPages).toBe(result.pages.length);
    expect(manifest.pages).toHaveLength(result.pages.length);

    // Verify ZIP local file header magic signature PK\x03\x04
    expect(result.zipData).toBeInstanceOf(Uint8Array);
    expect(Array.from(result.zipData.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);

    const entries: ZipEntryRecord[] = parseZipArchive(result.zipData);
    const entryPaths = entries.map((e) => e.path);

    for (let i = 0; i < result.pages.length; i++) {
      const pageArtifact = result.pages[i];
      const expectedFileName = `deck-${String(i + 1).padStart(2, '0')}.png`;
      expect(pageArtifact.fileName).toBe(expectedFileName);
      expect(entryPaths).toContain(expectedFileName);

      const zipEntry = entries.find((e) => e.path === expectedFileName)!;
      expect(zipEntry).toBeDefined();
      expect(zipEntry.crc32).toBe(pageArtifact.crc32);
      expect(zipEntry.uncompressedSize).toBe(pageArtifact.data.byteLength);
      expect(Buffer.from(zipEntry.data).equals(Buffer.from(pageArtifact.data))).toBe(true);
    }

    expect(entryPaths).toContain('manifest.json');
    const manifestEntry = entries.find((e) => e.path === 'manifest.json')!;
    const parsedManifest = JSON.parse(
      new TextDecoder('utf-8').decode(manifestEntry.data),
    ) as CardsExportManifest;
    expect(parsedManifest).toEqual(result.manifest);
  });

  it('test_zip_archive_corrupted_crc_or_path_traversal_is_rejected_cleanly', () => {
    expect(() =>
      createZipArchive([
        {
          path: '../evil.png',
          data: new Uint8Array([1, 2, 3]),
        },
      ]),
    ).toThrow();

    expect(() =>
      createZipArchive([
        {
          path: '/etc/passwd',
          data: new Uint8Array([1, 2, 3]),
        },
      ]),
    ).toThrow();

    const validPng = png(5, 16, 16);
    const validZip = createZipArchive([
      {
        path: 'card-01.png',
        data: validPng,
      },
    ]);

    const corruptedZip = new Uint8Array(validZip);
    // Flip a byte inside the first entry's data payload (after 30-byte local header + 11-byte filename)
    corruptedZip[45] ^= 0xff;

    expect(() => parseZipArchive(corruptedZip)).toThrow();
  });
});
