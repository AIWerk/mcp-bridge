import test from "node:test";
import assert from "node:assert/strict";
import { OAuth2TokenManager } from "../src/oauth2-token-manager.ts";
import { resolveAuthHeadersAsync } from "../src/transport-base.ts";
import { StreamableHttpTransport } from "../src/transport-streamable-http.ts";
import type { Logger, McpClientConfig, McpServerConfig } from "../src/types.ts";

function makeLogger(): Logger {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };
}

function makeClientConfig(overrides: Partial<McpClientConfig> = {}): McpClientConfig {
  return {
    servers: {},
    connectionTimeoutMs: 200,
    requestTimeoutMs: 1000,
    reconnectIntervalMs: 60_000,
    ...overrides,
  };
}

test("oauth2 token acquisition and bearer header resolution", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = String(url);
    calls.push(href);

    if (href === "https://auth.example.com/token") {
      const body = String(init?.body || "");
      assert.match(body, /grant_type=client_credentials/);
      assert.match(body, /client_id=client-a/);
      assert.match(body, /client_secret=secret-a/);

      return new Response(
        JSON.stringify({ access_token: "access-1", token_type: "Bearer", expires_in: 3600 }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    throw new Error(`Unexpected fetch: ${href}`);
  }) as typeof fetch;

  const manager = new OAuth2TokenManager(makeLogger());
  const headers = await resolveAuthHeadersAsync(
    {
      transport: "streamable-http",
      url: "https://api.example.com/mcp",
      auth: {
        type: "oauth2",
        clientId: "client-a",
        clientSecret: "secret-a",
        tokenUrl: "https://auth.example.com/token",
      },
    },
    manager
  );

  assert.equal(headers.Authorization, "Bearer access-1");
  assert.equal(calls.length, 1);

  globalThis.fetch = originalFetch;
});

