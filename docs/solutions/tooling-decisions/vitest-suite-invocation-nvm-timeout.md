---
title: Run the vitest suite under nvm 22.22.3 with a CLI-only --testTimeout flag
date: 2026-09-20
category: tooling-decisions
module: test suite tooling (vitest.config.ts, package.json scripts) and Node environment (nvm 22.22.3 for node:sqlite FTS5)
problem_type: tooling_decision
component: testing_framework
severity: medium
applies_when:
  - running the full vitest suite on this shared, loaded 8-core macOS machine
  - any node/npm invocation in this repo, which must run under nvm 22.22.3 for node:sqlite FTS5
  - deciding between a targeted test run (iteration loop) and the full-suite run (pre-ship gate)
  - tempted to move --testTimeout into vitest.config.ts or the npm test script
  - checking types before shipping via npm run typecheck (tsc --noEmit, src only)
tags: [vitest, test-timeout, nvm, node-sqlite, fts5, test-suite, macos]
---

# Run the vitest suite under nvm 22.22.3 with a CLI-only --testTimeout flag

## Context

digital-duo's vitest suite is run on a loaded, shared 8-core macOS machine, and three environmental factors compound there. First, the suite is subprocess-heavy: 26 test files exercise the CLI through `runCli` (`test/helpers/run-cli.ts:29`), which spawns the CLI entry (`src/cli.ts`) through the `tsx` binary as a real child process (`test/helpers/run-cli.ts:34`) precisely to cross the same process boundary a real invocation does. Under CPU load, tsx startup plus transpile in a child process can exceed vitest's default 5s per-test timeout — there is no override in the tree: `vitest.config.ts:3-10` sets only `root`, `include`, `environment`, and `setupFiles`, and the `test` script is bare `vitest run` (`package.json:16`). Second, the Node version is load-bearing: the repo's `node:sqlite` FTS5 usage breaks under both Homebrew node (23.11.0, compiled without FTS5) and old nvm node 18 (predates `node:sqlite`), which commit 8a39388 ("fix(env): pin Node 22.22.3 for FTS5 — full suite green again (957/957)") diagnosed after 325/921 local failures that looked like a code regression but were environmental. Third, the full suite is slow enough (297.18s wall for 113 files / 1074 tests, aggregate 1978.87s across workers — session measurement, 2026-09-20, under load) that running it as the inner loop wastes the session.

Dead ends from the environment triage (session history):

- Homebrew node 23.11.0 was the version an earlier plan doc recommended, and it is the broken build — it has `node:sqlite` but no FTS5. The working builds are nvm v22.22.2 and v22.22.3 (session history build-matrix probe); the pin chose .3.
- The PATH-default nvm node at the time was v18.20.8, which has no `node:sqlite` module at all — that default produced the original 325 failures (session history).
- Bumping `engines.node` in `package.json` alone does not update `package-lock.json`'s embedded engines; the lockfile needed a separate refresh (commit 5e98b48, "chore: sync package-lock.json engines with package.json (>=22.5)") (session history).

## Guidance

