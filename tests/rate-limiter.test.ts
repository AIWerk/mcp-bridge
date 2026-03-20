import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { RateLimiter } from "../src/rate-limiter.ts";

function createUsageDir(): string {
  return mkdtempSync(join(tmpdir(), "mcp-bridge-rate-limit-"));
}

function withMockedNow<T>(isoTimestamp: string, fn: () => T): T {
  const RealDate = Date;
  class MockDate extends RealDate {
    constructor(value?: string | number | Date) {
      if (value !== undefined) {
        super(value);
      } else {
        super(isoTimestamp);
      }
    }

    static now(): number {
      return new RealDate(isoTimestamp).getTime();
    }

    static parse(dateString: string): number {
      return RealDate.parse(dateString);
    }

    static UTC(
      year: number,
      monthIndex?: number,
      date?: number,
      hours?: number,
      minutes?: number,
      seconds?: number,
      ms?: number
    ): number {
      return RealDate.UTC(year, monthIndex, date, hours, minutes, seconds, ms);
    }
  }

  globalThis.Date = MockDate as DateConstructor;
  try {
    return fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

test("checkAndIncrement increments counter", () => {
  const limiter = new RateLimiter(createUsageDir());
  const result = limiter.checkAndIncrement("google-maps", { maxCallsPerDay: 10, maxCallsPerMonth: 100 });

  assert.equal(result.allowed, true);
  assert.deepEqual(limiter.getUsage("google-maps"), { daily: 1, monthly: 1 });
});

test("blocks when daily limit reached", () => {
  const limiter = new RateLimiter(createUsageDir());
  limiter.checkAndIncrement("google-maps", { maxCallsPerDay: 2, maxCallsPerMonth: 100 });
  limiter.checkAndIncrement("google-maps", { maxCallsPerDay: 2, maxCallsPerMonth: 100 });

  const blocked = limiter.checkAndIncrement("google-maps", { maxCallsPerDay: 2, maxCallsPerMonth: 100 });
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.error?.includes("mcp-bridge limit google-maps --daily"));
});

test("blocks when monthly limit reached", () => {
  const limiter = new RateLimiter(createUsageDir());
  limiter.checkAndIncrement("stripe", { maxCallsPerMonth: 2 });
  limiter.checkAndIncrement("stripe", { maxCallsPerMonth: 2 });

  const blocked = limiter.checkAndIncrement("stripe", { maxCallsPerMonth: 2 });
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.error?.includes("mcp-bridge limit stripe --monthly"));
});

test("returns warning at 80% threshold", () => {
  const limiter = new RateLimiter(createUsageDir());
  for (let i = 0; i < 3; i++) {
    const result = limiter.checkAndIncrement("maps", { maxCallsPerDay: 5 });
    assert.equal(result.warning, undefined);
  }

  const warning = limiter.checkAndIncrement("maps", { maxCallsPerDay: 5 });
  assert.equal(warning.allowed, true);
  assert.ok(warning.warning?.includes("80% of daily limit used (4/5)"));
  assert.ok(warning.warning?.includes("mcp-bridge limit maps --daily <number>"));
});

test("daily reset on date change", () => {
  const dir = createUsageDir();
  const limiter = new RateLimiter(dir);

  withMockedNow("2026-03-20T12:00:00.000Z", () => {
    limiter.checkAndIncrement("daily-reset", { maxCallsPerDay: 100, maxCallsPerMonth: 1000 });
    assert.deepEqual(limiter.getUsage("daily-reset"), { daily: 1, monthly: 1 });
  });

  withMockedNow("2026-03-21T00:00:01.000Z", () => {
    assert.deepEqual(limiter.getUsage("daily-reset"), { daily: 0, monthly: 1 });
  });
});

test("monthly reset on month change", () => {
  const dir = createUsageDir();
  const limiter = new RateLimiter(dir);

  withMockedNow("2026-03-31T23:59:00.000Z", () => {
    limiter.checkAndIncrement("monthly-reset", { maxCallsPerDay: 100, maxCallsPerMonth: 1000 });
    assert.deepEqual(limiter.getUsage("monthly-reset"), { daily: 1, monthly: 1 });
  });

  withMockedNow("2026-04-01T00:00:01.000Z", () => {
    assert.deepEqual(limiter.getUsage("monthly-reset"), { daily: 0, monthly: 0 });
  });
});

test("persists usage to file", () => {
  const dir = createUsageDir();
  const limiter = new RateLimiter(dir);
  limiter.checkAndIncrement("persist-me", { maxCallsPerDay: 100, maxCallsPerMonth: 1000 });

  assert.equal(existsSync(join(dir, "persist-me.json")), true);

  const anotherLimiter = new RateLimiter(dir);
  assert.deepEqual(anotherLimiter.getUsage("persist-me"), { daily: 1, monthly: 1 });
});

test("actionable error messages contain CLI commands", () => {
  const limiter = new RateLimiter(createUsageDir());
  limiter.checkAndIncrement("actionable", { maxCallsPerDay: 1 });

  const blocked = limiter.checkAndIncrement("actionable", { maxCallsPerDay: 1 });
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.error?.includes("mcp-bridge limit actionable --daily"));
  assert.ok(blocked.error?.includes("mcp-bridge usage"));
  assert.ok(blocked.error?.includes("mcp-bridge limit actionable --daily 0"));
});

test("handles corrupt usage file gracefully", () => {
  const dir = createUsageDir();
  writeFileSync(join(dir, "corrupt.json"), "{not-json", "utf-8");
  const limiter = new RateLimiter(dir);

  const result = limiter.checkAndIncrement("corrupt", { maxCallsPerDay: 10 });
  assert.equal(result.allowed, true);

  const fileContent = readFileSync(join(dir, "corrupt.json"), "utf-8");
  assert.ok(fileContent.includes('"count": 1'));
});
