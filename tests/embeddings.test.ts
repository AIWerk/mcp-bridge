import test from "node:test";
import assert from "node:assert/strict";
import { KeywordEmbedding, createEmbeddingProvider } from "../src/embeddings.ts";
import { cosineSimilarity } from "../src/vector-store.ts";

test("KeywordEmbedding returns vectors of same length", async () => {
  const provider = new KeywordEmbedding();
  const vectors = await provider.embed([
    "create a new file",
    "delete a file",
    "search for documents"
  ]);

  assert.equal(vectors.length, 3);
  assert.equal(vectors[0].length, vectors[1].length);
  assert.equal(vectors[1].length, vectors[2].length);
});

test("KeywordEmbedding: similar texts have higher cosine similarity than dissimilar", async () => {
  const provider = new KeywordEmbedding();
  const vectors = await provider.embed([
    "create a new server instance",
    "provision a new server machine",
    "delete all email messages"
  ]);

  const simSimilar = cosineSimilarity(vectors[0], vectors[1]);
  const simDissimilar = cosineSimilarity(vectors[0], vectors[2]);

  assert.ok(
    simSimilar > simDissimilar,
    `Similar texts similarity (${simSimilar.toFixed(3)}) should be > dissimilar (${simDissimilar.toFixed(3)})`
  );
});

test("KeywordEmbedding handles empty input", async () => {
  const provider = new KeywordEmbedding();
  const vectors = await provider.embed([]);
  assert.equal(vectors.length, 0);
});

test("KeywordEmbedding handles single text", async () => {
  const provider = new KeywordEmbedding();
  const vectors = await provider.embed(["hello world"]);
  assert.equal(vectors.length, 1);
  assert.ok(vectors[0].length > 0);
});

test("createEmbeddingProvider auto falls back to keyword when no API keys", () => {
  // Ensure no API keys are set for this test
  const origGemini = process.env.GEMINI_API_KEY;
  const origOpenai = process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.OPENAI_API_KEY;

  try {
    const provider = createEmbeddingProvider("auto");
    assert.ok(provider instanceof KeywordEmbedding);
  } finally {
    if (origGemini) process.env.GEMINI_API_KEY = origGemini;
    if (origOpenai) process.env.OPENAI_API_KEY = origOpenai;
  }
});

test("createEmbeddingProvider keyword type returns KeywordEmbedding", () => {
  const provider = createEmbeddingProvider("keyword");
  assert.ok(provider instanceof KeywordEmbedding);
});

test("createEmbeddingProvider gemini throws without API key", () => {
  const orig = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    assert.throws(
      () => createEmbeddingProvider("gemini"),
      /GEMINI_API_KEY is required/
    );
  } finally {
    if (orig) process.env.GEMINI_API_KEY = orig;
  }
});

test("createEmbeddingProvider openai throws without API key", () => {
  const orig = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    assert.throws(
      () => createEmbeddingProvider("openai"),
      /OPENAI_API_KEY is required/
    );
  } finally {
    if (orig) process.env.OPENAI_API_KEY = orig;
  }
});
