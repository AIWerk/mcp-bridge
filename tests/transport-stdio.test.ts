import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StdioTransport } from "../src/transport-stdio.ts";
import type { McpServerConfig, McpClientConfig, Logger } from "../src/types.ts";

function makeLogger(): Logger {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };
}

/** Inline MCP echo server script for child process spawning. */
const ECHO_SERVER_SCRIPT = `
  process.stdout.write("\\n"); // readiness signal for startup timeout gate
  const readline = require("readline");
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    let req;
    try { req = JSON.parse(line); } catch { return; }
    if (req.method === "initialize") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0", id: req.id,
        result: { protocolVersion: "2025-06-18", serverInfo: { name: "echo", version: "1.0" }, capabilities: { tools: {} } }
      }) + "\\n");
    } else if (req.method === "notifications/initialized") {
      // no-op, no response
    } else if (req.method === "tools/list") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0", id: req.id,
        result: { tools: [{ name: "echo", description: "Echo tool", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] }
      }) + "\\n");
    } else if (req.method === "tools/call") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0", id: req.id,
        result: { content: [{ type: "text", text: "echoed: " + (req.params && req.params.arguments && req.params.arguments.text || "") }] }
      }) + "\\n");
    }
  });
`;

function makeEchoTransport(extraClient: Partial<McpClientConfig> = {}): StdioTransport {
  const config: McpServerConfig = {
    transport: "stdio",
    command: process.execPath,
    args: ["-e", ECHO_SERVER_SCRIPT],
  };
  const clientConfig: McpClientConfig = {
    servers: {},
    connectionTimeoutMs: 5000,
    requestTimeoutMs: 5000,
    reconnectIntervalMs: 60000, // long to avoid reconnect during tests
    ...extraClient,
  };
  return new StdioTransport(config, clientConfig, makeLogger());
}

test("stdio transport: connect and tools/list", async () => {
  const transport = makeEchoTransport();

  try {
    await transport.connect();
    assert.ok(transport.isConnected());

    // Initialize protocol
    const initRes = await transport.sendRequest({
      jsonrpc: "2.0",
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    });
    assert.ok(initRes.result);
    assert.equal(initRes.result.serverInfo.name, "echo");

    await transport.sendNotification({ jsonrpc: "2.0", method: "notifications/initialized" });

    // tools/list
    const toolsRes = await transport.sendRequest({ jsonrpc: "2.0", method: "tools/list" });
    assert.ok(Array.isArray(toolsRes.result?.tools));
    assert.equal(toolsRes.result.tools.length, 1);
    assert.equal(toolsRes.result.tools[0].name, "echo");
  } finally {
    await transport.disconnect();
  }
});

test("stdio transport: tool call round-trip", async () => {
  const transport = makeEchoTransport();

  try {
    await transport.connect();

    await transport.sendRequest({
      jsonrpc: "2.0",
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    });
    await transport.sendNotification({ jsonrpc: "2.0", method: "notifications/initialized" });

    const callRes = await transport.sendRequest({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "echo", arguments: { text: "hello world" } },
    });

    assert.ok(callRes.result);
    assert.equal(callRes.result.content[0].text, "echoed: hello world");
  } finally {
    await transport.disconnect();
  }
});

test("stdio transport: disconnect cleans up", async () => {
  const transport = makeEchoTransport();

  await transport.connect();
  assert.ok(transport.isConnected());

  await transport.disconnect();
  assert.equal(transport.isConnected(), false);
});

test("stdio transport: shutdown terminates process", async () => {
  const transport = makeEchoTransport();

  await transport.connect();
  assert.ok(transport.isConnected());

  await transport.shutdown?.(200);
  assert.equal(transport.isConnected(), false);
});

test("stdio transport: process crash triggers disconnect", async () => {
  // Server that exits immediately after first message
  const crashScript = `
    process.stdout.write("\\n"); // readiness signal for startup timeout gate
    const readline = require("readline");
    const rl = readline.createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      const req = JSON.parse(line);
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0", id: req.id,
        result: { protocolVersion: "2025-06-18", serverInfo: { name: "crash", version: "1.0" }, capabilities: { tools: {} } }
      }) + "\\n");
      setTimeout(() => process.exit(1), 50);
    });
  `;

  const config: McpServerConfig = {
    transport: "stdio",
    command: process.execPath,
    args: ["-e", crashScript],
  };
  const clientConfig: McpClientConfig = {
    servers: {},
    connectionTimeoutMs: 5000,
    requestTimeoutMs: 5000,
    reconnectIntervalMs: 300000, // very long to prevent reconnect
  };
  const transport = new StdioTransport(config, clientConfig, makeLogger());

  try {
    await transport.connect();

    // Send initialize to trigger crash
    await transport.sendRequest({
      jsonrpc: "2.0",
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    });

    // Wait for process to exit
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.equal(transport.isConnected(), false);
  } finally {
    await transport.disconnect().catch(() => {});
  }
});

