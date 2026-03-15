import {
  McpClientConfig,
  McpServerConfig,
  McpTool,
  McpTransport,
  Logger
} from "./types.js";
import { SseTransport } from "./transport-sse.js";
import { StdioTransport } from "./transport-stdio.js";
import { StreamableHttpTransport } from "./transport-streamable-http.js";
import { fetchToolsList, initializeProtocol, PACKAGE_VERSION } from "./protocol.js";
import { compressDescription } from "./schema-compression.js";
import { IntentRouter } from "./intent-router.js";
import { createEmbeddingProvider } from "./embeddings.js";
import { isToolAllowed, processResult } from "./security.js";
import { AdaptivePromotion } from "./adaptive-promotion.js";

type RouterErrorCode =
  | "unknown_server"
  | "unknown_tool"
  | "connection_failed"
  | "mcp_error"
  | "invalid_params";

interface RouterBatchCall {
  server?: string;
  tool?: string;
  params?: any;
}

interface RouterBatchResult {
  server: string;
  tool: string;
  result?: any;
  error?: {
    error: RouterErrorCode;
    message: string;
    available?: string[];
    code?: number;
  };
}

export interface RouterToolHint {
  name: string;
  description: string;
  requiredParams: string[];
}

export interface RouterServerStatus {
  name: string;
  transport: string;
  status: "connected" | "idle" | "disconnected";
  tools: number;
  lastUsed?: string;
}

export type RouterDispatchResponse =
  | { server: string; action: "list"; tools: RouterToolHint[] }
  | { server: string; action: "refresh"; refreshed: true; tools: RouterToolHint[] }
  | { server: string; action: "call"; tool: string; result: any }
  | { server: string; action: "schema"; tool: string; schema: any; description: string }
  | { action: "status"; servers: RouterServerStatus[] }
  | { action: "batch"; results: RouterBatchResult[] }
  | { action: "promotions"; promoted: Array<{ server: string; tool: string; callCount: number }>; stats: Array<{ server: string; tool: string; callCount: number; lastCall: string }> }
  | {
      action: "intent";
      intent: string;
      match: { server: string; tool: string; score: number };
      alternatives: Array<{ server: string; tool: string; score: number }>;
    }
  | {
      error: RouterErrorCode;
      message: string;
      available?: string[];
      code?: number;
    };

export interface RouterTransportRefs {
  sse: new (config: McpServerConfig, clientConfig: McpClientConfig, logger: Logger, onReconnected?: () => Promise<void>) => McpTransport;
  stdio: new (config: McpServerConfig, clientConfig: McpClientConfig, logger: Logger, onReconnected?: () => Promise<void>) => McpTransport;
  streamableHttp: new (config: McpServerConfig, clientConfig: McpClientConfig, logger: Logger, onReconnected?: () => Promise<void>) => McpTransport;
}

interface RouterServerState {
  transport: McpTransport;
  initialized: boolean;
  toolsCache?: RouterToolHint[];
  /** Full uncompressed tool metadata keyed by tool name */
  fullToolsMap?: Map<string, { description: string; inputSchema: any }>;
  toolNames: string[];
  lastUsedAt: number;
  idleTimer: NodeJS.Timeout | null;
  initPromise?: Promise<void>;
}

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_CONCURRENT = 5;
const DEFAULT_MAX_BATCH_SIZE = 10;

export class McpRouter {
  private readonly servers: Record<string, McpServerConfig>;
  private readonly clientConfig: McpClientConfig;
  private readonly logger: Logger;
  private readonly transportRefs: RouterTransportRefs;
  private readonly idleTimeoutMs: number;
  private readonly maxConcurrent: number;
  private readonly maxBatchSize: number;
  private readonly states = new Map<string, RouterServerState>();
  private intentRouter: IntentRouter | null = null;
  private promotion: AdaptivePromotion | null = null;

  constructor(
    servers: Record<string, McpServerConfig>,
    clientConfig: McpClientConfig,
    logger: Logger,
    transportRefs?: Partial<RouterTransportRefs>
  ) {
    this.servers = servers;
    this.clientConfig = clientConfig;
    this.logger = logger;
    this.transportRefs = {
      sse: transportRefs?.sse ?? SseTransport,
      stdio: transportRefs?.stdio ?? StdioTransport,
      streamableHttp: transportRefs?.streamableHttp ?? StreamableHttpTransport
    };
    this.idleTimeoutMs = clientConfig.routerIdleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.maxConcurrent = clientConfig.routerMaxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.maxBatchSize = clientConfig.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;

    if (clientConfig.adaptivePromotion?.enabled) {
      this.promotion = new AdaptivePromotion(clientConfig.adaptivePromotion, logger);
    }
  }

