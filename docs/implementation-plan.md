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
- #20 (PR [#83](https://github.com/guangshinhaha/digital-duo/pull/83), merged, squash commit
  `4b81915`) — lighter path: `EmbeddingProvider` + `OllamaEmbeddingProvider` (`/api/embeddings`,
  mirroring the completion provider's client), unconditional local embeddings with a real default
  model (`nomic-embed-text`) since there's no G1 gate to wait on. `src/ingest/embeddings.ts`:
  `embedRecords()` (backfills a vector per record, tagged with model+dimensions so a model change
  triggers a re-embed) and `hybridSearch()` (FTS5 fused with cosine similarity via reciprocal rank
  fusion). `duo embed` / `duo search <query>`. Scope decision: no `sqlite-vec` — brute-force
  cosine over a plain table, enough at a personal corpus's scale, no native extension dependency.
  134 tests. One review finding, fixed before merge: RRF scores by rank position only, so a
  record with *zero* real similarity to the query was still getting a small "free" boost merely
  for occupying a low rank in the vector candidate list; fixed by filtering out
  zero-and-below-similarity matches before fusion. No two-phase retention boundary yet — that's
  #21, next.
- #21 (PR [#85](https://github.com/guangshinhaha/digital-duo/pull/85), merged, squash commit
  `a07b83a`) — lighter path: `src/ingest/two-phase.ts` (`ingestRecords`). Phase A stages every
  record — including `author: "other"` text, needed for context — in its own transient encrypted
  database (`import-<random>.staging.db`, in the data directory #17's `duo purge` already
  sweeps); phase B copies only what survives the retention boundary into the retained store, then
  deletes the staging file in a `finally`. `isRetainedAcrossBoundary` states the boundary in the
  same words told to the team (v1-tech-design.md §1.4), now echoed in `duo import --help` too:
  "we keep questions put to you, we discard everything else others said." DM opt-in is a separate
  gate applied before that filter, reporting skipped-conversation counts. Retrofitted `duo import
  claude`/`duo import paste` (#19) to route through this pipeline instead of writing directly —
  a no-op filter for that source today, a real one once a multi-party source (Slack) exists. 144
  tests. Self-review found no fixable issues. **Wave W1 (epic `e2`, ingest) is now complete**;
  #22 stays skipped, blocked on #15 per the original plan.

- #23 (PR [#87](https://github.com/guangshinhaha/digital-duo/pull/87), merged, squash commit
  `658062f`) — lighter path: `src/derivation/qa-pairs.ts` (`extractQaPairs`, pure/no-DB) walks
  each thread in timestamp order, collapsing multiple owner turns on one question into a single
  pair via the last substantive answer (so multi-turn exchanges don't fragment). A second
  unanswered question arriving before the first is resolved has no deterministic answer —
  `IngestRecord` carries no per-person asker identity — so it's routed to an optional
  `Adjudicate` hook (`createLlmAdjudicator` wraps any `InferenceProvider`), falling back to the
  safe `"new_question"` default on any failure or when unconfigured; both the ambiguous and
  adjudicated counts are returned so the rate is visible. `qa_pairs` table, idempotent by
  content-hashed id; `topic_id` starts `null` for #24 to fill in. New `duo derive` command
  group, starting with `duo derive pairs`, degrading gracefully without a configured provider
  (same shape as #20's `hybridSearch`). 158 tests. Self-review found no fixable issues beyond a
  minor readability cleanup (an async IIFE simplified to a plain `if`) made before commit. No
  topic assignment yet — that's #24, next.

- #24 (PR [#89](https://github.com/guangshinhaha/digital-duo/pull/89), merged, squash commit
  `d4c5f33`) — lighter path: `src/derivation/topics.ts`. Only `qa_pairs` with `topic_id IS
  NULL` are considered on any run, so a previously-assigned pair's topic id never moves (AR-8) —
  new pairs' questions are embedded (backfilling via #20's `embedRecords`), greedily clustered by
  cosine similarity, then each cluster is matched against existing topics' centroids
  (`topic_centroids` table) before minting anything new; an unmatched cluster becomes a new
  topic surfaced for owner review rather than force-fitted. `duo/topics.json` (id/label/createdAt
  only, no vectors) is the source of truth for labels, read first every run; the DB `topics`
  table is a projection unconditionally rebuilt from it at the end of every run, so a hand-rename
  is exactly what the next run's DB reflects — matching is keyed by id and centroid, neither of
  which the file carries. Cluster labeling is best-effort LLM, falling back to a deterministic
  default (same "degrade rather than fail" shape as #23's adjudicator). New `DUO_DIR` config
  option (default `"duo"`), kept separate from the encrypted store. `duo derive topics` CLI
  command. 169 tests. Self-review found one fixable issue before commit: the empty-store/no-op
  path called `embedRecords` and then queried `record_embeddings` directly, but that first
  `embedRecords` call opens the store read-only (`mutate: false`) and its schema-creation inside
  that call is never persisted when there's nothing to embed — so a truly empty store threw "no
  such table: record_embeddings". Fixed by exporting embeddings.ts's `ensureEmbeddingSchema` and
  calling it directly in topics.ts's own read pass. Deliberately does not write back to
  `IngestRecord.topics` — record-store.ts documents records as insert-only, so topic linkage
  lives entirely on `qa_pairs.topic_id`. No rule induction yet — that's #25, next.

- #25 (PR [#91](https://github.com/guangshinhaha/digital-duo/pull/91), merged, squash commit
  `11b8f2d`) — lighter path: `src/derivation/rules.ts`. Recomputes one rule per topic from
  scratch on every run, over every `qa_pair` currently assigned to it — unlike #24's topic ids, a
  topic's consistency/support genuinely changes as evidence accumulates, so re-running updates a
  rule in place rather than just extending it. Consistency is average pairwise cosine similarity
  among a topic's answer embeddings (backfilled via #20's `embedRecords`); ≥3 supporting pairs
  and ≥0.7 average similarity promotes a `confirmed` rule, below the support threshold produces a
  `weak_signal` candidate (AR-3), at/above threshold but inconsistent produces an `inconsistent`
  record carrying its conflicting examples rather than a fabricated averaged policy. Rule text
  for the confirmed case defaults to the topic's most central answer verbatim, optionally
  LLM-phrased (best-effort, same degrade-rather-than-fail shape as #23/#24) — the inconsistent
  case is deliberately never handed to an LLM, so the disagreement itself stays visible. One rule
  per topic in v1 (`rule.id === topic.id`), documented as a deliberate simplification.
  `rule_evidence` fully replaced each run; every rule (any status) always carries at least one
  evidence row. `duo derive rules` CLI command. 179 tests. Self-review found no fixable issues.
  No file sync or voice profile yet — that's #26, next.

- #26 (PR [#93](https://github.com/guangshinhaha/digital-duo/pull/93), merged, squash commit
  `4737f7e`) — lighter path: `src/derivation/rules-sync.ts` reconciles `duo/rules/*.md` (one
  file per rule, named `<rule id>.md`, YAML frontmatter carrying id/topic/status/support/
  consistency/timestamps/evidence, markdown body) with the `rules` table — hand-edits to the
  files win, even over what #25's induction most recently computed, which is what makes an edit
  "stick" across a later re-run (sync is meant to run after induction). A rule with no file yet
  gets one materialized; a malformed file is reported by name and reason with its DB row left
  untouched and the file never deleted; a rule whose file is deleted is removed from the store
  with its evidence. A hidden `duo/rules/.sync-state.json` tracks which rule ids have ever been
  materialized, telling "never synced yet" apart from "synced, now deleted" without needing a
  migration to #25's already-shipped schema. Refactored `rules.ts`'s write path into shared
  `putRule`/`deleteRule`/`readRuleRow` helpers so induction and sync share one implementation.
  `src/derivation/voice.ts`: statistical voice profile (median length, hedge/bullet/emoji/
  greeting/sign-off rates) over the owner's own records, LLM-described register only
  (best-effort, same degrade shape as #23-25), written to `duo/voice.md` — never overwritten
  once it exists unless `--force` is passed. `duo derive sync` / `duo derive voice` CLI
  commands, completing the `derive` group. 195 tests. Self-review found no fixable issues.
  **Wave W2's epic `e3` (derivation) is now complete** — all of #23, #24, #25, #26 merged in
  order, one at a time on `main`.

- #48 (PR [#95](https://github.com/guangshinhaha/digital-duo/pull/95), merged, squash commit
  `575e665`) — lighter path: `src/ingest/record.ts` gains `CLASSIFICATION_LEVELS` (the GSCS-style
  ordered tiers `official_open` < `official_closed` < `restricted` < `confidential` < `secret`)
  and `RECORD_CLASSIFICATIONS` (those plus `"unknown"`); `IngestRecord.classification` is no
  longer `string | null` — `detectClassification` reads a marking off a record's own first line
  (anchored at the start, so "let's keep this confidential" in a message body is never mistaken
  for a marking), defaulting to `"unknown"`, never to the most permissive value.
  `src/permissions/classification.ts` (new directory, epic `e10`'s home): `isWithinCeiling`
  (ingest-time gate; `"unknown"` exempt — always retained) and `isVisibleToClearance`
  (answer-time gate for #49/#50 to build on; `"unknown"` is the *stricter* case there — it needs
  the same clearance as the top defined level, since over-classifying when unsure is the safe
  posture). `enforceClassificationCeiling` re-evaluates an existing corpus against a given
  ceiling (AC3). `DUO_CLASSIFICATION_CEILING` config, defaulting to `"official_open"`; `duo
  permissions enforce-ceiling` CLI command. Design decision, documented in the module: the
  apparent tension between AC1 ("above ceiling never written") and AC2 ("unmarked material is
  recorded") is resolved by treating ingest-time ceiling enforcement and answer-time clearance
  visibility as two different gates — unknown material is exempt from the first, strictest under
  the second. 209 tests. Self-review found no fixable issues. No asker resolution yet — that's
  #49, next.

- #49 (PR [#97](https://github.com/guangshinhaha/digital-duo/pull/97), merged, squash commit
  `ebbbbeb`) — lighter path: `src/permissions/directory.ts` (new): `AskerIdentity`, read from a
  checked-in `duo/directory.json` — the source-of-truth stand-in, same "checked-in file,
  hand-maintained" convention `duo/topics.json` already established; provisioning clearances
  stays out of scope, this only reads. `resolveAsker` matches by id case-insensitively and comes
  back `{resolved: false}` for a no-match rather than throwing; `effectiveClearance` gives an
  unresolved asker the lowest defined clearance, the most restrictive treatment (AC2).
  `src/permissions/retrieval.ts` (new): `retrieveForAsker`, the one entry point for asker-scoped
  retrieval — resolves the directory + asker *before* calling #20's `hybridSearch`, then filters
  the returned candidates immediately into `generationContext` (what may go downstream) and
  `excluded` (what matched but was filtered, and why), so there's no code path through which an
  excluded record ever reaches generation. 222 tests. Self-review found no fixable issues. No
  answering/generation or audit log yet — that's #50, next.

- #50 (PR [#99](https://github.com/guangshinhaha/digital-duo/pull/99), merged, squash commit
  `d60397a`) — **full path** (`story` label, §4): `src/permissions/answer.ts` (new):
  `answerForAsker`, the first real "the duo answers" mechanism — "(what I know) x (what I would
  tell you)", resolved before generation via #49's `retrieveForAsker`. Only `generationContext`
  (what the asker's clearance permits) ever reaches a prompt or the extractive fallback; a
  best-effort inference provider degrades to the visible records' own text when unset or
  unreachable, same shape as #23-#26. `src/permissions/audit.ts` (new): minimal insert-only audit
  log for this issue's own AC3 (question, asker, clearance applied, records used/excluded + why,
  declined, exact answer text) — only an append function is exported; #51 builds the read/
  reconstruction side. `duo permissions ask <question> --as <askerId>` CLI command. Design
  decision on the issue's own flagged open question (does declining leak that something was
  restricted?): resolved conservatively — `DECLINE_MESSAGE` is one fixed string, byte-identical
  whether nothing matched at all or everything that matched was excluded for clearance, verified
  by a test. Multi-angle review (adversarial + simplification passes, per the story path) found
  two real issues fixed before commit: a visible record's own classification marking line was
  being echoed verbatim into answers (added `stripMarkingLine` to `src/ingest/record.ts`), and
  the CLI silently swallowed retrieval's degraded-to-full-text warning (now surfaced, same as
  `duo search`). Also lifted `derive.ts`'s local best-effort-provider-resolution helper into a
  shared `tryResolveProvider` in `src/provider/registry.ts`. 242 tests. No hardened append-only
  guarantees or owner-facing read view yet — that's #51, next.

