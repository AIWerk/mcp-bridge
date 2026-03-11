function isNameTaken(name: string, localNames: Set<string>, globalNames: Set<string>): boolean {
  return localNames.has(name) || globalNames.has(name);
}

export function pickRegisteredToolName(
  serverName: string,
  toolName: string,
  toolPrefix: boolean | "auto" | undefined,
  localNames: Set<string>,
  globalNames: Set<string>,
  logger?: { warn: (...args: unknown[]) => void }
): string {
  // toolPrefix: true = always prefix, false = never prefix, "auto" = prefix only on collision (default)
  const effectivePrefix = toolPrefix === undefined ? "auto" : toolPrefix;

  let candidate: string;
  if (effectivePrefix === true) {
    // Always prefix with server name
    candidate = `${serverName}_${toolName}`.replace(/[^a-zA-Z0-9_]/g, "_");
  } else if (effectivePrefix === false) {
    // Never prefix — use raw tool name, no collision fallback
    candidate = toolName.replace(/[^a-zA-Z0-9_]/g, "_");
  } else {
    // "auto" — try without prefix, auto-prefix on collision
    const unprefixed = toolName.replace(/[^a-zA-Z0-9_]/g, "_");
    if (isNameTaken(unprefixed, localNames, globalNames)) {
      const prefixedName = `${serverName}_${toolName}`.replace(/[^a-zA-Z0-9_]/g, "_");
      logger?.warn(
        `[mcp-bridge] Global tool name collision detected for "${unprefixed}". Auto-prefixing with server name: "${prefixedName}"`
      );
      candidate = prefixedName;
    } else {
      candidate = unprefixed;
    }
  }

  const uniqueBase = candidate;
  let suffix = 2;
  while (isNameTaken(candidate, localNames, globalNames)) {
    candidate = `${uniqueBase}_${suffix}`;
    suffix += 1;
  }

  if (candidate !== uniqueBase) {
    logger?.warn(
      `[mcp-bridge] Tool name collision after sanitization on server ${serverName}: "${uniqueBase}" -> "${candidate}"`
    );
  }

  return candidate;
}
