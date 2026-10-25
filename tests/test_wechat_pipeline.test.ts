import { deflateSync } from 'node:zlib';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AssetStore,
  buildDeliverySnapshot,
} from '../src/index';
import {
  createWeChatVerificationSession,
  propertyRules,
  type WeChatVerificationSession,
} from './verifiers/wechat/index';
import { isEmptyParagraph } from './verifiers/wechat/verify-engine/dom';
import { getCleanOuterHTML } from './verifiers/wechat/verify-engine/layout';
import {
  checkFontFamilyViolation,
  getInlineStyleValue,
  isTransparentRgba,
  type PropertyMaps,
  type RuleCandidate,
  type RuleContext,
} from './verifiers/wechat/verify-engine/rules/index';

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

/**
 * 使用官方 #3 font-family 规则检查器扫描 HTML 片段中的非白名单字体违规
 */
async function collectFontFamilyViolations(page: Page, html: string): Promise<RuleCandidate[]> {
  const elements = await page.evaluate((rawHtml) => {
    const container = document.createElement('div');
    container.innerHTML = rawHtml;
    return Array.from(container.querySelectorAll('*')).map((el, idx) => ({
      tagName: el.tagName.toLowerCase(),
      style: el.getAttribute('style'),
      outerHTML: el.outerHTML,
      idx,
    }));
  }, html);

  const ctx: RuleContext = {
    getInlineStyleValue,
    isTransparentRgba,
    isEmptyParagraph,
    getCleanOuterHTML,
    propertyRules,
    ensureViolationId: (_node, pIdx) => `font-violation-${pIdx}`,
  };
  const dummyMaps: PropertyMaps = {};
  const violations: RuleCandidate[] = [];

  for (const item of elements) {
    const fakeNode = {
      tagName: item.tagName,
      outerHTML: item.outerHTML,
      getAttribute(name: string) {
        return name === 'style' ? item.style : null;
      },
      setAttribute() {},
    };
    const hit = checkFontFamilyViolation(fakeNode, item.idx, dummyMaps, item.tagName, ctx);
    if (hit) {
      violations.push(hit);
    }
  }
  return violations;
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
      '<p><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" data-w="300" style="opacity: 0;" /><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" data-w="300" style="opacity: 0.0;" /></p>',
      '<div class="bad-box" style="caret-color: rgba(0, 0, 0, 0); line-height: 0; width: 586px; text-align: start;">这是第一行文字<br>这是第二行文字<br>这是第三行文字</div>',
      '<div class="bad-caret-transparent" style="caret-color: transparent;">透明光标关键词段落</div>',
      '<div class="bad-lh-small" style="font-size: 20px; line-height: 10px;">窄屏多行紧凑行高第一行文字用于触发Range重叠检测<br>窄屏多行紧凑行高第二行文字用于触发Range重叠检测</div>',
      '<div class="bad-lh-pct" style="font-size: 20px; line-height: 50%;">百分比紧凑行高第一行文字用于触发Range重叠检测<br>百分比紧凑行高第二行文字用于触发Range重叠检测</div>',
      '<div class="bad-lh-em" style="font-size: 20px; line-height: 0.5em;">em单位紧凑行高第一行文字用于触发Range重叠检测<br>em单位紧凑行高第二行文字用于触发Range重叠检测</div>',
      '<div class="bad-center-width" style="width: 420px; margin: 0 auto;">固定宽度配合margin自动居中容器</div>',
      '<div class="bad-center-offset" style="width: 345px; margin-left: 120px;">跨屏居中状态不一致的偏移定宽容器</div>',
      '<div class="bad-diff-width" style="width: 620px;">跨屏宽度与比例差异过大的定宽容器</div>',
      '<section class="bad-margin" style="margin-left: 294pt; margin-right: -40px; text-align: end;"><span>这段文字设置了超大左边距与负右边距会导致手机端水平溢出</span></section>',
      '<section class="bad-height" style="height: 0px;"><span>这段文字由于父容器高度为0在移动端会完全消失</span></section>',
      '<section class="bad-height-overflow" style="height: 20px;"><div style="height: 120px;">这段内容高度远超父容器固定高度20px且无滚动条导致截断</div></section>',
      '<svg viewBox="0 0 100 40"><circle cx="20" cy="20" r="10"><animate attributeName="opacity" values="1;0;1" dur="1s" begin="touchstart"></animate><animateTransform attributeName="transform" type="rotate" from="0" to="90" dur="1s" begin="touchstart"></animateTransform><animateMotion path="M 0 0 L 10 10" dur="1s" begin="touchstart"></animateMotion></circle></svg>',
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

    const preCheckAnimateMotion = await verifier.verifyHtml(
      '<p>动画<svg viewBox="0 0 100 40" width="80" height="40"><circle cx="10" cy="10" r="5"><animateMotion path="M 0 0 L 20 20" dur="1s" begin="touchstart"></animateMotion></circle></svg></p>'
    );
    expect(preCheckAnimateMotion.isValid).toBe(false);
    expect(Object.keys(preCheckAnimateMotion.inValidInfo)).toContain('animate-begin');

    const markdown = [
      `![透明违禁图](morph-asset://${record.id})`,
      '',
      `<img class="inline-zero-opacity" src="morph-asset://${record.id}" alt="浮点零透明图" style="opacity: 0.0;" />`,
      '',
      '<div class="bad-box">这是第一行文字<br>这是第二行文字<br>这是第三行文字</div>',
      '',
      '<div class="bad-caret-transparent" style="caret-color: transparent;">透明光标关键词段落</div>',
      '',
      '<div class="bad-lh-small" style="font-size: 20px; line-height: 10px;">窄屏多行紧凑行高第一行文字用于触发Range重叠检测<br>窄屏多行紧凑行高第二行文字用于触发Range重叠检测</div>',
      '',
      '<div class="bad-lh-pct" style="font-size: 20px; line-height: 50%;">百分比紧凑行高第一行文字用于触发Range重叠检测<br>百分比紧凑行高第二行文字用于触发Range重叠检测</div>',
      '',
      '<div class="bad-lh-em" style="font-size: 20px; line-height: 0.5em;">em单位紧凑行高第一行文字用于触发Range重叠检测<br>em单位紧凑行高第二行文字用于触发Range重叠检测</div>',
      '',
      '<div class="bad-center-width" style="width: 420px; margin: 0 auto;">固定宽度配合margin自动居中容器</div>',
      '',
      '<div class="bad-center-offset" style="width: 345px; margin-left: 120px;">跨屏居中状态不一致的偏移定宽容器</div>',
      '',
      '<div class="bad-diff-width" style="width: 620px;">跨屏宽度与比例差异过大的定宽容器</div>',
      '',
      '<section class="bad-margin"><span>这段文字设置了超大左边距与负右边距会导致手机端水平溢出</span></section>',
      '',
      '<section class="bad-height"><span>这段文字由于父容器高度为0在移动端会完全消失</span></section>',
      '',
      '<section class="bad-height-overflow" style="height: 20px;"><div style="height: 120px;">这段内容高度远超父容器固定高度20px且无滚动条导致截断</div></section>',
      '',
      '<section class="good-scrollable-height" style="height: 60px; overflow: auto;"><div style="height: 120px;">带有overflow:auto简写的可滚动定高容器</div></section>',
      '',
      '<section class="good-scroll-y-height" style="height: 70px; overflow-y: scroll;"><div style="height: 140px;">带有overflow-y:scroll的可滚动定高容器</div></section>',
      '',
      '<section class="good-pct-width" style="width: 80%;"><span>合规的80%百分比宽度容器</span></section>',
      '',
      '<section class="good-small-px-width" style="width: 240px;"><span>小于375px窄屏的240px宽度容器</span></section>',
      '',
      '<svg viewBox="0 0 100 40"><circle cx="20" cy="20" r="10"><animate attributeName="opacity" values="1;0;1" dur="1s" begin="touchstart"></animate><animateTransform attributeName="transform" type="rotate" from="0" to="90" dur="1s" begin="touchstart"></animateTransform><animateMotion path="M 0 0 L 10 10" dur="1s" begin="touchstart"></animateMotion></circle></svg>',
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
          margin-right: -40px;
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
        const imgs = Array.from(container.querySelectorAll('img'));
        const badBox = container.querySelector('.bad-box') as HTMLElement | null;
        const badCaretTransparent = container.querySelector('.bad-caret-transparent') as HTMLElement | null;
        const badMargin = container.querySelector('.bad-margin') as HTMLElement | null;
        const ignoredWidthEl = container.querySelector('[data-ignore-width]') as HTMLElement | null;
        const goodScrollableEl = container.querySelector('.good-scrollable-height') as HTMLElement | null;
        const goodScrollYEl = container.querySelector('.good-scroll-y-height') as HTMLElement | null;
        const goodPctWidthEl = container.querySelector('.good-pct-width') as HTMLElement | null;
        const goodSmallPxWidthEl = container.querySelector('.good-small-px-width') as HTMLElement | null;
        const animElements = Array.from(
          container.querySelectorAll('animate, animateTransform, animateMotion')
        );
        return {
          text: container.textContent || '',
          imgs: imgs.map((img) => ({
            src: img.getAttribute('src') || '',
            alt: img.getAttribute('alt') || '',
            opacity: img.style.opacity || '',
          })),
          badBoxAlign: badBox?.style.textAlign || '',
          badBoxCaret: badBox?.style.caretColor || '',
          badCaretTransparentVal: badCaretTransparent?.style.caretColor || '',
          badMarginAlign: badMargin?.style.textAlign || '',
          ignoredWidth: ignoredWidthEl?.style.width || '',
          goodScrollableHeight: goodScrollableEl?.style.height || '',
          goodScrollYHeight: goodScrollYEl?.style.height || '',
          goodPctWidth: goodPctWidthEl?.style.width || '',
          goodSmallPxWidth: goodSmallPxWidthEl?.style.width || '',
          animBegins: animElements.map((el) => el.getAttribute('begin') || ''),
        };
      }, snapshot.html);

      expect(snapshot.ready).toBe(true);
      // 1. 全部正文语义与图片替代文本完整保留，图片恢复可见且可解码
      expect(inspect.text).toContain('这是第一行文字');
      expect(inspect.text).toContain('透明光标关键词段落');
      expect(inspect.text).toContain('窄屏多行紧凑行高第一行文字');
      expect(inspect.text).toContain('百分比紧凑行高第一行文字');
      expect(inspect.text).toContain('em单位紧凑行高第一行文字');
      expect(inspect.text).toContain('固定宽度配合margin自动居中容器');
      expect(inspect.text).toContain('跨屏居中状态不一致的偏移定宽容器');
      expect(inspect.text).toContain('跨屏宽度与比例差异过大的定宽容器');
      expect(inspect.text).toContain('这段文字设置了超大左边距与负右边距会导致手机端水平溢出');
      expect(inspect.text).toContain('这段文字由于父容器高度为0在移动端会完全消失');
      expect(inspect.text).toContain('这段内容高度远超父容器固定高度20px且无滚动条导致截断');
      expect(inspect.text).toContain('这是一段直接手写的超长pre标签内容');
      expect(inspect.imgs.length).toBe(2);
      expect(inspect.imgs.map((i) => i.alt)).toEqual(['透明违禁图', '浮点零透明图']);
      for (const imgInfo of inspect.imgs) {
        expect(imgInfo.opacity).not.toBe('0');
        expect(imgInfo.opacity).not.toBe('0.0');
        const decoded = await decodeBitmapDataUrl(page, imgInfo.src);
        expect(decoded).toEqual({ decoded: true, width: 300, height: 200 });
      }
      // 2. caret-color: transparent 与 rgba(0,0,0,0) 被净化，text-align: start/end 被归一化为 left/right
      expect(inspect.badBoxCaret).not.toMatch(/transparent|rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/i);
      expect(inspect.badCaretTransparentVal).not.toMatch(/transparent|rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/i);
      expect(inspect.badBoxAlign).toBe('left');
      expect(inspect.badMarginAlign).toBe('right');
      // 3. 合规百分比/<375px宽度、overflow:auto / overflow-y:scroll 可滚动容器定高与 data-ignore-width 豁免宽度均保留
      expect(inspect.ignoredWidth).toBe('520px');
      expect(inspect.goodScrollableHeight).toBe('60px');
      expect(inspect.goodScrollYHeight).toBe('70px');
      expect(inspect.goodPctWidth).toBe('80%');
      expect(inspect.goodSmallPxWidth).toBe('240px');
      // 4. SVG animate / animateTransform / animateMotion 的 touchstart 均补齐 click
      expect(inspect.animBegins.length).toBe(3);
      for (const beginVal of inspect.animBegins) {
        expect(beginVal).toMatch(/\btouchstart\b/i);
        expect(beginVal).toMatch(/\bclick\b/i);
      }
      // 5. 100% 通过官方多屏沙箱与 Range API 行高重叠校验
      expect(verifyResult).toEqual({ isValid: true, inValidInfo: {} });
    } finally {
      assetStore.clear();
    }
  });

  // =========================================================================
  // 维度 4：官方文章结构规范净化（#2.1 15层嵌套、#2.2 span[leaf]、#2.3 section[nodeleaf]、#2.4 冗余空白节点）
  // =========================================================================
  it('test_excessive_nesting_illegal_leaf_containers_and_redundant_empty_nodes_normalize_cleanly', async () => {
    const assetStore = new AssetStore();
    const deepOpen = '<section>'.repeat(18);
    const deepClose = '</section>'.repeat(18);
    const rawDeepNesting = `${deepOpen}<span>深层嵌套中的核心正文</span>${deepClose}`;

    // 构造 #2.4 redundant-node 原始违规结构：单容器内子节点数 24 (> 20) 且空白子节点数 18 (> 15)
    const redundantChildren: string[] = [];
    for (let i = 1; i <= 6; i++) {
      redundantChildren.push(`<p>有效保留段落 ${i}</p>`);
    }
    for (let i = 1; i <= 9; i++) {
      redundantChildren.push('<p></p>');
      redundantChildren.push('<span></span>');
    }
    const rawRedundantContainer = `<section class="redundant-wrap">${redundantChildren.join('')}</section>`;

    // 【前置校验】：
    // 1) 18 层冗余 <section> 嵌套在官方校验器中触发 nestNodes 违规
    const preCheck = await verifier.verifyHtml(rawDeepNesting);
    expect(preCheck.isValid).toBe(false);
    expect(preCheck.inValidInfo.nestNodes?.items.length).toBeGreaterThan(0);

    // 2) 原始 span[leaf]、section[nodeleaf] 与 redundant-node 容器确实命中官方规则 #2.2 ~ #2.4 的违规条件
    const rawStructureViolations = await page.evaluate((html) => {
      const container = document.createElement('div');
      container.innerHTML = html;
      const redundantWrap = container.querySelector('.redundant-wrap');
      const allChildren = redundantWrap ? Array.from(redundantWrap.children) : [];
      const emptyChildren = allChildren.filter(
        (el) => (el.textContent || '').trim() === '' && el.children.length === 0
      );
      return {
        hasIllegalSpanLeaf: container.querySelectorAll('span[leaf] section, span[leaf] p').length > 0,
        hasIllegalNodeLeaf: container.querySelectorAll('section[nodeleaf] p, section[nodeleaf] div').length > 0,
        totalChildrenCount: allChildren.length,
        emptyChildrenCount: emptyChildren.length,
      };
    }, [
      '<div><span leaf=""><section>不能放在 span[leaf] 里的块级内容</section></span></div>',
      '<section nodeleaf=""><p>不能放在 section[nodeleaf] 里的块级段落</p></section>',
      rawRedundantContainer,
    ].join('\n'));
    expect(rawStructureViolations.hasIllegalSpanLeaf).toBe(true);
    expect(rawStructureViolations.hasIllegalNodeLeaf).toBe(true);
    expect(rawStructureViolations.totalChildrenCount).toBeGreaterThan(20);
    expect(rawStructureViolations.emptyChildrenCount).toBeGreaterThan(15);

    const markdown = [
      rawDeepNesting,
      '',
      '<div><span leaf="">前缀行内文字<section>不能放在 span[leaf] 里的块级内容</section></span></div>',
      '',
      '<section nodeleaf=""><p>不能放在 section[nodeleaf] 里的块级段落</p></section>',
      '',
      rawRedundantContainer,
    ].join('\n');

    const snapshot = await buildDeliverySnapshot(markdown, 'wechat', assetStore);

    try {
      const verifyResult = await verifier.verifyHtml(snapshot.html);
      const inspect = await page.evaluate((html) => {
        const container = document.createElement('div');
        container.innerHTML = html;
        const redundantWrap = container.querySelector('.redundant-wrap') || container;
        const wrapChildren = Array.from(redundantWrap.children);
        const emptyWrapChildren = wrapChildren.filter(
          (el) =>
            (el.textContent || '').trim() === '' &&
            !el.querySelector('img, svg, hr, br, video, audio, iframe')
        );
        const emptySpanLeafCount = Array.from(container.querySelectorAll('span[leaf]')).filter(
          (el) => (el.textContent || '').trim() === '' && !el.querySelector('img, br, svg')
        ).length;
        return {
          text: container.textContent || '',
          illegalLeafCount: container.querySelectorAll(
            'span[leaf] section, span[leaf] p, span[leaf] div, section[nodeleaf] p, section[nodeleaf] div'
          ).length,
          emptySpanLeafCount,
          hasNestLevelAttr: container.querySelector('[data-nest-level]') !== null,
          emptyWrapChildrenCount: emptyWrapChildren.length,
        };
      }, snapshot.html);

      expect(snapshot.ready).toBe(true);
      // 1. 文字内容完整保留（含 6 个有效段落）
      expect(inspect.text).toContain('深层嵌套中的核心正文');
      expect(inspect.text).toContain('前缀行内文字');
      expect(inspect.text).toContain('不能放在 span[leaf] 里的块级内容');
      expect(inspect.text).toContain('不能放在 section[nodeleaf] 里的块级段落');
      for (let i = 1; i <= 6; i++) {
        expect(inspect.text).toContain(`有效保留段落 ${i}`);
      }
      // 2. 通过官方校验器（消除 #2.1 nestNodes 冗余 15 层嵌套违规，且不残留 data-nest-level 临时属性）
      expect(verifyResult).toEqual({ isValid: true, inValidInfo: {} });
      expect(inspect.hasNestLevelAttr).toBe(false);
      expect(snapshot.html).not.toContain('data-nest-level');
      // 3. 消除 #2.2 span[leaf] 与 #2.3 section[nodeleaf] 非法包裹块级元素结构及拆分产生的空 span[leaf]
      expect(inspect.illegalLeafCount).toBe(0);
      expect(inspect.emptySpanLeafCount).toBe(0);
      // 4. 消除 #2.4 redundant-node 大量空白子节点堆积（剩余空节点数 <= 15）
      expect(inspect.emptyWrapChildrenCount).toBeLessThanOrEqual(15);
    } finally {
      assetStore.clear();
    }
  });

  // =========================================================================
  // 维度 5：官方字体使用规范净化（#3 font-family 非白名单自定义字体收敛）
  // =========================================================================
  it('test_custom_font_family_normalizes_to_wechat_compatible_font_stack', async () => {
    const rawCustomFontHtml = [
      '<p class="inline-fancy-font" style="font-family: &quot;Custom Fancy Font&quot;, cursive;">内联花哨自定义字体段落</p>',
      '<div class="css-fancy-font" style="font-family: Papyrus, fantasy;">样式表花哨自定义字体段落</div>',
    ].join('\n');

    // 【前置校验】：先确认原始非微信白名单字体确实触发官方 #3 checkFontFamilyViolation 规则
    const preCheckFontViolations = await collectFontFamilyViolations(page, rawCustomFontHtml);
    expect(preCheckFontViolations.length).toBe(2);
    expect(preCheckFontViolations[0].property).toBe('font-family');
    expect(preCheckFontViolations[0].rule).toBe(propertyRules['font-family']);

    const assetStore = new AssetStore();
    const markdown = [
      '<p class="inline-fancy-font" style="font-family: &quot;Custom Fancy Font&quot;, cursive;">内联花哨自定义字体段落</p>',
      '',
      '<div class="css-fancy-font">样式表花哨自定义字体段落</div>',
      '',
      '普通 Markdown 段落继承字体测试。',
    ].join('\n');

    const snapshot = await buildDeliverySnapshot(markdown, 'wechat', assetStore, {
      tokens: {
        '--morph-font-sans': '"Comic Sans MS", cursive',
      },
      customCss: `
        .css-fancy-font {
          font-family: "Papyrus", fantasy;
        }
      `,
    });

    try {
      const verifyResult = await verifier.verifyHtml(snapshot.html);
      const postCheckFontViolations = await collectFontFamilyViolations(page, snapshot.html);
      const renderedText = await page.evaluate((html) => {
        const container = document.createElement('div');
        container.innerHTML = html;
        return container.textContent || '';
      }, snapshot.html);

      expect(snapshot.ready).toBe(true);
      // 1. 原稿正文一字不差
      expect(renderedText).toContain('内联花哨自定义字体段落');
      expect(renderedText).toContain('样式表花哨自定义字体段落');
      expect(renderedText).toContain('普通 Markdown 段落继承字体测试。');
      // 2. 转化后不触发 checkFontFamilyViolation 规则且通过官方校验器
      expect(postCheckFontViolations).toEqual([]);
      expect(verifyResult).toEqual({ isValid: true, inValidInfo: {} });
    } finally {
      assetStore.clear();
    }
  });

  // =========================================================================
  // 维度 6：官方 Dark Mode 深色模式合规净化（#4.1.1 低对比度、#4.1.2 文字渐变背景、#4.5.1 data-no-dark、#4.6 data-ignore-dm）
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
          hasDataNoDark: container.querySelector('[data-no-dark]') !== null,
        };
      }, snapshot.html);

      expect(snapshot.ready).toBe(true);
      // 1. 正文内容完整保留，且未通过注入伪造的 data-ignore-dm 属性逃避校验，data-no-dark 白名单属性已剥离
      expect(inspect.text).toContain('文本与背景对比度过低');
      expect(inspect.text).toContain('文字背景使用了线性渐变');
      expect(inspect.text).toContain('带有白名单属性的列表项');
      expect(inspect.lowContrastHasIgnoreDm).toBe(false);
      expect(inspect.gradientHasIgnoreDm).toBe(false);
      expect(inspect.hasDataNoDark).toBe(false);
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
