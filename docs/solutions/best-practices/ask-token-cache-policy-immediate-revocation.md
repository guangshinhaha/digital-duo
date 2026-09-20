---
title: Choose the ask-token cache policy deliberately when wiring verifyAskToken behind POST /ask
date: 2026-09-20
category: docs/solutions/best-practices/
module: src/serve/tokens.ts (verifyAskToken) and src/serve/auth.ts (registerAuth success cache)
problem_type: best_practice
component: authentication
severity: medium
applies_when:
  - wiring verifyAskToken behind POST /ask in issue #159
  - reusing registerAuth's 5s success cache (TOKEN_CACHE_TTL_MS, keyed by raw token) for a token kind with immediate-revocation semantics
  - routing any short-lived or immediately-revocable token kind through a shared verification cache
  - adding a new token kind to the serve token layer (src/serve/tokens.ts)
symptoms:
  - a revoked ask token is still accepted on POST /ask for up to TOKEN_CACHE_TTL_MS (5s) after revocation
  - an expired ask token is still accepted for up to the cache TTL past expires_at
  - the stale success is silent - the store shows revoked_at set but the endpoint keeps admitting the token, with no error or log marking the divergence
  - no failing test catches the contract break because revocation-then-immediate-use is never exercised
related_components:
  - api_layer
  - testing_framework
tags:
  - ask-token
  - token-revocation
  - cache-invalidation
  - auth-hook
  - serve-layer
  - issue-159
---

# Choose the ask-token cache policy deliberately when wiring verifyAskToken behind POST /ask

## Context

Issue #158 (open as of this writing; its implementation ships in this branch's PR) adds a second, short-lived, ask-only token kind to the serve token layer: an `ask_tokens` table (src/serve/tokens.ts:175-186) with `createAskToken` (src/serve/tokens.ts:197), `listAskTokens` (src/serve/tokens.ts:215), `revokeAskToken` (src/serve/tokens.ts:231), and `verifyAskToken` (src/serve/tokens.ts:253). The verify primitive is deliberately read-only — it opens the store with `withDatabase(storePath, passphrase, false, ...)` (src/serve/tokens.ts:254) — and decides everything in one predicate: `WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?` (src/serve/tokens.ts:257). Revocation is immediate by contract: #158's R6 requires that `duo ask-link revoke` take effect on the very next verification (docs/plans/2026-09-20-1356-feat-ask-link-tokens-plan.md:52), and `revokeAskToken` implements it as a direct store write (`UPDATE ask_tokens SET revoked_at = ?`, src/serve/tokens.ts:234).

Nothing exercises `verifyAskToken` on a request path yet. Its only callers are unit tests (test/serve-tokens.test.ts:93-127); the daemon's auth hook (`registerAuth`, src/serve/auth.ts:48) imports and calls only `verifyDeviceToken` and `touchLastSeen` (src/serve/auth.ts:2, :116, :135) and never mentions ask tokens — refusal on every existing route is structural, by table separation (src/serve/tokens.ts:151-152). `createServer` registers that hook before any route (src/serve/server.ts:234-235), and the hook exempts only `/health` (src/serve/auth.ts:79). Issue #159 will change this by wiring `verifyAskToken` behind `POST /ask`, where valid device tokens may also ask (owner superset; docs/plans/2026-09-20-1356-feat-ask-link-tokens-plan.md:32).

Sitting beside that future seam is a success cache. `registerAuth` keeps `verifiedTokens`, an in-memory `Map` keyed by the raw bearer-token string parsed from the header (src/serve/auth.ts:54, :96), and trusts a cached success without re-checking the store for `TOKEN_CACHE_TTL_MS = 5_000` (src/serve/auth.ts:17; the freshness check is `now - cached.verifiedAt <= TOKEN_CACHE_TTL_MS`, src/serve/auth.ts:112-113). The cache exists to spare one full store decrypt — scrypt key derivation plus AES-GCM over the whole file — per request from a polling device client; that rationale is documented at the top of the file (src/serve/auth.ts:7-16).