- #51 (PR [#101](https://github.com/guangshinhaha/digital-duo/pull/101), merged, squash commit
  `eed8f6a`) — lighter path: extends #50's minimal insert-only `audit_log` into a full read/
  reconstruction surface. `getAuditEntry`/`listAuditEntries` return the parsed `AuditEntry` shape
  (question, asker, clearance applied, records used/excluded + why, rules used, confidence,
  declined, exact answer text). Adds `confidence` (`"low" | "degraded" | "high"`, a coarse honest
  signal, not a calibrated probability) and `correctsEntryId` + `appendCorrection`, which records
  a correction as a brand-new entry referencing the one it corrects rather than touching it.
  Append-only enforced two ways: still no update/delete export anywhere in the module, *and*
  `ensureAuditSchema` now installs `BEFORE UPDATE`/`BEFORE DELETE` triggers on `audit_log` that
  `RAISE(ABORT)` — a database-level refusal that holds even against a future bug in this
  codebase, not only against a convenience function nobody wrote. `duo permissions audit`
  (list) / `duo permissions audit --id <id>` (one entry's full reconstruction) — the
  owner-opens-the-audit-log surface. `src/permissions/answer.ts` now computes and records
  `confidence` per answer. 253 tests. Self-review found no fixable issues beyond what the ACs
  themselves called for. **Wave W2's epic `e10` (permissions) is now complete** — all of #48,
  #49, #50, #51 merged in order, one at a time on `main`. Every issue's schema fields were
  captured on ingest (#48), resolved to a real asker+clearance before retrieval (#49), used to
  filter what an answer may draw from (#50), and everything about that answer is now
  reconstructible (#51) — this is the full permission engine v1-spec.md §3 deferred, now built
  ahead of phase 2 / public answering (wave W5's `e9`), which will be the first real consumer.

- #67 (PR [#103](https://github.com/guangshinhaha/digital-duo/pull/103), merged, squash commit
  `9e5da19`) — lighter path: `src/shared-duo/` (new directory, epic `e64`'s home), layered on the
  general `Duo` primitive #65 shipped rather than a second, parallel definition mechanism.
  `shared-duo/persona.json` — a real, checked-in persona file at the repo root, sibling to `duo/`
  (the personal duo's derived-output directory) — is the one config for Phase 1.5's bridge duo
  (concept.md §12). `loadSharedDuo`/`createSharedDuo` reuse #65's `parseDuoDefinition` for the
  general shape, then `assertHumanOwner` enforces the one constraint specific to a *shared* duo:
  loading fails, naming the duo and the owner's actual kind, unless `owner.kind === "person"` —
  the general `Duo` entity deliberately allows `role`/`none` owners for later phases (role duos,
  synthetic personas), but a shared duo has "nobody to escalate to and nobody accountable for it"
  otherwise (#67 AC2), checked at load time rather than left to whichever call reaches
  `requireHumanOwner()` first. No write path anywhere in the module — the only way the persona
  file changes is a hand-edited diff proposed and merged through version control (AC3). Scope
  decision: `knowledge.documents` stays plain strings (reusing #65's `AuthoredKnowledgeSource`
  as-is) with no per-document citation name or freshness date yet — that richer structure belongs
  to #68/#69's *answering* work, not this issue's *loading* work. 266 tests (13 new). Self-review
  found no fixable issues. Also fixed as environment setup, not a code change: this worktree's
  `node_modules` was empty (a stale checkout), which made every CLI-spawning test fail with
  `spawn .../tsx ENOENT` and the branch's initial `git checkout -b ... main` resolve to a stale
  local `main` ref three issues behind `origin/main` — the first was fixed with `npm install`, the
  second by re-basing onto `origin/main` before any commit landed. No answering, citation, or
  attribution logic yet — that's #68, next.

- #68 (PR [#105](https://github.com/guangshinhaha/digital-duo/pull/105), merged, squash commit
  `518c1e6`) — lighter path: `src/shared-duo/loader.ts` gains `assertAuthoredKnowledgeOnly`,
  refusing a persona file at load time — naming the duo and the offending kind — unless
  `knowledge.kind === "authored"`. The only `KnowledgeSource` implementation that can ever touch
  an encrypted personal store is `DerivedKnowledgeSource` (#65's `src/duo/knowledge.ts`, resolved
  from `knowledge.kind: "derived"` + a `storePath`); refusing that kind means a misconfigured
  persona file can never construct one for a shared duo, which is the store boundary #68 AC3 asks
  for, enforced by construction rather than a prompt instruction. `src/shared-duo/answer.ts`:
  `answerSharedDuo` — extractive-only over `duo.knowledge`, quoting matching documents verbatim
  and returning them as citations, or declining and naming the human owner to escalate to when
  nothing matches; no inference provider anywhere in the module, so there is no step that could
  generalise or infer a position a source doesn't state (the issue's own out-of-scope item). 274
  tests (8 new): a dynamic test creates a real encrypted personal store with a secret record and
  shows the shared duo's answer never surfaces it (and the personal store itself is left
  untouched), plus a source-level check that neither `answer.ts` nor `loader.ts` imports anything
  from `src/store/`. Self-review found one fixable issue before commit: that structural
  "no store import" test's regex matched the word `withDatabase` inside its own doc comment
  explaining the boundary, not an actual import — tightened to match only a real import/call
  pattern. No answering CLI, citation dates, or usage tracking yet — that's #69, next.

- #69 (PR [#107](https://github.com/guangshinhaha/digital-duo/pull/107), merged, squash commit
  `49c69c0`) — **full path** (`story` label, §4): `src/shared-duo/documents.ts` —
  `PublishedDocument`/`parsePublishedDocument` reads a document's title and update date off its
  own text (the `"<Title> (updated YYYY-MM-DD): <body>"` convention — the same
  read-a-marking-off-the-text idiom #48's `detectClassification` uses), so #69's citation/
  staleness needs are met with **no schema change to #65's general `Duo` primitive** —
  `knowledge.documents` stays a plain `string[]`. `isStale` flags a document not revisited in 180
  days. `src/shared-duo/loader.ts` gains `assertDocumentsAreWellFormed`, extending #67/#68's
  load-time validation chain to the new convention. `src/shared-duo/answer.ts`'s
  `answerSharedDuo` now returns per-citation title/date/staleness and writes exactly one
  usage-log entry per call, answered or declined. `src/shared-duo/usage-log.ts` +
  `src/commands/shared.ts` + `duo shared ask`/`duo shared gaps`: a durable, plain-JSON,
  owner-only log of every question asked; `unresolvedQuestionGaps` groups repeated out-of-scope
  questions by normalized text, most-repeated first (#69 AC4). Design decisions: "which surface
  first" resolved as the CLI (consistent with every other "ask" feature already shipped, and
  explicit in the issue that the epic shouldn't inherit #40's Slack block); "links to the source
  material" interpreted as a named document title, not a literal URL (these are configured
  strings, not files); "passes the question on" implemented as durable, owner-reviewable logging
  rather than a live notification, since no chat/email surface is decided yet. 304 tests (30 new).
  Multi-angle review (adversarial + simplification, per the story path) found two real issues
  fixed before commit: the usage log's default path sat under `data/`, the *personal* duo's
  store directory `duo purge` deletes wholesale — a personal purge would have silently wiped the
  shared team duo's entire usage history — moved to its own gitignored `shared-duo-runtime/`
  directory, with a regression test; and the document-date regex accepted syntactically-shaped
  but impossible calendar dates (e.g. `2026-13-45`), which `Date` rolls over silently rather than
  rejecting — added a round-trip validation so a typo fails loudly at load time. Also
  deduplicated `answerSharedDuo`'s two near-identical usage-log writes into one. No attribution
  enforcement or usage reporting yet — that's #70, next.

- #70 (PR [#109](https://github.com/guangshinhaha/digital-duo/pull/109), merged, squash commit
  `7f68472`) — **full path** (`story` label, §4): `src/shared-duo/attribution.ts`
  (`attributionLine`/`withAttribution`) — every one of `answerSharedDuo`'s three return paths
  (covered answer, out-of-scope decline, new decision decline) is wrapped in `withAttribution`
  before it's handed back, naming "the shared duo" and its owner; no parameter on
  `answerSharedDuo` and nothing read from the persona file could suppress it. `src/shared-duo/
  decision-guard.ts` (`isDecisionRequest`) — a deterministic keyword heuristic (same
  "documented v1 stand-in" idiom `work-relevance.ts` uses), checked *before* retrieval: a
  question asking the duo to decide/approve/authorize/sign off/greenlight/overrule always
  declines with a fixed message naming the owner, even when a configured document is squarely
  on-topic (AC2's key adversarial case — "approve this expense claim" never answers from the
  Expense claims document as if the duo could sign off on it). `SharedDuoAnswer.declineReason`
  distinguishes "out_of_scope" from "not_a_decision_maker"; `duo shared ask`'s decline wording
  now reflects which. 338 tests (34 new). Multi-angle review (adversarial + simplification, per
  the story path) found two real regex bugs before commit: `authoriz\b` never matched
  "authorize"/"authorized" because the trailing word boundary landed mid-word (fixed to
  `authoriz\w*`), and "green light" (space-separated) wasn't matched by
  `greenlight|green-light` alone (fixed to `green[\s-]?light`). Also caught and corrected a
  flawed test premise: `AuthoredKnowledgeSource.retrieve` matches by containment of the *query*
  in the *document*, not the reverse, so a long natural-language question is never a hit
  regardless of wording — replaced a misleading integration test with a plain unit-level
  negative case in `decision-guard`'s own tests. No usage-report/abandonment-tracking CLI yet —
  that's #71, next and last of this chain.

- #71 (PR [#111](https://github.com/guangshinhaha/digital-duo/pull/111), merged, squash commit
  `4a28e72`) — lighter path: `src/shared-duo/usage-log.ts`'s `SharedDuoUsageEntry` gains
  `askerId`, recorded via a new `duo shared ask --as <askerId>` option (defaulting to
  `"anonymous"`) — never resolved against a directory or used to filter an answer, since a
  shared duo does no per-asker permissioning at all (v1-spec.md §3); it exists solely so usage
  can be measured by who, not just how many. `src/shared-duo/usage-report.ts`
  (`buildUsageReport`): total questions, distinct/repeat askers (case-insensitively normalized,
  same convention #69's `unresolvedQuestionGaps` uses for questions), answer/escalation rate (0,
  never `NaN`, when unused), a **weekly trend** rather than one aggregate (AC1), **abandonment**
  — active use followed by `ABANDONED_AFTER_DAYS` (14) days of silence flagged with the exact
  date it happened rather than smoothed into a period average (AC2) — and **gaps**, reusing
  #69's `unresolvedQuestionGaps` exactly (AC3). The report's `summary` is exactly `"The shared
  duo is not being used."` when the log is empty, in those words (AC4). `duo shared usage` CLI
  command. 351 tests (13 new). Self-review found one real inconsistency fixed before commit:
  asker-id counting was case-sensitive, unlike the question grouping it's modeled on — `"Alice"`
  and `"alice"` across two asks would have counted as two distinct askers instead of one repeat
  asker; normalized the same way, with a regression test. **Wave W2's epic `e64` (shared-duos)
  is now complete** — all of #67, #68, #69, #70, #71 merged in order, one at a time on `main`.
  The Phase 1.5 bridge duo (concept.md §12) now: loads from a checked-in, human-owned
  configuration file (#67); is grounded in published material only, structurally unable to
  reach a personal store (#68); answers a team member's question with cited, dated sources, or
  escalates by name (#69); is unmistakably attributed and refuses to be treated as a decision
  (#70); and reports its own honest usage, including the finding that nobody is using it, if
  that's what's true (#71).

**Wave W2 is now complete.** All three of its epics — `e3` (derivation, #23-#26), `e10`
(permissions, #48-#51), and `e64` (shared-duos, #67-#71) — are merged, one at a time on `main`,
per §1/§2's locked sequencing.

**Wave W3 — real concurrency starts here.** Three chains ran as separate concurrent worktree
agents, each fetching/rebasing onto `origin/main` before every issue and merging squash-clean;
none touched this doc directly (three concurrent editors would race on one file), so the
orchestrating session consolidated all three below after all three finished.

- `e4` (mirror, #27→28→29→30): #27 PR [#113](https://github.com/guangshinhaha/digital-duo/pull/113)
  `38e0f03` — `src/derivation/portrait.ts`, `duo mirror portrait`, sourced only from #23/#24's
  output; below 10 pairs shows a plain "not enough history" message rather than a chart; "who
  asks most" is reported as busiest conversation *threads*, explicitly labelled a stand-in since
  `IngestRecord` carries no per-person asker identity. #28 PR
  [#120](https://github.com/guangshinhaha/digital-duo/pull/120) `713501f` — `Rule` gains
  `reviewStatus` (pending/approved/rejected) and `origin` (derived/owner_asserted), orthogonal to
  derivation's own confidence tier and persisted across re-induction; `src/derivation/
  rule-review.ts` (`approveRule`/`rejectRule`/`promoteRule`/`writeRuleByHand`/
  `listRulesForReview`/`listActiveRules`), `duo mirror rules ...`. Review caught a real bug: the
  review-write path called an already-`withDatabase`-wrapped helper from inside another open
  `withDatabase(mutate:true)` callback — both decrypt to the same `.rw-tmp` file, so the inner
  call would have clobbered it under the outer's open handle; fixed with a `readRuleEvidenceRows`
  primitive for callers already holding a handle. #29 PR
  [#123](https://github.com/guangshinhaha/digital-duo/pull/123) `3075b41` — extended #53's
  `src/trust/refusals.ts` with the real writer (`upsertRefusal`/`confirmNoRefusals`/
  `writeRefusalsFile`), an onboarding gate (`requireRefusalsDecision`), wired so `listActiveRules`
  re-checks every approved rule against `duo/refusals.md` on *every* call, not just at approval
  time — "the refusal wins" holds even for a refusal written after approval. Also reconciled two
  epics' independently-written `refusals.md` parsers (`## heading` sections vs. bullet points)
  onto the richer canonical format. #30 PR
  [#126](https://github.com/guangshinhaha/digital-duo/pull/126) `c6d8f00` — `src/derivation/
  calibration.ts`, `duo mirror calibrate`; reuses #32's real draft pipeline and #32's own
  `recordDraftOutcome` rather than a parallel mechanism, gated behind #29's
  `requireRefusalsDecision`. Honestly caveats that this "held-out" selection is a self-contained
  approximation, not the real time-based train/held-out split (that's W4's `e6`). **577 tests at
  the end of this chain.** Also landed one build-break hotfix mid-chain (PR
  [#124](https://github.com/guangshinhaha/digital-duo/pull/124), merged before #30): concurrent
  `e5` had merged #32 against an earlier `main`, before #28's new required `Rule` fields existed;
  the non-conflicting merge landed anyway (`tsconfig` excludes `test/` from typecheck, so nothing
  caught it at merge time) — fixed `src/drafting/context.ts`'s `findRuleHit` and two test
  fixtures.

- `e5` (drafting, #31→66→33→32→34 — dependency-corrected order, not numeric): #31 PR
  [#115](https://github.com/guangshinhaha/digital-duo/pull/115) `f3a4ad6` — `src/drafting/
  relevance-gate.ts` (pure `classifyMention`), `refusals.ts`, `gate.ts`/`gate-log.ts`; deliberately
  *not* wired into `duo draft` yet — it's for a future Slack-mention entry point, not an
  owner-typed CLI question. #66 PR
  [#116](https://github.com/guangshinhaha/digital-duo/pull/116) `8c92556` —
  `test/fixtures/synthetic-persona.ts` (an `owner.kind: "none"` duo per concept.md §12). Review
  caught a real placement bug: the reusable "cannot be used on a Slack surface" guard was written
  entirely under `test/`, which `tsconfig.json` excludes from the build — unreachable from real
  production code; moved to `src/drafting/fixture-guard.ts`, keeping only fixture data under
  `test/`. #33 PR [#118](https://github.com/guangshinhaha/digital-duo/pull/118) `f0c21b2` —
  `src/drafting/confidence.ts` (`scoreConfidence` + the four component signals from
  v1-tech-design.md §1.8), new `DUO_CONFIDENCE_*` config. #32 PR
  [#122](https://github.com/guangshinhaha/digital-duo/pull/122) `f24d978` — `duo draft <question>`
  / `duo draft-outcome`, `src/drafting/{context,generate,pipeline,draft-log}.ts` (**full path**,
  `story` label). Multi-angle review found two real issues: `runSelfConsistencySampling` scored
  identical samples as **zero** agreement when they embedded to a degenerate zero vector (fixed
  with an exact-text-equality short-circuit), and two commands went beyond this issue's stated
  acceptance criteria (trimmed). #34 PR
  [#125](https://github.com/guangshinhaha/digital-duo/pull/125) `1ec0682` — refusal short-circuit
  before any retrieval/generation, richer `explainEscalation` wording, `standing-order-
  candidates.ts` + `duo draft-answer` (**full path**, `story` label). Rebased onto both `e4`'s and
  a concurrent narrower hotfix's changes to the same break, resolving one real conflict in
  `src/drafting/context.ts` in favor of the fuller fix, and updated this branch's fixtures to
  #29's new canonical refusals-file format. **550 tests at the end of this chain.**

- `e11` (trust, #52→53→54→55): #52 PR
  [#114](https://github.com/guangshinhaha/digital-duo/pull/114) `c84f806` — `src/trust/grid.ts`,
  the (topic × tier) autonomy grid keyed on #24's stable topic ids; every untouched or stale cell
  resolves to `"ask"`, no default-allow path; `TRUST_TIERS` deliberately excludes T4 (never
  autonomous, concept.md's own product principle). #53 PR
  [#117](https://github.com/guangshinhaha/digital-duo/pull/117) `3967b24` — `src/trust/
  grants.ts` (plain-English grant → topic match → apply/ambiguous/refuse), a new append-only
  `trust_ledger` (DB-trigger-enforced like #51's `audit_log`, deliberately a separate table since
  `audit_log`'s schema needs a classification value that has no meaning for a trust event) —
  **full path**, `story` label; multi-angle review found no fixable issues. #54 PR
  [#119](https://github.com/guangshinhaha/digital-duo/pull/119) `4a288af` — `src/trust/
  promotion.ts`: clean-instance streak tracking, batched-digest offers (never a per-offer ping),
  explicit accept/decline only (no timeout auto-promotes); declining raises the re-offer bar
  rather than silencing forever. #55 PR
  [#121](https://github.com/guangshinhaha/digital-duo/pull/121) `357e8df` — `src/trust/
  demotion.ts`: a correction drops a cell one level and restarts its promotion counter, logged in
  `trust_ledger`. Self-review caught a real bug before commit: the "cell already at the floor"
  branch left the pending-offer decline gate untouched, so a correction on an already-`"ask"`
  cell would have let stale pre-correction evidence still count toward a future promotion; fixed
  to reset the streak/offer state in that branch too. **460 tests at the end of this chain.**

**Cross-epic hotfix, found after all three chains reported in** (PR
[#127](https://github.com/guangshinhaha/digital-duo/pull/127), squash `273ccee`): the `e4` chain's
own agent flagged — but correctly left out of its own issues' scope — that `src/drafting/
context.ts`'s `findRuleHit` (the *live* `duo draft` pipeline's rule-hit lookup) checked
derivation status and #28's review status, but not #29's refusal-conflict check that
`listActiveRules` (the Mirror's *read* path) already enforces. A refusal written after a rule's
approval correctly suppressed it everywhere the Mirror shows it, but a live draft could still
ground an answer on, and cite, that exact rule text — a real trust-boundary gap, fixed directly
by the orchestrating session rather than left in `main`: `findRuleHit` now skips any candidate
topic with a conflicting refusal via the same `findConflictingRefusal` check, falling through to
the next matched topic. One regression test added. **578 tests, full suite green.**

**Wave W3 is now complete.** All three epics — `e4` (mirror), `e5` (drafting), `e11` (trust) —
are merged, plus the cross-epic refusal-check hotfix. `main` tip: `273ccee`.

**Wave W4** — same worktree-per-chain concurrency pattern as W3 (three chains, none touching
this doc directly; consolidated below once all three reported in). `e8` (Slack, #40→41→42)
stayed skipped, blocked on #15 regardless of pacing policy, per §2/§4.

- `e6` (eval, #35→36): #35 PR [#133](https://github.com/guangshinhaha/digital-duo/pull/133)
  `46e83a7` (task, lighter path) — `src/eval/time-split.ts` (`splitCorpusByTime`, before
  derivation — AR-7), `src/eval/held-out-assertion.ts` (checks, not assumes, that no rule cites
  held-out evidence), `src/eval/offline-eval.ts` (`runOfflineEval`: isolated scratch store, real
  derivation over the train split only, real `draftReply` scoring against real held-out answers).
  `duo eval offline`. Auto-approves rules inside the scratch store only (no owner exists in an
  automated run), a real refusal conflict still blocks approval; skips #29's onboarding gate
  since this harness runs "before Slack is ever connected" per §1.10, but still honors a real
  refusals.md if one exists. Review finding: `--sample`/`--seed` silently coerced a bad value to
  `NaN` → an empty evaluated set with no error; fixed with a validating parser. #36 PR
  [#136](https://github.com/guangshinhaha/digital-duo/pull/136) `f95d16c` (task, lighter path) —
  `eval/gate-labels.json` (46 hand-labelled mentions, versioned), `src/eval/gate-eval.ts`
  (`scoreRelevanceGate`: precision/recall/coverage reported separately, never averaged;
  `assertPrecisionFloor`). **705 tests at the end of this chain.** Real finding, correctly not
  fixed here (out of #36's own scope, #31/`e5` already merged): scored against the fixture, the
  relevance gate's precision is 0.750 against a 0.95 floor, entirely from rhetorical questions
  scored as genuine — pinned as a regression tripwire in `test/gate-eval.test.ts` and filed as
  [#137](https://github.com/guangshinhaha/digital-duo/issues/137) for a follow-up fix to #31.

- `e7` (corrections, #37→38→39): #37 PR
  [#130](https://github.com/guangshinhaha/digital-duo/pull/130) `4e288c4` (task, lighter path) —
  `src/corrections/classify.ts` (`classifyEdit`: trivial-edit short-circuit, then a deterministic
  content-word-overlap heuristic for style/substance/both, optional best-effort LLM), `queue.ts`
  (`correction_candidates`, deduped). Extended `recordDraftOutcome` (#32) with an optional
  `sentText` param, backward compatible. Review fix: an "edited" outcome against an *escalated*
  draft (nothing to diff) threw past the CLI's own already-recorded success — fixed to record
  first, then handle that case. #38 PR
  [#131](https://github.com/guangshinhaha/digital-duo/pull/131) `a0e6897` (**full path**, `story`
  label) — `src/corrections/review.ts`: `listPendingReview` merges #37's queue with #34's
  `standing_order_candidates`; flags a substance candidate that contradicts an active rule.
  `approveCandidate` writes with provenance (style → `duo/voice.md`'s new "## Corrections"
  section; substance → a new active rule via `writeRuleByHand`) only after the write succeeds; a
  conflicting substance candidate is refused outright (`CandidateConflictError`), never silently
  accumulated alongside the rule it contradicts. `duo corrections review/approve/reject`. #39 PR
  [#135](https://github.com/guangshinhaha/digital-duo/pull/135) `a626082` (task, lighter path,
  more surface than typical) — `Rule` gains `supersededByRuleId`/`correctionDraftId`/
  `correctionQuestion`, `reviewStatus` gains `"superseded"` (persists across re-induction,
  `listActiveRules` excludes it for free); `writeCorrectionRule` writes every file first, then
  one DB round trip, so a failure touches the store nowhere and the candidate stays queued. `duo
  corrections approve <id> --supersedes <ruleId>`. **648 tests at the end of this chain.** Review
  findings: five pre-existing test files needed the three new `Rule` fields (`tsconfig.json`
  excludes `test/`, so this class of break isn't caught statically — same gap PR #124 hit for a
  different field, back in W3); a test-authoring bug (double `createEncryptedStore` silently
  wiped a rule a prior step wrote, fixed with an `existsSync` guard); one genuinely flaky CLI test
  given an explicit timeout budget. Design decision documented in the PR: "the rule it came from"
  resolved via #38's conflict heuristic plus an explicit `--supersedes`, not by tracing the
  originating draft's own cited rule — flagged as a possible future enhancement, not built, since
  no AC requires it.

- `e12` (actions, #56→60→57→58→59 — dependency-corrected order): #56 PR
  [#129](https://github.com/guangshinhaha/digital-duo/pull/129) `7c25670` (task, lighter path) —
  `src/actions/registry.ts` (`classifyActionTier`/`registerAction`/`resolveActionForUse`, the
  one choke point every later module in this epic routes through), `src/actions/attempt-log.ts`
  (append-only `action_attempts`, same DB-trigger pattern as `audit_log`/`trust_ledger`). Review
  fix: `--reversible`/`--obligates` silently coerced a typo'd value to `false`; fixed to throw on
  anything but exact `"true"`/`"false"`. #60 PR
  [#132](https://github.com/guangshinhaha/digital-duo/pull/132) `7d8dcb9` (task, lighter path) —
  `trust_cells` gains `CHECK (tier IN ('T0','T1','T2','T3'))` (a T4 row cannot exist even via raw
  SQL, on top of #52's compile-time exclusion); `src/actions/t4-guard.ts`
  (`createT4Request`/`confirmAndExecuteT4Request`, the only function anywhere allowed to run a T4
  side effect, always stage-then-confirm); a T4 grant attempt is logged, not just refused. Review
  fix (a pattern re-caught twice more later in this same chain): `withDatabase` only persists a
  mutation when its callback *returns* — the refusal path logged an attempt then threw from
  inside that same transaction, silently discarding the very log entry meant to record it;
  restructured so the callback always returns and the throw happens after commit. #57 PR
  [#134](https://github.com/guangshinhaha/digital-duo/pull/134) `493c7d4` (**full path**, `story`
  label) — `src/actions/preparation.ts`: visibility inherited from the owner's own encrypted
  store, no submit/send/share function anywhere in the module (checked structurally); T1
  deliberately ignores the trust grid, matching `duo draft`'s existing "works at n=1" posture.
  Review fix: the built-in `prepare_*` action was unconditionally re-registered on every call,
  which would silently undo any future re-tiering of that action id — fixed to register once, on
  first use. #58 PR [#138](https://github.com/guangshinhaha/digital-duo/pull/138) `d7b0d3e`
  (**full path**, `story` label) — `src/actions/reversible.ts`
  (`performReversibleAction`/`undoReversibleAction`: registration → revertibility (escalates T3
  if not) → grid autonomy (escalates T2 if not `"auto"`) → run `perform()` once; a thrown
  `perform` rolls back and is reported, never a silent partial effect). Review fix: the same
  throw-discards-the-transaction bug as #60, hit and fixed again in this module's own refusal
  path. #59 PR [#139](https://github.com/guangshinhaha/digital-duo/pull/139) `3241afd` (**full
  path**, `story` label) — `src/actions/binding.ts` (`prepareBindingAction`: stages only, no
  execute parameter exists at all); `approvePendingAction` checks expiry inline so a late
  approval can never sneak past the window even without a prior sweep. One deliberate change to
  already-shipped code, required by this issue's own AC ("no T3 action is autonomous on first
  grant"): `src/trust/grants.ts`'s `grantAutonomy` now caps a T3 grant at `"approve"`, never
  `"auto"` — resolving the issue's own open question ("should any T3 ever reach full autonomy")
  as none, by design. Review findings: `getApprovalStats` counted a later retraction as if the
  original approval never happened (fixed to count both together); the `grants.ts` change
  correctly invalidated a pre-existing `t4-guard.test.ts` expectation, updated. **744 tests at the
  end of this chain.** No T4-severity gap found. One pattern flagged for awareness, not a
  confirmed bug elsewhere: the throw-discards-the-transaction issue hit three times in this
  chain's own new code was not audited across the ~28 pre-existing `withDatabase(mutate:true)`
  call sites elsewhere, since none of them combine a throw with a required attempt-log write the
  way these new modules did.

**Cross-epic hotfix, found after all three W4 chains reported in** (PR
[#140](https://github.com/guangshinhaha/digital-duo/pull/140), squash `a214c11`): the `e7`
chain's own agent flagged — correctly left out of its own three issues' scope — that
`src/derivation/voice.ts`'s `runVoiceProfile`, when run with `force: true`, overwrote the entire
`duo/voice.md` file, including the `"## Corrections"` section #38/#39 append to it — a log with
no database projection to rebuild it from. Fixed directly: the section is now read back before
the overwrite and re-appended verbatim after the fresh statistical/register content. One
regression test added. **745 tests, full suite green.**

**Wave W4 is now complete.** All three epics — `e6` (eval), `e7` (corrections), `e12` (actions)
— are merged, plus the Corrections-log-preservation hotfix. `e8` stays skipped pending #15. One
follow-up issue filed against already-merged `e5` ([#137](https://github.com/guangshinhaha/digital-duo/issues/137),
relevance gate precision), not actioned in this run. `main` tip: `a214c11`.

**Wave W5** (`e9`, public-answering, #43→44→45→46→47, run sequentially rather than splitting
#46/#47 across a second worktree — simpler, equally correct) — the first wave to consume the
full permission engine (`e10`) and trust grid (`e11`) built ahead of it in W2/W3:

#43 PR [#142](https://github.com/guangshinhaha/digital-duo/pull/142) `34344aa` (**full path**,
`story` label) — `src/permissions/public-answer.ts` + `public-answer-log.ts` (a purpose-built log,
not `audit_log` — that schema's clearance columns don't fit a topic-gated flow), `duo permissions
ask-public`. **Real permission-boundary bug, caught in review and fixed directly** (this is the
first wave whose own chain, not the orchestrating session, found and fixed a trust-boundary gap):
naively reusing #32's owner's-eyes-unfiltered `gatherDraftContext`/`draftReply` for a *public*
answer would have let restricted or unmarked (`"unknown"`) material leak the moment this epic
gave that pipeline's output a way to leave the owner's own eyes — the first real breach of the
classification boundary #48-51 established back in W2. Fixed with an optional `clearanceCeiling`
param on `gatherDraftContext`/`draftReply` (filters via #48's `isVisibleToClearance` *before*
rule-hit/topic/evidence resolution); public answering passes the lowest defined level uniformly,
per the issue's own out-of-scope note (no per-asker differentiation yet). Added
`DraftContext.topicId`/`DraftAnswer.topicId` so public answering has something to check against
the T0 trust cell at all. #44 PR
[#143](https://github.com/guangshinhaha/digital-duo/pull/143) `93dc0ae` (**full path**, `story`
label) — `src/permissions/attribution.ts` (mirrors `src/shared-duo/attribution.ts`'s pattern),
`DUO_OWNER_NAME` config; every one of #43's three return paths composed through
`withPublicAttribution` before logging/returning, unsuppressible by any parameter. #45 PR
[#144](https://github.com/guangshinhaha/digital-duo/pull/144) `ff0707a` (**full path**, `story`
label) — `src/permissions/public-correction.ts` wires #55's `applyCorrection` (T0 demotion)
together with an append-only `"corrected"` log entry (`correctsEntryId`, original never touched);
`threadStillExists` is a caller-supplied fact, same idiom as `actions/reversible.ts`'s
`canRevertHere`, since no live channel integration exists (`e8` stays blocked). #46 PR
[#145](https://github.com/guangshinhaha/digital-duo/pull/145) `2687394` (**full path**, `story`
label) — `escalation_urgency_log`/`escalation_digests` over #32's existing `drafts` table (no
parallel tracking); urgency classified on objective severity signals, not self-declared "urgent"
framing, per the issue's own flagged risk. Self-review caught a real bug before commit: an INSERT
had 3 `?` placeholders bound against 4 arguments (copy-paste leftover) — would have thrown at
runtime on the first escalated draft. #47 PR
[#146](https://github.com/guangshinhaha/digital-duo/pull/146) `46c20aa` (**full path**, `story`
label) — `src/drafting/proactive-offer.ts` + `channel-mutes.ts` (`duo/muted-channels.json`,
checked-in convention); the first real consumer of #31's `runRelevanceGate`, built for exactly
this; "one action to post it" reuses #32's existing `duo draft-outcome <id> sent` rather than a
new send path. **811 tests at the end of this chain.** No blockers hit; every issue resolved with
existing `e10`/`e11`/`e5` machinery already in place, as the plan anticipated. [#137](https://github.com/guangshinhaha/digital-duo/issues/137)
(relevance-gate precision, filed in W4) stays open and untouched — #47 reuses that gate unchanged,
correctly out of this chain's scope.

**Wave W5 is now complete.** `main` tip: `46c20aa`.

**Wave W6** (`e13`, role-duos, the last wave) — #72→61→62→63, single chain, sequential:

#72 PR [#148](https://github.com/guangshinhaha/digital-duo/pull/148) `f0bd104` (task, lighter
path) — `src/role-duo/` (types/loader/seed), layered on #65's `Duo` primitive (`owner.kind:
"role"`), not a parallel entity type. Seeds standing orders from every consenting holder's
already-approved rules (`listActiveRules`), matched across holders' separate stores by topic
label; surfaces conflicting positions rather than averaging them; excludes and names
non-consenting holders; states honestly when only one holder's material was used; withdrawal
flips consent and re-seeds. `duo role-duo seed/withdraw`. Review fix: `withdrawHolderConsent`
wrote the updated definition to disk *before* recomputing the seed — a seeding failure would
have left the definition recording a withdrawal the seed file didn't yet reflect; fixed by
computing the seed first. 824 tests. #61 PR
[#149](https://github.com/guangshinhaha/digital-duo/pull/149) `456fbe6` (**full path**, `story`
label) — `src/continuity/predecessor.ts`, layered on #32's `draftReply`; names the predecessor
and states evidence age prominently; a live-matter question declines as current but still
answers historically with a "may have changed" caveat; staleness hedging strengthens
monotonically (fresh/aging/stale/very_stale, reusing #33/#69's 180-day convention). **Real
classification-boundary gap found and fixed before shipping**, introduced by this issue's own
design and caught in its own self-review (not pre-existing): a successor is not the predecessor's
duo's owner, so the default owner's-eyes-unfiltered `gatherDraftContext` would have let a
successor read the predecessor's entire personal store — the same class of bypass #43 caught for
public answering — fixed by passing the same lowest-defined-clearance ceiling #43 established,
with a regression test. 836 tests. #62 PR
[#151](https://github.com/guangshinhaha/digital-duo/pull/151) `e1346da` (**full path**, `story`
label) — `src/continuity/handover.ts`: assembles recurring questions, standing orders with
evidence, refusals, thread activity, and open escalations purely from what earlier epics already
derived, nothing re-derived; owner cuts any item (or hand-edits an `excluded` flag) before one
explicit `share` act; a thin/empty corpus names gaps rather than padding; the draft lives in the
store's own gitignored data directory, never the git-tracked `duoDir` — an unreviewed pack may
hold something personal. Two review fixes: a rule and its own topic shared the same id, so
cutting one would silently cut the other too (fixed by prefixing every section's ids); reading a
hand-edited draft with no validation meant `"excluded": "false"` (a truthy string in JS) silently
left an item un-cut, and a malformed file threw a raw `SyntaxError` (fixed with a strict-boolean
shape check and `HandoverDraftMalformedError`). 848 tests. #63 PR
[#153](https://github.com/guangshinhaha/digital-duo/pull/153) `dbf2841` (task, lighter path) —
`src/continuity/{lifecycle,transfer,lifecycle-log}.ts`: `archiveDuo` revokes every autonomy grant
(new `grid.ts#revokeAllAutonomy`, logged via the ledger's existing `"revoked"` event); a transfer
completes only once both named parties separately confirm — structurally impossible to complete
from one call, matched against the request's own recorded parties, never a caller-asserted role;
`endDuo` removes both the encrypted store and `duoDir` (the one thing `duo purge` deliberately
never touches — a new, separate, stronger action, that invariant left alone). Orphan status is an
explicit, named report wired as a fail-safe into both `duo draft` and #61's consult command —
nothing in this codebase can detect "the owner left" on its own. Every archival/transfer/deletion
is logged to its own durable, own-directory lifecycle log that survives the very deletion it
records. Review fix: a doc comment claimed the deletion event logged *before* `endDuo` ran; the
code correctly logs it *after* — fixed the comment, not the code. **877 tests at the end of this
chain.**

**A second, entirely separate Claude Code session did unrelated concurrent work on `main`
throughout this wave** — PRs [#150](https://github.com/guangshinhaha/digital-duo/pull/150) and
[#152](https://github.com/guangshinhaha/digital-duo/pull/152) (`docs/client-surface-design`,
`feat/client-core-gaps`; session `01F1ZFT1BqF3qsF4u9av82Bo`, authored and merged by the repo
owner's own account), building a Mac/phone client + `duo serve` daemon — entirely outside this
plan and this orchestrating session's scope. Verified via GitHub before treating it as
legitimate rather than unexpected repo state. Not part of the 72-issue backlog; not touched or
reviewed by this run. Full suite after both landed: **943 tests**, `npm run typecheck`/`npm run
build`/`npm test` all green at `main`'s tip.

**One low-severity gap found during #61, filed rather than fixed inline**: [#155](https://github.com/guangshinhaha/digital-duo/issues/155)
— `src/drafting/generate.ts`'s `extractiveDraft` (the no-provider fallback inside `draftReply`)
never calls `stripMarkingLine` (#50), unlike `src/permissions/answer.ts`'s own extractive
fallback, so a raw classification marking line can be echoed verbatim by `duo draft`, public
answering, or predecessor consultation whenever no inference provider is configured. Not a
classification-boundary breach — the content is already permitted through whatever ceiling
applies by the time this runs — a polish/consistency issue, same class as what #50 fixed once
already. Investigated for an inline fix during doc consolidation: the straightforward version
doesn't fully close the gap, since `DraftEvidenceItem` (`src/drafting/context.ts`) doesn't carry
a record's `classification` at all (it's dropped when hybrid search results are mapped into
evidence items), and `Rule.text` has no classification field to strip from in the first place —
a correct fix touches evidence-item construction and possibly `derivation/rules.ts`'s
text-selection, not just `generate.ts` as the issue titled it. Left filed, not patched, rather
than ship a partial fix under time pressure.

**Wave W6 is now complete — this was the last wave.** All 72 issues in the original backlog that
were in scope for this run are closed. #14, #15, #22, and epic `e8` (Slack) stay permanently
skipped per §2/§4 — both are standing gating conversations, not code, and nothing in this run
was blocked incorrectly by them. Two follow-up issues were filed against already-merged work
rather than fixed inline: [#137](https://github.com/guangshinhaha/digital-duo/issues/137)
(relevance-gate precision on rhetorical questions) and [#155](https://github.com/guangshinhaha/digital-duo/issues/155)
(classification-marking leak in the extractive draft fallback). `main` tip: `dbf2841`, plus the
unrelated client-surface work in #150/#152.

**Resume point, if this backlog is ever revisited:** there is no wave left to run. A future
session picking this up should (1) decide G1/G2 (#14/#15) if `e8`/Slack or a real inference
provider ever becomes relevant, (2) triage #137 and #155 as ordinary bug-fix issues, not part of
a wave, and (3) be aware `main` also carries the independent client-surface work from session
`01F1ZFT1BqF3qsF4u9av82Bo` (`docs/client-design.md`, `docs/client-tech-design.md`, `src/serve/`)
— unrelated to this plan, safe to ignore unless asked to extend it.

*(This closing instruction applied while waves remained; it no longer does — see "Resume point,
if this backlog is ever revisited" above.)*

## 6. Status as of 2026-09-20 — read this first

Everything in §1–5 above describes the original 72-issue backlog and how it was run. Since then:

- **All 72 backlog issues shipped**, in a separate session that ran after this plan was written.
  963+ tests exist. The issue tracker was out of sync with this (issues stayed open after
  merging) — cleaned up 2026-09-20: 43 issues closed with a comment pointing at the merging PR.
- **A circular dependency was found and fixed** in the original epic links: #9 (public-answering)
  and #11 (trust) depended on each other. #11 only needs #3 (stable topic IDs); it doesn't need
  #9 to exist to be built, only to be exercised later.
- **The Mac/phone/web client moved to a separate repo**: [guangshinhaha/duo](https://github.com/guangshinhaha/duo),
  commit `ad5ee47`. It was built inside this repo by an independent session
  (`docs/client-design.md`, `docs/client-tech-design.md`, `client/`, `src/serve/`) — outside this
  plan and never part of the 72-issue backlog. `client/` and the two design docs moved; `src/serve/`
  (the daemon) **stayed here deliberately** — it imports directly from core modules (store,
  derivation, drafting, permissions, trust) and isn't client code. The client talks to it over
  HTTP only, per its own README.
- **Two new issues filed 2026-09-20**, prompted by the owner's own reasoning: Slack (#8, blocked
  on #15) was always the surface for someone else to consult the duo. It's staying blocked
  indefinitely — the owner chose the client as the deliberately lower-resistance path instead.
  But the client only served the owner's own paired devices; nobody else could reach the duo at
  all. Filed to close that gap:
  - [digital-duo#157](https://github.com/guangshinhaha/digital-duo/issues/157) — a scoped
    ask-token type (not device pairing) and a `POST /ask` route wired to the answering logic
    that already ships (`answerPublicly`, `answerSharedDuo`). Children: #158, #159, #160.
  - [duo#1](https://github.com/guangshinhaha/duo/issues/1) — the no-install asker-facing page
    that calls it. Child: #2.
  - Scoped deliberately small: no new trust model. `duo/directory.json` already resolves asker
    identity/clearance and already treats an unrecognised asker as unresolved-safe-default, which
    covers "people outside the team or agency" without redesign — a teammate gets added with a
    real clearance, an outsider just falls through to the same conservative default.
- **A real, unresolved problem** ~~unresolved~~ **— RESOLVED 2026-09-20, environment not code**:
  325 of 921 tests failed in this environment. Root cause: the store uses Node's built-in
  `node:sqlite`, and Homebrew's Node build (v23.11.0, `/opt/homebrew/bin/node`) is compiled
  without FTS5 (`no such module: fts5`); the machine's PATH-default nvm Node (v18.20.8) predates
  `node:sqlite` entirely. Verified fix: run under nvm's **v22.22.3**
  (`PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npm test`) — **957/957 tests pass**, so
  the code was never regressed. Pinned durably: `.nvmrc` (22.22.3), `engines.node >=22.5`, and a
  Development section in README. No fallback in `store.ts` was built — one working Node build
  beats a permanent second search path.
- **Still genuinely open, not started**: #137 (relevance gate misclassifies rhetorical
  questions), #155 (classification marking can leak through the no-provider draft fallback),
  and all four issues under #157/#1 above.
- **Still deliberately deferred, not a bug**: #14, #15 (the two gating decisions — real
  inference provider, real Slack access), and everything under #8/#2/#22/#40/#41/#42 (Slack) —
  the owner's explicit call, keep these open rather than resolving or working around them.
