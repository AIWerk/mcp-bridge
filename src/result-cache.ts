export interface ResultCacheConfig {
  maxEntries?: number;
  defaultTtlMs?: number;
  cacheTtl?: Record<string, number>;
}

export interface ResultCacheStats {
  hits: number;
  misses: number;
  evictions: number;
  size: number;
}

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_TTL_MS = 300_000;

function normalizeForStableJson(value: unknown, inArray: boolean): unknown {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return inArray ? null : undefined;
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeForStableJson(item, true));
  }

  const obj = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  const keys = Object.keys(obj).sort();

  for (const key of keys) {
    const normalizedValue = normalizeForStableJson(obj[key], false);
    if (normalizedValue !== undefined) {
      normalized[key] = normalizedValue;
    }
  }

  return normalized;
}

export function stableStringify(value: unknown): string {
  const normalized = normalizeForStableJson(value, false);
  const serialized = JSON.stringify(normalized);
  return serialized === undefined ? "undefined" : serialized;
}

export function createResultCacheKey(server: string, tool: string, params: unknown): string {
  return `${server}:${tool}:${stableStringify(params)}`;
}

export class ResultCache {
  private readonly maxEntries: number;
  private readonly defaultTtlMs: number;
  private readonly cacheTtl: Record<string, number>;
  private readonly entries = new Map<string, CacheEntry>();

  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(config: ResultCacheConfig = {}) {
    this.maxEntries = config.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.defaultTtlMs = config.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.cacheTtl = config.cacheTtl ?? {};
  }

  get(key: string): unknown {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }

    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      this.misses += 1;
      return undefined;
    }

    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits += 1;
    return entry.value;
  }

  set(key: string, value: unknown, ttlMs?: number): void {
    const effectiveTtlMs = ttlMs ?? this.resolveTtlMsForKey(key);
    const entry: CacheEntry = {
      value,
      expiresAt: Date.now() + effectiveTtlMs
    };

    if (this.entries.has(key)) {
      this.entries.delete(key);
    }

    this.entries.set(key, entry);
    this.trimToCapacity();
  }

  invalidate(pattern?: string | RegExp): number {
    if (!pattern) {
      const size = this.entries.size;
      this.entries.clear();
      return size;
    }

    let removed = 0;
    for (const key of this.entries.keys()) {
      const matches = typeof pattern === "string"
        ? key.includes(pattern)
        : pattern.test(key);

      if (matches) {
        this.entries.delete(key);
        removed += 1;
      }
    }

    return removed;
  }

  stats(): ResultCacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      size: this.entries.size
    };
  }

  private resolveTtlMsForKey(key: string): number {
    const firstColon = key.indexOf(":");
    const secondColon = key.indexOf(":", firstColon + 1);

    if (firstColon === -1 || secondColon === -1) {
      return this.defaultTtlMs;
    }

    const server = key.slice(0, firstColon);
    const tool = key.slice(firstColon + 1, secondColon);
    const override = this.cacheTtl[`${server}:${tool}`];

    return override ?? this.defaultTtlMs;
  }

  private trimToCapacity(): void {
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.entries.delete(oldestKey);
      this.evictions += 1;
    }
  }
}
