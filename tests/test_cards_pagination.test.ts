import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AssetStore,
  buildDeliverySnapshot,
  CARD_RATIO_PRESETS,
  computeCardViewportGeometry,
  createDeliverySnapshotSync,
  getCardPreset,
  normalizeSelectionRange,
  paginateCardsHtml,
  paginateDom,
  reflowCards,
  serializeFullSnapshot,
  type CardAspectRatio,
} from '../src/index';
import { assetStore, documentOf, evidence } from './support/contracts';
import { decodeBitmapDataUrl, png } from './support/fixtures';

function stripGeneratedText(html: string): string {
  const doc = documentOf(html);
  doc.querySelectorAll('[data-morph-generated]').forEach((el) => el.remove());
  return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
}

describe('TestCardRatioPresetsAndViewportGeometry', () => {
  it('test_preset_registry_exposes_exact_layout_and_export_resolutions_for_all_supported_ratios', () => {
    expect(CARD_RATIO_PRESETS['3:4']).toEqual(
      expect.objectContaining({
        ratio: '3:4',
        exportWidth: 1440,
        exportHeight: 1920,
        layoutWidth: 720,
        layoutHeight: 960,
        exportScale: 2,
      }),
    );
    expect(CARD_RATIO_PRESETS['4:5']).toEqual(
      expect.objectContaining({
        ratio: '4:5',
        exportWidth: 1440,
        exportHeight: 1800,
        layoutWidth: 720,
        layoutHeight: 900,
        exportScale: 2,
      }),
    );
    expect(CARD_RATIO_PRESETS['1:1']).toEqual(
      expect.objectContaining({
        ratio: '1:1',
        exportWidth: 1440,
        exportHeight: 1440,
        layoutWidth: 720,
        layoutHeight: 720,
        exportScale: 2,
      }),
    );
    expect(CARD_RATIO_PRESETS['16:9']).toEqual(
      expect.objectContaining({
        ratio: '16:9',
        exportWidth: 1920,
        exportHeight: 1080,
        layoutWidth: 960,
        layoutHeight: 540,
        exportScale: 2,
      }),
    );

    expect(getCardPreset()).toEqual(CARD_RATIO_PRESETS['3:4']);
    expect(getCardPreset('4:5')).toEqual(CARD_RATIO_PRESETS['4:5']);
    expect(getCardPreset('1:1')).toEqual(CARD_RATIO_PRESETS['1:1']);
    expect(getCardPreset('16:9')).toEqual(CARD_RATIO_PRESETS['16:9']);
  });

  it('test_viewport_geometry_separates_css_layout_pixels_preview_scale_and_export_scale', () => {
    const ratios: CardAspectRatio[] = ['3:4', '4:5', '1:1', '16:9'];

    for (const ratio of ratios) {
      const compact = computeCardViewportGeometry(ratio, {
        containerWidth: 360,
        containerHeight: 480,
      });
      const spacious = computeCardViewportGeometry(ratio, {
        containerWidth: 1600,
        containerHeight: 1400,
      });
      const exportSized = computeCardViewportGeometry(ratio, {
        renderAtExportSize: true,
      });

      expect(compact.ratio).toBe(ratio);
      expect(compact.layoutWidth * compact.exportScale).toBe(compact.exportWidth);
      expect(compact.layoutHeight * compact.exportScale).toBe(compact.exportHeight);

      // CSS layout dimensions and available content budget are invariant across preview container sizes
      expect(compact.layoutWidth).toBe(spacious.layoutWidth);
      expect(compact.layoutHeight).toBe(spacious.layoutHeight);
      expect(compact.exportWidth).toBe(spacious.exportWidth);
      expect(compact.exportHeight).toBe(spacious.exportHeight);
      expect(compact.exportScale).toBe(spacious.exportScale);
      expect(compact.availableContentWidth).toBe(spacious.availableContentWidth);
      expect(compact.availableContentHeight).toBe(spacious.availableContentHeight);
      expect(compact.availableContentWidth).toBeGreaterThan(0);
      expect(compact.availableContentHeight).toBeGreaterThan(0);
      expect(compact.availableContentHeight).toBeLessThan(compact.layoutHeight);

      // Preview scale adapts to fit the host container without mutating layoutWidth/layoutHeight
      expect(compact.previewScale).toBeLessThan(1);
      expect(compact.previewWidth).toBeLessThanOrEqual(360.01);
      expect(compact.previewHeight).toBeLessThanOrEqual(480.01);
      expect(Math.abs(compact.previewWidth - compact.layoutWidth * compact.previewScale)).toBeLessThan(0.01);
      expect(Math.abs(compact.previewHeight - compact.layoutHeight * compact.previewScale)).toBeLessThan(0.01);

      expect(exportSized.previewScale).toBe(exportSized.exportScale);
      expect(exportSized.previewWidth).toBe(exportSized.exportWidth);
      expect(exportSized.previewHeight).toBe(exportSized.exportHeight);
    }

    const overridden = computeCardViewportGeometry('3:4', { contentHeightOverride: 420 });
    expect(overridden.availableContentHeight).toBe(420);
  });
});

