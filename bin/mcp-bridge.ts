#!/usr/bin/env node

import { readFileSync, existsSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { loadConfig, initConfigDir, getConfigDir } from "../src/config.js";
import { StandaloneServer } from "../src/standalone-server.js";
import { PACKAGE_VERSION } from "../src/protocol.js";
import { checkForUpdate, runUpdate } from "../src/update-checker.js";
import type { Logger } from "../src/types.js";

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

  return {
    error: (...args: unknown[]) => {
      if (threshold >= 0) process.stderr.write(`[${ts()}] [ERROR] ${args.map(String).join(" ")}\n`);
    },
    warn: (...args: unknown[]) => {
      if (threshold >= 1) process.stderr.write(`[${ts()}] [WARN] ${args.map(String).join(" ")}\n`);
    },
    info: (...args: unknown[]) => {
      if (threshold >= 2) process.stderr.write(`[${ts()}] [INFO] ${args.map(String).join(" ")}\n`);
    },
    debug: (...args: unknown[]) => {
      if (threshold >= 3) process.stderr.write(`[${ts()}] [DEBUG] ${args.map(String).join(" ")}\n`);
    },
  };
}

// -- Arg parsing ----------------------------------------------------------

interface CliArgs {
  command: "serve" | "init" | "install" | "catalog" | "servers" | "search" | "update" | "version" | "help";
  sse: boolean;
  http: boolean;
  port: number;
  configPath?: string;
  verbose: boolean;
  debug: boolean;
  positional: string[];
  checkOnly: boolean;
  offline: boolean;
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
      case "init": args.command = "init"; break;
      case "install": args.command = "install"; break;
      case "catalog": args.command = "catalog"; break;
      case "servers": args.command = "servers"; break;
      case "search": args.command = "search"; break;
      case "update": args.command = "update"; break;
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
  mcp-bridge init                   Create ~/.mcp-bridge/ with config template
  mcp-bridge install <server>       Install a server from the catalog
  mcp-bridge catalog [--offline]    List available servers
  mcp-bridge servers                List configured servers
  mcp-bridge search <query>         Search catalog by keyword
  mcp-bridge update [--check]       Check for / install updates

Options:
  --config PATH     Custom config file (default: ~/.mcp-bridge/config.json)
  --verbose         Info-level logs to stderr
  --debug           Full protocol-level logs to stderr
  --version         Print version
  --help            Show this help

All logs go to stderr. Stdout is reserved for the MCP protocol (stdio mode).
`);
}

function cmdInit(logger: Logger): void {
  initConfigDir(logger);
}

function cmdCatalog(logger: Logger, offline: boolean): void {
  const catalogPath = join(PACKAGE_ROOT, "servers", "index.json");
  if (!existsSync(catalogPath)) {
    logger.error("Server catalog not found");
    process.exit(1);
  }

  const catalog = JSON.parse(readFileSync(catalogPath, "utf-8"));
  const servers = catalog.servers || {};

  process.stdout.write("\nAvailable servers:\n\n");
  process.stdout.write("  Server          Transport    Description\n");
  process.stdout.write("  " + "─".repeat(60) + "\n");

  for (const [name, info] of Object.entries(servers) as [string, any][]) {
    const padded = name.padEnd(16);
    const transport = (info.transport || "stdio").padEnd(13);
    process.stdout.write(`  ${padded}${transport}${info.description || ""}\n`);
  }
  process.stdout.write("\n");
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

    process.stdout.write("\nConfigured servers:\n\n");
    process.stdout.write("  Server          Transport    Description\n");
    process.stdout.write("  " + "─".repeat(60) + "\n");

    for (const [name, serverConfig] of entries) {
      const padded = name.padEnd(16);
      const transport = serverConfig.transport.padEnd(13);
      process.stdout.write(`  ${padded}${transport}${serverConfig.description || ""}\n`);
    }
    process.stdout.write("\n");
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

function cmdSearch(query: string, logger: Logger): void {
  const catalogPath = join(PACKAGE_ROOT, "servers", "index.json");
  if (!existsSync(catalogPath)) {
    logger.error("Server catalog not found");
    process.exit(1);
  }

  const catalog = JSON.parse(readFileSync(catalogPath, "utf-8"));
  const servers = catalog.servers || {};
  const lowerQuery = query.toLowerCase();

  const matches = Object.entries(servers).filter(([name, info]: [string, any]) => {
    return name.toLowerCase().includes(lowerQuery) ||
      (info.description || "").toLowerCase().includes(lowerQuery);
  });

  if (matches.length === 0) {
    process.stdout.write(`No servers matching "${query}"\n`);
    return;
  }

  process.stdout.write(`\nSearch results for "${query}":\n\n`);
  for (const [i, [name, info]] of matches.entries() as any) {
    process.stdout.write(`  ${i + 1}  ${name.padEnd(16)}${(info as any).description || ""}\n`);
  }
  process.stdout.write("\n");
}

function cmdInstall(serverName: string, logger: Logger): void {
  const scriptPath = join(PACKAGE_ROOT, "scripts", "install-server.sh");
  if (!existsSync(scriptPath)) {
    logger.error("Install script not found");
    process.exit(1);
  }

  try {
    execFileSync("bash", [scriptPath, serverName], { stdio: "inherit" });
  } catch (err) {
    process.exit(1);
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

async function cmdServe(args: CliArgs, logger: Logger): Promise<void> {
  let config;
  try {
    config = loadConfig({ configPath: args.configPath, logger });
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // HTTP modes: require auth
  if ((args.sse || args.http) && !config.http?.auth?.token) {
    logger.error("HTTP auth not configured. Set http.auth in config or use stdio mode.");
    process.exit(1);
  }

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
      cmdInit(logger);
      break;
    case "catalog":
      cmdCatalog(logger, args.offline);
      break;
    case "servers":
      cmdServers(logger, args.configPath);
      break;
    case "search":
      if (args.positional.length === 0) {
        process.stderr.write("Usage: mcp-bridge search <query>\n");
        process.exit(1);
      }
      cmdSearch(args.positional[0], logger);
      break;
    case "install":
      if (args.positional.length === 0) {
        process.stderr.write("Usage: mcp-bridge install <server>\n");
        process.exit(1);
      }
      cmdInstall(args.positional[0], logger);
      break;
    case "update":
      await cmdUpdate(logger, args.checkOnly);
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
