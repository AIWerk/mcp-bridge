#!/usr/bin/env node

import { readFileSync, existsSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join, dirname, resolve, extname } from "path";
import { fileURLToPath } from "url";
import { platform, homedir } from "os";
import { execFileSync, execSync } from "child_process";
import { loadConfig, initConfigDir, warnDeprecatedBundledRecipes, recipeToServerConfig, collectRequiredEnvVars } from "../src/config.js";
import { StandaloneServer } from "../src/standalone-server.js";
import { PACKAGE_VERSION } from "../src/protocol.js";
import { checkForUpdate, runUpdate } from "../src/update-checker.js";
import { FileTokenStore } from "../src/token-store.js";
import { performAuthCodeLogin, performDeviceCodeLogin } from "../src/cli-auth.js";
import { RateLimiter } from "../src/rate-limiter.js";
import { CatalogClient } from "../src/catalog-client.js";
import type { Logger, HttpAuthConfig } from "../src/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// After tsc, this file lives at dist/bin/mcp-bridge.js.
// Package root is two levels up: dist/bin/ -> dist/ -> package root.
const PACKAGE_ROOT = join(__dirname, "..", "..");

// -- Logger ---------------------------------------------------------------

type LogLevel = "error" | "warn" | "info" | "debug";

function createLogger(level: LogLevel): Logger {
  const levels: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };
  const threshold = levels[level];
  const ts = () => new Date().toISOString().replace("T", " ").replace("Z", "");
  const fmt = (a: unknown) => a instanceof Error ? (a.stack || a.message) : String(a);

  return {
    error: (...args: unknown[]) => {
      if (threshold >= 0) process.stderr.write(`[${ts()}] [ERROR] ${args.map(fmt).join(" ")}\n`);
    },
    warn: (...args: unknown[]) => {
      if (threshold >= 1) process.stderr.write(`[${ts()}] [WARN] ${args.map(fmt).join(" ")}\n`);
    },
    info: (...args: unknown[]) => {
      if (threshold >= 2) process.stderr.write(`[${ts()}] [INFO] ${args.map(fmt).join(" ")}\n`);
    },
    debug: (...args: unknown[]) => {
      if (threshold >= 3) process.stderr.write(`[${ts()}] [DEBUG] ${args.map(fmt).join(" ")}\n`);
    },
  };
}

// -- Arg parsing ----------------------------------------------------------

interface CliArgs {
  command: "serve" | "init" | "install" | "remove" | "catalog" | "servers" | "search" | "update" | "version" | "help" | "auth" | "usage" | "limit";
  authSubcommand?: "login" | "logout" | "status";
  sse: boolean;
  http: boolean;
  port: number;
  configPath?: string;
  verbose: boolean;
  debug: boolean;
  positional: string[];
  checkOnly: boolean;
  offline: boolean;
  daily?: number;
  monthly?: number;
  register?: string;
  mode?: "router" | "direct";
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    command: "serve",
    sse: false,
    http: false,
    port: 3000,
    verbose: false,
    debug: false,
    positional: [],
    checkOnly: false,
    offline: false,
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    switch (arg) {
      case "--sse": args.sse = true; break;
      case "--http": args.http = true; break;
      case "--port":
        i++;
        args.port = parseInt(argv[i], 10);
        if (isNaN(args.port)) { process.stderr.write("Error: --port requires a number\n"); process.exit(1); }
        break;
      case "--config":
        i++;
        if (!argv[i]) { process.stderr.write("Error: --config requires a path\n"); process.exit(1); }
        args.configPath = resolve(argv[i]);
        break;
      case "--verbose": args.verbose = true; break;
      case "--debug": args.debug = true; break;
      case "--version": args.command = "version"; break;
      case "--help": case "-h": args.command = "help"; break;
      case "--check": args.checkOnly = true; break;
      case "--offline": args.offline = true; break;
      case "--register":
        i++;
        if (!argv[i]) { process.stderr.write("Error: --register requires a client name (claude-code, codex, cursor, windsurf)\n"); process.exit(1); }
        args.register = argv[i];
        break;
      case "--mode":
        i++;
        if (argv[i] !== "router" && argv[i] !== "direct") { process.stderr.write("Error: --mode must be 'router' or 'direct'\n"); process.exit(1); }
        args.mode = argv[i] as "router" | "direct";
        break;
      case "--daily":
        i++;
        args.daily = parseInt(argv[i], 10);
        if (isNaN(args.daily)) { process.stderr.write("Error: --daily requires a number\n"); process.exit(1); }
        break;
      case "--monthly":
        i++;
        args.monthly = parseInt(argv[i], 10);
        if (isNaN(args.monthly)) { process.stderr.write("Error: --monthly requires a number\n"); process.exit(1); }
        break;
      case "init": args.command = "init"; break;
      case "install": args.command = "install"; break;
      case "remove": case "uninstall": args.command = "remove"; break;
      case "catalog": args.command = "catalog"; break;
      case "servers": args.command = "servers"; break;
      case "search": args.command = "search"; break;
      case "update": args.command = "update"; break;
      case "usage": args.command = "usage"; break;
      case "limit": args.command = "limit"; break;
      case "auth":
        args.command = "auth";
        // Consume subcommand
        if (i + 1 < argv.length) {
          const sub = argv[i + 1];
          if (sub === "login" || sub === "logout" || sub === "status") {
            args.authSubcommand = sub;
            i++;
          }
        }
        break;
      default:
        if (!arg.startsWith("-")) {
          args.positional.push(arg);
        }
        break;
    }
    i++;
  }

  return args;
}

