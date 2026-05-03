/**
 * CatalogClient — REST client for the AIWerk MCP catalog at bridge.aiwerk.ch.
 *
 * Restored 2026-05-03 after maintenance mode ended. Endpoint moved from the
 * historical catalog.aiwerk.ch to bridge.aiwerk.ch/api/recipes/<name>/download.
 * Every fetched recipe is Ed25519-verified against the bundled AIWerk public
 * key before it is cached or returned. Unsigned or tampered recipes are
 * refused.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createPublicKey, verify } from "node:crypto";

import type { Logger } from "./types.js";

// ── Public key (Ed25519, AIWerk catalog signer) ──────────────────────────────
//
// The hosted bridge signs every recipe with the matching private key kept in
// pass under aiwerk/mcp-catalog-private-key. The public key is baked into
// the standalone bundle so a fresh install does not need to fetch it.
const AIWERK_CATALOG_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAkHESasC8Mbf2+pGe+bhKRQkgOBSPcqGj0ZWGop4TS6k=
-----END PUBLIC KEY-----
`;

const SIGNED_FIELDS = [
  "id",
  "name",
  "description",
  "transports",
  "auth",
  "install",
  "metadata",
  "skill",
  "localOnly",
] as const;

// ── Types ────────────────────────────────────────────────────────────────────

export interface CatalogSearchResult {
  name: string;
  description?: string;
  category?: string;
  quality?: number;
  [key: string]: unknown;
}

export interface RecipeSignature {
  algorithm: string;
  publisherId: string;
  value: string;
  signedFields: string[];
  signedAt: string;
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
    method?: string;
    package?: string;
    version?: string;
    npm?: { package: string; version?: string };
    docker?: { image: string };
  };
  auth?: {
    type: string;
    required?: boolean;
    envVars?: string[];
    credentialsUrl?: string;
  };
  signature?: RecipeSignature;
  localOnly?: boolean;
  [key: string]: unknown;
}

// ── Errors ───────────────────────────────────────────────────────────────────

export class CatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogError";
  }
}

export class CatalogSignatureError extends CatalogError {
  constructor(message: string) {
    super(message);
    this.name = "CatalogSignatureError";
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const TIMEOUT_MS = 5_000;
const DEFAULT_BASE_URL = "https://bridge.aiwerk.ch";

const noop: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map((v) => stableStringify(v)).join(",") + "]";
  }
  const sorted = Object.keys(value as Record<string, unknown>).sort();
  const entries = sorted.map(
    (k) => JSON.stringify(k) + ":" + stableStringify((value as Record<string, unknown>)[k]),
  );
  return "{" + entries.join(",") + "}";
}

function canonicalSignedPayload(recipe: CatalogRecipe): string {
  const subset: Record<string, unknown> = {};
  for (const field of SIGNED_FIELDS) {
    if (field in recipe) {
      subset[field] = (recipe as Record<string, unknown>)[field];
    }
  }
  return stableStringify(subset);
}

/**
 * Verify the Ed25519 signature on a recipe against the bundled AIWerk public
 * key. Throws CatalogSignatureError on any failure (missing signature, wrong
 * algorithm, tampered payload, key mismatch).
 */
export function verifyRecipeSignature(recipe: CatalogRecipe): void {
  const sig = recipe.signature;
  if (!sig) {
    throw new CatalogSignatureError("recipe has no signature");
  }
  if (sig.algorithm !== "ed25519") {
    throw new CatalogSignatureError(`unsupported signature algorithm: ${sig.algorithm}`);
  }
  if (typeof sig.value !== "string" || sig.value.length === 0) {
    throw new CatalogSignatureError("recipe signature value is empty");
  }
  const publicKey = createPublicKey(AIWERK_CATALOG_PUBLIC_KEY_PEM);
  const payload = Buffer.from(canonicalSignedPayload(recipe), "utf-8");
  const signatureBytes = Buffer.from(sig.value, "base64");
  const ok = verify(null, payload, publicKey, signatureBytes);
  if (!ok) {
    throw new CatalogSignatureError("recipe signature does not match");
  }
}

// ── CatalogClient ────────────────────────────────────────────────────────────

