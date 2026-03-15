import type { Logger } from "./types.js";

export interface OAuth2Config {
  clientId: string;
  clientSecret: string;
  tokenUrl: string;
  scopes?: string[];
  audience?: string;
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

  constructor(logger: Logger) {
    this.logger = logger;
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
