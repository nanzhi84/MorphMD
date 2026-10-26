import { encodeRgbPngBytes } from '../core/dom/binary';
import { DEFAULT_DESIGN_TOKENS, type DesignTokens } from '../core/style/tokens';

export type ThemePresetId = 'default' | 'minimal' | 'magazine' | 'tech';

export interface ThemePresetDefinition {
  id: ThemePresetId;
  label: string;
  description: string;
  previewBg: string;
  previewInk: string;
  previewAccent: string;
  darkPreview?: boolean;
  tokens: DesignTokens;
  presetCss: string;
}

export interface AccentSwatchItem {
  hex: string;
  label: string;
}

/**
 * Notion-aligned accent color palette (strictly zero purple).
 */
export const NOTION_ACCENT_SWATCHES: readonly AccentSwatchItem[] = Object.freeze([
  { hex: '#37352f', label: '经典炭黑' },
  { hex: '#2383e2', label: 'Notion 蓝' },
  { hex: '#0f7b6c', label: '松石绿' },
  { hex: '#d9730d', label: '琥珀橙' },
  { hex: '#c4554d', label: '陶土红' },
  { hex: '#64645e', label: '暖岩灰' },
]);

export const FONT_SANS_OPTIONS = Object.freeze([
  {
    label: '系统默认 (PingFang SC)',
    value: 'mp-quote, PingFang SC, system-ui, -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif',
  },
  {
    label: '现代无衬线 (Inter / Noto Sans)',
    value: 'mp-quote, PingFang SC, system-ui, -apple-system, "Inter", "Noto Sans SC", sans-serif',
  },
  {
    label: '人文雅黑 (Source Han Sans)',
    value: 'mp-quote, PingFang SC, system-ui, -apple-system, "Source Han Sans SC", sans-serif',
  },
]);

export const FONT_SERIF_OPTIONS = Object.freeze([
  {
    label: 'Inter / 现代标题',
    value: 'mp-quote, PingFang SC, system-ui, -apple-system, "Inter", sans-serif',
  },
  {
    label: '人文衬线 (Source Serif 4)',
    value: 'mp-quote, PingFang SC, system-ui, -apple-system, "Source Serif 4", "Songti SC", Georgia, serif',
  },
  {
    label: '书刊宋体 (STSong / Georgia)',
    value: 'mp-quote, PingFang SC, system-ui, -apple-system, "STSong", Georgia, serif',
  },
]);

