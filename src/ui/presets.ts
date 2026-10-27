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
:root {
  --claude-bg-primary: #FAF8F5;
  --claude-bg-secondary: #F2EFE9;
  --claude-text-primary: #1F1E1D;
  --claude-text-secondary: #666560;
  --claude-border: #E2DFD7;
  --claude-accent: #C86446;

  /* 衬线栈：西文用 Newsreader，中文强制用思源宋体或系统宋体 */
  --font-serif: 'Newsreader', 'Noto Serif SC', 'Songti SC', 'STSong', serif;
  /* 无衬线栈：西文用 Inter，中文用苹方或微软雅黑 */
  --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
  /* 等宽栈：严格锁定等宽字体 */
  --font-mono: 'JetBrains Mono', 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
}

/* Markdown 核心渲染容器 (.morph-doc / .claude-prose)：去除局部背景色块 */
.morph-doc,
.claude-prose {
  font-family: var(--font-sans);
  font-size: 16px;
  line-height: 1.8;
  letter-spacing: 0.01em;
  color: var(--claude-text-primary);
}

/* 标题：严格使用衬线体，禁止粗体导致的黑体化 */
.morph-h1,
.morph-h2,
.claude-prose h1,
.claude-prose h2 {
  font-family: var(--font-serif);
  font-weight: 500;
  color: #141413;
  letter-spacing: -0.01em;
}

.morph-h1,
.claude-prose h1 {
  font-size: 36px;
  line-height: 1.3;
  margin-top: 0px;
  margin-bottom: 20px;
}

.morph-h2,
.claude-prose h2 {
  font-size: 24px;
  line-height: 1.4;
  margin-top: 24px;
  margin-bottom: 14px;
}

/* H3 采用无衬线紧凑排版，与 H1/H2 形成材质对比 */
.morph-h3,
.claude-prose h3 {
  font-family: var(--font-sans);
  font-size: 18px;
  font-weight: 600;
  line-height: 1.5;
  margin-top: 16px;
  margin-bottom: 10px;
  color: #141413;
}

.morph-h4,
.claude-prose h4 {
  font-family: var(--font-sans);
  font-size: 16px;
  line-height: 1.45;
  font-weight: 600;
  color: #141413;
  margin-top: 12px;
  margin-bottom: 8px;
}

/* 段落与行内样式：统一采用单向底边距 (margin-top: 0px)，消除微信非折叠容器下的双倍间距叠加 */
.morph-p,
.claude-prose p {
  margin-top: 0px;
  margin-bottom: 20px;
  line-height: 1.8;
}

strong,
.claude-prose strong {
  font-weight: 600;
  color: #141413;
}

/* 彻底禁用中文伪斜体，改用衬线体切换与克制强调色实现强调（去除难看的虚线下划线） */
em,
.claude-prose em {
  font-style: normal;
  font-family: var(--font-serif);
  color: var(--claude-accent);
}

a,
.claude-prose a {
  color: var(--claude-text-primary);
  text-decoration: none;
  border-bottom: 1px solid var(--claude-accent);
  padding-bottom: 1px;
}

a:hover,
.claude-prose a:hover {
  color: var(--claude-accent);
}

/* 引用块：取消 italic 伪斜体，使用正体衬线体与 2px 陶土色左边框，单向底边距 */
.morph-quote,
.claude-prose blockquote {
  margin-top: 0px;
  margin-right: 0px;
  margin-bottom: 24px;
  margin-left: 0px;
  padding: 4px 0px 4px 20px;
  border-left: 2px solid var(--claude-accent);
  background-color: transparent;
  font-family: var(--font-serif);
  font-style: normal;
  font-size: 16.8px;
  line-height: 1.75;
  color: #3D3C3A;
}

.morph-quote .morph-p,
.morph-quote p,
.claude-prose blockquote p {
  margin-top: 0px;
  margin-bottom: 0px;
}

.morph-quote .morph-p + .morph-p,
.morph-quote p + p {
  margin-top: 10px;
}

