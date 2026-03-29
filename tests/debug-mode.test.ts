import test from "node:test";
import assert from "node:assert/strict";
import { McpRouter } from "../src/mcp-router.js";
import type { McpRequest, McpResponse, McpServerConfig, McpClientConfig, McpTransport, McpTool } from "../src/types.js";

type MockBehavior = {
  tools: McpTool[];
  callResult?: any;
  callError?: { code: number; message: string };
};

class MockTransport implements McpTransport {
  static behaviors = new Map<string, MockBehavior>();

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

  isConnected(): boolean {
    return this.connected;
  }

  async sendRequest(request: McpRequest): Promise<McpResponse> {
    const behavior = MockTransport.behaviors.get(this.key);
    if (!behavior) {
      throw new Error(`No behavior set for ${this.key}`);
    }

    if (request.method === "initialize") {
      return {
        jsonrpc: "2.0",
        id: request.id!,
        result: {
          protocolVersion: "0.1.0",
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "test", version: "1.0.0" }
        }
      };
    }

    if (request.method === "tools/list") {
      return {
        jsonrpc: "2.0",
        id: request.id!,
        result: { tools: behavior.tools }
      };
    }

    if (request.method === "tools/call") {
      if (behavior.callError) {
        return {
          jsonrpc: "2.0",
          id: request.id!,
          error: behavior.callError
        };
      }
      return {
        jsonrpc: "2.0",
        id: request.id!,
        result: behavior.callResult || "mock result"
      };
    }

    throw new Error(`Unexpected request: ${request.method}`);
  }

  async sendNotification(): Promise<void> {
    // Mock implementation
  }
}

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

test("debug mode enabled - includes _debug metadata in responses", async () => {
  MockTransport.reset();

  const servers: Record<string, McpServerConfig> = {
    test1: { transport: "stdio", command: "test1" },
  };

  const clientConfig: McpClientConfig = {
    servers,
    debug: true,
  };

  MockTransport.behaviors.set("test1", {
    tools: [
      {
        name: "test_tool",
        description: "A test tool",
        inputSchema: {
          type: "object",
          properties: {
            message: { type: "string" }
          },
          required: ["message"]
        }
      }
    ],
    callResult: { response: "test response" }
  });

  const router = new McpRouter(servers, clientConfig, logger, {
    stdio: MockTransport as any
  });

  // Make a tool call
  const startTime = Date.now();
  const response = await router.dispatch("test1", "call", "test_tool", { message: "hello" });
  const endTime = Date.now();

  assert.equal("error" in response, false, "Response should not have error");
  if ("error" in response) return;

  assert.equal(response.action, "call");
  assert.equal(response.server, "test1");
  assert.equal(response.tool, "test_tool");
  assert.deepEqual(response.result, { response: "test response" });

  // Check debug metadata
  assert.ok("_debug" in response, "_debug should be present when debug=true");
  if ("_debug" in response) {
    const debug = response._debug;
    assert.equal(debug.server, "test1");
    assert.equal(debug.tool, "test_tool");
    assert.equal(debug.transport, "stdio");
    assert.ok(typeof debug.latencyMs === "number", "latencyMs should be a number");
    assert.ok(debug.latencyMs >= 0, "latencyMs should be non-negative");
    assert.ok(debug.latencyMs <= (endTime - startTime + 100), "latencyMs should be reasonable"); // +100ms buffer
  }
});

test("debug mode disabled - no _debug metadata in responses", async () => {
  MockTransport.reset();

  const servers: Record<string, McpServerConfig> = {
    test1: { transport: "stdio", command: "test1" },
  };

  const clientConfig: McpClientConfig = {
    servers,
    debug: false,
  };

  MockTransport.behaviors.set("test1", {
    tools: [
      {
        name: "test_tool",
        description: "A test tool",
        inputSchema: {
          type: "object",
          properties: {
            message: { type: "string" }
          },
          required: ["message"]
        }
      }
    ],
    callResult: { response: "test response" }
  });

  const router = new McpRouter(servers, clientConfig, logger, {
    stdio: MockTransport as any
  });

  const response = await router.dispatch("test1", "call", "test_tool", { message: "hello" });

  assert.equal("error" in response, false, "Response should not have error");
  if ("error" in response) return;

  assert.equal(response.action, "call");
  assert.equal(response.server, "test1");
  assert.equal(response.tool, "test_tool");
  assert.deepEqual(response.result, { response: "test response" });

  // Check no debug metadata
  assert.ok(!("_debug" in response), "_debug should not be present when debug=false");
});

