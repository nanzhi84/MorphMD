# 自定义 CSS 编写指南

MorphMD 提供了基于受控样式内联引擎的自定义 CSS 排版能力。创作者可以通过编写标准 CSS 选择器与引用内置 Design Tokens 变量，实现一套样式在微信公众号、图文卡片与多渠道平台之间的一致渲染。

## 一、工作原理与跨端适配机制

### 1.1 受控样式内联引擎

现代内容发布平台（特别是微信公众号富文本编辑器）出于安全和样式隔离考虑，会直接剥离 HTML 文档中的 `<style>` 标签与 `<link>` 外部样式表。

MorphMD 采用**受控样式内联引擎**（Controlled Style Inlining Engine）解决跨平台排版丢失问题：

1. **AST 静态安全分析**：通过 CSS-Tree 遍历解析自定义 CSS 语法树，执行选择器作用域校验与危险语法过滤。
2. **Design Tokens 动态求值**：计算当前纸张主题、强调色与排版参数所声明的 CSS 自定义属性（`var(--morph-*)`），在沙箱环境中完成级联解析与循环依赖规避。
3. **特异性与层叠排序**：支持标准 CSS Specificity 权重计算、`@layer` 规则层叠与 `!important` 优先级裁决。
4. **两阶段内联编译**：在隔离的 DOM 沙箱中匹配目标节点，计算最终样式并将其序列化注入到每个 HTML 元素的内联 `style` 属性中。
5. **伪元素物化**：将 CSS 伪元素规则转换为真实的 DOM 节点并内联样式，使不支持伪元素的富文本环境也能呈现装饰效果。

### 1.2 跨端发布目标适配差异

MorphMD 针对不同发布渠道的排版引擎特性进行了定向适配：

| 发布目标 | 标识符 (`targetId`) | 样式内联策略 | 复杂块处理方案 | 链接处理规则 |
| :--- | :--- | :--- | :--- | :--- |
| **微信公众号** | `wechat` | 强制求值并内联至所有节点的 `style` 属性；过滤非白名单属性 | 数学公式与 SVG 自动编译并转为自包含矢量/位图 | 外部链接降级为行内文本并在末尾展开 URL |
| **图文卡片** | `cards` | 完整内联排版样式；支持卡片页眉页脚与分页断点控制 | 保留完整 DOM 结构，通过排版引擎进行智能高度测量与切页 | 保留完整文本并自动附带展开 URL 便于读者查阅 |
| **X 长文** | `x-article` | 剥离所有内联 `style`，仅保留 X 平台支持的原生语义标签 | 表格、数学公式、代码块与 SVG 高清 Canvas 光栅化输出 | 保留原生标准超链接 `<a>` 标签 |

## 二、语义化选择器参考

MorphMD 在 Markdown 编译期会为生成的 HTML 结构自动挂载语义化类名。编写自定义 CSS 时，应优先使用以 `.morph-*` 为前缀的类选择器或原生文本修饰标签。

### 2.1 核心容器与块级结构选择器

| 选择器 | 目标元素 | 语义说明与排版建议 |
| :--- | :--- | :--- |
| `.morph-doc` | `<div>` / `<section>` | 文档根容器，承载文档基础字号、背景色、墨水色与行高基准。 |
| `.morph-h1` | `<h1>` | 一级标题，通常作为文章主标题，建议设置较大的行高与下边距。 |
| `.morph-h2` | `<h2>` | 二级标题，核心章节分节标题，常配合左侧修饰线或底边框。 |
| `.morph-h3` | `<h3>` | 三级标题，小节标题，建议字号略大于正文且字重加粗。 |
| `.morph-h4` | `<h4>` | 四级标题，次级小节标题，保持紧凑的上下外边距。 |
| `.morph-p` | `<p>` | 正文段落，承载主要文字内容，建议设置 `1.6` ~ `1.8` 的舒适行高。 |
| `.morph-quote` | `<blockquote>` / `<p>` | 引用块容器，在微信平台会自动规范化为单层结构以消除双重边线。 |
| `.morph-callout` | `<div>` / `<p>` | 提示卡片外层容器，具备独立背景底色与醒目的左侧强调边线。 |
| `.morph-callout-title` | `<div>` / `<span>` | 提示卡片标题栏，通常包含图标文本与加粗标题。 |
| `.morph-callout-body` | `<div>` / `<span>` | 提示卡片正文容器，其内部段落采用紧凑无额外外边距布局。 |
| `.morph-code` | `<pre>` | 代码块外部容器，默认配置等宽字体、水平滚动与背景填充。 |
| `.morph-list` | `<ul>` / `<ol>` | 列表容器，默认包含标准缩进与紧凑的项目间距。 |
| `.morph-img` | `<img>` | 文章插图节点，默认具备最大宽度限制、自适应高度与圆角修饰。 |

