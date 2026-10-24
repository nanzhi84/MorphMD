# X (Twitter) Articles 富文本编辑器架构、二次开发机制与粘贴契约验证规范

> **来源背景**：基于 X 长文编辑器（`https://x.com/compose/article`）前端交互层、X 内部 GraphQL 持久化协议（`ArticleEntityDraftCreate` / `ArticleEntityUpdate` / `article_results.result.content_state` + `media_entities`）、底层定制版 **Draft.js** 状态转换机制，以及开源社区主流 X Articles 逆向与发布工具（`@kaitox/x-article`、`wshuyi/x-article-publisher-skill`、`punk2898/x-article-publisher`、`Michaelliv/markdown-for-x`、`baoyu-danger-x-to-markdown`、`yuta/bird`、`emusks`）实测归纳的权威结构验证规范。

## 前言：以 X Articles 真实编辑器为核心（而非通用 Draft.js）

X Articles 编辑器虽然以 Meta 开源的 **Draft.js**（`.public-DraftEditor-content` / `data-block="true"`）为底座，但 **X 工程团队对其进行了深度的二次开发与私有协议魔改**。如果仅按照通用 Draft.js 标准生成 HTML 或状态数据，在实际粘贴或导入至 `x.com/compose/article` 时仍会遭遇大量平台特有的吞标签、丢图、代码块退化与排版崩坏问题。

理解 X Articles 的核心在于认清其**“双层耦合架构”**：
1. **前端剪贴板粘贴拦截层（DOM `text/html` $\rightarrow$ X Customized `DraftPasteProcessor`）**：当创作者在编辑器正文区按下 `Cmd/Ctrl + V`（或通过 `⋯ -> Import` 导入）时，X 前端的粘贴处理器会先对剪贴板 HTML 执行白名单过滤与节点解构，剥离所有非白名单标签、`<svg>` 节点与内联 `style` 属性；
2. **后端私有 `ArticleEntity` 持久化状态机（`content_state` + `media_entities`）**：X 并不直接存储 HTML，也不完全等同于原生 Draft.js 的 `RawDraftContentState`，而是通过私有实体（`MEDIA`、`MARKDOWN`、`DIVIDER`、`TWEET`、`TWEMOJI`、`LINK`）与独立媒体附件表（`media_entities`）协同持久化整篇长文（上限 100,000 字符）。

为保证 MorphMD 在 `x-article` 视图下的版本化交付快照粘贴至 X Articles 后**不丢标题层级、不塌缩表格、不产生公式重影乱码、不触发单字符双实体覆盖、不因 X 私有实体转换而丢图或吞分割线、不残留伪所见即所得样式**，特制定本规范作为 `verifyXArticleStructure` / `verifyXArticleHtml` / `verifyXArticleHtmlInBrowser` 的权威判准。

---

## 0、X Articles 二次开发架构与核心映射契约

### 0.1 X Articles 二次开发 vs 原生 Draft.js 的 7 大核心差异

在为 `x-article` 设计 DOM 归一化与校验规则时，必须优先遵循 X 真实编辑器的二次开发行为，而非原生 Draft.js 的默认假设：

| 维度 | 原生 Draft.js 默认行为 | X (Twitter) Articles 二次开发真实行为 | MorphMD `x-article` 适配与校验对策 |
| :--- | :--- | :--- | :--- |
| **1. 文章主标题与正文标题层级** | 支持 `header-one` 至 `header-six`（`<h1>~<h6>`）共 6 级标题块 | **顶部主标题独立抽离**为专用输入框（`Article Title`）+ 封面图（`Cover Image`）；正文区工具栏**仅暴露两档标题**（大标题 Heading / 小标题 Subheading）。粘贴深层标题（`h3~h6`）会被直接拍平为普通正文（`unstyled`） | 在正文交付快照中禁止残留 `<h3>~<h6>`，统一归一化为 `<h2>`（保留 `data-original-heading` 溯源），确保粘贴后 100% 命中 X 正文副标题样式（`#1.1`） |
| **2. 代码块（Code Box）的实现机制** | `<pre>` 映射为 `type: 'code-block'` 普通文本块 | X 将多行代码块二次开发为 **`type: 'atomic'` 原子块 + `entityMap` 中的私有 `MARKDOWN` 实体**（`data: { markdown: "```lang\n...\n```" }`）。粘贴 `<pre><code>` 时，X 会剥离内部所有语法高亮 `<span style="color:...">` 仅保留纯文本，或需要光栅化卡片兜底 | 代码块仅输出标准 `<pre><code>` 结构或声明为光栅化候选块；严禁依赖代码块内嵌复杂 HTML 结构（`#1.4`、`#3.1`） |
| **3. 图片与媒体持久化（`MEDIA` vs `IMAGE`）** | `<img>` 映射为 `IMAGE` 实体，直接保存外部 `src` URL | X 的 `ArticleEntity` **不直接信任或持久化剪贴板 HTML 中的裸外链 `<img>` 或非法协议**；真实落库依赖先上传至 `upload.x.com` 生成 `media_id` 登记入顶层 `media_entities`，再由正文 `atomic` 块通过私有 **`MEDIA` 实体**（`data.mediaItems[].mediaId`）引用。直接粘贴含 `blob:` / `http:` / `svg+xml` 的 `<img>` 极易静默丢图 | 严禁 `morph-asset://`、`blob:`、`http:` 或 `data:image/svg+xml`；本地图片、表格、公式、SVG 必须转换为通过二进制 CRC32 与 `img.decode()` 校验的真 PNG/JPEG/WebP 位图（供复制图片或按 `blockIndex` 自动注入上传），并保留完整 `alt`（`#2.3`） |
| **4. 分割线（Divider）与 `<hr>` 粘贴陷阱** | 原生 `convertFromHTML` **完全不识别 `<hr>`**，粘贴后直接静默丢弃 | X 二次开发了 **`type: 'atomic'` + `DIVIDER` 实体**（`text: " "`，`data: {}`，对应工具栏 `Insert > Divider`）。但在部分浏览器富文本粘贴路径下，裸 `<hr>` 仍可能被前端粘贴器忽略 | 将 `<hr>` 映射并校验为 `atomic` + `DIVIDER` 实体，确保数量守恒（`#4.2`）并提供精确 `blockIndex` 定位 |
| **5. 独立行 X 推文链接自动展开（`TWEET` 实体）** | 所有 `<a>` 均映射为普通行内 `LINK` 实体 | 当 `https://x.com/<user>/status/<id>`（或 `twitter.com`）独占一行时，X 会将其拦截转换为 **`type: 'atomic'` + 私有 `TWEET` 实体**（`data: { tweetId }`），渲染为交互式嵌入推文卡片；若混排在段落文字中则保持为普通 `LINK` | 校验超链接协议安全性，区分独立行嵌入链接与段落内行内链接（`#2.3`、`#4.1`） |
| **6. `TWEMOJI` 与社交自动装饰器（`@`/`#`/`$`）** | 无内置 Emoji 实体或社交标签解析 | X 对正文中的 Emoji 注入私有 **`TWEMOJI` 实体**（映射至 Twemoji 矢量/位图地址），并对 `@username`、`#hashtag`、`$CASHTAG` 执行码点级偏移绑定 | `inlineStyleRanges` 与 `entityRanges` 的 `offset` / `length` **必须严格按 Unicode 码点（`UnicodeUtils.strlen`）计算**，将代理对（Surrogate Pairs）计为 `1`，严防 Emoji 之后的所有样式与链接发生偏移错位（`#4.3`） |
| **7. `entityMap` 序列化结构与行内修饰裁剪** | `entityMap` 为对象字典 `Record<string, RawDraftEntity>`；支持 `BOLD` / `ITALIC` / `UNDERLINE` / `STRIKETHROUGH` / `CODE` | X GraphQL 接口中 `content_state.entityMap` 采用 **`Array<{ key: string, value: Entity }>` 数组格式**；工具栏原生暴露加粗、斜体、删除线，而行内 `<code>` 与 `<u>` 在部分粘贴/导出链路下无胶囊背景或易被清洗 | 严禁任何非 `<pre>` 原生节点携带内联 `style="..."`，通过语义标签传递行内修饰，并在自定义样式被剥离时输出显式告警诊断（`#3.1`） |

