import { fromHtml } from 'hast-util-from-html';
import { compileMarkdown, compileMarkdownSync } from '../ast/compiler';
import type { CompileOptions } from '../ast/types';
import type { AssetStore } from '../assets/store';
import { inlineStyles } from '../style/inliner';
import { getDefaultCapabilities } from '../style/guard';
import type { DesignTokens } from '../style/tokens';
import { dedupeWeChatNesting } from '../wechat/normalizer';
import { normalizeXArticleStructureAndStyles } from '../x-article/normalizer';
import { paginateDom, type CardsPaginationOptions } from '../cards';
import type {
  DeliverySnapshot,
  TargetId,
  AdapterCapabilities,
  DiagnosticItem,
  SourceRangeEntry,
} from './types';

export interface SnapshotOptions {
  customCss?: string;
  tokens?: Partial<DesignTokens>;
  capabilities?: AdapterCapabilities;
  /**
   * Explicit snapshot version numbers.
   * `buildDeliverySnapshot` and `createDeliverySnapshotSync` are stateless pure builders:
   * when omitted, version defaults to `{ doc: 1, style: 1, assets: 1 }`.
   * The caller (upper-layer editor or session controller) is responsible for
   * monotonically advancing `doc`, `style`, and `assets` version counters across edits.
   */
  version?: {
    doc: number;
    style: number;
    assets: number;
  };
  compileOptions?: CompileOptions;
  cardsOptions?: CardsPaginationOptions;
}

function restoreBase64Placeholders(node: any, table: string[]): void {
  if (!node || typeof node !== 'object') return;
  if (typeof node.value === 'string' && node.value.includes('__MORPH_B64_')) {
    node.value = node.value.replace(/__MORPH_B64_(\d+)__/g, (_: string, idx: string) => table[Number(idx)]);
  }
  if (node.properties && typeof node.properties === 'object') {
    for (const key of Object.keys(node.properties)) {
      const val = node.properties[key];
      if (typeof val === 'string' && val.includes('__MORPH_B64_')) {
        node.properties[key] = val.replace(/__MORPH_B64_(\d+)__/g, (_: string, idx: string) => table[Number(idx)]);
      }
    }
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      restoreBase64Placeholders(child, table);
    }
  }
}

