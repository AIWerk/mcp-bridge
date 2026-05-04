/**
 * Vendor-specific OAuth2 credentials file emitters.
 *
 * Some upstream MCP servers (e.g. workspace-mcp) read OAuth credentials from
 * a JSON file rather than an Authorization header or env var. The standalone
 * bridge writes that file at spawn time so the server can refresh its own
 * tokens via the upstream library.
 *
 * Currently supports the "google-workspace" format used by
 * taylorwilsdon/google_workspace_mcp.
 */

import { mkdirSync, writeFileSync, chmodSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { StoredToken } from "./token-store.js";

export interface GoogleWorkspaceCredentialOpts {
  serverName: string;
  /** Result of OAuth2TokenManager.getStoredToken(serverName). */
  stored: StoredToken;
  /**
   * The Google account email. Required so workspace-mcp finds the file at
   * <dir>/<email>.json. Pre-fetched by the caller (we don't bundle a userinfo
   * fetch here to keep the standalone bridge offline-friendly).
   */
  email: string;
  /** OAuth2 client_id used during the install OAuth flow. */
  clientId: string;
  /** OAuth2 client_secret used during the install OAuth flow. */
  clientSecret: string;
  /** Override the base directory (testing). Defaults to ~/.mcp-bridge/google-credentials. */
  baseDirOverride?: string;
}

/** Resolve the base dir for google-workspace credentials files (per-server). */
export function getGoogleCredentialsBaseDir(): string {
  if (process.env.MCP_BRIDGE_GOOGLE_CREDENTIALS_DIR) {
    return process.env.MCP_BRIDGE_GOOGLE_CREDENTIALS_DIR;
  }
  return join(homedir(), ".mcp-bridge", "google-credentials");
}

/** Per-server dir where workspace-mcp finds <email>.json. */
export function getGoogleCredentialsServerDir(serverName: string, baseOverride?: string): string {
  const base = baseOverride ?? getGoogleCredentialsBaseDir();
  return join(base, serverName);
}

/**
 * Write the google-workspace credentials file in the shape expected by
 * workspace-mcp's LocalDirectoryCredentialStore (Google Auth Library JSON
 * with tz-naive ISO expiry). Returns the absolute file path so the caller
 * can log/audit. Permissions: dir 0700, file 0600.
 */
export function writeGoogleWorkspaceCredentials(opts: GoogleWorkspaceCredentialOpts): { dir: string; filePath: string } {
  const dir = getGoogleCredentialsServerDir(opts.serverName, opts.baseDirOverride);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  // workspace-mcp / google-auth-library expects expiry as a tz-naive
  // ISO datetime (Python datetime.fromisoformat). Strip the trailing Z.
  const expiry = new Date(opts.stored.expiresAt).toISOString().replace(/Z$/, "");

  const credential = {
    token: opts.stored.accessToken,
    refresh_token: opts.stored.refreshToken ?? "",
    token_uri: "https://oauth2.googleapis.com/token",
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    scopes: opts.stored.scopes ?? [],
    expiry,
  };

  const filePath = join(dir, `${opts.email}.json`);
  writeFileSync(filePath, JSON.stringify(credential, null, 2), { mode: 0o600 });
  chmodSync(filePath, 0o600);
  return { dir, filePath };
}

/**
 * Resolve the user's Google email by hitting the userinfo endpoint with the
 * given access token. Used at spawn time when no cached credentials file
 * exists yet for the server. Throws on HTTP error or missing email.
 */
export async function fetchGoogleUserEmail(accessToken: string): Promise<string> {
  const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`google userinfo fetch failed: HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as { email?: string };
  if (typeof json.email !== "string" || json.email.length === 0) {
    throw new Error("google userinfo response missing email");
  }
  return json.email;
}

/**
 * Look up a previously written credentials file for this server and return
 * the embedded Google email (the file basename, sans .json). Returns null
 * if no credentials file exists yet. Used to skip the userinfo fetch on
 * subsequent spawns of the same server.
 */
export function findCachedEmailForServer(serverName: string, baseOverride?: string): string | null {
  const dir = getGoogleCredentialsServerDir(serverName, baseOverride);
  if (!existsSync(dir)) return null;
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    if (files.length === 0) return null;
    return files[0].slice(0, -".json".length);
  } catch {
    return null;
  }
}
