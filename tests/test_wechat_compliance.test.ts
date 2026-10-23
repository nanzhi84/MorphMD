import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDeliverySnapshot } from '../src/core/snapshot';
import { inlineStyles, getDefaultCapabilities } from '../src/core/style';
import { createWeChatVerificationSession, type WeChatVerificationSession } from '../src/core/wechat/runner';
import { assetStore, documentOf, evidence } from './support/contracts';
import { jpeg, png } from './support/fixtures';

describe('TestWeChatArticleCompliance', () => {
  let session: WeChatVerificationSession;

  beforeAll(async () => {
    session = await createWeChatVerificationSession();
  });

  afterAll(async () => {
    await session?.close();
  });

  it('test_verify_engine_detects_raw_unnormalized_wechat_violations', async () => {
    const rawViolatingHtml = [
      '<section style="margin-left: 294pt;"><span style="text-align: start;">Overflowing paragraph</span></section>',
      '<section><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" style="opacity: 0;"></section>',
      '<pre>export function veryLongCodeLineWithoutHorizontalScrollThatOverflowsOn375pxMobileViewport(a: string, b: string, c: string) { return a + b + c; }</pre>',
    ].join('\n');

    const report = await session.verifyHtml(rawViolatingHtml);
    evidence('wechat-raw-violations', report);
    expect(report.isValid).toBe(false);
    expect(Object.keys(report.inValidInfo)).toEqual(expect.arrayContaining(['width', 'opacity', 'pre', 'text-align']));
  });

  it('test_rich_markdown_with_wide_images_code_tables_and_callout_formulas_passes_wechat_spec', async () => {
    const store = assetStore();
    const smallDiagram = await store.ingest(png(1, 100, 80), { fileName: 'small.png' });
    const mediumBanner = await store.ingest(png(2, 600, 360), { fileName: 'medium-600.png' });
    const wideHero = await store.ingest(png(3, 1080, 640), { fileName: 'wide-1080.png' });
    const rotatedPhoto = await store.ingest(jpeg(6), { fileName: 'exif-6.jpg' });

    const markdown = [
      '# WeChat Article Compliance Verification',
      '',
      'A complete end-to-end article testing multi-screen layout (375px, 585px, 677px), Dark Mode, and DOM structure.',
      '',
      '> [!NOTE] Deeply Nested Formula Inside Callout',
      '> Inline Gaussian $e^{-x^2}$ and mass-energy $E = mc^2$ inside a callout block.',
      '>',
      '> $$',
      '> \\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}',
      '> $$',
      '',
      '## Wide Code Block (#1.8 pre)',
      '',
      '```typescript',
      'export async function verifyMultiScreenWeChatArticleComplianceAcross375And585And677Viewports(input: string): Promise<boolean> {',
      '  return input.trim().length > 0;',
      '}',
      '```',
      '',
      '## Responsive Images Across All Breakpoints (#1.4 width)',
      '',
      `![Small Diagram](${smallDiagram.uri})`,
      '',
      `![Medium 600px Banner](${mediumBanner.uri})`,
      '',
      `![Wide 1080px Hero](${wideHero.uri})`,
      '',
      `![Rotated EXIF Photo](${rotatedPhoto.uri})`,
      '',
      '## Comparison Table',
      '',
      '| Rule | Spec Section | Status |',
      '| :--- | :---: | ---: |',
      '| Width & Overflow | #1.4 | Verified |',
      '| Pre Horizontal Scroll | #1.8 | Verified |',
      '| Nesting Depth <= 15 | #2.1 | Verified |',
    ].join('\n');

    const snapshot = await buildDeliverySnapshot(markdown, 'wechat', store, {
      customCss: `
        .morph-h1 { color: var(--morph-accent); border-bottom: 2px solid var(--morph-accent); padding-bottom: 8px; }
        .morph-h2::before { content: "§ "; color: var(--morph-accent); }
        .morph-callout-note { background-color: #f0f7ff; border-left: 4px solid var(--morph-accent); padding: 12px; }
      `,
    });

    const report = await session.verifyHtml(snapshot.html);
    evidence('wechat-rich-snapshot-verify', { diagnostics: snapshot.diagnostics, report });
    expect(snapshot.ready).toBe(true);
    expect(report.isValid).toBe(true);
    expect(report.inValidInfo).toEqual({});
  });

  it('test_hostile_css_and_structure_violations_are_normalized_and_pass_wechat_spec', async () => {
    const store = assetStore();
    const imgAsset = await store.ingest(png(1, 500, 300));

    let deepSpanNesting = '<span>Deep nested text content</span>';
    for (let i = 0; i < 18; i++) {
      deepSpanNesting = `<span>${deepSpanNesting}</span>`;
    }

    const markdown = [
      '# Hostile Style & Structure Normalization',
      '',
      `![Transparent Attempt](${imgAsset.uri})`,
      '',
      'First line of paragraph.<br>Second line of paragraph.<br>Third line of paragraph.',
      '',
      '<span leaf><section>Block inside span[leaf]</section></span>',
      '',
      '<section nodeleaf><section>Block inside section[nodeleaf]</section></section>',
      '',
      `<section data-no-dark>${deepSpanNesting}</section>`,
    ].join('\n');

    const hostileCss = `
      .morph-img { opacity: 0; }
      .morph-p {
        caret-color: rgba(0, 0, 0, 0);
        line-height: 0;
        width: 586px;
        margin-left: 294pt;
        height: 0px;
        text-align: start;
        background: linear-gradient(rgb(248, 245, 247), rgb(194, 43, 76));
      }
      .morph-h1 {
        text-align: end;
        height: 10px;
      }
    `;

    const snapshot = await buildDeliverySnapshot(markdown, 'wechat', store, {
      customCss: hostileCss,
    });

    const doc = documentOf(snapshot.html);
    expect(doc.querySelector('span[leaf]')).toBeNull();
    expect(doc.querySelector('section[nodeleaf]')).toBeNull();
    expect(doc.querySelector('[data-no-dark]')).toBeNull();
    expect(doc.querySelector<HTMLElement>('.morph-h1')!.style.textAlign).toBe('right');

    const diagCodes = new Set(snapshot.diagnostics.map((d) => d.code));
    expect(diagCodes).toContain('style/wechat-img-opacity-zero');
    expect(diagCodes).toContain('style/wechat-line-height-overlap');
    expect(diagCodes).toContain('style/wechat-fixed-width');
    expect(diagCodes).toContain('style/wechat-overflow-margin');
    expect(diagCodes).toContain('style/wechat-unsafe-height');
    expect(diagCodes).toContain('style/wechat-text-align-normalized');
    expect(diagCodes).toContain('style/wechat-text-gradient-bg');
    expect(diagCodes).toContain('structure/wechat-span-leaf-block');
    expect(diagCodes).toContain('structure/wechat-section-nodeleaf');
    expect(diagCodes).toContain('structure/wechat-darkmode-whitelist');
    expect(diagCodes).toContain('structure/wechat-redundant-nesting');

    const report = await session.verifyHtml(snapshot.html);
    evidence('wechat-hostile-normalized-verify', { diagnostics: snapshot.diagnostics, report });
    expect(report.isValid).toBe(true);
    expect(report.inValidInfo).toEqual({});
  });

  it('test_data_ignore_width_opt_out_preserves_intentional_fixed_width_and_passes_wechat_spec', async () => {
    const html = '<div class="morph-doc"><section data-ignore-width style="width: 500px;"><span>Intentional fixed width container</span></section></div>';
    const styled = inlineStyles(html, { capabilities: getDefaultCapabilities('wechat') });
    const doc = documentOf(styled.html);
    expect(doc.querySelector<HTMLElement>('section')!.style.width).toBe('500px');

    const report = await session.verifyHtml(styled.html);
    expect(report.isValid).toBe(true);
    expect(report.inValidInfo).toEqual({});
  });
});
