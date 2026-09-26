import type { DuoConfig } from "../config.js";
import { createOllamaProvider } from "./ollama-provider.js";
import { createOpenRouterProvider } from "./openrouter-provider.js";
import { InferenceProvider, ProviderConfigError } from "./types.js";

export type ProviderFactory = (config: DuoConfig) => InferenceProvider;

/**
 * The production registry. Ollama is the local-only option; OpenRouter is
 * the hosted option added for the Railway POC (docs/deploy/railway.md) — the
 * owner's 2026-09-26 call on #14 for the pilot. Neither is a default:
 * DUO_PROVIDER must name one explicitly (R4).
 */
export const defaultRegistry: Record<string, ProviderFactory> = {
  ollama: createOllamaProvider,
  openrouter: createOpenRouterProvider,
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
  // Own-property check: a plain bracket lookup on registry would also
  // resolve Object.prototype members (e.g. DUO_PROVIDER="constructor"),
  // silently returning a non-provider value instead of a clean, named error.
  const factory = Object.prototype.hasOwnProperty.call(registry, config.providerName)
    ? registry[config.providerName]
    : undefined;
  if (!factory) {
    throw new ProviderConfigError("DUO_PROVIDER", config.providerName);
  }
  return factory(config);
}

/**
 * Resolves a provider for a best-effort LLM helper (adjudication,
 * labeling, answering) — a missing/misconfigured provider (G1 is
 * unresolved) degrades that helper to its deterministic fallback rather
 * than failing the whole operation. Shared by every `duo derive *`
 * command and `duo permissions ask` rather than each command re-deriving
 * the same try/catch.
 */
export function tryResolveProvider(
  config: DuoConfig,
  registry: Record<string, ProviderFactory> = defaultRegistry,
): InferenceProvider | undefined {
  try {
    return resolveProvider(config, registry);
  } catch (error) {
    if (error instanceof ProviderConfigError) {
      return undefined;
    }
    throw error;
  }
}
