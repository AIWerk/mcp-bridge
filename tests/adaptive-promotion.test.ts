import test from "node:test";
import assert from "node:assert/strict";
import { AdaptivePromotion } from "../src/adaptive-promotion.ts";

function makeLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {}
  };
}

test("recordCall tracks timestamps", () => {
  const promo = new AdaptivePromotion(
    { enabled: true, minCalls: 1, windowMs: 60_000 },
    makeLogger()
  );

  promo.recordCall("github", "list_repos");
  promo.recordCall("github", "list_repos");

  const stats = promo.getStats();
  assert.equal(stats.length, 1);
  assert.equal(stats[0].server, "github");
  assert.equal(stats[0].tool, "list_repos");
  assert.equal(stats[0].callCount, 2);
});

test("getPromotedTools returns tools above minCalls threshold", () => {
  const promo = new AdaptivePromotion(
    { enabled: true, minCalls: 3, windowMs: 60_000 },
    makeLogger()
  );

  promo.recordCall("github", "list_repos");
  promo.recordCall("github", "list_repos");
  promo.recordCall("github", "list_repos");

  const promoted = promo.getPromotedTools();
  assert.equal(promoted.length, 1);
  assert.equal(promoted[0].server, "github");
  assert.equal(promoted[0].tool, "list_repos");
  assert.equal(promoted[0].callCount, 3);
});

test("getPromotedTools respects maxPromoted cap", () => {
  const promo = new AdaptivePromotion(
    { enabled: true, minCalls: 1, maxPromoted: 2, windowMs: 60_000 },
    makeLogger()
  );

  promo.recordCall("a", "tool1");
  promo.recordCall("b", "tool2");
  promo.recordCall("c", "tool3");

  const promoted = promo.getPromotedTools();
  assert.equal(promoted.length, 2);
});

test("getPromotedTools sorted by frequency (most used first)", () => {
  const promo = new AdaptivePromotion(
    { enabled: true, minCalls: 1, windowMs: 60_000 },
    makeLogger()
  );

  promo.recordCall("a", "low");
  promo.recordCall("b", "high");
  promo.recordCall("b", "high");
  promo.recordCall("b", "high");
  promo.recordCall("c", "mid");
  promo.recordCall("c", "mid");

  const promoted = promo.getPromotedTools();
  assert.equal(promoted[0].tool, "high");
  assert.equal(promoted[0].callCount, 3);
  assert.equal(promoted[1].tool, "mid");
  assert.equal(promoted[1].callCount, 2);
  assert.equal(promoted[2].tool, "low");
  assert.equal(promoted[2].callCount, 1);
});

test("tools below threshold not promoted", () => {
  const promo = new AdaptivePromotion(
    { enabled: true, minCalls: 5, windowMs: 60_000 },
    makeLogger()
  );

  promo.recordCall("github", "list_repos");
  promo.recordCall("github", "list_repos");

  const promoted = promo.getPromotedTools();
  assert.equal(promoted.length, 0);
});

test("cleanup removes old timestamps outside windowMs", () => {
  const promo = new AdaptivePromotion(
    { enabled: true, minCalls: 1, windowMs: 50, decayMs: 100 },
    makeLogger()
  );

  promo.recordCall("github", "old_tool");

  // Wait for the window to expire, then record another call to trigger cleanup
  const start = Date.now();
  while (Date.now() - start < 60) { /* busy wait */ }

  promo.recordCall("github", "new_tool");

  const stats = promo.getStats();
  const oldTool = stats.find(s => s.tool === "old_tool");
  // old_tool timestamps should have been cleaned from the window
  // but the entry may still exist if within decayMs
  if (oldTool) {
    assert.equal(oldTool.callCount, 0);
  }

  const newTool = stats.find(s => s.tool === "new_tool");
  assert.ok(newTool);
  assert.equal(newTool!.callCount, 1);
});

test("decay: tools with no recent calls get demoted", () => {
  const promo = new AdaptivePromotion(
    { enabled: true, minCalls: 1, windowMs: 20, decayMs: 40 },
    makeLogger()
  );

  promo.recordCall("github", "decaying");

  // Wait for both window and decay to expire
  const start = Date.now();
  while (Date.now() - start < 50) { /* busy wait */ }

  // Trigger cleanup by recording another call
  promo.recordCall("github", "fresh");

  const stats = promo.getStats();
  const decayed = stats.find(s => s.tool === "decaying");
  assert.equal(decayed, undefined, "Decayed tool should be removed entirely");

  const fresh = stats.find(s => s.tool === "fresh");
  assert.ok(fresh);
});

test("empty state: no promoted tools", () => {
  const promo = new AdaptivePromotion(
    { enabled: true, minCalls: 1, windowMs: 60_000 },
    makeLogger()
  );

  assert.deepEqual(promo.getPromotedTools(), []);
  assert.deepEqual(promo.getStats(), []);
});

test("disabled: getPromotedTools returns empty array", () => {
  const promo = new AdaptivePromotion(
    { enabled: false, minCalls: 1, windowMs: 60_000 },
    makeLogger()
  );

  promo.recordCall("github", "list_repos");
  promo.recordCall("github", "list_repos");
  promo.recordCall("github", "list_repos");

  assert.deepEqual(promo.getPromotedTools(), []);
  assert.equal(promo.isPromoted("github", "list_repos"), false);
  assert.deepEqual(promo.getStats(), []);
});

test("isPromoted returns true for promoted tools", () => {
  const promo = new AdaptivePromotion(
    { enabled: true, minCalls: 2, windowMs: 60_000 },
    makeLogger()
  );

  promo.recordCall("github", "list_repos");
  assert.equal(promo.isPromoted("github", "list_repos"), false);

  promo.recordCall("github", "list_repos");
  assert.equal(promo.isPromoted("github", "list_repos"), true);
});
