import { readFileSync, existsSync, mkdirSync, writeFileSync, chmodSync } from "fs";
import { join, extname } from "path";
import { homedir } from "os";
import { BridgeConfig, Logger } from "./types.js";
import { resolveEnvVars } from "./transport-base.js";
import { randomBytes } from "crypto";

const DEFAULT_CONFIG_DIR = join(homedir(), ".mcp-bridge");
const DEFAULT_CONFIG_FILE = "config.json";
const DEFAULT_ENV_FILE = ".env";

/** Cached fallback env from ~/.openclaw/.env (loaded once). */
let _openclawDotEnvCache: Record<string, string> | null = null;

/**
 * Load ~/.openclaw/.env as a fallback env source.
 * 
 * When running as an OpenClaw plugin, dotenv uses `override: false` which means
 * pre-existing env vars (even empty strings) take precedence over .env values.
 * This fallback allows the bridge to recover the intended .env values when
 * process.env has empty/missing entries.
 */
export function loadOpenClawDotEnvFallback(): Record<string, string> {
  if (_openclawDotEnvCache !== null) return _openclawDotEnvCache;

  const openclawEnvPath = join(
    process.env.OPENCLAW_CONFIG_DIR || join(homedir(), ".openclaw"),
    ".env"
  );

  if (existsSync(openclawEnvPath)) {
    try {
      _openclawDotEnvCache = parseEnvFile(readFileSync(openclawEnvPath, "utf-8"));
    } catch {
      _openclawDotEnvCache = {};
    }
  } else {
    _openclawDotEnvCache = {};
  }
  return _openclawDotEnvCache;
}

/** Reset the cached OpenClaw .env (for testing). */
export function resetOpenClawDotEnvCache(): void {
  _openclawDotEnvCache = null;
}

/** Parse a simple KEY=VALUE .env file (no npm dependency). */
export function parseEnvFile(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.substring(0, eqIdx).trim();
    let value = trimmed.substring(eqIdx + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) env[key] = value;
  }
  return env;
}

/** Recursively resolve ${VAR} placeholders in a JSON-compatible value. */
function resolveConfigValue(value: unknown, extraEnv: Record<string, string | undefined>): unknown {
  if (typeof value === "string") {
    return resolveEnvVars(value, "config value", extraEnv);
  }
  if (Array.isArray(value)) {
    return value.map(item => resolveConfigValue(item, extraEnv));
  }
  if (value !== null && typeof value === "object") {
    const resolved: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      resolved[k] = resolveConfigValue(v, extraEnv);
    }
    return resolved;
  }
  return value;
}

export interface LoadConfigOptions {
  configPath?: string;
  logger?: Logger;
}

/**
 * Load and validate bridge config.
 * 1. Read ~/.mcp-bridge/config.json (or custom path)
 * 2. Parse ~/.mcp-bridge/.env
 * 3. Resolve ${ENV_VAR} in config values
 * 4. Validate required fields
 */
export function loadConfig(options: LoadConfigOptions = {}): BridgeConfig {
  const configDir = getConfigDir(options.configPath);

  const configPath = options.configPath || join(DEFAULT_CONFIG_DIR, DEFAULT_CONFIG_FILE);
  const envPath = join(configDir, DEFAULT_ENV_FILE);

  if (!existsSync(configPath)) {
    throw new Error(
      `Config file not found: ${configPath}\nRun 'mcp-bridge init' to set up.`
    );
  }

  // Load .env file
  let dotEnv: Record<string, string> = {};
  if (existsSync(envPath)) {
    try {
      dotEnv = parseEnvFile(readFileSync(envPath, "utf-8"));
    } catch (err) {
      options.logger?.warn(`[mcp-bridge] Failed to parse .env file: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Merge .env into process.env (don't overwrite existing)
  for (const [key, value] of Object.entries(dotEnv)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  // Read and parse config
  const rawConfig = JSON.parse(readFileSync(configPath, "utf-8"));

  // Resolve ${VAR} placeholders using .env + process.env
  const mergedEnv: Record<string, string | undefined> = { ...dotEnv };
  for (const [k, v] of Object.entries(process.env)) {
    if (mergedEnv[k] === undefined) mergedEnv[k] = v;
  }

  let config: BridgeConfig;
  try {
    config = resolveConfigValue(rawConfig, mergedEnv) as BridgeConfig;
  } catch (err) {
    throw new Error(`Config resolution failed: ${err instanceof Error ? err.message : err}`);
  }

  // Validate required fields
  if (!config.servers || typeof config.servers !== "object") {
    throw new Error("Config must have a 'servers' object");
  }

  return config;
}

/** Get the default config directory path. */
export function getConfigDir(configPath?: string): string {
  if (!configPath) return DEFAULT_CONFIG_DIR;
  // If path ends with separator or has no extension, treat as directory
  if (configPath.endsWith("/") || configPath.endsWith("\\") || !extname(configPath)) {
    return configPath;
  }
  return join(configPath, "..");
}

/** Initialize the config directory with template files. */
export function initConfigDir(logger: Logger): void {
  const dir = DEFAULT_CONFIG_DIR;

  mkdirSync(dir, { recursive: true });

  // Set directory permissions (Linux/macOS)
  try {
    chmodSync(dir, 0o700);
  } catch { /* Windows doesn't support chmod */ }

  const configPath = join(dir, DEFAULT_CONFIG_FILE);
  if (!existsSync(configPath)) {
    const template: BridgeConfig = {
      mode: "router",
      servers: {},
      toolPrefix: true,
      connectionTimeoutMs: 5000,
      requestTimeoutMs: 60000,
      routerIdleTimeoutMs: 600000,
      routerMaxConcurrent: 5,
      http: {
        auth: {
          type: "bearer",
          token: "${MCP_BRIDGE_TOKEN}"
        }
      }
    };
    writeFileSync(configPath, JSON.stringify(template, null, 2) + "\n");
    logger.info(`Created config: ${configPath}`);
  }

  const envPath = join(dir, DEFAULT_ENV_FILE);
  if (!existsSync(envPath)) {
    const token = randomBytes(32).toString("hex");
    writeFileSync(envPath, `# MCP Bridge environment variables\nMCP_BRIDGE_TOKEN=${token}\n`);
    try {
      chmodSync(envPath, 0o600);
    } catch { /* Windows */ }
    logger.info(`Created .env: ${envPath} (with generated token)`);
  }

  logger.info(`Config directory ready: ${dir}`);
}
