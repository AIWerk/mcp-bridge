export interface VectorMetadata {
  server: string;
  tool: string;
  description: string;
}

interface VectorEntry {
  id: string;
  vector: number[];
  metadata: VectorMetadata;
}

export class VectorStore {
  private entries: VectorEntry[] = [];

  add(id: string, vector: number[], metadata: VectorMetadata): void {
    this.entries.push({ id, vector, metadata });
  }

  search(queryVector: number[], topK: number): Array<{ id: string; score: number; metadata: VectorMetadata }> {
    const scored = this.entries.map((entry) => ({
      id: entry.id,
      score: cosineSimilarity(queryVector, entry.vector),
      metadata: entry.metadata
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  clear(): void {
    this.entries = [];
  }

  size(): number {
    return this.entries.length;
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  // Handle any extra dimensions (vectors may differ in length for keyword embeddings)
  for (let i = len; i < a.length; i++) {
    normA += a[i] * a[i];
  }
  for (let i = len; i < b.length; i++) {
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}
