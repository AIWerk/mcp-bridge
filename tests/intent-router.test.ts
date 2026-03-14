import test from "node:test";
import assert from "node:assert/strict";
import { IntentRouter } from "../src/intent-router.ts";
import type { EmbeddingProvider } from "../src/embeddings.ts";

// Mock embedding provider that uses simple word-overlap vectors
class MockEmbeddingProvider implements EmbeddingProvider {
  private vocabulary: Map<string, number> = new Map();
  embedCalls: string[][] = [];

  async embed(texts: string[]): Promise<number[][]> {
    this.embedCalls.push(texts);

    // Build vocabulary
    for (const text of texts) {
      for (const word of text.toLowerCase().split(/\s+/)) {
        if (!this.vocabulary.has(word)) {
          this.vocabulary.set(word, this.vocabulary.size);
        }
      }
    }

    const size = this.vocabulary.size;
    return texts.map((text) => {
      const vec = new Array(size).fill(0);
      for (const word of text.toLowerCase().split(/\s+/)) {
        const idx = this.vocabulary.get(word);
        if (idx !== undefined) vec[idx] = 1;
      }
      return vec;
    });
  }

  dimensions(): number {
    return this.vocabulary.size;
  }
}

function makeLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {}
  };
}

test("indexTools indexes all tools from all servers", async () => {
  const provider = new MockEmbeddingProvider();
  const router = new IntentRouter(provider, makeLogger());

  assert.equal(router.isIndexed(), false);

  await router.indexTools({
    github: [
      { name: "create_issue", description: "Create a GitHub issue", inputSchema: {} },
      { name: "list_repos", description: "List repositories", inputSchema: {} }
    ],
    slack: [
      { name: "send_message", description: "Send a Slack message", inputSchema: {} }
    ]
  });

  assert.equal(router.isIndexed(), true);
  // Should have embedded 3 tool descriptions in one call
  assert.equal(provider.embedCalls.length, 1);
  assert.equal(provider.embedCalls[0].length, 3);
});

test("resolve returns best match for a matching intent", async () => {
  const provider = new MockEmbeddingProvider();
  const router = new IntentRouter(provider, makeLogger());

  await router.indexTools({
    github: [
      { name: "create_issue", description: "Create a GitHub issue", inputSchema: {} },
      { name: "list_repos", description: "List all repositories", inputSchema: {} }
    ],
    email: [
      { name: "send_email", description: "Send an email message", inputSchema: {} }
    ]
  });

  const result = await router.resolve("create a new issue on GitHub");
  assert.ok(result);
  assert.equal(result!.server, "github");
  assert.equal(result!.tool, "create_issue");
  assert.ok(result!.score > 0);
  assert.ok(Array.isArray(result!.alternatives));
});

test("resolve returns null when below minScore", async () => {
  const provider = new MockEmbeddingProvider();
  // Set a very high minScore so nothing matches
  const router = new IntentRouter(provider, makeLogger(), 0.99);

  await router.indexTools({
    server: [
      { name: "tool_a", description: "Does something specific", inputSchema: {} }
    ]
  });

  const result = await router.resolve("completely unrelated query about cooking recipes");
  assert.equal(result, null);
});

test("alternatives are returned sorted by score descending", async () => {
  const provider = new MockEmbeddingProvider();
  const router = new IntentRouter(provider, makeLogger(), 0);

  await router.indexTools({
    s1: [
      { name: "create_file", description: "Create a new file", inputSchema: {} },
      { name: "delete_file", description: "Delete a file", inputSchema: {} }
    ],
    s2: [
      { name: "create_repo", description: "Create a new repository", inputSchema: {} }
    ]
  });

  const result = await router.resolve("create a new file");
  assert.ok(result);
  // Alternatives should be sorted by score descending
  for (let i = 0; i < result!.alternatives.length - 1; i++) {
    assert.ok(result!.alternatives[i].score >= result!.alternatives[i + 1].score);
  }
});

test("resolve returns null when not indexed", async () => {
  const provider = new MockEmbeddingProvider();
  const router = new IntentRouter(provider, makeLogger());

  const result = await router.resolve("anything");
  assert.equal(result, null);
});

test("clearIndex resets indexed state", async () => {
  const provider = new MockEmbeddingProvider();
  const router = new IntentRouter(provider, makeLogger());

  await router.indexTools({
    s: [{ name: "t", description: "test", inputSchema: {} }]
  });
  assert.equal(router.isIndexed(), true);

  router.clearIndex();
  assert.equal(router.isIndexed(), false);
});

test("indexTools with empty servers still marks as indexed", async () => {
  const provider = new MockEmbeddingProvider();
  const router = new IntentRouter(provider, makeLogger());

  await router.indexTools({});
  assert.equal(router.isIndexed(), true);

  const result = await router.resolve("anything");
  assert.equal(result, null);
});