---

### 0.2 HTML 允许标签白名单（`ALLOWED_X_ARTICLE_TAGS`）

`x-article` 交付快照的 DOM 树（除根容器 `<body>` / `<div class="morph-doc">` 外）仅允许出现以下 **25 个**受 X Articles 粘贴管线支持的 HTML 标签：

| 分类 | 允许的 HTML 标签 | X Articles / Draft.js 转换角色 |
| :--- | :--- | :--- |
| **块级排版与容器** | `div`, `p`, `h1`, `h2`, `blockquote`, `pre`, `figure`, `figcaption` | 映射为对应 `DraftBlockType` 或作为块级遍历分组容器 |
| **列表结构** | `ul`, `ol`, `li` | 映射为 `unordered-list-item` / `ordered-list-item` 并维护 `depth`（$0 \le \text{depth} \le 4$） |
| **行内语义修饰** | `strong`, `b`, `em`, `i`, `u`, `del`, `s`, `strike`, `code`, `span` | 累加 `DraftInlineStyle` 集合并生成 `inlineStyleRanges` |
| **实体与原子块** | `a`, `img`, `hr` | 注册 `LINK`、`IMAGE`（对应 X 端 `MEDIA`）、`DIVIDER` 实体并生成 `entityRanges` 或 `atomic` 块 |
| **软换行** | `br` | 在当前 `ContentBlock` 文本流中插入 `\n`（`U+000A`） |

### 0.3 块级类型映射矩阵（`DraftBlockType`）

X Articles 编辑器正文支持以下 **8 种**块级类型映射：

| Block Type | 对应 HTML 结构 | `depth` 范围 | X Articles 平台真实表现与说明 |
| :--- | :--- | :---: | :--- |
| `header-one` | `<h1>` | `0` | 一级章节大标题（Section Heading，对应工具栏 Heading；注意若使用自动化发布脚本提取首行 `<h1>` 作为顶部 Article Title，正文内的 `<h1>` 则作为一级章节标题） |
| `header-two` | `<h2>`（含 `h3~h6` 归一化） | `0` | 二级小节副标题（Subheading，对应工具栏 Subheading） |
| `unstyled` | `<p>` / `<div>` / `<figcaption>` | `0` | 普通正文段落（含混排文本与行内公式/小图标 `<img>`） |
| `blockquote` | `<blockquote>` | `0` | 引用块（含降级后的 Callout 容器；X 不支持嵌套引用层级） |
| `unordered-list-item` | `<ul> > <li>` | `0 ~ 4` | 无序列表项（嵌套子列表通过递增 `depth` 表达，最高 `depth = 4`） |
| `ordered-list-item` | `<ol> > <li>` | `0 ~ 4` | 有序列表项（嵌套子列表通过递增 `depth` 表达，最高 `depth = 4`） |
| `code-block` | `<pre>` / `<pre><code>` | `0` | 代码块（剪贴板粘贴时由 `<pre>` 承载；X 后端持久化时亦常封装为 `atomic` + `MARKDOWN` 实体） |
| `atomic` | `<hr>` 或独立 `<img>` 段落 | `0` | 不可分割的独立原子块（在 X 后端分别对应 `MEDIA` 图片块、`DIVIDER` 分割线块、`MARKDOWN` 代码盒或 `TWEET` 嵌入推文块） |

### 0.4 行内修饰映射矩阵（`DraftInlineStyle`）

每个字符的 `CharacterMetadata.style` 采用 `Immutable.OrderedSet<string>` 存储，支持在同一字符上叠加多种行内修饰。在非代码块（`inCodeBlock === false`）上下文中，HTML 行内标签按以下规则映射并自动合并相邻或重叠的同类区间（`mergeAdjacentInlineStyleRanges`）：

| `DraftInlineStyle` | 对应 HTML 标签 | X Articles 平台支持度说明 |
| :--- | :--- | :--- |
| `BOLD` | `<strong>`, `<b>` | **原生核心支持**（工具栏 `B` 按钮，Callout 首段标题依赖此修饰） |
| `ITALIC` | `<em>`, `<i>` | **原生核心支持**（工具栏 `I` 按钮） |
| `STRIKETHROUGH` | `<del>`, `<s>`, `<strike>` | **原生核心支持**（工具栏 `S` 删除线按钮） |
| `UNDERLINE` | `<u>` | **受限支持**（Draft.js 模型支持 `UNDERLINE`，但 X 工具栏未直接暴露按钮，部分粘贴路径可能剥离 `<u>`） |
| `CODE` | `<code>`（非 `<pre>` 内部） | **受限支持**（Draft.js 模型支持 `CODE`，但 X 正文渲染器对行内 `<code>` 无明显的独立背景框样式；位于 `<pre>` 内部的 `<code>` 由外层代码块统一承载，不重复生成 `CODE` 行内区间） |

> [!NOTE]
> 在 `<pre>`（`code-block`）内部，X Articles 与 Draft.js 均将所有子节点视为纯代码文本，忽略 `<strong>`、`<em>`、`<u>`、`<del>`、`<code>`、`<span>` 等标签的 `DraftInlineStyle` 映射，仅保留文本内容与换行符。

### 0.5 实体模型与独立媒体块判定（`entityMap` & `atomic`）

在剪贴板 HTML 仿真层与 X Articles 内部 `content_state.entityMap` 之间，实体按以下契约映射：

| 仿真校验实体类型 (`type`) | X `ArticleEntity` 内部持久化类型 | 可变性 (`mutability`) | 触发标签 | 占位字符与 `text` 表现 | `data` 元数据契约 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `LINK` | `LINK`（独立行推文 URL 转为 `TWEET`） | `MUTABLE` | `<a href="...">` | 包裹的实际可见锚文本（要求 `length > 0`） | `{ url: string }` |
| `IMAGE` | `MEDIA`（关联顶层 `media_entities[].media_id`） | `IMMUTABLE` | `<img src="...">` | 单个对象替换字符 `\uFFFC`（`U+FFFC`，`length: 1`） | `{ src: string, alt: string, rasterized?: boolean, rasterType?: 'table' \| 'math' \| 'svg' \| 'code' }` |
| `DIVIDER` | `DIVIDER` | `IMMUTABLE` | `<hr>` | 单个空格字符 `" "`（`U+0020`，`offset: 0, length: 1`） | `{}` |

