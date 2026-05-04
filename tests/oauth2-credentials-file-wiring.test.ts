import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchGoogleUserEmail,
  findCachedEmailForServer,
  writeGoogleWorkspaceCredentials,
} from "../src/oauth2-credentials-file.ts";
import { OAuth2TokenManager } from "../src/oauth2-token-manager.ts";
import { resolveOauth2CredentialsFileAsync } from "../src/transport-base.ts";
import type { StoredToken, TokenStore } from "../src/token-store.ts";
import type { Logger, McpServerConfig } from "../src/types.ts";

function makeLogger(): Logger {
  return { info() {}, warn() {}, error() {}, debug() {} };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "mcp-bridge-credwire-"));
}

class MemTokenStore implements TokenStore {
  private map = new Map<string, StoredToken>();
  load(serverName: string): StoredToken | null { return this.map.get(serverName) ?? null; }
  save(serverName: string, token: StoredToken): void { this.map.set(serverName, token); }
  remove(serverName: string): void { this.map.delete(serverName); }
  list() { return Array.from(this.map.entries()).map(([n, t]) => ({ serverName: n, token: t })); }
}

test("OAuth2TokenManager.getStoredToken forwards to tokenStore", () => {
  const store = new MemTokenStore();
  const stored: StoredToken = {
    accessToken: "ya29.x",
    refreshToken: "r",
    expiresAt: Date.now() + 3600_000,
    tokenUrl: "https://oauth2.googleapis.com/token",
  };
  store.save("workspace", stored);
  const tm = new OAuth2TokenManager(makeLogger(), store);
  assert.deepEqual(tm.getStoredToken("workspace"), stored);
  assert.equal(tm.getStoredToken("nonexistent"), null);
});

test("OAuth2TokenManager.getStoredToken returns null when no token store", () => {
  const tm = new OAuth2TokenManager(makeLogger());
  assert.equal(tm.getStoredToken("anything"), null);
});

