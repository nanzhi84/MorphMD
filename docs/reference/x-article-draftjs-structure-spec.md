# X (Twitter) Articles 结构与 Draft.js 粘贴契约验证规范

> **来源背景**：基于 X 长文编辑器（`https://x.com/compose/article`）底层 Draft.js `convertFromHTML` 状态转换机制，以及开源社区主流 X Articles 发布工具（`wshuyi/x-article-publisher-skill`、`punk2898/x-article-publisher`、`Michaelliv/markdown-for-x`）实测归纳的富文本剪贴板结构验证规范。

## 前言

与微信公众号编辑器保留内联 `style` 和任意 `<section>` 树不同，X Articles 编辑器基于 **Draft.js** 构建。当创作者通过剪贴板粘贴 `text/html` 时，X 编辑器会丢弃所有非白名单标签与普通文本节点上的内联样式，并将 HTML 节点映射为固定的 Draft.js `ContentBlock` 与 `EntityMap`。

为保证 MorphMD 在 `x-article` 视图下的交付快照粘贴至 X Articles 后**不丢标题层级、不塌缩表格、不产生公式重影乱码、不残留无效样式**，特制定本验证规范作为 `verifyXArticleStructure` 引擎的权威判准。

---

## 1、块级语义与 Draft.js Block 映射规范

X Articles 的 Draft.js 编辑器仅支持以下原生块级类型（`DraftBlockType`）：

| Draft.js Block Type | 对应 HTML 标签 | 说明 |
| :--- | :--- | :--- |
| `header-one` | `<h1>` | 一级大标题（Section Heading） |
| `header-two` | `<h2>` | 二级副标题（Subheading） |
| `unstyled` | `<p>` / `<div>` | 普通正文段落 |
| `blockquote` | `<blockquote>` | 引用块 |
| `unordered-list-item` | `<ul> > <li>` | 无序列表项 |
| `ordered-list-item` | `<ol> > <li>` | 有序列表项 |
| `code-block` | `<pre>` | 代码块 |
| `atomic` | `<hr>` / 独立媒体块 | 分割线或独立图片/光栅化卡片原子块 |

### 1.1 heading-level（标题层级限制）

**错误场景**：
HTML 中包含 `<h3>`、`<h4>`、`<h5>`、`<h6>` 标签。

**影响说明**：
X Articles 工具栏与 Draft.js 块级映射仅支持 `H1`（大标题）与 `H2`（小标题）两级。粘贴 `<h3>~<h6>` 时会被降级为普通正文段落（`unstyled`），导致小节标题失去加粗放大层级。

**合规要求**：
`x-article` 快照必须将 `<h3>~<h6>` 归一化为 `<h2>`（可通过 `data-original-heading="h3..h6"` 保留原始语义层级溯源）。

### 1.2 callout-structure（Callout 容器降级规范）

**错误场景**：
使用 `<div class="morph-callout">` 包裹提示框标题与正文。

**影响说明**：
Draft.js `convertFromHTML` 会将普通 `<div>` 拍平为无缩进的 `unstyled` 段落，导致 Callout 的引用视觉边界与标题强调完全丢失。

**合规要求**：
Callout 容器必须转换为原生 `<blockquote>` 结构，并将标题转换为首段加粗文本 `<p><strong>标题</strong></p>`。

### 1.3 unrasterized-table（原生表格必须光栅化降级）

**错误场景**：
HTML 中直接包含裸 `<table>`、`<thead>`、`<tbody>`、`<tr>`、`<th>`、`<td>` 节点。

**影响说明**：
X Articles 不支持原生表格 Block。直接粘贴 `<table>` 会导致单元格标签被剥离，所有单元格文字被拼接或拆散成毫无对齐结构的普通段落。

**合规要求**：
`x-article` 快照中的表格必须前置光栅化为带 `data-morph-rasterized="true"` 标记的 `<img>` 图像块，并在 `alt` 属性中完整保留表格文本语义以保障无障碍与纯文本提取不丢字。

### 1.4 unsupported-element（非法标签与孤立列表项限制）

**错误场景**：
1. 存在孤立的 `<li>` 节点（父元素不是 `<ul>` 或 `<ol>`）。
2. 存在超出 X 粘贴白名单的复杂容器或表单/脚本标签（如 `<section>`、`<article>`、`<aside>`、`<details>`、`<iframe >` 等）。

