# Digital Duo — Client Technical Design

> Route contracts, the daemon's seam with the existing code, the pairing protocol, and the
> design system. Last updated: 2026-09-19.
> Architecture, gating unknowns and adversarial review live in `client-design.md`; this document
> is what you build from once those are resolved.

---

# Part 0 — The rule this document exists to enforce

`client-design.md` 1.3 states it in one line: **adding a surface must not add a behaviour.** Every
route wraps a function that already exists and is already tested. Where the client needs something
the core cannot do, the core grows a function and a CLI command in the same change — never a route
with logic behind it that `duo` cannot reach.

Reading the code to write this surfaced three places where that rule bites immediately. They are
in 1.6, and they are the actual first commits.

---

# Part 1 — The daemon

## 1.1 Layout

```
src/
  serve/
    index.ts          createServer(deps) → Fastify instance. No side effects.
    boot.ts           duo serve: unlock, resolve deps, bind, listen
    auth.ts           device-token middleware
    routes/
      duos.ts  drafts.ts  mirror.ts  trust.ts  review.ts  audit.ts
    ws.ts             one channel: draft-ready
  commands/serve.ts   CLI entry, thin
```

`createServer` takes its dependencies as an argument and never reads `process.env`, so tests
construct it with a temp store and a fake provider — the same shape the command tests already use.

## 1.2 The seam: why the daemon does not call `commands/`

Every `run*` function in `src/commands/` resolves the passphrase itself:

```ts
// src/commands/draft.ts
export async function runDraft(question, threadContext, config, env = process.env) {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);  // ← reads data/.passphrase
  …
}
```

`resolveOrCreatePassphrase` falls back to reading `data/.passphrase` from disk, which is exactly
what `client-design.md` 1.4 forbids in serving mode. The `env` parameter offers a loophole —
`DUO_PASSPHRASE` wins, so the daemon *could* pass a synthetic env object — but that is a trick, not
a boundary, and it leaves the disk fallback one refactor away from reappearing.

**So the daemon depends on the module layer, not the command layer.** It holds one passphrase in
memory from boot and passes it explicitly:

| Daemon calls | Not |
|---|---|
| `draftReply(storePath, passphrase, duoDir, …)` | `runDraft(…)` |
| `listDrafts(storePath, passphrase)` | — |
| `listGrid(storePath, passphrase, duoDir)` | `runTrustGrid(…)` |
| `buildInterruptionPortrait(storePath, passphrase, duoDir)` | `runMirrorPortrait(…)` |
| `listCorrectionCandidates(storePath, passphrase, status)` | — |

Most `run*` functions are pure passphrase plumbing — `runMirrorRuleApprove` is three lines and a
call to `approveRule` — so the daemon simply calls the module function they wrap and loses nothing.

**One is not.** `runRecordDraftOutcome` orchestrates: record the outcome unconditionally, then
classify the edit, then queue candidates, swallowing `NoDraftTextError` because an escalated draft
has no text to diff. That sequence is load-bearing and duplicating it in a route handler would be
the second code path this document exists to prevent. **Extract its body into a module function
taking an explicit passphrase, and let both the CLI command and the route call it.** It is C1's
first commit and it should not change a single test.

## 1.3 Boot

```
duo serve [--host <tailnet-ip>] [--port 7717]
  1. requireStoreExists(config.storePath)
  2. passphrase ← DUO_PASSPHRASE, else interactive prompt (TTY only)
       never resolveOrCreatePassphrase — no disk fallback, ever
  3. refuse to start if host is absent, 0.0.0.0, or a non-loopback
     non-tailnet address  (client-design.md AR-12)
  4. embedding + inference providers resolved once
  5. listen; log the bound address and nothing else
```

Step 3 is a hard failure with an explanatory error, not a warning. A daemon holding a decrypted
government corpus must not be one absent flag away from listening on every interface.

## 1.4 Route contracts

