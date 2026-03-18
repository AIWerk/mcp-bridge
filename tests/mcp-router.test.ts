import test from "node:test";
import assert from "node:assert/strict";
import { McpRouter } from "../src/mcp-router.ts";
import type { McpRequest, McpResponse, McpServerConfig, McpClientConfig, McpTransport, McpTool } from "../src/types.ts";

type Behavior = {
  tools: McpTool[];
  callResult?: any;
  callError?: { code: number; message: string };
  callThrowSequence?: Error[];
  connectError?: Error;
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
  connectCount = 0;
  disconnectCount = 0;
  shutdownCount = 0;
  private readonly key: string;

  constructor(config: McpServerConfig, _clientConfig?: any, _logger?: any, _onReconnected?: () => Promise<void>) {
    this.key = config.url || config.command || "default";
    MockTransport.instances.set(this.key, this);
  }

  async connect(): Promise<void> {
    this.connectCount += 1;
    const behavior = MockTransport.behaviors.get(this.key);
    if (behavior?.connectError) {
      throw behavior.connectError;
    }
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.disconnectCount += 1;
    this.connected = false;
  }

  async shutdown(): Promise<void> {
    this.shutdownCount += 1;
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
      if (behavior?.callThrowSequence?.length) {
        const nextError = behavior.callThrowSequence.shift();
        if (nextError) throw nextError;
      }
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

function makeLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {}
  };
}

