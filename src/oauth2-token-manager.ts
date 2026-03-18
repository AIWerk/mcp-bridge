import type { Logger } from "./types.js";
import type { TokenStore, StoredToken } from "./token-store.js";

export interface OAuth2Config {
  clientId: string;
  clientSecret: string;
  tokenUrl: string;
  scopes?: string[];
  audience?: string;
}

export interface AuthCodeOAuth2Config {
  grantType: "authorization_code";
  tokenUrl: string;
  clientId?: string;
  clientSecret?: string;
  scopes?: string[];
}

export interface DeviceCodeOAuth2Config {
  grantType: "device_code";
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  scopes?: string[];
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
  refreshToken?: string;
}

interface OAuth2TokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
}

const DEFAULT_EXPIRES_IN_SECONDS = 3600;
const EXPIRY_BUFFER_SECONDS = 60;

export class OAuth2TokenManager {
  private readonly logger: Logger;
  private readonly tokenCache = new Map<string, CachedToken>();
  private readonly inflight = new Map<string, Promise<string>>();
  private readonly tokenRefreshInflight = new Map<string, Promise<string>>();
  private readonly tokenStore?: TokenStore;

  constructor(logger: Logger, tokenStore?: TokenStore) {
    this.logger = logger;
    this.tokenStore = tokenStore;
  }

  async getToken(config: OAuth2Config): Promise<string> {
    const key = this.makeKey(config.tokenUrl, config.clientId);
    const now = Date.now();
    const cached = this.tokenCache.get(key);

    if (cached && cached.expiresAt > now) {
      return cached.accessToken;
    }

    const existingInflight = this.inflight.get(key);
    if (existingInflight) {
      return existingInflight;
    }

    const requestPromise = this.fetchToken(config, cached)
      .then((token) => {
        this.tokenCache.set(key, token);
        return token.accessToken;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, requestPromise);
    return requestPromise;
  }

  invalidate(tokenUrl: string, clientId: string): void {
    const key = this.makeKey(tokenUrl, clientId);
    this.tokenCache.delete(key);
    this.inflight.delete(key);
  }

  clear(): void {
    this.tokenCache.clear();
    this.inflight.clear();
  }

  /**
   * Get a token for an authorization_code flow server.
   * Checks TokenStore, refreshes if expired, throws if unavailable.
   */
  async getTokenForAuthCode(serverName: string, config: AuthCodeOAuth2Config): Promise<string> {
    if (!this.tokenStore) {
      throw new Error(
        `Authentication required for server "${serverName}". Run: mcp-bridge auth login ${serverName}`,
      );
    }

    const stored = this.tokenStore.load(serverName);
    if (!stored) {
      const err = new Error(
        `Authentication required for server "${serverName}". Run: mcp-bridge auth login ${serverName}`,
      );
      (err as any).code = -32007;
      throw err;
    }

    const now = Date.now();
    if (stored.expiresAt > now) {
      return stored.accessToken;
    }

    // Token expired — try refresh with inflight dedup to avoid
    // concurrent requests both trying to refresh the same token
    // (the second refresh would fail because the first invalidated the refresh_token)
    const existingInflight = this.tokenRefreshInflight.get(serverName);
    if (existingInflight) {
      return existingInflight;
    }

    const refreshPromise = this.doAuthCodeRefresh(serverName, stored, config);
    this.tokenRefreshInflight.set(serverName, refreshPromise);
    try {
      return await refreshPromise;
    } finally {
      this.tokenRefreshInflight.delete(serverName);
    }
  }

  /**
   * Get a token for a device_code flow server.
   * Checks TokenStore, refreshes if expired, throws if unavailable.
   */
  async getTokenForDeviceCode(serverName: string, config: DeviceCodeOAuth2Config): Promise<string> {
    if (!this.tokenStore) {
      throw new Error(
        `Authentication required for server "${serverName}". Run: mcp-bridge auth login ${serverName}`,
      );
    }

    const stored = this.tokenStore.load(serverName);
    if (!stored) {
      const err = new Error(
        `Authentication required for server "${serverName}". Run: mcp-bridge auth login ${serverName}`,
      );
      (err as any).code = -32007;
      throw err;
    }

    const now = Date.now();
    if (stored.expiresAt > now) {
      return stored.accessToken;
    }

    // Token expired — try refresh with inflight dedup
    const existingInflight = this.tokenRefreshInflight.get(serverName);
    if (existingInflight) {
      return existingInflight;
    }

    const refreshPromise = this.doDeviceCodeRefresh(serverName, stored, config);
    this.tokenRefreshInflight.set(serverName, refreshPromise);
    try {
      return await refreshPromise;
    } finally {
      this.tokenRefreshInflight.delete(serverName);
    }
  }

  private async doDeviceCodeRefresh(serverName: string, stored: StoredToken, config: DeviceCodeOAuth2Config): Promise<string> {
    if (stored.refreshToken) {
      try {
        const refreshed = await this.refreshDeviceCodeToken(stored, config);
        this.tokenStore!.save(serverName, refreshed);
        return refreshed.accessToken;
      } catch (err) {
        this.logger.warn("[mcp-bridge] Device code token refresh failed:", err);
      }
    }

    // Refresh failed or no refresh token
    this.tokenStore!.remove(serverName);
    const error = new Error(
      `Authentication expired for server "${serverName}". Run: mcp-bridge auth login ${serverName}`,
    );
    (error as any).code = -32006;
    throw error;
  }

  private async refreshDeviceCodeToken(stored: StoredToken, config: DeviceCodeOAuth2Config): Promise<StoredToken> {
    const formData = new URLSearchParams();
    formData.set("grant_type", "refresh_token");
    formData.set("refresh_token", stored.refreshToken!);
    formData.set("client_id", config.clientId);
    if (config.clientSecret) formData.set("client_secret", config.clientSecret);
    if (config.scopes?.length) formData.set("scope", config.scopes.join(" "));

    const response = await fetch(stored.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData.toString(),
    });

    if (!response.ok) {
      throw new Error(`OAuth2 refresh token exchange failed: HTTP ${response.status}`);
    }

    const payload = (await response.json()) as OAuth2TokenResponse;
    if (!payload.access_token) {
      throw new Error("OAuth2 refresh response missing access_token");
    }

    const expiresIn = Number.isFinite(payload.expires_in)
      ? Number(payload.expires_in)
      : DEFAULT_EXPIRES_IN_SECONDS;
    const expiresAt = Date.now() + Math.max(0, expiresIn - EXPIRY_BUFFER_SECONDS) * 1000;

    return {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token ?? stored.refreshToken,
      expiresAt,
      tokenUrl: stored.tokenUrl,
      clientId: config.clientId,
      scopes: config.scopes,
    };
  }

