import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createHash } from "crypto";
import { FileTokenStore } from "../src/token-store.ts";
import type { StoredToken } from "../src/token-store.ts";
import { generateCodeVerifier, computeCodeChallenge } from "../src/cli-auth.ts";
import { OAuth2TokenManager } from "../src/oauth2-token-manager.ts";
import { resolveAuthCodeOAuth2Config, resolveOAuth2Config, isAuthCodeOAuth2 } from "../src/transport-base.ts";
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
  return mkdtempSync(join(tmpdir(), "mcp-bridge-test-tokens-"));
}

// -- TokenStore tests -------------------------------------------------------

test("TokenStore save and load round-trip", () => {
  const dir = makeTempDir();
  try {
    const store = new FileTokenStore(dir);
    const token: StoredToken = {
      accessToken: "access-123",
      refreshToken: "refresh-456",
      expiresAt: Date.now() + 3600_000,
      tokenUrl: "https://auth.example.com/token",
      clientId: "my-client",
      scopes: ["read", "write"],
    };

    store.save("test-server", token);
    const loaded = store.load("test-server");

    assert.ok(loaded);
    assert.equal(loaded.accessToken, "access-123");
    assert.equal(loaded.refreshToken, "refresh-456");
    assert.equal(loaded.tokenUrl, "https://auth.example.com/token");
    assert.equal(loaded.clientId, "my-client");
    assert.deepEqual(loaded.scopes, ["read", "write"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TokenStore load returns null for missing server", () => {
  const dir = makeTempDir();
  try {
    const store = new FileTokenStore(dir);
    assert.equal(store.load("nonexistent"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TokenStore remove deletes stored token", () => {
  const dir = makeTempDir();
  try {
    const store = new FileTokenStore(dir);
    store.save("to-remove", {
      accessToken: "x",
      expiresAt: Date.now() + 3600_000,
      tokenUrl: "https://auth.example.com/token",
    });

    assert.ok(store.load("to-remove"));
    store.remove("to-remove");
    assert.equal(store.load("to-remove"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TokenStore remove is idempotent for missing server", () => {
  const dir = makeTempDir();
  try {
    const store = new FileTokenStore(dir);
    // Should not throw
    store.remove("nonexistent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TokenStore list returns all stored tokens", () => {
  const dir = makeTempDir();
  try {
    const store = new FileTokenStore(dir);
    store.save("server-a", {
      accessToken: "a",
      expiresAt: Date.now() + 3600_000,
      tokenUrl: "https://a.example.com/token",
    });
    store.save("server-b", {
      accessToken: "b",
      expiresAt: Date.now() + 3600_000,
      tokenUrl: "https://b.example.com/token",
    });

    const list = store.list();
    assert.equal(list.length, 2);
    const names = list.map((e) => e.serverName).sort();
    assert.deepEqual(names, ["server-a", "server-b"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TokenStore list returns empty array when no tokens dir exists", () => {
  const dir = join(tmpdir(), "mcp-bridge-test-nonexistent-" + Date.now());
  const store = new FileTokenStore(dir);
  assert.deepEqual(store.list(), []);
});

// -- PKCE tests -------------------------------------------------------------

test("generateCodeVerifier produces string of correct length", () => {
  const v43 = generateCodeVerifier(43);
  assert.equal(v43.length, 43);

  const v128 = generateCodeVerifier(128);
  assert.equal(v128.length, 128);

  const vDefault = generateCodeVerifier();
  assert.equal(vDefault.length, 64);
});

test("generateCodeVerifier uses only valid characters", () => {
  const validChars = /^[A-Za-z0-9\-._~]+$/;
  for (let i = 0; i < 10; i++) {
    const verifier = generateCodeVerifier();
    assert.match(verifier, validChars, `Verifier contains invalid characters: ${verifier}`);
  }
});

test("computeCodeChallenge produces correct S256 hash", () => {
  // RFC 7636 Appendix B test vector
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const expectedChallenge = createHash("sha256")
    .update(verifier, "ascii")
    .digest("base64url");

  const challenge = computeCodeChallenge(verifier);
  assert.equal(challenge, expectedChallenge);
});

test("computeCodeChallenge is deterministic", () => {
  const verifier = generateCodeVerifier();
  const c1 = computeCodeChallenge(verifier);
  const c2 = computeCodeChallenge(verifier);
  assert.equal(c1, c2);
});

// -- OAuth2TokenManager auth code flow tests --------------------------------

test("getTokenForAuthCode returns stored token when valid", async () => {
  const dir = makeTempDir();
  try {
    const store = new FileTokenStore(dir);
    store.save("my-server", {
      accessToken: "stored-access",
      expiresAt: Date.now() + 3600_000,
      tokenUrl: "https://auth.example.com/token",
    });

    const manager = new OAuth2TokenManager(makeLogger(), store);
    const token = await manager.getTokenForAuthCode("my-server", {
      grantType: "authorization_code",
      tokenUrl: "https://auth.example.com/token",
    });

    assert.equal(token, "stored-access");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getTokenForAuthCode throws when no token stored", async () => {
  const dir = makeTempDir();
  try {
    const store = new FileTokenStore(dir);
    const manager = new OAuth2TokenManager(makeLogger(), store);

    await assert.rejects(
      () => manager.getTokenForAuthCode("missing-server", {
        grantType: "authorization_code",
        tokenUrl: "https://auth.example.com/token",
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

test("getTokenForAuthCode throws when no token store configured", async () => {
  const manager = new OAuth2TokenManager(makeLogger());

  await assert.rejects(
    () => manager.getTokenForAuthCode("any-server", {
      grantType: "authorization_code",
      tokenUrl: "https://auth.example.com/token",
    }),
    /mcp-bridge auth login any-server/,
  );
});

test("getTokenForAuthCode refreshes expired token with refreshToken", async () => {
  const dir = makeTempDir();
  const originalFetch = globalThis.fetch;

  try {
    const store = new FileTokenStore(dir);
    store.save("refresh-server", {
      accessToken: "old-access",
      refreshToken: "the-refresh-token",
      expiresAt: Date.now() - 1000, // expired
      tokenUrl: "https://auth.example.com/token",
      clientId: "my-client",
    });

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (String(url) === "https://auth.example.com/token") {
        const body = String(init?.body || "");
        const params = new URLSearchParams(body);
        assert.equal(params.get("grant_type"), "refresh_token");
        assert.equal(params.get("refresh_token"), "the-refresh-token");
        assert.equal(params.get("client_id"), "my-client");

        return new Response(
          JSON.stringify({ access_token: "new-access", expires_in: 3600, refresh_token: "new-refresh" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch: ${String(url)}`);
    }) as typeof fetch;

    const manager = new OAuth2TokenManager(makeLogger(), store);
    const token = await manager.getTokenForAuthCode("refresh-server", {
      grantType: "authorization_code",
      tokenUrl: "https://auth.example.com/token",
      clientId: "my-client",
    });

    assert.equal(token, "new-access");

    // Verify the token was persisted
    const updated = store.load("refresh-server");
    assert.ok(updated);
    assert.equal(updated.accessToken, "new-access");
    assert.equal(updated.refreshToken, "new-refresh");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    globalThis.fetch = originalFetch;
  }
});

test("getTokenForAuthCode refreshes without clientSecret", async () => {
  const dir = makeTempDir();
  const originalFetch = globalThis.fetch;

  try {
    const store = new FileTokenStore(dir);
    store.save("no-secret-server", {
      accessToken: "old",
      refreshToken: "ref-tok",
      expiresAt: Date.now() - 1000,
      tokenUrl: "https://auth.example.com/token",
    });

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (String(url) === "https://auth.example.com/token") {
        const params = new URLSearchParams(String(init?.body || ""));
        assert.equal(params.get("grant_type"), "refresh_token");
        // client_secret should NOT be present
        assert.equal(params.get("client_secret"), null);

        return new Response(
          JSON.stringify({ access_token: "refreshed-no-secret", expires_in: 3600 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch: ${String(url)}`);
    }) as typeof fetch;

    const manager = new OAuth2TokenManager(makeLogger(), store);
    const token = await manager.getTokenForAuthCode("no-secret-server", {
      grantType: "authorization_code",
      tokenUrl: "https://auth.example.com/token",
    });

    assert.equal(token, "refreshed-no-secret");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    globalThis.fetch = originalFetch;
  }
});

test("getTokenForAuthCode throws auth_expired when refresh fails", async () => {
  const dir = makeTempDir();
  const originalFetch = globalThis.fetch;

  try {
    const store = new FileTokenStore(dir);
    store.save("fail-refresh", {
      accessToken: "old",
      refreshToken: "bad-refresh",
      expiresAt: Date.now() - 1000,
      tokenUrl: "https://auth.example.com/token",
    });

    globalThis.fetch = (async (): Promise<Response> => {
      return new Response("Unauthorized", { status: 401 });
    }) as typeof fetch;

    const manager = new OAuth2TokenManager(makeLogger(), store);

    await assert.rejects(
      () => manager.getTokenForAuthCode("fail-refresh", {
        grantType: "authorization_code",
        tokenUrl: "https://auth.example.com/token",
      }),
      (err: any) => {
        assert.match(err.message, /expired/i);
        assert.equal(err.code, -32006);
        return true;
      },
    );

    // Token should be removed from store
    assert.equal(store.load("fail-refresh"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    globalThis.fetch = originalFetch;
  }
});

// -- resolveOAuth2Config / resolveAuthCodeOAuth2Config tests ----------------

test("isAuthCodeOAuth2 correctly identifies grant types", () => {
  assert.equal(isAuthCodeOAuth2({ type: "oauth2", grantType: "authorization_code" }), true);
  assert.equal(isAuthCodeOAuth2({ type: "oauth2" }), false);
});

test("resolveAuthCodeOAuth2Config resolves authorization_code config", () => {
  const config: McpServerConfig = {
    transport: "streamable-http",
    url: "https://api.example.com/mcp",
    auth: {
      type: "oauth2",
      grantType: "authorization_code",
      authorizationUrl: "https://auth.example.com/authorize",
      tokenUrl: "https://auth.example.com/token",
      clientId: "my-client",
      scopes: ["read", "write"],
    },
  };

  const resolved = resolveAuthCodeOAuth2Config(config);
  assert.equal(resolved.grantType, "authorization_code");
  assert.equal(resolved.tokenUrl, "https://auth.example.com/token");
  assert.equal(resolved.clientId, "my-client");
  assert.deepEqual(resolved.scopes, ["read", "write"]);
});

test("resolveAuthCodeOAuth2Config works without optional fields", () => {
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

  const resolved = resolveAuthCodeOAuth2Config(config);
  assert.equal(resolved.grantType, "authorization_code");
  assert.equal(resolved.tokenUrl, "https://auth.example.com/token");
  assert.equal(resolved.clientId, undefined);
  assert.equal(resolved.clientSecret, undefined);
});

test("resolveOAuth2Config throws for authorization_code config", () => {
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
    () => resolveOAuth2Config(config),
    /authorization_code/,
  );
});

test("resolveOAuth2Config still works for client_credentials", () => {
  const config: McpServerConfig = {
    transport: "streamable-http",
    url: "https://api.example.com/mcp",
    auth: {
      type: "oauth2",
      clientId: "cc-client",
      clientSecret: "cc-secret",
      tokenUrl: "https://auth.example.com/token",
    },
  };

  const resolved = resolveOAuth2Config(config);
  assert.equal(resolved.clientId, "cc-client");
  assert.equal(resolved.clientSecret, "cc-secret");
  assert.equal(resolved.tokenUrl, "https://auth.example.com/token");
});