### 2.2 链接展开与行内修饰选择器

| 选择器 | 目标元素 | 语义说明与排版建议 |
| :--- | :--- | :--- |
| `.morph-link-text` | `<span>` | 外部超链接降级后的文本包裹节点，保留原链接的文字样式。 |
| `.morph-link-url` | `<span>` | 微信与卡片中外链自动展开的地址文本，通常采用次级灰度与缩小等宽字体。 |
| `strong` | `<strong>` | 粗体强调文本，用于突出关键信息。 |
| `em` | `<em>` | 斜体强调文本，MorphMD 默认优化为中文楷体栈并消除机械倾斜。 |
| `code` | `<code>` | 正文行内代码胶囊（`:not(pre) > code`），常用于命令、变量名或快捷键标注。 |
| `a` | `<a>` | 原生超链接锚点，在支持原生链接的导出模式中生效。 |

### 2.3 伪元素自动物化机制 (`::before` / `::after`)

微信富文本编辑器会丢失 CSS 伪元素（`::before` 与 `::after`）。为了兼顾现代 CSS 排版习惯与微信平台兼容性，MorphMD 实现了伪元素自动物化机制：

- 当自定义 CSS 中包含 `.morph-h2::before` 或 `.morph-quote::before` 等规则且声明了 `content` 属性时，样式引擎会在目标节点内部首尾自动生成真实的 `<span data-morph-pseudo="before">` 或 `<span data-morph-pseudo="after">` 元素。
- 伪元素上声明的字号、颜色、内边距、边框与 CSS 变量会自动求值并作为内联 `style` 写入物化节点中。

## 三、内置主题变量 (Design Tokens)

MorphMD 内置了一组标准 Design Tokens 变量。在自定义 CSS 中通过 `var(--token-name)` 引用这些变量，可以在用户切换工具栏的「强调色」、「纸张模式」或「排版参数」时自动实现全局联动。

| Token 变量名称 | 默认取值 | 语义与推荐应用场景 |
| :--- | :--- | :--- |
| `var(--morph-accent)` | `#0969da` | 品牌强调色。用于二级标题左线、重点文字标记、引用块装饰与按钮高亮。 |
| `var(--morph-ink)` | `#24292e` | 正文主墨水色。随纸张浅色/深色模式自动适配，保证最佳对比度。 |
| `var(--morph-bg)` | `#ffffff` | 画布与纸张背景底色。适配纯白、暖白、羊皮纸与暗色背景。 |
| `var(--morph-font-sans)` | 系统无衬线字体栈 | 现代正文排版字体栈，优先调用苹方、Inter 与系统高清晰度字体。 |
| `var(--morph-font-serif)` | `"Source Serif 4", Georgia, serif` | 经典人文衬线字体栈，适用于主标题、诗歌或刊物风格排版。 |
| `var(--morph-font-mono)` | 等宽字体栈 | 代码字体栈，适用于代码块、行内指令及展开 URL 文本。 |
| `var(--morph-body-size)` | `16px` | 正文字号基准值。建议以此作为正文排版与相对比例运算的基准。 |
| `var(--morph-line-height)` | `1.75` | 正文基准行高。推荐保持在 `1.6` ~ `1.8` 之间以获得良好的段落通透感。 |
| `var(--morph-block-gap)` | `1.25rem` | 块级元素纵向外边距。用于统一控制段落、列表与引用之间的垂直节律。 |

> 自定义 CSS 中亦支持声明私有 CSS 变量（如 `--brand-color: #d9730d;`），引擎会完整支持级联推导与局部重写。

## 四、常用排版实战示例

### 示例一：二级标题左侧强调竖线

为二级标题添加与主题色联动的左侧加粗竖线，增强长文阅读中的层级定位感：

```css
.morph-h2 {
  border-left: 4px solid var(--morph-accent);
  padding-left: 12px;
  margin-top: 28px;
  margin-bottom: 16px;
  font-family: var(--morph-font-serif);
  font-size: 20px;
  line-height: 1.4;
  color: var(--morph-ink);
}
```

### 示例二：引用容器暖灰卡片与圆角边框

将默认的引用块转换为柔和质感的轻量信息卡片：

