# duo: Interaction Model PRD v0.4 (Grok Bot patterns)

**Author:** Principal Product Manager  |  **Date:** 20 Oct 2026  |  **Status:** Draft for shin's approval. Planning only. No code changes until shin approves.

**Audience:** shin (owner, solo builder), Product Designer (flows and wireframes), Staff Software Engineer Bot (build plan).

**Changelog:** v0.4 (20 Oct 2026): D9 updated with the build-vs-adopt result and final call, approved by shin (keep Matrix and the current client, add interactive card messages); licence decided (none for now); D1 notes now record shin's approval of chosen avatars for desk duos and typed instructions to set them up. v0.3 (20 Oct 2026): added Design principles (Principle 1, Conversation first, DECIDED); added D9 (client is replaceable, DECIDED); rewrote stories and v1 scope so creation and permission changes happen in chat; added an in-chat group creation story; D6 card editable inline; N set to 5 throughout. v0.2 (20 Oct 2026): D1 marked DECIDED by shin (one personal duo plus up to 5 owner-private desk duos, always "desk duos"); TL;DR updated; noted the docs-only PR. v0.1 (20 Oct 2026): first draft.

**Repos:** guangshinhaha/digital-duo (model/backend: `duo` CLI, `duo serve` daemon) and guangshinhaha/duo (client). One product.

## 1\. TL;DR

