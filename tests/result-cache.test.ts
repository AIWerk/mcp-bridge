import test from "node:test";
import assert from "node:assert/strict";
import { ResultCache, createResultCacheKey } from "../src/result-cache.ts";
import { McpRouter } from "../src/mcp-router.ts";
import type { McpClientConfig, McpRequest, McpResponse, McpServerConfig, McpTool, McpTransport } from "../src/types.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("basic get/set and eviction", () => {
  const cache = new ResultCache({ maxEntries: 2, defaultTtlMs: 1_000 });

  cache.set("a", { value: 1 });
  cache.set("b", { value: 2 });
  cache.set("c", { value: 3 });

  assert.equal(cache.get("a"), undefined);
  assert.deepEqual(cache.get("b"), { value: 2 });
  assert.deepEqual(cache.get("c"), { value: 3 });
});

test("TTL expiry", async () => {
  const cache = new ResultCache({ defaultTtlMs: 20 });

  cache.set("ttl", { ok: true });
  await sleep(35);

  assert.equal(cache.get("ttl"), undefined);
});

test("LRU ordering updates on get", () => {
  const cache = new ResultCache({ maxEntries: 2, defaultTtlMs: 1_000 });

  cache.set("a", 1);
  cache.set("b", 2);
  assert.equal(cache.get("a"), 1); // a is now most recently used

  cache.set("c", 3); // should evict b

  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), 1);
  assert.equal(cache.get("c"), 3);
});

test("cache key generation uses stable param stringification", () => {
  const keyA = createResultCacheKey("todoist", "find-tasks", { z: 1, a: { b: 2, c: 3 } });
  const keyB = createResultCacheKey("todoist", "find-tasks", { a: { c: 3, b: 2 }, z: 1 });

  assert.equal(keyA, keyB);
});

test("per-tool TTL override", async () => {
  const cache = new ResultCache({
    defaultTtlMs: 200,
    cacheTtl: {
      "todoist:find-tasks": 20
    }
  });

  const shortTtlKey = createResultCacheKey("todoist", "find-tasks", { q: "today" });
  const defaultTtlKey = createResultCacheKey("todoist", "list-projects", {});

  cache.set(shortTtlKey, { short: true });
  cache.set(defaultTtlKey, { normal: true });
  await sleep(35);

  assert.equal(cache.get(shortTtlKey), undefined);
  assert.deepEqual(cache.get(defaultTtlKey), { normal: true });
});

test("stats tracking", () => {
  const cache = new ResultCache({ maxEntries: 1, defaultTtlMs: 1_000 });

  cache.set("a", 1);
  assert.equal(cache.get("a"), 1); // hit
  assert.equal(cache.get("missing"), undefined); // miss
  cache.set("b", 2); // evict a

  assert.deepEqual(cache.stats(), {
    hits: 1,
    misses: 1,
    evictions: 1,
    size: 1
  });
});

type Behavior = {
  tools: McpTool[];
  callResult?: any;
  callError?: { code: number; message: string };
};

class MockTransport implements McpTransport {
  static behaviors = new Map<string, Behavior>();
  static instances = new Map<string, MockTransport>();

  static reset(): void {
    this.behaviors.clear();
    this.instances.clear();
  }

  connected = false;
  requests: McpRequest[] = [];
  private readonly key: string;

  constructor(config: McpServerConfig) {
    this.key = config.url || config.command || "default";
    MockTransport.instances.set(this.key, this);
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async sendRequest(request: McpRequest): Promise<McpResponse> {
    this.requests.push(request);
    const behavior = MockTransport.behaviors.get(this.key);

    if (request.method === "initialize") {
      return { jsonrpc: "2.0", id: 1, result: {} };
    }

    if (request.method === "tools/list") {
      return { jsonrpc: "2.0", id: 2, result: { tools: behavior?.tools || [] } };
    }

    if (request.method === "tools/call") {
      if (behavior?.callError) {
        return {
          jsonrpc: "2.0",
          id: 3,
          error: {
            code: behavior.callError.code,
            message: behavior.callError.message
          }
        };
      }
      return { jsonrpc: "2.0", id: 3, result: behavior?.callResult ?? { ok: true } };
    }

    return { jsonrpc: "2.0", id: 4, result: {} };
  }

  async sendNotification(_notification: any): Promise<void> {
    return;
  }

  isConnected(): boolean {
    return this.connected;
  }
}

function makeRouter(
  servers: Record<string, McpServerConfig>,
  resultCache?: McpClientConfig["resultCache"]
): McpRouter {
  return new McpRouter(
    servers,
    {
      servers,
      resultCache
    },
    {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {}
    },
    {
      sse: MockTransport,
      stdio: MockTransport,
      streamableHttp: MockTransport
    }
  );
}

test.beforeEach(() => {
  MockTransport.reset();
});

test("router integration: caches call results and refresh invalidates cache", async () => {
  MockTransport.behaviors.set("mock://cache", {
    tools: [{ name: "find-tasks", description: "Find tasks", inputSchema: { type: "object" } }],
    callResult: { items: [1] }
  });

  const router = makeRouter(
    { todoist: { transport: "sse", url: "mock://cache" } },
    { enabled: true, maxEntries: 10, defaultTtlMs: 10_000 }
  );

  const first = await router.dispatch("todoist", "call", "find-tasks", { query: "today" });
  const second = await router.dispatch("todoist", "call", "find-tasks", { query: "today" });

  assert.equal("error" in first, false);
  assert.equal("error" in second, false);

  const instance = MockTransport.instances.get("mock://cache");
  assert.ok(instance);

  let callRequests = instance!.requests.filter((r) => r.method === "tools/call");
  assert.equal(callRequests.length, 1);

  await router.dispatch("todoist", "refresh");
  await router.dispatch("todoist", "call", "find-tasks", { query: "today" });

  callRequests = instance!.requests.filter((r) => r.method === "tools/call");
  assert.equal(callRequests.length, 2);
});

test("router integration: does not cache errors", async () => {
  MockTransport.behaviors.set("mock://errors", {
    tools: [{ name: "find-tasks", description: "Find tasks", inputSchema: { type: "object" } }],
    callError: { code: -32001, message: "temporary failure" }
  });

  const router = makeRouter(
    { todoist: { transport: "sse", url: "mock://errors" } },
    { enabled: true, maxEntries: 10, defaultTtlMs: 10_000 }
  );

  const failed = await router.dispatch("todoist", "call", "find-tasks", { query: "today" });
  assert.ok("error" in failed);

  MockTransport.behaviors.set("mock://errors", {
    tools: [{ name: "find-tasks", description: "Find tasks", inputSchema: { type: "object" } }],
    callResult: { ok: true }
  });

  const success1 = await router.dispatch("todoist", "call", "find-tasks", { query: "today" });
  const success2 = await router.dispatch("todoist", "call", "find-tasks", { query: "today" });

  assert.equal("error" in success1, false);
  assert.equal("error" in success2, false);

  const instance = MockTransport.instances.get("mock://errors");
  assert.ok(instance);

  const callRequests = instance!.requests.filter((r) => r.method === "tools/call");
  // first failed + first success; second success should hit cache
  assert.equal(callRequests.length, 2);
});
