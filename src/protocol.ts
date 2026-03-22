import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { McpRequest, McpResponse, McpTool, McpTransport } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function loadPackageVersion(): string {
  const candidates = [
    join(__dirname, "..", "package.json"),
    join(__dirname, "..", "..", "package.json"),
    join(__dirname, "..", "..", "..", "package.json"),
  ];
  for (const p of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(p, "utf-8"));
      if (pkg.version) return pkg.version;
    } catch { /* try next candidate */ }
  }
  return "0.0.0";
}

export const PACKAGE_VERSION: string = loadPackageVersion();

export async function initializeProtocol(transport: McpTransport, version: string): Promise<void> {
  const initRequest: McpRequest = {
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: {
        name: "mcp-bridge",
        version: version || PACKAGE_VERSION
      }
    }
  };

  const response = await transport.sendRequest(initRequest);
  if (response.error) {
    throw new Error(`Initialize failed: ${response.error.message}`);
  }

  await transport.sendNotification({
    jsonrpc: "2.0",
    method: "notifications/initialized"
  });
}

export async function fetchToolsList(transport: McpTransport): Promise<McpTool[]> {
  const allTools: McpTool[] = [];
  let cursor: string | undefined;
  const MAX_PAGES = 100;
  let page = 0;

  while (page++ < MAX_PAGES) {
    const request: McpRequest = {
      jsonrpc: "2.0",
      method: "tools/list",
      ...(cursor ? { params: { cursor } } : {})
    };

    const response: McpResponse = await transport.sendRequest(request);
    if (response.error) {
      throw new Error(response.error.message);
    }

    const pageTools = Array.isArray(response.result?.tools) ? response.result.tools : [];
    allTools.push(...pageTools);

    const nextCursor = response.result?.nextCursor;
    if (!nextCursor) {
      break;
    }
    cursor = nextCursor;
  }

  if (page >= MAX_PAGES) {
    process.stderr.write("[mcp-bridge] Tool list pagination exceeded max pages, possible cursor loop\n");
  }

  return allTools;
}
