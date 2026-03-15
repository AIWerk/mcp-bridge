import { Logger, McpClientConfig, McpRequest, McpResponse, McpServerConfig, nextRequestId } from "./types.js";
import { OAuth2TokenManager } from "./oauth2-token-manager.js";
import {
  BaseTransport,
  resolveOAuth2Config,
  resolveServerHeaders,
  resolveServerHeadersAsync,
  warnIfNonTlsRemoteUrl,
} from "./transport-base.js";

export class StreamableHttpTransport extends BaseTransport {
  private sessionId?: string;
  private resolvedHeaders: Record<string, string> | null = null;
  private pendingRequestControllers = new Map<number, AbortController>();
  private readonly tokenManager: OAuth2TokenManager;

  protected get transportName(): string { return "streamable-http"; }

  constructor(
    config: McpServerConfig,
    clientConfig: McpClientConfig,
    logger: Logger,
    onReconnected?: () => Promise<void>,
    tokenManager?: OAuth2TokenManager
  ) {
    super(config, clientConfig, logger, onReconnected);
    this.tokenManager = tokenManager ?? new OAuth2TokenManager(logger);
  }

  async connect(): Promise<void> {
    if (!this.config.url) {
      throw new Error("Streamable HTTP transport requires URL");
    }

    warnIfNonTlsRemoteUrl(this.config.url, this.logger);
    await this.refreshResolvedHeaders();
    await this.probeServer();

    this.connected = true;
    this.backoffDelay = this.clientConfig.reconnectIntervalMs || 30000;
    this.logger.info(`[mcp-bridge] Streamable HTTP transport ready for ${this.config.url}`);
  }

  private async getBaseHeaders(forceRefresh = false): Promise<Record<string, string>> {
    if (this.config.auth?.type === "oauth2") {
      if (forceRefresh) {
        this.invalidateOAuth2Token();
      }
      return this.refreshResolvedHeaders();
    }

    if (!this.resolvedHeaders) {
      this.resolvedHeaders = resolveServerHeaders(this.config, undefined, this.clientConfig.envFallback);
    }
    return this.resolvedHeaders;
  }

  private async refreshResolvedHeaders(): Promise<Record<string, string>> {
    if (this.config.auth?.type === "oauth2") {
      this.resolvedHeaders = await resolveServerHeadersAsync(this.config, this.tokenManager, undefined, this.clientConfig.envFallback);
    } else {
      this.resolvedHeaders = resolveServerHeaders(this.config, undefined, this.clientConfig.envFallback);
    }
    return this.resolvedHeaders;
  }

  private invalidateOAuth2Token(): void {
    if (this.config.auth?.type !== "oauth2") {
      return;
    }

    const oauth2Config = resolveOAuth2Config(this.config, undefined, this.clientConfig.envFallback);
    this.tokenManager.invalidate(oauth2Config.tokenUrl, oauth2Config.clientId);
  }

  private async fetchWithOAuthRetry(url: string, init: RequestInit): Promise<Response> {
    const response = await fetch(url, init);
    if (response.status !== 401 || this.config.auth?.type !== "oauth2") {
      return response;
    }

    this.logger.warn("[mcp-bridge] Streamable HTTP request returned 401, invalidating OAuth2 token and retrying once");
    const refreshedBase = await this.getBaseHeaders(true);
    const retryHeaders = {
      ...refreshedBase,
      ...Object.fromEntries(Array.from(new Headers(init.headers).entries()).filter(([key]) => key.toLowerCase() !== "authorization")),
      Authorization: refreshedBase.Authorization,
    };

    return fetch(url, { ...init, headers: retryHeaders });
  }