test("findCachedEmailForServer reads existing credentials file", () => {
  const base = tempDir();
  try {
    const dir = join(base, "workspace");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "user@example.com.json"), "{}");
    const email = findCachedEmailForServer("workspace", base);
    assert.equal(email, "user@example.com");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("findCachedEmailForServer returns null on missing dir", () => {
  const base = tempDir();
  try {
    assert.equal(findCachedEmailForServer("nope", base), null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("fetchGoogleUserEmail returns email from userinfo response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    assert.equal(String(url), "https://www.googleapis.com/oauth2/v2/userinfo");
    const auth = (init?.headers as Record<string, string>)?.Authorization;
    assert.equal(auth, "Bearer ya29.access");
    return new Response(JSON.stringify({ email: "u@example.com" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const email = await fetchGoogleUserEmail("ya29.access");
    assert.equal(email, "u@example.com");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchGoogleUserEmail throws on HTTP 401", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (): Promise<Response> => {
    return new Response("invalid token", { status: 401 });
  }) as typeof fetch;
  try {
    await assert.rejects(() => fetchGoogleUserEmail("bad-token"), /HTTP 401/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("resolveOauth2CredentialsFileAsync returns empty record when oauth2CredentialsFile not set", async () => {
  const tm = new OAuth2TokenManager(makeLogger(), new MemTokenStore());
  const config: McpServerConfig = { transport: "stdio", command: "x" };
  const env = await resolveOauth2CredentialsFileAsync(config, tm, undefined, undefined, "wm");
  assert.deepEqual(env, {});
});

test("resolveOauth2CredentialsFileAsync rejects unsupported format", async () => {
  const tm = new OAuth2TokenManager(makeLogger(), new MemTokenStore());
  const config = {
    transport: "stdio",
    command: "x",
    oauth2CredentialsFile: { format: "bogus" as "google-workspace" },
  } as McpServerConfig;
  await assert.rejects(
    () => resolveOauth2CredentialsFileAsync(config, tm, undefined, undefined, "wm"),
    /Unsupported oauth2CredentialsFile.format/
  );
});

test("resolveOauth2CredentialsFileAsync rejects client_credentials grant", async () => {
  const tm = new OAuth2TokenManager(makeLogger(), new MemTokenStore());
  const config: McpServerConfig = {
    transport: "stdio",
    command: "x",
    oauth2CredentialsFile: { format: "google-workspace" },
    auth: {
      type: "oauth2",
      clientId: "cid",
      clientSecret: "secret",
      tokenUrl: "https://oauth2.googleapis.com/token",
    },
  };
  await assert.rejects(
    () => resolveOauth2CredentialsFileAsync(config, tm, undefined, undefined, "wm"),
    /requires auth_code or device_code/
  );
});

test("resolveOauth2CredentialsFileAsync e2e auth_code: refreshes, fetches email, writes file, returns env", async () => {
  const base = tempDir();
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env.MCP_BRIDGE_GOOGLE_CREDENTIALS_DIR;
  process.env.MCP_BRIDGE_GOOGLE_CREDENTIALS_DIR = base;

  // Mock fetch: handles both userinfo and (potential) refresh.
  let userinfoCalls = 0;
  globalThis.fetch = (async (url: string | URL | Request): Promise<Response> => {
    const href = String(url);
    if (href === "https://www.googleapis.com/oauth2/v2/userinfo") {
      userinfoCalls += 1;
      return new Response(JSON.stringify({ email: "alice@example.com" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch: ${href}`);
  }) as typeof fetch;

  // Pre-populate token store as if `mcp-bridge auth login` already ran.
  const store = new MemTokenStore();
  const stored: StoredToken = {
    accessToken: "ya29.AC-CESS",
    refreshToken: "1//rtoken",
    expiresAt: Date.now() + 3600_000,
    tokenUrl: "https://oauth2.googleapis.com/token",
    clientId: "cid.apps.googleusercontent.com",
    scopes: ["https://www.googleapis.com/auth/calendar"],
  };
  store.save("google-workspace", stored);

  const tm = new OAuth2TokenManager(makeLogger(), store);

  const config: McpServerConfig = {
    transport: "stdio",
    command: "uvx",
    args: ["workspace-mcp"],
    oauth2CredentialsFile: { format: "google-workspace" },
    auth: {
      type: "oauth2",
      grantType: "authorization_code",
      authorizationUrl: "https://accounts.google.com/o/oauth2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      clientId: "cid.apps.googleusercontent.com",
      clientSecret: "client-secret-x",
      scopes: ["https://www.googleapis.com/auth/calendar"],
    },
  };

  try {
    const env = await resolveOauth2CredentialsFileAsync(config, tm, undefined, undefined, "google-workspace");
    assert.equal(env.GOOGLE_MCP_CREDENTIALS_DIR, join(base, "google-workspace"));

    // File was written
    const filePath = join(base, "google-workspace", "alice@example.com.json");
    const cred = JSON.parse(readFileSync(filePath, "utf-8"));
    assert.equal(cred.token, "ya29.AC-CESS");
    assert.equal(cred.refresh_token, "1//rtoken");
    assert.equal(cred.client_id, "cid.apps.googleusercontent.com");
    assert.equal(cred.client_secret, "client-secret-x");
    assert.deepEqual(cred.scopes, ["https://www.googleapis.com/auth/calendar"]);

    // Userinfo fetched once
    assert.equal(userinfoCalls, 1);

    // Second call uses cached email — no extra userinfo fetch
    await resolveOauth2CredentialsFileAsync(config, tm, undefined, undefined, "google-workspace");
    assert.equal(userinfoCalls, 1, "second call should reuse cached email");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalEnv === undefined) delete process.env.MCP_BRIDGE_GOOGLE_CREDENTIALS_DIR;
    else process.env.MCP_BRIDGE_GOOGLE_CREDENTIALS_DIR = originalEnv;
    rmSync(base, { recursive: true, force: true });
  }
});

test("resolveOauth2CredentialsFileAsync throws when no token in store (user has not logged in)", async () => {
  const tm = new OAuth2TokenManager(makeLogger(), new MemTokenStore());
  const config: McpServerConfig = {
    transport: "stdio",
    command: "uvx",
    oauth2CredentialsFile: { format: "google-workspace" },
    auth: {
      type: "oauth2",
      grantType: "authorization_code",
      authorizationUrl: "https://x",
      tokenUrl: "https://oauth2.googleapis.com/token",
      clientId: "cid",
      clientSecret: "sec",
    },
  };
  await assert.rejects(
    () => resolveOauth2CredentialsFileAsync(config, tm, undefined, undefined, "wm"),
    /Authentication required|No stored OAuth2 token/
  );
});