/* 列表 */
.morph-list,
.claude-prose ul,
.claude-prose ol {
  margin-top: 0px;
  margin-bottom: 20px;
  padding-left: 24px;
}

.morph-list li,
.claude-prose li {
  margin-top: 0px;
  margin-bottom: 8px;
  padding-left: 4px;
  line-height: 1.8;
}

/* 修复行内代码跨行折断与等宽字体丢失问题 */
:not(pre) > code,
.claude-prose :not(pre) > code {
  font-family: var(--font-mono) !important;
  font-size: 13.6px;
  background-color: #EAE6DF;
  color: #2C2B29;
  padding: 2.4px 6.4px;
  border-radius: 4px;
  white-space: nowrap;
  vertical-align: baseline;
}

/* 修复代码块字体与高饱和度配色冲突，单向底边距 */
pre.morph-code,
.claude-prose pre {
  font-family: var(--font-mono) !important;
  background-color: var(--claude-bg-secondary) !important;
  color: #2C2B29 !important;
  border: 1px solid var(--claude-border);
  border-radius: 6px;
  padding: 18px 20px;
  margin-top: 0px;
  margin-bottom: 24px;
  overflow-x: auto;
  line-height: 1.6;
  font-size: 14px;
}

pre.morph-code code,
.claude-prose pre code {
  font-family: var(--font-mono) !important;
  background-color: transparent;
  padding: 0px;
  border-radius: 0px;
  white-space: pre;
  color: #2C2B29;
  font-size: 14px;
  line-height: 1.6;
}

/* 修复 Callout 提示框圆角与左边框打架以及底部多余留白的问题，单向底边距 */
.morph-callout,
.claude-prose .callout {
  background-color: var(--claude-bg-secondary);
  border: none;
  border-left: 3px solid var(--claude-accent);
  border-radius: 0px;
  padding: 18px 20px 18px 24px;
  margin-top: 0px;
  margin-bottom: 24px;
}

.morph-callout-title,
.claude-prose .callout-title {
  font-weight: 600;
  font-size: 15.2px;
  line-height: 1.5;
  margin-bottom: 8px;
  color: #141413;
}

.morph-callout-body p,
.morph-callout-body .morph-p,
.morph-callout p:last-child,
.claude-prose .callout p:last-child {
  margin-top: 0px !important;
  margin-bottom: 0px !important;
}

/* 学术风三线表：固定列宽 (table-layout: fixed) 与单向底边距 (margin-top: 0px)，显式清除上/左/右边框 */
.morph-table,
.claude-prose table {
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  border-top: 0px solid transparent;
  border-bottom: 0px solid transparent;
  border-left: 0px solid transparent;
  border-right: 0px solid transparent;
  border-top-style: none;
  border-bottom-style: none;
  border-left-style: none;
  border-right-style: none;
  margin-top: 0px;
  margin-bottom: 24px;
  font-size: 15px;
  line-height: 1.5;
}

.morph-table thead,
.morph-table tbody,
.morph-table tr,
.claude-prose thead,
.claude-prose tbody,
.claude-prose tr {
  border-top: 0px solid transparent;
  border-bottom: 0px solid transparent;
  border-left: 0px solid transparent;
  border-right: 0px solid transparent;
  border-top-style: none;
  border-bottom-style: none;
  border-left-style: none;
  border-right-style: none;
}

.morph-table th,
.claude-prose th {
  text-align: left;
  font-weight: 600;
  padding: 12px 12px;
  border-top: 0px solid transparent;
  border-left: 0px solid transparent;
  border-right: 0px solid transparent;
  border-top-style: none;
  border-left-style: none;
  border-right-style: none;
  border-bottom: 2px solid #141413;
  background-color: transparent;
  color: #141413;
  word-break: break-word;
  overflow-wrap: break-word;
}

