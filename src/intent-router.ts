import type { EmbeddingProvider } from "./embeddings.js";
import type { Logger } from "./types.js";
import type { McpTool } from "./types.js";
import { VectorStore } from "./vector-store.js";

const DEFAULT_MIN_SCORE = 0.3;
const DEFAULT_TOP_K = 4;

export interface IntentMatch {
  server: string;
  tool: string;
  score: number;
  alternatives: Array<{ server: string; tool: string; score: number }>;
}

export class IntentRouter {
  private readonly embeddingProvider: EmbeddingProvider;
  private readonly logger: Logger;
  private readonly store = new VectorStore();
  private indexed = false;
  private minScore: number;

  constructor(embeddingProvider: EmbeddingProvider, logger: Logger, minScore?: number) {
    this.embeddingProvider = embeddingProvider;
    this.logger = logger;
    this.minScore = minScore ?? DEFAULT_MIN_SCORE;
  }

  async indexTools(servers: Record<string, McpTool[]>): Promise<void> {
    this.store.clear();
    this.indexed = false;

    const entries: Array<{ id: string; text: string; server: string; tool: string }> = [];

    for (const [serverName, tools] of Object.entries(servers)) {
      for (const tool of tools) {
        const text = `${tool.name}: ${tool.description || ""}`;
        entries.push({
          id: `${serverName}/${tool.name}`,
          text,
          server: serverName,
          tool: tool.name
        });
      }
    }

    if (entries.length === 0) {
      this.indexed = true;
      return;
    }

    const texts = entries.map((e) => e.text);
    const vectors = await this.embeddingProvider.embed(texts);

    for (let i = 0; i < entries.length; i++) {
      this.store.add(entries[i].id, vectors[i], {
        server: entries[i].server,
        tool: entries[i].tool,
        description: entries[i].text
      });
    }

    this.indexed = true;
    this.logger.debug(`[mcp-bridge] Intent router indexed ${entries.length} tools`);
  }

  async resolve(intent: string): Promise<IntentMatch | null> {
    if (!this.indexed || this.store.size() === 0) {
      return null;
    }

    // Embed the intent together with stored texts for keyword provider compatibility
    // For API-based providers this is just a single text embedding
    const [queryVector] = await this.embeddingProvider.embed([intent]);

    const results = this.store.search(queryVector, DEFAULT_TOP_K);
    if (results.length === 0) {
      return null;
    }

    const best = results[0];
    if (best.score < this.minScore) {
      this.logger.debug(
        `[mcp-bridge] Intent "${intent}" best match score ${best.score.toFixed(3)} below threshold ${this.minScore}`
      );
      return null;
    }

    return {
      server: best.metadata.server,
      tool: best.metadata.tool,
      score: best.score,
      alternatives: results.slice(1).map((r) => ({
        server: r.metadata.server,
        tool: r.metadata.tool,
        score: r.score
      }))
    };
  }

  isIndexed(): boolean {
    return this.indexed;
  }

  clearIndex(): void {
    this.store.clear();
    this.indexed = false;
  }
}
