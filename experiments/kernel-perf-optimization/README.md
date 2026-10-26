# MorphMD 内核性能基准测试与优化实验 (`kernel-perf-optimization`)

本实验沙盒用于对 `MorphMD` 核心渲染管线（`src/core/`）在 **真实 Chromium 浏览器（Playwright）** 与 **Node.js + JSDOM** 下的端到端性能进行量化剖析与前后对比验证，涵盖 **60 行短文、228 行中篇、564 行长文，以及 5,184 行（185 节、2.16 万+ DOM 节点）超长复合文档** 四个负载梯度：

1. **左栏用户输入丝滑度**：连续高频调用 `session.inputDoc()` 的单次按键阻塞耗时与防抖提交后的主线程占用。
2. **右栏三平台预览渲染速度**：`wechat`、`x-article`、`cards` 在短文（60 行）、中篇（228 行）、长文（564 行）与超长文（**5,184 行 Markdown**，含 185 个代码块、371 个数学公式、185 张表格、185 个 Callout）下的冷启动与增量编辑渲染耗时。

---

## 1. 复现与运行方式

所有基准测试均通过 `harness run` 在隔离工作区中执行，实测 JSON 报告自动产出至 `artifacts/`，固化对比快照保存在本目录 `results/` 下：

```bash
# 运行真实 Chromium 浏览器端到端基准测试（含 5,184 行超长文档）
harness run kernel-perf-browser -- npx tsx experiments/kernel-perf-optimization/bench_browser.ts

# 运行 Node.js v24 + JSDOM 端到端基准测试（含 5,184 行超长文档）
harness run kernel-perf-node -- npx tsx experiments/kernel-perf-optimization/bench_node.ts
```

---

## 2. 诊断并解决的核心性能瓶颈（含 5,000+ 行超长篇专项优化）

1. **移除 Node 专属依赖（`node:zlib` / `Buffer`），实现浏览器原生零 Polyfill 同构运行与 LZ77/RLE 压缩**
   - 新增 [`src/core/dom/binary.ts`](../../src/core/dom/binary.ts)，以纯 `Uint8Array` 实现 CRC32、Adler32、Fixed-Huffman LZ77/RLE Deflate/Zlib 压缩、PNG 编码与 Base64 转换。
   - 彻底解决优化前 [`src/core/x-article/normalizer.ts`](../../src/core/x-article/normalizer.ts) 与 [`src/core/cards/exporter.ts`](../../src/core/cards/exporter.ts) 在浏览器打包后因 `node:zlib` / `Buffer` 抛错崩溃的问题，并将 `x-article` 光栅化 Data URL 体积压缩 **~94%**。

2. **消除 `EditorSessionController.runSnapshotBuild` 双倍重复编译与冗余 HAST 遍历**
   - 优化 [`src/core/session/controller.ts`](../../src/core/session/controller.ts)：当 Shiki 高亮器已就绪时，同步阶段生成的 `prebuiltSyncSnapshot` 直接复用为最终快照；并通过 [`getSnapshotReferencedAssetIds`](../../src/core/snapshot/builder.ts) 直接读取 DOM 阶段已提取的资产引用集合，避免触发 `snapshot.hast` 解析。

3. **5,000+ 行超长文档：重型块缓存扩容（`500 -> 4096`）、浅拷贝复用与 KaTeX `mathml` 精简 DOM 树**
   - 5,184 行复合长文包含 **556 个重型块**（185 个代码块 + 371 个公式）与 **741 个光栅化块**，超出原 `HeavyBlockCache(500)` 与 `MAX_RASTER_PNG_CACHE(512)` 容量上限，导致每次增量编辑发生 **100% FIFO/LRU 缓存颠簸（0% 命中）**。
   - 在 [`src/core/ast/cache.ts`](../../src/core/ast/cache.ts) 与 [`src/core/x-article/normalizer.ts`](../../src/core/x-article/normalizer.ts) 中将容量提升至 `4096`；在 [`src/core/ast/math-code.ts`](../../src/core/ast/math-code.ts) 中入库前一次性剥离后代 `position`，命中缓存时仅做顶层浅拷贝（消除每次 556 次 `JSON.parse(JSON.stringify(...))`），并采用 `output: 'mathml'` 将 5,184 行文档的 DOM 节点数从 **43,459** 精简至 **21,635**，同时在 [`src/core/ast/compiler.ts`](../../src/core/ast/compiler.ts) 中对 `<pre>` 与 `.morph-math` 内部子树返回 `SKIP`。

