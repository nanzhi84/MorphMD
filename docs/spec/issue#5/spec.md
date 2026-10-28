# 微信公众号与跨端排版优化：强调与外链语义、Callout 现代几何样式与微信容器保真、移动端代码块与字号适配

> **Status:** In Progress · Issue #5 · Created 2026-10-27
> **Affected Architecture:** [docs/architecture/overview.md](../../architecture/overview.md) · [ADR-0002](../../adr/0002-isomorphic-delivery-snapshot-and-asset-pipeline.md)

## 1. 背景与问题定位 (Context & Root Causes)

在微信公众号（`wechat`）实机预览与跨预设排版验收中，暴露出以下 5 项体验与兼容性问题：

1. **行内强调（`em`）与加粗（`strong`）视觉层次微调**：
   - 加粗（`strong`）保持沉稳的深黑/墨色（Anthropic `#141413` / Yoryon `#282828`），避免大面积高饱和亮色破坏阅读节奏；
   - 斜体（`em`）保持真实的斜体（`font-style: italic`），并采用**偏灰暗的低饱和主题同色系**（Anthropic `--claude-accent-muted: #8C5A4B` 灰调赤陶褐 / Yoryon `--yoryon-muted-fg: #607383` 灰暗石板蓝），温润区分强调语义而不刺眼。
2. **微信公众号不支持嵌入外部超链接**：
   - 微信公众号后台不允许普通文章嵌入非微信域名的 `<a href="...">` 外链。在 `wechat` 视图下，外链需直接降级为可读的纯文本/行内文本形式（如 `锚文本 (https://...)`），同时保留原稿完整语义与诊断信息。
3. **Callout 提示框（如 Yoryon 预设）几何畸变与字体混排割裂**：
   - 当 `.morph-callout` 同时声明四周圆角（`border-radius: 6px`）与单侧粗边框（`border-left: 3px solid`）时，浏览器在计算左边框上下内切圆弧时产生类似括弧的尖角畸变；
   - Yoryon 预设中 Callout 标题使用无衬线体（`13px`），而内部正文却继承了大行距的书刊衬线体（`17px` 宋体，`line-height: 1.85`），导致视觉割裂与松散。
4. **Callout「样式内联提示」粘贴至公众号后台后样式完全失效（无论样式预设）**：
   - [`src/core/ast/callout.ts`](../../../src/core/ast/callout.ts) 产出的 `.morph-callout`、`.morph-callout-title`、`.morph-callout-body` 均为 `<div>` 标签，且标题文本直接裸露在 `<div class="morph-callout-title">` 中；
   - 微信公众号后台编辑器（基于 ProseMirror）的粘贴解析 Schema 不将通用 `<div>` 识别为带样式的布局容器，粘贴时会直接剥离外层 `<div class="morph-callout">`（丢弃背景色、左边框与内边距），并将 `<div class="morph-callout-title">` 退化为无字重/无颜色的普通 `<p>`；
   - 此外，[`src/core/style/inliner.ts`](../../../src/core/style/inliner.ts) 的基础样式表未包含 `.morph-callout` 兜底规则，导致不含 Callout 规则的自定义预设无法内联 Callout 样式。
5. **手机端微信呈现中代码块乱行/空格拉伸，以及移动端字号偏大与表格拥挤**：
   - **代码块乱行与空格拉伸**：ProseMirror 的 `code_block` 节点在粘贴序列化为 `["pre", attrs, ["code", 0]]` 时会剥离内层 `<code>` 标签上的 `style` 属性。由于原有预设仅在 `pre code` 上声明了 `white-space: pre`，而未在 `<pre class="morph-code">` 本体及 `<span class="line">` 上内联 `white-space: pre; text-align: left; word-break: normal; overflow-wrap: normal;`，粘贴后微信移动端默认样式 `.rich_media_content pre { white-space: pre-wrap; word-wrap: break-word; }` 生效并继承了外层 `text-align: justify`，导致代码在窄屏下折行且行内空格被两端对齐强行拉开。
   - **移动端字号与四列表格拥挤**：桌面端看似合适的正文字号（`16px`–`17px`）、超大标题（`H1: 31px`–`36px`）以及表格字号（`15px` + `12px` 内边距 + `nowrap` 行内代码）在 375px 宽的手机屏幕上显得过大且拥挤，四列表格内文字被挤压为单字竖排。