function makeRouter(
  servers: Record<string, McpServerConfig>,
  overrides: {
    routerIdleTimeoutMs?: number;
    routerConnectErrorCooldownMs?: number;
    routerMaxConcurrent?: number;
    schemaCompression?: { enabled?: boolean; maxDescriptionLength?: number };
    intentRouting?: McpClientConfig["intentRouting"];
    maxResultChars?: number;
    adaptivePromotion?: McpClientConfig["adaptivePromotion"];
    retry?: McpClientConfig["retry"];
    shutdownTimeoutMs?: number;
    resultCache?: McpClientConfig["resultCache"];
  } = {}
): McpRouter {
  return new McpRouter(
    servers,
    {
      servers,
      routerIdleTimeoutMs: overrides.routerIdleTimeoutMs,
      routerConnectErrorCooldownMs: overrides.routerConnectErrorCooldownMs,
      routerMaxConcurrent: overrides.routerMaxConcurrent,
      schemaCompression: overrides.schemaCompression,
      intentRouting: overrides.intentRouting,
      maxResultChars: overrides.maxResultChars,
      adaptivePromotion: overrides.adaptivePromotion,
      retry: overrides.retry,
      shutdownTimeoutMs: overrides.shutdownTimeoutMs,
      resultCache: overrides.resultCache
    },
    makeLogger(),
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

test("dispatch returns unknown_server error for missing server", async () => {
  const router = makeRouter({
    alpha: { transport: "sse", url: "mock://alpha" }
  });

  const result = await router.dispatch("missing", "list");
  assert.equal("error" in result ? result.error : "", "unknown_server");
});

test("ensureConnected caches connect failures briefly before retrying", async () => {
  const behavior: Behavior = {
    tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object" } }],
    connectError: new Error("connect failed")
  };
  MockTransport.behaviors.set("mock://unstable", behavior);

  const router = makeRouter(
    { unstable: { transport: "sse", url: "mock://unstable" } },
    { routerConnectErrorCooldownMs: 20 }
  );

  const first = await router.dispatch("unstable", "list");
  assert.ok("error" in first);

  const second = await router.dispatch("unstable", "list");
  assert.ok("error" in second);

  let instance = MockTransport.instances.get("mock://unstable");
  assert.ok(instance);
  assert.equal(instance!.connectCount, 1);

  behavior.connectError = undefined;
  await new Promise((resolve) => setTimeout(resolve, 30));

  const third = await router.dispatch("unstable", "list");
  assert.equal("error" in third, false);

  instance = MockTransport.instances.get("mock://unstable");
  assert.ok(instance);
  assert.equal(instance!.connectCount, 2);
});

test("dispatch action=list returns cached tool list", async () => {
  const server = { transport: "sse" as const, url: "mock://cache" };
  MockTransport.behaviors.set("mock://cache", {
    tools: [
      {
        name: "create_server",
        description: "Create server",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"]
        }
      }
    ]
  });

  const router = makeRouter({ cache: server });
  const first = await router.dispatch("cache", "list");
  const second = await router.dispatch("cache", "list");

  assert.equal("error" in first, false);
  assert.equal("error" in second, false);
  if (!("error" in first) && first.action === "list") {
    assert.deepEqual(first.tools, [
      {
        name: "create_server",
        description: "Create server",
        requiredParams: ["name"]
      }
    ]);
  }

  const instance = MockTransport.instances.get("mock://cache");
  assert.ok(instance);
  const listCalls = instance!.requests.filter((req) => req.method === "tools/list");
  assert.equal(listCalls.length, 1);
});

test("dispatch action=call proxies to transport", async () => {
  MockTransport.behaviors.set("mock://call", {
    tools: [{ name: "list_servers", description: "List", inputSchema: { type: "object" } }],
    callResult: { servers: [{ id: "1" }] }
  });

  const router = makeRouter({
    call: { transport: "sse", url: "mock://call" }
  });

  const result = await router.dispatch("call", "call", "list_servers", { region: "eu-central" });
  assert.equal("error" in result, false);
  if (!("error" in result) && result.action === "call") {
    assert.deepEqual(result.result, { servers: [{ id: "1" }] });
  }

  const instance = MockTransport.instances.get("mock://call");
  assert.ok(instance);
  const callRequest = instance!.requests.find((req) => req.method === "tools/call");
  assert.ok(callRequest);
  assert.deepEqual(callRequest!.params, {
    name: "list_servers",
    arguments: { region: "eu-central" }
  });
});

test("evicts least recently used connection when max concurrent exceeded", async () => {
  const servers = {
    a: { transport: "sse" as const, url: "mock://a" },
    b: { transport: "sse" as const, url: "mock://b" },
    c: { transport: "sse" as const, url: "mock://c" }
  };

  for (const key of Object.keys(servers)) {
    MockTransport.behaviors.set(`mock://${key}`, {
      tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object" } }]
    });
  }

  const router = makeRouter(servers, { routerMaxConcurrent: 2, routerIdleTimeoutMs: 60_000 });

  await router.dispatch("a", "list");
  await new Promise((resolve) => setTimeout(resolve, 5));
  await router.dispatch("b", "list");
  await new Promise((resolve) => setTimeout(resolve, 5));
  await router.dispatch("c", "list");

  assert.equal(MockTransport.instances.get("mock://a")?.disconnectCount, 1);
  assert.equal(MockTransport.instances.get("mock://b")?.isConnected(), true);
  assert.equal(MockTransport.instances.get("mock://c")?.isConnected(), true);
});

test("disconnects idle connection after timeout", async () => {
  MockTransport.behaviors.set("mock://idle", {
    tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object" } }]
  });

  const router = makeRouter(
    { idle: { transport: "sse", url: "mock://idle" } },
    { routerIdleTimeoutMs: 25, routerMaxConcurrent: 5 }
  );

  await router.dispatch("idle", "list");
  await new Promise((resolve) => setTimeout(resolve, 80));

  const instance = MockTransport.instances.get("mock://idle");
  assert.ok(instance);
  assert.equal(instance!.disconnectCount >= 1, true);
  assert.equal(instance!.isConnected(), false);
});

test("generateDescription includes configured servers", () => {
  const description = McpRouter.generateDescription({
    hetzner: { transport: "sse", url: "mock://h" },
    github: { transport: "sse", url: "mock://g" }
  });

  assert.match(description, /hetzner/);
  assert.match(description, /github/);
  assert.match(description, /action='list'/);
  assert.match(description, /action='call'/);
  assert.match(description, /action='refresh'/);
});

test("status action returns all servers with connection state", async () => {
  const servers = {
    alpha: { transport: "stdio" as const, command: "node", args: ["fake.js"] },
    beta: { transport: "sse" as const, url: "http://localhost:9999/sse" }
  };
  const router = makeRouter(servers);

  const result = await router.dispatch(undefined, "status");
  assert.equal("action" in result && result.action, "status");
  if ("servers" in result) {
    assert.equal(result.servers.length, 2);
    const alpha = result.servers.find(s => s.name === "alpha");
    assert.ok(alpha);
    assert.equal(alpha!.status, "disconnected");
    assert.equal(alpha!.tools, 0);
    assert.equal(alpha!.transport, "stdio");
    const beta = result.servers.find(s => s.name === "beta");
    assert.ok(beta);
    assert.equal(beta!.status, "disconnected");
    assert.equal(beta!.transport, "sse");
  }
});

test("status action shows connected server after list", async () => {
  const servers = {
    alpha: { transport: "stdio" as const, command: "node", args: ["fake.js"] }
  };
  MockTransport.behaviors.set("node", {
    tools: [
      { name: "tool_a", description: "A", inputSchema: { type: "object" } },
      { name: "tool_b", description: "B", inputSchema: { type: "object" } }
    ]
  });
  const router = makeRouter(servers);

  // List triggers connection + tool fetch
  await router.dispatch("alpha", "list");

  const result = await router.dispatch(undefined, "status");
  if ("servers" in result) {
    const alpha = result.servers.find(s => s.name === "alpha");
    assert.ok(alpha);
    assert.equal(alpha!.status, "connected");
    assert.equal(alpha!.tools, 2);
  }
});

test("generateDescription includes status action", () => {
  const description = McpRouter.generateDescription({
    test: { transport: "stdio", command: "node", args: [] }
  });
  assert.match(description, /action='status'/);
});

test("action=schema returns full schema and description", async () => {
  const longDesc = "Create a new virtual server. This provisions compute resources and sets up networking for production workloads.";
  MockTransport.behaviors.set("mock://schema", {
    tools: [
      {
        name: "create_vm",
        description: longDesc,
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" }, region: { type: "string" } },
          required: ["name"]
        }
      }
    ]
  });

  const router = makeRouter({ schema: { transport: "sse", url: "mock://schema" } });

  const result = await router.dispatch("schema", "schema", "create_vm");
  assert.equal("error" in result, false);
  if (!("error" in result) && result.action === "schema") {
    assert.equal(result.tool, "create_vm");
    assert.equal(result.description, longDesc);
    assert.deepEqual(result.schema, {
      type: "object",
      properties: { name: { type: "string" }, region: { type: "string" } },
      required: ["name"]
    });
  }
});

