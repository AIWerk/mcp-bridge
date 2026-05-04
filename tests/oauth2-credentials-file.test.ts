import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeGoogleWorkspaceCredentials,
  getGoogleCredentialsServerDir,
} from "../src/oauth2-credentials-file.ts";
import type { StoredToken } from "../src/token-store.ts";

function tempBase(): string {
  return mkdtempSync(join(tmpdir(), "mcp-bridge-cred-"));
}

test("writeGoogleWorkspaceCredentials emits a workspace-mcp shaped JSON file", () => {
  const base = tempBase();
  try {
    const stored: StoredToken = {
      accessToken: "ya29.access-token",
      refreshToken: "1//refresh-token",
      expiresAt: Date.UTC(2026, 4, 4, 8, 0, 0),
      tokenUrl: "https://oauth2.googleapis.com/token",
      clientId: "client-x.apps.googleusercontent.com",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/calendar"],
    };
    const { dir, filePath } = writeGoogleWorkspaceCredentials({
      serverName: "google-workspace",
      stored,
      email: "user@example.com",
      clientId: "client-x.apps.googleusercontent.com",
      clientSecret: "secret-x",
      baseDirOverride: base,
    });

    assert.equal(dir, join(base, "google-workspace"));
    assert.equal(filePath, join(base, "google-workspace", "user@example.com.json"));

    const credential = JSON.parse(readFileSync(filePath, "utf-8"));
    assert.equal(credential.token, "ya29.access-token");
    assert.equal(credential.refresh_token, "1//refresh-token");
    assert.equal(credential.token_uri, "https://oauth2.googleapis.com/token");
    assert.equal(credential.client_id, "client-x.apps.googleusercontent.com");
    assert.equal(credential.client_secret, "secret-x");
    assert.deepEqual(credential.scopes, [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/calendar",
    ]);
    // tz-naive expiry: must NOT end with Z
    assert.match(credential.expiry, /^2026-05-04T08:00:00\.000$/);
    assert.doesNotMatch(credential.expiry, /Z$/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("writeGoogleWorkspaceCredentials writes file with 0600 perms", () => {
  const base = tempBase();
  try {
    const stored: StoredToken = {
      accessToken: "x",
      refreshToken: "y",
      expiresAt: Date.now() + 3600_000,
      tokenUrl: "https://oauth2.googleapis.com/token",
    };
    const { filePath } = writeGoogleWorkspaceCredentials({
      serverName: "wm",
      stored,
      email: "u@e.com",
      clientId: "cid",
      clientSecret: "sec",
      baseDirOverride: base,
    });
    const mode = statSync(filePath).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0o600 perms, got ${mode.toString(8)}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("writeGoogleWorkspaceCredentials handles missing refresh_token + scopes", () => {
  const base = tempBase();
  try {
    const stored: StoredToken = {
      accessToken: "no-refresh",
      expiresAt: Date.now() + 1000,
      tokenUrl: "https://oauth2.googleapis.com/token",
    };
    const { filePath } = writeGoogleWorkspaceCredentials({
      serverName: "wm",
      stored,
      email: "u@e.com",
      clientId: "cid",
      clientSecret: "sec",
      baseDirOverride: base,
    });
    const cred = JSON.parse(readFileSync(filePath, "utf-8"));
    assert.equal(cred.refresh_token, "");
    assert.deepEqual(cred.scopes, []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("getGoogleCredentialsServerDir respects MCP_BRIDGE_GOOGLE_CREDENTIALS_DIR env", () => {
  const original = process.env.MCP_BRIDGE_GOOGLE_CREDENTIALS_DIR;
  process.env.MCP_BRIDGE_GOOGLE_CREDENTIALS_DIR = "/tmp/custom-cred-dir";
  try {
    const dir = getGoogleCredentialsServerDir("workspace-mcp");
    assert.equal(dir, "/tmp/custom-cred-dir/workspace-mcp");
  } finally {
    if (original === undefined) delete process.env.MCP_BRIDGE_GOOGLE_CREDENTIALS_DIR;
    else process.env.MCP_BRIDGE_GOOGLE_CREDENTIALS_DIR = original;
  }
});
