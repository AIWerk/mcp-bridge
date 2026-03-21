import type { Logger } from "./types.js";

export interface PromotionConfig {
  enabled?: boolean;        // default: false (opt-in feature)
  maxPromoted?: number;     // max promoted tools, default: 10
  windowMs?: number;        // time window for counting, default: 24h (86400000)
  minCalls?: number;        // minimum calls in window to promote, default: 3
  decayMs?: number;         // if no calls in this period, demote, default: 48h
}

interface ToolUsage {
  server: string;
  tool: string;
  callTimestamps: number[];
}

const DEFAULT_WINDOW_MS = 86_400_000;    // 24h
const DEFAULT_DECAY_MS = 172_800_000;    // 48h
const DEFAULT_MAX_PROMOTED = 10;
const DEFAULT_MIN_CALLS = 3;

export class AdaptivePromotion {
  private readonly enabled: boolean;
  private readonly maxPromoted: number;
  private readonly windowMs: number;
  private readonly minCalls: number;
  private readonly decayMs: number;
  private readonly logger: Logger;
  private readonly usage = new Map<string, ToolUsage>();

  constructor(config: PromotionConfig, logger: Logger) {
    this.enabled = config.enabled ?? false;
    this.maxPromoted = config.maxPromoted ?? DEFAULT_MAX_PROMOTED;
    this.windowMs = config.windowMs ?? DEFAULT_WINDOW_MS;
    this.minCalls = config.minCalls ?? DEFAULT_MIN_CALLS;
    this.decayMs = config.decayMs ?? DEFAULT_DECAY_MS;
    this.logger = logger;
  }

  private key(server: string, tool: string): string {
    return `${server}::${tool}`;
  }

  recordCall(server: string, tool: string): void {
    if (!this.enabled) return;

    const k = this.key(server, tool);
    let entry = this.usage.get(k);
    if (!entry) {
      entry = { server, tool, callTimestamps: [] };
      this.usage.set(k, entry);
    }
    entry.callTimestamps.push(Date.now());
    this.cleanup();
  }

  getPromotedTools(): Array<{ server: string; tool: string; callCount: number }> {
    if (!this.enabled) return [];

    const now = Date.now();
    const cutoff = now - this.windowMs;

    const candidates: Array<{ server: string; tool: string; callCount: number }> = [];
    for (const entry of this.usage.values()) {
      const recentCalls = entry.callTimestamps.filter(t => t > cutoff);
      if (recentCalls.length >= this.minCalls) {
        candidates.push({
          server: entry.server,
          tool: entry.tool,
          callCount: recentCalls.length
        });
      }
    }

    candidates.sort((a, b) => b.callCount - a.callCount);
    return candidates.slice(0, this.maxPromoted);
  }

  isPromoted(server: string, tool: string): boolean {
    if (!this.enabled) return false;
    return this.getPromotedTools().some(
      p => p.server === server && p.tool === tool
    );
  }

  getStats(): Array<{ server: string; tool: string; callCount: number; lastCall: number }> {
    if (!this.enabled) return [];

    const now = Date.now();
    const cutoff = now - this.windowMs;
    const stats: Array<{ server: string; tool: string; callCount: number; lastCall: number }> = [];

    for (const entry of this.usage.values()) {
      const recentCalls = entry.callTimestamps.filter(t => t > cutoff);
      if (recentCalls.length > 0) {
        stats.push({
          server: entry.server,
          tool: entry.tool,
          callCount: recentCalls.length,
          lastCall: entry.callTimestamps.reduce((a, b) => a > b ? a : b, 0)
        });
      }
    }

    return stats;
  }

  private cleanup(): void {
    const now = Date.now();
    const windowCutoff = now - this.windowMs;
    const decayCutoff = now - this.decayMs;

    for (const [k, entry] of this.usage.entries()) {
      // Remove timestamps older than the window
      entry.callTimestamps = entry.callTimestamps.filter(t => t > windowCutoff);

      // Remove entire entry if no calls within decay period
      const lastCall = entry.callTimestamps.length > 0
        ? entry.callTimestamps.reduce((a, b) => a > b ? a : b, 0)
        : 0;
      if (lastCall === 0 || lastCall < decayCutoff) {
        this.usage.delete(k);
      }
    }
  }
}