function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') return obj;
  Object.freeze(obj);
  for (const key of Object.keys(obj)) {
    const val = (obj as any)[key];
    if (val !== null && typeof val === 'object' && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

function isValidRemoteHttpsUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  if (/[\s"'<>]/.test(url)) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function createDeliverySnapshotSync(
  markdown: string,
  targetId: TargetId,
  assetStore: AssetStore,
  options: SnapshotOptions = {}
): DeliverySnapshot {
  const version = {
    doc: options.version?.doc ?? 1,
    style: options.version?.style ?? 1,
    assets: options.version?.assets ?? 1,
  };
  const capabilities = options.capabilities || getDefaultCapabilities(targetId);
  const compileOpts: CompileOptions = {
    themeKey: 'vitesse-light',
    ...options.compileOptions,
  };
  const astResult = compileMarkdownSync(markdown, compileOpts);
  return finalizeSnapshot(astResult, targetId, capabilities, assetStore, version, options);
}

export async function buildDeliverySnapshot(
  markdown: string,
  targetId: TargetId,
  assetStore: AssetStore,
  options: SnapshotOptions = {}
): Promise<DeliverySnapshot> {
  const version = {
    doc: options.version?.doc ?? 1,
    style: options.version?.style ?? 1,
    assets: options.version?.assets ?? 1,
  };
  const capabilities = options.capabilities || getDefaultCapabilities(targetId);
  const compileOpts: CompileOptions = {
    themeKey: 'vitesse-light',
    ...options.compileOptions,
  };
  const astResult = await compileMarkdown(markdown, compileOpts);
  return finalizeSnapshot(astResult, targetId, capabilities, assetStore, version, options);
}

const snapshotReferencedAssetIds = new WeakMap<DeliverySnapshot, Set<string>>();

export function getSnapshotReferencedAssetIds(snapshot: DeliverySnapshot): Set<string> | undefined {
  return snapshotReferencedAssetIds.get(snapshot);
}

function finalizeSnapshot(
  astResult: { html: string; diagnostics: DiagnosticItem[]; sourceMap: SourceRangeEntry[] },
  targetId: TargetId,
  capabilities: AdapterCapabilities,
  assetStore: AssetStore,
  version: { doc: number; style: number; assets: number },
  options: SnapshotOptions
): DeliverySnapshot {
  const allDiagnostics: DiagnosticItem[] = [...astResult.diagnostics];
  let ready = true;

  const optVer = options.version;
  if (optVer) {
    const isPosInt = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= 1;
    if (!isPosInt(optVer.doc) || !isPosInt(optVer.style) || !isPosInt(optVer.assets)) {
      ready = false;
      allDiagnostics.push({
        code: 'snapshot/invalid-version',
        message: 'Snapshot options.version contains invalid, fractional, negative, or NaN version numbers.',
        severity: 'error',
      });
    }
  }

  if (options.capabilities && options.capabilities.targetId !== targetId) {
    ready = false;
    allDiagnostics.push({
      code: 'snapshot/target-mismatch',
      message: `Capabilities targetId "${options.capabilities.targetId}" does not match snapshot targetId "${targetId}".`,
      severity: 'error',
    });
  }

  const referencedAssets = new Set<string>();

  // 1 & 2. Process inline styles, capabilities guard, DOM-based Asset Resolution, and target normalization in a single DOM pass
  const styleResult = inlineStyles(astResult.html, {
    customCss: options.customCss,
    tokens: options.tokens,
    capabilities,
    afterInline(root, doc, inlineDiagnostics) {
      const images = Array.from(root.querySelectorAll('img'));

      for (const img of images) {
        let assetId = img.getAttribute('data-morph-asset-id');
        const src = img.getAttribute('src') || '';

        if (!assetId && src.startsWith('morph-asset://')) {
          assetId = src.replace('morph-asset://', '').split('?')[0].split('#')[0];
        }

        if (assetId) {
          referencedAssets.add(assetId);
          const record = assetStore.get(assetId);
          if (!record) {
            ready = false;
            inlineDiagnostics.push({
              code: 'asset/not-found',
              message: `Referenced asset "${assetId}" was not found in AssetStore.`,
              severity: 'error',
              assetId,
            });
            continue;
          }

          if (record.status !== 'delivery-ready') {
            ready = false;
            inlineDiagnostics.push({
              code: 'asset/not-delivery-ready',
              message: `Asset "${assetId}" is not delivery ready (current status: ${record.status}).`,
              severity: 'warning',
              assetId,
            });
          }

          // Determine delivery URL
          let deliveryUrl: string | undefined;

          if (capabilities.imageTransport === 'remote-https') {
            if (record.remoteUrl && isValidRemoteHttpsUrl(record.remoteUrl)) {
              deliveryUrl = record.remoteUrl;
            } else {
              ready = false;
              inlineDiagnostics.push({
                code: 'snapshot/missing-representation',
                message: `Asset "${assetId}" lacks a valid remote HTTPS URL required by remote-https transport.`,
                severity: 'error',
                assetId,
              });
              if (record.dataUrl) {
                deliveryUrl = record.dataUrl;
              }
            }
          } else if (capabilities.imageTransport === 'platform-upload') {
            if (record.remoteUrl && isValidRemoteHttpsUrl(record.remoteUrl)) {
              deliveryUrl = record.remoteUrl;
            } else {
              ready = false;
              inlineDiagnostics.push({
                code: 'snapshot/missing-representation',
                message: `Asset "${assetId}" lacks an uploaded remote URL required by platform-upload transport.`,
                severity: 'error',
                assetId,
              });
              if (record.dataUrl) {
                deliveryUrl = record.dataUrl;
              }
            }
          } else {
            // inline-data default
            if (record.dataUrl) {
              deliveryUrl = record.dataUrl;
            } else if (record.remoteUrl && isValidRemoteHttpsUrl(record.remoteUrl)) {
              deliveryUrl = record.remoteUrl;
            }
          }

          if (!deliveryUrl && record.status === 'delivery-ready') {
            ready = false;
            inlineDiagnostics.push({
              code: 'snapshot/missing-representation',
              message: `Asset "${assetId}" has no deliverable URL representation.`,
              severity: 'error',
              assetId,
            });
          }

          if (deliveryUrl) {
            img.setAttribute('src', deliveryUrl);
            img.setAttribute('data-morph-snapshot-src', deliveryUrl);
          }

          if (targetId === 'cards' && record.width && record.width > 0 && record.height && record.height > 0) {
            if (!img.hasAttribute('width')) img.setAttribute('width', String(record.width));
            if (!img.hasAttribute('height')) img.setAttribute('height', String(record.height));
          }

          if (targetId === 'wechat' && record.width && record.width > 0) {
            if (record.height && record.height > 0) {
              img.setAttribute('data-ratio', String(Number((record.height / record.width).toFixed(6))));
            }
            if (record.width >= 374) {
              img.setAttribute('data-w', String(Math.max(record.width, 677)));
              if (capabilities.allowInlineStyles) {
                const allowed = capabilities.allowedStyleProps;
                if (!allowed || allowed.has('width')) img.style.setProperty('width', '100%');
                if (!allowed || allowed.has('height')) img.style.setProperty('height', 'auto');
                if (!allowed || allowed.has('display')) img.style.setProperty('display', 'block');
              }
            } else {
              img.setAttribute('data-w', String(record.width));
            }
          }
        } else if (targetId === 'wechat' && !img.hasAttribute('data-w')) {
          img.setAttribute('data-w', '677');
        }
      }

      const formulaNodes = Array.from(root.querySelectorAll('[data-morph-asset-id]:not(img)'));
      for (const node of formulaNodes) {
        const assetId = node.getAttribute('data-morph-asset-id');
        if (assetId) {
          referencedAssets.add(assetId);
          const record = assetStore.get(assetId);
          if (!record) {
            ready = false;
            inlineDiagnostics.push({
              code: 'asset/not-found',
              message: `Referenced formula asset "${assetId}" was not found in AssetStore.`,
              severity: 'error',
              assetId,
            });
            continue;
          }

          if (record.status !== 'delivery-ready') {
            ready = false;
            inlineDiagnostics.push({
              code: 'asset/not-delivery-ready',
              message: `Formula asset "${assetId}" is not delivery ready (current status: ${record.status}).`,
              severity: 'warning',
              assetId,
            });
          }

          let deliveryUrl: string | undefined;
          if (capabilities.imageTransport === 'remote-https') {
            if (record.remoteUrl && isValidRemoteHttpsUrl(record.remoteUrl)) {
              deliveryUrl = record.remoteUrl;
            } else {
              ready = false;
              inlineDiagnostics.push({
                code: 'snapshot/missing-representation',
                message: `Formula asset "${assetId}" lacks a valid remote HTTPS URL required by remote-https transport.`,
                severity: 'error',
                assetId,
              });
              if (record.dataUrl) deliveryUrl = record.dataUrl;
            }
          } else if (capabilities.imageTransport === 'platform-upload') {
            if (record.remoteUrl && isValidRemoteHttpsUrl(record.remoteUrl)) {
              deliveryUrl = record.remoteUrl;
            } else {
              ready = false;
              inlineDiagnostics.push({
                code: 'snapshot/missing-representation',
                message: `Formula asset "${assetId}" lacks an uploaded remote URL required by platform-upload transport.`,
                severity: 'error',
                assetId,
              });
              if (record.dataUrl) deliveryUrl = record.dataUrl;
            }
          } else {
            deliveryUrl = record.dataUrl || (record.remoteUrl && isValidRemoteHttpsUrl(record.remoteUrl) ? record.remoteUrl : undefined);
          }

          if (!deliveryUrl && record.status === 'delivery-ready') {
            ready = false;
            inlineDiagnostics.push({
              code: 'snapshot/missing-representation',
              message: `Formula asset "${assetId}" has no deliverable URL representation.`,
              severity: 'error',
              assetId,
            });
          }

          if (deliveryUrl) {
            const tex = node.getAttribute('data-math-tex') || '';
            const img = doc.createElement('img');
            img.setAttribute('src', deliveryUrl);
            img.setAttribute('alt', tex);
            if (tex) img.setAttribute('data-math-tex', tex);
            img.setAttribute('data-morph-snapshot-src', deliveryUrl);
            img.setAttribute('data-morph-asset-id', assetId);
            if (targetId === 'wechat') {
              if (record.width && record.width > 0) {
                img.setAttribute('data-w', String(record.width >= 374 ? Math.max(record.width, 677) : record.width));
                if (record.height && record.height > 0) {
                  img.setAttribute('data-ratio', String(Number((record.height / record.width).toFixed(6))));
                }
              } else {
                img.setAttribute('data-w', '677');
              }
            }
            node.replaceChildren(img);
          }
        }
      }

      if (targetId === 'wechat') {
        dedupeWeChatNesting(root, inlineDiagnostics);
      } else if (targetId === 'x-article') {
        normalizeXArticleStructureAndStyles(root, inlineDiagnostics, capabilities);
      } else if (targetId === 'cards') {
        paginateDom(root as HTMLElement, inlineDiagnostics, options.cardsOptions);
      }
    },
  });
  allDiagnostics.push(...styleResult.diagnostics);

  const finalHtml = styleResult.html;

  // 3. Lazily derive and freeze HAST from final HTML on first access
  let cachedDerivedHast: any = null;
  const frozenVersion = Object.freeze({ doc: version.doc, style: version.style, assets: version.assets });
  const frozenDiagnostics = Object.freeze(allDiagnostics.map((d) => deepFreeze({ ...d })));
  const frozenSourceMap = Object.freeze(astResult.sourceMap.map((entry) => Object.freeze({ ...entry })));

  const snapshot = {
    version: frozenVersion,
    targetId,
    ready,
    get hast() {
      if (!cachedDerivedHast) {
        const base64Table: string[] = [];
        const htmlForHast = finalHtml.includes('data:image/')
          ? finalHtml.replace(/data:image\/[^"'\s]{256,}/g, (match) => {
              const idx = base64Table.length;
              base64Table.push(match);
              return `__MORPH_B64_${idx}__`;
            })
          : finalHtml;
        const derived = fromHtml(htmlForHast, { fragment: true });
        if (base64Table.length > 0) {
          restoreBase64Placeholders(derived, base64Table);
        }
        cachedDerivedHast = deepFreeze(derived);
      }
      return cachedDerivedHast;
    },
    html: finalHtml,
    diagnostics: frozenDiagnostics,
    sourceMap: frozenSourceMap,
  } as DeliverySnapshot;

  Object.freeze(snapshot);
  snapshotReferencedAssetIds.set(snapshot, referencedAssets);
  return snapshot;
}
