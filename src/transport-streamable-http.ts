import { McpRequest, McpResponse, McpServerConfig, nextRequestId } from "./types.js";
import { BaseTransport, resolveServerHeaders, warnIfNonTlsRemoteUrl } from "./transport-base.js";

export class StreamableHttpTransport extends BaseTransport {
  private sessionId?: string;
  private resolvedHeaders: Record<string, string> | null = null;
  private pendingRequestControllers = new Map<number, AbortController>();

  protected get transportName(): string { return "streamable-http"; }

  async connect(): Promise<void> {
    if (!this.config.url) {
      throw new Error("Streamable HTTP transport requires URL");
    }

    warnIfNonTlsRemoteUrl(this.config.url, this.logger);
    // Validate that all header/auth env vars resolve (fail fast)
    this.resolvedHeaders = resolveServerHeaders(this.config);
    await this.probeServer();

    this.connected = true;
    this.backoffDelay = this.clientConfig.reconnectIntervalMs || 30000;
    this.logger.info(`[mcp-bridge] Streamable HTTP transport ready for ${this.config.url}`);
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

      const base = this.resolvedHeaders ?? resolveServerHeaders(this.config);
      const headers: Record<string, string> = {
        ...base,
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json"
      };

      if (this.sessionId) {
        headers["mcp-session-id"] = this.sessionId;
      }

      fetch(this.config.url!, {
        method: "POST",
        headers,
        body: JSON.stringify(requestWithId),
        signal: abortController.signal
      })
        .then(async response => {
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
            let jsonResponse: any;

            if (contentType.includes("text/event-stream")) {
              const text = await response.text();
              const lines = text.split('\n');
              // SSE event boundary parsing: collect data lines, dispatch on empty line
              let dataBuffer: string[] = [];
              const dispatch = () => {
                if (dataBuffer.length === 0) return;
                const data = dataBuffer.join("\n");
                dataBuffer = [];
                try {
                  this.handleMessage(JSON.parse(data));
                } catch { /* skip malformed events */ }
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
        })
        .catch(error => {
          this.pendingRequestControllers.delete(id);
          clearTimeout(timeout);
          this.pendingRequests.delete(id);

          if (error.name === 'TypeError' && error.message.includes('fetch')) {
            this.logger.error("Connection error, scheduling reconnect:", error.message);
            this.scheduleReconnect();
          }

          reject(error);
        });
    });
  }

  async sendNotification(notification: any): Promise<void> {
    if (!this.connected || !this.config.url) {
      throw new Error("Streamable HTTP transport not connected");
    }

    const base = this.resolvedHeaders ?? resolveServerHeaders(this.config);
    const headers: Record<string, string> = {
      ...base,
      "Accept": "application/json, text/event-stream",
      "Content-Type": "application/json"
    };

    if (this.sessionId) {
      headers["mcp-session-id"] = this.sessionId;
    }

    try {
      const response = await fetch(this.config.url, {
        method: "POST",
        headers,
        body: JSON.stringify(notification)
      });

      const responseSessionId = response.headers.get("mcp-session-id");
      if (responseSessionId) {
        this.sessionId = responseSessionId;
      }

      if (!response.ok && response.status >= 500) {
        throw new Error(`Server error: HTTP ${response.status}`);
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'TypeError' && error.message.includes('fetch')) {
        this.logger.error("Connection error during notification, scheduling reconnect:", error.message);
        this.scheduleReconnect();
      }
      throw error;
    }
  }

  private async probeServer(): Promise<void> {
    if (!this.config.url) return;

    try {
      const headers = this.resolvedHeaders ?? resolveServerHeaders(this.config);
      const optionsResponse = await fetch(this.config.url, { method: "OPTIONS", headers });
      if (optionsResponse.ok) return;

      const headResponse = await fetch(this.config.url, { method: "HEAD", headers });
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
        const base = this.resolvedHeaders ?? resolveServerHeaders(this.config);
        const headers = { ...base, "mcp-session-id": this.sessionId };

        await fetch(this.config.url, {
          method: "DELETE",
          headers
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
