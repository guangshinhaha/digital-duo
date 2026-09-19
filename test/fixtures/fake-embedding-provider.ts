import type { EmbeddingProvider } from "../../src/provider/types.js";

/**
 * A deterministic, offline stand-in for OllamaEmbeddingProvider, used to
 * test hybrid retrieval's semantic-similarity behavior without a real
 * Ollama server. Each vector dimension is a *synonym group*, not a single
 * word: "vacation" and "holiday" both set the same "time off" dimension.
 * That's what lets a query and a past record with zero words in common
 * still get a nonzero cosine similarity — the "semantically similar but
 * lexically different" case #20 asks retrieval to handle — while an exact
 * substring match (what FTS5 alone would need) is deliberately absent.
 */
const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ["leave", "vacation", "holiday", "absence", "pto"],
  ["printer", "broken", "floor", "hardware"],
  ["budget", "deadline", "invoice", "finance"],
];

function bagOfWordsVector(text: string): number[] {
  const lower = text.toLowerCase();
  return SYNONYM_GROUPS.map((group) => (group.some((word) => lower.includes(word)) ? 1 : 0));
}

export function createFakeEmbeddingProvider(model = "fake-embed"): EmbeddingProvider {
  return {
    name: "fake",
    model,
    async embed(text: string): Promise<readonly number[]> {
      return bagOfWordsVector(text);
    },
  };
}

/** An EmbeddingProvider whose every call rejects, for exercising the "embedding service is down" fallback path. */
export function createFailingEmbeddingProvider(model = "fake-embed"): EmbeddingProvider {
  return {
    name: "fake",
    model,
    async embed(): Promise<readonly number[]> {
      throw new Error("embedding service unreachable (fake)");
    },
  };
}
