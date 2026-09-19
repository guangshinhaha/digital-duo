import type { DuoConfig } from "../config.js";
import { InferenceProvider, ProviderConfigError, ProviderError } from "./types.js";

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * The sole production InferenceProvider: a local Ollama HTTP client. No SDK
 * — a raw `fetch` call against Ollama's `/api/generate` endpoint (KTD1).
 * Never sends anything to a hosted API.
 */
class OllamaProvider implements InferenceProvider {
  readonly name = "ollama";

  constructor(
    private readonly host: string,
    private readonly model: string,
  ) {}

  async complete(prompt: string): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${this.host}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, prompt, stream: false }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      // Network failure, DNS failure, or the request timed out — Ollama is
      // not reachable at the configured host. Never fall back silently.
      throw new ProviderError(
        `Ollama unreachable at ${this.host} (model "${this.model}"): ${String(
          cause instanceof Error ? cause.message : cause,
        )}`,
      );
    }

    if (!response.ok) {
      // The server responded, so it is not "unreachable" — this is a
      // distinct failure (e.g. the model isn't pulled). Report the
      // response's own status/body rather than mislabeling it.
      const body = await response.text().catch(() => "");
      throw new ProviderError(
        `Ollama request failed for model "${this.model}" at ${this.host}: ${response.status} ${body}`.trim(),
      );
    }

    const data = (await response.json()) as { response?: unknown };
    if (typeof data.response !== "string") {
      throw new ProviderError(
        `Ollama returned an unexpected response shape for model "${this.model}" at ${this.host}`,
      );
    }
    return data.response;
  }
}

/**
 * Constructs the Ollama provider from config. Throws ProviderConfigError at
 * construction time if the model is unset — this is the "credentials/
 * settings absent" half of R4.
 */
export function createOllamaProvider(config: DuoConfig): InferenceProvider {
  if (!config.ollama.model) {
    throw new ProviderConfigError("DUO_OLLAMA_MODEL");
  }
  return new OllamaProvider(config.ollama.host, config.ollama.model);
}
