# Digital Duo — What Happens When the Duo Is Asleep

> Decision record for #188 (parent #184). Status: **PROPOSED** — this document becomes the
> decision when the PR carrying it is merged. It sits on top of `workspace-platform.md`
> (Matrix/Synapse org-hosted, federation off, daemon dials out) and changes nothing in its §5.
>
> Related: #186 (the daemon dials out), #187 (directory and availability — consumes §6 here),
> #161 (org-mode deployment), #193 (doc overhaul — applies the AR-10 wording in §10).

---

## 1. The decision

**A question addressed to an unavailable duo is an ordinary message. The workspace server holds
it and delivers it when the duo's daemon reconnects; the duo answers then, on its existing
pipeline, and posts the answer as its own message. The asker is told — at send time, and for as
long as the hold lasts — that the duo is offline and when it was last seen.**

Concretely:

- The question is a message in a conversation the duo is a member of. The workspace holds it
  exactly as it holds a message to a person whose client is offline — on Matrix this is the
  protocol's core `/sync` behaviour, not duo machinery (§2). Nothing duo-specific is queued.
- A duo's **availability** is a directory state (#187): `online` while its daemon's outbound
  connection is live, `offline (last seen T)` otherwise. §6.
- The asker is told, before and during: this duo is offline, last seen T, the question will be
  delivered when it reconnects. **No spinner, no predicted time, no cached answer, no fabricated
  answer** — and no promise that the answer, when it comes, is direct rather than escalated. §3.
- On reconnect the daemon syncs, receives the held questions (each still carrying the time it
  was asked), and answers under the rules that already govern it: questions its granted autonomy
  covers are answered directly; questions it escalates become drafts awaiting its owner. §5.
- What is *not* held: the duo's own outgoing actions — a scheduled summary, a draft waiting on
  Send — are disabled while the actor is offline, never queued to fire later. §7.

## 2. Why

AR-10 accepted "the duo is asleep when your laptop is" for a single-user drafting tool on the
reasoning that if you were asleep, you were not answering either. The workspace product inverts
that reasoning: **the point of asking a colleague's duo at 21:00 is that the colleague is not
available.** Unavailability is the input, not the failure.

The answer has to hold three properties at once. It must be honest to the asker (this issue's
second AC). It must not move `workspace-platform.md` §5's line — corpus, passphrase, derived
rules and draft evidence stay on the owner's machine. And it must be consistent with the
queueing split #193 writes: ordinary messages queue and deliver on reconnect; drafts and actions
are disabled, not queued. Only hold-and-deliver holds all three: the question is asker-authored
workspace data, the answer is minted by the daemon against its own corpus, and the wait is
stated rather than disguised.