.morph-table td,
.claude-prose td {
  text-align: left;
  padding: 12px 12px;
  border-top: 0px solid transparent;
  border-left: 0px solid transparent;
  border-right: 0px solid transparent;
  border-top-style: none;
  border-left-style: none;
  border-right-style: none;
  border-bottom: 1px solid var(--claude-border);
  color: var(--claude-text-primary);
  vertical-align: top;
  word-break: break-word;
  overflow-wrap: break-word;
}

.morph-math-display {
  display: block;
  text-align: center;
  margin-top: 0px;
  margin-bottom: 20px;
  overflow-x: auto;
}

/* 分割线与媒体元素：单向底边距 */
hr,
.claude-prose hr {
  border: none;
  border-top: 1px solid var(--claude-border);
  margin-top: 0px;
  margin-bottom: 28px;
}

figure,
.claude-prose figure {
  margin-top: 0px;
  margin-bottom: 24px;
}

.morph-img,
.claude-prose img {
  width: 100%;
  max-width: 100%;
  height: auto;
  border-radius: 6px;
  border: 1px solid rgba(20, 20, 19, 0.08);
  display: block;
  margin-top: 0px;
  margin-bottom: 20px;
}

.morph-p > .morph-img,
.claude-prose p > img {
  margin-top: 0px;
  margin-bottom: 0px;
}

figcaption,
.claude-prose figcaption {
  margin-top: 10px;
  font-size: 14px;
  color: var(--claude-text-secondary);
  line-height: 1.4;
}
`.trim();

const YORYON_EDITORIAL_CSS = `
:root {
  --yoryon-bg: #ffffff;
  --yoryon-reading-fg: #282828;
  --yoryon-foreground: #253947;
  --yoryon-primary: #47758f;
  --yoryon-reading-muted: #6b6866;
  --yoryon-muted-fg: #607383;
  --yoryon-border: #dfeaf0;
  --yoryon-reading-surface: #f3f3f2;
  --yoryon-reading-code: #3d3936;

  /* Yoryon 书刊衬线栈：西文 Iowan Old Style / Palatino，中文宋体 / 思源宋体 */
  --yoryon-font-serif: 'Iowan Old Style', 'Iowan Old Style BT', 'Palatino Linotype', Palatino, Georgia, 'Songti SC', 'Noto Serif SC', 'Noto Serif CJK SC', 'Source Han Serif SC', 'SimSun', serif;
  /* 辅助无衬线栈：用于图注与提示框眉题 */
  --yoryon-font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', Arial, sans-serif;
  /* 等宽代码栈 */
  --yoryon-font-mono: 'SF Mono', SFMono-Regular, ui-monospace, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
}

/* Yoryon 核心阅读容器 (.morph-doc / .prose-yoryon)：全篇采用书刊衬线体，17px / 1.85 行高 */
.morph-doc,
.prose-yoryon {
  font-family: var(--yoryon-font-serif);
  font-size: 17px;
  line-height: 1.85;
  font-weight: 400;
  letter-spacing: 0em;
  color: var(--yoryon-reading-fg);
}

/* 标题：沿用书刊衬线体，字重 600，H1 居中排版 */
.morph-h1,
.prose-yoryon h1 {
  font-family: var(--yoryon-font-serif);
  font-size: 31px;
  line-height: 1.38;
  font-weight: 600;
  color: var(--yoryon-reading-fg);
  text-align: center;
  letter-spacing: 0em;
  margin-top: 0px;
  margin-bottom: 28px;
}

.morph-h2,
.prose-yoryon h2 {
  font-family: var(--yoryon-font-serif);
  font-size: 23px;
  line-height: 1.4;
  font-weight: 600;
  color: var(--yoryon-reading-fg);
  letter-spacing: 0em;
  margin-top: 24px;
  margin-bottom: 18px;
}

.morph-h3,
.prose-yoryon h3 {
  font-family: var(--yoryon-font-serif);
  font-size: 19px;
  line-height: 1.4;
  font-weight: 600;
  color: var(--yoryon-reading-fg);
  margin-top: 18px;
  margin-bottom: 14px;
}

