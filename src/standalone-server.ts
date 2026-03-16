import { McpRouter } from "./mcp-router.js";
import { fetchToolsList, initializeProtocol, PACKAGE_VERSION } from "./protocol.js";
import { pickRegisteredToolName } from "./tool-naming.js";
import {
  BridgeConfig,
  Logger,
  McpRequest,
  McpResponse,
  McpServerConfig,
  McpTool,
  McpTransport,
} from "./types.js";
import { SseTransport } from "./transport-sse.js";
import { StdioTransport } from "./transport-stdio.js";
import { StreamableHttpTransport } from "./transport-streamable-http.js";
import { OAuth2TokenManager } from "./oauth2-token-manager.js";

interface DirectToolEntry {
  serverName: string;
  originalName: string;
  registeredName: string;
  description: string;
  inputSchema: any;
}

/**
 * Standalone MCP server that wraps the router.
 * Implements the MCP protocol (initialize, tools/list, tools/call)
 * and forwards tool calls to backend MCP servers.
 */
export class StandaloneServer {
  private config: BridgeConfig;
  private logger: Logger;
  private router: McpRouter | null = null;
  private initialized = false;
  private lspMode = false;
  private readonly tokenManager: OAuth2TokenManager;

  // Direct mode state
  private directTools: DirectToolEntry[] = [];
  private directConnections = new Map<string, { transport: McpTransport; initialized: boolean }>();

  constructor(config: BridgeConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.tokenManager = new OAuth2TokenManager(logger);

    if (this.isRouterMode()) {
      this.router = new McpRouter(config.servers || {}, config, logger);
    }
  }

  private isRouterMode(): boolean {
    return (this.config.mode ?? "router") === "router";
  }

  /** Start stdio mode: read JSON-RPC from stdin, write responses to stdout.
   *  Supports both newline-delimited JSON and LSP Content-Length framing. */
  async startStdio(): Promise<void> {
    const stdin = process.stdin;
    const stdout = process.stdout;

    let buffer = Buffer.alloc(0);
    // LSP framing state
    let lspContentLength = -1; // -1 means not in LSP mode for current message
    let lspHeadersDone = false;

    stdin.on("data", (chunk: Buffer | string) => {
      const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      buffer = Buffer.concat([buffer, chunkBuffer]);

      // Process buffer in a loop — it may contain multiple messages
      let progress = true;
      while (progress) {
        progress = false;

        // If we're reading an LSP body, check if we have enough bytes
        if (lspContentLength >= 0 && lspHeadersDone) {
          if (buffer.length >= lspContentLength) {
            // Extract exactly lspContentLength bytes (LSP spec defines Content-Length in bytes)
            const bodyBuffer = buffer.subarray(0, lspContentLength);
            const body = bodyBuffer.toString("utf8");
            buffer = buffer.subarray(lspContentLength);
            lspContentLength = -1;
            lspHeadersDone = false;
            const trimmed = body.trim();
            if (trimmed) {
              this.processLine(trimmed, stdout);
            }
            progress = true;
            continue;
          }
          // Not enough data yet — wait for more
          break;
        }

        // Look for complete lines to detect framing
        const newlineIdx = buffer.indexOf(0x0a);
        if (newlineIdx === -1) break;

        const lineBuffer = buffer.subarray(0, newlineIdx);
        const line = lineBuffer.toString("utf8").replace(/\r$/, "");
        const trimmed = line.trim();

        // LSP header detection
        if (lspContentLength >= 0 && !lspHeadersDone) {
          // We're reading LSP headers — consume until empty line
          buffer = buffer.subarray(newlineIdx + 1);
          progress = true;
          if (trimmed === "") {
            // End of headers — next read the body
            lspHeadersDone = true;
          }
          // Ignore other headers (Content-Type, etc.)
          continue;
        }

        if (trimmed.startsWith("Content-Length:")) {
          // Start of LSP-framed message
          this.lspMode = true;
          const lengthStr = trimmed.slice("Content-Length:".length).trim();
          const length = parseInt(lengthStr, 10);
          if (!isNaN(length) && length > 0) {
            lspContentLength = length;
            lspHeadersDone = false;
            buffer = buffer.subarray(newlineIdx + 1);
            progress = true;
            continue;
          }
        }

        // Newline-delimited JSON: consume the line
        buffer = buffer.subarray(newlineIdx + 1);
        progress = true;

        if (!trimmed || !trimmed.startsWith("{")) continue;
        this.processLine(trimmed, stdout);
      }
    });

    stdin.on("end", () => {
      this.logger.info("[mcp-bridge] stdin closed, shutting down");
      this.shutdown().catch(err => {
        this.logger.error("[mcp-bridge] Shutdown error:", err);
      });
    });

    this.logger.info("[mcp-bridge] Stdio server ready");
  }

