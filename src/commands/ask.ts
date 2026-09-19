import type { DuoConfig } from "../config.js";
import { resolveProvider } from "../provider/registry.js";

/**
 * Implements `duo ask <prompt>` (R4, R5). The one command that resolves and
 * calls the provider, so a missing/misconfigured provider (R4) and a real
 * Ollama call (R5) are both exercised without adding any drafting or
 * derivation logic. Any error from resolveProvider or complete() propagates
 * to the CLI boundary (src/cli.ts), which is the single place that formats
 * it, prints to stderr, and sets a non-zero exit code.
 */
export async function runAsk(prompt: string, config: DuoConfig): Promise<string> {
  const provider = resolveProvider(config);
  return provider.complete(prompt);
}