describe('TestCardsStreamingPaginationAndRatioSwitching', () => {
  it('test_multi_block_document_paginates_into_card_sections_with_generated_chrome_and_zero_blank_pages', () => {
    const blocks: string[] = [
      '<h1 class="morph-h1" data-node-id="node-h1">多比例流式卡片排版引擎</h1>',
    ];
    for (let i = 1; i <= 14; i++) {
      blocks.push(
        `<p class="morph-p" data-node-id="node-p-${i}">第 ${i} 段正文内容：用于验证多比例图文卡片在流式分页时能够准确计算剩余空间、注入生成性页眉与页脚，并严格保证一字不漏且绝不产生空白废页。</p>`,
      );
    }
    const sourceHtml = `<div class="morph-doc">${blocks.join('')}</div>`;
    const expectedText = stripGeneratedText(sourceHtml);

    const result = paginateCardsHtml(sourceHtml, {
      ratio: '3:4',
      headerText: 'MorphMD Cards',
    });
    evidence('cards-streaming-basic', { state: result.state, diagnostics: result.diagnostics });

    expect(result.state.ratio).toBe('3:4');
    expect(result.state.totalPages).toBeGreaterThan(1);

    const doc = documentOf(result.html);
    const pages = Array.from(doc.querySelectorAll('section.morph-card-page'));
    expect(pages.length).toBe(result.state.totalPages);

    pages.forEach((page, index) => {
      const pageNum = index + 1;
      expect(page.getAttribute('data-page')).toBe(String(pageNum));
      expect(page.getAttribute('data-total-pages')).toBe(String(result.state.totalPages));
      expect(page.getAttribute('data-ratio')).toBe('3:4');

      const headers = page.querySelectorAll('[data-morph-generated="header"]');
      const footers = page.querySelectorAll('[data-morph-generated="footer"]');
      expect(headers.length).toBe(1);
      expect(footers.length).toBe(1);

      const expectedFooter = `${String(pageNum).padStart(2, '0')} / ${String(result.state.totalPages).padStart(2, '0')}`;
      expect(footers[0].textContent).toContain(expectedFooter);

      // Zero blank waste pages: every page must contain at least one non-generated semantic block
      const semanticBlocks = Array.from(page.querySelectorAll('*')).filter(
        (el) =>
          !el.hasAttribute('data-morph-generated') &&
          !el.closest('[data-morph-generated]') &&
          /^(h[1-6]|p|blockquote|pre|ul|ol|table|hr|img|svg|figure)$/.test(el.tagName.toLowerCase()),
      );
      expect(semanticBlocks.length).toBeGreaterThan(0);
    });

    expect(stripGeneratedText(result.html)).toBe(expectedText);
  });

  it('test_switching_aspect_ratios_repaginates_cleanly_without_nested_pages_or_duplicate_chrome', () => {
    const paragraphs = Array.from({ length: 16 }, (_, idx) => {
      const n = idx + 1;
      return `<p class="morph-p" data-node-id="node-switch-${n}">比例切换测试段落 ${n}：在 3:4、4:5、1:1 与 16:9 之间连续切换画布比例时，分页引擎必须干净剥离旧页容器与旧页眉页脚，重新计算分页且保持文本 100% 一致。</p>`;
    });
    const rawHtml = `<div class="morph-doc"><h1 class="morph-h1" data-node-id="node-switch-h1">画布比例动态切换</h1>${paragraphs.join('')}</div>`;
    const originalText = stripGeneratedText(rawHtml);

    const doc = documentOf(rawHtml);
    const root = doc.querySelector('.morph-doc')!;

    const state34 = paginateDom(root, [], { ratio: '3:4' });
    const pages34 = state34.totalPages;
    expect(pages34).toBeGreaterThanOrEqual(2);

    const state45 = paginateDom(root, [], { ratio: '4:5' });
    const pages45 = state45.totalPages;

    const state11 = paginateDom(root, [], { ratio: '1:1' });
    const pages11 = state11.totalPages;

    const state169 = paginateDom(root, [], { ratio: '16:9' });
    const pages169 = state169.totalPages;

    // 16:9 has the shortest vertical layoutHeight (540px), so it requires at least as many pages as 1:1 (720px) and 3:4 (960px)
    expect(pages169).toBeGreaterThanOrEqual(pages11);
    expect(pages11).toBeGreaterThanOrEqual(pages34);
    expect(pages45).toBeGreaterThanOrEqual(pages34);

    // Re-paginate back to 3:4 and verify deterministic convergence with initial 3:4 state
    const stateBackTo34 = paginateDom(root, [], { ratio: '3:4' });
    expect(stateBackTo34.totalPages).toBe(pages34);
    expect(root.querySelectorAll('.morph-card-page .morph-card-page').length).toBe(0);

    const finalPages = Array.from(root.querySelectorAll('section.morph-card-page'));
    expect(finalPages.length).toBe(pages34);
    for (const page of finalPages) {
      expect(page.getAttribute('data-ratio')).toBe('3:4');
      expect(page.querySelectorAll('[data-morph-generated="header"]').length).toBe(1);
      expect(page.querySelectorAll('[data-morph-generated="footer"]').length).toBe(1);
    }

    expect(stripGeneratedText(root.outerHTML)).toBe(originalText);
  });

  it('test_delivery_snapshot_for_cards_target_embeds_paginated_pages_and_resolved_assets', async () => {
    const store = assetStore();
    const record = await store.ingest(png(3, 240, 160), { fileName: 'card-cover.png' });

    const markdown = [
      '# 卡片交付快照测试',
      '',
      `![卡片配图](${record.uri})`,
      '',
      '第一段说明文字，包含行内公式 $E = mc^2$ 与 **加粗重点**。',
      '',
      '第二段说明文字，确保卡片快照在预览、复制与导出阶段同构共享。',
    ].join('\n');

    const asyncSnapshot = await buildDeliverySnapshot(markdown, 'cards', store, {
      cardsOptions: { ratio: '4:5', headerText: 'MorphMD 4:5' },
    });
    const syncSnapshot = createDeliverySnapshotSync(markdown, 'cards', store, {
      cardsOptions: { ratio: '1:1' },
    });

    expect(asyncSnapshot.targetId).toBe('cards');
    expect(asyncSnapshot.ready).toBe(true);
    expect(syncSnapshot.targetId).toBe('cards');
    expect(syncSnapshot.ready).toBe(true);

    const asyncDoc = documentOf(asyncSnapshot.html);
    const asyncPages = Array.from(asyncDoc.querySelectorAll('section.morph-card-page'));
    expect(asyncPages.length).toBeGreaterThanOrEqual(1);
    expect(asyncPages[0].getAttribute('data-ratio')).toBe('4:5');

    const img = asyncDoc.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe(record.dataUrl);
    expect(asyncSnapshot.html).not.toContain('morph-asset://');
    expect(asyncSnapshot.html).not.toContain('blob:');

    const syncDoc = documentOf(syncSnapshot.html);
    const syncPages = Array.from(syncDoc.querySelectorAll('section.morph-card-page'));
    expect(syncPages.length).toBeGreaterThanOrEqual(1);
    expect(syncPages[0].getAttribute('data-ratio')).toBe('1:1');
  });
});