**独立图片块（`atomic`）与行内图片（`unstyled` 内嵌 `\uFFFC`）的区分规则**：
- **独立图片原子块（`type: 'atomic'`）**：当 `<p>`、`<figure>` 或 `<figcaption>` 满足 `isStandaloneImageParagraph(el)` 条件——即内部**有且仅有 1 个 `<img>`**，不包含任何非空白可见文本，且不包含 `a, br, code, strong, b, em, i, del, s, strike, u` 等行内元素时（或 `<img>` 直接作为块级容器子节点且前后无相邻行内内容时），映射为独立的 `atomic` 块（`text: "\uFFFC"`）。
- **行内内嵌图片（如行内数学公式 `$E = mc^2$`）**：当 `<img>` 与普通文本或其他行内元素混排于同一段落（例如 `<p>质能方程 <span class="morph-math"><img .../></span> 是行内公式。</p>`）时，不拆分为 `atomic` 块，而是在当前段落块的对应码点偏移处插入 `\uFFFC` 并绑定 `IMAGE` 实体区间。

### 0.6 完整规则键一览表（`XArticleRuleKey`）

`verifyXArticleStructure` 包含 **4 大领域、11 项强制校验规则**：

| 规则键 (`XArticleRuleKey`) | 规范章节 | 核心拦截目标 |
| :--- | :--- | :--- |
| `heading-level` | `#1.1` | 残留 `<h3>` ~ `<h6>` 深层标题标签（粘贴至 X 正文后退化为 `unstyled` 普通段落） |
| `callout-structure` | `#1.2` | 未降级为 `<blockquote>` 的 Callout 容器，或转换后缺失非空加粗首段标题 |
| `unrasterized-table` | `#1.3` | 残留裸 `<table>` 家族标签或被 HTML5 解析器剥离的孤立单元格标签 |
| `unsupported-element` | `#1.4` | 非白名单 HTML 标签、孤立 `<li>`、列表非法子节点、`<li>`/`<h1>`/`<h2>` 内嵌块、嵌套 `<blockquote>`、嵌套 `.morph-doc` |
| `list-depth-exceeded` | `#1.5` | 列表项嵌套深度超出 X Articles / Draft.js 支持上限（`depth > 4`） |
| `unrasterized-math` | `#2.1` | 残留裸 `<math>`、`.katex-mathml`/`.katex-html`、`mjx-container` 或未彻底清洗的 `.morph-math` 容器 |
| `unrasterized-svg` | `#2.2` | 残留裸 `<svg>` 矢量图形节点 |
| `unsafe-media-or-link` | `#2.3` | 非法图片/链接协议、损坏或纯色空白位图、跨语义复用静态占位图、缺失光栅化 `alt`、残留 `srcset` 或 `on*` 事件属性 |
| `native-inline-style` | `#3.1` | 原生非光栅化节点（含根容器）残留 `style="..."` 内联样式 |
| `entity-conflict` | `#4.1` | 单字符位置重叠多个 Entity（如 `<a>` 内嵌 `<img>`）或 `EntityRange` 越界/悬空引用 |
| `content-loss` | `#4.2` | DOM 转 Draft.js 状态后发生正文字符丢失/重影、图片/分割线数量不守恒、空块坍塌或空文档坍塌 |

---

## 1、块级语义与 X Articles Block 映射规范

### 1.1 `heading-level`（标题层级限制）

**错误场景**：
HTML 中包含 `<h3>`、`<h4>`、`<h5>`、`<h6>` 标签（包括根容器自身为 `h3~h6` 的情形）。

**示例**：
```html
<!-- ❌ 错误示例：三级及以下标题在 X Articles 正文粘贴中不受支持 -->
<h3 class="morph-h3">1.1 核心架构演进</h3>
<h4>补充细节说明</h4>

<!-- ✅ 合规示例：归一化为 h2 并保留溯源属性 -->
<h2 class="morph-h2" data-original-heading="h3" data-node-id="node-3">1.1 核心架构演进</h2>
<h2 class="morph-h2" data-original-heading="h4" data-node-id="node-4">补充细节说明</h2>
```

**X 平台二次开发机制与影响说明**：
X Articles 将整篇文章的大标题独立为顶部的 `Article Title` 字段，而正文编辑器的工具栏仅提供 **Heading（一级大标题）** 与 **Subheading（二级副标题）** 两个层级档位：
- 当通过系统剪贴板直接向 X 正文区粘贴 HTML 时，`<h1>` 映射为大标题（`header-one`），`<h2>` 映射为副标题（`header-two`），而 `<h3> ~ <h6>` 因超出正文两档标题设计，在粘贴时会被降级为普通正文段落（`unstyled`），导致小节标题完全失去加粗放大层级；
- 注：部分通过 GraphQL 接口直接构造 `content_state` 的外部发布工具（如 `@kaitox/x-article`、`wshuyi/x-article-publisher-skill`）会将文档首个 `# H1` 抽离填入顶部 `Article Title`，并将正文内的 `## H2` / `### H3` 映射为两档正文标题（同时将 `H4~H6` 截断合并）。而在 MorphMD 的“预览与剪贴板同构快照”模式下，正文快照统一使用 `<h1>`（`header-one`）与 `<h2>`（`header-two`）承载这两档正文标题，并将 `<h3> ~ <h6>` 归一化为 `<h2>`。

**合规要求**：
`x-article` 快照归一化管线必须将所有 `<h3> ~ <h6>` 统一转换为 `<h2>`，同时写入 `data-original-heading="h3..h6"` 属性以保留原始 Markdown 语义层级溯源，并产出 `structure/x-article-heading-downgraded` 诊断信息。

---

### 1.2 `callout-structure`（Callout 容器降级规范）

**错误场景**：
1. 残留未转换的 `<div class="morph-callout">`、非 `<blockquote>` 的 `.morph-callout` 或 `[data-callout-type]:not(blockquote)` 容器，或残留内部子结构类名 `.morph-callout-title` / `.morph-callout-body`。
2. 已转换为 `<blockquote class="morph-callout">` 或 `<blockquote data-callout-type="...">`，但其首个子元素内部缺少**非空可见的加粗标题**（`<strong>` 或 `<b>`）。
3. 正文中仍残留未清洗的 GFM 原始标记文本（如 `[!NOTE]`、`[!TIP]`、`[!IMPORTANT]`、`[!WARNING]`、`[!CAUTION]`）。

