import { chromium, type Browser, type Page } from 'playwright';
import { build as viteBuild } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AssetStore,
  buildDeliverySnapshot,
  compileMarkdown,
} from '../src/index';
import { decodeBitmapDataUrl, png } from './support/fixtures';
import {
  createXArticleVerificationSession,
  inspectRasterDataUrl,
  verifyXArticleHtml,
  type XArticleVerificationSession,
} from './verifiers/x-article/index';

describe('TestXArticlePipeline', () => {
  let browser: Browser;
  let page: Page;
  let xSession: XArticleVerificationSession;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    xSession = await createXArticleVerificationSession();
  });

  afterAll(async () => {
    if (xSession) {
      await xSession.close();
    }
    if (browser) {
      await browser.close();
    }
  });

  // =========================================================================
  // 维度 1：本地图片资产 —— 零图床依赖并映射为 Draft.js IMAGE 实体（#2.3）
  // =========================================================================
  it('test_local_image_without_remote_host_resolves_to_ready_image_node', async () => {
    const assetStore = new AssetStore();
    const pngBytes = png(1, 12, 8);
    const record = await assetStore.ingest(pngBytes, { fileName: 'local-arch.png' });

    // 【前置校验】：未解析的 morph-asset:// 图片在 X Verifier 中必须触发 unsafe-media-or-link 违规
    const preCheck = verifyXArticleHtml(`<img src="morph-asset://${record.id}" alt="未解析图片" />`);
    expect(preCheck.isValid).toBe(false);
    expect(Object.keys(preCheck.inValidInfo)).toContain('unsafe-media-or-link');

    const markdown = [
      '# X 长文无图床测试',
      '',
      '直接引用本地图片：',
      `![系统架构图](morph-asset://${record.id})`,
      '',
      '跨段引用本地图片：',
      '![备份拓扑图][topo-ref]',
      '',
      `[topo-ref]: morph-asset://${record.id}`,
    ].join('\n');

    const snapshot = await buildDeliverySnapshot(markdown, 'x-article', assetStore);

    try {
      const verifyResult = await xSession.verifyHtml(snapshot.html);
      const imageEntities = Object.values(verifyResult.draftState.entityMap).filter(
        (entity) => entity.type === 'IMAGE'
      );

      expect(snapshot.ready).toBe(true);
      expect(snapshot.diagnostics.some((d) => d.severity === 'error')).toBe(false);
      // 1. 100% 通过 X 结构与真实浏览器解码校验器
      expect(verifyResult.isValid).toBe(true);
      expect(verifyResult.inValidInfo).toEqual({});
      // 2. 通过 verifyResult.draftState.entityMap 核对识别出的 2 个 IMAGE 实体及 alt 文本，并在真实 Chromium 中解码为 12x8 位图
      expect(imageEntities.length).toBe(2);
      expect(imageEntities.map((e) => e.data.alt)).toEqual(['系统架构图', '备份拓扑图']);
      for (const entity of imageEntities) {
        const decoded = await decodeBitmapDataUrl(page, String(entity.data.src || ''));
        expect(decoded).toEqual({ decoded: true, width: 12, height: 8 });
      }
    } finally {
      assetStore.clear();
    }
  });

  // =========================================================================
  // 维度 2：表格（含孤立 tr/td）、数学公式（含裸 math/katex/morph-math）、SVG —— 统一转成真非空白位图实体（#1.3、#2.1、#2.2）
  // =========================================================================
  it('test_table_math_and_svg_blocks_convert_to_bitmap_image_nodes', async () => {
    const assetStore = new AssetStore();

    // 【前置校验】：裸 <table>、孤立 <tr><td>、公式节点（<math>/.katex/.morph-math）、裸 <svg> 及伪造的 data:image/svg+xml 均被 Verifier 拦截
    const rawNonCompliant = [
      '<table><tr><td>原生表格</td></tr></table>',
      '<math><mi>x</mi></math>',
      '<span class="katex"><span class="katex-mathml">y=2x</span><span class="katex-html">y=2x</span></span>',
      '<span class="morph-math" data-math-tex="z=3x">z=3x</span>',
      '<svg width="100" height="40"><rect width="100" height="40"/></svg>',
      '<img data-morph-rasterized="true" src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" alt="伪造SVG位图" />',
    ].join('\n');
    const preCheck = verifyXArticleHtml(rawNonCompliant);
    expect(preCheck.isValid).toBe(false);
    expect(Object.keys(preCheck.inValidInfo)).toEqual(
      expect.arrayContaining([
        'unrasterized-table',
        'unrasterized-math',
        'unrasterized-svg',
        'unsafe-media-or-link',
      ])
    );

    const preCheckOrphanTr = verifyXArticleHtml('<tr><td>孤立表格行单元格A</td><td>孤立表格行单元格B</td></tr>');
    expect(preCheckOrphanTr.isValid).toBe(false);
    expect(Object.keys(preCheckOrphanTr.inValidInfo)).toContain('unrasterized-table');

    const markdown = [
      '## 复杂块转位图测试',
      '',
      '| 目标平台 | 行内样式 |',
      '| :--- | :--- |',
      '| 微信公众号 | 保留 |',
      '| X Articles | 剥离 |',
      '',
      '<table><thead><tr><th>HTML原生表头A</th><th>HTML原生表头B</th></tr></thead><tbody><tr><td>单元格A1</td><td>单元格B1</td></tr></tbody></table>',
      '',
      '<tr><td>孤立行单元格数据甲</td><td>孤立行单元格数据乙</td></tr>',
      '',
      '质能方程 $E = mc^2$ 是行内公式。',
      '',
      '$$',
      '\\int_0^1 x^2 dx = \\frac{1}{3}',
      '$$',
      '',
      '<p>手写数学节点：<math><mi>\\alpha</mi><mo>+</mo><mi>\\beta</mi></math> 与 <span class="katex"><span class="katex-mathml">\\gamma = \\theta</span><span class="katex-html">\\gamma = \\theta</span></span> 以及 <span class="morph-math" data-math-tex="\\Delta = b^2 - 4ac">\\Delta = b^2 - 4ac</span></p>',
      '',
      '<svg width="100" height="40" aria-label="架构矢量图"><rect width="100" height="40" fill="#0969da"/><circle cx="50" cy="20" r="12" fill="#ffffff"/></svg>',
    ].join('\n');

    const snapshot = await buildDeliverySnapshot(markdown, 'x-article', assetStore);

    try {
      const verifyResult = await xSession.verifyHtml(snapshot.html);
      const imageEntities = Object.values(verifyResult.draftState.entityMap).filter(
        (entity) => entity.type === 'IMAGE'
      );

      expect(snapshot.ready).toBe(true);
      // 1. 100% 通过 X 结构与真实浏览器位图解码校验器（确保无未光栅化表格/孤立单元格/公式/SVG，且无纯色空白占位图）
      expect(verifyResult.isValid).toBe(true);
      expect(verifyResult.inValidInfo).toEqual({});

      // 2. 表格(3: Markdown表 + HTML表 + 孤立tr/td) + 公式(5: 行内 + 块级 + <math> + .katex + .morph-math) + SVG(1) = 9 个光栅化 IMAGE 实体
      expect(imageEntities.length).toBe(9);
      const tableEntities = imageEntities.filter((e) => e.data.rasterType === 'table');
      const mathEntities = imageEntities.filter((e) => e.data.rasterType === 'math');
      const svgEntities = imageEntities.filter((e) => e.data.rasterType === 'svg');
      expect(tableEntities.length).toBe(3);
      expect(mathEntities.length).toBe(5);
      expect(svgEntities.length).toBe(1);

      // 3. 核对每个光栅化位图均具有真实前景内容像素，且不同表格、不同公式生成的 pixelDigest 互不相同
      const tableDigests = new Set<string>();
      for (const ent of tableEntities) {
        const check = inspectRasterDataUrl(String(ent.data.src || ''), true);
        expect(check.valid).toBe(true);
        expect(check.hasContentPixels).toBe(true);
        expect(check.pixelDigest).toBeTruthy();
        tableDigests.add(check.pixelDigest!);
      }
      expect(tableDigests.size).toBe(3);

      const mathDigests = new Set<string>();
      for (const ent of mathEntities) {
        const check = inspectRasterDataUrl(String(ent.data.src || ''), true);
        expect(check.valid).toBe(true);
        expect(check.hasContentPixels).toBe(true);
        expect(check.pixelDigest).toBeTruthy();
        mathDigests.add(check.pixelDigest!);
      }
      expect(mathDigests.size).toBe(5);

      const svgCheck = inspectRasterDataUrl(String(svgEntities[0].data.src || ''), true);
      expect(svgCheck.valid).toBe(true);
      expect(svgCheck.hasContentPixels).toBe(true);

      // 4. 核对 IMAGE 实体 alt 原稿语义与上下文正文完整保留
      const allAlts = imageEntities.map((e) => String(e.data.alt || '')).join(' | ');
      expect(allAlts).toContain('微信公众号');
      expect(allAlts).toContain('HTML原生表头A');
      expect(allAlts).toContain('孤立行单元格数据甲');
      expect(allAlts).toContain('E = mc^2');
      expect(allAlts).toContain('\\int_0^1 x^2 dx');
      expect(allAlts).toContain('\\alpha');
      expect(allAlts).toContain('\\gamma');
      expect(allAlts).toContain('\\Delta = b^2 - 4ac');
      expect(svgEntities[0].data.alt).toBe('架构矢量图');
      expect(
        verifyResult.draftState.blocks.some(
          (b) => b.text.includes('质能方程') && b.text.includes('是行内公式。')
        )
      ).toBe(true);
    } finally {
      assetStore.clear();
    }
  });

  // =========================================================================
  // 维度 3：标题层级降级与非法 data-original-heading 属性清洗（#1.1 heading-level）
  // =========================================================================
  it('test_headings_h1_to_h6_downgrade_deep_levels_to_h2_and_clean_illegal_heading_attributes', async () => {
    const assetStore = new AssetStore();

    // 【前置校验】：未降级的 h3~h6 以及挂载在 <p>/<h1>/<h2 data-original-heading="h1"> 上的非法属性均触发 heading-level 违规
    const preCheckH3 = verifyXArticleHtml('<h3>未降级的三级标题</h3>');
    expect(preCheckH3.isValid).toBe(false);
    expect(Object.keys(preCheckH3.inValidInfo)).toContain('heading-level');
    expect(preCheckH3.draftState.blocks[0].type).toBe('unstyled');

    const preCheckBadAttrOnP = verifyXArticleHtml('<p data-original-heading="h3">段落伪装标题属性</p>');
    expect(preCheckBadAttrOnP.isValid).toBe(false);
    expect(Object.keys(preCheckBadAttrOnP.inValidInfo)).toContain('heading-level');

    const preCheckBadAttrOnH1 = verifyXArticleHtml('<h1 data-original-heading="h3">一级标题非法挂载属性</h1>');
    expect(preCheckBadAttrOnH1.isValid).toBe(false);
    expect(Object.keys(preCheckBadAttrOnH1.inValidInfo)).toContain('heading-level');

    const preCheckBadAttrOnH2 = verifyXArticleHtml('<h2 data-original-heading="h1">二级标题非法属性取值</h2>');
    expect(preCheckBadAttrOnH2.isValid).toBe(false);
    expect(Object.keys(preCheckBadAttrOnH2.inValidInfo)).toContain('heading-level');

    const markdown = [
      '# 一级主标题',
      '## 二级副标题',
      '### 三级小节标题',
      '#### 四级小节标题',
      '##### 五级小节标题',
      '###### 六级小节标题',
      '',
      '<p data-original-heading="h3">段落伪装标题属性</p>',
      '',
      '<h1 data-original-heading="h3">一级标题非法挂载属性</h1>',
      '',
      '<h2 data-original-heading="h1">二级标题非法属性取值</h2>',
    ].join('\n');

    const snapshot = await buildDeliverySnapshot(markdown, 'x-article', assetStore);

    try {
      const verifyResult = await xSession.verifyHtml(snapshot.html);

      expect(snapshot.ready).toBe(true);
      expect(verifyResult.isValid).toBe(true);
      expect(verifyResult.inValidInfo).toEqual({});
      // 通过 Draft.js 仿真块序列验证 H1 映射为 header-one，H2~H6 映射为 header-two，且带非法属性节点的正文一字不差
      expect(
        verifyResult.draftState.blocks.map((b) => ({ type: b.type, text: b.text }))
      ).toEqual([
        { type: 'header-one', text: '一级主标题' },
        { type: 'header-two', text: '二级副标题' },
        { type: 'header-two', text: '三级小节标题' },
        { type: 'header-two', text: '四级小节标题' },
        { type: 'header-two', text: '五级小节标题' },
        { type: 'header-two', text: '六级小节标题' },
        { type: 'unstyled', text: '段落伪装标题属性' },
        { type: 'header-one', text: '一级标题非法挂载属性' },
        { type: 'header-two', text: '二级标题非法属性取值' },
      ]);
      expect(snapshot.diagnostics.length).toBeGreaterThan(0);
    } finally {
      assetStore.clear();
    }
  });

  // =========================================================================
  // 维度 4：提示框（Callout）及残缺/孤立 Callout 结构、原始 GFM 标记归一化（#1.2 callout-structure）
  // =========================================================================
  it('test_callout_containers_and_raw_gfm_markers_convert_to_native_blockquotes', async () => {
    const assetStore = new AssetStore();

    // 【前置校验】：div.morph-callout、缺标题的 blockquote.morph-callout、孤立 .morph-callout-title/.morph-callout-body 及未解析的 [!NOTE]/[!TIP] 均触发 callout-structure 违规
    const preCheckDivCallout = verifyXArticleHtml('<div class="morph-callout"><p>未降级提示框</p></div>');
    expect(preCheckDivCallout.isValid).toBe(false);
    expect(Object.keys(preCheckDivCallout.inValidInfo)).toContain('callout-structure');

    const preCheckTitlelessBq = verifyXArticleHtml(
      '<blockquote class="morph-callout" data-callout-type="warning"><p>缺少加粗标题的引用提示框正文</p></blockquote>'
    );
    expect(preCheckTitlelessBq.isValid).toBe(false);
    expect(Object.keys(preCheckTitlelessBq.inValidInfo)).toContain('callout-structure');

    const preCheckOrphanParts = verifyXArticleHtml(
      '<div class="morph-callout-title">孤立提示框标题</div><div class="morph-callout-body"><p>孤立提示框正文</p></div>'
    );
    expect(preCheckOrphanParts.isValid).toBe(false);
    expect(Object.keys(preCheckOrphanParts.inValidInfo)).toContain('callout-structure');

    const preCheckRawMarker = verifyXArticleHtml(
      '<blockquote><p>[!NOTE] 手写HTML引用块中的未清洗标记正文</p></blockquote><p>[!TIP] 普通段落中的未清洗提示标记</p>'
    );
    expect(preCheckRawMarker.isValid).toBe(false);
    expect(Object.keys(preCheckRawMarker.inValidInfo)).toContain('callout-structure');

    const markdown = [
      '> [!WARNING] 部署警告',
      '> 请勿在周五下午执行发版操作。',
      '',
      '<div class="morph-callout" data-callout-type="note"><div class="morph-callout-title">架构说明</div><div class="morph-callout-body"><p>所有跨端视图共享同一份语义语法树。</p></div></div>',
      '',
      '<blockquote class="morph-callout" data-callout-type="important"><p>缺少加粗标题的引用提示框正文</p></blockquote>',
      '',
      '<div class="morph-callout-title">孤立提示框标题</div><div class="morph-callout-body"><p>孤立提示框正文</p></div>',
      '',
      '<blockquote><p>[!NOTE] 手写HTML引用块中的未清洗标记正文</p></blockquote>',
      '',
      '<p>[!TIP] 普通段落中的未清洗提示标记</p>',
    ].join('\n');

    const snapshot = await buildDeliverySnapshot(markdown, 'x-article', assetStore);

    try {
      const verifyResult = await xSession.verifyHtml(snapshot.html);
      const { blocks } = verifyResult.draftState;

      expect(snapshot.ready).toBe(true);
      expect(verifyResult.isValid).toBe(true);
      expect(verifyResult.inValidInfo).toEqual({});
      // 1. 标题块文本为 "部署警告" 且携带 BOLD 行内样式
      const titleBlock = blocks.find((b) => b.text.includes('部署警告'));
      expect(titleBlock).toBeDefined();
      expect(titleBlock!.type).toBe('blockquote');
      expect(
        titleBlock!.inlineStyleRanges.some((r) => r.style === 'BOLD' && r.length >= '部署警告'.length)
      ).toBe(true);
      // 2. 所有输入分支的正文语义 100% 保留，且不含 "[!WARNING]" / "[!NOTE]" / "[!TIP]" 原始标记
      const fullText = blocks.map((b) => b.text).join('\n');
      expect(fullText).toContain('请勿在周五下午执行发版操作。');
      expect(fullText).toContain('架构说明');
      expect(fullText).toContain('所有跨端视图共享同一份语义语法树。');
      expect(fullText).toContain('缺少加粗标题的引用提示框正文');
      expect(fullText).toContain('孤立提示框标题');
      expect(fullText).toContain('孤立提示框正文');
      expect(fullText).toContain('手写HTML引用块中的未清洗标记正文');
      expect(fullText).toContain('普通段落中的未清洗提示标记');
      expect(fullText).not.toMatch(/\[!(?:WARNING|NOTE|TIP|IMPORTANT|CAUTION)\]/i);
    } finally {
      assetStore.clear();
    }
  });

  // =========================================================================
  // 维度 5：样式剥离与守卫（含严格模式 allowCodeBlockStyles: false）、列表、代码块、分割线及行内修饰映射（#3.1 native-inline-style）
  // =========================================================================
  it('test_custom_tokens_and_css_strip_inline_styles_with_diagnostics', async () => {
    const assetStore = new AssetStore();

    // 【前置校验】：残留内联 style 的原生节点及根容器在 X Verifier 中触发 native-inline-style 违规（含 allowCodeBlockStyles: false）
    const preCheck = verifyXArticleHtml(
      '<div class="morph-doc" style="color: #111"><h1 style="color: #ff0055">带内联样式的标题</h1><pre style="background: #000"><code style="color: #0f0">const a = 1;</code></pre></div>',
      { allowCodeBlockStyles: false }
    );
    expect(preCheck.isValid).toBe(false);
    expect(preCheck.inValidInfo['native-inline-style']?.items.length).toBeGreaterThanOrEqual(3);

    const markdown = [
      '# 样式守卫标题',
      '',
      '这是一段包含 **重点加粗**、*斜体强调*、~~删除线~~、`inlineCode` 与 [外部链接](https://example.com) 的正文。',
      '',
      '<span style="color: #ff0000">手写内联样式文本</span>',
      '',
      '- 无序父项',
      '  - 无序嵌套子项',
      '',
      '1. 有序第一项',
      '2. 有序第二项',
      '',
      '---',
      '',
      '```ts',
      'const answer = 42;',
      '```',
    ].join('\n');

    const snapshot = await buildDeliverySnapshot(markdown, 'x-article', assetStore, {
      tokens: {
        '--morph-accent': '#ff0055',
      },
      customCss: `
        .morph-doc { background: #fafafa; color: #222222; }
        h1, .morph-h1 { color: #ff0055; font-size: 32px; }
        p, .morph-p { color: #333333; background-color: #ffffaa; }
        pre, code { background-color: #1e1e1e; color: #d4d4d4; }
      `,
    });

    try {
      const verifyResult = await xSession.verifyHtml(snapshot.html);
      const strictVerifyResult = await xSession.verifyHtml(snapshot.html, {
        allowCodeBlockStyles: false,
      });
      const { blocks, entityMap } = verifyResult.draftState;

      expect(snapshot.ready).toBe(true);
      // 1. 诊断列表报告平台不支持自定义样式的告警
      expect(snapshot.diagnostics.some((d) => d.severity === 'warning')).toBe(true);
      // 2. 通过默认模式与 { allowCodeBlockStyles: false } 严格模式下的 #3.1 native-inline-style 校验
      expect(verifyResult.isValid).toBe(true);
      expect(verifyResult.inValidInfo).toEqual({});
      expect(strictVerifyResult.isValid).toBe(true);
      expect(strictVerifyResult.inValidInfo).toEqual({});
      // 3. 验证 Draft.js 块类型、列表嵌套 depth、行内样式 (BOLD/ITALIC/STRIKETHROUGH/CODE) 及 LINK / DIVIDER 实体
      expect(blocks.find((b) => b.type === 'header-one')?.text).toBe('样式守卫标题');
      const richParagraph = blocks.find((b) => b.text.includes('重点加粗'));
      expect(richParagraph).toBeDefined();
      const richStyles = new Set(richParagraph!.inlineStyleRanges.map((r) => r.style));
      expect(richStyles).toEqual(new Set(['BOLD', 'ITALIC', 'STRIKETHROUGH', 'CODE']));

      const flattenedUlItem = blocks.find((b) => b.type === 'unordered-list-item' && b.text.includes('无序父项'));
      expect(flattenedUlItem).toBeDefined();
      expect(flattenedUlItem?.depth).toBe(0);
      expect(flattenedUlItem?.text).toBe('无序父项\n- 无序嵌套子项');

      const orderedItems = blocks.filter((b) => b.type === 'ordered-list-item');
      expect(orderedItems.map((b) => b.text)).toEqual(['有序第一项', '有序第二项']);

      expect(blocks.some((b) => b.type === 'code-block' && b.text.includes('const answer = 42;'))).toBe(true);
      expect(blocks.some((b) => b.type === 'atomic')).toBe(true);

      const entities = Object.values(entityMap);
      expect(entities.some((e) => e.type === 'LINK' && e.data.url === 'https://example.com')).toBe(true);
      expect(entities.some((e) => e.type === 'DIVIDER')).toBe(true);
    } finally {
      assetStore.clear();
    }
  });

  // =========================================================================
  // 维度 6：复杂非法容器、列表项非法嵌套、嵌套引用、嵌套 .morph-doc 与超深列表收敛（#1.4 unsupported-element & #1.5 list-depth-exceeded）
  // =========================================================================
  it('test_unsupported_elements_and_deep_list_nesting_normalize_without_text_loss', async () => {
    const assetStore = new AssetStore();
    const pngBytes = png(1, 10, 10);
    const record = await assetStore.ingest(pngBytes, { fileName: 'in-heading.png' });

    // 【前置校验】：验证 #1.4 所有非法容器/嵌套形态与 #1.5 超深列表在 X Verifier 中均精确报错
    const rawUnsupportedHtml = [
      '<section><article><aside><nav><header><footer><main><p>七层语义容器内的正文</p></main></footer></header></nav></aside></article></section>',
      '<li>孤立列表项文本</li>',
      '<ul><p>列表直接包裹的非法段落</p><li>正常列表项文本</li></ul>',
      '<ul><li>列表项前导文本<blockquote>列表项内嵌套引用</blockquote><pre><code>const insideLi = 1;</code></pre><h3>列表项内三级标题</h3><hr /></li></ul>',
      '<h1>标题前导文本<div>标题内嵌套块元素</div></h1>',
      '<pre><code>代码块前导文本</code><div>代码块内嵌套div</div><img src="https://example.com/code.png" alt="代码块内图片" /></pre>',
      '<blockquote><p>外层引用段落</p><blockquote><p>内层嵌套引用段落</p></blockquote></blockquote>',
      '<div class="morph-doc"><p>嵌套morph-doc容器内的段落</p></div>',
    ].join('\n');
    const preCheckUnsupported = verifyXArticleHtml(rawUnsupportedHtml);
    expect(preCheckUnsupported.isValid).toBe(false);
    expect(Object.keys(preCheckUnsupported.inValidInfo)).toContain('unsupported-element');
    expect(preCheckUnsupported.inValidInfo['unsupported-element']!.items.length).toBeGreaterThanOrEqual(8);

    // 6 层嵌套列表（0-indexed depth = 5 > 4）触发 list-depth-exceeded
    const rawDeepListHtml =
      '<ul><li>L1<ul><li>L2<ul><li>L3<ul><li>L4<ul><li>L5<ul><li>L6超深项</li></ul></li></ul></li></ul></li></ul></li></ul></li></ul>';
    const preCheckDeepList = verifyXArticleHtml(rawDeepListHtml);
    expect(preCheckDeepList.isValid).toBe(false);
    expect(Object.keys(preCheckDeepList.inValidInfo)).toContain('list-depth-exceeded');

    const markdown = [
      '<section><article><aside><nav><header><footer><main><p>七层语义容器内的正文</p></main></footer></header></nav></aside></article></section>',
      '',
      '<li>孤立列表项文本</li>',
      '',
      '<ul><p>列表直接包裹的非法段落</p><li>正常列表项文本</li></ul>',
      '',
      '<ul><li>列表项前导文本<blockquote>列表项内嵌套引用</blockquote><pre><code>const insideLi = 1;</code></pre><h3>列表项内三级标题</h3><hr /></li></ul>',
      '',
      `<h1>标题前导文本<div>标题内嵌套块元素</div><img src="morph-asset://${record.id}" alt="标题内嵌套图片" /></h1>`,
      '',
      `<pre><code>代码块前导文本</code><div>代码块内嵌套div</div><img src="morph-asset://${record.id}" alt="代码块内图片" /></pre>`,
      '',
      '<blockquote><p>外层引用段落</p><blockquote><p>内层嵌套引用段落</p></blockquote></blockquote>',
      '',
      '<div class="morph-doc"><p>嵌套morph-doc容器内的段落</p></div>',
      '',
      '1. 第1层列表项',
      '   1. 第2层列表项',
      '      1. 第3层列表项',
      '         1. 第4层列表项',
      '            1. 第5层列表项',
      '               1. 第6层列表项',
      '                  1. 第7层列表项',
      '',
      '- 无序父级列表项',
      '  - 无序子级列表项A',
      '    - 无序孙级列表项B',
    ].join('\n');

    const snapshot = await buildDeliverySnapshot(markdown, 'x-article', assetStore);

    try {
      const verifyResult = await xSession.verifyHtml(snapshot.html);
      const { blocks, entityMap } = verifyResult.draftState;
      const allBlockText = blocks.map((b) => b.text).join('\n');
      const allAlts = Object.values(entityMap)
        .filter((e) => e.type === 'IMAGE')
        .map((e) => String(e.data.alt || ''))
        .join(' | ');

      expect(snapshot.ready).toBe(true);
      // 1. 100% 通过 X Verifier（无 unsupported-element，无 list-depth-exceeded）
      expect(verifyResult.isValid).toBe(true);
      expect(verifyResult.inValidInfo).toEqual({});
      // 2. 所有列表项的 depth 均收敛在 <= 4 范围内
      const listBlocks = blocks.filter(
        (b) => b.type === 'unordered-list-item' || b.type === 'ordered-list-item'
      );
      expect(listBlocks.length).toBeGreaterThanOrEqual(7);
      expect(listBlocks.every((b) => b.depth <= 4)).toBe(true);
      expect(Math.max(...listBlocks.map((b) => b.depth))).toBe(4);
      const flattenedNestedUl = blocks.find(
        (b) =>
          b.type === 'unordered-list-item' &&
          b.text === '无序父级列表项\n- 无序子级列表项A\n- 无序孙级列表项B'
      );
      expect(flattenedNestedUl).toBeDefined();
      expect(flattenedNestedUl?.depth).toBe(0);
      // 3. 原稿所有正文、深层列表项与图片替代文本一字不差
      expect(Object.values(entityMap).filter((e) => e.type === 'IMAGE').length).toBe(2);
      const expectedTexts = [
        '七层语义容器内的正文',
        '孤立列表项文本',
        '列表直接包裹的非法段落',
        '正常列表项文本',
        '列表项前导文本',
        '列表项内嵌套引用',
        'const insideLi = 1;',
        '列表项内三级标题',
        '标题前导文本',
        '标题内嵌套块元素',
        '标题内嵌套图片',
        '代码块前导文本',
        '代码块内嵌套div',
        '代码块内图片',
        '外层引用段落',
        '内层嵌套引用段落',
        '嵌套morph-doc容器内的段落',
        '第1层列表项',
        '第2层列表项',
        '第3层列表项',
        '第4层列表项',
        '第5层列表项',
        '第6层列表项',
        '第7层列表项',
        '无序父级列表项\n- 无序子级列表项A\n- 无序孙级列表项B',
      ];
      for (const txt of expectedTexts) {
        expect(`${allBlockText}\n${allAlts}`).toContain(txt);
      }
    } finally {
      assetStore.clear();
    }
  });

  // =========================================================================
  // 维度 7：媒体与超链接安全协议守卫（#2.3 unsafe-media-or-link 全分支）
  // =========================================================================
  it('test_unsafe_media_protocols_and_dangerous_links_sanitize_cleanly', async () => {
    const assetStore = new AssetStore();
    const pngBytes = png(1, 8, 6);
    const record = await assetStore.ingest(pngBytes, { fileName: 'safe.png' });

    // 【前置校验】：危险链接（javascript:/vbscript:/data:text/html）、内联事件（onclick/onerror）、srcset、非加密 http:// 图片及 data:image/svg+xml 图片均触发 unsafe-media-or-link
    const rawUnsafeHtml = [
      '<p onclick="window.__pwned_click = true">带点击事件的正文段落</p>',
      '<p><a href="javascript:alert(1)">JS恶意链接</a> <a href="vbscript:msgbox(1)">VBS恶意链接</a> <a href="data:text/html,&lt;script&gt;alert(1)&lt;/script&gt;">Data恶意链接</a></p>',
      '<img src="https://example.com/a.png" srcset="https://example.com/a-2x.png 2x" onerror="alert(2)" alt="带srcset与onerror的图片" />',
      '<img src="http://insecure.example.com/plain.png" alt="非加密HTTP图片" />',
      '<img src="data:image/svg+xml;utf8,&lt;svg xmlns=&quot;http://www.w3.org/2000/svg&quot; width=&quot;40&quot; height=&quot;20&quot;&gt;&lt;rect width=&quot;40&quot; height=&quot;20&quot; fill=&quot;red&quot;/&gt;&lt;/svg&gt;" alt="SVG数据URL图片" />',
    ].join('\n');
    const preCheck = verifyXArticleHtml(rawUnsafeHtml);
    expect(preCheck.isValid).toBe(false);
    expect(Object.keys(preCheck.inValidInfo)).toContain('unsafe-media-or-link');
    expect(preCheck.inValidInfo['unsafe-media-or-link']!.items.length).toBeGreaterThanOrEqual(6);

    const markdown = [
      '<p onclick="window.__pwned_click = true">带点击事件的正文段落</p>',
      '',
      '<script>window.__pwned = true;</script>',
      '',
      '[JS恶意链接](javascript:alert(1)) 与 <a href="vbscript:msgbox(1)">VBS恶意链接</a> 与 <a href="data:text/html,evil">Data恶意链接</a> 与 [安全文档链接](https://example.com/docs)',
      '',
      `<img src="morph-asset://${record.id}" srcset="https://example.com/a-2x.png 2x" onerror="alert(2)" alt="净化srcset与onerror的本地图" />`,
      '',
      '<img src="http://insecure.example.com/plain.png" alt="非加密HTTP图片说明" />',
      '',
      '<img src="data:image/svg+xml;utf8,&lt;svg xmlns=&quot;http://www.w3.org/2000/svg&quot; width=&quot;40&quot; height=&quot;20&quot;&gt;&lt;rect width=&quot;40&quot; height=&quot;20&quot; fill=&quot;red&quot;/&gt;&lt;/svg&gt;" alt="SVG数据URL图片说明" />',
    ].join('\n');

    const snapshot = await buildDeliverySnapshot(markdown, 'x-article', assetStore);

    try {
      const verifyResult = await xSession.verifyHtml(snapshot.html);
      const { blocks, entityMap } = verifyResult.draftState;
      const allBlockText = blocks.map((b) => b.text).join('\n');
      const allAlts = Object.values(entityMap)
        .filter((e) => e.type === 'IMAGE')
        .map((e) => String(e.data.alt || ''))
        .join(' | ');
      const combinedTextAndAlts = `${allBlockText}\n${allAlts}`;
      const linkUrls = Object.values(entityMap)
        .filter((e) => e.type === 'LINK')
        .map((e) => String(e.data.url || ''));

      expect(snapshot.ready).toBe(true);
      // 1. 净化后产物 100% 通过 X Verifier 与浏览器校验
      expect(verifyResult.isValid).toBe(true);
      expect(verifyResult.inValidInfo).toEqual({});
      // 2. 正文、被降级或保留的链接文本、图片替代文本及安全链接完整保留
      expect(combinedTextAndAlts).toContain('带点击事件的正文段落');
      expect(combinedTextAndAlts).toContain('JS恶意链接');
      expect(combinedTextAndAlts).toContain('VBS恶意链接');
      expect(combinedTextAndAlts).toContain('Data恶意链接');
      expect(combinedTextAndAlts).toContain('净化srcset与onerror的本地图');
      expect(combinedTextAndAlts).toContain('非加密HTTP图片说明');
      expect(combinedTextAndAlts).toContain('SVG数据URL图片说明');
      expect(linkUrls).toContain('https://example.com/docs');
      // 3. 恶意脚本、事件属性、srcset 与危险协议完全清除
      expect(allBlockText).not.toContain('window.__pwned');
      expect(linkUrls.some((u) => /^(?:javascript|vbscript|data):/i.test(u))).toBe(false);
      expect(snapshot.html.toLowerCase()).not.toContain('javascript:');
      expect(snapshot.html.toLowerCase()).not.toContain('vbscript:');
      expect(snapshot.html.toLowerCase()).not.toContain('onclick=');
      expect(snapshot.html.toLowerCase()).not.toContain('onerror=');
      expect(snapshot.html.toLowerCase()).not.toContain('srcset=');
    } finally {
      assetStore.clear();
    }
  });

  // =========================================================================
  // 维度 8：链接包裹图片与嵌套链接拆解（#4.1 entity-conflict）
  // =========================================================================
  it('test_nested_links_and_linked_images_decompose_without_entity_conflict', async () => {
    const assetStore = new AssetStore();
    const pngBytes = png(1, 16, 12);
    const record = await assetStore.ingest(pngBytes, { fileName: 'linked.png' });

    // 【前置校验】：<a> 内包裹 <img> 以及嵌套 <a>...<a>...</a></a> 在 X Verifier 中均触发 entity-conflict
    const preCheckLinkedImg = verifyXArticleHtml(
      '<p><a href="https://example.com/arch"><img src="https://example.com/pic.png" alt="链接包裹图片" /></a></p>'
    );
    expect(preCheckLinkedImg.isValid).toBe(false);
    expect(Object.keys(preCheckLinkedImg.inValidInfo)).toContain('entity-conflict');

    const preCheckNestedAnchor = verifyXArticleHtml(
      '<p><a href="https://example.com/outer">外层链接文本<a href="https://example.com/inner">内层链接文本</a></a></p>'
    );
    expect(preCheckNestedAnchor.isValid).toBe(false);
    expect(Object.keys(preCheckNestedAnchor.inValidInfo)).toContain('entity-conflict');

    const markdown = [
      `[![可点击架构图](morph-asset://${record.id})](https://example.com/arch)`,
      '',
      `<p><a href="https://example.com/mixed">前导链接文字<img src="morph-asset://${record.id}" alt="混排链接内图片" />后续链接文字</a></p>`,
      '',
      '<p><a href="https://example.com/outer">外层链接文本<a href="https://example.com/inner">内层链接文本</a></a></p>',
    ].join('\n');

    const snapshot = await buildDeliverySnapshot(markdown, 'x-article', assetStore);

    try {
      const verifyResult = await xSession.verifyHtml(snapshot.html);
      const { blocks, entityMap } = verifyResult.draftState;
      const imageEntities = Object.values(entityMap).filter((e) => e.type === 'IMAGE');
      const linkUrls = Object.values(entityMap)
        .filter((e) => e.type === 'LINK')
        .map((e) => String(e.data.url || ''));
      const allBlockText = blocks.map((b) => b.text).join('\n');

      expect(snapshot.ready).toBe(true);
      // 1. 100% 通过 X Verifier（无 entity-conflict 重叠实体冲突）
      expect(verifyResult.isValid).toBe(true);
      expect(verifyResult.inValidInfo).toEqual({});
      // 2. 两张图片与所有链接文字、目标 URL 均完整保留，且图片在真实 Chromium 中可解码
      expect(imageEntities.length).toBe(2);
      expect(imageEntities.map((e) => e.data.alt)).toEqual(['可点击架构图', '混排链接内图片']);
      for (const ent of imageEntities) {
        const decoded = await decodeBitmapDataUrl(page, String(ent.data.src || ''));
        expect(decoded).toEqual({ decoded: true, width: 16, height: 12 });
      }
      expect(linkUrls).toEqual(
        expect.arrayContaining([
          'https://example.com/arch',
          'https://example.com/mixed',
          'https://example.com/outer',
          'https://example.com/inner',
        ]),
      );
      expect(allBlockText).toContain('前导链接文字');
      expect(allBlockText).toContain('后续链接文字');
      expect(allBlockText).toContain('外层链接文本');
      expect(allBlockText).toContain('内层链接文本');
    } finally {
      assetStore.clear();
    }
  });

  // =========================================================================
  // 维度 9：图文混排段落、列表项内嵌图与公式、空白块防坍塌（#4.2 content-loss）
  // =========================================================================
  it('test_mixed_inline_media_and_empty_blocks_preserve_content_without_collapse', async () => {
    const assetStore = new AssetStore();
    const pngBytes = png(1, 14, 10);
    const record = await assetStore.ingest(pngBytes, { fileName: 'inline.png' });

    // 【前置校验】：含空白块 <p></p> / <div></div> / <blockquote></blockquote> 的原始 HTML 在 X Verifier 中触发 content-loss
    const preCheckEmptyBlocks = verifyXArticleHtml(
      '<p></p><div>   </div><blockquote></blockquote><p>有效正文段落</p>'
    );
    expect(preCheckEmptyBlocks.isValid).toBe(false);
    expect(Object.keys(preCheckEmptyBlocks.inValidInfo)).toContain('content-loss');

    const markdown = [
      '<p></p>',
      '<div>   </div>',
      '<blockquote></blockquote>',
      '',
      `这是一段前置混排说明 ![段内插图](morph-asset://${record.id}) 以及紧随其后的尾随混排说明。`,
      '',
      `- 列表项首部文字 ![列表项内插图](morph-asset://${record.id}) 列表项中部文字 $a^2 + b^2 = c^2$ 列表项尾部文字`,
      '',
      '---',
      '',
      '<p>保留的有效结尾段落</p>',
    ].join('\n');

    const snapshot = await buildDeliverySnapshot(markdown, 'x-article', assetStore);

    try {
      const syncResult = verifyXArticleHtml(snapshot.html);
      const browserResult = await xSession.verifyHtml(snapshot.html);
      const { blocks, entityMap } = browserResult.draftState;
      const imageEntities = Object.values(entityMap).filter((e) => e.type === 'IMAGE');
      const dividerEntities = Object.values(entityMap).filter((e) => e.type === 'DIVIDER');
      const allBlockText = blocks.map((b) => b.text).join('\n');

      expect(snapshot.ready).toBe(true);
      // 1. 同步校验器与真实 Chromium 浏览器会话校验均 100% 通过（无 content-loss 空块坍塌或字符/图片丢失）
      expect(syncResult.isValid).toBe(true);
      expect(syncResult.inValidInfo).toEqual({});
      expect(browserResult.isValid).toBe(true);
      expect(browserResult.inValidInfo).toEqual({});
      // 2. 2 张本地插图 + 1 张光栅化行内公式 = 3 个 IMAGE 实体，1 个 DIVIDER 实体
      expect(imageEntities.length).toBe(3);
      expect(dividerEntities.length).toBe(1);
      // 3. 图文混排段落与列表项内的所有文字一字不差
      expect(allBlockText).toContain('这是一段前置混排说明');
      expect(allBlockText).toContain('以及紧随其后的尾随混排说明。');
      expect(allBlockText).toContain('列表项首部文字');
      expect(allBlockText).toContain('列表项中部文字');
      expect(allBlockText).toContain('列表项尾部文字');
      expect(allBlockText).toContain('保留的有效结尾段落');
    } finally {
      assetStore.clear();
    }
  });

  // =========================================================================
  // 维度 10：块级数学公式与矮表格防裁切画布尺寸（680px 栏宽 & 宽高比 <= 4.0:1）及代码语言别名高亮（Issue #7）
  // =========================================================================
  it('test_display_math_and_short_table_canvas_enforce_anti_crop_aspect_ratio_and_language_aliases', async () => {
    const assetStore = new AssetStore();
    const markdown = [
      '# 公式与表格防裁切及语言别名测试',
      '',
      '$$\\mathcal{S}_{\\text{fidelity}}(D) = \\frac{1}{|B|} \\sum_{b \\in B} \\mathbb{I}\\big(\\text{Render}_{\\text{target}}(b) \\cong \\text{Render}_{\\text{stage}}(b)\\big)$$',
      '',
      '| A | B |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '```ts',
      'const x: number = 1;',
      '```',
      '',
      '```js',
      'const y = 2;',
      '```',
      '',
      '```py',
      'def calc(): pass',
      '```',
    ].join('\n');

    const snapshot = await buildDeliverySnapshot(markdown, 'x-article', assetStore);

    try {
      expect(snapshot.ready).toBe(true);
      // 1. 验证 ts / js / py 语言别名代码块不触发 code/unknown-language 告警诊断
      const unknownLangDiags = snapshot.diagnostics.filter(
        (d) => d.code === 'code/unknown-language'
      );
      expect(unknownLangDiags).toEqual([]);

      // 2. 在真实浏览器 page.evaluate 中调用生成的块级公式与矮表格位图，验证物理宽度为 1360（2x 680px）且宽高比 width / height <= 4.0
      const rawCompiled = await compileMarkdown(markdown);
      const xNormalizerBundle = await viteBuild({
        configFile: false,
        logLevel: 'silent',
        build: {
          write: false,
          lib: {
            entry: 'src/core/x-article/normalizer.ts',
            name: 'MorphXNormalizer',
            formats: ['iife'],
          },
        },
      });
      const xNormalizerCode = (xNormalizerBundle as any)[0].output[0].code as string;

      const rasterResult = await page.evaluate(
        ({ rawHtml, bundleCode }) => {
          const scriptEl = document.createElement('script');
          scriptEl.textContent = bundleCode;
          document.head.appendChild(scriptEl);
          const container = document.createElement('div');
          container.innerHTML = rawHtml;
          const diags: unknown[] = [];
          (window as any).MorphXNormalizer.normalizeXArticleStructureAndStyles(container, diags);

          const mathImg = container.querySelector(
            'img[data-raster-type="math"][data-math-display="block"]'
          ) as HTMLImageElement | null;
          const tableImg = container.querySelector(
            'img[data-raster-type="table"]'
          ) as HTMLImageElement | null;

          return {
            mathSrc: mathImg?.getAttribute('src') || '',
            mathCssWidth: Number(mathImg?.getAttribute('width') || 0),
            mathCssHeight: Number(mathImg?.getAttribute('height') || 0),
            tableSrc: tableImg?.getAttribute('src') || '',
          };
        },
        { rawHtml: rawCompiled.html, bundleCode: xNormalizerCode }
      );

      expect(rasterResult.mathSrc).toMatch(/^data:image\/png;base64,/);
      expect(rasterResult.tableSrc).toMatch(/^data:image\/png;base64,/);
      expect(rasterResult.mathCssWidth).toBe(680);
      expect(rasterResult.mathCssHeight).toBeGreaterThanOrEqual(170);

      const decodedMath = await decodeBitmapDataUrl(page, rasterResult.mathSrc);
      expect(decodedMath.decoded).toBe(true);
      expect(decodedMath.width).toBe(1360);
      expect(decodedMath.height).toBeGreaterThanOrEqual(340);
      expect(decodedMath.width / decodedMath.height).toBeLessThanOrEqual(4.0);

      const decodedTable = await decodeBitmapDataUrl(page, rasterResult.tableSrc);
      expect(decodedTable.decoded).toBe(true);
      expect(decodedTable.width).toBe(1360);
      expect(decodedTable.height).toBeGreaterThanOrEqual(340);
      expect(decodedTable.width / decodedTable.height).toBeLessThanOrEqual(4.0);
    } finally {
      assetStore.clear();
    }
  });

  // =========================================================================
  // 维度 11：二级无序列表通过 <br>- 拍平至父级 <li>，消除首项粘连、空行与尾部换行并保留行内样式
  // =========================================================================
  it('test_nested_unordered_list_items_map_to_dash_prefix_while_preserving_top_level_items_and_inline_formatting', async () => {
    const assetStore = new AssetStore();
    const markdown = [
      '- **IP 地址：给每一台联网设备分配的门牌号**',
      '  - 第一类是**公网 IP**（如 `203.0.113.50`）',
      '  - 第二类是**局域网/内网 IP**（如 `192.168.x.x`）',
      '  - 第三类是**本地回环地址** `127.0.0.1`',
    ].join('\n');

    const snapshot = await buildDeliverySnapshot(markdown, 'x-article', assetStore);

    try {
      const verifyResult = await xSession.verifyHtml(snapshot.html);
      const { blocks } = verifyResult.draftState;

      expect(snapshot.ready).toBe(true);
      expect(verifyResult.isValid).toBe(true);
      expect(verifyResult.inValidInfo).toEqual({});

      // HTML 结构中无嵌套 <ul> 残留在 <li> 内，且使用 <br>- 连接子项
      expect(snapshot.html).not.toMatch(/<li[^>]*>[\s\S]*?<ul\b/i);
      expect(snapshot.html).toContain('<br>- ');

      const ulBlocks = blocks.filter((b) => b.type === 'unordered-list-item');
      expect(ulBlocks.length).toBe(1);

      const [ulItem] = ulBlocks;
      expect(ulItem!.depth).toBe(0);
      expect(ulItem!.text).toBe(
        [
          'IP 地址：给每一台联网设备分配的门牌号',
          '- 第一类是公网 IP（如 203.0.113.50）',
          '- 第二类是局域网/内网 IP（如 192.168.x.x）',
          '- 第三类是本地回环地址 127.0.0.1',
        ].join('\n')
      );
      expect(ulItem!.text).not.toContain('\n\n');
      expect(ulItem!.text.endsWith('\n')).toBe(false);

      const boldRanges = ulItem!.inlineStyleRanges.filter((r) => r.style === 'BOLD');
      const codeRanges = ulItem!.inlineStyleRanges.filter((r) => r.style === 'CODE');
      expect(boldRanges.length).toBe(4);
      expect(codeRanges.length).toBe(3);
      expect(
        boldRanges.map((r) => ulItem!.text.slice(r.offset, r.offset + r.length))
      ).toEqual([
        'IP 地址：给每一台联网设备分配的门牌号',
        '公网 IP',
        '局域网/内网 IP',
        '本地回环地址',
      ]);
      expect(
        codeRanges.map((r) => ulItem!.text.slice(r.offset, r.offset + r.length))
      ).toEqual(['203.0.113.50', '192.168.x.x', '127.0.0.1']);
    } finally {
      assetStore.clear();
    }
  });
});
