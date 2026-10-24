import { deflateSync } from 'node:zlib';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AssetStore,
  buildDeliverySnapshot,
} from '../src/index';
import {
  createWeChatVerificationSession,
  type WeChatVerificationSession,
} from './verifiers/wechat/index';

/**
 * 构造真实可解码的 PNG 二进制数据
 */
function createRealPngBytes(width = 800, height = 400): Uint8Array {
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
  header[8] = 8;
  header[9] = 2;

  const rows = Buffer.alloc((width * 3 + 1) * height);
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
 * 在真实 Chromium 浏览器中解码位图 Data URL 并返回天然像素尺寸
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

describe('TestWeChatPipeline', () => {
  let verifier: WeChatVerificationSession;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    verifier = await createWeChatVerificationSession();
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
  });

  afterAll(async () => {
    if (verifier) {
      await verifier.close();
    }
    if (browser) {
      await browser.close();
    }
  });

  // =========================================================================
  // 维度 1：受控样式内联、CSS 变量求值、伪元素实体化与代码块滚动保护
  // =========================================================================
  it('test_tokens_custom_css_and_pseudo_elements_inline_and_pass_official_verifier', async () => {
    const assetStore = new AssetStore();
    const markdown = [
      '# 公众号排版主标题',
      '',
      '## 核心章节副标题',
      '',
      '> [!NOTE] 排版提示',
      '> 微信公众号不支持外部样式表，所有样式必须内联到标签上。',
      '',
      '```typescript',
      'export const message = "这是一行非常长非常长的代码，用于在移动端窄屏下测试代码块是否自动加上了横向滚动保护";',
      '```',
      '',
      '| 屏幕宽度 | 校验标准 |',
      '| :--- | :--- |',
      '| 375px | 移动端窄屏不溢出 |',
      '| 677px | 公众号标准正文宽 |',
    ].join('\n');

    const snapshot = await buildDeliverySnapshot(markdown, 'wechat', assetStore, {
      tokens: {
        '--morph-accent': '#07c160',
      },
      customCss: `
        .morph-h1 {
          color: var(--morph-accent);
          border-bottom: 2px solid var(--morph-accent);
        }
        .morph-h2::before {
          content: "▍ ";
          color: var(--morph-accent);
        }
      `,
    });

    try {
      const verifyResult = await verifier.verifyHtml(snapshot.html);
      const rendered = await page.evaluate((html) => {
        const container = document.createElement('div');
        container.innerHTML = html;
        const h1 = container.querySelector('h1') as HTMLElement | null;
        const h2 = container.querySelector('h2') as HTMLElement | null;
        const h2Lead = h2?.firstElementChild as HTMLElement | null;
        return {
          h1Color: h1?.style.color || '',
          h1BorderBottom: h1?.style.borderBottom || '',
          h2Text: h2?.textContent || '',
          h2LeadText: h2Lead?.textContent || '',
          h2LeadColor: h2Lead?.style.color || '',
        };
      }, snapshot.html);

      expect(snapshot.ready).toBe(true);
      // 1. H1 的文字颜色与下边框颜色求值为 #07c160
      expect(rendered.h1Color).toMatch(/^(#07c160|rgb\(7,\s*193,\s*96\))$/i);
      expect(rendered.h1BorderBottom).toMatch(/2px\s+solid\s+(#07c160|rgb\(7,\s*193,\s*96\))/i);
      // 2. ::before 伪元素在外在 DOM 文本中呈现为前缀 "▍ " 且颜色求值生效（不依赖内部属性名）
      expect(rendered.h2Text).toBe('▍ 核心章节副标题');
      expect(rendered.h2LeadText).toBe('▍ ');
      expect(rendered.h2LeadColor).toMatch(/^(#07c160|rgb\(7,\s*193,\s*96\))$/i);
      // 3. 通过微信官方 verify-article-structure-spec 校验器（含 #1.8 pre 横向滚动与表格多屏宽度检测）
      expect(verifyResult).toEqual({ isValid: true, inValidInfo: {} });
      // 4. 最终内联 style 中不残留未解析的 var(--morph-*)
      expect(snapshot.html).not.toContain('var(--morph-');
    } finally {
      assetStore.clear();
    }
  });

  // =========================================================================
  // 维度 2：本地图片资产内联与微信防坍缩属性（#1.4 图片宽度检测 data-w / data-ratio）
  // =========================================================================
  it('test_local_image_injects_wechat_dimensions_and_passes_official_verifier', async () => {
    const assetStore = new AssetStore();
    const pngBytes = createRealPngBytes(800, 400);
    const record = await assetStore.ingest(pngBytes, { fileName: 'banner.png' });

    const markdown = `![公众号横幅图](morph-asset://${record.id})`;
    const snapshot = await buildDeliverySnapshot(markdown, 'wechat', assetStore);

    try {
      const verifyResult = await verifier.verifyHtml(snapshot.html);
      const imgMeta = await page.evaluate((html) => {
        const container = document.createElement('div');
        container.innerHTML = html;
        const img = container.querySelector('img');
        return img
          ? {
              src: img.getAttribute('src') || '',
              alt: img.getAttribute('alt') || '',
              dataW: img.getAttribute('data-w'),
              dataRatio: img.getAttribute('data-ratio'),
            }
          : null;
      }, snapshot.html);

      expect(snapshot.ready).toBe(true);
      expect(imgMeta).not.toBeNull();
      const decoded = await decodeBitmapDataUrl(page, imgMeta!.src);
      expect(decoded).toEqual({ decoded: true, width: 800, height: 400 });
      expect(imgMeta!.alt).toBe('公众号横幅图');
      expect(imgMeta!.dataW).toBe('800');
      expect(imgMeta!.dataRatio).toBe('0.5');
      expect(verifyResult).toEqual({ isValid: true, inValidInfo: {} });

      expect(snapshot.html).not.toContain('morph-asset://');
      expect(snapshot.html).not.toContain('blob:');
    } finally {
      assetStore.clear();
    }
  });

  // =========================================================================
  // 维度 3：官方 CSS 与布局违规属性自动拦截与净化（#1.1 ~ #1.8 全规则覆盖）
  // =========================================================================
  it('test_violating_css_properties_are_sanitized_to_pass_official_verifier', async () => {
    const assetStore = new AssetStore();
    const pngBytes = createRealPngBytes(300, 200);
    const record = await assetStore.ingest(pngBytes, { fileName: 'pic.png' });

    // 【前置校验】：先确认构造的原始违规片段在官方校验器中确实触发 #1.1 ~ #1.8 全部规则报警
    const rawViolatingHtml = [
      '<p><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" data-w="300" style="opacity: 0;" /></p>',
      '<div class="bad-box" style="caret-color: rgba(0, 0, 0, 0); line-height: 0; width: 586px; text-align: start;">这是第一行文字<br>这是第二行文字<br>这是第三行文字</div>',
      '<div class="bad-lh-small" style="font-size: 20px; line-height: 10px;">窄屏多行紧凑行高第一行文字用于触发Range重叠检测<br>窄屏多行紧凑行高第二行文字用于触发Range重叠检测</div>',
      '<section class="bad-margin" style="margin-left: 294pt; text-align: end;"><span>这段文字设置了超大左边距会导致手机端水平溢出</span></section>',
      '<section class="bad-height" style="height: 0px;"><span>这段文字由于父容器高度为0在移动端会完全消失</span></section>',
      '<section class="bad-height-overflow" style="height: 20px;"><div style="height: 120px;">这段内容高度远超父容器固定高度20px且无滚动条导致截断</div></section>',
      '<svg viewBox="0 0 100 40"><circle cx="20" cy="20" r="10"><animate attributeName="opacity" values="1;0;1" dur="1s" begin="touchstart"></animate></circle></svg>',
      '<pre style="line-height: 1.75em;">这是一段直接手写的超长pre标签内容没有设置overflowX滚动属性在375px窄屏下必然发生水平截断违规</pre>',
    ].join('\n');

    const preCheck = await verifier.verifyHtml(rawViolatingHtml);
    expect(preCheck.isValid).toBe(false);
    expect(Object.keys(preCheck.inValidInfo)).toEqual(
      expect.arrayContaining([
        'opacity',
        'caret-color',
        'line-height',
        'width',
        'height',
        'text-align',
        'animate-begin',
        'pre',
      ])
    );

    const preCheckHeightOverflow = await verifier.verifyHtml(
      '<section style="height: 20px;"><div style="height: 120px;">这段内容高度远超父容器固定高度20px且无滚动条导致截断</div></section>'
    );
    expect(preCheckHeightOverflow.isValid).toBe(false);
    expect(Object.keys(preCheckHeightOverflow.inValidInfo)).toContain('height-nodisplay');

    const preCheckAnimateTransform = await verifier.verifyHtml(
      '<p>动画<svg viewBox="0 0 100 40" width="80" height="40"><rect width="10" height="10"><animateTransform attributeName="transform" type="rotate" from="0" to="90" dur="1s" begin="touchstart"></animateTransform></rect></svg></p>'
    );
    expect(preCheckAnimateTransform.isValid).toBe(false);
    expect(Object.keys(preCheckAnimateTransform.inValidInfo)).toContain('animate-begin');

    const markdown = [
      `![透明违禁图](morph-asset://${record.id})`,
      '',
      '<div class="bad-box">这是第一行文字<br>这是第二行文字<br>这是第三行文字</div>',
      '',
      '<div class="bad-lh-small" style="font-size: 20px; line-height: 10px;">窄屏多行紧凑行高第一行文字用于触发Range重叠检测<br>窄屏多行紧凑行高第二行文字用于触发Range重叠检测</div>',
      '',
      '<section class="bad-margin"><span>这段文字设置了超大左边距会导致手机端水平溢出</span></section>',
      '',
      '<section class="bad-height"><span>这段文字由于父容器高度为0在移动端会完全消失</span></section>',
      '',
      '<section class="bad-height-overflow" style="height: 20px;"><div style="height: 120px;">这段内容高度远超父容器固定高度20px且无滚动条导致截断</div></section>',
      '',
      '<section class="good-scrollable-height" style="height: 60px; overflow: auto;"><div style="height: 120px;">带有overflow:auto简写的可滚动定高容器</div></section>',
      '',
      '<section class="good-pct-width" style="width: 80%;"><span>合规的80%百分比宽度容器</span></section>',
      '',
      '<section class="good-small-px-width" style="width: 240px;"><span>小于375px窄屏的240px宽度容器</span></section>',
      '',
      '<svg viewBox="0 0 100 40"><circle cx="20" cy="20" r="10"><animate attributeName="opacity" values="1;0;1" dur="1s" begin="touchstart"></animate></circle></svg>',
      '',
      '<pre style="line-height: 1.75em;">这是一段直接手写的超长pre标签内容没有设置overflowX滚动属性在375px窄屏下必然发生水平截断违规</pre>',
      '',
      '<table><thead><tr><th style="width: 200px;" data-colwidth="200">列1</th><th style="width: 400px;" data-colwidth="400">列2</th></tr></thead><tbody><tr><td>内容1</td><td>内容2</td></tr></tbody></table>',
      '',
      '<section data-ignore-width style="width: 520px;"><span>显式标记 data-ignore-width 的豁免容器</span></section>',
    ].join('\n');

    const snapshot = await buildDeliverySnapshot(markdown, 'wechat', assetStore, {
      customCss: `
        img {
          opacity: 0;
        }
        .bad-box {
          caret-color: rgba(0, 0, 0, 0);
          line-height: 0;
          width: 586px;
          text-align: start;
        }
        .bad-margin {
          margin-left: 294pt;
          text-align: end;
        }
        .bad-height {
          height: 0px;
        }
      `,
    });

    try {
      const verifyResult = await verifier.verifyHtml(snapshot.html);
      const inspect = await page.evaluate((html) => {
        const container = document.createElement('div');
        container.innerHTML = html;
        const badBox = container.querySelector('.bad-box') as HTMLElement | null;
        const badMargin = container.querySelector('.bad-margin') as HTMLElement | null;
        const ignoredWidthEl = container.querySelector('[data-ignore-width]') as HTMLElement | null;
        const goodScrollableEl = container.querySelector('.good-scrollable-height') as HTMLElement | null;
        const goodPctWidthEl = container.querySelector('.good-pct-width') as HTMLElement | null;
        const goodSmallPxWidthEl = container.querySelector('.good-small-px-width') as HTMLElement | null;
        return {
          text: container.textContent || '',
          badBoxAlign: badBox?.style.textAlign || '',
          badMarginAlign: badMargin?.style.textAlign || '',
          ignoredWidth: ignoredWidthEl?.style.width || '',
          goodScrollableHeight: goodScrollableEl?.style.height || '',
          goodPctWidth: goodPctWidthEl?.style.width || '',
          goodSmallPxWidth: goodSmallPxWidthEl?.style.width || '',
        };
      }, snapshot.html);

      expect(snapshot.ready).toBe(true);
      // 1. 全部正文语义完整保留
      expect(inspect.text).toContain('这是第一行文字');
      expect(inspect.text).toContain('窄屏多行紧凑行高第一行文字');
      expect(inspect.text).toContain('这段文字设置了超大左边距会导致手机端水平溢出');
      expect(inspect.text).toContain('这段文字由于父容器高度为0在移动端会完全消失');
      expect(inspect.text).toContain('这段内容高度远超父容器固定高度20px且无滚动条导致截断');
      expect(inspect.text).toContain('这是一段直接手写的超长pre标签内容');
      // 2. text-align: start/end 被归一化为跨端兼容的 left/right，且合规百分比/<375px宽度、overflow:auto简写高度与 data-ignore-width 豁免宽度均保留
      expect(inspect.badBoxAlign).toBe('left');
      expect(inspect.badMarginAlign).toBe('right');
      expect(inspect.ignoredWidth).toBe('520px');
      expect(inspect.goodScrollableHeight).toBe('60px');
      expect(inspect.goodPctWidth).toBe('80%');
      expect(inspect.goodSmallPxWidth).toBe('240px');
      // 3. 100% 通过官方多屏沙箱与 Range API 行高重叠校验（以官方 Verifier 为唯一合规判准，不锁死内部属性删除方式）
      expect(verifyResult).toEqual({ isValid: true, inValidInfo: {} });
    } finally {
      assetStore.clear();
    }
  });

  // =========================================================================
  // 维度 4：官方文章结构规范净化（#2.1 15层嵌套、#2.2 span[leaf]、#2.3 section[nodeleaf]）
  // =========================================================================
  it('test_excessive_nesting_and_illegal_leaf_containers_normalize_cleanly', async () => {
    const assetStore = new AssetStore();
    const deepOpen = '<section>'.repeat(18);
    const deepClose = '</section>'.repeat(18);
    const rawDeepNesting = `${deepOpen}<span>深层嵌套中的核心正文</span>${deepClose}`;

    // 【前置校验】：先确认 18 层冗余 <section> 嵌套在官方校验器中确实触发 nestNodes 违规
    const preCheck = await verifier.verifyHtml(rawDeepNesting);
    expect(preCheck.isValid).toBe(false);
    expect(preCheck.inValidInfo.nestNodes?.items.length).toBeGreaterThan(0);

    const markdown = [
      rawDeepNesting,
      '',
      '<div><span leaf=""><section>不能放在 span[leaf] 里的块级内容</section></span></div>',
      '',
      '<section nodeleaf=""><p>不能放在 section[nodeleaf] 里的块级段落</p></section>',
    ].join('\n');

    const snapshot = await buildDeliverySnapshot(markdown, 'wechat', assetStore);

    try {
      const verifyResult = await verifier.verifyHtml(snapshot.html);
      const inspect = await page.evaluate((html) => {
        const container = document.createElement('div');
        container.innerHTML = html;
        return {
          text: container.textContent || '',
          illegalLeafCount: container.querySelectorAll('span[leaf] section, section[nodeleaf] p').length,
        };
      }, snapshot.html);

      expect(snapshot.ready).toBe(true);
      // 1. 文字内容完整保留
      expect(inspect.text).toContain('深层嵌套中的核心正文');
      expect(inspect.text).toContain('不能放在 span[leaf] 里的块级内容');
      expect(inspect.text).toContain('不能放在 section[nodeleaf] 里的块级段落');
      // 2. 通过官方校验器（消除 #2.1 nestNodes 冗余 15 层嵌套违规）
      expect(verifyResult).toEqual({ isValid: true, inValidInfo: {} });
      // 3. 消除 #2.2 span[leaf] 与 #2.3 section[nodeleaf] 非法包裹块级元素结构（官方仓库未在 collect.ts 接线此两项，通过 DOM 契约验证）
      expect(inspect.illegalLeafCount).toBe(0);
    } finally {
      assetStore.clear();
    }
  });

  // =========================================================================
  // 维度 5：官方 Dark Mode 深色模式合规净化（#4.1.1 低对比度、#4.1.2 文字渐变背景、#4.5.1 data-no-dark、#4.6 data-ignore-dm）
  // =========================================================================
  it('test_dark_mode_low_contrast_and_text_gradient_sanitize_while_respecting_ignore_dm', async () => {
    const rawLowContrast =
      '<div class="dm-low-contrast" style="background-color: rgb(194, 43, 76); color: rgba(194, 43, 76, 0.2);">文本与背景对比度过低</div>';
    const rawGradient =
      '<div class="dm-gradient" style="background: linear-gradient(rgb(248, 245, 247), rgb(194, 43, 76)); color: yellow;">文字背景使用了线性渐变</div>';
    const rawWhitelist = '<ul data-no-dark=""><li>带有白名单属性的列表项</li></ul>';

    // 【前置校验】：先确认这三组原始输入在官方校验器中确实触发对应违规
    const preCheck = await verifier.verifyHtml([rawLowContrast, rawGradient, rawWhitelist].join('\n'));
    expect(preCheck.isValid).toBe(false);
    expect(Object.keys(preCheck.inValidInfo)).toEqual(
      expect.arrayContaining(['darkmode-low-contrast', 'darkmode-no-gradient', 'darkmode-whitelist'])
    );

    const assetStore = new AssetStore();
    const markdown = [
      rawLowContrast,
      '',
      rawGradient,
      '',
      rawWhitelist,
      '',
      '<div class="dm-pure-bg" style="background: linear-gradient(rgb(248, 245, 247), rgb(194, 43, 76));"><br></div>',
      '',
      '<div class="dm-exempt" data-ignore-dm="low-contrast text-bg-gradient" style="background: linear-gradient(rgb(248, 245, 247), rgb(194, 43, 76)); background-color: rgb(194, 43, 76); color: rgba(194, 43, 76, 0.2);">显式豁免深色模式检测的节点</div>',
    ].join('\n');

    const snapshot = await buildDeliverySnapshot(markdown, 'wechat', assetStore);

    try {
      const verifyResult = await verifier.verifyHtml(snapshot.html);
      const inspect = await page.evaluate((html) => {
        const container = document.createElement('div');
        container.innerHTML = html;
        const lowContrastEl = container.querySelector('.dm-low-contrast') as HTMLElement | null;
        const gradientEl = container.querySelector('.dm-gradient') as HTMLElement | null;
        const pureBgEl = container.querySelector('.dm-pure-bg') as HTMLElement | null;
        const exemptEl = container.querySelector('.dm-exempt') as HTMLElement | null;
        return {
          text: container.textContent || '',
          pureBgStyle: pureBgEl?.getAttribute('style') || '',
          exemptStyle: exemptEl?.getAttribute('style') || '',
          lowContrastHasIgnoreDm: lowContrastEl?.hasAttribute('data-ignore-dm') || false,
          gradientHasIgnoreDm: gradientEl?.hasAttribute('data-ignore-dm') || false,
        };
      }, snapshot.html);

      expect(snapshot.ready).toBe(true);
      // 1. 正文内容完整保留，且未通过注入伪造的 data-ignore-dm 属性逃避校验
      expect(inspect.text).toContain('文本与背景对比度过低');
      expect(inspect.text).toContain('文字背景使用了线性渐变');
      expect(inspect.text).toContain('带有白名单属性的列表项');
      expect(inspect.lowContrastHasIgnoreDm).toBe(false);
      expect(inspect.gradientHasIgnoreDm).toBe(false);
      // 2. 显式标记 data-ignore-dm 的节点、以及 #4.1.3 无文字纯背景节点，保留其渐变背景
      expect(inspect.exemptStyle).toContain('linear-gradient');
      expect(inspect.pureBgStyle).toContain('linear-gradient');
      // 3. 100% 通过官方 mp-darkmode 深色模式校验（消除低对比度、文字渐变与白名单属性违规）
      expect(verifyResult).toEqual({ isValid: true, inValidInfo: {} });
    } finally {
      assetStore.clear();
    }
  });
});
