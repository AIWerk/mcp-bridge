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
