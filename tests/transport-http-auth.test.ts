import test from "node:test";
import assert from "node:assert/strict";
import { SseTransport } from "../src/transport-sse.ts";
import { StreamableHttpTransport } from "../src/transport-streamable-http.ts";
import type { Logger, McpClientConfig, McpServerConfig } from "../src/types.ts";

function makeLogger(): Logger {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {}
  };
}

function makeClientConfig(overrides: Partial<McpClientConfig> = {}): McpClientConfig {
  return {
    servers: {},
    connectionTimeoutMs: 200,
    requestTimeoutMs: 500,
    reconnectIntervalMs: 60_000,
    ...overrides
  };
}

test("sse transport merges auth headers (auth overrides config headers)", async () => {
  process.env.__TEST_SSE_TOKEN = "sse-secret";
  const originalFetch = globalThis.fetch;
  const seenHeaders: Array<Record<string, string>> = [];

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("event: endpoint\ndata: /messages\n\n"));
      // Keep stream open so connect() doesn't immediately trigger reconnect path
    }
  });

  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    seenHeaders.push(Object.fromEntries(headers.entries()));
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;

  const config: McpServerConfig = {
    transport: "sse",
    url: "https://example.com/sse",
    headers: {
      Authorization: "Basic legacy",
      "X-Trace": "trace-1"
    },
    auth: {
      type: "bearer",
      token: "${__TEST_SSE_TOKEN}"
    }
  };

  const transport = new SseTransport(config, makeClientConfig(), makeLogger());

  try {
    await transport.connect();
    assert.equal(transport.isConnected(), true);
    assert.ok(seenHeaders.length >= 1);
    const first = seenHeaders[0];
    assert.equal(first.authorization, "Bearer sse-secret");
    assert.equal(first["x-trace"], "trace-1");
    assert.equal(first.accept, "text/event-stream");
  } finally {
    await transport.shutdown?.();
    globalThis.fetch = originalFetch;
    delete process.env.__TEST_SSE_TOKEN;
  }
});

test("streamable-http transport includes auth headers and resolves bearer env vars", async () => {
  process.env.__TEST_HTTP_TOKEN = "http-secret";
  const originalFetch = globalThis.fetch;
  const seenHeaders: Array<Record<string, string>> = [];

  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const method = (init?.method || "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    seenHeaders.push(Object.fromEntries(headers.entries()));

    if (method === "OPTIONS") {
      return new Response(null, { status: 200 });
    }

    if (method === "POST") {
      const rawBody = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(rawBody || "{}");
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: { ok: true } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    return new Response(null, { status: 200 });
  }) as typeof fetch;

  const config: McpServerConfig = {
    transport: "streamable-http",
    url: "https://example.com/mcp",
    headers: {
      Authorization: "Basic old",
      "X-Client": "bridge"
    },
    auth: {
      type: "bearer",
      token: "${__TEST_HTTP_TOKEN}"
    }
  };

  const transport = new StreamableHttpTransport(config, makeClientConfig(), makeLogger());

  try {
    await transport.connect();
    const response = await transport.sendRequest({
      jsonrpc: "2.0",
      method: "tools/list"
    });
    assert.deepEqual(response.result, { ok: true });

    const postHeaders = seenHeaders.find((h) => h["content-type"] === "application/json");
    assert.ok(postHeaders);
    assert.equal(postHeaders!.authorization, "Bearer http-secret");
    assert.equal(postHeaders!["x-client"], "bridge");
  } finally {
    await transport.shutdown?.();
    globalThis.fetch = originalFetch;
    delete process.env.__TEST_HTTP_TOKEN;
  }
});

test("streamable-http shutdown aborts pending requests", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const method = (init?.method || "GET").toUpperCase();

    if (method === "OPTIONS") {
      return new Response(null, { status: 200 });
    }

    if (method === "POST") {
      return await new Promise<Response>((resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(new Error("aborted"));
          return;
        }
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }

    return new Response(null, { status: 200 });
  }) as typeof fetch;

  const config: McpServerConfig = {
    transport: "streamable-http",
    url: "https://example.com/mcp"
  };

  const transport = new StreamableHttpTransport(config, makeClientConfig({ requestTimeoutMs: 10_000 }), makeLogger());

  try {
    await transport.connect();

    const pending = transport.sendRequest({ jsonrpc: "2.0", method: "tools/list" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await transport.shutdown?.();

    await assert.rejects(pending, /Connection closed|aborted/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