  private processLine(line: string, stdout: NodeJS.WriteStream): void {
    let request: any;
    try {
      request = JSON.parse(line);
    } catch {
      this.writeResponse(stdout, {
        jsonrpc: "2.0",
        id: 0,
        error: { code: -32700, message: "Parse error" }
      });
      return;
    }

    // Notifications (no id) — just acknowledge
    if (request.id === undefined || request.id === null) {
      // notifications/initialized, etc. — no response needed
      return;
    }

    this.handleRequest(request).then(response => {
      this.writeResponse(stdout, response);
    }).catch(err => {
      this.writeResponse(stdout, {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32603, message: err instanceof Error ? err.message : String(err) }
      });
    });
  }

  private writeResponse(stdout: NodeJS.WriteStream, response: any): void {
    const json = JSON.stringify(response);
    if (this.lspMode) {
      const byteLength = Buffer.byteLength(json, "utf8");
      stdout.write(`Content-Length: ${byteLength}\r\n\r\n${json}`);
    } else {
      stdout.write(json + "\n");
    }
  }

  /** Handle a single MCP JSON-RPC request. */
  async handleRequest(request: McpRequest): Promise<McpResponse> {
    const id = request.id ?? 0;

    switch (request.method) {
      case "initialize":
        return this.handleInitialize(id);

      case "notifications/initialized":
        return { jsonrpc: "2.0", id, result: {} };

      case "tools/list":
        if (!this.initialized) {
          return { jsonrpc: "2.0", id, error: { code: -32002, message: "Server not initialized. Call 'initialize' first." } };
        }
        return this.handleToolsList(id);

      case "tools/call":
        if (!this.initialized) {
          return { jsonrpc: "2.0", id, error: { code: -32002, message: "Server not initialized. Call 'initialize' first." } };
        }
        return this.handleToolsCall(id, request.params);

      case "ping":
        return { jsonrpc: "2.0", id, result: {} };

      default:
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${request.method}` }
        };
    }
  }

  private handleInitialize(id: number): McpResponse {
    this.initialized = true;
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: "mcp-bridge",
          version: PACKAGE_VERSION
        }
      }
    };
  }

  private async handleToolsList(id: number): Promise<McpResponse> {
    if (this.isRouterMode()) {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: [{
            name: "mcp",
            description: McpRouter.generateDescription(this.config.servers),
            inputSchema: {
              type: "object",
              properties: {
                server: { type: "string", description: "Server name" },
                action: { type: "string", description: "list | call | batch | refresh | status | intent | schema | promotions" },
                tool: { type: "string", description: "Tool name for action=call/schema" },
                params: { type: "object", description: "Tool arguments" },
                calls: {
                  type: "array",
                  description: "Batch calls for action=batch",
                  items: {
                    type: "object",
                    properties: {
                      server: { type: "string" },
                      tool: { type: "string" },
                      params: { type: "object" }
                    },
                    required: ["server", "tool"]
                  }
                }
              },
              required: []
            }
          }]
        }
      };
    }

    // Direct mode: discover all tools from all servers
    await this.discoverDirectTools();
    const tools = this.directTools.map(t => ({
      name: t.registeredName,
      description: t.description,
      inputSchema: t.inputSchema
    }));

    return { jsonrpc: "2.0", id, result: { tools } };
  }

  private async handleToolsCall(id: number, params: any): Promise<McpResponse> {
    const toolName = params?.name;
    const toolArgs = params?.arguments ?? {};

    if (!toolName) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: "Missing tool name" }
      };
    }

    if (this.isRouterMode()) {
      if (toolName !== "mcp") {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32004, message: `Unknown tool: ${toolName}. In router mode, use the 'mcp' tool.` }
        };
      }

      const dispatchParams = toolArgs.action === "batch"
        ? { ...(toolArgs.params ?? {}), calls: toolArgs.calls }
        : toolArgs.params;

      const result = await this.router!.dispatch(
        toolArgs.server,
        toolArgs.action,
        toolArgs.tool,
        dispatchParams
      );

      // Check if result is an error
      if ("error" in result) {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify(result) }],
            isError: true
          }
        };
      }

      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result) }]
        }
      };
    }

    // Direct mode: find and call the tool
    const entry = this.directTools.find(t => t.registeredName === toolName);
    if (!entry) {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32004,
          message: `Unknown tool: ${toolName}`,
          data: { errorType: "unknown_tool" }
        }
      };
    }

    try {
      const conn = this.directConnections.get(entry.serverName);
      if (!conn || !conn.transport.isConnected()) {
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32001,
            message: `Server '${entry.serverName}' not connected`,
            data: { errorType: "connection_failed", server: entry.serverName, retriable: true }
          }
        };
      }

      const response = await conn.transport.sendRequest({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: entry.originalName, arguments: toolArgs }
      });

      if (response.error) {
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32005,
            message: response.error.message,
            data: { errorType: "mcp_error", server: entry.serverName }
          }
        };
      }

      return { jsonrpc: "2.0", id, result: response.result };
    } catch (err) {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32001,
          message: err instanceof Error ? err.message : String(err),
          data: { errorType: "connection_failed", server: entry.serverName, retriable: true }
        }
      };
    }
  }

  private discoveryPromise?: Promise<void>;

  /** Connect to all backend servers and discover their tools (direct mode). */
  private async discoverDirectTools(force = false): Promise<void> {
    if (this.directTools.length > 0 && !force) return; // Already discovered
    if (this.discoveryPromise && !force) {
      await this.discoveryPromise;
      return;
    }
    const promise = this._doDiscovery(force);
    this.discoveryPromise = promise;
    try {
      await promise;
    } finally {
      // Only clear if we're still the active promise (a force call may have replaced us)
      if (this.discoveryPromise === promise) {
        this.discoveryPromise = undefined;
      }
    }
  }

  private async _doDiscovery(force: boolean): Promise<void> {
    if (force) {
      this.directTools = [];
      for (const [, conn] of this.directConnections) {
        await conn.transport.disconnect().catch(() => {});
      }
      this.directConnections.clear();
    }

    const globalNames = new Set<string>();

    for (const [serverName, serverConfig] of Object.entries(this.config.servers)) {
      try {
        const transport = this.createTransport(serverName, serverConfig);
        await transport.connect();
        await initializeProtocol(transport, PACKAGE_VERSION);

        this.directConnections.set(serverName, { transport, initialized: true });

        const tools = await fetchToolsList(transport);
        const localNames = new Set<string>();

        for (const tool of tools) {
          const registeredName = pickRegisteredToolName(
            serverName,
            tool.name,
            this.config.toolPrefix,
            localNames,
            globalNames,
            this.logger
          );
          localNames.add(registeredName);
          globalNames.add(registeredName);

          this.directTools.push({
            serverName,
            originalName: tool.name,
            registeredName,
            description: tool.description,
            inputSchema: tool.inputSchema
          });
        }

        this.logger.info(`[mcp-bridge] Discovered ${tools.length} tools from ${serverName}`);
      } catch (err) {
        this.logger.error(`[mcp-bridge] Failed to connect to ${serverName}:`, err);
      }
    }
  }

  private createTransport(serverName: string, serverConfig: McpServerConfig): McpTransport {
    const onReconnected = async () => {
      this.logger.info(`[mcp-bridge] ${serverName} reconnected, refreshing tools`);
      await this.discoverDirectTools(true);
    };

    switch (serverConfig.transport) {
      case "sse":
        return new SseTransport(serverConfig, this.config, this.logger, onReconnected, this.tokenManager);
      case "stdio":
        return new StdioTransport(serverConfig, this.config, this.logger, onReconnected);
      case "streamable-http":
        return new StreamableHttpTransport(serverConfig, this.config, this.logger, onReconnected, this.tokenManager);
      default:
        throw new Error(`Unsupported transport: ${serverConfig.transport}`);
    }
  }

  /** Graceful shutdown: disconnect all backend servers. */
  async shutdown(): Promise<void> {
    this.logger.info("[mcp-bridge] Shutting down...");

    if (this.router) {
      await this.router.shutdown(this.config.shutdownTimeoutMs);
    }

    for (const [name, conn] of this.directConnections) {
      try {
        await conn.transport.disconnect();
      } catch (err) {
        this.logger.error(`[mcp-bridge] Error disconnecting ${name}:`, err);
      }
    }
    this.directConnections.clear();
    this.tokenManager.clear();

    this.logger.info("[mcp-bridge] Shutdown complete");
  }
}
