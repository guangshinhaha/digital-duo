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