**示例**：
```html
<!-- ❌ 错误示例 1：使用 div 容器包裹 Callout -->
<div class="morph-callout" data-callout-type="warning">
  <div class="morph-callout-title">部署警告</div>
  <div class="morph-callout-body"><p>请勿在周五下午执行发版操作。</p></div>
</div>

<!-- ❌ 错误示例 2：转为 blockquote 但缺少非空加粗首段标题 -->
<blockquote class="morph-quote morph-callout" data-callout-type="warning">
  <p><strong>   </strong></p>
  <p>请勿在周五下午执行发版操作。</p>
</blockquote>

<!-- ✅ 合规示例：原生 blockquote + 首段加粗标题 + 展开的正文段落 -->
<blockquote class="morph-quote morph-callout" data-callout-type="warning" data-node-id="callout-1">
  <p class="morph-p"><strong>部署警告</strong></p>
  <p class="morph-p">请勿在周五下午执行发版操作。</p>
</blockquote>
```

**X 平台机制与影响说明**：
X Articles 没有原生的 Callout / Alert 彩色提示框组件，其粘贴管线会将任何自定义 `<div>` 容器直接拍平为无左边框、无缩进的普通 `unstyled` 段落，导致提示框的视觉边界与标题强调彻底丢失。转换为原生 `<blockquote>` 后，内部每个 `<p>` 均映射为连续的 `blockquote` 类型 `ContentBlock`（带 X 原生引用左竖线样式），首段 `<p><strong>标题</strong></p>` 生成带 `BOLD` `inlineStyleRanges` 的首行引用块，清晰还原提示框层次。

**合规要求**：
- 所有 Callout 必须转换为 `<blockquote class="morph-quote morph-callout" data-callout-type="...">`；
- 标题必须提取为 `<blockquote>` 的第一个子元素 `<p class="morph-p"><strong>标题文本</strong></p>`（含有效可见字符）；
- `.morph-callout-body` 的子节点必须解包直接挂载至 `<blockquote>` 下，移除 `.morph-callout-title` 与 `.morph-callout-body` 包装层。

---

### 1.3 `unrasterized-table`（原生表格与孤立单元格必须光栅化降级）

**错误场景**：
1. DOM 树中包含任何表格家族标签：`<table>`、`<thead>`、`<tbody>`、`<tfoot>`、`<tr>`、`<th>`、`<td>`、`<caption>`、`<colgroup>`、`<col>`。
2. 原始 HTML 字符串中包含未包裹在 `<table>` 内的孤立表格标签（如裸 `<tr><td>单元格</td></tr>` 或 `<td>数据</td>`）。注意：浏览器或 JSDOM 的 HTML5 `<body>` 解析器在执行 `body.innerHTML = html` 时可能会静默剥离孤立的 `<tr>`/`<td>` 标签而仅留下裸文本，因此校验器必须同时在 DOM 树与原始 HTML 源码两个层面拦截表格标签。

**示例**：
```html
<!-- ❌ 错误示例：直接输出原生 HTML 表格 -->
<table class="morph-table">
  <thead><tr><th>目标平台</th><th>行内样式</th></tr></thead>
  <tbody><tr><td>X Articles</td><td>剥离</td></tr></tbody>
</table>

<!-- ✅ 合规示例：前置光栅化为带完整语义 alt 的独立位图块 -->
<p class="morph-p" data-morph-raster-container="table" data-node-id="tbl-1">
  <img
    class="morph-img morph-raster-img"
    data-morph-rasterized="true"
    data-raster-type="table"
    src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA..."
    alt="目标平台 | 行内样式 ; X Articles | 剥离"
  />
</p>
```

**X 平台机制与影响说明**：
X Articles 的编辑器与 `ArticleEntity` 协议均不支持原生表格组件。直接向 X 粘贴 `<table>` 会导致所有表格行列标签被剥离，所有单元格文字被挤压拼接或拆散成毫无对齐结构的普通段落，彻底破坏多维数据可读性（社区主流工具如 `wshuyi/x-article-publisher-skill` 同样通过 `table_to_image.py` 将表格前置转为 PNG 图片）。

**合规要求**：
- `x-article` 快照中的表格必须前置光栅化为携带 `data-morph-rasterized="true"` 与 `data-raster-type="table"` 的真位图 `<img src="data:image/png;base64,...">`（或已上传的 `https://` 图像），并包裹在 `<p data-morph-raster-container="table">` 内以映射为 `atomic` 块；
- 必须按行提取所有 `<th>` / `<td>` 文本（同列以 ` | ` 分隔，跨行以 ` ; ` 分隔）完整写入 `<img>` 的 `alt` 属性，遵守“原稿语义零篡改”红线，保障无障碍读屏与纯文本复制不丢字。

---

### 1.4 `unsupported-element`（非法标签、孤立列表项与结构嵌套契约）

**错误场景**：
本规则涵盖 **7 类**违反 X Articles DOM 与块级结构契约的场景：

1. **超出白名单的 HTML 标签**：
   - 结构语义容器：`<section>`、`<article>`、`<aside>`、`<nav>`、`<header>`、`<footer>`、`<main>`；
   - 交互、表单与折叠标签：`<details>`、`<summary>`、`<input>`（含 GFM 任务列表复选框 `<input type="checkbox">`）、`<button>`、`<select>`、`<textarea>`、`<form>`、`<fieldset>`；
   - 不受支持的行内语义标签：`<mark>`、`<kbd>`、`<sub>`、`<sup>`、`<abbr>`、`<ruby>`、`<rt>`、`<rp>`、`<time>`、`<small>`、`<ins>`、`<q>`、`<cite>`、`<dfn>`、`<var>`、`<samp>`；
   - 外部媒体与嵌入容器：`<video>`、`<audio>`、`<iframe>`、`<canvas>`、`<object>`、`<embed>`、`<picture>`、`<source>`、`<map>`、`<area>`；
   - 定义列表：`<dl>`、`<dt>`、`<dd>`；
   - 脚本与元数据标签：`<script>`、`<style>`、`<link>`、`<meta>`、`<base>`、`<noscript>`、`<template>`。
2. **孤立的 `<li>` 节点**：`<li>` 的直接父元素（`parentElement`）不是 `<ul>` 或 `<ol>`。
3. **列表容器包含非 `<li>` 直接子元素**：`<ul>` 或 `<ol>` 的直接子元素（`children`）中存在非 `<li>` 标签（例如 `<ul><p>文本</p></ul>` 或 `<ul><ul><li>嵌套</li></ul></ul>`——嵌套子列表必须置于父 `<li>` 内部而非直接挂在 `<ul>`/`<ol>` 下）。
4. **列表项 `<li>` 内部嵌套复杂块级元素**：`<li>` 的后代（归属于当前 `<li>` 层级）中包含 `<h1>` ~ `<h6>`、`<blockquote>`、`pre`、`hr` 或 `table`。
5. **标题 `<h1>` / `<h2>` 内部嵌套块级元素**：`<h1>` 或 `<h2>` 的直接子元素中包含任何块级标签（如 `<h1><p>标题</p></h1>` 或 `<h2><div>副标题</div></h2>`）。
6. **嵌套 `<blockquote>` 引用块**：`<blockquote>` 内部直接或间接嵌套另一个 `<blockquote>`。
7. **嵌套 `.morph-doc` 根容器伪造**：在文档根容器内部再次出现 `.morph-doc` 元素，试图截断或欺骗校验器的根节点解析范围。

