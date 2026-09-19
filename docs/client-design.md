# Digital Duo — Client Surface Design

> The Mac app, the phone app, and the daemon behind both.
> Last updated: 2026-09-19 · Extends `v1-tech-design.md`. Gating unknowns and adversarial
> review continue that document's numbering.

---

# Part 0 — Two gating unknowns, resolve before writing code

Same rule as `v1-tech-design.md` Part 0: these are not risks to manage, they are decisions that
invalidate the design if they go the wrong way.

### G3 — Can a persistent daemon and a mesh VPN run on the managed Mac?

The whole thin-client design rests on `duo serve` running on the owner's machine and the phone
reaching it over Tailscale. Managed government endpoints commonly block both halves: MDM profiles
restrict background LaunchAgents, and VPN-shaped software is a standard blocklist entry.

| Outcome | Consequence |
|---|---|
| Daemon + Tailscale both permitted | Best case. Build as designed. |
| Daemon permitted, Tailscale blocked | Mac app only over `localhost`. Phone waits for a sanctioned transport. The Mac app still closes the loop and is still worth shipping. |
| Neither permitted | The client is a local web app the CLI opens in a browser — `v1-tech-design.md` 1.2's original "Mirror UI" line, no more. Mobile is dead until v2's hosting question is reopened. |

**Check this before any client code.** It is an MDM policy question, not a sprint.

### G4 — Can you install your own build on your own phone?

A Tauri iOS build needs signing, and getting it onto a device needs an Apple Developer account
plus either TestFlight or a direct install. A supervised, MDM-enrolled phone can refuse all of
these, and a personal phone reaching a work machine over Tailscale may itself be the policy
problem rather than the solution.

**Mitigation that needs no approval:** the client is a web app first (build step C3) and a
packaged app second. A responsive web client reached over Tailscale in mobile Safari is not as
good, but it is not blocked on Apple or on MDM, and it proves the surface before anyone signs
anything.

---

# Part 1 — The design

## 1.1 Shape: one daemon, two clients, still no cloud

`v1-tech-design.md` 1.1 committed to a local application: no hosting, no public endpoint, no
inbound firewall rule, no data at rest on third-party infrastructure. **Nothing here changes
that.** The phone does not get a copy of the duo; it gets a window onto the one running on the
Mac.

```
┌──────────────────── owner's machine ────────────────────┐
│                                                          │
│  duo/  ·  data/duo.db        ← unchanged                │
│                                                          │
│  duo serve  ────────────────────────────┐               │
│    holds the passphrase in memory       │               │
│    binds the Tailscale interface only   │               │
│    HTTP + WS                            │               │
└─────────────────────────────────────────┼───────────────┘
                                          │ tailnet, no public URL
                    ┌─────────────────────┴─────────────────┐
                    │                                       │
              Mac app (Tauri)                      Phone (Tauri / web)
              full surface                         read · review · approve
```

The reasoning is the same one that picked Socket Mode for Slack: an **outbound-only or
private-network** transport means there is no public URL to expose, no inbound rule to request,
and no security review on the critical path.

## 1.2 Stack

| Layer | Choice | Why |
|---|---|---|
| Shell | **Tauri v2** | One codebase → macOS, iOS, Android. Stable since Oct 2024, 2.11.x by mid-2026. Bundles ~3 MB against Electron's ~96 MB. |
| UI | React + Tailwind + **shadcn/ui** | The layer every open-source Slack clone is built from, without inheriting their backend. |
| Daemon | Node + Fastify, in this repo | Same process model as the CLI; imports the existing modules directly rather than shelling out. |
| Transport | HTTP + WebSocket over Tailscale | No public URL, no inbound firewall rule. |
| Auth | Per-device bearer token | Tailscale gives you a network boundary, not an identity. |
| Server state | TanStack Query | Cache, refetch, and the offline story of 1.7 for free. |

Hono is equally defensible in place of Fastify and lighter; the HTTP boundary means the choice
does not lock anything in either way.

