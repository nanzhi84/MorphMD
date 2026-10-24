import { xArticlePropertyRules } from './rules-text';
import type { XArticleVerifyOpts, XArticleVerifyResult } from './types';
import { verifyXArticleHtml } from './verifier';

export interface XArticleVerificationSession {
  verifyHtml(html: string, opts?: XArticleVerifyOpts): Promise<XArticleVerifyResult>;
  close(): Promise<void>;
}

/**
 * Launches a headless Chromium browser session to verify X-Article HTML structure,
 * Draft.js ContentState invariants, and real Chromium image decoding (`img.decode()`).
 */
export async function createXArticleVerificationSession(): Promise<XArticleVerificationSession> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 680, height: 900 } });
  await page.goto('about:blank');

  return {
    async verifyHtml(html: string, opts: XArticleVerifyOpts = {}): Promise<XArticleVerifyResult> {
      const result = verifyXArticleHtml(html, opts);

      // Verify all Data URL IMAGE entities actually decode in real Chromium
      const imageEntities = Object.entries(result.draftState.entityMap).filter(
        ([, ent]) => ent.type === 'IMAGE'
      );

      for (const [keyStr, ent] of imageEntities) {
        const src = String(ent.data.src || '');
        if (!/^data:/i.test(src)) continue;
        const entityKey = Number(keyStr);
        const requireContentPixels = Boolean(ent.data.rasterized);

        const decoded = await page.evaluate(
          async ({
            dataUrl,
            checkContentPixels,
          }: {
            dataUrl: string;
            checkContentPixels: boolean;
          }) => {
            const img = new Image();
            img.src = dataUrl;
            try {
              await img.decode();
              const w = img.naturalWidth;
              const h = img.naturalHeight;
              if (w <= 0 || h <= 0) {
                return { ok: false, width: w, height: h, reason: '图像解码宽高为 0' };
              }
              if (checkContentPixels) {
                if (w <= 1 && h <= 1) {
                  return {
                    ok: false,
                    width: w,
                    height: h,
                    reason: '光栅化图像尺寸为 1x1 占位像素',
                  };
                }
                const canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext('2d');
                if (ctx) {
                  ctx.drawImage(img, 0, 0);
                  const imgData = ctx.getImageData(0, 0, w, h).data;
                  const distinctColors = new Set<number>();
                  const yStart = w > 24 && h > 8 ? 1 : 0;
                  const yEnd = w > 24 && h > 8 ? h - 1 : h;
                  const xStart = w > 24 && h > 8 ? 24 : 0;
                  const xEnd = w > 24 && h > 8 ? w - 1 : w;
                  for (let y = yStart; y < yEnd; y++) {
                    for (let x = xStart; x < xEnd; x++) {
                      const idx = (y * w + x) * 4;
                      const color =
                        ((imgData[idx] << 24) |
                          (imgData[idx + 1] << 16) |
                          (imgData[idx + 2] << 8) |
                          imgData[idx + 3]) >>>
                        0;
                      distinctColors.add(color);
                      if (distinctColors.size >= 2) break;
                    }
                    if (distinctColors.size >= 2) break;
                  }
                  if (distinctColors.size < 2) {
                    return {
                      ok: false,
                      width: w,
                      height: h,
                      reason: '光栅化图像内容区域仅含单一纯色像素',
                    };
                  }
                }
              }
              return {
                ok: true,
                width: w,
                height: h,
              };
            } catch {
              return { ok: false, width: 0, height: 0, reason: 'img.decode() 解码异常' };
            }
          },
          { dataUrl: src, checkContentPixels: requireContentPixels }
        );

        if (!decoded.ok) {
          const ruleDesc = xArticlePropertyRules['unsafe-media-or-link'];
          if (!result.inValidInfo['unsafe-media-or-link']) {
            result.inValidInfo['unsafe-media-or-link'] = {
              violateRules: ruleDesc,
              items: [],
            };
          }
          const foundBlockIdx = result.draftState.blocks.findIndex((b) =>
            b.entityRanges.some((er) => er.key === entityKey)
          );
          result.inValidInfo['unsafe-media-or-link'].items.push({
            blockIndex: foundBlockIdx >= 0 ? foundBlockIdx : 0,
            outerHTML: `<img src="${src.slice(0, 64)}..." alt="${String(ent.data.alt || '')}">`,
            tagName: 'img',
            rules: `Chromium 真实浏览器 img.decode() 解码失败（${decoded.reason || '未知原因'}）：${ruleDesc}`,
          });
          result.isValid = false;
        }
      }

      return result;
    },
    async close(): Promise<void> {
      await browser.close();
    },
  };
}

/**
 * Single-shot helper to verify X-Article HTML in headless Chromium.
 */
export async function verifyXArticleHtmlInBrowser(
  html: string,
  opts: XArticleVerifyOpts = {}
): Promise<XArticleVerifyResult> {
  const session = await createXArticleVerificationSession();
  try {
    return await session.verifyHtml(html, opts);
  } finally {
    await session.close();
  }
}
