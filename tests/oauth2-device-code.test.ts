import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { FileTokenStore } from "../src/token-store.ts";
import type { StoredToken } from "../src/token-store.ts";
import { performDeviceCodeLogin } from "../src/cli-auth.ts";
import { OAuth2TokenManager } from "../src/oauth2-token-manager.ts";
import { isDeviceCodeOAuth2, resolveDeviceCodeOAuth2Config } from "../src/transport-base.ts";
import type { Logger, McpServerConfig } from "../src/types.ts";

function makeLogger(): Logger {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "mcp-bridge-test-device-"));
}

/**
 * Create a mock HTTP server that handles device authorization and token endpoints.
 * Returns { baseUrl, close, pollCount }.
 */
function createMockDeviceServer(opts: {
  pendingPolls?: number;
  slowDownOnPoll?: number;
  errorOnPoll?: string;
  expiresIn?: number;
  interval?: number;
}): Promise<{ baseUrl: string; close: () => Promise<void>; pollCount: () => number }> {
  let polls = 0;
  const pendingPolls = opts.pendingPolls ?? 1;
  const slowDownOnPoll = opts.slowDownOnPoll ?? -1;
  const errorOnPoll = opts.errorOnPoll;

  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const url = req.url || "";
        res.setHeader("Content-Type", "application/json");

        if (url === "/device/code") {
          res.writeHead(200);
          res.end(JSON.stringify({
            device_code: "test-device-code",
            user_code: "ABCD-1234",
            verification_uri: "https://example.com/device",
            verification_uri_complete: "https://example.com/device?code=ABCD-1234",
            expires_in: opts.expiresIn ?? 300,
            interval: opts.interval ?? 1,
          }));
          return;
        }

        if (url === "/token") {
          polls++;

          if (errorOnPoll && polls === 1) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: errorOnPoll }));
            return;
          }

          if (slowDownOnPoll >= 0 && polls === slowDownOnPoll) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: "slow_down" }));
            return;
          }

          if (polls <= pendingPolls) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: "authorization_pending" }));
            return;
          }

          // Success
          res.writeHead(200);
          res.end(JSON.stringify({
            access_token: "device-access-token",
            refresh_token: "device-refresh-token",
            expires_in: 3600,
            token_type: "Bearer",
          }));
          return;
        }

        res.writeHead(404);
        res.end("{}");
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
        pollCount: () => polls,
      });
    });
  });
}

// -- performDeviceCodeLogin tests -------------------------------------------

test("performDeviceCodeLogin succeeds after pending poll", async () => {
  const mock = await createMockDeviceServer({ pendingPolls: 1 });

  try {
    const token = await performDeviceCodeLogin("test-server", { skipBrowser: true,
      deviceAuthorizationUrl: `${mock.baseUrl}/device/code`,
      tokenUrl: `${mock.baseUrl}/token`,
      clientId: "test-client",
      scopes: ["read"],
    }, makeLogger());

    assert.equal(token.accessToken, "device-access-token");
    assert.equal(token.refreshToken, "device-refresh-token");
    assert.equal(token.clientId, "test-client");
    assert.deepEqual(token.scopes, ["read"]);
    assert.ok(token.expiresAt > Date.now());
    assert.equal(mock.pollCount(), 2);
  } finally {
    await mock.close();
  }
});

test("performDeviceCodeLogin handles slow_down by increasing interval", async () => {
  // slowDownOnPoll=1 means poll #1 returns slow_down, pendingPolls=1 means polls <= 1 return pending
  // Poll #1: slow_down (checked first), Poll #2: polls > pendingPolls → success
  const mock = await createMockDeviceServer({ pendingPolls: 1, slowDownOnPoll: 1 });

  try {
    const token = await performDeviceCodeLogin("test-server", { skipBrowser: true,
      deviceAuthorizationUrl: `${mock.baseUrl}/device/code`,
      tokenUrl: `${mock.baseUrl}/token`,
      clientId: "test-client",
    }, makeLogger());

    assert.equal(token.accessToken, "device-access-token");
    // Poll 1: slow_down, Poll 2: success (polls=2 > pendingPolls=1)
    assert.equal(mock.pollCount(), 2);
  } finally {
    await mock.close();
  }
});

