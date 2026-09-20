---
title: "POST /ask wired to answerPublicly and answerSharedDuo - Plan"
type: feat
date: 2026-09-20
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# POST /ask wired to answerPublicly and answerSharedDuo - Plan

## Goal Capsule

- **Objective:** A holder of an ask link can get a question answered by the duo over HTTP — with exactly the answer behavior, scoping, and conservatism the CLI already applies — while every owner-only route stays closed to them.
- **Means:** A thin `POST /ask` route delegating to the existing answering functions behind a kind-aware auth seam in the daemon's hook (KTD1).
- **Authority hierarchy:** issue #159 acceptance criteria govern product behavior; R-IDs state requirements; KTD-IDs state implementation mechanism within those constraints.
- **Stop conditions:** all R-IDs hold, the Verification Contract is green, and ask tokens are still refused byte-identically on every owner-only route.
- **Execution profile:** TypeScript/ESM, vitest; every node/npm/npx invocation under pinned Node 22.22.3.
- **Who finishes and ships:** this plan's implementer, via the standard branch → tests → review → PR flow.

---

## Product Contract

### Summary

`POST /ask` is the one route an ask token authorizes. It takes a question, authenticates the bearer as a valid ask token or a valid device token (the owner is a superset of an asker), and delegates to `answerPublicly` (personal duo) or `answerSharedDuo` (shared duo) argument-for-argument as the CLI wrappers already do. The response carries the CLI's three-outcome shape — answered (with sources or citations), passed on, declined — with owner-facing diagnostics exposed only to device-token principals.

### Problem Frame

Ask tokens (#158, merged) are minted, expiring, revocable credentials that authorize nothing: the daemon's auth hook resolves them on no route, structurally. The asker-facing surface of this product is otherwise CLI-only — a colleague holding an ask link has no way to use it. #159 gives the credential its one capability without handing over anything owner-only.

### Key Decisions

- **Device tokens may also ask.** The owner is a superset of an asker; a paired device asking its own duo is ordinary use, and an ask token never gains the reverse. (session-settled: user-directed — chosen over `/ask` accepting only ask tokens: the owner must retain ask access through existing device credentials.) Governs R1, R2.
- **The route is a thin wrapper, not new answering logic.** Delegation mirrors `runAnswerPublicly` and `runSharedAsk` argument-for-argument; every behavioral question is answered by the existing functions. (session-settled: user-directed — chosen over HTTP-specific answering logic: the answering behavior is already specified, tested, and conservatism-pinned.) Governs R6.
- **The response carries the CLI's three-outcome shape.** Answered with sources, passed on, declined — not a new HTTP-specific outcome vocabulary. (session-settled: user-directed — chosen over a new HTTP-specific response schema: the three outcomes are the product's answer contract, identical over HTTP.) Governs R7.

### Requirements

**Authentication and authorization**

- R1. `POST /ask` authenticates the bearer as either a valid, unexpired, unrevoked ask token or a valid device token; on `/ask` only, a refusal for either kind is one uniform kind-blind 401 (no oracle distinguishing expired from revoked from unknown).
- R2. Every owner-only route continues to refuse ask tokens identically to an invalid device token — byte-identical status and body, unchanged by this work.
- R3. Ask-token revocation and expiry take effect on the very next `/ask` request — no success cache serves ask tokens.
- R4. A failed `/ask` authentication records at most one failure per request in the hook's per-IP rate limiter; valid requests never record failures.

**Asking**

- R5. The request body is `{ question: string, duo?: "personal" | "shared" }`; `question` must be a string that is non-empty after trimming; `duo` defaults to `"personal"`; an unknown `duo` value is a 400 naming the accepted values.
- R6. The route delegates to `answerPublicly` (personal) or `answerSharedDuo` (shared) exactly as the CLI wrappers call them — no new answering, scoping, retrieval, or refusal logic in the serve layer.
- R7. Every successful ask answers 200 with the normalized three-kind envelope: `answered` (with sources for personal, citations for shared), `passed_on`, or `declined_refused`; shared `out_of_scope` maps to `passed_on` and `not_a_decision_maker` to `declined_refused`.
- R8. Ask-token principals receive the asker-visible projection (`duo`, `kind`, `text`, `sources`/`citations`, `declineReason?`). Device-token principals additionally receive the personal outcome's own fields (`draftId`, `logEntryId`, `topicId?`, `confidence`?, `evidenceAgeDays`?, `ownerNotice?`); the shared outcome carries no such fields, so shared answers return the same normalized envelope for both principal kinds. `ownerNotice` never reaches an ask-token principal.
- R9. An asker whose name is not in `duo/directory.json` is scoped exactly as `answerPublicly` already scopes an unresolved asker — the route introduces no new leniency and no new strictness.
- R10. Requesting the shared duo when it is unavailable (persona absent or malformed) is a 404 `shared_duo_unavailable` whose message names the personal fallback; there is no silent fallback to personal.

