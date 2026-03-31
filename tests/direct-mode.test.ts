import test from "node:test";
import assert from "node:assert/strict";
import { McpRouter } from "../src/mcp-router.ts";
import type { McpServerConfig, McpClientConfig } from "../src/types.ts";

const noop = () => {};
const noopLogger = { info: noop, warn: noop, error: noop, debug: noop };

function makeRouter(servers: Record<string, McpServerConfig> = {}): McpRouter {
  const config: McpClientConfig = { servers };
  return new McpRouter(servers, config, noopLogger as any);
}

// ── Remove action ────────────────────────────────────────────────────────

test("remove action removes an existing server", async () => {
  const router = makeRouter({
    todoist: { transport: "stdio", command: "npx", args: ["-y", "@anthropic/mcp-todoist"] },
    github: { transport: "stdio", command: "npx", args: ["-y", "@anthropic/mcp-github"] },
  });
  const result = await router.dispatch("todoist", "remove");
  assert.ok("removed" in result, "expected removed field");
  assert.equal((result as any).removed, true);
  assert.ok((result as any).message.includes("removed"));
});

test("remove action returns error for non-existent server", async () => {
  const router = makeRouter({});
  const result = await router.dispatch("nonexistent", "remove");
  assert.ok("error" in result);
  assert.equal((result as any).error, "not_found");
});

test("remove action rejects invalid server name", async () => {
  const router = makeRouter({});
  const result = await router.dispatch("__proto__", "remove");
  assert.ok("error" in result);
  assert.equal((result as any).error, "invalid_params");
});

test("remove action requires server name", async () => {
  const router = makeRouter({});
  const result = await router.dispatch(undefined, "remove");
  assert.ok("error" in result);
  assert.equal((result as any).error, "invalid_params");
});

// ── Cache format ─────────────────────────────────────────────────────────

test("saveToolCache creates file with cachedAt wrapper", async () => {
  const { join } = await import("path");
  const { homedir } = await import("os");
  const { existsSync, readFileSync, unlinkSync, mkdirSync } = await import("fs");

  // Create a minimal StandaloneServer to test cache methods
  const { StandaloneServer } = await import("../src/standalone-server.ts");
  const server = new StandaloneServer(
    { servers: {}, mode: "direct" } as any,
    noopLogger as any
  );

  // Access private method via any cast
  const s = server as any;
  const testName = "test-cache-server";
  const tools = [{ name: "test_tool", description: "Test", inputSchema: { type: "object" } }];

  s.saveToolCache(testName, tools);

  const cachePath = join(homedir(), ".mcp-bridge", "cache", `${testName}-tools.json`);
  assert.ok(existsSync(cachePath), "cache file should exist");

  const raw = JSON.parse(readFileSync(cachePath, "utf-8"));
  assert.ok(raw.cachedAt, "should have cachedAt");
  assert.ok(Array.isArray(raw.tools), "should have tools array");
  assert.equal(raw.tools[0].name, "test_tool");

  // Load it back
  const loaded = s.loadToolCache(testName);
  assert.ok(Array.isArray(loaded));
  assert.equal(loaded[0].name, "test_tool");

  // Cleanup
  try { unlinkSync(cachePath); } catch {}
});

test("loadToolCache returns null for expired cache", async () => {
  const { join } = await import("path");
  const { homedir } = await import("os");
  const { writeFileSync, unlinkSync, mkdirSync } = await import("fs");

  const { StandaloneServer } = await import("../src/standalone-server.ts");
  const server = new StandaloneServer(
    { servers: {}, mode: "direct" } as any,
    noopLogger as any
  );

  const s = server as any;
  const testName = "test-expired-cache";
  const cacheDir = join(homedir(), ".mcp-bridge", "cache");
  mkdirSync(cacheDir, { recursive: true });
  const cachePath = join(cacheDir, `${testName}-tools.json`);

  // Write cache with old timestamp (25 hours ago)
  writeFileSync(cachePath, JSON.stringify({
    cachedAt: Date.now() - 25 * 60 * 60 * 1000,
    tools: [{ name: "old_tool", description: "Old", inputSchema: {} }]
  }));

  const loaded = s.loadToolCache(testName);
  assert.equal(loaded, null, "expired cache should return null");

  // Cleanup
  try { unlinkSync(cachePath); } catch {}
});

test("loadToolCache handles corrupt JSON gracefully", async () => {
  const { join } = await import("path");
  const { homedir } = await import("os");
  const { writeFileSync, unlinkSync, mkdirSync } = await import("fs");

  const { StandaloneServer } = await import("../src/standalone-server.ts");
  const server = new StandaloneServer(
    { servers: {}, mode: "direct" } as any,
    noopLogger as any
  );

  const s = server as any;
  const testName = "test-corrupt-cache";
  const cacheDir = join(homedir(), ".mcp-bridge", "cache");
  mkdirSync(cacheDir, { recursive: true });
  const cachePath = join(cacheDir, `${testName}-tools.json`);

  writeFileSync(cachePath, "not valid json {{{");

  const loaded = s.loadToolCache(testName);
  assert.equal(loaded, null, "corrupt cache should return null");

  // Cleanup
  try { unlinkSync(cachePath); } catch {}
});

test("saveToolCache rejects path-traversal server name", async () => {
  const { join } = await import("path");
  const { homedir } = await import("os");
  const { existsSync } = await import("fs");

  const { StandaloneServer } = await import("../src/standalone-server.ts");
  const server = new StandaloneServer(
    { servers: {}, mode: "direct" } as any,
    noopLogger as any
  );

  const s = server as any;
  s.saveToolCache("../../evil", [{ name: "hack", description: "x", inputSchema: {} }]);

  const evilPath = join(homedir(), ".mcp-bridge", "cache", "../../evil-tools.json");
  // The sanitization should prevent writing
  assert.ok(!existsSync(join(homedir(), ".mcp-bridge", "evil-tools.json")), "should not write outside cache dir");
});
