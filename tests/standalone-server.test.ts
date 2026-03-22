import test from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { StandaloneServer } from "../src/standalone-server.ts";
import type { BridgeConfig, Logger, McpResponse, McpTransport } from "../src/types.ts";

function makeLogger(): Logger {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };
}

function makeServer(overrides: Partial<BridgeConfig> = {}): StandaloneServer {
  const config: BridgeConfig = {
    servers: {},
    mode: "router",
    ...overrides,
  };
  return new StandaloneServer(config, makeLogger());
}

// ── Router mode ──────────────────────────────────────────────────────

test("router mode: initialize returns correct serverInfo", async () => {
  const server = makeServer({ mode: "router" });

  const res = await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  });

  assert.equal(res.result?.serverInfo.name, "mcp-bridge");
  assert.equal(res.result?.protocolVersion, "2025-06-18");
  assert.ok(res.result?.serverInfo.version);
  assert.ok(res.result?.capabilities.tools);
});

test("router mode: tools/list returns mcp meta-tool", async () => {
  const server = makeServer({ mode: "router" });
  await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize" });

  const res = await server.handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" });

  assert.ok(Array.isArray(res.result?.tools));
  assert.equal(res.result.tools.length, 1);
  assert.equal(res.result.tools[0].name, "mcp");
  assert.ok(res.result.tools[0].inputSchema);
});

test("router mode: handleToolsCall with unknown tool returns error", async () => {
  const server = makeServer({ mode: "router" });
  await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize" });

  const res = await server.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "nonexistent", arguments: {} },
  });

  assert.ok(res.error);
  assert.match(res.error.message, /Unknown tool.*nonexistent/);
});

test("router mode: handleToolsCall missing tool name returns error", async () => {
  const server = makeServer({ mode: "router" });
  await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize" });

  const res = await server.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {},
  });

  assert.ok(res.error);
  assert.match(res.error.message, /Missing tool name/);
});

// ── Direct mode ──────────────────────────────────────────────────────

test("direct mode: initialize returns correct serverInfo", async () => {
  const server = makeServer({ mode: "direct" });

  const res = await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  });

  assert.equal(res.result?.serverInfo.name, "mcp-bridge");
  assert.equal(res.result?.protocolVersion, "2025-06-18");
});

test("direct mode: tools/list returns prefixed tools from backends", async () => {
  const server = makeServer({ mode: "direct" });
  await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize" });

  // Pre-populate direct tools (bypasses real discovery)
  const directTools = [
    { serverName: "backend1", originalName: "greet", registeredName: "backend1__greet", description: "Say hi", inputSchema: { type: "object" } },
    { serverName: "backend1", originalName: "bye", registeredName: "backend1__bye", description: "Say bye", inputSchema: { type: "object" } },
  ];
  (server as any).directTools = directTools;

  const res = await server.handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" });

  assert.ok(Array.isArray(res.result?.tools));
  assert.equal(res.result.tools.length, 2);
  assert.equal(res.result.tools[0].name, "backend1__greet");
  assert.equal(res.result.tools[1].name, "backend1__bye");
});

test("direct mode: handleToolsCall routes to correct backend", async () => {
  const server = makeServer({ mode: "direct" });
  await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize" });

  // Set up mock transport
  const mockTransport: McpTransport = {
    connect: async () => {},
    disconnect: async () => {},
    sendNotification: async () => {},
    isConnected: () => true,
    sendRequest: async (req) => ({
      jsonrpc: "2.0" as const,
      id: req.id ?? 0,
      result: { content: [{ type: "text", text: "hello from backend" }] },
    }),
  };

  (server as any).directTools = [
    { serverName: "srv1", originalName: "echo", registeredName: "srv1__echo", description: "Echo", inputSchema: { type: "object" } },
  ];
  (server as any).directConnections = new Map([
    ["srv1", { transport: mockTransport, initialized: true }],
  ]);

  const res = await server.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "srv1__echo", arguments: { text: "hi" } },
  });

  assert.ok(res.result);
  assert.equal(res.result.content[0].text, "hello from backend");
});

test("direct mode: handleToolsCall unknown tool returns error", async () => {
  const server = makeServer({ mode: "direct" });
  await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize" });
  (server as any).directTools = [];

  const res = await server.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "no_such_tool", arguments: {} },
  });

  assert.ok(res.error);
  assert.equal(res.error.code, -32004);
  assert.match(res.error.message, /Unknown tool/);
});

