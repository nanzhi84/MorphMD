import { describe, expect, it } from 'vitest';
import { analyzeStyles, DEFAULT_DESIGN_TOKENS, getDefaultCapabilities, inlineStyles, MORPH_TOKEN_KEYS, serializeTokensToCss } from '../src/core/style';
import { documentOf, evidence } from './support/contracts';

const content = '<div class="morph-doc"><h2 class="morph-h2">Heading</h2><p class="morph-p">Body <em>child</em></p><pre class="morph-code"><code>const n = 1;</code></pre></div>';

describe('TestStyleEngine', () => {
  it('test_nine_design_tokens_have_defaults_and_serializable_overrides', () => {
    const expected = ['--morph-bg', '--morph-ink', '--morph-accent', '--morph-font-serif', '--morph-font-sans', '--morph-font-mono', '--morph-body-size', '--morph-line-height', '--morph-block-gap'];
    expect([...MORPH_TOKEN_KEYS]).toEqual(expected);
    expect(Object.keys(DEFAULT_DESIGN_TOKENS)).toEqual(expected);
    const result = analyzeStyles(serializeTokensToCss({ '--morph-accent': '#123456' }));
    expect(result.customProperties.size).toBe(9);
    expect(result.customProperties.get('--morph-accent')).toBe('#123456');
    expect(result.propertyWhitelist.size).toBe(0);
  });

  it('test_declared_properties_are_extracted_without_custom_variables_or_browser_defaults', () => {
    const result = analyzeStyles('.morph-p { color: red; margin: 1em; --local: blue } .morph-h2 { font-weight: 700 }');
    expect([...result.propertyWhitelist].sort()).toEqual(['color', 'font-weight', 'margin']);
  });

  it.each([
    ['script_protocol', 'background-image:url("javascript:void(0)")'],
    ['html_protocol', 'background-image:url("data:text/html,<p>x</p>")'],
    ['expression', 'width:expression(1+1)'],
    ['fixed_position', 'position:fixed'],
    ['escaped_script_protocol', 'background-image:url("j\\61vascript:void(0)")'],
    ['escaped_expression', 'width:expres\\73ion(1+1)'],
    ['uppercase_position', 'POSITION:fixed'],
  ])('test_dangerous_%s_declaration_is_removed_and_diagnosed', (name, declaration) => {
    const result = analyzeStyles(`.morph-p { ${declaration}; color:red }`, 'cards');
    evidence(`style-danger-${name}`, result);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect([...result.propertyWhitelist]).toEqual(['color']);
  });

  it.each([['body', 'body'], ['html', 'html'], ['app_id', '#app'], ['nested_is', ':is(body)'], ['nested_where', ':where(html)'], ['body_before', 'body::before']])('test_global_selector_%s_is_intercepted_with_diagnostics', (_, selector) => {
    const result = analyzeStyles(`${selector} { color:red; content:"x" }`);
    evidence(`style-scope-${selector.replace(/\W/g, '_')}`, result);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.pseudoRules).toHaveLength(0);
    expect(result.propertyWhitelist.has('color')).toBe(false);
  });

  it.each([['lowercase_import', '@import'], ['uppercase_import', '@IMPORT']])('test_external_%s_rule_is_blocked', (_, rule) => {
    const result = analyzeStyles(`${rule} url("https://example.test/external.css"); .morph-p {color:red}`);
    expect(result.sanitizedCss.toLowerCase()).not.toContain('@import');
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it('test_cards_overflow_hidden_is_removed_after_diagnostic', () => {
    const result = analyzeStyles('.morph-p {overflow:hidden;color:red}', 'cards');
    evidence('style-overflow', result);
    expect(result.diagnostics.some(d => d.property === 'overflow')).toBe(true);
    expect(result.sanitizedCss).not.toMatch(/overflow\s*:\s*hidden/);
    expect(result.propertyWhitelist.has('overflow')).toBe(false);
  });

  it('test_dangerous_custom_property_is_not_reintroduced_through_variable_resolution', () => {
    const result = analyzeStyles(':root {--payload:url("javascript:void(0)")} .morph-p {background:var(--payload)}');
    evidence('style-danger-variable', result);
    expect(result.sanitizedCss).not.toContain('javascript:');
    expect(result.customProperties.get('--payload') || '').not.toContain('javascript:');
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it('test_only_declared_and_capability_allowed_properties_are_inlined', () => {
    const capabilities = { ...getDefaultCapabilities('wechat'), allowedStyleProps: new Set(['color']) };
    const result = inlineStyles('<div class="morph-doc"><p class="morph-p">Text</p></div>', {
      capabilities, customCss: '.morph-p {color:rgb(12,34,56); width:100px; padding:8px}',
    });
    const doc = documentOf(result.html);
    expect(doc.querySelector('p')!.style.color).toBe('rgb(12, 34, 56)');
    for (const el of doc.querySelectorAll<HTMLElement>('[style]')) expect(Array.from(el.style)).toEqual(['color']);
  });

  it('test_simple_before_after_are_materialized_once_with_literal_content', () => {
    const result = inlineStyles(content, {
      capabilities: getDefaultCapabilities('wechat'),
      customCss: '.morph-h2::before {content:"§ ";color:red} .morph-h2::after {content:" !";font-weight:700}',
    });
    evidence('style-pseudos', result);
    const heading = documentOf(result.html).querySelector('h2')!;
    expect(heading.querySelectorAll('[data-morph-pseudo]')).toHaveLength(2);
    expect(heading.querySelector('[data-morph-pseudo="before"]')!.textContent).toBe('§ ');
    expect(heading.querySelector('[data-morph-pseudo="after"]')!.textContent).toBe(' !');
    expect(heading.textContent).toBe('§ Heading !');
  });

  it('test_pseudo_declarations_obey_security_and_property_capability_guard', () => {
    const result = inlineStyles(content, {
      capabilities: { ...getDefaultCapabilities('wechat'), allowedStyleProps: new Set(['color']) },
      customCss: '.morph-h2::before {content:"x";color:red;position:fixed;width:100px;background-image:url("javascript:void(0)")}',
    });
    evidence('style-pseudo-bypass', result);
    const pseudo = documentOf(result.html).querySelector<HTMLElement>('[data-morph-pseudo]')!;
    expect(Array.from(pseudo.style)).toEqual(['color']);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it('test_scoped_variables_and_adjacent_selectors_keep_distinct_computed_values', () => {
    const result = inlineStyles('<div class="morph-doc"><p class="morph-p first">A</p><p class="morph-p second">B</p></div>', {
      capabilities: getDefaultCapabilities('wechat'),
      customCss: '.first {--ink:red;color:var(--ink)} .first + .second {--ink:blue;color:var(--ink)}',
    });
    evidence('style-variable-scope', result);
    const doc = documentOf(result.html);
    expect(doc.querySelector<HTMLElement>('.first')!.style.color).toMatch(/^(red|rgb\(255, 0, 0\))$/);
    expect(doc.querySelector<HTMLElement>('.second')!.style.color).toMatch(/^(blue|rgb\(0, 0, 255\))$/);
  });

  it('test_layer_cascade_with_comments_and_escaped_identifiers_resolves_consistently', () => {
    const html = '<div class="morph-doc"><p class="morph-p a">Body</p></div>';
    const css = [
      '.morph-doc { --a: green }',
      String.raw`@layer foo/*comment*/.bar, foo\61 .bar, \2e .bar, foo\20 .bar;`,
      String.raw`@layer foo\20 .bar { .morph-p.a::before { --a: red } }`,
      String.raw`@layer foo\ .bar { .morph-p::before { --a: blue } }`,
      '.morph-p::before { content: "X"; color: var(--a) }',
    ].join('\n');
    const result = inlineStyles(html, { capabilities: getDefaultCapabilities('wechat'), customCss: css });
    const pseudo = documentOf(result.html).querySelector<HTMLElement>('[data-morph-pseudo="before"]')!;
    expect(pseudo.style.color).toMatch(/^(red|rgb\(255, 0, 0\))$/);
  });
});

describe('TestStyleCapabilityGuard', () => {
  it('test_native_text_remains_unstyled_and_emits_property_diagnostics', () => {
    const result = inlineStyles(content, { capabilities: getDefaultCapabilities('x-article'), customCss: '.morph-p {color:red;font-size:24px}' });
    expect(documentOf(result.html).querySelector('p')!.hasAttribute('style')).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ property: 'color', targetId: 'x-article' }));
  });

  it('test_declared_raster_block_preserves_styles_for_image_rendering', () => {
    const result = inlineStyles(content, { capabilities: getDefaultCapabilities('x-article'), customCss: '.morph-code {color:red;font-size:24px}' });
    const code = documentOf(result.html).querySelector<HTMLElement>('pre')!;
    expect(code.style.color).toMatch(/red|rgb\(255, 0, 0\)/);
    expect(code.style.fontSize).toBe('24px');
  });

  it('test_empty_raster_capabilities_do_not_bypass_native_style_restrictions', () => {
    const result = inlineStyles(content, {
      capabilities: { ...getDefaultCapabilities('x-article'), rasterizeBlocks: new Set() },
      customCss: '.morph-code {color:red}',
    });
    expect(documentOf(result.html).querySelector('pre')!.hasAttribute('style')).toBe(false);
  });

  it('test_existing_inline_styles_and_pseudos_cannot_style_native_text', () => {
    const result = inlineStyles('<div class="morph-doc"><p class="morph-p" style="color:red">Body</p></div>', {
      capabilities: getDefaultCapabilities('x-article'), customCss: '.morph-p::before {content:"X";color:blue}',
    });
    evidence('style-native-bypass', result);
    expect(documentOf(result.html).querySelector('p[style], p [style]')).toBeNull();
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it('test_existing_inline_properties_are_filtered_to_allowed_subset', () => {
    const result = inlineStyles('<div class="morph-doc"><p class="morph-p" style="position:fixed; color:red">Text</p></div>', {
      capabilities: { ...getDefaultCapabilities('wechat'), allowedStyleProps: new Set(['color']) },
    });
    expect(documentOf(result.html).querySelector('p')!.style.position).toBe('');
  });

  it('test_token_only_native_style_change_emits_target_diagnostic', () => {
    const result = inlineStyles(content, { capabilities: getDefaultCapabilities('x-article'), tokens: { '--morph-ink': 'red' } });
    expect(result.diagnostics.some(d => d.targetId === 'x-article')).toBe(true);
  });
});