.morph-h4,
.prose-yoryon h4 {
  font-family: var(--yoryon-font-serif);
  font-size: 17px;
  line-height: 1.45;
  font-weight: 600;
  color: var(--yoryon-reading-fg);
  margin-top: 14px;
  margin-bottom: 8px;
}

/* 段落与行内样式：单向底边距 (margin-top: 0px)，保障公众号与预览 1:1 所见即所得 */
.morph-p,
.prose-yoryon p {
  margin-top: 0px;
  margin-bottom: 20px;
  line-height: 1.85;
  color: var(--yoryon-reading-fg);
}

strong,
.prose-yoryon strong {
  font-weight: 600;
  color: var(--yoryon-reading-fg);
}

/* 中文强调禁用几何伪斜体，采用正体衬线 + Yoryon 石板蓝强调 */
em,
.prose-yoryon em {
  font-style: normal;
  font-family: var(--yoryon-font-serif);
  color: var(--yoryon-primary);
}

a,
.prose-yoryon a {
  color: var(--yoryon-primary);
  text-decoration: none;
  border-bottom: 1px solid var(--yoryon-primary);
  padding-bottom: 1px;
}

/* 引用块：2px 石板蓝左边框，无背景色，正体衬线，深石板灰蓝墨色 (#253947) */
.morph-quote,
.prose-yoryon blockquote {
  margin-top: 0px;
  margin-right: 0px;
  margin-bottom: 20px;
  margin-left: 0px;
  padding: 4px 0px 4px 18px;
  border-left: 2px solid var(--yoryon-primary);
  background-color: transparent;
  font-family: var(--yoryon-font-serif);
  font-style: normal;
  font-weight: 400;
  font-size: 17px;
  line-height: 1.85;
  color: var(--yoryon-foreground);
}

.morph-quote .morph-p,
.morph-quote p,
.prose-yoryon blockquote p {
  margin-top: 0px;
  margin-bottom: 0px;
}

.morph-quote .morph-p + .morph-p,
.morph-quote p + p {
  margin-top: 10px;
}

/* 列表 */
.morph-list,
.prose-yoryon ul,
.prose-yoryon ol {
  margin-top: 0px;
  margin-bottom: 20px;
  padding-left: 24px;
}

.morph-list li,
.prose-yoryon li {
  margin-top: 0px;
  margin-bottom: 8px;
  padding-left: 4px;
  line-height: 1.85;
}

/* 行内代码：复刻 yoryon.com #f3f3f2 浅暖灰底色与 #3d3936 深褐灰代码字色 */
:not(pre) > code,
.prose-yoryon :not(pre) > code {
  font-family: var(--yoryon-font-mono) !important;
  font-size: 14.6px;
  font-weight: 400;
  background-color: var(--yoryon-reading-surface);
  color: var(--yoryon-reading-code);
  padding: 2px 5px;
  border-radius: 3px;
  white-space: nowrap;
  vertical-align: baseline;
}

/* 代码块：复刻 yoryon.com .prose-yoryon pre (#f3f3f2 底色 + 1px #dfeaf0 边框 + 4px 圆角) */
pre.morph-code,
.prose-yoryon pre {
  font-family: var(--yoryon-font-mono) !important;
  background-color: var(--yoryon-reading-surface) !important;
  color: var(--yoryon-reading-code) !important;
  border: 1px solid var(--yoryon-border);
  border-radius: 4px;
  padding: 16px 18px;
  margin-top: 0px;
  margin-bottom: 20px;
  overflow-x: auto;
  line-height: 1.6;
  font-size: 13px;
}

pre.morph-code code,
.prose-yoryon pre code {
  font-family: var(--yoryon-font-mono) !important;
  background-color: transparent;
  padding: 0px;
  border-radius: 0px;
  white-space: pre;
  color: var(--yoryon-reading-code);
  font-size: 13px;
  line-height: 1.6;
}

