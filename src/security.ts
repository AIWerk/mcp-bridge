/**
 * Security processing for MCP tool results.
 *
 * Pipeline order: truncate → sanitize → trust-tag
 */

import type { McpServerConfig, McpClientConfig } from "./types.js";

// Prompt injection patterns to strip (pattern source + flags)
const INJECTION_PATTERNS: Array<{ source: string; flags: string }> = [
  { source: "ignore\\s+(all\\s+)?previous\\s+instructions", flags: "gi" },
  { source: "ignore\\s+(all\\s+)?prior\\s+instructions", flags: "gi" },
  { source: "disregard\\s+(all\\s+)?previous\\s+instructions", flags: "gi" },
  { source: "you\\s+are\\s+now\\b", flags: "gi" },
  { source: "^system\\s*:", flags: "gim" },
  { source: "\\bact\\s+as\\s+(a|an)\\s+", flags: "gi" },
  { source: "pretend\\s+you\\s+are\\b", flags: "gi" },
  { source: "from\\s+now\\s+on\\s+you\\s+are\\b", flags: "gi" },
  { source: "new\\s+instructions\\s*:", flags: "gi" },
  { source: "override\\s+(all\\s+)?instructions", flags: "gi" },
];

function stripHtmlTags(text: string): string {
  return text.replace(/<[^>]*>/g, "");
}

function stripInjectionPatterns(text: string): string {
  let result = text;
  for (const { source, flags } of INJECTION_PATTERNS) {
    result = result.replace(new RegExp(source, flags), "");
  }
  return result;
}

function sanitizeString(text: string): string {
  return stripInjectionPatterns(stripHtmlTags(text));
}

/**
 * Sanitize a tool result by stripping HTML and prompt injection patterns.
 */
export function sanitizeResult(result: any): any {
  if (typeof result === "string") {
    return sanitizeString(result);
  }

  if (Array.isArray(result)) {
    return result.map((item) => sanitizeResult(item));
  }

  if (result !== null && typeof result === "object") {
    // MCP standard content array
    if (Array.isArray(result.content)) {
      return {
        ...result,
        content: result.content.map((item: any) => {
          if (item.type === "text" && typeof item.text === "string") {
            return { ...item, text: sanitizeString(item.text) };
          }
          return item;
        }),
      };
    }

    // Recursively sanitize object values
    const sanitized: Record<string, any> = {};
    for (const [key, value] of Object.entries(result)) {
      sanitized[key] = sanitizeResult(value);
    }
    return sanitized;
  }

  return result;
}

/**
 * Check if a tool is allowed by the server's toolFilter config.
 * Returns true if the tool should be visible/callable.
 */
export function isToolAllowed(
  toolName: string,
  serverConfig: McpServerConfig
): boolean {
  const filter = serverConfig.toolFilter;
  if (!filter) return true;

  const { allow, deny } = filter;

  if (allow && allow.length > 0) {
    // Whitelist mode: only allowed tools, minus denied
    if (!allow.includes(toolName)) return false;
  }

  if (deny && deny.length > 0) {
    if (deny.includes(toolName)) return false;
  }

  return true;
}

/**
 * Apply max result size truncation.
 * Returns the result as-is or a truncation wrapper.
 */
export function applyMaxResultSize(
  result: any,
  serverConfig: McpServerConfig,
  clientConfig: McpClientConfig
): any {
  const limit = serverConfig.maxResultChars ?? clientConfig.maxResultChars;
  if (limit === undefined) return result;

  const serialized = JSON.stringify(result);
  if (serialized.length <= limit) return result;

  return {
    _truncated: true,
    _originalLength: serialized.length,
    result: serialized.slice(0, limit),
  };
}

/**
 * Apply trust level wrapping/sanitization.
 */
export function applyTrustLevel(
  result: any,
  serverName: string,
  serverConfig: McpServerConfig
): any {
  const trust = serverConfig.trust ?? "trusted";

  switch (trust) {
    case "trusted":
      return result;
    case "untrusted":
      return { _trust: "untrusted", _server: serverName, result };
    case "sanitize":
      return sanitizeResult(result);
    default:
      return result;
  }
}

/**
 * Full security pipeline: truncate → trust-tag (which includes sanitize for trust="sanitize")
 * Note: sanitization only runs when trust="sanitize". trust="untrusted" wraps without sanitizing.
 */
export function processResult(
  result: any,
  serverName: string,
  serverConfig: McpServerConfig,
  clientConfig: McpClientConfig
): any {
  let processed = applyMaxResultSize(result, serverConfig, clientConfig);
  const wasTruncated = processed !== null && typeof processed === "object" && processed._truncated === true;
  // Sanitize step (only for trust=sanitize, handled inside applyTrustLevel)
  processed = applyTrustLevel(processed, serverName, serverConfig);

  // If both truncated and untrusted, flatten the metadata to top level
  const trust = serverConfig.trust ?? "trusted";
  if (wasTruncated && trust === "untrusted") {
    return {
      _trust: "untrusted",
      _server: serverName,
      _truncated: true,
      _originalLength: processed.result?._originalLength,
      result: processed.result?.result,
    };
  }
  return processed;
}
