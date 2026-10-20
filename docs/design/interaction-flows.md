# duo: Interaction Flows v0.1

Product Designer · 20 Oct 2026 · Status: draft for shin. Planning only, no code changes.
Source of truth: *duo: Interaction Model PRD v0.4* (Principal PM). Visual language: Hairline (`docs/design-language.md`, `docs/vocabulary.md`, `src/styles/tokens.css` in guangshinhaha/duo).
Prototype: [`prototype.html`](./prototype.html) (one self-contained file, 10 screens, Offline / Error / Empty switches). Sample people and organisations are fictional.

## 0. Design principles

1. **Conversation first (PRD Principle 1, decided).** The owner never has to click through setup screens. They type "create a desk duo for policy research", "make a group with Priya and Arun", "never answer questions about budgets". The pattern is always: **message → instant ack → inline card → result card**. When details are missing, the duo asks with an **inline form card** pre-filled from the message (fields marked *guessed*), never a separate page. Settings and lists exist only as read-only mirrors.
2. **Confirm, then show the result.** Every create or change goes ask → form or confirm card → result card with links (Open / Edit / Undo). A card that has been decided **updates in place**: it dims to 0.55, its inputs lock, and its header reads "· submitted / confirmed".
3. **The duo always writes behind a line.** Every duo-authored block has the attribution line (mark · name · state · time) and the 2px hairline: Moss = confident or done, Amber = hedged, needs a choice or needs a confirm, Ash = refused or declined, Dust = neutral (ack, working, failed). Confidence is shown in words, never as a percentage.
4. **One accent means one thing.** Signal (#7C8CFF) is used only on the primary action that is available now. Everything else is greyscale.
5. **Never mistakable for the owner.** A duo shows the mark, never a face. It is labelled "Your duo" on the owner's side and "{owner}'s duo" everywhere else. Desk duos may have a chosen avatar (abstract or uploaded, never a person's photo; approved by shin in PRD v0.4) plus a 2-letter tag, and are always called "desk duos".
6. **Irreversible means two steps.** T4 is never on its own: a card with "Review and confirm…", then a dialog with Cancel focused. It is disabled when offline and never queued.
7. **Rich, reversible components.** Option chips, inline forms, toggles inside cards, task blocks, and an Undo toast (5 s, ⌘Z) for anything that has not yet left the machine.
8. **Keep the client, add cards (PRD D9, decided in v0.4).** shin was fine with replacing the client, but the final call is to keep Matrix and the current guangshinhaha/duo client and add interactive card messages that the duo posts and updates in place. So the prototype keeps the existing shell (chat list, conversation, Info panel ⌘I) and the Hairline tokens (colour ramp, hairline, mark, type roles, radii 6/10/14, 4px grid, no shadows except dialogs and popovers), and puts the new work into cards. See §4–5.

## 1. Screens in the prototype

| # | Tab | Covers | PRD |
|---|---|---|---|
| 1 | 1:1 · task | Persistent chat with Your duo, ack, task block with milestones, decision card inside the task, result with files and links, reactions | S2–S6, D5 |
| 2 | Draft · confirm · reactions | Dashed draft (Send / Edit / Dismiss / Why?), Why? popover, 👍-as-feedback, T4 card and dialog, offline-disabled actions | S7, S8, D7 |
| 3 | Visitor view | Arun asks Rachel's duo: Waiting for OK, decision card, labelled outcomes, 👎 report, "Rachel is replying" | S2–S9, §7 |
| 4 | Owner view | First-message request (Allow / Allow and always allow / Decline), draft for a passed-on question, I'll take it from here / Hand back | S4, S9 |
| 5 | Permissions in chat | "What can you do?" → editable card; tap-to-move or "never answer questions about budgets" → confirm card → result card | S10, D6 |
| 6 | Create group in chat | "Make a group with…" → inline form → result card with Open | S12 |
| 7 | Group room · @mention | Duos reply only when @mentioned; "No duo replied" cue; mention toggle in the composer | S1, D3 |
| 8 | Task list | Read-only mirror of every task, filter by state, empty state | D5 |
| 9 | Create desk duo in chat (v2) | Inline form with the sensitive-data warning, progress, "Desk duo created" card, the 5-cap case, routine set in chat, routines list with pause toggles | S13, S15, D1, D8 |
| 10 | Orchestrator room (v2) | Owner → lead; lead hands off (hop 1/1, budget); desk duos post only finished work or a choice | S14, D4 |

### Screenshots

- 01-duo-task-working: ![01-duo-task-working](./shots/01-duo-task-working.png)
- 02-duo-task-decision: ![02-duo-task-decision](./shots/02-duo-task-decision.png)
- 03-duo-task-result: ![03-duo-task-result](./shots/03-duo-task-result.png)
- 04-duo-empty: ![04-duo-empty](./shots/04-duo-empty.png)
- 05-cards-draft-why: ![05-cards-draft-why](./shots/05-cards-draft-why.png)
- 06-cards-t4-dialog: ![06-cards-t4-dialog](./shots/06-cards-t4-dialog.png)
- 07-cards-offline: ![07-cards-offline](./shots/07-cards-offline.png)
- 08-cards-decided: ![08-cards-decided](./shots/08-cards-decided.png)
- 09-owner-request: ![09-owner-request](./shots/09-owner-request.png)
- 10-visitor-waiting: ![10-visitor-waiting](./shots/10-visitor-waiting.png)
- 11-visitor-answering: ![11-visitor-answering](./shots/11-visitor-answering.png)
- 12-owner-answering-draft: ![12-owner-answering-draft](./shots/12-owner-answering-draft.png)
- 13-owner-takeover: ![13-owner-takeover](./shots/13-owner-takeover.png)
- 14-visitor-takeover: ![14-visitor-takeover](./shots/14-visitor-takeover.png)
- 15-visitor-replied-declined-wrong: ![15-visitor-replied-declined-wrong](./shots/15-visitor-replied-declined-wrong.png)
- 16-perms-card-in-chat: ![16-perms-card-in-chat](./shots/16-perms-card-in-chat.png)
- 17-perms-confirm: ![17-perms-confirm](./shots/17-perms-confirm.png)
- 18-perms-result: ![18-perms-result](./shots/18-perms-result.png)
- 19-mkgroup-form: ![19-mkgroup-form](./shots/19-mkgroup-form.png)
- 20-mkgroup-result: ![20-mkgroup-result](./shots/20-mkgroup-result.png)
- 21-group-mention: ![21-group-mention](./shots/21-group-mention.png)
- 22-tasks-list: ![22-tasks-list](./shots/22-tasks-list.png)
- 23-tasks-empty: ![23-tasks-empty](./shots/23-tasks-empty.png)
- 24-mkdesk-form: ![24-mkdesk-form](./shots/24-mkdesk-form.png)
- 25-mkdesk-result-routine: ![25-mkdesk-result-routine](./shots/25-mkdesk-result-routine.png)
- 26-mkdesk-at-cap: ![26-mkdesk-at-cap](./shots/26-mkdesk-at-cap.png)
- 27-orch-decision: ![27-orch-decision](./shots/27-orch-decision.png)
- 28-orch-result: ![28-orch-result](./shots/28-orch-result.png)
- 29-mkdesk-error: ![29-mkdesk-error](./shots/29-mkdesk-error.png)

## 2. Flows

### F1. 1:1 chat with a duo, and background work as a task
```mermaid
flowchart LR
  A[Owner asks] --> B{Can answer now?}
  B -- yes --> C[Answer behind the line, with sources and Why?]
  B -- no --> D[One-line ack]
  D --> E[Task block: acknowledged]
  E --> F[working: at most 3 milestone lines]
  F --> G{Needs a choice?}
  G -- yes --> H[Decision card inside the task, Amber] --> F
  G -- no --> I[done: result with files and links, Moss]
  F --> J[failed: daemon reason verbatim, steps kept, Try again]
```
States: **empty** (new chat: "Ask your duo anything, or tell it what to set up", plus 3 suggestion chips); **offline** (the owner's messages queue; tasks keep running on the daemon; decisions are disabled with a reason); **error** (task `failed`, the daemon's words verbatim, finished steps kept).
Open questions: should milestone lines collapse into one line once the task is done? Does a task survive a daemon restart?

### F2. Draft, decision, approval and reactions
```mermaid
flowchart LR
  Q[Colleague asks owner] --> D[Dashed draft: only you can see this · not sent]
  D -->|Send ⏎| S[Owner's own message, footnoted 'from your duo's draft' for the owner only]
  D -->|Edit E| E[Edit in place] -->|Send edited ⌘⏎| S
  D -->|Dismiss X| X[Dismissed + Undo toast 5 s]
  D -->|Why?| W[Popover: trust reading, standing orders, sources, who asked]
  D -->|👍| R{Trust grid allows auto for this person and topic?}
  R -- yes --> S
  R -- no --> F[Feedback only, toast says nothing was sent]
  T[Request to act, T3/T4] --> C[Confirmation card: what, to what, can it be undone]
  C -->|Review and confirm…| G[Dialog, Cancel focused] -->|Confirm| K[Confirmed: owner does it, v1 has no executor]
  C -->|Don't go ahead| N[Not going ahead, asker told]
```
Phase 1 calls: T3/T4 sample actions are labelled "Sample, nothing runs". In group rooms only the asker can choose on a decision card; everyone else sees it read-only. Options reword the asker's own words and never show topic labels.
States: **offline** (Send, Confirm and Create disabled with a reason, never queued); **error** (send failed: "Couldn't deliver — {daemon reason}" with Retry); **empty** ("Nothing waiting on you.").
Open questions: is 👍-to-send a second send path that the trust grid must explicitly allow per person (PRD S8), or should it always need Send? Which word goes on a T3 card, which is not irreversible?

### F3. Visitor chatting with someone else's duo (v1 priority)
```mermaid
sequenceDiagram
  participant V as Visitor (Arun)
  participant D as Rachel's duo
  participant O as Owner (Rachel)
  V->>D: first message
  D-->>V: Waiting for Rachel's OK
  D->>O: Request card: Allow / Allow and always allow Arun / Decline
  O->>D: Allow
  D-->>V: Decision card "Which circular?"
  V->>D: taps option
  D-->>V: Answer + trust reading → "Answered by Rachel's duo"
  V->>D: question outside the grid
  D-->>V: passed-on message + task → "Passed to Rachel — waiting on them"
  D->>O: dashed draft (Amber)
  O->>V: Send → Rachel's own message → "Rachel replied"
  O->>D: I'll take it from here
  D-->>V: "Rachel is replying" (duo paused)
  O->>D: Hand back → duo resumes
```
Visitors get no Why? button, only the source, evidence-age and trust lines. The decision card reads "Did you mean one of these?" with options that reword Arun's own question; Rachel sees it read-only.
Visitor outcome labels: **Answered by Rachel's duo**, **Passed to Rachel — waiting on them**, **Rachel replied**, **Declined**. Owner side uses "Your duo refused this one." (vocabulary: never "declined" on owner surfaces). The passed-on and refusal texts are daemon-owned and render verbatim (shown as `PUBLIC_PASSED_ON_MESSAGE` / `PUBLIC_REFUSAL_MESSAGE` placeholders).
States: **pending** (visitor composer disabled); **declined** (composer replaced by one line); **owner offline** (ack: "Passed to Rachel. You'll get a reply here."); **away** (ack names the return date; only in-grid answers); **error** (delivery failure verbatim).
Open questions: does "always allow" also cover Ask-link visitors? Should the visitor see the task chip's milestones, or only state?

### F4. Permissions, changed in chat
```mermaid
flowchart LR
  A["What can you do?"] --> B[Permissions card inline: 3 columns + T4 hatched row + Who can reach it]
  B -->|tap item| M[Move to… chips]
  A2["Never answer questions about budgets"] --> C
  M --> C[Confirm card: diff old → new, consequences]
  C -->|Confirm| R[Result card + Undo toast; original card updates in place, item highlighted]
  C -->|Cancel| B
```
Scope chips (Everyone / a person) and a "Tier codes" toggle (T0–T4 shown only on demand). T4 is a hatched row with no control: "Never on its own. You confirm each one."
States: **empty column** ("Nothing earned yet."); **offline** (Confirm disabled); **error** ("Couldn't save — {daemon error}. Nothing changed.").
Open questions: PRD has 3 columns but vocabulary.md has 4 levels (Answers on its own / Drafts for you / Always asks you / Never on its own). Where does "Always asks you" go? Can a promotion be made by tap at all, or only accepted as an offer (Hairline P4)?

### F5. Create a group in chat
`"Make a group with Priya, Arun and my policy research desk duo"` → ack → **New group form card** (name *guessed*, member chips with ×, "Your duo joins" toggle, "Duos reply only when @mentioned" locked on) → Create group → working line → **Group created** card (Open / Edit members / Undo).
States: offline (Create disabled); error (nothing created, no invites sent, Try again); unknown name ("I don't know a Ben. Did you mean…" option chips).
Open questions: is Undo after invites have gone out a real undo? Proposed: Undo = remove the room and withdraw invites, stated in the toast.

### F6. Group room with @mention gating
Human posts without a mention → no duo replies; one faint cue "No duo replied: nobody @mentioned one." A mention (or a reply to a duo's message) → the duo acks and works as in F1. If the duo needs a choice, the decision card is read-only for everyone except the asker (prototype: Wei Jie's "when does it close?"). The @ menu separates people (initials) from duos (mark, "{owner}'s duo"). The member panel shows "@mention only" beside every duo.
Open question: show the "no duo replied" cue every time, or only the first time per room?

### F7. Owner task list (mirror)
Filters: All / Acknowledged / Working / Needs decision / Done / Failed. Each row: task, asked by, state chip (hairline colour), latest milestone, since, Open chat. No actions in the list itself. Also answerable in chat ("what's open?").
Empty: "No tasks yet. When someone asks your duo something it can't answer at once, the task shows up here and in that chat."

### F8. (v2) Create a desk duo in chat, plus routines
```mermaid
flowchart LR
  A["Create a desk duo for policy research"] --> B{Fewer than 5?}
  B -- no --> C[Decision card: end one of the 5, or keep all]
  B -- yes --> D[Form card: name, role, brief guessed; instructions; avatar + tag; Knows; May do = drafts everything, locked; only you]
  D --> W[Sensitive-data warning, always visible]
  D --> AV[Avatar: pick an abstract one or upload, never a person's photo]
  D -->|Create| P[Task: created, reading N documents]
  P --> R[Desk duo created card: Open its chat / Edit / End it, plus Undo toast]
  R --> S["Every Monday 9am, draft the weekly digest"] --> T[Routine confirm card] --> L[Routines list card with pause toggles]
```
States: at cap (5 of 5); offline; error ("Couldn't create it — {daemon error}. Nothing was created."); a source that can't be read is named in the progress line.
Open questions: does each desk duo get its own Matrix user (PRD recommends yes)? Who checks that an uploaded avatar is not a person's photo?

### F9. (v2) Orchestrator room
Owner → @Your duo (LEAD). Lead acks and posts **handoff chips** (desk duo, brief, hop 1/1, time budget, state). Desk duos post only **finished results** or a **decision card**. Lead posts the final result with files. Over budget → the desk duo posts `failed` back to the lead, and the lead asks the owner (extend / drop). A desk duo can't hand off again.
Open questions: can the owner @mention a desk duo directly in this room (PRD: "mostly to the lead")? Where does the budget come from: a default, or set in chat?

## 3. Component inventory (acceptance criteria)

Visibility is shown on each card as a mono label at the top right ("visible to: you", "visible to: Arun and you"). Every duo card carries the attribution line and a hairline. "Decided" = dimmed to 0.55, inputs locked, header suffix updated, and the card stays in place.

**Card events (Phase 1 call):** a card is posted as a `duo.card` event and every answer to it comes back as `duo.card.response`. The card's later states are edits of that same `duo.card`.

Transport (PRD v0.4 D9): cards a visitor can see go over **Matrix** as a custom message type; owner-only cards go over digital-duo's own **HTTP/WebSocket** connection, which needs a new task and progress event stream (D5). The Transport column follows that rule.

| Component | Fields | States (hairline) | Who sees it | Actions | Transport |
|---|---|---|---|---|---|
| Attribution line | mark (desk duos: grey bar + tag; avatar where space allows), name ("Your duo" / "{owner}'s duo" / desk duo name), state word, time, visibility label | n/a | everyone who sees the block | none | both |
| Ack | one line, at most | sent (Dust) | everyone in the chat | reactions | Matrix |
| Answer | text, trust reading in words, "Drew on N sources" links with each source's date (evidence age); Why? for the owner only, so visitors get no Why? button, only the source, evidence-age and trust lines | confident (Moss), hedging (Amber), refused (Ash) | everyone in the chat | Why?, reactions (👎 → "What was wrong?" → report to owner) | Matrix |
| Task block | title, state, ≤3 milestone lines, optional inline decision, result (files with type, name, size; source links) | acknowledged, working (mark loops), needs decision (Amber), done (Moss), failed (Dust, reason verbatim) | requester and owner; visitors only their own | Simulate in prototype; Try again on failed; reactions on done | Matrix if the requester is a visitor; else HTTP/WS |
| Decision card | question, 2–4 options, each **rewording the asker's own words** (never a topic label), number keys | open (Amber) → decided (chosen option outlined, rest dimmed) | everyone in the chat; **only the asker can choose**. Everyone else, the owner included, sees it read-only ("only {asker}, who asked, can choose") | asker: tap an option or 1–4 → `duo.card.response` | Matrix if a visitor chooses; else HTTP/WS |
| Draft card | dashed border, text, one-line why, "only you can see this · not sent" | open, editing, sent (becomes the owner's own message), dismissed (Undo 5 s), send failed | owner only | Send ⏎, Edit E, Send edited ⌘⏎, Dismiss X, Why?, 👍 (sends only if the grid allows) | HTTP/WS |
| Why? popover | trust reading, standing orders hit, sources, who asked | open / closed | owner (on drafts); asker sees the trust reading only | links open the rule or source | HTTP/WS |
| Confirmation card (T3/T4) | verb + object + identifier, asker, time, can it be undone, what the asker sees; while there are no executors, a **"Sample, nothing runs"** label on the card and in the dialog | open (Amber) → confirmed / not going ahead (decided) | owner only; asker sees "Needs {owner}'s OK" | Review and confirm… → dialog (Cancel focused, Confirm, no shortcut); Don't go ahead. Disabled offline | HTTP/WS |
| First-message request | asker, team, their question | pending → allowed / always allowed / declined | owner only; asker sees "Waiting for {owner}'s OK" | Allow, Allow and always allow {name} (1:1 only), Decline | HTTP/WS |
| Outcome label | Answered by {owner}'s duo / Passed to {owner} — waiting on them / {owner} replied / Declined | updates in place as the state moves | everyone in the chat | none | Matrix |
| Take-over bar | "{owner} is replying" (visitor), "You're replying… duo paused" (owner) | on / off | both sides | I'll take it from here / Hand back (header) | Matrix |
| Permissions card | scope chips, 3 columns of topics, tier codes toggle, hatched T4 row, Who can reach it (org wall, always allowed, rooms, Ask links with limit and expiry, away mode) | read, item selected, change pending, updated (new item highlighted) | owner only | tap item → Move to…, Remove, Revoke, ask in words | HTTP/WS |
| Inline form card | fields with *guessed* tags, chips with ×, toggles, locked toggles for rules that can't change | open → submitted (decided) | owner only | Submit (Signal), Cancel. Disabled offline | HTTP/WS |
| Change confirm card | old → new diff, consequence line, scope | open (Amber) → confirmed | owner only | Confirm, Cancel | HTTP/WS |
| Result card | what was created or changed, key facts, timing | done (Moss) / failed (Dust + daemon error) | owner only | Open, Edit, End it / Undo, Try again | HTTP/WS |
| Handoff chip (v2) | kind, desk duo, brief, hop n/1, budget, state | working, needs decision, done, failed | owner and room | none (read-only) | Matrix |
| Routines list card (v2) | when, desk duo, does, last run, on/off | per row: first run, done, failed | owner only | toggle pause; delete by asking | HTTP/WS |
| Undo toast | sentence of what happened, Undo (⌘Z) | 5 s then gone | the actor | Undo | client only |
| Offline bar | what still works | shown while offline | the device user | none | client only |

## 4. Must-have UX for the client (to score D9 build-vs-adopt)

1. Custom message types rendered as interactive cards (forms, options, toggles) that **update in place** when their state changes.
2. Multi-party rooms: people, several duos, mentions, replies, reactions, read state (Matrix).
3. Per-viewer visibility: owner-only cards inside a shared room.
4. Structural attribution: duo messages can't be styled as a person; no avatar slot for duos.
5. Draft-before-send with an offline rule: decisions never queue.
6. Streaming or progress updates on one message (task block) without new messages per step.
7. Keyboard map (⏎ / E / X / ⌘K / ⌘I / J K) and 44px touch targets.
8. Theming to the Hairline tokens; dark by default.
9. Desktop and phone (Tauri today).
10. Licence: no licence file for now (PRD v0.4); borrowed MIT code needs a third-party notices file, so copyleft clients are ruled out.

## 5. Open-source client options

Checked on 20 Oct 2026 via the GitHub API and each repo's README/LICENSE. "Effort" is my estimate, not a measured figure.

| Project | Licence | Activity | Matrix fit | Rich inline components | Effort |
|---|---|---|---|---|---|
| [Element Web](https://github.com/element-hq/element-web) | AGPL-3.0 or GPL-3.0, or paid Element commercial licence (README) | last push 19 Oct 2026 | Native, full-featured Matrix client | Has Matrix widgets; custom card types and owner-only cards inside its timeline would mean deep changes to a large codebase | L: big fork to maintain, copyleft obligations |
| [Cinny](https://github.com/cinnyapp/cinny) | AGPL-3.0 | last push 19 Oct 2026 | Native Matrix client, smaller and simpler than Element | No agent-card system; we would add custom event renderers | M–L: smaller fork, still copyleft |
| [assistant-ui](https://github.com/assistant-ui/assistant-ui) | MIT | last push 20 Oct 2026 | None built in; README says any custom runtime can replace the default, so a runtime over matrix-js-sdk is possible | Strong: README lists generative UI (tool calls rendered as React components) and inline human approvals | M: keep matrix-js-sdk, build a runtime adapter; multi-party rooms need our own message model on top of its user/assistant thread |
| [CopilotKit](https://github.com/CopilotKit/CopilotKit) | MIT | last push 20 Oct 2026 | None; built around its AG-UI protocol to an agent backend | Strong: generative UI and human-in-the-loop (README) | M–L: designed for an in-app copilot, not a messenger; would add a second protocol next to Matrix |
| [Vercel Chatbot](https://github.com/vercel/chatbot) | Apache-2.0 (LICENSE) | last push 8 Jul 2026 | None; Next.js app for one user and one model | Moderate, through the AI SDK | M–L: a template, not a messenger; less recent activity |
| [LibreChat](https://github.com/danny-avila/LibreChat) (now LibreChat-AI/LibreChat) | MIT | last push 20 Oct 2026 | None; ChatGPT-style app with its own auth and storage | Artifacts and agents, not our card types | L: a whole product with its own backend to bend |
| [Open WebUI](https://github.com/open-webui/open-webui) | Open WebUI License: BSD-3 plus a branding clause (branding must stay above 50 users in 30 days unless permission or an enterprise licence) | last push 19 Oct 2026 | None | Model-chat oriented | L, and the branding clause conflicts with shipping "duo" |

**Decision (PRD v0.4 D9, shin, 20 Oct 2026): keep Matrix and the current client, add interactive card messages, and borrow assistant-ui's MIT card components.** Staff Software Engineer Bot's scored comparison (*duo: Client build-vs-adopt comparison v0.1*, same Drive folder) put the current client at 85/100 and a thin assistant-ui client at 72. My check above reaches the same shortlist and the same rule-outs (AGPL for Element and Cinny, the branding clause for Open WebUI, no rooms or visitor flow for LibreChat, CopilotKit and Vercel Chatbot). Before v0.4 I leaned towards a thin client on assistant-ui. I agree with the decision: per the PRD, the current client already has rooms, @mentions, visitor states and a custom message type, and every card in this doc can land there unchanged.

Design consequence: each card in §3 is one message that the duo posts and then **edits in place** (same message, new state). It is never a new message per state.

## 6. Conflicts noticed between the PRD and the repo docs

1. **Avatar.** PRD v0.4 records shin's approval of a chosen avatar for desk duos (never a person's photo), and §7 still lists an avatar in the visitor's view of a personal duo. Hairline §3.5 and vocabulary rule 2: a duo has no avatar, only the mark. *Prototype:* personal duos show the mark only; desk duos get a chosen abstract avatar or upload, plus the mark and a tag. The repo docs need updating to match.
2. **Permission levels.** PRD D6: three columns (Answers on its own / Drafts for you / Never). vocabulary.md: three levels plus a non-level (Answers on its own / Drafts for you / **Always asks you**, and "Never on its own. You confirm each one." for T4). PRD's "Never" mixes never-answer rules with T4. *Prototype:* PRD columns, with T4 as a separate hatched row.
3. **Editing permissions.** PRD D6/S10: tap an item to move it. Hairline P4 and vocabulary "autonomy level": trust changes only by accepting an offer or a plain-words grant; no switch changes what the duo may do. *Prototype:* tap or words, always through a confirm card. Needs shin's call on promotions by tap.
4. **Tier codes.** The brief asks for T0–T4 on the card; vocabulary.md keeps T-codes out of default views. *Prototype:* hidden behind a "Tier codes" toggle.
5. **One duo per owner.** vocabulary.md "duo: one per owner" and the three fixed attributions ("Your duo", "{owner}'s duo", "the owner's duo") don't cover desk duos. D1 is decided, and the docs-only PR is pending. Desk-duo attribution wording is not yet defined.
6. **"Approval" vs "confirm".** The PRD says "approval card". vocabulary.md says the T4 verb is **confirm**, never "approve" (approve is for rules). *Prototype:* "Needs your confirm" and "Review and confirm…".
7. **Request button label.** The brief says "Always allow this person". vocabulary.md and the PRD say "Allow and always allow {name}". *Prototype:* the vocabulary wording.
8. **Client direction.** shin's steer said the client is not precious. PRD v0.4 D9 then decided to keep it and add cards. *Prototype:* follows D9.
9. **Orchestrator scope.** The brief lists the orchestrator room as core. PRD: v2. *Prototype:* marked v2.
10. **Draft placement (inside the repo docs).** vocabulary.md: drafts live in a draft tray above the composer, never in the transcript. design-language.md §6.2: inline at the end of the transcript, dashed. *Prototype:* inline, dashed (the newer text).
11. **Settings.** PRD Principle 1 makes settings read-only mirrors. Hairline §6.2 lists Settings as one of three places for changes (Ask links, End this duo). Needs reconciling.
12. **Desk-duo status.** The original brief said D1 was pending shin's yes/no. PRD v0.2 to v0.4 mark D1 **decided** (20 Oct 2026, up to 5). *Prototype:* shown as decided.