**示例**：
```html
<!-- ❌ 错误示例 1：孤立 <li> 与列表直接包裹 <ul> -->
<li>孤立的列表项</li>
<ul>
  <ul><li>错误的子列表挂载位置</li></ul>
</ul>

<!-- ❌ 错误示例 2：<li> 内部嵌套代码块或引用块，或嵌套 <blockquote> -->
<ul>
  <li>列表项文本<pre><code>const x = 1;</code></pre></li>
</ul>
<blockquote>
  <p>外层引用</p>
  <blockquote><p>内层嵌套引用（X Articles 引用块不支持层级深度）</p></blockquote>
</blockquote>

<!-- ✅ 合规示例：标准嵌套列表（子 <ul> 位于父 <li> 内）与扁平 <blockquote> -->
<ul class="morph-list">
  <li>一级列表项
    <ul class="morph-list">
      <li>二级嵌套列表项</li>
    </ul>
  </li>
</ul>
<blockquote class="morph-quote">
  <p class="morph-p">第一段引用内容</p>
  <p class="morph-p">第二段引用内容</p>
</blockquote>
```

**X 平台机制与影响说明**：
- X Articles 的 `content_state.blocks` 模型是**一维扁平数组**，唯有列表项（`unordered-list-item` 与 `ordered-list-item`）拥有生效的 `depth` 缩进渲染；`blockquote`、`header-one`、`header-two`、`code-block` 均固定为 `depth: 0`，因此嵌套 `<blockquote>` 在粘贴后会被拍平为同级引用。
- 若在 `<li>` 内嵌套 `<blockquote>`、`<pre>` 或 `<h1>~<h2>`，X 粘贴器会强制中断当前列表流，将列表拆碎或把代码块吞入列表行内文本。
- 若使用 `<input type="checkbox">` 表达 GFM 任务列表，X 粘贴时会直接剥离 `<input>` 导致任务完成状态静默丢失（应在 AST/归一化阶段将勾选状态转换为文本前缀或符号表达）。

**合规要求**：
- `<section>`、`<article>`、`<aside>`、`<nav>`、`<header>`、`<footer>` 等结构容器必须归一化替换为 `<div>`；
- 孤立 `<li>` 必须自动补齐外层 `<ul class="morph-list">` 包裹；
- 严禁产生嵌套 `<blockquote>`、标题内嵌块或列表项内嵌复杂块。

---

### 1.5 `list-depth-exceeded`（列表嵌套深度上限限制）

**错误场景**：
`<ul>` / `<ol>` 列表嵌套层级超过 5 层，即转换生成的 `unordered-list-item` 或 `ordered-list-item` 块的 `depth > 4`（`depth` 从 `0` 开始计数，允许范围为 `0, 1, 2, 3, 4`）。

**示例**：
```html
<!-- ❌ 错误示例：6 层列表嵌套（最内层 depth = 5，超出上限 4） -->
<ul>
  <li>depth 0
    <ul><li>depth 1
      <ul><li>depth 2
        <ul><li>depth 3
          <ul><li>depth 4
            <ul><li>depth 5（违规：超出 X Articles / Draft.js 最大深度 4）</li></ul>
          </li></ul>
        </li></ul>
      </li></ul>
    </li></ul>
  </li>
</ul>
```

**X 平台机制与影响说明**：
X Articles 复用了 Draft.js `RichUtils.onTab(event, editorState, maxDepth = 4)` 与 `.public-DraftStyleDefault-depth0` 至 `.public-DraftStyleDefault-depth4` 的 5 级列表样式规则。任何 `depth > 4` 的深层列表项在粘贴或通过 `ArticleEntityUpdate` 保存草稿时，要么失去 CSS 缩进回退到最左侧（`depth 0` 视觉位置），要么被后端序列化器强制拍平。

**合规要求**：
文档中的列表嵌套深度 `depth` 必须满足 $0 \le \text{depth} \le 4$（可通过 `XArticleVerifyOpts.maxListDepth` 配置，默认值为 `4`）。

---

## 2、数学公式、SVG 与媒体协议规范

### 2.1 `unrasterized-math`（禁止裸 KaTeX / MathML / MathJax DOM 穿透）

**错误场景**：
1. HTML 中残留裸 `<math>`（MathML）、`.katex`、`.katex-display`、`.katex-mathml`、`.katex-html`、`mjx-container` 或 `.MathJax` 节点。
2. `.morph-math` 容器未完成干净的光栅化替换——例如内部仍残留 `<math>` / `.katex` / `<svg>` 子节点、未包含唯一一个 `img[data-morph-rasterized="true"]` 子元素，或在 `<img>` 旁残留了可见文本节点。

**示例**：
```html
<!-- ❌ 错误示例：KaTeX 默认输出的双重子树（粘贴至 X 会产生三倍重影乱码） -->
<span class="morph-math" data-math-tex="E = mc^2">
  <span class="katex">
    <span class="katex-mathml">
      <math xmlns="http://www.w3.org/1998/Math/MathML">
        <semantics>
          <mrow><mi>E</mi><mo>=</mo><mi>m</mi><msup><mi>c</mi><mn>2</mn></msup></mrow>
          <annotation encoding="application/x-tex">E = mc^2</annotation>
        </semantics>
      </math>
    </span>
    <span class="katex-html" aria-hidden="true">
      <span class="base"><span class="mord mathnormal">E</span><span class="mrel">=</span>...</span>
    </span>
  </span>
</span>

<!-- ✅ 合规示例（行内公式）：干净的 .morph-math 容器仅包裹 1 个光栅化位图 <img> -->
<span class="morph-math" data-math-tex="E = mc^2">
  <img
    class="morph-img morph-raster-img"
    data-morph-rasterized="true"
    data-raster-type="math"
    data-math-tex="E = mc^2"
    alt="E = mc^2"
    src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA..."
  />
</span>

<!-- ✅ 合规示例（块级公式）：div.morph-math-display 归一化为 <p> 以映射为独立 atomic 块 -->
<p class="morph-math morph-math-display" data-math-tex="\int_0^1 x^2 dx = \frac{1}{3}">
  <img
    class="morph-img morph-raster-img"
    data-morph-rasterized="true"
    data-raster-type="math"
    data-math-tex="\int_0^1 x^2 dx = \frac{1}{3}"
    alt="\int_0^1 x^2 dx = \frac{1}{3}"
    src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA..."
  />
</p>
```

**X 平台机制与影响说明（KaTeX 三倍重影乱码成因）**：
X Articles 不支持任何原生 LaTeX / MathML 数学公式渲染。而 KaTeX 默认生成的 DOM 树同时包含两部分：
1. 供屏幕阅读器读取的 `<span class="katex-mathml"><math><semantics><mrow>...</mrow><annotation>LaTeX源码</annotation></semantics></math></span>`（平时靠外部 CSS `clip: rect(1px, 1px, 1px, 1px); position: absolute;` 隐藏）；
2. 供视觉呈现的 `<span class="katex-html" aria-hidden="true">...</span>`。