```css
.morph-quote {
  background-color: #f7f7f5;
  border: 1px solid #e9e9e7;
  border-left: 4px solid var(--morph-accent);
  border-radius: 6px;
  padding: 12px 16px;
  margin-top: 0px;
  margin-bottom: 20px;
  color: var(--morph-ink);
  font-size: 15px;
  line-height: 1.7;
}
```

### 示例三：中文楷体强调与荧光笔重点标记

优化中西文混排细节，将斜体转换为典雅的书刊楷体，并将重点粗体加注荧光笔底色：

```css
/* 中文优雅斜体：消除机械倾斜，采用标准人文楷体 */
em {
  font-family: "LXGW WenKai", "Kaiti SC", "STKaiti", "KaiTi", "Newsreader", Georgia, serif;
  font-style: normal;
  color: #32383f;
  padding: 0 2px;
}

/* 荧光笔高亮标注：为重要加粗词句增加醒目的柔光背景 */
.morph-p strong {
  background-color: #faebdd;
  color: var(--morph-ink);
  padding: 2px 4px;
  border-radius: 3px;
  font-weight: 600;
}
```

### 示例四：提示块 (Callout) 品牌定制

精细化定制注意提示块（Callout）的标题与正文样式：

```css
.morph-callout {
  background-color: #f4f6f8;
  border-left: 4px solid var(--morph-accent);
  border-radius: 0 8px 8px 0;
  padding: 14px 16px;
  margin-top: 0px;
  margin-bottom: 18px;
}

.morph-callout-title {
  font-weight: 600;
  font-size: 15px;
  line-height: 1.5;
  margin-bottom: 6px;
  color: var(--morph-accent);
}

.morph-callout-body {
  font-size: 14px;
  line-height: 1.65;
  color: var(--morph-ink);
}
```

## 五、平台安全白名单与排版建议

### 5.1 字号、行高与无障碍对比度

1. **移动端黄金阅读字号**：正文文本推荐保持在 `15px` ~ `16px`。字号过小（< 14px）在手机端阅读易引起视觉疲劳，字号过大（> 18px）会导致每行汉字容纳量过低而频繁断行。
2. **段落间距与垂直韵律**：段落之间建议依靠单向的 `margin-bottom: 16px` 控制流向，避免同时设置上下外边距导致跨宿主（Flex 布局与 Block 盒模型）间距计算失真。
3. **色彩对比度要求**：文字颜色与底色需符合 Web 内容无障碍指南（WCAG AA 级）标准，即普通文本色彩对比度不低于 4.5:1，大标题对比度不低于 3:1。

### 5.2 外部链接的跨端降级展开

微信公众号等封闭内容生态限制在文章正文中点击非官方域名的外部超链接。为解决读者获取参考文献的问题，MorphMD 制定了自动降级处理机制：

- **DOM 结构自动重构**：正文中的 `<a href="https://example.com">示例网站</a>` 会被转换为包含文本的 `<span class="morph-link-text">示例网站</span>`，并在紧邻其后追加带有括号的 URL 节点 `<span class="morph-link-url link-url"> (https://example.com)</span>`。
- **视觉层级分离**：展开的 URL 采用 `0.85em` 字号、等宽字体与低明度中性灰（`#8C857B`），保持信息完整性的同时最大程度减少对正文主阅读流的干扰。

### 5.3 安全沙箱过滤与受限语法

MorphMD 内置的 CSS 安全沙箱会在编译期拦截潜在的破坏性样式，以防止破坏公众号后台或导出画布的稳定性：

| 受限语法 / 属性 | 处理动作 | 拦截原因 |
| :--- | :--- | :--- |
| `position: fixed` | 强制剔除并警告 | 绝对/固定定位会脱离文档流，导致微信文章排版崩溃或覆盖平台导航。 |
| `z-index` | 强制剔除并警告 | 避免浮动层级冲突干扰宿主编辑器控件。 |
| 外部 `@import` | 强制拦截并报错 | 禁止引入未受信任的外部远程样式表，防范样式注入风险。 |
| `body` / `html` / `#app` | 规则整条移除 | 禁止选择器穿透到全局视口，自定义规则必须收敛于 `.morph-doc` 命名空间内部。 |
| `overflow: hidden / clip` | 在图文卡片中移除 | 在 `cards` 模式下，非法隐藏溢出将破坏分页算法的精确内容测量，导致文字断层。 |
| `javascript:` / `expression()` | 强制剔除并报错 | 严禁任何形式的动态脚本与伪协议注入。 |

如在自定义 CSS 中使用了上述受限语法，编辑器左下角诊断面板将以精确行号的形式提示违规位置与修复方案。