/* 提示框 / 导读摘要框：复刻 yoryon.com .editorial-keypoints (#f3f3f2 底色 + 3px #47758f 左边框) */
.morph-callout,
.prose-yoryon .editorial-keypoints {
  background-color: var(--yoryon-reading-surface);
  border: none;
  border-left: 3px solid var(--yoryon-primary);
  border-radius: 6px;
  padding: 18px 20px;
  margin-top: 0px;
  margin-bottom: 24px;
}

.morph-callout-title,
.prose-yoryon .editorial-keypoints-header {
  font-family: var(--yoryon-font-sans);
  font-weight: 600;
  font-size: 13px;
  line-height: 1.6;
  letter-spacing: 0.08em;
  margin-bottom: 8px;
  color: var(--yoryon-muted-fg);
}

.morph-callout-body p,
.morph-callout-body .morph-p,
.morph-callout p:last-child,
.prose-yoryon .editorial-keypoints p:last-child {
  margin-top: 0px !important;
  margin-bottom: 0px !important;
}

/* 表格：复刻 yoryon.com --tw-prose-th-borders / --tw-prose-td-borders (#dfeaf0)，兼容公众号无网格线三线表 */
.morph-table,
.prose-yoryon table {
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  border-top: 0px solid transparent;
  border-bottom: 0px solid transparent;
  border-left: 0px solid transparent;
  border-right: 0px solid transparent;
  border-top-style: none;
  border-bottom-style: none;
  border-left-style: none;
  border-right-style: none;
  margin-top: 0px;
  margin-bottom: 24px;
  font-size: 15px;
  line-height: 1.6;
}

.morph-table thead,
.morph-table tbody,
.morph-table tr,
.prose-yoryon thead,
.prose-yoryon tbody,
.prose-yoryon tr {
  border-top: 0px solid transparent;
  border-bottom: 0px solid transparent;
  border-left: 0px solid transparent;
  border-right: 0px solid transparent;
  border-top-style: none;
  border-bottom-style: none;
  border-left-style: none;
  border-right-style: none;
}

.morph-table th,
.prose-yoryon th {
  text-align: left;
  font-weight: 600;
  padding: 10px 12px;
  border-top: 0px solid transparent;
  border-left: 0px solid transparent;
  border-right: 0px solid transparent;
  border-top-style: none;
  border-left-style: none;
  border-right-style: none;
  border-bottom: 2px solid var(--yoryon-border);
  background-color: transparent;
  color: var(--yoryon-reading-fg);
  word-break: break-word;
  overflow-wrap: break-word;
}

.morph-table td,
.prose-yoryon td {
  text-align: left;
  padding: 10px 12px;
  border-top: 0px solid transparent;
  border-left: 0px solid transparent;
  border-right: 0px solid transparent;
  border-top-style: none;
  border-left-style: none;
  border-right-style: none;
  border-bottom: 1px solid var(--yoryon-border);
  color: var(--yoryon-reading-fg);
  vertical-align: top;
  word-break: break-word;
  overflow-wrap: break-word;
}

.morph-math-display {
  display: block;
  text-align: center;
  margin-top: 0px;
  margin-bottom: 20px;
  overflow-x: auto;
}

hr,
.prose-yoryon hr {
  border: none;
  border-top: 1px solid var(--yoryon-border);
  margin-top: 0px;
  margin-bottom: 28px;
}

figure,
.prose-yoryon figure {
  margin-top: 0px;
  margin-bottom: 24px;
}

.morph-img,
.prose-yoryon img {
  width: 100%;
  max-width: 100%;
  height: auto;
  border-radius: 8px;
  border: none;
  display: block;
  margin-top: 0px;
  margin-bottom: 20px;
}

.morph-p > .morph-img,
.prose-yoryon p > img {
  margin-top: 0px;
  margin-bottom: 0px;
}

