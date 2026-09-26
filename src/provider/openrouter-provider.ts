import type { DuoConfig } from "../config.js";
import { InferenceProvider, ProviderConfigError, ProviderError } from "./types.js";

// Longer than Ollama's 30s: a hosted router adds queueing and the Auto
// Router may pick a slower, larger model for a hard prompt.
const REQUEST_TIMEOUT_MS = 90_000;

/**
 * The hosted completion provider for the Railway POC (docs/deploy/railway.md):
 * OpenRouter's OpenAI-compatible `/chat/completions`, raw `fetch`, no SDK —
 * the same shape as the Ollama provider. Selecting it is the owner's
 * explicit egress decision (DUO_PROVIDER=openrouter); nothing defaults here.
 */
class OpenRouterProvider implements InferenceProvider {
  readonly name = "openrouter";

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async complete(prompt: string): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          "X-Title": "Digital Duo",
        },
        body: JSON.stringify({ model: this.model, messages: [{ role: "user", content: prompt }] }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      throw new ProviderError(
        `OpenRouter unreachable at ${this.baseUrl} (model "${this.model}"): ${String(
          cause instanceof Error ? cause.message : cause,
        )}`,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new ProviderError(`OpenRouter request failed for model "${this.model}": ${response.status} ${body}`.trim());
    }

    let data: { choices?: Array<{ message?: { content?: unknown } }> } | null;
    try {
      data = (await response.json()) as typeof data;
    } catch (cause) {
      throw new ProviderError(
        `OpenRouter returned a non-JSON response for model "${this.model}": ${String(
          cause instanceof Error ? cause.message : cause,
        )}`,
      );
    }
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new ProviderError(`OpenRouter returned an unexpected response shape for model "${this.model}"`);
    }
    return content;
  }
}

/** Throws ProviderConfigError naming DUO_OPENROUTER_API_KEY when the key is unset (R4). */
export function createOpenRouterProvider(config: DuoConfig): InferenceProvider {
  if (!config.openrouter.apiKey) {
    throw new ProviderConfigError("DUO_OPENROUTER_API_KEY");
  }
  if (!config.openrouter.baseUrl.startsWith("https://")) {
    throw new ProviderConfigError("DUO_OPENROUTER_BASE_URL", "must be https — the API key is sent on every request");
  }
  return new OpenRouterProvider(config.openrouter.baseUrl.replace(/\/+$/, ""), config.openrouter.apiKey, config.openrouter.model);
}
