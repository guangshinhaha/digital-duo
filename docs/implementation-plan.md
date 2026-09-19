# Digital Duo — Implementation Plan

> Execution plan for the 72-issue backlog. Written 2026-09-19 after the #16 calibration run.
> Resume point tracked at the bottom — check there first.

## 1. The dependency-corrected wave plan

While building this plan, a real bug surfaced in the backlog: **#9 and #11 depended on each
other** (a cycle from the original linking script). Fixed — #11 (trust grid) only needs stable
topic IDs from #3 to be *built*; it only needs #9 (public answering) to be *exercised*
end-to-end later. The fix freed real parallelism: the trust grid and the action ladder no
longer wait for phase 2, and start right after derivation.

```
W0  e1  foundations
W1  e2  ingest
W2  e3 derivation │ e10 permissions │ e64 shared-duos      ← parallel epics
W3  e4 mirror │ e5 drafting │ e11 trust                    ← parallel epics
W4  e6 eval │ e7 corrections │ e8 slack │ e12 actions       ← parallel epics
W5  e9  public-answering
W6  e13 role-duos
```

### Per-wave issue sequence

| Wave | Sequence |
|---|---|
| **W0** `e1` | #16 → #65 → #17. *(#14, #15 are conversations, not code — standing spikes, non-blocking under the G1/G2 defaults below.)* |
| **W1** `e2` | #18 → **#19 ∥ #20** → #21. *(#22 blocked on #15.)* |
| **W2** | `e3`: #23→#24→#25→#26 · `e10`: #48→#49→#50→#51 · `e64`: #67→#68→**#69∥#70**→#71 |
| **W3** | `e4`: #27→#28→#29→#30 · `e5`: #31→**#66**→#33→#32→#34 · `e11`: #52→#53→#54→#55 |
| **W4** | `e6`: #35→#36 · `e7`: #37→#38→#39 · `e8`: #40→#41→#42 *(blocked on #15)* · `e12`: #56→#60→#57→#58→#59 |
| **W5** `e9` | #43→#44→#45→**#46∥#47** |
| **W6** `e13` | #72→#61→#62→#63 |

**Why W0–W2 stay sequential even across "parallel" epics:** they build the same skeleton.
Concurrent `lfg` pipelines don't coordinate with each other, so parallel branches there would
just collide. Real concurrency (separate worktrees, several `lfg` runs at once) becomes safe
from W3, once epics touch more disjoint subsystems.

## 2. Locked execution decisions

- **Concurrency**: sequential, one issue at a time, through W2. Parallel worktrees from W3.
- **Merge policy**: merge immediately once the pipeline's own review step passes. No CI gate —
  there is no CI configured in this repo. This is a deliberate choice, not a placeholder.
- **G1 default (inference provider)**: local-only via Ollama, behind the abstracted provider
  interface (#16 shipped this). Revisit the real provider decision at #14 later; swapping the
  implementation is a config change, not a rewrite.
- **G2 (Slack access)**: unresolved. #22 and all of epic `e8` (Slack) stay blocked until #15
  settles.
- **Cross-model review**: kept conservative. Running fully autonomous with nobody watching, the
  pipeline's review stages default to in-process review rather than sending repo content to a
  third-party model — consistent with `docs/concept.md` §6 ("anything external or irreversible
  is never autonomous"). This costs nothing to keep and matters more once real corpus data is
  involved, so it's locked in for the rest of the run rather than re-decided per issue.

## 3. Calibration: what #16 showed

One foundational, appropriately-scoped task issue through the full `lfg` pipeline (plan →
build → multi-persona review → simplify → ship):

- **~39 minutes wall-clock, 217 tool calls, ~525k tokens.**
- Real review value: caught a genuine bug (an env var could bypass the provider registry guard
  via `Object.prototype`) and a real gap (malformed Ollama JSON threw a raw `SyntaxError`
  instead of a clean error) — both cross-corroborated by independent reviewers, fixed, and
  covered by regression tests before merge.
- CI-babysit resolved trivially and correctly (no `.github/workflows` exists, so it reported
  zero actionable backlog rather than looping on a check that will never appear).

Extrapolated flat across 72 issues: **tens of millions of tokens, multi-day wall-clock**, even
with parallelism from W3 on — parallelism cuts wall-clock, not total spend. That rate is fine
for the 21 story-shaped issues, where judgment calls and ambiguous acceptance criteria justify
the full multi-persona ceremony. It is overkill for the 29 narrowly-scoped task issues, which
is what #16 itself was.

## 4. Pacing policy for the remaining 71 issues

**Story-shaped issues (`story` label, 21 of them): full `lfg`, as run for #16.** No change.

**Task-shaped issues (`task` label, 29 of them): a lighter path.** Still autonomous, still one
PR per issue, still auto-merged — without the full plan-artifact and multi-persona review
ceremony on work that doesn't need it:

1. `ce-work` directly against the issue's acceptance criteria (a narrowly-scoped task with
   Given-When-Then criteria doesn't need `ce-plan`'s separate planning artifact).
2. One straightforward `ce-code-review` pass (`mode:agent`) — not the full adversarial
   multi-persona routing `lfg` uses.
3. Apply findings, then `ce-commit-push-pr`.
4. Merge immediately per the policy in §2. No `ce-babysit-pr` needed while there is no CI.

**Epics with unresolved gating issues stay skipped, not run at reduced rigor.** #22 and
`e8` (Slack) wait for #15 regardless of pacing policy.

## 5. Resume point

**Done:**
- #16 (PR [#73](https://github.com/guangshinhaha/digital-duo/pull/73), merged, squash commit `4fd79b9`).
- #65 (PR [#74](https://github.com/guangshinhaha/digital-duo/pull/74), merged, squash commit
  `52a7181`) — lighter path: `src/duo/` (`Owner`, `KnowledgeSource`, `Duo` entity,
  `requireHumanOwner`, definition validation), 15 tests, zero code-review findings. Not yet
  wired into the CLI — nothing there reads an owner yet, so there was nothing to retrofit.
