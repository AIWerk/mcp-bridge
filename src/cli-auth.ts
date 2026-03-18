import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { randomBytes, createHash } from "crypto";
import { exec } from "child_process";
import { platform } from "os";
import type { Logger } from "./types.js";
import type { StoredToken } from "./token-store.js";

/** Escape HTML special characters to prevent XSS in callback responses. */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface AuthCodeConfig {
  authorizationUrl: string;
  tokenUrl: string;
  clientId?: string;
  clientSecret?: string;
  scopes?: string[];
  callbackPort?: number;
}

const LOGIN_TIMEOUT_MS = 120_000;

/**
 * Generate a PKCE code_verifier: 43-128 URL-safe characters.
 */
export function generateCodeVerifier(length = 64): string {
  const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = randomBytes(length);
  let result = "";
  for (let i = 0; i < length; i++) {
    result += charset[bytes[i] % charset.length];
  }
  return result;
}

/**
 * Compute S256 code_challenge from code_verifier.
 */
export function computeCodeChallenge(verifier: string): string {
  return createHash("sha256")
    .update(verifier, "ascii")
    .digest("base64url");
}

/**
 * Open a URL in the default browser using platform-specific commands.
 */
function openBrowser(url: string, logger: Logger): void {
  const os = platform();
  let cmd: string;
  if (os === "darwin") {
    cmd = `open "${url}"`;
  } else if (os === "win32") {
    cmd = `start "" "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }

  exec(cmd, (err) => {
    if (err) {
      logger.warn(`[mcp-bridge] Could not open browser automatically. Please visit:\n${url}`);
    }
  });
}

interface OAuth2TokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

const DEFAULT_EXPIRES_IN = 3600;
const EXPIRY_BUFFER_SECONDS = 60;

/**
 * Perform the full OAuth2 Authorization Code flow with PKCE.
 *
 * 1. Start local HTTP server on callbackPort
 * 2. Open browser to authorization URL
 * 3. Receive callback with authorization code
 * 4. Exchange code for tokens
 */
export async function performAuthCodeLogin(
  serverName: string,
  authConfig: AuthCodeConfig,
  logger: Logger,
): Promise<StoredToken> {
  const port = authConfig.callbackPort ?? 9876;
  const redirectUri = `http://localhost:${port}/callback`;

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = computeCodeChallenge(codeVerifier);
  const state = randomBytes(16).toString("hex");

  return new Promise<StoredToken>((resolve, reject) => {
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        server.close();
        reject(new Error("Authentication timed out after 120 seconds"));
      }
    }, LOGIN_TIMEOUT_MS);

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (!req.url?.startsWith("/callback")) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const url = new URL(req.url, `http://localhost:${port}`);
      const error = url.searchParams.get("error");
      if (error) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<html><body><h2>Authentication failed</h2><p>${escapeHtml(error)}: ${escapeHtml(url.searchParams.get("error_description") || "")}</p></body></html>`);
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          server.close();
          reject(new Error(`Authorization failed: ${error}`));
        }
        return;
      }

      const returnedState = url.searchParams.get("state");
      if (returnedState !== state) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<html><body><h2>Invalid state parameter</h2></body></html>");
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          server.close();
          reject(new Error("OAuth2 state mismatch — possible CSRF attack"));
        }
        return;
      }

      const code = url.searchParams.get("code");
      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<html><body><h2>Missing authorization code</h2></body></html>");
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          server.close();
          reject(new Error("No authorization code in callback"));
        }
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><h2>Authentication successful!</h2><p>You can close this window and return to the terminal.</p></body></html>`);

      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        server.close();

        exchangeCodeForToken(authConfig, code, redirectUri, codeVerifier, logger)
          .then(resolve)
          .catch(reject);
      }
    });

    server.listen(port, () => {
      const params = new URLSearchParams();
      params.set("response_type", "code");
      if (authConfig.clientId) params.set("client_id", authConfig.clientId);
      params.set("redirect_uri", redirectUri);
      if (authConfig.scopes?.length) params.set("scope", authConfig.scopes.join(" "));
      params.set("state", state);
      params.set("code_challenge", codeChallenge);
      params.set("code_challenge_method", "S256");

      const authUrl = `${authConfig.authorizationUrl}?${params.toString()}`;
      logger.info(`[mcp-bridge] Opening browser for ${serverName} authentication...`);
      logger.info(`[mcp-bridge] If the browser doesn't open, visit: ${authUrl}`);
      openBrowser(authUrl, logger);
    });

    server.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`Failed to start callback server on port ${port}: ${err.message}`));
      }
    });
  });
}

export interface DeviceCodeConfig {
  deviceAuthorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes?: string[];
}

interface DeviceAuthorizationResponse {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
  error?: string;
  error_description?: string;
}

const DEFAULT_POLL_INTERVAL_S = 5;
const SLOW_DOWN_INCREMENT_S = 5;

/**
 * Perform the OAuth2 Device Authorization Grant (RFC 8628).
 *
 * 1. POST to deviceAuthorizationUrl to obtain device_code + user_code
 * 2. Display user_code and verification_uri to the user
 * 3. Poll tokenUrl until the user authorizes or the code expires
 */