**Do not fork a Slack clone.** The live candidates (OpenHive, sralk, the Convex-based ones) are
human-to-human messaging products: workspaces, members, presence, WebRTC, backed by
Supabase/Postgres/Redis/NATS. Adopting one means deleting most of it and then bolting a
multi-tenant cloud backend onto a single-user encrypted local store — the exact posture 1.1
exists to avoid. Take the component layer, not the product.

## 1.3 The API surface

Every core module already takes `(storePath, passphrase, duoDir, …)`. The daemon resolves those
three once at boot and the routes are thin wrappers — no reimplementation, no second code path.

| Endpoint | Backed by | Notes |
|---|---|---|
| `GET /duos` | `duo/registry.ts` | The sidebar: your duo, plus the shared one if configured. |
| `POST /drafts` | `drafting/pipeline.ts` | Relevance gate → confidence → draft **or** escalation. Asking your own duo something *is* drafting — there's no separate ask action for it, same as the CLI. |
| `POST /drafts/:id/outcome` | `corrections/classify.ts` | Send / Edit / Ignore. The edit is the training signal. |
| `GET /review` | `corrections/queue.ts` | The batched queue. Never auto-writes. |
| `GET /mirror/portrait` | `derivation/portrait.ts` | The interruption portrait. |
| `GET /mirror/rules` | `derivation/rule-review.ts` | Rules, weak signals, conflicts. |
| `POST /mirror/rules/:id/:action` | `derivation/rule-review.ts` | Approve, reject, promote a weak signal. |
| `GET /trust/grid` | `trust/grid.ts` | Read-only on mobile (AR-17). |
| `GET /audit` | `permissions/audit.ts` | Every answer, already logged. |

Adding a surface must not add a behaviour. If the client needs something the CLI cannot do, that
is a gap in the core, and it gets fixed in the core.

This table is the shape of the idea; `client-tech-design.md` §1.4 is the actual route contract —
exact paths, response types, and the two deliberate omissions (no `/duos/:id/ask`, no async
draft pipeline yet) — and is authoritative where the two differ.

## 1.4 The unlock problem

`src/store/passphrase.ts` generates a random passphrase and persists it beside the store at
`data/.passphrase`, mode `0600`. That is a sound trade for a CLI whose only reader is you, on
your laptop — `v1-tech-design.md` 1.2 says as much: *"it is your laptop."*

A network daemon breaks that trade, because encryption at rest protects a stolen disk, not a
listening socket. See AR-12. The design consequence:

- `duo serve` takes the passphrase **at start**, from `DUO_PASSPHRASE` or an interactive prompt,
  and never falls back to reading `.passphrase` from disk.
- It binds the tailnet interface explicitly. Never `0.0.0.0`, never a default that could become
  `0.0.0.0` by omission.
- Every client presents a per-device token, issued by an explicit CLI pairing step and revocable
  from the Mac. Losing the phone must not mean re-keying the store.

## 1.5 Information architecture — Slack-shaped, deliberately not Slack

Slack's model is *channels are people*. Here, channels are duos, and two things do not fit.

**Drafts are not messages.** The Send / Edit / Ignore loop is where the product's value and its
entire training signal live. In a chat transcript an action has no home: it scrolls away, and an
ignored draft looks exactly like an unread one. **Review is its own surface** with its own badge,
not a message type (AR-14).

**The duo is not you.** `concept.md` is unambiguous — *"it never poses as you"*, *"always
labelled."* Slack's grammar is avatar + name + body, identical chrome for a person and a bot.
That grammar, adopted unchanged, produces the one thing the product principle forbids (AR-13).

```
┌──────────┬───────────────────────────────┬──────────────┐
│ Review ③ │                               │              │
│          │   thread                      │  provenance  │
│ My duo   │                               │   rules hit  │
│ Shared   │   ── question ──              │   past pairs │
│          │   ── duo draft ──             │   confidence │
│ Mirror   │      [Send] [Edit] [Ignore]   │              │
│ Trust    │                               │              │
└──────────┴───────────────────────────────┴──────────────┘
```

