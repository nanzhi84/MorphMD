<p align="center">
  <!-- <img src="docs/assets/logo.svg" alt="MorphMD Logo" width="96"> -->
</p>

<h1 align="center">MorphMD</h1>

<p align="center"><strong>一源多态（Multi-target Rendering）的轻量级统一 Markdown 编辑器</strong></p>

<p align="center">
  <code>MorphMD</code> 在底层维护同一棵 Markdown AST（基于 Unified / Remark 生态）与静态资产中心（<code>AssetStore</code>），在渲染层挂载可插拔的视图适配器（View Adapters）。左侧支持像 Typora 一样随手粘贴图片并编写一份 Markdown，右侧即可像切换 Tab 一样在<strong>微信公众号</strong>、<strong>X 文章</strong>与<strong>多比例图文卡片</strong>（支持 <code>3:4</code> / <code>4:5</code> / <code>1:1</code> / <code>16:9</code> 等常用画布比例预设）之间无缝切换同构预览，共享同一套设计变量（Design Tokens）与受控自定义 CSS，并提供一键全文复制、右栏鼠标自由框选图文复制与高清图文导出。
</p>

## Core ideas

- **一源多态与同构交付快照（Single AST, Isomorphic Delivery Snapshot）**：底层共享同一棵 Unified / Remark 语法树与版本化交付快照，渲染层挂载 `wechat`（公众号）、`x-article`（X 长文）、`cards`（多页图文卡片）视图适配器，预览即最终降级结构。
- **类 Typora 极速贴图 + 右栏图文自由复制（`AssetStore` & Selection Normalizer）**：左栏粘贴图片自动生成清爽的 `morph-asset://` 短协议引用，右栏不仅实时无闪烁渲染，还支持一键复制全文或直接用鼠标自由框选任意段落与图片按 `Cmd/Ctrl + C` 带样式复制。
- **共享 Design Tokens + 受控 CSS 拓展**：提炼统一的字体、字号、行高与色彩设计变量，结合稳定语义类名（`.morph-*`）、CSS AST 白名单内联与平台样式能力守卫，兼顾跨视图自由定制与平台兼容保真。
- **多比例流式分页与高清图文导出**：`cards` 视图内置 `3:4`（`1440×1920`）、`4:5`、`1:1`、`16:9` 等常用社交画布比例预设，支持回溯增量分页（Look-back Reflow）、超高块自动兜底缩放与高分 PNG / ZIP 批量导出。

## Get started

```bash
# 运行仓库结构、架构图约定与文档死链巡检
harness doctor
```

## Learn more

- **Agent 与项目特异规则**：[AGENTS.md](AGENTS.md) · [PROJECTS.md](PROJECTS.md)
- **文档导航与全局架构**：[文档维护规范](docs/README.md) · [全局架构现状](docs/architecture/overview.md) · [ADR-0002](docs/adr/0002-isomorphic-delivery-snapshot-and-asset-pipeline.md)
- **参考资料与版本记录**：[参考资料索引](docs/reference/INDEX.md) · [CHANGELOG.md](CHANGELOG.md)