4. **单次 DOM 遍历合成（`afterInline`）与惰性缓存 `snapshot.hast` Getter**
   - 在 [`src/core/style/inliner.ts`](../../src/core/style/inliner.ts) 与 [`src/core/snapshot/builder.ts`](../../src/core/snapshot/builder.ts) 中引入 `afterInline` 钩子，使样式内联、资产解析与目标平台归一化（`wechat` / `x-article` / `cards`）在**同一个 DOM 实例与单次遍历**中完成，消除数 MB HTML 的二次 `outerHTML` 序列化与 `parseDocument` 重解析。
   - 将 `DeliverySnapshot.hast` 改造为可枚举、惰性求值且带记忆化缓存与 `deepFreeze` 的 Getter，使常规预览与导出（仅消费 `snapshot.html`）完全免除 `fromHtml`（`parse5`）在 5,184 行文档上高达 `339–605 ms` 的开销，同时 100% 兼容 `snapshot.hast` 访问与 `JSON.stringify(snapshot)`。

5. **DOM 沙箱复用、`WeakMap` 祖先变量作用域缓存与同类元素样式 Profile 批量豁免**
   - 在 [`src/core/dom/env.ts`](../../src/core/dom/env.ts) 中复用持久化隐藏 `<iframe>` 与预热 `JSDOM` 实例。
   - 在 [`src/core/style/inliner.ts`](../../src/core/style/inliner.ts) 中引入 `WeakMap<Element, Record<string, string>>` 缓存祖先 CSS 变量作用域，并对无位置伪类/属性选择器的同类无内联样式元素（如 5,184 行文档中的 1,480 个 `<td>`、740 个 `<th>`、371 个 `<p>`、555 个 `<li>`）按祖先链路签名缓存 Phase 1 规则计算结果、Phase 2 序列化样式字符串与 Step 3.5 白名单校验结果。
   - 在 [`src/core/wechat/normalizer.ts`](../../src/core/wechat/normalizer.ts) 中仅遍历 `[style]` 元素，对 Shiki 语法高亮纯色 `<span style="color:#...">` 与已验证合规的同类元素样式提供 O(1) 快速豁免并缓存背景对比度。

---

## 3. 优化前后实测数据对比（含 5,184 行超长文档）

### 3.1 真实浏览器（Chromium via Playwright）

> 原始数据见 [`results/baseline-browser.json`](results/baseline-browser.json) 与 [`results/optimized-browser.json`](results/optimized-browser.json)。