test("debug mode undefined - no _debug metadata in responses", async () => {
  MockTransport.reset();

  const servers: Record<string, McpServerConfig> = {
    test1: { transport: "stdio", command: "test1" },
  };

  const clientConfig: McpClientConfig = {
    servers,
    // debug is undefined
  };

  MockTransport.behaviors.set("test1", {
    tools: [
      {
        name: "test_tool",
        description: "A test tool",
        inputSchema: {
          type: "object",
          properties: {
            message: { type: "string" }
          },
          required: ["message"]
        }
      }
    ],
    callResult: { response: "test response" }
  });

  const router = new McpRouter(servers, clientConfig, logger, {
    stdio: MockTransport as any
  });

  const response = await router.dispatch("test1", "call", "test_tool", { message: "hello" });

  assert.equal("error" in response, false, "Response should not have error");
  if ("error" in response) return;

  assert.equal(response.action, "call");
  assert.equal(response.server, "test1");
  assert.equal(response.tool, "test_tool");
  assert.deepEqual(response.result, { response: "test response" });

  // Check no debug metadata
  assert.ok(!("_debug" in response), "_debug should not be present when debug is undefined");
});

test("debug mode enabled - cached results include _debug with cached flag", async () => {
  MockTransport.reset();

  const servers: Record<string, McpServerConfig> = {
    test1: { transport: "stdio", command: "test1" },
  };

  const clientConfig: McpClientConfig = {
    servers,
    debug: true,
    resultCache: {
      enabled: true,
      maxEntries: 100,
      defaultTtlMs: 60000,
    }
  };

  MockTransport.behaviors.set("test1", {
    tools: [
      {
        name: "test_tool",
        description: "A test tool",
        inputSchema: {
          type: "object",
          properties: {
            message: { type: "string" }
          },
          required: ["message"]
        }
      }
    ],
    callResult: { response: "test response" }
  });

  const router = new McpRouter(servers, clientConfig, logger, {
    stdio: MockTransport as any
  });

  // First call - should not be cached
  const response1 = await router.dispatch("test1", "call", "test_tool", { message: "hello" });
  assert.equal("error" in response1, false);
  if ("error" in response1) return;
  assert.ok("_debug" in response1);
  if ("_debug" in response1) {
    assert.ok(!("cached" in response1._debug), "First call should not have cached flag");
  }

  // Second call with same params - should be cached
  const response2 = await router.dispatch("test1", "call", "test_tool", { message: "hello" });
  assert.equal("error" in response2, false);
  if ("error" in response2) return;
  assert.ok("_debug" in response2);
  if ("_debug" in response2) {
    assert.equal(response2._debug.cached, true, "Second call should have cached=true");
  }
});

test("debug mode enabled - batch calls include _debug in each result", async () => {
  MockTransport.reset();

  const servers: Record<string, McpServerConfig> = {
    test1: { transport: "stdio", command: "test1" },
  };

  const clientConfig: McpClientConfig = {
    servers,
    debug: true,
  };

  MockTransport.behaviors.set("test1", {
    tools: [
      {
        name: "test_tool",
        description: "A test tool",
        inputSchema: {
          type: "object",
          properties: {
            message: { type: "string" }
          },
          required: ["message"]
        }
      }
    ],
    callResult: { response: "test response" }
  });

  const router = new McpRouter(servers, clientConfig, logger, {
    stdio: MockTransport as any
  });

  const response = await router.dispatch(undefined, "batch", undefined, {
    calls: [
      { server: "test1", tool: "test_tool", params: { message: "hello1" } },
      { server: "test1", tool: "test_tool", params: { message: "hello2" } },
    ]
  });

  assert.equal("error" in response, false);
  if ("error" in response) return;

  assert.equal(response.action, "batch");
  assert.equal(response.results.length, 2);

  // Check that each batch result has debug info
  for (const result of response.results) {
    assert.ok("_debug" in result, "Batch result should include _debug");
    if ("_debug" in result) {
      assert.equal(result._debug.server, "test1");
      assert.equal(result._debug.tool, "test_tool");
      assert.equal(result._debug.transport, "stdio");
      assert.ok(typeof result._debug.latencyMs === "number");
    }
  }
});
