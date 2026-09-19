import type { DuoConfig } from "../config.js";
import { createOllamaProvider } from "./ollama-provider.js";
import { InferenceProvider, ProviderConfigError } from "./types.js";

export type ProviderFactory = (config: DuoConfig) => InferenceProvider;

/**
 * The production registry. Exactly one entry (Ollama) per the settled
 * decision that only one implementation ships right now. Tests prove R6's
 * swappability by passing a second, test-only registry — never by adding a
 * second entry here.
 */
export const defaultRegistry: Record<string, ProviderFactory> = {
  ollama: createOllamaProvider,
};

/**
 * Resolves an InferenceProvider from config via the registry. Throws
 * ProviderConfigError naming DUO_PROVIDER when it is unset or not a
 * registered name — this is the "no provider configured" half of R4, and it
 * never defaults to a different provider silently.
 */
export function resolveProvider(
  config: DuoConfig,
  registry: Record<string, ProviderFactory> = defaultRegistry,
): InferenceProvider {
  if (!config.providerName) {
    throw new ProviderConfigError("DUO_PROVIDER");
  }
  const factory = registry[config.providerName];
  if (!factory) {
    throw new ProviderConfigError("DUO_PROVIDER", config.providerName);
  }
  return factory(config);
}
