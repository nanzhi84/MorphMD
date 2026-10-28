# 微信公众号与跨端排版优化：强调与外链语义、Callout 现代几何样式与微信容器保真、移动端代码块与字号适配

> **Status:** In Progress · Issue #5 · Created 2026-10-27
> **Affected Architecture:** [docs/architecture/overview.md](../../architecture/overview.md) · [ADR-0002](../../adr/0002-isomorphic-delivery-snapshot-and-asset-pipeline.md)

## 1. 背景与问题定位 (Context & Root Causes)

在微信公众号（`wechat`）实机预览与跨预设排版验收中，暴露出以下 5 项体验与兼容性问题：

1. **行内强调（`em`）与超链接在色彩空间与字形特征上的解耦**：
   - 加粗（`strong`）保持沉稳的深黑/墨色（Anthropic `#141413` / Yoryon `#282828`），避免大面积高饱和亮色破坏阅读节奏；
   - 斜体（`em`）彻底剥离品牌的暖色调/主题色相（避免与超链接同色系造成视觉语义混淆），采用与正文同属黑灰中性色阶的微弱明度微调（`#32383F`）；同时由于汉字缺乏原生斜体，浏览器矩阵仿射变换（`skewX`）生成的伪斜体（Oblique）笔画僵硬，因此将 `em` 的字体栈优先指向楷体并配合西文衬线体（`font-family: "LXGW WenKai", "Kaiti SC", "STKaiti", "KaiTi", "Newsreader", Georgia, serif; font-style: normal;`），依靠楷体字形肌理在黑灰正文中形成克制而优雅的强调对比。
2. **微信公众号外链展开后的主次视觉层级解耦与纯 Web 端底边线修饰**：
   - 微信公众号后台不允许普通文章嵌入非微信域名的 `<a href="...">` 外链。在 `wechat` 视图下，外链需降级为行内文本形式 `锚文本 (https://...)`；若括号与冗长 URL 继续沿用高饱和度品牌主色，会喧宾夺主并破坏正文灰度（Typographic Gray）均衡；
   - 因此在 `wechat` 与 `cards`（图文卡片）外链降级转换时，主链接文本保留品牌主色（如 Anthropic `#B85A3A` / Yoryon `#47758f`），而将生成的 ` (URL)` 包装在独立的 `<span class="morph-link-url link-url">` 标签内，赋予低饱和度次级中性灰（`#8C857B`），字号缩小至 `0.85em` 并切换为等宽字体（Monospace）；
   - 对于保留原生 `<a>` 的 Web 场景，不加箭头伪元素，采用主色文本配合降低不透明度的下划线（`text-decoration: underline; text-decoration-color: rgba(184, 90, 58, 0.35); text-underline-offset: 4px;`）。
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

### 2.1 加粗保持深黑色、斜体（`em`）剥离暖色采用中性深灰 `#32383F` 与楷体字形对比（[`src/ui/presets.ts`](../../../src/ui/presets.ts) & [`src/core/style/inliner.ts`](../../../src/core/style/inliner.ts)）

- **`strong`（加粗）**：
  - `font-weight: 600;`
  - 颜色保持沉稳深黑墨色：Anthropic 预设为 `#141413`，Yoryon 预设为 `var(--yoryon-reading-fg)`（`#282828`）。
- **`em`（强调/斜体）**：
  - 彻底剥离品牌暖色/强调色相，采用中性深炭灰 `color: #32383F;`；
  - 字体栈优先指向楷体并取消浏览器合成伪斜体倾斜：`font-family: "LXGW WenKai", "Kaiti SC", "STKaiti", "KaiTi", "Newsreader", Georgia, serif; font-style: normal;`；
  - 在 [`src/core/wechat/normalizer.ts`](../../../src/core/wechat/normalizer.ts) 的 `#3 font-family` 白名单识别中纳入 `LXGW WenKai`、`Kaiti SC`、`STKaiti`、`KaiTi`。

### 2.2 微信公众号与图文卡片外链分级文本呈现（`.morph-link-text` + `.link-url`）与原生 `<a>` 半透明下划线契约（[`src/core/wechat/normalizer.ts`](../../../src/core/wechat/normalizer.ts)、[`src/core/cards/paginator.ts`](../../../src/core/cards/paginator.ts)、[`src/ui/presets.ts`](../../../src/ui/presets.ts) & [`src/core/style/guard.ts`](../../../src/core/style/guard.ts)）

