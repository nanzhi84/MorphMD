# 工作台顶栏精简、触控板丝滑缩放、下拉箭头内缩与 X 自动贴图油猴脚本（Status Dot 胶囊）

> **Status:** In Progress · Issue #6 · Created 2026-10-28
> **Affected Architecture:** [docs/architecture/overview.md](../../architecture/overview.md) · [ADR-0002](../../adr/0002-isomorphic-delivery-snapshot-and-asset-pipeline.md)

## 1. 背景与目标 (Context & Goals)

围绕 `x-article` 图文一体粘贴体验落地及工作台顶栏与预览控件的视觉交互打磨，本期（Issue #6）解决以下四项核心问题：

1. **下拉选择框（`.morph-select`）向下箭头过于贴近右边缘**：
   - 原生 `<select>` 在 macOS 浏览器下默认将下拉箭头渲染在紧贴右边框（仅约 `3px~4px`）的位置，视觉上显得局促拥挤。需要将箭头向左侧内缩，留出舒适的右侧边距与文字间距。
2. **顶栏冗余按钮清理（移除撤销、重做与 `.md + assets` 导出按钮）**：
   - 顶栏右侧操作区（`.morph-header-actions`）原先摆放的撤销（`undo-btn`）、重做（`redo-btn`）与 `导出 .md + assets`（`export-package-btn`）三个按钮占用了过多横向空间，且编辑器 textarea 原生支持系统快捷键撤销/重做，无需在顶栏重复堆砌按钮。
3. **移除顶栏固定比例下拉框，支持 Mac 触控板在预览区丝滑缩放**：
   - 移除顶栏的 `100%` 缩放比例下拉框（`zoom-select`），改为在预览区滚动容器（`.morph-preview-scroll`）内直接响应 Mac 触控板双指捏合缩放手势（`WheelEvent` 携带 `ctrlKey` / `metaKey`），实现连续、丝滑的无级缩放体验。
4. **新增「X 自动贴图油猴脚本」状态指示圆点（Status Dot）胶囊按钮与配套 `.user.js` 脚本**：
   - 由于 X Articles（`x.com/compose/article`）底层 Draft.js `editOnPaste` 在检测到剪贴板包含 `text/html` 时会进入纯文本/HTML 解析分支而忽略图片上传接口，需提供配套的油猴脚本（`public/morphmd-x-paste.user.js`）拦截富文本粘贴并将内嵌 `data:image/...` 位图转换为二进制 `File` 触发 X 原生上传接口（`handlePastedFiles` $\rightarrow$ `upload.x.com`）。
   - 在顶栏「复制富文本」按钮左侧放置油猴脚本状态胶囊按钮，摒弃 Emoji 状态符号，采用 **CSS 状态指示圆点（Status Dot）** 传达脚本就绪状态，并支持点击一键触发 `.user.js` 油猴安装页。

---

## 2. 方案设计 (Design & Contracts)

### 2.1 下拉框（`.morph-select`）箭头左移内缩样式契约（[`src/styles/workbench.css`](../../../src/styles/workbench.css)）

- 对 `.morph-select`（含预览区 `data-testid="canvas-preset-select"` 等下拉控件）应用自定义外观重置与内缩 SVG 箭头背景：
  - `appearance: none; -webkit-appearance: none;`
  - 右侧内边距扩大为 `padding: 0 32px 0 12px;`（确保选项文本与箭头之间留有充足间隔）；
  - 使用内联 SVG 向下箭头作为 `background-image`，设置 `background-repeat: no-repeat; background-position: right 12px center; background-size: 12px 12px;`，使向下箭头距离右边框稳定保持 `12px` 的内缩间距。

### 2.2 顶栏按钮精简契约（[`src/App.tsx`](../../../src/App.tsx)）

- 在顶部全局导航栏右侧 `.morph-header-actions` 中移除以下四个控件：
  - `data-testid="zoom-select"`（`100%` 缩放比例选择框）
  - `data-testid="undo-btn"`（撤销按钮）
  - `data-testid="redo-btn"`（重做按钮）
  - `data-testid="export-package-btn"`（`导出 .md + assets` 按钮）
- 精简后的 `.morph-header-actions` 仅保留核心交付与设置入口（按从左到右顺序）：
  1. `data-testid="x-userscript-pill"`（X 贴图油猴脚本 Status Dot 状态胶囊）
  2. `data-testid="primary-delivery-btn"`（「复制富文本」或「导出高清卡片」）
  3. `data-testid="toggle-style-drawer-btn"`（「样式设置」）

### 2.3 预览区 Mac 触控板丝滑缩放契约（[`src/App.tsx`](../../../src/App.tsx) & [`src/styles/workbench.css`](../../../src/styles/workbench.css)）

- 在预览滚动容器 `.morph-preview-scroll`（标注 `data-testid="preview-scroll"`）上绑定非被动（`{ passive: false }`）原生 `wheel` 事件监听器：
  - 当检测到 `event.ctrlKey === true` 或 `event.metaKey === true`（macOS 触控板双指捏合缩放在 Chromium / Safari / Firefox 中派发的标准手势事件）时：
    - 调用 `event.preventDefault()` 阻止浏览器整页缩放；
    - 根据 `event.deltaY` 计算连续缩放增量：`nextZoom = Math.min(2.5, Math.max(0.5, Number((currentZoom - event.deltaY * 0.008).toFixed(3))))`；
    - 实时更新 `.morph-preview-stage` 上的 `--stage-zoom` CSS 变量（非卡片视图下为 `zoomScale`，`cards` 视图下为 `Number((zoomScale * 0.68).toFixed(3))`）及 `data-zoom-scale={String(zoomScale)}` 属性。