  private async doAuthCodeRefresh(serverName: string, stored: StoredToken, config: AuthCodeOAuth2Config): Promise<string> {
    if (stored.refreshToken) {
      try {
        const refreshed = await this.refreshAuthCodeToken(stored, config);
        this.tokenStore!.save(serverName, refreshed);
        return refreshed.accessToken;
      } catch (err) {
        this.logger.warn("[mcp-bridge] Auth code token refresh failed:", err);
      }
    }

    // Refresh failed or no refresh token
    this.tokenStore!.remove(serverName);
    const error = new Error(
      `Authentication expired for server "${serverName}". Run: mcp-bridge auth login ${serverName}`,
    );
    (error as any).code = -32006;
    throw error;
  }

  private async refreshAuthCodeToken(stored: StoredToken, config: AuthCodeOAuth2Config): Promise<StoredToken> {
    const formData = new URLSearchParams();
    formData.set("grant_type", "refresh_token");
    formData.set("refresh_token", stored.refreshToken!);
    if (config.clientId) formData.set("client_id", config.clientId);
    if (config.clientSecret) formData.set("client_secret", config.clientSecret);
    if (config.scopes?.length) formData.set("scope", config.scopes.join(" "));

    const response = await fetch(stored.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData.toString(),
    });

    if (!response.ok) {
      throw new Error(`OAuth2 refresh token exchange failed: HTTP ${response.status}`);
    }

    const payload = (await response.json()) as OAuth2TokenResponse;
    if (!payload.access_token) {
      throw new Error("OAuth2 refresh response missing access_token");
    }

    const expiresIn = Number.isFinite(payload.expires_in)
      ? Number(payload.expires_in)
      : DEFAULT_EXPIRES_IN_SECONDS;
    const expiresAt = Date.now() + Math.max(0, expiresIn - EXPIRY_BUFFER_SECONDS) * 1000;

    return {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token ?? stored.refreshToken,
      expiresAt,
      tokenUrl: stored.tokenUrl,
      clientId: config.clientId,
      scopes: config.scopes,
    };
  }

  private makeKey(tokenUrl: string, clientId: string): string {
    return `${tokenUrl}::${clientId}`;
  }

  private async fetchToken(config: OAuth2Config, cached?: CachedToken): Promise<CachedToken> {
    if (cached?.refreshToken) {
      try {
        return await this.exchangeToken(config, {
          grant_type: "refresh_token",
          refresh_token: cached.refreshToken,
        });
      } catch (error) {
        this.logger.warn("[mcp-bridge] OAuth2 refresh token exchange failed, falling back to client_credentials:", error);
      }
    }

    return this.exchangeToken(config, {
      grant_type: "client_credentials",
    });
  }

  private async exchangeToken(
    config: OAuth2Config,
    grant: { grant_type: "client_credentials" } | { grant_type: "refresh_token"; refresh_token: string }
  ): Promise<CachedToken> {
    const formData = new URLSearchParams();
    formData.set("grant_type", grant.grant_type);
    formData.set("client_id", config.clientId);
    formData.set("client_secret", config.clientSecret);

    if (grant.grant_type === "refresh_token") {
      formData.set("refresh_token", grant.refresh_token);
    }

    if (config.scopes?.length) {
      formData.set("scope", config.scopes.join(" "));
    }

    if (config.audience) {
      formData.set("audience", config.audience);
    }

    const response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formData.toString(),
    });

    if (!response.ok) {
      throw new Error(`OAuth2 token exchange failed: HTTP ${response.status}`);
    }

    const payload = (await response.json()) as OAuth2TokenResponse;
    if (!payload.access_token) {
      throw new Error("OAuth2 token exchange response missing access_token");
    }

    const expiresIn = Number.isFinite(payload.expires_in)
      ? Number(payload.expires_in)
      : DEFAULT_EXPIRES_IN_SECONDS;

    const expiresAt = Date.now() + Math.max(0, expiresIn - EXPIRY_BUFFER_SECONDS) * 1000;

    return {
      accessToken: payload.access_token,
      expiresAt,
      refreshToken: payload.refresh_token,
    };
  }
}
