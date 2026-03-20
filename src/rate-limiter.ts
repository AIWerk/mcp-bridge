import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface RateLimitConfig {
  maxCallsPerDay?: number;
  maxCallsPerMonth?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  warning?: string;
  error?: string;
}

interface UsageCounter {
  date?: string;
  month?: string;
  count: number;
}

interface UsageRecord {
  daily: UsageCounter;
  monthly: UsageCounter;
}

function utcDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function utcMonth(now: Date): string {
  return now.toISOString().slice(0, 7);
}

function isPositiveLimit(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function warningThreshold(limit: number): number {
  return Math.max(1, Math.ceil(limit * 0.8));
}

function nextSuggestedLimit(limit: number): number {
  return Math.ceil(limit * 1.5);
}

export class RateLimiter {
  private readonly usageDir: string;

  constructor(usageDir?: string) {
    this.usageDir = usageDir ?? join(homedir(), ".mcp-bridge", "usage");
  }

  checkLimit(serverId: string, config?: RateLimitConfig): RateLimitResult {
    const dailyLimit = isPositiveLimit(config?.maxCallsPerDay) ? config.maxCallsPerDay : undefined;
    const monthlyLimit = isPositiveLimit(config?.maxCallsPerMonth) ? config.maxCallsPerMonth : undefined;
    if (!dailyLimit && !monthlyLimit) {
      return { allowed: true };
    }

    const { usage, changed } = this.loadUsage(serverId);
    if (changed) {
      this.saveUsage(serverId, usage);
    }

    if (dailyLimit && usage.daily.count >= dailyLimit) {
      return {
        allowed: false,
        error: `❌ Rate limit reached for ${serverId}: ${usage.daily.count}/${dailyLimit} daily calls used. Resets at midnight UTC. To adjust: mcp-bridge limit ${serverId} --daily ${nextSuggestedLimit(dailyLimit)}. To check usage: mcp-bridge usage. To disable limit: mcp-bridge limit ${serverId} --daily 0`
      };
    }

    if (monthlyLimit && usage.monthly.count >= monthlyLimit) {
      return {
        allowed: false,
        error: `❌ Rate limit reached for ${serverId}: ${usage.monthly.count}/${monthlyLimit} monthly calls used. Resets on the 1st of each month at midnight UTC. To adjust: mcp-bridge limit ${serverId} --monthly ${nextSuggestedLimit(monthlyLimit)}. To check usage: mcp-bridge usage. To disable limit: mcp-bridge limit ${serverId} --monthly 0`
      };
    }

    return { allowed: true };
  }

  checkAndIncrement(serverId: string, config?: RateLimitConfig): RateLimitResult {
    const dailyLimit = isPositiveLimit(config?.maxCallsPerDay) ? config.maxCallsPerDay : undefined;
    const monthlyLimit = isPositiveLimit(config?.maxCallsPerMonth) ? config.maxCallsPerMonth : undefined;
    if (!dailyLimit && !monthlyLimit) {
      return { allowed: true };
    }

    // Single loadUsage call — check + increment in one pass (avoids double file read)
    const { usage, changed } = this.loadUsage(serverId);
    if (changed) {
      this.saveUsage(serverId, usage);
    }

    if (dailyLimit && usage.daily.count >= dailyLimit) {
      return {
        allowed: false,
        error: `❌ Rate limit reached for ${serverId}: ${usage.daily.count}/${dailyLimit} daily calls used. Resets at midnight UTC. To adjust: mcp-bridge limit ${serverId} --daily ${nextSuggestedLimit(dailyLimit)}. To check usage: mcp-bridge usage. To disable limit: mcp-bridge limit ${serverId} --daily 0`
      };
    }

    if (monthlyLimit && usage.monthly.count >= monthlyLimit) {
      return {
        allowed: false,
        error: `❌ Rate limit reached for ${serverId}: ${usage.monthly.count}/${monthlyLimit} monthly calls used. Resets on the 1st of each month at midnight UTC. To adjust: mcp-bridge limit ${serverId} --monthly ${nextSuggestedLimit(monthlyLimit)}. To check usage: mcp-bridge usage. To disable limit: mcp-bridge limit ${serverId} --monthly 0`
      };
    }

    usage.daily.count += 1;
    usage.monthly.count += 1;
    this.saveUsage(serverId, usage);

    if (dailyLimit && usage.daily.count >= warningThreshold(dailyLimit) && usage.daily.count < dailyLimit) {
      return {
        allowed: true,
        warning: `⚠️ ${serverId}: 80% of daily limit used (${usage.daily.count}/${dailyLimit}). Adjust with: mcp-bridge limit ${serverId} --daily <number>`
      };
    }

    if (monthlyLimit && usage.monthly.count >= warningThreshold(monthlyLimit) && usage.monthly.count < monthlyLimit) {
      return {
        allowed: true,
        warning: `⚠️ ${serverId}: 80% of monthly limit used (${usage.monthly.count}/${monthlyLimit}). Adjust with: mcp-bridge limit ${serverId} --monthly <number>`
      };
    }

    return { allowed: true };
  }

  getUsage(serverId: string): { daily: number; monthly: number } {
    const { usage, changed } = this.loadUsage(serverId);
    if (changed) {
      this.saveUsage(serverId, usage);
    }
    return { daily: usage.daily.count, monthly: usage.monthly.count };
  }

  getAllUsage(): Record<string, { daily: number; monthly: number; dailyLimit?: number; monthlyLimit?: number }> {
    const all: Record<string, { daily: number; monthly: number; dailyLimit?: number; monthlyLimit?: number }> = {};
    if (!existsSync(this.usageDir)) {
      return all;
    }

    for (const fileName of readdirSync(this.usageDir)) {
      if (!fileName.endsWith(".json")) continue;
      const encodedId = fileName.slice(0, -5);
      let serverId: string;
      try {
        serverId = decodeURIComponent(encodedId);
      } catch {
        serverId = encodedId;
      }
      const { usage, changed } = this.loadUsage(serverId);
      if (changed) {
        this.saveUsage(serverId, usage);
      }
      all[serverId] = {
        daily: usage.daily.count,
        monthly: usage.monthly.count
      };
    }

    return all;
  }

  reset(serverId: string): void {
    const now = new Date();
    this.saveUsage(serverId, {
      daily: { date: utcDate(now), count: 0 },
      monthly: { month: utcMonth(now), count: 0 }
    });
  }

  private loadUsage(serverId: string): { usage: UsageRecord; changed: boolean } {
    const now = new Date();
    const expectedDate = utcDate(now);
    const expectedMonth = utcMonth(now);
    const filePath = this.serverFilePath(serverId);

    const fallback: UsageRecord = {
      daily: { date: expectedDate, count: 0 },
      monthly: { month: expectedMonth, count: 0 }
    };

    if (!existsSync(filePath)) {
      return { usage: fallback, changed: false };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(filePath, "utf-8"));
    } catch {
      return { usage: fallback, changed: true };
    }

    const dailyRaw = typeof parsed === "object" && parsed !== null ? (parsed as any).daily : undefined;
    const monthlyRaw = typeof parsed === "object" && parsed !== null ? (parsed as any).monthly : undefined;

    let changed = false;

    const dailyDate = typeof dailyRaw?.date === "string" ? dailyRaw.date : expectedDate;
    const dailyCount = typeof dailyRaw?.count === "number" && dailyRaw.count >= 0 ? dailyRaw.count : 0;
    const monthlyMonth = typeof monthlyRaw?.month === "string" ? monthlyRaw.month : expectedMonth;
    const monthlyCount = typeof monthlyRaw?.count === "number" && monthlyRaw.count >= 0 ? monthlyRaw.count : 0;

    const usage: UsageRecord = {
      daily: { date: dailyDate, count: dailyCount },
      monthly: { month: monthlyMonth, count: monthlyCount }
    };

    if (usage.daily.date !== expectedDate) {
      usage.daily.date = expectedDate;
      usage.daily.count = 0;
      changed = true;
    }
    if (usage.monthly.month !== expectedMonth) {
      usage.monthly.month = expectedMonth;
      usage.monthly.count = 0;
      changed = true;
    }

    return { usage, changed };
  }

  private saveUsage(serverId: string, usage: UsageRecord): void {
    mkdirSync(this.usageDir, { recursive: true });
    writeFileSync(this.serverFilePath(serverId), JSON.stringify(usage, null, 2) + "\n", "utf-8");
  }

  private serverFilePath(serverId: string): string {
    return join(this.usageDir, `${encodeURIComponent(serverId)}.json`);
  }
}
