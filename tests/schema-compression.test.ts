import test from "node:test";
import assert from "node:assert/strict";
import { compressDescription } from "../src/schema-compression.ts";

test("short description passes through unchanged", () => {
  const desc = "List all servers in the cluster";
  assert.equal(compressDescription(desc, 80), desc);
});

test("description exactly at maxLen passes through unchanged", () => {
  const desc = "A".repeat(80);
  assert.equal(compressDescription(desc, 80), desc);
});

test("long description truncated at sentence boundary", () => {
  const desc = "Create a new virtual server. This provisions compute resources and sets up networking.";
  const result = compressDescription(desc, 60);
  assert.equal(result, "Create a new virtual server.\u2026");
});

test("long description with no sentence boundary truncated at word boundary", () => {
  const desc = "Create a new virtual server with all the networking and compute resources needed for production";
  const result = compressDescription(desc, 50);
  // Should cut at last space before position 50
  assert.ok(result.endsWith("\u2026"));
  assert.ok(result.length <= 51); // word + ellipsis
  assert.ok(!result.includes("needed"));
});

test("custom maxLen works", () => {
  const desc = "Short. But this part is longer and should be cut off.";
  const result = compressDescription(desc, 10);
  assert.ok(result.endsWith("\u2026"));
  assert.ok(result.length <= 11);
});

test("default maxLen is 80", () => {
  const desc = "A".repeat(81);
  const result = compressDescription(desc);
  assert.equal(result, "A".repeat(80) + "\u2026");
});

test("empty description passes through", () => {
  assert.equal(compressDescription("", 80), "");
});