It is also nearly free. Matrix delivery to an offline account is the `/sync` model the platform
decision already adopted as library capability (`workspace-platform.md` §1: "message
queueing-on-offline … arrive as library capability"). We are deciding to use it and to be honest
in the UI about it — not to build a queue.

## 3. The asker's experience

The rule is that the asker is never misled, and every state below is a plain statement of fact:

- **Before asking.** The directory shows the duo's availability (#187). Asking an offline duo
  stays allowed — asynchronous is the point — but the asker knows the duo is offline before
  typing, not after.
- **At send.** The local echo renders the question as **held**, visually distinct from
  sent-and-delivered, with: *"This duo is offline (last seen 17:42). Your question will be
  delivered when it reconnects."*
- **During the hold.** No typing indicator, no progress affordance, nothing that implies the duo
  is processing. **No estimated time is ever shown** — when the owner's Mac wakes is
  unknowable, and a predicted time is a fabricated answer of a different kind.
- **State changes are visible.** `held → delivered` when the daemon reconnects; `delivered →
  answered` when the duo posts; `delivered → passed to the owner` if the duo escalated (§5). A
  question left in `delivered` is the same honest state as a person who has read your message
  and not yet replied.
- **The answer carries its latency.** An answer arriving three days late is rendered with both
  timestamps — when the question was asked and when it was answered. Latency is legible, and the
  asker judges the answer's usefulness.

## 4. Retention and expiry of held questions

- **A held question is a message** and lives under the conversation's message retention
  (#189/#190), not under a duo-specific clock. There is **no automatic expiry in the pilot**: a
  later answer is still an honest answer, and it arrives timestamped (§3).
- **The asker can cancel.** Deleting (redacting) the question before the daemon syncs means the
  daemon never sees its content — Matrix redaction strips the event's content server-side, and a
  client that syncs later is served the stripped event (verified, §11). Cancellation is the
  expiry mechanism, and it belongs to the asker rather than to a timer that destroys their words
  on a schedule the message store does not otherwise have.
- **A crash mid-answer does not mislead.** If the daemon receives a question and dies before
  answering, the asker-visible state remains `delivered`, which is true. The daemon records
  receipt locally before processing, so processing resumes idempotently at the next reconnect;
  those mechanics are #186's, not this record's.

## 5. What each side records

**The workspace server records** — and nothing beyond: the question message (author, body,
time, thread parent), exactly as for any message; the duo's availability transitions
(`online`/`offline`, last-seen), which is directory data (#187); the delivery state of the
question (pending, or delivered at T); and the answer message once the duo posts it. No corpus,
no derived rules, no passphrase, no draft evidence — §5 of the platform decision is unchanged
by this record.

**The daemon records, on reconnect:** it receives each held question over its held outbound
connection (#186), records receipt locally before processing, and runs the existing pipeline —
relevance gate, retrieval, autonomy resolution. The relevance gate is tuned for silence and may
decline to answer a question whose context has moved ("this has waited three days; ask again"):
that is an honest outcome, not a failure. The answer posts as the duo's own Matrix user
(`workspace-platform.md` §6). **The hold is invisible to the daemon**: it sees a question with a
timestamp, exactly as if it had been asked a moment ago.

**The owner's side:** a question the duo escalates becomes a draft in the owner's review
surface, waiting for the owner's explicit act — the standing-grant and escalation rules are
unchanged by this record; it only routes their output. An untouched draft stays in review until
dispositioned (AR-14), and drafts are never queued-to-fire (§7). An owner returning from a week
away finds the T0-covered questions already answered and the escalated ones waiting — with the
askers having seen true states the whole time.

## 6. Availability as an explicit directory state

#187 requires that "a duo whose daemon is asleep is a distinct state from a person who is
away." This record supplies the semantics for the duo half:

- **A duo's availability is the state of its daemon's outbound connection to the workspace
  server.** `online` = the connection is live; `offline` = the connection is down, with
  last-seen time. That is the whole definition — it is derived from what the server already
  knows as the message router, and it asserts nothing else.
- **It says nothing about the owner's presence.** A person can be online while their duo is
  asleep, and a duo can be online while its owner is away; the directory carries the two as
  separate facts.
- **It is observable at every phase**: at addressing time (composer/directory), during the hold
  (the visible `held → delivered` transition is the availability flip), and after (the answer's
  timestamp).

## 7. Two queueing rules, kept distinct

#193's split, restated here so this record cannot be read against it:

| Object | Rule | Reasoning |
|---|---|---|
| Ordinary messages, **including questions to a duo** | Queue and deliver on reconnect | The message is asker-authored workspace data; holding it violates nothing in §5. "Queue-and-deliver-on-reconnect is simply correct" (#193). |
| Drafts and duo actions (the duo's own outgoing output) | Disabled while the actor is unavailable, never queued to fire later | An action or a Send firing hours later against moved context is worse than no action — the AR-15 reasoning, applied one layer out. |

This record extends the first rule to questions addressed to a duo and restates the second for
duo-originated output. #193 writes both into the design docs.

## 8. Alternatives weighed

| Option | The honest case for it | Why it does not win |
|---|---|---|
| **(a) Hold-and-deliver** *(chosen)* | Costs nothing new (§5's store already holds messages); honest by construction; the exact rule #193 states for ordinary messages. | Its cost is latency, and latency stated plainly is the best available trade. Mitigations on top (§9) stay optional. |
| **(b) Org-hosted daemons (#161)** | The only option that *removes* the wait rather than describing it: daemons on an org box are always-on by construction, and it closes #14's org-billing half. | It removes the problem by moving the corpus. #184's stated line: "anything that would put decision history on org infrastructure is a change to epic #184, not an implementation detail inside it" — corpus and passphrase would live on org machines, with the operator able to see metadata and the box holding passphrase material in memory (#161, open question 4). Adopting it here would repeal the epic's premise to solve a product question. **#161 remains what it already is: a deployment mode an owner or org may choose.** If chosen, that duo stops being offline — but availability is then a deployment property, not a platform guarantee, and the platform must still behave correctly when nobody chooses it. |
| **(c) Owner-approved cache of answerable topics on the server** | Most 21:00 questions are repetitive — the asker graph is a derived product feature — so a narrow cache would answer many of them, and it is a smaller leak than (b). | A cache of answerable topics is a derived-rules-shaped artifact, and §5 forbids derived rules on the server outright; "owner-approved" makes the leak standing rather than one-off. Worse, it creates a **second answer path**: answers minted without the daemon's grounding, evidence or provenance. An asker cannot tell a stale cache from a grounded answer unless it is labelled — and labelled, it is worth little more than "it will answer later." A smaller leak is still a leak, and it spends exactly the honesty this issue exists to protect. |

## 9. What this decision does not decide

- **#186** — reconnect mechanics, backoff, idempotent receipt before processing.
- **#187** — the directory schema and how availability is exposed to clients; this record fixes
  only its semantics (§6).
- **#189/#190** — the message-store contract, including how redaction/cancellation is exposed.
- **#193** — applying §10's AR-10 wording into `v1-tech-design.md` and `client-design.md`.
- **Waking the owner** — notifying the owner's phone that questions are pending (wake-on-LAN,
  push-to-owner) is a product choice layered on top; this record only requires that if it
  exists, it too is honest. #161 already notes wake-on-LAN mitigates but does not remove.
- **Notifying the asker** — push when the answer lands is ordinary client push, with nothing
  duo-specific about it.

## 10. AR-10 replacement wording (applied by #193)

Current (`v1-tech-design.md`):

> ### AR-10 · The duo is asleep when your laptop is — LOW for v1
> Local-only means no drafts overnight. For private drafting this is fine: if you were asleep
> you were not answering either. It becomes real the moment the duo answers others directly.
> **→ Accepted for v1. Flagged as the forcing function for v2's hosting question.**

Replacement:

> ### AR-10 · The duo is asleep when its owner's laptop is — MEDIUM for the workspace product
> The duo answers only while the daemon that holds its corpus is running. For private drafting
> this was fine: if you were asleep, you were not answering either. The workspace product
> inverts the reasoning — the point of asking a colleague's duo at 21:00 is that the colleague
> is not available.
> **→ Accepted, and made honest rather than solved: a question to an offline duo is an ordinary
> message — held by the workspace, delivered when the daemon reconnects, answered then on the
> existing pipeline — and the asker is told the duo is offline at send time (availability is a
> directory state, #187). No fabricated answer, no cached answer, no spinner, no predicted
> time. Drafts and duo actions remain disabled-when-offline, never queued (AR-15).
> Org-hosted daemons (#161) remain an owner's deployment option that removes the wait — not a
> default that moves the corpus. Full record: [`workspace/asleep-duo.md`](workspace/asleep-duo.md)
> (#188).**

## 11. Sources (verified 2026-09-25)

- Matrix `/sync`: returns an initial snapshot and then incremental deltas, "to receive new
  messages" — messages sent to a room while a client was offline are returned at its next sync.
  — <https://spec.matrix.org/v1.15/client-server-api/#syncing>
- Matrix redaction: "removing all keys from an event that are not required by the protocol.
  This stripped down event is thereafter returned anytime a client or remote server requests
  it" — a question redacted before the daemon syncs is therefore never delivered in readable
  form. — <https://spec.matrix.org/v1.15/client-server-api/#redactions>
- Wake-on-LAN and always-on machines "mitigate but do not remove" offline unreachability;
  operator-trust cost of org-hosted daemons — #161 (issue text).
- All issue references (#161, #184–#190, #193) and document references
  (`workspace-platform.md`, `v1-tech-design.md`, `concept.md`) read from source this session.