当粘贴至 X Articles 时，X 编辑器会**剥离所有外部 CSS 样式表并完全忽略 `aria-hidden="true"` 属性**。粘贴处理器在递归提取文本节点时，会依次把 `<mrow>` 的符号文本、`<annotation>` 的 LaTeX 源码以及 `.katex-html` 的视觉字符全部拼接到同一个 `ContentBlock.text` 中，导致单个公式在 X 编辑器中变成**三倍重复的乱码字符串**（如 `E=mc2E = mc^2E=mc2`）。

**合规要求**：
- 所有数学公式必须前置转换为唯一一个 `<img data-morph-rasterized="true" data-raster-type="math" data-math-tex="..." alt="...">` 真位图节点；
- `.morph-math` 容器内部必须满足：`children.length === 1`、唯一子元素为 `img[data-morph-rasterized="true"]`、无任何残留 `<math>`/`.katex`/`<svg>` 子树，且容器 `textContent` 不含任何可见字符；
- 块级公式容器若原本为 `<div class="morph-math morph-math-display">`，应归一化替换为 `<p>`，使 `isStandaloneImageParagraph` 将其精确识别为 `atomic` 独立图片块。

---

### 2.2 `unrasterized-svg`（禁止裸 SVG 矢量节点穿透）

**错误场景**：
HTML 中包含任何裸 `<svg>` 节点（包括独立流程图/架构图 `<svg>`、图标 `<svg>` 或公式内部残留的根号拉伸 `<svg>`）。

**示例**：
```html
<!-- ❌ 错误示例：裸 SVG 节点在粘贴至 X Articles 后会静默蒸发 -->
<svg width="100" height="40" aria-label="架构矢量图">
  <rect width="100" height="40" fill="#0969da" />
</svg>

<!-- ✅ 合规示例：光栅化为 PNG/WebP 位图并保留 aria-label 作为 alt -->
<img
  class="morph-img morph-raster-img"
  data-morph-rasterized="true"
  data-raster-type="svg"
  src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA..."
  alt="架构矢量图"
/>
```

**X 平台机制与影响说明**：
X Articles 的富文本粘贴器与 `MEDIA` 实体上传服务（`upload.x.com`）均不支持 `<svg>` 矢量图形。粘贴含 `<svg>` 的 HTML 时，`<svg>`、`<path>`、`<rect>`、`<g>` 节点会被直接丢弃（若含 `<text>` 子节点则仅残留散乱文字）。

**排除场景（去重归并）**：
若某个 `<svg>` 位于已被 `#2.1 unrasterized-math` 标记违规的未光栅化数学公式容器内部，校验器仅报告一次 `unrasterized-math`，不再重复报告 `unrasterized-svg` 噪音。

**合规要求**：
所有独立与内嵌 `<svg>` 必须前置光栅化为带 `data-morph-rasterized="true"`、`data-raster-type="svg"` 与非空 `alt`（优先提取 `aria-label`）的真位图 `<img>`。

---

### 2.3 `unsafe-media-or-link`（X 媒体持久化协议、位图完整性与超链接安全规范）

**错误场景**：
本规则围绕 X Articles 的媒体上传管线（`upload.x.com` $\rightarrow$ `media_entities` $\rightarrow$ `MEDIA` 实体）与超链接安全限制，对 `<img>`、`<a>` 及全局元素属性执行 **6 重**校验：

1. **图片 `src` 协议与格式违规**：
   - `src` 为空、包含空白符/引号/尖括号；
   - 残留未解析的内部协议 `morph-asset://<id>` 或仅在当前源有效的临时地址 `blob:...`；
   - 使用非加密 `http://` 远程图片地址、协议相对地址 `//...` 或本地相对路径 `./assets/...`；
   - 使用非位图的 `data:` URI（例如**严禁使用 `data:image/svg+xml;base64,...` 伪装光栅化位图**——X Articles 的图片粘贴与 `upload.x.com` 仅接收光栅化位图格式 PNG / JPEG / WebP / GIF，拒绝 SVG Data URL）。
2. **Data URL 位图二进制结构损坏或纯色空白占位（`inspectRasterDataUrl`）**：
   - 仅允许 `data:image/(png|jpeg|webp);base64,<payload>`，且 Base64 长度须 $\ge 16$ 并为 $4$ 的整数倍；
   - **PNG 严格二进制校验**：
     - 8 字节魔数签名必须精确匹配 `89 50 4E 47 0D 0A 1A 0A`；
     - 首块必须为 13 字节 `IHDR`，且宽高满足 $1 \le \text{width}, \text{height} \le 16384$，`colorType` 合法（`0, 2, 3, 4, 6`），压缩/滤波/隔行扫描参数合法；
     - **全块 CRC32 校验**：逐块核对 `IHDR`、`IDAT`、`IEND` 等每个 Chunk 的 IEEE 802.3 `CRC32` 校验和，拦截任何字节篡改或截断；
     - **Zlib 解压与扫描线步长校验**：拼接所有 `IDAT` 块并执行 `inflateSync` 解压，8-bit 非隔行 PNG 的解压字节数不得小于 $(\text{width} \times \text{channels} + 1) \times \text{height}$；
   - **JPEG / WebP 容器头校验**：JPEG 必须以 `FF D8 FF`（SOI）开头；WebP 必须匹配 `RIFF....WEBP` 容器签名；
   - **光栅化前景内容像素非空校验（`requireContentPixels`）**：凡标记为 `data-morph-rasterized="true"` 的降级图片（表格、公式、SVG），严禁使用 `1×1` 透明像素或纯色背景图敷衍。校验器在排除外边框（$1\text{px}$）与左侧装饰条区域（$x < 24$）后的内容区扫描像素，必须至少存在 **$\ge 2$ 种不同颜色的像素值**；
   - **真实浏览器解码校验（`verifyXArticleHtmlInBrowser`）**：在无头 Chromium 环境中，所有 `data:` 图片必须通过 `await img.decode()` 且 `naturalWidth > 0 && naturalHeight > 0`。
3. **跨语义节点复用相同静态位图载荷（防伪造占位检测 `rasterDigestToAlt`）**：
   - 校验器对文档内每个 `img[data-morph-rasterized="true"]` 的解压像素数据计算 `SHA-256` 摘要（`pixelDigest`）。若两个光栅化图片的 `alt` 原始语义文本不同（例如公式 `E = mc^2` 与公式 `\int_0^1 x^2 dx`），但底层复用了完全相同的静态位图载荷（`pixelDigest` 相同），直接判定为伪造占位图违规。
4. **光栅化降级图片缺失非空 `alt` 替代文本**：
   - `img[data-morph-rasterized="true"]` 缺少 `alt` 属性，或 `alt` 仅包含空白符/零宽字符，违反 [PROJECTS.md](../../PROJECTS.md)“原稿语义零篡改”红线。
5. **`<img>` 携带 `srcset` 属性**：
   - `<img>` 上残留 `srcset` 属性会导致浏览器预览按屏幕 DPR 选取候选图，而粘贴管线仅读取 `src` 属性，造成预览与交付源不一致。
6. **不安全的超链接 `href` 或内联事件属性 `on*`**：
   - `<a>` 的 `href` 为空、为协议相对路径 `//...`，或使用 `javascript:`、`vbscript:`、`data:`、`blob:`、`morph-asset:` 等危险/内部协议；
   - 任何元素携带 `onclick`、`onerror`、`onload`、`onmouseover` 等 `^on[a-z]+` 内联事件处理器属性。

