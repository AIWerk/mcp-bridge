import test from "node:test";
import assert from "node:assert/strict";
import { ToolResolver } from "../src/tool-resolution.ts";
import { McpRouter } from "../src/mcp-router.ts";
import type { McpClientConfig, McpRequest, McpResponse, McpServerConfig, McpTool, McpTransport } from "../src/types.ts";

test("ToolResolver: collision + server hint picks explicit server", () => {
  const resolver = new ToolResolver(["todoist", "linear"]);
  resolver.registerServerTools("todoist", [{ name: "create-task", inputSchema: { type: "object", properties: { content: { type: "string" } } } }]);
  resolver.registerServerTools("linear", [{ name: "create-task", inputSchema: { type: "object", properties: { title: { type: "string" } } } }]);

  const resolved = resolver.resolve("create-task", { title: "A" }, "todoist");
  assert.ok(resolved && "server" in resolved);
  if (resolved && "server" in resolved) {
    assert.equal(resolved.server, "todoist");
  }
});

test("ToolResolver: high score delta auto-resolves", () => {
  const resolver = new ToolResolver(["todoist", "linear"]); // linear gets higher base priority
  resolver.registerServerTools("todoist", [{ name: "create-task", inputSchema: { type: "object", properties: { content: { type: "string" } } } }]);
  resolver.registerServerTools("linear", [{ name: "create-task", inputSchema: { type: "object", properties: { title: { type: "string" } } } }]);

  const resolved = resolver.resolve("create-task", { title: "Launch" });
  assert.ok(resolved && "server" in resolved);
  if (resolved && "server" in resolved) {
    assert.equal(resolved.server, "linear");
  }
});

test("ToolResolver: close scores return disambiguation result", () => {
  const resolver = new ToolResolver(["alpha", "beta"]);
  resolver.registerServerTools("alpha", [{ name: "create-task", inputSchema: { type: "object" } }]);
  resolver.registerServerTools("beta", [{ name: "create-task", inputSchema: { type: "object" } }]);

  const resolved = resolver.resolve("create-task", {});
  assert.ok(resolved && "ambiguous" in resolved);
  if (resolved && "ambiguous" in resolved) {
    assert.equal(resolved.ambiguous, true);
    assert.equal(resolved.candidates.length, 2);
    assert.equal(resolved.candidates[0].suggested, true);
  }
});

test("ToolResolver: recency boost changes winner", () => {
  const resolver = new ToolResolver(["todoist", "linear"]); // linear base 1.0, todoist base 0.9
  resolver.registerServerTools("todoist", [{ name: "create-task", inputSchema: { type: "object" } }]);
  resolver.registerServerTools("linear", [{ name: "create-task", inputSchema: { type: "object" } }]);

  resolver.recordCall("todoist", "x");
  const resolved = resolver.resolve("create-task", {});
  assert.ok(resolved && "server" in resolved);
  if (resolved && "server" in resolved) {
    assert.equal(resolved.server, "todoist"); // 0.9 + 0.3 beats 1.0
  }
});

test("ToolResolver: param match affects scoring", () => {
  const resolver = new ToolResolver(["todoist", "linear"]);
  resolver.registerServerTools("todoist", [{ name: "create-task", inputSchema: { type: "object", properties: { content: { type: "string" } } } }]);
  resolver.registerServerTools("linear", [{ name: "create-task", inputSchema: { type: "object", properties: { title: { type: "string" }, due: { type: "string" } } } }]);

  const resolved = resolver.resolve("create-task", { title: "A", due: "today" });
  assert.ok(resolved && "server" in resolved);
  if (resolved && "server" in resolved) {
    assert.equal(resolved.server, "linear");
  }
});

test("ToolResolver: recent calls ring buffer wraps at 5", () => {
  const resolver = new ToolResolver(["a", "b", "c", "d", "e", "f", "g"]);
  resolver.registerServerTools("a", [{ name: "shared", inputSchema: { type: "object" } }]);
  resolver.registerServerTools("b", [{ name: "shared", inputSchema: { type: "object" } }]);

  resolver.recordCall("a", "first");
  resolver.recordCall("c", "x");
  resolver.recordCall("d", "x");
  resolver.recordCall("e", "x");
  resolver.recordCall("f", "x");
  resolver.recordCall("g", "x"); // pushes out server a

  const resolved = resolver.resolve("shared", {});
  assert.ok(resolved && "ambiguous" in resolved);
});