test("action=schema returns error for unknown tool", async () => {
  MockTransport.behaviors.set("mock://schema2", {
    tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object" } }]
  });

  const router = makeRouter({ s: { transport: "sse", url: "mock://schema2" } });
  const result = await router.dispatch("s", "schema", "nonexistent");
  assert.equal("error" in result ? result.error : "", "unknown_tool");
});

test("compressed descriptions in tool list (default enabled)", async () => {
  const longDesc = "Create a new virtual server. This provisions compute resources and sets up networking for production workloads.";
  MockTransport.behaviors.set("mock://compress", {
    tools: [
      {
        name: "create_vm",
        description: longDesc,
        inputSchema: { type: "object", required: ["name"] }
      }
    ]
  });

  const router = makeRouter({ comp: { transport: "sse", url: "mock://compress" } });
  const result = await router.dispatch("comp", "list");
  assert.equal("error" in result, false);
  if (!("error" in result) && result.action === "list") {
    const tool = result.tools[0];
    // Should be truncated at sentence boundary
    assert.equal(tool.description, "Create a new virtual server.\u2026");
  }
});

test("disabled compression returns full description", async () => {
  const longDesc = "Create a new virtual server. This provisions compute resources and sets up networking for production workloads.";
  MockTransport.behaviors.set("mock://nocompress", {
    tools: [
      {
        name: "create_vm",
        description: longDesc,
        inputSchema: { type: "object" }
      }
    ]
  });

  const router = makeRouter(
    { nc: { transport: "sse", url: "mock://nocompress" } },
    { schemaCompression: { enabled: false } }
  );
  const result = await router.dispatch("nc", "list");
  assert.equal("error" in result, false);
  if (!("error" in result) && result.action === "list") {
    assert.equal(result.tools[0].description, longDesc);
  }
});