- #17 (PR [#77](https://github.com/guangshinhaha/digital-duo/pull/77), merged, squash commit
  `02f51c7`) — lighter path: `src/store/` (AES-256-GCM encryption at rest over a real
  `node:sqlite` database, passphrase generation/persistence via a gitignored keyfile),
  `duo init` and `duo purge --yes`/`duo purge` (describe-then-refuse without confirmation), 70
  tests. One review finding, fixed before merge: a `DUO_STORE_PATH` with no directory component
  made `dirname()` resolve to the cwd, so an unguarded `duo purge --yes` could delete the whole
  project or home directory; added a guard (`assertSafeDataDir`) that refuses cwd/home/root as
  the data directory before touching disk. No ingest pipeline yet — that's #18, next.
- #18 (PR [#79](https://github.com/guangshinhaha/digital-duo/pull/79), merged, squash commit
  `f4d69f3`) — lighter path: `src/ingest/record.ts` (the `IngestRecord` type per
  `import-adapters.md` §2 — named to avoid shadowing TS's built-in `Record<K,V>` — plus
  boundary validation and content-hashed ids) and `src/ingest/record-store.ts` (`writeRecords`/
  `getRecord`/`countRecords`/`searchRecords` over a `records` table and an FTS5 `records_fts`
  index, ranked via bm25). Extended `src/store/store.ts` with `withDatabase()`, the shared
  decrypt/run/re-encrypt-on-success helper #17 anticipated. 91 tests. One review finding, fixed
  before merge: FTS5's query grammar parses characters like `-` as operators, so a raw search
  string such as `nonexistent-term-xyz` threw `no such column: term` instead of returning no
  results; fixed by tokenizing the query and quoting each word as a literal phrase before it
  reaches `MATCH`. No adapter yet — that's #19, next.
- #19 (PR [#81](https://github.com/guangshinhaha/digital-duo/pull/81), merged, squash commit
  `77c1acf`) — lighter path: `src/ingest/adapters/claude-export.ts` and `.../paste.ts`
  (`duo import claude <path>` / `duo import paste <path>`), both producing `IngestRecord`s with
  `kind: "my_thinking"` and `author` distinguishing `me`/`assistant`; `src/ingest/
  work-relevance.ts`, a deterministic keyword heuristic (documented as a v1 stand-in for the
  LLM classification `v1-tech-design.md` §1.5 describes eventually) that filters non-work
  conversations out before they become a record (AR-11). Scope decision, documented in the PR
  and in `claude-export.ts`'s module comment: "Claude export archive" is the `conversations.json`
  a Claude data export contains, not zip-container parsing — no zip library exists in this repo,
  and adding one for a task-shaped issue was judged out of scope. 112 tests. Self-review found no
  fixable issues beyond that scope decision. No embeddings/retrieval yet — that's #20, next.

**Next:** #20 (W1, epic `e2` — ingest) — check its label before assuming which path applies.

To resume: work straight through the wave sequence in §1 using the policy in §4, without
re-deriving this plan. Stop only at a GATE/blocked stop `lfg` (or the lighter path) can't
resolve itself, or at a wave boundary worth a status check.
