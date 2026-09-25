/**
 * The single interface every inference call in this codebase goes through.
 * No call site outside `src/provider/` may import a provider SDK or issue
 * an inference HTTP request directly (R3).
 */
export interface InferenceProvider {
  /** The provider's registry name, e.g. "ollama". */
  readonly name: string;
  /** Send a prompt to the provider and return its raw text completion. */
  complete(prompt: string): Promise<string>;
}

/**
 * The interface every embedding call goes through. Separate from
 * InferenceProvider: embeddings return a vector, not a text completion,
 * and — unlike completion, which waits on G1 — embeddings run locally via
 * Ollama unconditionally (v1-tech-design.md §1.2), so there is exactly one
 * implementation and it needs no registry to swap between alternatives.
 */
export interface EmbeddingProvider {
  /** The provider's name, e.g. "ollama". */
  readonly name: string;
  /** The specific embedding model in use, e.g. "nomic-embed-text" — recorded alongside every vector so a model change is detectable rather than silently mixing embedding spaces. */
  readonly model: string;
  /** Embeds a single piece of text and returns its vector. */
  embed(text: string): Promise<readonly number[]>;
}

/**
 * A typed question the Jev spike can ask a typed-decision model. Neutral
 * vocabulary on purpose: the provider layer must not leak Jev's wire names
 * ("noul", "choice") to callers — the adapter in jev-provider.ts owns that
 * mapping, so the interface stays removable as one unit (spike plan KTD1).
 */
export type TypedDecisionQuestion = BinaryQuestion | ChoiceQuestion;

/** A yes/no question; the answer is a probability, not a completion. */
export interface BinaryQuestion {
  readonly kind: "binary";
  readonly instructions: string;
}

/**
 * A menu-picking question. `criteria` maps option ids to their
 * descriptions — menu-picking is the capability being bought (settled
 * decision 4), so it is part of the interface, not an afterthought.
 */
export interface ChoiceQuestion {
  readonly kind: "choice";
  readonly instructions: string;
  readonly criteria: Readonly<Record<string, string>>;
}

export type TypedDecisionAnswer = BinaryAnswer | ChoiceAnswer;

export interface BinaryAnswer {
  readonly kind: "binary";
  /** Probability the answer is yes, 0–1. */
  readonly probability: number;
}

export interface ChoiceAnswer {
  readonly kind: "choice";
  /** The picked option id — always a key from the question's `criteria`. */
  readonly pick: string;
  /** Per-option probabilities when the model returns them (may cover the full criteria map or a top-k subset — recorded, not assumed). */
  readonly probabilities?: Readonly<Record<string, number>>;
  /** The model's own confidence in the pick, 0–1, when provided. */
  readonly confidence?: number;
}

/** Token accounting for one decide() call — Jev bills input tokens only, but output is reported the same way. */
export interface TypedDecisionUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface TypedDecisionResult {
  /** Positionally aligned with the `questions` argument. */
  readonly answers: readonly TypedDecisionAnswer[];
  /** The model's self-reported version string, e.g. "jev-1.13.0". */
  readonly model: string;
  readonly usage: TypedDecisionUsage;
}

/**
 * The interface every typed-decision call goes through — a parallel to
 * InferenceProvider, deliberately NOT shoehorned into complete() (settled
 * decision 3): Jev's state-plus-typed-questions-to-probabilities shape is
 * the thing being measured. Like EmbeddingProvider it has exactly one
 * implementation and no registry entry — the production provider registry
 * stays local-only (G1), so Jev never appears in defaultRegistry.
 */
export interface TypedDecisionProvider {
  /** The provider's name, e.g. "jev". */
  readonly name: string;
  /**
   * Ask a batch of typed questions against one shared state. Batched because
   * Jev prices per call's input tokens — one call carrying several questions
   * is the cheaper-and-faster shape the spike exists to measure.
   */
  decide(
    state: Readonly<Record<string, unknown>>,
    questions: readonly TypedDecisionQuestion[],
  ): Promise<TypedDecisionResult>;
}

/**
 * Thrown whenever a command that needs inference cannot proceed because a
 * provider is not configured, or a configured provider is missing a
 * required setting. The message always names the specific missing key so
 * failures are loud and actionable (R4) — callers must never catch this and
 * fall back to a different provider.
 */
export class ProviderConfigError extends Error {
  readonly missingKey: string;

  constructor(missingKey: string, detail?: string) {
    const message = detail
      ? `Missing or invalid configuration: ${missingKey} (${detail})`
      : `Missing or invalid configuration: ${missingKey}`;
    super(message);
    this.name = "ProviderConfigError";
    this.missingKey = missingKey;
  }
}

/**
 * Thrown when a provider is configured correctly but the call itself fails
 * (e.g. the local Ollama server is unreachable, or returns an error
 * response). Distinct from ProviderConfigError, which is a configuration
 * problem discovered before any request is made.
 */
export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}
