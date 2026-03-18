import { McpTransport, McpRequest, McpResponse, McpServerConfig, McpClientConfig, Logger, JsonRpcMessage, RequestIdGenerator, nextRequestId } from "./types.js";
import type { OAuth2Config, AuthCodeOAuth2Config, DeviceCodeOAuth2Config, OAuth2TokenManager } from "./oauth2-token-manager.js";
import { loadOpenClawDotEnvFallback } from "./config.js";

export type PendingRequest = { resolve: (value: McpResponse) => void; reject: (reason: Error) => void; timeout: NodeJS.Timeout };

/**
 * Base class for all MCP transports. Provides shared logic for:
 * - Message handling (JSON-RPC response routing, notification dispatch)
 * - Pending request management with timeout
 * - Reconnection with exponential backoff + jitter
 * - Environment variable resolution for headers, env, and args
 * - Non-TLS remote URL warnings
 */
export abstract class BaseTransport implements McpTransport {
  protected config: McpServerConfig;
  protected clientConfig: McpClientConfig;
  protected connected = false;
  protected pendingRequests = new Map<number, PendingRequest>();
  protected logger: Logger;
  protected reconnectTimer: NodeJS.Timeout | null = null;
  protected onReconnected?: () => Promise<void>;
  protected backoffDelay = 0;
  private readonly requestIdState = { value: 0 };
  private readonly requestIdGenerator: RequestIdGenerator;

  constructor(
    config: McpServerConfig,
    clientConfig: McpClientConfig,
    logger: Logger,
    onReconnected?: () => Promise<void>,
    requestIdGenerator?: RequestIdGenerator
  ) {
    this.config = config;
    this.clientConfig = clientConfig;
    this.logger = logger;
    this.onReconnected = onReconnected;
    this.requestIdGenerator = requestIdGenerator ?? (() => nextRequestId(this.requestIdState));
  }

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract sendRequest(request: McpRequest): Promise<McpResponse>;
  abstract sendNotification(notification: any): Promise<void>;

  isConnected(): boolean {
    return this.connected;
  }

  protected nextRequestId(): number {
    return this.requestIdGenerator();
  }

  /** Human-readable transport name for log messages (e.g. "stdio", "SSE", "streamable-http"). */
  protected abstract get transportName(): string;

  /**
   * Route an incoming JSON-RPC message to the appropriate handler:
   * - notifications/tools/list_changed -> trigger tool refresh
   * - Other notifications -> debug log
   * - Responses with id -> resolve/reject matching pending request
   */
  protected handleMessage(message: JsonRpcMessage): void {
    const hasId = message.id !== undefined && message.id !== null;

    if (!hasId && message.method === "notifications/tools/list_changed") {
      if (this.onReconnected) {
        this.onReconnected().catch((error) => {
          this.logger.error("[mcp-bridge] Failed to refresh tools after list_changed notification:", error);
        });
      }
      return;
    }

    if (!hasId && message.method) {
      this.logger.debug(`[mcp-bridge] Unhandled ${this.transportName} notification: ${message.method}`);
      return;
    }

    if (hasId) {
      const id = message.id as number;
      if (this.pendingRequests.has(id)) {
        const pending = this.pendingRequests.get(id)!;
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(id);

        if (message.error) {
          pending.reject(new Error(message.error.message || "MCP error"));
        } else {
          pending.resolve({ jsonrpc: "2.0", id, result: message.result });
        }
      }
    }
  }

