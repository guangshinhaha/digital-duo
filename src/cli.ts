#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { loadConfig } from "./config.js";
import {
  runActionsAttempts,
  runActionsDiscard,
  runActionsList,
  runActionsListDiscards,
  runActionsListPrepared,
  runActionsPrepare,
  runActionsRegister,
  runActionsT4Confirm,
  runActionsT4Pending,
  runActionsT4Request,
} from "./commands/actions.js";
import { PREPARED_ARTIFACT_KINDS } from "./actions/preparation.js";
import { runAsk } from "./commands/ask.js";
import { runDerivePairs, runDeriveRules, runDeriveSync, runDeriveTopics, runDeriveVoice } from "./commands/derive.js";
import { runDraft, runRecordDraftOutcome, runRecordEscalationAnswer } from "./commands/draft.js";
import { HELD_OUT_CAVEAT, type CalibrationItem } from "./derivation/calibration.js";
import { DRAFT_OUTCOMES } from "./drafting/draft-log.js";
import { runEmbed } from "./commands/embed.js";
import { runEvalOffline } from "./commands/eval.js";
import { WOULD_HAVE_SENT_CAVEAT } from "./eval/offline-eval.js";
import { runImportClaude, runImportPaste } from "./commands/import.js";
import { runInit } from "./commands/init.js";
import {
  runMirrorCalibrateJudge,
  runMirrorCalibrateProgress,
  runMirrorCalibrateStart,
  runMirrorCalibrateSummary,
  runMirrorPortrait,
  runMirrorRefusalAdd,
  runMirrorRefusalConfirmNone,
  runMirrorRefusalsList,
  runMirrorRuleApprove,
  runMirrorRuleConflicts,
  runMirrorRulePromote,
  runMirrorRuleReject,
  runMirrorRuleShow,
  runMirrorRuleWrite,
  runMirrorRulesList,
  type CalibrationProgress,
} from "./commands/mirror.js";
import { runCorrectionsApprove, runCorrectionsReject, runCorrectionsReview } from "./commands/corrections.js";
import { runAskAsAsker, runEnforceCeiling, runListAuditEntries, runShowAuditEntry } from "./commands/permissions.js";
import { runPurge } from "./commands/purge.js";
import { runSearch } from "./commands/search.js";
import { runSharedAsk, runSharedGaps, runSharedUsage } from "./commands/shared.js";
import { runStatus } from "./commands/status.js";
import { runTrustCorrect, runTrustGrant, runTrustGrid, runTrustLedger, runTrustPromote, runTrustPromotions } from "./commands/trust.js";

const program = new Command();

program.name("duo").description("Digital Duo CLI").version("0.1.0");