Responses return the **domain types verbatim**. No DTO layer: a second set of shapes is a second
thing to drift, and the only client is the owner, so there is nothing to redact.

| Method | Path | Returns | Module |
|---|---|---|---|
| `GET` | `/duos` | `DuoSummary[]` *(new, 1.6)* | `duo/loader`, `shared-duo/loader` |
| `POST` | `/duos/:id/ask` | `AnswerForAskerResult` | `permissions/answer` |
| `POST` | `/drafts` | `DraftPipelineResult` | `drafting/pipeline` |
| `GET` | `/drafts?outcome=pending` | `DraftRecord[]` | `drafting/draft-log` |
| `GET` | `/drafts/:id` | `DraftRecord` | `drafting/draft-log` |
| `POST` | `/drafts/:id/outcome` | `ClassifyAndQueueResult \| null` | extracted from `commands/draft` |
| `POST` | `/drafts/:id/answer` | `{ candidateId: string }` | `drafting/standing-order-candidates` |
| `GET` | `/review` | `CorrectionCandidate[]` | `corrections/queue` |
| `GET` | `/mirror/portrait` | `InterruptionPortrait` | `derivation/portrait` |
| `GET` | `/mirror/rules` | `RuleReviewListing` | `derivation/rule-review` |
| `POST` | `/mirror/rules/:id/:action` | `Rule` | `derivation/rule-review` |
| `GET` | `/trust/grid` | `GridRow[]` | `trust/grid` |
| `GET` | `/audit` | `AuditEntry[]` | `permissions/audit` |

`POST /drafts` is the one slow route — self-consistency sampling runs `selfConsistencySamples`
completions. It returns `202` with a draft id immediately and pushes the result over the
WebSocket, because a phone on a tailnet will not hold a 40-second request open.

`DraftPipelineResult` is already a discriminated union on `kind`, so the client renders a draft and
an escalation from one switch with no shape-guessing:

```ts
type DraftPipelineResult =
  | { kind: "draft";      draftId: string; text: string;   sources: readonly DraftSource[]; confidence: ConfidenceResult }
  | { kind: "escalation"; draftId: string; reason: string; refused: boolean; confidence: ConfidenceResult | undefined }
```

`refused` exists so the client can tell **"won't"** from **"can't"** without parsing prose. They get
different treatments: a refusal is a boundary the owner set and should read as the system working;
a low-confidence escalation is the duo being honest and invites `POST /drafts/:id/answer`.

## 1.5 Errors

One shape, always:

```ts
{ error: { code: string; message: string } }
```

`code` is stable and switchable; `message` is the existing error's own text, which is already
written for a human — `UnsafeStorePathError` and `CorrectionCandidateNotFoundError` both explain
themselves better than a route handler would. Domain errors map to status directly:
`CorrectionCandidateNotFoundError` → `404`, `CandidateAlreadyReviewedError` → `409`,
`NoDraftTextError` → swallowed as it already is, never a `500`.

## 1.6 Three gaps in the core, found by reading it

**G-a · `listDrafts` has no CLI command.** `src/drafting/draft-log.ts` exports it, the CLI exposes
`draft`, `draft-outcome` and `draft-answer` — and nothing that lists. The Review surface is built
entirely on a function no user can currently reach. → Add `duo drafts list` in the same commit as
the route.

**G-b · `listDrafts` cannot filter or paginate.** It is `SELECT * FROM drafts ORDER BY created_at`.
Review wants `outcome IS NULL`; filtering client-side means shipping the entire draft log on every
poll, forever. → `listDrafts(storePath, passphrase, { outcome?: DraftOutcome | "pending", limit?, before? })`,
defaulting to today's behaviour so no caller changes.

**G-c · There is no "list my duos".** The sidebar is the first thing the client renders and nothing
returns it: `duo/loader.ts` resolves one duo from a definition and `shared-duo/loader.ts` resolves
the team's. → A `DuoSummary { id, name, kind: "own" | "shared", knowledgeKind: "derived" | "authored" }`
and a function that lists both, with `duo list` beside it.

