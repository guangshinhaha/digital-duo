import type { DuoConfig } from "../config.js";
import { EmbeddingProvider, ProviderConfigError, ProviderError } from "./types.js";

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * The sole EmbeddingProvider: a local Ollama HTTP client against
 * `/api/embeddings`, mirroring OllamaProvider's `/api/generate` client —
 * same raw-fetch, no-SDK approach (KTD1), same error shapes so callers
 * handle both providers' failures identically.
 */
class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly name = "ollama";

  constructor(
    private readonly host: string,
    readonly model: string,
    private readonly numThread: number | undefined,
  ) {}

  async embed(text: string): Promise<readonly number[]> {
    let response: Response;
    try {
      response = await fetch(`${this.host}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          prompt: text,
          ...(this.numThread === undefined ? {} : { options: { num_thread: this.numThread } }),
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      throw new ProviderError(
        `Ollama unreachable at ${this.host} (embedding model "${this.model}"): ${String(
          cause instanceof Error ? cause.message : cause,
        )}`,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new ProviderError(
        `Ollama embedding request failed for model "${this.model}" at ${this.host}: ${response.status} ${body}`.trim(),
      );
    }

    let data: { embedding?: unknown } | null;
    try {
      data = (await response.json()) as { embedding?: unknown } | null;
    } catch (cause) {
      throw new ProviderError(
        `Ollama returned a non-JSON embedding response for model "${this.model}" at ${this.host}: ${String(
          cause instanceof Error ? cause.message : cause,
        )}`,
      );
    }
    if (data === null || !Array.isArray(data.embedding) || data.embedding.some((value) => typeof value !== "number")) {
      throw new ProviderError(
        `Ollama returned an unexpected embedding response shape for model "${this.model}" at ${this.host}`,
      );
    }
    return data.embedding as number[];
  }
}

/** Constructs the Ollama embedding provider from config. Throws ProviderConfigError if the model is unset — defensive, since config.ts always applies a default. */
export function createOllamaEmbeddingProvider(config: DuoConfig): EmbeddingProvider {
  if (!config.ollama.embeddingModel) {
    throw new ProviderConfigError("DUO_OLLAMA_EMBEDDING_MODEL");
  }
  return new OllamaEmbeddingProvider(config.ollama.host, config.ollama.embeddingModel, config.ollama.numThread);
}
