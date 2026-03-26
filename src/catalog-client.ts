/**
 * CatalogClient — REST client for the AIWerk MCP Catalog API.
 *
 * Default endpoint: https://catalog.aiwerk.ch
 * Supports local file caching with offline fallback.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import type { Logger } from "./types.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface CatalogSearchResult {
  name: string;
  description?: string;
  category?: string;
  quality?: number;
  [key: string]: unknown;
}

export interface CatalogRecipe {
  name: string;
  description?: string;
  transport?: "stdio" | "sse" | "streamable-http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  transports?: Array<{
    type: "stdio" | "sse" | "streamable-http";
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
  }>;
  install?: {
    npm?: { package: string; version?: string };
    docker?: { image: string };
  };
  auth?: {
    type: string;
    required?: boolean;
    envVars?: string[];
  };
  [key: string]: unknown;
}

// ── Error ────────────────────────────────────────────────────────────────────

export class CatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogError";
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const TIMEOUT_MS = 5_000;

const noop: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// ── CatalogClient ────────────────────────────────────────────────────────────

/**
 * CatalogClient — REST client for the AIWerk MCP Catalog API.
 *
 * NOTE: File I/O operations (readCache, writeCache, etc.) are intentionally
 * synchronous. This is acceptable for CLI tools and bridge startup, but
 * should be converted to async if used in hot paths (e.g., per-request).
 */
export class CatalogClient {
  private baseUrl: string;
  private cacheDir: string;
  private logger: Logger;
  private staleMs: number;

  constructor(opts?: { baseUrl?: string; cacheDir?: string; logger?: Logger; staleDays?: number }) {
    this.baseUrl = (opts?.baseUrl ?? "https://catalog.aiwerk.ch").replace(/\/+$/, "");
    this.cacheDir = opts?.cacheDir ?? join(homedir(), ".mcp-bridge", "recipes");
    this.logger = opts?.logger ?? noop;
    this.staleMs = (opts?.staleDays ?? 7) * 24 * 60 * 60 * 1000;
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private async fetchJson<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (res.status === 404) {
        const name = path.split("/").filter(Boolean).pop() ?? path;
        throw new CatalogError(`Recipe not found: ${name}`);
      }
      if (!res.ok) {
        throw new CatalogError(`Catalog HTTP ${res.status}: ${await res.text().catch(() => "")}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private cachePath(name: string): string {
    return join(this.cacheDir, name, "recipe.json");
  }

  private readCache(name: string): CatalogRecipe | null {
    const p = this.cachePath(name);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, "utf-8")) as CatalogRecipe;
    } catch {
      return null;
    }
  }

  private writeCache(name: string, data: CatalogRecipe): void {
    const dir = join(this.cacheDir, name);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.cachePath(name), JSON.stringify(data, null, 2), "utf-8");
  }

  private isCacheStale(name: string): boolean {
    const p = this.cachePath(name);
    if (!existsSync(p)) return true;
    try {
      const stat = statSync(p);
      return Date.now() - stat.mtimeMs > this.staleMs;
    } catch {
      return true;
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /** Search for recipes by keyword. */
  async search(query: string): Promise<CatalogSearchResult[]> {
    const encoded = encodeURIComponent(query);
    return this.fetchJson<CatalogSearchResult[]>(`/api/search?q=${encoded}`);
  }

  /** List recipes with optional filtering. */
  async list(opts?: {
    limit?: number;
    category?: string;
    sort?: string;
    hostedSafe?: boolean;
  }): Promise<{ results: CatalogSearchResult[]; total: number }> {
    const params = new URLSearchParams();
    if (opts?.limit != null) params.set("limit", String(opts.limit));
    if (opts?.category) params.set("category", opts.category);
    if (opts?.sort) params.set("sort", opts.sort);
    if (opts?.hostedSafe) params.set("hostedSafe", "true");
    const qs = params.toString();
    return this.fetchJson(`/api/recipes${qs ? `?${qs}` : ""}`);
  }

  /** Download a recipe from the catalog and cache it locally. */
  async download(name: string): Promise<CatalogRecipe> {
    const recipe = await this.fetchJson<CatalogRecipe>(`/api/recipes/${encodeURIComponent(name)}/download`);
    this.writeCache(name, recipe);
    return recipe;
  }

  /**
   * Resolve a recipe — returns cached if available, otherwise fetches from catalog.
   * Falls back to cache when the catalog is unreachable (offline mode).
   */
  async resolve(name: string): Promise<CatalogRecipe> {
    const cached = this.readCache(name);
    if (cached && !this.isCacheStale(name)) return cached;
    try {
      const recipe = await this.fetchJson<CatalogRecipe>(`/api/recipes/${encodeURIComponent(name)}/download`);
      this.writeCache(name, recipe);
      return recipe;
    } catch (err) {
      if (err instanceof CatalogError && err.message.startsWith("Recipe not found:")) {
        throw err;
      }
      if (cached) {
        this.logger.warn(`Catalog unreachable for "${name}", using cached version`);
        return cached;
      }
      throw new CatalogError(`Cannot resolve recipe "${name}": catalog unreachable and no local cache`);
    }
  }

  /**
   * Bootstrap by downloading the top N most popular recipes.
   * Skips already-cached recipes unless they are stale.
   */
  async bootstrap(limit = 15, hostedSafe = false): Promise<string[]> {
    const { results } = await this.list({ limit, sort: "popular", hostedSafe });
    const names: string[] = [];
    const toDownload: string[] = [];

    for (const entry of results) {
      const name = entry.name;
      if (!this.isCacheStale(name)) {
        names.push(name);
        continue;
      }

      toDownload.push(name);
    }

    const BATCH_SIZE = 5;
    for (let i = 0; i < toDownload.length; i += BATCH_SIZE) {
      const batch = toDownload.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (name) => {
          await this.download(name);
          return name;
        }),
      );
      for (const r of results) {
        if (r.status === "fulfilled") {
          names.push(r.value);
        } else {
          this.logger.warn(`Failed to download recipe: ${r.reason}`);
        }
      }
    }

    return names;
  }

  /** Synchronously read a recipe from local cache. Returns null if not cached. */
  getCached(name: string): CatalogRecipe | null {
    return this.readCache(name);
  }

  /** List all recipe names in the local cache. */
  listCached(): string[] {
    if (!existsSync(this.cacheDir)) return [];
    return readdirSync(this.cacheDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(this.cacheDir, d.name, "recipe.json")))
      .map((d) => d.name);
  }
}