**合规要求**：
- 外部图片必须为合法的 `https://` URL，内嵌位图必须为通过二进制 CRC32、前景像素非空与 `img.decode()` 校验的 `data:image/(png|jpeg|webp);base64,...`；
- 每个不同语义的光栅化块必须渲染具有真实差异的像素载荷并附带完整的 `alt` 原始文本；
- 超链接 `href` 仅允许 `https:`、`http:`、`mailto:`、页内锚点 `#...` 或站内根路径 `/...`（非 `//`）。

---

## 3、内联样式与行内修饰规范

### 3.1 `native-inline-style`（禁止原生文本与容器节点残留内联样式）

**错误场景**：
在根容器（`.morph-doc`）或 `<p>`、`<h1>`、`<h2>`、`<blockquote>`、`<ul>`、`<ol>`、`<li>`、`<strong>`、`<b>`、`<em>`、`<i>`、`<u>`、`<del>`、`<s>`、`<a>`、`<span>`、`<img>` 等原生节点上残留非空的 `style="..."` 属性。

**示例**：
```html
<!-- ❌ 错误示例：在标题、段落或 span 上残留内联颜色与字号样式 -->
<h1 class="morph-h1" style="color: #ff0055; font-size: 32px;">样式守卫标题</h1>
<p class="morph-p"><span style="color: #ff0000;">手写内联样式文本</span></p>

<!-- ✅ 合规示例：剥离所有原生节点上的 style 属性，输出平台样式守卫告警诊断 -->
<h1 class="morph-h1">样式守卫标题</h1>
<p class="morph-p"><span>手写内联样式文本</span></p>
```

**X 平台机制与影响说明**：
X Articles 的粘贴管线与 `content_state` 模型不支持任意自定义 CSS 样式（如自定义文字颜色 `color`、背景色 `background-color`、字号 `font-size`、行高 `line-height`、字间距 `letter-spacing`、外边距 `margin`、居中/右对齐 `text-align` 等），粘贴时会**强制清洗所有原生节点上的 `style` 属性**，并按 X 平台固定的亮色/暗色（Light / Dim / Lights out）主题渲染。若交付快照的 HTML 中残留了内联样式，会导致 MorphMD 右侧预览视图呈现彩色/自定义排版，但用户粘贴到 X Articles 后全部退化为默认黑白排版，产生严重的**“伪所见即所得”**误导。

**排除场景（`allowCodeBlockStyles` 选项）**：
- 当 `XArticleVerifyOpts.allowCodeBlockStyles` 为 `true`（默认值）时，声明为代码高亮光栅化候选块的 `<pre>` 及其内部后代节点（如 Shiki 生成的 `<span style="color: ...">`）允许保留语法高亮内联样式；
- 当 `allowCodeBlockStyles: false` 时，包括 `<pre>` 在内的整棵 DOM 树严禁出现任何 `style` 属性。

**合规要求**：
1. 样式能力守卫（Style Capability Guard）在检测到用户自定义 CSS 或非默认主题 Tokens 试图修改 `x-article` 原生块样式时，必须生成 `severity: 'warning'` 的降级诊断告知创作者；
2. 归一化管线必须剥离所有非 `<pre>` 原生节点（含根容器与 `<img>`）上的 `style` 属性。

---

## 4、X Articles `content_state` 状态模拟与不变量校验

完成静态 DOM 规则巡检后，`verifyXArticleStructure` 会调用 `simulateDraftJsConvertFromHtml(root)` 完整仿真 X Articles 的 DOM-to-ContentState 解析过程，产出结构化的 `draftState: { blocks, entityMap }`，并执行以下核心状态机不变量校验：

### 4.1 `entity-conflict`（CharacterMetadata 单字符单实体互斥与区间边界契约）

**错误场景**：
1. **`<a>` 标签内部嵌套 `<img>`（最典型的 Markdown `[![alt](img.png)](https://example.com)` 冲突）**：导致同一个字符位置（`\uFFFC`）同时被赋予 `LINK` 实体与 `IMAGE`（`MEDIA`）实体。
2. **`EntityRange` 区间重叠或越界**：同一 `ContentBlock` 的 `entityRanges` 中存在两个重叠区间（`prev.offset + prev.length > next.offset`），或 `offset < 0`、`length <= 0`、`offset + length > UnicodeUtils.strlen(block.text)`，或 `entityMap[er.key]` 不存在。

**示例**：
```html
<!-- ❌ 错误示例：超链接 <a> 包裹图片 <img> 引发单字符双实体冲突 -->
<p>
  <a href="https://example.com">
    <img src="https://example.com/badge.png" alt="Build Status" />
  </a>
</p>

<!-- ✅ 合规示例：图片与文字链接分离，各自独立绑定 IMAGE (MEDIA) 与 LINK 实体 -->
<p>
  <img src="https://example.com/badge.png" alt="Build Status" />
</p>
<p>
  <a href="https://example.com">Build Status (https://example.com)</a>
</p>
```

**X 平台机制与权威依据**：
在 X Articles 底层的 `CharacterMetadata` 记录中，每个字符槽位的元数据定义为：
```ts
type CharacterMetadataConfig = {
  style?: DraftInlineStyle, // Immutable.OrderedSet<string>（支持多样式叠加）
  entity?: ?string,         // 单一可空字符串键（仅能指向 1 个 Entity！）
};
```
同时，在 X Articles 的 UI 与 `ArticleEntity` 协议中，**图片（`MEDIA` 原子块）本身不支持绑定点击跳转外链（`LINK`）**。当 HTML 中出现 `<a><img /></a>` 时，内层 `<img>` 在偏移量 `offset` 处插入长度 `1` 的 `\uFFFC` 并绑定 `IMAGE` 实体，随后外层 `<a>` 在包含该 `\uFFFC` 的区间上再次绑定 `LINK` 实体，导致同一字符槽位的实体引用发生覆盖冲突或触发 `ArticleEntityDraftCreate` 校验错误。

**合规要求**：
严禁在 `<a>` 内部直接或间接嵌套 `<img>`；同一 `ContentBlock` 内的所有 `entityRanges` 必须按 `offset` 严格递增且互不重叠。

---

### 4.2 `content-loss`（ContentState 零丢字、零丢图与空块坍塌防护契约）

**错误场景**：
1. **非空输入坍塌为空块数组**：输入 DOM 包含可见文字或媒体（`<img>` / `<hr>`），但仿真转换后 `draftState.blocks.length === 0`（或整个文档为空文档且未触发其他规则时 `blocks.length === 0`）。
2. **可见字符序列不守恒**：DOM 树提取的全部可见非空白字符序列（剔除空白符与 `\uFFFC` 后）与 `draftState.blocks.map(b => b.text).join('')` 的非空白字符序列不一致（包括字符静默丢失、顺序错乱，或因未光栅化节点导致的字符重影翻倍）。
3. **媒体与分割线实体数量不守恒**：
   - DOM 中 `<img>` 节点总数 $\neq$ `draftState.entityMap` 中 `type === 'IMAGE'` 的实体总数；
   - DOM 中 `<hr>` 节点总数 $\neq$ `draftState.entityMap` 中 `type === 'DIVIDER'` 的实体总数。
