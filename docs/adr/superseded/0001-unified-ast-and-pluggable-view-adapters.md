# ADR-0001: 统一 Markdown AST、可插拔视图适配器与可扩展样式体系

- **状态 (Status)**：Superseded by [ADR-0002](../0002-isomorphic-delivery-snapshot-and-asset-pipeline.md)
- **日期 (Date)**：2026-10-22

## 1. 背景与上下文 (Context)

在日常多平台内容发布流程中，同一篇 Markdown 原稿往往需要同时投递为**微信公众号长文**、**X (Twitter) Articles** 以及**小红书/社交平台多页竖版图文卡片**。
既有独立工作流（如 `publish-wechat` 专用内联排版器、`article-to-social-cards` 固定尺寸分页制卡流水线）虽然验证了单平台交付规则，但存在两项明显局限：
1. **工具链割裂**：创作者需要在多个孤立脚本或页面间反复切换，无法在同一工作区内实时对比同一篇 Markdown 在不同媒介形态下的排版效果。
2. **模板刚性、缺乏样式拓展性**：既有工具将字号、行高、配色与边距写死在固定模板中，用户无法在不改动底层源码的前提下调整主题变量（Design Tokens）或通过自定义 CSS 微调版式。

## 2. 决策方案 (Decision)

1. **底层维护单一 Markdown AST（基于 Unified / Remark / Rehype 生态）**：
   - 左侧编辑器输入的 Markdown 经统一解析管线生成标准语法树（mdast -> hast），在 AST 层面统一处理 GFM 表格、任务列表、数学公式（KaTeX/MathJax）、代码语法高亮、Callout 块、Emoji 字素簇与图片/SVG 资源引用。
2. **渲染层挂载可插拔视图适配器（Pluggable View Adapters）**：
   - 右侧预览区以 Tab 形态挂载不同目标平台的适配器，消费同一棵 AST 并按平台契约渲染：
     - **`wechat`（微信公众号适配器）**：将 CSS 变量与自定义样式编译为微信编辑器可存活的内联 `style`，自动将列表转换为防断行悬挂缩进段落，并在复制时将内联 SVG 与公式光栅化为高清 PNG。
     - **`x-article`（X 文章适配器）**：面向 X Articles 富文本编辑器契约，输出适配其标题层级、引用块、代码块与列表语义的清洁富文本结构。
     - **`cards`（多页图文适配器）**：基于固定画布比例（如 3:4 / `1440×2036`）在浏览器端执行确定性 DOM 自动流式分页（支持跨页列表拆分、跨页表格表头重复、封面与页脚定制），并提供单张或整套 PNG / ZIP 高清导出。
3. **共享 Design Tokens + 自定义 CSS 覆盖的双层样式架构**：
   - 顶层提取跨视图共享的 CSS Custom Properties（`--morph-bg`、`--morph-ink`、`--morph-accent`、`--morph-font-serif`、`--morph-font-sans`、`--morph-font-mono`、`--morph-body-size`、`--morph-line-height` 等），切换一套主题即可同步作用于“公众号”“X 文章”“图文”三种视图。
   - 开放用户级 Custom CSS 编辑器（支持全局作用域与 `[data-view="wechat|x-article|cards"]` 视图作用域），允许用户像写普通 CSS 一样自由覆写任何块级或行内样式，并在导出/复制管线中自动完成样式内联（Computed Style Inlining）或画布快照。

## 3. 影响与后果 (Consequences)

- **正面收益**：
  - 真正实现“一次编写、多端实时预览与交付”，大幅缩短跨平台排版时间。
  - 样式系统兼具开箱即用的预设主题与完全开放的 CSS 自定义能力，摆脱单一固定模板束缚。
  - 新增平台（如知乎、Newsletter 等）只需实现新的 `ViewAdapter` 接口，无需改动 AST 核心解析层。
- **潜在代价与约束**：
  - 微信公众号等受限富文本环境不支持外部 `<style>` 表，自定义 CSS 在走 `wechat` 复制管线时必须通过计算样式内联器（CSS Inliner）转换为节点级 `style` 属性。
  - `cards` 视图在用户大幅修改字号或行高后，需响应式重算分页边界并保持不拆碎原子块（如单行标题或公式块）。

## 失效说明 (Superseded Note)

- **失效日期**：2026-10-23
- **原因总结**：原方案将 `cards` 视图局限于单一固定尺寸（且将 `1440×2036` 误标为 `3:4`），未支持可选常用画布比例预设；同时将样式内联与资源光栅化后置到点击复制阶段，缺乏 `AssetStore` 静态资产管线、右栏原生选区上下文重建（Selection Normalizer）、受控白名单样式内联及平台样式能力守卫，无法闭环支撑真所见即所得与右栏图文一体自由复制。
