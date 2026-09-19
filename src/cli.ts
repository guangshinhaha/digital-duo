#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig } from "./config.js";
import { runAsk } from "./commands/ask.js";
import { runDerivePairs, runDeriveRules, runDeriveSync, runDeriveTopics, runDeriveVoice } from "./commands/derive.js";
import { runEmbed } from "./commands/embed.js";
import { runImportClaude, runImportPaste } from "./commands/import.js";
import { runInit } from "./commands/init.js";
import { runAskAsAsker, runEnforceCeiling } from "./commands/permissions.js";
import { runPurge } from "./commands/purge.js";
import { runSearch } from "./commands/search.js";
import { runStatus } from "./commands/status.js";

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