- **原生 `<a>` 样式（不添加箭头伪元素）**：
  - Anthropic 预设：`color: #B85A3A; text-decoration: underline; text-decoration-color: rgba(184, 90, 58, 0.35); text-underline-offset: 4px; border-bottom: none;`；
  - Yoryon 预设：`color: var(--yoryon-primary); text-decoration: underline; text-decoration-color: rgba(71, 117, 143, 0.35); text-underline-offset: 4px; border-bottom: none;`；
  - 在 [`src/core/style/guard.ts`](../../../src/core/style/guard.ts) 的 `DEFAULT_ALLOWED_STYLE_PROPS` 中允许 `text-decoration-color` 与 `text-underline-offset`。
- **微信公众号（`wechat`）与图文卡片（`cards`）外链展开降级及 `.link-url` 视觉降噪**：
  - 微信公众号不允许外部超链接，而图文卡片导出为静态社交媒体图片同样无法直接点击跳转。因此在 `wechat` 与 `cards` 视图下，若 `href` 为外部链接（非 `#` 页内锚点，且在 `wechat` 下非 `https://mp.weixin.qq.com` 微信生态内链）：
    - 将 `<a>` 替换为 `<span class="morph-link-text" data-original-href="...">`，保留主链接文本的品牌色（Anthropic `#B85A3A` / Yoryon `#47758f`），并移除下划线与底边框属性（`text-decoration`、`text-decoration-color`、`text-underline-offset`、`border-bottom`）；
    - 若锚文本（`textContent.trim()`）未包含该 URL，则将追加的 ` (URL)` 包装在独立的 `<span class="morph-link-url link-url">` 子节点内，显式内联次级中性灰 `color: #8C857B;`、缩小字号 `font-size: 0.85em;`、等宽字体栈 `font-family: "JetBrains Mono", "SF Mono", SFMono-Regular, ui-monospace, Menlo, Consolas, monospace;` 与 `font-weight: 400; font-style: normal;`；在 `wechat` 下产出 `code: 'structure/wechat-external-link-degraded'`（`severity: 'info'`）诊断项。
  - `x-article` 视图继续保留原生 `<a href="...">` 标签。

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

### 2.6 X 长文复杂块浏览器端高清 Canvas 光栅化与《自定义 CSS 编写指南》纯竖向 Markdown 文档化（[`src/core/x-article/normalizer.ts`](../../../src/core/x-article/normalizer.ts)、[`src/ui/custom-css-guide.md`](../../../src/ui/custom-css-guide.md) & [`src/App.tsx`](../../../src/App.tsx)）

1. **X 长文（`x-article`）复杂块（`table`、`math`、`svg`）高清 Canvas 2D 光栅化渲染**：
   - 在真实浏览器预览与快照生成环境中（当 `HTMLCanvasElement.prototype.getContext('2d')` 可用时），摒弃原先的 5x10 像素色块占位图，使用高分屏（2x Retina）Canvas 2D 直接绘制真实可读的成品位图（`data:image/png;base64,...`）：
     - **表格（`table`）**：提取表头 `th` 与单元格 `td` 的真实文本与行内 `<code>` 节点，按列宽自动折行排版，绘制清晰的表头暖灰底色（`#F5F4F0`）、单元格边框线（`#E2DFD7`）、行内代码胶囊底色以及真实的中英文字体；
     - **数学公式（`math`）**：通过 MathJax 将 LaTeX 公式编译为自包含矢量路径（`SVG` `path` + `rect`），在 Canvas 2D 中通过 `Path2D` 递归应用 `transform`（`translate` / `scale` / `matrix`）进行高清矢量光栅化，并为行内公式标记 `data-math-display="inline"`（在预览舞台中保持行内对齐）、块级公式标记 `data-math-display="block"`（块级居中展示）；
     - **无头 JSDOM 回退**：在无 Canvas 2D 上下文的纯 JSDOM 环境中自动回退至纯 JS PNG 编码器，兼顾毫秒级测试执行与 `verifyXArticleHtml` 契约校验。
