# Digital Duo — v1 Technical Design

> Design + adversarial review + the revisions that survived it.
> Last updated: 2026-09-18 · Scope from `v1-spec.md`, ingest contract in `import-adapters.md`.

---

# Part 0 — Two gating unknowns, resolve before writing code

These are not risks to manage. They are **decisions that invalidate the design if they go the
wrong way**, and both are cheap to check.

### G1 — Which LLM can legally see this corpus?

Drafting replies from Slack content means sending government conversation data to whatever model
runs inference. "Keep the provider abstracted" is a real mitigation for *portability* and a
**hand-wave for legality**. Three outcomes, each with a different build:

| Outcome | Consequence |
|---|---|
| Sanctioned internal LLM is API-accessible | Best case. Build as designed, point at it. |
| Only a hosted commercial API is available | Pilot corpus must be restricted to data permitted to leave. Probably means Official (Open) only, and the duo's usefulness drops accordingly. |
| Nothing may leave the machine | Local inference (Ollama + a 7–30B model). Rule induction and voice matching get materially worse but remain viable. Embeddings stay local regardless — cheap and easy. |

**Check this first.** It is a conversation, not a sprint.

### G2 — Can you actually obtain your own Slack history?

`v1-spec.md` claims steps 1–4 need no approvals. That claim rests on being able to export your
own Slack data. In most workspace configurations **you cannot**: exports are admin-initiated, and
private channels and DMs typically require the top plan tier plus an approval process.

If Slack data is gated, the corpus for v1 is your AI chat history plus documents — which changes
what the Mirror can show, because the interruption baseline ("asked 23 times about X") comes
*only* from Slack.

**Mitigation that needs no approval:** the Slack API lets *you* read your own accessible history
with a user token. Whether a user token can be minted without admin install is the specific thing
to check.

---

# Part 1 — The design

## 1.1 Shape: a local application, not a deployment

v1 runs entirely on the owner's machine. No hosting, no public endpoint, no inbound firewall
rule, no data at rest on third-party infrastructure.

This is not laziness — it removes the security review from the critical path for the pilot
entirely, and for gov data that is worth more than any convenience a cloud stack buys.

Slack integration survives this via **Socket Mode**: Bolt opens an outbound websocket to Slack,
so there is no public URL to expose or approve.

```
┌──────────────────── owner's machine ────────────────────┐
│                                                          │
│  duo/            ← git-versioned human artifacts        │
│    rules/*.md      standing orders, one file per rule   │
│    refusals.md     hand-written, never derived          │
│    voice.md        derived, owner-editable              │
│    topics.json     stable topic IDs                     │
│                                                          │
│  data/duo.db     ← SQLite, gitignored, encrypted        │
│                                                          │
│  surfaces:  CLI  ·  local web (Mirror)  ·  Slack Socket │
└──────────────────────────────────────────────────────────┘
                            │ outbound only
                 LLM provider (see G1) · Slack
```

## 1.2 Stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript / Node | Slack Bolt with Socket Mode is first-class; AI SDK is TS |
| Store | SQLite (`better-sqlite3`) + FTS5 | Single file, zero ops, full-text search built in |
| Vectors | `sqlite-vec` | Same file, no second system at this scale |
| Embeddings | Ollama (`nomic-embed-text`) locally | Never sends corpus out, regardless of G1's answer |
| Inference | Provider interface, one implementation at a time | Swap per G1 without touching callers |
| Slack | `@slack/bolt`, Socket Mode | No public URL |
| Mirror UI | Local web app, single user, no auth | It is your laptop |

Python is equally defensible and stronger for clustering; the Ollama HTTP boundary means the
choice does not lock in the embedding strategy either way.

## 1.3 Data model

Records per `import-adapters.md`, plus derived tables:

```
records(id, source, source_ref, kind, author, text, ts, thread_id,
        audience, classification, topic_id)
records_fts                      FTS5 over text
record_vec                       sqlite-vec, embedding per record

qa_pairs(id, question_id, answer_id, thread_id, ts, topic_id)
topics(id, label, created_at)    STABLE ids — see AR-8
rules(id, topic_id, text, status, support_count, consistency,
      created_at, last_confirmed_at)   mirrors duo/rules/*.md
rule_evidence(rule_id, qa_pair_id)
drafts(id, trigger_ref, draft_text, confidence, sent_text, outcome, ts)
```

`duo/rules/*.md` is the **source of truth for humans**; the `rules` table is a projection for
retrieval. Hand-edits to the files win, and a sync step reconciles them.

## 1.4 Ingest — two phases, with an enforced retention boundary

Phase A (transient) and Phase B (retained) are **separate processes** with different database
handles. The consent rule from `concept.md` — others' messages are used for derivation then
dropped — is enforced in code, not by convention.

```
Phase A  raw export → Adapter → Record[] → staging DB (ephemeral)
         • includes author:other text, needed for context
         • extract QA pairs, topics, candidate rules
Phase B  copy to duo.db:  author:me records
                          + QA pairs with question text retained
                            (needed: it is what the duo matches against)
                          + derived artifacts
         then DELETE the staging DB
```