- **Recreate the Grok Bot interaction model in duo, in two parts.** Part A: a visitor chatting with someone else's duo. Part B: an owner running a small team of desk duos.  
- **Ship A first (v1).** It is about 70% built, and it is what the pilot metric measures: "Do you leave it on for two weeks?"  
- **v1 adds:** @mention gating in group rooms, a Task unit with ack and milestone updates, decision cards, inline approval cards, a single "What {duo} may do" permissions card editable from chat, in-chat group creation, and take-over / hand-back. Everything is driven from the conversation (Principle 1).  
- **v2 is Part B:** desk duos, orchestrator handoffs between duos, and routines.  
- **Decided (shin, 20 Oct 2026):** D1: owners may create their own duos: one personal duo plus up to 5 owner-private desk duos, created in chat in about 60 seconds. Always called "desk duos", never employees. D9: the duo client is replaceable. Comparison done; decided (shin, 20 Oct 2026): keep Matrix and the current client and add interactive card messages. Also approved: desk duos can have a chosen avatar (never a person's photo) and are set up by typed instructions. A docs-only PR updating concept.md, the README, vocabulary.md and hosted-mode.md is being opened by Staff Software Engineer Bot for shin's review.

## 2\. Design principles

### Principle 1\. Conversation first: chat is the control surface — DECIDED (shin, 20 Oct 2026\)

- **Anything the owner can do, they can do by asking in chat.** "Create a desk duo for X." "Make a group with A and B." "Stop answering questions about budgets." "Every Monday, draft the weekly status." No clicking through screens.  
- **Details come inline.** When the duo needs details, it shows an inline form or option card in the conversation, pre-filled from what the owner said.  
- **Confirm, then show the result.** Before anything is created or changed, a confirmation card. Afterwards, a result card with links (to the new chat, room, rule or routine).  
- **Rich components, one vocabulary.** Option/decision cards, inline forms, draft and approval cards, progress/status cards, result cards. The same components serve the owner and the visitor.  
- **Settings screens are a read-only mirror.** They may exist to show state. They are never the required path to change it.

## 3\. Problem and goals

**Problem.** shin gets real leverage from Grok Bot's "virtual employees": one chat per agent, instant acks, background work, tappable decisions, approval before anything goes out. duo has the hard parts underneath (a derived voice, a trust grid, drafting with confidence gates). But the interaction is still question→draft. There is no task, no progress, no decision card, and no safe way for duos to work together. In group rooms the duo answers every human message, which is noisy and erodes trust.

**Goals.**

1. A visitor gets a useful answer, or a clear "passed to {owner}", fast, and always knows what is happening.  
2. The owner stays in control with minimal effort: approve, override, take over, hand back.  
3. Permissions are understandable on one card.  
4. (v2) The owner can run several role-scoped desk duos through one orchestrator without loops or noise.

**Non-goals.** Real action integrations, Slack, mobile and Mac apps, a marketplace or templates, cross-org duos.

**Who it's for.**

| User | Who | What they need |
| :---- | :---- | :---- |
| Owner | "The officer everyone asks, who rotates out within a year" (concept.md §4) | Fewer repeat questions, no surprises, easy control |
| Visitor | A colleague asking the owner's duo | A fast, honest answer or a clear handoff |
| Owner of desk duos (B) | shin, running several role-scoped duos | Delegate to the right duo, see progress, approve results |

## 4\. Current state (verified from repos)

Paths are under digital-duo unless marked *client* (guangshinhaha/duo).

**Build and mirror**

| Status | Capability | Where |
| :---- | :---- | :---- |
| Working | Build from Claude export or paste. Derives pairs, topics, rules, voice | src/ingest, src/derivation; *client* src/routes/Onboarding.tsx |
| Working | Mirror: portrait, approve/reject derived rules, hand-written refusals | *client* src/profile |
| Missing | More than one duo per account (signup returns `already_has_duo`) | n/a |

**Answering and drafting**

| Status | Capability | Where |
| :---- | :---- | :---- |
| Working | Drafting pipeline: confidence gating, relevance gate, fact-check, "Why?" | drafting/pipeline.ts |
| Working | MCP connector | serve/mcp-tools.ts |
| Working | Inline drafts: Send / Edit / Dismiss / Why? | *client* RoomDrafts.tsx, DraftTray.tsx, WhyButton.tsx |
| Partial | Proactive draft offers on @mention (no live trigger) | n/a |
| Missing | Task or progress unit. The unit of work is question→draft | n/a |

**Visitors and workspace**

| Status | Capability | Where |
| :---- | :---- | :---- |
| Working | Colleagues ask the duo in Matrix. It answers, passes to owner, or declines. Duo is its own Matrix user | permissions/public-answer.ts, workspace/service.ts |
| Working | First-contact request: Allow / Allow and always allow {who} / Decline. Asker sees "Waiting for {owner}'s OK". Always-allow is 1:1 only | *client* DuoRequests.tsx, src/workspace/duoConversation.ts |
| Working | Banner "{owner}'s duo — answers within limits {owner} set". Outcomes: answered / passed to {owner} / declined | *client* src/workspace/duoConversation.ts |
| Working | Ask links: no-install page (POST /ask) | serve |
| Missing | @mention gating in group rooms. Every human message is treated as a question | src/workspace/questions.ts `answerableQuestionFrom` |
| Missing | Duo-to-duo handoff. Other duos' messages are ignored on purpose (loop guard) | src/workspace |

**Trust, permissions, attention**

| Status | Capability | Where |
| :---- | :---- | :---- |
| Working | Trust grid (slow promote, fast demote), away mode (max 14 days), pinned answers, never-answer rules | backend |
| Working | Escalation digest, daily brief, catch-up, scheduled sends, push, /ws "drafting…" signal | backend |
| Partial | Autonomous send per person (never wired in production) | n/a |
| Partial | Permissions scattered across "May do", Confirmations, room requests, always-allow, Ask links, away mode, never-answer | several |
| Stubbed | Actions T2–T4: tiering, approval, undo exist; executors are no-ops | backend |

**Roles, continuity, platform**

| Status | Capability | Where |
| :---- | :---- | :---- |
| Partial | Role duos with per-holder consent (CLI only) | src/role-duo |
| Partial | Predecessor handover (CLI only) | src/continuity |
| Partial | Shared document duo (sample config only) | n/a |
| Working | Hosted mode: invite-only Google signup, orgs, Synapse org wall | hosted |
| Blocked | Slack (issues \#8, \#22, \#40–42) | n/a |
| Never run | Mac and mobile apps | *client* Tauri |

**Activity.** About 680 issues and PRs in 3 weeks by shin. Last commit 7 Oct 2026\. No open PRs. duo \#325 is the client roadmap epic. \#138 is the chat-first redesign; this PRD should feed it.

## 5\. Gap analysis: Grok Bot patterns vs duo

| \# | Pattern | duo today | Gap | Call |
| :---- | :---- | :---- | :---- | :---- |
| 1 | One persistent 1:1 chat per agent with name, title, avatar, memory | Partial | One duo per account. Visitor 1:1 exists. No per-role chat | A: v1 (polish). B: v2 |
| 2 | Instant answer or one-line ack, then background work with milestones | Partial | Only answer / pass / decline plus "drafting…". No task, no milestones | v1 (Task, D5) |
| 3 | Decision cards, draft cards, approval for risky actions | Partial | Draft card exists. No decision card. Confirmations not inline | v1 (D7) |
| 4 | Emoji reactions as lightweight replies | Missing | Reactions not read as feedback | v1 (D7) |
| 5 | Group rooms with one orchestrator | Missing | No @mention gating. Duos ignore each other | Gating v1 (D3). Orchestrator v2 (D4) |
| 6 | Routines while the owner is away | Partial | Scheduled sends and daily brief only. No owner-defined routines | v2 (D8) |
| 7 | Agents message each other and hand off | Missing | Loop guard blocks all duo messages | v2 (D4) |
| 8 | Agents created on demand with a role; added/removed from rooms | Partial | role-duo is CLI only. No create flow. One-duo cap | v2 (D1) |
| 9 | Results with links and files, never vague pointers | Partial | "Why?" shows sources. No standard result format | v1 (Task result spec) |

## 6\. Decisions

### D1. Personal duo plus desk duos — DECIDED

**Decision (20 Oct 2026, shin).** Owners may create their own duos: one personal duo plus up to 5 owner-private desk duos. They are always called "desk duos", never employees.

**Docs follow-up.** Staff Software Engineer Bot is opening a docs-only PR that updates concept.md, the README, vocabulary.md and hosted-mode.md, for shin's review. No code changes.

**Recommendation.** Each owner has one personal duo plus up to 5 desk duos. A desk duo is role-scoped and owner-private. The owner creates it in chat in about 60 seconds (Principle 1): name, role, one-line brief, instructions, avatar, knowledge sources. It is built on the existing role-duo model (src/role-duo). No template gallery. No marketplace. No sharing outside the owner.

**Rationale.** A separate chat, memory and room membership per desk duo is the core of the Grok Bot pattern. **Rejected alternative:** keep one duo and fake a team with modes. Modes share one memory and one identity, so they cannot sit in a room as distinct members or hand off work. It looks like a team but behaves like one bot.

**Keep the vocabulary ban.** User-facing copy says "desk duo" or "role duo". Never "employee", "teammate", "assistant", "staff", "chatbot", "intern". The headcount-replacement risk in concept.md §12 is real in a public-service context. "Virtual-employee model" may name the interaction pattern in internal docs only.

**What changes.**

| Doc | Line today | Change | Why |
| :---- | :---- | :---- | :---- |
| concept.md §11 | "Not a persona-authoring product. No builder UI, no template gallery, no marketplace." | Add: "Exception: an owner may create private desk duos for their own work. Still no templates, gallery or marketplace." | The create flow is owner-private and scoped, not a platform |
| concept.md §11 | "No duos of someone, created by someone else. Self-created only, instantly killable." | Unchanged. Add: "Desk duos are duos of a role, not of a person. Same rule: owner-created, instantly killable." | Clarifies desk duos don't break the spirit |
| concept.md §12 | "Never build a persona-authoring product… The moment there is a 'create your agent' screen, this is a platform…" | Narrow to: "No create screen for duos that others use or that represent other people. Owner-private desk duos are allowed, capped at 5." | Keeps us out of the platform team's lane |
| concept.md §11/§12 | "Nothing is ever called a virtual employee." / "Never call them employees." | Unchanged | Headcount risk |
| README | "One duo per account" (if stated) | "One personal duo plus up to 5 desk duos" | Matches product |
| vocabulary.md rule 1 | Bans employee, teammate, assistant, staff, chatbot, intern | Unchanged. Add "desk duo" as the approved term | Copy consistency |
| Backend | Signup `already_has_duo` | Keep for personal duo. Desk duos created via a separate path | Minimal blast radius |

### D2. Ship A before B

**Recommendation.** v1 \= Part A plus prerequisites. v2 \= Part B. **Rationale.** A is about 70% built and drives the two-week metric. B needs D3–D5 anyway. **Changes:** roadmap epic duo \#325 and \#138 reorder to A first.

### D3. Fix @mention gating first

**Recommendation.** In group rooms a duo responds only when @mentioned or when a human replies to its message. In a 1:1 it responds to everything. **Rationale.** Answering every message is noise and a trust risk. Multi-duo rooms are impossible without it. **Changes:** src/workspace/questions.ts `answerableQuestionFrom` gains a room-type and mention check. Metric: 100% of group-room replies are mention- or reply-triggered.

### D4. Duo-to-duo work only through an orchestrator (v2)

**Recommendation.** Keep the "ignore other duos" loop guard by default. Accept a duo message only when it is a structured handoff: a Task object with a requester, hop count ≤ 1, and a budget (tokens and time). Only the owner's orchestrator (their personal duo acting as lead in a room) can delegate. Specialists reply with a finished result or a decision card, never chat. **Rationale.** Loops and budget burn are the main risks of multi-agent rooms. One delegator and one hop make the system easy to reason about. **Changes:** new handoff message type; loop guard checks for it; orchestrator role per room.

### D5. Task as a first-class unit

**Recommendation.** Add Task next to Draft. States: `acknowledged → working → needs-decision → done | failed`. A Task produces an instant ack (≤ 1 line), milestone updates (only at state changes or meaningful steps, max \~3), and a final result with links and files. Visitors see only their own tasks. Owners see all tasks. **Rationale.** This is pattern 2 and 9\. It also gives handoffs (D4) and routines (D8) a common object. **Changes:** new table in sqlite store, /ws events per state change, task chip in chat, owner task list.

### D6. One permissions card

**Recommendation.** One "What {duo} may do" card per duo with three columns: **Answers on its own** / **Drafts for you** / **Never**. Below it: **Who can reach it** (org wall, always-allowed people, rooms, Ask links). It replaces the scattered UI surfaces. The owner opens it by asking ("what can you do?") and edits it inline in chat: tap an item to move it between columns, or say "never answer questions about budgets". Every change shows a confirmation card, then a result card. The backend stays as is in v1; the card reads from and writes to the existing settings. **Rationale.** The owner can't trust what they can't see in one place, and shouldn't have to leave the conversation to change it. **Changes:** client plus a thin write path to existing settings in v1. Existing surfaces become read-only mirrors of the card.

### D7. Cards, reactions, take-over

**Recommendation.**

- **Decision card:** 2–4 tappable options from the duo to the owner or visitor. Puts a Task in `needs-decision`.  
- **Draft card:** existing Send / Edit / Dismiss / Why?.  
- **Approval card:** existing Confirmations for T3/T4, surfaced inline in the chat.  
- **Reactions:** 👍 on a draft approves sending only where the trust grid already allows auto for that person and topic. Otherwise any reaction is feedback only. 👎 counts as a wrong-answer signal and prompts "What was wrong?".  
- **Take over:** "I'll take it from here" pauses the duo in that thread. A visible label shows "{owner} is replying". **Hand back** resumes the duo.

**Rationale.** Patterns 3 and 4, without creating a new path to autonomous send. **Changes:** new decision card component, inline Confirmations, reaction handler, per-thread pause flag.

### D8. Routines are v2 for B

**Recommendation.** Routines (scheduled or event-triggered tasks) build on the scheduled-send runner and daily brief. They run as Tasks and deliver to the owner. A visitor can never create a routine on someone else's duo. **Rationale.** Valuable for B, not needed for the two-week metric. **Changes (v2):** routine object, triggers, run history.

### D9. The duo client is replaceable — DECIDED (shin, 20 Oct 2026\)

**Decision.** The product is the digital-duo model plus this interaction model. The guangshinhaha/duo client is one way to deliver it, not the product. Redesigning it from scratch or adopting an open-source chat client are both acceptable. **Comparison result.** Staff Software Engineer Bot's [duo: Client build-vs-adopt comparison v0.1](https://docs.google.com/document/d/1RjZy1oe_BsJcEbNOWfUyXDE5bpOjlyn1V_mSpjl0o8o/edit) is done.

**Final call: DECIDED (shin, 20 Oct 2026).** Keep Matrix and keep the current guangshinhaha/duo client. Add interactive card messages (decision, form, approval, progress, result, "desk duo created") that the duo posts and updates in place, and the client draws. It scored 85/100 on the agreed weights, because the client already has rooms, threads, @mentions, visitor states, PWA, push, an offline queue and a custom message type (polls). A new thin client on assistant-ui scored 72: it is built for one person talking to one AI, so all of that would be rebuilt. We borrow assistant-ui's MIT-licensed card components instead. Ruled out: Element and Cinny (AGPL), Open WebUI (branding limits above 50 users), LobeHub (commercial licence), Chainlit (archived), CopilotKit and LibreChat (no rooms or visitor flow). **PM view:** agree; this replaces my earlier thin-client hunch.

**Card transport.** Cards visitors can see go over Matrix as a custom message type. Owner-only cards (drafts, approvals, the D6 card) go over digital-duo's own HTTP/WebSocket connection. That connection does not yet send task or progress updates, so D5 needs a task event stream on the backend.

**Licence: DECIDED (shin, 20 Oct 2026).** Neither repo gets a licence file for now (private, all rights reserved). Add a third-party notices file for the borrowed MIT code. If shin ever open-sources, MIT is the default.

**Changes:** v1 client work is card messages in the existing client, following the comparison doc's six-phase plan. Backend work: emit cards over Matrix and the HTTP/WebSocket connection, plus task and progress events (D5). No code until shin approves.

## 7\. Part A: visitor chatting with someone else's duo (v1)

**What the visitor sees.**

- A 1:1 chat with the duo: name, "{owner}'s duo", avatar, banner "{owner}'s duo — answers within limits {owner} set."  
- First contact: "Waiting for {owner}'s OK" until allowed (existing).  
- Each question gets one of: an instant answer with sources, a one-line ack plus a task chip ("Checking with {owner}…"), or an honest decline.  
- Task chip shows state and milestones. Final result includes links or files.  
- Decision cards when the duo needs the visitor to choose ("Do you mean the 2025 or 2026 circular?").  
- Reactions: 👍 / 👎 on any answer.  
- In group rooms, the duo replies only when @mentioned or replied to.

**What the visitor can do.** Ask, react, choose on a decision card, ask "Why?", see their own task status. They cannot see other visitors' tasks, change permissions, or create routines.

**What the owner sees.**

- All visitor tasks in one list, filterable by state.  
- Passed-to-owner items with a pre-drafted reply (draft card).  
- Approval cards inline for any T3/T4 request.  
- Escalation digest, daily brief and push (existing), now linking to tasks.  
- The permissions card (D6).

**Owner controls.** Approve or edit a draft. Answer a decision. Take over a thread ("I'll take it from here") and hand back. Pin an answer. Add a never-answer rule from any message.

**Permissions.** As shown on the D6 card. The duo answers on its own only inside the trust grid. Everything else becomes a draft for the owner. Never-answer rules always win.

**Edge cases.**

| Case | Behaviour |
| :---- | :---- |
| Owner offline | Duo acks, creates a task in `working`, tells the visitor "Passed to {owner}. You'll get a reply here." Digest and push reach the owner |
| Owner in away mode | Ack says "{owner} is away until {date}." Duo answers only what the trust grid allows. Rest queues. Max 14 days (existing) |
| Duo can't answer | Says so plainly, passes to owner. Never guesses below the confidence gate |
| Sensitive topic | Never-answer rules and the relevance gate decline with a neutral line. No hint of the content. Logged for the owner |
| Visitor asks it to act ("book the room", "send this to X") | v1 has no real executors. The duo creates a task in `needs-decision` and sends the owner an approval card. Visitor sees "Needs {owner}'s OK". On approval the owner does it; the duo confirms back |
| Owner takes over mid-task | Task stays open, assigned to owner. Label shows. Duo silent until hand back |
| Visitor via Ask link | Same flow, no install. Rate-limited per link (see Risks) |

## 8\. Part B: owner's desk-duo team (v2)

**Create a desk duo.** In chat, about 60 seconds. The owner says "create a desk duo for weekly reports". The duo replies with an inline form card, pre-filled where it can: name, role, one-line brief, instructions, avatar, knowledge sources (existing ingest). Confirm, then a result card links to the new desk duo's chat. Default permissions: drafts everything for the owner; answers nothing on its own until the trust grid promotes it. Delete is instant, by asking or one tap. Cap: 5\.

**1:1 chat per desk duo.** Each desk duo has its own persistent chat and memory. Same Task, decision, draft and approval cards as Part A. The owner can talk to any desk duo directly.

**Orchestrator room.** A group room with the owner, their personal duo as lead, and chosen desk duos. The owner talks mostly to the lead. The lead acks, picks the right desk duo, de-duplicates work, and sends a structured handoff (D4). Desk duos post only finished results or decision cards. No chatter between duos.

**Handoffs.** Task object: requester, assignee, brief, hop count (≤ 1), budget, deadline. The lead may delegate. A desk duo may not re-delegate; it returns `needs-decision` or `failed` to the lead. Over budget \= `failed` with a reason.

**Routines.** Set in chat, with a confirmation card. "Every Monday 9am, draft the weekly status from these sources." "When a new circular lands in folder X, summarise it." Each run is a Task delivered to the owner. Owner can pause, edit or delete. Visitors can't create routines.

**Add or remove from rooms.** The owner asks in chat ("add the reports duo to \#ops") and confirms on a card. Removing is immediate. A desk duo's answers in shared rooms follow the same @mention gating and its own permissions card.

## 9\. Scope

| v1 (Part A \+ prerequisites) | v2 (Part B) | Out of scope |
| :---- | :---- | :---- |
| @mention gating (D3) | Desk duos (D1) | Real T2–T4 executors / integrations |
| Task unit with ack, milestones, result with links (D5) | Orchestrator room and handoffs (D4) | Slack |
| Decision card (D7) | Routines (D8) | Mobile and Mac apps |
| Inline approval cards (D7) | Add/remove desk duos from rooms | Marketplace, templates, gallery |
| Reactions as feedback (D7) | Per-desk-duo 1:1 chat and memory | Cross-org duos |
| Unified permissions card, editable in chat (D6) |  | Autonomous send beyond current trust grid |
| Take over / hand back (D7) | Desk duos created in chat via inline form (D1) |  |
| Conversation-first control: inline forms, confirmation and result cards (Principle 1\) | Routines set in chat (D8) |  |
| In-chat group creation (people plus the owner's duo) |  |  |
| Permissions card editable inline from chat (D6) |  |  |
| Build-vs-adopt client comparison (D9) |  |  |

## 10\. User stories

**S1 (v1, A) @mention gating in group rooms.** Given a duo is in an allowed group room. When a human posts without @mentioning the duo or replying to it. Then the duo does not respond or draft. When a human @mentions it or replies to its message. Then it responds as normal.

**S2 (v1, A) 1:1 responds to everything.** Given a visitor in an allowed 1:1 with a duo. When they send any message. Then the duo responds (answer, ack, or decline) without needing a mention.

**S3 (v1, A) Instant answer.** Given the question is inside the trust grid and above the confidence gate. When the visitor asks. Then the duo answers in one message with sources, and "Why?" shows the reasoning.

**S4 (v1, A) Ack plus task.** Given the duo can't answer on its own. When the visitor asks. Then within a few seconds the visitor sees a one-line ack and a task chip in `acknowledged`, and the owner gets a task with a draft reply.

**S5 (v1, A) Milestones, not play-by-play.** Given a task is open. When it changes state. Then the visitor sees at most one short update per state change, and the final result includes links or files rather than "see the doc".

**S6 (v1, A) Decision card.** Given the question is ambiguous. When the duo needs a choice. Then it shows 2–4 tappable options, the task moves to `needs-decision`, and tapping one resumes the task.

**S7 (v1, A) Inline approval.** Given a visitor asks the duo to do something at tier T3/T4. When the duo receives it. Then the owner sees an approval card inline in the chat, the visitor sees "Needs {owner}'s OK", and nothing happens without approval.

**S8 (v1, A) Reactions.** Given a draft or answer. When the owner reacts 👍 and the trust grid allows auto for that person and topic. Then the draft sends. Otherwise 👍 is recorded as feedback only and nothing sends. When a visitor reacts 👎. Then it counts as a wrong-answer report and the owner is notified.

**S9 (v1, A) Take over and hand back.** Given a visitor conversation. When the owner taps "I'll take it from here". Then the duo stops responding in that thread and both sides see "{owner} is replying". When the owner taps "Hand back". Then the label clears and the duo resumes.

**S10 (v1, A) Permissions card, edited in chat.** Given I type "what can you do?" in my duo's chat. When the duo replies. Then the "What {duo} may do" card appears inline with three columns (answers on its own / drafts for you / never) and who can reach it, from current backend settings. When I type "never answer questions about budgets" or tap an item to move it. Then a confirmation card shows the change, and on Confirm a result card shows the updated card. No settings screen is needed.

**S11 (v1, A) Owner away.** Given away mode is on. When a visitor asks something outside the trust grid. Then the duo acks with "{owner} is away until {date}", queues a task, and does not answer on its own.

**S12 (v1, A) Create a group in chat.** Given I type "make a group with Aisha and Ben" in my duo's chat. When the duo replies. Then an inline form card appears with the room name and members pre-filled, plus whether my duo joins. On Confirm, a result card links to the new room. In that room my duo follows @mention gating (S1).

**S13 (v2, B) Create a desk duo in chat.** Given I have fewer than 5 desk duos and I type "create a desk duo for weekly reports". When the duo replies. Then an inline form card appears with name, role and brief pre-filled, and fields for instructions, avatar and knowledge sources. On Confirm, a result card links to the new desk duo's chat within about 60 seconds. The desk duo defaults to drafting everything. No copy uses banned words. If I already have 5, the duo says so and offers to remove one.

**S14 (v2, B) Orchestrator handoff.** Given an orchestrator room with the owner's lead duo and two desk duos. When the owner asks the lead for work. Then the lead acks, sends one handoff (hop count 1, budget set) to one desk duo, and only the finished result or a decision card is posted. A desk duo attempting to re-delegate is rejected.

**S15 (v2, B) Routine set in chat.** Given I type "every Monday 9am, draft the weekly status" in a desk duo's chat and confirm the confirmation card. When the trigger fires while the owner is away. Then a Task runs, and the result with links lands in the owner's 1:1 chat. A visitor has no option to create a routine.

## 11\. Success metrics

All targets are initial guesses to calibrate in the pilot. No baselines exist yet; measure them in week 1\.

| Metric | Part | Initial target |
| :---- | :---- | :---- |
| **Primary:** owners who leave it on for 14 days | A+B | Majority of pilot owners |
| Answered-without-owner rate | A | Rising week on week |
| Pass-to-owner median time | A | Under one working day |
| Visitor 👍 rate on answers | A | Majority positive |
| Wrong-answer reports per 100 answers | A | Under 2 |
| Share of group-room duo replies triggered by @mention or reply | A | 100% |
| Tasks completed without owner rework | B | Majority |
| Time from ack to first milestone | B | Minutes, not hours |
| Desk duos active weekly per owner | B | At least 1 |

## 12\. Risks and open questions

| Risk | Note | Mitigation / question |
| :---- | :---- | :---- |
| Privacy: one master key | Hosted server holds all duo keys under one master key | Open: per-org or per-owner keys before widening the pilot? Desk duos multiply what the key protects |
| Classified / sensitive data | Docs say not cleared for classified or sensitive government data | Show this on the create flow and knowledge-source picker. Keep pilot to non-sensitive work |
| Leaked Ask link spends budget | One shared OpenRouter key | Per-link rate limits, expiry, and a per-owner daily budget. Revoke from the permissions card |
| Loops between duos | Main multi-agent risk | Loop guard stays default. Handoff only via Task, hop ≤ 1, budget, orchestrator-only delegation |
| Impersonation | A duo or desk duo mistaken for the owner | Duo is its own Matrix user. Banner and "{owner}'s duo" label on every surface. Never posts as the owner |
| Platform team's lane | A create flow can read as a platform | Owner-private, capped at 5, no templates, no sharing. Open: brief the platform team before v2 |
| Headcount optics | "Virtual employee" reads as replacement | Vocabulary ban stays in all user-facing copy |

**Open questions for shin.** (1) D1: resolved on 20 Oct 2026 (decided, up to 5 desk duos). (2) Does a desk duo get its own Matrix user? We recommend yes. (3) Should visitors ever reach desk duos, or are they owner-only in v2? We recommend owner-only.

## 13\. Hand-offs

**Product Designer: wireframe these.**

1. 1:1 chat (visitor view and owner view), with banner and identity.  
2. Decision card, draft card, approval card, and reaction states, plus the inline form, confirmation and result cards (Principle 1\) used for every create or change.  
3. Task chip and task progress: states, milestones, final result with links.  
4. Owner task list.  
5. Take over / hand back, with the visible label.  
6. "What {duo} may do" permissions card, edited inline in chat.  
7. Group room with @mention gating cues, and in-chat group creation.  
8. (v2) Orchestrator room.  
9. (v2) Desk-duo creation in chat, under 60 seconds, with the sensitive-data warning.  
10. A must-have UX list for the client, used to score D9's build-vs-adopt comparison.

**Staff Software Engineer Bot: analyse these.**

1. @mention and reply gating in src/workspace/questions.ts `answerableQuestionFrom`, and Matrix reply detection.  
2. Task data model in sqlite, state machine, /ws events, and how it relates to Draft and the drafting pipeline.  
3. Surfacing Confirmations (T3/T4) inline without new executors.  
4. Reaction handling and the trust-grid check for 👍-to-send.  
5. Per-thread pause flag for take-over.  
6. Read and write model for the permissions card across all existing permission sources, driven from chat.  
7. Ask link rate limits and per-owner budget on the shared OpenRouter key.  
8. (v2) Desk duos on src/role-duo: separate creation path vs `already_has_duo`, memory and key isolation.  
9. (v2) Handoff message type, loop-guard change, hop and budget enforcement.  
10. (v2) Routines on the scheduled-send runner.  
11. Turning chat requests into actions: intent to inline form, confirmation and result cards, with no hidden side effects.  
12. D9 build-vs-adopt comparison: the current client vs open-source chat UIs with rich inline components, scored against Product Designer's must-have UX list. Recommendation to shin; no code until approved.

Planning only. No code changes until shin approves.