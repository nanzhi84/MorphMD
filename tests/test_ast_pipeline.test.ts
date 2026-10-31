import { describe, expect, it } from 'vitest';
import { compileMarkdown, compileMarkdownSync, HeavyBlockCache } from '../src/core/ast';
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

  it('test_synchronous_compile_returns_plain_code_fallback_with_hast_and_source_map', () => {
    const result = compileMarkdownSync('# Sync Title\n\n```typescript\nconst syncVal = 1;\n```');
    evidence('ast-sync-compile', result);
    const doc = documentOf(result.html);
    expect(doc.querySelector('h1.morph-h1')!.textContent).toBe('Sync Title');
    expect(doc.querySelector('pre.morph-code code')!.textContent!.trim()).toBe('const syncVal = 1;');
    expect(result.hast.type).toBe('root');
    expect(result.sourceMap.length).toBeGreaterThanOrEqual(2);
    expect(result.diagnostics).toEqual([]);
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

  it('test_cjk_and_punctuation_adjacent_inline_formatting_renders_semantic_tags_without_raw_delimiters', async () => {
    const source = [
      '网卡、多个 IP 入口，服务端程序占用端口时，必须向操作系统声明自己愿意接收从哪张网卡进来的流量：',
      '',
      '>**回环监听（127.0.0.1）：**当后端程序提示运行在 http://127.0.0.1:8000 时，代表它向操作系统声明只接收本机…',
      '',
      '这是**（重点内容）**与**(次要内容)**以及*（斜体说明）：*还有~~（废弃项）：~~紧接着中文，实现**C++**与**50%**提升。',
    ].join('\n');
    const result = await compileMarkdown(source);
    const syncResult = compileMarkdownSync(source);
    evidence('ast-cjk-inline-formatting', { source, ...result });

    for (const html of [result.html, syncResult.html]) {
      const doc = documentOf(html);
      const quote = doc.querySelector('.morph-quote');
      expect(quote).not.toBeNull();
      expect(quote!.querySelector('strong')?.textContent).toBe('回环监听（127.0.0.1）：');
      expect(quote!.querySelector('a')?.getAttribute('href')).toBe('http://127.0.0.1:8000');
      expect(quote!.textContent?.trim()).toBe(
        '回环监听（127.0.0.1）：当后端程序提示运行在 http://127.0.0.1:8000 时，代表它向操作系统声明只接收本机…'
      );

      const paragraphs = [...doc.querySelectorAll('.morph-doc > .morph-p')];
      const inlinePara = paragraphs[1]!;
      expect([...inlinePara.querySelectorAll('strong')].map(el => el.textContent)).toEqual([
        '（重点内容）',
        '(次要内容)',
        'C++',
        '50%',
      ]);
      expect([...inlinePara.querySelectorAll('em')].map(el => el.textContent)).toEqual(['（斜体说明）：']);
      expect([...inlinePara.querySelectorAll('del')].map(el => el.textContent)).toEqual(['（废弃项）：']);
      expect(inlinePara.textContent).toBe(
        '这是（重点内容）与(次要内容)以及（斜体说明）：还有（废弃项）：紧接着中文，实现C++与50%提升。'
      );
      expect(doc.body.textContent).not.toMatch(/\*\*|~~/);
    }
  });

  it('test_image_captions_from_adjacent_lines_italic_lines_and_titles_render_as_caption_blocks', async () => {
    const source = [
      '![](https://example.com/arch.png)',
      '左侧是找到机器和进程的 IP、网卡、端口与监听',
      '',
      '![图 1　IP、端口与 DNS 知识结构：左侧是找到机器和进程的 IP、网卡、端口与监听，右侧是把域名翻译成 IP 的 DNS 体系](https://example.com/net.png)',
      '',
      '![](https://example.com/seq.png)',
      '',
      '*补充说明：客户端与服务端三次握手时序*',
      '',
      '![](https://example.com/title.png "通过图片 title 属性声明的图注")',
      '',
      '![](https://example.com/normal.png)',
      '',
      '这是一段普通的正文段落，不应该被误判为图注。',
    ].join('\n');

    const result = await compileMarkdown(source);
    const syncResult = compileMarkdownSync(source);
    evidence('ast-image-captions', { source, asyncHtml: result.html, syncHtml: syncResult.html });

    const expectedCaptions = [
      '左侧是找到机器和进程的 IP、网卡、端口与监听',
      '图 1　IP、端口与 DNS 知识结构：左侧是找到机器和进程的 IP、网卡、端口与监听，右侧是把域名翻译成 IP 的 DNS 体系',
      '补充说明：客户端与服务端三次握手时序',
      '通过图片 title 属性声明的图注',
    ];

    for (const html of [result.html, syncResult.html]) {
      const doc = documentOf(html);
      const images = [...doc.querySelectorAll('img.morph-img')];
      expect(images).toHaveLength(5);

      for (let i = 0; i < 4; i++) {
        const mediaPara = images[i]!.closest('p');
        expect(mediaPara).not.toBeNull();
        expect(mediaPara!.classList.contains('morph-p')).toBe(true);
        expect(mediaPara!.classList.contains('morph-figure-media')).toBe(true);

        const nextEl = mediaPara!.nextElementSibling;
        expect(nextEl).not.toBeNull();
        expect(nextEl!.tagName.toLowerCase()).toBe('p');
        expect(nextEl!.classList.contains('morph-caption')).toBe(true);
        expect(nextEl!.textContent?.trim()).toBe(expectedCaptions[i]);
        expect(nextEl!.getAttribute('data-node-id')).toMatch(/^node-/);
        expect(nextEl!.getAttribute('data-source-range')).toMatch(/^\d+-\d+$/);
      }

      const fifthMediaPara = images[4]!.closest('p');
      expect(fifthMediaPara).not.toBeNull();
      expect(fifthMediaPara!.classList.contains('morph-p')).toBe(true);
      expect(fifthMediaPara!.classList.contains('morph-figure-media')).toBe(false);

      const fifthNextEl = fifthMediaPara!.nextElementSibling;
      expect(fifthNextEl).not.toBeNull();
      expect(fifthNextEl!.classList.contains('morph-p')).toBe(true);
      expect(fifthNextEl!.classList.contains('morph-caption')).toBe(false);
      expect(fifthNextEl!.textContent?.trim()).toBe('这是一段普通的正文段落，不应该被误判为图注。');
    }
  });
});

describe('TestAstColdStart', () => {
  // Isolated process prevents other tests warming the highlighter before this scenario.
  it('test_sync_then_async_compile_upgrades_plain_fallback_to_highlighted_output', async () => {
    const { execFileSync } = await import('node:child_process');
    const script = `import {compileMarkdownSync,compileMarkdown,HeavyBlockCache} from './src/core/ast/index.ts'; const cache=new HeavyBlockCache(); const source='\`\`\`typescript\\nconst n = 1;\\n\`\`\`'; const syncRes=compileMarkdownSync(source,{cache}); const asyncRes=await compileMarkdown(source,{cache}); console.log(JSON.stringify({syncHtml:syncRes.html,asyncHtml:asyncRes.html}));`;
    const output = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { encoding: 'utf8' }));
    evidence('ast-cold-start', output);
    const syncDoc = documentOf(output.syncHtml);
    expect(syncDoc.querySelector('pre.morph-code code')!.textContent!.trim()).toBe('const n = 1;');
    expect(syncDoc.querySelector('pre span[style*="color"]')).toBeNull();
    expect(documentOf(output.asyncHtml).querySelector('pre span[style*="color"]')).not.toBeNull();
  });
});