Review sits **above** the duo list, because it is the thing you open the app for. The provenance
rail is permanent, not a disclosure triangle: "why did it say that" is the product's core promise
and it should cost zero clicks.

## 1.6 What "sleek" means here, concretely

A hard requirement stated as an adjective is not testable. Making it so:

- **Dark by default.** This is a tool left open beside a terminal all day.
- **One accent colour.** Everything else greyscale. The accent means *action available* and
  nothing else, which is what makes a pending draft findable in peripheral vision.
- **Airier than Slack.** Slack's density serves hundreds of daily messages. This surface shows a
  handful of considered drafts; crowding them reads as cheap.
- **Confidence is never a percentage.** The score is a weighted composite with a 0.55 escalation
  threshold — rendering "62%" is precision the number does not have. A three-state hairline on
  the draft's leading edge: escalated, hedged, confident.
- **Duo output is structurally distinct.** A different container, not a badge on the same one.
  Never the owner's avatar on generated text.
- **Motion only on state change**, 150 ms, ease-out. A draft arriving may animate. Scrolling may
  not.

## 1.7 Realtime, notifications, and being offline

The WebSocket carries one thing: *a new draft is waiting*. Everything else is request/response,
because nothing else in this product is time-critical.

Notifications are honest about the architecture. On the Mac, the daemon is local and native
notifications work. On the phone, a notification can only arrive while the tailnet connection is
live — **true background push would need a relay with a public endpoint, which 1.1 forbids.** That
is a real limitation, not an oversight, and it is the same forcing function `AR-10` already named
for v2's hosting question.

So offline is a designed state, not an error: the last synced view stays readable, marked with an
explicit timestamp, and every action is disabled rather than queued. A queued Send that fires
hours later against stale context is worse than no Send at all.

---

# Part 2 — Adversarial review

Continuing `v1-tech-design.md` Part 2's numbering, ranked by how likely each is to kill the
surface.

### AR-12 · The daemon turns encryption at rest into decoration — HIGH
The store passphrase sits in plaintext beside the store. Against a stolen laptop that is still
fine. Against a listening socket it is not: the daemon holds the key in memory and answers
questions over HTTP, so anything that reaches the port has the corpus, and anything running as
your user has the file. The CLI never had a port.
**→ 1.4: passphrase at start only, never read from disk when serving; explicit tailnet bind with
no `0.0.0.0` fallback; per-device revocable tokens.**

### AR-13 · A Slack-shaped UI makes the duo pose as you — CRITICAL
`concept.md`: *"always labelled … an officer's word carries policy weight."* Slack's visual
grammar gives a person and a bot identical chrome. Adopting a Slack clone's message component
unchanged ships the impersonation the product principle forbids, and it ships it as a default
rather than a decision anyone made.
**→ Structural differentiation, not a badge (1.5, 1.6). The owner's avatar never appears on
generated text. This is a lint rule, not a design guideline.**

### AR-14 · The draft loop drowns in a chat transcript — HIGH
Send / Edit / Ignore is the correction loop's only input. In a scrolling transcript, an action has
no persistent home and an ignored draft is indistinguishable from an unread one — which also
corrupts `drafts.outcome`, since "ignored" stops meaning a judgement.
**→ Review as a first-class surface with its own badge count; an untouched draft stays there
until it is dispositioned.**

### AR-15 · The phone is asleep when the Mac is — MEDIUM
`AR-10` accepted "the duo is asleep when your laptop is" for v1, reasoning that if you were asleep
you were not answering either. The thin client makes it sharper: close the lid mid-afternoon and
the phone app is a spinner during exactly the hours you would use it.
**→ Offline as a designed state (1.7): last-synced view, explicit timestamp, actions disabled
rather than queued. Also the honest headline for the pilot: the phone is a review surface, not a
pager.**

