<p align="center">
  <!-- <img src="docs/assets/logo.svg" alt="MorphMD Logo" width="96"> -->
</p>

<h1 align="center">MorphMD</h1>

<p align="center"><strong>一源多态（Multi-target Rendering）的轻量级统一 Markdown 编辑器</strong></p>

<p align="center">
  <code>MorphMD</code> 在底层维护同一棵 Markdown AST（基于 Unified / Remark 生态），在渲染层挂载可插拔的视图适配器（View Adapters）。左侧编写一份 Markdown，右侧即可像切换 Tab 一样在<strong>微信公众号</strong>、<strong>X 文章</strong>与<strong>多页图文卡片</strong>之间无缝切换预览，共享同一套配色与字体设计变量（Design Tokens），支持自由编写 CSS 微调样式，并提供一键富文本复制与高清图文导出。
</p>

## Core ideas

- **一源多态（Single AST, Multi-target Adapters）**：底层共享同一棵 Unified / Remark 语法树，渲染层按需挂载 `wechat`（公众号）、`x-article`（X 长文）、`social-cards`（多页图文卡片）视图适配器，告别多脚本割裂排版。
- **共享 Design Tokens + 开放式 CSS 拓展**：提炼统一的字体、字号、行高与色彩设计变量，一套主题跨端同步生效；同时内置自定义 CSS 编辑器，支持随时覆写全局或特定视图版式。
- **所见即所得的复制与图文导出**：内置微信公众号样式内联与 SVG/公式自动转 PNG 剪贴板管线、X 文章富文本复制管线，以及多页图文卡片流式自动分页与高分 PNG / ZIP 批量导出能力。

## Get started

```bash
# 运行仓库结构、架构图约定与文档死链巡检
harness doctor
```

## Learn more

- **Agent 与项目特异规则**：[AGENTS.md](AGENTS.md) · [PROJECTS.md](PROJECTS.md)
- **文档导航与全局架构**：[文档维护规范](docs/README.md) · [全局架构现状](docs/architecture/overview.md) · [ADR-0001](docs/adr/0001-unified-ast-and-pluggable-view-adapters.md)
- **参考资料与版本记录**：[参考资料索引](docs/reference/INDEX.md) · [CHANGELOG.md](CHANGELOG.md)
