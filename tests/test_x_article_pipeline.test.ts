import { deflateSync } from 'node:zlib';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AssetStore,
  buildDeliverySnapshot,
} from '../src/index';
import { verifyXArticleHtml } from './verifiers/x-article/index';

/**
 * 构造真实可解码的最小 PNG 二进制数据（含合法 IHDR / IDAT / IEND 与 CRC 校验）
 */
function createRealPngBytes(width = 4, height = 3): Uint8Array {
  function chunk(type: string, data: Buffer): Buffer {
    const payload = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of payload) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
    }
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, payload, checksum]);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // color type RGB

  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 1; x <= width * 3; x++) {
      rows[y * (width * 3 + 1) + x] = (x * 17 + y * 31) % 256;
    }
  }

  return new Uint8Array(
    Buffer.concat([
      Buffer.from('89504e470d0a1a0a', 'hex'),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(rows)),
      chunk('IEND', Buffer.alloc(0)),
    ])
  );
}

/**
 * 在真实 Chromium 浏览器中解码 PNG/WebP Data URL 并返回天然像素尺寸
 */
async function decodeBitmapDataUrl(
  page: Page,
  src: string
): Promise<{ decoded: boolean; width: number; height: number }> {
  if (!/^data:image\/(png|webp);base64,[A-Za-z0-9+/=]+$/i.test(src)) {
    return { decoded: false, width: 0, height: 0 };
  }
  return await page.evaluate(async (dataUrl) => {
    const img = new Image();
    img.src = dataUrl;
    try {
      await img.decode();
      return {
        decoded: img.naturalWidth > 0 && img.naturalHeight > 0,
        width: img.naturalWidth,
        height: img.naturalHeight,
      };
    } catch {
      return { decoded: false, width: 0, height: 0 };
    }
  }, src);
}