2. **《自定义 CSS 编写指南》弹窗改为标准竖向 Markdown 文档排版**：
   - 移除原有的多列横向选择器网格卡片（`.morph-guide-selector-grid`、`.morph-guide-token-list`），将指南内容抽离为独立的标准竖向 Markdown 文件 [`src/ui/custom-css-guide.md`](../../../src/ui/custom-css-guide.md)，并在弹窗（`data-testid="css-guide-modal"`）中通过 `compileMarkdownSync` 直接渲染为单栏纵向技术文档流。

### 2.7 品牌门面（`README.md` & `images/`）、工作台预览防变形布局与书刊级公开着陆页（`index.html`）

1. **工作台三栏弹性防挤压与品牌实机演示资产（`src/App.tsx`、`src/styles/workbench.css`、`images/logo.svg`、`images/demo.mp4`、`images/demo.gif`）**：
   - **工作台预览舞台防挤压变形**：在 [`src/App.tsx`](../../../src/App.tsx) 与 [`src/styles/workbench.css`](../../../src/styles/workbench.css) 中优化默认栏宽（编辑区 `360px`、右侧样式抽屉 `300px`），赋予中间预览区（`.morph-preview-pane`）主优占宽度（`flex: 1 1 560px; min-width: 520px;`），两侧栏允许随窄视口弹性收缩（`flex: 0 1 auto`）；所有工具栏按钮与子标签（`.morph-subtab`、`.morph-target-tab`）强制 `white-space: nowrap; flex-shrink: 0;` 杜绝竖向折行；公众号画布内边距采用自适应 `padding: 36px clamp(24px, 6%, 66.5px);`，图文卡片采用安全居中布局杜绝左右裁切；
   - **`images/logo.svg`**：采用 Claude 暖纸 Squircle 底座（`#FAF9F5` → `#EAE2D2`）、深炭墨色线条（`#141413`）与 Anthropic 赤陶色星芒点缀（`#D97757`），呈现左侧 Markdown 原稿通过星芒转化为三端发布形态（公众号、X 长文、图文卡片）的矢量品牌标志；
   - **`images/demo.mp4` 与 `images/demo.gif`**：在 `1440×900`（`16:10` 宽屏高分比）视口下基于真实浏览器录制：先以舒展的双栏布局（编辑区 + 宽幅预览舞台）依次演示「微信公众号」585px 书刊排版、「X 长文」2x Retina 表格与公式光栅化、「图文卡片」3:4 完整无裁切卡片切页，随后按需展开右侧「样式设置」抽屉切换「Anthropic 学术出版」与「Yoryon 书刊阅读」预设并展示自定义 CSS 编写指南，画面比例端正、零挤压变形。
2. **`README.md` 门面重构（借鉴 `Glint` 门面组织模式并与 `AGENTS.md` 约定对齐）**：
   - 顶部 `<div align="center">` 居中展示 `images/logo.svg`、`# MorphMD`、核心定位副标题、架构亮点简介、Shields.io 徽章组以及指向 `images/demo.mp4` 的无拉伸 `images/demo.gif` 宽屏演示画框；
   - 正文保持 `## Core ideas`（核心理念列表 + 三端目标与交互能力矩阵表）、`## Get started`（三步快速启动与使用指南）、`## Learn more`（工程规范、架构现状、ADR 与变更记录导航）三段式结构，严禁混入外部仓库作者残留标识。
