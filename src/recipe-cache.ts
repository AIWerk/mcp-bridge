/**
 * RecipeCache — local file cache for downloaded catalog recipes.
 *
 * Default cache dir: ~/.mcp-bridge/recipes/
 * Each recipe is stored as recipes/<name>/recipe.json with metadata.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import type { CatalogRecipe } from "./catalog-client.js";

export interface CachedRecipe {
  recipe: CatalogRecipe;
  downloadedAt: string;
  catalogVersion?: string;
}

export class RecipeCache {
  private cacheDir: string;

  constructor(cacheDir?: string) {
    this.cacheDir = cacheDir ?? join(homedir(), ".mcp-bridge", "recipes");
  }

  private recipePath(name: string): string {
    return join(this.cacheDir, name, "recipe.json");
  }

  private ensureDir(name: string): void {
    const dir = join(this.cacheDir, name);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /** Get a cached recipe by name, or undefined if not cached. */
  get(name: string): CachedRecipe | undefined {
    const path = this.recipePath(name);
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, "utf-8")) as CachedRecipe;
    } catch {
      return undefined;
    }
  }

  /** Cache a recipe. */
  put(name: string, recipe: CatalogRecipe, catalogVersion?: string): void {
    this.ensureDir(name);
    const entry: CachedRecipe = {
      recipe,
      downloadedAt: new Date().toISOString(),
      catalogVersion,
    };
    writeFileSync(this.recipePath(name), JSON.stringify(entry, null, 2), "utf-8");
  }

  /** List all cached recipe names. */
  list(): string[] {
    if (!existsSync(this.cacheDir)) return [];
    return readdirSync(this.cacheDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(this.cacheDir, d.name, "recipe.json")))
      .map((d) => d.name);
  }

  /** Check if a recipe is cached. */
  has(name: string): boolean {
    return existsSync(this.recipePath(name));
  }

  /** Remove all cached recipes. */
  clear(): void {
    if (existsSync(this.cacheDir)) {
      rmSync(this.cacheDir, { recursive: true, force: true });
    }
  }
}
