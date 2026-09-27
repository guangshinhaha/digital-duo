#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { loadConfig } from "./config.js";
import {
  runActionsApprove,
  runActionsAttempts,
  runActionsBind,
  runActionsDiscard,
  runActionsExpire,
  runActionsList,
  runActionsListDiscards,
  runActionsListPending,
  runActionsListPrepared,
  runActionsListReversible,
  runActionsPerform,
  runActionsPrepare,
  runActionsRegister,
  runActionsRetract,
  runActionsStats,
  runActionsT4Confirm,
  runActionsT4Pending,
  runActionsT4Request,
  runActionsUndo,
} from "./commands/actions.js";
import { PENDING_ACTION_STATUSES } from "./actions/approvals.js";
import { PREPARED_ARTIFACT_KINDS } from "./actions/preparation.js";
import { runAsk } from "./commands/ask.js";
import { runDerivePairs, runDeriveRules, runDeriveSync, runDeriveTopics, runDeriveVoice } from "./commands/derive.js";
import { runDraft, runDraftsList, runRecordDraftOutcome, runRecordEscalationAnswer } from "./commands/draft.js";
import { runList } from "./commands/list.js";
import { runHostedInvite, runHostedOrgCreate, runHostedOrgList, runHostedOrgMembers, runHostedOrgRename, runHostedProvision, runHostedRemint, runHostedServe } from "./commands/hosted.js";
import { runAskLink, runAskLinkList, runAskLinkRevoke, runPair, runPairList, runPairRevoke, runServe } from "./commands/serve.js";
import { HELD_OUT_CAVEAT, type CalibrationItem } from "./derivation/calibration.js";
import { DRAFT_OUTCOMES, SETTABLE_DRAFT_OUTCOMES } from "./drafting/draft-log.js";
import { runEmbed } from "./commands/embed.js";
import { runEvalGate, runEvalJevStage1, runEvalJevStage2, runEvalOffline } from "./commands/eval.js";
import { assertPrecisionFloor } from "./eval/gate-eval.js";
import { WOULD_HAVE_SENT_CAVEAT } from "./eval/offline-eval.js";
import { createJevProvider } from "./provider/jev-provider.js";
import { REFUSALS_PARITY_CAVEAT, assertStage1QualityPass, stage1ReportPath } from "./eval/jev-gate-eval.js";
import { requireStage1Pass, stage2ReportPath } from "./eval/jev-trace-eval.js";
import { runJevVerdict } from "./eval/jev-verdict.js";
import { runHandoverCut, runHandoverGenerate, runHandoverShare } from "./commands/handover.js";
import { runArchive, runDeclareOrphaned, runEnd, runTransferConfirm, runTransferInitiate, runTransferList } from "./commands/lifecycle.js";
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
import { runConsultPredecessor } from "./commands/continuity.js";
import { runCorrectionsApprove, runCorrectionsReject, runCorrectionsReview } from "./commands/corrections.js";
import { runEscalationsCheck, runEscalationsDigest, runEscalationsHistory, runEscalationsRate } from "./commands/escalations.js";
import { runMentionsListMuted, runMentionsMute, runMentionsOffer, runMentionsUnmute } from "./commands/mentions.js";
import {
  runAnswerPublicly,
  runAskAsAsker,
  runCorrectPublicAnswer,
  runEnforceCeiling,
  runListAuditEntries,
  runListPublicAnswerLogEntries,
  runShowAuditEntry,
} from "./commands/permissions.js";
import { runPurge } from "./commands/purge.js";
import { runRoleDuoSeed, runRoleDuoWithdraw } from "./commands/role-duo.js";
import { runSearch } from "./commands/search.js";
import { runSharedAsk, runSharedGaps, runSharedUsage } from "./commands/shared.js";
import { runKnowledge, runStatus } from "./commands/status.js";
import { runTrustCorrect, runTrustGrant, runTrustGrid, runTrustLedger, runTrustPromote, runTrustPromotions } from "./commands/trust.js";

const program = new Command();

program.name("duo").description("Digital Duo CLI").version("0.1.0");

/** Formats an unknown thrown value to stderr and sets a non-zero exit code. */
function reportError(error: unknown): void {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

/** A Commander option parser for a numeric flag — Commander calls this itself while parsing argv, so throwing here (rather than letting a bare `Number.parseInt` silently produce NaN) is what turns `--limit abc` into a clean argv-parsing error instead of NaN reaching a SQL LIMIT binding downstream. */
function parseIntegerOption(flag: string): (value: string) => number {
  return (value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      throw new Error(`${flag} expects a number, got "${value}"`);
    }
    return parsed;
  };
}

program
  .command("status")
  .description("Print the configured provider, store location, and whether the store exists")
  .action(() => {
    const config = loadConfig();
    console.log(runStatus(config));
  });

program
  .command("knowledge")
  .description("Summarize what this duo knows: records by source, the last import, corpus coverage, rules by review status, providers, and shared-duo usage")
  .action(() => {
    const config = loadConfig();
    try {
      console.log(runKnowledge(config));
    } catch (error) {
      reportError(error);
    }
  });

program
  .command("serve")
  .description(
    "Run the Mac/phone client daemon (client-tech-design.md §1.3): a passphrase-in-memory HTTP API over the " +
      "existing store. Never falls back to reading the passphrase off disk, and refuses to bind every interface.",
  )
  .option("--host <host>", "the address to bind — a tailnet IP, or 127.0.0.1 for local-only. Never a wildcard.")
  .option("--port <port>", "the port to bind", parseIntegerOption("--port"), 7717)
  .option(
    "--behind-proxy",
    "allow a wildcard --host — only for a container whose sole inbound path is a TLS-terminating front (e.g. Railway)",
  )
  .option("--hosted", "serve many duos from one process, invite-only (docs/deploy/hosted-mode.md)")
  .action(async (options: { host?: string; port: number; behindProxy?: boolean; hosted?: boolean }) => {
    const config = loadConfig();
    try {
      const serveOptions = { host: options.host, port: options.port, behindProxy: options.behindProxy };
      const { address } = options.hosted ? await runHostedServe(serveOptions, config) : await runServe(serveOptions, config);
      console.error(`duo serve listening on ${address}`);
    } catch (error) {
      reportError(error);
    }
  });

const hostedCommand = program.command("hosted").description("Hosted mode administration: orgs, and inviting people to create their own duo on this server");

hostedCommand
  .command("invite <name>")
  .description("Mint a single-use invite link for <name> (run on the server; talks to the running hosted daemon)")
  .option("--expires-in-hours <n>", "hours before the invite expires", parseIntegerOption("--expires-in-hours"), 168)
  .option("--org <id>", "the org the invitee joins (see `duo hosted org list`); default is the default org")
  .action(async (name: string, options: { expiresInHours: number; org?: string }) => {
    try {
      const invite = await runHostedInvite(name, options.expiresInHours, process.env, options.org);
      console.log(`Invite for "${invite.name}" into org ${invite.orgId} (expires ${invite.expiresAt}, single use):`);
      console.log(invite.link ?? `code: ${invite.code} (set DUO_HOSTED_PUBLIC_URL and DUO_HOSTED_WEB_URL to get a full link)`);
    } catch (error) {
      reportError(error);
    }
  });

