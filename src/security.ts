/**
 * Security processing for MCP tool results.
 *
 * Pipeline order: truncate → sanitize → trust-tag
 */

import type { McpServerConfig, McpClientConfig } from "./types.js";

// Prompt injection pattern sources to strip (compiled per call to avoid RegExp state leakage)
const INJECTION_PATTERN_SOURCES: string[] = [
  "ignore\\s+(all\\s+)?previous\\s+instructions",
  "ignore\\s+(all\\s+)?prior\\s+instructions",
  "disregard\\s+(all\\s+)?previous\\s+instructions",
  "you\\s+are\\s+now\\b",
  "\\bact\\s+as\\s+(a|an)\\s+",
  "pretend\\s+you\\s+are\\b",
  "from\\s+now\\s+on\\s+you\\s+are\\b",
  "new\\s+instructions\\s*:",
  "override\\s+(all\\s+)?instructions",
];

const INJECTION_PATTERN_MULTILINE_SOURCES: string[] = ["^system\\s*:"];

function stripHtmlTags(text: string): string {
  return text.replace(/<[^>]*>/g, "");
}

function stripInjectionPatterns(text: string): string {
  let result = text;

  for (const source of INJECTION_PATTERN_SOURCES) {
    result = result.replace(new RegExp(source, "gi"), "");
  }

  for (const source of INJECTION_PATTERN_MULTILINE_SOURCES) {
    result = result.replace(new RegExp(source, "gim"), "");
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
 *
 * Uses JSON-aware truncation: tries to produce valid JSON by truncating
 * at the object/array level rather than slicing raw JSON strings
 * (which produces invalid JSON that LLMs may hallucinate around).
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

  // Try JSON-aware truncation: if the result is an array, take fewer elements;
  // if it's an object with a nested array, truncate the largest array.
  const truncated = truncateJsonAware(result, limit);
  if (truncated !== null) {
    return {
      _truncated: true,
      _originalLength: serialized.length,
      result: truncated,
    };
  }

  // Fallback: stringify and cut at a safe boundary, then wrap as a string
  // to ensure the consumer always gets valid JSON
  let cutPoint = Math.min(limit, serialized.length);
  // Try to cut at the last complete JSON token boundary (comma, closing bracket, or newline)
  const lastSafe = Math.max(
    serialized.lastIndexOf(",", cutPoint),
    serialized.lastIndexOf("}", cutPoint),
    serialized.lastIndexOf("]", cutPoint),
    serialized.lastIndexOf("\n", cutPoint),
  );
  if (lastSafe > cutPoint * 0.5) {
    cutPoint = lastSafe + 1;
  }

  return {
    _truncated: true,
    _originalLength: serialized.length,
    result: serialized.slice(0, cutPoint) + "…",
    _note: "Result truncated. Original response exceeded size limit.",
  };
}

/**
 * JSON-aware truncation: reduce array sizes to fit within the char limit.
 * Returns the truncated value or null if not applicable.
 */
function truncateJsonAware(value: any, limit: number): any | null {
  if (Array.isArray(value)) {
    return truncateArray(value, limit);
  }

  if (value !== null && typeof value === "object") {
    // Find the largest array field and truncate it
    let largestKey: string | null = null;
    let largestLen = 0;
    for (const [k, v] of Object.entries(value)) {
      if (Array.isArray(v) && v.length > largestLen) {
        largestKey = k;
        largestLen = v.length;
      }
    }
    if (largestKey && largestLen > 1) {
      const copy = { ...value };
      copy[largestKey] = truncateArray(value[largestKey], limit);
      if (JSON.stringify(copy).length <= limit) {
        return copy;
      }
      // Still too large — try with fewer elements
      return truncateObjectWithArrays(value, limit);
    }
  }

  return null;
}

function truncateArray(arr: any[], limit: number): any[] {
  // Binary search for the number of elements that fit
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    const slice = arr.slice(0, mid);
    if (JSON.stringify(slice).length <= limit) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return arr.slice(0, Math.max(1, lo));
}

function truncateObjectWithArrays(obj: Record<string, any>, limit: number): any | null {
  const copy = { ...obj };
  // Progressively halve all arrays until it fits
  for (let attempt = 0; attempt < 10; attempt++) {
    let changed = false;
    for (const [k, v] of Object.entries(copy)) {
      if (Array.isArray(v) && v.length > 1) {
        copy[k] = v.slice(0, Math.max(1, Math.ceil(v.length / 2)));
        changed = true;
      }
    }
    if (JSON.stringify(copy).length <= limit) return copy;
    if (!changed) break;
  }
  return null;
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

  // If both truncated and untrusted/sanitize, flatten the metadata to top level
  // to avoid double-wrapping ({ _trust, result: { _truncated, result: actual } })
  const trust = serverConfig.trust ?? "trusted";
  if (wasTruncated && (trust === "untrusted" || trust === "sanitize")) {
    const flat: Record<string, unknown> = {
      _truncated: true,
      _originalLength: processed.result?._originalLength,
      result: processed.result?.result,
    };
    if (trust === "untrusted") {
      flat._trust = "untrusted";
      flat._server = serverName;
    }
    return flat;
  }
  return processed;
}
