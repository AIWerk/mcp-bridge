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
import { ResultCache, createResultCacheKey } from "./result-cache.js";
import { ToolResolver } from "./tool-resolution.js";
import { OAuth2TokenManager } from "./oauth2-token-manager.js";

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
  | { server: string; action: "call"; tool: string; result: any; retries?: number }
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
      ambiguous: true;
      message: string;
      candidates: Array<{ server: string; tool: string; score: number; suggested?: true }>;
    }
  | {
      error: RouterErrorCode;
      message: string;
      available?: string[];
      code?: number;
    };

export interface RouterTransportRefs {
  sse: new (
    config: McpServerConfig,
    clientConfig: McpClientConfig,
    logger: Logger,
    onReconnected?: () => Promise<void>,
    tokenManager?: OAuth2TokenManager
  ) => McpTransport;
  stdio: new (
    config: McpServerConfig,
    clientConfig: McpClientConfig,
    logger: Logger,
    onReconnected?: () => Promise<void>
  ) => McpTransport;
  streamableHttp: new (
    config: McpServerConfig,
    clientConfig: McpClientConfig,
    logger: Logger,
    onReconnected?: () => Promise<void>,
    tokenManager?: OAuth2TokenManager
  ) => McpTransport;
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
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000;

interface NormalizedRetryPolicy {
  maxAttempts: number;
  delayMs: number;
  backoffMultiplier: number;
  retryOn: Set<"timeout" | "connection_error">;
}

export class McpRouter {
  private readonly servers: Record<string, McpServerConfig>;
  private readonly clientConfig: McpClientConfig;
  private readonly logger: Logger;
  private readonly transportRefs: RouterTransportRefs;
  private readonly idleTimeoutMs: number;
  private readonly maxConcurrent: number;
  private readonly resultCache: ResultCache | null;
  private readonly maxBatchSize: number;
  private readonly states = new Map<string, RouterServerState>();
  private readonly toolResolver: ToolResolver;
  private readonly tokenManager: OAuth2TokenManager;
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
    this.resultCache = clientConfig.resultCache?.enabled
      ? new ResultCache({
          maxEntries: clientConfig.resultCache.maxEntries,
          defaultTtlMs: clientConfig.resultCache.defaultTtlMs,
          cacheTtl: clientConfig.resultCache.cacheTtl
        })
      : null;
    this.maxBatchSize = clientConfig.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    this.toolResolver = new ToolResolver(Object.keys(servers));
    this.tokenManager = new OAuth2TokenManager(logger);

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
              result: "result" in response ? response.result : response
            };
          })
        );

        return { action: "batch", results };
      }
      if (normalizedAction === "list") {
        if (!server) {
          return this.error("invalid_params", "server is required for action=list");
        }
        if (!this.servers[server]) {
          return this.error("unknown_server", `Server '${server}' not found`, Object.keys(this.servers));
        }
        try {
          const tools = await this.getToolList(server);
          return { server, action: "list", tools };
        } catch (error) {
          return this.error("connection_failed", `Failed to connect to ${server}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (normalizedAction === "schema") {
        if (!server) {
          return this.error("invalid_params", "server is required for action=schema");
        }
        if (!this.servers[server]) {
          return this.error("unknown_server", `Server '${server}' not found`, Object.keys(this.servers));
        }
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
        if (!server) {
          return this.error("invalid_params", "server is required for action=refresh");
        }
        if (!this.servers[server]) {
          return this.error("unknown_server", `Server '${server}' not found`, Object.keys(this.servers));
        }
        this.resultCache?.invalidate();
        try {
          const state = await this.ensureConnected(server);
          state.toolsCache = undefined;
          state.fullToolsMap = undefined;
          state.toolNames = [];
          this.toolResolver.removeServer(server);
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

      let targetServer = server;
      if (!targetServer) {
        await this.primeToolResolutionIndex();
        const resolution = this.toolResolver.resolve(tool, params ?? {});
        if (!resolution) {
          return this.error("unknown_tool", `Tool '${tool}' was not found on any connected server`, this.toolResolver.getKnownToolNames());
        }
        if ("ambiguous" in resolution) {
          return resolution;
        }
        targetServer = resolution.server;
      }

      if (!this.servers[targetServer]) {
        return this.error("unknown_server", `Server '${targetServer}' not found`, Object.keys(this.servers));
      }

      try {
        await this.getToolList(targetServer);
      } catch (error) {
        return this.error("connection_failed", `Failed to connect to ${targetServer}: ${error instanceof Error ? error.message : String(error)}`);
      }
      const state = this.states.get(targetServer)!;

      if (!state.toolNames.includes(tool)) {
        return this.error("unknown_tool", `Tool '${tool}' not found on server '${targetServer}'`, state.toolNames);
      }

      // Defense in depth: double-check tool filter
      const serverConfig = this.servers[targetServer];
      if (!isToolAllowed(tool, serverConfig)) {
        return this.error("unknown_tool", `Tool '${tool}' is not allowed on server '${targetServer}'`, state.toolNames);
      }

      server = targetServer;

      const cacheKey = this.resultCache
        ? createResultCacheKey(server, tool, params ?? {})
        : null;
      if (this.resultCache && cacheKey) {
        const cachedResult = this.resultCache.get(cacheKey);
        if (cachedResult !== undefined) {
          if (this.promotion) {
            this.promotion.recordCall(server, tool);
          }
          this.toolResolver.recordCall(server, tool);
          return { server, action: "call", tool, result: cachedResult };
        }
      }

      this.markUsed(server);
      const callOutcome = await this.callToolWithRetry(server, tool, params ?? {}, state.transport);
      const response = callOutcome.response;

      if (response.error) {
        return this.error("mcp_error", response.error.message, undefined, response.error.code);
      }

      // Record usage for adaptive promotion
      if (this.promotion) {
        this.promotion.recordCall(server, tool);
      }
      this.toolResolver.recordCall(server, tool);

      // Security pipeline: truncate → sanitize → trust-tag
      const result = processResult(response.result, server, serverConfig, this.clientConfig);
      if (this.resultCache && cacheKey) {
        this.resultCache.set(cacheKey, result);
      }
      return {
        server,
        action: "call",
        tool,
        result,
        ...(callOutcome.retries > 0 ? { retries: callOutcome.retries } : {})
      };
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

    this.toolResolver.registerServerTools(server, tools.map((tool) => ({
      name: tool.name,
      inputSchema: tool.inputSchema
    })));

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

  private async primeToolResolutionIndex(): Promise<void> {
    for (const serverName of Object.keys(this.servers)) {
      try {
        await this.getToolList(serverName);
      } catch (error) {
        this.toolResolver.removeServer(serverName);
        this.logger.warn(`[mcp-bridge] Tool resolution: failed to load tools from ${serverName}:`, error);
      }
    }
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

  private getRetryPolicy(server: string): NormalizedRetryPolicy {
    const globalRetry = this.clientConfig.retry ?? {};
    const serverRetry = this.servers[server].retry ?? {};

    const maxAttemptsRaw = serverRetry.maxAttempts ?? globalRetry.maxAttempts ?? 1;
    const delayMsRaw = serverRetry.delayMs ?? globalRetry.delayMs ?? 1000;
    const backoffMultiplierRaw = serverRetry.backoffMultiplier ?? globalRetry.backoffMultiplier ?? 2;
    const retryOn = serverRetry.retryOn ?? globalRetry.retryOn ?? ["timeout", "connection_error"];

    return {
      maxAttempts: Math.max(1, Math.floor(maxAttemptsRaw)),
      delayMs: Math.max(0, Math.floor(delayMsRaw)),
      backoffMultiplier: Math.max(1, backoffMultiplierRaw),
      retryOn: new Set(retryOn)
    };
  }

  private classifyTransientError(error: unknown): "timeout" | "connection_error" | null {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

    if (
      message.includes("timeout") ||
      message.includes("timed out") ||
      message.includes("abort")
    ) {
      return "timeout";
    }

    if (
      message.includes("connection") ||
      message.includes("econnreset") ||
      message.includes("socket hang up") ||
      message.includes("network") ||
      message.includes("fetch failed") ||
      message.includes("econnrefused") ||
      message.includes("enotfound")
    ) {
      return "connection_error";
    }

    return null;
  }

  private async callToolWithRetry(
    server: string,
    tool: string,
    args: any,
    transport: McpTransport
  ): Promise<{ response: any; retries: number }> {
    const retryPolicy = this.getRetryPolicy(server);
    let retries = 0;
    let lastError: unknown;

    for (let attempt = 0; attempt < retryPolicy.maxAttempts; attempt++) {
      try {
        const response = await transport.sendRequest({
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            name: tool,
            arguments: args
          }
        });
        return { response, retries };
      } catch (error) {
        lastError = error;
        const category = this.classifyTransientError(error);
        const shouldRetry =
          category !== null &&
          retryPolicy.retryOn.has(category) &&
          attempt < retryPolicy.maxAttempts - 1;

        if (!shouldRetry) {
          throw error;
        }

        retries += 1;
        const delay = retryPolicy.delayMs * Math.pow(retryPolicy.backoffMultiplier, attempt);
        if (delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async disconnectAll(): Promise<void> {
    for (const serverName of Object.keys(this.servers)) {
      await this.disconnectServer(serverName);
    }
  }

  async shutdown(timeoutMs: number = this.clientConfig.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS): Promise<void> {
    const effectiveTimeout = Math.max(0, timeoutMs);

    for (const [serverName, state] of this.states) {
      if (state.idleTimer) {
        clearTimeout(state.idleTimer);
        state.idleTimer = null;
      }

      try {
        if (state.transport.shutdown) {
          await state.transport.shutdown(effectiveTimeout);
        } else {
          await state.transport.disconnect();
        }
      } catch (error) {
        this.logger.warn(`[mcp-bridge] Router shutdown: failed to close ${serverName}:`, error);
      }
    }

    this.states.clear();
    this.toolResolver.clear();
    if (this.intentRouter) {
      this.intentRouter.clearIndex();
    }
    this.resultCache?.invalidate();
    this.tokenManager.clear();
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
    this.toolResolver.removeServer(server);
    this.resultCache?.invalidate(`${server}:`);
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
      this.toolResolver.removeServer(serverName);
      this.resultCache?.invalidate(`${serverName}:`);
    };

    if (serverConfig.transport === "sse") {
      return new this.transportRefs.sse(serverConfig, this.clientConfig, this.logger, onReconnected, this.tokenManager);
    }
    if (serverConfig.transport === "stdio") {
      return new this.transportRefs.stdio(serverConfig, this.clientConfig, this.logger, onReconnected);
    }
    if (serverConfig.transport === "streamable-http") {
      return new this.transportRefs.streamableHttp(serverConfig, this.clientConfig, this.logger, onReconnected, this.tokenManager);
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
