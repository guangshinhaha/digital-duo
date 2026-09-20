import type { DuoConfig } from "../config.js";
import {
  ProviderConfigError,
  ProviderError,
  type BinaryAnswer,
  type ChoiceAnswer,
  type TypedDecisionAnswer,
  type TypedDecisionProvider,
  type TypedDecisionQuestion,
  type TypedDecisionResult,
} from "./types.js";

/**
 * Adapter for TypeSafe AI's Jev ("System One") typed-decision endpoint.
 *
 * Spike-scoped (docs/plans/2026-09-20-1759-spike-jev-typed-decisions-plan.md):
 * this is the ONLY module the hosted gateway is reachable from, everything it
 * sends is fixture-synthetic (R9), and it is never registered in
 * defaultRegistry — callers construct it explicitly through createJevProvider.
 *
 * Wire contract (verified against the vendor docs by the planning research
 * pass): POST {gateway}/v1/systemone with {state, model, questions} where
 * `questions` is a map of caller-chosen ids to typed questions — the ids are
 * correlation keys and are not seen by the model. A "noul" question answers
 * with a 0–1 number; a "choice" question answers with a picked criteria key,
 * per-option probabilities, and a confidence.
 */

const REQUEST_TIMEOUT_MS = 30_000;
const JEV_MODEL = "jev-latest";
// Error bodies are echoed into ProviderError messages, which reach the
// terminal and the spike's recorded exchanges — so they are scrubbed of the
// API key and any bearer-token-shaped content, then capped (KTD10).
const ERROR_BODY_MAX_CHARS = 300;

function scrubAndTruncate(body: string, apiKey: string): string {
  let text = body.split(apiKey).join("«redacted»");
  text = text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer «redacted»");
  if (text.length > ERROR_BODY_MAX_CHARS) {
    text = `${text.slice(0, ERROR_BODY_MAX_CHARS)}…`;
  }
  return text;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A finite number or undefined — the one coercion every accounting field goes through. */
function optionalFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The raw JSON shape of one wire answer, before validation. */
interface WireAnswer {
  noul?: unknown;
  choice?: unknown;
  probabilities?: unknown;
  confidence?: unknown;
}

class JevProvider implements TypedDecisionProvider {
  readonly name = "jev";
  private readonly endpoint: string;
  private readonly apiKey: string;

  constructor(gatewayUrl: string, apiKey: string) {
    this.endpoint = `${gatewayUrl.replace(/\/+$/, "")}/v1/systemone`;
    this.apiKey = apiKey;
  }

  async decide(
    state: Readonly<Record<string, unknown>>,
    questions: readonly TypedDecisionQuestion[],
  ): Promise<TypedDecisionResult> {
    // Caller-chosen correlation ids (q0, q1, …) — positionally aligned with
    // the questions array so answers map back without carrying the ids out.
    const wireQuestions: Record<string, object> = {};
    questions.forEach((question, index) => {
      wireQuestions[`q${index}`] =
        question.kind === "binary"
          ? { type: "noul", instructions: question.instructions }
          : {
              type: "choice",
              instructions: question.instructions,
              criteria: { ...question.criteria },
            };
    });

    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ state, model: JEV_MODEL, questions: wireQuestions }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new ProviderError(
        `Jev gateway unreachable at ${this.endpoint}: ${errorMessage(error)}`,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new ProviderError(
        `Jev gateway returned HTTP ${response.status}: ${scrubAndTruncate(body, this.apiKey)}`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ProviderError(
        `Jev gateway returned a non-JSON response (HTTP ${response.status})`,
      );
    }

    const answers = (payload as { answers?: unknown } | null)?.answers;
    if (typeof answers !== "object" || answers === null) {
      throw new ProviderError(
        "Jev gateway returned an unexpected response shape: no answers object",
      );
    }
    const answerMap = answers as Record<string, unknown>;

    const mapped: TypedDecisionAnswer[] = questions.map((question, index) => {
      const wire = answerMap[`q${index}`];
      if (typeof wire !== "object" || wire === null) {
        throw new ProviderError(
          `Jev gateway returned an unexpected response shape: no answer for question ${index}`,
        );
      }
      const answer = wire as WireAnswer;
      if (question.kind === "binary") {
        const probability = optionalFinite(answer.noul);
        if (probability === undefined) {
          throw new ProviderError(
            `Jev gateway returned an unexpected response shape: question ${index} has no numeric noul answer`,
          );
        }
        if (probability < 0 || probability > 1) {
          throw new ProviderError(
            `Jev gateway returned an out-of-contract noul for question ${index}: ${probability} is outside 0-1`,
          );
        }
        const binary: BinaryAnswer = { kind: "binary", probability };
        return binary;
      }
      if (typeof answer.choice !== "string") {
        throw new ProviderError(
          `Jev gateway returned an unexpected response shape: question ${index} has no string choice answer`,
        );
      }
      const probabilities =
        typeof answer.probabilities === "object" &&
        answer.probabilities !== null &&
        Object.values(answer.probabilities).every((p) => optionalFinite(p) !== undefined)
          ? (answer.probabilities as Record<string, number>)
          : undefined;
      const confidence = optionalFinite(answer.confidence);
      const choice: ChoiceAnswer = {
        kind: "choice",
        pick: answer.choice,
        ...(probabilities ? { probabilities } : {}),
        ...(confidence !== undefined ? { confidence } : {}),
      };
      return choice;
    });

    // Usage and model are accounting metadata, not the product — coerce
    // instead of failing a run whose answers were fine.
    const usage = (payload as { usage?: { input_tokens?: unknown; output_tokens?: unknown } }).usage;
    const inputTokens = optionalFinite(usage?.input_tokens) ?? 0;
    const outputTokens = optionalFinite(usage?.output_tokens) ?? 0;
    const rawModel = (payload as { model?: unknown }).model;
    const model = typeof rawModel === "string" ? rawModel : "unknown";

    return { answers: mapped, model, usage: { inputTokens, outputTokens } };
  }
}

/**
 * Constructs the Jev adapter from configuration. Fails loudly and before any
 * request when the spike is not configured (no DUO_JEV_API_KEY) or when the
 * gateway URL is not https — the key and the synthetic payloads never travel
 * in plaintext (KTD2/KTD10).
 */
export function createJevProvider(config: DuoConfig): TypedDecisionProvider {
  if (!config.jev.apiKey) {
    throw new ProviderConfigError(
      "DUO_JEV_API_KEY",
      "the Jev spike requires an explicit API key — see docs/plans/2026-09-20-1759-spike-jev-typed-decisions-plan.md",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(config.jev.gatewayUrl);
  } catch {
    throw new ProviderConfigError("DUO_JEV_GATEWAY_URL", `"${config.jev.gatewayUrl}" is not a parseable URL`);
  }
  if (parsed.protocol !== "https:") {
    throw new ProviderConfigError(
      "DUO_JEV_GATEWAY_URL",
      `"${config.jev.gatewayUrl}" must be an https:// URL — the API key and payloads are never sent in plaintext`,
    );
  }
  return new JevProvider(config.jev.gatewayUrl, config.jev.apiKey);
}
