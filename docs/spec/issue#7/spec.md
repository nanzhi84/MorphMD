# X Articles 图文、代码块、数学公式与提示块粘贴渲染全面修复

> **Status:** In Progress · Issue #7 · Created 2026-10-28
> **Affected Architecture:** [docs/architecture/overview.md](../../architecture/overview.md) · [ADR-0002](../../adr/0002-isomorphic-delivery-snapshot-and-asset-pipeline.md)

## 1. 背景与问题根因分析 (Context & Root Causes)

在 `https://x.com/compose/article` 真实编辑器中粘贴默认示例长文并运行油猴脚本实测后，暴露出以下四类严重的排版与上传问题：

1. **行内数学公式（Inline Math，如 `$\eta = 1.0$`）截断段落并变为空行**：
   - X Articles 的 `MEDIA` 实体仅支持全宽独立原子块（`type: 'atomic'`），不支持在正文句子内部嵌入行内图片。
   - 此前油猴脚本将段落内的行内公式 `<img data-math-display="inline">` 视为待上传块级图片，并在 `<p>` 内部替换为 `<p>[[MORPH_IMG_SLOT_0]]</p>`，导致原段落 `<p>...（信息守恒率 $...$）。</p>` 被浏览器 HTML 解析器强行拆碎为三段并留下空白断行。
2. **多张块级图片仅最后一张上传成功，前序表格图与配图全部丢失并残留空行**：
   - X Articles 的 `handlePastedFiles` 是异步管线（读取位图、生成本地预览及向 `upload.x.com` 上传并异步调用 `insertAtomicBlock` 更新 `EditorState`）。
   - 此前脚本按正序（`0 -> N-1`）仅固定 `sleep(520)` 就立即移动选区并调用 `execCommand('delete')` 与下一次 `paste`，在上一张图片尚未挂载入 DOM 前就覆写了 Draft.js `EditorState`，导致前序图片全部被中断吞没，仅有循环最后一次粘贴（块级公式图）存活。
   - 同时，将占位符放在独立的 `<p>` 块中并在其内部触发 `AtomicBlockUtils.insertAtomicBlock` 时，Draft.js 的 `splitBlock` 会将该空块切分为上下两个空块，导致图片上方永久残留多余空行。
3. **块级数学公式（Display Math）与矮表格在 X 中被放大并左右裁切（`y(D) = ... Render_sta`）**：
   - X Articles 媒体容器（`[data-testid="tweetPhoto"]`）会将上传图片横向拉伸至 100% 正文栏宽（约 `602px~680px`），并对宽高比超过 `5 : 1`（`width / height > 5.0`）的横幅图片强制应用 `object-fit: cover` 居中裁切。
   - 此前 `renderMathToCanvasDataUrl` 生成的块级公式位图尺寸为 `502 × 74`（宽高比 `6.78 : 1 > 5.0 : 1`），被 X 容器按最小高度放大 `1.63x` 后左右各裁切了约 `16.5%`，导致公式首尾字符被截断且字号过大。
4. **代码块（`<pre><code>`）退化为多行普通正文，Callout 标题与正文粘连**：
   - X Articles 的 `blockRenderMap` 在 HTML 粘贴路径下不识别 `<pre>`，直接粘贴 `<pre><code>` 会按换行符拆成多段毫无代码框与语法高亮的普通正文（`unstyled`）。
   - `<blockquote>` 内嵌套多个 `<p>`（如 Callout 的 `<p><strong>标题</strong></p><p>正文</p>`）时，X 粘贴处理器会剥离内层 `<p>` 且不插入换行符，导致标题与正文直接粘连在同一行（`样式内联提示微信公众号编辑器...`）。

---

## 2. 方案设计与技术契约 (Design & Contracts)

### 2.1 块级公式与表格画布防裁切及 1:1 栏宽契约（[`src/core/x-article/normalizer.ts`](../../../src/core/x-article/normalizer.ts)）

1. **块级公式画布（`renderMathToCanvasDataUrl`，`isDisplay === true`）**：
   - 画布 CSS 宽度固定为 `cssWidth = 680`（2x DPR 物理宽度 `1360px`），与正文栏宽严格 1:1 对齐，杜绝 X 放大图片导致公式字号膨胀；
   - 若超长公式 `drawW > 616`（`680 - 64`），按 `616 / drawW` 等比缩放 `drawW` 与 `drawH`，确保左右两侧始终保留至少 `32px` 安全留白；
   - 画布 CSS 高度设为 `cssHeight = Math.max(drawH + 48, 176)`，使宽高比稳定满足 `680 / cssHeight <= 3.86 : 1 < 5.0 : 1`，彻底消除 X `object-fit: cover` 左右裁切；
   - 在画布内绘制柔和学术公式卡片衬底并将公式水平、垂直双向居中。
2. **表格画布（`renderTableToCanvasDataUrl`）**：
   - 画布 CSS 宽度固定为 `w = 680`，画布总 CSS 高度设为 `canvasH = Math.max(totalH, 176)`（宽高比 $\le 3.86 : 1$），当表格行数较少（`totalH < 176`）时在白色画布上垂直居中绘制表格，防止矮表格被 X 裁切。