describe('TestCompositeBlockSplittingAndHeadingKeepWithNext', () => {
  it('test_heading_near_page_bottom_moves_to_next_page_to_stay_with_following_block', () => {
    // Use an explicit contentHeightOverride of 300px:
    // Lead paragraph is 220px tall -> 80px remaining on Page 1.
    // Heading is 44px tall -> fits in 80px alone, BUT Heading (44px) + Following Paragraph (90px) = 134px > 80px.
    // Keep-with-next contract requires Heading to move to Page 2 so it is not stranded at the bottom of Page 1.
    const html = [
      '<div class="morph-doc">',
      '  <p class="morph-p" data-node-id="lead-p" style="height: 210px; margin: 0;">第一页前导正文段落，占据页面绝大部分高度。</p>',
      '  <h2 class="morph-h2" data-node-id="stranded-h2" style="height: 40px; margin: 0;">必须与下文同页的小节标题</h2>',
      '  <p class="morph-p" data-node-id="follow-p" style="height: 90px; margin: 0;">紧随标题之后的正文段落，标题绝不能独自留在第一页底部。</p>',
      '</div>',
    ].join('\n');

    const result = paginateCardsHtml(html, {
      ratio: '3:4',
      contentHeightOverride: 300,
    });

    const doc = documentOf(result.html);
    const pages = Array.from(doc.querySelectorAll('section.morph-card-page'));
    expect(pages.length).toBe(2);

    expect(pages[0].querySelector('[data-node-id="lead-p"]')).not.toBeNull();
    expect(pages[0].querySelector('h2')).toBeNull();

    expect(pages[1].querySelector('h2')?.textContent).toBe('必须与下文同页的小节标题');
    expect(pages[1].querySelector('[data-node-id="follow-p"]')?.textContent).toContain('紧随标题之后的正文段落');
  });

  it('test_ordered_and_unordered_lists_split_across_pages_while_preserving_continuation_numbering', () => {
    const items = Array.from({ length: 10 }, (_, idx) => {
      const n = idx + 1;
      return `<li data-node-id="ol-item-${n}" style="height: 60px; margin: 0;">有序列表第 ${n} 项详细说明内容</li>`;
    }).join('');
    const ulItems = Array.from({ length: 6 }, (_, idx) => {
      const n = idx + 1;
      return `<li data-node-id="ul-item-${n}" style="height: 60px; margin: 0;">无序列表第 ${n} 项内容</li>`;
    }).join('');

    const html = [
      '<div class="morph-doc">',
      `  <ol class="morph-list" start="5" data-node-id="ol-main">${items}</ol>`,
      `  <ul class="morph-list" data-node-id="ul-main">${ulItems}</ul>`,
      '</div>',
    ].join('\n');

    const result = paginateCardsHtml(html, {
      ratio: '3:4',
      contentHeightOverride: 260,
    });
    evidence('cards-list-splitting', { state: result.state, html: result.html });

    const doc = documentOf(result.html);
    const pages = Array.from(doc.querySelectorAll('section.morph-card-page'));
    expect(pages.length).toBeGreaterThanOrEqual(3);

    const splitOls = Array.from(doc.querySelectorAll('ol'));
    expect(splitOls.length).toBeGreaterThanOrEqual(2);

    // Verify accurate numbering across all split <ol> fragments starting at 5
    let expectedStart = 5;
    let totalOlItems = 0;
    for (const ol of splitOls) {
      const lis = Array.from(ol.children).filter((c) => c.tagName.toLowerCase() === 'li');
      expect(lis.length).toBeGreaterThan(0);
      const startAttr = Number(ol.getAttribute('start') || '1');
      expect(startAttr).toBe(expectedStart);
      expectedStart += lis.length;
      totalOlItems += lis.length;
    }
    expect(totalOlItems).toBe(10);

    const totalUlItems = doc.querySelectorAll('ul > li').length;
    expect(totalUlItems).toBe(6);

    // Re-paginating with a tall contentHeightOverride merges the split lists back together cleanly
    const merged = paginateCardsHtml(result.html, {
      ratio: '3:4',
      contentHeightOverride: 2000,
    });
    const mergedDoc = documentOf(merged.html);
    expect(mergedDoc.querySelectorAll('section.morph-card-page').length).toBe(1);
    expect(mergedDoc.querySelectorAll('ol').length).toBe(1);
    expect(mergedDoc.querySelectorAll('ol > li').length).toBe(10);
    expect(mergedDoc.querySelector('ol')?.getAttribute('start')).toBe('5');
    expect(mergedDoc.querySelectorAll('ul').length).toBe(1);
    expect(mergedDoc.querySelectorAll('ul > li').length).toBe(6);
  });

  it('test_multi_row_table_splits_tbody_rows_and_repeats_thead_on_continuation_pages', () => {
    const rows = Array.from({ length: 10 }, (_, idx) => {
      const n = idx + 1;
      return `<tr data-node-id="row-${n}" style="height: 55px;"><td>指标 ${n}</td><td>数值 ${n * 100}</td></tr>`;
    }).join('');

    const html = [
      '<div class="morph-doc">',
      '  <table class="morph-table" data-node-id="table-main">',
      '    <thead><tr style="height: 45px;"><th>监控维度</th><th>当前读数</th></tr></thead>',
      `    <tbody>${rows}</tbody>`,
      '  </table>',
      '</div>',
    ].join('\n');

    const result = paginateCardsHtml(html, {
      ratio: '3:4',
      contentHeightOverride: 260,
    });
    evidence('cards-table-splitting', { state: result.state, html: result.html });

    const doc = documentOf(result.html);
    const pages = Array.from(doc.querySelectorAll('section.morph-card-page'));
    expect(pages.length).toBeGreaterThanOrEqual(2);

    const tables = Array.from(doc.querySelectorAll('table'));
    expect(tables.length).toBe(pages.length);

    // First page table has original thead (not marked as generated repeat)
    const firstThead = tables[0].querySelector('thead');
    expect(firstThead).not.toBeNull();
    expect(firstThead!.getAttribute('data-morph-generated')).toBeNull();

    // Continuation tables on subsequent pages repeat thead with data-morph-generated="repeat"
    for (let i = 1; i < tables.length; i++) {
      const repeatedThead = tables[i].querySelector('thead');
      expect(repeatedThead).not.toBeNull();
      expect(repeatedThead!.getAttribute('data-morph-generated')).toBe('repeat');
      expect(repeatedThead!.textContent).toContain('监控维度');
      expect(repeatedThead!.textContent).toContain('当前读数');
    }

    // All 10 tbody rows are preserved in exact order across pages
    const allBodyRows = Array.from(doc.querySelectorAll('tbody > tr'));
    expect(allBodyRows.length).toBe(10);
    expect(allBodyRows.map((tr) => tr.textContent)).toEqual(
      Array.from({ length: 10 }, (_, idx) => `指标 ${idx + 1}数值 ${(idx + 1) * 100}`),
    );
  });
});

