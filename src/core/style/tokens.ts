/**
 * Shared Design Tokens for MorphMD
 * Cross-view unified visual tokens.
 */

import type { DiagnosticItem } from '../snapshot/types';

export const MORPH_TOKEN_KEYS = [
  '--morph-bg',
  '--morph-ink',
  '--morph-accent',
  '--morph-font-serif',
  '--morph-font-sans',
  '--morph-font-mono',
  '--morph-body-size',
  '--morph-line-height',
  '--morph-block-gap',
] as const;

export type MorphTokenKey = (typeof MORPH_TOKEN_KEYS)[number];

export interface DesignTokens {
  '--morph-bg': string;
  '--morph-ink': string;
  '--morph-accent': string;
  '--morph-font-serif': string;
  '--morph-font-sans': string;
  '--morph-font-mono': string;
  '--morph-body-size': string;
  '--morph-line-height': string;
  '--morph-block-gap': string;
  [customKey: `--${string}`]: string;
}

export const DEFAULT_DESIGN_TOKENS: DesignTokens = {
  '--morph-bg': '#ffffff',
  '--morph-ink': '#24292e',
  '--morph-accent': '#0969da',
  '--morph-font-serif': '"Source Serif 4", Georgia, Cambria, serif',
  '--morph-font-sans': '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  '--morph-font-mono': 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
  '--morph-body-size': '16px',
  '--morph-line-height': '1.75',
  '--morph-block-gap': '1.25rem',
};

export function serializeTokensToCss(
  tokens: Partial<DesignTokens> = {},
  diagnostics?: DiagnosticItem[]
): string {
  const merged = { ...DEFAULT_DESIGN_TOKENS, ...tokens };
  const lines: string[] = [];
  for (const [key, val] of Object.entries(merged)) {
    if (!/^--[a-zA-Z0-9_-]+$/.test(key)) {
      if (diagnostics) {
        diagnostics.push({
          code: 'style/invalid-token-key',
          message: `Invalid token key "${key}". Must match /^--[a-zA-Z0-9_-]+$/.`,
          severity: 'error',
          property: key,
        });
      }
      continue;
    }
    if (typeof val !== 'string') continue;
    if (/[{};]/.test(val) || /url\s*\(\s*javascript:/i.test(val) || /expression\s*\(/i.test(val)) {
      if (diagnostics) {
        diagnostics.push({
          code: 'style/invalid-token-value',
          message: `Invalid or dangerous token value for "${key}".`,
          severity: 'error',
          property: key,
        });
      }
      continue;
    }
    lines.push(`  ${key}: ${val};`);
  }
  return `:root {\n${lines.join('\n')}\n}\n`;
}
