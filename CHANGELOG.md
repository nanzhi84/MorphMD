# Changelog

本项目的所有重要版本变更、新特性汇总与修复记录均归档于此。

## [Unreleased]

### Added
- 初始化项目 Universal Harness 目录结构与文档规范。
- 确立 [ADR-0002](docs/adr/0002-isomorphic-delivery-snapshot-and-asset-pipeline.md) 架构基线（取代 [ADR-0001](docs/adr/superseded/0001-unified-ast-and-pluggable-view-adapters.md)）：引入版本化同构交付快照、`cards` 可选常用画布比例预设（`3:4` / `4:5` / `1:1` / `16:9`）与回溯分页引擎、受控白名单 CSS 内联，以及 `AssetStore`（`morph-asset://`）静态资产管线与右栏选区重建自由复制机制。
