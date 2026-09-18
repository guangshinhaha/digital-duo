# Digital Duo — Concept

> Status: converged direction, pre-build. Internal GovTech project, dogfood pilot.
> Last updated: 2026-09-18

## 1. What it is

A platform where a person creates a digital agent of themselves — their voice, their
knowledge, and their authorised actions — that colleagues can consult, and that eventually
acts on their behalf within limits they set.

Not "a chatbot with my personality." The word that changes the category is **actions**. The
moment a duo can *do* something for you, you are no longer shipping an AI feature; you are
shipping **delegated authority**. That is a trust product.

**Positioning:** a *duo*, not a clone. A second you that holds your context and works inside
boundaries you grant. It never poses as you.

## 2. The real problem

Not "can it sound like me" — models are already good enough at voice.

The real problem: **when my duo is wrong in public, it is my reputation.**

So the core primitives are not embeddings and prompts. They are:

- **Confidence gating** — the duo must be excellent at saying *"I don't know, I've flagged this"*
- **Escalation** — silent handoff to the human with thread context preserved
- **Approval queues** — batched, never a stream of pings
- **Retraction** — corrections posted into the same thread
- **Audit trail** — every answer traced to a source, every action to a policy

A duo that is right 70% of the time and *knows which 70%* beats one that is right 90% and
always confident. Most products in this space get that backwards.

## 3. The core bet

**A knowledge base is not documents. It is decisions.**

Uploading PDFs gives you a search engine with a personality skin — useless, because the asker
could have searched. What makes a duo worth consulting is that it knows:

- what you would say **no** to
- what you would **push back** on
- what you would **escalate**
- your **standing preferences**

That does not live in documents. It lives in past Slack threads, PR reviews, email replies,
and — most densely — in your past conversations with AI assistants.

The output is not a black-box fine-tune. It is a **readable, editable list of standing orders**.
That editability is simultaneously the quality loop, the explainability surface, and the trust
story: when someone asks "why did it do that," you open a file and point at a line.

## 4. The wedge

**The human bottleneck** — the person everyone DMs. Staff engineer, ops lead, the one who owns
the thing nobody documented. Their day is ~40 interruptions, most of them repeats.

In the public service this fuses with a second, stronger force: **posting rotation**. Knowledge
loss is not episodic here, it is *scheduled*. Every rotation, deep institutional context walks
out and a successor starts at zero, and everyone knows months in advance.

So the sharpest profile is: **the officer everyone asks, who rotates out within a year.** Acute
present pain, deadline-shaped future pain, and a director with key-person anxiety.

It also unlocks a second mode worth naming: a duo is not only *"consult me"* — it is
*"consult my predecessor."* A duo that outlives a posting is a genuinely new object.

## 5. Why GovTech makes this easier

**Classification already exists.** In a company, knowledge tiering is the hardest unsolved part
— you must invent tiers and get people to apply them. In government the taxonomy is mandated,
applied, understood, and legally enforced. You inherit it. The permission model becomes "the duo
respects classification and need-to-know," which is a sentence a security reviewer can approve.

The flip side: it is licence-to-operate, not a v2 feature. Mishandling classified material is
not a bad Slack moment. The **field belongs in the v1 schema even though the logic does not**.

**Gov work is procedural.** Private-sector actions are fuzzy; gov actions are defined — route an
approval, check a circular, find the owning agency, escalate per SOP. The correct answer exists
and is written down, which makes the action ladder far easier to climb safely.

**Gov does not buy on hours saved.** The value story is continuity, response latency to other
agencies, and reduced key-person risk — not cost.

## 6. The trust ladder

Actions are staged by **risk shape**, not build difficulty. Three axes: reversibility,
obligation (does it bind the human to future work), and audience.

| Tier | What | Stance |
|---|---|---|
| **T0 Retrieval** | Answer, cite, summarise, find the thread | No side effects |
| **T1 Private preparation** | Drafts visible **only to the owner** | Cannot embarrass anyone. Richest training signal. |
| **T2 Reversible internal** | Post a link, label, triage, tentative hold, route | One-click undo, duo announces what it did |
| **T3 Binding internal** | Approve, confirm, assign, commit to a date, speak unhedged | Starts as draft-and-approve, graduates individually |
| **T4 External / irreversible** | Citizen-facing, cross-agency outbound, spend, statutory effect | **Never autonomous. Product principle, not a limitation.** |

### Autonomy is a grid, never a global setting

Trust is granted per **(topic × tier)**:

```
                    onboarding   deploy access   pricing   hiring
T0  answer             auto          auto         auto      ask
T1  draft              auto          auto         auto      auto
T2  reversible act     auto          approve       —         —
T3  binding act      approve           —           —         —
```

