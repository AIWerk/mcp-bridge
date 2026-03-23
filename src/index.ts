// Core exports for @aiwerk/mcp-bridge

// Transport classes
export {
  BaseTransport,
  resolveEnvVars,
  resolveEnvRecord,
  resolveArgs,
  resolveAuthHeaders,
  resolveAuthHeadersAsync,
  isAuthCodeOAuth2,
  resolveOAuth2Config,
  resolveAuthCodeOAuth2Config,
  resolveServerHeaders,
  resolveServerHeadersAsync,
  warnIfNonTlsRemoteUrl,
} from "./transport-base.js";
export { StdioTransport } from "./transport-stdio.js";
export { SseTransport } from "./transport-sse.js";
export { StreamableHttpTransport } from "./transport-streamable-http.js";
export { OAuth2TokenManager } from "./oauth2-token-manager.js";
export type { OAuth2Config, AuthCodeOAuth2Config } from "./oauth2-token-manager.js";

// Token store
export { FileTokenStore } from "./token-store.js";
export type { TokenStore, StoredToken } from "./token-store.js";

// CLI auth
export { performAuthCodeLogin, generateCodeVerifier, computeCodeChallenge } from "./cli-auth.js";
export type { AuthCodeConfig } from "./cli-auth.js";

// Router
export { McpRouter } from "./mcp-router.js";
export type { RouterToolHint, RouterServerStatus, RouterDispatchResponse, RouterTransportRefs } from "./mcp-router.js";

// Result cache
export { ResultCache, createResultCacheKey, stableStringify } from "./result-cache.js";
export type { ResultCacheConfig, ResultCacheStats } from "./result-cache.js";
export { RateLimiter } from "./rate-limiter.js";
export type { RateLimitConfig, RateLimitResult } from "./rate-limiter.js";
export { ToolResolver } from "./tool-resolution.js";
export type { ToolResolutionResult, ToolResolutionCandidate } from "./tool-resolution.js";

// Schema conversion
export { convertJsonSchemaToTypeBox, createToolParameters, setTypeBoxLoader, setSchemaLogger } from "./schema-convert.js";

// Protocol helpers
export { initializeProtocol, fetchToolsList, PACKAGE_VERSION } from "./protocol.js";

// Config
export { loadConfig, parseEnvFile, initConfigDir, getConfigDir, bootstrapCatalog, mergeRecipesIntoConfig } from "./config.js";

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
  RequestIdState,
  RequestIdGenerator,
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

// Catalog client
export { CatalogClient, CatalogError } from "./catalog-client.js";
export type { CatalogRecipe, CatalogSearchResult } from "./catalog-client.js";

// Recipe cache
export { RecipeCache } from "./recipe-cache.js";
export type { CachedRecipe } from "./recipe-cache.js";