What no artifact records — not #158's code, tests, or plan — is that these two designs collide at #159's seam: a 5-second stale-success window and R6's very-next-use revocation cannot both hold if the cache is reused as-is. The plan's KTD2 weighs a cache hazard only to reject use-counts ("opens a cache-then-consume race", docs/plans/2026-09-20-1356-feat-ask-link-tokens-plan.md:77); the success-cache TTL hazard for revocation and expiry enforcement is unrecorded. This learning closes that gap. (Provenance: established during the pre-ship code review of #158's implementation.)

## Guidance

When #159 wires `verifyAskToken` into the request path, choose the ask-token cache policy deliberately — a stated decision, never an inheritance from the device-token path. Two sound options:

(a) **Verify ask tokens uncached, per request.** Each `POST /ask` bearing an ask token pays one store decrypt inside `verifyAskToken` — exactly the tradeoff the primitive's read-only design already documents (src/serve/tokens.ts:245-252, inheriting the cost rationale from `verifyDeviceToken`'s doc comment, src/serve/tokens.ts:106-117). The load fits: ask links are short-lived credentials minted one per person (src/serve/tokens.ts:145-147), so asks are human-paced, not the several-GETs-per-page-load polling the cache was built for (src/serve/auth.ts:10-14). Code sites: #159's route/hook seam only — `src/serve/auth.ts` and `src/serve/server.ts` were deliberately untouched in #158 (KTD3, docs/plans/2026-09-20-1356-feat-ask-link-tokens-plan.md:78), so the kind-aware seam is entirely #159's diff.

(b) **Key or invalidate so a revoked or expired ask token can never hit a stale success entry.** If caching is kept, it cannot be the raw-token-keyed, TTL-only map as-is: use a separate ask-token map (or kind-qualified key) whose lookup still evaluates expiry — the existing entry stores only `{deviceId, verifiedAt}` (src/serve/auth.ts:28-31) and carries no `expiresAt` to re-check — or simply bypass the cache on the ask path. Do not rely on revoke-time invalidation as the mechanism: `duo ask-link revoke` is a CLI-side store write (src/serve/tokens.ts:231-243) while the cache is daemon-process memory, so a revoke cannot purge it. That asymmetry is why (a) is the simpler correct default. (Kind-qualified keying is about policy, not collision: both kinds are 32 random bytes — src/serve/tokens.ts:61, :199 — so raw strings will not realistically collide.)

Whichever is chosen, pin the boundary with a test: revoke (or expire), then immediately request `/ask`, and assert refusal on the very next request, with no clock advance — the route-level analogue of the unit test that already pins the primitive (test/serve-tokens.test.ts:108-113).

## Why This Matters

Reusing the cache as-is delays revocation and expiry enforcement by up to the TTL. A cache hit short-circuits before any store read (src/serve/auth.ts:112-113), so a success entry created just before a revoke keeps authorizing `/ask` for up to 5 seconds after `duo ask-link revoke` returned — silently breaking R6's very-next-use contract (docs/plans/2026-09-20-1356-feat-ask-link-tokens-plan.md:52). The failure-side eviction does not save you: `verifiedTokens.delete(token)` runs only when verification is actually attempted and fails (src/serve/auth.ts:118), and the stale success means verification is never attempted. Expiry degrades identically — the cached entry holds no `expiresAt` (src/serve/auth.ts:28-31), so an expired token rides its success entry to the end of the TTL, breaking the expiry semantics #159 promises askers.

The break is silent because it hides behind an in-repo precedent: for device tokens, post-revoke success inside the window is documented, intended behavior — "a revoked device stops working within one ordinary polling interval" (src/serve/auth.ts:14-15) — and the suite asserts it: revoke, then immediately re-request, returns 200 (test/serve-server.test.ts:80-90). An implementer reusing the cache for ask tokens is copying a pinned pattern; only the contract differs, and nothing in the code states that difference.

