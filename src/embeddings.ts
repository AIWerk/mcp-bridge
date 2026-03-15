import type { Logger } from "./types.js";

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  dimensions(): number;
}

export class GeminiEmbedding implements EmbeddingProvider {
  private readonly apiKey: string;
  private readonly model = "gemini-embedding-001";
  private readonly baseUrl = "https://generativelanguage.googleapis.com/v1beta";
  private static readonly BATCH_LIMIT = 100;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];

    // Process in chunks of BATCH_LIMIT
    for (let i = 0; i < texts.length; i += GeminiEmbedding.BATCH_LIMIT) {
      const chunk = texts.slice(i, i + GeminiEmbedding.BATCH_LIMIT);
      try {
        const chunkResults = await this.batchEmbed(chunk);
        results.push(...chunkResults);
      } catch {
        // Fallback: sequential embedding if batch fails
        for (const text of chunk) {
          results.push(await this.singleEmbed(text));
        }
      }
    }

    return results;
  }

  private async batchEmbed(texts: string[]): Promise<number[][]> {
    const response = await fetch(
      `${this.baseUrl}/models/${this.model}:batchEmbedContents?key=${this.apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: texts.map(text => ({
            model: `models/${this.model}`,
            content: { parts: [{ text }] },
          })),
        }),
      }
    );
    if (!response.ok) {
      throw new Error(`Gemini API error: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    return data.embeddings.map((e: any) => e.values);
  }

  private async singleEmbed(text: string): Promise<number[]> {
    const response = await fetch(
      `${this.baseUrl}/models/${this.model}:embedContent?key=${this.apiKey}`,
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
    return data.embedding.values;
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
  private frozen = false;

  /**
   * Add texts to the vocabulary (call during indexing phase).
   * After freeze(), new words are silently ignored.
   */
  buildVocabulary(texts: string[]): void {
    if (this.frozen) return;
    for (const text of texts) {
      for (const word of this.tokenize(text)) {
        if (!this.vocabulary.has(word)) {
          this.vocabulary.set(word, this.vocabulary.size);
        }
      }
    }
  }

  /** Freeze vocabulary — no new words added after this. */
  freeze(): void {
    this.frozen = true;
  }

  async embed(texts: string[]): Promise<number[][]> {
    // If not frozen yet, add these texts to vocabulary first
    if (!this.frozen) {
      this.buildVocabulary(texts);
    }

    const vocabSize = this.vocabulary.size;
    if (vocabSize === 0) {
      return texts.map(() => [0]);
    }

    // Create TF vectors using the FIXED vocabulary
    return texts.map((text) => {
      const vector = new Array(vocabSize).fill(0);
      const words = this.tokenize(text);
      for (const word of words) {
        const idx = this.vocabulary.get(word);
        if (idx !== undefined) {
          vector[idx] += 1;
        }
      }
      // Normalize by document length
      const len = words.length || 1;
      for (let i = 0; i < vector.length; i++) {
        vector[i] /= len;
      }
      return vector;
    });
  }

  dimensions(): number {
    return this.vocabulary.size || 1;
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