4. **语义块空块坍塌**：DOM 中存在不包含任何可见字符（剔除 `\s`、`\u200B-\u200D`、`\uFEFF`、`\uFFFC` 后长度为 `0`）且不包含任何有效媒体（`<img>`、`<hr>`）的空块级元素（`<h1>`、`<h2>`、`<p>`、`<blockquote>`、`<pre>`、`<ul>`、`<ol>`、`<li>`、`figure`、`figcaption`、`div`）。

**示例**：
```html
<!-- ❌ 错误示例：残留空标题与空段落，粘贴后导致块坍塌或产生异常空行 -->
<h2 class="morph-h2">   </h2>
<p class="morph-p">&#8203;</p>
<blockquote class="morph-quote"></blockquote>
```

**X 平台机制与影响说明**：
X 粘贴器在构建 `content_state.blocks` 序列时会自动忽略或合并纯空白块；同时，若适配器在处理复杂容器时意外丢弃了子节点文本、图片或分割线，会导致最终粘贴至 X Articles 的内容残缺，严重违反 MorphMD“原稿语义零篡改”的核心领域红线。

**合规要求**：
转换前后的非空白可见字符序列、`IMAGE` 实体计数与 `DIVIDER` 实体计数必须 **100% 严格守恒**，且文档树中不得残留无文本、无媒体的空语义块。

---

### 4.3 Unicode 码点度量（`UnicodeUtils.strlen`）、`TWEMOJI` 偏移对齐与空白符细则

为确保 `simulateDraftJsConvertFromHtml` 与 X Articles 内部 `content_state` 编码器（及 `TWEMOJI` / `LINK` 偏移量计算）完全一致，仿真器严格遵循以下底层编码契约：

1. **Unicode 码点（Code Point）偏移量计算**：
   - JavaScript 原生 `String.prototype.length` 返回 UTF-16 代码单元（Code Unit）数量，对于辅助平面字符（Astral Symbols，码点 `> U+FFFF`，如 Emoji `🚀`、数学粗体符号 `𝕏`、罕见汉字，由高代理项 `0xD800..0xDBFF` 与低代理项 `0xDC00..0xDFFF` 组成），`.length` 会计为 `2`。
   - X Articles 的 `content_state`（含 `TWEMOJI` 实体与 `inlineStyleRanges` / `entityRanges`）规定 **`offset` 和 `length` 必须按 Unicode 码点（`UnicodeUtils.strlen`）计数**。仿真器通过识别代理对将每个辅助平面字符精确计为 `1`，防止含 Emoji 或数学符号的段落后续加粗/超链接区间发生偏移错位。
2. **换行符与边界空白归一化**：
   - 文本节点内的 `\r\n` 与 `\r` 统一归一化为 `\n`；
   - `<br>` 标签在当前块内转换为 `\n`；
   - `<pre>`（`code-block`）块仅剥离末尾单个多余的 `\n`，完整保留块内所有缩进空格与空行；
   - 非 `<pre>` 且非 `atomic` 的普通块自动剥离块尾连续的 `\n+`，并裁剪行内缓冲区首尾的纯空白文本节点（`trimBoundaryWhitespaceNodes`）。

---

## 5、常见 Markdown 元素在 X Articles 真实编辑器下的行为与降级速查表

| Markdown 语法 / 扩展元素 | 原始 HTML 表现 | X Articles 真实编辑器直接粘贴后果 | `x-article` 合规转换与交付策略 |
| :--- | :--- | :--- | :--- |
| **一级至二级标题** (`#` / `##`) | `<h1>` / `<h2>` | 映射为正文大标题（Heading）与副标题（Subheading） | 保持原生 `<h1>` 与 `<h2>`（禁止标题内嵌块级元素） |
| **三级至六级标题** (`###` ~ `######`) | `<h3>` ~ `<h6>` | 超出 X 正文两档标题限制，退化为 `unstyled` 普通正文 | 归一化为 `<h2 data-original-heading="h3..h6">`（`#1.1`） |
| **GFM 提示框** (`> [!NOTE]` 等) | `<div class="morph-callout">` | 拍平为无左竖线的 `unstyled` 普通段落 | 转换为 `<blockquote>` + 首段 `<p><strong>标题</strong></p>`（`#1.2`） |
| **GFM 表格** (`\| a \| b \|`) | `<table>...</table>` | X 无原生表格组件，单元格标签被剥离、文字粘连错乱 | 光栅化为真 PNG 位图 `<img data-morph-rasterized="true">` + 完整 `alt`（`#1.3`） |
| **数学公式** (`$...$` / `$$...$$`) | `.katex-mathml` + `.katex-html` | 外部 CSS 剥离且忽略 `aria-hidden`，产生三倍重影乱码 | 光栅化为真 PNG 位图 `<img data-morph-rasterized="true" data-math-tex="...">`（`#2.1`） |
| **SVG 矢量图 / Mermaid 图表** | `<svg>...</svg>` | X 粘贴器与 `upload.x.com` 均不解析 `<svg>`，图形蒸发 | 光栅化为真 PNG 位图 `<img data-morph-rasterized="true">`（`#2.2`） |
| **本地粘贴图片** (`morph-asset://`) | `<img src="morph-asset://...">` | 无法解析内部协议或 `blob:`，无法转存为 `MEDIA` 实体 | 由 `AssetStore` 替换为真 PNG/JPEG/WebP `data:` URL 或 `https://` URL，并记录 `blockIndex`（`#2.3`） |
| **带超链接的图片** (`[![alt](img)](url)`) | `<a href="..."><img .../></a>` | X 图片不支持绑定外链，触发单字符 `LINK` + `IMAGE` 双实体冲突 | 拆分为独立图片与显式文本链接，严禁 `<a>` 包裹 `<img>`（`#4.1`） |
| **水平分割线** (`---`) | `<hr>` | 映射为 `atomic` + `DIVIDER` 实体（部分粘贴路径易吞裸 `<hr>`） | 保持标准顶层 `<hr>` 映射为 `DIVIDER` 实体并校验数量守恒（`#0.5`、`#4.2`） |
| **独立行 X 推文链接** | `<p><a href="https://x.com/.../status/...">...</a></p>` | X 自动识别并展开为 `atomic` + `TWEET` 嵌入推文卡片 | 保持独立段落 `<p>` 包裹合法 `https://x.com` 链接（`#0.1`、`#2.3`） |
| **深层嵌套列表** (`> 5` 级) | `<ul>` / `<ol>` 嵌套深度 $> 5$ | 超出 `maxDepth = 4`，缩进样式丢失或被后端强制拍平 | 控制列表嵌套深度 $0 \le \text{depth} \le 4$（`#1.5`） |
| **自定义主题色 / 行内样式** | `<span style="color:...">` | X 强制清洗所有原生节点上的 `style` 属性，伪所见即所得 | 剥离非 `<pre>` 节点的 `style` 并输出样式能力守卫告警（`#3.1`） |