export const FONT_MONO_OPTIONS = Object.freeze([
  {
    label: 'JetBrains Mono',
    value: 'mp-quote, PingFang SC, system-ui, -apple-system, "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  },
  {
    label: 'SF Mono / Menlo',
    value: 'mp-quote, PingFang SC, system-ui, -apple-system, ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
  },
  {
    label: 'Fira Code',
    value: 'mp-quote, PingFang SC, system-ui, -apple-system, "Fira Code", Consolas, monospace',
  },
]);

export type PaperPresetId = 'pure' | 'warm' | 'sepia' | 'dark';

export interface PaperPresetItem {
  id: PaperPresetId;
  label: string;
  bg: string;
  ink: string;
  quoteBg: string;
}

export const PAPER_SURFACE_PRESETS: readonly PaperPresetItem[] = Object.freeze([
  { id: 'pure', label: '纯白纸张', bg: '#ffffff', ink: '#37352f', quoteBg: '#f7f7f5' },
  { id: 'warm', label: 'Notion 暖白', bg: '#fbfbf9', ink: '#37352f', quoteBg: '#f1f1ef' },
  { id: 'sepia', label: '羊皮护眼', bg: '#f6f1e7', ink: '#2c2520', quoteBg: '#ede6d8' },
  { id: 'dark', label: '深色极客', bg: '#191919', ink: '#e6e6e4', quoteBg: '#262626' },
]);

export type HeadingStyleId = 'bar' | 'underline' | 'pill' | 'plain';

export const HEADING_STYLE_OPTIONS: ReadonlyArray<{ id: HeadingStyleId; label: string; css: string }> =
  Object.freeze([
    {
      id: 'bar',
      label: '左侧竖线强调',
      css: '.morph-h2 { border-left: 3px solid var(--morph-accent); padding-left: 10px; }',
    },
    {
      id: 'underline',
      label: '底部细线分割',
      css: '.morph-h2 { border-bottom: 1px solid #e9e9e7; padding-bottom: 6px; }',
    },
    {
      id: 'pill',
      label: '暖灰胶囊背景',
      css: '.morph-h2 { background-color: #f1f1ef; padding: 6px 12px; border-radius: 6px; }',
    },
    {
      id: 'plain',
      label: '极简无修饰',
      css: '',
    },
  ]);

export type QuoteStyleId = 'classic' | 'boxed' | 'minimal';

export const QUOTE_STYLE_OPTIONS: ReadonlyArray<{ id: QuoteStyleId; label: string; css: string }> =
  Object.freeze([
    {
      id: 'classic',
      label: '经典左框暖底',
      css: '.morph-quote { border-left: 3px solid var(--morph-accent); background-color: #f7f7f5; padding: 12px 16px; border-radius: 4px; }',
    },
    {
      id: 'boxed',
      label: '卡片圆角边框',
      css: '.morph-quote { border: 1px solid #e9e9e7; border-left: 4px solid var(--morph-accent); background-color: #ffffff; padding: 14px 16px; border-radius: 8px; }',
    },
    {
      id: 'minimal',
      label: '极简缩进引文',
      css: '.morph-quote { border-left: 2px solid #d4d3cf; background-color: transparent; padding: 4px 14px; }',
    },
  ]);

export type ImageRadiusId = '0px' | '8px' | '14px';

export const IMAGE_RADIUS_OPTIONS: ReadonlyArray<{ id: ImageRadiusId; label: string; css: string }> =
  Object.freeze([
    { id: '8px', label: '标准圆角 (8px)', css: '.morph-img { border-radius: 8px; }' },
    { id: '0px', label: '利落直角 (0px)', css: '.morph-img { border-radius: 0px; }' },
    { id: '14px', label: '柔和画框 (14px)', css: '.morph-img { border-radius: 14px; }' },
  ]);

export type HeadingScaleId = 'compact' | 'standard' | 'airy';

export const HEADING_SCALE_OPTIONS: ReadonlyArray<{ id: HeadingScaleId; label: string; css: string }> =
  Object.freeze([
    {
      id: 'standard',
      label: '标准层级 (1.4x)',
      css: '.morph-h1 { font-size: 1.65em; } .morph-h2 { font-size: 1.35em; } .morph-h3 { font-size: 1.15em; }',
    },
    {
      id: 'compact',
      label: '紧凑内敛 (1.25x)',
      css: '.morph-h1 { font-size: 1.45em; } .morph-h2 { font-size: 1.22em; } .morph-h3 { font-size: 1.08em; }',
    },
    {
      id: 'airy',
      label: '舒展张力 (1.6x)',
      css: '.morph-h1 { font-size: 1.85em; } .morph-h2 { font-size: 1.48em; } .morph-h3 { font-size: 1.22em; }',
    },
  ]);

export interface CssSnippetItem {
  id: string;
  testId: string;
  label: string;
  description: string;
  css: string;
}

export const CUSTOM_CSS_SNIPPETS: readonly CssSnippetItem[] = Object.freeze([
  {
    id: 'highlight',
    testId: 'css-snippet-highlight',
    label: '荧光笔重点高亮',
    description: '为粗体文字添加暖琥珀底色标记',
    css: 'strong { background-color: #faebdd; padding: 1px 4px; border-radius: 3px; color: #37352f; }',
  },
  {
    id: 'h2-pill',
    testId: 'css-snippet-h2-pill',
    label: 'H2 编号胶囊',
    description: '将二级标题渲染为圆角胶囊标签',
    css: '.morph-h2 { background-color: #f1f1ef; padding: 5px 12px; border-radius: 6px; }',
  },
  {
    id: 'quote-mark',
    testId: 'css-snippet-quote-mark',
    label: '引用块装饰前缀',
    description: '使用 ::before 伪元素注入引号前缀',
    css: '.morph-quote::before { content: "“ "; font-weight: 700; color: var(--morph-accent); }',
  },
  {
    id: 'img-frame',
    testId: 'css-snippet-img-frame',
    label: '图片画框留白',
    description: '为插图增加细边框与相纸留白内边距',
    css: '.morph-img { padding: 6px; border: 1px solid #e9e9e7; background-color: #ffffff; border-radius: 8px; }',
  },
  {
    id: 'table-zebra',
    testId: 'css-snippet-table-zebra',
    label: '代码块暖灰衬底',
    description: '为代码块添加 Notion 风格暖灰边框衬底',
    css: '.morph-code { background-color: #f7f7f5; border: 1px solid #e9e9e7; border-radius: 6px; padding: 12px; }',
  },
  {
    id: 'hr-dots',
    testId: 'css-snippet-hr-dots',
    label: '章节分割虚线',
    description: '定制水平分割线间距与柔和线条',
    css: '.morph-hr { border-top: 1px dashed #d4d3cf; margin: 24px 0; }',
  },
]);

export const CSS_SELECTOR_REFERENCE = Object.freeze([
  { token: '.morph-h1', label: '一级标题' },
  { token: '.morph-h2', label: '二级标题' },
  { token: '.morph-h3', label: '三级标题' },
  { token: '.morph-p', label: '正文段落' },
  { token: '.morph-quote', label: '引用容器' },
  { token: '.morph-code', label: '代码块' },
  { token: '.morph-img', label: '文章插图' },
  { token: '.morph-doc', label: '文档容器' },
  { token: 'var(--morph-accent)', label: '主题色变量' },
  { token: 'var(--morph-ink)', label: '正文墨水色' },
]);

export interface SavedCssPresetItem {
  id: string;
  name: string;
  updatedLabel: string;
  dotColor: string;
  css: string;
}

export const DEFAULT_SAVED_CSS_PRESETS: readonly SavedCssPresetItem[] = Object.freeze([
  {
    id: 'default',
    name: '默认样式',
    updatedLabel: '3 小时前更新',
    dotColor: '#37352f',
    css: '.morph-h2 {\n  border-left: 3px solid var(--morph-accent);\n  padding-left: 10px;\n}',
  },
  {
    id: 'reading',
    name: '阅读增强',
    updatedLabel: '2026-10-20',
    dotColor: '#0f7b6c',
    css: '.morph-h2 {\n  border-left: 3px solid var(--morph-accent);\n  padding-left: 10px;\n}\n\n.morph-p {\n  line-height: 1.95;\n}\n\nstrong {\n  background-color: #faebdd;\n  padding: 1px 4px;\n  border-radius: 3px;\n}',
  },
  {
    id: 'minimal',
    name: '极简灰调',
    updatedLabel: '2026-10-15',
    dotColor: '#64645e',
    css: '.morph-h2 {\n  border-bottom: 1px solid #e9e9e7;\n  padding-bottom: 6px;\n}\n\n.morph-quote {\n  border-left: 2px solid #9b9a97;\n  background-color: transparent;\n}',
  },
  {
    id: 'editorial',
    name: '社论引文',
    updatedLabel: '2026-10-10',
    dotColor: '#d9730d',
    css: '.morph-h1 {\n  border-bottom: 2px solid var(--morph-accent);\n  padding-bottom: 8px;\n}\n\n.morph-quote {\n  border: 1px solid #e9e9e7;\n  border-left: 4px solid var(--morph-accent);\n  border-radius: 8px;\n}',
  },
]);

export const CSS_TUTORIAL_GUIDE_LINES: readonly string[] = Object.freeze([
  '/* 在这里编写自定义 CSS */',
  '/* 示例：为二级标题添加左侧强调线 */',
  '',
  '.morph-h2 {',
  '  border-left: 3px solid var(--morph-accent);',
  '  padding-left: 10px;',
  '  margin: 16px 0;',
  '}',
]);

const BASE_THEME_ACCENT_CSS = `
.morph-h1 {
  font-weight: 700;
  letter-spacing: -0.02em;
  margin-bottom: 0.75em;
}
.morph-h2 {
  font-weight: 600;
  margin-top: 1.4em;
  margin-bottom: 0.6em;
}
.morph-h3 {
  font-weight: 600;
  color: var(--morph-accent);
  margin-top: 1.1em;
  margin-bottom: 0.4em;
}
.morph-quote {
  border-left: 3px solid var(--morph-accent);
  background-color: #f7f7f5;
  padding: 12px 16px;
  border-radius: 4px;
  color: #5a5852;
}
strong {
  color: var(--morph-accent);
  font-weight: 600;
}
a {
  color: var(--morph-accent);
  text-decoration: underline;
}
`.trim();

export const THEME_PRESETS: Readonly<Record<ThemePresetId, ThemePresetDefinition>> = Object.freeze({
  default: {
    id: 'default',
    label: '默认',
    description: 'Notion 经典炭黑',
    previewBg: '#ffffff',
    previewInk: '#37352f',
    previewAccent: '#37352f',
    tokens: {
      ...DEFAULT_DESIGN_TOKENS,
      '--morph-bg': '#ffffff',
      '--morph-ink': '#37352f',
      '--morph-accent': '#37352f',
      '--morph-font-sans': FONT_SANS_OPTIONS[0].value,
      '--morph-font-serif': FONT_SERIF_OPTIONS[0].value,
      '--morph-font-mono': FONT_MONO_OPTIONS[0].value,
      '--morph-body-size': '15px',
      '--morph-line-height': '1.8',
      '--morph-block-gap': '16px',
    },
    presetCss: BASE_THEME_ACCENT_CSS,
  },
  minimal: {
    id: 'minimal',
    label: '简约',
    description: '轻盈暖灰留白',
    previewBg: '#fbfbfa',
    previewInk: '#2f2e2b',
    previewAccent: '#64645e',
    tokens: {
      ...DEFAULT_DESIGN_TOKENS,
      '--morph-bg': '#fbfbfa',
      '--morph-ink': '#2f2e2b',
      '--morph-accent': '#64645e',
      '--morph-font-sans': FONT_SANS_OPTIONS[1].value,
      '--morph-font-serif': FONT_SERIF_OPTIONS[0].value,
      '--morph-font-mono': FONT_MONO_OPTIONS[1].value,
      '--morph-body-size': '15px',
      '--morph-line-height': '1.85',
      '--morph-block-gap': '18px',
    },
    presetCss: `${BASE_THEME_ACCENT_CSS}\n.morph-h2 { border-bottom: 1px solid #e9e9e7; padding-bottom: 6px; }`,
  },
  magazine: {
    id: 'magazine',
    label: '杂志',
    description: '人文衬线社论风',
    previewBg: '#fffdf9',
    previewInk: '#2c2520',
    previewAccent: '#c4554d',
    tokens: {
      ...DEFAULT_DESIGN_TOKENS,
      '--morph-bg': '#fffdf9',
      '--morph-ink': '#2c2520',
      '--morph-accent': '#c4554d',
      '--morph-font-sans': FONT_SANS_OPTIONS[0].value,
      '--morph-font-serif': FONT_SERIF_OPTIONS[1].value,
      '--morph-font-mono': FONT_MONO_OPTIONS[0].value,
      '--morph-body-size': '16px',
      '--morph-line-height': '1.9',
      '--morph-block-gap': '18px',
    },
    presetCss: `${BASE_THEME_ACCENT_CSS}\n.morph-h1 { border-bottom: 2px solid var(--morph-accent); padding-bottom: 8px; }`,
  },
  tech: {
    id: 'tech',
    label: '科技',
    description: '利落深石板蓝',
    previewBg: '#0f172a',
    previewInk: '#1f2328',
    previewAccent: '#2383e2',
    darkPreview: true,
    tokens: {
      ...DEFAULT_DESIGN_TOKENS,
      '--morph-bg': '#ffffff',
      '--morph-ink': '#1f2328',
      '--morph-accent': '#2383e2',
      '--morph-font-sans': FONT_SANS_OPTIONS[1].value,
      '--morph-font-serif': FONT_SERIF_OPTIONS[0].value,
      '--morph-font-mono': FONT_MONO_OPTIONS[0].value,
      '--morph-body-size': '15px',
      '--morph-line-height': '1.75',
      '--morph-block-gap': '16px',
    },
    presetCss: `${BASE_THEME_ACCENT_CSS}\n.morph-quote { background-color: #f0f6fc; border-left: 3px solid var(--morph-accent); }`,
  },
});

let cachedShowcaseCoverPng: Uint8Array | null = null;

/**
 * Generates a warm alpine sunset mountain landscape PNG (matching the reference preview artwork)
 * with zero external network requests.
 */
export function createShowcaseCoverPng(width = 360, height = 160): Uint8Array {
  if (cachedShowcaseCoverPng && width === 360 && height === 160) {
    return cachedShowcaseCoverPng;
  }

  const stride = width * 3 + 1;
  const rawRows = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const ny = y / Math.max(1, height - 1);
    const nxCenter = 0.52;
    const rowStart = y * stride;
    rawRows[rowStart] = 0; // PNG Filter type 0 (None)

    for (let x = 0; x < width; x++) {
      const nx = x / Math.max(1, width - 1);
      const idx = rowStart + 1 + x * 3;

      // Sky gradient: warm twilight slate at top -> golden apricot horizon
      let r = Math.round(92 + ny * 150);
      let g = Math.round(104 + ny * 76);
      let b = Math.round(138 - ny * 24);

      // Subtle glowing sunset aura near horizon
      const dx = nx - nxCenter;
      const dy = ny - 0.58;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 0.35) {
        const glow = (0.35 - dist) / 0.35;
        r = Math.min(255, Math.round(r + glow * 38));
        g = Math.min(255, Math.round(g + glow * 22));
      }

      // Far mountain ridge (alpenglow lit peaks)
      const ridge1 =
        0.54 -
        0.16 * Math.exp(-Math.pow((nx - 0.36) / 0.14, 2)) -
        0.22 * Math.exp(-Math.pow((nx - 0.62) / 0.16, 2)) -
        0.08 * Math.exp(-Math.pow((nx - 0.18) / 0.11, 2)) +
        0.015 * Math.sin(nx * 28);

      // Foreground silhouette ridge
      const ridge2 =
        0.72 -
        0.14 * Math.exp(-Math.pow((nx - 0.25) / 0.18, 2)) -
        0.18 * Math.exp(-Math.pow((nx - 0.76) / 0.15, 2)) +
        0.012 * Math.cos(nx * 22);

      if (ny >= ridge2) {
        // Deep charcoal-indigo foreground shadow
        r = 38;
        g = 41;
        b = 54;
      } else if (ny >= ridge1) {
        // Sunlit warm terracotta/amber eastern slope vs cool slate western shadow
        const isSunlitSlope = (nx > 0.28 && nx < 0.37) || (nx > 0.52 && nx < 0.63);
        if (isSunlitSlope) {
          r = 218;
          g = 132;
          b = 98;
        } else {
          r = 68;
          g = 72;
          b = 92;
        }
      }

      rawRows[idx] = r;
      rawRows[idx + 1] = g;
      rawRows[idx + 2] = b;
    }
  }

  const encoded = encodeRgbPngBytes(width, height, rawRows);
  if (width === 360 && height === 160) {
    cachedShowcaseCoverPng = encoded;
  }
  return encoded;
}

export function buildDefaultShowcaseMarkdown(coverUri = 'morph-asset://cover-1'): string {
  return [
    '# 让内容自由流动',
    '',
    '一份 Markdown，**三种发布形态**。从写作到排版，从创作到发布，MorphMD 让每一次内容分发都变得简单。',
    '',
    '> 写一次，自由发布。让优秀的内容被更多人看见。',
    '',
    '## 核心功能',
    '',
    '### 01 · 多平台适配',
    '微信公众号、X Articles 与图文卡片，随时切换。',
    '',
    '### 02 · 统一样式系统',
    '通过 Design Tokens 控制颜色、字体与段落排版。',
    '',
    `![示例图片](${coverUri})`,
    '',
    '## 更多可能',
    '',
    '- 高质量的图文排版与自动分页',
    '- 右栏局部框选带样式自由复制',
  ].join('\n');
}