// -- Commands -------------------------------------------------------------

function printVersion(): void {
  process.stdout.write(`mcp-bridge ${PACKAGE_VERSION}\n`);
}

function printHelp(): void {
  process.stdout.write(`
mcp-bridge v${PACKAGE_VERSION} — MCP server multiplexer

Usage:
  mcp-bridge                        Start in stdio mode (default)
  mcp-bridge --sse --port 3000      Start as SSE server
  mcp-bridge --http --port 3000     Start as streamable-http server
  mcp-bridge init [--register <client>] [--mode router|direct]  Create config + optionally register
  mcp-bridge install <server>       Install a server from the catalog
  mcp-bridge remove <server>        Remove a configured server
  mcp-bridge catalog [--offline]    List available servers
  mcp-bridge servers                List configured servers
  mcp-bridge search <query>         Search catalog by keyword
  mcp-bridge usage                  Show current per-server call usage
  mcp-bridge limit <server> [--daily N] [--monthly N]
                                    Set per-server rate limits (0 = unlimited)
  mcp-bridge update [--check]       Check for / install updates
  mcp-bridge auth login <server>    Authenticate with an OAuth2 server
  mcp-bridge auth logout <server>   Remove stored token for a server
  mcp-bridge auth status            Show auth status for all servers

Options:
  --config PATH     Custom config file (default: ~/.mcp-bridge/config.json)
  --verbose         Info-level logs to stderr
  --debug           Full protocol-level logs to stderr
  --version         Print version
  --help            Show this help

All logs go to stderr. Stdout is reserved for the MCP protocol (stdio mode).
`);
}