### AR-16 · Tailscale is blocked on the managed endpoint — HIGH
The entire mobile half assumes a mesh VPN the MDM profile may simply forbid, and finding out after
the client is built wastes the client.
**→ Promoted to gating unknown G3, with a stated fallback that still ships the Mac app.**

### AR-17 · A settings grid invites T4 to look like a switch — MEDIUM
`TRUST_TIERS` is `T0`–`T3`; T4 is *structurally absent* because `concept.md` calls it "never
autonomous, product principle, not a limitation." A tidy UI grid will naturally render T4 as a
fifth row with a disabled toggle — which teaches the owner it is a policy value someone could
enable, quietly undoing the thing the type system was shaped to prevent.
**→ T4 is not a disabled control. It is absent, with one line of prose saying why. Unknown cells
render as `ask`, matching `resolveAutonomy`'s default, and no client path can write a cell the
CLI could not.**

### AR-18 · Two editors, one file, and the files are supposed to win — MEDIUM
`duo/rules/*.md` is the source of truth for humans; the `rules` table is a projection, hand-edits
win, and a sync step reconciles. A phone that edits a rule is editing the projection while the
file sits on a machine it cannot see, and the next `derive sync` silently discards the edit.
**→ Mobile is read, approve, reject, promote — never free-text authoring. Rule writing stays
where the files are. The same constraint applies to any client action with no CLI equivalent
(1.3).**

### AR-19 · The surface outruns the duo — MEDIUM
A polished app invites daily use, and `AR-3` already warns the Mirror may be thin: a handful of
rules and a sparse portrait. A sleek shell around four rules reads as a demo, and the gap between
how good it looks and how much it knows is itself a trust problem.
**→ Build order puts the Review surface (C4) before the Mirror browser (C6), because a single
real draft is worth more than a rules list. If the corpus is thin, ship the Mac app to an audience
of one and say so.**

---

# Part 3 — What this changes in `v1-tech-design.md`

| # | Change |
|---|---|
| 1 | "Mirror UI — local web app, single user, no auth" becomes **`duo serve` + two clients with per-device tokens.** "It is your laptop" stops being true the moment a port is open. |
| 2 | Surfaces line becomes `CLI · duo serve (Mac + phone) · Slack Socket` |
| 3 | The non-Slack surface of **AR-4** is now specified rather than promised — this document is that mitigation |
| 4 | **AR-10**'s "asleep when your laptop is" is extended to the phone and given a designed offline state |
| 5 | Passphrase handling gains a serving mode that never reads `.passphrase` from disk |
| 6 | Two new gating unknowns, **G3** (daemon + Tailscale on a managed Mac) and **G4** (installing your own build on your own phone) |

---

# Part 4 — Build order

Same rule as before: each step ends somewhere useful, so stopping early still leaves something
working.

| # | Step | Blocked by |
|---|---|---|
| C0 | Resolve G3 and G4 | MDM policy conversations |
| C1 | `duo serve` — read-only routes (`/duos`, `/mirror/portrait`, `/trust/grid`, `/audit`) over the existing modules | — |
| C2 | Serving-mode passphrase, tailnet bind, `duo pair` device tokens | G3 |
| C3 | Web client shell — React + Tailwind + shadcn, responsive, against C1 in a browser | C1 |
| C4 | **Review surface** — `/draft`, `/drafts/:id/outcome`, Send / Edit / Ignore wired to the correction queue | C1 |
| C5 | Tauri v2 macOS wrap + native notifications | C3 |
| C6 | Mirror browser — portrait, rules, weak signals, approve / reject / promote | C3 |
| C7 | WebSocket draft-ready push; offline cache and last-synced state | C5 |
| C8 | Tauri v2 iOS / Android targets | G4, C7 |

C1–C6 are a complete, sleek Mac application that needs nobody's permission beyond G3. C7–C8 are
the phone, and they are the half that can be blocked by someone else — which is why they are last.
