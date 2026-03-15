/**
 * Smart Filter v2 - Phase 1: Keyword-based filtering
 * Zero external dependencies, graceful degradation
 */

import type { Logger, McpServerConfig, McpTool } from "./types.js";

/** Smart filter configuration for router mode. */
export interface SmartFilterConfig {
  enabled?: boolean;
  embedding?: "auto" | "ollama" | "openai" | "gemini" | "keyword";
  topServers?: number;
  hardCap?: number;
  topTools?: number;
  serverThreshold?: number;
  toolThreshold?: number;
  fallback?: "keyword";
  alwaysInclude?: string[];
  timeoutMs?: number;
  telemetry?: boolean;
}

/** Extended server config with optional keywords for smart filter. */
export interface PluginServerConfig extends McpServerConfig {
  keywords?: string[];
}

export type OpenClawLogger = Logger;

export interface FilterableServer {
  name: string;
  description: string;
  keywords: string[];
  tools: McpTool[];
}

export interface FilterResult {
  servers: FilterableServer[];
  tools: Array<{ serverId: string; tool: McpTool }>;
  metadata: {
    queryUsed: string;
    totalServersBeforeFilter: number;
    totalToolsBeforeFilter: number;
    filterMode: "keyword" | "disabled";
    timeoutOccurred: boolean;
    confidenceScore?: number;
  };
}

export interface UserTurn {
  content: string;
  timestamp: number;
}

// ── Shared helpers (used by both standalone functions and legacy class) ───────

/** Tokenize text into lowercase words, stripping punctuation. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(word => word.length > 0);
}

function extractMeaningfulContent(content: string): string {
  const cleaned = content
    .replace(/\[.*?\]/g, "")
    .replace(/^\s*[>]*\s*/gm, "")
    .replace(/^\s*[-*•]\s*/gm, "")
    .trim();

  const noisePatterns = [
    /^(yes|no|ok|okay|sure|thanks?|thank you)\.?$/i,
    /^(do it|go ahead|proceed)\.?$/i,
    /^(yes,?\s+(do it|go ahead|proceed))\.?$/i,
    /^\?+$/,
    /^\.+$/,
    /^!+$/,
  ];

  if (noisePatterns.some(pattern => pattern.test(cleaned))) {
    return "";
  }

  return cleaned
    .replace(/\s+please\.?$/i, "")
    .replace(/\s+thanks?\.?$/i, "")
    .trim();
}

/** Extract meaningful intent from last 1-3 user turns. */
export function synthesizeQuery(userTurns: UserTurn[]): string {
  if (!userTurns || userTurns.length === 0) {
    return "";
  }

  const recentTurns = userTurns
    .slice(-3)
    .reverse()
    .map(turn => turn.content.trim());

  for (const content of recentTurns) {
    const cleanedQuery = extractMeaningfulContent(content);
    if (cleanedQuery.length >= 3) {
      return cleanedQuery;
    }
  }

  const combined = recentTurns
    .map(content => extractMeaningfulContent(content))
    .filter(content => content.length > 0)
    .join(" ")
    .trim();

  return combined.length >= 3 ? combined : "";
}

// ── Standalone utility exports (for testing and external use) ────────────────

const MAX_KEYWORDS = 30;

export const DEFAULTS: Required<SmartFilterConfig> = {
  enabled: true,
  embedding: "keyword",
  topServers: 5,
  hardCap: 8,
  topTools: 10,
  serverThreshold: 0.01,
  toolThreshold: 0.05,
  fallback: "keyword",
  alwaysInclude: [],
  timeoutMs: 500,
  telemetry: false,
};

/** Normalize keywords: lowercase, trim, dedup, strip empties, cap at MAX_KEYWORDS. */
export function validateKeywords(raw: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const kw of raw) {
    const normalized = kw.toLowerCase().trim();
    if (normalized.length === 0 || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= MAX_KEYWORDS) break;
  }
  return out;
}

export interface ServerScore {
  name: string;
  score: number;
}

/**
 * Score a single server against a query using weighted word overlap.
 * desc_matches * 1.0 + kw_only_matches * 0.5, normalized by query length.
 */
export function scoreServer(
  queryTokens: string[],
  serverName: string,
  description: string,
  keywords: string[],
): number {
  if (queryTokens.length === 0) return 0;

  const descTokens = new Set(tokenize(description));
  for (const t of tokenize(serverName)) descTokens.add(t);
  const kwTokens = new Set(validateKeywords(keywords).flatMap(kw => tokenize(kw)));

  let descMatches = 0;
  let kwOnlyMatches = 0;

  for (const qt of queryTokens) {
    if (descTokens.has(qt)) {
      descMatches++;
    } else if (kwTokens.has(qt)) {
      kwOnlyMatches++;
    }
  }

  return (descMatches * 1.0 + kwOnlyMatches * 0.5) / queryTokens.length;
}

