export interface Logger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
}

export type HttpAuthConfig =
  | { type: "bearer"; token: string }
  | { type: "header"; headers: Record<string, string> }
  | {
      type: "oauth2";
      clientId: string;
      clientSecret: string;
      tokenUrl: string;
      scopes?: string[];
      audience?: string;
    }
  | {
      type: "oauth2";
      grantType: "authorization_code";
      authorizationUrl: string;
      tokenUrl: string;
      clientId?: string;
      clientSecret?: string;
      scopes?: string[];
      callbackPort?: number;
    }
  | {
      type: "oauth2";
      grantType: "device_code";
      deviceAuthorizationUrl: string;
      tokenUrl: string;
      clientId: string;
      clientSecret?: string;
      scopes?: string[];
    };

export interface RetryConfig {
  maxAttempts?: number;
  delayMs?: number;
  backoffMultiplier?: number;
  retryOn?: Array<"timeout" | "connection_error">;
}

export interface McpServerConfig {
  transport: "sse" | "stdio" | "streamable-http";
  /** Human-readable description for router tool description generation */
  description?: string;
  // SSE / streamable-http transport
  url?: string;
  headers?: Record<string, string>;
  auth?: HttpAuthConfig;
  // Stdio transport
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // Stdio framing override (default: auto-detect from first message)
  framing?: "auto" | "lsp" | "newline";
  // Security: trust level for results from this server
  trust?: "trusted" | "untrusted" | "sanitize";
  // Security: tool allow/deny filter
  toolFilter?: {
    deny?: string[];
    allow?: string[];
  };
  // Security: max result size (overrides global)
  maxResultChars?: number;
  // Per-server tool call retry policy (action=call only)
  retry?: RetryConfig;
  // Per-server call count limits
  rateLimit?: {
    maxCallsPerDay?: number;
    maxCallsPerMonth?: number;
  };
}

export interface McpClientConfig {
  servers: Record<string, McpServerConfig>;
  mode?: "direct" | "router";
  toolPrefix?: boolean | "auto";
  reconnectIntervalMs?: number;
  connectionTimeoutMs?: number;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  routerIdleTimeoutMs?: number;
  routerConnectErrorCooldownMs?: number;
  routerMaxConcurrent?: number;
  maxBatchSize?: number;
  schemaCompression?: {
    enabled?: boolean;
    maxDescriptionLength?: number;
  };
  intentRouting?: {
    embedding?: "auto" | "gemini" | "openai" | "ollama" | "keyword";
    model?: string;
    minScore?: number;
  };
  // Security: global max result size in chars
  maxResultChars?: number;
  // Dependency injection: custom env fallback for resolveEnvVars
  envFallback?: () => Record<string, string>;
  // Adaptive promotion: frequently used tools get promoted to standalone
  adaptivePromotion?: {
    enabled?: boolean;
    maxPromoted?: number;
    windowMs?: number;
    minCalls?: number;
    decayMs?: number;
  };
  // Global tool call retry policy (can be overridden per server)
  retry?: RetryConfig;
  // Tool call result cache (in-memory LRU)
  resultCache?: {
    enabled?: boolean;
    maxEntries?: number;
    defaultTtlMs?: number;
    // Per-tool TTL override keyed by "server:tool"
    cacheTtl?: Record<string, number>;
  };
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: any; // JSON Schema
}

/** Incoming JSON-RPC message (response or notification). */
export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | null;
  method?: string;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}

/** MCP JSON-RPC request. id is required for requests (omit only for notifications). */
export interface McpRequest {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params?: any;
}

/** MCP request that requires a response (id is mandatory). */
export interface McpCallRequest extends McpRequest {
  id: number;
}

export interface RequestIdState {
  value: number;
}

export type RequestIdGenerator = () => number;

export function nextRequestId(state: RequestIdState): number {
  state.value++;
  if (state.value >= Number.MAX_SAFE_INTEGER) {
    state.value = 1;
  }
  return state.value;
}

export interface McpResponse {
  jsonrpc: "2.0";
  id: number;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

export interface McpTransport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  shutdown?(timeoutMs?: number): Promise<void>;
  sendRequest(request: McpRequest): Promise<McpResponse>;
  sendNotification(notification: any): Promise<void>;
  isConnected(): boolean;
}

export interface McpServerConnection {
  name: string;
  transport: McpTransport;
  tools: McpTool[];
  isInitialized: boolean;
  registeredToolNames: string[];
}

/** Bridge-level config loaded from ~/.mcp-bridge/config.json */
export interface BridgeConfig extends McpClientConfig {
  http?: {
    auth?: HttpAuthConfig;
  };
  security?: {
    /**
     * When true, only load MCP servers whose depAudit is "clean" or "not-applicable".
     * Servers with "has-advisories", "skip", or other values are blocked at startup.
     * Default: false (advisories are logged as info, not blocked).
     */
    requireCleanAudit?: boolean;
  };
  /**
   * Whether bootstrapCatalog() fetches recipes from the remote catalog.
   * Default: true (catalog discovery is enabled).
   */
  catalog?: boolean;
  /**
   * Whether mergeRecipesIntoConfig() auto-merges cached recipes into config.
   * Default: false (opt-in). Set to true to enable automatic recipe merging.
   */
  autoMerge?: boolean;
}