---

## 2. 方案设计与契约 (Design & Contracts)

### 2.1 加粗保持深黑色、斜体保持 `italic` 并采用偏灰暗的主题色（[`src/ui/presets.ts`](../../../src/ui/presets.ts)）

- **`strong`（加粗）**：
  - `font-weight: 600;`
  - 颜色保持沉稳深黑墨色：Anthropic 预设为 `#141413`，Yoryon 预设为 `var(--yoryon-reading-fg)`（`#282828`）。
- **`em`（斜体）**：
  - 保持真实斜体 `font-style: italic;`
  - 颜色采用**偏灰暗的低饱和主题色**：Anthropic 预设为 `var(--claude-accent-muted)`（`#8C5A4B` 灰调赤陶褐），Yoryon 预设为 `var(--yoryon-muted-fg)`（`#607383` 灰暗石板蓝）。

### 2.2 微信公众号外链转文本呈现契约（[`src/core/wechat/normalizer.ts`](../../../src/core/wechat/normalizer.ts)）

- 在 `normalizeWeChatStructureAndStyles` 中处理所有 `<a href="...">` 节点：
  - 若 `href` 为外部链接（即非 `#` 页内锚点，且非 `https://mp.weixin.qq.com` 微信生态内链）：
    - 将 `<a>` 替换为 `<span class="morph-link-text" data-original-href="...">`；
    - 若锚文本（`textContent.trim()`）未包含该 URL，则以纯文本形式组合呈现为 `锚文本 (URL)`（例如 `[MorphMD 跨端排版系统](https://morphmd.dev)` 转换为 `<span class="morph-link-text" data-original-href="https://morphmd.dev">MorphMD 跨端排版系统 (https://morphmd.dev)</span>`；若锚文本本身即为该 URL，则直接显示 URL 不重复附加括号）；
    - 移除误导点击的底边框/下划线，保留主题色或正文可读色彩，并产出 `code: 'structure/wechat-external-link-degraded'`（`severity: 'info'`）诊断项。
  - `x-article` 与 `cards` 视图继续保留原生 `<a href="...">` 标签。

### 2.3 Callout 现代几何切边与统一无衬线排版（[`src/ui/presets.ts`](../../../src/ui/presets.ts) & [`src/core/style/inliner.ts`](../../../src/core/style/inliner.ts)）

- **消除圆角+粗左框尖角畸变**：
  - `.morph-callout` 统一采用**左直右圆几何切边（`border-radius: 0px 8px 8px 0px`）**配合 `3px solid` 主题色左边框，使左侧强调线保持绝对垂直利落的直角切边，右侧保持柔和圆角。
  - 在 [`src/core/style/inliner.ts`](../../../src/core/style/inliner.ts) 中增加 `border-radius` 简写属性内联保留与 `.morph-callout` / `.morph-callout-title` / `.morph-callout-body` 基础兜底样式。
- **消除衬线/无衬线混排割裂**：
  - 在 `Anthropic 学术出版` 与 `Yoryon 书刊阅读` 预设中，`.morph-callout` 容器及其内部 `.morph-callout-title`、`.morph-callout-body`、`.morph-callout-body p` **统一采用系统现代无衬线字体栈**（`var(--font-sans)` / `var(--yoryon-font-sans)`），字号设为紧凑的 `14.5px`，行高控制在 `1.65`，标题设为 `font-weight: 600; margin-bottom: 6px;`，建立清晰、现代的信息层级。

### 2.4 Callout 与普通引用块（Blockquote）微信公众号原生段落 `<p>` 容器保真与消除双左线阴影/前后莫名空行（[`src/core/wechat/normalizer.ts`](../../../src/core/wechat/normalizer.ts)、[`src/ui/presets.ts`](../../../src/ui/presets.ts) & [`src/core/ast/compiler.ts`](../../../src/core/ast/compiler.ts)）