figcaption,
.prose-yoryon figcaption {
  font-family: var(--yoryon-font-sans);
  margin-top: 8px;
  font-size: 13px;
  color: var(--yoryon-reading-muted);
  line-height: 1.6;
}
`.trim();

export const DEFAULT_SAVED_CSS_PRESETS: readonly SavedCssPresetItem[] = Object.freeze([
  {
    id: 'default',
    name: 'Anthropic 学术出版',
    updatedLabel: '官方预设',
    dotColor: '#C86446',
    css: BASE_THEME_ACCENT_CSS,
  },
  {
    id: 'yoryon',
    name: 'Yoryon 书刊阅读',
    updatedLabel: '官方预设',
    dotColor: '#47758f',
    css: YORYON_EDITORIAL_CSS,
  },
]);

const ANTHROPIC_SERIF_STACK =
  "'Newsreader', 'Noto Serif SC', 'Songti SC', 'STSong', serif";
const ANTHROPIC_SANS_STACK =
  "'Inter', -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif";
const ANTHROPIC_MONO_STACK =
  "'JetBrains Mono', 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace";

export const THEME_PRESETS: Readonly<Record<ThemePresetId, ThemePresetDefinition>> = Object.freeze({
  default: {
    id: 'default',
    label: 'Anthropic 学术出版',
    description: '人文衬线与无衬线正文中英混排学术出版风',
    previewBg: '#ffffff',
    previewInk: '#1F1E1D',
    previewAccent: '#C86446',
    tokens: {
      ...DEFAULT_DESIGN_TOKENS,
      '--morph-bg': '#ffffff',
      '--morph-ink': '#1F1E1D',
      '--morph-accent': '#C86446',
      '--morph-font-sans': ANTHROPIC_SANS_STACK,
      '--morph-font-serif': ANTHROPIC_SERIF_STACK,
      '--morph-font-mono': ANTHROPIC_MONO_STACK,
      '--morph-body-size': '16px',
      '--morph-line-height': '1.8',
      '--morph-block-gap': '20px',
    },
    presetCss: BASE_THEME_ACCENT_CSS,
  },
  minimal: {
    id: 'minimal',
    label: 'Anthropic 学术出版',
    description: '人文衬线与无衬线正文中英混排学术出版风',
    previewBg: '#ffffff',
    previewInk: '#1F1E1D',
    previewAccent: '#C86446',
    tokens: {
      ...DEFAULT_DESIGN_TOKENS,
      '--morph-bg': '#ffffff',
      '--morph-ink': '#1F1E1D',
      '--morph-accent': '#C86446',
      '--morph-font-sans': ANTHROPIC_SANS_STACK,
      '--morph-font-serif': ANTHROPIC_SERIF_STACK,
      '--morph-font-mono': ANTHROPIC_MONO_STACK,
      '--morph-body-size': '16px',
      '--morph-line-height': '1.8',
      '--morph-block-gap': '20px',
    },
    presetCss: BASE_THEME_ACCENT_CSS,
  },
  magazine: {
    id: 'magazine',
    label: 'Anthropic 学术出版',
    description: '人文衬线与无衬线正文中英混排学术出版风',
    previewBg: '#ffffff',
    previewInk: '#1F1E1D',
    previewAccent: '#C86446',
    tokens: {
      ...DEFAULT_DESIGN_TOKENS,
      '--morph-bg': '#ffffff',
      '--morph-ink': '#1F1E1D',
      '--morph-accent': '#C86446',
      '--morph-font-sans': ANTHROPIC_SANS_STACK,
      '--morph-font-serif': ANTHROPIC_SERIF_STACK,
      '--morph-font-mono': ANTHROPIC_MONO_STACK,
      '--morph-body-size': '16px',
      '--morph-line-height': '1.8',
      '--morph-block-gap': '20px',
    },
    presetCss: BASE_THEME_ACCENT_CSS,
  },
  tech: {
    id: 'tech',
    label: 'Anthropic 学术出版',
    description: '人文衬线与无衬线正文中英混排学术出版风',
    previewBg: '#ffffff',
    previewInk: '#1F1E1D',
    previewAccent: '#C86446',
    tokens: {
      ...DEFAULT_DESIGN_TOKENS,
      '--morph-bg': '#ffffff',
      '--morph-ink': '#1F1E1D',
      '--morph-accent': '#C86446',
      '--morph-font-sans': ANTHROPIC_SANS_STACK,
      '--morph-font-serif': ANTHROPIC_SERIF_STACK,
      '--morph-font-mono': ANTHROPIC_MONO_STACK,
      '--morph-body-size': '16px',
      '--morph-line-height': '1.8',
      '--morph-block-gap': '20px',
    },
    presetCss: BASE_THEME_ACCENT_CSS,
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
    '一份 Markdown，**三种发布形态**。基于 *确定性 AST 编译管线* 与受控 `Design Tokens` 样式引擎，[MorphMD 跨端排版系统](https://morphmd.dev) 让每一次内容分发都保持视觉与结构同构（信息守恒率 $\\eta = 1.0$）。',
    '',
    '> 写一次，自由发布。让优秀的内容被更多人看见。',
    '',
    '## 本文要点',
    '',
    '1. **多端同构适配**：一套原稿同时面向微信公众号、X Articles 长文与多比例社交图文卡片输出。',
    '2. **受控样式内联**：自动将排版参数、主题预设与自定义 CSS 求值内联，消除宿主编辑器默认样式覆盖。',
    '3. **全样式排版体系**：完整支持多级标题、引用、提示块、代码高亮、数据表格、数学公式与图表光栅化。',
    '',
    '## 核心功能',
    '',
    '### 01 · 多平台适配',
    '',
    '微信公众号、X Articles 与图文卡片，随时切换。不同发布目标拥有独立的样式能力矩阵与块级降级策略：',
    '',
    '| 发布目标 | 样式传输机制 | 复杂块处理策略 | 典型交付产物 |',
    '| :--- | :--- | :--- | :--- |',
    '| 微信公众号 (`wechat`) | 全量受控内联 `style` | 数学公式与 SVG 转高清图 | 公众号兼容富文本 |',
    '| X 长文 (`x-article`) | 平台原生语义标签 | 表格、代码块与公式自动光栅化 | 原生富文本 + 内联图 |',
    '| 图文卡片 (`cards`) | 固定画布比例 + 内联样式 | 跨页防截断流式自动分页 | 多页 PNG 压缩包 |',
    '',
    '### 02 · 统一样式系统',
    '',
    '通过 `Design Tokens` 控制颜色、字体与段落排版，并在交付阶段自动完成 CSS 变量求值与安全净化。',
    '',
    '> [!TIP] 样式内联提示',
    '> 微信公众号编辑器会重置未显式声明字号的标题与段落。MorphMD 会在生成交付快照时将 `h1`–`h3` 字号、行高与图片圆角完整内联到标签属性上。',
    '',
    '```typescript',
    'export interface StyleInlineOptions {',
    '  targetId: "wechat" | "x-article" | "cards";',
    '  tokens: Record<`--morph-${string}`, string>;',
    '  preserveHeadingHierarchy: boolean;',
    '}',
    '```',
    '',
    '### 03 · 视觉资产与公式排版',
    '',
    `![示例图片](${coverUri})`,
    '',
    '**图 1**  本地图片资产在复制时自动转换为内联 Data URL，并注入宽高比防坍缩属性。',
    '',
    '当需要在技术专栏中表达排版评分或版面密度约束时，可以直接书写块级 LaTeX 公式：',
    '',
    '$$',
    '\\mathcal{S}_{\\text{fidelity}}(D) = \\frac{1}{|B|} \\sum_{b \\in B} \\mathbb{I}\\big(\\text{Render}_{\\text{target}}(b) \\cong \\text{Render}_{\\text{stage}}(b)\\big)',
    '$$',
    '',
    '---',
    '',
    '## 更多可能',
    '',
    '- 高质量的图文排版与多比例画布自动分页（`3:4`、`4:5`、`1:1`、`16:9`）',
    '- 右栏局部框选带样式自由复制，自动补齐祖先容器上下文',
    '- 离线优先的 `.morphpkg` 源码与二进制资产包无损导入导出',
  ].join('\n');
}