| 场景 / 指标 | 文档规模 | 优化前 (Baseline) | 优化后 (Post-Opt) | 提升幅度 |
| :--- | :--- | ---: | ---: | ---: |
| **浏览器端无 Polyfill 独立打包运行** | 全平台 (`wechat` / `x-article` / `cards`) | ❌ **100% 崩溃** (`node:zlib` / `Buffer` 缺失) | ✅ **100% 原生通过** | **彻底修复致命缺陷** |
| **左栏高频打字单键耗时 (`inputDoc`)** | 60 ~ 5,184 行连续输入 30 次 | 平均 `0.003 ms` (最大 `0.1 ms`) | 平均 **`0.000–0.003 ms`** (最大 `0.1 ms`) | **零阻塞 (< 0.1ms)** |
| **打字防抖提交后构建总耗时 (`runSnapshotBuild`)** | 短文 (60 行) | `33.0 ms` (同步阻塞 `16.9 ms`) | **`4.1 ms`** | **8.0x 提速 (-87.6%)** |
| **打字防抖提交后构建总耗时 (`runSnapshotBuild`)** | 中篇 (228 行) | `104.7 ms` (同步阻塞 `54.1 ms`) | **`12.4 ms`** | **8.4x 提速 (-88.2%)** |
| **打字防抖提交后构建总耗时 (`runSnapshotBuild`)** | 长文 (564 行) | `225.3 ms` (同步阻塞 `115.0 ms`) | **`25.5 ms`** | **8.8x 提速 (-88.7%)** |
| **打字防抖提交后构建总耗时 (`runSnapshotBuild`)** | **超长篇 (5,184 行)** | `2,642.5 ms` (同步阻塞 `1,318.2 ms`) | **`235.0 ms`** | **11.2x 提速 (-91.1%)** |
| **右栏 `wechat` 增量渲染** | 短 / 中 / 长 / **5,184 行** | `17.9` / `46.3` / `113.0` / `1,322.1 ms` | **`4.6` / `11.0` / `21.3` / `212.5 ms`** | **最高 6.2x 提速** |
| **右栏 `cards` 增量渲染** | 短 / 中 / 长 / **5,184 行** | `14.2` / `42.8` / `108.2` / `1,495.8 ms` | **`3.1` / `9.8` / `20.7` / `201.8 ms`** | **最高 7.4x 提速** |
| **右栏 `x-article` 增量渲染** | 短 / 中 / 长 / **5,184 行** | `95.6` / `366.8` / `1,142.6` / `10,592.0 ms` | **`2.8` / `7.9` / `18.1` / `181.1 ms`** | **最高 58.5x 提速 (-98.3%)** |

---

### 3.2 Node.js v24 + JSDOM 环境

> 原始数据见 [`results/baseline-node.json`](results/baseline-node.json) 与 [`results/optimized-node.json`](results/optimized-node.json)。

| 场景 / 指标 | 文档规模 | 优化前 (Baseline) | 优化后 (Post-Opt) | 提升幅度 |
| :--- | :--- | ---: | ---: | ---: |
| **打字防抖提交后构建总耗时 (`runSnapshotBuild`)** | 短 / 中 / 长 / **5,184 行** | `175.7` / `678.8` / `1,711.2` / `15,984.6 ms` | **`11.9` / `33.3` / `80.0` / `1,471.4 ms`** | **10.9x ~ 21.4x 提速** |
| **`wechat` 增量渲染** | 短 / 中 / 长 / **5,184 行** | `97.6` / `315.8` / `829.4` / `7,894.7 ms` | **`15.8` / `34.3` / `81.9` / `1,414.6 ms`** | **5.6x ~ 10.1x 提速** |
| **`cards` 增量渲染** | 短 / 中 / 长 / **5,184 行** | `76.3` / `301.0` / `792.9` / `7,765.0 ms` | **`10.4` / `31.7` / `73.6` / `1,215.2 ms`** | **6.4x ~ 10.8x 提速** |
| **`x-article` 增量渲染** | 短 / 中 / 长 / **5,184 行** | `75.4` / `250.8` / `769.9` / `7,151.6 ms` | **`13.5` / `35.1` / `88.5` / `1,236.4 ms`** | **5.6x ~ 8.7x 提速** |

---

## 4. 目录结构

- [`bench_browser.ts`](bench_browser.ts)：使用 `esbuild`（无任何 Node Polyfill）打包内核并在真实 Playwright Chromium 页面中测量 4 级文档规模（60 行 / 228 行 / 564 行 / **5,184 行**）的三平台分阶段耗时与打字模拟指标。
- [`bench_node.ts`](bench_node.ts)：在 Node.js + JSDOM 下测量 4 级文档规模（含 **5,184 行**）的三平台分阶段耗时与打字模拟指标。
- [`results/baseline-browser.json`](results/baseline-browser.json)：优化前 Chromium 实测基准数据（含 5,184 行）。
- [`results/optimized-browser.json`](results/optimized-browser.json)：优化后 Chromium 实测数据（含 5,184 行）。
- [`results/baseline-node.json`](results/baseline-node.json)：优化前 Node.js + JSDOM 实测基准数据（含 5,184 行）。
- [`results/optimized-node.json`](results/optimized-node.json)：优化后 Node.js + JSDOM 实测数据（含 5,184 行）。
