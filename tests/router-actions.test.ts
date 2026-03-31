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

// ── Install action: serverName sanitization ──────────────────────────────

test("install action rejects __proto__ serverName (prototype pollution)", async () => {
  const router = makeRouter();
  const result = await router.dispatch("__proto__", "install");
  assert.ok("error" in result, "expected error response");
  assert.equal((result as any).error, "invalid_params");
  assert.ok((result as any).message.includes("Invalid server name"));
});

test("install action rejects path traversal serverName", async () => {
  const router = makeRouter();
  const result = await router.dispatch("../evil", "install");
  assert.ok("error" in result, "expected error response");
  assert.equal((result as any).error, "invalid_params");
});

test("install action rejects uppercase serverName", async () => {
  const router = makeRouter();
  const result = await router.dispatch("MyServer", "install");
  assert.ok("error" in result, "expected error response");
  assert.equal((result as any).error, "invalid_params");
});

test("install action rejects serverName starting with hyphen", async () => {
  const router = makeRouter();
  const result = await router.dispatch("-bad-name", "install");
  assert.ok("error" in result, "expected error response");
  assert.equal((result as any).error, "invalid_params");
});

test("install action rejects empty serverName", async () => {
  const router = makeRouter();
  const result = await router.dispatch("", "install");
  assert.ok("error" in result, "expected error response");
  assert.equal((result as any).error, "invalid_params");
});

// ── Install action: already configured ───────────────────────────────────

test("install action returns already-configured for existing server", async () => {
  const router = makeRouter({
    todoist: { transport: "stdio", command: "npx", args: ["-y", "@anthropic/mcp-todoist"] },
  });
  const result = await router.dispatch("todoist", "install");
  assert.ok("installed" in result);
  assert.equal((result as any).installed, true);
  assert.ok((result as any).message.includes("already configured"));
});

test("install action accepts valid kebab-case name for non-existent server", async () => {
  // Valid name passes sanitization, hits catalog resolve (which may fail on network, that's OK)
  const router = makeRouter();
  const result = await router.dispatch("some-nonexistent-server-xyz", "install");
  // Should NOT be invalid_params - it passes the regex
  if ("error" in result) {
    assert.notEqual((result as any).error, "invalid_params", "valid name should pass sanitization");
  }
});
