import test from "node:test";
import assert from "node:assert/strict";
import { VectorStore, cosineSimilarity } from "../src/vector-store.ts";

test("VectorStore add + search returns correct results", () => {
  const store = new VectorStore();
  store.add("a", [1, 0, 0], { server: "s1", tool: "toolA", description: "Tool A" });
  store.add("b", [0, 1, 0], { server: "s2", tool: "toolB", description: "Tool B" });
  store.add("c", [1, 1, 0], { server: "s1", tool: "toolC", description: "Tool C" });

  const results = store.search([1, 0, 0], 2);
  assert.equal(results.length, 2);
  assert.equal(results[0].id, "a"); // exact match
  assert.equal(results[0].metadata.tool, "toolA");
});

test("VectorStore search respects topK", () => {
  const store = new VectorStore();
  store.add("a", [1, 0], { server: "s1", tool: "a", description: "A" });
  store.add("b", [0, 1], { server: "s1", tool: "b", description: "B" });
  store.add("c", [1, 1], { server: "s1", tool: "c", description: "C" });

  const results = store.search([1, 0], 1);
  assert.equal(results.length, 1);
});

test("cosine similarity correctness with known vectors", () => {
  // Identical vectors = 1
  assert.ok(Math.abs(cosineSimilarity([1, 0], [1, 0]) - 1.0) < 1e-9);

  // Orthogonal vectors = 0
  assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1]) - 0.0) < 1e-9);

  // Opposite vectors = -1
  assert.ok(Math.abs(cosineSimilarity([1, 0], [-1, 0]) - (-1.0)) < 1e-9);

  // 45 degree angle = ~0.707
  const sim = cosineSimilarity([1, 0], [1, 1]);
  assert.ok(Math.abs(sim - Math.SQRT1_2) < 1e-9);
});

test("cosine similarity returns 0 for zero vectors", () => {
  assert.equal(cosineSimilarity([0, 0], [1, 0]), 0);
  assert.equal(cosineSimilarity([0, 0], [0, 0]), 0);
});

test("empty store returns empty results", () => {
  const store = new VectorStore();
  const results = store.search([1, 0, 0], 5);
  assert.equal(results.length, 0);
});

test("VectorStore clear removes all entries", () => {
  const store = new VectorStore();
  store.add("a", [1, 0], { server: "s1", tool: "a", description: "A" });
  assert.equal(store.size(), 1);
  store.clear();
  assert.equal(store.size(), 0);
  assert.equal(store.search([1, 0], 1).length, 0);
});

test("VectorStore size tracks entries", () => {
  const store = new VectorStore();
  assert.equal(store.size(), 0);
  store.add("a", [1], { server: "s", tool: "a", description: "A" });
  assert.equal(store.size(), 1);
  store.add("b", [0], { server: "s", tool: "b", description: "B" });
  assert.equal(store.size(), 2);
});
