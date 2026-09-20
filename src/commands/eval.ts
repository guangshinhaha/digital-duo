import type { DuoConfig } from "../config.js";
import { readRefusalsFile } from "../drafting/refusals.js";
import { scoreRelevanceGate, type GateEvalReport } from "../eval/gate-eval.js";
import { loadGateLabels } from "../eval/gate-labels.js";
import { fixtureSha256, loadJevMultiwayTasks } from "../eval/jev-fixtures.js";
import {
  persistStage1Report,
  runJevStage1Quality,
  sanitizeFailure,
  type JevStage1Report,
} from "../eval/jev-gate-eval.js";
import { runJevTimingPass, runOllamaReferenceSection, type JevReferenceSection, type JevTimingSection } from "../eval/jev-timing-eval.js";
import { runOfflineEval, type OfflineEvalOptions, type OfflineEvalReport } from "../eval/offline-eval.js";
import { createOllamaEmbeddingProvider } from "../provider/ollama-embedding-provider.js";
import { tryResolveProvider } from "../provider/registry.js";
import type { TypedDecisionProvider } from "../provider/types.js";
import { resolveOrCreatePassphrase } from "../store/passphrase.js";
import { requireStoreExists } from "../store/store.js";

/**
 * Implements `duo eval offline` (#35). Best-effort adjudication/labeling/
 * rule-phrasing, same "degrade rather than fail" shape as every other
 * derivation entry point (G1 is unresolved) — a run without a configured
 * provider still exercises the whole harness through draftReply's
 * deterministic extractive fallback.
 */
export async function runEvalOffline(
  config: DuoConfig,
  options: Pick<OfflineEvalOptions, "sampleSize" | "seed"> = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<OfflineEvalReport> {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);

  const provider = tryResolveProvider(config);
  const embeddingProvider = createOllamaEmbeddingProvider(config);

  return runOfflineEval(
    config.storePath,
    passphrase,
    config.duoDir,
    embeddingProvider,
    provider,
    config.confidence,
    config.eval.holdoutDays,
    options,
  );
}

/**
 * Implements `duo eval gate` (#36). Scores the real relevance gate
 * (classifyMention) against the checked-in hand-labelled set — no store
 * or provider needed at all, since the gate itself is a pure function and
 * the labels are a plain checked-in file. Deliberately doesn't assert the
 * precision floor itself: the caller (the CLI action) prints the full
 * report — including coverage (#36 AC3) — *before* deciding whether to
 * fail on it, so a floor violation still reports the label distribution
 * rather than only the error that aborted the run.
 */
export function runEvalGate(config: DuoConfig): GateEvalReport {
  const labels = loadGateLabels(config.eval.gateLabelsPath);
  const refusals = readRefusalsFile(config.duoDir);
  return scoreRelevanceGate(labels, refusals);
}

/**
 * Implements the Jev spike's `duo eval jev stage1` (plan U4): runs the
 * quality head-to-head and persists `stage1-report.json` under the
 * configured runtime dir — always, including on failure, because a failed
 * run's evidence must outlive the abort (KTD5/KTD6). Like runEvalGate,
 * this never asserts R5 itself: the CLI action prints the full report
 * first and only then decides whether to fail on it.
 *
 * The provider is injected rather than constructed here so the checked-in
 * suite runs this whole path offline through the fake; `src/cli.ts`
 * constructs the real adapter (and gets its ProviderConfigError) at the
 * process boundary.
 */
export async function runEvalJevStage1(
  config: DuoConfig,
  provider: TypedDecisionProvider,
): Promise<JevStage1Report> {
  const labels = loadGateLabels(config.eval.gateLabelsPath);
  const refusals = readRefusalsFile(config.duoDir);
  const tasks = loadJevMultiwayTasks(config.eval.jevMultiwayTasksPath);
  const gatewayOrigin = new URL(config.jev.gatewayUrl).origin;
  const fixtureHashes = {
    gateLabels: fixtureSha256(config.eval.gateLabelsPath),
    multiwayTasks: fixtureSha256(config.eval.jevMultiwayTasksPath),
  };

  try {
    let report = await runJevStage1Quality(provider, { labels, refusals, tasks, gatewayOrigin, fixtureHashes });

    // An earned R5 pass buys the timing/cost pass and the Ollama reference
    // (F1). A failure in either section marks only that section failed or
    // gapped — the quality verdict stands (KTD6); no timing code is
    // reachable from a run whose quality section failed or did not pass.
    if (report.quality.r5Passed) {
      let timing: JevTimingSection;
      try {
        timing = await runJevTimingPass(provider, tasks, config.jev.inputPricePerMTok);
      } catch (error) {
        timing = { status: "failed", failureSummary: sanitizeFailure(error) };
      }
      const reference: JevReferenceSection = await runOllamaReferenceSection(config, labels, tasks);
      report = { ...report, timing, reference };
    }

    persistStage1Report(config.jev.runtimeDir, report);
    return report;
  } catch (error) {
    persistStage1Report(config.jev.runtimeDir, {
      generatedAt: new Date().toISOString(),
      gatewayOrigin,
      fixtureHashes,
      refusalsLoaded: refusals.length,
      baseline: scoreRelevanceGate(labels, [...refusals]),
      quality: { status: "failed", failureSummary: sanitizeFailure(error) },
    });
    throw error;
  }
}
