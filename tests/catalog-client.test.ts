import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CatalogClient, recipeToConfig, getCatalogClient, resetCatalogClient } from "../src/catalog-client.ts";
import type { CatalogRecipe } from "../src/catalog-client.ts";
import { RecipeCache } from "../src/recipe-cache.ts";

// ── recipeToConfig tests ────────────────────────────────────────────────────

test("recipeToConfig: stdio with npm install", () => {
  const recipe: CatalogRecipe = {
    name: "test-server",
    description: "A test server",
    transports: [{ type: "stdio" }],
    install: { npm: { package: "@example/mcp-server", version: "1.2.3" } },
    auth: { type: "env", envVars: ["API_KEY", "SECRET"] },
  };

  const config = recipeToConfig(recipe);

  assert.equal(config.transport, "stdio");
  assert.equal(config.command, "npx");
  assert.deepEqual(config.args, ["-y", "@example/mcp-server@1.2.3"]);
  assert.equal(config.description, "A test server");
  assert.deepEqual(config.env, { API_KEY: "${API_KEY}", SECRET: "${SECRET}" });
});

test("recipeToConfig: stdio npm without version", () => {
  const recipe: CatalogRecipe = {
    name: "bare-pkg",
    transports: [{ type: "stdio" }],
    install: { npm: { package: "my-server" } },
  };

  const config = recipeToConfig(recipe);

  assert.equal(config.command, "npx");
  assert.deepEqual(config.args, ["-y", "my-server"]);
  assert.equal(config.env, undefined);
});

test("recipeToConfig: streamable-http with url", () => {
  const recipe: CatalogRecipe = {
    name: "remote-server",
    transports: [{ type: "streamable-http", url: "https://example.com/mcp" }],
  };

  const config = recipeToConfig(recipe);

  assert.equal(config.transport, "streamable-http");
  assert.equal(config.url, "https://example.com/mcp");
  assert.equal(config.command, undefined);
});

test("recipeToConfig: defaults to stdio when no transports", () => {
  const recipe: CatalogRecipe = { name: "bare" };

  const config = recipeToConfig(recipe);

  assert.equal(config.transport, "stdio");
});

// ── CatalogClient.download with mocked fetch ────────────────────────────────

test("CatalogClient.download parses JSON response", async () => {
  const recipe: CatalogRecipe = { name: "fetched-server", description: "Fetched" };
  let callCount = 0;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url: any, init: any): Promise<any> => {
    callCount++;
    const body = JSON.parse(init.body ?? "{}");

    if (body.method === "initialize") {
      return {
        ok: true,
        headers: new Headers({ "content-type": "application/json", "mcp-session-id": "test-session" }),
        json: async () => ({ jsonrpc: "2.0", id: body.id, result: { capabilities: {} } }),
      };
    }

    if (body.method === "notifications/initialized") {
      return { ok: true, headers: new Headers(), json: async () => ({}) };
    }

    if (body.method === "tools/call") {
      return {
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          jsonrpc: "2.0",
          id: body.id,
          result: { content: [{ type: "text", text: JSON.stringify(recipe) }] },
        }),
      };
    }

    return { ok: true, headers: new Headers(), json: async () => ({}) };
  };

  try {
    const client = new CatalogClient("https://mock-catalog/mcp");
    const result = await client.download("fetched-server");

    assert.equal(result.name, "fetched-server");
    assert.equal(result.description, "Fetched");
    assert.ok(callCount >= 2, "should have made at least 2 fetch calls (init + tool call)");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CatalogClient.download handles SSE response", async () => {
  const recipe: CatalogRecipe = { name: "sse-server" };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url: any, init: any): Promise<any> => {
    const body = JSON.parse(init.body ?? "{}");

    if (body.method === "initialize") {
      return {
        ok: true,
        headers: new Headers({ "content-type": "application/json", "mcp-session-id": "s1" }),
        json: async () => ({ jsonrpc: "2.0", id: body.id, result: { capabilities: {} } }),
      };
    }

    if (body.method === "notifications/initialized") {
      return { ok: true, headers: new Headers(), json: async () => ({}) };
    }

    if (body.method === "tools/call") {
      const rpcResponse = {
        jsonrpc: "2.0",
        id: body.id,
        result: { content: [{ type: "text", text: JSON.stringify(recipe) }] },
      };
      return {
        ok: true,
        headers: new Headers({ "content-type": "text/event-stream" }),
        text: async () => `event: message\ndata: ${JSON.stringify(rpcResponse)}\n\n`,
      };
    }

    return { ok: true, headers: new Headers(), json: async () => ({}) };
  };

  try {
    const client = new CatalogClient("https://mock-catalog/mcp");
    const result = await client.download("sse-server");
    assert.equal(result.name, "sse-server");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── Singleton helpers ───────────────────────────────────────────────────────

test("getCatalogClient returns singleton, resetCatalogClient clears it", () => {
  resetCatalogClient();
  const a = getCatalogClient();
  const b = getCatalogClient();
  assert.equal(a, b);

  resetCatalogClient();
  const c = getCatalogClient();
  assert.notEqual(a, c);
});

// ── RecipeCache tests ───────────────────────────────────────────────────────

test("RecipeCache: put and get", () => {
  const dir = mkdtempSync(join(tmpdir(), "recipe-cache-"));
  try {
    const cache = new RecipeCache(dir);
    const recipe: CatalogRecipe = { name: "test-server", description: "desc" };

    cache.put("test-server", recipe, "v1");
    const cached = cache.get("test-server");

    assert.ok(cached);
    assert.equal(cached.recipe.name, "test-server");
    assert.equal(cached.catalogVersion, "v1");
    assert.ok(cached.downloadedAt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RecipeCache: has returns false for missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "recipe-cache-"));
  try {
    const cache = new RecipeCache(dir);
    assert.equal(cache.has("nonexistent"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RecipeCache: list returns cached names", () => {
  const dir = mkdtempSync(join(tmpdir(), "recipe-cache-"));
  try {
    const cache = new RecipeCache(dir);
    cache.put("alpha", { name: "alpha" });
    cache.put("beta", { name: "beta" });

    const names = cache.list().sort();
    assert.deepEqual(names, ["alpha", "beta"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RecipeCache: clear removes all entries", () => {
  const dir = mkdtempSync(join(tmpdir(), "recipe-cache-"));
  try {
    const cache = new RecipeCache(dir);
    cache.put("x", { name: "x" });
    assert.ok(cache.has("x"));

    cache.clear();
    assert.equal(cache.has("x"), false);
    assert.deepEqual(cache.list(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RecipeCache: get returns undefined for missing cache dir", () => {
  const cache = new RecipeCache("/tmp/nonexistent-recipe-cache-" + Date.now());
  assert.equal(cache.get("foo"), undefined);
  assert.deepEqual(cache.list(), []);
});