### The trust ledger

- **Promote slowly** — a cell offers to graduate after N clean instances *and* an explicit tap
  from the owner. Never silently. The owner must feel they granted it.
- **Demote fast** — one correction drops the cell a level immediately, and says so:
  *"I got that wrong, so I've gone back to asking you first."*

That asymmetry is the whole trust story in one mechanic. A system that gets cautious when it is
wrong is one people will actually delegate to.

### Standing orders — the granted fast path

Learned trust is slow, so the owner can write plain-English overrides:

> *"If anyone asks about deploy access: point them at the runbook, grant read-only, don't ask me."*
> *"Never speak for me on comp, headcount, or anything touching a renewal."*

Two routes to autonomy — **earned** (ledger) and **granted** (standing orders).

## 7. Onboarding: The Mirror

Nobody will sit and describe their own personality. The duo must arrive already knowing them.
Target: **15 minutes, 10 of them optional.**

1. **Connect / import** — see `import-adapters.md`
2. **Derive, don't ask** — topics, voice, refusals, escalation patterns, asker graph
3. **Show the mirror** — a portrait, not a settings page:

   > *You were asked about deployment access 23 times in six months. You almost always point
   > people at the runbook and grant read-only. You never commit to a date without checking with
   > X. You push back on prod exceptions every time, in five words or less. Your top 5 topics are
   > 61% of everything people ask you.*

   One screen that proves it works, delivers the ROI story in the user's own data, produces the
   topic taxonomy, and is the thing they screenshot for their director.

4. **Calibrate from real history** — twelve past questions, the duo's proposed answer beside what
   they actually said, 👍/👎/edit. Far better than a questionnaire: concrete, fast, and it yields
   labelled corrections plus confidence calibration.
5. **Go live in shadow mode** — useful in hour one, public in month three.

> **Principle: the user never writes their personality. They approve a draft of it.**

## 8. What each source is good for

| Source | Uniquely good for | Weakness |
|---|---|---|
| **Slack** | Decisions *in context*, refusals, the interruption pattern itself, who-asks-what | Terse; reasoning usually missing |
| **LLM chat history** | **Reasoning, standards, voice, what "good" means to them** | No social context |
| **Docs / circulars** | Facts, SOPs, the authoritative answer | Stale; the asker could have searched |

The LLM-history point stated plainly: **when someone talks to an AI they externalise their
reasoning in a way they never do in Slack.** They state constraints, reject options and say why,
and iterate toward what good looks like. It is the densest available record of how a person
thinks — better training data for judgment than their Slack one-liners.

**Slack teaches what you decide. LLM history teaches how you think. Docs teach what is true.**

⚠️ LLM history is drafts and thinking-out-loud, including positions considered and rejected. It
trains style and reasoning. It must **never** be quotable as "X said."

## 9. Consent design (non-negotiable)

- **Only the owner's own utterances are stored.** Others' messages are read at ingest for
  context, used to derive the rule, then dropped.
- **No DMs by default.** Opt-in, per-conversation, explicit.
- **Classification-aware ingest.** Above the ceiling is never ingested; the ceiling is policy-set,
  not user-set.
- **Visible provenance.** Every standing order shows its source threads; one click deletes the
  rule and its evidence.
- **Always labelled.** The duo never poses as the human. An officer's word carries policy weight;
  impersonation is a category error.
- **Full owner-visible log**, always, by default.

Written up properly, this list *is* the security review submission.

## 10. Known risks

- **Survivorship bias in the training data.** History records what you said, not what you
  declined, ignored, or quietly routed elsewhere — and discernment is the bottleneck person's
  real skill. The duo will learn helpfulness and not learn restraint. Mitigation: hand-written
  refusals, prompted for explicitly. The one part worth not deriving.
- **Trading 40 interruptions for 40 approval pings.** The fastest way to kill this. Escalations
  must batch into a digest; only a narrow urgent class interrupts live.
- **Staleness.** You changed your mind in March; the duo quotes January. Needs recency decay and
  age-aware hedging.
- **Nobody invokes it.** Waiting to be @mentioned is a losing strategy. The duo should watch
  threads where its owner is mentioned and proactively offer a draft — to the owner only.
- **Accountability chain.** If a duo misguides another agency, who answers? Solve it in the
  product — labelled, logged, retractable, owner-attributed — before it is asked in a review.
- **Internal platform collision.** Position as a layer *on top of* the sanctioned AI stack, not
  a competitor to it.

## 11. Non-goals

- Not a general org-wide knowledge oracle — a duo is **someone's**, accountable to them
- Not a search engine over documents
- Not a clone, not an impersonation, never unlabelled
- No duos *of* someone, created *by* someone else. Self-created only, instantly killable.