hostedCommand
  .command("provision")
  .description("Create the Matrix accounts every hosted duo still lacks, then each org's Space and #general and put members in them (safe to re-run; talks to the running hosted daemon, which needs DUO_WORKSPACE_PRIVATE_URL and DUO_WORKSPACE_ADMIN_TOKEN)")
  .option("--remint <duoId>", "instead, give this one duo a new Matrix token (for a duo whose token Synapse no longer knows, e.g. after its database was reset); the connection restarts with it")
  .action(async (options: { remint?: string }) => {
    try {
      if (options.remint !== undefined) {
        const outcome = await runHostedRemint(options.remint);
        console.log(
          outcome.status === "reminted"
            ? `Minted a new token for ${outcome.duoId}; its connection is restarting with it.`
            : `${outcome.duoId}: ${outcome.status}${outcome.error ? ` (${outcome.error})` : ""}. Nothing was changed.`,
        );
        return;
      }
      const summary = await runHostedProvision();
      console.log(`Provisioned ${summary.provisioned}, already done ${summary.already}, pending ${summary.pending}, needs attention ${summary.failed}.`);
      for (const outcome of summary.outcomes.filter((candidate) => candidate.status === "pending")) {
        console.log(`  ${outcome.duoId}: pending (${outcome.error ?? "unknown"}) — it will be retried`);
      }
      for (const outcome of summary.outcomes.filter((candidate) => candidate.status === "failed")) {
        console.log(`  ${outcome.duoId}: needs attention (${outcome.error ?? "unknown"}) — see the daemon log`);
      }
      const { orgs, members } = summary.spaces;
      console.log(
        `Org spaces: ${orgs.provisioned} made, ${orgs.already} already done, ${orgs.pending} pending, ${orgs.failed} need attention. ` +
          `Members joined: ${members.provisioned} now, ${members.already} already, ${members.pending} pending, ${members.failed} need attention, ${members.waiting} waiting for their accounts.`,
      );
      for (const outcome of summary.spaces.orgOutcomes.filter((candidate) => candidate.status === "pending" || candidate.status === "failed")) {
        console.log(`  org ${outcome.orgId}: ${outcome.status} (${outcome.error ?? "unknown"})`);
      }
      for (const outcome of summary.spaces.memberOutcomes.filter((candidate) => candidate.status === "pending" || candidate.status === "failed")) {
        console.log(`  ${outcome.duoId}: space join ${outcome.status} (${outcome.error ?? "unknown"})`);
      }
    } catch (error) {
      reportError(error);
    }
  });

const hostedOrgCommand = hostedCommand.command("org").description("Orgs on this hosted server (talks to the running hosted daemon)");

hostedOrgCommand
  .command("create <name>")
  .description("Create an org")
  .action(async (name: string) => {
    try {
      const org = await runHostedOrgCreate(name);
      console.log(`Created org "${org.name}" (id ${org.id}). Invite people into it: duo hosted invite "<name>" --org ${org.id}`);
    } catch (error) {
      reportError(error);
    }
  });

hostedOrgCommand
  .command("list")
  .description("List orgs and how many duos are in each")
  .action(async () => {
    try {
      for (const org of await runHostedOrgList()) {
        console.log(`${org.id}\t${org.name}\t${org.memberCount} member${org.memberCount === 1 ? "" : "s"}`);
      }
    } catch (error) {
      reportError(error);
    }
  });

hostedOrgCommand
  .command("rename <id> <name>")
  .description("Rename an org")
  .action(async (id: string, name: string) => {
    try {
      const org = await runHostedOrgRename(id, name);
      console.log(`Renamed org ${org.id} to "${org.name}".`);
    } catch (error) {
      reportError(error);
    }
  });

hostedOrgCommand
  .command("members <id>")
  .description("List the duos in an org")
  .action(async (id: string) => {
    try {
      for (const member of await runHostedOrgMembers(id)) {
        console.log(`${member.duoId}\t${member.name}\t${member.email ?? "-"}${member.isAdmin ? "\tadmin" : ""}`);
      }
    } catch (error) {
      reportError(error);
    }
  });

const pairCommand = program.command("pair").description("Pair a device (Mac app, phone) with this duo's daemon (client-tech-design.md Part 2)");

pairCommand
  .command("new")
  .description("Mint a device token and print it once — copy it to the device now, it is never shown again")
  .argument("<name>", "a name for the device, e.g. \"iPhone\"")
  .action((name: string) => {
    const config = loadConfig();
    try {
      const paired = runPair(name, config);
      console.log(`Device "${paired.name}" paired (id ${paired.id}). Token (copy this now, it will not be shown again):`);
      console.log(paired.token);
    } catch (error) {
      reportError(error);
    }
  });

pairCommand
  .command("list")
  .description("List every paired device, whether currently valid, and when it was last seen")
  .action(() => {
    const config = loadConfig();
    try {
      const devices = runPairList(config);
      if (devices.length === 0) {
        console.log("No paired devices.");
        return;
      }
      for (const device of devices) {
        const status = device.revokedAt ? `revoked ${device.revokedAt}` : `last seen ${device.lastSeenAt ?? "never"}`;
        console.log(`[${device.id}] ${device.name} — ${status}`);
      }
    } catch (error) {
      reportError(error);
    }
  });

pairCommand
  .command("revoke")
  .description("Revoke a device immediately — losing a phone means revoking one token, never re-keying the store")
  .argument("<id>", "the device id, from `duo pair list`")
  .action((id: string) => {
    const config = loadConfig();
    try {
      runPairRevoke(id, config);
      console.log(`Device ${id} revoked.`);
    } catch (error) {
      reportError(error);
    }
  });

// Ask links (issue #158): a second token kind beside `duo pair` — a
// short-lived, ask-only credential minted for one person. An ask link is
// never a PairedDevice and never appears in `duo pair list`; the token
// layer's own refusal of it on every existing route is structural (see
// src/serve/tokens.ts's AskToken doc comment).
const askLinkCommand = program.command("ask-link").description("Mint and manage short-lived, ask-only links (issue #158) — never a paired device");

