import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Spawn mcp-bridge in stdio mode with the given config, send a JSON-RPC
 * message, and collect the response.  Returns parsed JSON responses.
 */
function spawnBridge(configPath: string): {
  proc: ReturnType<typeof spawn>;
  send: (msg: object) => void;
  readResponse: () => Promise<object>;
  kill: () => void;
} {
  const proc = spawn(
    process.execPath,
    ["--import", "tsx", "./bin/mcp-bridge.ts", "--config", configPath],
    {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: join(import.meta.dirname!, ".."),
    }
  );

  let buffer = "";
  const pending: Array<(value: object) => void> = [];
  const received: object[] = [];

  proc.stdout!.setEncoding("utf8");
  proc.stdout!.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (pending.length > 0) {
          pending.shift()!(parsed);
        } else {
          received.push(parsed);
        }
      } catch { /* skip non-JSON stderr leak */ }
    }
  });

  return {
    proc,
    send(msg: object) {
      proc.stdin!.write(JSON.stringify(msg) + "\n");
    },
    readResponse(): Promise<object> {
      if (received.length > 0) {
        return Promise.resolve(received.shift()!);
      }
      return new Promise((resolve) => {
        pending.push(resolve);
      });
    },
    kill() {
      proc.stdin!.end();
      proc.kill("SIGTERM");
    },
  };
}

test("integration: stdio initialize and tools/list (router mode)", async (t) => {
  // Create a minimal config with no real servers
  const tmpDir = mkdtempSync(join(tmpdir(), "mcp-bridge-test-"));
  const configPath = join(tmpDir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      mode: "router",
      servers: {},
    })
  );

  let bridge: ReturnType<typeof spawnBridge> | undefined;

  try {
    bridge = spawnBridge(configPath);

    // Wait a moment for the process to start
    await new Promise((resolve) => setTimeout(resolve, 500));

    // 1. Send initialize request
    bridge.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "0.0.1" },
      },
    });

    const initResponse = (await bridge.readResponse()) as {
      jsonrpc: string;
      id: number;
      result?: {
        protocolVersion: string;
        capabilities: object;
        serverInfo: { name: string; version: string };
      };
      error?: object;
    };

    // Verify initialize response
    assert.equal(initResponse.jsonrpc, "2.0");
    assert.equal(initResponse.id, 1);
    assert.ok(initResponse.result, "initialize should return a result");
    assert.equal(initResponse.result!.serverInfo.name, "mcp-bridge");
    assert.ok(initResponse.result!.serverInfo.version, "version should be set");
    assert.equal(initResponse.result!.protocolVersion, "2024-11-05");

    // 2. Send notifications/initialized (no response expected)
    bridge.send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    // 3. Send tools/list request
    bridge.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });

    const toolsResponse = (await bridge.readResponse()) as {
      jsonrpc: string;
      id: number;
      result?: { tools: Array<{ name: string; description: string; inputSchema: object }> };
      error?: object;
    };

    // Verify tools/list response — should contain the mcp meta-tool in router mode
    assert.equal(toolsResponse.jsonrpc, "2.0");
    assert.equal(toolsResponse.id, 2);
    assert.ok(toolsResponse.result, "tools/list should return a result");
    assert.ok(Array.isArray(toolsResponse.result!.tools), "tools should be an array");
    assert.equal(toolsResponse.result!.tools.length, 1, "router mode should expose 1 meta-tool");
    assert.equal(toolsResponse.result!.tools[0].name, "mcp");
  } finally {
    bridge?.kill();
    // Give process time to exit before cleanup
    await new Promise((resolve) => setTimeout(resolve, 200));
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
