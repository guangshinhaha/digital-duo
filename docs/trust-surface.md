# Trust writes and the remote — decision record (#179)

**Status: PROPOSED — awaiting owner ratification on #179.** Nothing in this record has been
built. Like the workspace-platform decision (#185, recorded in `workspace-platform.md` after
PR #194), this document exists so the constraint stops looking accidental: either trust writes
are permanently CLI-only for a reason we can state, or they are exposeable under requirements we
can name.

## The question

`client-design.md` AR-17 justifies the read-only trust grid with "the daemon has no route to
change a tier or level, so a control there would be a promise the core would refuse." That is a
consequence, not a principle. The CLI has `trust grant`, `trust promote`, `trust correct` and
`trust ledger`. Should granting autonomy be possible from a client at all, or must it stay an
act performed at the machine holding the corpus?

## What exists today

| Surface | Verb | Module function |
| --- | --- | --- |
| CLI | `duo trust grant <text> --tier <T0–T3> [--topic <id>]` | `grantAutonomy` (`src/trust/grants.ts`) |
| CLI | `duo trust promote <topicId> <tier> --accept\|--decline` | `acceptPromotionOffer` / `declinePromotionOffer` (`src/trust/promotion.ts`) |
| CLI | `duo trust correct <topicId> <tier> --reason <text>` | `applyCorrection` (`src/trust/demotion.ts`) |
| CLI | `duo trust ledger` / `duo trust promotions` / `duo trust grid` | `listLedgerEntries` / `getPendingPromotionOffers` / `listGrid` |
| HTTP | `GET /trust/grid` | `listGrid`, verbatim (`src/serve/server.ts`) |

The HTTP surface stops at the read. Every write is terminal-only today.

## The decision

**Trust writes are not permanently CLI-only. Exposing them over HTTP is correct in principle,
pending the requirements below — the principle that governs trust writes is deliberateness
with provenance, not physical presence at the corpus.**

Three pieces of evidence carry it:

1. **The location argument is already settled, the other way, by heavier acts.** The daemon's
   owner surface already includes `POST /actions/t4/:id/confirm` (`src/serve/server.ts` — the
   single most consequential confirmation in the system, exposed in #180 with the confirming
   device's `tokenId` as provenance) and `POST /lifecycle/end` (#181 — deletes the store,
   evicts every cached token, the product's own "instantly killable" promise, `concept.md`
   line 210). A paired device that may *end the duo* and *confirm a T4 action* cannot coherently
   be denied a trust grant on the grounds that grants are too consequential for a phone. If
   those two routes are wrong to expose, that is a #180/#181 problem to reopen — not a reason
   this one stays terminal-bound.

2. **The principle `concept.md` §6 actually states is about how a grant feels, not where it is
   typed.** "Promote slowly — a cell offers to graduate after N clean instances *and an explicit
   tap from the owner*. Never silently. The owner must feel they granted it" (`concept.md`
   lines 114–115), and "Demote fast — one correction drops the cell a level immediately." The
   promotion flow is *defined* as an explicit tap on a batched, evidence-bearing offer — a
   phone is the natural surface for exactly that mechanic, not a violation of it. And the
   owner-only property does not live in the terminal: `grantAutonomy`'s own comment says "a
   CLI command only they can run" (`src/trust/grants.ts`), but what enforces *only they* on
   HTTP is the auth seam's table separation — ask tokens are refused byte-identically on every
   owner route, whatever their state (#158). A paired device is the owner's own remote:
   `client-design.md` line 48 — "The phone does not get a copy of the duo; it gets a window
   onto the one running on the [Mac]."

3. **The write semantics are already bounded by construction, so a route adds no capability.**
   T4 is unrepresentable at every layer: `TrustTier` excludes it, and the `CHECK (tier IN
   ('T0','T1','T2','T3'))` constraint holds even against raw SQL (`src/trust/grid.ts`, the
   `ensureTrustSchema` doc block — "There is and can be no row in this table for T4"). Grants
   are reversible (`applyCorrection` demotes at once), every trust event lands in the ledger
   (reconstructible — #55), ambiguity returns candidates instead of guessing
   (`GrantOutcome.status: "ambiguous"`), a conflicting written refusal always wins, and a T3
   grant enters capped at `"approve"` (#59). "Adding a surface must not add a behaviour"
   (`client-design.md` line 109) is the surviving rule from the original read-only-daemon
   conception — and it points at module-sharing, not at CLI-only.

## What exposing would require

Recorded so the eventual implementation PR has its constraints written down. None of this is
built here.

1. **One shared module path, no second code path** — the issue's own conditional AC. Routes
   call the same `grantAutonomy` / `acceptPromotionOffer` / `declinePromotionOffer` /
   `applyCorrection` the `runTrust*` commands call; the commands delegate their tails exactly
   as `runImportPaste` delegates to `importPastedTranscript` (#176) and both `runEnd` and
   `POST /lifecycle/end` call `endDuoAndRecord` (#181). A grant made either way must read
   identically in the grid.
2. **The T4-bypass attempt log moves into the shared seam.** Today a `--tier T4` grant attempt
   is refused *and* recorded as `refused_t4_bypass` in the action attempt log — but that
   logging lives in `runTrustGrant`'s command wrapper (`src/commands/trust.ts`), before tier
   parsing. Exposed naively, an HTTP path would refuse (nothing else is possible) without
   logging. The logging must move to the module boundary so both surfaces refuse-and-record
   identically. The `CHECK` constraint remains the enforcement either way; the log is the
   accountability, not the barrier.
3. **Provenance in the ledger.** Every trust write over HTTP records the acting device via
   `request.principal?.tokenId` — the same provenance `POST /actions/t4/:id/confirm` carries
   (#160/#211, #180). "The owner must feel they granted it" includes being able to see *from
   where* it was granted when reading `trust ledger`.
4. **Deliberateness preserved verbatim.** An ambiguous grant refuses and returns its candidates
   — a client renders a picker; it never best-guesses. A refusal conflict refuses. T3 caps at
   `"approve"` on first grant. Corrections take an explicit reason. None of these get a
   "quick" variant for the phone; the friction is the feature.
5. **T4 stays absent, including visually.** AR-17's UI rule carries over unchanged: T4 is not
   a disabled fifth row, it is absent, unknown cells render as `ask` matching
   `resolveAutonomy`'s default, and no client path can write a cell the CLI could not — which
   remains literally true under the shared-path requirement.

## What would reopen this

- #180/#181 being reopened (if T4-confirm or end-over-HTTP is judged wrong, the
  consequentiality ladder above collapses and this decision should be re-argued).
- A future grant semantics that is *not* reversible-or-capped at the module layer (if a write
  ever exceeds the T4-confirm/end envelope of consequence without a module-level bound).
- The auth seam's owner/ask table separation weakening in any way.

Until ratified, nothing changes: the grid stays read-only over HTTP, and the terminal remains
the only place a tier or level moves.