3. **书刊出版工作室风公开着陆页（`index.html`）与工作台无缝切换（拒绝 1:1 复刻插件模板，构建 MorphMD 原生排版美学）**：
   - 在 `index.html` 中构建专属于多渠道排版工作台的暖米白书刊风（`#FAF9F5` / `#F5F4EF` + 赤陶色 `#D97757` + 雾凇蓝 `#4A6B82` + 衬线标题与明暗主题/中英双语切换）产品公开页，严禁照搬第三方插件的 LLM 服务商盒子（`.providers-box`）、波浪底线或外部作者署名，且所有首屏与屏下区块默认保持 `100%` 可见（禁止未滚动时空白隐身）：
     - **工作室顶栏（`<header class="site-header">`）**：品牌 Logo、区块锚点导航、中/英双语切换（`#lang-toggle-btn`）、明/暗主题切换（`#theme-toggle-btn`）、GitHub 链接与「进入工作台」快捷入口；
     - **书刊风 Hero 首屏（`.hero-section`）**：杂志风导语标签、衬线主副标题、主次行动按钮（`#launch-workbench-btn`、三端沙盒跳转、GitHub 源码），以及 `16:10` 原生比例无变形展示 `images/demo.mp4` 的实机画框（`.hero-showcase` 内含 `video.showcase-video`）；
     - **左右分栏「一源三态」实时编译交互沙盒（`.isomorphic-studio-section` / `.hero-interactive-preview`）**：左栏展示真实的 `article.md` 原稿代码（含标题、楷体强调、外链、行内公式与引用块），右栏提供「微信公众号 / X 长文 / 图文卡片」三端切换按钮（`#demo-btn-wechat`、`#demo-btn-x`、`#demo-btn-cards`）与对应的真实 DOM 编译预览面板（`#demo-output-wechat`、`#demo-output-x`、`#demo-output-cards`）；
     - **四大核心排版架构 Bento 矩阵（`#why-morphmd` / `.why-section`）**：4 张精炼架构卡片（`.feature-card`，中文说明控制在 20–62 字）；
     - **核心编译管线深度剖析（`#walkthrough` / `.walkthrough-section`）**：4 组单层视觉剖析（`.walkthrough-row`），分别展示微信公众号白名单内联与外链展开、X 长文复杂块 2x Retina 光栅化、多比例卡片回溯分页与 CSS-Tree 双官方预设（`Anthropic 学术出版` / `Yoryon 书刊阅读`）；
     - **快速上手指南（`#install-guide`）与纯净页脚（`.site-footer`）**：提供 3 步引导卡片（`.install-step-card`），保留 `<div id="root"></div>` 支持一键无缝切换至在线 React 工作台。

---

## 3. 真实执行与验收标准 (Verification)

### 3.1 实施与验收 Checklist

- [x] 由独立子代理（Fresh Subagent）严格依据本 Spec 编写/更新黑盒回归测试（覆盖 `strong` 深黑与 `em` 中性深灰 `#32383F` + 楷体 `font-style: normal`、微信外链转文本呈现 `.morph-link-text` + `.link-url` 次级中性灰 `#8C857B` / `0.85em` 等宽字体、Callout 与普通引用块 `.morph-quote` 纯行内 `<span>`+`<br>` 原生 `<p>` 结构且无 `<blockquote>` 双左线阴影及上下零空行、`.morph-p` 与 `li > section` 显式字号/行高/边距内联、预览与模拟微信宿主（剥离 `.morph-doc` 及 `<ol>`/`<li>` 样式后）的逐块高度与间距 1:1 同构、移动端 375px 视口代码块零折行/零拉伸及表格紧凑排版），并在实现前确认红灯失败（TDD Red Phase）。
- [x] 更新 [`src/ui/presets.ts`](../../../src/ui/presets.ts)、[`src/core/style/inliner.ts`](../../../src/core/style/inliner.ts) 与 [`src/styles/workbench.css`](../../../src/styles/workbench.css)，落地 `.morph-p`、`.morph-quote .morph-p` 与 `.morph-list li` 显式字体/字号/字色声明、标题与 Callout 间距层级及 `.morph-doc` 块级流同构。
- [x] 更新 [`src/core/ast/compiler.ts`](../../../src/core/ast/compiler.ts)、[`src/core/ast/math-code.ts`](../../../src/core/ast/math-code.ts)、[`src/core/selection/normalizer.ts`](../../../src/core/selection/normalizer.ts) 与 [`src/core/wechat/normalizer.ts`](../../../src/core/wechat/normalizer.ts)，落地 Callout 与普通引用块纯行内子节点 `<p class="morph-callout">` / `<p class="morph-quote">` 转换、`li > section` 排版与底边距下沉内联及跨块间距同构。
- [x] 通过全量黑盒测试套件、微信官方结构校验器（`verify-article-structure-spec`）、375px 手机视口与 585px 预览-微信宿主对比 Playwright 真实渲染验收、`npm run typecheck` 与 `harness doctor`。