test("oauth2 token caching avoids repeated token fetches", async () => {
  const originalFetch = globalThis.fetch;
  let tokenFetches = 0;

  globalThis.fetch = (async (url: string | URL | Request): Promise<Response> => {
    if (String(url) === "https://auth.example.com/token") {
      tokenFetches += 1;
      return new Response(
        JSON.stringify({ access_token: "cached-token", token_type: "Bearer", expires_in: 3600 }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    throw new Error(`Unexpected fetch: ${String(url)}`);
  }) as typeof fetch;

  const manager = new OAuth2TokenManager(makeLogger());
  const config = {
    clientId: "cache-client",
    clientSecret: "cache-secret",
    tokenUrl: "https://auth.example.com/token",
  };

  const first = await manager.getToken(config);
  const second = await manager.getToken(config);

  assert.equal(first, "cached-token");
  assert.equal(second, "cached-token");
  assert.equal(tokenFetches, 1);

  globalThis.fetch = originalFetch;
});

test("oauth2 refresh token flow runs after expiry", async () => {
  const originalFetch = globalThis.fetch;
  const grantTypes: string[] = [];

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (String(url) === "https://auth.example.com/token") {
      const body = String(init?.body || "");
      const params = new URLSearchParams(body);
      const grantType = params.get("grant_type") || "";
      grantTypes.push(grantType);

      if (grantType === "client_credentials") {
        return new Response(
          JSON.stringify({ access_token: "token-initial", token_type: "Bearer", expires_in: 61, refresh_token: "refresh-1" }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }

      if (grantType === "refresh_token") {
        assert.equal(params.get("refresh_token"), "refresh-1");
        return new Response(
          JSON.stringify({ access_token: "token-refreshed", token_type: "Bearer", expires_in: 3600, refresh_token: "refresh-2" }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
    }

    throw new Error(`Unexpected fetch: ${String(url)}`);
  }) as typeof fetch;

  const manager = new OAuth2TokenManager(makeLogger());
  const config = {
    clientId: "refresh-client",
    clientSecret: "refresh-secret",
    tokenUrl: "https://auth.example.com/token",
  };

  const initial = await manager.getToken(config);
  assert.equal(initial, "token-initial");

  await new Promise((resolve) => setTimeout(resolve, 1200));

  const refreshed = await manager.getToken(config);
  assert.equal(refreshed, "token-refreshed");
  assert.deepEqual(grantTypes, ["client_credentials", "refresh_token"]);

  globalThis.fetch = originalFetch;
});

test("oauth2 invalidate forces token reacquisition", async () => {
  const originalFetch = globalThis.fetch;
  let counter = 0;

  globalThis.fetch = (async (url: string | URL | Request): Promise<Response> => {
    if (String(url) === "https://auth.example.com/token") {
      counter += 1;
      return new Response(
        JSON.stringify({ access_token: `token-${counter}`, token_type: "Bearer", expires_in: 3600 }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    throw new Error(`Unexpected fetch: ${String(url)}`);
  }) as typeof fetch;

  const manager = new OAuth2TokenManager(makeLogger());
  const config = {
    clientId: "invalidate-client",
    clientSecret: "invalidate-secret",
    tokenUrl: "https://auth.example.com/token",
  };

  const first = await manager.getToken(config);
  manager.invalidate(config.tokenUrl, config.clientId);
  const second = await manager.getToken(config);

  assert.equal(first, "token-1");
  assert.equal(second, "token-2");

  globalThis.fetch = originalFetch;
});

test("oauth2 resolves env vars in clientId and clientSecret", async () => {
  const originalFetch = globalThis.fetch;
  process.env.__TEST_OAUTH_CLIENT_ID = "env-client";
  process.env.__TEST_OAUTH_CLIENT_SECRET = "env-secret";

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (String(url) === "https://auth.example.com/token") {
      const params = new URLSearchParams(String(init?.body || ""));
      assert.equal(params.get("client_id"), "env-client");
      assert.equal(params.get("client_secret"), "env-secret");
      return new Response(
        JSON.stringify({ access_token: "env-token", token_type: "Bearer", expires_in: 3600 }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    throw new Error(`Unexpected fetch: ${String(url)}`);
  }) as typeof fetch;

  const manager = new OAuth2TokenManager(makeLogger());
  const headers = await resolveAuthHeadersAsync(
    {
      transport: "streamable-http",
      url: "https://api.example.com/mcp",
      auth: {
        type: "oauth2",
        clientId: "${__TEST_OAUTH_CLIENT_ID}",
        clientSecret: "${__TEST_OAUTH_CLIENT_SECRET}",
        tokenUrl: "https://auth.example.com/token",
      },
    },
    manager
  );

  assert.equal(headers.Authorization, "Bearer env-token");

  delete process.env.__TEST_OAUTH_CLIENT_ID;
  delete process.env.__TEST_OAUTH_CLIENT_SECRET;
  globalThis.fetch = originalFetch;
});

test("streamable-http retries once on 401 with token invalidation", async () => {
  const originalFetch = globalThis.fetch;
  const seenAuthHeaders: string[] = [];
  let tokenFetchCount = 0;
  let postCount = 0;

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = String(url);
    const method = (init?.method || "GET").toUpperCase();

    if (href === "https://auth.example.com/token") {
      tokenFetchCount += 1;
      const token = tokenFetchCount === 1 ? "token-a" : "token-b";
      return new Response(
        JSON.stringify({ access_token: token, token_type: "Bearer", expires_in: 3600 }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    if (href === "https://api.example.com/mcp" && method === "OPTIONS") {
      seenAuthHeaders.push(new Headers(init?.headers).get("authorization") || "");
      return new Response(null, { status: 200 });
    }

    if (href === "https://api.example.com/mcp" && method === "POST") {
      postCount += 1;
      const auth = new Headers(init?.headers).get("authorization") || "";
      seenAuthHeaders.push(auth);

      if (postCount === 1) {
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
      }

      const payload = JSON.parse(String(init?.body || "{}"));
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: { ok: true } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    throw new Error(`Unexpected fetch: ${method} ${href}`);
  }) as typeof fetch;

  const transport = new StreamableHttpTransport(
    {
      transport: "streamable-http",
      url: "https://api.example.com/mcp",
      auth: {
        type: "oauth2",
        clientId: "retry-client",
        clientSecret: "retry-secret",
        tokenUrl: "https://auth.example.com/token",
      },
    },
    makeClientConfig(),
    makeLogger()
  );

  try {
    await transport.connect();
    const response = await transport.sendRequest({ jsonrpc: "2.0", method: "tools/list" });

    assert.deepEqual(response.result, { ok: true });
    assert.equal(tokenFetchCount, 2);
    assert.equal(postCount, 2);
    assert.deepEqual(seenAuthHeaders, ["Bearer token-a", "Bearer token-a", "Bearer token-b"]);
  } finally {
    await transport.shutdown?.();
    globalThis.fetch = originalFetch;
  }
});
