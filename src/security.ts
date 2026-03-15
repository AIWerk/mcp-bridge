/**
 * Security processing for MCP tool results.
 *
 * Pipeline order: truncate → sanitize → trust-tag
 */

import type { McpServerConfig, McpClientConfig } from "./types.js";

// Prompt injection patterns to strip (case-insensitive)
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?previous\s+instructions/gi,
  /ignore\s+(all\s+)?prior\s+instructions/gi,
  /disregard\s+(all\s+)?previous\s+instructions/gi,
  /you\s+are\s+now\b/gi,
  /^system\s*:/gim,
  /\bact\s+as\s+(a|an)\s+/gi,
  /pretend\s+you\s+are\b/gi,
  /from\s+now\s+on\s+you\s+are\b/gi,
  /new\s+instructions\s*:/gi,
  /override\s+(all\s+)?instructions/gi,
];

function stripHtmlTags(text: string): string {
  return text.replace(/<[^>]*>/g, "");
}

function stripInjectionPatterns(text: string): string {
  let result = text;
  for (const pattern of INJECTION_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    result = result.replace(pattern, "");
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
 * Full security pipeline: truncate → sanitize → trust-tag
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