test("action=intent dispatches correctly and finds matching tool", async () => {
  MockTransport.behaviors.set("mock://github", {
    tools: [
      { name: "create_issue", description: "Create a GitHub issue for tracking bugs", inputSchema: { type: "object" } },
      { name: "list_repos", description: "List all GitHub repositories", inputSchema: { type: "object" } }
    ]
  });
  MockTransport.behaviors.set("mock://email", {
    tools: [
      { name: "send_email", description: "Send an email message to a recipient", inputSchema: { type: "object" } }
    ]
  });

  const router = makeRouter(
    {
      github: { transport: "sse", url: "mock://github" },
      email: { transport: "sse", url: "mock://email" }
    },
    { intentRouting: { embedding: "keyword" } }
  );

  const result = await router.dispatch(undefined, "intent", undefined, { intent: "create a new issue on GitHub" });
  assert.equal("error" in result, false);
  if (!("error" in result) && "action" in result && result.action === "intent") {
    assert.equal(result.match.server, "github");
    assert.equal(result.match.tool, "create_issue");
    assert.ok(result.match.score > 0);
    assert.ok(Array.isArray(result.alternatives));
  }
});

test("action=intent returns error for unknown intent gracefully", async () => {
  MockTransport.behaviors.set("mock://srv", {
    tools: [
      { name: "specific_tool", description: "Does one very specific thing", inputSchema: { type: "object" } }
    ]
  });

  const router = makeRouter(
    { srv: { transport: "sse", url: "mock://srv" } },
    { intentRouting: { embedding: "keyword", minScore: 0.99 } }
  );

  const result = await router.dispatch(undefined, "intent", undefined, { intent: "completely unrelated cooking recipe" });
  assert.ok("error" in result);
  if ("error" in result) {
    assert.equal(result.error, "invalid_params");
    assert.ok(result.message.includes("No tool found"));
  }
});

test("action=call retries transient transport errors and reports retries count", async () => {
  MockTransport.behaviors.set("mock://retry", {
    tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object" } }],
    callResult: { ok: true },
    callThrowSequence: [
      new Error("Request timeout after 1000ms"),
      new Error("fetch failed: socket hang up")
    ]
  });

  const router = makeRouter(
    { retry: { transport: "sse", url: "mock://retry" } },
    { retry: { maxAttempts: 3, delayMs: 1, backoffMultiplier: 1, retryOn: ["timeout", "connection_error"] } }
  );

  const result = await router.dispatch("retry", "call", "ping", {});
  assert.equal("error" in result, false);
  if (!('error' in result) && result.action === "call") {
    assert.deepEqual(result.result, { ok: true });
    assert.equal(result.retries, 2);
  }

  const instance = MockTransport.instances.get("mock://retry");
  assert.ok(instance);
  const callCount = instance!.requests.filter((req) => req.method === "tools/call").length;
  assert.equal(callCount, 3);
});

test("action=call does not retry on non-transient transport errors", async () => {
  MockTransport.behaviors.set("mock://noretry", {
    tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object" } }],
    callThrowSequence: [new Error("invalid params from client")]
  });

  const router = makeRouter(
    { noretry: { transport: "sse", url: "mock://noretry" } },
    { retry: { maxAttempts: 3, delayMs: 1, backoffMultiplier: 1, retryOn: ["timeout", "connection_error"] } }
  );

  const result = await router.dispatch("noretry", "call", "ping", {});
  assert.ok("error" in result);

  const instance = MockTransport.instances.get("mock://noretry");
  assert.ok(instance);
  const callCount = instance!.requests.filter((req) => req.method === "tools/call").length;
  assert.equal(callCount, 1);
});

test("server retry config overrides global retry config", async () => {
  MockTransport.behaviors.set("mock://override", {
    tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object" } }],
    callThrowSequence: [new Error("Request timeout after 1000ms"), new Error("Request timeout after 1000ms")]
  });

  const router = makeRouter(
    {
      override: {
        transport: "sse",
        url: "mock://override",
        retry: { maxAttempts: 1, delayMs: 1, backoffMultiplier: 1, retryOn: ["timeout"] }
      }
    },
    { retry: { maxAttempts: 3, delayMs: 1, backoffMultiplier: 1, retryOn: ["timeout"] } }
  );

  const result = await router.dispatch("override", "call", "ping", {});
  assert.ok("error" in result);

  const instance = MockTransport.instances.get("mock://override");
  assert.ok(instance);
  const callCount = instance!.requests.filter((req) => req.method === "tools/call").length;
  assert.equal(callCount, 1);
});

test("shutdown closes transports via shutdown()", async () => {
  MockTransport.behaviors.set("mock://shutdown", {
    tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object" } }]
  });

  const router = makeRouter({ s: { transport: "sse", url: "mock://shutdown" } });
  await router.dispatch("s", "list");

  await router.shutdown(10);

  const instance = MockTransport.instances.get("mock://shutdown");
  assert.ok(instance);
  assert.equal(instance!.shutdownCount, 1);
  assert.equal(instance!.isConnected(), false);
});