describe('TestOversizeAtomicBlockFallback', () => {
  it('test_oversize_atomic_image_and_formula_scale_to_fit_page_without_infinite_loop_or_blank_page', () => {
    const html = [
      '<div class="morph-doc">',
      '  <p class="morph-p" data-node-id="intro-p">前置正常段落文本。</p>',
      '  <img class="morph-img" data-node-id="giant-img" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" width="720" height="2400" style="height: 2400px;" alt="超高架构全景图" />',
      '  <div class="morph-math-display" data-node-id="giant-math" data-math-tex="\\sum_{i=1}^{n} x_i" style="height: 1800px;">$$\\sum_{i=1}^{n} x_i$$</div>',
      '  <p class="morph-p" data-node-id="outro-p">后置正常段落文本。</p>',
      '</div>',
    ].join('\n');

    const result = paginateCardsHtml(html, {
      ratio: '3:4',
    });
    evidence('cards-oversize-atomic', {
      state: result.state,
      diagnostics: result.diagnostics,
    });

    expect(result.state.totalPages).toBeGreaterThanOrEqual(2);
    expect(result.state.oversizePageNumbers.length).toBeGreaterThanOrEqual(2);

    const oversizeDiags = result.diagnostics.filter((d) => d.code === 'cards/oversize-atomic-scaled');
    expect(oversizeDiags.length).toBeGreaterThanOrEqual(2);
    for (const diag of oversizeDiags) {
      expect(diag.severity).toBe('warning');
      expect(diag.targetId).toBe('cards');
    }

    const doc = documentOf(result.html);
    const scaledNodes = Array.from(doc.querySelectorAll('[data-morph-oversize="scaled"]')) as HTMLElement[];
    expect(scaledNodes.length).toBeGreaterThanOrEqual(2);
    for (const node of scaledNodes) {
      expect(node.style.maxHeight).toBe('100%');
      expect(node.style.objectFit).toBe('contain');
    }

    // Verify zero blank pages exist before, between, or after oversize atomic blocks
    const pages = Array.from(doc.querySelectorAll('section.morph-card-page'));
    for (const page of pages) {
      const hasSemanticNode = Array.from(page.querySelectorAll('*')).some(
        (el) =>
          !el.hasAttribute('data-morph-generated') &&
          !el.closest('[data-morph-generated]') &&
          (el.tagName.toLowerCase() === 'p' ||
            el.tagName.toLowerCase() === 'img' ||
            el.classList.contains('morph-math-display')),
      );
      expect(hasSemanticNode).toBe(true);
    }

    expect(doc.body.textContent).toContain('前置正常段落文本。');
    expect(doc.body.textContent).toContain('后置正常段落文本。');
  });
});

