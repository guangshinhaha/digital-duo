import { ProviderError, type TypedDecisionProvider, type TypedDecisionQuestion, type TypedDecisionResult } from "../../src/provider/types.js";

/**
 * A deterministic, offline stand-in for the Jev adapter, in the
 * fake-embedding-provider.ts shape: one working variant scripted with
 * answers, one failing variant. One deliberate divergence from that
 * precedent — the failing fake throws `ProviderError`, not a plain Error,
 * because the spike's eval code branches on exactly that class (a call
 * failure aborts the run and persists a failed section; a config error
 * never starts one).
 *
 * Every call is recorded so tests can audit the exact requests the eval
 * layers built — the egress-audit assertions deep-equal against
 * `calls[n].state` and `calls[n].questions` rather than trusting printouts.
 */
export interface FakeJevCall {
  readonly state: Readonly<Record<string, unknown>>;
  readonly questions: readonly TypedDecisionQuestion[];
}

export interface FakeJevProvider extends TypedDecisionProvider {
  readonly calls: ReadonlyArray<FakeJevCall>;
}

export function createFakeJevProvider(script: readonly TypedDecisionResult[]): FakeJevProvider {
  const remaining = [...script];
  const calls: FakeJevCall[] = [];
  return {
    name: "fake-jev",
    calls,
    async decide(state, questions) {
      calls.push({ state, questions });
      const next = remaining.shift();
      if (next === undefined) {
        throw new ProviderError("fake Jev script exhausted before the run ended");
      }
      return next;
    },
  };
}

/** A TypedDecisionProvider whose every call fails the way an unreachable gateway does. */
export function createFailingJevProvider(): TypedDecisionProvider {
  return {
    name: "fake-jev",
    async decide() {
      throw new ProviderError("Jev gateway unreachable at https://fake.invalid/v1/systemone (fake)");
    },
  };
}

/** Script helpers: one-line TypedDecisionResults for the two question kinds. */
export function binaryResult(probability: number, model = "fake-jev-1"): TypedDecisionResult {
  return {
    answers: [{ kind: "binary", probability }],
    model,
    usage: { inputTokens: 10, outputTokens: 0 },
  };
}

export function choiceResult(
  pick: string,
  options: { probabilities?: Record<string, number>; confidence?: number; model?: string } = {},
): TypedDecisionResult {
  return {
    answers: [
      {
        kind: "choice",
        pick,
        ...(options.probabilities ? { probabilities: options.probabilities } : {}),
        ...(options.confidence !== undefined ? { confidence: options.confidence } : {}),
      },
    ],
    model: options.model ?? "fake-jev-1",
    usage: { inputTokens: 10, outputTokens: 0 },
  };
}