test("shutdown clears result cache", async () => {
  MockTransport.behaviors.set("mock://cache-shutdown", {
    tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object" } }],
    callResult: { ok: true }
  });

  const router = makeRouter(
    { s: { transport: "sse", url: "mock://cache-shutdown" } },
    { resultCache: { enabled: true } }
  );

  await router.dispatch("s", "call", "ping", { a: 1 });
  await router.dispatch("s", "call", "ping", { a: 1 });

  let instance = MockTransport.instances.get("mock://cache-shutdown");
  assert.ok(instance);
  let callCount = instance!.requests.filter((req) => req.method === "tools/call").length;
  assert.equal(callCount, 1);

  await router.shutdown();

  await router.dispatch("s", "call", "ping", { a: 1 });
  instance = MockTransport.instances.get("mock://cache-shutdown");
  assert.ok(instance);
  callCount = instance!.requests.filter((req) => req.method === "tools/call").length;
  assert.equal(callCount, 1);
});

// ─── Security integration tests ──────────────────────────────────────────────

test("security: tool filter hides tools from getToolList", async () => {
  MockTransport.behaviors.set("mock://filter", {
    tools: [
      { name: "safe", description: "Safe tool", inputSchema: { type: "object" } },
      { name: "dangerous", description: "Dangerous tool", inputSchema: { type: "object" } },
    ],
  });

  const router = makeRouter({
    filtered: { transport: "sse", url: "mock://filter", toolFilter: { deny: ["dangerous"] } },
  });

  const result = await router.dispatch("filtered", "list");
  assert.equal("error" in result, false);
  if (!("error" in result) && result.action === "list") {
    assert.equal(result.tools.length, 1);
    assert.equal(result.tools[0].name, "safe");
  }
});

test("security: deny list blocks dispatch call", async () => {
  MockTransport.behaviors.set("mock://deny", {
    tools: [
      { name: "allowed", description: "OK", inputSchema: { type: "object" } },
      { name: "blocked", description: "No", inputSchema: { type: "object" } },
    ],
  });

  const router = makeRouter({
    deny: { transport: "sse", url: "mock://deny", toolFilter: { deny: ["blocked"] } },
  });

  const result = await router.dispatch("deny", "call", "blocked");
  assert.ok("error" in result);
  if ("error" in result) {
    assert.equal(result.error, "unknown_tool");
  }
});

test("security: trust=untrusted wraps call result", async () => {
  MockTransport.behaviors.set("mock://untrust", {
    tools: [{ name: "read", description: "Read", inputSchema: { type: "object" } }],
    callResult: { data: "secret" },
  });

  const router = makeRouter({
    untrust: { transport: "sse", url: "mock://untrust", trust: "untrusted" },
  });

  const result = await router.dispatch("untrust", "call", "read");
  assert.equal("error" in result, false);
  if (!("error" in result) && result.action === "call") {
    assert.equal(result.result._trust, "untrusted");
    assert.equal(result.result._server, "untrust");
    assert.deepEqual(result.result.result, { data: "secret" });
  }
});

test("security: trust=sanitize strips HTML from call result", async () => {
  MockTransport.behaviors.set("mock://san", {
    tools: [{ name: "get", description: "Get", inputSchema: { type: "object" } }],
    callResult: { content: [{ type: "text", text: "<script>alert(1)</script>Hello" }] },
  });

  const router = makeRouter({
    san: { transport: "sse", url: "mock://san", trust: "sanitize" },
  });

  const result = await router.dispatch("san", "call", "get");
  assert.equal("error" in result, false);
  if (!("error" in result) && result.action === "call") {
    assert.ok(!JSON.stringify(result.result).includes("<script>"));
    assert.ok(JSON.stringify(result.result).includes("Hello"));
  }
});

test("security: maxResultChars truncates large results", async () => {
  MockTransport.behaviors.set("mock://big", {
    tools: [{ name: "dump", description: "Dump", inputSchema: { type: "object" } }],
    callResult: { data: "x".repeat(500) },
  });

  const router = makeRouter(
    { big: { transport: "sse", url: "mock://big" } },
    { maxResultChars: 50 }
  );

  const result = await router.dispatch("big", "call", "dump");
  assert.equal("error" in result, false);
  if (!("error" in result) && result.action === "call") {
    assert.equal(result.result._truncated, true);
    assert.equal(typeof result.result._originalLength, "number");
    // JSON-aware truncation: result is smaller than original but exact size varies
    const resultStr = typeof result.result.result === "string" ? result.result.result : JSON.stringify(result.result.result);
    assert.ok(resultStr.length < 500, "result should be truncated");
  }
});

