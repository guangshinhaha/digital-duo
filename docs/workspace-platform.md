# Digital Duo — Workspace Platform Decision

> Decision record for #185 (parent #184). Status: **PROPOSED** — this document becomes the
> decision when the PR carrying it is merged. Every licence and deployment claim below was
> verified against its source on 2026-09-20; sources listed at the end.
>
> Extends `v1-tech-design.md` §1.1 the way `client-design.md` does: the local posture is not
> repealed, it is given a second store. `#184` states the line: **two stores, and the line
> between them never moves.**

---

## 1. The decision

**Adopt the Matrix protocol as the workspace layer. Build our own client on `matrix-js-sdk`. Do
not write a message store. Do not fork Element Web.**

Concretely:

- The org hosts **one Matrix homeserver** (closed, federation off — §7). It holds identity,
  conversations, messages, read state and files — exactly the store `#184` draws on the left of
  its diagram, and nothing else (§5).
- The client repo keeps its React + Tailwind + Tauri stack and gains `matrix-js-sdk` as the
  messaging library. Sync, rooms, timelines, threads, read receipts, local echo, message
  queueing-on-offline, E2EE and push arrive as **library capability**, not as product we maintain.
- A duo is a **separate Matrix user** (§6) — its own account, posting under its own identity.
- Slack/Teams/email become **bridges into** the workspace when they must, accepting the
  maintenance cost stated in §3.