test("direct mode: handleToolsCall with disconnected backend returns error", async () => {
  const server = makeServer({ mode: "direct" });
  await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize" });

  const disconnectedTransport: McpTransport = {
    connect: async () => {},
    disconnect: async () => {},
    sendNotification: async () => {},
    isConnected: () => false,
    sendRequest: async () => ({ jsonrpc: "2.0" as const, id: 0, result: {} }),
  };

  (server as any).directTools = [
    { serverName: "srv1", originalName: "echo", registeredName: "echo", description: "Echo", inputSchema: { type: "object" } },
  ];
  (server as any).directConnections = new Map([
    ["srv1", { transport: disconnectedTransport, initialized: true }],
  ]);

  const res = await server.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "echo", arguments: {} },
  });

  assert.ok(res.error);
  assert.match(res.error.message, /not connected/);
});

// ── Protocol edge cases ──────────────────────────────────────────────

test("tools/list before initialize returns error", async () => {
  const server = makeServer();

  const res = await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });

  assert.ok(res.error);
  assert.equal(res.error.code, -32002);
  assert.match(res.error.message, /not initialized/i);
});

test("tools/call before initialize returns error", async () => {
  const server = makeServer();

  const res = await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "mcp", arguments: {} },
  });

  assert.ok(res.error);
  assert.equal(res.error.code, -32002);
});

test("notifications/initialized returns result (no-op)", async () => {
  const server = makeServer();

  const res = await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "notifications/initialized",
  });

  assert.ok(res.result);
  assert.deepEqual(res.result, {});
});

test("ping returns empty result", async () => {
  const server = makeServer();

  const res = await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "ping" });

  assert.ok(res.result);
  assert.deepEqual(res.result, {});
});

test("unknown method returns -32601 error", async () => {
  const server = makeServer();
  await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize" });

  const res = await server.handleRequest({ jsonrpc: "2.0", id: 2, method: "resources/list" });

  assert.ok(res.error);
  assert.equal(res.error.code, -32601);
  assert.match(res.error.message, /Method not found/);
});

// ── Stdio framing (via processLine / startStdio-like integration) ────

test("newline-delimited JSON framing: request parsed correctly", async () => {
  const server = makeServer();
  const outputChunks: string[] = [];

  // Access private processLine via casting
  const processLine = (server as any).processLine.bind(server);
  const mockStdout = new Writable({
    write(chunk, _encoding, callback) {
      outputChunks.push(chunk.toString());
      callback();
    },
  }) as unknown as NodeJS.WriteStream;

  processLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }), mockStdout);

  // processLine is async internally; give it a tick
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(outputChunks.length, 1);
  const parsed = JSON.parse(outputChunks[0].trim());
  assert.equal(parsed.id, 1);
  assert.ok(parsed.result?.serverInfo);
});

test("processLine with invalid JSON returns parse error", async () => {
  const server = makeServer();
  const outputChunks: string[] = [];

  const processLine = (server as any).processLine.bind(server);
  const mockStdout = new Writable({
    write(chunk, _encoding, callback) {
      outputChunks.push(chunk.toString());
      callback();
    },
  }) as unknown as NodeJS.WriteStream;

  processLine("not valid json{{{", mockStdout);

  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(outputChunks.length, 1);
  const parsed = JSON.parse(outputChunks[0].trim());
  assert.ok(parsed.error);
  assert.equal(parsed.error.code, -32700);
});

test("processLine with notification (no id) does not produce response", async () => {
  const server = makeServer();
  const outputChunks: string[] = [];

  const processLine = (server as any).processLine.bind(server);
  const mockStdout = new Writable({
    write(chunk, _encoding, callback) {
      outputChunks.push(chunk.toString());
      callback();
    },
  }) as unknown as NodeJS.WriteStream;

  processLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), mockStdout);

  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(outputChunks.length, 0, "notifications should not produce a response");
});

// ── Shutdown ─────────────────────────────────────────────────────────

test("shutdown disconnects all direct connections", async () => {
  const server = makeServer({ mode: "direct" });
  let disconnected = false;

  const mockTransport: McpTransport = {
    connect: async () => {},
    disconnect: async () => { disconnected = true; },
    sendNotification: async () => {},
    isConnected: () => true,
    sendRequest: async () => ({ jsonrpc: "2.0" as const, id: 0, result: {} }),
  };

  (server as any).directConnections = new Map([
    ["srv1", { transport: mockTransport, initialized: true }],
  ]);

  await server.shutdown();

  assert.ok(disconnected);
  assert.equal((server as any).directConnections.size, 0);
});
