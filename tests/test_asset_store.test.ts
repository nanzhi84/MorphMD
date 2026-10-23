import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { parseImageMetadata } from '../src/core/assets';
import { assetStore, evidence } from './support/contracts';
import { jpeg, png } from './support/fixtures';

describe('TestAssetStore', () => {
  it('test_complete_png_passes_four_stages_and_produces_readable_delivery_bytes', async () => {
    const store = assetStore();
    const data = png();
    const record = await store.ingest(data);
    evidence('asset-png', { record, history: store.getTransitionHistory(record.id) });
    expect(record.uri).toBe(`morph-asset://${record.id}`);
    expect(record).toMatchObject({ width: 3, height: 2, mimeType: 'image/png', status: 'delivery-ready' });
    expect(store.getTransitionHistory(record.id)).toEqual(['received', 'metadata-ready', 'preview-ready', 'delivery-ready']);
    expect(new Uint8Array(await (await fetch(record.blobUrl!)).arrayBuffer())).toEqual(data);
    expect(new Uint8Array(await (await fetch(record.dataUrl!)).arrayBuffer())).toEqual(data);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('test_jpeg_orientation_%i_normalizes_visual_dimensions', async orientation => {
    const data = jpeg(orientation);
    const record = await assetStore().ingest(data);
    expect(record).toMatchObject({ mimeType: 'image/jpeg', exifOrientation: orientation, width: orientation >= 5 ? 2 : 3, height: orientation >= 5 ? 3 : 2 });
    expect(parseImageMetadata(data)).toMatchObject({ naturalWidth: 3, naturalHeight: 2 });
  });

  it('test_big_endian_jpeg_orientation_swaps_dimensions', () => {
    expect(parseImageMetadata(jpeg(6, false))).toMatchObject({ width: 2, height: 3, exifOrientation: 6 });
  });

  it.each([
    ['empty', new Uint8Array()],
    ['text', new TextEncoder().encode('This is not an image')],
    ['header_only', png().slice(0, 24)],
    ['truncated_pixels', png().slice(0, 40)],
  ])('test_invalid_%s_input_fails_without_publishing_delivery_url', async (name, data) => {
    const store = assetStore();
    const record = await store.ingest(data);
    evidence(`asset-invalid-${name}`, record);
    expect(record.status).toBe('failed');
    expect(record.error).toBeTruthy();
    expect(record.dataUrl).toBeUndefined();
    expect(record.blobUrl).toBeUndefined();
  });

  it('test_identical_bytes_deduplicate_across_distinct_buffers_and_filenames', async () => {
    const store = assetStore();
    const first = await store.ingest(png(), { fileName: 'first.png' });
    const second = await store.ingest(png().slice(), { fileName: 'second.png' });
    expect(second.id).toBe(first.id);
    expect(second.refCount).toBe(2);
    expect(store.getByUri(first.uri)!.id).toBe(first.id);
  });

  it('test_concurrent_duplicate_ingest_resolves_only_after_delivery_ready', async () => {
    const store = assetStore();
    const first = store.ingest(png());
    const second = store.ingest(png()).then(record => ({ statusAtResolution: record.status, id: record.id }));
    const duplicate = await second;
    const original = await first;
    evidence('asset-concurrent', { duplicate, finalStatus: original.status });
    expect(duplicate.statusAtResolution).toBe('delivery-ready');
    expect(duplicate.id).toBe(original.id);
  });

  it('test_export_lock_keeps_blob_readable_until_last_reference_and_lock_release', async () => {
    const store = assetStore();
    const record = await store.ingest(png());
    const url = record.blobUrl!;
    store.retain(record.id);
    const unlock = store.acquireLock(record.id);
    store.release(record.id);
    store.release(record.id);
    expect((await fetch(url)).ok).toBe(true);
    unlock();
    unlock();
    expect(record.activeLocks).toBe(0);
    expect(record.blobUrl).toBeUndefined();
    await expect(fetch(url)).rejects.toThrow();
  });

  it.each(['remove', 'clear'] as const)('test_%s_during_export_defers_blob_revocation_until_unlock', async action => {
    const store = assetStore();
    const record = await store.ingest(png());
    const url = record.blobUrl!;
    const unlock = store.acquireLock(record.id);
    store.release(record.id);
    if (action === 'remove') store.remove(record.id);
    else store.clear();
    try {
      expect((await fetch(url)).ok).toBe(true);
    } finally { unlock(); }
    await expect(fetch(url)).rejects.toThrow();
  });

  it('test_unreferenced_lru_asset_is_evicted_while_recent_asset_survives', async () => {
    const store = assetStore({ maxEntries: 2 });
    const first = await store.ingest(png(1));
    const second = await store.ingest(png(2));
    store.release(first.id);
    store.release(second.id);
    store.get(first.id);
    const third = await store.ingest(png(3));
    expect(store.has(first.id)).toBe(true);
    expect(store.has(second.id)).toBe(false);
    expect(store.has(third.id)).toBe(true);
  });

  it('test_byte_budget_evicts_unreferenced_data_before_new_asset', async () => {
    const store = assetStore({ maxBytes: png(1).length + png(2).length - 1 });
    const first = await store.ingest(png(1));
    store.release(first.id);
    const second = await store.ingest(png(2));
    expect(store.has(first.id)).toBe(false);
    expect(store.has(second.id)).toBe(true);
  });

  it.each(['entries', 'bytes'] as const)('test_%s_budget_with_no_evictable_asset_rejects_new_admission', async limit => {
    const store = assetStore(limit === 'entries' ? { maxEntries: 1 } : { maxBytes: png(1).length });
    const first = await store.ingest(png(1));
    const unlock = store.acquireLock(first.id);
    let rejected = false;
    try {
      const next = await store.ingest(png(2));
      rejected = next.status === 'failed' && !store.getBinary(next.id);
    } catch { rejected = true; }
    finally { unlock(); }
    expect(store.has(first.id)).toBe(true);
    expect(rejected).toBe(true);
  });

  it('test_single_asset_larger_than_budget_is_rejected', async () => {
    const store = assetStore({ maxBytes: 1 });
    let rejected = false;
    try {
      const result = await store.ingest(png());
      rejected = result.status === 'failed' && !store.getBinary(result.id);
    } catch { rejected = true; }
    expect(rejected).toBe(true);
  });

  it('test_remove_during_decode_does_not_resurrect_removed_asset', async () => {
    const store = assetStore();
    const pending = store.ingest(png());
    // The public sync entry returns the same in-flight duplicate receipt.
    const receipt = store.ingestSync(png());
    store.remove(receipt.id);
    const result = await pending;
    expect(store.has(receipt.id)).toBe(false);
    expect(result.blobUrl).toBeUndefined();
    expect(result.dataUrl).toBeUndefined();
    const fresh = await store.ingest(png());
    expect(fresh.id).not.toBe(receipt.id);
    expect(fresh.status).toBe('delivery-ready');
  });

  it('test_release_all_references_during_decode_does_not_leak_blob_url', async () => {
    const store = assetStore();
    const pending = store.ingest(png());
    const receipt = store.ingestSync(png());
    store.release(receipt.id);
    store.release(receipt.id);
    const result = await pending;
    evidence('asset-release-race', result);
    expect(result.refCount).toBe(0);
    expect(result.blobUrl).toBeUndefined();
  });

  it('test_repasting_released_bytes_restores_readable_preview', async () => {
    const store = assetStore();
    const first = await store.ingest(png());
    store.release(first.id);
    const again = await store.ingest(png());
    expect(again.blobUrl).toMatch(/^blob:/);
    expect((await fetch(again.blobUrl!)).ok).toBe(true);
  });

  it('test_input_and_returned_binary_mutations_cannot_corrupt_stored_content', async () => {
    const store = assetStore();
    const data = png();
    const expected = data.slice();
    const record = await store.ingest(data);
    data.fill(0);
    store.getBinary(record.id)!.fill(1);
    expect(store.exportPackageManifest(`![alt](${record.uri})`).assets[0].data).toEqual(expected);
  });

  it('test_illegal_status_regression_cannot_reset_delivery_ready_record', async () => {
    const store = assetStore();
    const record = await store.ingest(png());
    try { store.advanceStatus(record.id, 'received'); } catch { /* A rejected transition is valid. */ }
    expect(store.get(record.id)!.status).toBe('delivery-ready');
  });

  it('test_package_export_rewrites_short_uris_and_includes_each_binary_once', async () => {
    const store = assetStore();
    const record = await store.ingest(png(), { fileName: 'diagram.png' });
    const manifest = store.exportPackageManifest(`![a](${record.uri})\n\n![b](${record.uri})`);
    expect(manifest.assets).toHaveLength(1);
    expect(manifest.assets[0].exportPath).toBe('./assets/diagram.png');
    expect(manifest.assets[0].data).toEqual(png());
    expect(manifest.rewrittenContent).toBe('![a](./assets/diagram.png)\n\n![b](./assets/diagram.png)');
  });

  it('test_duplicate_filenames_export_to_distinct_package_paths', async () => {
    const store = assetStore();
    const a = await store.ingest(png(1), { fileName: 'same.png' });
    const b = await store.ingest(png(2), { fileName: 'same.png' });
    const manifest = store.exportPackageManifest(`![a](${a.uri}) ![b](${b.uri})`);
    evidence('asset-filename-collision', manifest);
    expect(new Set(manifest.assets.map(a => a.exportPath)).size).toBe(2);
  });

  it('test_untrusted_filename_cannot_escape_package_asset_directory', async () => {
    const store = assetStore();
    const record = await store.ingest(png(), { fileName: '../../outside.png' });
    const path = store.exportPackageManifest(`![a](${record.uri})`).assets[0].exportPath;
    evidence('asset-path-traversal', { path });
    expect(resolve('/package', path).startsWith('/package/assets/')).toBe(true);
  });
});
