/**
 * #35 AC3: "the same score is reported [across two runs], because
 * sampling and ordering are seeded". A plain `Math.random()`-backed sample
 * would make the harness's own output non-reproducible independent of
 * anything about the corpus or the model — this is a small, dependency-free
 * PRNG (mulberry32) so a fixed seed always produces the same sequence, on
 * any Node version, without pulling in a library for it.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates, driven by the seeded PRNG above — deterministic for a fixed `seed` and a fixed input order. */
function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const rng = mulberry32(seed);
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/**
 * Picks `count` items deterministically for a given `seed`: the whole list
 * when `count >= items.length`, otherwise a seeded-random subset. Same
 * `items` + same `seed` always yields the same subset, in the same order —
 * callers that also need a *stable display order* (e.g. chronological) are
 * expected to re-sort the result themselves rather than rely on shuffle
 * order, which this function makes no promise about beyond reproducibility.
 */
export function pickSeededSample<T>(items: readonly T[], count: number, seed: number): T[] {
  if (count >= items.length) {
    return [...items];
  }
  if (count <= 0) {
    return [];
  }
  return seededShuffle(items, seed).slice(0, count);
}
