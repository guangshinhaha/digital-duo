import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const cliEntry = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const tsxBin = fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url));

export interface RunCliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs the duo CLI as a real subprocess via tsx, so tests exercise the same
 * process boundary (argv, exit code, stdout/stderr) a real invocation does.
 * `env` replaces the child's environment entirely (aside from PATH) so each
 * test starts from a clean, fully-known configuration.
 *
 * `stdin`, when given, is written to the child's stdin and the pipe is then
 * closed — this is what `duo draft`'s piped-thread-context reads (#32
 * AC4). When omitted, the child's stdin pipe is closed immediately with no
 * data, giving an instant, empty EOF: node's spawn creates a stdin pipe by
 * default that stays open until explicitly ended, and any command that
 * synchronously reads fd 0 (as `duo draft` does when nothing is piped in a
 * *real* terminal invocation, where stdin is a closed TTY, not an open
 * pipe) would otherwise hang forever waiting for a parent that never
 * writes to it.
 */
export function runCli(
  args: string[],
  options: { cwd: string; env: Record<string, string>; stdin?: string },
): Promise<RunCliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(tsxBin, [cliEntry, ...args], {
      cwd: options.cwd,
      env: { PATH: process.env.PATH ?? "", ...options.env },
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });

    if (options.stdin) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}