- **转换为纯行内子节点的原生段落 `<p class="morph-callout">` 与 `<p class="morph-quote">`（彻底消除微信顶层 `<section>` 卡片前后自动加空行与 `<blockquote>` 原生 `.js_blockquote_wrap` 左竖线灰色阴影畸变）**：
  - 经实机像素级比对与源码调研确认：微信公众号后台编辑器（基于 ProseMirror）在粘贴顶层 `<div>` 时会剥离外层容器样式，而在粘贴任何带背景/边框的顶层 `<section>` 块（无论内部是否包含子块）时，均会将其视为第三方模板卡片（如 135/秀米卡片），并在该顶层 `<section>` 前后各自动插入一个用于光标落点的默认空段落（`<p><br></p>`，实测高度 `51.5 CSS px` / `103 Retina px`）；若保留为 `<blockquote>`（如普通单行/多行引用 `<blockquote class="morph-quote">`），微信编辑器又会将其转换为 `.js_blockquote_wrap` 并注入微信自带的圆角浅灰左竖线（`::before`），紧贴在我们内联的 `border-left` 右侧，视觉上造成“左竖线带一条灰色阴影/双左线”的渲染畸变；
  - 唯有 ProseMirror 原生段落节点 `<p>` 既能 100% 保留内联盒模型样式（`background-color`、`border-left`、`border-radius`、`padding`、`margin`），又**绝不会被微信编辑器注入 `.js_blockquote_wrap` 灰色阴影竖线，也绝不会在前后插入空段落**；同时由于内部子节点已全部转换为合法 HTML5 短语内容（Phrasing Content：`<span>` + `<br>`），HTML5 解析器（`parse5` / `DOMParser`）不会触发 `<p>` 自动闭合拆分：
    - `.morph-callout`：在内部子节点完成行内化后，由 `<div>` 转换为 `<p class="morph-callout ...">`，完整保留内联背景色、`border-left: 3px solid`、`border-radius: 0px 8px 8px 0px`、内边距与 `margin-top: 0px; margin-bottom: 16px;`；
    - `.morph-callout-title`：转换为行内 `<span class="morph-callout-title">`，内部包裹携带显式内联 `font-weight: 600; color: ...; font-size: 14.5px; font-family: ...; line-height: 1.9;` 的 `<span class="morph-callout-title-text">`，并在标题 `<span>` 后插入直接子节点 `<br>` 实现换行；
    - `.morph-callout-body` 及内部 `<p>`：全部转换为行内 `<span class="morph-callout-body">` 与 `<span class="morph-p">`（多段之间以直接子节点 `<br>` 分隔），显式内联 `font-family`、`font-size: 14.5px`、`line-height: 1.65` 与 `color`，确保 `<p class="morph-callout">` 内部**零 `<p>`、零 `<div>`、零 `<section>` 块级后代**；
    - `blockquote.morph-quote`（普通引用块）：在 `wechat` 视图下，只要内部不包含复杂块级结构（如 `table`、`pre`、`ul`、`ol`、`figure`、`hr`），统一将内部段落 `<p>` 转换为行内 `<span class="morph-p">`（多段之间以 `<br>` 分隔，剥离 `margin`/`padding` 并显式内联引用块的 `font-family`、`font-style: normal`、`font-size: 15px`、`line-height: 1.7` 与 `color`），并将外层 `<blockquote>` 转换为 `<p class="morph-quote">`，保留 `border-left`、`padding`、`background-color` 与 `margin-top: 0px; margin-bottom: 20px;`，确保 `<p class="morph-quote">` 内部零块级后代且在微信编辑器中不触发 `.js_blockquote_wrap` 灰色阴影线。
    - 同时在 [`src/ui/presets.ts`](../../../src/ui/presets.ts) 的 `.morph-quote .morph-p, .morph-quote p` 中显式声明引用块专属的衬线字体（`var(--font-serif)` / `var(--yoryon-font-serif)`）、字号（`15px`）、行高（`1.7`）与字色（`#3D3C3A` / `var(--yoryon-foreground)`），防止 `.morph-p` 的默认正文字体与颜色覆盖引用块内部文本。
