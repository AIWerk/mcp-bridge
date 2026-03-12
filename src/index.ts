// Core exports for @aiwerk/mcp-bridge

// Transport classes
export { BaseTransport, resolveEnvVars, resolveEnvRecord, resolveArgs, warnIfNonTlsRemoteUrl } from "./transport-base.js";
export { StdioTransport } from "./transport-stdio.js";
export { SseTransport } from "./transport-sse.js";
export { StreamableHttpTransport } from "./transport-streamable-http.js";

// Router
export { McpRouter } from "./mcp-router.js";
export type { RouterToolHint, RouterServerStatus, RouterDispatchResponse, RouterTransportRefs } from "./mcp-router.js";

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
  McpTool,
  McpRequest,
  McpCallRequest,
  McpResponse,
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
export { checkForUpdate, getUpdateNotice, runUpdate, resetNoticeFlag } from "./update-checker.js";
export type { UpdateInfo } from "./update-checker.js";

// Smart filter
export { filterServers, buildFilteredDescription } from "./smart-filter.js";
