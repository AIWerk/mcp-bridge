import test from "node:test";
import assert from "node:assert/strict";
import { McpRouter } from "../src/mcp-router.ts";
import type { McpRequest, McpResponse, McpServerConfig, McpClientConfig, McpTransport, McpTool } from "../src/types.ts";

type Behavior = {
  tools: McpTool[];
  callResult?: any;
  callError?: { code: number; message: string };
};

class MockTransport implements McpTransport {
  static behaviors = new Map<string, Behavior>();

  static reset(): void {
    this.behaviors.clear();
  }

  connected = false;
  private readonly key: string;

  constructor(config: McpServerConfig) {
    this.key = config.url || config.command || "default";
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async sendRequest(request: McpRequest): Promise<McpResponse> {
    const behavior = MockTransport.behaviors.get(this.key);

    if (request.method === "initialize") {
      return { jsonrpc: "2.0", id: 1, result: {} };
    }

    if (request.method === "tools/list") {
      return { jsonrpc: "2.0", id: 2, result: { tools: behavior?.tools || [] } };
    }

    if (request.method === "tools/call") {
      if (behavior?.callError) {
        return { jsonrpc: "2.0", id: 3, error: { code: behavior.callError.code, message: behavior.callError.message } };
      }
      return { jsonrpc: "2.0", id: 3, result: behavior?.callResult || { ok: true } };
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

function makeRouter(servers: Record<string, McpServerConfig>, maxBatchSize?: number): McpRouter {
  return new McpRouter(
    servers,
    { servers, maxBatchSize } as McpClientConfig,
    { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    { sse: MockTransport, stdio: MockTransport, streamableHttp: MockTransport }
  );
}

test.beforeEach(() => {
  MockTransport.reset();
});

test("batch: single batch call", async () => {
  MockTransport.behaviors.set("mock://todo", {
    tools: [{ name: "find_tasks", description: "Find", inputSchema: { type: "object" } }],
    callResult: { tasks: [{ id: "1" }] }
  });

  const router = makeRouter({ todo: { transport: "sse", url: "mock://todo" } });
  const result = await router.dispatch(undefined, "batch", undefined, {
    calls: [{ server: "todo", tool: "find_tasks", params: { query: "today" } }]
  });

  assert.equal("error" in result, false);
  if ("action" in result && result.action === "batch") {
    assert.deepEqual(result.results[0], {
      server: "todo",
      tool: "find_tasks",
      result: { tasks: [{ id: "1" }] }
    });
  }
});

test("batch: mixed success/failure", async () => {
  MockTransport.behaviors.set("mock://ok", {
    tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object" } }],
    callResult: { pong: true }
  });
  MockTransport.behaviors.set("mock://bad", {
    tools: [{ name: "boom", description: "Boom", inputSchema: { type: "object" } }],
    callError: { code: -32000, message: "upstream failed" }
  });

  const router = makeRouter({
    ok: { transport: "sse", url: "mock://ok" },
    bad: { transport: "sse", url: "mock://bad" }
  });

  const result = await router.dispatch(undefined, "batch", undefined, {
    calls: [{ server: "ok", tool: "ping" }, { server: "bad", tool: "boom" }]
  });

  assert.equal("error" in result, false);
  if ("action" in result && result.action === "batch") {
    assert.equal(result.results[1].error?.error, "mcp_error");
    assert.match(result.results[1].error?.message || "", /upstream failed/);
  }
});

test("batch: max batch size enforcement", async () => {
  const router = makeRouter({}, 10);
  const result = await router.dispatch(undefined, "batch", undefined, {
    calls: Array.from({ length: 11 }, () => ({ server: "x", tool: "y" }))
  });

  assert.ok("error" in result);
  if ("error" in result) {
    assert.equal(result.error, "invalid_params");
    assert.match(result.message, /maxBatchSize/);
  }
});

test("batch: empty calls returns error", async () => {
  const router = makeRouter({});
  const result = await router.dispatch(undefined, "batch", undefined, { calls: [] });

  assert.ok("error" in result);
  if ("error" in result) {
    assert.equal(result.error, "invalid_params");
    assert.match(result.message, /non-empty array/);
  }
});

test("batch: each call respects security pipeline", async () => {
  MockTransport.behaviors.set("mock://secure", {
    tools: [{ name: "dump", description: "Dump", inputSchema: { type: "object" } }],
    callResult: { data: "x".repeat(500) }
  });

  const router = makeRouter({
    secure: {
      transport: "sse",
      url: "mock://secure",
      trust: "untrusted",
      maxResultChars: 30
    }
  });

  const result = await router.dispatch(undefined, "batch", undefined, {
    calls: [{ server: "secure", tool: "dump" }]
  });

  assert.equal("error" in result, false);
  if ("action" in result && result.action === "batch") {
    const slot = result.results[0];
    assert.equal(slot.error, undefined);
    assert.equal(slot.result._trust, "untrusted");
    assert.equal(slot.result._truncated, true);
    assert.equal(slot.result.result.length, 30);
  }
});
