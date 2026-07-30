/**
 * Static recipe-declared config files (e.g. dbhub's `--config` TOML file).
 *
 * Some upstream MCP servers dropped CLI flags in favor of a config file
 * (e.g. @bytebase/dbhub 0.22+ only accepts read-only mode via a
 * `[[tools]]`-block TOML, not `--readonly`). Recipe content is static and
 * secret-free — any `${VAR}` inside the file is resolved by the upstream
 * server itself from its own process env, not by the bridge. The bridge's
 * job is only to write the file to disk before spawn and point the command
 * at it via the `${CONFIG_DIR}` arg placeholder.
 */

import { mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ConfigFileSpec {
  name: string;
  content: string;
}

/** Resolve the base dir for spawn-time config files (per-instance). */
export function getConfigFilesBaseDir(): string {
  if (process.env.MCP_BRIDGE_CONFIG_FILES_DIR) {
    return process.env.MCP_BRIDGE_CONFIG_FILES_DIR;
  }
  return join(homedir(), ".mcp-bridge", "config");
}

/** Per-instance dir where recipe configFiles are written. */
export function getConfigFilesServerDir(serverName: string, baseOverride?: string): string {
  const base = baseOverride ?? getConfigFilesBaseDir();
  return join(base, serverName);
}

/**
 * Write each recipe-declared config file into <base>/<serverName>/<name>
 * (dir 0700, file 0600). Idempotent: skips the write when the file already
 * holds the exact requested content, so repeat spawns don't touch file
 * metadata unnecessarily. Returns the directory the files were written to,
 * for substitution into the `${CONFIG_DIR}` arg placeholder.
 *
 * `name` must be a plain filename (validate-recipe.ts already rejects path
 * separators and ".." at recipe-validation time); this is a second,
 * defense-in-depth check since this function may be called directly by
 * callers that bypass recipe validation (e.g. tests, future callers).
 */
export function writeConfigFiles(serverName: string, files: ConfigFileSpec[], baseOverride?: string): string {
  const dir = getConfigFilesServerDir(serverName, baseOverride);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  for (const file of files) {
    if (!file.name || file.name.includes("/") || file.name.includes("\\") || file.name.includes("..")) {
      throw new Error(`[mcp-bridge] configFiles entry has an unsafe name: "${file.name}"`);
    }

    const filePath = join(dir, file.name);
    const existing = existsSync(filePath) ? readFileSync(filePath, "utf8") : null;
    if (existing === file.content) continue;

    writeFileSync(filePath, file.content, { mode: 0o600 });
    chmodSync(filePath, 0o600);
  }

  return dir;
}
