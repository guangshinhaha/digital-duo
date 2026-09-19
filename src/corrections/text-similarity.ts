/**
 * Deterministic text-comparison primitives shared by classification (#37)
 * and conflict detection (#38) — no embeddings, no LLM: both need a cheap,
 * synchronous judgment of "how much did the words actually change" before
 * ever reaching for a provider.
 */

const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "to",
  "of",
  "in",
  "on",
  "for",
  "with",
  "at",
  "by",
  "from",
  "it",
  "this",
  "that",
  "as",
  "i",
  "you",
  "we",
  "they",
  "he",
  "she",
  "do",
  "does",
  "did",
  "will",
  "would",
  "can",
  "could",
  "should",
]);

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Lowercased, punctuation-stripped, stop-word-free tokens — the "what is actually being said" half of a sentence, as opposed to how it's phrased. */
export function contentWords(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 0 && !STOP_WORDS.has(token));
  return new Set(tokens);
}

/** Jaccard similarity of two texts' content-word sets: 1 when they assert the same content, 0 when they share none of it. Two empty sets (e.g. both blank) are trivially identical. */
export function contentWordOverlap(a: string, b: string): number {
  const wordsA = contentWords(a);
  const wordsB = contentWords(b);
  if (wordsA.size === 0 && wordsB.size === 0) {
    return 1;
  }
  let intersection = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) {
      intersection += 1;
    }
  }
  const union = wordsA.size + wordsB.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

/**
 * Character-level Levenshtein distance. Used only for detecting trivial
 * edits (short strings — a draft/sent pair), never for anything scored
 * against corpus-scale text, so the classic O(n*m) table is fine here.
 */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i++) {
    table[i][0] = i;
  }
  for (let j = 0; j < cols; j++) {
    table[0][j] = j;
  }
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      table[i][j] = Math.min(table[i - 1][j] + 1, table[i][j - 1] + 1, table[i - 1][j - 1] + cost);
    }
  }
  return table[rows - 1][cols - 1];
}
