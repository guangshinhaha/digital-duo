import type { KnowledgeItem, KnowledgeSource, KnowledgeSourceConfig } from "./types.js";

/**
 * Backed by the derivation pipeline's output (topics, induced rules, QA
 * pairs) — that pipeline ships in a later phase (e3). Constructing this
 * source is safe today; calling retrieve() before the pipeline exists fails
 * loudly, naming the store, instead of silently returning nothing.
 */
class DerivedKnowledgeSource implements KnowledgeSource {
  readonly kind = "derived";

  constructor(private readonly storePath: string) {}

  async retrieve(_query: string): Promise<KnowledgeItem[]> {
    throw new Error(
      `Derived knowledge retrieval is not implemented yet (store: ${this.storePath}); ` +
        "the derivation pipeline ships in a later phase",
    );
  }
}

/**
 * Backed by a fixed, hand-authored set of documents — no derivation
 * pipeline involved. Used for synthetic personas and the phase-1.5 shared
 * duo, whose knowledge is written, not learned from a corpus.
 */
class AuthoredKnowledgeSource implements KnowledgeSource {
  readonly kind = "authored";

  constructor(private readonly documents: readonly string[]) {}

  async retrieve(query: string): Promise<KnowledgeItem[]> {
    const needle = query.toLowerCase();
    return this.documents
      .filter((document) => document.toLowerCase().includes(needle))
      .map((document) => ({ text: document, source: "authored" }));
  }
}

/**
 * Resolves a KnowledgeSourceConfig to its implementation. This is the one
 * place a duo's knowledge kind is switched on; every other call site goes
 * through the KnowledgeSource interface and never knows which kind it holds.
 */
export function createKnowledgeSource(config: KnowledgeSourceConfig): KnowledgeSource {
  switch (config.kind) {
    case "derived":
      return new DerivedKnowledgeSource(config.storePath);
    case "authored":
      return new AuthoredKnowledgeSource(config.documents);
  }
}
