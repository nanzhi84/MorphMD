import { describe, expect, it } from 'vitest';
import { compileMarkdown, HeavyBlockCache } from '../src/core/ast';
import { documentOf, evidence } from './support/contracts';

describe('TestAstPipeline', () => {
  it('test_rich_markdown_preserves_semantic_blocks_and_source_locations', async () => {
    const source = '# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six\n\nText **bold**.\n\n> Quote\n\n- [x] Done\n- [ ] Todo\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n![diagram](morph-asset://sample)';
    const result = await compileMarkdown(source);
    evidence('ast-rich', { source, ...result });
    const doc = documentOf(result.html);
    for (const selector of ['.morph-doc', ...[1, 2, 3, 4, 5, 6].map(n => `.morph-h${n}`), '.morph-p', '.morph-quote', '.morph-list', '.morph-table', '.morph-img']) {
      expect(doc.querySelector(selector), selector).not.toBeNull();
    }
    expect(doc.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
    expect(doc.querySelector<HTMLInputElement>('input')!.checked).toBe(true);
    expect(doc.querySelector('table')!.textContent).toContain('1');
    expect(doc.querySelector('img')!.getAttribute('src')).toBe('morph-asset://sample');
    const h2 = doc.querySelector('h2')!;
    expect(h2.getAttribute('data-source-range')).toBe('3-3');
    expect(result.sourceMap).toContainEqual(expect.objectContaining({ nodeId: h2.getAttribute('data-node-id'), startLine: 3, endLine: 3 }));
    const ids = [...doc.querySelectorAll('[data-node-id]')].map(el => el.getAttribute('data-node-id'));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'])('test_callout_%s_preserves_body_and_emits_semantic_container', async type => {
    const result = await compileMarkdown(`> [!${type}]\n> Keep this sentence.\n> And **this** one.`);
    evidence(`ast-callout-${type}`, result);
    const callout = documentOf(result.html).querySelector(`.morph-callout-${type.toLowerCase()}`);
    expect(callout).not.toBeNull();
    expect(callout!.querySelector('.morph-callout-body')!.textContent).toContain('Keep this sentence.');
    expect(callout!.querySelector('strong')!.textContent).toBe('this');
    expect(callout!.getAttribute('data-source-range')).toBe('1-3');
  });

  it('test_inline_and_block_formulas_keep_tex_and_distinct_display_semantics', async () => {
    const result = await compileMarkdown('Inline $x^2$ here.\n\n$$\n\\frac{a}{b}\n$$');
    evidence('ast-formulas', result);
    const doc = documentOf(result.html);
    expect(doc.querySelector('.morph-math-inline')!.getAttribute('data-math-tex')).toBe('x^2');
    expect(doc.querySelector('.morph-math-display')!.getAttribute('data-math-tex')).toBe('\\frac{a}{b}');
    expect(doc.querySelectorAll('math')).toHaveLength(2);
    expect(doc.querySelector('.morph-math-display')!.getAttribute('data-source-range')).toBe('3-5');
  });

  it('test_fenced_code_keeps_characters_and_emits_colored_tokens', async () => {
    const result = await compileMarkdown('```typescript\nconst label = "<x> & y";\n```');
    evidence('ast-code', result);
    const doc = documentOf(result.html);
    expect(doc.querySelector('pre code')!.textContent!.trim()).toBe('const label = "<x> & y";');
    expect(doc.querySelector('pre span[style*="color"]')).not.toBeNull();
    expect(doc.querySelector('pre')!.classList.contains('morph-code')).toBe(true);
  });

  it('test_reference_definition_changed_or_removed_never_reuses_stale_destination', async () => {
    const cache = new HeavyBlockCache();
    for (const url of ['https://example.test/one', 'https://example.test/two']) {
      const result = await compileMarkdown(`[jump][ref]\n\nParagraph\n\n[ref]: ${url}`, { cache });
      expect(documentOf(result.html).querySelector('a')!.getAttribute('href')).toBe(url);
    }
    expect(documentOf((await compileMarkdown('[jump][ref]', { cache })).html).querySelector('a')).toBeNull();
  });

  it('test_repeated_heavy_blocks_hit_cache_without_sharing_output_mutations', async () => {
    const cache = new HeavyBlockCache();
    const source = '```typescript\nconst n = 1;\n```\n\n$x^2$';
    const first = await compileMarkdown(source, { cache });
    const before = cache.getStats();
    first.hast.children.splice(0);
    const second = await compileMarkdown(`Intro\n\n${source}`, { cache });
    const after = cache.getStats();
    evidence('ast-cache-reuse', { before, after, html: second.html });
    expect(after.hits - before.hits).toBe(2);
    expect(after.misses).toBe(before.misses);
    expect(documentOf(second.html).querySelector('pre')!.getAttribute('data-source-range')).toBe('3-5');
  });

  it.each(['content', 'language', 'theme', 'capability'] as const)('test_%s_change_invalidates_affected_heavy_output', async layer => {
    const cache = new HeavyBlockCache();
    const source = '```typescript\nconst n = 1;\n```\n\n$x^2$';
    await compileMarkdown(source, { cache });
    const before = cache.getStats();
    const changed = layer === 'content' ? source.replace('n = 1', 'n = 2') : layer === 'language' ? source.replace('typescript', 'javascript') : source;
    const result = await compileMarkdown(changed, { cache, themeKey: layer === 'theme' ? 'github-dark' : 'github-light', targetCapabilityVersion: layer === 'capability' ? 'v2' : 'v1' });
    const after = cache.getStats();
    expect(after.misses - before.misses).toBe(layer === 'content' || layer === 'language' ? 1 : 2);
    expect(after.hits - before.hits).toBe(layer === 'content' || layer === 'language' ? 1 : 0);
    expect(result.html).toContain('morph-code');
  });

  it('test_identical_paragraphs_have_distinct_stable_ids_when_prefix_is_inserted', async () => {
    const before = documentOf((await compileMarkdown('Same\n\nSame')).html);
    const after = documentOf((await compileMarkdown('# Prefix\n\nSame\n\nSame')).html);
    const ids = (doc: Document) => [...doc.querySelectorAll('p')].map(p => p.getAttribute('data-node-id'));
    expect(new Set(ids(before)).size).toBe(2);
    expect(ids(after)).toEqual(ids(before));
  });

  it('test_generated_formula_descendants_never_claim_unrelated_source_lines', async () => {
    const source = '# Heading\n\nParagraph\n\n$x^2$';
    const result = await compileMarkdown(source);
    evidence('ast-formula-source-map', result);
    const math = documentOf(result.html).querySelector('.morph-math')!;
    const ranges = [...math.querySelectorAll('[data-source-range]')].map(el => el.getAttribute('data-source-range'));
    expect(ranges.every(range => range === '5-5')).toBe(true);
  });

  it('test_raw_html_cannot_spoof_duplicate_node_identity_or_source_mapping', async () => {
    const result = await compileMarkdown('<p data-node-id="node-1" data-source-range="999-999">A</p>\n\nB');
    const doc = documentOf(result.html);
    const ids = [...doc.querySelectorAll('[data-node-id]')].map(el => el.getAttribute('data-node-id'));
    expect(new Set(ids).size).toBe(ids.length);
    expect(result.html).not.toContain('999-999');
  });

  it.each([
    ['adjacent_tags', '<script>void 0</script><script>void 0</script><iframe src="about:blank"></iframe>'],
    ['global_style', '<style>body { display: none }</style><p>Keep</p>'],
    ['svg_protocol', '<svg><a xlink:href="javascript:void(0)"><text>label</text></a></svg>'],
    ['raw_inline_style', '<p style="position:fixed;inset:0" onclick="void 0">Keep</p>'],
  ])('test_untrusted_%s_cannot_escape_document_security_boundary', async (name, source) => {
    const result = await compileMarkdown(source);
    evidence(`ast-security-${name}`, result);
    const doc = documentOf(result.html);
    expect(doc.querySelector('script, iframe, object, embed, style')).toBeNull();
    expect(result.html).not.toMatch(/javascript:|on(?:click|error)=|position\s*:\s*fixed/i);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });
});

describe('TestAstColdStart', () => {
  // Isolated process prevents other tests warming the highlighter before this scenario.
  it('test_sync_then_async_compile_upgrades_plain_fallback_to_highlighted_output', async () => {
    const { execFileSync } = await import('node:child_process');
    const script = `import {compileMarkdownSync,compileMarkdown,HeavyBlockCache} from './src/core/ast/index.ts'; const cache=new HeavyBlockCache(); const source='\`\`\`typescript\\nconst n = 1;\\n\`\`\`'; compileMarkdownSync(source,{cache}); console.log((await compileMarkdown(source,{cache})).html);`;
    const html = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { encoding: 'utf8' });
    evidence('ast-cold-start', { html });
    expect(documentOf(html).querySelector('pre span[style*="color"]')).not.toBeNull();
  });
});
