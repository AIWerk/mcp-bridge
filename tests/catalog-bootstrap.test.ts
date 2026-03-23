import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { bootstrapCatalog, mergeRecipesIntoConfig } from "../src/config.ts";
import type { BridgeConfig } from "../src/types.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "catalog-bootstrap-test-"));
}

function mockFetch(handler: (url: string, init?: any) => Promise<any>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = handler as any;
  return () => {
    globalThis.fetch = original;
  };
}

function seedCache(cacheDir: string, name: string, recipe: any): void {
  const dir = join(cacheDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "recipe.json"), JSON.stringify(recipe, null, 2), "utf-8");
}

function emptyConfig(): BridgeConfig {
  return { servers: {} };
}

// ── bootstrapCatalog ─────────────────────────────────────────────────────────

test("bootstrapCatalog: downloads recipes with mocked fetch", async () => {
  const cacheDir = makeTmpDir();
  const restore = mockFetch(async (url) => {
    if (url.includes("/api/recipes?")) {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          results: [
            { name: "alpha", description: "A" },
            { name: "beta", description: "B" },
          ],
          total: 2,
        }),
      };
    }
    if (url.includes("/download")) {
      const name = url.split("/api/recipes/")[1].split("/download")[0];
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ name, transport: "stdio", command: "npx", args: ["-y", name] }),
      };
    }
    return { ok: false, status: 404, headers: new Headers(), text: async () => "not found" };
  });

  try {
    const names = await bootstrapCatalog({ cacheDir, limit: 2 });
    assert.deepEqual(names.sort(), ["alpha", "beta"]);
  } finally {
    restore();
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("bootstrapCatalog: skips bootstrap when cache already populated", async () => {
  const cacheDir = makeTmpDir();
  seedCache(cacheDir, "existing", { name: "existing" });

  let fetchCalled = false;
  const restore = mockFetch(async () => {
    fetchCalled = true;
    return { ok: false, status: 500, headers: new Headers(), text: async () => "" };
  });

  try {
    const names = await bootstrapCatalog({ cacheDir });
    assert.deepEqual(names, ["existing"]);
    assert.equal(fetchCalled, false, "should not call fetch when cache is populated");
  } finally {
    restore();
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("bootstrapCatalog: returns empty array when catalog unreachable", async () => {
  const cacheDir = makeTmpDir();
  const restore = mockFetch(async () => {
    throw new Error("ECONNREFUSED");
  });

  try {
    const names = await bootstrapCatalog({ cacheDir, force: true });
    assert.deepEqual(names, []);
  } finally {
    restore();
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

// ── mergeRecipesIntoConfig ───────────────────────────────────────────────────

test("mergeRecipesIntoConfig: adds cached v1 stdio recipes to empty config", () => {
  const cacheDir = makeTmpDir();
  seedCache(cacheDir, "my-tool", {
    name: "my-tool",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@scope/my-tool"],
    env: { PORT: "3000" },
  });

  try {
    const config = emptyConfig();
    const merged = mergeRecipesIntoConfig(config, { cacheDir });
    assert.ok(merged.servers["my-tool"]);
    assert.equal(merged.servers["my-tool"].transport, "stdio");
    assert.equal(merged.servers["my-tool"].command, "npx");
    assert.deepEqual(merged.servers["my-tool"].args, ["-y", "@scope/my-tool"]);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("mergeRecipesIntoConfig: adds cached v1 sse recipes to config", () => {
  const cacheDir = makeTmpDir();
  seedCache(cacheDir, "sse-tool", {
    name: "sse-tool",
    transport: "sse",
    url: "https://example.com/sse",
    headers: { "x-api-key": "test" },
  });

  try {
    const merged = mergeRecipesIntoConfig(emptyConfig(), { cacheDir });
    assert.ok(merged.servers["sse-tool"]);
    assert.equal(merged.servers["sse-tool"].transport, "sse");
    assert.equal(merged.servers["sse-tool"].url, "https://example.com/sse");
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("mergeRecipesIntoConfig: handles v2 recipes with transports array", () => {
  const cacheDir = makeTmpDir();
  seedCache(cacheDir, "v2-tool", {
    name: "v2-tool",
    transports: [
      { type: "stdio", command: "node", args: ["server.js"], env: { MODE: "prod" } },
      { type: "sse", url: "https://fallback.test/sse" },
    ],
  });

  try {
    const merged = mergeRecipesIntoConfig(emptyConfig(), { cacheDir });
    assert.ok(merged.servers["v2-tool"]);
    assert.equal(merged.servers["v2-tool"].transport, "stdio");
    assert.equal(merged.servers["v2-tool"].command, "node");
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("mergeRecipesIntoConfig: skips recipes with missing env vars", () => {
  const cacheDir = makeTmpDir();
  seedCache(cacheDir, "needs-creds", {
    name: "needs-creds",
    transport: "stdio",
    command: "npx",
    args: ["-y", "needs-creds"],
    env: { TOKEN: "${SUPER_SECRET_TOKEN_12345}" },
    auth: { type: "api_key", envVars: ["SUPER_SECRET_TOKEN_12345"] },
  });

  // Ensure the env var is NOT set
  const saved = process.env.SUPER_SECRET_TOKEN_12345;
  delete process.env.SUPER_SECRET_TOKEN_12345;

  try {
    const merged = mergeRecipesIntoConfig(emptyConfig(), { cacheDir });
    assert.equal(merged.servers["needs-creds"], undefined, "should skip recipe with missing env");
  } finally {
    if (saved !== undefined) process.env.SUPER_SECRET_TOKEN_12345 = saved;
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("mergeRecipesIntoConfig: adds recipe when env vars are present", () => {
  const cacheDir = makeTmpDir();
  const envVarName = `TEST_CATALOG_KEY_${Date.now()}`;
  seedCache(cacheDir, "has-creds", {
    name: "has-creds",
    transport: "stdio",
    command: "npx",
    args: ["-y", "has-creds"],
    env: { API_KEY: `\${${envVarName}}` },
    auth: { type: "api_key", envVars: [envVarName] },
  });

  process.env[envVarName] = "secret-value";

  try {
    const merged = mergeRecipesIntoConfig(emptyConfig(), { cacheDir });
    assert.ok(merged.servers["has-creds"], "should add recipe when env vars present");
  } finally {
    delete process.env[envVarName];
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("mergeRecipesIntoConfig: does not overwrite existing config entries", () => {
  const cacheDir = makeTmpDir();
  seedCache(cacheDir, "my-server", {
    name: "my-server",
    transport: "stdio",
    command: "npx",
    args: ["-y", "catalog-version"],
  });

  const config: BridgeConfig = {
    servers: {
      "my-server": {
        transport: "stdio",
        command: "/usr/local/bin/my-server",
        args: ["--custom"],
      },
    },
  };

  try {
    const merged = mergeRecipesIntoConfig(config, { cacheDir });
    // Should keep the manual config, not overwrite with catalog version
    assert.equal(merged.servers["my-server"].command, "/usr/local/bin/my-server");
    assert.deepEqual(merged.servers["my-server"].args, ["--custom"]);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("mergeRecipesIntoConfig: does not mutate original config", () => {
  const cacheDir = makeTmpDir();
  seedCache(cacheDir, "new-tool", {
    name: "new-tool",
    transport: "stdio",
    command: "npx",
    args: ["-y", "new-tool"],
  });

  const config = emptyConfig();
  try {
    const merged = mergeRecipesIntoConfig(config, { cacheDir });
    assert.ok(merged.servers["new-tool"]);
    assert.equal(config.servers["new-tool"], undefined, "original config should not be mutated");
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