1. Pin the interpreter before any node/npm run: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 22.22.3`. The pin is recorded in the tree — `.nvmrc:1` is `22.22.3` and `package.json:7-9` declares `"engines": { "node": ">=22.5" }` — but nothing forces it; the shell's PATH-default (Homebrew or stale nvm) wins unless you activate nvm explicitly.
2. Full-suite invocation is `npx vitest run --testTimeout=60000`. The 60s timeout is a per-invocation CLI flag only. Committing `testTimeout` to `vitest.config.ts` is rejected: the accommodation is machine- and load-specific, and a committed raise would mask genuinely hanging tests on every other machine. The config's absence of the key (`vitest.config.ts:3-10`) is the intended steady state.
3. Iterate on targeted files — `npx vitest run test/ask.test.ts test/purge.test.ts ...` — and treat the ~5-minute full run as the pre-ship gate, not the feedback loop.
4. Typecheck separately with `npm run typecheck` (`tsc --noEmit`, `package.json:17`), and remember it covers `src/` only: `tsconfig.json:17-18` includes `src/**/*.ts` and excludes `test`, so type errors in test files are invisible to it and surface only when vitest runs them.

## Why This Matters

Without the pin and the flag, failures appear that are not the code's fault and get misread as regressions. The wrong Node produces hard load errors — commit 8a39388 records that the 325/921 failures came from Homebrew node 23.11.0 lacking FTS5 and PATH-default nvm node 18 predating `node:sqlite`, and that the suite went green (957/957 at that commit) under nvm v22.22.3 with no code change. The missing timeout flag produces the softer failure: spawned-CLI tests (`runCli` consumers) flake under load against vitest's 5s default, inviting a hunt through the CLI code for a hang that is actually scheduler contention. Committing the fix would trade that local noise for global blindness to real hangs. Running the full suite as the inner loop costs surprise 5-minute waits (297.18s measured, 2026-09-20) per iteration; and trusting `npm run typecheck` as full coverage hides test-file type errors entirely, since `tsconfig.json:18` excludes `test`. The engines field is a floor (`>=22.5`, `package.json:8`), not the FTS5-exact pin — `node -v` under Homebrew satisfies engines and still breaks, so the check must be habitual, not delegated. Across the same machine's PR chains, the working pattern was consistent: full suite as the per-PR merge gate under pinned Node, targeted runs only for spot checks (session history).

## When to Apply

- On this machine, and on any loaded shared machine where subprocess-spawning test suites (spawned-CLI tests like digital-duo's `runCli`, `test/helpers/run-cli.ts:29`) routinely exceed vitest's 5s default under contention.
- On every session start and after any shell/env reset — the nvm activation does not persist across shells, and `.nvmrc`/`engines` do not self-enforce.
- `--testTimeout=60000` on full-suite runs specifically; targeted single-file runs usually fit the default and can omit it, though under heavy load including it is harmless.
- The full ~5-minute run as the final gate before shipping a change; targeted runs during development.
- The "typecheck misses test/" caveat whenever a change touches files under `test/`.

## Examples

Wrong — PATH-default Node, no timeout, full suite as the loop:

```
$ npm test                          # = "vitest run" (package.json:16): no timeout flag anywhere
# under Homebrew node 23.11.0 → node:sqlite FTS5 load errors (per commit 8a39388's diagnosis)
# under the right Node but load → spawned-CLI tests flake against the 5s vitest default
# and it's the full ~5-minute run every iteration
```

Right — pinned interpreter, flagged full run as the gate:

```
$ export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 22.22.3
$ npx vitest run test/mentions-cli.test.ts        # inner loop: targeted file(s)
$ npx vitest run --testTimeout=60000              # pre-ship gate (297.18s / 113 files / 1074 tests, session-measured 2026-09-20)
$ npm run typecheck                                # src/ only — test/ excluded (tsconfig.json:18)
```

The supporting pins live in the tree and history: `.nvmrc:1` (`22.22.3`), `package.json:7-9` (`engines.node >=22.5`, synced into package-lock.json by commit 5e98b48), and commit 8a39388, which introduced the pin after the environmental-failure diagnosis.

## Related

- `docs/plans/2026-09-20-1356-feat-ask-link-tokens-plan.md` — first in-repo appearance of this rule as a verification contract (PATH-pinned nvm v22.22.3, `npx vitest run --testTimeout=60000` as the all-units shipping gate, targeted runs for iteration).
- `README.md` Development section — the durable Node/FTS5 requirement ("Run nvm use before npm test"); cross-link there rather than restating.
- `docs/implementation-plan.md` — root-cause record of the environment break (Homebrew 23.11.0 without FTS5, PATH-default node 18 predating `node:sqlite`, 957/957 green under nvm v22.22.3) and of typecheck's src-only scope.
- `docs/plans/2026-09-20-1759-spike-jev-typed-decisions-plan.md` — a later plan repeating the pinned-Node full-suite rule with bare `npm test`; this doc's invocation supersedes it on loaded machines.
- `vitest.config.ts`, `tsconfig.json`, `package.json`, `.nvmrc` — the config files the guidance governs.
- The sole prior solutions doc, `docs/solutions/best-practices/ask-token-cache-policy-immediate-revocation.md`, covers an unrelated problem (ask-token cache revocation); no cross-link.