class MockTransport implements McpTransport {
  static behaviors = new Map<string, { tools: McpTool[]; result?: unknown; connectError?: string }>();

  static reset(): void {
    this.behaviors.clear();
  }

  private connected = false;
  private readonly key: string;

  constructor(config: McpServerConfig) {
    this.key = config.url || config.command || "mock";
  }

  async connect(): Promise<void> {
    const behavior = MockTransport.behaviors.get(this.key);
    if (behavior?.connectError) {
      throw new Error(behavior.connectError);
    }
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async sendRequest(request: McpRequest): Promise<McpResponse> {
    const behavior = MockTransport.behaviors.get(this.key);
    if (request.method === "initialize") {
      return { jsonrpc: "2.0", id: request.id ?? 1, result: {} };
    }
    if (request.method === "tools/list") {
      return { jsonrpc: "2.0", id: request.id ?? 1, result: { tools: behavior?.tools ?? [] } };
    }
    if (request.method === "tools/call") {
      return { jsonrpc: "2.0", id: request.id ?? 1, result: behavior?.result ?? { ok: true } };
    }
    return { jsonrpc: "2.0", id: request.id ?? 1, result: {} };
  }

  async sendNotification(_notification: any): Promise<void> {
    return;
  }

  isConnected(): boolean {
    return this.connected;
  }
}

function makeRouter(servers: Record<string, McpServerConfig>): McpRouter {
  const cfg: McpClientConfig = { servers };
  return new McpRouter(
    servers,
    cfg,
    { info() {}, warn() {}, error() {}, debug() {} },
    { sse: MockTransport as any, stdio: MockTransport as any, streamableHttp: MockTransport as any }
  );
}

test("McpRouter: no collision dispatches directly without server", async () => {
  MockTransport.reset();
  MockTransport.behaviors.set("mock://one", {
    tools: [{ name: "list-tasks", description: "", inputSchema: { type: "object" } }],
    result: { server: "one" }
  });
  MockTransport.behaviors.set("mock://two", {
    tools: [{ name: "create-task", description: "", inputSchema: { type: "object" } }],
    result: { server: "two" }
  });

  const router = makeRouter({
    one: { transport: "sse", url: "mock://one" },
    two: { transport: "sse", url: "mock://two" }
  });

  const res = await router.dispatch(undefined, "call", "create-task", {});
  assert.ok(!("error" in res));
  assert.ok(!("ambiguous" in res));
  if (!("error" in res) && !("ambiguous" in res)) {
    assert.equal(res.server, "two");
  }
});

test("McpRouter: dynamic add/remove updates collision behavior", async () => {
  MockTransport.reset();
  MockTransport.behaviors.set("mock://linear", {
    tools: [{ name: "create-task", description: "", inputSchema: { type: "object", properties: { title: { type: "string" } } } }],
    result: { server: "linear" }
  });
  MockTransport.behaviors.set("mock://todoist", {
    tools: [{ name: "create-task", description: "", inputSchema: { type: "object", properties: { content: { type: "string" } } } }],
    connectError: "offline"
  });

  const router = makeRouter({
    linear: { transport: "sse", url: "mock://linear" },
    todoist: { transport: "sse", url: "mock://todoist" }
  });

  const noCollision = await router.dispatch(undefined, "call", "create-task", { title: "A" });
  assert.ok(!("error" in noCollision));
  assert.ok(!("ambiguous" in noCollision));

  const todoBehavior = MockTransport.behaviors.get("mock://todoist")!;
  delete todoBehavior.connectError;
  await router.dispatch("todoist", "list"); // server becomes available
  await router.dispatch("todoist", "call", "create-task", { content: "seed recency" });

  const ambiguous = await router.dispatch(undefined, "call", "create-task", {});
  assert.ok("ambiguous" in ambiguous);

  todoBehavior.connectError = "offline";
  await router.disconnectAll(); // removes offline server from resolver map

  const resolvedAgain = await router.dispatch(undefined, "call", "create-task", { title: "B" });
  assert.ok(!("error" in resolvedAgain));
  assert.ok(!("ambiguous" in resolvedAgain));
});
