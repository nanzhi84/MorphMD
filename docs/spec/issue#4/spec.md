# 修复「复制富文本」按钮仅写入纯文本、块间多余空行与图片降级占位问题

> **Status:** Proposal · [Issue #3](https://github.com/nanzhi84/MorphMD/issues/3) · Created 2026-10-26
> **Affected Architecture:** [docs/architecture/overview.md](../../architecture/overview.md) · [ADR-0002](../../adr/0002-isomorphic-delivery-snapshot-and-asset-pipeline.md)

## 1. 背景与目标 (Context & Goals)

在工作台（`x-article` / `wechat` 视图）中点击顶部主交付按钮「复制富文本」（`data-testid="primary-delivery-btn"`）并粘贴至 X 时，粘贴结果丢失了全部富文本格式（标题层级、加粗、引用块、列表），图片退化为纯文本 `[Image: 示例图片]`，且段落之间产生 2～4 行异常空行：

```text
让内容自由流动


一份 Markdown，三种发布形态。从写作到排版，从创作到发布，MorphMD 让每一次内容分发都变得简单。




写一次，自由发布。让优秀的内容被更多人看见。




核心功能


01 · 多平台适配


微信公众号、X Articles 与图文卡片，随时切换。


02 · 统一样式系统


通过 Design Tokens 控制颜色、字体与段落排版。


[Image: 示例图片]


更多可能



高质量的图文排版与自动分页


右栏局部框选带样式自由复制
```

### 1.1 根因定位

1. **主交付按钮未向系统剪贴板写入 `text/html` 富文本 MIME 载荷（核心缺陷）**：
   - 在 [`src/App.tsx`](../../../src/App.tsx) 的 `handlePrimaryDelivery` 中，虽然调用 [`serializeFullSnapshot`](../../../src/core/selection/normalizer.ts) 产出了包含 `html` 与 `plainText` 的完整 `ClipboardPayload`，但后续仅执行了 `navigator.clipboard.writeText(payload.plainText)`。
   - `writeText` 仅向系统剪贴板写入 `text/plain` 纯文本通道，完全丢弃了 `payload.html`；目标编辑器（如 X Articles、微信公众号后台）在粘贴时因剪贴板中不存在 `text/html` 数据，只能回退读取 `text/plain` 纯文本（而右栏局部框选 `handleNativeCopy` 则通过 `clipboardData.setData('text/html', payload.html)` 写入了双通道数据）。
2. **`extractPlainTextFromDom` 未过滤块级元素间的格式化换行文本节点，导致多重空行叠加**：
   - 在 [`src/core/selection/normalizer.ts`](../../../src/core/selection/normalizer.ts) 的 `extractPlainTextFromDom` 中，编译器产出的 HTML 在相邻块级标签之间包含换行文本节点（如 `</h1>\n<p>`、`<blockquote>\n<p>`）。
   - 遍历函数在每个块级元素前后插入 `BLOCK_SEP`（`\0BLOCK_SEP\0`）的同时，将块间的纯空白文本节点 `\n`（`nodeType === 3`）原样拼接到 `text` 中。由于 `text` 末尾变为 `\n` 而非 `BLOCK_SEP`，进入下一个块级元素时再次追加 `BLOCK_SEP`，形成 `\0BLOCK_SEP\0\n\0BLOCK_SEP\0`，最终替换为连续 3～5 个 `\n`。
3. **纯文本通道下 `<img>` 的 `[Image: alt]` 替代文本与 X 平台粘贴边界**：
   - `extractPlainTextFromDom` 将 `<img>` 转换为 `[Image: ${alt}]` 作为纯文本回退表示（默认示例文稿中即为 `[Image: 示例图片]`）。由于根因 1 导致剪贴板缺少 `text/html`，粘贴端直接渲染了纯文本回退内容。
   - 此外，X 普通推文发布框（Post Composer）仅支持纯文本，富文本排版（`<h1>`/`<h2>`、`<strong>`、`<blockquote>`、`<ul>`/`<ol>`）需粘贴至 **X Articles 长文编辑器（`x.com/compose/article`）** 才能解析生效（详见 [X Articles 结构规范](../../reference/x-article-draftjs-structure-spec.md)）。

---

## 2. 方案设计 (Design & Contracts)

### 2.1 双通道富文本剪贴板写入契约（`src/App.tsx`）

在 `handlePrimaryDelivery` 中，将单一 `writeText(payload.plainText)` 升级为**双通道富文本剪贴板写入**：
1. **标准 Clipboard API 路径**：当环境支持 `navigator.clipboard?.write` 与 `typeof ClipboardItem !== 'undefined'` 时，构造包含 `'text/html'`（`new Blob([payload.html], { type: 'text/html' })`）与 `'text/plain'`（`new Blob([payload.plainText], { type: 'text/plain' })`）的 `ClipboardItem` 并调用 `await navigator.clipboard.write([item])`。
2. **DOM `copy` 事件降级路径**：当 `ClipboardItem` 不可用或调用抛出异常时，在 `document.body` 下挂载临时离屏选区容器，监听一次性原生 `copy` 事件并在 `event.clipboardData` 上调用 `setData('text/html', payload.html)` 与 `setData('text/plain', payload.plainText)`，随后执行 `document.execCommand('copy')` 并清理临时节点。
3. **纯文本兜底路径**：若上述两条路径均不可用，最终回退至 `navigator.clipboard?.writeText(payload.plainText)`。

### 2.2 纯文本提取空行归一化契约（`src/core/selection/normalizer.ts`）

在 `extractPlainTextFromDom` 中修复块级元素间的空白节点叠加：
1. 对于非 `<pre>` / `<code>` 上下文中的文本节点（`nodeType === 3`），若该文本节点仅由空白字符组成且位于块级边界之间（即相邻兄弟或父容器为块级元素间的格式化缩进/换行），忽略该纯排版换行空白，避免打断 `BLOCK_SEP` 归并。
2. 在最终将 `BLOCK_SEP` 序列归一化为换行符时，合并紧邻 `BLOCK_SEP` 的多余空白换行，确保相邻块级元素之间仅产出标准单行换行分隔，同时严格保留：
   - `<pre>` / `<code>` 内部的原始多行代码换行与缩进；
   - `<br>` 显式软换行；
   - 表格单元格之间的 `\t` 分隔与行换行；
   - 用户局部框选（`normalizeSelectionRange`）时显式选中的边界空白字符。

---

## 3. 真实执行与验收标准 (Verification)

### 3.1 实施与验收 Checklist

- [x] 由独立子代理（Fresh Subagent）严格依据本 Issue 契约补充黑盒测试（验证点击「复制富文本」按钮向剪贴板写入 `text/html` 与 `text/plain` 双通道数据，且 `extractPlainTextFromDom` 在块级元素间不产生多重异常空行），并在修复前确认红灯失败（TDD Red Phase）。
- [x] 修复 [`src/App.tsx`](../../../src/App.tsx) 中 `handlePrimaryDelivery` 的剪贴板写入实现，支持 `ClipboardItem` 双通道（`text/html` + `text/plain`）写入及 `copy` 事件降级兜底。
- [x] 修复 [`src/core/selection/normalizer.ts`](../../../src/core/selection/normalizer.ts) 中 `extractPlainTextFromDom` 的块间空白文本节点叠加问题，确保纯文本换行干净且不破坏 `<pre>/<code>`、`<br>` 与局部选区边界空白契约。
- [x] 通过全量黑盒测试套件、真实 Chromium 浏览器剪贴板读写端到端验证、`npm run typecheck` 与 `harness doctor` 规范巡检。
