# PROJECTS.md — MorphMD 项目特异规范与领域红线

## 1. 项目定位与命名约定
- **项目名称**：`MorphMD`（基于“一源多态 Multi-target Rendering”架构的轻量级统一 Markdown 编辑器）。
- **核心目标视图标识符（Target ID）**：
  - `wechat`：微信公众号长文视图（支持微信兼容富文本复制）
  - `x-article`：X (Twitter) Articles 长文视图（支持富文本与清洁格式复制）
  - `social-cards`：多页图文卡片视图（支持自动分页预览与高分 PNG / ZIP 批量导出）

## 2. 领域红线与不变量
- **原稿语义零篡改（Source Fidelity）**：所有目标视图必须派生自同一份源 Markdown，严禁任何视图适配器增删、润色、摘要或静默丢弃用户的正文语义、标点、代码块、引用或链接。
- **单一设计变量与可扩展样式边界**：配色、字体族、字号与间距等视觉属性统一由共享设计变量（Design Tokens）与用户自定义 CSS 覆盖层驱动，禁止将单一视图硬编码为不可调节的死板模板。
- **预览与交付产物一致性**：右侧 Tab 预览所呈现的排版、分页、列表缩进与代码高亮，必须与最终复制（`wechat` / `x-article`）或导出（`social-cards` 图文图片包）的实际交付产物保持视觉一致。
- **架构与决策入口**：全局架构现状详见 [docs/architecture/overview.md](docs/architecture/overview.md)，核心架构权衡与模块选型详见 [ADR-0001](docs/adr/0001-unified-ast-and-pluggable-view-adapters.md)。
