import { readFileSync, existsSync, mkdirSync, writeFileSync, chmodSync, readdirSync } from "fs";
import { join, extname } from "path";
import { homedir } from "os";
import { BridgeConfig, Logger, McpServerConfig } from "./types.js";
import { resolveEnvVars } from "./transport-base.js";
import { randomBytes } from "crypto";
import { CatalogClient } from "./catalog-client.js";
import type { CatalogRecipe } from "./catalog-client.js";

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
    const rawValue = trimmed.substring(eqIdx + 1).trim();
    let value: string;
    let wasQuoted = false;
    // Strip surrounding quotes and handle escaped quotes within
    if ((rawValue.startsWith('"') && rawValue.endsWith('"')) ||
        (rawValue.startsWith("'") && rawValue.endsWith("'"))) {
      const quote = rawValue[0];
      value = rawValue.slice(1, -1);
      // Unescape escaped quotes: \" → " or \' → '
      value = value.replace(new RegExp(`\\\\${quote}`, "g"), quote);
      // Unescape escaped backslashes: \\ → \
      value = value.replace(/\\\\/g, "\\");
      wasQuoted = true;
    } else {
      value = rawValue;
    }
    // Strip inline comments (KEY=value # comment) for unquoted values only.
    // Quoted values preserve # characters literally: KEY="val#ue" → val#ue
    if (!wasQuoted) {
      const hashIdx = value.indexOf(" #");
      if (hashIdx !== -1) {
        value = value.substring(0, hashIdx).trimEnd();
      }
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

  // Populate process.env with .env values for child processes (don't overwrite
  // existing env vars — this matches dotenv's default behavior). This is separate
  // from the config resolution below, which uses a different merge order where
  // .env values win over process.env.
  for (const [key, value] of Object.entries(dotEnv)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  // Read and parse config
  const rawConfig = JSON.parse(readFileSync(configPath, "utf-8"));

  // Merge order: .env file values take priority over process.env for config resolution.
  // This is intentional: .env is the user-controlled secrets file, process.env may have
  // stale or system-level values. Note: dotenv loads .env INTO process.env without
  // overwriting (opposite direction), but our config resolver uses this merged map
  // where .env wins.
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

/**
 * Warn about deprecated bundled recipes.
 * In v2.8.0, bundled servers/ recipes are deprecated in favor of catalog.
 * They will be removed in v3.0.0.
 */
export function warnDeprecatedBundledRecipes(logger: Logger): void {
  const catalogClient = new CatalogClient({ logger });
  const cached = catalogClient.listCached();
  if (cached.length === 0) {
    logger.info('[mcp-bridge] Tip: Run bootstrapCatalog() to fetch recipes from catalog.aiwerk.ch (replaces bundled servers/)');
  }
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
      maxBatchSize: 10,
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

// ── Catalog bootstrap ─────────────────────────────────────────────────────────

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

/**
 * Extract the depAudit value from a catalog recipe's metadata.verification field.
 * Returns null if not present.
 */
function getDepAudit(recipe: CatalogRecipe): string | null {
  const meta = recipe.metadata as Record<string, unknown> | undefined;
  const verification = meta?.verification as Record<string, unknown> | undefined;
  const depAudit = verification?.depAudit;
  return typeof depAudit === "string" ? depAudit : null;
}

/**
 * Bootstrap the local recipe cache from the catalog.
 * Downloads top N popular recipes if cache is empty or force=true.
 * Returns array of recipe names now cached. Never throws on network errors.
 */
export async function bootstrapCatalog(options?: {
  logger?: Logger;
  cacheDir?: string;
  catalogUrl?: string;
  limit?: number;
  force?: boolean;
  requireCleanAudit?: boolean;
  catalog?: boolean;
}): Promise<string[]> {
  // If catalog is explicitly disabled, skip fetching
  if (options?.catalog === false) {
    const logger = options?.logger ?? noopLogger;
    logger.info("[mcp-bridge] Catalog discovery disabled (catalog: false), skipping bootstrap");
    return [];
  }

  const logger = options?.logger ?? noopLogger;
  const cacheDir = options?.cacheDir ?? join(homedir(), ".mcp-bridge", "recipes");
  const requireCleanAudit = options?.requireCleanAudit ?? false;
  const client = new CatalogClient({
    baseUrl: options?.catalogUrl,
    cacheDir,
    logger,
  });

  // Check if cache already has recipes
  if (!options?.force) {
    const cached = client.listCached();
    if (cached.length > 0) {
      logger.debug(`Recipe cache already has ${cached.length} recipes, skipping bootstrap`);
      return cached;
    }
  }

  try {
    return await client.bootstrap(options?.limit ?? 15, requireCleanAudit);
  } catch (err) {
    logger.warn(
      `Catalog unreachable during bootstrap: ${err instanceof Error ? err.message : err}`,
    );
    return [];
  }
}

/**
 * Merge cached catalog recipes into a BridgeConfig.
 * Only adds recipes whose required env vars are all present in process.env.
 * Never overwrites manually configured servers.
 *
 * IMPORTANT: Must be called AFTER loadConfig() / dotenv, since env var
 * checks rely on process.env being fully populated.
 */
export function mergeRecipesIntoConfig(
  config: BridgeConfig,
  options?: { cacheDir?: string; logger?: Logger },
): BridgeConfig {
  const logger = options?.logger ?? noopLogger;

  // autoMerge defaults to false (opt-in) — only merge when explicitly enabled
  if (config.autoMerge !== true) {
    logger.debug("[mcp-bridge] Auto-merge disabled (autoMerge is not true), skipping recipe merge");
    return config;
  }

  const cacheDir = options?.cacheDir ?? join(homedir(), ".mcp-bridge", "recipes");
  const client = new CatalogClient({ cacheDir, logger });

  const names = client.listCached();
  if (names.length === 0) return config;

  const servers = { ...config.servers };

  const requireCleanAudit = config.security?.requireCleanAudit ?? false;

  for (const name of names) {
    // Never overwrite manually configured servers
    if (servers[name]) continue;

    const recipe = client.getCached(name);
    if (!recipe) continue;

    // Check depAudit security policy
    const depAudit = getDepAudit(recipe);
    const auditOk = depAudit === null || depAudit === "clean" || depAudit === "not-applicable";
    if (!auditOk) {
      if (requireCleanAudit) {
        logger.warn(`⚠️ Skipping server "${name}": has known security advisories (depAudit: ${depAudit}). Set security.requireCleanAudit=false to allow.`);
        continue;
      } else {
        logger.info(`ℹ️ Server "${name}" has known advisories (depAudit: ${depAudit}). Set security.requireCleanAudit=true to block.`);
      }
    }

    const converted = recipeToServerConfig(recipe);
    if (!converted) {
      logger.debug(`Skipping recipe "${name}": unsupported format`);
      continue;
    }

    // Check that all required env vars are available
    const requiredVars = collectRequiredEnvVars(recipe);
    const missing = requiredVars.filter((v) => !process.env[v]);
    if (missing.length > 0) {
      logger.debug(`Skipping recipe "${name}": missing env vars: ${missing.join(", ")}`);
      continue;
    }

    servers[name] = converted;
    logger.debug(`Added catalog recipe "${name}" to config`);
  }

  return { ...config, servers };
}

/** Convert a catalog recipe JSON to McpServerConfig, or null if unsupported. */
function recipeToServerConfig(recipe: CatalogRecipe): McpServerConfig | null {
  // v2 recipe: has transports array
  if (Array.isArray(recipe.transports) && recipe.transports.length > 0) {
    const t = recipe.transports[0];
    if (t.type === "stdio") {
      return {
        transport: "stdio",
        description: recipe.description,
        command: t.command,
        args: t.args,
        env: t.env,
      };
    }
    if (t.type === "sse" || t.type === "streamable-http") {
      return {
        transport: t.type,
        description: recipe.description,
        url: t.url,
        headers: t.headers,
      };
    }
    return null;
  }

  // v1 recipe: has transport string
  if (recipe.transport === "stdio") {
    return {
      transport: "stdio",
      description: recipe.description,
      command: recipe.command,
      args: recipe.args,
      env: recipe.env,
    };
  }
  if (recipe.transport === "sse" || recipe.transport === "streamable-http") {
    return {
      transport: recipe.transport,
      description: recipe.description,
      url: recipe.url,
      headers: recipe.headers,
    };
  }

  return null;
}

/** Collect all env var names required by a recipe. */
function collectRequiredEnvVars(recipe: CatalogRecipe): string[] {
  const vars = new Set<string>();

  // From auth.envVars
  if (Array.isArray(recipe.auth?.envVars)) {
    for (const v of recipe.auth.envVars) vars.add(v);
  }

  // From env object: extract ${VAR} references
  const envObj = Array.isArray(recipe.transports)
    ? recipe.transports[0]?.env
    : recipe.env;
  if (envObj && typeof envObj === "object") {
    for (const val of Object.values(envObj)) {
      if (typeof val === "string") {
        const matches = val.matchAll(/\$\{([^}]+)\}/g);
        for (const m of matches) vars.add(m[1]);
      }
    }
  }

  // If auth is explicitly required but no env vars were found,
  // return a placeholder to prevent auto-registration without credentials
  if (recipe.auth?.required === true && vars.size === 0) {
    vars.add("__AUTH_REQUIRED__");
  }

  return [...vars];
}
