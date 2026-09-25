# Digital Duo — v1 Spec

> Internal dogfood. Pilot = the author and their immediate team.
> Last updated: 2026-09-25 · See `concept.md` for the thesis, `import-adapters.md` for ingest.

## 1. The risk v1 is designed around

Selling externally, the hard problem is trust. Building internally for your own team, trust is
cheap — you are the pilot and nobody is going to be embarrassed.

The actual risk is more boring and more fatal: **you build it and nobody opens it, including you.**

Every scope decision below follows from that.

## 2. Why v1 is private drafting, not public answering

The instinct is to ship T0 first — the duo answers colleagues when @mentioned. On a team of ~10
that is wrong:

**Deflection needs volume; a small team does not have it.** If the duo fields three questions a
week you will never learn whether it works, the training loop never spins up, and the project
dies of ambiguity rather than failure.

**T1 private drafting works at n=1:**

- It fires whenever *you* answer something, not when someone asks you
- Zero embarrassment surface, therefore zero hesitation to leave it on
- Every edit before sending is a labelled correction — the loop runs from day one regardless of
  whether anyone else ever touches it
- You will use it daily, which is currently the only thing that matters

**The v1 loop:**

```
someone asks you in Slack
      ↓
duo drafts a reply, visible only to you
      ↓
you send / edit / ignore
      ↓
the edit becomes a standing order
```

T0 (answering others directly) is v2, and the trigger is behavioural not calendar-based: switch
it on when the duo is beating you to the answer often enough that it is annoying not to let it
speak.

**Amended 2026-09-25 (#184, #193):** the answering side has since shipped, and this section's
"T0 is v2" no longer describes the product. The workspace epic added an org-hosted message
layer — Matrix, per [`workspace-platform.md`](workspace-platform.md) — in which colleagues
address duos directly in consented shared conversations, with every corpus still local
([`v1-tech-design.md`](v1-tech-design.md) §1.1). Nothing here is repealed: private drafting is
still what v1 built, still the on-ramp, and still the corpus pipeline a workspace duo answers
from. The §3 out-scope row "Public answering (T0 to others)" is superseded by that layer;
"Multi-tenant anything" still holds — a daemon is one duo, one owner, one encrypted store, and
org mode ([`workspace/org-mode-deployment.md`](workspace/org-mode-deployment.md)) adds a place
a daemon may run, not a multi-tenant rewrite.

## 3. Scope

### In

1. **File-upload import** — Claude export, Slack export, a folder of docs. Plus paste-a-conversation.
2. **Normalisation** into the `Record` schema (`import-adapters.md`)
3. **Derivation pass** → topic taxonomy, voice profile, draft standing orders
4. **The Mirror** — what it learned, presented as a portrait; approve / edit / delete each rule
5. **Hand-written refusals** — prompted explicitly, not derived
6. **Slack app, private to the owner** — on mention of the owner, DM them a draft reply with sources
7. **Send / edit / ignore**, with edits writing back into the standing orders, visibly

### Out — and why

| Deferred | Because |
|---|---|
| Classification & asker-scoped permissions | One team, shared footing. **Keep the schema field**, skip the logic. |
| Public answering (T0 to others) | Needs volume and trust the pilot cannot generate yet |
| Trust grid, promotion/demotion ledger | Nothing to promote until there is public answering |
| Actions beyond drafting (T2–T4) | Not until drafting is demonstrably good |
| Deflection dashboards / weekly receipts | No audience to convince — that is an adoption artifact, not a pilot one |
| Multi-tenant anything | Build for one duo — but model it as an entity rather than scattering the owner through the code, so a role duo or a shared duo needs no retrofit (`concept.md` §12) |
| Live capture, gov-tool connectors | Blocked on docs/approvals. Stub the adapters. |

### The one thing that must not be cut

**Corrections writing back into a readable, editable standing-orders file.** That loop is the
product. Without it this is a RAG bot with a personality prompt.

## 4. Sequencing

Ordered by *how little permission each step needs*, because every approval you wait on is a week
you do not ship.

| # | Step | Needs approval? |
|---|---|---|
| 1 | Import + normalise a Claude export | No |
| 2 | Derivation → topics, voice, draft standing orders | No |
| 3 | The Mirror + refusals, as a local review UI | No |
| 4 | Draft generation against a pasted question, evaluated by hand | No |
| 5 | Slack export import (widens the corpus, adds the asker graph) | No |
| 6 | Slack app scoped to the owner, drafts via DM | Workspace app install |
| 7 | Edits write back → standing orders diff | No |

Steps 1–4 are a working, useful duo with no integration and no requests filed. Ship that first.

## 5. Success criteria for the pilot

Deliberately behavioural, not accuracy metrics:

- **Do you leave it on for two weeks?** The only criterion that cannot be gamed.
- **Send-rate** — % of drafts sent unedited, lightly edited, or discarded. Watch the trend, not
  the absolute.
- **Does the standing-orders file get better and stay readable?** If it becomes a sprawl nobody
  opens, the explainability story has failed.
- **Would a teammate ask for their own?** The real graduation signal out of pilot.

Explicitly *not* a criterion: answer quality scores. At this scale, judgement beats metrics.

## 6. Build notes

- **Scale is irrelevant.** One duo, one user. Spend context freely, re-derive from scratch on
  every change, keep everything in plain files or a single Postgres. Do not build for throughput.
- **Keep the model layer abstracted.** A prototype stack will not survive a production security
  review; the whole thing must be re-pointable at approved infrastructure without a rewrite.
- **Standing orders are a real file**, versioned, human-diffable — not a system-prompt blob.
- **A duo is an entity, not a global.** Its owner may be a person, a role, or nothing, and its
  knowledge sources are pluggable between derived and authored. This is the one concession to
  `concept.md` §12 made in v1, and it is cheap only if made now.
- **Provenance on everything.** Every draft carries its sources; every standing order carries the
  threads it came from. Retrofitting provenance is painful; adding it at the start is free.
- **Position as a layer on the sanctioned AI stack**, not a competitor to it.

## 7. Open questions

- Which LLM chat history is realistically exportable, and under what consent?
- Slack: workspace app scoped to one user, or per-user export only, for the pilot?
- Where do standing orders live so they are both machine-readable and pleasant to edit by hand?
- How is staleness surfaced in a draft — hedge text, a badge, or a confidence score?