askLinkCommand
  .command("new")
  .description("Mint a short-lived, ask-only link and print its token once — copy it to the person now, it is never shown again")
  .argument(
    "<name>",
    "a name for whom the link is intended — use the asker's duo/directory.json id (e.g. \"sam-carter\") so their asks log under it; a free-form name (e.g. \"Sam\") logs as-is",
  )
  .option("--expires-in-hours <n>", "hours before this link expires (default 24; a positive whole number)", parseIntegerOption("--expires-in-hours"), 24)
  .action((name: string, options: { expiresInHours: number }) => {
    const config = loadConfig();
    // parseIntegerOption only guarantees a finite number — the positive-
    // integer contract (KTD4: no fractional-hours link is ever minted) is
    // checked here at the action boundary, before any arithmetic.
    if (!Number.isInteger(options.expiresInHours) || options.expiresInHours <= 0) {
      reportError(new Error(`--expires-in-hours must be a positive whole number of hours, got ${options.expiresInHours}`));
      return;
    }
    // ECMAScript Dates max out at ±8.64e15 ms, so a value whose offset
    // overflows that (e.g. a pasted epoch) would crash in toISOString()
    // below with the unattributed "Invalid time value" — reject it here
    // with the flag named instead (review finding #4).
    if (options.expiresInHours * 3_600_000 + Date.now() > 8.64e15) {
      reportError(new Error(`--expires-in-hours is too large — the resulting expiry would exceed the maximum representable date, got ${options.expiresInHours}`));
      return;
    }
    try {
      // KTD4: the default-and-flag arithmetic lives here at the CLI edge;
      // createAskToken takes the expiry itself as an ISO-8601 string.
      const expiresAt = new Date(Date.now() + options.expiresInHours * 3_600_000).toISOString();
      const link = runAskLink(name, expiresAt, config);
      console.log(`Ask link "${link.name}" created (id ${link.id}). Expires ${link.expiresAt}.`);
      console.log("Token (copy this now, it will not be shown again):");
      console.log(link.token);
    } catch (error) {
      reportError(error);
    }
  });

askLinkCommand
  .command("list")
  .description("List every ask link with its expiry and status — outstanding, expired, or revoked; no token value is ever shown")
  .action(() => {
    const config = loadConfig();
    try {
      const links = runAskLinkList(config);
      if (links.length === 0) {
        console.log("No ask links.");
        return;
      }
      const now = new Date().toISOString();
      for (const link of links) {
        // A revoked link matches `pair list`'s own revoked line exactly;
        // otherwise the ask scope rides alongside the expiry (ISO-8601
        // strings compare order-equivalently to their instants).
        if (link.revokedAt !== null) {
          console.log(`[${link.id}] ${link.name} — revoked ${link.revokedAt}`);
          continue;
        }
        const expiry = link.expiresAt <= now ? `expired ${link.expiresAt}` : `expires ${link.expiresAt}`;
        console.log(`[${link.id}] ${link.name} — ask · ${expiry}`);
      }
    } catch (error) {
      reportError(error);
    }
  });