describe('TestLookBackReflowAndConvergence', () => {
  it('test_shortening_block_on_page_k_triggers_look_back_from_previous_page_and_backfills_upward', () => {
    // Available content height = 300px.
    // Initially:
    // - block-1 (190px) fits on Page 1 (110px remaining).
    // - block-2 (160px) does NOT fit in 110px -> goes to Page 2 (140px remaining).
    // - block-3 (180px) does NOT fit in 140px -> goes to Page 3.
    const initialHtml = [
      '<div class="morph-doc">',
      '  <p class="morph-p" data-node-id="block-1" style="height: 190px; margin: 0;">第一页固定段落内容</p>',
      '  <p class="morph-p" data-node-id="block-2" style="height: 160px; margin: 0;">第二页首段（将被缩短以测试向上回填至第一页）</p>',
      '  <p class="morph-p" data-node-id="block-3" style="height: 180px; margin: 0;">第三页尾部段落内容</p>',
      '</div>',
    ].join('\n');

    const initial = paginateCardsHtml(initialHtml, {
      ratio: '3:4',
      contentHeightOverride: 300,
    });
    expect(initial.state.totalPages).toBe(3);

    const initialDoc = documentOf(initial.html);
    const initialPages = Array.from(initialDoc.querySelectorAll('section.morph-card-page'));
    expect(initialPages[0].querySelector('[data-node-id="block-1"]')).not.toBeNull();
    expect(initialPages[0].querySelector('[data-node-id="block-2"]')).toBeNull();
    expect(initialPages[1].querySelector('[data-node-id="block-2"]')).not.toBeNull();

    // Now shorten block-2 on Page 2 from 160px to 80px so it fits in the 110px remaining space on Page 1!
    const shortenedBlock2 = initialDoc.querySelector<HTMLElement>('[data-node-id="block-2"]')!;
    shortenedBlock2.style.height = '80px';
    shortenedBlock2.textContent = '已缩短的第二页首段（应回填至第一页）';

    const reflowed = reflowCards(
      initialDoc.querySelector('.morph-doc')!,
      initial.state,
      { dirtyPageNumber: 2, dirtyNodeIds: ['block-2'] },
      { ratio: '3:4', contentHeightOverride: 300 },
    );
    evidence('cards-lookback-backfill', {
      beforeState: initial.state,
      afterState: reflowed.state,
    });

    // Look-back reflow from Page K=2 must start at max(1, 2 - 1) = Page 1
    expect(reflowed.state.reflowStartPage).toBe(1);
    expect(reflowed.state.totalPages).toBe(2);

    const reflowedDoc = documentOf(reflowed.html);
    const reflowedPages = Array.from(reflowedDoc.querySelectorAll('section.morph-card-page'));
    expect(reflowedPages.length).toBe(2);
    // block-2 has been pulled upward onto Page 1!
    expect(reflowedPages[0].querySelector('[data-node-id="block-1"]')).not.toBeNull();
    expect(reflowedPages[0].querySelector('[data-node-id="block-2"]')).not.toBeNull();
    expect(reflowedPages[1].querySelector('[data-node-id="block-3"]')).not.toBeNull();
  });

  it('test_editing_late_page_reuses_upstream_pages_and_converges_with_downstream_checkpoints', () => {
    // 5 pages where each block is 240px inside a 300px content height budget (1 block per page).
    const blocks = Array.from({ length: 5 }, (_, idx) => {
      const n = idx + 1;
      return `<p class="morph-p" data-node-id="page-block-${n}" style="height: 240px; margin: 0;">第 ${n} 页独立块内容</p>`;
    }).join('\n');
    const initialHtml = `<div class="morph-doc">${blocks}</div>`;

    const initial = paginateCardsHtml(initialHtml, {
      ratio: '3:4',
      contentHeightOverride: 300,
    });
    expect(initial.state.totalPages).toBe(5);
    expect(initial.state.checkpoints.length).toBe(5);

    // Modify page-block-3 on Page 3 slightly (height 240px -> 230px), keeping it on Page 3 without shifting Page 4 or Page 5
    const doc = documentOf(initial.html);
    const block3 = doc.querySelector<HTMLElement>('[data-node-id="page-block-3"]')!;
    block3.style.height = '230px';
    block3.textContent = '第 3 页局部微调后的独立块内容';

    const reflowed = reflowCards(
      doc.querySelector('.morph-doc')!,
      initial.state,
      { dirtyPageNumber: 3, dirtyNodeIds: ['page-block-3'] },
      { ratio: '3:4', contentHeightOverride: 300 },
    );
    evidence('cards-lookback-convergence', {
      beforeCheckpoints: initial.state.checkpoints,
      afterState: reflowed.state,
    });

    // K = 3 -> reflowStartPage = max(1, 3 - 1) = 2
    expect(reflowed.state.reflowStartPage).toBe(2);
    // Page 1 is upstream of reflowStartPage and must be reused without recomputation
    expect(reflowed.state.reusedPageNumbers).toContain(1);
    // Downstream pages converge and reuse trailing pages (Page 4 / Page 5)
    expect(reflowed.state.convergedAtPage).not.toBeNull();
    expect(
      reflowed.state.reusedPageNumbers.some((p) => p >= 4),
    ).toBe(true);
    expect(reflowed.state.totalPages).toBe(5);
  });
});