  async sendRequest(request: McpRequest): Promise<McpResponse> {
    if (!this.connected || !this.config.url) {
      throw new Error("Streamable HTTP transport not connected");
    }

    const id = nextRequestId();
    const requestWithId = { ...request, id };

    return new Promise((resolve, reject) => {
      const requestTimeout = this.clientConfig.requestTimeoutMs || 60000;
      const abortController = new AbortController();
      const timeout = setTimeout(() => {
        abortController.abort();
        this.pendingRequestControllers.delete(id);
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout after ${requestTimeout}ms`));
      }, requestTimeout);

      this.pendingRequests.set(id, { resolve, reject, timeout });
      this.pendingRequestControllers.set(id, abortController);

      (async () => {
        try {
          const base = await this.getBaseHeaders();
          const headers: Record<string, string> = {
            ...base,
            Accept: "application/json, text/event-stream",
            "Content-Type": "application/json",
          };

          if (this.sessionId) {
            headers["mcp-session-id"] = this.sessionId;
          }

          const response = await this.fetchWithOAuthRetry(this.config.url!, {
            method: "POST",
            headers,
            body: JSON.stringify(requestWithId),
            signal: abortController.signal,
          });

          this.pendingRequestControllers.delete(id);
          const responseSessionId = response.headers.get("mcp-session-id");
          if (responseSessionId) {
            this.sessionId = responseSessionId;
          }

          if (!response.ok) {
            clearTimeout(timeout);
            this.pendingRequests.delete(id);
            reject(new Error(`HTTP ${response.status}: ${response.statusText}`));
            return;
          }

          try {
            const contentType = response.headers.get("content-type") || "";

            if (contentType.includes("text/event-stream")) {
              const text = await response.text();
              const lines = text.split("\n");
              // SSE event boundary parsing: collect data lines, dispatch on empty line
              let dataBuffer: string[] = [];
              const dispatch = () => {
                if (dataBuffer.length === 0) return;
                const data = dataBuffer.join("\n");
                dataBuffer = [];
                try {
                  this.handleMessage(JSON.parse(data));
                } catch {
                  // skip malformed events
                }
              };
              let hasData = false;
              for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed.startsWith("data:")) {
                  dataBuffer.push(trimmed.substring(5).trimStart());
                  hasData = true;
                } else if (trimmed === "" && dataBuffer.length > 0) {
                  dispatch();
                }
              }
              // Dispatch any trailing data (server may omit final empty line)
              dispatch();
              if (!hasData) {
                throw new Error("No data lines in SSE response");
              }
            } else {
              this.handleMessage(await response.json());
            }
          } catch (error) {
            clearTimeout(timeout);
            this.pendingRequests.delete(id);
            reject(new Error("Failed to parse response: " + (error instanceof Error ? error.message : String(error))));
          }
        } catch (error) {
          this.pendingRequestControllers.delete(id);
          clearTimeout(timeout);
          this.pendingRequests.delete(id);

          if (error instanceof Error && error.name === "TypeError" && error.message.includes("fetch")) {
            this.logger.error("Connection error, scheduling reconnect:", error.message);
            this.scheduleReconnect();
          }

          reject(error as Error);
        }
      })();
    });
  }

  async sendNotification(notification: any): Promise<void> {
    if (!this.connected || !this.config.url) {
      throw new Error("Streamable HTTP transport not connected");
    }

    const base = await this.getBaseHeaders();
    const headers: Record<string, string> = {
      ...base,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    };

    if (this.sessionId) {
      headers["mcp-session-id"] = this.sessionId;
    }

    try {
      const response = await this.fetchWithOAuthRetry(this.config.url, {
        method: "POST",
        headers,
        body: JSON.stringify(notification),
      });

      const responseSessionId = response.headers.get("mcp-session-id");
      if (responseSessionId) {
        this.sessionId = responseSessionId;
      }

      if (!response.ok && response.status >= 500) {
        throw new Error(`Server error: HTTP ${response.status}`);
      }
    } catch (error) {
      if (error instanceof Error && error.name === "TypeError" && error.message.includes("fetch")) {
        this.logger.error("Connection error during notification, scheduling reconnect:", error.message);
        this.scheduleReconnect();
      }
      throw error;
    }
  }

  private async probeServer(): Promise<void> {
    if (!this.config.url) return;

    try {
      const headers = await this.getBaseHeaders();
      const optionsResponse = await this.fetchWithOAuthRetry(this.config.url, { method: "OPTIONS", headers });
      if (optionsResponse.ok) return;

      const headResponse = await this.fetchWithOAuthRetry(this.config.url, { method: "HEAD", headers });
      if (!headResponse.ok) {
        this.logger.warn(`[mcp-bridge] Streamable HTTP server probe: OPTIONS ${optionsResponse.status}, HEAD ${headResponse.status} (non-blocking, connection continues)`);
      }
    } catch (error) {
      this.logger.warn(`[mcp-bridge] Streamable HTTP server probe failed (non-blocking): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.cleanupReconnectTimer();

    for (const [, controller] of this.pendingRequestControllers) {
      controller.abort();
    }
    this.pendingRequestControllers.clear();

    // Send DELETE request if we have a session to clean up
    if (this.sessionId && this.config.url) {
      try {
        const base = await this.getBaseHeaders();
        const headers = { ...base, "mcp-session-id": this.sessionId };

        await this.fetchWithOAuthRetry(this.config.url, {
          method: "DELETE",
          headers,
        });

        this.sessionId = undefined;
        this.logger.info("Streamable HTTP session cleaned up");
      } catch (error) {
        this.logger.warn("Failed to clean up session on disconnect:", error);
      }
    }

    this.rejectAllPending("Connection closed");
  }

  async shutdown(): Promise<void> {
    await this.disconnect();
  }
}