  static generateDescription(servers: Record<string, McpServerConfig>): string {
    const serverNames = Object.keys(servers);
    if (serverNames.length === 0) {
      return "Call MCP server tools. No servers configured.";
    }

    const serverList = serverNames
      .map((name) => {
        const desc = servers[name].description;
        return desc ? `${name} (${desc})` : name;
      })
      .join(", ");

    return `Call any MCP server tool. Servers: ${serverList}. Use action='list' to discover tools and required parameters, action='call' to execute a tool, action='batch' to execute multiple calls in one round-trip, action='refresh' to clear cache and re-discover tools, and action='status' to check server connection states. If the user mentions a specific tool by name, the call action auto-connects and works without listing first.`;
  }

  async dispatch(server?: string, action: string = "call", tool?: string, params?: any): Promise<RouterDispatchResponse> {
    try {
      const normalizedAction = action || "call";

      // Status action: no server required, shows all server states
      if (normalizedAction === "status") {
        return this.getStatus();
      }

      // Promotions action: return promotion stats
      if (normalizedAction === "promotions") {
        return this.getPromotionStats();
      }

      // Intent action: find server+tool from natural language
      if (normalizedAction === "intent") {
        const intent = params?.intent || tool;
        if (!intent) {
          return this.error("invalid_params", "intent string is required for action=intent");
        }
        return this.resolveIntent(intent);
      }

      if (normalizedAction === "batch") {
        const calls = params?.calls;
        if (!Array.isArray(calls) || calls.length === 0) {
          return this.error("invalid_params", "calls must be a non-empty array for action=batch");
        }
        if (calls.length > this.maxBatchSize) {
          return this.error("invalid_params", `batch size exceeds maxBatchSize (${this.maxBatchSize})`);
        }

        const results = await Promise.all(
          calls.map(async (call: RouterBatchCall): Promise<RouterBatchResult> => {
            const callServer = typeof call?.server === "string" ? call.server : "";
            const callTool = typeof call?.tool === "string" ? call.tool : "";
            const response = await this.dispatch(callServer, "call", callTool, call?.params);

            if ("error" in response) {
              return {
                server: callServer,
                tool: callTool,
                error: {
                  error: response.error,
                  message: response.message,
                  ...(response.available ? { available: response.available } : {}),
                  ...(typeof response.code === "number" ? { code: response.code } : {})
                }
              };
            }

            return {
              server: callServer,
              tool: callTool,
              result: response.result
            };
          })
        );

        return { action: "batch", results };
      }

      if (!server) {
        return this.error("invalid_params", "server is required");
      }
      if (!this.servers[server]) {
        return this.error("unknown_server", `Server '${server}' not found`, Object.keys(this.servers));
      }
      if (normalizedAction === "list") {
        try {
          const tools = await this.getToolList(server);
          return { server, action: "list", tools };
        } catch (error) {
          return this.error("connection_failed", `Failed to connect to ${server}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (normalizedAction === "schema") {
        if (!tool) {
          return this.error("invalid_params", "tool is required for action=schema");
        }
        try {
          await this.getToolList(server);
        } catch (error) {
          return this.error("connection_failed", `Failed to connect to ${server}: ${error instanceof Error ? error.message : String(error)}`);
        }
        const state = this.states.get(server)!;
        const fullTool = state.fullToolsMap?.get(tool);
        if (!fullTool) {
          return this.error("unknown_tool", `Tool '${tool}' not found on server '${server}'`, state.toolNames);
        }
        return { server, action: "schema", tool, schema: fullTool.inputSchema, description: fullTool.description };
      }

      if (normalizedAction === "refresh") {
        try {
          const state = await this.ensureConnected(server);
          state.toolsCache = undefined;
          state.fullToolsMap = undefined;
          state.toolNames = [];
          // Clear intent index so it re-indexes on next intent query
          if (this.intentRouter) {
            this.intentRouter.clearIndex();
          }
          const tools = await this.getToolList(server);
          return { server, action: "refresh", refreshed: true, tools };
        } catch (error) {
          return this.error("connection_failed", `Failed to connect to ${server}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (normalizedAction !== "call") {
        return this.error("invalid_params", `action must be one of: list, call, batch, refresh, schema, intent`);
      }

      if (!tool) {
        return this.error("invalid_params", "tool is required for action=call");
      }

      try {
        await this.getToolList(server);
      } catch (error) {
        return this.error("connection_failed", `Failed to connect to ${server}: ${error instanceof Error ? error.message : String(error)}`);
      }
      const state = this.states.get(server)!;

      if (!state.toolNames.includes(tool)) {
        return this.error("unknown_tool", `Tool '${tool}' not found on server '${server}'`, state.toolNames);
      }

      // Defense in depth: double-check tool filter
      const serverConfig = this.servers[server];
      if (!isToolAllowed(tool, serverConfig)) {
        return this.error("unknown_tool", `Tool '${tool}' is not allowed on server '${server}'`, state.toolNames);
      }

      this.markUsed(server);
      const response = await state.transport.sendRequest({
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: tool,
          arguments: params ?? {}
        }
      });

      if (response.error) {
        return this.error("mcp_error", response.error.message, undefined, response.error.code);
      }

      // Record usage for adaptive promotion
      if (this.promotion) {
        this.promotion.recordCall(server, tool);
      }

      // Security pipeline: truncate → sanitize → trust-tag
      const result = processResult(response.result, server, serverConfig, this.clientConfig);
      return { server, action: "call", tool, result };
    } catch (error) {
      return this.error("mcp_error", error instanceof Error ? error.message : String(error));
    }
  }

  async getToolList(server: string): Promise<RouterToolHint[]> {
    if (!this.servers[server]) {
      throw new Error(`Server '${server}' not found`);
    }

    const state = await this.ensureConnected(server);
    if (state.toolsCache) {
      this.markUsed(server);
      return state.toolsCache;
    }

    const allTools = await fetchToolsList(state.transport);
    const serverConfig = this.servers[server];
    const tools = allTools.filter((tool) => isToolAllowed(tool.name, serverConfig));
    state.toolNames = tools.map((tool) => tool.name);

    // Store full tool metadata for action=schema
    state.fullToolsMap = new Map(
      tools.map((tool) => [tool.name, { description: tool.description || "", inputSchema: tool.inputSchema }])
    );

    const compressionEnabled = this.clientConfig.schemaCompression?.enabled ?? true;
    const maxLen = this.clientConfig.schemaCompression?.maxDescriptionLength ?? 80;

    state.toolsCache = tools.map((tool) => ({
      name: tool.name,
      description: compressionEnabled
        ? compressDescription(tool.description || "", maxLen)
        : (tool.description || ""),
      requiredParams: this.extractRequiredParams(tool)
    }));

    this.markUsed(server);
    return state.toolsCache;
  }

  private async resolveIntent(intent: string): Promise<RouterDispatchResponse> {
    try {
      // Lazily create the intent router
      if (!this.intentRouter) {
        const routingConfig = this.clientConfig.intentRouting;
        const embeddingType = routingConfig?.embedding ?? "auto";
        const provider = createEmbeddingProvider(
          embeddingType,
          { model: routingConfig?.model },
          this.logger
        );
        this.intentRouter = new IntentRouter(
          provider,
          this.logger,
          routingConfig?.minScore
        );
      }

      // Index tools if not already done
      if (!this.intentRouter.isIndexed()) {
        const allTools: Record<string, McpTool[]> = {};
        for (const serverName of Object.keys(this.servers)) {
          try {
            await this.getToolList(serverName);
            const state = this.states.get(serverName);
            if (state?.fullToolsMap) {
              allTools[serverName] = [...state.fullToolsMap.entries()].map(([name, meta]) => ({
                name,
                description: meta.description,
                inputSchema: meta.inputSchema
              }));
            }
          } catch (err) {
            this.logger.warn(`[mcp-bridge] Intent routing: failed to index tools from ${serverName}:`, err);
          }
        }
        await this.intentRouter.indexTools(allTools);
      }

      const match = await this.intentRouter.resolve(intent);
      if (!match) {
        return this.error("invalid_params", `No tool found matching intent: "${intent}"`);
      }

      return {
        action: "intent",
        intent,
        match: { server: match.server, tool: match.tool, score: match.score },
        alternatives: match.alternatives
      };
    } catch (err) {
      return this.error("mcp_error", `Intent resolution failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private getStatus(): RouterDispatchResponse {
    const serverStatuses: RouterServerStatus[] = Object.entries(this.servers).map(([name, config]) => {
      const state = this.states.get(name);
      let status: "connected" | "idle" | "disconnected" = "disconnected";
      if (state?.transport.isConnected()) {
        const idleMs = Date.now() - state.lastUsedAt;
        status = idleMs > 60_000 ? "idle" : "connected";
      }
      return {
        name,
        transport: config.transport,
        status,
        tools: state?.toolNames.length ?? 0,
        ...(state?.lastUsedAt ? { lastUsed: new Date(state.lastUsedAt).toISOString() } : {})
      };
    });
    return { action: "status", servers: serverStatuses };
  }

  getPromotedTools(): Array<{ server: string; tool: string; toolHint: RouterToolHint; inputSchema: any }> {
    if (!this.promotion) return [];

    const promoted = this.promotion.getPromotedTools();
    const result: Array<{ server: string; tool: string; toolHint: RouterToolHint; inputSchema: any }> = [];

    for (const p of promoted) {
      const state = this.states.get(p.server);
      const fullTool = state?.fullToolsMap?.get(p.tool);
      const hint = state?.toolsCache?.find(t => t.name === p.tool);
      if (fullTool && hint) {
        result.push({
          server: p.server,
          tool: p.tool,
          toolHint: hint,
          inputSchema: fullTool.inputSchema
        });
      }
    }

    return result;
  }

  private getPromotionStats(): RouterDispatchResponse {
    if (!this.promotion) {
      return { action: "promotions", promoted: [], stats: [] };
    }

    const promoted = this.promotion.getPromotedTools();
    const stats = this.promotion.getStats().map(s => ({
      ...s,
      lastCall: new Date(s.lastCall).toISOString()
    }));

    return { action: "promotions", promoted, stats };
  }

  async disconnectAll(): Promise<void> {
    for (const serverName of Object.keys(this.servers)) {
      await this.disconnectServer(serverName);
    }
  }

  private async ensureConnected(server: string): Promise<RouterServerState> {
    let state = this.states.get(server);
    if (!state) {
      const transport = this.createTransport(server, this.servers[server]);
      state = {
        transport,
        initialized: false,
        toolNames: [],
        lastUsedAt: Date.now(),
        idleTimer: null
      };
      this.states.set(server, state);
    }

    if (state.initPromise) {
      await state.initPromise;
      return state;
    }

    state.initPromise = (async () => {
      if (!state!.transport.isConnected()) {
        await state!.transport.connect();
      }
      if (!state!.initialized) {
        await initializeProtocol(state!.transport, PACKAGE_VERSION);
        state!.initialized = true;
      }
      this.markUsed(server);
      await this.enforceMaxConcurrent(server);
    })();

    try {
      await state.initPromise;
      return state;
    } finally {
      state.initPromise = undefined;
    }
  }

  private async enforceMaxConcurrent(activeServer: string): Promise<void> {
    const connectedServers = [...this.states.entries()]
      .filter(([_, s]) => s.transport.isConnected())
      .map(([name, s]) => ({ name, lastUsedAt: s.lastUsedAt }));

    if (connectedServers.length <= this.maxConcurrent) {
      return;
    }

    connectedServers.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    for (const candidate of connectedServers) {
      if (candidate.name === activeServer) {
        continue;
      }
      await this.disconnectServer(candidate.name);
      this.logger.info(`[mcp-bridge] Router evicted idle server via LRU: ${candidate.name}`);
      return;
    }
  }

  private async disconnectServer(server: string): Promise<void> {
    const state = this.states.get(server);
    if (!state) return;

    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = null;
    }

    if (state.transport.isConnected()) {
      await state.transport.disconnect();
    }

    state.initialized = false;
    state.toolsCache = undefined;
    state.fullToolsMap = undefined;
    state.toolNames = [];
  }

  private markUsed(server: string): void {
    const state = this.states.get(server);
    if (!state) return;

    state.lastUsedAt = Date.now();

    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
    }

    state.idleTimer = setTimeout(() => {
      this.disconnectServer(server).catch((error) => {
        this.logger.warn(`[mcp-bridge] Router idle disconnect failed for ${server}:`, error);
      });
    }, this.idleTimeoutMs);
    // Don't keep the process alive just for idle disconnect
    if (state.idleTimer && typeof state.idleTimer.unref === "function") {
      state.idleTimer.unref();
    }
  }

  private createTransport(serverName: string, serverConfig: McpServerConfig): McpTransport {
    const onReconnected = async () => {
      const state = this.states.get(serverName);
      if (!state) return;
      state.initialized = false;
      state.toolsCache = undefined;
      state.fullToolsMap = undefined;
      state.toolNames = [];
    };

    if (serverConfig.transport === "sse") {
      return new this.transportRefs.sse(serverConfig, this.clientConfig, this.logger, onReconnected);
    }
    if (serverConfig.transport === "stdio") {
      return new this.transportRefs.stdio(serverConfig, this.clientConfig, this.logger, onReconnected);
    }
    if (serverConfig.transport === "streamable-http") {
      return new this.transportRefs.streamableHttp(serverConfig, this.clientConfig, this.logger, onReconnected);
    }

    throw new Error(`Unsupported transport: ${serverConfig.transport}`);
  }

  private extractRequiredParams(tool: McpTool): string[] {
    const required = tool.inputSchema?.required;
    if (!Array.isArray(required)) {
      return [];
    }
    return required.filter((name: unknown) => typeof name === "string");
  }

  private error(error: RouterErrorCode, message: string, available?: string[], code?: number): RouterDispatchResponse {
    return {
      error,
      message,
      ...(available ? { available } : {}),
      ...(typeof code === "number" ? { code } : {})
    };
  }
}
