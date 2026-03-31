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
  RequestIdState,
  nextRequestId,
} from "./types.js";
import { SseTransport } from "./transport-sse.js";
import { StdioTransport } from "./transport-stdio.js";
import { StreamableHttpTransport } from "./transport-streamable-http.js";
import { OAuth2TokenManager } from "./oauth2-token-manager.js";
import { FileTokenStore } from "./token-store.js";
import { homedir } from "os";
import { join } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";

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
  private readonly requestIdState: RequestIdState = { value: 0 };

  // Direct mode state
  private directTools: DirectToolEntry[] = [];
  private directConnections = new Map<string, { transport: McpTransport; initialized: boolean; lastUsed: number }>();
  private directIdleTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly DIRECT_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
  private stdoutRef: NodeJS.WriteStream | null = null;

  constructor(config: BridgeConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.tokenManager = new OAuth2TokenManager(logger, new FileTokenStore());

    if (this.isRouterMode()) {
      this.router = new McpRouter(config.servers ?? {}, config, logger);
    } else {
      // Warn if security config is used in direct mode where processResult() doesn't run
      const hasSecurityConfig = Object.values(config.servers ?? {}).some(
        s => s.trust && s.trust !== "trusted" || s.maxResultChars || s.toolFilter
      );
      if (hasSecurityConfig || config.maxResultChars) {
        logger.warn(
          "[mcp-bridge] Security config (trust/maxResultChars/toolFilter) detected in direct mode. " +
          "These settings only apply in router mode. Consider switching to mode: \"router\"."
        );
      }
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
    this.stdoutRef = stdout;

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
        protocolVersion: "2025-06-18",
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
                action: { type: "string", description: "list | call | batch | refresh | status | intent | schema | promotions | search | catalog | install | remove | set-mode | set-env" },
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

    // Direct mode: return tools lazily
    // If already discovered, use real tool list. Otherwise, generate placeholder
    // tools from config descriptions (no child process startup on tools/list).
    if (this.directTools.length > 0) {
      const tools = this.directTools.map(t => ({
        name: t.registeredName,
        description: t.description,
        inputSchema: t.inputSchema
      }));
      tools.push(this.getMcpManageTool());
      return { jsonrpc: "2.0", id, result: { tools } };
    }

    // Lazy: try cache first, add discover tool for uncached servers
    const lazyTools: Array<{ name: string; description: string; inputSchema: any }> = [];
    const globalNames = new Set<string>();
    const uncachedServers: string[] = [];

    for (const [serverName, serverConfig] of Object.entries(this.config.servers)) {
      const cached = this.loadToolCache(serverName);
      if (cached && cached.length > 0) {
        // Use cached tools (real tool names + descriptions, no child process)
        const localNames = new Set<string>();
        for (const tool of cached) {
          const registeredName = pickRegisteredToolName(
            serverName, tool.name, this.config.toolPrefix,
            localNames, globalNames, this.logger
          );
          localNames.add(registeredName);
          globalNames.add(registeredName);
          lazyTools.push({ name: registeredName, description: tool.description, inputSchema: tool.inputSchema });
          this.directTools.push({
            serverName, originalName: tool.name, registeredName,
            description: tool.description, inputSchema: tool.inputSchema
          });
        }
      } else {
        uncachedServers.push(serverName);
      }
    }

    // Add a single discover tool if there are uncached servers
    if (uncachedServers.length > 0) {
      const serverDescs = uncachedServers.map(name => {
        const desc = this.config.servers[name]?.description || name;
        return `${name} (${desc})`;
      });
      lazyTools.push({
        name: "mcp_discover",
        description: `Connect to MCP servers and discover their tools. Servers not yet connected: ${serverDescs.join(", ")}. Call this before using any of these servers.`,
        inputSchema: {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: `Server to discover. Available: ${uncachedServers.join(", ")}`,
              enum: uncachedServers
            }
          },
          required: ["server"]
        }
      });
    }

    lazyTools.push(this.getMcpManageTool());
    return { jsonrpc: "2.0", id, result: { tools: lazyTools } };
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

    // Handle mcp_manage tool (direct mode management)
    if (toolName === "mcp_manage") {
      const action = toolArgs?.action as string;
      const server = toolArgs?.server as string;
      const query = toolArgs?.query as string;

      if (action === "servers" || action === "status") {
        const mode = this.config.mode ?? "router";
        const entries = Object.entries(this.config.servers).map(([name, cfg]) => {
          const connected = this.directConnections.get(name)?.initialized ? "connected" : "not connected";
          return `${name} (${cfg.transport}, ${connected}): ${cfg.description || ""}`;
        });
        const header = `Mode: ${mode}\n\n`;
        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: entries.length > 0 ? `${header}Configured servers:\n\n${entries.join("\n")}` : `${header}No servers configured.` }] } };
      }

      if (action === "discover" && server) {
        await this.discoverSingleServer(server);
        const serverTools = this.directTools.filter(t => t.serverName === server);
        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Discovered ${serverTools.length} tools from "${server}":\n\n${serverTools.map(t => `${t.registeredName}: ${t.description}`).join("\n")}` }] } };
      }

      if (action === "set-env") {
        const key = toolArgs?.key as string;
        const value = toolArgs?.value as string;
        if (!key || !value) {
          return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "Both 'key' and 'value' are required for set-env." }] } };
        }
        // Validate key format (only uppercase letters, digits, underscores)
        if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
          return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Invalid key format: "${key}". Use UPPER_SNAKE_CASE (e.g. TODOIST_API_TOKEN).` }] } };
        }
        try {
          const envPath = join(homedir(), ".mcp-bridge", ".env");
          let envContent = "";
          if (existsSync(envPath)) {
            envContent = readFileSync(envPath, "utf-8");
          }
          // Replace existing key or append
          const lines = envContent.split("\n");
          const keyLine = `${key}=${value}`;
          const idx = lines.findIndex(l => l.startsWith(`${key}=`));
          if (idx >= 0) {
            lines[idx] = keyLine;
          } else {
            lines.push(keyLine);
          }
          const newContent = lines.filter(l => l.trim() !== "").join("\n") + "\n";
          writeFileSync(envPath, newContent, { mode: 0o600 });
          // Also set in current process env so it's available immediately
          process.env[key] = value;
          this.logger.info(`Set env var ${key} in ${envPath}`);
          return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `✓ Set ${key} in ~/.mcp-bridge/.env (file permissions: 600). The value is now available. ⚠️ Security note: this API key is stored in plaintext in ~/.mcp-bridge/.env. Ensure this file has restricted permissions (chmod 600).` }] } };
        } catch (err) {
          return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Failed to set env var: ${err instanceof Error ? err.message : String(err)}` }] } };
        }
      }

      if (action === "search" || action === "install" || action === "catalog" || action === "set-mode" || action === "remove") {
        // Delegate to router dispatch (create a temporary router for management actions)
        if (!this.router) {
          const { McpRouter } = await import("./mcp-router.js");
          this.router = new McpRouter(this.config.servers, this.config, this.logger);
        }
        const params: Record<string, unknown> = {};
        if (query) params.query = query;
        if (server) params.server = server;
        if (server) params.name = server;
        if (toolArgs?.mode) params.mode = toolArgs.mode;
        const result = await this.router.dispatch(server, action, undefined, params);
        // If install succeeded, notify about new tools
        if (action === "install" && "installed" in result && (result as any).installed) {
          this.sendToolsChanged();
        }
        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) }] } };
      }

      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "Unknown action. Use: search, install, remove, catalog, status, servers, discover, set-mode" }] } };
    }

    // Handle mcp_discover tool (legacy, kept for backward compatibility)
    if (toolName === "mcp_discover") {
      const serverName = toolArgs?.server as string;
      if (!serverName || !this.config.servers[serverName]) {
        const available = Object.keys(this.config.servers).join(", ");
        return {
          jsonrpc: "2.0", id,
          result: { content: [{ type: "text", text: `Please specify a server. Available: ${available}` }] }
        };
      }
      this.logger.info(`[mcp-bridge] Discovering server: ${serverName}`);
      await this.discoverSingleServer(serverName);
      const serverTools = this.directTools.filter(t => t.serverName === serverName);
      const discovered = serverTools.map(t => `${t.registeredName}: ${t.description}`);
      return {
        jsonrpc: "2.0", id,
        result: { content: [{ type: "text", text: `Connected to "${serverName}". Discovered ${serverTools.length} tools:\n\n${discovered.join("\n")}\n\nThese tools are now available. Call them directly by name.` }] }
      };
    }

    // Direct mode: find and call the tool
    let entry = this.directTools.find(t => t.registeredName === toolName);

    // Lazy discovery: if tool not found, try to discover the relevant server
    if (!entry) {
      const serverName = this.guessServerFromToolName(toolName);
      if (serverName && !this.directConnections.get(serverName)?.initialized) {
        this.logger.info(`[mcp-bridge] Auto-discovering server: ${serverName} (triggered by ${toolName})`);
        await this.discoverSingleServer(serverName);
        entry = this.directTools.find(t => t.registeredName === toolName);
      }
    }

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
      let conn = this.directConnections.get(entry.serverName);
      // Lazy connect: if server not connected yet, connect now
      if (!conn || !conn.transport.isConnected()) {
        const serverConfig = this.config.servers[entry.serverName];
        if (serverConfig) {
          try {
            this.logger.info(`[mcp-bridge] Lazy connecting to ${entry.serverName}...`);
            const transport = this.createTransport(entry.serverName, serverConfig);
            await transport.connect();
            await initializeProtocol(transport, PACKAGE_VERSION);
            conn = { transport, initialized: true, lastUsed: Date.now() };
            this.directConnections.set(entry.serverName, conn);
          } catch (connErr) {
            return {
              jsonrpc: "2.0",
              id,
              error: {
                code: -32001,
                message: `Failed to connect to ${entry.serverName}: ${connErr instanceof Error ? connErr.message : String(connErr)}`,
                data: { errorType: "connection_failed", server: entry.serverName, retriable: true }
              }
            };
          }
        }
      }
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

      // Mark connection as recently used + start idle timer
      conn.lastUsed = Date.now();
      this.startDirectIdleTimer();

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

        this.directConnections.set(serverName, { transport, initialized: true, lastUsed: Date.now() });

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

  /** The mcp_manage tool definition for direct mode */
  private getMcpManageTool() {
    const serverNames = Object.keys(this.config.servers);
    return {
      name: "mcp_manage",
      description: `MCP server manager. Actions: 'search' to find servers in the verified catalog (100+ signed recipes), 'install' to add a server by name, 'remove' to remove a server, 'catalog' to browse all, 'status' to check connections, 'servers' to list configured servers, 'discover' to connect a server and discover its tools, 'set-mode' to switch between router/direct mode, 'set-env' to configure API keys in ~/.mcp-bridge/.env. Connected servers: ${serverNames.join(", ") || "none"}.`,
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", description: "search | install | remove | catalog | status | servers | discover | set-mode | set-env", enum: ["search", "install", "remove", "catalog", "status", "servers", "discover", "set-mode", "set-env"] },
          server: { type: "string", description: "Server name (for install, remove, discover)" },
          query: { type: "string", description: "Search query (for action=search)" },
          mode: { type: "string", description: "Mode (for action=set-mode): router or direct", enum: ["router", "direct"] },
          key: { type: "string", description: "Environment variable name for action=set-env (e.g. TODOIST_API_TOKEN)" },
          value: { type: "string", description: "Environment variable value for action=set-env" }
        },
        required: ["action"]
      }
    };
  }

  /** Send notifications/tools/list_changed to the client via stdout */
  private sendToolsChanged(): void {
    if (!this.stdoutRef) return;
    const notification = { jsonrpc: "2.0", method: "notifications/tools/list_changed" };
    this.writeResponse(this.stdoutRef, notification);
    this.logger.info("[mcp-bridge] Sent notifications/tools/list_changed");
  }

  /** Extract server name from a tool name like "todoist_call" or "github_call" */
  private guessServerFromToolName(toolName: string): string | null {
    // Sort by longest name first to avoid prefix collisions (e.g. "github" before "git")
    const serverNames = Object.keys(this.config.servers).sort((a, b) => b.length - a.length);
    for (const serverName of serverNames) {
      if (toolName.startsWith(serverName + "_") || toolName === serverName) {
        return serverName;
      }
    }
    return null;
  }

  /** Discover tools from a single server (lazy, per-server) */
  private async discoverSingleServer(serverName: string): Promise<void> {
    const serverConfig = this.config.servers[serverName];
    if (!serverConfig) return;

    // Skip if already connected
    const existing = this.directConnections.get(serverName);
    if (existing?.initialized) return;

    try {
      const transport = this.createTransport(serverName, serverConfig);
      await transport.connect();
      await initializeProtocol(transport, PACKAGE_VERSION);

      const tools = await fetchToolsList(transport);

      // Only add to connections AFTER successful tool fetch (prevents leak on partial failure)
      this.directConnections.set(serverName, { transport, initialized: true, lastUsed: Date.now() });
      const globalNames = new Set(this.directTools.map(t => t.registeredName));
      const localNames = new Set<string>();

      // Remove placeholder entries for this server
      this.directTools = this.directTools.filter(t => t.serverName !== serverName);

      for (const tool of tools) {
        const registeredName = pickRegisteredToolName(
          serverName, tool.name, this.config.toolPrefix,
          localNames, globalNames, this.logger
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

      // Cache tools to disk
      this.saveToolCache(serverName, tools);

      this.logger.info(`[mcp-bridge] Discovered ${tools.length} tools from ${serverName}`);

      // Notify client that tool list changed (MCP spec: notifications/tools/list_changed)
      this.sendToolsChanged();
    } catch (err) {
      this.logger.error(`[mcp-bridge] Failed to discover ${serverName}:`, err);
      // Clean up partial connection to allow retry
      const partial = this.directConnections.get(serverName);
      if (partial?.transport) {
        try { await partial.transport.disconnect(); } catch { /* ignore */ }
      }
      this.directConnections.delete(serverName);
    }
  }

  private static readonly CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

  /** Save discovered tools to disk cache with timestamp */
  private saveToolCache(serverName: string, tools: McpTool[]): void {
    try {
      // Sanitize server name for filesystem safety
      if (!/^[a-z0-9][a-z0-9-]*$/.test(serverName)) return;
      const cacheDir = join(homedir(), ".mcp-bridge", "cache");
      mkdirSync(cacheDir, { recursive: true });
      const cachePath = join(cacheDir, `${serverName}-tools.json`);
      writeFileSync(cachePath, JSON.stringify({ cachedAt: Date.now(), tools }, null, 2), "utf-8");
    } catch { /* ignore cache write errors */ }
  }

  /** Load cached tools from disk (with TTL validation) */
  private loadToolCache(serverName: string): McpTool[] | null {
    try {
      // Sanitize server name for filesystem safety
      if (!/^[a-z0-9][a-z0-9-]*$/.test(serverName)) return null;
      const cachePath = join(homedir(), ".mcp-bridge", "cache", `${serverName}-tools.json`);
      if (!existsSync(cachePath)) return null;
      const raw = JSON.parse(readFileSync(cachePath, "utf-8"));
      // Support both old format (array) and new format ({cachedAt, tools})
      if (Array.isArray(raw)) return raw; // legacy format, no TTL
      if (raw && typeof raw === "object" && Array.isArray(raw.tools)) {
        // Check TTL
        if (raw.cachedAt && (Date.now() - raw.cachedAt > StandaloneServer.CACHE_TTL_MS)) {
          this.logger.info(`[mcp-bridge] Cache expired for ${serverName}, will re-discover`);
          return null;
        }
        return raw.tools;
      }
      return null; // malformed cache
    } catch {
      return null; // corrupt/unreadable cache
    }
  }

  private nextRequestId(): number {
    return nextRequestId(this.requestIdState);
  }

  private createTransport(serverName: string, serverConfig: McpServerConfig): McpTransport {
    const onReconnected = async () => {
      this.logger.info(`[mcp-bridge] ${serverName} reconnected, refreshing tools`);
      await this.discoverSingleServer(serverName);
    };

    switch (serverConfig.transport) {
      case "sse":
        return new SseTransport(serverConfig, this.config, this.logger, onReconnected, this.tokenManager, () => this.nextRequestId(), serverName);
      case "stdio":
        return new StdioTransport(serverConfig, this.config, this.logger, onReconnected, () => this.nextRequestId());
      case "streamable-http":
        return new StreamableHttpTransport(
          serverConfig,
          this.config,
          this.logger,
          onReconnected,
          this.tokenManager,
          () => this.nextRequestId(),
          serverName,
        );
      default:
        throw new Error(`Unsupported transport: ${serverConfig.transport}`);
    }
  }

  /** Graceful shutdown: disconnect all backend servers. */
  /** Start idle connection cleanup timer for direct mode */
  private startDirectIdleTimer(): void {
    if (this.directIdleTimer) return;
    this.directIdleTimer = setInterval(() => {
      const now = Date.now();
      for (const [name, conn] of this.directConnections) {
        if (now - conn.lastUsed > StandaloneServer.DIRECT_IDLE_TIMEOUT_MS) {
          this.logger.info(`[mcp-bridge] Disconnecting idle server: ${name}`);
          conn.transport.disconnect().catch(() => {});
          this.directConnections.delete(name);
        }
      }
    }, 60_000); // Check every minute
    this.directIdleTimer.unref(); // Don't keep process alive
  }

  async shutdown(): Promise<void> {
    this.logger.info("[mcp-bridge] Shutting down...");

    if (this.directIdleTimer) {
      clearInterval(this.directIdleTimer);
      this.directIdleTimer = null;
    }

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
