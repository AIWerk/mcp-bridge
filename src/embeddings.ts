import type { Logger } from "./types.js";

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  dimensions(): number;
}

export class GeminiEmbedding implements EmbeddingProvider {
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (const text of texts) {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${this.apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: { parts: [{ text }] }
          })
        }
      );
      if (!response.ok) {
        throw new Error(`Gemini API error: ${response.status} ${response.statusText}`);
      }
      const data = await response.json();
      results.push(data.embedding.values);
    }
    return results;
  }

  dimensions(): number {
    return 768;
  }
}

export class OpenAIEmbedding implements EmbeddingProvider {
  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey: string, model: string = "text-embedding-3-small") {
    this.apiKey = apiKey;
    this.model = model;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({ input: texts, model: this.model })
    });
    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    return data.data
      .sort((a: any, b: any) => a.index - b.index)
      .map((item: any) => item.embedding);
  }

  dimensions(): number {
    return 1536;
  }
}

export class OllamaEmbedding implements EmbeddingProvider {
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(model: string = "nomic-embed-text", baseUrl: string = "http://localhost:11434") {
    this.model = model;
    this.baseUrl = baseUrl;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const response = await fetch(`${this.baseUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, input: texts })
    });
    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    return data.embeddings;
  }

  dimensions(): number {
    return 768;
  }
}

export class KeywordEmbedding implements EmbeddingProvider {
  private vocabulary: Map<string, number> = new Map();
  private vocabSize: number = 0;

  async embed(texts: string[]): Promise<number[][]> {
    // Build vocabulary from all texts
    this.vocabulary.clear();
    this.vocabSize = 0;

    const tokenizedTexts = texts.map((text) => this.tokenize(text));

    for (const tokens of tokenizedTexts) {
      for (const token of tokens) {
        if (!this.vocabulary.has(token)) {
          this.vocabulary.set(token, this.vocabSize++);
        }
      }
    }

    if (this.vocabSize === 0) {
      return texts.map(() => [0]);
    }

    // Create TF vectors
    const vectors: number[][] = [];
    for (const tokens of tokenizedTexts) {
      const vector = new Array(this.vocabSize).fill(0);
      for (const token of tokens) {
        const idx = this.vocabulary.get(token)!;
        vector[idx] += 1;
      }
      // Normalize by document length
      const len = tokens.length || 1;
      for (let i = 0; i < vector.length; i++) {
        vector[i] /= len;
      }
      vectors.push(vector);
    }

    // Apply IDF weighting
    const docCount = texts.length;
    const idf = new Array(this.vocabSize).fill(0);
    for (let i = 0; i < this.vocabSize; i++) {
      let df = 0;
      for (const vec of vectors) {
        if (vec[i] > 0) df++;
      }
      idf[i] = Math.log((docCount + 1) / (df + 1)) + 1;
    }

    for (const vec of vectors) {
      for (let i = 0; i < vec.length; i++) {
        vec[i] *= idf[i];
      }
    }

    return vectors;
  }

  dimensions(): number {
    return this.vocabSize || 1;
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1);
  }
}

export function createEmbeddingProvider(
  type: "auto" | "gemini" | "openai" | "ollama" | "keyword",
  config?: { model?: string; apiKey?: string; ollamaUrl?: string },
  logger?: Logger
): EmbeddingProvider {
  if (type === "gemini") {
    const key = config?.apiKey || process.env.GEMINI_API_KEY;
    if (!key) throw new Error("GEMINI_API_KEY is required for gemini embedding provider");
    return new GeminiEmbedding(key);
  }

  if (type === "openai") {
    const key = config?.apiKey || process.env.OPENAI_API_KEY;
    if (!key) throw new Error("OPENAI_API_KEY is required for openai embedding provider");
    return new OpenAIEmbedding(key, config?.model);
  }

  if (type === "ollama") {
    return new OllamaEmbedding(config?.model, config?.ollamaUrl);
  }

  if (type === "keyword") {
    return new KeywordEmbedding();
  }

  // auto: try gemini, openai, ollama, then keyword fallback
  const geminiKey = config?.apiKey || process.env.GEMINI_API_KEY;
  if (geminiKey) {
    logger?.debug("[mcp-bridge] Intent routing: using Gemini embeddings");
    return new GeminiEmbedding(geminiKey);
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    logger?.debug("[mcp-bridge] Intent routing: using OpenAI embeddings");
    return new OpenAIEmbedding(openaiKey, config?.model);
  }

  // For ollama, we can't synchronously check reachability in factory,
  // so we skip it in auto mode and fall back to keyword.
  // Users who want ollama should specify type="ollama" explicitly.
  logger?.debug("[mcp-bridge] Intent routing: using keyword fallback embeddings");
  return new KeywordEmbedding();
}
