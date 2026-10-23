import { describe, expect, it } from 'vitest';
import { toHtml } from 'hast-util-to-html';
import { buildDeliverySnapshot, createDeliverySnapshotSync } from '../src/core/snapshot';
import { normalizeSelectionRange, serializeFullSnapshot } from '../src/core/selection';
import { assetStore, documentOf, evidence, selectionFixture, snapshotOf } from './support/contracts';
import { png } from './support/fixtures';

describe('TestDeliverySnapshot', () => {
  it('test_explicit_versions_and_ready_assets_are_reflected_in_delivery', async () => {
    const store = assetStore();
    const asset = await store.ingest(png());
    const result = await buildDeliverySnapshot(`## Heading\n\n![diagram](${asset.uri})`, 'wechat', store, { version: { doc: 2, style: 3, assets: 4 } });
    evidence('snapshot-ready', result);
    expect(result.version).toEqual({ doc: 2, style: 3, assets: 4 });
    expect(result.ready).toBe(true);
    expect(documentOf(result.html).querySelector('img')!.getAttribute('src')).toBe(asset.dataUrl);
    expect(result.sourceMap.length).toBeGreaterThan(0);
  });

  it('test_missing_or_pending_assets_prevent_ready_until_delivery_finishes', async () => {
    const store = assetStore();
    expect(createDeliverySnapshotSync('![lost](morph-asset://missing)', 'wechat', store).ready).toBe(false);
    const pending = store.ingest(png());
    const record = store.ingestSync(png());
    const first = createDeliverySnapshotSync(`![pending](${record.uri})`, 'wechat', store);
    expect(first.ready).toBe(false);
    expect(first.diagnostics).toContainEqual(expect.objectContaining({ assetId: record.id }));
    await pending;
    expect(createDeliverySnapshotSync(`![ready](${record.uri})`, 'wechat', store).ready).toBe(true);
  });

  it('test_caller_version_mutation_does_not_change_existing_snapshot', async () => {
    const version = { doc: 2, style: 3, assets: 4 };
    const snapshot = await buildDeliverySnapshot('Text', 'wechat', assetStore(), { version });
    version.doc = 99;
    expect(snapshot.version.doc).toBe(2);
  });

  it('test_nested_mutation_cannot_change_snapshot_or_serialized_payload', async () => {
    const store = assetStore();
    const snapshot = await buildDeliverySnapshot('## Heading', 'wechat', store);
    const original = JSON.stringify(snapshot);
    const attempts = [
      // @ts-expect-error Intentionally violate the readonly consumer contract to verify runtime freezing.
      () => { snapshot.version.style = 99; },
      // @ts-expect-error Intentionally violate the readonly consumer contract to verify runtime freezing.
      () => { snapshot.html = '<p>overwritten</p>'; },
      // @ts-expect-error Intentionally violate the readonly consumer contract to verify runtime freezing.
      () => { snapshot.hast.children.splice(0); },
      // @ts-expect-error Intentionally violate the readonly consumer contract to verify runtime freezing.
      () => { snapshot.sourceMap[0].startLine = 99; },
      // @ts-expect-error Intentionally violate the readonly consumer contract to verify runtime freezing.
      () => { snapshot.diagnostics.push({ code: 'injected', message: 'injected', severity: 'error' }); },
    ];
    for (const mutate of attempts) { try { mutate(); } catch { /* Frozen values may throw. */ } }
    expect(JSON.stringify(snapshot)).toBe(original);
    expect(serializeFullSnapshot(snapshot, store).plainText).toBe('Heading');
  });

  it('test_snapshot_tree_and_html_describe_the_same_styled_asset_delivery', async () => {
    const store = assetStore();
    const asset = await store.ingest(png());
    const snapshot = await buildDeliverySnapshot(`![diagram](${asset.uri})`, 'wechat', store, { customCss: '.morph-p {color:red}' });
    const fromTree = documentOf(toHtml(snapshot.hast));
    const fromString = documentOf(snapshot.html);
    expect(fromTree.querySelector('img')!.getAttribute('src')).toBe(fromString.querySelector('img')!.getAttribute('src'));
    expect(fromTree.querySelector('p')!.style.color).toBe(fromString.querySelector('p')!.style.color);
  });

  it('test_literal_asset_uri_in_code_or_prose_does_not_affect_readiness_or_text', async () => {
    const snapshot = await buildDeliverySnapshot('Use `morph-asset://missing` as a short reference.', 'wechat', assetStore());
    evidence('snapshot-literal-uri', snapshot);
    expect(snapshot.ready).toBe(true);
    expect(documentOf(snapshot.html).querySelector('code')!.textContent).toBe('morph-asset://missing');
  });

  it('test_existing_asset_uri_in_code_is_not_replaced_with_image_data', async () => {
    const store = assetStore();
    const asset = await store.ingest(png());
    const snapshot = await buildDeliverySnapshot(`Use \`${asset.uri}\`.`, 'wechat', store);
    expect(documentOf(snapshot.html).querySelector('code')!.textContent).toBe(asset.uri);
  });

  it('test_untrusted_remote_url_cannot_inject_attributes_into_snapshot', async () => {
    const store = assetStore();
    const asset = await store.ingest(png(), { remoteUrl: 'https://example.test/image.png" onerror="void 0' });
    const snapshot = await buildDeliverySnapshot(`![diagram](${asset.uri})`, 'x-article', store);
    evidence('snapshot-remote-injection', snapshot);
    expect(documentOf(snapshot.html).querySelector('img')!.hasAttribute('onerror')).toBe(false);
  });

  it.each([['insecure_http', 'http://example.test/image.png'], ['script_scheme', 'javascript:void(0)'], ['html_data', 'data:text/html,<p>x</p>']])('test_remote_transport_%s_never_publishes_unverified_protocol', async (_, remoteUrl) => {
    const store = assetStore();
    const asset = await store.ingest(png(), { remoteUrl });
    const snapshot = await buildDeliverySnapshot(`![diagram](${asset.uri})`, 'x-article', store);
    const src = documentOf(snapshot.html).querySelector('img')!.getAttribute('src')!;
    expect(src).not.toBe(remoteUrl);
    expect(snapshot.diagnostics.length).toBeGreaterThan(0);
  });

  it('test_later_asset_update_does_not_rewrite_already_versioned_snapshot_copy', async () => {
    const store = assetStore();
    const asset = await store.ingest(png(), { remoteUrl: 'https://example.test/old.png' });
    const snapshot = await buildDeliverySnapshot(`![diagram](${asset.uri})`, 'x-article', store);
    const before = serializeFullSnapshot(snapshot, store);
    store.advanceStatus(asset.id, 'delivery-ready', { remoteUrl: 'https://example.test/new.png' });
    const after = serializeFullSnapshot(snapshot, store);
    evidence('snapshot-version-drift', { preview: snapshot.html, before, after });
    expect(after.html).toBe(before.html);
  });

  it('test_full_serialization_preserves_document_root_typography', async () => {
    const store = assetStore();
    const snapshot = await buildDeliverySnapshot('Text', 'wechat', store, { tokens: { '--morph-body-size': '22px', '--morph-ink': 'red' } });
    const payload = serializeFullSnapshot(snapshot, store);
    evidence('snapshot-root-style', { snapshot: snapshot.html, payload });
    const sourceRoot = documentOf(snapshot.html).querySelector<HTMLElement>('.morph-doc')!;
    const copiedRoot = documentOf(payload.html).querySelector<HTMLElement>('.morph-doc');
    expect(copiedRoot).not.toBeNull();
    expect(copiedRoot!.style.fontSize).toBe(sourceRoot.style.fontSize);
    expect(payload.plainText).toBe('Text');
  });
});

