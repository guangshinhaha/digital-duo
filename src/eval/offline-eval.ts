import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DuoConfig } from "../config.js";
import { type Adjudicate, extractQaPairs, listQaPairs, type QaPair, runPairExtraction } from "../derivation/qa-pairs.js";
import { listRuleEvidence, listRules, runRuleInduction, type Rule, type RuleTextGenerator } from "../derivation/rules.js";
import { approveRule, RefusalConflictError } from "../derivation/rule-review.js";
import { runTopicAssignment, type TopicLabeler } from "../derivation/topics.js";
import { draftReply } from "../drafting/pipeline.js";
import { listRecords, writeRecords } from "../ingest/record-store.js";
import type { EmbeddingProvider, InferenceProvider } from "../provider/types.js";
import { createEncryptedStore, dataDirFor } from "../store/store.js";
import { assertNoHeldOutEvidence } from "./held-out-assertion.js";
import { pickSeededSample } from "./seeded-sample.js";
import { splitCorpusByTime } from "./time-split.js";

/**
 * #35's honest caveat, in the shape #30's HELD_OUT_CAVEAT and #69's
 * unresolvedQuestionGaps established: named plainly rather than glossed
 * over. Would-have-sent judgements come from an LLM (createLlmWouldHaveSentJudge)
 * when a provider is configured, or are left "not_judged" when one isn't
 * (G1 is unresolved) — either way they are not ground truth. #35's own AC
 * checklist says as much: "the judgement is spot-checked by hand".
 * `humanReviewSample` on the report names which items to check first.
 */
export const WOULD_HAVE_SENT_CAVEAT =
  "would-have-sent judgements are model-generated (or left \"not_judged\" with no provider configured) — " +
  "not ground truth. Spot-check the items in humanReviewSample by hand before trusting wouldHaveSentRate.";

export const WOULD_HAVE_SENT_VALUES = ["yes", "no", "unclear", "not_judged"] as const;
export type WouldHaveSentJudgement = (typeof WOULD_HAVE_SENT_VALUES)[number];

export type WouldHaveSentJudge = (question: string, realAnswer: string, draftedAnswer: string) => Promise<WouldHaveSentJudgement>;

/** LLM-backed would-have-sent judge. Never throws: any provider failure or unparseable response falls back to "not_judged", the same value used when no provider is configured at all — a failed judgement should not abort the run. */
export function createLlmWouldHaveSentJudge(provider: InferenceProvider): WouldHaveSentJudge {
  return async (question, realAnswer, draftedAnswer) => {
    try {
      const response = await provider.complete(
        [
          `Question: "${question}"`,
          `The owner's real, already-sent answer: "${realAnswer}"`,
          `A drafted answer, generated without ever seeing the real answer: "${draftedAnswer}"`,
          'Would the owner plausibly have sent the drafted answer as-is? Reply with exactly one word: "yes", "no", or "unclear".',
        ].join("\n"),
      );
      const cleaned = response.trim().toLowerCase();
      if (cleaned.includes("yes")) {
        return "yes";
      }
      if (cleaned.includes("no")) {
        return "no";
      }
      return "unclear";
    } catch {
      return "not_judged";
    }
  };
}

export interface OfflineEvalItem {
  readonly qaPairId: string;
  readonly questionText: string;
  readonly realAnswerText: string;
  /** Null when the pipeline escalated instead of drafting — never a fabricated draft to compare against. */
  readonly draftedText: string | null;
  readonly escalated: boolean;
  /** Cosine similarity between the drafted and real answer's embeddings, or null when there's no draft to compare, or embedding failed. */
  readonly similarity: number | null;
  readonly wouldHaveSent: WouldHaveSentJudgement;
}

export interface OfflineEvalReport {
  readonly holdoutDays: number;
  readonly cutoff: string;
  readonly corpusSpanDays: number;
  readonly trainRecordCount: number;
  readonly heldOutRecordCount: number;
  /** Every qa_pair whose answer falls at or after the cutoff — the full held-out set, before any sampling. */
  readonly heldOutPairCount: number;
  /** How many of `heldOutPairCount` were actually drafted and scored this run. */
  readonly evaluatedCount: number;
  readonly seed: number;
  /** Mean cosine similarity over items with a non-null similarity; 0 when there are none. */
  readonly meanSimilarity: number;
  /** Fraction of "yes"-judged among items judged "yes" or "no" (never counting "unclear"/"not_judged" as either); 0 when nothing was judged. */
  readonly wouldHaveSentRate: number;
  readonly escalationRate: number;
  /** A seeded-random subset of `items`' qa_pair ids, flagged for hand spot-check per the AC checklist. */
  readonly humanReviewSample: readonly string[];
  readonly confirmedRuleCount: number;
  readonly inconsistentRuleCount: number;
  readonly weakSignalRuleCount: number;
  readonly items: readonly OfflineEvalItem[];
}

