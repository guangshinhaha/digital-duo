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

**Next: wave W4**, three concurrent chains (same worktree-per-chain pattern as W3): `e6` (eval,
#35→36), `e7` (corrections, #37→38→39), `e12` (actions, #56→60→57→58→59). `e8` (Slack, #40→41→42)
stays skipped — blocked on #15 (G2, Slack access) regardless of pacing policy, per §2/§4.

To resume: work straight through the wave sequence in §1 using the policy in §4, without
re-deriving this plan. Stop only at a GATE/blocked stop `lfg` (or the lighter path) can't
resolve itself, or at a wave boundary worth a status check.