### 2.2 代码语言别名支持（[`src/core/ast/math-code.ts`](../../../src/core/ast/math-code.ts)）

- 新增 `LANG_ALIASES` 映射表（`ts` $\rightarrow$ `typescript`、`js` $\rightarrow$ `javascript`、`py` $\rightarrow$ `python`、`yml` $\rightarrow$ `yaml`、`shell`/`zsh` $\rightarrow$ `bash`），确保 ```` ```ts ````、```` ```js ````、```` ```py ```` 等常用简写均能命中 Shiki 高亮器而不触发 `code/unknown-language` 降级。

### 2.3 X Articles 粘贴拦截器全链路升级（[`public/morphmd-x-paste.user.js`](../../../public/morphmd-x-paste.user.js)）

1. **行内公式原位转 Unicode 数学文本（`texToInlineUnicode`）**：
   - 对所有行内公式 `<img>`（`data-math-display="inline"`，或所在父块中除该 `<img>` 外还含有其他可见文字的 `img[data-raster-type="math"]`），不进入图片上传队列，而是将其 `data-math-tex` / `alt` 转换为可读的 Unicode 数学符号文本（如 `\eta = 1.0` $\rightarrow$ `η = 1.0`、`E = mc^2` $\rightarrow$ `E = mc²`、`\alpha + \beta` $\rightarrow$ `α + β`），原位替换为 DOM `Text` 节点，保持段落完整不断行。
2. **Callout 与多段 `<blockquote>` 内部换行归一化（`normalizeBlockquotesForX`）**：
   - 遍历剪贴板 DOM 中的 `<blockquote>`，当内部包含多个 `<p>` / `<div>` 子元素时，解包内层 `<p>` / `<div>` 并在相邻子块之间插入 `<br>`，使 X Draft.js 在同一个引用块内生成 `\n` 软换行，让加粗标题独立成首行、正文位于次行且共享左侧连续引用竖线。
3. **代码块（`<pre>`）自动光栅化为 2x Retina 语法高亮代码卡片（`renderCodeBlockToDataUrl`）**：
   - 将剪贴板 DOM 中的每个 `<pre>` 节点渲染为 `680px` CSS 宽（`1360px` 物理像素宽）、高度 $\ge 176\text{px}$（宽高比 $\le 3.86 : 1$）的高清代码卡片 PNG：
     - 包含顶部窗口控制圆点与语言标识胶囊（如 `TYPESCRIPT`）、左侧行号栏、等宽代码字体与关键字/字符串/类型/注释语法着色；
     - 转换为 `<p><img data-raster-type="code" src="data:image/png;base64,..." /></p>` 并纳入统一图片上传管线。
4. **前置块尾锚定、逆序（Reverse Order）上传与 DOM 挂载确认（`waitForMediaBlockInsertion`）**：
   - **前置块尾锚定**：将每个独立块级图片的占位符 `XIMGPH_${idx}_END` 优先挂载在紧邻的前置文本块末尾（若存在），使 `selectAndClearToken` 删除占位符后光标精准停在前置块末尾，`insertAtomicBlock` 切分后直接在下方生成媒体块，不产生多余空行；
   - **位图防裁切标准化（`ensureXSafeImageFile`）**：对所有待上传图片检查宽高比，若 `width / height > 4.0` 或尺寸过小，自动在 `1360px` 宽画布上居中衬底至安全宽高比；
   - **逆序逐张上传 + 挂载确认**：按 `i = tasks.length - 1` 递减至 `0` 的逆序处理，每张图片先同步 Draft.js 选区（派发 `selectionchange`、`mouseup`、`select` 并等待状态提交）再删除占位符并派发文件粘贴事件，随后轮询 `countEditorMediaNodes(editorEl)` 等待新增媒体块在 DOM 中真实挂载并稳定后再处理上一张图片。

---

## 3. 真实执行与验收标准 (Verification)

### 3.1 实施与验收 Checklist

- [x] 由独立子代理（Fresh Subagent）严格依据本 Spec 在 `tests/test_x_article_pipeline.test.ts` 与 `tests/test_workbench_ui.test.ts` 中编写黑盒测试（覆盖块级公式与表格 `680px` 宽度及宽高比 $\le 4.0 : 1$ 防裁切、`ts`/`js`/`py` 语言别名高亮、油猴脚本行内公式转 Unicode 不拆段、Callout `<blockquote>` 插入 `<br>` 换行、`<pre>` 代码块转高清代码卡片位图、以及多图逆序上传与挂载等待逻辑），并在实现前确认红灯失败（TDD Red Phase）。
- [x] 更新 [`src/core/x-article/normalizer.ts`](../../../src/core/x-article/normalizer.ts) 与 [`src/core/ast/math-code.ts`](../../../src/core/ast/math-code.ts)，完成公式与表格防裁切画布尺寸及代码语言别名支持。
- [x] 更新 [`public/morphmd-x-paste.user.js`](../../../public/morphmd-x-paste.user.js)，完成行内公式 Unicode 转换、Callout 换行、代码块高清卡片光栅化、防裁切图片衬底与多图逆序同步上传管线。
- [x] 通过全量黑盒测试套件、`npm run typecheck` 与 `harness doctor` 巡检。