  /** Reject and clear all pending requests with the given reason. */
  protected rejectAllPending(reason: string): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(reason));
    }
    this.pendingRequests.clear();
  }

  /**
   * Schedule a reconnection attempt with exponential backoff and jitter.
   * Rejects all pending requests before scheduling.
   */
  protected scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    this.connected = false;
    this.rejectAllPending("Connection lost, request cancelled");

    const baseDelay = this.clientConfig.reconnectIntervalMs || 30000;
    if (this.backoffDelay <= 0) {
      this.backoffDelay = baseDelay;
    }
    const jitter = 0.5 + Math.random(); // 0.5x-1.5x jitter
    const reconnectInterval = Math.round(this.backoffDelay * jitter);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
        this.logger.info(`${this.transportName} transport reconnected successfully`);
        this.backoffDelay = baseDelay;

        if (this.onReconnected) {
          await this.onReconnected();
        }
      } catch (error) {
        this.logger.error("Reconnection failed:", error);
        this.backoffDelay = Math.min(this.backoffDelay * 2, 300000);
        this.scheduleReconnect();
      }
    }, reconnectInterval);
  }

  /** Cancel any scheduled reconnection timer. */
  protected cleanupReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

// -- Shared utility functions -----------------------------------------------

/**
 * Resolve ${VAR} placeholders in a single string value using environment variables.
 * Throws if a referenced variable is not defined.
 *
 * @param value - String potentially containing ${VAR} placeholders
 * @param contextDescription - Human-readable context for error messages (e.g. 'header "Authorization"')
 * @param extraEnv - Additional env vars to check before process.env (e.g. merged child process env)
 */
export function resolveEnvVars(
  value: string,
  contextDescription: string,
  extraEnv?: Record<string, string | undefined>,
  envFallback?: () => Record<string, string>
): string {
  return value.replace(/\$\{(\w+)\}/g, (_, varName) => {
    const resolved = extraEnv?.[varName] ?? process.env[varName];
    // If resolved is undefined or empty string, try the env fallback.
    // Default fallback is loadOpenClawDotEnvFallback (handles the case where
    // dotenv(override:false) didn't overwrite a pre-existing empty env var).
    if (resolved === undefined || resolved === "") {
      const fallbackFn = envFallback ?? loadOpenClawDotEnvFallback;
      const fallbackVal = fallbackFn()[varName];
      if (fallbackVal !== undefined && fallbackVal !== "") {
        return fallbackVal;
      }
    }
    if (resolved === undefined || resolved === "") {
      throw new Error(`[mcp-bridge] Missing required environment variable "${varName}" while resolving ${contextDescription}`);
    }
    return resolved;
  });
}

/**
 * Resolve ${VAR} placeholders in all values of a Record<string, string>.
 *
 * @param record - Key-value pairs with potential ${VAR} placeholders in values
 * @param contextPrefix - Prefix for error context (e.g. "header", "env key")
 * @param extraEnv - Additional env vars to check before process.env
 */
export function resolveEnvRecord(
  record: Record<string, string>,
  contextPrefix: string,
  extraEnv?: Record<string, string | undefined>,
  envFallback?: () => Record<string, string>
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    resolved[key] = resolveEnvVars(value, `${contextPrefix} "${key}"`, extraEnv, envFallback);
  }
  return resolved;
}

/**
 * Resolve ${VAR} placeholders in an array of command arguments.
 *
 * @param args - Array of argument strings with potential ${VAR} placeholders
 * @param extraEnv - Additional env vars to check before process.env
 */
export function resolveArgs(
  args: string[],
  extraEnv?: Record<string, string | undefined>,
  envFallback?: () => Record<string, string>
): string[] {
  return args.map(arg =>
    resolveEnvVars(arg, `arg "${arg}"`, extraEnv, envFallback)
  );
}

/**
 * Resolve auth config into HTTP headers.
 */
export function resolveAuthHeaders(
  config: McpServerConfig,
  extraEnv?: Record<string, string | undefined>,
  envFallback?: () => Record<string, string>
): Record<string, string> {
  if (!config.auth) return {};

  if (config.auth.type === "bearer") {
    const token = resolveEnvVars(config.auth.token, "auth token", extraEnv, envFallback);
    return { Authorization: `Bearer ${token}` };
  }

  if (config.auth.type === "header") {
    return resolveEnvRecord(config.auth.headers, "auth header", extraEnv, envFallback);
  }

  throw new Error("[mcp-bridge] OAuth2 auth requires async header resolution via resolveAuthHeadersAsync");
}