export async function performDeviceCodeLogin(
  serverName: string,
  config: DeviceCodeConfig,
  logger: Logger,
): Promise<StoredToken> {
  // Step 1: Request device code
  const formData = new URLSearchParams();
  formData.set("client_id", config.clientId);
  if (config.scopes?.length) formData.set("scope", config.scopes.join(" "));

  const deviceResponse = await fetch(config.deviceAuthorizationUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formData.toString(),
  });

  if (!deviceResponse.ok) {
    const text = await deviceResponse.text().catch(() => "");
    throw new Error(`Device authorization request failed: HTTP ${deviceResponse.status} ${text}`);
  }

  const devicePayload = (await deviceResponse.json()) as DeviceAuthorizationResponse;

  if (devicePayload.error) {
    throw new Error(`Device authorization error: ${devicePayload.error} — ${devicePayload.error_description || ""}`);
  }

  if (!devicePayload.device_code || !devicePayload.user_code || !devicePayload.verification_uri) {
    throw new Error("Device authorization response missing required fields (device_code, user_code, verification_uri)");
  }

  const deviceCode = devicePayload.device_code;
  const userCode = devicePayload.user_code;
  const verificationUri = devicePayload.verification_uri;
  const verificationUriComplete = devicePayload.verification_uri_complete;
  const expiresInS = devicePayload.expires_in ?? 900;
  let intervalS = devicePayload.interval ?? DEFAULT_POLL_INTERVAL_S;

  // Step 2: Display instructions to the user
  logger.info(`[mcp-bridge] ──────────────────────────────────────────`);
  logger.info(`[mcp-bridge]  Device authentication for "${serverName}"`);
  logger.info(`[mcp-bridge]`);
  logger.info(`[mcp-bridge]  1. Open: ${verificationUri}`);
  logger.info(`[mcp-bridge]  2. Enter code: ${userCode}`);
  logger.info(`[mcp-bridge] ──────────────────────────────────────────`);

  if (verificationUriComplete) {
    logger.info(`[mcp-bridge] Or open this URL directly: ${verificationUriComplete}`);
    openBrowser(verificationUriComplete, logger);
  }

  logger.info(`[mcp-bridge] Waiting for authorization (expires in ${expiresInS}s)...`);

  // Step 3: Poll for token
  const deadline = Date.now() + expiresInS * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalS * 1000);

    const tokenForm = new URLSearchParams();
    tokenForm.set("grant_type", "urn:ietf:params:oauth:grant-type:device_code");
    tokenForm.set("device_code", deviceCode);
    tokenForm.set("client_id", config.clientId);

    const tokenResponse = await fetch(config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenForm.toString(),
    });

    const tokenPayload = (await tokenResponse.json()) as OAuth2TokenResponse;

    if (tokenPayload.error) {
      if (tokenPayload.error === "authorization_pending") {
        continue;
      }
      if (tokenPayload.error === "slow_down") {
        intervalS += SLOW_DOWN_INCREMENT_S;
        continue;
      }
      if (tokenPayload.error === "expired_token") {
        throw new Error("Device code expired. Please try again.");
      }
      if (tokenPayload.error === "access_denied") {
        throw new Error("Authorization denied by user.");
      }
      throw new Error(`Device code token error: ${tokenPayload.error} — ${tokenPayload.error_description || ""}`);
    }

    if (!tokenPayload.access_token) {
      throw new Error("Device code token response missing access_token");
    }

    const expiresIn = Number.isFinite(tokenPayload.expires_in)
      ? Number(tokenPayload.expires_in)
      : DEFAULT_EXPIRES_IN;

    const expiresAt = Date.now() + Math.max(0, expiresIn - EXPIRY_BUFFER_SECONDS) * 1000;

    logger.info(`[mcp-bridge] Authentication successful. Token expires in ${expiresIn}s.`);

    return {
      accessToken: tokenPayload.access_token,
      refreshToken: tokenPayload.refresh_token,
      expiresAt,
      tokenUrl: config.tokenUrl,
      clientId: config.clientId,
      scopes: config.scopes,
    };
  }

  throw new Error("Device code expired (timeout). Please try again.");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function exchangeCodeForToken(
  config: AuthCodeConfig,
  code: string,
  redirectUri: string,
  codeVerifier: string,
  logger: Logger,
): Promise<StoredToken> {
  const formData = new URLSearchParams();
  formData.set("grant_type", "authorization_code");
  formData.set("code", code);
  formData.set("redirect_uri", redirectUri);
  formData.set("code_verifier", codeVerifier);
  if (config.clientId) formData.set("client_id", config.clientId);
  if (config.clientSecret) formData.set("client_secret", config.clientSecret);

  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formData.toString(),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Token exchange failed: HTTP ${response.status} ${text}`);
  }

  const payload = (await response.json()) as OAuth2TokenResponse;

  if (payload.error) {
    throw new Error(`Token exchange error: ${payload.error} — ${payload.error_description || ""}`);
  }

  if (!payload.access_token) {
    throw new Error("Token exchange response missing access_token");
  }

  const expiresIn = Number.isFinite(payload.expires_in)
    ? Number(payload.expires_in)
    : DEFAULT_EXPIRES_IN;

  const expiresAt = Date.now() + Math.max(0, expiresIn - EXPIRY_BUFFER_SECONDS) * 1000;

  logger.info(`[mcp-bridge] Authentication successful. Token expires in ${expiresIn}s.`);

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt,
    tokenUrl: config.tokenUrl,
    clientId: config.clientId,
    scopes: config.scopes,
  };
}