/** Formats an unknown thrown value to stderr and sets a non-zero exit code. */
function reportError(error: unknown): void {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

program
  .command("status")
  .description("Print the configured provider, store location, and whether the store exists")
  .action(() => {
    const config = loadConfig();
    console.log(runStatus(config));
  });

program
  .command("init")
  .description("Create the encrypted local store if one doesn't already exist, and report its path")
  .action(() => {
    const config = loadConfig();
    try {
      const result = runInit(config);
      console.log(
        result.created
          ? `Created encrypted store at ${result.storePath}`
          : `Store already exists at ${result.storePath}`,
      );
    } catch (error) {
      reportError(error);
    }
  });

program
  .command("purge")
  .description("Delete the local store and every derived artifact. Destructive; requires --yes")
  .option("--yes", "confirm deletion")
  .action((options: { yes?: boolean }) => {
    const config = loadConfig();
    try {
      const result = runPurge(config, Boolean(options.yes));
      if (result.paths.length === 0) {
        console.log(`Nothing to purge: no store exists at ${result.dataDir}`);
        return;
      }
      if (!result.confirmed) {
        console.log(
          [
            `Would delete ${result.paths.length} file(s) under ${result.dataDir}:`,
            ...result.paths.map((path) => `  ${path}`),
            "Re-run with --yes to confirm. Nothing has been deleted.",
          ].join("\n"),
        );
        process.exitCode = 1;
        return;
      }
      console.log(`Purged ${result.paths.length} file(s) under ${result.dataDir}. Nothing recoverable remains.`);
    } catch (error) {
      reportError(error);
    }
  });

// The retention boundary, stated in the same words told to the team
// (v1-tech-design.md §1.4): we keep questions put to you, we discard
// everything else others said.
const importCommand = program
  .command("import")
  .description(
    "Import records from a source into the store. Retention boundary: we keep questions put to you, we discard everything else others said.",
  );

importCommand
  .command("claude")
  .description("Import a Claude data export (conversations.json) into the store")
  .argument("<path>", "path to the Claude export JSON file")
  .action((path: string) => {
    const config = loadConfig();
    try {
      const summary = runImportClaude(path, config);
      console.log(
        `Imported ${summary.written} record(s) (${summary.skipped} already present, ` +
          `${summary.discardedAboveCeiling} above the classification ceiling) from ` +
          `${summary.workRelevantConversationCount}/${summary.conversationCount} work-relevant conversation(s).`,
      );
    } catch (error) {
      reportError(error);
    }
  });

importCommand
  .command("paste")
  .description("Import a pasted conversation transcript (a text file of Human:/Assistant: lines) into the store")
  .argument("<path>", "path to a text file containing the pasted transcript")
  .action((path: string) => {
    const config = loadConfig();
    try {
      const summary = runImportPaste(path, config);
      if (!summary.workRelevant) {
        console.log("Transcript judged not work-relevant; nothing imported.");
        return;
      }
      console.log(
        `Imported ${summary.written} record(s) (${summary.skipped} already present, ` +
          `${summary.discardedAboveCeiling} above the classification ceiling).`,
      );
    } catch (error) {
      reportError(error);
    }
  });

program
  .command("embed")
  .description("Compute local Ollama embeddings for every record that doesn't have a current one")
  .action(async () => {
    const config = loadConfig();
    try {
      const result = await runEmbed(config);
      console.log(`Embedded ${result.embedded} record(s) (${result.total} total in the store).`);
    } catch (error) {
      reportError(error);
    }
  });

program
  .command("search")
  .description("Hybrid full-text + embedding search over the store")
  .argument("<query>", "the search query")
  .action(async (query: string) => {
    const config = loadConfig();
    try {
      const outcome = await runSearch(query, config);
      if (outcome.warning) {
        console.error(outcome.warning);
      }
      if (outcome.results.length === 0) {
        console.log("No matching records.");
        return;
      }
      for (const { record } of outcome.results) {
        console.log(`[${record.id.slice(0, 8)}] (${record.author}) ${record.text}`);
      }
    } catch (error) {
      reportError(error);
    }
  });

// The derivation pipeline (v1-tech-design.md §1.5): pair extraction, topic
// assignment, rule induction, and voice/sync land here across #23-#26.
const deriveCommand = program.command("derive").description("Run a stage of the derivation pipeline over the store");

deriveCommand
  .command("pairs")
  .description("Extract question/answer pairs from threads in the store")
  .action(async () => {
    const config = loadConfig();
    try {
      const summary = await runDerivePairs(config);
      console.log(
        `Extracted ${summary.pairs.length} pair(s) (${summary.written} new, ${summary.alreadyPresent} already present); ` +
          `${summary.unansweredCount} unanswered question(s), ${summary.ambiguousCount} ambiguous ` +
          `(${summary.adjudicatedCount} resolved by adjudication).`,
      );
    } catch (error) {
      reportError(error);
    }
  });

deriveCommand
  .command("topics")
  .description("Assign qa_pairs to stable topic ids, clustering by question embedding and matching against duo/topics.json")
  .action(async () => {
    const config = loadConfig();
    try {
      const result = await runDeriveTopics(config);
      console.log(
        `Assigned ${result.assignedPairs} pair(s): ${result.matchedTopicIds.length} matched existing topic(s), ` +
          `${result.newTopics.length} new topic(s) minted for review.`,
      );
      for (const topic of result.newTopics) {
        console.log(`  new: [${topic.id}] ${topic.label}`);
      }
    } catch (error) {
      reportError(error);
    }
  });

deriveCommand
  .command("rules")
  .description("Induce one rule per topic from its qa_pairs, with citations and a support/consistency filter")
  .action(async () => {
    const config = loadConfig();
    try {
      const result = await runDeriveRules(config);
      console.log(
        `Induced ${result.rules.length} rule(s): ${result.confirmedCount} confirmed, ` +
          `${result.inconsistentCount} inconsistent, ${result.weakSignalCount} weak signal.`,
      );
    } catch (error) {
      reportError(error);
    }
  });

deriveCommand
  .command("sync")
  .description("Reconcile duo/rules/*.md with the store: hand-edits to the files win")
  .action(() => {
    const config = loadConfig();
    try {
      const result = runDeriveSync(config);
      console.log(
        `Synced ${result.synced.length} rule file(s), removed ${result.deleted.length} deleted rule(s) from the store.`,
      );
      for (const problem of result.malformed) {
        console.error(`  malformed, left in place: ${problem.file} — ${problem.reason}`);
      }
    } catch (error) {
      reportError(error);
    }
  });

deriveCommand
  .command("voice")
  .description("Compute the voice profile and write duo/voice.md")
  .option("--force", "overwrite an existing duo/voice.md")
  .action(async (options: { force?: boolean }) => {
    const config = loadConfig();
    try {
      const result = await runDeriveVoice(config, Boolean(options.force));
      console.log(
        result.written
          ? `Wrote duo/voice.md from ${result.stats.sampleSize} sample(s).`
          : "duo/voice.md already exists; re-run with --force to overwrite it.",
      );
    } catch (error) {
      reportError(error);
    }
  });

// The permission model (docs/concept.md §5, epic e10): classification
// capture/ceiling enforcement lands with #48; asker resolution, permission-
// scoped answering, and the audit log land across #49-#51.
const permissionsCommand = program.command("permissions").description("Classification, asker permissions, and the audit log");

permissionsCommand
  .command("enforce-ceiling")
  .description("Re-evaluate the store against the currently configured classification ceiling, removing anything above it")
  .action(() => {
    const config = loadConfig();
    try {
      const result = runEnforceCeiling(config);
      console.log(
        result.removed === 0
          ? "No records sit above the configured ceiling; nothing removed."
          : `Removed ${result.removed} record(s) above the configured ceiling.`,
      );
    } catch (error) {
      reportError(error);
    }
  });

permissionsCommand
  .command("ask")
  .description("Answer a question as a specific asker, filtered to what they may see, and log it to the audit trail")
  .argument("<question>", "the question to answer")
  .requiredOption("--as <askerId>", "the asker's identity, resolved against duo/directory.json")
  .action(async (question: string, options: { as: string }) => {
    const config = loadConfig();
    try {
      const result = await runAskAsAsker(question, options.as, config);
      if (result.warning) {
        console.error(result.warning);
      }
      console.log(result.answer);
      if (result.declined) {
        console.error("(declined — nothing visible to this asker informed this answer)");
      }
    } catch (error) {
      reportError(error);
    }
  });

permissionsCommand
  .command("audit")
  .description(
    "List every audit log entry (oldest first), or show one entry in full with --id — every answer, given or declined, is reconstructible (#51)",
  )
  .option("--id <id>", "show one entry's full reconstruction (question, asker, records, confidence, ceiling, exact text sent)")
  .action((options: { id?: string }) => {
    const config = loadConfig();
    try {
      if (options.id) {
        const entry = runShowAuditEntry(options.id, config);
        if (!entry) {
          console.error(`No audit entry with id "${options.id}"`);
          process.exitCode = 1;
          return;
        }
        console.log(JSON.stringify(entry, null, 2));
        return;
      }
      const entries = runListAuditEntries(config);
      if (entries.length === 0) {
        console.log("No audit entries yet.");
        return;
      }
      for (const entry of entries) {
        console.log(
          `[${entry.id}] ${entry.createdAt} asker=${entry.askerRef} clearance=${entry.clearanceApplied} ` +
            `confidence=${entry.confidence} declined=${entry.declined} question="${entry.question}"`,
        );
      }
    } catch (error) {
      reportError(error);
    }
  });

/** Reads piped stdin as thread context (#32 AC4: "the owner pipes the thread in"). Returns null when stdin is a TTY (nothing piped) or empty, so a plain interactive `duo draft <question>` never blocks waiting for input that was never coming. */
function readPipedThreadContext(): string | null {
  if (process.stdin.isTTY) {
    return null;
  }
  try {
    const content = readFileSync(0, "utf8").trim();
    return content.length > 0 ? content : null;
  } catch {
    return null;
  }
}

// The owner's own draft pipeline (docs/v1-tech-design.md §1.7, epic e5):
// a CLI surface that closes the correction loop before any Slack app is
// approved (AR-4 — gov workspaces commonly restrict installs hard).
program
  .command("draft")
  .description("Draft a reply to a question, in your own voice, citing the standing orders and past exchanges it drew on")
  .argument("<question>", "the question to draft a reply to")
  .action(async (question: string) => {
    const config = loadConfig();
    const threadContext = readPipedThreadContext();
    try {
      const result = await runDraft(question, threadContext, config);
      if (result.kind === "escalation") {
        console.log(result.reason);
        console.error(
          result.refused
            ? `(escalated, refused — draft id ${result.draftId})`
            : `(escalated — draft id ${result.draftId}; run duo draft-answer ${result.draftId} <answer> to record it as a standing-order candidate)`,
        );
        return;
      }
      console.log(result.text);
      console.log("");
      console.log(`Confidence: ${result.confidence.score.toFixed(2)} (draft id ${result.draftId})`);
      if (result.sources.length > 0) {
        console.log("Drew on:");
        for (const source of result.sources) {
          console.log(`  [${source.kind}:${source.id}] ${source.label}`);
        }
      }
    } catch (error) {
      reportError(error);
    }
  });

program
  .command("draft-outcome")
  .description(
    "Record what happened to a draft — sent, edited, or discarded — for the correction loop and the eval. " +
      "For \"edited\", pass the text you actually sent to also classify the edit and queue a correction candidate (#37)",
  )
  .argument("<draftId>", "the draft id printed by `duo draft`")
  .argument("<outcome>", `one of: ${DRAFT_OUTCOMES.join(", ")}`)
  .argument("[sentText]", "the text actually sent — required to classify an \"edited\" outcome, ignored otherwise")
  .action(async (draftId: string, outcome: string, sentText: string | undefined) => {
    const config = loadConfig();
    if (!DRAFT_OUTCOMES.includes(outcome as (typeof DRAFT_OUTCOMES)[number])) {
      reportError(new Error(`outcome must be one of: ${DRAFT_OUTCOMES.join(", ")}`));
      return;
    }
    try {
      const result = await runRecordDraftOutcome(draftId, outcome as (typeof DRAFT_OUTCOMES)[number], config, sentText);
      console.log(`Recorded draft ${draftId} as ${outcome}.`);
      if (result) {
        console.log(
          result.classification === "trivial"
            ? "Edit judged trivial (whitespace/typo-level) — nothing queued."
            : `Edit classified as "${result.classification}"; queued: ${result.queuedKinds.length > 0 ? result.queuedKinds.join(", ") : "nothing new (already queued or previously rejected)"}.`,
        );
      }
    } catch (error) {
      reportError(error);
    }
  });

// #34 AC3: an escalation the owner knows the answer to becomes a queued
// standing-order candidate, entering the same batched review any other
// correction will (v1-tech-design.md §1.9, epic e7 — not yet built; this
// is the table it will read from).
program
  .command("draft-answer")
  .description("Answer an escalated draft yourself, queuing a standing-order candidate for later batched review")
  .argument("<draftId>", "the escalated draft's id, printed by `duo draft`")
  .argument("<answer>", "your answer to the question that was escalated")
  .action((draftId: string, answer: string) => {
    const config = loadConfig();
    try {
      const candidateId = runRecordEscalationAnswer(draftId, answer, config);
      console.log(`Queued standing-order candidate ${candidateId} from draft ${draftId}. It will be reviewed in the next batch.`);
    } catch (error) {
      reportError(error);
    }
  });

// The correction loop's batched review (docs/v1-tech-design.md §1.9, epic
// e7, AR-9): everything #37 (an edited draft) and #34 (an answered
// escalation) have queued, reviewed together rather than one ping per edit.
const correctionsCommand = program
  .command("corrections")
  .description("Review what the correction loop has queued since the last review, and approve or reject it (#38)");

correctionsCommand
  .command("review")
  .description(
    "List every pending correction candidate, flagging any substance candidate that conflicts with an active rule (#38 AC1/AC4). " +
      "Prints nothing at all when the queue is empty (#38 AC3)",
  )
  .action(() => {
    const config = loadConfig();
    try {
      const review = runCorrectionsReview(config);
      if (review.candidates.length === 0) {
        return;
      }
      for (const candidate of review.candidates) {
        console.log(`[${candidate.id}] (${candidate.kind}, from ${candidate.source}) ${candidate.question}`);
        if (candidate.draftText !== null) {
          console.log(`  draft: ${candidate.draftText}`);
        }
        console.log(`  ${candidate.kind === "style" ? "sent" : "proposed"}: ${candidate.proposedText}`);
      }
      if (review.conflicts.length > 0) {
        console.log("");
        console.log(`Conflicts with an active rule (${review.conflicts.length}) — resolve before approving:`);
        for (const { candidate, conflictingRule } of review.conflicts) {
          console.log(`  [${candidate.id}] proposes: "${candidate.proposedText}"`);
          console.log(`  [${conflictingRule.id}] active rule says: "${conflictingRule.text}"`);
        }
      }
    } catch (error) {
      reportError(error);
    }
  });

correctionsCommand
  .command("approve")
  .description("Approve a pending candidate: writes to duo/rules/ (substance) or duo/voice.md (style), then marks it approved (#38 AC1)")
  .argument("<id>", "the candidate's id, from `duo corrections review`")
  .action((id: string) => {
    const config = loadConfig();
    try {
      const result = runCorrectionsApprove(id, config);
      console.log(
        result.kind === "style"
          ? `Approved — appended to ${config.duoDir}/voice.md.`
          : `Approved — wrote rule [${result.rule?.id}] to ${config.duoDir}/rules/${result.rule?.id}.md.`,
      );
    } catch (error) {
      reportError(error);
    }
  });

correctionsCommand
  .command("reject")
  .description("Reject a pending candidate; it is never re-proposed unchanged (#38 AC2)")
  .argument("<id>", "the candidate's id, from `duo corrections review`")
  .action((id: string) => {
    const config = loadConfig();
    try {
      runCorrectionsReject(id, config);
      console.log(`Rejected [${id}].`);
    } catch (error) {
      reportError(error);
    }
  });

// The team's one shared duo (concept.md §12, epic e64): document-grounded,
// no personal corpus, no code path that writes its persona file. #67/#68
// shipped the definition/grounding; #69 is the first thing anyone can
// actually ask it.
const sharedCommand = program
  .command("shared")
  .description("The team's one shared duo — grounded in shared-duo/persona.json's published material only");

sharedCommand
  .command("ask")
  .description(
    "Ask the shared duo a question. Answers cite the configured published material and its date; " +
      "an out-of-scope question is declined and named to the owner to escalate to",
  )
  .argument("<question>", "the question to ask")
  .option("--as <askerId>", "who is asking (recorded for the usage report only — a shared duo does no per-asker permissioning; defaults to \"anonymous\")")
  .action(async (question: string, options: { as?: string }) => {
    try {
      const result = await runSharedAsk(question, options.as);
      console.log(result.text);
      if (result.declineReason === "not_a_decision_maker") {
        console.error("(declined — this isn't something the shared duo can decide; passed on to its owner)");
      } else if (result.declined) {
        console.error("(declined — outside the shared duo's configured material; passed on to its owner)");
      }
    } catch (error) {
      reportError(error);
    }
  });

sharedCommand
  .command("gaps")
  .description("List out-of-scope questions the shared duo has been asked, most-repeated first — the gaps in its material (#69 AC4)")
  .action(() => {
    try {
      const gaps = runSharedGaps();
      if (gaps.length === 0) {
        console.log("No out-of-scope questions recorded yet.");
        return;
      }
      for (const gap of gaps) {
        console.log(`${gap.count}x  ${gap.question}`);
      }
    } catch (error) {
      reportError(error);
    }
  });

sharedCommand
  .command("usage")
  .description(
    "Report whether the shared duo is actually being used: questions, distinct/repeat askers, " +
      "answer/escalation rate, the weekly trend, and unanswerable-question gaps (#71) — a bad answer is allowed",
  )
  .action(() => {
    try {
      const report = runSharedUsage();
      console.log(report.summary);
      if (report.totalQuestions === 0) {
        return;
      }
      console.log(`Total questions: ${report.totalQuestions}`);
      console.log(`Distinct askers: ${report.distinctAskers} (${report.repeatAskers} asked more than once)`);
      console.log(
        `Answer rate: ${(report.answerRate * 100).toFixed(0)}% · Escalation rate: ${(report.escalationRate * 100).toFixed(0)}%`,
      );
      console.log("Weekly trend:");
      for (const week of report.weeklyTrend) {
        console.log(`  ${week.weekStart}: ${week.questionCount}`);
      }
      if (report.gaps.length === 0) {
        console.log("No repeated out-of-scope questions.");
      } else {
        console.log("Out-of-scope gaps (most repeated first):");
        for (const gap of report.gaps) {
          console.log(`  ${gap.count}x  ${gap.question}`);
        }
      }
    } catch (error) {
      reportError(error);
    }
  });

// The trust grid (docs/concept.md §6, epic e11): autonomy granted per
// (topic × tier), never globally. #52 shipped the grid model itself; #53
// is the first way an owner can move a cell — a written, plain-English
// grant, refused outright if it would exceed a standing duo/refusals.md
// entry.
const trustCommand = program.command("trust").description("The autonomy grid: per-topic, per-tier trust, earned or granted");

trustCommand
  .command("grid")
  .description("List every touched cell: its current level, and whether it was earned or granted")
  .action(() => {
    const config = loadConfig();
    try {
      const rows = runTrustGrid(config);
      if (rows.length === 0) {
        console.log("No cell has moved yet — every topic is still at the default 'ask'.");
        return;
      }
      for (const row of rows) {
        const label = row.stale ? "(stale — topic no longer exists)" : row.topicLabel ?? row.topicId;
        console.log(`[${row.topicId}] ${row.tier}  ${row.level} (${row.source})  ${label}`);
      }
    } catch (error) {
      reportError(error);
    }
  });

trustCommand
  .command("grant")
  .description(
    "Grant autonomy on a topic in plain words. Applies immediately unless the scope is ambiguous " +
      "(re-run with --topic once you see the candidates) or it conflicts with duo/refusals.md",
  )
  .argument("<scopeText>", "plain-English description of what's being granted, e.g. \"deploy access questions\"")
  .requiredOption("--tier <tier>", "T0, T1, T2, or T3")
  .option("--topic <topicId>", "grant exactly this topic id, skipping matching entirely (how an ambiguous match is confirmed)")
  .action((scopeText: string, options: { tier: string; topic?: string }) => {
    const config = loadConfig();
    try {
      const outcome = runTrustGrant(scopeText, { tier: options.tier, topicId: options.topic }, config);
      switch (outcome.status) {
        case "applied":
          console.log(`Granted ${outcome.tier} autonomy on "${outcome.topicLabel}" (${outcome.topicId}). It acts on its own from here.`);
          break;
        case "ambiguous":
          console.log("That could refer to more than one topic. Re-run with --topic to confirm which one:");
          for (const candidate of outcome.candidates) {
            console.log(`  [${candidate.topicId}] ${candidate.label}`);
          }
          process.exitCode = 1;
          break;
        case "no_match":
          console.log("No topic matched that description. Check duo/topics.json, or pass --topic directly.");
          process.exitCode = 1;
          break;
        case "topic_not_found":
          console.error(`No topic with id "${outcome.topicId}" in duo/topics.json.`);
          process.exitCode = 1;
          break;
        case "refused":
          console.error(`Refused: "${outcome.refusal.heading}" is a standing refusal. ${outcome.refusal.reason}`);
          process.exitCode = 1;
          break;
      }
    } catch (error) {
      reportError(error);
    }
  });

trustCommand
  .command("promotions")
  .description("List every cell currently offered a promotion, with the evidence behind it — the batched digest (#54), never individual pings")
  .action(() => {
    const config = loadConfig();
    try {
      const offers = runTrustPromotions(config);
      if (offers.length === 0) {
        console.log("No promotion offers pending.");
        return;
      }
      for (const offer of offers) {
        console.log(
          `[${offer.topicId}] ${offer.tier}  ${offer.currentLevel} -> ${offer.offeredLevel}  ` +
            `(${offer.cleanStreak} clean instance(s))  ${offer.topicLabel ?? "(unlabeled)"}`,
        );
      }
    } catch (error) {
      reportError(error);
    }
  });

trustCommand
  .command("promote")
  .description("Accept or decline a pending promotion offer for one cell — nothing promotes without this explicit call (#54 AC3)")
  .argument("<topicId>", "the topic id, as shown by `duo trust promotions`")
  .argument("<tier>", "T0, T1, T2, or T3")
  .option("--accept", "accept the offer: the cell moves up one level")
  .option("--decline", "decline the offer: the cell stays, and re-offering waits for a materially higher bar (#54 AC2)")
  .action((topicId: string, tier: string, options: { accept?: boolean; decline?: boolean }) => {
    const config = loadConfig();
    try {
      if (Boolean(options.accept) === Boolean(options.decline)) {
        console.error("Specify exactly one of --accept or --decline.");
        process.exitCode = 1;
        return;
      }
      const decision = options.accept ? "accept" : "decline";
      const cell = runTrustPromote(topicId, tier, decision, config);
      console.log(
        decision === "accept"
          ? `Promoted [${topicId}] ${tier} to ${cell.level}.`
          : `Declined. [${topicId}] ${tier} stays at ${cell.level}; it won't be offered again until well past this point.`,
      );
    } catch (error) {
      reportError(error);
    }
  });

trustCommand
  .command("correct")
  .description("Record a correction on a cell: it demotes at once, restarting its promotion counter (#55 AC1/AC3)")
  .argument("<topicId>", "the topic id the corrected answer was about")
  .argument("<tier>", "T0, T1, T2, or T3")
  .requiredOption("--reason <text>", "what was corrected — an audit-log entry id, or a plain description; recorded in the trust ledger")
  .action((topicId: string, tier: string, options: { reason: string }) => {
    const config = loadConfig();
    try {
      const result = runTrustCorrect(topicId, tier, options.reason, config);
      console.log(
        result.demoted
          ? `Demoted [${result.topicId}] ${result.tier}: ${result.fromLevel} -> ${result.toLevel}. It'll check first next time and say why.`
          : `[${result.topicId}] ${result.tier} was already at the floor ("ask") — nothing lower to drop to, but the correction is recorded.`,
      );
    } catch (error) {
      reportError(error);
    }
  });

trustCommand
  .command("ledger")
  .description("List every trust event ever recorded (grants, instances, promotions, demotions), or narrow to one cell")
  .option("--topic <topicId>", "narrow to one topic (requires --tier too)")
  .option("--tier <tier>", "narrow to one tier (requires --topic too)")
  .action((options: { topic?: string; tier?: string }) => {
    const config = loadConfig();
    try {
      const entries = runTrustLedger(config, options);
      if (entries.length === 0) {
        console.log("No trust events recorded yet.");
        return;
      }
      for (const entry of entries) {
        console.log(`[${entry.id}] ${entry.createdAt} ${entry.topicId} ${entry.tier} ${entry.eventType} ${JSON.stringify(entry.detail)}`);
      }
    } catch (error) {
      reportError(error);
    }
  });

// The Mirror (docs/concept.md §7, epic e4): the owner's own onboarding and
// review surface over #23-#26's derived output. #27 ships the opening
// portrait; later issues in this epic add rule review, refusals, and
// calibration.
const mirrorCommand = program.command("mirror").description("Review and approve what your duo has learned about you");

const PORTRAIT_BAR_WIDTH = 24;

/** A proportional bar with a floor of one character for anything nonzero — AC3: a small topic must stay visible, never collapse to an invisible sliver next to a dominant one. */
function renderBar(share: number): string {
  const width = Math.max(1, Math.round(share * PORTRAIT_BAR_WIDTH));
  return "#".repeat(Math.min(width, PORTRAIT_BAR_WIDTH));
}

function formatPercent(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

mirrorCommand
  .command("portrait")
  .description("Show the interruption portrait: volume, topic distribution, busiest threads, and the period covered")
  .action(() => {
    const config = loadConfig();
    try {
      const portrait = runMirrorPortrait(config);
      if (portrait.tooThin) {
        console.log(
          `Not enough history to characterise yet: found only ${portrait.totalQuestions} question(s) ` +
            `(want at least ${portrait.minimumQuestionsToCharacterize}). Import another source with ` +
            `\`duo import claude\` or \`duo import paste\`, then run \`duo derive pairs\` and \`duo derive topics\` again.`,
        );
        return;
      }
      console.log(`${portrait.totalQuestions} question(s) put to you, from ${portrait.periodStart} to ${portrait.periodEnd}.`);
      console.log(`Top 5 topics hold ${formatPercent(portrait.topFiveShare)} of all questions.`);
      console.log("");
      console.log("Topics (most-asked first):");
      for (const topic of portrait.topicBreakdown) {
        console.log(`  ${renderBar(topic.share).padEnd(PORTRAIT_BAR_WIDTH)} ${formatPercent(topic.share).padStart(6)} (${topic.count})  ${topic.label}`);
      }
      console.log("");
      console.log("Busiest threads (no per-person asker identity yet — grouped by conversation thread):");
      for (const thread of portrait.busiestThreads) {
        console.log(`  ${formatPercent(thread.share).padStart(6)} (${thread.count})  ${thread.threadId}`);
      }
    } catch (error) {
      reportError(error);
    }
  });

const rulesCommand = mirrorCommand
  .command("rules")
  .description("Review the standing orders derived from your history (#28)");

function renderRuleLine(rule: { id: string; text: string; status: string; supportCount: number; consistency: number }): string {
  return `  [${rule.id}] (${rule.status}, support=${rule.supportCount}, consistency=${rule.consistency.toFixed(2)}) ${rule.text}`;
}

rulesCommand
  .command("list")
  .description("List rules awaiting review, weak signals, and inconsistent topics")
  .action(() => {
    const config = loadConfig();
    try {
      const listing = runMirrorRulesList(config);
      if (listing.awaitingApproval.length === 0) {
        console.log(
          "No rule has cleared the confirmation threshold (≥3 consistent pairs) yet — nothing is awaiting approval.",
        );
      } else {
        console.log(`Awaiting your approval (${listing.awaitingApproval.length}):`);
        listing.awaitingApproval.forEach((rule) => console.log(renderRuleLine(rule)));
      }
      console.log("");
      console.log(
        listing.weakSignals.length === 0
          ? "No weak signals below threshold."
          : `Weak signals below threshold, promotable by hand (${listing.weakSignals.length}):`,
      );
      listing.weakSignals.forEach((rule) => console.log(renderRuleLine(rule)));
      if (listing.inconsistent.length > 0) {
        console.log("");
        console.log(`Inconsistent — conflicting answers, no confident rule (${listing.inconsistent.length}):`);
        listing.inconsistent.forEach((rule) => console.log(renderRuleLine(rule)));
      }
      if (listing.awaitingApproval.length === 0 && listing.weakSignals.length === 0 && listing.inconsistent.length === 0) {
        console.log(
          "No rules were derived at all yet. Write one by hand with `duo mirror rules write --label <topic> --text <rule text>`.",
        );
      }
      if (listing.approved.length > 0 || listing.rejected.length > 0) {
        console.log("");
        console.log(`Already reviewed: ${listing.approved.length} approved, ${listing.rejected.length} rejected.`);
      }
      // #29 AC3: "the refusal wins ... the conflict is surfaced to the
      // owner" — an approved rule a later refusal now suppresses.
      const conflicts = runMirrorRuleConflicts(config);
      if (conflicts.length > 0) {
        console.log("");
        console.log(`Suppressed by a standing refusal (${conflicts.length}) — approved, but not active:`);
        for (const { rule, refusal } of conflicts) {
          console.log(`  [${rule.id}] conflicts with refusal "${refusal.heading}": ${refusal.reason}`);
        }
      }
    } catch (error) {
      reportError(error);
    }
  });

rulesCommand
  .command("show")
  .description("Show a rule and the exchanges its citations point to")
  .argument("<ruleId>", "the rule's id")
  .action((ruleId: string) => {
    const config = loadConfig();
    try {
      const { rule, evidence } = runMirrorRuleShow(ruleId, config);
      console.log(renderRuleLine(rule));
      console.log(`review: ${rule.reviewStatus} · origin: ${rule.origin}`);
      console.log("");
      console.log(evidence.length === 0 ? "No cited exchanges." : "Cited exchanges:");
      for (const exchange of evidence) {
        console.log(`  Q: ${exchange.questionText ?? "(record no longer available)"}`);
        console.log(`  A: ${exchange.answerText ?? "(record no longer available)"}`);
        console.log("");
      }
    } catch (error) {
      reportError(error);
    }
  });

rulesCommand
  .command("approve")
  .description("Approve a confirmed rule, making it active (#28 AC1)")
  .argument("<ruleId>", "the rule's id")
  .action((ruleId: string) => {
    const config = loadConfig();
    try {
      const rule = runMirrorRuleApprove(ruleId, config);
      console.log(`Approved [${rule.id}]: ${rule.text}`);
    } catch (error) {
      reportError(error);
    }
  });

rulesCommand
  .command("reject")
  .description("Reject a rule; it becomes inactive and is never re-proposed unchanged (#28 AC2)")
  .argument("<ruleId>", "the rule's id")
  .action((ruleId: string) => {
    const config = loadConfig();
    try {
      const rule = runMirrorRuleReject(ruleId, config);
      console.log(`Rejected [${rule.id}].`);
    } catch (error) {
      reportError(error);
    }
  });

rulesCommand
  .command("promote")
  .description("Promote a below-threshold weak signal to an active, owner-asserted rule (#28 AC3)")
  .argument("<ruleId>", "the rule's id")
  .action((ruleId: string) => {
    const config = loadConfig();
    try {
      const rule = runMirrorRulePromote(ruleId, config);
      console.log(`Promoted [${rule.id}] (owner-asserted): ${rule.text}`);
    } catch (error) {
      reportError(error);
    }
  });

rulesCommand
  .command("write")
  .description("Write a new rule by hand when nothing was derived (#28 AC4)")
  .requiredOption("--label <label>", "a short topic label for the new rule")
  .requiredOption("--text <text>", "the rule's text, in your own words")
  .action((options: { label: string; text: string }) => {
    const config = loadConfig();
    try {
      const rule = runMirrorRuleWrite(options.label, options.text, config);
      console.log(`Wrote [${rule.id}] (owner-asserted, approved): ${rule.text}`);
    } catch (error) {
      reportError(error);
    }
  });

// The one part of the Mirror deliberately not derived (#29,
// docs/concept.md §10): subjects this duo must never speak for the owner
// on. No store needed — this is pure duo/refusals.md file state, same as
// duo/topics.json/voice.md's own commands.
const refusalsCommand = mirrorCommand
  .command("refusals")
  .description("Record what your duo must never speak for you on (#29)");

refusalsCommand
  .command("list")
  .description("Show recorded refusals, or that none have been decided on yet")
  .action(() => {
    const config = loadConfig();
    try {
      const { decided, refusals } = runMirrorRefusalsList(config);
      if (!decided) {
        console.log(
          "No decision about refusals has been recorded yet. This is asked once, explicitly — record at least one " +
            'with `duo mirror refusals add "<subject>" "<reason>"`, or confirm there truly are none with ' +
            "`duo mirror refusals confirm-none`.",
        );
        return;
      }
      if (refusals.length === 0) {
        console.log("Reviewed: the owner has deliberately recorded no refusals.");
        return;
      }
      console.log(`${refusals.length} refusal(s) recorded:`);
      for (const refusal of refusals) {
        console.log(`  ## ${refusal.heading}`);
        console.log(`     ${refusal.reason}`);
      }
    } catch (error) {
      reportError(error);
    }
  });

refusalsCommand
  .command("add")
  .description("Record (or edit) a refusal — a subject your duo must never speak for you on, and why (#29 AC1)")
  .argument("<heading>", "the subject refused (matched against a topic's label or id — #29 AC3)")
  .argument("<reason>", "why, shown back whenever this refusal blocks something")
  .action((heading: string, reason: string) => {
    const config = loadConfig();
    try {
      const refusals = runMirrorRefusalAdd(heading, reason, config);
      console.log(`Recorded ${refusals.length} refusal(s). Written to ${config.duoDir}/refusals.md.`);
    } catch (error) {
      reportError(error);
    }
  });

refusalsCommand
  .command("confirm-none")
  .description("Deliberately record that there are no refusals — a real, recorded choice, not an empty file by default (#29 AC2)")
  .action(() => {
    const config = loadConfig();
    try {
      runMirrorRefusalConfirmNone(config);
      console.log(`Recorded: no refusals. Written to ${config.duoDir}/refusals.md.`);
    } catch (error) {
      reportError(error);
    }
  });

// Calibration (#30, docs/concept.md §7 step 4): the Mirror's last screen —
// comparing the duo's real draft pipeline (#32's draftReply) against a
// dozen of the owner's own past answers, and deciding whether to keep
// going. Gated behind #29's requireRefusalsDecision ("finish onboarding").
const calibrateCommand = mirrorCommand
  .command("calibrate")
  .description("Compare the duo's proposed answers against your real past ones on a handful of held-out questions (#30)");

function renderCalibrationItem(item: CalibrationItem): void {
  console.log(`Next: [${item.qaPairId}]`);
  console.log(`  Question:              ${item.questionText}`);
  console.log(`  Your real answer:      ${item.realAnswerText}`);
  console.log(
    item.escalated
      ? `  Duo would escalate:    ${item.escalationReason}`
      : `  Duo's proposed answer: ${item.proposedText}`,
  );
  console.log("");
  console.log(
    `  duo mirror calibrate judge ${item.qaPairId} --approve|--reject${item.escalated ? "" : ' --edit "<your corrected text>"'}`,
  );
}

function renderCalibrationStatus(progress: CalibrationProgress): void {
  console.log(`Session [${progress.sessionId}]: ${progress.judgedCount}/${progress.totalCount} judged.`);
  if (progress.completed) {
    console.log("All judged. Run `duo mirror calibrate summary` to see how it went.");
    return;
  }
  console.log("");
  renderCalibrationItem(progress.next!);
}

calibrateCommand
  .action(async () => {
    const config = loadConfig();
    try {
      const started = await runMirrorCalibrateStart(config);
      if (started.status === "insufficient_history") {
        console.log(
          `Not enough held-out history to calibrate: found ${started.available} question(s), wanted ${started.wanted}. ` +
            "Import more sources and run `duo derive pairs` again.",
        );
        return;
      }
      console.log(started.status === "started" ? "Started a new calibration session." : "Resuming your calibration session.");
      console.log(HELD_OUT_CAVEAT);
      console.log("");
      const progress = runMirrorCalibrateProgress(config);
      renderCalibrationStatus(progress);
    } catch (error) {
      reportError(error);
    }
  });

calibrateCommand
  .command("judge")
  .description("Judge the current session's next item — approve, reject, or edit the duo's proposed answer (#30 AC1)")
  .argument("<qaPairId>", "the item's qa_pair id, from `duo mirror calibrate`")
  .option("--approve", "the duo's answer (or escalation) was right")
  .option("--reject", "the duo's answer (or escalation) was wrong")
  .option("--edit <text>", "the duo's answer needed a correction — supply the corrected text")
  .action((qaPairId: string, options: { approve?: boolean; reject?: boolean; edit?: string }) => {
    const config = loadConfig();
    try {
      const chosen = [options.approve && "approved", options.reject && "rejected", options.edit !== undefined && "edited"].filter(
        Boolean,
      );
      if (chosen.length !== 1) {
        console.error("Specify exactly one of --approve, --reject, or --edit <text>.");
        process.exitCode = 1;
        return;
      }
      const judgement = chosen[0] as "approved" | "rejected" | "edited";
      const result = runMirrorCalibrateJudge(qaPairId, judgement, options.edit, config);
      console.log(`Recorded: ${judgement}. ${result.judgedCount}/${result.totalCount} judged.`);
      if (result.session.completedAt !== null) {
        console.log("All judged. Run `duo mirror calibrate summary` to see how it went.");
      } else {
        console.log("Run `duo mirror calibrate` to see the next item.");
      }
    } catch (error) {
      reportError(error);
    }
  });

calibrateCommand
  .command("summary")
  .description("Report the calibration run honestly: the agreement rate and every rejected/edited item, never smoothed over (#30 AC2)")
  .action(() => {
    const config = loadConfig();
    try {
      const summary = runMirrorCalibrateSummary(config);
      console.log(
        `${summary.judgedCount}/${summary.totalItems} judged: ${summary.approvedCount} approved, ` +
          `${summary.rejectedCount} rejected, ${summary.editedCount} edited.`,
      );
      console.log(`Agreement rate: ${(summary.agreementRate * 100).toFixed(0)}%`);
      if (summary.lowAgreement) {
        console.log("This is a low agreement rate — the duo is getting a real share of these wrong, not just rounding error.");
      }
      if (summary.mismatches.length > 0) {
        console.log("");
        console.log("What it's getting wrong:");
        for (const mismatch of summary.mismatches) {
          console.log(`  [${mismatch.qaPairId}] (${mismatch.judgement})`);
          console.log(`    Question:  ${mismatch.questionText}`);
          console.log(`    Real:      ${mismatch.realAnswerText}`);
          console.log(`    Proposed:  ${mismatch.escalated ? "(escalated instead of answering)" : mismatch.proposedText}`);
          if (mismatch.editedText) {
            console.log(`    Corrected: ${mismatch.editedText}`);
          }
        }
      }
    } catch (error) {
      reportError(error);
    }
  });

// The action registry (docs/concept.md §6, epic e12): every tool the duo
// can reach is registered with its risk shape, and its tier is resolved
// from that — never asserted directly. #56 is this choke point; #57-#60
// are the tier-specific modules that route through it.
const actionsCommand = program
  .command("actions")
  .description("The action registry: every tool the duo can reach, its derived tier, and every attempt to use one");

actionsCommand
  .command("register")
  .description("Register (or re-register) an action with its risk shape. A tier rise on re-registration revokes any grid cell no longer covering it (#56 AC3)")
  .argument("<actionId>", "a stable id for this action")
  .requiredOption("--description <text>", "what this action does")
  .requiredOption("--reversible <true|false>", "whether the effect can be fully undone")
  .requiredOption("--obligates <true|false>", "whether it binds the owner to future work")
  .requiredOption("--audience <audience>", "none, owner, internal, or external")
  .requiredOption("--topics <ids>", "comma-separated topic ids this action can be exercised within")
  .action((actionId: string, options: { description: string; reversible: string; obligates: string; audience: string; topics: string }) => {
    const config = loadConfig();
    try {
      const result = runActionsRegister(
        actionId,
        { description: options.description, reversible: options.reversible, obligates: options.obligates, audience: options.audience, topics: options.topics },
        config,
      );
      console.log(`Registered [${result.action.id}] at ${result.action.tier}${result.tierChanged ? ` (was ${result.previousTier})` : ""}.`);
      if (result.lapsedGrants.length > 0) {
        console.log(`${result.lapsedGrants.length} grant(s) lapsed, since the risk rose past what they covered:`);
        for (const grant of result.lapsedGrants) {
          console.log(`  [${grant.topicId}] ${grant.tier}: ${grant.previousLevel} -> ask`);
        }
      }
    } catch (error) {
      reportError(error);
    }
  });

// The offline evaluation harness (v1-tech-design.md §1.10, epic e6):
// draft quality on a real time-based held-out split (#35).
const evalCommand = program.command("eval").description("Offline evaluation: draft quality on a real time-based held-out split");

function parseIntegerOption(flag: string): (value: string) => number {
  return (value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      throw new Error(`${flag} expects a number, got "${value}"`);
    }
    return parsed;
  };
}

evalCommand
  .command("offline")
  .description(
    "Time-split the corpus, re-run derivation on the train split only, and score drafts against real held-out answers (#35)",
  )
  .option("--sample <n>", "evaluate only this many held-out pairs (a seeded, reproducible sample)", parseIntegerOption("--sample"))
  .option("--seed <n>", "seed for sampling and ordering, for a reproducible run", parseIntegerOption("--seed"))
  .action(async (options: { sample?: number; seed?: number }) => {
    const config = loadConfig();
    try {
      const report = await runEvalOffline(config, { sampleSize: options.sample, seed: options.seed });
      console.log(
        `Holdout: ${report.holdoutDays} day(s) (corpus spans ${report.corpusSpanDays.toFixed(1)} day(s); cutoff ${report.cutoff}).`,
      );
      console.log(
        `Train: ${report.trainRecordCount} record(s). Held out: ${report.heldOutRecordCount} record(s), ` +
          `${report.heldOutPairCount} qa_pair(s) — evaluated ${report.evaluatedCount} (seed ${report.seed}).`,
      );
      console.log(
        `Rules induced from the train split alone: ${report.confirmedRuleCount} confirmed, ` +
          `${report.inconsistentRuleCount} inconsistent, ${report.weakSignalRuleCount} weak signal.`,
      );
      console.log(
        `Mean similarity to the real answer: ${report.meanSimilarity.toFixed(3)}. Would-have-sent rate: ` +
          `${report.wouldHaveSentRate.toFixed(3)}. Escalation rate: ${report.escalationRate.toFixed(3)}.`,
      );
      console.log("");
      console.log(WOULD_HAVE_SENT_CAVEAT);
      if (report.humanReviewSample.length > 0) {
        console.log(`Spot-check these by hand: ${report.humanReviewSample.join(", ")}`);
      }
    } catch (error) {
      reportError(error);
    }
  });

actionsCommand
  .command("list")
  .description("List every registered action and its derived tier")
  .action(() => {
    const config = loadConfig();
    try {
      const actions = runActionsList(config);
      if (actions.length === 0) {
        console.log("No action is registered yet.");
        return;
      }
      for (const action of actions) {
        console.log(`[${action.id}] ${action.tier}  ${action.description} (topics: ${action.topicIds.join(", ") || "none"})`);
      }
    } catch (error) {
      reportError(error);
    }
  });

actionsCommand
  .command("attempts")
  .description("List every attempt to use an action, refused or resolved (#56 AC2, #60 AC3's owner-notified surface)")
  .action(() => {
    const config = loadConfig();
    try {
      const attempts = runActionsAttempts(config);
      if (attempts.length === 0) {
        console.log("No action attempt recorded yet.");
        return;
      }
      for (const attempt of attempts) {
        console.log(`[${attempt.id}] ${attempt.createdAt} ${attempt.actionId} tier=${attempt.tier ?? "-"} ${attempt.outcome}`);
      }
    } catch (error) {
      reportError(error);
    }
  });

// T4 (docs/concept.md §6, #60): never autonomous, a product principle, not
// a limitation. Every T4 action goes through this staged request/confirm
// sequence — there is no configuration or flag that skips it.
const t4Command = actionsCommand
  .command("t4")
  .description("T4 actions never run without an explicit, separate human confirmation — no setting bypasses this (#60)");

t4Command
  .command("request")
  .description("Stage a T4 request. Nothing executes until a separate `duo actions t4 confirm` call")
  .argument("<actionId>", "the T4-classified action's id, as registered")
  .requiredOption("--topic <topicId>", "the topic this request concerns")
  .requiredOption("--reasoning <text>", "why the duo believes this should happen")
  .action((actionId: string, options: { topic: string; reasoning: string }) => {
    const config = loadConfig();
    try {
      const request = runActionsT4Request(actionId, options, config);
      console.log(`Staged T4 request [${request.id}] for "${actionId}". Run \`duo actions t4 confirm ${request.id}\` to execute it — nothing has happened yet.`);
    } catch (error) {
      reportError(error);
    }
  });

t4Command
  .command("pending")
  .description("List every T4 request awaiting the owner's explicit confirmation")
  .action(() => {
    const config = loadConfig();
    try {
      const pending = runActionsT4Pending(config);
      if (pending.length === 0) {
        console.log("No T4 request is pending.");
        return;
      }
      for (const request of pending) {
        console.log(`[${request.id}] ${request.createdAt} ${request.actionId} (topic ${request.topicId}): ${request.reasoning}`);
      }
    } catch (error) {
      reportError(error);
    }
  });

t4Command
  .command("confirm")
  .description("The owner's explicit, at-the-moment-of-execution confirmation — the only way a T4 action ever runs (#60 AC1)")
  .argument("<requestId>", "the request id printed by `duo actions t4 request`")
  .action((requestId: string) => {
    const config = loadConfig();
    try {
      const request = runActionsT4Confirm(requestId, config);
      console.log(`Confirmed and executed T4 request [${request.id}] at ${request.executedAt}.`);
    } catch (error) {
      reportError(error);
    }
  });

// T1 private preparation (docs/concept.md §6, #57): drafts, documents, and
// staged tickets visible only to the owner, never submitted anywhere by
// this codebase.
actionsCommand
  .command("prepare")
  .description("Prepare a draft, document, or staged ticket visible only to the owner (#57 AC1)")
  .requiredOption("--kind <kind>", `one of: ${PREPARED_ARTIFACT_KINDS.join(", ")}`)
  .requiredOption("--title <text>", "a short title for the prepared artifact")
  .requiredOption("--content <text>", "the artifact's content")
  .option("--topic <topicId>", "the topic this preparation concerns (defaults to \"general\")")
  .action((options: { kind: string; title: string; content: string; topic?: string }) => {
    const config = loadConfig();
    if (!(PREPARED_ARTIFACT_KINDS as readonly string[]).includes(options.kind)) {
      reportError(new Error(`--kind must be one of: ${PREPARED_ARTIFACT_KINDS.join(", ")}`));
      return;
    }
    try {
      const artifact = runActionsPrepare({ kind: options.kind as (typeof PREPARED_ARTIFACT_KINDS)[number], topic: options.topic, title: options.title, content: options.content }, config);
      console.log(`Prepared [${artifact.id}] (${artifact.kind}): ${artifact.title}. Visible only to you — nothing has been submitted anywhere.`);
    } catch (error) {
      reportError(error);
    }
  });

actionsCommand
  .command("prepared")
  .description("List every prepared artifact currently sitting — visible only to the owner")
  .action(() => {
    const config = loadConfig();
    try {
      const artifacts = runActionsListPrepared(config);
      if (artifacts.length === 0) {
        console.log("Nothing prepared yet.");
        return;
      }
      for (const artifact of artifacts) {
        console.log(`[${artifact.id}] (${artifact.kind}, topic ${artifact.topicId}) ${artifact.title}`);
      }
    } catch (error) {
      reportError(error);
    }
  });

actionsCommand
  .command("discard")
  .description("Discard a prepared artifact entirely — removed, with the discard itself recorded as a signal (#57 AC3)")
  .argument("<id>", "the prepared artifact's id")
  .option("--note <text>", "why it wasn't wanted")
  .action((id: string, options: { note?: string }) => {
    const config = loadConfig();
    try {
      runActionsDiscard(id, options.note, config);
      console.log(`Discarded [${id}]. Nothing recoverable remains; the discard itself is recorded.`);
    } catch (error) {
      reportError(error);
    }
  });

actionsCommand
  .command("discards")
  .description("List every discard signal recorded — what was prepared but never wanted")
  .action(() => {
    const config = loadConfig();
    try {
      const signals = runActionsListDiscards(config);
      if (signals.length === 0) {
        console.log("No discard recorded yet.");
        return;
      }
      for (const signal of signals) {
        console.log(`[${signal.id}] ${signal.discardedAt} (${signal.kind}) ${signal.title}${signal.note ? ` — ${signal.note}` : ""}`);
      }
    } catch (error) {
      reportError(error);
    }
  });

program
  .command("ask")
  .description("Send a prompt straight to the configured inference provider and print its completion")
  .argument("<prompt>", "the prompt to send")
  .action(async (prompt: string) => {
    const config = loadConfig();
    try {
      const result = await runAsk(prompt, config);
      console.log(result);
    } catch (error) {
      reportError(error);
    }
  });

program.parseAsync(process.argv).catch(reportError);