describe('TestXArticlePipeline', () => {
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

  // =========================================================================
  // 维度 1：本地图片资产 —— 零图床依赖并映射为 Draft.js IMAGE 实体
  // =========================================================================
  it('test_local_image_without_remote_host_resolves_to_ready_image_node', async () => {
    const assetStore = new AssetStore();
    const pngBytes = createRealPngBytes(12, 8);
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
      const verifyResult = verifyXArticleHtml(snapshot.html);
      const imageEntities = Object.values(verifyResult.draftState.entityMap).filter(
        (entity) => entity.type === 'IMAGE'
      );

      expect(snapshot.ready).toBe(true);
      expect(snapshot.diagnostics.some((d) => d.severity === 'error')).toBe(false);
      // 1. 100% 通过 X 结构与协议校验器
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
  // 维度 2：表格、数学公式、SVG —— 统一转成真 PNG/WebP 位图实体
  // =========================================================================
  it('test_table_math_and_svg_blocks_convert_to_bitmap_image_nodes', async () => {
    const assetStore = new AssetStore();

    // 【前置校验】：裸 <table>、公式节点、裸 <svg> 及伪造的 data:image/svg+xml 均被 Verifier 拦截
    const rawNonCompliant = [
      '<table><tr><td>原生表格</td></tr></table>',
      '<math><mi>x</mi></math>',
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

    const markdown = [
      '## 复杂块转位图测试',
      '',
      '| 目标平台 | 行内样式 |',
      '| :--- | :--- |',
      '| 微信公众号 | 保留 |',
      '| X Articles | 剥离 |',
      '',
      '质能方程 $E = mc^2$ 是行内公式。',
      '',
      '$$',
      '\\int_0^1 x^2 dx = \\frac{1}{3}',
      '$$',
      '',
      '<svg width="100" height="40" aria-label="架构矢量图"><rect width="100" height="40" fill="#0969da"/></svg>',
    ].join('\n');

    const snapshot = await buildDeliverySnapshot(markdown, 'x-article', assetStore);

    try {
      const verifyResult = verifyXArticleHtml(snapshot.html);
      const imageEntities = Object.values(verifyResult.draftState.entityMap).filter(
        (entity) => entity.type === 'IMAGE'
      );

      expect(snapshot.ready).toBe(true);
      // 1. 通过 X 结构校验器（确保无未光栅化表格/公式/SVG，且无 data:image/svg+xml 伪位图）
      expect(verifyResult.isValid).toBe(true);
      expect(verifyResult.inValidInfo).toEqual({});
      // 2. 表格(1) + 行内公式(1) + 块级公式(1) + SVG(1) = 4 个 IMAGE 实体
      expect(imageEntities.length).toBe(4);
      for (const entity of imageEntities) {
        const decoded = await decodeBitmapDataUrl(page, String(entity.data.src || ''));
        expect(decoded.decoded).toBe(true);
        expect(decoded.width).toBeGreaterThan(0);
        expect(decoded.height).toBeGreaterThan(0);
      }
      // 3. 核对 IMAGE 实体 alt 语义与 Draft.js 段落中的行内公式上下文正文
      expect(String(imageEntities[0].data.alt || '')).toContain('微信公众号');
      expect(String(imageEntities[0].data.alt || '')).toContain('X Articles');
      expect(String(imageEntities[1].data.alt || '')).toContain('E = mc^2');
      expect(String(imageEntities[2].data.alt || '')).toContain('\\int_0^1 x^2 dx');
      expect(imageEntities[3].data.alt).toBe('架构矢量图');
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
  // 维度 3：标题层级降级（X 只支持 header-one 与 header-two）
  // =========================================================================
  it('test_headings_h1_to_h6_downgrade_deep_levels_to_h2', async () => {
    const assetStore = new AssetStore();

    // 【前置校验】：未降级的 h3~h6 在 X Verifier 中触发 heading-level 违规，且在 Draft.js 中退化为 unstyled
    const preCheck = verifyXArticleHtml('<h3>未降级的三级标题</h3>');
    expect(preCheck.isValid).toBe(false);
    expect(Object.keys(preCheck.inValidInfo)).toContain('heading-level');
    expect(preCheck.draftState.blocks[0].type).toBe('unstyled');

    const markdown = [
      '# 一级主标题',
      '## 二级副标题',
      '### 三级小节标题',
      '#### 四级小节标题',
      '##### 五级小节标题',
      '###### 六级小节标题',
    ].join('\n');

    const snapshot = await buildDeliverySnapshot(markdown, 'x-article', assetStore);

    try {
      const verifyResult = verifyXArticleHtml(snapshot.html);

      expect(snapshot.ready).toBe(true);
      expect(verifyResult.isValid).toBe(true);
      expect(verifyResult.inValidInfo).toEqual({});
      // 通过 Draft.js 仿真块序列验证 H1 映射为 header-one，H2~H6 全部映射为 header-two 且标题文本一字不差
      expect(
        verifyResult.draftState.blocks.map((b) => ({ type: b.type, text: b.text }))
      ).toEqual([
        { type: 'header-one', text: '一级主标题' },
        { type: 'header-two', text: '二级副标题' },
        { type: 'header-two', text: '三级小节标题' },
        { type: 'header-two', text: '四级小节标题' },
        { type: 'header-two', text: '五级小节标题' },
        { type: 'header-two', text: '六级小节标题' },
      ]);
      expect(snapshot.diagnostics.length).toBeGreaterThan(0);
    } finally {
      assetStore.clear();
    }
  });

  // =========================================================================
  // 维度 4：提示框（Callout）转原生引用块与加粗标题
  // =========================================================================
  it('test_callout_container_converts_to_native_blockquote', async () => {
    const assetStore = new AssetStore();

    // 【前置校验】：未转换的 Callout 容器在 X Verifier 中触发 callout-structure 违规
    const preCheck = verifyXArticleHtml('<div class="morph-callout"><p>未降级提示框</p></div>');
    expect(preCheck.isValid).toBe(false);
    expect(Object.keys(preCheck.inValidInfo)).toContain('callout-structure');

    const markdown = [
      '> [!WARNING] 部署警告',
      '> 请勿在周五下午执行发版操作。',
    ].join('\n');

    const snapshot = await buildDeliverySnapshot(markdown, 'x-article', assetStore);

    try {
      const verifyResult = verifyXArticleHtml(snapshot.html);
      const { blocks } = verifyResult.draftState;

      expect(snapshot.ready).toBe(true);
      expect(verifyResult.isValid).toBe(true);
      expect(verifyResult.inValidInfo).toEqual({});
      // 1. 所有生成的 Draft.js 块均为 blockquote 类型
      expect(blocks.length).toBeGreaterThan(0);
      expect(blocks.every((b) => b.type === 'blockquote')).toBe(true);
      // 2. 标题块文本为 "部署警告" 且携带 BOLD 行内样式，正文块完整保留且不含 "[!WARNING]" 原始标记
      const titleBlock = blocks.find((b) => b.text.includes('部署警告'));
      expect(titleBlock).toBeDefined();
      expect(
        titleBlock!.inlineStyleRanges.some((r) => r.style === 'BOLD' && r.length >= '部署警告'.length)
      ).toBe(true);
      const fullText = blocks.map((b) => b.text).join('\n');
      expect(fullText).toContain('请勿在周五下午执行发版操作。');
      expect(fullText).not.toContain('[!WARNING]');
    } finally {
      assetStore.clear();
    }
  });

  // =========================================================================
  // 维度 5：样式剥离与守卫、列表嵌套、代码块、分割线及行内修饰映射
  // =========================================================================
  it('test_custom_tokens_and_css_strip_inline_styles_with_diagnostics', async () => {
    const assetStore = new AssetStore();

    // 【前置校验】：残留内联 style 的原生节点在 X Verifier 中触发 native-inline-style 违规（含 allowCodeBlockStyles: false）
    const preCheck = verifyXArticleHtml(
      '<h1 style="color: #ff0055">带内联样式的标题</h1><pre style="background: #000"><code>const a = 1;</code></pre>',
      { allowCodeBlockStyles: false }
    );
    expect(preCheck.isValid).toBe(false);
    expect(preCheck.inValidInfo['native-inline-style']?.items.length).toBe(2);

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
        h1, .morph-h1 { color: #ff0055; font-size: 32px; }
        p, .morph-p { color: #333333; background-color: #ffffaa; }
      `,
    });

    try {
      const verifyResult = verifyXArticleHtml(snapshot.html);
      const { blocks, entityMap } = verifyResult.draftState;

      expect(snapshot.ready).toBe(true);
      // 1. 诊断列表报告平台不支持自定义样式的告警
      expect(snapshot.diagnostics.some((d) => d.severity === 'warning')).toBe(true);
      // 2. 通过 X 结构与 #3.1 native-inline-style 校验
      expect(verifyResult.isValid).toBe(true);
      expect(verifyResult.inValidInfo).toEqual({});
      // 3. 验证 Draft.js 块类型、列表嵌套 depth、行内样式 (BOLD/ITALIC/STRIKETHROUGH/CODE) 及 LINK / DIVIDER 实体
      expect(blocks.find((b) => b.type === 'header-one')?.text).toBe('样式守卫标题');
      const richParagraph = blocks.find((b) => b.text.includes('重点加粗'));
      expect(richParagraph).toBeDefined();
      const richStyles = new Set(richParagraph!.inlineStyleRanges.map((r) => r.style));
      expect(richStyles).toEqual(new Set(['BOLD', 'ITALIC', 'STRIKETHROUGH', 'CODE']));

      const nestedUlItem = blocks.find((b) => b.text === '无序嵌套子项');
      expect(nestedUlItem?.type).toBe('unordered-list-item');
      expect(nestedUlItem?.depth).toBe(1);

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
  // 维度 6：脏标签清理、孤立列表项修复与安全底线
  // =========================================================================
  it('test_unsafe_html_and_unsupported_containers_sanitize_cleanly', async () => {
    const assetStore = new AssetStore();

    // 【前置校验】：非法容器、孤立 <li>、内联事件属性 onclick 与 javascript: 链接均被 X Verifier 拦截
    const rawDirtyHtml = [
      '<section><article><p onclick="window.__pwned_click = true">安全的正文段落</p></article></section>',
      '<li>孤立的列表项</li>',
      '<script>window.__pwned = true;</script>',
      '<p><a href="javascript:alert(1)">恶意链接</a></p>',
    ].join('\n');
    const preCheck = verifyXArticleHtml(rawDirtyHtml);
    expect(preCheck.isValid).toBe(false);
    expect(Object.keys(preCheck.inValidInfo)).toEqual(
      expect.arrayContaining(['unsupported-element', 'unsafe-media-or-link'])
    );

    const markdown = [
      '<section><article><p onclick="window.__pwned_click = true">安全的正文段落</p></article></section>',
      '',
      '<li>孤立的列表项</li>',
      '',
      '<script>window.__pwned = true;</script>',
      '',
      '[恶意链接](javascript:alert(1)) 与 [安全链接](https://example.com/docs)',
    ].join('\n');

    const snapshot = await buildDeliverySnapshot(markdown, 'x-article', assetStore);

    try {
      const verifyResult = verifyXArticleHtml(snapshot.html);
      const { blocks, entityMap } = verifyResult.draftState;
      const allBlockText = blocks.map((b) => b.text).join('\n');
      const linkUrls = Object.values(entityMap)
        .filter((e) => e.type === 'LINK')
        .map((e) => String(e.data.url || ''));

      expect(snapshot.ready).toBe(true);
      // 1. 安全拦截产生 error 级诊断，且净化后产物 100% 通过 X Verifier（无非法标签、无孤立 li、无 onclick、无危险链接）
      expect(snapshot.diagnostics.some((d) => d.severity === 'error')).toBe(true);
      expect(verifyResult.isValid).toBe(true);
      expect(verifyResult.inValidInfo).toEqual({});
      // 2. 正文、被自动包裹为合法列表项的 "孤立的列表项" 与安全链接在 Draft.js 状态中完整保留
      expect(allBlockText).toContain('安全的正文段落');
      expect(
        blocks.some(
          (b) =>
            (b.type === 'unordered-list-item' || b.type === 'ordered-list-item') &&
            b.text === '孤立的列表项'
        )
      ).toBe(true);
      expect(linkUrls).toContain('https://example.com/docs');
      // 3. 恶意脚本内容与危险协议完全清除
      expect(allBlockText).not.toContain('window.__pwned');
      expect(linkUrls.some((u) => u.toLowerCase().startsWith('javascript:'))).toBe(false);
      expect(snapshot.html.toLowerCase()).not.toContain('javascript:');
    } finally {
      assetStore.clear();
    }
  });
});