/** Check whether an oauth2 auth config uses the authorization_code grant type. */
export function isAuthCodeOAuth2(auth: { type: "oauth2"; grantType?: string }): boolean {
  return auth.grantType === "authorization_code";
}

/** Check whether an oauth2 auth config uses the device_code grant type. */
export function isDeviceCodeOAuth2(auth: { type: "oauth2"; grantType?: string }): boolean {
  return auth.grantType === "device_code";
}

export function resolveOAuth2Config(
  config: McpServerConfig,
  extraEnv?: Record<string, string | undefined>,
  envFallback?: () => Record<string, string>
): OAuth2Config {
  if (!config.auth || config.auth.type !== "oauth2") {
    throw new Error("[mcp-bridge] resolveOAuth2Config called for non-oauth2 auth config");
  }

  if (isAuthCodeOAuth2(config.auth)) {
    throw new Error("[mcp-bridge] resolveOAuth2Config called for authorization_code config — use resolveAuthCodeOAuth2Config instead");
  }

  if (isDeviceCodeOAuth2(config.auth)) {
    throw new Error("[mcp-bridge] resolveOAuth2Config called for device_code config — use resolveDeviceCodeOAuth2Config instead");
  }

  const auth = config.auth as { type: "oauth2"; clientId: string; clientSecret: string; tokenUrl: string; scopes?: string[]; audience?: string };

  const scopes = auth.scopes?.map((scope, index) =>
    resolveEnvVars(scope, `oauth2 scope[${index}]`, extraEnv, envFallback)
  );

  return {
    clientId: resolveEnvVars(auth.clientId, "oauth2 clientId", extraEnv, envFallback),
    clientSecret: resolveEnvVars(auth.clientSecret, "oauth2 clientSecret", extraEnv, envFallback),
    tokenUrl: resolveEnvVars(auth.tokenUrl, "oauth2 tokenUrl", extraEnv, envFallback),
    ...(scopes && scopes.length > 0 ? { scopes } : {}),
    ...(auth.audience
      ? { audience: resolveEnvVars(auth.audience, "oauth2 audience", extraEnv, envFallback) }
      : {}),
  };
}

export function resolveAuthCodeOAuth2Config(
  config: McpServerConfig,
  extraEnv?: Record<string, string | undefined>,
  envFallback?: () => Record<string, string>
): AuthCodeOAuth2Config {
  if (!config.auth || config.auth.type !== "oauth2" || !isAuthCodeOAuth2(config.auth)) {
    throw new Error("[mcp-bridge] resolveAuthCodeOAuth2Config called for non-authorization_code auth config");
  }

  const auth = config.auth as { type: "oauth2"; grantType: "authorization_code"; tokenUrl: string; clientId?: string; clientSecret?: string; scopes?: string[] };

  const scopes = auth.scopes?.map((scope, index) =>
    resolveEnvVars(scope, `oauth2 scope[${index}]`, extraEnv, envFallback)
  );

  return {
    grantType: "authorization_code",
    tokenUrl: resolveEnvVars(auth.tokenUrl, "oauth2 tokenUrl", extraEnv, envFallback),
    ...(auth.clientId ? { clientId: resolveEnvVars(auth.clientId, "oauth2 clientId", extraEnv, envFallback) } : {}),
    ...(auth.clientSecret ? { clientSecret: resolveEnvVars(auth.clientSecret, "oauth2 clientSecret", extraEnv, envFallback) } : {}),
    ...(scopes && scopes.length > 0 ? { scopes } : {}),
  };
}