test("security: pipeline order - truncate then trust-tag", async () => {
  MockTransport.behaviors.set("mock://pipe", {
    tools: [{ name: "tool", description: "Tool", inputSchema: { type: "object" } }],
    callResult: { data: "x".repeat(500) },
  });

  const router = makeRouter(
    { pipe: { transport: "sse", url: "mock://pipe", trust: "untrusted", maxResultChars: 30 } },
  );

  const result = await router.dispatch("pipe", "call", "tool");
  assert.equal("error" in result, false);
  if (!("error" in result) && result.action === "call") {
    // Flat metadata: trust + truncation at top level (no nesting)
    assert.equal(result.result._trust, "untrusted");
    assert.equal(result.result._truncated, true);
    assert.equal(typeof result.result.result, "string");
  }
});

test("action=intent requires intent parameter", async () => {
  const router = makeRouter({ s: { transport: "sse", url: "mock://s" } });
  const result = await router.dispatch(undefined, "intent");
  assert.ok("error" in result);
  if ("error" in result) {
    assert.equal(result.error, "invalid_params");
    assert.ok(result.message.includes("intent"));
  }
});

// ─── Adaptive promotion integration tests ────────────────────────────────────

test("action=promotions returns stats", async () => {
  MockTransport.behaviors.set("mock://promo", {
    tools: [
      { name: "tool_a", description: "Tool A", inputSchema: { type: "object" } },
      { name: "tool_b", description: "Tool B", inputSchema: { type: "object" } }
    ],
    callResult: { ok: true }
  });

  const router = makeRouter(
    { promo: { transport: "sse", url: "mock://promo" } },
    { adaptivePromotion: { enabled: true, minCalls: 2, windowMs: 60_000 } }
  );

  await router.dispatch("promo", "call", "tool_a");
  await router.dispatch("promo", "call", "tool_a");
  await router.dispatch("promo", "call", "tool_b");

  const result = await router.dispatch(undefined, "promotions");
  assert.equal("error" in result, false);
  if ("action" in result && result.action === "promotions") {
    assert.equal(result.promoted.length, 1);
    assert.equal(result.promoted[0].tool, "tool_a");
    assert.equal(result.promoted[0].callCount, 2);
    assert.equal(result.stats.length, 2);
  }
});

test("recordCall is called after successful tool dispatch", async () => {
  MockTransport.behaviors.set("mock://track", {
    tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object" } }],
    callResult: { pong: true }
  });

  const router = makeRouter(
    { track: { transport: "sse", url: "mock://track" } },
    { adaptivePromotion: { enabled: true, minCalls: 1, windowMs: 60_000 } }
  );

  await router.dispatch("track", "call", "ping");

  const result = await router.dispatch(undefined, "promotions");
  if ("action" in result && result.action === "promotions") {
    assert.equal(result.promoted.length, 1);
    assert.equal(result.promoted[0].server, "track");
    assert.equal(result.promoted[0].tool, "ping");
  }
});

test("getPromotedTools returns tool metadata", async () => {
  MockTransport.behaviors.set("mock://meta", {
    tools: [{
      name: "create_issue",
      description: "Create a GitHub issue",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"]
      }
    }],
    callResult: { id: 1 }
  });

  const router = makeRouter(
    { meta: { transport: "sse", url: "mock://meta" } },
    { adaptivePromotion: { enabled: true, minCalls: 1, windowMs: 60_000 } }
  );

  await router.dispatch("meta", "call", "create_issue", { title: "test" });

  const promoted = router.getPromotedTools();
  assert.equal(promoted.length, 1);
  assert.equal(promoted[0].server, "meta");
  assert.equal(promoted[0].tool, "create_issue");
  assert.ok(promoted[0].toolHint);
  assert.equal(promoted[0].toolHint.name, "create_issue");
  assert.ok(promoted[0].inputSchema);
  assert.deepEqual(promoted[0].inputSchema.required, ["title"]);
});
