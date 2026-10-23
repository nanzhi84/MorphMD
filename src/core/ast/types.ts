import type { Root } from 'hast';
import type { DiagnosticItem, SourceRangeEntry } from '../snapshot/types';
import type { HeavyBlockCache } from './cache';

export interface CompileOptions {
  themeKey?: string;
  targetCapabilityVersion?: string;
  cache?: HeavyBlockCache;
}

export interface CompileResult {
  hast: Root;
  html: string;
  diagnostics: DiagnosticItem[];
  sourceMap: SourceRangeEntry[];
}