- **彻底清除块间格式化换行文本节点（`\n`）与代码块尾部空行**：
  - 在 [`src/core/ast/compiler.ts`](../../../src/core/ast/compiler.ts) 与 [`src/core/wechat/normalizer.ts`](../../../src/core/wechat/normalizer.ts) 中，清除 `.morph-doc`、`.morph-callout`、`blockquote`、`ul`、`ol`、`figure`、`table` 等块级容器（`<pre>`/`<code>` 除外）内块级子节点之间的纯空白换行文本节点（`\n`）；
  - 在 [`src/core/ast/math-code.ts`](../../../src/core/ast/math-code.ts) 与 [`src/core/wechat/normalizer.ts`](../../../src/core/wechat/normalizer.ts) 中，剥离代码块源码末尾多余换行符及 Shiki 产出的尾部空 `<span class="line"></span>`。

### 2.5 移动端代码块防乱行、段落/列表显式排版内联与预览-公众号 1:1 间距同构（[`src/ui/presets.ts`](../../../src/ui/presets.ts)、[`src/core/style/inliner.ts`](../../../src/core/style/inliner.ts)、[`src/core/wechat/normalizer.ts`](../../../src/core/wechat/normalizer.ts) & [`src/styles/workbench.css`](../../../src/styles/workbench.css)）

1. **代码块（`pre.morph-code`）防折行与防两端对齐拉伸**：
   - 在 `pre.morph-code` 与 `pre.morph-code code` 上同时显式声明并内联：`white-space: pre; overflow-x: auto; text-align: left; word-break: normal; overflow-wrap: normal; font-size: 13px; line-height: 1.55; padding: 14px 16px;`；
   - 在 `normalizeWeChatStructureAndStyles` 中，确保每个 `<pre>`、`<pre> > code` 及 `<span class="line">` 均显式携带 `white-space: pre; text-align: left; word-break: normal; overflow-wrap: normal;`，并移除末尾空 `.line` 节点，彻底阻断微信移动端 `pre-wrap` 折行与 `text-align: justify` 空格拉伸。
2. **段落（`.morph-p`）与列表项（`li > section`）显式排版属性与底边距下沉内联**：
   - 微信公众号粘贴时会剥离最外层 `<div class="morph-doc">` 以及 `<ol>`/`<ul>`/`<li>` 上的 `style` 属性，导致未显式声明字号与字体的 `<p>` 和 `<li> > <section>` 回退为微信默认 `17px` 字号并丢失列表项间距（`6px`）与列表底边距（`16px`）；
   - 在 [`src/ui/presets.ts`](../../../src/ui/presets.ts) 与 [`src/core/style/inliner.ts`](../../../src/core/style/inliner.ts) 中，为 `.morph-p`、`.morph-list`、`.morph-list li` 显式声明 `font-family`、`font-size: 15px`、`line-height: 1.75`、`color` 与 `letter-spacing`；
   - 在 [`src/core/wechat/normalizer.ts`](../../../src/core/wechat/normalizer.ts) 的 `0.1` 列表归一阶段，将 `<li>` 的字体、字号（`15px`）、行高（`1.75`）、字色、字间距完整复制到 `<li> > <section>` 的内联 `style` 上；同时将 `<ol>`/`<ul>` 与 `<li>` 自身垂直外边距归零（`margin-top: 0px; margin-bottom: 0px;`），将列表项间距（非末项 `margin-bottom: 6px`）与顶层列表底边距（末项 `margin-bottom: 16px`）直接内联到 `<li> > <section>` 上，使预览与公众号粘贴后的列表项间距和列表尾间距 1:1 完全一致。
