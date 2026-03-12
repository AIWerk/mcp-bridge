import { McpRequest, McpResponse, McpServerConfig, nextRequestId } from "./types.js";
import { BaseTransport, resolveEnvRecord, warnIfNonTlsRemoteUrl } from "./transport-base.js";

export class StreamableHttpTransport extends BaseTransport {
  private sessionId?: string;

  protected get transportName(): string { return "streamable-http"; }

  async connect(): Promise<void> {
    if (!this.config.url) {
      throw new Error("Streamable HTTP transport requires URL");
    }

    warnIfNonTlsRemoteUrl(this.config.url, this.logger);
    // Validate that all header env vars resolve (fail fast)
    resolveEnvRecord(this.config.headers || {}, "header");
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
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout after ${requestTimeout}ms`));
      }, requestTimeout);

      this.pendingRequests.set(id, { resolve, reject, timeout });

      const headers = resolveEnvRecord({
        "Accept": "application/json, text/event-stream",
        ...this.config.headers,
        "Content-Type": "application/json"
      }, "header");

      if (this.sessionId) {
        headers["mcp-session-id"] = this.sessionId;
      }

      fetch(this.config.url!, {
        method: "POST",
        headers,
        body: JSON.stringify(requestWithId)
      })
        .then(async response => {
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

    const headers = resolveEnvRecord({
      "Accept": "application/json, text/event-stream",
      ...this.config.headers,
      "Content-Type": "application/json"
    }, "header");

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
      const optionsResponse = await fetch(this.config.url, { method: "OPTIONS" });
      if (optionsResponse.ok) return;

      const headers = resolveEnvRecord(this.config.headers || {}, "header");
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

    // Send DELETE request if we have a session to clean up
    if (this.sessionId && this.config.url) {
      try {
        const headers = resolveEnvRecord(this.config.headers || {}, "header");
        headers["mcp-session-id"] = this.sessionId;

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
}
