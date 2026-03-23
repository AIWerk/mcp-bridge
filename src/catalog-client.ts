/**
 * CatalogClient — connects to the AIWerk MCP Catalog at catalog.aiwerk.ch/mcp
 *
 * Uses the MCP Streamable HTTP transport (JSON-RPC over HTTP POST).
 * Singleton pattern — one shared client for all users.
 */

import type { McpServerConfig } from "./types.js";

const CATALOG_URL = process.env.CATALOG_URL ?? "https://catalog.aiwerk.ch/mcp";

// ── Catalog recipe types ─────────────────────────────────────────────────────

export interface CatalogRecipe {
  name: string;
  description?: string;
  transports?: Array<{ type: string; url?: string }>;
  install?: {
    npm?: { package: string; version?: string };
    docker?: { image: string };
  };
  auth?: {
    type: string;
    envVars?: string[];
  };
  [key: string]: unknown;
}

// ── JSON-RPC types ───────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: {
    content?: Array<{ type: string; text: string }>;
    [key: string]: unknown;
  };
  error?: { code: number; message: string };
}

// ── CatalogClient ────────────────────────────────────────────────────────────

export class CatalogClient {
  private initialized = false;
  private sessionId?: string;
  private requestId = 0;
  private catalogUrl: string;

  constructor(catalogUrl?: string) {
    this.catalogUrl = catalogUrl ?? CATALOG_URL;
  }

  /**
   * Send a raw JSON-RPC POST to the catalog.
   * Handles SSE and plain JSON responses, captures session ID header.
   */
  private async post(body: JsonRpcRequest): Promise<JsonRpcResponse> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (this.sessionId) {
      headers["mcp-session-id"] = this.sessionId;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    let res: Response;
    try {
      res = await fetch(this.catalogUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    // Capture session ID if provided
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const err = new Error(`Catalog HTTP ${res.status}: ${text}`);
      if (text.includes("Session") || text.includes("session") || text.includes("initialized") || res.status === 400) {
        (err as any).sessionError = true;
      }
      throw err;
    }

    const contentType = res.headers.get("content-type") ?? "";

    if (contentType.includes("text/event-stream")) {
      const text = await res.text();
      const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) throw new Error("Catalog SSE response contained no data line");
      return JSON.parse(dataLine.slice(5).trim()) as JsonRpcResponse;
    }

    return res.json() as Promise<JsonRpcResponse>;
  }

  /**
   * Send the MCP initialize handshake on first use.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    this.sessionId = undefined;

    const initRequest: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: this.requestId++,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "mcp-bridge", version: "1.0" },
      },
    };

    try {
      await this.post(initRequest);
    } catch (err) {
      if (err instanceof Error) {
        if (err.message.includes("already initialized")) {
          this.initialized = true;
          return;
        }
        if (err.message.includes("Session-Id") || err.message.includes("session")) {
          throw new Error("Catalog session conflict — catalog may need restart. Try again later.");
        }
      }
      throw err;
    }

    // Send notifications/initialized
    if (this.sessionId) {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": this.sessionId,
      };

      void fetch(this.catalogUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
          params: {},
        }),
      }).catch(() => {});
    }

    this.initialized = true;
  }

  /**
   * Call a catalog tool and return its parsed result.
   * Each call starts a fresh session to avoid session state conflicts.
   */
  private async callTool(toolName: string, args: Record<string, unknown> = {}): Promise<unknown> {
    this.reset();
    await this.ensureInitialized();

    let res: JsonRpcResponse;
    try {
      res = await this.post({
        jsonrpc: "2.0",
        id: this.requestId++,
        method: "tools/call",
        params: { name: toolName, arguments: args },
      });
    } catch (err) {
      if (err instanceof Error && (err as any).sessionError) {
        this.reset();
        await this.ensureInitialized();
        res = await this.post({
          jsonrpc: "2.0",
          id: this.requestId++,
          method: "tools/call",
          params: { name: toolName, arguments: args },
        });
      } else {
        throw err;
      }
    }

    if (res.error) {
      throw new Error(`Catalog tool "${toolName}" error: ${res.error.message}`);
    }

    const content = res.result?.content;
    if (!Array.isArray(content) || content.length === 0) {
      return null;
    }

    const text = content[0]?.text;
    if (typeof text === "string") {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }

    return content[0];
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Search for MCP servers by keyword. */
  async search(query: string): Promise<unknown> {
    return this.callTool("catalog.search", { query });
  }

  /** List all available servers in the catalog. */
  async list(): Promise<unknown> {
    return this.callTool("catalog.list");
  }

  /** Get details about a specific server. */
  async info(name: string): Promise<unknown> {
    return this.callTool("catalog.info", { name });
  }

  /** Download the full recipe JSON for a server. */
  async download(name: string): Promise<CatalogRecipe> {
    return this.callTool("catalog.download", { name }) as Promise<CatalogRecipe>;
  }

  /**
   * Reset the client state (e.g. after a session error).
   * The next call will re-initialize.
   */
  reset(): void {
    this.initialized = false;
    this.sessionId = undefined;
    this.requestId = 0;
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _instance: CatalogClient | undefined;

export function getCatalogClient(): CatalogClient {
  if (!_instance) _instance = new CatalogClient();
  return _instance;
}

/** Reset the singleton (for tests). */
export function resetCatalogClient(): void {
  _instance = undefined;
}

// ── Recipe conversion ─────────────────────────────────────────────────────────

/**
 * Convert a catalog recipe into the bridge's McpServerConfig format.
 */
export function recipeToConfig(recipe: CatalogRecipe): McpServerConfig {
  const transport = (recipe.transports?.[0]?.type ?? "stdio") as McpServerConfig["transport"];

  const config: McpServerConfig = {
    transport,
    description: recipe.description,
  };

  if (transport === "stdio") {
    const npm = recipe.install?.npm;
    if (npm) {
      config.command = "npx";
      const pkg = npm.version ? `${npm.package}@${npm.version}` : npm.package;
      config.args = ["-y", pkg];
    }
  } else {
    config.url = recipe.transports?.[0]?.url;
  }

  const envVars = recipe.auth?.envVars;
  if (envVars && envVars.length > 0) {
    config.env = {};
    for (const varName of envVars) {
      config.env[varName] = `\${${varName}}`;
    }
  }

  return config;
}
