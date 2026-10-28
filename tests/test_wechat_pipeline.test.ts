import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AssetStore,
  buildDeliverySnapshot,
} from '../src/index';
import {
  buildDefaultShowcaseMarkdown,
  DEFAULT_SAVED_CSS_PRESETS,
  THEME_PRESETS,
} from '../src/ui/presets';
import { decodeBitmapDataUrl, png } from './support/fixtures';
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
    const pngBytes = png(1, 800, 400);
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
    const pngBytes = png(1, 300, 200);
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
        const redundantWrap = container.querySelector('.redundant-wrap');
        const wrapChildren = redundantWrap ? Array.from(redundantWrap.children) : [];
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
          hasRedundantWrap: redundantWrap !== null,
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
      // 4. 消除 #2.4 redundant-node 大量空白子节点堆积（.redundant-wrap 存在且剩余空节点数 <= 15）
      expect(inspect.hasRedundantWrap).toBe(true);
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
          ignoreDmCount: container.querySelectorAll('[data-ignore-dm]').length,
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
      expect(inspect.ignoreDmCount).toBe(1);
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

  // =========================================================================
  // 维度 7：学术三线表边框、固定列宽与块级垂直间距在微信宿主样式及 BFC 下的所见即所得一致性
  // =========================================================================
  it('test_wechat_academic_three_line_table_and_block_spacing_maintain_wysiwyg_under_host_stylesheet_and_bfc', async () => {
    const assetStore = new AssetStore();
    const coverRecord = await assetStore.ingest(png(1, 360, 160), { fileName: 'cover-1.png' });
    const markdown = buildDefaultShowcaseMarkdown(coverRecord.uri);

    const snapshot = await buildDeliverySnapshot(markdown, 'wechat', assetStore, {
      customCss: THEME_PRESETS.default.presetCss,
      tokens: THEME_PRESETS.default.tokens,
    });

    try {
      const verifyResult = await verifier.verifyHtml(snapshot.html);
      expect(verifyResult).toEqual({ isValid: true, inValidInfo: {} });

      const metrics = await page.evaluate((html) => {
        document.body.innerHTML = `
          <style>
            body { margin: 0; padding: 0; }
            .stage-row { display: flex; gap: 20px; align-items: flex-start; }
            .box { width: 585px; box-sizing: border-box; }
            #wechat-host-box table { table-layout: fixed; width: 100%; }
            #wechat-host-box table, #wechat-host-box th, #wechat-host-box td { border: 1px solid #d9d9d9; }
            #wechat-host-box .morph-doc { display: flex; flex-direction: column; }
          </style>
          <div class="stage-row">
            <div id="preview-box" class="box">${html}</div>
            <div id="wechat-host-box" class="box">${html}</div>
          </div>
        `;

        const collectBoxMetrics = (boxId: string) => {
          const root = document.getElementById(boxId)!;
          const table = root.querySelector('table.morph-table') as HTMLElement;
          const prevEl = table.previousElementSibling as HTMLElement;
          const ths = Array.from(table.querySelectorAll('th')) as HTMLElement[];
          const tds = Array.from(table.querySelectorAll('td')) as HTMLElement[];
          const trs = Array.from(table.querySelectorAll('tr')) as HTMLElement[];

          const tableCS = window.getComputedStyle(table);
          const thBorders = ths.map((th) => {
            const cs = window.getComputedStyle(th);
            return {
              top: cs.borderTopWidth,
              left: cs.borderLeftWidth,
              right: cs.borderRightWidth,
              bottom: cs.borderBottomWidth,
              width: th.getBoundingClientRect().width,
            };
          });
          const tdBorders = tds.map((td) => {
            const cs = window.getComputedStyle(td);
            return {
              top: cs.borderTopWidth,
              left: cs.borderLeftWidth,
              right: cs.borderRightWidth,
              bottom: cs.borderBottomWidth,
            };
          });
          const rowHeights = trs.map((tr) => tr.getBoundingClientRect().height);
          const gapBeforeTable =
            table.getBoundingClientRect().top - prevEl.getBoundingClientRect().bottom;

          return {
            tableLayout: tableCS.tableLayout,
            thBorders,
            tdBorders,
            rowHeights,
            gapBeforeTable,
          };
        };

        return {
          preview: collectBoxMetrics('preview-box'),
          host: collectBoxMetrics('wechat-host-box'),
        };
      }, snapshot.html);

      // a) In wechat-host-box, computed borders on th and td must have 0px top/left/right and 2px/1px bottom
      for (const thB of metrics.host.thBorders) {
        expect(thB.top).toBe('0px');
        expect(thB.left).toBe('0px');
        expect(thB.right).toBe('0px');
        expect(thB.bottom).toBe('2px');
      }
      for (const tdB of metrics.host.tdBorders) {
        expect(tdB.top).toBe('0px');
        expect(tdB.left).toBe('0px');
        expect(tdB.right).toBe('0px');
        expect(tdB.bottom).toBe('1px');
      }

      // b) Both containers use fixed table layout, equal 4-column widths, and matching column widths
      expect(metrics.preview.tableLayout).toBe('fixed');
      expect(metrics.host.tableLayout).toBe('fixed');
      expect(metrics.preview.thBorders).toHaveLength(4);
      expect(metrics.host.thBorders).toHaveLength(4);

      const firstPreviewColW = metrics.preview.thBorders[0].width;
      for (let i = 0; i < 4; i++) {
        expect(Math.abs(metrics.preview.thBorders[i].width - firstPreviewColW)).toBeLessThanOrEqual(1);
        expect(
          Math.abs(metrics.preview.thBorders[i].width - metrics.host.thBorders[i].width)
        ).toBeLessThanOrEqual(1);
      }

      // c) Vertical gap before table is identical between preview and non-collapsing host BFC, and <= 24px
      expect(metrics.preview.gapBeforeTable).toBeLessThanOrEqual(24);
      expect(metrics.host.gapBeforeTable).toBeLessThanOrEqual(24);
      expect(
        Math.abs(metrics.preview.gapBeforeTable - metrics.host.gapBeforeTable)
      ).toBeLessThanOrEqual(1);

      // d) Every table row height in preview matches wechat-host-box within 1px
      expect(metrics.preview.rowHeights.length).toBe(metrics.host.rowHeights.length);
      for (let i = 0; i < metrics.preview.rowHeights.length; i++) {
        expect(
          Math.abs(metrics.preview.rowHeights[i] - metrics.host.rowHeights[i])
        ).toBeLessThanOrEqual(1);
      }

      // e) Also verify the Yoryon preset passes official verifier and preserves WYSIWYG table & spacing
      const yoryonPreset = DEFAULT_SAVED_CSS_PRESETS.find((p) => p.id === 'yoryon');
      expect(yoryonPreset).toBeDefined();

      const yoryonSnap = await buildDeliverySnapshot(markdown, 'wechat', assetStore, {
        customCss: yoryonPreset!.css,
        tokens: THEME_PRESETS.default.tokens,
      });
      const yoryonVerify = await verifier.verifyHtml(yoryonSnap.html);
      expect(yoryonVerify).toEqual({ isValid: true, inValidInfo: {} });

      const yoryonMetrics = await page.evaluate((html) => {
        document.body.innerHTML = `
          <style>
            body { margin: 0; padding: 0; }
            .stage-row { display: flex; gap: 20px; align-items: flex-start; }
            .box { width: 585px; box-sizing: border-box; }
            #wechat-host-box table { table-layout: fixed; width: 100%; }
            #wechat-host-box table, #wechat-host-box th, #wechat-host-box td { border: 1px solid #d9d9d9; }
            #wechat-host-box .morph-doc { display: flex; flex-direction: column; }
          </style>
          <div class="stage-row">
            <div id="preview-box" class="box">${html}</div>
            <div id="wechat-host-box" class="box">${html}</div>
          </div>
        `;
        const root = document.getElementById('wechat-host-box')!;
        const table = root.querySelector('table.morph-table') as HTMLElement;
        const prevEl = table.previousElementSibling as HTMLElement;
        const ths = Array.from(table.querySelectorAll('th')) as HTMLElement[];
        const tds = Array.from(table.querySelectorAll('td')) as HTMLElement[];
        return {
          tableLayout: window.getComputedStyle(table).tableLayout,
          gapBeforeTable: table.getBoundingClientRect().top - prevEl.getBoundingClientRect().bottom,
          thBorders: ths.map((th) => {
            const cs = window.getComputedStyle(th);
            return {
              top: cs.borderTopWidth,
              left: cs.borderLeftWidth,
              right: cs.borderRightWidth,
              bottom: cs.borderBottomWidth,
            };
          }),
          tdBorders: tds.map((td) => {
            const cs = window.getComputedStyle(td);
            return {
              top: cs.borderTopWidth,
              left: cs.borderLeftWidth,
              right: cs.borderRightWidth,
              bottom: cs.borderBottomWidth,
            };
          }),
        };
      }, yoryonSnap.html);

      expect(yoryonMetrics.tableLayout).toBe('fixed');
      expect(yoryonMetrics.gapBeforeTable).toBeLessThanOrEqual(24);
      for (const thB of yoryonMetrics.thBorders) {
        expect(thB.top).toBe('0px');
        expect(thB.left).toBe('0px');
        expect(thB.right).toBe('0px');
        expect(thB.bottom).toBe('2px');
      }
      for (const tdB of yoryonMetrics.tdBorders) {
        expect(tdB.top).toBe('0px');
        expect(tdB.left).toBe('0px');
        expect(tdB.right).toBe('0px');
        expect(tdB.bottom).toBe('1px');
      }
    } finally {
      assetStore.clear();
    }
  });

  // =========================================================================
  // 维度 8：外链转文本降级、Callout <section> 保真与兜底样式、375px 手机端代码块防折行与字号/表格密度
  // =========================================================================
  it('test_wechat_external_link_degradation_callout_section_fidelity_and_375px_mobile_code_and_table_layout', async () => {
    const assetStore = new AssetStore();
    const coverRecord = await assetStore.ingest(png(1, 360, 160), { fileName: 'cover-mobile.png' });
    const markdown = buildDefaultShowcaseMarkdown(coverRecord.uri);

    try {
      const anthropicSnap = await buildDeliverySnapshot(markdown, 'wechat', assetStore, {
        customCss: THEME_PRESETS.default.presetCss,
        tokens: THEME_PRESETS.default.tokens,
      });

      const yoryonPreset = DEFAULT_SAVED_CSS_PRESETS.find((p) => p.id === 'yoryon')!;
      const yoryonSnap = await buildDeliverySnapshot(markdown, 'wechat', assetStore, {
        customCss: yoryonPreset.css,
        tokens: THEME_PRESETS.default.tokens,
      });

      const emptyCssSnap = await buildDeliverySnapshot(markdown, 'wechat', assetStore, {
        customCss: '',
        tokens: THEME_PRESETS.default.tokens,
      });

      const xArticleSnap = await buildDeliverySnapshot(markdown, 'x-article', assetStore, {
        customCss: THEME_PRESETS.default.presetCss,
        tokens: THEME_PRESETS.default.tokens,
      });

      const cardsSnap = await buildDeliverySnapshot(markdown, 'cards', assetStore, {
        customCss: THEME_PRESETS.default.presetCss,
        tokens: THEME_PRESETS.default.tokens,
      });

      // 1. Official verifier passes on Anthropic, Yoryon, and empty-CSS WeChat snapshots
      expect(await verifier.verifyHtml(anthropicSnap.html)).toEqual({
        isValid: true,
        inValidInfo: {},
      });
      expect(await verifier.verifyHtml(yoryonSnap.html)).toEqual({
        isValid: true,
        inValidInfo: {},
      });
      expect(await verifier.verifyHtml(emptyCssSnap.html)).toEqual({
        isValid: true,
        inValidInfo: {},
      });

      // 2. External link diagnostic emitted in WeChat, while x-article and cards keep <a href="https://morphmd.dev">
      expect(
        anthropicSnap.diagnostics.some(
          (d) => d.code === 'structure/wechat-external-link-degraded' && d.severity === 'info'
        )
      ).toBe(true);
      expect(xArticleSnap.html).toContain('href="https://morphmd.dev"');
      expect(cardsSnap.html).toContain('href="https://morphmd.dev"');

      // 3. Even with empty customCss (""), Callout and Quote in WeChat retain baseline styles and native <p> with inline <span>+<br> (zero block descendants)
      const emptyCalloutCheck = await page.evaluate((html) => {
        const container = document.createElement('div');
        container.innerHTML = html;
        const callout = container.querySelector('.morph-callout') as HTMLElement | null;
        const title = container.querySelector('.morph-callout-title') as HTMLElement | null;
        const titleText = title?.querySelector('.morph-callout-title-text') as HTMLElement | null;
        const body = container.querySelector('.morph-callout-body') as HTMLElement | null;
        const quote = container.querySelector('.morph-quote') as HTMLElement | null;
        return {
          calloutTag: callout?.tagName || '',
          containsTitleAndBody:
            Boolean(callout && title && body && callout.contains(title) && callout.contains(body)),
          blockDescendantCount: callout?.querySelectorAll('p, div, section').length ?? -1,
          hasDirectBr: callout?.querySelector(':scope > br') !== null,
          calloutBg: callout?.style.backgroundColor || '',
          calloutBorderLeft: callout?.style.borderLeft || callout?.style.borderLeftWidth || '',
          calloutRadius: callout?.style.borderRadius || '',
          calloutPadding: callout?.style.padding || callout?.style.paddingTop || '',
          calloutMarginTop: callout?.style.marginTop || '',
          calloutMarginBottom: callout?.style.marginBottom || '',
          calloutFontSize: callout?.style.fontSize || '',
          calloutLineHeight: callout?.style.lineHeight || '',
          calloutFontFamily: callout?.style.fontFamily || '',
          calloutColor: callout?.style.color || '',
          titleTag: title?.tagName || '',
          titleTextWeight: titleText?.style.fontWeight || '',
          bodyTag: body?.tagName || '',
          quoteTag: quote?.tagName || '',
          quoteBlockDescendantCount:
            quote?.querySelectorAll('p, div, section, blockquote').length ?? -1,
          hasLegacyBlockquote: container.querySelector('blockquote.morph-quote') !== null,
        };
      }, emptyCssSnap.html);

      expect(emptyCalloutCheck.calloutTag).toBe('P');
      expect(emptyCalloutCheck.containsTitleAndBody).toBe(true);
      expect(emptyCalloutCheck.blockDescendantCount).toBe(0);
      expect(emptyCalloutCheck.hasDirectBr).toBe(true);
      expect(emptyCalloutCheck.calloutBg).toBeTruthy();
      expect(emptyCalloutCheck.calloutBorderLeft).toContain('3px');
      expect(emptyCalloutCheck.calloutRadius).toBe('0px 8px 8px 0px');
      expect(emptyCalloutCheck.calloutPadding).toBeTruthy();
      expect(emptyCalloutCheck.calloutMarginTop).toBe('0px');
      expect(emptyCalloutCheck.calloutMarginBottom).toBe('16px');
      expect(emptyCalloutCheck.calloutFontSize).toBe('14.5px');
      expect(emptyCalloutCheck.calloutLineHeight).toBe('1.65');
      expect(emptyCalloutCheck.calloutFontFamily).toBeTruthy();
      expect(emptyCalloutCheck.calloutColor).toBeTruthy();
      expect(emptyCalloutCheck.titleTag).toBe('SPAN');
      expect(emptyCalloutCheck.titleTextWeight).toBe('600');
      expect(emptyCalloutCheck.bodyTag).toBe('SPAN');
      expect(emptyCalloutCheck.quoteTag).toBe('P');
      expect(emptyCalloutCheck.quoteBlockDescendantCount).toBe(0);
      expect(emptyCalloutCheck.hasLegacyBlockquote).toBe(false);

      // 4. Verify 375px mobile WeChat viewport rendering & 585px Preview-vs-WeChat-Host 1:1 Isomorphism for both Anthropic and Yoryon presets
      for (const [presetId, snap] of [
        ['default', anthropicSnap],
        ['yoryon', yoryonSnap],
      ] as const) {
        const mobileAudit = await page.evaluate((html) => {
          document.body.innerHTML = `
            <style>
              body { margin: 0; padding: 0; }
              #wechat-mobile-box {
                width: 375px;
                padding: 0 16px;
                box-sizing: border-box;
                text-align: justify;
              }
              #wechat-mobile-box pre {
                white-space: pre-wrap;
                word-wrap: break-word;
              }
              #wechat-mobile-box ol,
              #wechat-mobile-box ul,
              #wechat-mobile-box blockquote {
                margin-bottom: 0px;
              }
            </style>
            <div id="wechat-mobile-box" class="rich_media_content">${html}</div>
          `;

          const root = document.getElementById('wechat-mobile-box')!;
          const docEl = root.querySelector('.morph-doc') as HTMLElement;
          const h1 = root.querySelector('h1.morph-h1') as HTMLElement;
          const h2s = Array.from(root.querySelectorAll('h2.morph-h2')) as HTMLElement[];
          const h2 = h2s[0];
          const h2Second = h2s[1];
          const h3 = root.querySelector('h3.morph-h3') as HTMLElement;
          const bodyPara = root.querySelector('p.morph-p') as HTMLElement;
          const ol = root.querySelector('ol.morph-list') as HTMLElement;
          const liSections = Array.from(ol.querySelectorAll(':scope > li > section')) as HTMLElement[];
          const strong = root.querySelector('p strong') as HTMLElement;
          const em = root.querySelector('p em') as HTMLElement;
          const externalAnchors = root.querySelectorAll('a[href^="http"]');
          const linkText = root.querySelector('.morph-link-text') as HTMLElement | null;

          const quote = root.querySelector('.morph-quote') as HTMLElement;
          const quotePara = quote?.querySelector('.morph-p') as HTMLElement | null;
          const legacyBlockquoteCount = root.querySelectorAll('blockquote.morph-quote').length;

          const callout = root.querySelector('.morph-callout') as HTMLElement;
          const calloutTitle = callout.querySelector('.morph-callout-title') as HTMLElement;
          const calloutTitleText = calloutTitle.querySelector(
            '.morph-callout-title-text'
          ) as HTMLElement | null;
          const calloutBody = callout.querySelector('.morph-callout-body') as HTMLElement;
          const calloutPara = calloutBody.querySelector('.morph-p') as HTMLElement;
          const calloutPrevEl = callout.previousElementSibling as HTMLElement;
          const calloutNextEl = callout.nextElementSibling as HTMLElement;

          const blockContainers = Array.from(
            root.querySelectorAll(
              '.morph-doc, .morph-callout, .morph-quote, ul.morph-list, ol.morph-list'
            )
          );
          let interBlockWhitespaceTextNodeCount = 0;
          for (const containerEl of blockContainers) {
            for (const child of Array.from(containerEl.childNodes)) {
              if (
                child.nodeType === Node.TEXT_NODE &&
                (child.textContent || '').trim() === '' &&
                (child.textContent || '').length > 0
              ) {
                interBlockWhitespaceTextNodeCount++;
              }
            }
          }

          const pre = root.querySelector('pre.morph-code') as HTMLElement;
          const preCode = pre.querySelector('code') as HTMLElement;
          const codeLines = Array.from(pre.querySelectorAll('.line')) as HTMLElement[];

          const table = root.querySelector('table.morph-table') as HTMLElement;
          const th = table.querySelector('th') as HTMLElement;
          const td = table.querySelector('td') as HTMLElement;
          const tableCode = table.querySelector('code') as HTMLElement;

          const preCS = window.getComputedStyle(pre);
          const preCodeCS = window.getComputedStyle(preCode);

          const h2FirstPrev = h2.previousElementSibling as HTMLElement;
          const h2FirstNext = h2.nextElementSibling as HTMLElement;
          const h2SecondPrev = h2Second.previousElementSibling as HTMLElement;
          const h3Next = h3.nextElementSibling as HTMLElement;

          return {
            docFontSize: docEl.style.fontSize,
            docLineHeight: docEl.style.lineHeight,
            paraFontSize: bodyPara.style.fontSize,
            paraLineHeight: bodyPara.style.lineHeight,
            olMarginTop: ol.style.marginTop,
            olMarginBottom: ol.style.marginBottom,
            liSectionFontSizes: liSections.map((s) => s.style.fontSize),
            liSectionMargins: liSections.map((s) => s.style.marginBottom),
            h1FontSize: h1.style.fontSize,
            h1LineHeight: h1.style.lineHeight,
            h1MarginTop: h1.style.marginTop,
            h1MarginBottom: h1.style.marginBottom,
            h2FontSize: h2.style.fontSize,
            h2LineHeight: h2.style.lineHeight,
            h2MarginTop: h2.style.marginTop,
            h2MarginBottom: h2.style.marginBottom,
            h3FontSize: h3.style.fontSize,
            h3LineHeight: h3.style.lineHeight,
            h3MarginTop: h3.style.marginTop,
            h3MarginBottom: h3.style.marginBottom,
            gapAboveFirstH2:
              h2.getBoundingClientRect().top - h2FirstPrev.getBoundingClientRect().bottom,
            gapBelowFirstH2:
              h2FirstNext.getBoundingClientRect().top - h2.getBoundingClientRect().bottom,
            gapAboveSecondH2:
              h2Second.getBoundingClientRect().top - h2SecondPrev.getBoundingClientRect().bottom,
            gapH2ToH3:
              h3.getBoundingClientRect().top - h2Second.getBoundingClientRect().bottom,
            gapBelowH3:
              h3Next.getBoundingClientRect().top - h3.getBoundingClientRect().bottom,
            strongWeight: strong.style.fontWeight,
            strongColor: strong.style.color.toLowerCase(),
            emStyle: em.style.fontStyle,
            emColor: em.style.color.toLowerCase(),
            externalAnchorCount: externalAnchors.length,
            linkTextHref: linkText?.getAttribute('data-original-href') || '',
            linkTextContent: linkText?.textContent || '',
            legacyBlockquoteCount,
            quoteTag: quote?.tagName || '',
            quoteBlockDescendantCount:
              quote?.querySelectorAll('p, div, section, blockquote').length ?? -1,
            quoteBorderLeft: (quote?.style.borderLeft || quote?.style.borderLeftColor || '').toLowerCase(),
            quoteBorderLeftWidth: quote?.style.borderLeftWidth || quote?.style.borderLeft || '',
            quotePadding: quote?.style.padding || quote?.style.paddingLeft || '',
            quoteMarginTop: quote?.style.marginTop || '',
            quoteMarginBottom: quote?.style.marginBottom || '',
            quoteParaTag: quotePara?.tagName || '',
            quoteParaFontFamily: quotePara?.style.fontFamily || '',
            quoteParaColor: (quotePara?.style.color || '').toLowerCase(),
            quoteParaFontSize: quotePara?.style.fontSize || '',
            quoteParaLineHeight: quotePara?.style.lineHeight || '',
            quoteParaFontStyle: quotePara?.style.fontStyle || '',
            calloutTag: callout.tagName,
            calloutBlockDescendantCount: callout.querySelectorAll('p, div, section').length,
            calloutHasDirectBr: callout.querySelector(':scope > br') !== null,
            calloutMarginTop: callout.style.marginTop,
            calloutMarginBottom: callout.style.marginBottom,
            calloutPrevSiblingNodeType: callout.previousSibling?.nodeType ?? 0,
            calloutNextSiblingNodeType: callout.nextSibling?.nodeType ?? 0,
            interBlockWhitespaceTextNodeCount,
            gapAboveCallout:
              callout.getBoundingClientRect().top - calloutPrevEl.getBoundingClientRect().bottom,
            gapBelowCallout:
              calloutNextEl.getBoundingClientRect().top - callout.getBoundingClientRect().bottom,
            calloutRadius: callout.style.borderRadius,
            calloutFontSize: callout.style.fontSize,
            calloutLineHeight: callout.style.lineHeight,
            calloutTitleTag: calloutTitle.tagName,
            calloutTitleTextWeight: calloutTitleText?.style.fontWeight || '',
            calloutBodyTag: calloutBody.tagName,
            calloutParaTag: calloutPara?.tagName || '',
            calloutParaFontSize: calloutPara?.style.fontSize || '',
            calloutParaLineHeight: calloutPara?.style.lineHeight || '',
            preFontSize: pre.style.fontSize,
            preWhiteSpace: preCS.whiteSpace,
            preTextAlign: preCS.textAlign,
            preWordBreak: preCS.wordBreak,
            preOverflowWrap: preCS.overflowWrap,
            preCodeWhiteSpace: preCodeCS.whiteSpace,
            preCodeTextAlign: preCodeCS.textAlign,
            lineStyles: codeLines.map((line) => {
              const cs = window.getComputedStyle(line);
              return {
                text: (line.textContent || '').trim(),
                whiteSpace: cs.whiteSpace,
                textAlign: cs.textAlign,
                wordBreak: cs.wordBreak,
                overflowWrap: cs.overflowWrap,
                height: line.getBoundingClientRect().height,
              };
            }),
            tableFontSize: table.style.fontSize,
            thPadding: th.style.padding,
            tdPadding: td.style.padding,
            tableCodeFontSize: tableCode.style.fontSize,
            tableCodeWhiteSpace: tableCode.style.whiteSpace,
          };
        }, snap.html);

        expect(mobileAudit.docFontSize).toBe('15px');
        expect(mobileAudit.docLineHeight).toBe('1.75');
        expect(mobileAudit.paraFontSize).toBe('15px');
        expect(mobileAudit.paraLineHeight).toBe('1.75');
        expect(mobileAudit.olMarginTop).toBe('0px');
        expect(mobileAudit.olMarginBottom).toBe('0px');
        expect(mobileAudit.liSectionFontSizes).toEqual(['15px', '15px', '15px']);
        expect(mobileAudit.liSectionMargins).toEqual(['6px', '6px', '16px']);

        expect(mobileAudit.h1FontSize).toBe('24px');
        expect(mobileAudit.h1LineHeight).toBe('1.35');
        expect(mobileAudit.h1MarginTop).toBe('0px');
        expect(mobileAudit.h1MarginBottom).toBe('22px');
        expect(mobileAudit.h2FontSize).toBe('20px');
        expect(mobileAudit.h2LineHeight).toBe('1.4');
        expect(mobileAudit.h2MarginTop).toBe('28px');
        expect(mobileAudit.h2MarginBottom).toBe('16px');
        expect(mobileAudit.h3FontSize).toBe('17px');
        expect(mobileAudit.h3LineHeight).toBe('1.45');
        expect(mobileAudit.h3MarginTop).toBe('22px');
        expect(mobileAudit.h3MarginBottom).toBe('12px');

        // Heading vertical rhythm under hostile WeChat host CSS (ol/ul/blockquote margin-bottom: 0)
        expect(mobileAudit.gapAboveFirstH2).toBeGreaterThanOrEqual(26);
        expect(mobileAudit.gapBelowFirstH2).toBeGreaterThanOrEqual(15);
        expect(mobileAudit.gapAboveSecondH2).toBeGreaterThanOrEqual(26);
        expect(mobileAudit.gapH2ToH3).toBeGreaterThanOrEqual(18);
        expect(mobileAudit.gapBelowH3).toBeGreaterThanOrEqual(11);

        expect(mobileAudit.strongWeight).toBe('600');
        expect(mobileAudit.emStyle).toBe('italic');
        if (presetId === 'default') {
          expect(mobileAudit.strongColor).toMatch(/#141413|rgb\(20,\s*20,\s*19\)/);
          expect(mobileAudit.emColor).toMatch(/#8c5a4b|rgb\(140,\s*90,\s*75\)/);
        } else {
          expect(mobileAudit.strongColor).toMatch(/#282828|rgb\(40,\s*40,\s*40\)/);
          expect(mobileAudit.emColor).toMatch(/#607383|rgb\(96,\s*115,\s*131\)/);
        }

        expect(mobileAudit.externalAnchorCount).toBe(0);
        expect(mobileAudit.linkTextHref).toBe('https://morphmd.dev');
        expect(mobileAudit.linkTextContent).toBe('MorphMD 跨端排版系统 (https://morphmd.dev)');

        // Quote native <p class="morph-quote"> with inline <span class="morph-p"> (eliminates .js_blockquote_wrap double left-border shadow)
        expect(mobileAudit.legacyBlockquoteCount).toBe(0);
        expect(mobileAudit.quoteTag).toBe('P');
        expect(mobileAudit.quoteBlockDescendantCount).toBe(0);
        expect(mobileAudit.quoteBorderLeftWidth).toContain('2px');
        expect(mobileAudit.quotePadding).toBeTruthy();
        expect(mobileAudit.quoteMarginTop).toBe('0px');
        expect(mobileAudit.quoteMarginBottom).toBe('20px');
        expect(mobileAudit.quoteParaTag).toBe('SPAN');
        expect(mobileAudit.quoteParaFontSize).toBe('15px');
        expect(mobileAudit.quoteParaLineHeight).toBe('1.7');
        expect(mobileAudit.quoteParaFontStyle).toBe('normal');
        if (presetId === 'default') {
          expect(mobileAudit.quoteBorderLeft).toMatch(/#c86446|rgb\(200,\s*100,\s*70\)/);
          expect(mobileAudit.quoteParaFontFamily).toContain('Newsreader');
          expect(mobileAudit.quoteParaFontFamily).toContain('Noto Serif SC');
          expect(mobileAudit.quoteParaColor).toMatch(/#3d3c3a|rgb\(61,\s*60,\s*58\)/);
        } else {
          expect(mobileAudit.quoteBorderLeft).toMatch(/#47758f|rgb\(71,\s*117,\s*143\)/);
          expect(mobileAudit.quoteParaFontFamily).toMatch(/Iowan Old Style|Palatino|Songti SC/i);
          expect(mobileAudit.quoteParaColor).toMatch(/#253947|rgb\(37,\s*57,\s*71\)/);
        }

        expect(mobileAudit.calloutTag).toBe('P');
        expect(mobileAudit.calloutBlockDescendantCount).toBe(0);
        expect(mobileAudit.calloutHasDirectBr).toBe(true);
        expect(mobileAudit.calloutMarginTop).toBe('0px');
        expect(mobileAudit.calloutMarginBottom).toBe('16px');
        expect(mobileAudit.calloutPrevSiblingNodeType).toBe(1);
        expect(mobileAudit.calloutNextSiblingNodeType).toBe(1);
        expect(mobileAudit.interBlockWhitespaceTextNodeCount).toBe(0);
        expect(mobileAudit.gapAboveCallout).toBeGreaterThanOrEqual(14);
        expect(mobileAudit.gapAboveCallout).toBeLessThanOrEqual(20);
        expect(mobileAudit.gapBelowCallout).toBeGreaterThanOrEqual(14);
        expect(mobileAudit.gapBelowCallout).toBeLessThanOrEqual(20);
        expect(mobileAudit.calloutRadius).toBe('0px 8px 8px 0px');
        expect(mobileAudit.calloutFontSize).toBe('14.5px');
        expect(mobileAudit.calloutLineHeight).toBe('1.65');
        expect(mobileAudit.calloutTitleTag).toBe('SPAN');
        expect(mobileAudit.calloutTitleTextWeight).toBe('600');
        expect(mobileAudit.calloutBodyTag).toBe('SPAN');
        expect(mobileAudit.calloutParaTag).toBe('SPAN');
        expect(mobileAudit.calloutParaFontSize).toBe('14.5px');
        expect(mobileAudit.calloutParaLineHeight).toBe('1.65');

        expect(mobileAudit.preFontSize).toBe('13px');
        expect(mobileAudit.preWhiteSpace).toBe('pre');
        expect(mobileAudit.preTextAlign).toBe('left');
        expect(mobileAudit.preWordBreak).toBe('normal');
        expect(mobileAudit.preOverflowWrap).toBe('normal');
        expect(mobileAudit.preCodeWhiteSpace).toBe('pre');
        expect(mobileAudit.preCodeTextAlign).toBe('left');
        expect(mobileAudit.lineStyles).toHaveLength(5);
        for (const line of mobileAudit.lineStyles) {
          expect(line.text.length).toBeGreaterThan(0);
          expect(line.whiteSpace).toBe('pre');
          expect(line.textAlign).toBe('left');
          expect(line.wordBreak).toBe('normal');
          expect(line.overflowWrap).toBe('normal');
          // Each code line must stay on a single line (no wrapping in 375px mobile container)
          expect(line.height).toBeLessThanOrEqual(26);
        }

        expect(mobileAudit.tableFontSize).toBe('13px');
        expect(mobileAudit.thPadding).toBe('8px 6px');
        expect(mobileAudit.tdPadding).toBe('8px 6px');
        expect(mobileAudit.tableCodeFontSize).toBe('12px');
        expect(mobileAudit.tableCodeWhiteSpace).toBe('normal');

        // 5. 1:1 Preview vs Simulated WeChat Host (.ProseMirror / .rich_media_content) Layout Isomorphism at 585px
        const isomorphism = await page.evaluate((html) => {
          document.body.innerHTML = `
            <style>
              body { margin: 0; padding: 0; }
              .stage-row { display: flex; gap: 20px; align-items: flex-start; }
              .box { width: 585px; box-sizing: border-box; }
              #preview-box .morph-doc { display: flow-root; }
              #wechat-host-box {
                font-size: 17px;
                line-height: 1.6;
                color: rgba(0, 0, 0, 0.9);
                text-align: justify;
              }
              #wechat-host-box .list-paddingleft-1 {
                margin: 0;
                padding-left: 22px;
              }
              #wechat-host-box pre {
                white-space: pre-wrap;
                word-wrap: break-word;
              }
            </style>
            <div class="stage-row">
              <div id="preview-box" class="box">${html}</div>
              <div id="wechat-host-box" class="box"></div>
            </div>
          `;

          const hostBox = document.getElementById('wechat-host-box')!;
          const temp = document.createElement('div');
          temp.innerHTML = html;
          const morphDoc = temp.querySelector('.morph-doc');
          if (morphDoc) {
            while (morphDoc.firstChild) {
              hostBox.appendChild(morphDoc.firstChild);
            }
          }

          // Simulate WeChat ProseMirror stripping style from ol, ul, li, and pre > code
          for (const listEl of Array.from(hostBox.querySelectorAll('ol, ul'))) {
            listEl.removeAttribute('style');
            listEl.classList.add('list-paddingleft-1');
          }
          for (const liEl of Array.from(hostBox.querySelectorAll('li'))) {
            liEl.removeAttribute('style');
          }
          for (const codeEl of Array.from(hostBox.querySelectorAll('pre > code'))) {
            codeEl.removeAttribute('style');
          }

          // Simulate WeChat ProseMirror inserting empty <p><br></p> around any top-level <section> card
          let injectedEmptyParaCount = 0;
          for (const sec of Array.from(hostBox.querySelectorAll(':scope > section'))) {
            const beforeP = document.createElement('p');
            beforeP.setAttribute('style', 'margin: 0 0 24px 0; line-height: 1.6;');
            beforeP.innerHTML = '<br>';
            const afterP = document.createElement('p');
            afterP.setAttribute('style', 'margin: 0 0 24px 0; line-height: 1.6;');
            afterP.innerHTML = '<br>';
            sec.parentNode!.insertBefore(beforeP, sec);
            sec.parentNode!.insertBefore(afterP, sec.nextSibling);
            injectedEmptyParaCount += 2;
          }

          const measureBox = (boxId: string) => {
            const root = document.getElementById(boxId)!;
            const quote = root.querySelector('.morph-quote') as HTMLElement;
            const callout = root.querySelector('.morph-callout') as HTMLElement;
            const calloutPrev = callout.previousElementSibling as HTMLElement;
            const calloutNext = callout.nextElementSibling as HTMLElement;
            const h2s = Array.from(root.querySelectorAll('h2.morph-h2')) as HTMLElement[];
            const ol = root.querySelector('ol.morph-list') as HTMLElement;
            const liSecs = Array.from(ol.querySelectorAll(':scope > li > section')) as HTMLElement[];
            const paras = Array.from(root.querySelectorAll('p.morph-p')) as HTMLElement[];

            return {
              quoteHeight: quote.getBoundingClientRect().height,
              calloutHeight: callout.getBoundingClientRect().height,
              gapAboveCallout:
                callout.getBoundingClientRect().top - calloutPrev.getBoundingClientRect().bottom,
              gapBelowCallout:
                calloutNext.getBoundingClientRect().top - callout.getBoundingClientRect().bottom,
              gapH2ToFirstLi:
                liSecs[0].getBoundingClientRect().top - h2s[0].getBoundingClientRect().bottom,
              gapLi1ToLi2:
                liSecs[1].getBoundingClientRect().top - liSecs[0].getBoundingClientRect().bottom,
              gapLi2ToLi3:
                liSecs[2].getBoundingClientRect().top - liSecs[1].getBoundingClientRect().bottom,
              gapLastLiToNextH2:
                h2s[1].getBoundingClientRect().top - liSecs[2].getBoundingClientRect().bottom,
              liSectionHeights: liSecs.map((s) => s.getBoundingClientRect().height),
              paraHeights: paras.map((p) => p.getBoundingClientRect().height),
            };
          };

          return {
            injectedEmptyParaCount,
            preview: measureBox('preview-box'),
            host: measureBox('wechat-host-box'),
          };
        }, snap.html);

        expect(isomorphism.injectedEmptyParaCount).toBe(0);
        expect(
          Math.abs(isomorphism.preview.quoteHeight - isomorphism.host.quoteHeight)
        ).toBeLessThan(1);
        expect(
          Math.abs(isomorphism.preview.calloutHeight - isomorphism.host.calloutHeight)
        ).toBeLessThanOrEqual(1);
        expect(
          Math.abs(isomorphism.preview.gapAboveCallout - isomorphism.host.gapAboveCallout)
        ).toBeLessThanOrEqual(1);
        expect(
          Math.abs(isomorphism.preview.gapBelowCallout - isomorphism.host.gapBelowCallout)
        ).toBeLessThanOrEqual(1);
        expect(isomorphism.host.gapAboveCallout).toBeLessThanOrEqual(24);
        expect(isomorphism.host.gapBelowCallout).toBeLessThanOrEqual(24);

        expect(
          Math.abs(isomorphism.preview.gapH2ToFirstLi - isomorphism.host.gapH2ToFirstLi)
        ).toBeLessThanOrEqual(1);
        expect(
          Math.abs(isomorphism.preview.gapLi1ToLi2 - isomorphism.host.gapLi1ToLi2)
        ).toBeLessThanOrEqual(1);
        expect(
          Math.abs(isomorphism.preview.gapLi2ToLi3 - isomorphism.host.gapLi2ToLi3)
        ).toBeLessThanOrEqual(1);
        expect(
          Math.abs(isomorphism.preview.gapLastLiToNextH2 - isomorphism.host.gapLastLiToNextH2)
        ).toBeLessThanOrEqual(1);

        for (let i = 0; i < isomorphism.preview.liSectionHeights.length; i++) {
          expect(
            Math.abs(isomorphism.preview.liSectionHeights[i] - isomorphism.host.liSectionHeights[i])
          ).toBeLessThanOrEqual(1);
        }
        for (let i = 0; i < isomorphism.preview.paraHeights.length; i++) {
          expect(
            Math.abs(isomorphism.preview.paraHeights[i] - isomorphism.host.paraHeights[i])
          ).toBeLessThanOrEqual(1);
        }
      }
    } finally {
      assetStore.clear();
    }
  });
});