test("performDeviceCodeLogin throws on expired_token error", async () => {
  const mock = await createMockDeviceServer({ errorOnPoll: "expired_token" });

  try {
    await assert.rejects(
      () => performDeviceCodeLogin("test-server", { skipBrowser: true,
        deviceAuthorizationUrl: `${mock.baseUrl}/device/code`,
        tokenUrl: `${mock.baseUrl}/token`,
        clientId: "test-client",
      }, makeLogger()),
      /Device code expired/,
    );
  } finally {
    await mock.close();
  }
});

test("performDeviceCodeLogin throws on access_denied error", async () => {
  const mock = await createMockDeviceServer({ errorOnPoll: "access_denied" });

  try {
    await assert.rejects(
      () => performDeviceCodeLogin("test-server", { skipBrowser: true,
        deviceAuthorizationUrl: `${mock.baseUrl}/device/code`,
        tokenUrl: `${mock.baseUrl}/token`,
        clientId: "test-client",
      }, makeLogger()),
      /Authorization denied/,
    );
  } finally {
    await mock.close();
  }
});

test("performDeviceCodeLogin throws on device authorization HTTP error", async () => {
  const mock = await createMockDeviceServer({});
  await mock.close(); // Close immediately so the fetch fails

  await assert.rejects(
    () => performDeviceCodeLogin("test-server", { skipBrowser: true,
      deviceAuthorizationUrl: `http://127.0.0.1:1/device/code`,
      tokenUrl: `http://127.0.0.1:1/token`,
      clientId: "test-client",
    }, makeLogger()),
  );
});

// -- getTokenForDeviceCode tests --------------------------------------------

