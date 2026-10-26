import { chromium } from 'playwright';
import { build } from 'esbuild';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');

async function main() {
  const workDir = process.env.HARNESS_WORK_DIR || join(repoRoot, 'work/bench-browser-tmp');
  mkdirSync(workDir, { recursive: true });

  const entryFile = join(workDir, 'browser-entry.ts');
  const bundleFile = join(workDir, 'browser-bundle.js');
  const coreDir = join(repoRoot, 'src/core').replace(/\\/g, '/');

  try {
    writeFileSync(
      entryFile,
      `
import { compileMarkdown } from '${coreDir}/ast/compiler';
import { globalHeavyBlockCache } from '${coreDir}/ast/cache';
import { AssetStore } from '${coreDir}/assets/store';
import { inlineStyles } from '${coreDir}/style/inliner';
import { getDefaultCapabilities } from '${coreDir}/style/guard';
import { buildDeliverySnapshot } from '${coreDir}/snapshot/builder';
import { createEditorSession } from '${coreDir}/session/controller';
import { dedupeWeChatNesting } from '${coreDir}/wechat/normalizer';
import { normalizeXArticleStructureAndStyles } from '${coreDir}/x-article/normalizer';
import { paginateDom } from '${coreDir}/cards/paginator';
import type { TargetId } from '${coreDir}/snapshot/types';

function generateMarkdownDoc(sectionsCount: number): string {
  const parts: string[] = [
    '# MorphMD 性能基准测试报告：一源多态渲染引擎',
    '',
    '这是一篇包含**加粗强调**、*斜体文本*、\`行内代码\`、数学公式 $E = mc^2$ 以及自定义资源的典型技术长文。',
    '',
  ];

  for (let i = 1; i <= sectionsCount; i++) {
    parts.push(
      \`## 第 \${i} 节：核心编译与多平台样式同构优化\`,
      '',
      \`在实际生产环境中，创作者往往一边快速输入文字，一边观察右侧预览区的实时排版变化。本段用于测试第 \${i} 节的正文渲染吞吐量，包含行内公式 $\\\\alpha_\${i} + \\\\beta_\${i} = \\\\gamma_\${i}$ 与外链 [官方文档](https://example.com/docs/\${i})。\`,
      '',
      \`> [!TIP]\`,
      \`> 架构提示 \${i}：通过细粒度缓存复用重型节点，避免每次按键重新触发全量语法高亮。\`,
      '',
      '\`\`\`typescript',
      \`export function computeSectionMetric\${i}(items: readonly number[]): number {\`,
      \`  return items.reduce((acc, cur, idx) => acc + cur * (idx + \${i}), 0);\`,
      \`}\`,
      '\`\`\`',
      '',
      '$$',
      \`\\\\int_{0}^{\\\\infty} x^{\${i}} e^{-x} \\\\, dx = \${i}!\`,
      '$$',
      '',
      '| 指标维度 | 目标阈值 | 实测表现 | 状态 |',
      '| :--- | :--- | :--- | :--- |',
      \`| 输入延迟 #\${i} | < 2ms | 0.1ms | 正常 |\`,
      \`| 预览更新 #\${i} | < 50ms | 待测 | 评估中 |\`,
      '',
      \`- 列表项 \${i}.1：验证选择器匹配与计算样式提取\`,
      \`- 列表项 \${i}.2：验证 DOM 规范化与冗余节点清理\`,
      \`  - 嵌套子项 \${i}.2.a：检查层级深度与样式继承\`,
      '',
      \`![示例图片 \${i}](morph-asset://asset-bench-1)\`,
      ''
    );
  }

  return parts.join('\\n');
}

const CUSTOM_CSS = \`
  .morph-h1 { color: #1a202c; border-bottom: 2px solid var(--morph-accent); padding-bottom: 8px; }
  .morph-h2 { color: #2d3748; margin-top: 24px; border-left: 4px solid var(--morph-accent); padding-left: 10px; }
  .morph-h2::before { content: "§ "; color: var(--morph-accent); }
  .morph-p { color: #333333; font-size: 16px; line-height: 1.75; }
  .morph-quote { background-color: #f7fafc; border-left: 4px solid #cbd5e0; padding: 12px 16px; }
  .morph-code { background-color: #f6f8fa; border-radius: 6px; padding: 12px; }
  .morph-table th { background-color: #edf2f7; font-weight: bold; }
  .morph-table td, .morph-table th { border: 1px solid #e2e8f0; padding: 8px 12px; }
\`;

async function setupAssetStore(): Promise<AssetStore> {
  const store = new AssetStore();
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const binStr = atob(pngBase64);
  const bytes = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
  await store.ingest(bytes, 'image/png', { id: 'asset-bench-1', width: 800, height: 450 });
  return store;
}

async function profileBreakdown(
  markdown: string,
  targetId: TargetId,
  assetStore: AssetStore,
  warmCache: boolean
) {
  if (!warmCache) {
    globalHeavyBlockCache.clear();
  }

  const capabilities = getDefaultCapabilities(targetId);

  const t0 = performance.now();
  const astResult = await compileMarkdown(markdown);
  const t1 = performance.now();

  let t2 = t1;
  let t3 = t1;
  let domNodesCount = 0;

  const styleResult = inlineStyles(astResult.html, {
    customCss: CUSTOM_CSS,
    capabilities,
    afterInline(root, _doc, inlineDiagnostics) {
      t2 = performance.now();
      domNodesCount = root.querySelectorAll('*').length;
      if (targetId === 'wechat') {
        dedupeWeChatNesting(root, inlineDiagnostics);
      } else if (targetId === 'x-article') {
        normalizeXArticleStructureAndStyles(root, inlineDiagnostics, capabilities);
      } else if (targetId === 'cards') {
        paginateDom(root, inlineDiagnostics);
      }
      t3 = performance.now();
    },
  });
  const finalHtml = styleResult.html;
  const t4 = performance.now();

  const e0 = performance.now();
  await buildDeliverySnapshot(markdown, targetId, assetStore, { customCss: CUSTOM_CSS });
  const e1 = performance.now();

  return {
    astCompileMs: Number((t1 - t0).toFixed(2)),
    styleInlineMs: Number((t2 - t1).toFixed(2)),
    domAssetAndNormalizeMs: Number((t3 - t2).toFixed(2)),
    htmlSerializeMs: Number((t4 - t3).toFixed(2)),
    totalMs: Number((t4 - t0).toFixed(2)),
    endToEndBuildDeliverySnapshotMs: Number((e1 - e0).toFixed(2)),
    domNodesCount,
    htmlChars: finalHtml.length,
  };
}

async function profileTypingSimulation(markdownBase: string, assetStore: AssetStore) {
  const session = createEditorSession({
    assetStore,
    targetId: 'wechat',
    customCss: CUSTOM_CSS,
    debounceMs: 120,
  });

  await session.commitDoc(markdownBase);

  const keystrokeCount = 30;
  const keystrokeCallTimesMs: number[] = [];

  let currentText = markdownBase + '\\n\\n正在输入新段落：';
  let lastPromise: Promise<any> | null = null;

  for (let i = 0; i < keystrokeCount; i++) {
    currentText += '丝滑';
    const kt0 = performance.now();
    lastPromise = session.inputDoc(currentText);
    const kt1 = performance.now();
    keystrokeCallTimesMs.push(kt1 - kt0);
  }

  const commitWaitStart = performance.now();
  await lastPromise;
  const commitTotalElapsedMs = performance.now() - commitWaitStart;

  const singleCommitText = currentText + '！';
  const c0 = performance.now();
  const commitPromise = session.commitDoc(singleCommitText);
  const syncBlockingDuringCommitCallMs = performance.now() - c0;
  await commitPromise;
  const fullCommitResolutionMs = performance.now() - c0;

  session.dispose();

  return {
    keystrokeCount,
    avgKeystrokeCallMs: Number(
      (keystrokeCallTimesMs.reduce((a, b) => a + b, 0) / keystrokeCount).toFixed(4)
    ),
    maxKeystrokeCallMs: Number(Math.max(...keystrokeCallTimesMs).toFixed(4)),
    debouncedCommitTotalElapsedMs: Number(commitTotalElapsedMs.toFixed(2)),
    syncPhaseInRunSnapshotBuildMs: Number(syncBlockingDuringCommitCallMs.toFixed(2)),
    fullRunSnapshotBuildMs: Number(fullCommitResolutionMs.toFixed(2)),
  };
}

(window as any).__runMorphBenchmark = async () => {
  const assetStore = await setupAssetStore();
  await compileMarkdown('\`\`\`ts\\nconst x = 1;\\n\`\`\`');

  const docSizes = [
    { name: 'small (2 sections, ~70 lines)', sections: 2 },
    { name: 'medium (8 sections, ~260 lines)', sections: 8 },
    { name: 'large (20 sections, ~650 lines)', sections: 20 },
    { name: 'xlarge (185 sections, ~5200 lines)', sections: 185 },
  ];

  const targets: TargetId[] = ['wechat', 'x-article', 'cards'];
  const report: Record<string, any> = {
    environment: 'Chromium (Real Browser via Playwright - Post-Optimization)',
    stageBreakdown: {},
    typingSimulation: {},
  };

  for (const size of docSizes) {
    const md = generateMarkdownDoc(size.sections);
    report.stageBreakdown[size.name] = {
      markdownChars: md.length,
      markdownLines: md.split('\\n').length,
      targets: {},
    };

    for (const target of targets) {
      const cold = await profileBreakdown(md, target, assetStore, false);
      const warm = await profileBreakdown(md, target, assetStore, true);
      report.stageBreakdown[size.name].targets[target] = {
        coldCache: cold,
        warmCacheIncrementalEdit: warm,
      };
    }

    report.typingSimulation[size.name] = await profileTypingSimulation(md, assetStore);
  }

  return report;
};
`
    );

    await build({
      entryPoints: [entryFile],
      bundle: true,
      outfile: bundleFile,
      format: 'iife',
      platform: 'browser',
      target: ['es2022'],
    });

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent('<!DOCTYPE html><html><head><meta charset="utf-8"></head><body></body></html>');
    await page.addScriptTag({ path: bundleFile });

    const report = await page.evaluate(async () => {
      return await (window as any).__runMorphBenchmark();
    });

    await browser.close();

    console.log(JSON.stringify(report, null, 2));
    if (process.env.HARNESS_ARTIFACTS_DIR) {
      mkdirSync(process.env.HARNESS_ARTIFACTS_DIR, { recursive: true });
      writeFileSync(join(process.env.HARNESS_ARTIFACTS_DIR, 'browser-perf-report.json'), JSON.stringify(report, null, 2));
    }
  } finally {
    if (!process.env.HARNESS_WORK_DIR) {
      rmSync(workDir, { recursive: true, force: true });
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