export interface CatalogClientOptions {
  baseUrl?: string;
  cacheDir?: string;
  logger?: Logger;
  staleDays?: number;
  /** Skip signature verification (testing only). */
  skipSignatureVerify?: boolean;
}

/**
 * REST client for the AIWerk MCP catalog. File I/O is intentionally
 * synchronous — fine for CLI tools and bridge startup. Signature verification
 * runs on every fetch (including cache reads) so a tampered cache cannot
 * silently slip through.
 */
export class CatalogClient {
  private baseUrl: string;
  private cacheDir: string;
  private logger: Logger;
  private staleMs: number;
  private skipSignatureVerify: boolean;

  constructor(opts?: CatalogClientOptions) {
    this.baseUrl = (opts?.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.cacheDir = opts?.cacheDir ?? join(homedir(), ".mcp-bridge", "recipes");
    this.logger = opts?.logger ?? noop;
    this.staleMs = (opts?.staleDays ?? 7) * 24 * 60 * 60 * 1000;
    this.skipSignatureVerify = opts?.skipSignatureVerify ?? false;
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
        throw new CatalogError(
          `Catalog HTTP ${res.status}: ${await res.text().catch(() => "")}`,
        );
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

  private verifyOrThrow(recipe: CatalogRecipe, name: string): void {
    if (this.skipSignatureVerify) return;
    try {
      verifyRecipeSignature(recipe);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new CatalogSignatureError(
        `Recipe "${name}" failed signature verification: ${reason}`,
      );
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /** Search for recipes by keyword. */
  async search(query: string): Promise<CatalogSearchResult[]> {
    const encoded = encodeURIComponent(query);
    const result = await this.fetchJson<{ results?: CatalogSearchResult[] } | CatalogSearchResult[]>(
      `/api/search?q=${encoded}`,
    );
    return Array.isArray(result) ? result : (result.results ?? []);
  }

  /** List recipes with optional filtering. */
  async list(opts?: {
    limit?: number;
    category?: string;
    sort?: string;
  }): Promise<{ results: CatalogSearchResult[]; total: number }> {
    const params = new URLSearchParams();
    if (opts?.limit != null) params.set("limit", String(opts.limit));
    if (opts?.category) params.set("category", opts.category);
    if (opts?.sort) params.set("sort", opts.sort);
    const qs = params.toString();
    return this.fetchJson(`/api/recipes${qs ? `?${qs}` : ""}`);
  }

  /**
   * Download a recipe from the catalog, verify its signature, and cache it
   * locally. Throws CatalogSignatureError if the recipe is unsigned or
   * tampered — nothing is written to the cache in that case.
   */
  async download(name: string): Promise<CatalogRecipe> {
    const recipe = await this.fetchJson<CatalogRecipe>(
      `/api/recipes/${encodeURIComponent(name)}/download`,
    );
    this.verifyOrThrow(recipe, name);
    this.writeCache(name, recipe);
    return recipe;
  }

  /**
   * Resolve a recipe by name. Returns the cached copy if fresh; otherwise
   * fetches from the catalog. Falls back to a stale cache if the network is
   * unreachable. Signature is verified on both fresh and cached paths so a
   * tampered cache cannot slip through.
   */
  async resolve(name: string): Promise<CatalogRecipe> {
    const cached = this.readCache(name);
    if (cached && !this.isCacheStale(name)) {
      this.verifyOrThrow(cached, name);
      return cached;
    }
    try {
      const recipe = await this.fetchJson<CatalogRecipe>(
        `/api/recipes/${encodeURIComponent(name)}/download`,
      );
      this.verifyOrThrow(recipe, name);
      this.writeCache(name, recipe);
      return recipe;
    } catch (err) {
      if (err instanceof CatalogSignatureError) throw err;
      if (err instanceof CatalogError && err.message.startsWith("Recipe not found:")) {
        throw err;
      }
      if (cached) {
        // Stale cache fallback: still verify the signature so an offline user
        // does not run a tampered local copy.
        this.verifyOrThrow(cached, name);
        this.logger.warn(`Catalog unreachable for "${name}", using cached version`);
        return cached;
      }
      throw new CatalogError(
        `Cannot resolve recipe "${name}": catalog unreachable and no local cache`,
      );
    }
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