**Integrity**

- R11. Interleaved `/ask` handling loses no draft-log, public-answer-log, or usage-log rows: every store mutation on the ask and hook paths is a fully synchronous, self-contained `withDatabase` call, so concurrent requests interleave only at awaits and each append reads the current store — the no-lost-rows outcome holds by construction, and a regression test pins that invariant (see KTD6).
- R12. The residual daemon-vs-CLI store race (two processes on one encrypted store) is documented as a known limitation, not silently ignored.

### Scope Boundaries

**In scope:** the route, the kind-aware seam, the response envelope, asker log identity, concurrency safety of the new surface (pinned by regression test — see KTD6).

**Out of scope (non-goals):**

- New answering, retrieval, or refusal logic — R6 forbids it.
- Rate limiting beyond `registerAuth`'s existing per-IP limiter (issue #159's own boundary).
- Audit-log extension for asks — #160's work.
- Any notification surface for passed-on answers — a known CLI limitation the route inherits and documents (the `ownerNotice` text addresses the owner; no push/poll mechanism is added).

### Deferred to Follow-Up Work

- Cross-process locking in `src/store/store.ts` `withDatabase` (the #158 review's unapplied P1 — fixed `rw-tmp` sibling plus lock redesign); #159 documents the residual instead.
- Behavioral asker resolution / clearance scoping from `directory.json` (today resolution feeds nothing behavioral on either answering path; #160 audit work is its natural consumer).
- 202-plus-WebSocket async answering shape (the `POST /drafts` precedent defers it; `/ask` cites the same decision rather than re-litigating it).

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Kind-aware verification lives inside the auth hook, and attaches a principal.** On `/ask` the hook verifies ask tokens and device tokens (owner superset) and attaches `{kind: "ask" | "device", name}` to the request; on every other route its behavior is byte-identical to today. `/ask` is matched via `request.routeOptions.url` (Fastify 5 resolves routing before `onRequest`), not a raw `request.url` exact compare, which breaks on query strings. (session-settled: user-directed — chosen over verifying inside the route handler: route-local verification bypasses the hook's closure-private per-IP rate limiter, and exempting `/ask` like `/health` would bypass the seam entirely.) Governs R1, R2, R4.
- KTD2. **Ask tokens verify uncached, per request; the device path is untouched.** `verifyAskToken` runs on every `/ask` request bearing a non-device token — one store decrypt, no `verifiedTokens` entry, no `touchLastSeen` (ask tokens carry no `last_seen` by #158's design). The device cache, its 5-second stale-success window, and its test stay exactly as they are. Per `docs/solutions/best-practices/ask-token-cache-policy-immediate-revocation.md`: reusing the raw-token-keyed cache would admit a revoked or expired ask token for up to 5 seconds, silently breaking R3; a kind-qualified cache that re-evaluates expiry is sound but buys nothing for human-paced ask traffic — the load the cache exists for is device polling. This is a judgment call on evidence the learning doc already develops (both options specified, one recommended), not a bake-off. Governs R3.
- KTD3. **On `/ask`, verification order is device-cache check → ask verify → device verify, with single failure accounting.** The cache check is free; ask tokens (the dominant `/ask` caller) pay one decrypt; only a cache-missed device token pays two. Exactly one `recordFailure` runs per request, only after both kinds miss — the current hook's shape records failure at the device-verify branch, which a naive refactor would turn into either 401-on-every-ask or double-counted failures (~5 valid asks per minute self-rate-limiting an IP). Governs R1, R4.
- KTD4. **One normalized three-kind envelope; projection by principal kind.** `{duo, kind, text, ...}` with `sources` (personal answered) or `citations` (shared answered), `declineReason?` on shared declines; envelope `text` carries the asker-visible surface (`outcome.text ?? outcome.message` — for personal answered this is the fully composed answer with sources block and attribution, exactly what the CLI prints to stdout). Device principals get the full outcome fields appended, mirroring the CLI's stderr surface for the owner. This instantiates the three-outcome Key Decision (inherits session-settled: user-directed — chosen over a new HTTP-specific response schema: the three outcomes are the product's answer contract, identical over HTTP) and normalizes the shared path's flat `declined`/`declineReason` into the same kinds so the three-outcome promise holds for every 200. Governs R5, R7, R8.
- KTD5. **Asker identity is the principal name, resolved-when-possible for the log.** Ask principals run `resolveAsker(name, loadDirectory(duoDir))` — arguments in that order — and pass `identity.id` when the resolution matches, the raw `name` otherwise, as the `askerRef`/`askerId` value (the resolved id is recordable through the existing `public_answer_log.asker_ref` column and the shared usage entry, so no schema change is needed); device principals log the fixed ref `"owner"`. Resolution feeds nothing behavioral — `answerPublicly` applies a uniform clearance ceiling and `answerSharedDuo` does no per-asker permissioning, so R9 holds by construction; neither wired CLI command resolves behaviorally either, and `runAnswerPublicly`'s own comment says the asker "is never resolved against duo/directory.json here". A malformed `directory.json` (`loadDirectory` throws `InvalidDirectoryError`) falls back to the raw name rather than failing the ask — identity resolution never turns a 200 into a 500. The mint-name-is-a-directory-id convention (`resolveAsker` matches directory ids case-insensitively; ask-link names are free-form) is documented in `ask-link new`'s help text so resolution is not silently dead. Governs R9, and R6's log fidelity.
- KTD6. **No mutex is needed: every store mutation on the ask and hook paths is fully synchronous and top-level.** `withDatabase` (`src/store/store.ts:109-133`) decrypts, runs `fn`, and re-encrypts with plain synchronous calls — no awaits inside — so one call cannot interleave with another; and every mutation the ask surface touches (`appendDraft`, `appendPublicAnswerLogEntry`, `verifyAskToken`, `touchLastSeen`) is one self-contained top-level `withDatabase` call, never nested (the nested-call hazard shape the repo documents at `src/derivation/rule-review.ts:70-79` does not occur on these paths). Concurrent request handlers therefore interleave only at awaits — before or after whole store calls — and each append reads the current store: the no-lost-rows outcome holds by construction, and a U5 regression test pins the invariant so a future async-store refactor cannot silently reintroduce a race. The real residual is cross-process (R12): the daemon and a CLI command on one encrypted store can still clobber each other whole-file — including a `duo ask-link revoke` racing a daemon ask write and leaving the revoked token verifiable — documented per R12; fixing it is #158's deferred P1, a store-infra redesign out of scope here. Governs R11, R12.
- KTD7. **Shared-unavailable is a first-class 404; long answers stay synchronous.** `duo: "shared"` with a missing or malformed persona (the `/duos` precedent swallows both) is 404 `shared_duo_unavailable` with a message naming the personal fallback — an ask-token holder cannot call `GET /duos`, so the error is their only discovery surface; unknown `duo` values are a 400 naming `personal, shared` (role duos are structurally never askable). With a real inference provider an answered personal ask takes tens of seconds; the route answers synchronously exactly as `POST /drafts` already does and cites its deferral of the async shape. Token expiry mid-answer does not abort — expiry gates verification only. Governs R5, R10.

### High-Level Technical Design

Request sequence for `POST /ask` (the one new protocol surface):

```mermaid
sequenceDiagram
  participant C as Asker (ask or device token)
  participant H as onRequest hook (auth.ts)
  participant R as POST /ask (server.ts)
  participant A as answerPublicly / answerSharedDuo
  C->>H: POST /ask  Bearer <token>, {question, duo?}
  H->>H: rate-limit precheck (per-IP)
  alt route is /ask
    H->>H: device-cache check (free)
    H->>H: verifyAskToken (uncached, read-only)
    H->>H: verifyDeviceToken (owner superset)
    H--xC: 401 uniform (both kinds missed, one recordFailure)
  else any other route
    H--xC: device verify only; ask tokens refused identically
  end
  H->>R: request.principal = {kind, name}
  R->>R: body validation (question trim/non-string, duo value)
  R->>A: delegate argument-for-argument
  A-->>R: PublicAnswerOutcome | SharedDuoAnswer
  R-->>C: 200 {duo, kind, text, sources|citations, declineReason?, owner fields iff device}
```

### Assumptions

- `request.routeOptions.url` is populated in the global `onRequest` hook under Fastify ^5.12.5 (routing precedes hooks in v5). If it proves absent at implementation time, fall back to matching the path portion of `request.url` — the decision (parse, never raw exact-compare) is what carries.
- The mint-name-is-a-directory-id convention is documented in help text, not enforced at mint time — enforcement would couple `ask-link` to directory contents for no behavioral gain today.
- Unknown request-body fields are ignored (no strict schema), matching the repo's manual body-check convention; clients get no error for extra fields.
- The per-IP failure budget is shared across kinds and routes as pinned today; client authors learn this from the 429 body, which is unchanged.

### System-Wide Impact

- The auth hook gains a second verification path and a principal — every future route decides authorization against `principal.kind`, which is the seam #158's plan deliberately reserved for this issue (its KTD3).
- `/ask` is the daemon's first multi-user surface: its integrity rests on the synchronous-store invariant (KTD6) and on ask tokens never entering `verifiedTokens`.
- Both answering paths write on every ask (draft-log + public-answer-log rows; shared usage-log JSON) — `/ask` is not idempotent, and the personal path's cost is several inference calls plus embeddings with a real provider.
- A valid ask link authorizes unbounded successful asks at the owner's inference cost until it expires or is revoked — the documented guidance is to mint links with the shortest workable expiry; no limiter beyond the per-IP auth-failure budget is added (out of scope).

### Risks & Dependencies

- **Store races** (KTD6): the in-process surface is race-free by construction — synchronous, top-level store calls, no mutex to get wrong; the residual is cross-process only: the daemon and a CLI command on one store can clobber each other whole-file, up to and including a revoked ask token surviving as verifiable when a revoke write races a daemon ask write, until #158's P1 lands. U5's regression test pins the invariant the safety rests on.
- **Double store decrypt** for cache-missed device tokens on `/ask` (KTD3 order) — bounded, deliberate, and paid only by the owner.
- **Fixture weight**: a personal `answered` test needs the full fixture chain from `test/public-answer.test.ts:47-107`; `passed_on` (empty store) and `declined_refused` (`writeRefusalsFile`) are the cheap routes and carry most scenarios.
- **Environment**: the suite only runs under Node 22.22.3 (`node:sqlite` + FTS5); baseline is 1000/1000 green.

### Sources / Research

- `src/serve/auth.ts` — hook, cache, rate limiter, `/health` exemption; no principal today.
- `src/serve/server.ts` — `ServeDeps` (no `ownerName`), `registerRoutes`, `errorBody`/`statusForError`, `POST /drafts` body-check and long-answer precedents.
- `src/serve/tokens.ts` — `verifyAskToken` read-only predicate; ask tokens refused structurally everywhere today.
- `src/permissions/public-answer.ts` — `answerPublicly` signature, `PublicAnswerOutcome` union, uniform ceiling, composed `text`.
- `src/shared-duo/answer.ts`, `src/shared-duo/config.ts`, `src/duo/registry.ts` — flat `SharedDuoAnswer`, env-configured persona/usage paths, `/duos` silent-omission precedent.
- `src/commands/permissions.ts`, `src/commands/shared.ts`, `src/cli.ts:528-565` — the CLI wrappers this route mirrors; stdout/stderr field split.
- `src/permissions/directory.ts` — `resolveAsker` id matching, unresolved-safe default.
- `src/store/store.ts:109-133`, `src/derivation/rule-review.ts:70-79`, `src/shared-duo/usage-log.ts:51-57` — the fixed `rw-tmp` hazard and its in-repo documentation.
- `docs/solutions/best-practices/ask-token-cache-policy-immediate-revocation.md` — the cache-policy learning (KTD2's basis and the boundary tests).
- `docs/plans/2026-09-20-1356-feat-ask-link-tokens-plan.md` — #158's plan; R6 immediate revocation, owner-superset rule, KTD3 seam deferral.
- Issue #159 — acceptance criteria and out-of-scope list.

---

## Implementation Units

### U1. Kind-aware auth seam with principal

- **Goal:** The hook verifies ask tokens on `/ask` (and device tokens everywhere), attaches a principal, and keeps rate limiting unified with single failure accounting.
- **Requirements:** R1, R2, R3, R4.
- **Dependencies:** none.
- **Files:** `src/serve/auth.ts` (modify), `src/serve/server.ts` (principal type import only if co-located elsewhere), `test/serve-server.test.ts` (extend).
- **Approach:**
  1. Detect `/ask` via `request.routeOptions.url`; all other behavior byte-identical.
  2. On `/ask`: rate-limit precheck → device-cache check → `verifyAskToken` (uncached) → `verifyDeviceToken`; attach `{kind, name}` on the first success; one `recordFailure` and the uniform 401 message only after both kinds miss.
  3. Never write ask tokens into `verifiedTokens`; never `touchLastSeen` for ask principals.
- **Patterns to follow:** existing hook structure in `src/serve/auth.ts`; refusal helper `expectRefusedOnAllOwnerRoutes` in `test/serve-server.test.ts:111-141`.
- **Test scenarios:**
  - Valid ask token on `/ask` passes the hook (reaches the route; with U2 not yet present, assert not-401 or wire U1 and U2 in one commit if cleaner).
  - Revoked ask token: mint → one successful `/ask` → `revokeAskToken` → immediate second `/ask` is 401, no clock advance, no fake timers.
  - Expired ask token: sub-second expiry minted after a first success; next `/ask` is 401 within the would-be cache window.
  - Valid device token on `/ask` passes; a cache-missed device token still passes (two-decrypt path).
  - Ask token still refused byte-identically to an invalid device token on every owner-only route — the full 12-route inventory, not just the six GETs `ownerRoutes` pins today: add the parameterized GETs (`/drafts/:id`, `/mirror/rules`, `/mirror/rules/:id`) and the four POSTs (`/drafts`, `/drafts/:id/outcome`, `/drafts/:id/answer`, `/mirror/rules/:id/approve`, with dummy ids/bodies) so `expectRefusedOnAllOwnerRoutes` exercises every route and method.
  - The device stale-success test (`test/serve-server.test.ts:80-90`) passes unchanged.
  - Ten failed `/ask` auths from one IP → the next request is 429 via precheck; a single both-kinds-miss counts once (loop asserts the boundary at 10, not 5).
  - `/ask?x=1` (query string) is still matched as `/ask`.
- **Verification:** the scenarios above pass under `npx vitest run test/serve-server.test.ts`; owner-route refusal tests untouched.

### U2. POST /ask personal branch and response envelope

- **Goal:** The route exists, validates its body, delegates to `answerPublicly` exactly as `runAnswerPublicly` does, and answers 200 with the normalized envelope.
- **Requirements:** R5, R6, R7, R8 (personal side).
- **Dependencies:** U1.
- **Files:** `src/serve/server.ts` (modify), `src/commands/serve.ts` (modify — `ServeDeps.ownerName` from `config.ownerName`), `test/serve-server.test.ts` (extend, incl. the `deps()` helper).
- **Approach:**
  1. Add `ownerName: string` to `ServeDeps`; wire from config in `runServe`; update the test `deps()` helper (typecheck enforces all three).
  2. Register `POST /ask`: manual body checks in the `POST /drafts` style — `question` a string non-empty after trim else 400 `bad_request`; `duo` optional, `"personal"` default, unknown value 400 naming `personal, shared`.
  3. Personal branch mirrors `runAnswerPublicly` argument-for-argument (`storePath`, `passphrase`, `duoDir`, trimmed `question`, asker ref per KTD5, `embeddingProvider`, `inferenceProvider`, `confidenceConfig`, `ownerName`).
  4. Envelope per KTD4: 200 `{duo, kind, text, sources?, ...}`; full outcome fields appended only for `principal.kind === "device"`.
  5. Validate the body's shape before destructuring it: `request.body` may be `undefined` or a non-object on a bodyless or malformed POST — treat both as the missing-question 400 (the `POST /drafts` precedent destructures blind and would 500 on the same input).
  6. Wrap delegation in one catch: any error thrown by either answering branch answers 500 `errorBody("internal_error", "Something went wrong answering that.")` for every principal kind, with the real error logged server-side (`app.log`/`console.error`) and never echoed — deliberately NOT the `POST /drafts` no-catch precedent, because the asker-visible surface must not leak provider details or filesystem paths.
- **Patterns to follow:** `src/commands/permissions.ts` (`runAnswerPublicly`); `POST /drafts` body validation and `errorBody` usage in `src/serve/server.ts:115-143`.
- **Test scenarios:**
  - Empty store, valid ask token → 200 `passed_on`, envelope `kind` correct, asker-visible fields only (no `draftId`, `logEntryId`, `ownerNotice`).
  - `writeRefusalsFile(duoDir)` → 200 `declined_refused`.
  - Full fixture chain (template `test/public-answer.test.ts:47-107`) → 200 `answered` with `sources` present.
  - Same `passed_on` scenario with a device token → full fields including `draftId`/`logEntryId`.
  - A `passed_on` outcome carrying `ownerNotice` with an ask token → `ownerNotice` absent from the response.
  - Missing `question`, empty string, whitespace-only, non-string `question` → 400 `bad_request`.
  - Unknown `duo` value (including `"role"`) → 400 naming `personal, shared`.
  - A bodyless POST (no body at all) → 400 `bad_request` (missing question), not a 500.
  - A throwing embedding provider → 500 whose body contains neither the provider's error detail nor any filesystem path — the generic `internal_error` message only.
- **Verification:** scenarios pass; `npm run typecheck` clean (forces the `ownerName` wiring).

### U3. Shared branch and duo selector

- **Goal:** `duo: "shared"` reaches `answerSharedDuo` with the same isolation and freshness the CLI gets; unavailability is explicit.
- **Requirements:** R5, R6, R7, R10.
- **Dependencies:** U1, U2.
- **Files:** `src/serve/server.ts` (modify), `test/serve-server.test.ts` (extend — `deps()` also isolates `DUO_SHARED_USAGE_LOG_PATH`).
- **Approach:**
  1. Shared branch mirrors `runSharedAsk`: `loadSharedDuoConfig(deps.env)` for both paths, `loadSharedDuo` fresh per request, `answerSharedDuo(duo, question, askerId, usageLogPath)`.
  2. Missing or malformed persona (load failure of any kind) → 404 `shared_duo_unavailable` with the personal-fallback message; never a 500 from a thrown load error.
  3. Normalize per KTD4: `declined` + `out_of_scope` → `passed_on`; `not_a_decision_maker` → `declined_refused`; `citations` ride the answered envelope; `declineReason` is included for ask principals.
- **Patterns to follow:** `src/commands/shared.ts` (`runSharedAsk`); persona fixture template `test/shared-cli.test.ts:11-38`; `/duos` persona handling in `src/duo/registry.ts`.
- **Test scenarios:**
  - Persona fixture present, question matching a document → 200 `answered` with `citations`; attribution text intact.
  - Out-of-scope question → 200 `passed_on` (normalized), `declineReason` present.
  - Not-a-decision-maker question → 200 `declined_refused`.
  - No persona configured → 404 `shared_duo_unavailable`, message names the personal fallback.
  - Malformed persona JSON → same 404, not a 500.
  - Usage log path isolated per test; one ask appends exactly one entry with the asker's id.
  - The same shared ask returns byte-identical bodies for an ask-token principal and a device-token principal (the shared outcome carries no owner-only fields — R8).
- **Verification:** scenarios pass with both `DUO_SHARED_*` paths isolated in `deps()`.

### U4. Asker identity and log fidelity

- **Goal:** Every ask records who asked, the way the logs and #160 will need, without changing any answer behavior.
- **Requirements:** R9, and R6's log fidelity.
- **Dependencies:** U1, U2 (U3 for the shared leg).
- **Files:** `src/serve/server.ts` (modify), `src/cli.ts` (modify — one help-text line), `test/serve-server.test.ts` (extend).
- **Approach:**
  1. Ask principal: run `resolveAsker(name, loadDirectory(duoDir))` — that argument order — and pass `resolved ? identity.id : name` as the `askerRef`/`askerId` VALUE into the delegation, so the resolved id lands in the existing `public_answer_log.asker_ref` column / shared usage entry with no schema change; a thrown `InvalidDirectoryError` (malformed `directory.json`) falls back to the raw name so identity resolution never fails the ask (per KTD5). Device principal: fixed `"owner"`.
  2. Document the convention in `ask-link new`'s help: name the link with the asker's `duo/directory.json` id for log resolution.
- **Patterns to follow:** `src/permissions/directory.ts` (`loadDirectory` returns `[]` when missing, throws `InvalidDirectoryError` when malformed; `resolveAsker` is case-insensitive id match with the asker ref as the first argument).
- **Test scenarios:**
  - Ask token named for an in-directory id → the public-answer log row's `asker_ref` equals the directory id.
  - Ask token named "ZZZ-not-in-directory" → the row's `asker_ref` equals the raw name; response body identical in kind and text to the resolved case (no behavioral difference — R9).
  - Malformed `directory.json` → still 200 with the row's `asker_ref` equal to the raw name (no 500 from resolution).
  - Device token → log records `"owner"`.
  - Shared ask → usage-log entry carries the asker id.
- **Verification:** scenarios pass; no envelope differences between resolved and unresolved askers.

### U5. Pin the no-lost-rows invariant; document the residuals

- **Goal:** R11's no-lost-rows guarantee is pinned by a regression test rather than trust, and the real (cross-process) residuals are documented limitations.
- **Requirements:** R11, R12.
- **Dependencies:** U1, U2, U3.
- **Files:** `test/serve-server.test.ts` (extend), `README.md` (Development section — known limitations).
- **Approach:**
  1. No mutex, no new helper module, no `auth.ts` change: `withDatabase` is fully synchronous (`store.ts:109-133`) and every mutation on the ask and hook paths is one top-level self-contained call (KTD6), so interleaved requests cannot lose writes by construction.
  2. Pin that invariant with a concurrency regression test (concurrent asks → all rows exist) so a future async-store refactor cannot silently reintroduce a race — this test is the named proof of R11.
  3. Keep store mutations synchronous by convention (no `fs.promises`/`await` inside `withDatabase`); note the convention in the README limitation text so a refactor knows it is load-bearing.
  4. Document the known limitations in README's Development section: the cross-process daemon-vs-CLI store race (R12), the revoke-write-clobber instance (a `duo ask-link revoke` racing a daemon ask write can leave the revoked token verifiable — R3's durability rests on #158's deferred P1), and the passed-on notification gap.
- **Patterns to follow:** the existing `fastify.inject`-based tests in `test/serve-server.test.ts`.
- **Test scenarios:**
  - Two `/ask` requests in flight concurrently (`Promise.all` over two injects, personal, `passed_on` fixtures) → both 200, and both public-answer-log rows exist afterward (no lost write).
  - Shared branch: two concurrent shared asks → usage log has two entries.
  - The device stale-success test and owner-route refusal tests pass unchanged (nothing about the hook's writes moved).
- **Verification:** scenarios pass; `npm test` full-suite green; the device stale-success test and owner-route refusals unchanged.

---

## Verification Contract

- All commands under pinned Node 22.22.3 (`PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH"`); `node:sqlite` + FTS5 break otherwise.
- `npx vitest run test/serve-server.test.ts --testTimeout=60000` — the route and seam suites.
- `npm test` — full suite (baseline 1000/1000; new tests add to it).
- `npm run typecheck` — clean.
- No CI runs on this repo by design; these gates are the shipping evidence.
- Behavioral gates the suite must visibly pin: revoke/expiry boundary with no clock advance (R3); byte-identical ask-token refusal on every owner route (R2); the device stale-success window unchanged; single failure accounting (R4); no lost rows under interleaved asks (R11).

## Definition of Done

- All R-IDs hold and every unit's Verification is satisfied; full suite green and typecheck clean under pinned Node.
- Ask tokens still authorize exactly one route; every owner route's refusal is byte-identical to main's.
- The serve layer contains no answering, retrieval, or refusal logic — only delegation, validation, and the envelope.
- Boundary tests (revoke, expiry, rate-limit accounting, concurrency) exist and are the named proof of R3/R4/R11.
- The daemon-vs-CLI store race and the passed-on notification gap are documented limitations, not surprises.
- No dead-end or experimental code from abandoned approaches remains in the diff.
