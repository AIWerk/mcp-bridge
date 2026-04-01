import test from "node:test";
import assert from "node:assert/strict";
import { McpRouter } from "../src/mcp-router.ts";
import type { McpServerConfig, McpClientConfig } from "../src/types.ts";

const noop = () => {};
const noopLogger = { info: noop, warn: noop, error: noop, debug: noop };

function makeRouter(servers: Record<string, McpServerConfig> = {}): McpRouter {
  const config: McpClientConfig = { servers };
  return new McpRouter(servers, config, noopLogger as any);
}
