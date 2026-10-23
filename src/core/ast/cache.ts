/**
 * Heavy Block Layered Memoization Cache
 * Caches computationally expensive nodes (Shiki syntax highlighting, KaTeX formulas, SVG rasterization).
 */

export type HeavyBlockKind = 'code' | 'math' | 'svg';

export interface HeavyBlockCacheKey {
  kind: HeavyBlockKind;
  contentHash: string;
  languageOrDisplayMode: string;
  themeKey: string;
  targetCapabilityVersion: string;
}

export interface HeavyBlockCacheEntry<T = unknown> {
  key: HeavyBlockCacheKey;
  value: T;
  createdAt: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
}

/**
 * Deterministic hash for string contents across Node and Browser environments.
 */
export function hashString(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hashHex = (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(16, '0');
  return `${input.length.toString(16)}-${hashHex}`;
}

export class HeavyBlockCache {
  private cache = new Map<string, HeavyBlockCacheEntry<unknown>>();
  private hits = 0;
  private misses = 0;
  private maxEntries: number;

  constructor(maxEntries = 500) {
    this.maxEntries = maxEntries;
  }

  private makeKey(
    kind: HeavyBlockKind,
    contentHash: string,
    languageOrDisplayMode: string,
    themeKey: string,
    targetCapabilityVersion: string
  ): string {
    return `${kind}:${contentHash}:${languageOrDisplayMode}:${themeKey}:${targetCapabilityVersion}`;
  }

  public get<T>(
    kind: HeavyBlockKind,
    contentHash: string,
    languageOrDisplayMode: string,
    themeKey: string,
    targetCapabilityVersion: string
  ): T | undefined {
    const key = this.makeKey(kind, contentHash, languageOrDisplayMode, themeKey, targetCapabilityVersion);
    const entry = this.cache.get(key);
    if (entry) {
      // Refresh order for LRU
      this.cache.delete(key);
      this.cache.set(key, entry);
      this.hits++;
      return entry.value as T;
    }
    this.misses++;
    return undefined;
  }

  public set<T>(
    kind: HeavyBlockKind,
    contentHash: string,
    languageOrDisplayMode: string,
    themeKey: string,
    targetCapabilityVersion: string,
    value: T
  ): void {
    const key = this.makeKey(kind, contentHash, languageOrDisplayMode, themeKey, targetCapabilityVersion);
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(key, {
      key: { kind, contentHash, languageOrDisplayMode, themeKey, targetCapabilityVersion },
      value,
      createdAt: Date.now(),
    });
  }

  public has(
    kind: HeavyBlockKind,
    contentHash: string,
    languageOrDisplayMode: string,
    themeKey: string,
    targetCapabilityVersion: string
  ): boolean {
    const key = this.makeKey(kind, contentHash, languageOrDisplayMode, themeKey, targetCapabilityVersion);
    return this.cache.has(key);
  }

  public invalidateByTheme(themeKey: string): void {
    for (const [key, entry] of this.cache.entries()) {
      if (entry.key.themeKey === themeKey) {
        this.cache.delete(key);
      }
    }
  }

  public invalidateByCapability(targetCapabilityVersion: string): void {
    for (const [key, entry] of this.cache.entries()) {
      if (entry.key.targetCapabilityVersion === targetCapabilityVersion) {
        this.cache.delete(key);
      }
    }
  }

  public clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  public getStats(): CacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.cache.size,
    };
  }
}

export const globalHeavyBlockCache = new HeavyBlockCache();