function whichCmd(name: string): boolean {
  try {
    execSync(`which ${name}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function cmdInit(logger: Logger, register?: string, mode?: "router" | "direct"): void {
  initConfigDir(logger);

  // Apply --mode to config
  if (mode) {
    const configPath = join(homedir(), ".mcp-bridge", "config.json");
    if (existsSync(configPath)) {
      try {
        const raw = JSON.parse(readFileSync(configPath, "utf-8"));
        if (raw.mode !== mode) {
          raw.mode = mode;
          writeFileSync(configPath, JSON.stringify(raw, null, 2) + "\n", "utf-8");
          process.stdout.write(`Mode set to "${mode}" in ${configPath}\n`);
        }
      } catch { /* ignore parse errors */ }
    }
  }

  // If --register is specified, do both mode + register
  const isGlobal = __dirname.includes("node_modules") && (
    __dirname.includes("/lib/node_modules/") || __dirname.includes("\\lib\\node_modules\\")
  );
  const bridgeCmd = isGlobal ? "mcp-bridge" : "node";
  const bridgeArgs = isGlobal ? ["serve"] : [join(__dirname, "..", "bin", "mcp-bridge.js"), "serve"];
  const cmd = isGlobal ? "mcp-bridge" : `node ${join(__dirname, "..", "bin", "mcp-bridge.js")}`;

  if (register) {
    registerClient(register, bridgeCmd, bridgeArgs, cmd);
    return;
  }

  const detected: string[] = [];
  if (whichCmd("claude")) detected.push("claude-code");
  if (whichCmd("codex")) detected.push("codex");
  if (existsSync(join(homedir(), ".cursor"))) detected.push("cursor");
  if (existsSync(join(homedir(), ".windsurf"))) detected.push("windsurf");

  if (detected.length > 0) {
    process.stdout.write("\nDetected MCP clients. Register with:\n");
    for (const client of detected) {
      process.stdout.write(`  mcp-bridge init --register ${client}\n`);
    }
  } else {
    process.stdout.write(`\nNo supported MCP client detected. Manual setup:\n\n  Claude Code:    claude mcp add -s user mcp-bridge -- ${cmd} serve\n  Codex:          codex mcp add mcp-bridge -- ${cmd} serve\n  Cursor:         Add to ~/.cursor/mcp.json\n  Claude Desktop: Add to claude_desktop_config.json\n  OpenClaw:       openclaw plugins install @aiwerk/openclaw-mcp-bridge\n\nJSON config block (Cursor/Claude Desktop/Windsurf):\n\n  {\n    "mcp-bridge": {\n      "command": "${isGlobal ? "mcp-bridge" : "node"}",\n      "args": ${JSON.stringify(bridgeArgs)}\n    }\n  }\n`);
  }

  if (!isGlobal) {
    process.stdout.write("\nTip: Install globally for a cleaner setup:\n  npm install -g @aiwerk/mcp-bridge\n");
  }
}

function registerClient(client: string, bridgeCmd: string, bridgeArgs: string[], cmd: string): void {
  switch (client) {
    case "claude-code": {
      try {
        execFileSync("claude", ["mcp", "add", "-s", "user", "mcp-bridge", "--", bridgeCmd, ...bridgeArgs], { stdio: "pipe" });
        process.stdout.write("✓ Registered with Claude Code → ~/.claude.json\n  Restart Claude Code to activate.\n");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("already exists")) {
          process.stdout.write("✓ Claude Code already configured.\n");
        } else {
          process.stdout.write(`⚠ Registration failed. Manual setup:\n  claude mcp add -s user mcp-bridge -- ${cmd} serve\n`);
        }
      }
      break;
    }
    case "codex": {
      const codexConfigPath = join(homedir(), ".codex", "config.toml");
      try {
        const codexConfig = existsSync(codexConfigPath) ? readFileSync(codexConfigPath, "utf-8") : "";
        if (codexConfig.includes("[mcp_servers.mcp-bridge]") || codexConfig.includes("[mcp_servers.aiwerk-bridge]")) {
          process.stdout.write("✓ Codex already configured.\n");
        } else {
          execFileSync("codex", ["mcp", "add", "mcp-bridge", "--", bridgeCmd, ...bridgeArgs], { stdio: "pipe" });
          process.stdout.write(`✓ Registered with Codex → ${codexConfigPath}\n  Restart Codex to activate.\n`);
        }
      } catch {
        process.stdout.write(`⚠ Registration failed. Manual setup:\n  codex mcp add mcp-bridge -- ${cmd} serve\n`);
      }
      break;
    }
    case "cursor": {
      const configPath = join(homedir(), ".cursor", "mcp.json");
      try {
        let config: any = {};
        if (existsSync(configPath)) config = JSON.parse(readFileSync(configPath, "utf-8"));
        if (!config.mcpServers) config.mcpServers = {};
        if (config.mcpServers["mcp-bridge"]) {
          process.stdout.write("✓ Cursor already configured.\n");
        } else {
          config.mcpServers["mcp-bridge"] = { command: bridgeCmd, args: bridgeArgs };
          writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
          process.stdout.write(`✓ Registered with Cursor → ${configPath}\n  Restart Cursor to activate.\n`);
        }
      } catch {
        process.stdout.write("⚠ Cursor registration failed.\n");
      }
      break;
    }
    case "windsurf": {
      const configPath = join(homedir(), ".windsurf", "mcp.json");
      try {
        let config: any = {};
        if (existsSync(configPath)) config = JSON.parse(readFileSync(configPath, "utf-8"));
        if (!config.mcpServers) config.mcpServers = {};
        if (config.mcpServers["mcp-bridge"]) {
          process.stdout.write("✓ Windsurf already configured.\n");
        } else {
          config.mcpServers["mcp-bridge"] = { command: bridgeCmd, args: bridgeArgs };
          writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
          process.stdout.write(`✓ Registered with Windsurf → ${configPath}\n  Restart Windsurf to activate.\n`);
        }
      } catch {
        process.stdout.write("⚠ Windsurf registration failed.\n");
      }
      break;
    }
    default: {
      const isGlob = bridgeCmd === "mcp-bridge";
      process.stdout.write(`Unknown client "${client}". Generic MCP config (add to your client's MCP settings):\n\n  {\n    "mcp-bridge": {\n      "command": "${isGlob ? "mcp-bridge" : "node"}",\n      "args": ${JSON.stringify(bridgeArgs)}\n    }\n  }\n\nKnown clients with auto-registration: claude-code, codex, cursor, windsurf\n`);
      break;
    }
  }
}

async function cmdCatalog(logger: Logger, offline: boolean): Promise<void> {
  const client = new CatalogClient({ logger });
  try {
    const result = await client.list({ limit: 200 });
    const recipes = result.results || [];

    process.stdout.write(`\nAvailable servers (${recipes.length} from catalog.aiwerk.ch):\n\n`);
    process.stdout.write("  Server                Auth        Category         Description\n");
    process.stdout.write("  " + "─".repeat(90) + "\n");

    for (const r of recipes as any[]) {
      const name = (r.name || "").padEnd(22);
      const auth = (r.authSummary || "none").padEnd(12);
      const cat = (r.category || "").padEnd(17);
      const desc = (r.description || "").slice(0, 60);
      process.stdout.write(`  ${name}${auth}${cat}${desc}\n`);
    }
    process.stdout.write("\n");
  } catch (err) {
    logger.error(`Failed to fetch catalog: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

function cmdServers(logger: Logger, configPath?: string): void {
  try {
    const config = loadConfig({ configPath, logger });
    const servers = config.servers || {};
    const entries = Object.entries(servers);

    if (entries.length === 0) {
      process.stdout.write("No servers configured.\n");
      return;
    }

    const maxName = Math.max(8, ...entries.map(([n]) => n.length)) + 2;

    process.stdout.write(`\nConfigured servers (${entries.length}):\n\n`);
    process.stdout.write(`  ${"Server".padEnd(maxName)}${"Transport".padEnd(14)}Description\n`);
    process.stdout.write("  " + "─".repeat(maxName + 14 + 40) + "\n");

    for (const [name, serverConfig] of entries) {
      const padded = name.padEnd(maxName);
      const transport = serverConfig.transport.padEnd(14);
      const desc = (serverConfig.description || "").slice(0, 60);
      process.stdout.write(`  ${padded}${transport}${desc}\n`);
    }
    process.stdout.write("\n");
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

async function cmdSearch(query: string, logger: Logger): Promise<void> {
  const client = new CatalogClient({ logger });
  try {
    const searchResponse = await client.search(query);
    const results = Array.isArray(searchResponse) ? searchResponse : (searchResponse as any).results || [];

    if (results.length === 0) {
      process.stdout.write(`No servers matching "${query}"\n`);
      return;
    }

    process.stdout.write(`\nSearch results for "${query}" (${results.length} found):\n\n`);
    for (const [i, r] of (results as any[]).entries()) {
      const auth = r.authSummary || (r.authRequired ? "required" : "none");
      process.stdout.write(`  ${i + 1}  ${(r.name || "").padEnd(22)}[${auth}] ${r.description || ""}\n`);
    }
    process.stdout.write("\n");
  } catch (err) {
    logger.error(`Search failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

function resolveConfigPath(configPath?: string): string {
  if (!configPath) {
    return join(homedir(), ".mcp-bridge", "config.json");
  }
  if (configPath.endsWith("/") || configPath.endsWith("\\") || !extname(configPath)) {
    return join(configPath, "config.json");
  }
  return configPath;
}

function cmdUsage(configPath: string | undefined, logger: Logger): void {
  try {
    const limiter = new RateLimiter();
    const usage = limiter.getAllUsage();

    let configServers: Record<string, any> = {};
    try {
      const config = loadConfig({ configPath, logger });
      configServers = config.servers ?? {};
    } catch {
      // Show usage files even when config is missing/unreadable.
    }

    const names = new Set<string>([...Object.keys(usage), ...Object.keys(configServers)]);
    if (names.size === 0) {
      process.stdout.write("No usage data found.\n");
      return;
    }

    process.stdout.write("\nRate limit usage (note: cached calls are not counted):\n\n");
    process.stdout.write("  Server          Daily        Monthly      Limits\n");
    process.stdout.write("  " + "─".repeat(78) + "\n");

    for (const server of [...names].sort((a, b) => a.localeCompare(b))) {
      const counts = usage[server] ?? { daily: 0, monthly: 0 };
      const limit = configServers[server]?.rateLimit;
      const dailyLimit = typeof limit?.maxCallsPerDay === "number" && limit.maxCallsPerDay > 0
        ? limit.maxCallsPerDay
        : "-";
      const monthlyLimit = typeof limit?.maxCallsPerMonth === "number" && limit.maxCallsPerMonth > 0
        ? limit.maxCallsPerMonth
        : "-";
      process.stdout.write(
        `  ${server.padEnd(16)}${`${counts.daily}`.padEnd(13)}${`${counts.monthly}`.padEnd(13)}daily=${dailyLimit} monthly=${monthlyLimit}\n`
      );
    }

    process.stdout.write("\n");
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

function cmdLimit(args: CliArgs, logger: Logger): void {
  const server = args.positional[0];
  if (!server) {
    process.stderr.write("Usage: mcp-bridge limit <server> --daily <n> --monthly <n>\n");
    process.exit(1);
  }

  const hasDaily = typeof args.daily === "number";
  const hasMonthly = typeof args.monthly === "number";
  if (!hasDaily && !hasMonthly) {
    process.stderr.write("Error: provide at least one limit flag (--daily or --monthly)\n");
    process.exit(1);
  }

  if (hasDaily && args.daily! < 0) {
    process.stderr.write("Error: --daily must be >= 0\n");
    process.exit(1);
  }
  if (hasMonthly && args.monthly! < 0) {
    process.stderr.write("Error: --monthly must be >= 0\n");
    process.exit(1);
  }

  const resolvedPath = resolveConfigPath(args.configPath);
  if (!existsSync(resolvedPath)) {
    logger.error(`Config file not found: ${resolvedPath}`);
    process.exit(1);
  }

  try {
    const raw = JSON.parse(readFileSync(resolvedPath, "utf-8"));
    if (!raw.servers || typeof raw.servers !== "object" || !raw.servers[server]) {
      logger.error(`Server "${server}" not found in config`);
      process.exit(1);
    }

    if (!raw.servers[server].rateLimit || typeof raw.servers[server].rateLimit !== "object") {
      raw.servers[server].rateLimit = {};
    }

    if (hasDaily) {
      if (args.daily === 0) {
        delete raw.servers[server].rateLimit.maxCallsPerDay;
      } else {
        raw.servers[server].rateLimit.maxCallsPerDay = args.daily;
      }
    }

    if (hasMonthly) {
      if (args.monthly === 0) {
        delete raw.servers[server].rateLimit.maxCallsPerMonth;
      } else {
        raw.servers[server].rateLimit.maxCallsPerMonth = args.monthly;
      }
    }

    if (
      raw.servers[server].rateLimit.maxCallsPerDay === undefined &&
      raw.servers[server].rateLimit.maxCallsPerMonth === undefined
    ) {
      delete raw.servers[server].rateLimit;
    }

    writeFileSync(resolvedPath, JSON.stringify(raw, null, 2) + "\n", "utf-8");

    const effectiveDaily = raw.servers[server].rateLimit?.maxCallsPerDay ?? "unlimited";
    const effectiveMonthly = raw.servers[server].rateLimit?.maxCallsPerMonth ?? "unlimited";
    process.stdout.write(
      `Updated limits for ${server}: daily=${effectiveDaily}, monthly=${effectiveMonthly}\n` +
      `Check usage with: mcp-bridge usage\n`
    );
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

async function cmdInstall(serverName: string, args: CliArgs, logger: Logger): Promise<void> {
  const configPath = resolveConfigPath(args.configPath);
  const configDir = dirname(configPath);
  
  // Ensure config dir exists
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
  
  // Ensure config file exists
  if (!existsSync(configPath)) {
    writeFileSync(configPath, JSON.stringify({ servers: {} }, null, 2) + "\n", "utf-8");
    logger.info(`Created config: ${configPath}`);
  }

  // Read current config
  const raw = JSON.parse(readFileSync(configPath, "utf-8"));
  if (!raw.servers) raw.servers = {};
  
  // Check if already configured
  if (raw.servers[serverName]) {
    process.stdout.write(`Server "${serverName}" is already configured.\n`);
    process.stdout.write(`Config: ${configPath}\n`);
    return;
  }

  // Fetch recipe from catalog
  process.stdout.write(`Fetching recipe for ${serverName}...\n`);
  const cacheDir = join(configDir, "recipes");
  const client = new CatalogClient({ cacheDir, logger });
  
  let recipe;
  try {
    recipe = await client.resolve(serverName);
  } catch (err) {
    logger.error(`Recipe not found: ${serverName}`);
    process.exit(1);
  }

  // Convert recipe to server config
  const serverConfig = recipeToServerConfig(recipe);
  if (!serverConfig) {
    logger.error(`Unsupported recipe format for "${serverName}"`);
    process.exit(1);
  }

  // Check required env vars
  const requiredVars = collectRequiredEnvVars(recipe);
  const missing = requiredVars.filter(v => !process.env[v]);

  // Add to config
  raw.servers[serverName] = serverConfig;
  writeFileSync(configPath, JSON.stringify(raw, null, 2) + "\n", "utf-8");

  process.stdout.write(`\n✓ Added "${serverName}" to ${configPath}\n\n`);

  if (missing.length > 0) {
    process.stdout.write(`⚠ Missing environment variables:\n`);
    for (const v of missing) {
      process.stdout.write(`  ${v}\n`);
    }
    // Show credentials URL if available
    const credUrl = (recipe.auth as any)?.credentialsUrl;
    if (credUrl) {
      process.stdout.write(`\nGet credentials: ${credUrl}\n`);
    }
    process.stdout.write(`\nSet them in your environment or ~/.mcp-bridge/.env before starting the bridge.\n`);
  } else {
    process.stdout.write(`All required environment variables are set. Ready to use.\n`);
  }

  // Pre-discover tools and cache them (so direct mode has tools on first start)
  // Try even with missing env vars — many servers respond to tools/list without auth
  process.stdout.write(`\nDiscovering tools...\n`);
  {
    try {
      const { StdioTransport } = await import("../src/transport-stdio.js");
      const { SseTransport } = await import("../src/transport-sse.js");
      const { StreamableHttpTransport } = await import("../src/transport-streamable-http.js");
      const { fetchToolsList, initializeProtocol, PACKAGE_VERSION } = await import("../src/protocol.js");

      let transport: any;
      if (serverConfig.transport === "stdio") {
        transport = new StdioTransport(serverConfig, { servers: {} } as any, logger, async () => {});
      } else if (serverConfig.transport === "sse") {
        transport = new SseTransport(serverConfig, { servers: {} } as any, logger, async () => {});
      } else if (serverConfig.transport === "streamable-http") {
        transport = new StreamableHttpTransport(serverConfig, { servers: {} } as any, logger, async () => {});
      }

      if (transport) {
        await transport.connect();
        await initializeProtocol(transport, PACKAGE_VERSION);
        const tools = await fetchToolsList(transport);

        // Save to cache
        const cacheToolDir = join(configDir, "cache");
        mkdirSync(cacheToolDir, { recursive: true });
        writeFileSync(
          join(cacheToolDir, `${serverName}-tools.json`),
          JSON.stringify(tools, null, 2),
          "utf-8"
        );

        process.stdout.write(`✓ Cached ${tools.length} tools from "${serverName}"\n`);

        // Disconnect
        await transport.disconnect().catch(() => {});
      }
    } catch (discErr) {
      // Non-fatal: tool discovery is a nice-to-have, server still installed
      logger.info(`Tool discovery skipped: ${discErr instanceof Error ? discErr.message : String(discErr)}`);
      process.stdout.write(`Tool discovery skipped (server will discover tools on first use).\n`);
    }
  }
}

function cmdRemove(serverName: string, args: CliArgs, logger: Logger): void {
  const configPath = resolveConfigPath(args.configPath);
  if (!existsSync(configPath)) {
    logger.error("No config file found.");
    process.exit(1);
  }

  const raw = JSON.parse(readFileSync(configPath, "utf-8"));
  if (!raw.servers || !raw.servers[serverName]) {
    process.stdout.write(`Server "${serverName}" is not configured.\n`);
    const available = Object.keys(raw.servers || {});
    if (available.length > 0) {
      process.stdout.write(`Configured servers: ${available.join(", ")}\n`);
    }
    process.exit(1);
  }

  // Remove from config
  delete raw.servers[serverName];
  writeFileSync(configPath, JSON.stringify(raw, null, 2) + "\n", "utf-8");
  process.stdout.write(`✓ Removed "${serverName}" from ${configPath}\n`);

  // Remove tool cache
  const cacheDir = join(dirname(configPath), "cache");
  const cachePath = join(cacheDir, `${serverName}-tools.json`);
  if (existsSync(cachePath)) {
    unlinkSync(cachePath);
    process.stdout.write(`✓ Removed tool cache for "${serverName}"\n`);
  }
}

async function cmdUpdate(logger: Logger, checkOnly: boolean): Promise<void> {
  if (checkOnly) {
    const info = await checkForUpdate(logger);
    if (info.updateAvailable) {
      process.stdout.write(`Update available: ${info.currentVersion} → ${info.latestVersion}\n`);
      process.stdout.write(`Run 'mcp-bridge update' to install.\n`);
    } else {
      process.stdout.write(`mcp-bridge ${info.currentVersion} is up to date.\n`);
    }
    return;
  }

  const result = await runUpdate(logger);
  process.stdout.write(result + "\n");
}

async function cmdAuth(args: CliArgs, logger: Logger): Promise<void> {
  const sub = args.authSubcommand;
  if (!sub) {
    process.stderr.write("Usage: mcp-bridge auth <login|logout|status> [server-name]\n");
    process.exit(1);
  }

  const tokenStore = new FileTokenStore();

  if (sub === "status") {
    let config;
    try {
      config = loadConfig({ configPath: args.configPath, logger });
    } catch {
      config = null;
    }

    const stored = tokenStore.list();
    if (stored.length === 0 && !config) {
      process.stdout.write("No stored tokens.\n");
      return;
    }

    process.stdout.write("\nAuth status:\n\n");
    process.stdout.write("  Server          Auth Type              Token Status\n");
    process.stdout.write("  " + "\u2500".repeat(60) + "\n");

    // Show configured servers
    const shown = new Set<string>();
    if (config) {
      for (const [name, serverConfig] of Object.entries(config.servers)) {
        const authType = serverConfig.auth?.type ?? "none";
        const grantType = serverConfig.auth?.type === "oauth2" && "grantType" in serverConfig.auth
          ? (serverConfig.auth as any).grantType
          : serverConfig.auth?.type === "oauth2" ? "client_credentials" : "";
        const label = authType === "oauth2" ? `oauth2 (${grantType})` : authType;

        const token = tokenStore.load(name);
        let status: string;
        if (token) {
          const now = Date.now();
          if (token.expiresAt > now) {
            const mins = Math.round((token.expiresAt - now) / 60000);
            status = `valid (expires in ${mins}m)`;
          } else {
            status = token.refreshToken ? "expired (refresh available)" : "expired";
          }
        } else if (grantType === "authorization_code" || grantType === "device_code") {
          status = "not authenticated";
        } else {
          status = "-";
        }

        process.stdout.write(`  ${name.padEnd(16)}${label.padEnd(23)}${status}\n`);
        shown.add(name);
      }
    }

    // Show stored tokens not in config
    for (const { serverName, token } of stored) {
      if (shown.has(serverName)) continue;
      const now = Date.now();
      const status = token.expiresAt > now
        ? `valid (expires in ${Math.round((token.expiresAt - now) / 60000)}m)`
        : "expired";
      process.stdout.write(`  ${serverName.padEnd(16)}${"oauth2 (stored)".padEnd(23)}${status}\n`);
    }

    process.stdout.write("\n");
    return;
  }

  // login / logout need a server name
  const serverName = args.positional[0];
  if (!serverName) {
    process.stderr.write(`Usage: mcp-bridge auth ${sub} <server-name>\n`);
    process.exit(1);
  }

  if (sub === "logout") {
    tokenStore.remove(serverName);
    process.stdout.write(`Removed stored token for ${serverName}\n`);
    return;
  }

  // login
  let config;
  try {
    config = loadConfig({ configPath: args.configPath, logger });
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const serverConfig = config.servers[serverName];
  if (!serverConfig) {
    logger.error(`Server "${serverName}" not found in config`);
    process.exit(1);
  }

  const auth = serverConfig.auth;
  if (!auth || auth.type !== "oauth2" || !("grantType" in auth)) {
    logger.error(`Server "${serverName}" is not configured for an interactive OAuth2 flow (authorization_code or device_code)`);
    process.exit(1);
  }

  const grantType = (auth as any).grantType;

  let token;
  if (grantType === "device_code") {
    const deviceAuth = auth as Extract<HttpAuthConfig, { grantType: "device_code" }>;
    token = await performDeviceCodeLogin(serverName, {
      deviceAuthorizationUrl: deviceAuth.deviceAuthorizationUrl,
      tokenUrl: deviceAuth.tokenUrl,
      clientId: deviceAuth.clientId,
      clientSecret: deviceAuth.clientSecret,
      scopes: deviceAuth.scopes,
    }, logger);
  } else if (grantType === "authorization_code") {
    const authCodeAuth = auth as Extract<HttpAuthConfig, { grantType: "authorization_code" }>;
    token = await performAuthCodeLogin(serverName, {
      authorizationUrl: authCodeAuth.authorizationUrl,
      tokenUrl: authCodeAuth.tokenUrl,
      clientId: authCodeAuth.clientId,
      clientSecret: authCodeAuth.clientSecret,
      scopes: authCodeAuth.scopes,
      callbackPort: authCodeAuth.callbackPort,
    }, logger);
  } else {
    logger.error(`Server "${serverName}" uses grant type "${grantType}" which does not support interactive login`);
    process.exit(1);
  }

  tokenStore.save(serverName, token);
  process.stdout.write(`Authentication successful for ${serverName}. Token stored.\n`);
}

async function cmdServe(args: CliArgs, logger: Logger): Promise<void> {
  // Auto-create config if missing (don't crash on first run)
  const configPath = resolveConfigPath(args.configPath);
  if (!existsSync(configPath)) {
    initConfigDir(logger);
  }

  let config;
  try {
    config = loadConfig({ configPath: args.configPath, logger });
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  if (args.debug) {
    config.debug = true;
  }

  // HTTP modes: require auth
  if ((args.sse || args.http) && !config.http?.auth) {
    logger.error("HTTP auth not configured. Set http.auth in config or use stdio mode.");
    process.exit(1);
  }

  // Warn about deprecated bundled recipes (v2.8.0+)
  warnDeprecatedBundledRecipes(logger);

  const server = new StandaloneServer(config, logger);

  // Graceful shutdown
  const shutdown = async () => {
    await server.shutdown();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  if (args.sse || args.http) {
    // SSE/HTTP mode: not yet implemented in standalone, show message
    logger.error("SSE and HTTP server modes are not yet implemented. Use stdio mode (default).");
    process.exit(1);
  }

  // Default: stdio mode
  await server.startStdio();
}

// -- Main -----------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const logLevel: LogLevel = args.debug ? "debug" : args.verbose ? "info" : "warn";
  const logger = createLogger(logLevel);

  switch (args.command) {
    case "version":
      printVersion();
      break;
    case "help":
      printHelp();
      break;
    case "init":
      cmdInit(logger, args.register, args.mode);
      break;
    case "catalog":
      await cmdCatalog(logger, args.offline);
      break;
    case "servers":
      cmdServers(logger, args.configPath);
      break;
    case "search":
      if (args.positional.length === 0) {
        process.stderr.write("Usage: mcp-bridge search <query>\n");
        process.exit(1);
      }
      await cmdSearch(args.positional[0], logger);
      break;
    case "usage":
      cmdUsage(args.configPath, logger);
      break;
    case "limit":
      cmdLimit(args, logger);
      break;
    case "install":
      if (args.positional.length === 0) {
        process.stderr.write("Usage: mcp-bridge install <server>\n");
        process.exit(1);
      }
      await cmdInstall(args.positional[0], args, logger);
      break;
    case "remove":
      if (args.positional.length === 0) {
        process.stderr.write("Usage: mcp-bridge remove <server>\n");
        process.exit(1);
      }
      cmdRemove(args.positional[0], args, logger);
      break;
    case "update":
      await cmdUpdate(logger, args.checkOnly);
      break;
    case "auth":
      await cmdAuth(args, logger);
      break;
    case "serve":
      await cmdServe(args, logger);
      break;
  }
}

main().catch(err => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
