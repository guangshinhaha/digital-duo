import { createInterface } from "node:readline";

/** Thrown when serving mode has no way to get the passphrase: `DUO_PASSPHRASE` is unset and stdin isn't a TTY to prompt on (e.g. running under a process manager with no interactive session). */
export class NoPassphraseSourceError extends Error {
  constructor() {
    super(
      "duo serve needs the store passphrase and DUO_PASSPHRASE is unset. " +
        "Set DUO_PASSPHRASE, or run `duo serve` from an interactive terminal to be prompted.",
    );
    this.name = "NoPassphraseSourceError";
  }
}

/**
 * Prompts for the passphrase on stdin with the terminal's local echo
 * disabled, so it never lands in a scrollback buffer or a terminal
 * recording. `readline`'s own echo-suppression (`terminal: false` plus
 * manual writes) is used rather than a third-party prompt library, to
 * keep this dependency-free.
 */
function promptForPassphrase(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new NoPassphraseSourceError());
      return;
    }
    process.stdout.write("Store passphrase: ");
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // @ts-expect-error — readline's own `_writeToOutput` hook, the
    // documented (if internal) way to suppress echo for a single prompt
    // without pulling in a masking-input dependency.
    rl._writeToOutput = () => {};
    rl.question("", (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

/**
 * Resolves the passphrase for serving mode. Deliberately not
 * `resolveOrCreatePassphrase` (`store/passphrase.ts`): that function falls
 * back to reading `data/.passphrase` off disk, which is the exact
 * trade `client-tech-design.md` §1.3 forbids once a socket is listening —
 * encryption at rest defends a stolen disk, not a listening port. This
 * function's only sources are `DUO_PASSPHRASE` and an interactive prompt;
 * there is no disk fallback for it to ever regress into.
 */
export async function resolvePassphraseForServing(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const fromEnv = env.DUO_PASSPHRASE;
  if (fromEnv) {
    return fromEnv;
  }
  return promptForPassphrase();
}
