/**
 * Who a duo speaks for. `person` and `role` both carry an id and a
 * human-readable name; `none` is a fully synthetic persona with nobody
 * backing it (concept.md §12). Every call site that needs a human — an
 * escalation, an approval — must handle all three explicitly rather than
 * assume `owner` is a person.
 */
export type Owner =
  | { readonly kind: "person"; readonly id: string; readonly name: string }
  | { readonly kind: "role"; readonly id: string; readonly name: string }
  | { readonly kind: "none" };

/** A single piece of retrieved knowledge, with its source named for provenance. */
export interface KnowledgeItem {
  readonly text: string;
  readonly source: string;
}

/**
 * The one interface knowledge retrieval goes through, whether the source is
 * a derivation pipeline over the owner's corpus or a fixed, hand-authored
 * document set. Callers never know which implementation backs a given duo.
 */
export interface KnowledgeSource {
  readonly kind: "derived" | "authored";
  retrieve(query: string): Promise<KnowledgeItem[]>;
}

/** Configures which KnowledgeSource implementation a duo resolves to. */
export type KnowledgeSourceConfig =
  | { readonly kind: "derived"; readonly storePath: string }
  | { readonly kind: "authored"; readonly documents: readonly string[] };

/** A duo's persona: how it speaks, independent of what it knows. */
export interface PersonaDefinition {
  readonly voice: string;
}

/**
 * A duo's full definition — everything needed to construct it, and nothing
 * that isn't in this shape. There is no global "the owner" or "the
 * persona"; a duo resolves entirely from the definition passed to it.
 */
export interface DuoDefinition {
  readonly id: string;
  readonly owner: Owner;
  readonly persona: PersonaDefinition;
  readonly standingOrders: readonly string[];
  readonly refusals: readonly string[];
  readonly knowledge: KnowledgeSourceConfig;
}
