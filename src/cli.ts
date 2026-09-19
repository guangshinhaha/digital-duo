#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig } from "./config.js";
import { runAsk } from "./commands/ask.js";
import { runImportClaude, runImportPaste } from "./commands/import.js";
import { runInit } from "./commands/init.js";
import { runPurge } from "./commands/purge.js";
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

const importCommand = program.command("import").description("Import records from a source into the store");

importCommand
  .command("claude")
  .description("Import a Claude data export (conversations.json) into the store")
  .argument("<path>", "path to the Claude export JSON file")
  .action((path: string) => {
    const config = loadConfig();
    try {
      const summary = runImportClaude(path, config);
      console.log(
        `Imported ${summary.written} record(s) (${summary.skipped} already present) from ` +
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
      console.log(`Imported ${summary.written} record(s) (${summary.skipped} already present).`);
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
