import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { VerifyResult } from './verify-engine/types';

let cachedBundleSource: string | null = null;

/**
 * Bundles the vendored `wechatjs/verify-article-structure-spec` engine into a
 * self-contained browser IIFE string for injection into a real Chromium page.
 */
export async function getVerifyArticleBrowserBundle(): Promise<string> {
  if (cachedBundleSource) return cachedBundleSource;
  const esbuild = await import('esbuild');
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const entry = path.resolve(currentDir, 'verify-engine', 'index.ts');

  const result = esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: '__verifyArticleStructureModule__',
    platform: 'browser',
    target: 'es2017',
    legalComments: 'none',
  });

  cachedBundleSource = result.outputFiles[0].text;
  return cachedBundleSource;
}

export interface WeChatVerificationSession {
  verifyHtml(html: string): Promise<VerifyResult>;
  close(): Promise<void>;
}

/**
 * Launches a headless Chromium browser session pre-loaded with the official
 * `wechatjs/verify-article-structure-spec` engine (multi-screen 585px/677px/375px
 * layout measurement, Range API line-height overlap, mp-darkmode contrast/gradient
 * check, and 15-level nesting inspection).
 */
export async function createWeChatVerificationSession(): Promise<WeChatVerificationSession> {
  const { chromium } = await import('playwright');
  const bundleSource = await getVerifyArticleBrowserBundle();

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 677, height: 800 } });
  await page.goto('about:blank');
  await page.evaluate(
    `${bundleSource}\nwindow.verifyArticleStructure = __verifyArticleStructureModule__.verifyArticleStructure;`
  );

  return {
    async verifyHtml(html: string): Promise<VerifyResult> {
      return await page.evaluate(async (articleHtml: string) => {
        const container = document.createElement('div');
        container.innerHTML = articleHtml;
        return await (window as any).verifyArticleStructure(container, {});
      }, html);
    },
    async close(): Promise<void> {
      await browser.close();
    },
  };
}

/**
 * Single-shot helper to verify an HTML string against the official
 * `wechatjs/verify-article-structure-spec` engine in headless Chromium.
 */
export async function verifyWeChatArticleHtml(html: string): Promise<VerifyResult> {
  const session = await createWeChatVerificationSession();
  try {
    return await session.verifyHtml(html);
  } finally {
    await session.close();
  }
}