askLinkCommand
  .command("revoke")
  .description("Revoke an ask link immediately — it stops working on its very next use; revoking twice is a no-op")
  .argument("<id>", "the link's id, from `duo ask-link list`")
  .action((id: string) => {
    const config = loadConfig();
    try {
      runAskLinkRevoke(id, config);
      console.log(`Ask link ${id} revoked.`);
    } catch (error) {
      reportError(error);
    }
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
  .command("ask-public")
  .description(
    "The graduation from private drafting (#43): draft privately as v1 always does, and post publicly only when the " +
      "topic holds granted T0 autonomy, the evidence clears confidence, and nothing about it is refused",
  )
  .argument("<question>", "the question a colleague asked")
  .requiredOption("--as <askerRef>", "who is asking, recorded for the log only — public answering does not differentiate per asker (#43's own out-of-scope note)")
  .action(async (question: string, options: { as: string }) => {
    const config = loadConfig();
    try {
      const outcome = await runAnswerPublicly(question, options.as, config);
      switch (outcome.kind) {
        case "answered":
          console.log(outcome.text);
          console.error(
            `(answered publicly — log id ${outcome.logEntryId}, topic [${outcome.topicId}] is granted T0 autonomy; ` +
              `confidence ${outcome.confidence.score.toFixed(2)}; correct it later with \`duo permissions correct ${outcome.logEntryId} <correctedText>\`)`,
          );
          break;
        case "passed_on":
          console.log(outcome.message);
          console.error(
            `(kept private — draft id ${outcome.draftId}${outcome.topicId ? `, topic [${outcome.topicId}] not yet granted T0 autonomy` : ", no topic resolved"})`,
          );
          if (outcome.ownerNotice) {
            console.error(`(owner-facing: ${outcome.ownerNotice})`);
          }
          break;
        case "declined_refused":
          console.log(outcome.message);
          console.error(`(refused — draft id ${outcome.draftId})`);
          break;
      }
    } catch (error) {
      reportError(error);
    }
  });

permissionsCommand
  .command("log")
  .description("List every public-answer-log entry (oldest first) — every question a colleague asked publicly, and how it was handled (#43/#45), with each ask's link and clearance context (#160)")
  .action(() => {
    const config = loadConfig();
    try {
      const entries = runListPublicAnswerLogEntries(config);
      if (entries.length === 0) {
        console.log("No public-answer-log entries yet.");
        return;
      }
      for (const entry of entries) {
        console.log(
          `[${entry.id}] ${entry.createdAt} asker=${entry.askerRef} outcome=${entry.outcome}` +
            `${entry.topicId ? ` topic=${entry.topicId}` : ""}${entry.correctsEntryId ? ` corrects=${entry.correctsEntryId}` : ""}` +
            // #160: the ceiling every entry was filtered through, always, and
            // the ask link by id when the ask came through one — never the
            // raw secret. Same `clearance=` convention as `duo permissions audit`.
            `${entry.askLinkId ? ` link=${entry.askLinkId}` : ""} clearance=${entry.clearanceApplied} ` +
            `question="${entry.question}"`,
        );
      }
    } catch (error) {
      reportError(error);
    }
  });

permissionsCommand
  .command("correct")
  .description(
    "Correct a public answer already logged (#45): posts the correction linked to the original in the same " +
      "thread, drops that topic's T0 autonomy a level immediately, and — unless --thread-gone — reports it posted",
  )
  .argument("<entryId>", "the public-answer-log entry id to correct, from `duo permissions log`")
  .argument("<correctedText>", "the correct answer, in your own words")
  .option("--thread-gone", "the original thread no longer exists — the correction and topic demotion still happen, but nothing can be posted there")
  .action((entryId: string, correctedText: string, options: { threadGone?: boolean }) => {
    const config = loadConfig();
    try {
      const result = runCorrectPublicAnswer(entryId, correctedText, !options.threadGone, config);
      console.log(result.text);
      console.error(
        result.postedInThread
          ? `(posted to the original thread — correction id ${result.correctionEntryId}; notified: ${result.notifiedAskerRefs.join(", ")})`
          : `(${result.threadGoneNotice})`,
      );
      if (result.demotion?.demoted) {
        console.error(`(topic [${result.correctedTopicId}] T0 autonomy dropped: ${result.demotion.fromLevel} -> ${result.demotion.toLevel})`);
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
  .argument("<outcome>", `one of: ${SETTABLE_DRAFT_OUTCOMES.join(", ")}`)
  .argument("[sentText]", "the text actually sent — required to classify an \"edited\" outcome, ignored otherwise")
  .action(async (draftId: string, outcome: string, sentText: string | undefined) => {
    const config = loadConfig();
    // SETTABLE_DRAFT_OUTCOMES, not the full DRAFT_OUTCOMES: escalation_answered
    // is set only by standing-order-candidates.ts's own atomic write, never
    // by hand here — see SettableDraftOutcome's doc comment.
    if (!SETTABLE_DRAFT_OUTCOMES.includes(outcome as (typeof SETTABLE_DRAFT_OUTCOMES)[number])) {
      reportError(new Error(`outcome must be one of: ${SETTABLE_DRAFT_OUTCOMES.join(", ")}`));
      return;
    }
    try {
      const result = await runRecordDraftOutcome(draftId, outcome as (typeof SETTABLE_DRAFT_OUTCOMES)[number], config, sentText);
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

const draftsCommand = program.command("drafts").description("List drafts (client-tech-design.md G-a: the Review surface's read side)");

draftsCommand
  .command("list")
  .description("List drafts, oldest first — by default every one ever recorded")
  .option("--pending", "only drafts with no outcome recorded yet")
  .option("--outcome <outcome>", `only drafts with this outcome, one of: ${DRAFT_OUTCOMES.join(", ")}`)
  .option("--limit <n>", "cap the number of rows returned", parseIntegerOption("--limit"))
  .action((options: { pending?: boolean; outcome?: string; limit?: number }) => {
    const config = loadConfig();
    if (options.outcome !== undefined && !DRAFT_OUTCOMES.includes(options.outcome as (typeof DRAFT_OUTCOMES)[number])) {
      reportError(new Error(`--outcome must be one of: ${DRAFT_OUTCOMES.join(", ")}`));
      return;
    }
    try {
      const drafts = runDraftsList(config, {
        outcome: options.pending ? "pending" : (options.outcome as (typeof DRAFT_OUTCOMES)[number] | undefined),
        limit: options.limit,
      });
      if (drafts.length === 0) {
        console.log("No drafts.");
        return;
      }
      for (const draft of drafts) {
        const status = draft.escalated ? "escalated" : draft.outcome ? `outcome=${draft.outcome}` : "pending";
        console.log(`[${draft.id}] ${draft.createdAt} ${status} confidence=${draft.confidenceScore.toFixed(2)} question="${draft.question}"`);
      }
    } catch (error) {
      reportError(error);
    }
  });

program
  .command("list")
  .description("List every duo this process can currently reach — your personal duo, plus the shared duo if one is configured")
  .action(() => {
    try {
      const duos = runList();
      for (const duo of duos) {
        console.log(duo.kind === "personal" ? "personal  (this duo — duo ask / duo draft)" : `shared    owner=${duo.ownerName} (${duo.ownerId})  (duo shared ask)`);
      }
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
        console.log(`Conflicts with an active rule (${review.conflicts.length}) — choose one before approving:`);
        for (const { candidate, conflictingRule } of review.conflicts) {
          console.log(`  [${candidate.id}] proposes: "${candidate.proposedText}"`);
          console.log(`  [${conflictingRule.id}] active rule says: "${conflictingRule.text}"`);
          console.log(`  duo corrections approve ${candidate.id} --supersedes ${conflictingRule.id}   (retires [${conflictingRule.id}])`);
        }
      }
    } catch (error) {
      reportError(error);
    }
  });

correctionsCommand
  .command("approve")
  .description(
    "Approve a pending candidate: writes to duo/rules/ (substance) or duo/voice.md (style), then marks it approved (#38 AC1). " +
      "A substance candidate flagged as conflicting with an active rule needs --supersedes <ruleId> naming which rule it replaces (#39 AC3)",
  )
  .argument("<id>", "the candidate's id, from `duo corrections review`")
  .option("--supersedes <ruleId>", "the active rule this candidate replaces — retires it (marked superseded) instead of leaving both active")
  .action((id: string, options: { supersedes?: string }) => {
    const config = loadConfig();
    try {
      const result = runCorrectionsApprove(id, config, { supersedesRuleId: options.supersedes });
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

// Batched escalation digests (docs/concept.md §10, #46): "escalations must
// batch into a digest; only a narrow urgent class interrupts live." Built
// over #32's own drafts table (every escalated draft, whichever pipeline
// produced it) rather than a parallel tracking mechanism.
const escalationsCommand = program
  .command("escalations")
  .description("Batched escalation digests, the rare urgent-interrupt path, and the drift-visibility rate between them (#46)");

function renderDigestItem(item: { draftId: string; question: string; escalationReason: string | null; createdAt: string }): string {
  return `  [${item.draftId}] ${item.createdAt} ${item.question}${item.escalationReason ? `\n    ${item.escalationReason}` : ""}`;
}

escalationsCommand
  .command("check")
  .description(
    "The rare, live-interrupt path (#46 AC3): every urgent, unresolved escalation not yet surfaced. " +
      "Each one is reported here exactly once — it will not appear again on a later check",
  )
  .action(() => {
    const config = loadConfig();
    try {
      const result = runEscalationsCheck(config);
      if (result.items.length === 0) {
        console.log("No urgent escalations.");
        return;
      }
      console.log(`${result.items.length} urgent escalation(s) — this should stay rare:`);
      result.items.forEach((item) => console.log(renderDigestItem(item)));
    } catch (error) {
      reportError(error);
    }
  });

escalationsCommand
  .command("digest")
  .description(
    "Assemble and send the batched digest of every ordinary escalation since the last one (#46 AC1). " +
      "Sends and prints nothing at all when there is nothing new (#46 AC2) — an escalation the owner already " +
      "answered directly (`duo draft-answer`) is omitted as already resolved (#46 AC4)",
  )
  .action(() => {
    const config = loadConfig();
    try {
      const result = runEscalationsDigest(config);
      if (!result.sent) {
        console.log("Nothing to digest.");
        return;
      }
      console.log(`Digest [${result.digestId}] — ${result.items.length} escalation(s) since the last one:`);
      result.items.forEach((item) => console.log(renderDigestItem(item)));
    } catch (error) {
      reportError(error);
    }
  });

escalationsCommand
  .command("history")
  .description("List every digest actually sent, oldest first")
  .action(() => {
    const config = loadConfig();
    try {
      const digests = runEscalationsHistory(config);
      if (digests.length === 0) {
        console.log("No digest has been sent yet.");
        return;
      }
      for (const digest of digests) {
        console.log(`[${digest.id}] ${digest.createdAt} — ${digest.itemCount} escalation(s)`);
      }
    } catch (error) {
      reportError(error);
    }
  });

escalationsCommand
  .command("rate")
  .description("The all-time share of escalations classified urgent (#46 AC3) — the number to watch for drift away from \"rare\"")
  .action(() => {
    const config = loadConfig();
    try {
      const rate = runEscalationsRate(config);
      console.log(
        rate.total === 0
          ? "No escalations classified yet."
          : `${rate.urgent}/${rate.total} escalation(s) classified urgent (${(rate.rate * 100).toFixed(1)}%).`,
      );
    } catch (error) {
      reportError(error);
    }
  });

// Proactive offers on a mention (docs/concept.md §10, #47): "the duo
// should watch threads where its owner is mentioned and proactively offer
// a draft — to the owner only." #31's relevance gate was built for exactly
// this entry point; a live Slack mention (epic e8) stays blocked, so
// `offer` takes a hand-supplied stand-in for one, same as `duo draft`
// stands in for a real Slack DM everywhere else in this codebase.
const mentionsCommand = program
  .command("mentions")
  .description("Proactive private offers when the owner is mentioned, gated by relevance and per-channel mutes (#47)");

mentionsCommand
  .command("offer")
  .description(
    "Offer a draft for a hand-supplied mention, as a live Slack mention (epic e8, blocked) eventually would. " +
      "Muted (per --channel), gate-declined, and no-draft outcomes are all reported, never silently dropped",
  )
  .argument("<text>", "the mention's text")
  .option("--from <name>", "who mentioned the owner")
  .option("--channel <channel>", "which channel this arrived in — checked against the mute list (#47 AC3)")
  .option("--thread-id <threadId>", "the thread within --channel this arrived in — checked against thread-scoped mutes (#172)")
  .option("--thread-context <text>", "prior messages in the same thread, if any")
  .action(async (text: string, options: { from?: string; channel?: string; threadId?: string; threadContext?: string }) => {
    const config = loadConfig();
    try {
      const outcome = await runMentionsOffer(text, options, config);
      switch (outcome.kind) {
        case "muted":
          console.log(
            outcome.threadId === undefined
              ? `Muted — no offer made (channel "${outcome.channel}").`
              : `Muted — no offer made (thread ${outcome.threadId} in channel "${outcome.channel}").`,
          );
          break;
        case "gate_declined":
          console.log(`Gate declined (${outcome.reason}) — no offer made.`);
          break;
        case "no_draft":
          console.log(`No draft to offer: ${outcome.reason}`);
          console.error(`(draft id ${outcome.draftId})`);
          break;
        case "offer":
          console.log(outcome.text);
          console.log("");
          console.log(`Confidence: ${outcome.confidence.score.toFixed(2)} (draft id ${outcome.draftId})`);
          console.error(`(offered privately — one action to post it: \`duo draft-outcome ${outcome.draftId} sent\`)`);
          break;
      }
    } catch (error) {
      reportError(error);
    }
  });

mentionsCommand
  .command("mute")
  .description("Mute proactive offers from a channel, or one thread within it via --thread (#47 AC3, #172) — reversible with `duo mentions unmute`")
  .argument("<channel>", "the channel to mute")
  .option("--thread <threadId>", "mute only this thread within the channel, not the whole channel (#172)")
  .action((channel: string, options: { thread?: string }) => {
    const config = loadConfig();
    try {
      const entries = runMentionsMute(channel, config, options.thread);
      const mutedWhat = options.thread === undefined ? `"${channel}"` : `thread ${options.thread} in "${channel}"`;
      // The store is one list: entries echo back in their stored form, a
      // thread mute appearing as `channel/threadId` — visible, not decoded.
      console.log(`Muted ${mutedWhat}. Currently muted: ${entries.join(", ") || "(none)"}.`);
    } catch (error) {
      reportError(error);
    }
  });

mentionsCommand
  .command("unmute")
  .description("Unmute a previously-muted channel, or one thread within it via --thread (#47 AC3, #172)")
  .argument("<channel>", "the channel to unmute")
  .option("--thread <threadId>", "unmute only this thread within the channel (#172)")
  .action((channel: string, options: { thread?: string }) => {
    const config = loadConfig();
    try {
      const result = runMentionsUnmute(channel, config, options.thread);
      const unmutedWhat = options.thread === undefined ? `"${channel}"` : `thread ${options.thread} in "${channel}"`;
      console.log(
        result.wasMuted
          ? `Unmuted ${unmutedWhat}. Currently muted: ${result.channels.join(", ") || "(none)"}.`
          : `${unmutedWhat} was not muted.`,
      );
    } catch (error) {
      reportError(error);
    }
  });

mentionsCommand
  .command("muted")
  .description("List every currently-muted channel and thread (#47 AC3: \"the setting is visible\") — thread mutes appear as channel/threadId, their stored form")
  .action(() => {
    const config = loadConfig();
    try {
      const channels = runMentionsListMuted(config);
      console.log(channels.length === 0 ? "No channel is muted." : channels.join("\n"));
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

// Continuity (docs/concept.md §4/§12, epic e13): a duo that outlives a
// posting is a genuinely new object — "consult my predecessor," never
// "consult me" as if its owner still spoke for the role. #61 is the first
// piece: asking a predecessor's own duo, reframed as a stated-date
// historical record rather than a live answer.
const continuityCommand = program
  .command("continuity")
  .description("A duo that has outlived its owner's posting: consulted as a historical record, never as though current");

continuityCommand
  .command("consult")
  .description("Ask a predecessor's own duo something — answered as a historical record as of a stated date, never as though current")
  .argument("<predecessorStorePath>", "path to the predecessor's own encrypted store")
  .argument("<predecessorDuoDir>", "path to the predecessor's own derived-output directory")
  .argument("<predecessorName>", "the predecessor's name, stated in every answer")
  .argument("<question>", "the question to ask")
  .action(async (predecessorStorePath: string, predecessorDuoDir: string, predecessorName: string, question: string) => {
    const config = loadConfig();
    try {
      const result = await runConsultPredecessor(predecessorStorePath, predecessorDuoDir, predecessorName, question, config);
      console.log(result.text);
    } catch (error) {
      reportError(error);
    }
  });

// #63: every duo needs an end (docs/concept.md §11) — archival, transfer,
// and deletion are all deliberate acts with a record, never inferred from
// silence. An orphaned duo (no transfer or archival ever performed) fails
// safe: `duo draft` and `duo continuity consult` both refuse it (see
// src/continuity/lifecycle.ts's assertOwnerConsultable/
// assertPredecessorConsultable, wired into commands/draft.ts and
// commands/continuity.ts respectively).
continuityCommand
  .command("archive")
  .description("Archive this duo with an explicit decision: stops answering in the present tense, revokes every autonomy grant, records who and when")
  .argument("<decidedBy>", "who decided to archive this duo")
  .action((decidedBy: string) => {
    const config = loadConfig();
    try {
      const record = runArchive(decidedBy, config);
      console.log(`Archived by ${record.archivedBy} on ${record.archivedAt}.`);
    } catch (error) {
      reportError(error);
    }
  });

continuityCommand
  .command("orphan")
  .description("Record that this duo's owner has left with no transfer or archival ever performed — every consultation surface then fails safe")
  .argument("<reportedBy>", "who is reporting this")
  .argument("<reason>", "why this duo is being declared orphaned")
  .action((reportedBy: string, reason: string) => {
    const config = loadConfig();
    try {
      const record = runDeclareOrphaned(reportedBy, reason, config);
      console.log(`Declared orphaned by ${record.orphanedBy} on ${record.orphanedAt}: ${record.orphanReason}`);
    } catch (error) {
      reportError(error);
    }
  });

const transferCommand = continuityCommand
  .command("transfer")
  .description("A duo cannot be transferred without both the outgoing and receiving owner explicitly confirming — never by one party or an administrator alone");

transferCommand
  .command("initiate")
  .description("Start a transfer request — neither party is confirmed yet, and nothing changes until both are")
  .argument("<outgoingOwner>", "the current owner's name")
  .argument("<receivingOwner>", "the new owner's name")
  .action((outgoingOwner: string, receivingOwner: string) => {
    const config = loadConfig();
    try {
      const request = runTransferInitiate(outgoingOwner, receivingOwner, config);
      console.log(`Transfer "${request.id}" initiated: ${request.outgoingOwner} -> ${request.receivingOwner} (pending both confirmations).`);
    } catch (error) {
      reportError(error);
    }
  });

transferCommand
  .command("confirm")
  .description("Confirm a pending transfer as one of its two named parties — completes only once both have confirmed")
  .argument("<transferId>", "the transfer request's id")
  .argument("<confirmingName>", "the name of the party confirming (must match the request's outgoing or receiving owner)")
  .action((transferId: string, confirmingName: string) => {
    const config = loadConfig();
    try {
      const request = runTransferConfirm(transferId, confirmingName, config);
      console.log(
        request.status === "completed"
          ? `Transfer "${request.id}" completed on ${request.completedAt}: ${request.outgoingOwner} -> ${request.receivingOwner}.`
          : `Transfer "${request.id}" confirmed by ${confirmingName}; still awaiting the other party.`,
      );
    } catch (error) {
      reportError(error);
    }
  });

transferCommand
  .command("list")
  .description("List every transfer request ever made for this duo")
  .action(() => {
    const config = loadConfig();
    try {
      const requests = runTransferList(config);
      if (requests.length === 0) {
        console.log("No transfer requests recorded.");
        return;
      }
      for (const request of requests) {
        console.log(
          `${request.id}  ${request.outgoingOwner} -> ${request.receivingOwner}  ${request.status}` +
            (request.status === "completed" ? ` (${request.completedAt})` : ""),
        );
      }
    } catch (error) {
      reportError(error);
    }
  });

continuityCommand
  .command("end")
  .description("End this duo completely: the corpus, derived artifacts, and standing orders are all removed. Irreversible.")
  .argument("<decidedBy>", "who decided to end this duo")
  .option("--yes", "actually delete everything (without it, this only describes what would be deleted)")
  .action((decidedBy: string, options: { yes?: boolean }) => {
    const config = loadConfig();
    try {
      const result = runEnd(decidedBy, options.yes === true, config);
      const total = result.storePaths.length + result.duoDirPaths.length;
      if (total === 0) {
        console.log("Nothing to end — no store and no derived output exist.");
        return;
      }
      if (!result.confirmed) {
        console.log(`Would delete ${result.storePaths.length} file(s) under "${result.storeDataDir}" and ${result.duoDirPaths.length} file(s) under "${result.duoDir}".`);
        console.log("Re-run with --yes to actually delete everything. This cannot be undone.");
        return;
      }
      console.log(`Ended by ${decidedBy}. Deleted ${result.storePaths.length} file(s) under "${result.storeDataDir}" and ${result.duoDirPaths.length} file(s) under "${result.duoDir}".`);
      console.log("Nothing recoverable remains.");
    } catch (error) {
      reportError(error);
    }
  });

// #62's handover pack: assembled entirely from what #23/#24/#27/#28/#29/#32
// already derived — recurring questions, standing orders with evidence,
// refusals, thread activity, and open (unresolved) escalations. Reviewed
// and cut before anything is shared (AC2); the draft lives in the store's
// own gitignored data directory, never in the git-tracked duoDir, since an
// unreviewed pack may still hold something personal or inappropriate.
const handoverCommand = continuityCommand
  .command("handover")
  .description("A handover pack assembled from evidence — reviewed and cut before anything is shared");

function printHandoverSummary(pack: ReturnType<typeof runHandoverGenerate>): void {
  console.log(`Handover draft generated at ${pack.generatedAt}.`);
  console.log(
    `Recurring questions: ${pack.recurringQuestions.length} · Standing orders: ${pack.standingOrders.length} · ` +
      `Refusals: ${pack.refusals.length} · Thread activity: ${pack.askerActivity.length} · Open threads: ${pack.openThreads.length}`,
  );
  if (pack.gaps.length > 0) {
    console.log("What this pack could not cover:");
    for (const gap of pack.gaps) {
      console.log(`  - ${gap}`);
    }
  }
  console.log('Review the draft, cut anything with `duo continuity handover cut <itemId>`, then `duo continuity handover share <outputPath>`.');
}

handoverCommand
  .command("generate")
  .description("Assemble (or refresh) the handover draft from current derived data, carrying forward any earlier cuts")
  .action(() => {
    const config = loadConfig();
    try {
      printHandoverSummary(runHandoverGenerate(config));
    } catch (error) {
      reportError(error);
    }
  });

handoverCommand
  .command("cut")
  .description("Mark one item excluded from the handover draft by its id — reversible by hand-editing the draft file back")
  .argument("<itemId>", "the item id to exclude (as shown by `generate`, or in the draft file)")
  .action((itemId: string) => {
    const config = loadConfig();
    try {
      const pack = runHandoverCut(itemId, config);
      console.log(`Cut "${itemId}" from the handover draft.`);
      printHandoverSummary(pack);
    } catch (error) {
      reportError(error);
    }
  });

handoverCommand
  .command("share")
  .description("The one explicit act that produces a shareable document — renders the current draft, minus every cut item, to <outputPath>")
  .argument("<outputPath>", "where to write the final handover document")
  .action((outputPath: string) => {
    const config = loadConfig();
    try {
      const summary = runHandoverShare(outputPath, config);
      console.log(`Handover shared to ${summary.outputPath} at ${summary.sharedAt}.`);
      console.log(
        `Included: ${summary.includedCounts.recurringQuestions} recurring question(s), ` +
          `${summary.includedCounts.standingOrders} standing order(s), ${summary.includedCounts.refusals} refusal(s), ` +
          `${summary.includedCounts.askerActivity} thread(s), ${summary.includedCounts.openThreads} open thread(s). ` +
          `Cut before sharing: ${summary.excludedCount}.`,
      );
    } catch (error) {
      reportError(error);
    }
  });

// Role duos (docs/concept.md §12, epic e13): seeded from the real decisions
// of everyone who has held a post, not one person's corpus — a hand-authored
// definition file names the holders; #72 is the seeding step itself.
const roleDuoCommand = program
  .command("role-duo")
  .description("A duo for a role — seeded from the standing orders of everyone who has held the post, with consent");

function printRoleDuoSeed(seed: ReturnType<typeof runRoleDuoSeed>): void {
  console.log(`Role duo "${seed.roleName}" (${seed.roleId}) seeded at ${seed.seededAt}`);
  console.log(seed.basisStatement);
  console.log(`Current holder: ${seed.currentHolderId}`);
  if (seed.standingOrders.length === 0) {
    console.log("No standing orders yet.");
  } else {
    console.log(`Standing orders (${seed.standingOrders.length}):`);
    for (const order of seed.standingOrders) {
      console.log(`  [${order.topicLabel}] ${order.text}`);
      console.log(`    — established by ${order.holderName} on ${order.establishedAt}`);
    }
  }
  if (seed.conflicts.length > 0) {
    console.log(`Conflicts (${seed.conflicts.length}) — not synthesised into one rule, the current holder resolves them:`);
    for (const conflict of seed.conflicts) {
      console.log(`  [${conflict.topicLabel}]`);
      for (const position of conflict.positions) {
        console.log(`    - ${position.holderName} (${position.establishedAt}): ${position.text}`);
      }
    }
  }
  if (seed.excludedHolders.length > 0) {
    console.log(`Excluded holders (${seed.excludedHolders.length}):`);
    for (const excluded of seed.excludedHolders) {
      console.log(`  ${excluded.holderName}: ${excluded.reason}`);
    }
  }
}

roleDuoCommand
  .command("seed")
  .description("Seed (or re-seed) a role duo from its definition file's consenting holders' active rules")
  .argument("<definitionPath>", "path to the role duo's hand-authored definition JSON file")
  .action((definitionPath: string) => {
    try {
      printRoleDuoSeed(runRoleDuoSeed(definitionPath));
    } catch (error) {
      reportError(error);
    }
  });

roleDuoCommand
  .command("withdraw")
  .description("Record a holder's withdrawal of consent and re-seed immediately, removing their material and any rule resting only on it")
  .argument("<definitionPath>", "path to the role duo's definition JSON file")
  .argument("<holderId>", "the holder withdrawing consent")
  .action((definitionPath: string, holderId: string) => {
    try {
      printRoleDuoSeed(runRoleDuoWithdraw(definitionPath, holderId));
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
const evalCommand = program
  .command("eval")
  .description("Offline evaluation: draft quality on held-out data (#35), and the relevance gate's precision/recall (#36)");

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

evalCommand
  .command("gate")
  .description("Score the real relevance gate against the hand-labelled mention set in eval/gate-labels.json (#36)")
  .action(() => {
    const config = loadConfig();
    try {
      const report = runEvalGate(config);
      console.log(`${report.total} labelled mention(s): precision ${report.precision.toFixed(3)}, recall ${report.recall.toFixed(3)}.`);
      console.log(
        `TP ${report.truePositives} / FP ${report.falsePositives} / TN ${report.trueNegatives} / FN ${report.falseNegatives}.`,
      );
      console.log("Coverage by mention type:");
      for (const [mentionType, count] of Object.entries(report.coverageByMentionType).sort()) {
        console.log(`  ${mentionType}: ${count}`);
      }
      if (report.underrepresentedMentionTypes.length > 0) {
        console.log(
          `Under-represented (fewer than the labelled set can score reliably): ${report.underrepresentedMentionTypes.join(", ")}`,
        );
      }
      assertPrecisionFloor(report, config.eval.gatePrecisionFloor);
      console.log(`Precision floor (${config.eval.gatePrecisionFloor}) met.`);
    } catch (error) {
      reportError(error);
    }
  });

// The Jev typed-decision spike (docs/plans/2026-09-20-1759-spike-jev-typed-decisions-plan.md):
// staged evals against the hosted Jev gateway — synthetic fixtures only,
// refusals and store content never leave the machine — then a written
// verdict. Nothing here touches production paths.
const jevCommand = evalCommand
  .command("jev")
  .description("The Jev typed-decision spike: staged evals (stage1 gate head-to-head, stage2 trace replay) and a written verdict");

jevCommand
  .command("stage1")
  .description(
    "Score Jev against the deterministic gate on the labelled set plus multi-way accuracy; on an R5 pass, timing/cost and the Ollama reference",
  )
  .action(async () => {
    const config = loadConfig();
    try {
      // The adapter is constructed at this process boundary on purpose: a
      // missing key surfaces as a ProviderConfigError naming DUO_JEV_API_KEY
      // before any fixture loads or request is built.
      const provider = createJevProvider(config);
      const report = await runEvalJevStage1(config, provider);
      const jev = report.jev;
      const multiway = report.multiway;
      if (jev && multiway) {
        console.log(
          `Stage 1 quality: ${jev.total} labels — precision ${jev.precision.toFixed(3)}, recall ${jev.recall.toFixed(3)}; ` +
            `multi-way accuracy ${multiway.accuracy.toFixed(3)} (${multiway.correctCount}/${multiway.total}).`,
        );
        console.log(`Jev marked ${jev.answerableCount}/${jev.total} answerable.`);
      }
      if (report.timing?.status === "complete") {
        console.log(
          `Timing: mean ${report.timing.meanMsPerDecision?.toFixed(0)} ms, median ${report.timing.medianMsPerDecision?.toFixed(0)} ms ` +
            `per decision; $${report.timing.totalDollars?.toFixed(6)} total.`,
        );
      }
      if (report.reference?.status === "complete") {
        console.log(`Ollama reference: accuracy ${report.reference.accuracy?.toFixed(3)} over ${report.reference.total} question(s).`);
      }
      if (report.refusalsLoaded > 0) {
        console.log(REFUSALS_PARITY_CAVEAT(report.refusalsLoaded));
      }
      console.log(`Report persisted to ${stage1ReportPath(config.jev.runtimeDir)}.`);
      // The full report prints before the R5 assertion — a failed run still
      // reports its numbers (the `duo eval gate` ordering).
      assertStage1QualityPass(report);
      console.log("R5 met: Jev's precision is at or above the deterministic gate's on the same labels.");
    } catch (error) {
      reportError(error);
    }
  });

jevCommand
  .command("stage2")
  .description("Replay the synthetic navigation traces per-step, gated on a passing persisted stage-1 report")
  .action(async () => {
    const config = loadConfig();
    try {
      // The gate runs before the provider is constructed, so an ungated
      // invocation names the gate it failed, not the missing key.
      requireStage1Pass(config.jev.runtimeDir);
      const provider = createJevProvider(config);
      const report = await runEvalJevStage2(config, provider);
      console.log(
        `Stage 2 replay: step accuracy ${report.stepAccuracy.toFixed(3)} (${report.correctSteps}/${report.totalSteps} steps), ` +
          `${report.completedTraces}/${report.totalTraces} trace(s) completed.`,
      );
      console.log(`Report persisted to ${stage2ReportPath(config.jev.runtimeDir)}.`);
    } catch (error) {
      reportError(error);
    }
  });

jevCommand
  .command("verdict")
  .description("Assemble verdict.md from the persisted stage-1/stage-2 reports — aggregate fields only")
  .action(() => {
    const config = loadConfig();
    try {
      const result = runJevVerdict(config);
      console.log(result.markdown);
      console.log(`Verdict written to ${result.path}.`);
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

// T2 reversible internal actions (docs/concept.md §6, #58): the small
// mechanical things run without asking once granted, always announced,
// always undoable — a target that turns out not to be revertible here
// escalates as T3 instead of running unrecoverably.
actionsCommand
  .command("perform")
  .description("Run a granted T2 action if it's genuinely reversible here; escalates instead of running otherwise (#58 AC1/AC3)")
  .requiredOption("--action <actionId>", "the T2-registered action's id")
  .requiredOption("--topic <topicId>", "the topic this concerns")
  .requiredOption("--description <text>", "what this action does, in plain words")
  .option("--not-revertible", "this specific target cannot actually be undone here — escalates as T3 instead of running (#58 AC3)")
  .action((options: { action: string; topic: string; description: string; notRevertible?: boolean }) => {
    const config = loadConfig();
    try {
      const outcome = runActionsPerform(options, config);
      if (outcome.status === "performed") {
        console.log(outcome.announcement);
      } else if (outcome.status === "escalated") {
        console.log(`${outcome.reason} Pending action [${outcome.pendingAction.id}] awaits the owner.`);
      } else {
        console.error(`Failed: ${outcome.error}. Recorded as [${outcome.record.id}]; nothing partial was left in place, and this is escalated to you.`);
        process.exitCode = 1;
      }
    } catch (error) {
      reportError(error);
    }
  });

actionsCommand
  .command("undo")
  .description("Undo an active reversible action, restoring the prior state completely (#58 AC2)")
  .argument("<id>", "the reversible action's id, printed by `duo actions perform`")
  .action((id: string) => {
    const config = loadConfig();
    try {
      const record = runActionsUndo(id, config);
      console.log(`Reverted [${record.id}]: ${record.description}.`);
    } catch (error) {
      reportError(error);
    }
  });

actionsCommand
  .command("reversible")
  .description("List every reversible action performed, and whether it's still active, reverted, or failed")
  .action(() => {
    const config = loadConfig();
    try {
      const records = runActionsListReversible(config);
      if (records.length === 0) {
        console.log("No reversible action performed yet.");
        return;
      }
      for (const record of records) {
        console.log(`[${record.id}] (${record.status}) ${record.description}`);
      }
    } catch (error) {
      reportError(error);
    }
  });

actionsCommand
  .command("pending")
  .description("List every action escalated to the owner — a T2 that couldn't run autonomously, or a T3 draft-and-approve item")
  .option("--status <status>", `narrow to one status: ${PENDING_ACTION_STATUSES.join(", ")}`)
  .action((options: { status?: string }) => {
    const config = loadConfig();
    if (options.status && !(PENDING_ACTION_STATUSES as readonly string[]).includes(options.status)) {
      reportError(new Error(`--status must be one of: ${PENDING_ACTION_STATUSES.join(", ")}`));
      return;
    }
    try {
      const items = runActionsListPending(options.status as (typeof PENDING_ACTION_STATUSES)[number] | undefined, config);
      if (items.length === 0) {
        console.log("Nothing pending.");
        return;
      }
      for (const item of items) {
        console.log(`[${item.id}] ${item.tier} (${item.status}) ${item.reasoning} — topic ${item.topicId}`);
      }
    } catch (error) {
      reportError(error);
    }
  });

// T3 binding internal actions (docs/concept.md §6, #59): every binding
// action starts as draft-and-approve — no T3 action is autonomous on
// first grant, and this codebase never lets a promoted trust-grid cell
// skip the tap either (see src/actions/binding.ts's own doc comment).
actionsCommand
  .command("bind")
  .description("Stage a T3 action for the owner's one-tap approval. Nothing runs until `duo actions approve` (#59 AC1)")
  .requiredOption("--action <actionId>", "the T3-registered action's id")
  .requiredOption("--topic <topicId>", "the topic this concerns")
  .requiredOption("--reasoning <text>", "why the duo believes this should happen")
  .option("--commits-to <text>", "what the owner is being committed to — a date, a deliverable (#59 AC3)")
  .option("--expires-in-hours <n>", "hours before this expires unapproved (default 24, #59 AC2)", (value) => Number(value))
  .action((options: { action: string; topic: string; reasoning: string; commitsTo?: string; expiresInHours?: number }) => {
    const config = loadConfig();
    try {
      const pending = runActionsBind(
        { actionId: options.action, topicId: options.topic, reasoning: options.reasoning, commitsTo: options.commitsTo, expiresInHours: options.expiresInHours },
        config,
      );
      console.log(`Staged [${pending.id}] for approval (expires ${pending.expiresAt}). Nothing happens until \`duo actions approve ${pending.id}\`.`);
    } catch (error) {
      reportError(error);
    }
  });

actionsCommand
  .command("approve")
  .description("The owner's one-tap approval — the only way a pending T2/T3 action ever executes (#59 AC1/AC3)")
  .argument("<id>", "the pending action's id")
  .action((id: string) => {
    const config = loadConfig();
    try {
      const approved = runActionsApprove(id, config);
      console.log(approved.announcement);
    } catch (error) {
      reportError(error);
    }
  });

actionsCommand
  .command("expire")
  .description("Sweep every pending action past its window to expired, executing nothing (#59 AC2)")
  .action(() => {
    const config = loadConfig();
    try {
      const expired = runActionsExpire(config);
      if (expired.length === 0) {
        console.log("Nothing expired.");
        return;
      }
      for (const item of expired) {
        console.log(`[${item.id}] expired unapproved: ${item.reasoning}`);
      }
    } catch (error) {
      reportError(error);
    }
  });

actionsCommand
  .command("retract")
  .description("Retract an already-approved commitment (#59 AC3)")
  .argument("<id>", "the approved action's id")
  .action((id: string) => {
    const config = loadConfig();
    try {
      const retracted = runActionsRetract(id, config);
      console.log(`Retracted [${retracted.id}]: ${retracted.reasoning}.`);
    } catch (error) {
      reportError(error);
    }
  });

actionsCommand
  .command("stats")
  .description("Approval volume and rate — so approval fatigue on a topic is visible, not quietly ignored (#59 AC4)")
  .action(() => {
    const config = loadConfig();
    try {
      const stats = runActionsStats(config);
      console.log(
        `${stats.totalCreated} staged total — ${stats.pendingCount} pending, ${stats.approvedCount} approved, ` +
          `${stats.expiredCount} expired, ${stats.retractedCount} retracted. Approval rate: ${(stats.approvalRate * 100).toFixed(0)}%.`,
      );
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