Each is small. Each is a real gap the client would otherwise paper over with logic in a route
handler, which is the failure mode this document is written to prevent.

---

# Part 2 — Pairing and device tokens

Tailscale authenticates the *device onto the network*. It does not authenticate a client to the
daemon, and "anything on my tailnet is me" stops being true the moment a tailnet has a second
member or a shared node.

```
duo pair --name "iPhone"
  → token = base64url(randomBytes(32))
  → store sha256(token) in device_tokens(id, name, hash, created_at, last_seen_at, revoked_at)
  → print the token once, and a QR of it
```

- The daemon stores **only the hash**, so a stolen store yields no working token.
- Clients send `Authorization: Bearer <token>`; comparison is constant-time.
- `duo pair list` / `duo pair revoke <id>`. Revocation is immediate and closes that device's
  WebSocket.
- Losing the phone means revoking one token. It must never mean re-keying the store — which is
  the whole reason this is a separate secret rather than the passphrase.
- `last_seen_at` is recorded, because "which devices can read my corpus right now" is a question
  the owner should be able to answer.

Rate-limit auth failures and log them. On a private network the realistic attacker is a process on
a machine that is already on the tailnet, and that attacker gets to retry.

---

# Part 3 — The client

## 3.1 Routes

```
/review          ← default. badge = drafts where outcome is null
/duo/:id         thread view + composer
/mirror          portrait · rules · weak signals · refusals
/trust           grid, read-only on mobile (AR-17)
/audit
/settings        daemon address, device name, unpair
```

Mobile drops `/trust` and `/audit` to a single "More" section and hides rule authoring entirely
(AR-18). It is the same codebase and the same routes; the difference is which are reachable.

## 3.2 State

TanStack Query for everything server-shaped. Keys mirror the routes so invalidation is obvious:

```ts
["drafts", { outcome: "pending" }]   // invalidated by any outcome POST and by draft-ready
["review"]                           // invalidated by an outcome POST — an edit queues a candidate
["mirror", "rules"]  ["mirror", "portrait"]  ["trust", "grid"]  ["audit"]
```

The only client-owned state is the composer buffer and UI preferences. No Zustand, no Redux: there
is one writer (the daemon) and the cache is the model.

`POST /drafts/:id/outcome` with `edited` invalidates **both** `["drafts"]` and `["review"]`, because
one action writes the draft row and queues a correction candidate. Missing the second is the
easiest bug to ship here and the hardest to notice.

## 3.3 Offline

The query cache persists to storage and rehydrates at launch. When the daemon is unreachable:

- Cached views render, with a persistent bar: **"Last synced 14:32. Your Mac is unreachable."**
- Every mutation control is **disabled, not queued.** A Send that fires two hours later against
  context that has moved is worse than no Send. This is `client-design.md` AR-15, and it is a
  product decision, not a technical limitation to be engineered around later.
- Reconnect refetches rather than replaying.

## 3.4 The labelling contract

`concept.md`: *"always labelled … it never poses as you."* `client-design.md` AR-13 promotes this
from a guideline to a structural rule, which means it needs a mechanism, not a convention.

- One component, `<DuoMessage>`, renders every piece of duo-generated text. It has no `avatar`
  prop. There is nothing to pass.
- `<OwnerMessage>` renders the owner's own words — sent replies, typed questions — and is the only
  component that accepts the owner's identity.
- An ESLint rule forbids the owner's avatar component inside `DuoMessage`'s subtree, and a unit
  test asserts a rendered draft contains the duo attribution string. A principle with a failing
  test is a principle; one in a style guide is a hope.

---

# Part 4 — Design system

`client-design.md` 1.6 sets the intent. These are the values.

