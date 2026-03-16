import { Logger, McpClientConfig, McpRequest, McpResponse, McpServerConfig, RequestIdGenerator } from "./types.js";
import { OAuth2TokenManager } from "./oauth2-token-manager.js";
import {
  BaseTransport,
  resolveOAuth2Config,
  resolveServerHeaders,
  resolveServerHeadersAsync,
  warnIfNonTlsRemoteUrl,
} from "./transport-base.js";

export class SseTransport extends BaseTransport {
  private endpointUrl: string | null = null;
  private sseAbortController: AbortController | null = null;
  private resolvedHeaders: Record<string, string> | null = null;
  private pendingRequestControllers = new Map<number, AbortController>();
  private readonly tokenManager: OAuth2TokenManager;

  protected get transportName(): string { return "SSE"; }

  constructor(
    config: McpServerConfig,
    clientConfig: McpClientConfig,
    logger: Logger,
    onReconnected?: () => Promise<void>,
    tokenManager?: OAuth2TokenManager,
    requestIdGenerator?: RequestIdGenerator
  ) {
    super(config, clientConfig, logger, onReconnected, requestIdGenerator);
    this.tokenManager = tokenManager ?? new OAuth2TokenManager(logger);
  }

  async connect(): Promise<void> {
    if (!this.config.url) {
      throw new Error("SSE transport requires URL");
    }

    warnIfNonTlsRemoteUrl(this.config.url, this.logger);
    await this.refreshResolvedHeaders();

    if (this.sseAbortController) {
      this.sseAbortController.abort();
    }
    this.sseAbortController = new AbortController();

    const connectionTimeout = this.clientConfig.connectionTimeoutMs || 10000;
    const streamReady = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("SSE endpoint URL not received within timeout")), connectionTimeout);
      this._onEndpointReceived = () => { clearTimeout(timer); resolve(); };
    });

    // Fire and forget the stream reader
    this.startEventStream().catch((error) => {
      if (error instanceof Error && error.name !== "AbortError") {
        this.logger.error("[mcp-bridge] SSE stream error:", error.message);
        this.scheduleReconnect();
      }
    });

    await streamReady;
    this.connected = true;
    this.backoffDelay = this.clientConfig.reconnectIntervalMs || 30000;
  }

  private _onEndpointReceived: (() => void) | null = null;

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

    this.logger.warn("[mcp-bridge] SSE request returned 401, invalidating OAuth2 token and retrying once");
    const refreshedBase = await this.getBaseHeaders(true);
    const retryHeaders = {
      ...refreshedBase,
      ...Object.fromEntries(Array.from(new Headers(init.headers).entries()).filter(([key]) => key.toLowerCase() !== "authorization")),
      Authorization: refreshedBase.Authorization,
    };

    return fetch(url, { ...init, headers: retryHeaders });
  }

  private async startEventStream(): Promise<void> {
    if (!this.config.url) return;

    const base = await this.getBaseHeaders();
    const headers = { ...base, Accept: "text/event-stream" };

    try {
      const response = await this.fetchWithOAuthRetry(this.config.url, {
        method: "GET",
        headers,
        signal: this.sseAbortController?.signal,
      });

      if (!response.ok) {
        throw new Error(`SSE connection failed: HTTP ${response.status}`);
      }

      if (!response.body) {
        throw new Error("No response body for SSE stream");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      let buffer = "";
      const state = { event: "", dataBuffer: [] as string[] };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          this.processEventLine(line, state);
        }
      }
      // Stream ended normally — server closed connection
      this.logger.warn("[mcp-bridge] SSE stream ended, scheduling reconnect");
      this.scheduleReconnect();
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      this.logger.error("SSE stream error:", error);
      this.scheduleReconnect();
    }
  }

  private processEventLine(line: string, state: { event: string; dataBuffer: string[] }): void {
    const trimmed = line.trim();
    if (trimmed.startsWith("event:")) {
      state.event = trimmed.substring(6).trim();
      return;
    }

    if (trimmed.startsWith("data:")) {
      const rawData = trimmed.substring(5);
      state.dataBuffer.push(rawData.startsWith(" ") ? rawData.substring(1) : rawData);
      return;
    }

    if (trimmed === "") {
      if (state.dataBuffer.length === 0) return;

      const data = state.dataBuffer.join("\n");
      state.dataBuffer.length = 0;
      const eventType = state.event;
      state.event = "";

      if (eventType === "endpoint") {
        if (data.startsWith("/")) {
          const base = new URL(this.config.url!);
          this.endpointUrl = `${base.origin}${data}`;
        } else if (data.startsWith("http://") || data.startsWith("https://")) {
          if (!this.isSameOrigin(data)) {
            this.logger.warn(`[mcp-bridge] Rejected SSE endpoint with mismatched origin: ${data}`);
            return;
          }
          this.endpointUrl = data;
        } else {
          this.logger.warn(`[mcp-bridge] Rejected SSE endpoint with unsupported URL format: ${data}`);
          return;
        }
        this.logger.info(`[mcp-bridge] SSE endpoint URL received: ${this.endpointUrl}`);
        if (this._onEndpointReceived) {
          this._onEndpointReceived();
          this._onEndpointReceived = null;
        }
        return;
      }

      try {
        const message = JSON.parse(data);
        this.handleMessage(message);
      } catch {
        this.logger.debug("Failed to parse SSE data as JSON:", data);
      }
    }
  }

  async sendNotification(notification: any): Promise<void> {
    if (!this.connected || !this.endpointUrl) {
      throw new Error("SSE transport not connected or no endpoint URL");
    }
    const base = await this.getBaseHeaders();
    const headers = { ...base, "Content-Type": "application/json" };
    const response = await this.fetchWithOAuthRetry(this.endpointUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(notification),
    });
    if (!response.ok) {
      this.logger.warn(`[mcp-bridge] SSE notification got HTTP ${response.status}`);
    }
  }

  async sendRequest(request: McpRequest): Promise<McpResponse> {
    if (!this.connected || !this.endpointUrl) {
      throw new Error("SSE transport not connected or no endpoint URL");
    }

    const id = this.nextRequestId();
    const requestWithId = { ...request, id };

    return new Promise((resolve, reject) => {
      const requestTimeout = this.clientConfig.requestTimeoutMs || 60000;
      const timeout = setTimeout(() => {
        this.pendingRequestControllers.get(id)?.abort();
        this.pendingRequestControllers.delete(id);
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout after ${requestTimeout}ms`));
      }, requestTimeout);

      this.pendingRequests.set(id, { resolve, reject, timeout });

      const abortController = new AbortController();
      this.pendingRequestControllers.set(id, abortController);

      // The response arrives via the SSE stream (handleMessage), not from this fetch.
      // The fetch only confirms the server accepted the request (HTTP 200).
      // If the fetch fails, we reject immediately; otherwise we wait for the SSE stream.
      (async () => {
        try {
          const base = await this.getBaseHeaders();
          const headers = { ...base, "Content-Type": "application/json" };
          const response = await this.fetchWithOAuthRetry(this.endpointUrl!, {
            method: "POST",
            headers,
            body: JSON.stringify(requestWithId),
            signal: abortController.signal,
          });

          this.pendingRequestControllers.delete(id);
          if (!response.ok) {
            clearTimeout(timeout);
            this.pendingRequests.delete(id);
            reject(new Error(`HTTP ${response.status}`));
          }
        } catch (error) {
          this.pendingRequestControllers.delete(id);
          clearTimeout(timeout);
          this.pendingRequests.delete(id);
          reject(error as Error);
        }
      })();
    });
  }

  private isSameOrigin(url: string): boolean {
    try {
      if (!this.config.url) return false;
      const incoming = new URL(url);
      const base = new URL(this.config.url);
      return incoming.origin === base.origin;
    } catch {
      return false;
    }
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.cleanupReconnectTimer();

    if (this.sseAbortController) {
      this.sseAbortController.abort();
      this.sseAbortController = null;
    }

    for (const [, controller] of this.pendingRequestControllers) {
      controller.abort();
    }
    this.pendingRequestControllers.clear();

    this.rejectAllPending("Connection closed");
  }

  async shutdown(): Promise<void> {
    await this.disconnect();
  }
}