test("stdio transport: connection timeout proceeds optimistically on non-responsive process", async () => {
  // Server that never writes to stdout — simulates servers that wait for initialize
  const silentScript = `setTimeout(() => {}, 60000);`;

  const config: McpServerConfig = {
    transport: "stdio",
    command: process.execPath,
    args: ["-e", silentScript],
  };
  const clientConfig: McpClientConfig = {
    servers: {},
    connectionTimeoutMs: 500, // short timeout
    requestTimeoutMs: 1000,
    reconnectIntervalMs: 300000,
  };
  const transport = new StdioTransport(config, clientConfig, makeLogger());

  // connect() should resolve optimistically (not reject) — the process is still running,
  // initializeProtocol() will validate the connection afterwards
  await transport.connect();

  assert.equal(transport.isConnected(), true);
  await transport.disconnect().catch(() => {});
});

test("stdio transport: writes configFiles and substitutes ${CONFIG_DIR} in args before spawn", async () => {
  // Echo server that reports back its own argv, so the test can verify the
  // actual spawned command line — proof the file was written AND the
  // ${CONFIG_DIR} arg placeholder was substituted, without relying on
  // internals of transport-stdio. Written to a real script file (not -e)
  // so process.argv slicing behaves like a normal CLI invocation.
  const tempBase = mkdtempSync(join(tmpdir(), "mcp-bridge-configfiles-wiring-"));
  const scriptPath = join(tempBase, "argv-echo-server.cjs");
  writeFileSync(
    scriptPath,
    `
    process.stdout.write("\\n"); // readiness signal
    const readline = require("readline");
    const rl = readline.createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      let req;
      try { req = JSON.parse(line); } catch { return; }
      if (req.method === "initialize") {
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0", id: req.id,
          result: { protocolVersion: "2025-06-18", serverInfo: { name: "argv-echo", version: "1.0" }, capabilities: { tools: {} } }
        }) + "\\n");
      } else if (req.method === "tools/call") {
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0", id: req.id,
          result: { content: [{ type: "text", text: JSON.stringify(process.argv.slice(2)) }] }
        }) + "\\n");
      }
    });
    `
  );

  const original = process.env.MCP_BRIDGE_CONFIG_FILES_DIR;
  process.env.MCP_BRIDGE_CONFIG_FILES_DIR = tempBase;

  const config: McpServerConfig = {
    transport: "stdio",
    command: process.execPath,
    args: [scriptPath, "--config=${CONFIG_DIR}/dbhub.toml", "--dsn=${DSN}"],
    env: { DSN: "postgres://user:pass@host/db" },
    configFiles: [{ name: "dbhub.toml", content: '[[sources]]\nid = "default"\ndsn = "${DSN}"\n' }],
  };
  const clientConfig: McpClientConfig = {
    servers: {},
    connectionTimeoutMs: 5000,
    requestTimeoutMs: 5000,
    reconnectIntervalMs: 300000,
  };
  const transport = new StdioTransport(config, clientConfig, makeLogger(), undefined, undefined, undefined, "test-dbhub");

  try {
    await transport.connect();

    await transport.sendRequest({
      jsonrpc: "2.0",
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    });
    await transport.sendNotification({ jsonrpc: "2.0", method: "notifications/initialized" });

    const callRes = await transport.sendRequest({ jsonrpc: "2.0", method: "tools/call", params: { name: "getArgv" } });
    const receivedArgs = JSON.parse(callRes.result.content[0].text);
    const expectedConfigDir = join(tempBase, "test-dbhub");

    assert.deepStrictEqual(receivedArgs, [
      `--config=${expectedConfigDir}/dbhub.toml`,
      "--dsn=postgres://user:pass@host/db",
    ]);

    const written = readFileSync(join(expectedConfigDir, "dbhub.toml"), "utf-8");
    assert.equal(written, '[[sources]]\nid = "default"\ndsn = "${DSN}"\n');
  } finally {
    await transport.disconnect().catch(() => {});
    if (original === undefined) delete process.env.MCP_BRIDGE_CONFIG_FILES_DIR;
    else process.env.MCP_BRIDGE_CONFIG_FILES_DIR = original;
    rmSync(tempBase, { recursive: true, force: true });
  }
});

test("stdio transport: throws if configFiles set but serverName missing", async () => {
  const config: McpServerConfig = {
    transport: "stdio",
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 60000);"],
    configFiles: [{ name: "dbhub.toml", content: "x = 1\n" }],
  };
  const clientConfig: McpClientConfig = {
    servers: {},
    connectionTimeoutMs: 500,
    requestTimeoutMs: 1000,
    reconnectIntervalMs: 300000,
  };
  // No serverName passed (7th ctor arg omitted) — configFiles has no dir to write into.
  const transport = new StdioTransport(config, clientConfig, makeLogger());

  await assert.rejects(() => transport.connect(), /serverName is required to write configFiles/);
});