```css
:root {
  --bg:        #0B0C0E;   --surface:  #141619;   --surface-2: #1C1F24;
  --text:      #E8EAED;   --muted:    #9AA0A6;   --faint:     #5F6469;
  --accent:    #7C8CFF;                  /* action available. nothing else. */
  --edge:      #24282E;
  --escalate:  #D9A441;   --confident: #4B9E6A;  --refused:   #6B7280;

  --r-sm: 6px;  --r-md: 10px;  --r-lg: 14px;
  --sp: 4px;                             /* every spacing value is a multiple */
  --t: 150ms cubic-bezier(0.2, 0, 0, 1);
}
```

- **Type.** Inter, or SF on Apple platforms. Body 14/22. Headings tighten to `-0.011em`; body does
  not. One weight jump only — 400 and 560.
- **Density.** 12px vertical padding per message, 20px between speakers. Measurably airier than
  Slack's 8/8, because this surface shows a handful of considered drafts, not hundreds of lines.
- **The confidence hairline.** 2px on the draft's leading edge. Three states, derived from real
  fields — never a percentage, which is precision `confidenceScore` does not have:

  | State | Condition | Colour |
  |---|---|---|
  | Refused | `kind === "escalation" && refused` | `--refused` |
  | Escalated | `kind === "escalation"` | `--escalate` |
  | Hedged | `score < threshold + 0.15` | `--escalate` at 40% |
  | Confident | otherwise | `--confident` |

  `threshold` ships in `ConfidenceResult` rather than being hardcoded, so a config sweep moves the
  UI with it.
- **Motion.** `--t` on state change only. A draft arriving may animate. Scrolling, hover and tab
  switches may not.
- **Light mode** exists and is not the default. Same tokens, inverted ramp, identical contrast
  targets: AA for body, AAA for the muted ramp, because `--muted` carries provenance text that is
  load-bearing.

---

# Part 5 — Testing

Matching the repo's existing vitest setup:

| Layer | Approach |
|---|---|
| Routes | `fastify.inject()` against a temp store seeded by the existing test helpers. No network. |
| The seam | The extracted module functions from 1.2 keep their current command tests, unchanged. That they do not change is the evidence the refactor was safe. |
| Auth | Token hashing, constant-time compare, revocation closes the socket, and a test asserting boot **refuses** `0.0.0.0`. |
| Client | Testing Library on the reducers and the draft/escalation switch. |
| Labelling | The AR-13 test in 3.4. It gates the build. |

No end-to-end browser suite for the pilot. The audience is one person and the cost is not repaid.

---

# Part 6 — Work breakdown

One new epic. Steps match `client-design.md` Part 4's C-numbering.

| Step | Work | Blocked by |
|---|---|---|
| C1.0 | Extract `runRecordDraftOutcome`'s body into a passphrase-explicit module function. No behaviour change, no test changes. | — |
| C1.1 | G-a, G-b, G-c: `listDrafts` filter + pagination, `duo drafts list`, `DuoSummary` + `duo list` | — |
| C1.2 | `src/serve/`, `createServer`, read-only routes, `fastify.inject` tests | C1.0, C1.1 |
| C2.0 | Serving-mode unlock; boot refuses a non-tailnet bind | G3 |
| C2.1 | `device_tokens`, `duo pair` / `list` / `revoke`, bearer middleware | C2.0 |
| C3 | Client shell: Vite + React + Tailwind + shadcn, tokens from Part 4, route tree | C1.2 |
| C4 | Review surface, `<DuoMessage>`, the confidence hairline, the labelling test | C3 |
| C5 | Tauri v2 macOS shell, native notifications | C4 |
| C6 | Mirror browser: portrait, rules, weak signals, approve / reject / promote | C4 |
| C7 | WebSocket draft-ready, cache persistence, offline bar | C5 |
| C8 | Tauri v2 iOS / Android targets | G4, C7 |

C1.0 and C1.1 touch only existing code and are unblocked by G3 and G4 both — they are worth doing
whatever the MDM conversations return, because `duo drafts list` is a gap in the CLI today.
