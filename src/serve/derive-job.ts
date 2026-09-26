import { createLlmAdjudicator, runPairExtraction } from "../derivation/qa-pairs.js";
import { createLlmRuleTextGenerator, runRuleInduction } from "../derivation/rules.js";
import { createLlmTopicLabeler, runTopicAssignment } from "../derivation/topics.js";
import { createLlmRegisterDescriber, runVoiceProfile } from "../derivation/voice.js";
import type { EmbeddingProvider, InferenceProvider } from "../provider/types.js";

export type DeriveStage = "pairs" | "topics" | "rules" | "voice";

export interface DeriveJobStatus {
  readonly state: "idle" | "running" | "done" | "error";
  /** The stage running now, or the one that failed; null before the first run and after success. */
  readonly stage: DeriveStage | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly error: string | null;
}

export interface DeriveJobInputs {
  readonly storePath: string;
  readonly passphrase: string;
  readonly duoDir: string;
  readonly embeddingProvider: EmbeddingProvider;
  readonly inferenceProvider: InferenceProvider | undefined;
}

/**
 * The daemon's one derivation job — `duo derive pairs && topics && rules &&
 * voice`, run in-process so an owner with no terminal (a hosted user) can
 * build their duo from the app. Same shape as EmbedJob: one job at a time
 * (every stage is a whole-corpus read-modify-write), POST starts it, GET
 * reports it. Each stage calls the exact module function its CLI command
 * calls, with the same best-effort LLM helpers, so the app and the terminal
 * derive identically.
 */
export class DeriveJob {
  private status: DeriveJobStatus = { state: "idle", stage: null, startedAt: null, finishedAt: null, error: null };

  current(): DeriveJobStatus {
    return this.status;
  }

  /** Starts a run unless one is running; false means refused (a 409). Never throws — failures land in the status. */
  start(inputs: DeriveJobInputs): boolean {
    if (this.status.state === "running") {
      return false;
    }
    this.status = { state: "running", stage: "pairs", startedAt: new Date().toISOString(), finishedAt: null, error: null };
    void this.run(inputs);
    return true;
  }

  private async run(inputs: DeriveJobInputs): Promise<void> {
    const { storePath, passphrase, duoDir, embeddingProvider, inferenceProvider: provider } = inputs;
    const stages: Array<[DeriveStage, () => Promise<unknown>]> = [
      ["pairs", () => runPairExtraction(storePath, passphrase, { adjudicate: provider ? createLlmAdjudicator(provider) : undefined })],
      [
        "topics",
        () =>
          runTopicAssignment(storePath, passphrase, duoDir, embeddingProvider, {
            labelTopic: provider ? createLlmTopicLabeler(provider) : undefined,
          }),
      ],
      [
        "rules",
        () =>
          runRuleInduction(storePath, passphrase, embeddingProvider, {
            generateRuleText: provider ? createLlmRuleTextGenerator(provider) : undefined,
          }),
      ],
      [
        "voice",
        // force: the app has no hand-edit surface for voice.md, so a re-run
        // from the app should reflect the corpus as it now stands.
        () => runVoiceProfile(storePath, passphrase, duoDir, { describeRegister: provider ? createLlmRegisterDescriber(provider) : undefined, force: true }),
      ],
    ];
    for (const [stage, run] of stages) {
      this.status = { ...this.status, stage };
      try {
        await run();
      } catch (error) {
        this.status = {
          ...this.status,
          state: "error",
          finishedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        };
        return;
      }
    }
    this.status = { ...this.status, state: "done", stage: null, finishedAt: new Date().toISOString() };
  }
}