test("getTokenForDeviceCode returns stored token when valid", async () => {
  const dir = makeTempDir();
  try {
    const store = new FileTokenStore(dir);
    store.save("device-server", {
      accessToken: "stored-device-access",
      expiresAt: Date.now() + 3600_000,
      tokenUrl: "https://auth.example.com/token",
      clientId: "my-client",
    });

    const manager = new OAuth2TokenManager(makeLogger(), store);
    const token = await manager.getTokenForDeviceCode("device-server", {
      grantType: "device_code",
      tokenUrl: "https://auth.example.com/token",
      clientId: "my-client",
    });

    assert.equal(token, "stored-device-access");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getTokenForDeviceCode throws when no token stored", async () => {
  const dir = makeTempDir();
  try {
    const store = new FileTokenStore(dir);
    const manager = new OAuth2TokenManager(makeLogger(), store);

    await assert.rejects(
      () => manager.getTokenForDeviceCode("missing-server", {
        grantType: "device_code",
        tokenUrl: "https://auth.example.com/token",
        clientId: "my-client",
      }),
      (err: any) => {
        assert.match(err.message, /mcp-bridge auth login missing-server/);
        assert.equal(err.code, -32007);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getTokenForDeviceCode throws when no token store configured", async () => {
  const manager = new OAuth2TokenManager(makeLogger());

  await assert.rejects(
    () => manager.getTokenForDeviceCode("any-server", {
      grantType: "device_code",
      tokenUrl: "https://auth.example.com/token",
      clientId: "my-client",
    }),
    /mcp-bridge auth login any-server/,
  );
});

test("getTokenForDeviceCode refreshes expired token with refreshToken", async () => {
  const dir = makeTempDir();
  const originalFetch = globalThis.fetch;

  try {
    const store = new FileTokenStore(dir);
    store.save("device-refresh", {
      accessToken: "old-access",
      refreshToken: "the-refresh-token",
      expiresAt: Date.now() - 1000, // expired
      tokenUrl: "https://auth.example.com/token",
      clientId: "dc-client",
    });

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (String(url) === "https://auth.example.com/token") {
        const body = String(init?.body || "");
        const params = new URLSearchParams(body);
        assert.equal(params.get("grant_type"), "refresh_token");
        assert.equal(params.get("refresh_token"), "the-refresh-token");
        assert.equal(params.get("client_id"), "dc-client");

        return new Response(
          JSON.stringify({ access_token: "new-device-access", expires_in: 3600, refresh_token: "new-refresh" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch: ${String(url)}`);
    }) as typeof fetch;

    const manager = new OAuth2TokenManager(makeLogger(), store);
    const token = await manager.getTokenForDeviceCode("device-refresh", {
      grantType: "device_code",
      tokenUrl: "https://auth.example.com/token",
      clientId: "dc-client",
    });

    assert.equal(token, "new-device-access");

    // Verify the token was persisted
    const updated = store.load("device-refresh");
    assert.ok(updated);
    assert.equal(updated.accessToken, "new-device-access");
    assert.equal(updated.refreshToken, "new-refresh");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    globalThis.fetch = originalFetch;
  }
});

test("getTokenForDeviceCode throws auth_expired when refresh fails", async () => {
  const dir = makeTempDir();
  const originalFetch = globalThis.fetch;

  try {
    const store = new FileTokenStore(dir);
    store.save("fail-device-refresh", {
      accessToken: "old",
      refreshToken: "bad-refresh",
      expiresAt: Date.now() - 1000,
      tokenUrl: "https://auth.example.com/token",
      clientId: "dc-client",
    });

    globalThis.fetch = (async (): Promise<Response> => {
      return new Response("Unauthorized", { status: 401 });
    }) as typeof fetch;

    const manager = new OAuth2TokenManager(makeLogger(), store);

    await assert.rejects(
      () => manager.getTokenForDeviceCode("fail-device-refresh", {
        grantType: "device_code",
        tokenUrl: "https://auth.example.com/token",
        clientId: "dc-client",
      }),
      (err: any) => {
        assert.match(err.message, /expired/i);
        assert.equal(err.code, -32006);
        return true;
      },
    );

    // Token should be removed from store
    assert.equal(store.load("fail-device-refresh"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    globalThis.fetch = originalFetch;
  }
});

// -- Config type parsing tests -----------------------------------------------

test("isDeviceCodeOAuth2 correctly identifies grant types", () => {
  assert.equal(isDeviceCodeOAuth2({ type: "oauth2", grantType: "device_code" }), true);
  assert.equal(isDeviceCodeOAuth2({ type: "oauth2", grantType: "authorization_code" }), false);
  assert.equal(isDeviceCodeOAuth2({ type: "oauth2" }), false);
});

test("resolveDeviceCodeOAuth2Config resolves device_code config", () => {
  const config: McpServerConfig = {
    transport: "streamable-http",
    url: "https://api.example.com/mcp",
    auth: {
      type: "oauth2",
      grantType: "device_code",
      deviceAuthorizationUrl: "https://auth.example.com/device/code",
      tokenUrl: "https://auth.example.com/token",
      clientId: "my-client",
      scopes: ["read", "write"],
    },
  };

  const resolved = resolveDeviceCodeOAuth2Config(config);
  assert.equal(resolved.grantType, "device_code");
  assert.equal(resolved.tokenUrl, "https://auth.example.com/token");
  assert.equal(resolved.clientId, "my-client");
  assert.deepEqual(resolved.scopes, ["read", "write"]);
});

test("resolveDeviceCodeOAuth2Config works without scopes", () => {
  const config: McpServerConfig = {
    transport: "streamable-http",
    url: "https://api.example.com/mcp",
    auth: {
      type: "oauth2",
      grantType: "device_code",
      deviceAuthorizationUrl: "https://auth.example.com/device/code",
      tokenUrl: "https://auth.example.com/token",
      clientId: "my-client",
    },
  };

  const resolved = resolveDeviceCodeOAuth2Config(config);
  assert.equal(resolved.grantType, "device_code");
  assert.equal(resolved.clientId, "my-client");
  assert.equal(resolved.scopes, undefined);
});

test("resolveDeviceCodeOAuth2Config throws for non-device_code config", () => {
  const config: McpServerConfig = {
    transport: "streamable-http",
    url: "https://api.example.com/mcp",
    auth: {
      type: "oauth2",
      grantType: "authorization_code",
      authorizationUrl: "https://auth.example.com/authorize",
      tokenUrl: "https://auth.example.com/token",
    },
  };

  assert.throws(
    () => resolveDeviceCodeOAuth2Config(config),
    /non-device_code/,
  );
});

// -- Regression tests for security fixes ------------------------------------

test("performDeviceCodeLogin handles non-JSON error response gracefully", async () => {
  // Mock server returns HTML 500 on first token poll, then succeeds
  let polls = 0;
  const { baseUrl, close } = await new Promise<{ baseUrl: string; close: () => Promise<void> }>((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        if (req.url === "/device/code") {
          res.setHeader("Content-Type", "application/json");
          res.writeHead(200);
          res.end(JSON.stringify({
            device_code: "dc", user_code: "CODE", verification_uri: "https://example.com",
            expires_in: 30, interval: 1,
          }));
          return;
        }
        if (req.url === "/token") {
          polls++;
          if (polls === 1) {
            // Return HTML 500 — should not crash
            res.setHeader("Content-Type", "text/html");
            res.writeHead(500);
            res.end("<!DOCTYPE html><html><body>Internal Server Error</body></html>");
            return;
          }
          if (polls === 2) {
            // Return 200 with broken JSON — should not crash
            res.setHeader("Content-Type", "application/json");
            res.writeHead(200);
            res.end("not valid json {{{");
            return;
          }
          // Third poll succeeds
          res.setHeader("Content-Type", "application/json");
          res.writeHead(200);
          res.end(JSON.stringify({
            access_token: "recovered-token", refresh_token: "rt", expires_in: 3600, token_type: "Bearer",
          }));
          return;
        }
        res.writeHead(404);
        res.end("");
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });

  const token = await performDeviceCodeLogin("test-server", {
    skipBrowser: true,
    deviceAuthorizationUrl: `${baseUrl}/device/code`,
    tokenUrl: `${baseUrl}/token`,
    clientId: "test",
  }, makeLogger());

  assert.equal(token.accessToken, "recovered-token");
  assert.ok(polls >= 3, "Should have polled at least 3 times");
  await close();
});

test("performDeviceCodeLogin respects AbortSignal", async () => {
  const mock = await createMockDeviceServer({ pendingPolls: 100 }); // would poll forever

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 1500);

  await assert.rejects(
    () => performDeviceCodeLogin("test-server", {
      skipBrowser: true,
      deviceAuthorizationUrl: `${mock.baseUrl}/device/code`,
      tokenUrl: `${mock.baseUrl}/token`,
      clientId: "test",
    }, makeLogger(), controller.signal),
    /aborted/i,
  );

  await mock.close();
});

test("performDeviceCodeLogin passes AbortSignal to fetch", async () => {
  // Already aborted signal should throw immediately
  const controller = new AbortController();
  controller.abort();

  const mock = await createMockDeviceServer({ pendingPolls: 0 });

  await assert.rejects(
    () => performDeviceCodeLogin("test-server", {
      skipBrowser: true,
      deviceAuthorizationUrl: `${mock.baseUrl}/device/code`,
      tokenUrl: `${mock.baseUrl}/token`,
      clientId: "test",
    }, makeLogger(), controller.signal),
    /abort/i,
  );

  await mock.close();
});

// -- openBrowser shell injection regression test ----------------------------

test("openBrowser uses execFile not exec (source code regression guard)", async () => {
  // Read the actual source file and verify exec is NOT used with string interpolation.
  // This guards against someone accidentally reverting execFile back to exec.
  const { readFileSync } = await import("fs");
  const { join } = await import("path");
  const src = readFileSync(join(import.meta.dirname!, "..", "src", "cli-auth.ts"), "utf8");

  // The openBrowser function should use execFile, not exec with template strings
  const openBrowserSection = src.slice(
    src.indexOf("function openBrowser"),
    src.indexOf("}", src.indexOf("function openBrowser") + 200) + 50
  );

  // Verify execFile is used
  assert.ok(openBrowserSection.includes("execFile"), "openBrowser should use execFile");

  // Verify no exec() with string interpolation (shell injection vector)
  assert.ok(
    !openBrowserSection.includes('exec(`'),
    "openBrowser must NOT use exec with template literals (shell injection)",
  );
  assert.ok(
    !openBrowserSection.includes("exec(cmd"),
    "openBrowser must NOT use exec(cmd) (shell injection)",
  );
});
