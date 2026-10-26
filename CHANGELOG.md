# Changelog

本项目的所有重要版本变更、新特性汇总与修复记录均归档于此。

## [Unreleased]

### Added
- 初始化项目 Universal Harness 目录结构与文档规范。
- 确立 [ADR-0002](docs/adr/0002-isomorphic-delivery-snapshot-and-asset-pipeline.md) 架构基线（取代 [ADR-0001](docs/adr/superseded/0001-unified-ast-and-pluggable-view-adapters.md)）：引入版本化同构交付快照、`cards` 可选常用画布比例预设（`3:4` / `4:5` / `1:1` / `16:9`）与回溯分页引擎、受控白名单 CSS 内联，以及 `AssetStore`（`morph-asset://`）静态资产管线与右栏选区重建自由复制机制。
- 完成 [Issue #2](docs/spec/issue#2/spec.md) 端到端同构交付内核：实现统一 AST 与重型块增量缓存（`compileMarkdownToAst`）、静态资产管线（`AssetStore`）、受控 CSS 白名单内联（`compileScopedCss`）、三大目标视图归一化器（`normalizeForWechat`、`normalizeForXArticle`、`normalizeForCards`）、局部选区自由复制重建（`normalizeSelectionRange`）与会话控制器（`EditorSessionController`）。
- 完成 [Issue #3](docs/spec/issue#3/spec.md) 三栏同构工作台 UI：采用 Notion 炭黑极简视觉体系（`#37352F` 主炭黑、`#F7F7F5` 暖白画布、零高饱和紫色），打通三态视图切换、比例画布调节、图片粘贴入库、右栏选区复制、右侧样式设置抽屉以及左下角 Overleaf / VS Code 风格悬浮警告与诊断浮层（`diagnostics-popover`）。