export function resolveDeviceCodeOAuth2Config(
  config: McpServerConfig,
  extraEnv?: Record<string, string | undefined>,
  envFallback?: () => Record<string, string>
): DeviceCodeOAuth2Config {
  if (!config.auth || config.auth.type !== "oauth2" || !isDeviceCodeOAuth2(config.auth)) {
    throw new Error("[mcp-bridge] resolveDeviceCodeOAuth2Config called for non-device_code auth config");
  }

  const auth = config.auth as { type: "oauth2"; grantType: "device_code"; tokenUrl: string; clientId: string; clientSecret?: string; scopes?: string[] };

  const scopes = auth.scopes?.map((scope, index) =>
    resolveEnvVars(scope, `oauth2 scope[${index}]`, extraEnv, envFallback)
  );

  return {
    grantType: "device_code",
    tokenUrl: resolveEnvVars(auth.tokenUrl, "oauth2 tokenUrl", extraEnv, envFallback),
    clientId: resolveEnvVars(auth.clientId, "oauth2 clientId", extraEnv, envFallback),
    ...(auth.clientSecret ? { clientSecret: resolveEnvVars(auth.clientSecret, "oauth2 clientSecret", extraEnv, envFallback) } : {}),
    ...(scopes && scopes.length > 0 ? { scopes } : {}),
  };
}

export async function resolveAuthHeadersAsync(
  config: McpServerConfig,
  tokenManager: OAuth2TokenManager,
  extraEnv?: Record<string, string | undefined>,
  envFallback?: () => Record<string, string>,
  serverName?: string,
): Promise<Record<string, string>> {
  if (!config.auth) return {};

  if (config.auth.type === "oauth2") {
    if (isAuthCodeOAuth2(config.auth)) {
      if (!serverName) {
        throw new Error("[mcp-bridge] serverName is required for authorization_code OAuth2 flow");
      }
      const authCodeConfig = resolveAuthCodeOAuth2Config(config, extraEnv, envFallback);
      const token = await tokenManager.getTokenForAuthCode(serverName, authCodeConfig);
      return { Authorization: `Bearer ${token}` };
    }

    if (isDeviceCodeOAuth2(config.auth)) {
      if (!serverName) {
        throw new Error("[mcp-bridge] serverName is required for device_code OAuth2 flow");
      }
      const deviceCodeConfig = resolveDeviceCodeOAuth2Config(config, extraEnv, envFallback);
      const token = await tokenManager.getTokenForDeviceCode(serverName, deviceCodeConfig);
      return { Authorization: `Bearer ${token}` };
    }

    const oauth2Config = resolveOAuth2Config(config, extraEnv, envFallback);
    const token = await tokenManager.getToken(oauth2Config);
    return { Authorization: `Bearer ${token}` };
  }

  return resolveAuthHeaders(config, extraEnv, envFallback);
}

/**
 * Resolve server headers and merge auth headers (auth takes precedence).
 */
export function resolveServerHeaders(
  config: McpServerConfig,
  extraEnv?: Record<string, string | undefined>,
  envFallback?: () => Record<string, string>
): Record<string, string> {
  const base = resolveEnvRecord(config.headers || {}, "header", extraEnv, envFallback);
  const auth = resolveAuthHeaders(config, extraEnv, envFallback);
  return { ...base, ...auth };
}

export async function resolveServerHeadersAsync(
  config: McpServerConfig,
  tokenManager: OAuth2TokenManager,
  extraEnv?: Record<string, string | undefined>,
  envFallback?: () => Record<string, string>,
  serverName?: string,
): Promise<Record<string, string>> {
  const base = resolveEnvRecord(config.headers || {}, "header", extraEnv, envFallback);
  const auth = await resolveAuthHeadersAsync(config, tokenManager, extraEnv, envFallback, serverName);
  return { ...base, ...auth };
}

/**
 * Warn if a URL uses non-TLS HTTP to a remote (non-localhost) host.
 */
export function warnIfNonTlsRemoteUrl(rawUrl: string, logger: Logger): void {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:") return;
    const host = parsed.hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return;
    logger.warn(`[mcp-bridge] WARNING: Non-TLS connection to ${host} — credentials may be transmitted in plaintext`);
  } catch {
    // Ignore malformed URL here; connect() validation will fail later.
  }
}