3. **标题与块间垂直外边距单向化及预览容器块流同构**：
   - 在 [`src/styles/workbench.css`](../../../src/styles/workbench.css) 中，将 `.morph-preview-stage[data-target-view="wechat"] .morph-doc` 由 `display: flex; flex-direction: column;` 改为 `display: flow-root;`，并在 [`src/core/wechat/normalizer.ts`](../../../src/core/wechat/normalizer.ts) 中将带 `margin-top` 的标题（`h2`/`h3`/`h4`）与其前序相邻块统一折叠规整为单向间距（前序块 `margin-bottom` 保留或由标题 `margin-top: 0px` + 前序块底边距合成，或统一在非折叠/折叠容器下保持相同像素间隙），彻底消除预览（Flex 非折叠）与公众号（Block 折叠）之间的间距偏差：
     - `.morph-h1`：`font-size: 24px; line-height: 1.35; margin-top: 0px; margin-bottom: 22px;`
     - `.morph-h2`：`font-size: 20px; line-height: 1.4; margin-top: 28px; margin-bottom: 16px;`
     - `.morph-h3`：`font-size: 17px; line-height: 1.45; margin-top: 22px; margin-bottom: 12px;`
     - `.morph-h4`：`font-size: 15.5px; line-height: 1.45; margin-top: 16px; margin-bottom: 8px;`
4. **跨端黄金字号与四列表格紧凑排版**：
   - 正文字号调整为兼顾桌面与手机阅读的 `15px`（行高 `1.75`，段落底边距 `16px`）；引用块 `15px`（行高 `1.7`，底边距 `20px`）；Callout 底边距 `16px`；
   - 表格 `.morph-table` 字号调整为 `13px`，单元格 `th`/`td` 内边距优化为 `8px 6px`，表格内行内代码 `.morph-table :not(pre) > code` 字号设为 `12px`、`padding: 1px 4px`、`white-space: normal; word-break: break-word;`，消除手机窄屏下四列表格单字竖排与括号断行。

---

## 3. 真实执行与验收标准 (Verification)

### 3.1 实施与验收 Checklist

- [x] 由独立子代理（Fresh Subagent）严格依据本 Spec 编写/更新黑盒回归测试（覆盖 `strong` 深黑与 `em` 灰暗主题色斜体、微信外链转文本呈现、Callout 与普通引用块 `.morph-quote` 纯行内 `<span>`+`<br>` 原生 `<p>` 结构且无 `<blockquote>` 双左线阴影及上下零空行、`.morph-p` 与 `li > section` 显式字号/行高/边距内联、预览与模拟微信宿主（剥离 `.morph-doc` 及 `<ol>`/`<li>` 样式后）的逐块高度与间距 1:1 同构、移动端 375px 视口代码块零折行/零拉伸及表格紧凑排版），并在实现前确认红灯失败（TDD Red Phase）。
- [x] 更新 [`src/ui/presets.ts`](../../../src/ui/presets.ts)、[`src/core/style/inliner.ts`](../../../src/core/style/inliner.ts) 与 [`src/styles/workbench.css`](../../../src/styles/workbench.css)，落地 `.morph-p`、`.morph-quote .morph-p` 与 `.morph-list li` 显式字体/字号/字色声明、标题与 Callout 间距层级及 `.morph-doc` 块级流同构。
- [x] 更新 [`src/core/ast/compiler.ts`](../../../src/core/ast/compiler.ts)、[`src/core/ast/math-code.ts`](../../../src/core/ast/math-code.ts)、[`src/core/selection/normalizer.ts`](../../../src/core/selection/normalizer.ts) 与 [`src/core/wechat/normalizer.ts`](../../../src/core/wechat/normalizer.ts)，落地 Callout 与普通引用块纯行内子节点 `<p class="morph-callout">` / `<p class="morph-quote">` 转换、`li > section` 排版与底边距下沉内联及跨块间距同构。
- [x] 通过全量黑盒测试套件、微信官方结构校验器（`verify-article-structure-spec`）、375px 手机视口与 585px 预览-微信宿主对比 Playwright 真实渲染验收、`npm run typecheck` 与 `harness doctor`。