/** Score all servers, return sorted highest-first. */
export function scoreAllServers(
  queryTokens: string[],
  servers: Record<string, PluginServerConfig>,
): ServerScore[] {
  const scores: ServerScore[] = [];
  for (const [name, cfg] of Object.entries(servers)) {
    scores.push({ name, score: scoreServer(queryTokens, name, cfg.description ?? "", cfg.keywords ?? []) });
  }
  return scores.sort((a, b) => b.score - a.score);
}

/**
 * Select top servers with dynamic expansion toward hardCap.
 * If top score < threshold AND gap small → show all (true uncertainty).
 */
export function selectTopServers(
  scores: ServerScore[],
  topServers: number,
  hardCap: number,
  threshold: number,
  alwaysInclude: string[],
): string[] {
  if (scores.length === 0) return [];

  const topScore = scores[0].score;

  if (topScore < threshold && scores.length > 1) {
    const gap = topScore - scores[Math.min(scores.length - 1, topServers - 1)].score;
    if (gap < 0.05) {
      return scores.map(s => s.name);
    }
  }

  let k = Math.min(topServers, scores.length);

  if (k < scores.length && k < hardCap) {
    const kthScore = scores[k - 1].score;
    while (k < Math.min(hardCap, scores.length)) {
      if (scores[k].score >= kthScore * 0.8 && scores[k].score >= threshold) {
        k++;
      } else {
        break;
      }
    }
  }

  const selected = new Set<string>();
  for (let i = 0; i < k && i < scores.length; i++) {
    if (scores[i].score >= threshold || i === 0) {
      selected.add(scores[i].name);
    }
  }

  for (const name of alwaysInclude) selected.add(name);

  return [...selected];
}

// ── Main filter entry point ─────────────────────────────────────────────────

export interface SmartFilterResult {
  filteredServers: string[];
  allServers: string[];
  query: string | null;
  scores: ServerScore[];
  reason: "filtered" | "no-query" | "timeout" | "error" | "disabled";
}

/**
 * Run the smart filter. Returns the list of server names to include.
 * Guarantees: never throws, never blocks longer than timeoutMs.
 */
export function filterServers(
  servers: Record<string, PluginServerConfig>,
  userTurns: string[],
  config: SmartFilterConfig,
  logger?: OpenClawLogger,
): SmartFilterResult {
  const allServers = Object.keys(servers);
  const showAll = (reason: SmartFilterResult["reason"], query: string | null = null): SmartFilterResult => ({
    filteredServers: allServers,
    allServers,
    query,
    scores: [],
    reason,
  });

  if (!config.enabled) return showAll("disabled");

  try {
    const merged = { ...DEFAULTS, ...config };
    const startTime = Date.now();

    const userTurnObjects: UserTurn[] = userTurns.map(content => ({ content, timestamp: Date.now() }));
    const query = synthesizeQuery(userTurnObjects) || null;
    if (!query) return showAll("no-query");

    if (Date.now() - startTime > merged.timeoutMs) {
      logger?.warn("[smart-filter] Timeout during query synthesis");
      return showAll("timeout", query);
    }

    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return showAll("no-query");

    const scores = scoreAllServers(queryTokens, servers);

    if (Date.now() - startTime > merged.timeoutMs) {
      logger?.warn("[smart-filter] Timeout during scoring");
      return showAll("timeout", query);
    }

    const filteredServers = selectTopServers(
      scores,
      merged.topServers,
      merged.hardCap,
      merged.serverThreshold,
      merged.alwaysInclude,
    );

    return { filteredServers, allServers, query, scores, reason: "filtered" };
  } catch (err) {
    logger?.error("[smart-filter] Error during filtering, showing all servers:", err);
    return showAll("error");
  }
}

/** Build a filtered router tool description string. */
export function buildFilteredDescription(
  allServers: Record<string, PluginServerConfig>,
  filteredNames: string[],
): string {
  const included = new Set(filteredNames);
  const serverList = Object.entries(allServers)
    .filter(([name]) => included.has(name))
    .map(([name, cfg]) => {
      const desc = cfg.description;
      return desc ? `${name} (${desc})` : name;
    })
    .join(", ");

  if (!serverList) {
    return "Call MCP server tools. No servers matched the current context.";
  }

  return `Call any MCP server tool. Servers: ${serverList}. Use action='list' to discover tools and required parameters, action='call' to execute a tool, action='refresh' to clear cache and re-discover tools, and action='status' to check server connection states. If the user mentions a specific tool by name, the call action auto-connects and works without listing first.`;
}