describe('TestCardsSelectionAndBrowserLayoutVerification', () => {
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

  it('test_full_snapshot_and_cross_page_selection_strip_generated_chrome_and_preserve_source_semantics', async () => {
    const store = assetStore();
    const imgRecord = await store.ingest(png(5, 120, 80), { fileName: 'chart.png' });

    const tableRows = Array.from({ length: 8 }, (_, idx) => {
      const n = idx + 1;
      return `| 阶段 ${n} | 完成度 ${n * 10}% |`;
    }).join('\n');

    const markdown = [
      '# 卡片复制与跨页选区验证',
      '',
      `![数据趋势图](${imgRecord.uri})`,
      '',
      '这里包含行内公式 $a^2 + b^2 = c^2$ 的段落。',
      '',
      '1. 第一步准备数据集',
      '2. 第二步训练基线模型',
      '3. 第三步评估跨页列表续接',
      '4. 第四步生成多比例卡片',
      '5. 第五步验证选区重建',
      '6. 第六步导出高分位图',
      '',
      '| 项目阶段 | 指标状态 |',
      '| :--- | :--- |',
      tableRows,
    ].join('\n');

    const snapshot = await buildDeliverySnapshot(markdown, 'cards', store, {
      cardsOptions: {
        ratio: '3:4',
        headerText: 'MorphMD 页眉不得进入剪贴板',
        contentHeightOverride: 280,
      },
    });

    expect(snapshot.ready).toBe(true);
    const previewDoc = documentOf(snapshot.html);
    expect(previewDoc.querySelectorAll('section.morph-card-page').length).toBeGreaterThanOrEqual(2);
    expect(previewDoc.querySelectorAll('[data-morph-generated="header"]').length).toBeGreaterThanOrEqual(2);
    expect(previewDoc.querySelectorAll('[data-morph-generated="footer"]').length).toBeGreaterThanOrEqual(2);
    expect(previewDoc.querySelectorAll('thead[data-morph-generated="repeat"]').length).toBeGreaterThanOrEqual(1);

    // 1. Full snapshot serialization strips all generated headers/footers/repeated theads and unwraps .morph-card-page
    const fullPayload = serializeFullSnapshot(snapshot, store);
    const fullCopyDoc = documentOf(fullPayload.html);
    expect(fullCopyDoc.querySelectorAll('.morph-card-page').length).toBe(0);
    expect(fullCopyDoc.querySelectorAll('[data-morph-generated]').length).toBe(0);
    expect(fullCopyDoc.querySelectorAll('thead').length).toBe(1);
    expect(fullPayload.plainText).not.toContain('MorphMD 页眉不得进入剪贴板');
    expect(fullPayload.plainText).not.toMatch(/\b01\s*\/\s*0\d\b/);
    expect(fullPayload.plainText).toContain('$a^2 + b^2 = c^2$');
    expect(fullPayload.plainText).toContain('[Image: 数据趋势图]');
    expect(fullPayload.plainText).toContain('阶段 8');

    const copiedImgSrc = fullCopyDoc.querySelector('img')?.getAttribute('src') || '';
    const decoded = await decodeBitmapDataUrl(page, copiedImgSrc);
    expect(decoded).toEqual({ decoded: true, width: 120, height: 80 });

    // 2. Cross-page selection spanning from Page 1 into Page 2 strips generated chrome & reconstructs list start
    const root = previewDoc.querySelector<HTMLElement>('.morph-doc')!;
    const pages = Array.from(root.querySelectorAll('section.morph-card-page'));
    const range = previewDoc.createRange();
    range.setStart(pages[0], 0);
    range.setEnd(pages[1], pages[1].childNodes.length);

    const crossPagePayload = normalizeSelectionRange(range, root, snapshot, store);
    const crossDoc = documentOf(crossPagePayload.html);
    expect(crossDoc.querySelectorAll('.morph-card-page').length).toBe(0);
    expect(crossDoc.querySelectorAll('[data-morph-generated]').length).toBe(0);
    expect(crossPagePayload.plainText).not.toContain('MorphMD 页眉不得进入剪贴板');
    expect(crossPagePayload.plainText).toContain('卡片复制与跨页选区验证');
  });

  it('test_paginated_cards_render_at_exact_preset_geometry_and_paginate_live_dom_without_vertical_overflow', async () => {
    const store = new AssetStore();
    try {
      const markdown = [
        '# 真实排版几何与分页溢出核验',
        '',
        '## 第一节：多比例画布尺寸契约',
        '',
        ...Array.from(
          { length: 10 },
          (_, i) =>
            `第 ${i + 1} 段测试文本：在真实浏览器排版引擎中验证每张卡片的渲染边界尺寸与预设完全一致，且页面内容区域绝不发生垂直截断或溢出。`,
        ),
        '',
        '1. 列表项一：验证列表跨页拆分高度',
        '2. 列表项二：验证列表跨页续接编号',
        '3. 列表项三：验证列表项内行高与边距',
        '4. 列表项四：验证最后一页零空白废页',
      ].join('\n');

      const ratios: CardAspectRatio[] = ['3:4', '4:5', '1:1', '16:9'];

      for (const ratio of ratios) {
        const preset = getCardPreset(ratio);
        const snapshot = await buildDeliverySnapshot(markdown, 'cards', store, {
          cardsOptions: { ratio, headerText: `MorphMD ${ratio}` },
        });

        await page.setViewportSize({ width: 1400, height: 1200 });
        const measurements = await page.evaluate((html) => {
          document.body.style.margin = '0';
          document.body.innerHTML = html;
          const cardPages = Array.from(document.querySelectorAll('section.morph-card-page')) as HTMLElement[];
          return cardPages.map((card) => {
            const rect = card.getBoundingClientRect();
            const body = (card.querySelector('.morph-card-body, [data-morph-card-body]') as HTMLElement | null) || card;
            return {
              page: card.getAttribute('data-page'),
              ratio: card.getAttribute('data-ratio'),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              bodyScrollHeight: body.scrollHeight,
              bodyClientHeight: body.clientHeight,
            };
          });
        }, snapshot.html);

        expect(measurements.length).toBeGreaterThanOrEqual(2);
        for (const m of measurements) {
          expect(m.ratio).toBe(ratio);
          expect(m.width).toBe(preset.layoutWidth);
          expect(m.height).toBe(preset.layoutHeight);
        }
      }

      // Verify paginateDom directly executed on a live browser DOM element splits overflowing content without vertical overflow
      const unpaginatedBlocks = Array.from(
        { length: 14 },
        (_, i) =>
          `<p class="morph-p" data-node-id="live-p-${i + 1}" style="font-size: 18px; line-height: 1.7; margin: 0 0 16px 0;">实时浏览器 DOM 测量段落 ${i + 1}：用于验证 paginateDom 在真实渲染树上按 getBoundingClientRect / offsetHeight 拆分多页卡片。</p>`,
      ).join('');
      const liveResult = paginateCardsHtml(`<div class="morph-doc">${unpaginatedBlocks}</div>`, {
        ratio: '16:9',
      });

      const liveCheck = await page.evaluate((html) => {
        document.body.innerHTML = html;
        const cards = Array.from(document.querySelectorAll('section.morph-card-page')) as HTMLElement[];
        return cards.map((card) => {
          const rect = card.getBoundingClientRect();
          const body = (card.querySelector('.morph-card-body, [data-morph-card-body]') as HTMLElement | null) || card;
          return {
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            overflowPx: body.scrollHeight - body.clientHeight,
          };
        });
      }, liveResult.html);

      expect(liveCheck.length).toBeGreaterThanOrEqual(2);
      for (const item of liveCheck) {
        expect(item.width).toBe(960);
        expect(item.height).toBe(540);
        expect(item.overflowPx).toBeLessThanOrEqual(2);
      }
    } finally {
      store.clear();
    }
  });
});