One honest caveat: a question asked by a colleague **is** their text and it must be retained, or
the duo has nothing to match an incoming question against. So the boundary is "we keep questions
put to you, we discard everything else others said." That should be stated plainly to the team
rather than glossed as "we don't store colleagues' messages."

The DB holds government conversation data on a laptop: encrypted at rest, gitignored, and
`duo purge` must exist from day one.

## 1.5 Derivation — bounded, grounded, per-topic

Dumping the corpus into one prompt and asking for rules fails on context, grounding, and
hallucination. The pipeline instead:

1. **Pair extraction** — within a thread, a question from `other` followed by the owner's reply.
   Mostly deterministic; an LLM pass only adjudicates ambiguous cases.
2. **Topic assignment** — embed questions, cluster, label each cluster with an LLM.
   New clusters are matched against existing `topics` before minting an ID (AR-8).
3. **Per-topic rule induction** — for each topic, hand the LLM that topic's pairs only, and ask
   for the consistent policy *with citations to specific pairs*. Bounded context, grounded output,
   evidence links the Mirror needs.
4. **Support filter** — surface rules with ≥3 supporting pairs and high consistency; keep the rest
   as "weak signals" the owner can promote manually (AR-3).
5. **Voice profile** — separate pass. Statistical where possible (median length, hedge rate,
   formatting, emoji, greeting/sign-off habits), LLM-described for register.

## 1.6 The relevance gate — the component that decides whether you keep it on

Most Slack mentions of a person are not questions they would answer: FYIs, thread adds, thanks,
social. A duo that drafts on **every** mention is a spam generator, and it gets muted in week one.

So the first stage of the draft pipeline is a cheap classifier answering: *is this a question
directed at the owner that the owner would actually answer?*

Tuned **hard toward silence**. A missed draft costs nothing — you were going to answer anyway. A
spurious draft costs trust in the tool. Target precision over recall, deliberately and by a wide
margin.

## 1.7 Draft pipeline

```
Slack mention
  → relevance gate ─── not a question / not for me ──▶ silence
  → topic classification
  → retrieve: matching rules + top-k similar QA pairs (hybrid FTS5 + vector) + docs
  → generate draft, conditioned on voice profile + rules + evidence
  → confidence scoring (1.8)
  → low confidence ──▶ "I'd escalate this one" + why, not a fake draft
  → DM owner: draft + source links + [Send] [Edit] [Ignore]
```

## 1.8 Confidence

Self-reported LLM confidence is poorly calibrated and is weighted lowest. Composite of:

| Signal | Weight |
|---|---|
| **Self-consistency** — generate 3 at temperature, measure agreement | High. Cheap at this volume and genuinely calibrating. |
| **Retrieval strength** — count and similarity of supporting past pairs | High |
| **Explicit rule hit** — a standing order directly covers this | High |
| **Evidence recency** — decay; old evidence lowers confidence | Medium |
| **Model self-report** | Low |

## 1.9 The correction loop

Naively diffing draft against sent conflates two very different signals. If you always shorten
drafts, that must become **one voice-profile change**, not forty standing orders saying "be
shorter."

```
owner sends after editing
  → diff draft vs sent
  → classify the edit:  STYLE  → voice profile candidate
                        SUBSTANCE → standing-order candidate
                        BOTH → split into two candidates
  → queue it; do not write immediately
  → weekly review: "3 proposed changes" → approve/reject → write with provenance
```

Batching is the difference between a curated rules directory and an unreadable sprawl.

## 1.10 Offline evaluation — before Slack is ever connected

Split the corpus **by time** — hold out the most recent 6–8 weeks *before* derivation, so induced
rules never saw the held-out answers (AR-7). Then generate drafts for held-out questions and score
against what you actually said:

- Semantic similarity to the real answer
- Would-have-sent judgement (LLM-as-judge, spot-checked by hand)
- Relevance-gate precision/recall against hand-labelled mentions

This gives a number to iterate against during steps 1–4, while everything is still local and
unblocked.

---

# Part 2 — Adversarial review

Ranked by how likely each is to kill the pilot.

### AR-1 · The duo spams you and you mute it — CRITICAL
Not in the original design at all. Most mentions are not questions. A draft per mention makes the
tool an irritant, and the spec's own success criterion is "do you leave it on for two weeks."
**→ Relevance gate promoted to a first-class component (1.6), tuned hard toward silence.**

### AR-2 · "Steps 1–4 need no approvals" may be false — CRITICAL
The sequencing argument in `v1-spec.md` rests on self-service Slack export, which most workspaces
do not permit. If that is wrong, the no-approval path is much thinner than claimed and the
Mirror's headline statistic is unavailable.
**→ Promoted to gating unknown G2. Fallback: build on AI chat history + docs, and treat the
interruption baseline as Slack-dependent rather than assumed.**