export interface OfflineEvalOptions {
  /** How many held-out pairs to actually draft and score; defaults to all of them. */
  sampleSize?: number;
  /** Seeds both which held-out pairs get sampled and which get flagged for human review (#35 AC3). Defaults to a fixed value, so two runs over the same corpus and config agree. */
  seed?: number;
  adjudicate?: Adjudicate;
  labelTopic?: TopicLabeler;
  generateRuleText?: RuleTextGenerator;
  judgeWouldHaveSent?: WouldHaveSentJudge;
}

const DEFAULT_SEED = 42;
const HUMAN_REVIEW_SAMPLE_SIZE = 5;

function evalStagingPathFor(storePath: string): string {
  return join(dataDirFor(storePath), `eval-${randomBytes(8).toString("hex")}.staging.db`);
}

function evalDuoDirFor(storePath: string): string {
  return join(dataDirFor(storePath), `eval-${randomBytes(8).toString("hex")}.duo`);
}

function deleteIfExists(path: string): void {
  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true });
  }
}

/** Real, hand-written policy — copied (not re-derived) into the scratch duoDir so an eval run's escalations still honor it, same as production. Refusals are corpus-independent by design (v1-tech-design.md §1.1: "hand-written, never derived"), so copying the file verbatim is faithful, unlike topics/rules/voice which genuinely differ under a train-only split. */
function copyRefusalsFile(realDuoDir: string, scratchDuoDir: string): void {
  const source = join(realDuoDir, "refusals.md");
  if (existsSync(source)) {
    mkdirSync(scratchDuoDir, { recursive: true });
    copyFileSync(source, join(scratchDuoDir, "refusals.md"));
  }
}

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * The offline evaluation harness (v1-tech-design.md §1.10, AR-7): splits
 * the corpus by time *before* deriving anything, runs the real derivation
 * pipeline (#23-#25) over the train split only, in an isolated transient
 * store and scratch duoDir — never the real ones — then drafts a real
 * answer (via #32's own draftReply) for each held-out question and scores
 * it against what the owner actually said.
 *
 * The transient store and scratch duoDir are the same "separate handle,
 * deleted when done" shape #21's two-phase ingest uses for its staging
 * database: derivation never gets a chance to see anything outside the
 * train split because it is never given a handle to anything else, and
 * nothing here is left on disk once the run completes (or fails).
 *
 * Deliberately skips regenerating a voice profile for the scratch run —
 * gatherDraftContext degrades to a plain placeholder when duo/voice.md
 * doesn't exist, and voice conditions phrasing, not the draft/escalate
 * decision this harness scores.
 */
export async function runOfflineEval(
  storePath: string,
  passphrase: string,
  duoDir: string,
  embeddingProvider: EmbeddingProvider,
  inferenceProvider: InferenceProvider | undefined,
  confidenceConfig: DuoConfig["confidence"],
  holdoutDays: number,
  options: OfflineEvalOptions = {},
): Promise<OfflineEvalReport> {
  const seed = options.seed ?? DEFAULT_SEED;

  // Deliberately does not call requireRefusalsDecision (#29's onboarding
  // gate) the way #30's calibration does: that gate exists for the
  // Mirror's own onboarding flow, whereas this harness is meant to run
  // "before Slack is ever connected" and while the owner is still
  // deciding whether to keep going at all (v1-tech-design.md §1.10) —
  // gating it on a decision the owner hasn't made yet would contradict
  // its own stated purpose. A real refusals.md, if one already exists, is
  // still honored (see copyRefusalsFile below); there just isn't a hard
  // requirement that one has been written yet.
  const records = listRecords(storePath, passphrase);
  const split = splitCorpusByTime(records, holdoutDays); // throws CorpusTooShortError — #35 AC2

  const recordsById = new Map(records.map((record) => [record.id, record]));

  const evalStorePath = evalStagingPathFor(storePath);
  const evalDuoDir = evalDuoDirFor(storePath);
  createEncryptedStore(evalStorePath, passphrase);

  try {
    copyRefusalsFile(duoDir, evalDuoDir);
    writeRecords(evalStorePath, passphrase, split.trainRecords);

    await runPairExtraction(evalStorePath, passphrase, { adjudicate: options.adjudicate });
    await runTopicAssignment(evalStorePath, passphrase, evalDuoDir, embeddingProvider, { labelTopic: options.labelTopic });
    const ruleSummary = await runRuleInduction(evalStorePath, passphrase, embeddingProvider, {
      generateRuleText: options.generateRuleText,
    });

    // There is no owner to review-and-approve a rule inside a fully
    // automated eval run — #28's reviewStatus starts every freshly induced
    // rule at "pending", and findRuleHit (context.ts) only ever counts an
    // "approved" one. Leaving every rule pending would silently zero out
    // the rule-hit confidence signal for every item, understating what
    // the pipeline would actually do once a real owner reviews well-
    // supported rules. So every `confirmed` rule induced from the train
    // split is auto-approved within this scratch store only — a documented
    // approximation (same spirit as #30's calibration caveat), never
    // touching the real store's own review state. A genuine refusal
    // conflict still blocks approval, exactly as it would for a real
    // owner — that safety property is never bypassed here.
    for (const rule of ruleSummary.rules) {
      if (rule.status !== "confirmed") {
        continue;
      }
      try {
        approveRule(evalStorePath, passphrase, evalDuoDir, rule.id);
      } catch (error) {
        if (!(error instanceof RefusalConflictError)) {
          throw error;
        }
      }
    }

    // #35 AC1: asserted, not assumed.
    const evalQaPairsById = new Map<string, QaPair>(listQaPairs(evalStorePath, passphrase).map((pair) => [pair.id, pair]));
    const rules: readonly Rule[] = listRules(evalStorePath, passphrase);
    const evidenceByRuleId = new Map<string, readonly string[]>(
      rules.map((rule) => [rule.id, listRuleEvidence(evalStorePath, passphrase, rule.id)]),
    );
    assertNoHeldOutEvidence(rules, evidenceByRuleId, evalQaPairsById, recordsById, split.cutoff);

    // Extracted over the *full* corpus (pairing needs a thread's whole
    // context), then filtered to the pairs whose answer falls at or after
    // the cutoff — these are the questions genuinely new to a duo that
    // only ever saw the train split.
    const cutoffMs = new Date(split.cutoff).getTime();
    const { pairs: allPairs } = await extractQaPairs(records, { adjudicate: options.adjudicate });
    const heldOutPairs = allPairs
      .filter((pair) => {
        const ts = new Date(pair.ts).getTime();
        return !Number.isNaN(ts) && ts >= cutoffMs;
      })
      .sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id));

    const sampled = pickSeededSample(heldOutPairs, options.sampleSize ?? heldOutPairs.length, seed).sort(
      (a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id),
    );

    const judge: WouldHaveSentJudge =
      options.judgeWouldHaveSent ?? (inferenceProvider ? createLlmWouldHaveSentJudge(inferenceProvider) : async () => "not_judged");

    const items: OfflineEvalItem[] = [];
    for (const pair of sampled) {
      const question = recordsById.get(pair.questionId);
      const answer = recordsById.get(pair.answerId);
      if (!question || !answer) {
        continue; // a record removed since this pair was extracted — skip rather than crash the whole run over one stale citation
      }

      const draft = await draftReply(
        evalStorePath,
        passphrase,
        evalDuoDir,
        question.text,
        null,
        embeddingProvider,
        inferenceProvider,
        confidenceConfig,
      );
      const draftedText = draft.kind === "draft" ? draft.text : null;

      let similarity: number | null = null;
      if (draftedText !== null) {
        try {
          const [draftedVector, realVector] = await Promise.all([
            embeddingProvider.embed(draftedText),
            embeddingProvider.embed(answer.text),
          ]);
          similarity = cosineSimilarity(draftedVector, realVector);
        } catch {
          similarity = null;
        }
      }

      const wouldHaveSent = draftedText !== null ? await judge(question.text, answer.text, draftedText) : "not_judged";

      items.push({
        qaPairId: pair.id,
        questionText: question.text,
        realAnswerText: answer.text,
        draftedText,
        escalated: draft.kind === "escalation",
        similarity,
        wouldHaveSent,
      });
    }

    const withSimilarity = items.filter((item): item is OfflineEvalItem & { similarity: number } => item.similarity !== null);
    const meanSimilarity =
      withSimilarity.length === 0 ? 0 : withSimilarity.reduce((sum, item) => sum + item.similarity, 0) / withSimilarity.length;

    const judged = items.filter((item) => item.wouldHaveSent === "yes" || item.wouldHaveSent === "no");
    const wouldHaveSentRate = judged.length === 0 ? 0 : judged.filter((item) => item.wouldHaveSent === "yes").length / judged.length;

    const escalationRate = items.length === 0 ? 0 : items.filter((item) => item.escalated).length / items.length;

    // A different seed offset than the sampling above, so the human-review
    // subset isn't trivially correlated with which items got evaluated.
    const humanReviewSample = pickSeededSample(
      items.map((item) => item.qaPairId),
      Math.min(HUMAN_REVIEW_SAMPLE_SIZE, items.length),
      seed + 1,
    );

    return {
      holdoutDays: split.holdoutDays,
      cutoff: split.cutoff,
      corpusSpanDays: split.corpusSpanDays,
      trainRecordCount: split.trainRecords.length,
      heldOutRecordCount: split.heldOutRecords.length,
      heldOutPairCount: heldOutPairs.length,
      evaluatedCount: items.length,
      seed,
      meanSimilarity,
      wouldHaveSentRate,
      escalationRate,
      humanReviewSample,
      confirmedRuleCount: ruleSummary.confirmedCount,
      inconsistentRuleCount: ruleSummary.inconsistentCount,
      weakSignalRuleCount: ruleSummary.weakSignalCount,
      items,
    };
  } finally {
    deleteIfExists(evalStorePath);
    deleteIfExists(evalDuoDir);
  }
}
