// Core exports for @aiwerk/mcp-bridge

// Transport classes
export {
  BaseTransport,
  resolveEnvVars,
  resolveEnvRecord,
  resolveArgs,
  resolveAuthHeaders,
  resolveAuthHeadersAsync,
  resolveOAuth2Config,
  resolveServerHeaders,
  resolveServerHeadersAsync,
  warnIfNonTlsRemoteUrl,
} from "./transport-base.js";
export { StdioTransport } from "./transport-stdio.js";
export { SseTransport } from "./transport-sse.js";
export { StreamableHttpTransport } from "./transport-streamable-http.js";
export { OAuth2TokenManager } from "./oauth2-token-manager.js";
export type { OAuth2Config } from "./oauth2-token-manager.js";

// Router
export { McpRouter } from "./mcp-router.js";
export type { RouterToolHint, RouterServerStatus, RouterDispatchResponse, RouterTransportRefs } from "./mcp-router.js";

// Result cache
export { ResultCache, createResultCacheKey, stableStringify } from "./result-cache.js";
export type { ResultCacheConfig, ResultCacheStats } from "./result-cache.js";
export { ToolResolver } from "./tool-resolution.js";
export type { ToolResolutionResult, ToolResolutionCandidate } from "./tool-resolution.js";

// Schema conversion
export { convertJsonSchemaToTypeBox, createToolParameters, setTypeBoxLoader, setSchemaLogger } from "./schema-convert.js";

// Protocol helpers
export { initializeProtocol, fetchToolsList, PACKAGE_VERSION } from "./protocol.js";

// Config
export { loadConfig, parseEnvFile, initConfigDir, getConfigDir } from "./config.js";

// Types
export type {
  Logger,
  McpServerConfig,
  McpClientConfig,
  HttpAuthConfig,
  RetryConfig,
  McpTool,
  McpRequest,
  McpCallRequest,
  McpResponse,
  JsonRpcMessage,
  McpTransport,
  McpServerConnection,
  BridgeConfig,
} from "./types.js";
export { nextRequestId } from "./types.js";

// Tool naming
export { pickRegisteredToolName } from "./tool-naming.js";

// Standalone server
export { StandaloneServer } from "./standalone-server.js";

// Update checker
export { checkForUpdate, checkPluginUpdate, getUpdateNotice, runUpdate, resetNoticeFlag } from "./update-checker.js";
export type { UpdateInfo, PluginUpdateInfo } from "./update-checker.js";

// Smart filter
export { filterServers, buildFilteredDescription } from "./smart-filter.js";