What we do not adopt is as deliberate as what we adopt: not Element Web's UI (AGPL, and its
design system is the opposite of ours), not a Slack-clone product (the `client-design.md` §1.2
verdict stands — "take the component layer, not the product", one layer down: the SDK), and not
a hand-written message bus (§9's last row).

## 2. Why

A message store, identity, presence, read state, multi-device sync, files, push and search is
years of work that several projects have already done. **None of it is this product's
differentiation** — the duo is. Every month spent on state resolution or read-marker semantics
is a month not spent on the correction loop, provenance and trust.

Matrix wins on the one axis the others cannot match: **a duo becomes a first-class identity at
the protocol level.** AR-13 (`client-design.md`) demands that a duo never render as its owner.
On Matrix this is not a rendering discipline — the duo's messages are authored by the duo's
account, so the owner's account *cannot* have written them. We would be getting the labelling
contract enforced by the protocol, with our lint rule and `InsideDuoMessage` guard as the second
layer instead of the only one.

`matrix-js-sdk` gives the client sync, timelines, E2EE and offline queueing as an Apache-2.0
library (licence verified against the repository), which drops into the existing stack without a
rewrite.

## 3. What we adopt, and what each piece costs

| Piece | Choice | Licence (verified) | Cost / caveat |
|---|---|---|---|
| Client SDK | `matrix-js-sdk` | **Apache-2.0** | None beyond attribution. It stayed permissive when Element relicensed its apps. |
| Client UI | **Ours** (existing stack) | — | We own the whole surface; this is the product. |
| Homeserver (pilot) | **Synapse** | **AGPL-3.0** | Reference implementation; every bridge, appservice and E2EE path is tested against it first. AGPL obligations: §4. |
| Homeserver (evaluated upgrade) | Tuwunel · Continuwuity | **Apache-2.0** (both) | Rust, far lower resource cost. Tuwunel is the official conduwuit successor and is sponsored by the government of Switzerland, deployed for citizens — a directly relevant precedent for a government pilot. |
| Element Web | **Not adopted** | AGPL-3.0-or-commercial | Forking it means deleting most of it under a copyleft we do not need. |
| Bridges | mautrix family, self-hosted | varies (mostly AGPL) | Real and recurring: matrix.org retires its own Slack bridge on 2026-01-13, citing "the high cost and complexity of maintaining interoperability with a closed, proprietary platform." `matrix-appservice-slack` is already archived. Bridging is possible; budget it as maintenance, not a feature. |

**Homeserver sequencing is recorded, not left to drift:** the pilot runs Synapse because at pilot
scale compatibility risk costs more than an AGPL footnote; the Apache-2.0 Rust servers kill the
licence question entirely and are the evaluated switch before any org-wide scale-up. Which
binary runs is a deployment decision — the locked decision is *protocol + SDK + own UI*.

## 4. Licence obligations, stated plainly

- **`matrix-js-sdk` (Apache-2.0).** Permissive. Keep the NOTICE/attribution; no copyleft
  obligation reaches our client code.
- **Synapse (AGPL-3.0).** AGPL §13's network-use clause: modify it and let people interact with
  it over a network, and you must offer those users the modified source. For an **internal,
  unmodified** deployment the obligation is effectively nil (upstream source is public); for an
  internal **modified** deployment it means making our modifications available to staff — an
  internal publication, not a public one. If even that is unwelcome, run Tuwunel or Continuwuity
  and the question disappears.
- **Element Web (AGPL-3.0-or-commercial).** We are not adopting it, so it obliges us to nothing.
  If it is ever embedded, AGPL applies to that surface.
- **Bridges.** Mostly AGPL; same internal-modification logic as Synapse. The larger cost is
  maintenance, not licence (§3).

What the org must publish, if anyone asks: **nothing publicly**, provided unmodified servers are
used, or modifications are offered to the internal users they serve.

> **Amended 2026-09-26 (#235, `docs/deploy/hosted-workspace.md` §10; this is the record that
> section promised).** The paragraph above assumed an internal, unmodified server. The hosted
> workspace is neither: its Synapse loads our own module (`deploy/synapse/modules/duo_org_wall/`,
> through `modules:`) and is reachable from the internet. Whether a module loaded through `modules:`
> makes a modified Synapse under AGPL §13 is a legal question this record does not settle, but the
> safe reading is that it does, and that the users are then anyone who can reach the server. So
> plan on **publishing the module's source**: it is in this repository, which is the offer, and it
> holds nothing secret (its config, the service account's id, is rendered at boot from the
> deployment's environment and is not part of the source). Its being public does not weaken the
> org wall, which never rested on its secrecy. Two things stay open for the owner: this repository
> has no `LICENSE` file, so the module has no stated licence yet (AGPL-3.0 is the natural choice, to
> match Synapse, but it is the owner's to state); and the repository must be reachable by those users
> (public, or otherwise offered) for the "offer" to be real. The unmodified-Synapse case in the
> paragraph above is unchanged.

## 5. The boundary: what the workspace stores, and what it is forbidden to store

The workspace server holds **identity, conversations, messages, read state and files** — and
nothing else. It may **never** hold:

- a **corpus** — records, imports, embeddings stay in the owner's `data/duo.db`
- a **passphrase** — the store key never leaves the owner's machine, in any form
- **derived rules** — `duo/rules/*.md`, voice, refusals, the portrait
- **draft evidence** — the grounding chunks, sources and provenance behind a draft

One deliberate distinction, so it is not litigated later: **a draft that is sent becomes a
message**, by the owner's explicit act, and is then workspace data like any other message. Until
that act, nothing about a draft transits the workspace — not its text, not its evidence, not its
existence.

Mechanically, the boundary is held by connection direction: **the daemon dials out** to the
workspace server and holds that connection open; the owner's Mac never opens an inbound port,
and `duo serve` still refuses `0.0.0.0`. This is the same reasoning that picked Socket Mode for
Slack, one layer up. The duo's own credentials (its Matrix access token, and its encryption keys
if a room is E2EE) live in the owner's daemon — keys stay local, which means E2EE rooms do not
soften §5, they strengthen it: the workspace server cannot read what it cannot decrypt.

Anything that would put decision history on org infrastructure is a change to epic #184, not an
implementation detail inside it.

## 6. The duo's identity is structural

A duo posts as **its own Matrix user** — e.g. `@duo-alice:workspace` beside `@alice:workspace` —
never as its owner, never as a bot flag on the owner's account. The protocol attributes every
message to the account that sent it, so AR-13 cannot be violated by a rendering mistake: the
client renders what the protocol says, and the protocol says "the duo", not "the owner".

The duo's credentials are created where its corpus lives — on the owner's machine, during
pairing — and never leave the daemon. It joins rooms by invitation, the same as a person.
(An application service managing many duo accounts is the later, scaled shape; the pilot needs
one account per duo and nothing more.)

Our own second layer stays: `DuoMessage` remains avatarless, the ESLint rule and the
`InsideDuoMessage` guard remain and extend to multi-party rooms (duo issue #60). Protocol
enforcement plus rendering enforcement — belt and braces, because an officer's word carries
policy weight.

## 7. Federation

**Off, explicitly, for the pilot.** The homeserver is a closed org system; federation adds
state-resolution complexity and an outbound trust surface the pilot has no need for. The
decision to keep it off or enable it later belongs to a security review, not to a config sweep —
and enabling it is a deployment policy change, not a code change. Recorded here so nobody has to
re-derive it.

## 8. What this decision does not decide

Children of #184 that remain open, now unblocked on this record:

- **#186–#190** — where the workspace connection lives in the daemon, directory/identity
  bridging, addressing a duo, the message-store contract from our side, files.
- **E2EE and what the org can read (#191)** — E2EE rooms with a duo as a key-holding device
  change the answer; the key-management and verification UX is its own question.
- **A duo whose Mac is asleep (#188)** — unchanged by this decision: the workspace is always up,
  the duo still is not. That is a product question, not a platform one.
- **Bridge consent** — bridging a Slack channel puts other people's messages onto the workspace
  server; `concept.md` §9's consent rules apply to bridges as much as to ingest.

## 9. Alternatives weighed

| Option | Licence | Why it might win | Why it does not |
|---|---|---|---|
| **Matrix + own UI** | Apache-2.0 SDK; server varies | Duos as real identities; E2EE; bridges; org-hostable; permissive SDK | Protocol complexity we must switch off (federation) and understand |
| **Mattermost** | MIT (Team Edition) | Closest to Slack, simplest ops, Go + Postgres, plugin framework | Bots are accounts with a flag, not first-class identities — AR-13 stays a rendering discipline. Free-edition packaging is in motion (2025: SSO removal from Team Edition, GitLab Omnibus churn) — verified, and disqualifying for a multi-year bet without re-checking each upgrade |
| **Rocket.Chat** | MIT core | Feature-complete, large marketplace | Meteor runtime; the least appealing codebase to build on |
| **Zulip** | Apache-2.0 | Best threading in the category — topics map well onto `threadContext` | Python/Django server against our Node/TS core |
| **Telegram** | clients GPL | — | The server is closed. There is nothing to host. Ruled out |
| **Write it ourselves** | — | Total control | Years of undifferentiated work; the duo is the product, not the message bus |

## 10. Sources (verified 2026-09-20)

- Element's server-side AGPLv3 relicensing (Synapse, Dendrite et al.), Nov 2023 —
  <https://element.io/blog/element-to-adopt-agplv3/>
- `matrix-js-sdk` licence: **Apache-2.0** — <https://github.com/matrix-org/matrix-js-sdk>
  (repository licence metadata)
- Element Web/Desktop under AGPL-3.0-or-commercial — <https://github.com/element-hq/element-web>
- Tuwunel: **Apache-2.0**, Rust, official conduwuit successor, "primarily sponsored by the
  government of Switzerland … deployed for citizens" — <https://github.com/matrix-construct/tuwunel>
- Continuwuity: **Apache-2.0** — <https://github.com/continuwuity/continuwuity>
- matrix.org retiring its Slack bridge 2026-01-13, citing maintenance burden of a closed
  proprietary platform —
  <https://cyberinsider.com/matrix-org-to-retire-slack-bridge-by-january-citing-maintenance-burden/>
- Mattermost editions and licences (Team Edition MIT; 2025 free-edition packaging changes) —
  <https://docs.mattermost.com/product-overview/editions-and-offerings>
- Homeserver landscape (Synapse vs Dendrite vs Continuwuity) —
  <https://www.pistack.xyz/posts/2026-05-02-synapse-vs-dendrite-vs-continuwuity-self-hosted-matrix-server-guide/>