A naive test would not catch the drift: any test that advances time or sleeps past 5 seconds before re-requesting passes under the wrong wiring. Only the no-clock-advance boundary test exposes it — and it needs no fake timers, for which this repo has no precedent (KTD4, docs/plans/2026-09-20-1356-feat-ask-link-tokens-plan.md:79; the established pattern is caller-supplied ISO expiry dates, test/serve-tokens.test.ts:87, :117). Meanwhile the cost being bought back is one store decrypt per human-paced ask — the exact tradeoff `verifyAskToken`'s read-only design already accepted (src/serve/tokens.ts:254, :245-252).

## When to Apply

Apply whenever `verifyAskToken` — or any revocable, expiring credential — moves behind a per-request auth path that already has, or tempts toward, a success cache. The concrete instance is #159's `POST /ask` diff: the kind-aware seam was deliberately deferred to it (KTD3, docs/plans/2026-09-20-1356-feat-ask-link-tokens-plan.md:78, :68), and #158's server tests pin only refusal on today's owner routes (test/serve-server.test.ts:127-141), never acceptance on `/ask`. Reapply the same reasoning for any future credential kind added to src/serve/tokens.ts beside the existing cache: the stricter the revocation or expiry contract, the less a shared TTL cache can be inherited unexamined.

## Examples

**Wrong wiring — inherit the device-token cache as-is at #159's seam (what not to do):**

```
POST /ask (ask token)     -> 200; success cached under the raw token
                             (mirroring src/serve/auth.ts:129)
duo ask-link revoke <id>  -> store row updated (src/serve/tokens.ts:234);
                             the daemon's verifiedTokens is untouched
POST /ask again, < 5 s    -> cache hit (src/serve/auth.ts:112-113) -> 200
                             R6 broken: the very next use must refuse
```

That window is real, not theoretical — the suite asserts the identical sequence succeeds for device tokens today (test/serve-server.test.ts:85-89).

**Deliberate policy — option (a) plus the boundary test.** The `/ask` path calls `verifyAskToken` on every request and never consults or populates `verifiedTokens` for ask tokens; then pin the boundary:

```ts
it("refuses a revoked ask token on the very next /ask request, with no clock advance", async () => {
  const minted = createAskToken(storePath, PASSPHRASE, "Sam",
    new Date(Date.now() + 3_600_000).toISOString()); // caller-supplied ISO expiry (KTD4 pattern)
  const first = await app.inject({ method: "POST", url: "/ask",
    headers: { authorization: `Bearer ${minted.token}` } });
  expect(first.statusCode).toBe(200); // success — under the wrong wiring, this is what gets cached

  revokeAskToken(storePath, PASSPHRASE, minted.id); // immediate store write (src/serve/tokens.ts:234)

  const second = await app.inject({ method: "POST", url: "/ask",
    headers: { authorization: `Bearer ${minted.token}` } });
  expect(second.statusCode).toBe(401); // very next use must refuse (R6) — no sleep, no clock advance
});
```

The revoke leg mirrors the unit-level precedent "rejects a revoked ask token immediately" (test/serve-tokens.test.ts:108-113). The expiry leg mints a sub-second expiry the same way (`createAskToken` takes any ISO string, src/serve/tokens.ts:197): verify once successfully, let a few hundred real milliseconds pass — well inside the 5-second TTL, so a stale success entry would still be live under the wrong wiring — then request `/ask` immediately and assert 401. The exact #159 request shape (route, body, status codes) is that issue's to settle; the load-bearing part here is the no-clock-advance sequence.

## Related

- docs/plans/2026-09-20-1356-feat-ask-link-tokens-plan.md — #158's plan; defines the read-only verifyAskToken primitive, the R6 immediate-revocation contract, and #159's POST /ask as the future consumer.
- Issue #159 — the future consumer this learning is written for.
- Issue #158 — the feature whose R6 contract this learning guards at the wiring boundary.
- Issue #160 — adjacent consumer: a stale success cache would also feed stale asker context into the audit trail.
- src/serve/auth.ts — the hazard site: TOKEN_CACHE_TTL_MS and the verifiedTokens success cache keyed by raw token.
- src/serve/tokens.ts — verifyAskToken, whose per-call predicate this learning keeps any cache layer from weakening.
