#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig } from "./config.js";
import { runAsk } from "./commands/ask.js";
import { runStatus } from "./commands/status.js";

const program = new Command();

program.name("duo").description("Digital Duo CLI").version("0.1.0");

program
  .command("status")
  .description("Print the configured provider, store location, and whether the store exists")
  .action(() => {
    const config = loadConfig();
    console.log(runStatus(config));
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
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