**合规要求**：
所有 `<li>` 必须严格包裹在 `<ul>` 或 `<ol>` 内；文档树仅允许使用受支持的语义块与行内标签。

---

## 2、数学公式、SVG 与媒体协议规范

### 2.1 unrasterized-math（禁止裸 KaTeX / MathML DOM 穿透）

**错误场景**：
公式节点保留了 KaTeX 默认输出的 `<span class="katex-mathml"><math>...</math></span>` 与 `<span class="katex-html" aria-hidden="true">...</span>` 双重子树。

**影响说明**：
X Articles 粘贴时会剥离外部 CSS 样式表并忽略 `aria-hidden="true"`，导致 Draft.js 同时提取 `.katex-mathml`（含 `<mrow>` 与 `<annotation>` 源码）和 `.katex-html` 的文本节点，在编辑器中产生**三倍重复的乱码字符**（例如 `∫−∞∞e−x2dx=π\int_{-\infty}^{\infty}...∫−∞∞e−x2dx=π`）。

**合规要求**：
`x-article` 快照中的数学公式必须转换为带 `data-morph-rasterized="true"` 与 `data-math-tex` 属性的 `<img>` 光栅化图像节点（或由 `AssetStore` 替换为已就绪图片），严禁残留裸 `<math>`、`.katex-mathml` 或 `.katex-html` 节点。

### 2.2 unrasterized-svg（禁止裸 SVG 节点穿透）

**错误场景**：
HTML 中直接包含裸 `<svg>` 矢量节点（包括 KaTeX 根号 `<svg>` 或流程图 `<svg>`）。

**影响说明**：
X Articles `convertFromHTML` 不解析 `<svg>` 及其内部 `<path>`，粘贴后会直接丢失图形。

**合规要求**：
所有 `<svg>` 必须前置光栅化为 `<img data-morph-rasterized="true">`。

### 2.3 unsafe-media-or-link（媒体与超链接协议合规）

**错误场景**：
1. `<img>` 的 `src` 为空、未解析的 `morph-asset://`、临时 `blob:`、非加密 `http:`，或非光栅化生成的非法 `data:` 协议。
2. `<a>` 的 `href` 包含 `javascript:`、`vbscript:` 或 `data:` 等危险协议。

**合规要求**：
- 外部资产图片在 `x-article` 下必须使用有效的 `https://` 远程地址（或带 `data-morph-rasterized="true"` 的光栅化内嵌图像）。
- 超链接仅允许 `https:`、`http:`、`mailto:` 或页内锚点 `#`。

---

## 3、内联样式与行内修饰规范

### 3.1 native-inline-style（禁止原生文本块残留内联样式）

**错误场景**：
在 `<p>`、`<h1>`、`<h2>`、`<blockquote>`、`<ul>`、`<ol>`、`<li>`、`<strong>`、`<em>`、`<a>` 等原生文本节点（非光栅化块）上残留 `style="..."` 属性。

**影响说明**：
X Articles 会强制剥离所有原生文本块上的 `style` 属性；若快照中残留内联样式，会导致右侧预览视图与粘贴到 X 后的实际表现不一致（伪所见即所得）。

**合规要求**：
除声明为光栅化渲染的节点（如 `pre.morph-code` 代码高亮预备块或 `[data-morph-rasterized="true"]` 图像块）外，所有原生文本与容器节点严禁携带 `style` 属性。

---

## 4、Draft.js `convertFromHTML` 状态模拟校验

`verifyXArticleStructure` 在完成静态 DOM 规则巡检后，会执行一遍完整的 Draft.js `convertFromHTML` 仿真解析，输出：
- `blocks`：按文档顺序列出每个 `ContentBlock` 的 `type`、`text`、`depth`、`inlineStyleRanges`（`BOLD` / `ITALIC` / `STRIKETHROUGH` / `CODE`）与 `entityRanges`。
- `entityMap`：列出所有识别到的 `LINK`、`IMAGE`、`DIVIDER` 实体及其元数据。
- 确保转换后的 `blocks` 非空（当输入含有效内容时），且不出现公式字符重复拼接或表格粘连。