describe('TestSelectionContextNormalizer', () => {
  it('test_partial_heading_text_restores_heading_nested_emphasis_and_inline_style', () => {
    const { doc, root, snapshot } = selectionFixture('<h2 style="color:rgb(1,2,3)">Hello <strong><em>beautiful</em></strong> world</h2>');
    const range = doc.createRange();
    const text = root.querySelector('em')!.firstChild!;
    range.setStart(text, 1);
    range.setEnd(text, 5);
    const payload = normalizeSelectionRange(range, root, snapshot, assetStore());
    evidence('selection-heading', payload);
    const output = documentOf(payload.html);
    expect(output.querySelector('h2 strong em')!.textContent).toBe('eaut');
    expect(output.querySelector('h2')!.style.color).toBe('rgb(1, 2, 3)');
    expect(payload.plainText).toBe('eaut');
  });

  it('test_middle_list_text_selection_restores_original_number_and_excludes_unselected_items', () => {
    const { doc, root, snapshot } = selectionFixture('<ol start="4"><li>Alpha</li><li>Beta</li><li>Gamma</li></ol>');
    const items = root.querySelectorAll('li');
    const range = doc.createRange();
    range.setStart(items[1].firstChild!, 1);
    range.setEnd(items[2].firstChild!, 3);
    const payload = normalizeSelectionRange(range, root, snapshot, assetStore());
    evidence('selection-list', payload);
    const list = documentOf(payload.html).querySelector('ol')!;
    expect(list.start).toBe(5);
    expect([...list.querySelectorAll('li')].map(el => el.textContent)).toEqual(['eta', 'Gam']);
    expect(payload.plainText).toBe('eta\nGam');
  });

  it('test_selection_starting_at_list_element_offset_restores_item_number', () => {
    const { doc, root, snapshot } = selectionFixture('<ol><li>A</li><li>B</li><li>C</li></ol>');
    const list = root.querySelector('ol')!;
    const range = doc.createRange();
    range.setStart(list, 1);
    range.setEnd(list, 3);
    const payload = normalizeSelectionRange(range, root, snapshot, assetStore());
    expect(documentOf(payload.html).querySelector('ol')!.start).toBe(2);
  });

  it('test_selection_leaving_list_for_paragraph_preserves_list_start', () => {
    const { doc, root, snapshot } = selectionFixture('<ol><li>A</li><li>B</li><li>C</li></ol><p>After</p>');
    const range = doc.createRange();
    range.setStart(root.querySelectorAll('li')[1].firstChild!, 0);
    range.setEnd(root.querySelector('p')!.firstChild!, 5);
    const payload = normalizeSelectionRange(range, root, snapshot, assetStore());
    evidence('selection-list-cross-block', payload);
    expect(documentOf(payload.html).querySelector('ol')!.start).toBe(2);
    expect(payload.plainText).toBe('B\nC\nAfter');
  });

  it('test_nested_list_selection_keeps_each_ancestor_numbering_context', () => {
    const { doc, root, snapshot } = selectionFixture('<ol start="10"><li>Outer<ol start="5"><li>A</li><li>B</li></ol></li></ol>');
    const range = doc.createRange();
    range.selectNodeContents(root.querySelector('ol ol li:last-child')!);
    const payload = normalizeSelectionRange(range, root, snapshot, assetStore());
    const lists = documentOf(payload.html).querySelectorAll('ol');
    expect([...lists].map(list => list.start)).toEqual([10, 6]);
  });

  it.each([
    ['explicit_value', '<ol><li value="10">A</li><li>B</li><li>C</li></ol>', 11],
    ['reversed', '<ol reversed start="8"><li>A</li><li>B</li><li>C</li></ol>', 7],
  ] as const)('test_%s_list_uses_visible_marker_number', (_, html, expected) => {
    const { doc, root, snapshot } = selectionFixture(html);
    const range = doc.createRange();
    range.selectNodeContents(root.querySelectorAll('li')[1]);
    expect(documentOf(normalizeSelectionRange(range, root, snapshot, assetStore()).html).querySelector('ol')!.start).toBe(expected);
  });

  it('test_partial_table_cell_restores_table_body_row_and_cell_style', () => {
    const { doc, root, snapshot } = selectionFixture('<table style="border-collapse:collapse"><tbody><tr><td style="color:red">Alpha</td><td>Beta</td></tr></tbody></table>');
    const range = doc.createRange();
    const text = root.querySelector('td')!.firstChild!;
    range.setStart(text, 1);
    range.setEnd(text, 4);
    const payload = normalizeSelectionRange(range, root, snapshot, assetStore());
    evidence('selection-table', payload);
    const cell = documentOf(payload.html).querySelector<HTMLElement>('table > tbody > tr > td')!;
    expect(cell.textContent).toBe('lph');
    expect(cell.style.color).toBe('red');
    expect(payload.plainText).toBe('lph');
  });

  it('test_cross_page_selection_removes_generated_headers_footers_and_repeated_table_head', () => {
    const content = '<section class="morph-card-page"><header data-morph-generated="header">Generated header</header><p>First</p><footer data-morph-generated="footer">Generated footer</footer></section><section class="morph-card-page"><header data-morph-generated="header">Generated header</header><table><thead data-morph-generated="repeat"><tr><th>Repeated title</th></tr></thead><tbody><tr><td>Cell</td></tr></tbody></table><p>Second</p><footer data-morph-generated="footer">Generated footer</footer></section>';
    const { doc, root, snapshot } = selectionFixture(content, 'cards');
    const range = doc.createRange();
    range.setStart(root.querySelectorAll('p')[0].firstChild!, 0);
    range.setEnd(root.querySelectorAll('p')[1].firstChild!, 6);
    const payload = normalizeSelectionRange(range, root, snapshot, assetStore());
    evidence('selection-cards', payload);
    expect(payload.html).not.toMatch(/data-morph-generated|morph-card-page|Generated|Repeated/);
    expect(payload.plainText).toBe('First\nCell\nSecond');
  });

  it.each([['wechat', 'wechat'], ['x_article', 'x-article']] as const)('test_%s_asset_replacement_is_synchronous_and_preserves_alt_and_tex', async (_, target) => {
    const store = assetStore();
    const asset = await store.ingest(png(), { remoteUrl: 'https://example.test/image.png' });
    const { doc, root, snapshot } = selectionFixture(`<p>A<img src="${asset.uri}" alt="diagram"><img src="${asset.blobUrl}" data-morph-asset-id="${asset.id}" alt="photo"><span class="morph-math-inline" data-math-tex="x^2">visual formula</span>B</p>`, target);
    const range = doc.createRange();
    range.selectNodeContents(root);
    const payload = normalizeSelectionRange(range, root, snapshot, store);
    evidence(`selection-assets-${target}`, payload);
    expect(payload).not.toBeInstanceOf(Promise);
    expect(payload.unresolvedAssetIds).toEqual([]);
    for (const img of documentOf(payload.html).querySelectorAll('img')) expect(img.getAttribute('src')).toBe(target === 'wechat' ? asset.dataUrl : asset.remoteUrl);
    expect(payload.plainText).toContain('diagram');
    expect(payload.plainText).toContain('photo');
    expect(payload.plainText).toContain('$x^2$');
    expect(payload.plainText).not.toContain('visual formula');
  });

  it('test_blob_without_explicit_asset_attribute_resolves_from_store', async () => {
    const store = assetStore();
    const asset = await store.ingest(png());
    const { doc, root, snapshot } = selectionFixture(`<img src="${asset.blobUrl}" alt="diagram">`);
    const range = doc.createRange();
    range.selectNodeContents(root);
    const payload = normalizeSelectionRange(range, root, snapshot, store);
    evidence('selection-bare-blob', payload);
    expect(documentOf(payload.html).querySelector('img')!.getAttribute('src')).toBe(asset.dataUrl);
  });

  it('test_missing_and_pending_asset_ids_are_reported_with_diagnostics', async () => {
    const store = assetStore();
    const pending = store.ingest(png());
    const asset = store.ingestSync(png());
    const { doc, root, snapshot } = selectionFixture(`<img src="morph-asset://missing" alt="lost"><img src="${asset.uri}" alt="loading">`);
    const range = doc.createRange();
    range.selectNodeContents(root);
    const payload = normalizeSelectionRange(range, root, snapshot, store);
    expect(new Set(payload.unresolvedAssetIds)).toEqual(new Set(['missing', asset.id]));
    expect(payload.diagnostics).toHaveLength(2);
    expect(payload.plainText).toContain('lost');
    await pending;
  });

  it('test_remote_only_ready_asset_is_usable_for_selection_and_full_copy', async () => {
    const store = assetStore();
    const asset = await store.ingest(png());
    store.advanceStatus(asset.id, 'delivery-ready', { dataUrl: undefined, remoteUrl: 'https://example.test/ready.png' });
    const { doc, root, snapshot } = selectionFixture(`<img src="${asset.uri}" alt="remote">`);
    const range = doc.createRange();
    range.selectNodeContents(root);
    const selection = normalizeSelectionRange(range, root, snapshot, store);
    const full = serializeFullSnapshot(snapshot, store);
    evidence('selection-remote-only', { selection, full });
    for (const payload of [selection, full]) {
      expect.soft(documentOf(payload.html).querySelector('img')!.getAttribute('src')).toBe(asset.remoteUrl);
      expect.soft(payload.unresolvedAssetIds).toEqual([]);
    }
  });

  it('test_formula_asset_atom_uses_ready_delivery_image_and_preserves_tex', async () => {
    const store = assetStore();
    const asset = await store.ingest(png());
    const { doc, root, snapshot } = selectionFixture(`<span class="morph-math-inline" data-morph-asset-id="${asset.id}" data-math-tex="x^2"><math><mi>x</mi></math></span>`);
    const range = doc.createRange();
    range.selectNodeContents(root);
    const payload = normalizeSelectionRange(range, root, snapshot, store);
    evidence('selection-formula-delivery', payload);
    expect(documentOf(payload.html).querySelector('img')?.getAttribute('src')).toBe(asset.dataUrl);
    expect(payload.plainText).toContain('x^2');
  });

  it('test_collapsed_range_produces_empty_payload', () => {
    const { doc, root, snapshot } = selectionFixture('<p>Text</p>');
    const range = doc.createRange();
    range.setStart(root.querySelector('p')!.firstChild!, 2);
    expect(normalizeSelectionRange(range, root, snapshot, assetStore())).toEqual({ html: '', plainText: '', unresolvedAssetIds: [], diagnostics: [] });
  });

  it('test_range_outside_root_never_copies_host_content', () => {
    const { doc, root, snapshot } = selectionFixture('<p>Article</p>');
    const outside = doc.createElement('p');
    outside.textContent = 'Host UI';
    doc.body.append(outside);
    const range = doc.createRange();
    range.selectNodeContents(outside);
    let copied = '';
    try { copied = normalizeSelectionRange(range, root, snapshot, assetStore()).plainText; } catch { /* Explicit rejection is valid. */ }
    expect(copied).not.toContain('Host UI');
  });

  it('test_line_breaks_and_selected_boundary_spaces_survive_plain_text_output', () => {
    const { doc, root, snapshot } = selectionFixture('<p> A<br>B </p>');
    const range = doc.createRange();
    range.selectNodeContents(root.querySelector('p')!);
    const payload = normalizeSelectionRange(range, root, snapshot, assetStore());
    expect(payload.plainText).toBe(' A\nB ');
  });

  it('test_full_snapshot_serialization_strips_generated_content_and_tracks_unresolved_assets', () => {
    const html = '<div class="morph-doc"><div class="morph-card-page"><header data-morph-generated="header">omit</header><h2>Keep</h2><img src="morph-asset://missing" alt="diagram"><span data-math-tex="a+b">rendered</span></div></div>';
    const payload = serializeFullSnapshot(snapshotOf(html, 'cards'), assetStore());
    evidence('selection-full-snapshot', payload);
    expect(payload.html).not.toMatch(/data-morph-generated|morph-card-page|omit/);
    expect(payload.unresolvedAssetIds).toEqual(['missing']);
    expect(payload.plainText).toContain('diagram');
    expect(payload.plainText).toContain('$a+b$');
  });
});
