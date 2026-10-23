import { describe, expect, it } from 'vitest';
import { buildDeliverySnapshot } from '../src/core/snapshot';
import { serializeFullSnapshot } from '../src/core/selection';
import { verifyXArticleHtml } from '../src/core/x-article';
import { assetStore, documentOf, evidence } from './support/contracts';
import { png } from './support/fixtures';

describe('TestXArticleCompliance', () => {
  it('test_verify_engine_detects_raw_unnormalized_x_article_violations', () => {
    const rawViolatingHtml = [
      '<div class="morph-doc">',
      '  <h3 class="morph-h3" style="color: red;">Unnormalized H3 With Inline Style</h3>',
      '  <div class="morph-callout" data-callout-type="note"><div class="morph-callout-title">Note</div><div class="morph-callout-body"><p>Body</p></div></div>',
      '  <table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
      '  <div class="morph-math" data-math-tex="x^2"><span class="katex"><span class="katex-mathml"><math><mi>x</mi></math></span><span class="katex-html">x</span></span></div>',
      '  <svg width="100" height="50"><rect width="100" height="50" /></svg>',
      '  <section><li>Orphan list item inside unsupported section</li></section>',
      '  <p><img src="http://insecure.example.com/test.png" alt="insecure"><a href="javascript:void(0)">bad</a></p>',
      '</div>',
    ].join('\n');

    const report = verifyXArticleHtml(rawViolatingHtml);
    evidence('x-article-raw-violations', report);

    expect(report.isValid).toBe(false);
    expect(Object.keys(report.inValidInfo)).toEqual(
      expect.arrayContaining([
        'heading-level',
        'callout-structure',
        'unrasterized-table',
        'unrasterized-math',
        'unrasterized-svg',
        'unsupported-element',
        'native-inline-style',
        'unsafe-media-or-link',
      ])
    );
  });

  it('test_rich_markdown_with_deep_headings_callouts_tables_math_code_and_https_assets_passes_x_article_spec', async () => {
    const store = assetStore();
    const heroAsset = await store.ingest(png(1, 800, 450), {
      fileName: 'hero.png',
      remoteUrl: 'https://cdn.example.com/x-article-hero.png',
    });

    const markdown = [
      '# X Articles Long-Form Architecture',
      '',
      'Introductory paragraph with **bold**, *italic*, ~~strikethrough~~, `inlineCode`, and [official link](https://x.com).',
      '',
      '## Primary Section H2',
      '',
      '### Deep Subheading H3',
      '',
      '#### Deep Subheading H4',
      '',
      '> [!NOTE] Draft.js Ingestion Contract',
      '> X Articles parses clipboard HTML into immutable ContentBlocks and strips native inline styles.',
      '',
      'Inline mass-energy formula $E = mc^2$ in a sentence.',
      '',
      '$$',
      '\\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}',
      '$$',
      '',
      '| Capability | WeChat | X Articles |',
      '| :--- | :---: | :---: |',
      '| Native Inline CSS | Yes | No |',
      '| Table Rasterization | Optional | Required |',
      '',
      '```typescript',
      'export function verifyX(html: string): boolean {',
      '  return html.length > 0;',
      '}',
      '```',
      '',
      `![Hero Banner](${heroAsset.uri})`,
      '',
      '---',
      '',
      '1. First ordered item',
      '2. Second ordered item',
      '',
      '- Unordered bullet A',
      '- Unordered bullet B',
    ].join('\n');

    const snapshot = await buildDeliverySnapshot(markdown, 'x-article', store, {
      customCss: `
        .morph-p { color: #ff0000; font-size: 20px; }
        .morph-h1 { color: var(--morph-accent); }
        .morph-code { background-color: #f6f8fa; }
      `,
      tokens: { '--morph-accent': '#1d9bf0' },
    });

    const report = verifyXArticleHtml(snapshot.html);
    evidence('x-article-rich-snapshot-verify', { diagnostics: snapshot.diagnostics, report });

    expect(snapshot.ready).toBe(true);
    expect(report.isValid).toBe(true);
    expect(report.inValidInfo).toEqual({});

    const doc = documentOf(snapshot.html);
    expect(doc.querySelectorAll('h3, h4, h5, h6')).toHaveLength(0);
    expect(doc.querySelectorAll('h2[data-original-heading]')).toHaveLength(2);
    expect(doc.querySelector('div.morph-callout')).toBeNull();
    expect(doc.querySelector('blockquote.morph-callout')).not.toBeNull();
    expect(doc.querySelector('table')).toBeNull();
    expect(doc.querySelector('math, .katex')).toBeNull();
    expect(doc.querySelector('svg')).toBeNull();
    expect(doc.querySelectorAll('img[data-morph-rasterized="true"]')).toHaveLength(3);

    const diagCodes = new Set(snapshot.diagnostics.map((d) => d.code));
    expect(diagCodes).toContain('structure/x-article-heading-downgraded');
    expect(diagCodes).toContain('structure/x-article-callout-blockquote');
    expect(diagCodes).toContain('structure/x-article-table-rasterized');
    expect(diagCodes).toContain('structure/x-article-math-rasterized');

    // Verify Source Fidelity on plainText serialization (zero lost formula/table semantics)
    const fullPayload = serializeFullSnapshot(snapshot, store);
    expect(fullPayload.plainText).toContain('$E = mc^2$');
    expect(fullPayload.plainText).toContain('\\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}');
    expect(fullPayload.plainText).toContain('Table Rasterization | Optional | Required');
  });

  it('test_draftjs_convert_from_html_simulation_produces_accurate_blocks_inline_styles_and_entities', () => {
    const validXHtml = [
      '<div class="morph-doc">',
      '  <h1>Main Title</h1>',
      '  <h2>Subtitle</h2>',
      '  <p>Text with <strong>bold</strong>, <em>italic</em>, <del>strike</del>, <code>code</code>, and <a href="https://x.com">X</a>.</p>',
      '  <blockquote><p><strong>Note</strong></p><p>Quoted body</p></blockquote>',
      '  <ul><li>Item 1<ul><li>Nested 1.1</li></ul></li></ul>',
      '  <ol><li>Step 1</li></ol>',
      '  <pre class="morph-code"><code>const x = 1;</code></pre>',
      '  <hr>',
      '  <p><img src="https://cdn.example.com/figure.png" alt="Figure"></p>',
      '</div>',
    ].join('\n');

    const report = verifyXArticleHtml(validXHtml);
    expect(report.isValid).toBe(true);

    const blockTypes = report.draftState.blocks.map((b) => b.type);
    expect(blockTypes).toEqual([
      'header-one',
      'header-two',
      'unstyled',
      'blockquote',
      'blockquote',
      'unordered-list-item',
      'unordered-list-item',
      'ordered-list-item',
      'code-block',
      'atomic',
      'atomic',
    ]);

    const nestedItem = report.draftState.blocks[6];
    expect(nestedItem.text).toBe('Nested 1.1');
    expect(nestedItem.depth).toBe(1);

    const styledPara = report.draftState.blocks[2];
    expect(styledPara.inlineStyleRanges.map((r) => r.style)).toEqual([
      'BOLD',
      'ITALIC',
      'STRIKETHROUGH',
      'CODE',
    ]);

    const entities = Object.values(report.draftState.entityMap);
    expect(entities.map((e) => e.type)).toEqual(['LINK', 'DIVIDER', 'IMAGE']);
  });
});