### 2.4 Status Dot 油猴脚本胶囊按钮与 [`public/morphmd-x-paste.user.js`](../../../public/morphmd-x-paste.user.js) 契约

1. **顶栏 Status Dot 状态胶囊（`data-testid="x-userscript-pill"`）**：
   - 位于 `data-testid="primary-delivery-btn"`（「复制富文本」）的**正左侧**；
   - 渲染为 `<a href="morphmd-x-paste.user.js" target="_blank" rel="noopener noreferrer">` 胶囊链接，携带 `className="morph-userscript-pill is-ready | is-uninstalled"` 与 `data-status="ready" | "uninstalled"`，点击即可直接打开 `.user.js` 触发 Tampermonkey / Violentmonkey / ScriptCat 安装页；
   - 内部结构由左侧实心状态圆点 `<span className="morph-userscript-dot" data-testid="x-userscript-dot" aria-hidden="true" />` 与右侧纯文本标签 `<span className="morph-userscript-label" data-testid="x-userscript-label">` 组成，**严禁在胶囊内使用任何 Emoji 字符**：
     - **未就绪状态（未检测到 `window.__MORPHMD_USERSCRIPT_READY__`）**：
       - `data-status="uninstalled"`；
       - 状态圆点（`.morph-userscript-dot`）：宽高 `7px`（介于 `6px~8px`），实心圆（`border-radius: 50%`），呈现琥珀色 `#F59E0B`（`background-color: #f59e0b`）；
       - 胶囊边框：配合 `1px` 半透明边框（`border: 1px solid rgba(55, 53, 47, 0.16)`）；
       - 文本标签：`安装 X 贴图脚本`。
     - **已就绪状态（检测到 `window.__MORPHMD_USERSCRIPT_READY__ === true` 或收到 `morphmd:userscript-ready` 事件）**：
       - `data-status="ready"`；
       - 状态圆点（`.morph-userscript-dot`）：宽高 `7px`，切换为翠绿色 `#10B981`（`background-color: #10b981`），附加同色系外发光 `box-shadow: 0 0 6px rgba(16, 185, 129, 0.4)` 与呼吸动画（`@keyframes morphStatusPulse`）；
       - 文本标签：`X 贴图脚本已就绪`。

2. **配套油猴脚本（[`public/morphmd-x-paste.user.js`](../../../public/morphmd-x-paste.user.js)）**：
   - 包含完整 `==UserScript==` 头部元数据（`@name`、`@namespace`、`@version`、`@description`、`@match https://x.com/*`、`@match https://twitter.com/*` 及本地/线上工作台匹配规则、`@run-at document-start`、`@grant unsafeWindow`）；
   - **工作台端握手**：在页面上下文设置 `window.__MORPHMD_USERSCRIPT_READY__ = true`（若存在 `unsafeWindow` 同步设置 `unsafeWindow.__MORPHMD_USERSCRIPT_READY__ = true`），并派发 `new CustomEvent('morphmd:userscript-ready')`；
   - **X Articles 端图文拆解与原生上传触发**：
     - 在 `x.com/compose/article`（及 `twitter.com/compose/article`）监听捕获阶段 `paste` 事件；
     - 当剪贴板 `text/html` 包含内嵌位图（`<img src="data:image/...">`）时，拦截默认粘贴：
       1. 将每个 `data:image/(png|jpeg|webp|gif);base64,...` 解码为内存 `File` 对象，并在 HTML 对应位置替换为唯一占位锚点段落 `[[MORPH_IMG_SLOT_i]]`；
       2. 先向 Draft.js 编辑器派发携带占位锚点的富文本 `ClipboardEvent('paste')`，一次性建立所有标题、加粗、引用、列表与代码块；
       3. 随后依次在编辑器 DOM 中选中 `[[MORPH_IMG_SLOT_i]]` 文本范围并移除占位符，构造仅含二进制 `File` 的 `DataTransfer`（确保 `!data.isText()` 为 `true`）派发合成 `ClipboardEvent('paste')`，100% 触发 X 原生 `handlePastedFiles` 上传接口（`upload.x.com`）将图片插入对应段落位置。

---

## 3. 真实执行与验收标准 (Verification)

### 3.1 实施与验收 Checklist

- [x] 由独立子代理（Fresh Subagent）严格依据本 Spec 更新/编写黑盒测试（覆盖顶栏移除撤销/重做/导出 `.md + assets`/缩放下拉框、保留主交付按钮左侧的 Status Dot 油猴脚本胶囊及未安装 `#F59E0B` 琥珀色与已就绪 `#10B981` 翠绿色 + 外发光切换、无 Emoji 文本、预览区 Mac 触控板 `ctrlKey`/`metaKey` `wheel` 捏合连续缩放、`.morph-select` 箭头内缩样式，以及 `public/morphmd-x-paste.user.js` 脚本存在性与核心逻辑校验），并在实现前确认红灯失败（TDD Red Phase）。
- [x] 实现 [`public/morphmd-x-paste.user.js`](../../../public/morphmd-x-paste.user.js) 油猴脚本，支持工作台状态注入握手与 `x.com/compose/article` 图文粘贴自动拆图走 X 上传管线。
- [x] 更新 [`src/App.tsx`](../../../src/App.tsx) 与 [`src/styles/workbench.css`](../../../src/styles/workbench.css)，完成下拉框箭头左移、顶栏按钮精简、预览区触控板丝滑缩放与 Status Dot 油猴脚本胶囊按钮。
- [x] 通过全量黑盒测试套件、真实浏览器渲染与视觉核验、`npm run typecheck` 与 `harness doctor` 巡检。
