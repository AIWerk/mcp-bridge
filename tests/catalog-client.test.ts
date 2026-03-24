import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CatalogClient, CatalogError } from "../src/catalog-client.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "catalog-test-"));
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

// ── resolve() with mocked fetch ──────────────────────────────────────────────

test("resolve: fetches from catalog and caches locally", async () => {
  const cacheDir = makeTmpDir();
  const restore = mockFetch(async (url) => {
    if (url.includes("/api/recipes/my-server/download")) {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ name: "my-server", description: "fetched" }),
      };
    }
    return { ok: false, status: 404, headers: new Headers(), text: async () => "not found" };
  });

  try {
    const client = new CatalogClient({ baseUrl: "https://mock.test", cacheDir });
    const result = await client.resolve("my-server");

    assert.equal(result.name, "my-server");
    assert.equal(result.description, "fetched");
    // Verify it was cached
    assert.ok(existsSync(join(cacheDir, "my-server", "recipe.json")));
  } finally {
    restore();
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("resolve: returns cached recipe without fetching when cache is fresh", async () => {
  const cacheDir = makeTmpDir();
  seedCache(cacheDir, "cached-srv", { name: "cached-srv", description: "from cache" });

  let fetchCalled = false;
  const restore = mockFetch(async (url) => {
    fetchCalled = true;
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ name: "cached-srv", description: "fresh" }),
    };
  });

  try {
    const client = new CatalogClient({ baseUrl: "https://mock.test", cacheDir });
    const result = await client.resolve("cached-srv");
    // Cache-first: should return cached version without fetching
    assert.equal(result.name, "cached-srv");
    assert.equal(result.description, "from cache");
    assert.equal(fetchCalled, false, "Should not have fetched when cache is fresh");
  } finally {
    restore();
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

// ── getCached / listCached with tmp dir ──────────────────────────────────────

test("getCached: returns null for missing recipe", () => {
  const cacheDir = makeTmpDir();
  try {
    const client = new CatalogClient({ cacheDir });
    assert.equal(client.getCached("nonexistent"), null);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("getCached: returns cached recipe", () => {
  const cacheDir = makeTmpDir();
  seedCache(cacheDir, "alpha", { name: "alpha", description: "cached" });

  try {
    const client = new CatalogClient({ cacheDir });
    const result = client.getCached("alpha");
    assert.ok(result);
    assert.equal(result.name, "alpha");
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("listCached: returns array of cached recipe names", () => {
  const cacheDir = makeTmpDir();
  seedCache(cacheDir, "alpha", { name: "alpha" });
  seedCache(cacheDir, "beta", { name: "beta" });

  try {
    const client = new CatalogClient({ cacheDir });
    const names = client.listCached().sort();
    assert.deepEqual(names, ["alpha", "beta"]);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("listCached: returns empty array when cache dir does not exist", () => {
  const client = new CatalogClient({ cacheDir: "/tmp/nonexistent-catalog-" + Date.now() });
  assert.deepEqual(client.listCached(), []);
});

// ── Offline fallback ─────────────────────────────────────────────────────────

test("resolve: falls back to cache when catalog is unreachable", async () => {
  const cacheDir = makeTmpDir();
  seedCache(cacheDir, "offline-srv", { name: "offline-srv", description: "cached" });

  const restore = mockFetch(async () => {
    throw new Error("Network error: ECONNREFUSED");
  });

  try {
    const client = new CatalogClient({ baseUrl: "https://mock.test", cacheDir });
    const result = await client.resolve("offline-srv");

    assert.equal(result.name, "offline-srv");
    assert.equal(result.description, "cached");
  } finally {
    restore();
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("resolve: throws CatalogError when catalog unreachable and no cache", async () => {
  const cacheDir = makeTmpDir();

  const restore = mockFetch(async () => {
    throw new Error("Network error: ECONNREFUSED");
  });

  try {
    const client = new CatalogClient({ baseUrl: "https://mock.test", cacheDir });
    await assert.rejects(
      () => client.resolve("missing-srv"),
      (err: any) => {
        assert.ok(err instanceof CatalogError);
        assert.match(err.message, /Cannot resolve recipe "missing-srv"/);
        return true;
      },
    );
  } finally {
    restore();
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("resolve: returns cached recipe when cache is fresh, even if catalog would 404", async () => {
  // Cache-first: if cache is fresh, resolve() returns it without hitting the network
  const cacheDir = makeTmpDir();
  seedCache(cacheDir, "gone-srv", { name: "gone-srv" });

  let fetchCalled = false;
  const restore = mockFetch(async () => {
    fetchCalled = true;
    return { ok: false, status: 404, headers: new Headers(), text: async () => "not found" };
  });

  try {
    const client = new CatalogClient({ baseUrl: "https://mock.test", cacheDir });
    const result = await client.resolve("gone-srv");
    assert.equal(result.name, "gone-srv");
    assert.equal(fetchCalled, false, "Should not have fetched when cache is fresh");
  } finally {
    restore();
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

// ── bootstrap ────────────────────────────────────────────────────────────────

test("bootstrap: downloads top recipes and returns names", async () => {
  const cacheDir = makeTmpDir();

  const restore = mockFetch(async (url) => {
    if (url.includes("/api/recipes?")) {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          results: [
            { name: "srv-a", description: "A" },
            { name: "srv-b", description: "B" },
            { name: "srv-c", description: "C" },
          ],
          total: 3,
        }),
      };
    }
    if (url.includes("/download")) {
      const name = url.split("/api/recipes/")[1].split("/download")[0];
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ name, description: `recipe ${name}` }),
      };
    }
    return { ok: false, status: 404, headers: new Headers(), text: async () => "not found" };
  });

  try {
    const client = new CatalogClient({ baseUrl: "https://mock.test", cacheDir });
    const names = await client.bootstrap(3);

    assert.deepEqual(names.sort(), ["srv-a", "srv-b", "srv-c"]);
    // Verify all were cached
    assert.ok(existsSync(join(cacheDir, "srv-a", "recipe.json")));
    assert.ok(existsSync(join(cacheDir, "srv-b", "recipe.json")));
    assert.ok(existsSync(join(cacheDir, "srv-c", "recipe.json")));
  } finally {
    restore();
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("bootstrap: skips already-cached fresh recipes", async () => {
  const cacheDir = makeTmpDir();
  seedCache(cacheDir, "srv-a", { name: "srv-a", description: "already cached" });

  let downloadCalls = 0;
  const restore = mockFetch(async (url) => {
    if (url.includes("/api/recipes?")) {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          results: [{ name: "srv-a" }, { name: "srv-b" }],
          total: 2,
        }),
      };
    }
    if (url.includes("/download")) {
      downloadCalls++;
      const name = url.split("/api/recipes/")[1].split("/download")[0];
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ name }),
      };
    }
    return { ok: false, status: 404, headers: new Headers(), text: async () => "" };
  });

  try {
    const client = new CatalogClient({ baseUrl: "https://mock.test", cacheDir });
    const names = await client.bootstrap(2);

    assert.deepEqual(names.sort(), ["srv-a", "srv-b"]);
    // Only srv-b should have been downloaded (srv-a was fresh in cache)
    assert.equal(downloadCalls, 1);
  } finally {
    restore();
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