### AR-3 · The Mirror is thin and the project feels dead on arrival — HIGH
Rule induction needs ≥3 consistent instances per topic. One person's six months may clear that bar
for only a handful of topics. The Mirror is the magic moment; a screen with four rules kills
momentum precisely where the design expects delight.
**→ Show weak signals too, clearly labelled, as promotable candidates. Make the Mirror's headline
the *interruption portrait* (volume, distribution, who asks what) which needs no induction, and
treat rules as the second act.**

### AR-4 · Installing a Slack app in a gov workspace needs admin approval — HIGH
Socket Mode removes the public-URL problem but not the install problem, and gov workspaces
commonly restrict app installation hard. Steps 6–7 could be blocked for months.
**→ Ship a non-Slack surface that closes the loop: paste or pipe a question into the local UI/CLI,
get a draft, record the outcome. Slower, but the correction loop runs and the eval keeps
improving. Slack becomes an accelerator rather than a dependency.**

### AR-5 · Hosted inference on gov Slack data may be a policy violation — HIGH
"Abstract the provider" addresses portability, not legality, and a local model good enough for
rule induction and voice matching is a materially bigger lift than the design implies.
**→ Promoted to gating unknown G1. Embeddings go local unconditionally, since that is cheap and
removes the corpus-scale exposure regardless of the answer.**

### AR-6 · The retention story is softer than stated — MEDIUM
`concept.md` says others' messages are dropped after derivation. But questions put to the owner
must be retained — they are what incoming questions get matched against. And induced rules can
embed a colleague's phrasing verbatim.
**→ Restate honestly (1.4): questions to you are kept, everything else others said is discarded.
Enforce it with a two-database ingest, not a policy sentence.**

### AR-7 · Evaluation leaks — MEDIUM
Deriving rules over the whole corpus and then evaluating on held-out pairs is contaminated: the
rules were induced from the answers being predicted. The number would look great and mean nothing.
**→ Time-based split *before* derivation (1.10).**

### AR-8 · Topic IDs are unstable across re-derivation — MEDIUM
Clustering is not stable run to run. Since the future trust grid is keyed on `(topic × tier)`,
unstable topic identity silently invalidates every permission and every accumulated ledger entry.
**→ Topics get minted IDs once and new clusters are matched to existing ones; a `topics.json` the
owner can rename without breaking references.**

### AR-9 · The rules directory rots — MEDIUM
Plain markdown is pleasant at 10 rules and unnavigable at 100, and hand-edits drift from the DB.
**→ One file per rule with YAML frontmatter (id, topic, support, evidence, timestamps), markdown
body. Files win on conflict; a sync step reconciles. Batched weekly review, never auto-write.**

### AR-10 · The duo is asleep when your laptop is — LOW for v1
Local-only means no drafts overnight. For private drafting this is fine: if you were asleep you
were not answering either. It becomes real the moment the duo answers others directly.
**→ Accepted for v1. Flagged as the forcing function for v2's hosting question.**

### AR-11 · Personal AI chat history may not be about work — MEDIUM
`concept.md` bets heavily on LLM history as the densest record of reasoning. If the exportable
history is personal use, much of it is irrelevant to work judgement and will dilute derivation.
**→ Filter chat history by work-relevance during ingest before it reaches derivation, and report
what fraction survived. If it is small, say so and lean on Slack and docs.**

---

# Part 3 — What changed

| # | Change |
|---|---|
| 1 | **Relevance gate** added as a first-class component, tuned for silence |
| 2 | Two gating unknowns (G1 inference, G2 Slack access) resolved **before** code |
| 3 | Mirror's headline becomes the **interruption portrait**, not the rule list; weak signals shown |
| 4 | **Non-Slack surface** closes the loop so app approval is not a dependency |
| 5 | Ingest split into two phases with an **enforced** retention boundary; retention restated honestly |
| 6 | **Time-based** eval split, before derivation |
| 7 | **Stable topic IDs**, protecting the future trust grid |
| 8 | Rules as one file per rule with frontmatter; batched weekly writes |
| 9 | Embeddings local unconditionally |
| 10 | Edit classification (style vs substance) in the correction loop |

---

# Part 4 — Build order

Each step ends somewhere useful, so stopping early still leaves something working.

| # | Step | Blocked by |
|---|---|---|
| 0 | Resolve G1 and G2 | Conversations |
| 1 | `Record` schema, SQLite store, Claude-export adapter | — |
| 2 | Local embeddings via Ollama; hybrid FTS5 + vector retrieval | — |
| 3 | Pair extraction, topic assignment with stable IDs | — |
| 4 | Per-topic rule induction with evidence; `duo/rules/*.md` | — |
| 5 | **The Mirror** — interruption portrait, rules, weak signals, hand-written refusals | — |
| 6 | Draft pipeline + composite confidence; CLI surface | — |
| 7 | **Offline eval harness** on the time-held-out split | 6 |
| 8 | Correction loop with edit classification + batched weekly review | 6 |
| 9 | Slack adapter (export or user token) — widens corpus, adds asker graph | G2 |
| 10 | Slack Socket Mode app: relevance gate → DM draft → Send/Edit/Ignore | Admin install |

Steps 1–8 are a complete, measurable, useful duo that needs nobody's permission.
