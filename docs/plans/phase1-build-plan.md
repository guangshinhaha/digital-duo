# duo: Phase 1 build plan v0.1

**Date:** 20 Oct 2026 | **Status:** Plan only, for shin. No code changed, no branches, PRs or issues created. | **Repos read at `main`:** `guangshinhaha/digital-duo` (**DD**, git tree `74bf0657`, code-search ref `f75aec18`) and `guangshinhaha/duo` (**CL**, the client, git tree `dc7f7e6d`, code-search ref `8114d523`).
**Inputs:** "duo: Client build-vs-adopt comparison v0.1" (§7.1 card sketch, §8 phases, §9 risks), "duo: Interaction Model PRD v0.4" (Principle 1, D3, D5, D7, D9, stories S1 to S7), `/workspace/duo-doc-reversal.md` (§B).
**Audience:** Claude Opus files **one GitHub issue per user story** (dx-harness `dx-create-issue`). Claude Sonnet then builds the work items one at a time, in the order given in §6.
Anything I could not check in the code or docs is marked **[unverified]**.

---

## 0. How I read "Phase 1"

- The comparison doc (§8) numbers its six phases from **0**. Phase 0 is "Spec": the `duo.card` / `duo.card.response` schema, amending the `payload.ts` invariant (#186 AC5), the `/ws` events `task-updated` and `card-updated`, and the Task table and state machine (PRD D5). Its exit check is "Schema doc + test plan approved by shin".
- **Phase 1 is "Cards v1 (Part A core)"**, the first build phase that ships cards: the renderer registry; decision, task/progress, result and confirm cards; inline approval for T3/T4 on the owner channel; @mention/reply gating in `answerableQuestionFrom` (D3); and the instant ack. Its exit check is **"PRD S1–S7 pass in a two-person pilot room"**.
- **So this plan covers PRD stories S1 to S7.** Phase 0's spec work is folded in as the first work item under S4 (W-S4-1), because nothing can be built without it. §2 of this plan is the draft of that spec, and shin approving it closes Phase 0.
- The PRD's stories are written as Given/When/Then. There is no separate "acceptance criteria" list and no "Phase 1" label. I quote each story's Given/When/Then word for word as its acceptance criteria. Technical acceptance criteria follow under their own heading.
- **Cards in shin's approach that are *not* in Phase 1:** the **form** card and the **"desk duo created"** card. The comparison doc puts both in Phase 3 (S12/S13). The schema reserves those card kinds now so nothing has to be renamed later. No renderer or builder for them ships in Phase 1.
- **Reversal doc §B (one duo per owner):** none of it is in Phase 1. The comparison doc puts desk duos in Phase 3, so §B is noted under Out of scope.

---

## 1. Goal, scope, out of scope

**Goal.** A colleague who asks someone's duo in a two-person pilot room always knows what is happening. They get an instant answer, or a one-line ack with a live task card that updates in place, a decision card when the question is ambiguous, and "Needs {owner}'s OK" for T3/T4 requests. In group rooms the duo speaks only when @mentioned or replied to. The owner sees tasks and approves T3/T4 inline. Draft content never goes over Matrix.

**In scope (Phase 1).**
1. @mention/reply gating for shared rooms (S1). The 1:1 posture is kept and pinned by tests (S2).
2. The instant answer path is unchanged and protected by regression tests (S3).
3. The card protocol v1:
   - `duo.card` messages sent by the duo's own Matrix account and updated in place with `m.replace` edits
   - `duo.card.response` events sent by people
   - one whitelisted card builder in DD
   - a renderer registry in CL
4. The Task unit (PRD D5): a SQLite table, a state machine, an ack timer, milestones (at most 3), and a result card with links or files (S4, S5).
5. The decision card: 2 to 4 options, with `needs-decision` and resume (S6).
6. Inline approval for T3/T4. Visitors see "Needs {owner}'s OK" over Matrix. The owner's approval and confirm cards travel over daemon HTTP and `/ws` only (S7).
7. The owner channel:
   - `/ws` `task-updated` and `card-updated` signals
   - `GET /tasks`, `GET /cards`
   - `POST /cards/:id/respond`
   - HTTP routes for T3 pending actions, which do not exist today
8. A `THIRD_PARTY_NOTICES.md` in CL for any assistant-ui MIT code that is borrowed. Neither repo gets a LICENSE file.

**Out of scope (explicit).**
- Form card, "desk duo created" card, confirmation/result cards for creating or changing things (S10, S12, S13). These are Phase 3, and Phase 2 for S10.
- Reactions as feedback (S8), take-over and hand-back (S9), the permissions card (S10), owner away (S11). These are Phase 2.
- Desk duos and everything in reversal doc §B:
  - `already_has_duo` in DD `src/hosted/server.ts`
  - `tenantBySubject` in DD `src/hosted/registry.ts`
  - the `duoUserIdFor` bijection in DD `src/workspace/directory.ts` and CL `src/workspace/identity.ts`
  - and the rest of §B

  These are Phase 3. Orchestrator rooms and handoffs are Phase 4.
- Real T2 to T4 executors. Approving tells the visitor the owner will do it, and nothing executes (PRD §7 edge case).
- Model-composed arbitrary UI, assistant-ui's runtime, A2UI/MCP-UI schemas, Matrix widgets for Element.
- Streaming text into Matrix with edits (MSC4357). Streamed text stays on the owner's SSE (`POST /drafts/stream`).
- E2EE rooms. The DD adapter is "Plaintext only for v1" (`src/workspace/matrix-transport.ts` module comment, #191).
- A text-reply fallback for choosing on decision cards from non-duo clients (see Q5).

---

## 2. Card protocol v1 (draft spec; W-S4-1 turns this into `docs/workspace/cards.md` in DD)

### 2.1 Facts verified in the code that shape the design

| Fact | Where (verified) |
|---|---|
| DD sends only `{msgtype:"m.text", body}`. `buildAnswerEvent`, `buildFailedAnswerEvent` and `buildAttachmentRefusalEvent` are "the ONLY constructors of an outbound workspace payload" | DD `src/workspace/payload.ts`; type `AnswerEventContent` in `src/workspace/transport.ts`; pinned by `test/workspace-payload.test.ts` (POISON markers for draftId, logEntryId, topicId, ownerNotice, sourceId, evidence text, passphrase) |
| `sendAnswer(roomId, content): Promise<void>` returns no event id, so the daemon cannot edit what it sent | DD `transport.ts`; `matrix-transport.ts` calls `client.sendMessage(roomId, {msgtype: Text, body})` |
| The inbound adapter forwards only `m.room.message` events with msgtype `m.text`, and already folds `m.replace` edits to `m.new_content.body`. It reads no `m.mentions` and no reply relation | DD `matrix-transport.ts` `RoomEvent.Timeline` handler |
| `src/workspace/**` may not import `store`, `ingest`, `derivation`, `drafting`, `corrections` or `trust`. It may not open a network primitive or listener. Only `matrix-transport.ts` may import matrix-js-sdk | DD `test/workspace-payload.test.ts` "workspace egress surface" block |
| Injected owner-side state follows a pattern: the impl lives in `src/serve/` and is handed to `WorkspaceService` at wiring | DD `src/serve/workspace-wiring.ts` (`readState: durableDuoReadState(...)`, `answer: ...answerPublicly(...)`); `src/serve/workspace-read-state.ts` |
| `/ws` pushes only `ready`, `draft-ready {draftId}` and `draft-drafting {roomId}`. After auth the socket is server-push only | DD `src/serve/ws.ts` (`DraftReadyHub.publish`, `publishDrafting`); CL `src/api/ws.ts` `WsInbound` |
| `answerableQuestionFrom` has no mention or reply check. Shared rooms are gated only by the consent record | DD `src/workspace/questions.ts` |
| CL sends `m.mentions.user_ids` with every message it sends | CL `src/workspace/matrix.ts` `sendTrackedMessage` (~l.1708–1724) |
| **Poll precedent.** Polls go on the wire as MSC3381 `m.poll.start` events (not a custom `m.room.message` msgtype). The projection labels them with the internal msgtype `"duo.poll.start"` and attaches `RoomMessage.poll`. `Room.tsx` renders `<PollCard>` before any other branch. Untyped sends go through `sendUntypedEvent`. Responses are separate `m.poll.response` events that reference the start event, tallied in a later projection pass | CL `src/workspace/matrix.ts` l.36–51, ~1478, ~1779–1800, ~1946–1968, ~2124–2200; `src/components/PollCard.tsx`; `src/routes/Room.tsx` ~l.1367; test `test/RoomPollVoiceNote.test.tsx` |
| CL folds same-sender `m.replace` edits only when `newContent.msgtype === base.msgtype`. `isMainFlowRow` admits only text, file, image, audio and poll-start | CL `src/workspace/matrix.ts` ~l.1778–1800, ~1990–2020 |
| Duo messages render inside `RoomDuoMessage` → `DuoLine`, with no `avatar` or `authorName` prop. ESLint forbids person components inside duo components (AR-13) | CL `src/components/RoomDuoMessage.tsx`, `eslint.config.js` (`duoNeverPosesAsAPerson`) |
| CL derives visitor outcomes and the Waiting filter by parsing duo *text* | CL `src/workspace/duoAnswer.ts` (`readDuoAnswer`), `src/workspace/duoConversation.ts` (`questionOutcomes`), `src/shell/waiting.ts` |
| The org wall's `check_event_for_spam` inspects only join-rules, history/guest and `m.space.child` events. Everything else, custom events included, returns `NOT_SPAM` | DD `deploy/synapse/modules/duo_org_wall/module.py` l.172–189 |
| T3 pending actions (`pending_actions`, statuses `pending/approved/expired/retracted`) have **no HTTP route**, only CLI (`src/commands/actions.ts`). T4 has `GET /actions/t4/pending` and `POST /actions/t4/:id/confirm` | DD `src/actions/approvals.ts`, `src/actions/t4-guard.ts`, `src/serve/server.ts` route list |
| Requests are created only from the CLI and actions code (`createPendingAction` in `binding.ts`/`reversible.ts`, `createT4Request` in `reversible.ts`/`commands/actions.ts`). **Nothing turns a workspace message into an action request** | code search, DD |
| "Until that act, nothing about a draft transits the workspace" | DD `docs/workspace-platform.md` (also `docs/v1-tech-design.md`, `docs/workspace/org-read.md`) |

### 2.2 Event types and content (Matrix, visitor-visible)

**Card message.** Event type `m.room.message`, msgtype `duo.card`. Sent only by the duo's own account. The event name follows the comparison doc; see Q1 on namespacing.

```jsonc
{
  "msgtype": "duo.card",
  "body": "<plain-text fallback, see 2.5>",
  "m.mentions": {},                       // cards never ping; S6 may mention the requester (see W-S6-3)
  "duo.card": {
    "v": 1,                               // schema major version
    "rev": 3,                             // monotonically increasing per card; every edit bumps it
    "card_id": "c_01J…",                  // daemon-issued ULID, stable across edits
    "kind": "task" | "decision" | "result" | "confirm",   // Phase 1 kinds on Matrix
    "state": "acknowledged" | "working" | "needs_decision" | "done" | "failed"   // task
           | "open" | "chosen" | "expired",                                     // decision
    "task_id": "t_01J…",                  // optional; links cards of one task
    "requester": "@alice:server",         // the person this card answers; only they may respond
    "title": "Checking with Ana",         // ≤ 80 chars
    "lines": ["Passed to Ana. You'll get a reply here."],  // ≤ 3 lines, ≤ 200 chars each
    "options": [{ "id": "o1", "label": "The 2025 circular" }],      // decision only, 2–4
    "chosen": { "option_id": "o1", "by": "@alice:server" },         // decision, once chosen
    "milestones": [{ "state": "working", "label": "Ana is looking at it", "ts": 1760940000000 }], // ≤ 3
    "result": {                                                      // result / task done
      "text": "…asker-visible text…",
      "links": [{ "label": "Ana's reply", "url": "https://matrix.to/#/!room/$event" }],
      "files": [{ "name": "form.pdf", "mxc": "mxc://server/id", "mimetype": "application/pdf", "size": 12345 }]
    },
    "expires_ts": 1761000000000           // optional (decision)
  }
}
```

Reserved for later phases (the builder refuses them in Phase 1): `form`, `created` ("desk duo created"), `permissions`, `draft`, `approval`. `approval` and `draft` are **owner-only for ever** and must never be built for Matrix.

**Card response.** Event type `duo.card.response`. It is not an `m.room.message`, so other clients don't show it. Sent by a person's client.

```jsonc
{
  "m.relates_to": { "rel_type": "m.reference", "event_id": "$cardEventId" },
  "duo.card.response": { "v": 1, "card_id": "c_01J…", "action_id": "o1", "values": {} }
}
```

**Update in place.** Only the daemon changes a card. It sends a same-sender replacement:
`{ msgtype:"duo.card", body:"* <fallback>", "m.new_content": { msgtype:"duo.card", body:"<fallback>", "duo.card": {…full card, rev+1…} }, "m.relates_to": { rel_type:"m.replace", event_id:"$card" } }`.
- Every edit carries the **whole** card, never a delta.
- The client shows the replacement with the highest `rev` from the card's own sender. It breaks ties by `origin_server_ts`.
- A replacement from anyone else is ignored. This is the existing CL fold rule, extended.
- Clients never change card state themselves. A tap sends `duo.card.response`, and the daemon validates it and edits the card.

**Versioning.**
- `v` is the major version. Within v1, fields may be added, never removed or redefined.
- A client that sees an unknown `v` or `kind` renders the `body` fallback through the normal duo-text path.
- The daemon drops responses with an unknown `v`.
- `rev` orders edits.

**Anti-spoofing.**
- CL renders a card only when `isDuoUserId(sender)` (CL `src/workspace/identity.ts`). A `duo.card` from a person renders as plain text.
- DD acts on a response only when all of these hold:
  - it references a card event DD itself sent (lookup in `workspace_cards` by event id)
  - the card is open
  - `action_id` is one of the card's options
  - the sender equals the card's `requester` (or the owner, where the card allows that)
- Optional defence in depth: W-S4-11 has the Synapse org wall refuse `duo.card` msgtypes from non-`duo-` senders.

### 2.3 Which channel carries which card

| Card | Channel | Who sees it | Why |
|---|---|---|---|
| Task card (ack, milestones, done/failed) | Matrix `duo.card` | everyone in the room; only the requester can act | S4/S5: the visitor must see the chip |
| Decision card | Matrix `duo.card` | room; only the requester can choose | S6 |
| Result (task `done` with `result`) | Matrix `duo.card` edit | room | S5 |
| "Needs {owner}'s OK" (task in `needs_decision`, `lines` only) | Matrix `duo.card` | room | S7 |
| **Approval card** (T3/T4: action description, topic, reversibility, draft reply) | **daemon HTTP + `/ws` only** | owner devices only | contains owner-facing internals; drafts must never transit the workspace |
| **Confirm card** (T4 second step, "Review and confirm…") | **daemon HTTP + `/ws` only** | owner only | Phase 1 uses confirm only for T4 approval; the "confirm before create/change" use is Phase 2/3 |
| Owner's task view (draftId, confidence, gate reasons) | **daemon HTTP + `/ws` only** | owner only | the D5 owner task list |

Owner channel messages (DD `src/serve/ws.ts`, CL `src/api/ws.ts`), signals only, matching the `draft-ready` pattern:
- `{type:"task-updated", taskId, roomId, state}`
- `{type:"card-updated", cardId, roomId, audience:"owner"}`

The client then fetches `GET /tasks/:id` or `GET /cards/:id` over authenticated HTTP. Owner taps go to `POST /cards/:id/respond {actionId, values}`.

### 2.4 Task state machine (PRD D5)

`acknowledged → working → needs_decision → working → done | failed`. Also allowed:
- `acknowledged → done`, for an answer that arrives after the ack
- `acknowledged → needs_decision`
- any state → `failed`

Every transition is checked by a single pure function, and any other transition throws.
- Visitor-visible milestone edits: **at most one per state change, at most 3 in total per task**, not counting the final `done`/`failed`. Edits less than 10 s apart are coalesced. The ack threshold and the coalescing window can both be configured.
- Visitors see only their own tasks (cards carry `requester`, and only the requester can act). The owner sees all tasks.

### 2.5 Fallback `body` (what Element and other clients see)

- Task, `acknowledged` from a `passed_on` outcome: **exactly** today's asker text (`PUBLIC_PASSED_ON_MESSAGE` or the not-granted variant in DD `src/permissions/public-answer.ts`). A pre-card client sees exactly what it sees today.
- Task, `acknowledged` from the ack timer: "Looking into this — I'll update this message." (copy to be checked against CL `docs/vocabulary.md`)
- Task, `done`: the result text, followed by each link as `label: url`.
- Decision: "To answer, I need to know which you mean: A · B · C. Choose in the duo app." (see Q5)
- "Needs {owner}'s OK": "This needs {owner}'s OK before anything happens."
- Every fallback is built **only** from asker-visible strings that the existing projection already allows. The POISON test in `test/workspace-payload.test.ts` is extended to every card kind.

### 2.6 Privacy invariant, amended (#186 AC5)

The rule becomes: outbound workspace payloads are built only in `src/workspace/payload.ts` and `src/workspace/cards.ts`, and they carry only:
- asker-visible text (`outcome.text` / `outcome.message`)
- fixed copy
- option labels that pass the decision guard (W-S6-1)
- `matrix.to` permalinks into the same room
- `mxc://` references already shared in that room
- the requester's own user id

They never carry draftId, logEntryId, topicId, confidence, sources (ids **or labels**, as already pinned), evidence, rule text, ownerNotice or draft text.

---

## 3. Work items, grouped by user story

Sizes: **S** is half a day or less, **M** is about one day. Nothing is bigger than M, because anything larger was split.

---

### Story S1: @mention gating in group rooms

**Acceptance criteria (PRD v0.4, verbatim):**
> **S1 (v1, A) @mention gating in group rooms.** Given a duo is in an allowed group room. When a human posts without @mentioning the duo or replying to it. Then the duo does not respond or draft. When a human @mentions it or replies to its message. Then it responds as normal.

**Technical AC**
- [ ] The gate lives in `answerableQuestionFrom` (DD `src/workspace/questions.ts`) and runs before the dedupe mark and the answer chain. A non-addressed message never calls the pipeline, never opens the store, never fires `onDraftingStarted`/`draft-drafting`, and never writes read state.
- [ ] "Mentioned" means `m.mentions.user_ids` contains the duo's own user id. Fallback: `formatted_body` contains a `matrix.to` link to the duo's id (for clients without `m.mentions`).
- [ ] "Replied to" means one of:
  - `m.relates_to["m.in_reply_to"].event_id` points at an event whose sender is the duo
  - a thread (`rel_type: m.thread`) whose root's sender is the duo
- [ ] Direct rooms are unchanged (see S2). The duo↔duo loop guard still runs first.
- [ ] Consent still applies: an addressed message in a room without `allowed` consent is still not a question.

**W-S1-1 · DD · Surface mentions and reply targets on the candidate message (S)**
- Files: `src/workspace/transport.ts` (`WorkspaceCandidateMessage`: add `mentionedUserIds: readonly string[]`, `replyToSenderId: string | null`, `threadRootSenderId: string | null`), `src/workspace/matrix-transport.ts` (read `content["m.mentions"]`, the `formatted_body` matrix.to anchors, `m.relates_to`; resolve target senders through `room.findEventById`), `test/helpers/fake-workspace-transport.ts`.
- Build: normalise these facts in the adapter only. Leave the fields as `[]`/`null` when absent so the shape stays compatible with existing fakes.
- AC:
  - [ ] Fields are populated for live and sync-replayed events.
  - [ ] A reply target not on the loaded timeline gives `null` and does not throw.
  - [ ] The egress and import-boundary scans in `test/workspace-payload.test.ts` still pass.
- Tests: `test/workspace-matrix-transport.test.ts` (mentions via `m.mentions`; via the formatted_body anchor only; reply; thread root; unknown target).
- Depends on: none.

**W-S1-2 · DD · Gate shared-room questions on mention or reply (S)**
- Files: `src/workspace/questions.ts` (shared-room branch of `answerableQuestionFrom`), `test/workspace-questions.test.ts`, `test/workspace-service.test.ts`.
- Build: in the consented shared-room branch, return `null` unless the message is addressed (as defined above). Optionally strip a leading mention label from `body` before it reaches the pipeline. **[unverified]** exactly what text CL puts in `body` for a pill. Check `src/composer/serialize.ts` first.
- AC:
  - [ ] Group room, not addressed: `null`, and the fake pipeline call count is 0.
  - [ ] Mentioned: question returned.
  - [ ] Reply to a duo message: question returned.
  - [ ] Reply to a person's message: `null`.
  - [ ] Thread under a duo root: question returned.
  - [ ] A `refused`/`withdrawn` room is still `null` even when mentioned.
- Tests: the cases above, plus a service-level test that no `draft-drafting` publish happens for a non-addressed message.
- Depends on: W-S1-1.

**W-S1-3 · CL · Show the gating cue in group rooms (S)**
- Files: `src/routes/Room.tsx` (composer area), `src/components/Composer.tsx`, `test/composer.test.tsx` or `test/Workspace.test.tsx`, `test/Vocabulary.test.ts`.
- Build: when a group or channel room has a duo member (`isDuoUserId` over the members, as `Room.tsx` ~l.2142 already does), show a one-line hint: "{owner}'s duo answers only when you @mention it or reply to it." No hint in direct rooms.
- AC:
  - [ ] The hint appears only in group or channel rooms that contain a duo.
  - [ ] The copy passes `test/Vocabulary.test.ts`.
- Depends on: none (it can ship before W-S1-2).

---

### Story S2: 1:1 responds to everything

**Acceptance criteria (PRD v0.4, verbatim):**
> **S2 (v1, A) 1:1 responds to everything.** Given a visitor in an allowed 1:1 with a duo. When they send any message. Then the duo responds (answer, ack, or decline) without needing a mention.

**Technical AC**
- [ ] `directQuestionFrom` is unchanged. A direct room, including the duo#314 case where the owner was invited in, needs no mention.
- [ ] Every 1:1 question ends in exactly one of: an `m.text` answer, a task card (ack), or a decline/refusal `m.text`. Silence happens only under the existing documented policies (backlog age, rate bound, withdrawn consent).

**W-S2-1 · DD · Pin the 1:1 posture and the "always one outcome" rule (S)**
- Files: `test/workspace-questions.test.ts`, `test/workspace-service.test.ts`.
- Build: tests only. No change to `directQuestionFrom`.
- AC:
  - [ ] An unmentioned message in a direct room is a question.
  - [ ] The owner-invited direct room is still direct.
  - [ ] Across a table of `PublicAnswerOutcome` kinds, plus the slow path (after W-S4-5), exactly one outbound send or card happens per question.
- Depends on: W-S1-2. The ack row of the table depends on W-S4-5.

---

### Story S3: Instant answer

**Acceptance criteria (PRD v0.4, verbatim):**
> **S3 (v1, A) Instant answer.** Given the question is inside the trust grid and above the confidence gate. When the visitor asks. Then the duo answers in one message with sources, and "Why?" shows the reasoning.

**Technical AC**
- [ ] An `answered` outcome that resolves before the ack threshold produces **exactly one** `m.text` event and **no** task card.
- [ ] The answer text still carries its own citations and attribution (DD `public-answer.ts` composition is unchanged). CL `RoomDuoAnswer` still renders the sources, evidence age and trust line. **[unverified]** whether "Why?" for a *visitor* means anything beyond these lines. Today `WhyButton` is owner-side (see Q7).
- [ ] In group rooms the answer is sent as a reply (`m.in_reply_to` = the question), so a follow-up "reply to the duo" passes the S1 gate. This is a deliberate, tested widening of the payload shape.

**W-S3-1 · DD · Send answers in shared rooms as replies to the question (S)**
- Files: `src/workspace/payload.ts` (`buildAnswerEvent(outcome, { inReplyTo? })`), `src/workspace/transport.ts` (`AnswerEventContent` gets an optional `m.relates_to` with `m.in_reply_to` only), `src/workspace/matrix-transport.ts`, `src/workspace/service.ts` (`answerOrRefuse`/`handleQuestion` pass the event id for non-direct rooms), `test/workspace-payload.test.ts`.
- AC:
  - [ ] Direct-room answers stay byte-identical (two keys).
  - [ ] Shared-room answers have exactly three keys: `msgtype`, `body`, and `m.relates_to: {"m.in_reply_to": {event_id}}`.
  - [ ] The POISON tests pass for both.
- Depends on: W-S4-1 (the invariant amendment is approved).

**W-S3-2 · CL · Regression-pin the instant-answer render (S)**
- Files: `test/Workspace.test.tsx` or a new `test/RoomDuoAnswer.test.tsx`, `src/components/RoomDuoAnswer.tsx` (no change expected).
- AC:
  - [ ] A duo `m.text` answer with sources renders the `RoomDuoAnswer` composed answer with its sources and trust line.
  - [ ] A reply-shaped duo answer still renders as `RoomDuoAnswer`, not as plain words.
  - [ ] No card renders for an instant answer.
- Depends on: W-S3-1.

---

### Story S4: Ack plus task (also carries the Phase 0 spec and the card foundation)

**Acceptance criteria (PRD v0.4, verbatim):**
> **S4 (v1, A) Ack plus task.** Given the duo can't answer on its own. When the visitor asks. Then within a few seconds the visitor sees a one-line ack and a task chip in `acknowledged`, and the owner gets a task with a draft reply.

**Technical AC**
- [ ] A `passed_on` outcome creates a Task (`acknowledged`, `requester` = asker, `draft_id` = the outcome's draftId) and sends **one** `duo.card` (kind `task`) whose fallback `body` equals today's passed-on text.
- [ ] If the pipeline has not finished within `DUO_WORKSPACE_ACK_AFTER_MS` (default 2000, see Q2), a task card in `acknowledged` is sent first. The final outcome then **edits** that card instead of sending a second ack.
- [ ] The owner gets `/ws {type:"task-updated"}` and can `GET /tasks/:id`, which includes `draftId`. The existing `draft-ready` push still fires.
- [ ] No owner-only field reaches Matrix (extended POISON test).
- [ ] CL renders the task chip inside `RoomDuoMessage` (still no avatar, AR-13). It renders only for duo senders and falls back to text for an unknown `v` or `kind`.
- [ ] `THIRD_PARTY_NOTICES.md` exists in CL before any borrowed assistant-ui code is merged.

**W-S4-1 · DD (docs) · Card protocol spec, and the payload-invariant amendment (Phase 0 exit) (S)**
- Files: new `docs/workspace/cards.md`; a short dated amendment note in `docs/workspace-platform.md` §5 and in the `payload.ts` doc comment (comment only).
- Build: copy §2 of this plan into the doc, add a test plan (the tests named in this section), and the vocabulary list of card copy.
- AC:
  - [ ] The doc defines event types, fields, limits, versioning, edits, responses, anti-spoofing, channels, fallbacks and the state machine.
  - [ ] Every card string is listed and checked against CL `docs/vocabulary.md` ("desk duo" only; never employee, assistant, teammate, agent or bot).
  - [ ] **shin approves it.** This is the gate for every other W-S4 item.
- Depends on: none.

**W-S4-2 · DD · The whitelisted card builder (M)**
- Files: new `src/workspace/cards.ts` (types `DuoCardV1`, `buildCardEvent(card)`, `buildCardEdit(eventId, card)`, a zod schema with length/count limits, `fallbackBodyOf(card)`); `src/workspace/transport.ts` (an `OutboundWorkspaceContent` union of `AnswerEventContent` and the card content types); `test/workspace-payload.test.ts` (extended); new `test/workspace-cards.test.ts`.
- Build:
  - Input types take only asker-safe primitives: strings that came from `outcome.text`/`message`, fixed copy, option labels, permalinks, mxc refs and the requester id. They never take a `PublicAnswerOutcome` beyond those fields.
  - Phase 1 kinds are `task`, `decision`, `result`, `confirm`. **`confirm` on Matrix is refused**, because it is owner-only in Phase 1, so the builder accepts only `task`, `decision` and `result` for Matrix. Reserved kinds throw.
- AC:
  - [ ] Every builder output validates against the zod schema.
  - [ ] POISON markers planted in every owner-facing field never appear in any output (`JSON.stringify` scan).
  - [ ] Over-limit inputs are trimmed or rejected as the spec says.
  - [ ] An edit has `m.new_content` holding the full card with `rev`+1, plus `m.relates_to.rel_type = "m.replace"`.
  - [ ] The import-boundary scan still passes (`cards.ts` imports nothing forbidden; zod is allowed **[unverified: check that the scan does not ban it]**).
- Depends on: W-S4-1.

**W-S4-3 · DD · Transport: send and edit cards, receive responses (M)**
- Files: `src/workspace/transport.ts` (`sendAnswer` resolves `{eventId}`; add `sendCard(roomId, content): Promise<{eventId}>`, `editCard(roomId, eventId, content): Promise<void>`, `onCardResponse(handler)` with a `WorkspaceCardResponse {eventId, roomId, senderId, cardEventId, cardId, actionId, values, originServerTs}`), `src/workspace/matrix-transport.ts` (an untyped `sendEvent` for `duo.card.response`, mirroring CL's `sendUntypedEvent`; a timeline listener for `duo.card.response`), `test/helpers/fake-workspace-transport.ts`, `test/workspace-matrix-transport.test.ts`.
- AC:
  - [ ] Content passed to `sendCard`/`editCard` is exactly what the builders produced (the type allows nothing else).
  - [ ] Responses are delivered for live and replayed events, and malformed ones are dropped.
  - [ ] The duo's own echoes are ignored.
  - [ ] matrix-js-sdk is still imported only in `matrix-transport.ts`.
- Depends on: W-S4-2.

**W-S4-4 · DD · Task and card store, and the state machine (M)**
- Files: new `src/tasks/state.ts` (pure `transition(task, event)`), new `src/tasks/store.ts` (`ensureTasksSchema`; tables `tasks(id, room_id, question_event_id, requester, state, draft_id, pending_action_id, t4_request_id, milestone_count, created_at, updated_at)` and `workspace_cards(id, task_id, room_id, event_id, kind, audience, rev, state, payload_json, requester, created_at, updated_at)`), new `src/serve/workspace-tasks.ts` (the implementation injected into the service, like `workspace-read-state.ts`), plus an interface `WorkspaceTaskSink` in `src/workspace/service.ts` options. Pattern to copy: `ensurePendingActionsSchema` in `src/actions/approvals.ts`, and `withDatabase` in `src/store/store.ts`.
- AC:
  - [ ] Every allowed transition succeeds and every other one throws.
  - [ ] `milestone_count` never goes above 3.
  - [ ] Card `rev` increases monotonically.
  - [ ] The store lives in the encrypted store (no plaintext file).
  - [ ] `src/workspace` reaches the store only through the injected interface (the boundary scan passes).
- Tests: new `test/tasks-state.test.ts`, `test/tasks-store.test.ts`.
- Depends on: W-S4-1.

**W-S4-5 · DD · Ack timer and passed-on task in the workspace service (M)**
- Files: `src/workspace/service.ts` (`handleQuestion`, `answerOrRefuse`), `src/workspace/settings.ts` (`ackAfterMs`, env `DUO_WORKSPACE_ACK_AFTER_MS`), `src/serve/workspace-wiring.ts` (inject the task sink), `test/workspace-service.test.ts`, `test/workspace-settings.test.ts`.
- Build: start a timer when the answer chain picks up the question.
  - When the timer fires first: create the Task and send the `acknowledged` card.
  - When the outcome arrives:
    - `answered`: send the `m.text` answer (W-S3-1 shape). If a card exists, edit it to `done` with a `result` link to the answer's permalink.
    - `passed_on`: create the Task if it doesn't exist yet, and send or edit the card to `acknowledged` with the passed-on text.
    - `declined_refused`: send the decline `m.text`. If a card exists, edit it to `done` with lines "Declined".
    - Pipeline failure: edit to `failed`, or send the failure text.

  The existing withdrawn-consent, rate-bound and read-state rules are kept for card sends too.
- AC:
  - [ ] A fast answer sends 0 cards.
  - [ ] A slow answer sends 1 card and then 1 edit.
  - [ ] A fast passed-on sends 1 card.
  - [ ] A slow passed-on sends 1 card and then 1 edit.
  - [ ] The ack is sent within `ackAfterMs` + 500 ms, tested with fake timers.
  - [ ] With consent withdrawn mid-draft, neither a card nor an edit is sent.
  - [ ] A failed send forgets the event id, as `sendAnswer` does today.
- Depends on: W-S4-3, W-S4-4, W-S3-1.

**W-S4-6 · DD · Owner channel: `/ws` task and card signals, and the task routes (S)**
- Files: `src/serve/ws.ts` (`DraftReadyHub` gains `publishTask(taskId, roomId, state)` and `publishCard(cardId, roomId)`), `src/serve/server.ts` (wiring), new `src/serve/task-routes.ts` (`GET /tasks?state=`, `GET /tasks/:id`, `GET /cards/:id`, `GET /cards?roomId=&audience=owner`), `test/serve-ws.test.ts`, new `test/serve-task-routes.test.ts`.
- AC:
  - [ ] Signals carry ids and state only, never content.
  - [ ] Routes require the device-token bearer auth (`registerAuth`); an ask token is refused.
  - [ ] `GET /tasks/:id` returns `draftId` for the owner.
  - [ ] Revoked devices stop receiving signals (the existing re-verify path).
- Depends on: W-S4-4.

**W-S4-7 · CL · Project `duo.card` in the Matrix seam (M)**
- Files: `src/workspace/matrix.ts`:
  - `RoomMessage.card?: DuoCardView`
  - `isMainFlowRow` admits `msgtype === "duo.card"`
  - the base pass parses `content["duo.card"]` only when `isDuoUserId(sender)`; otherwise the event becomes a text row with `body`
  - the replace fold picks the highest `rev` from the same sender
  - a new `sendCardResponse(roomId, cardEventId, cardId, actionId, values)` through `sendUntypedEvent`, widening its doc comment from "exactly the three poll event types" to include `duo.card.response`
  - `duo.card.response` events are never main-flow rows

  Also `test/WorkspaceMatrixSeam.test.ts`.
- AC:
  - [ ] A duo card projects to `card` with the latest-rev state.
  - [ ] A person-sent `duo.card` projects as plain text.
  - [ ] A stranger's replace is ignored.
  - [ ] An unknown `v` gives a text row with the fallback body.
  - [ ] Responses never appear as rows.
  - [ ] Poll behaviour is unchanged (`test/RoomPollVoiceNote.test.tsx` still passes).
- Depends on: W-S4-1.

**W-S4-8 · CL · Card renderer registry, task chip, and NOTICES (M)**
- Files: new `src/components/cards/registry.tsx` (`kind → component`; an unknown kind renders `null` so the caller falls back to text), new `src/components/cards/CardFrame.tsx`, new `src/components/cards/TaskCard.tsx` (state chip, title, ≤3 lines, milestones), `src/routes/Room.tsx` (a `message.card !== undefined` branch beside the `message.poll` branch at ~l.1367, inside `RoomDuoMessage`), `src/styles/tokens.css` (if needed), new `THIRD_PARTY_NOTICES.md` (repo root: for each borrowed file, the upstream repo, path, commit SHA, and the MIT text "Copyright (c) 2026 AgentbaseAI Inc." as it appears in assistant-ui's LICENSE today; re-check it at the commit you copy from), new `test/Cards.test.tsx`, `test/Vocabulary.test.ts`, `test/DesignSystem.test.tsx` (if it enumerates components).
- Build: borrow assistant-ui's *patterns* only: a registry keyed by part type, and the approval-card state model (request → running → done / denied / expired). If any of its MIT props-only component source is copied, keep the copied files under `src/components/cards/vendor/`, each with a header comment naming its origin. No `@assistant-ui/*` runtime dependency.
- AC:
  - [ ] The task chip renders each state with text, not colour alone (accessibility).
  - [ ] It renders inside `RoomDuoMessage`, with no avatar prop and the ESLint rule passing.
  - [ ] The registry has no entry for reserved kinds.
  - [ ] `THIRD_PARTY_NOTICES.md` is present and lists every vendored file (empty list plus a header if nothing was copied).
  - [ ] No LICENSE file is added.
  - [ ] `package.json` gains no `@assistant-ui` dependency.
- Depends on: W-S4-7.

**W-S4-9 · CL · Owner task signals, task query, and the owner chip (S)**
- Files: `src/api/ws.ts` (`WsInbound` adds `task-updated` and `card-updated`, which invalidate `["tasks"]` and `["cards"]`), `src/api/types.ts`, `src/api/queries.ts` (`useTasks`, `useTask`, `useOwnerCards(roomId)`), `src/components/RoomDrafts.tsx` (an owner-only "Task · acknowledged" line beside the draft, linking to it), `mock/daemon.mjs`, `mock/ws.mjs`, `test/ws.test.tsx`, `test/WorkspaceDrafts.test.tsx`, `test/mockDaemon.test.mjs`.
- AC:
  - [ ] Receiving `task-updated` refetches the tasks.
  - [ ] The owner sees the task next to its draft.
  - [ ] A visitor (non-owner session) never calls the task routes.
  - [ ] The mock daemon serves the new routes and signals.
- Depends on: W-S4-6.

**W-S4-10 · CL · Keep visitor outcomes and the Waiting filter correct with task cards (S)**
- Files: `src/workspace/duoConversation.ts` (`questionOutcomes`: a duo task card answering a question maps `acknowledged/working/needs_decision` → `passed-on` and `done` → `answered` or `replied`), `src/shell/waiting.ts` (if it reads outcomes), `test/DuoConversation.test.tsx`, `test/waiting.test.tsx`.
- AC:
  - [ ] An outcome that was text before and is now a card reads the same in the banner and the Waiting filter.
  - [ ] Existing text-only fixtures are unchanged.
- Depends on: W-S4-7.

**W-S4-11 · DD (Synapse module, optional) · Refuse person-sent `duo.card` (S)**
- Files: `deploy/synapse/modules/duo_org_wall/rules.py` (`may_send_message(sender, event_type, content)`: refuse `m.room.message` with `msgtype == "duo.card"` unless the localpart starts with `duo-`, using the existing `_LOCALPART` grammar), `module.py` (`check_event_for_spam` branch), `deploy/synapse/modules/duo_org_wall/tests/test_rules.py`, `tests/test_module.py`, `test/synapse-org-wall.test.ts` (if it drives the module).
- AC:
  - [ ] A person's `duo.card` is refused with a fixed sentence.
  - [ ] A duo's card passes.
  - [ ] All other events still return `NOT_SPAM` with no extra state reads.
- Depends on: W-S4-1. Optional: client-side rendering rules already defeat spoofing in duo's own client.

---

### Story S5: Milestones, not play-by-play

**Acceptance criteria (PRD v0.4, verbatim):**
> **S5 (v1, A) Milestones, not play-by-play.** Given a task is open. When it changes state. Then the visitor sees at most one short update per state change, and the final result includes links or files rather than "see the doc".

**Technical AC**
- [ ] Each state change makes at most **one** edit to the task card. At most 3 milestone edits per task, not counting the final edit. Edits less than 10 s apart are coalesced. All three rules are enforced in `src/tasks/` and tested.
- [ ] Owner actions drive milestones:
  - opening or editing the task's draft: `working` ("{owner} is looking at it")
  - `POST /drafts/:id/outcome` with the owner's reply delivered: `done`, with a result link to the owner's message permalink
  - dismissing the draft: `done` ("{owner} closed this")
- [ ] A `result` must have at least 1 link or file, unless its text is the full answer. If the result text contains a vague pointer ("see the doc", "see attached", "check the link") with no link or file, the builder refuses it and sends the owner a notice instead.
- [ ] Links are only `matrix.to` permalinks into the same room, or `http(s)` URLs already present in the asker-visible text. Files are only mxc refs already shared in that room. Source labels and ids are never used (pinned).

**W-S5-1 · DD · Milestone driver on owner actions (M)**
- Files: new `src/tasks/milestones.ts` (throttle and coalesce, apply transition, build edit), `src/serve/server.ts` (the `POST /drafts/:id/outcome` and draft open/answer routes call the task service when the draft has a task), `src/serve/workspace-tasks.ts`, `src/workspace/service.ts` (exposes `editTaskCard(taskId, card)` over the live transport), new `test/tasks-milestones.test.ts`, `test/serve-owner-routes.test.ts` or `test/draft-delivery.test.ts`.
- AC:
  - [ ] The three owner actions produce the specified states.
  - [ ] A burst of 5 changes produces ≤ 3 visitor edits (fake timers).
  - [ ] With the workspace disconnected, edits are retried on reconnect, or the card is left at its last state, with an owner-side log line.
  - [ ] Every edit also publishes `task-updated`.
- Depends on: W-S4-5, W-S4-6. **[unverified]** whether "draft opened" is observable server-side today. If it isn't, drop that milestone.

**W-S5-2 · DD · Result payload builder and the vague-pointer guard (S)**
- Files: `src/workspace/cards.ts` (`buildResult({text, links, files})`), `test/workspace-cards.test.ts`.
- AC:
  - [ ] Only allowed link and file sources are accepted, and others are dropped.
  - [ ] A vague pointer with no link or file throws `VaguePointerError`.
  - [ ] The POISON scan passes.
- Depends on: W-S4-2.

**W-S5-3 · CL · Result card and milestone rendering (S)**
- Files: new `src/components/cards/ResultCard.tsx`, `src/components/cards/TaskCard.tsx` (milestone list), `src/workspace/links.ts` (reuse its link handling), `test/Cards.test.tsx`.
- AC:
  - [ ] Links open through the existing link handling.
  - [ ] Files render through `SharedFileCard`'s media loading (authenticated media).
  - [ ] At most 3 milestone lines show.
  - [ ] The `done` and `failed` states are visually distinct and labelled in text.
- Depends on: W-S4-8.

---

### Story S6: Decision card

**Acceptance criteria (PRD v0.4, verbatim):**
> **S6 (v1, A) Decision card.** Given the question is ambiguous. When the duo needs a choice. Then it shows 2–4 tappable options, the task moves to `needs-decision`, and tapping one resumes the task.

**Technical AC**
- [ ] The decision card is sent over Matrix with 2 to 4 options, each label ≤ 80 chars. Option labels come only from the asker's own question and from topic names the asker may already see **[open: Q4]**, never from evidence text (POISON-pinned).
- [ ] Only the card's `requester` can choose. Others see the card read-only with "Only {name} can choose". The first valid response wins. The daemon edits the card to `chosen` with "Chosen by {name}". Later responses are ignored.
- [ ] Choosing moves the task `needs_decision → working`. It re-runs the same `answerPublicly` pipeline with the question disambiguated by the chosen label, and ends in `done` (answer) or stays open (passed on).
- [ ] An unanswered decision card expires after 24 h (configurable): the card goes to `expired` and the task is passed to the owner.
- [ ] On the ask-link page (`POST /ask`, no Matrix), the same outcome falls back to text listing the options.

**W-S6-1 · DD · Ambiguity check producing options (M)**
- Files: new `src/drafting/clarify.ts` (one inference call: `{ambiguous: boolean, options: string[2..4]}` from the question and the allowed topic names, with output length/count validation), `src/drafting/pipeline.ts` or `src/permissions/public-answer.ts` (call it only when the pipeline would otherwise pass on for low confidence; **[unverified]** where the low-confidence branch is cleanest to hook. Read `public-answer.ts` around l.250–320), new `test/drafting-clarify.test.ts` (with `test/fixtures/fake-provider.ts`).
- AC:
  - [ ] Ambiguous: 2 to 4 options.
  - [ ] Not ambiguous: the existing path is unchanged.
  - [ ] Evidence text planted in context never appears in the options.
  - [ ] A provider error falls back to the existing passed-on path.
- Depends on: none (pure drafting), but it ships behind W-S6-2.

**W-S6-2 · DD · `needs_choice` outcome plumbing (M)**
- Files: `src/permissions/public-answer.ts` (new outcome `{kind:"needs_choice", options, message, draftId}`), `src/workspace/service.ts` (sends the decision card and sets the task to `needs_decision`), `src/serve/server.ts` (`POST /ask` text fallback), `test/public-answer.test.ts`, `test/ask.test.ts`, `test/workspace-service.test.ts`, `test/workspace-payload.test.ts`.
- AC:
  - [ ] `needs_choice` produces exactly one decision card in the workspace, and text on `/ask`.
  - [ ] The `draftId` and options provenance stay owner-side.
  - [ ] All existing outcome tests pass unchanged.
- Depends on: W-S6-1, W-S4-5.

**W-S6-3 · DD · Handle decision responses and resume the task (M)**
- Files: `src/workspace/service.ts` (`onCardResponse` handler on the serialized chain; validates that the card is ours and open, the sender is the requester, the action id is valid and it is not expired; edits the card; re-runs `answer` with `body + "\n\n(Meaning: <label>)"`), `src/tasks/store.ts`, `src/workspace/settings.ts` (`decisionExpiryMs`), `test/workspace-service.test.ts`.
- AC:
  - [ ] A valid tap edits the card to `chosen`, sets the task to `working` and then `done`, and sends the answer `m.text` (as a reply).
  - [ ] A non-requester tap does nothing (owner-side log).
  - [ ] When two taps race, the first wins.
  - [ ] A replayed response after restart is idempotent (card already `chosen`).
  - [ ] Expiry sets the card to `expired` and passes the task to the owner, with `draft-ready`.
- Depends on: W-S6-2, W-S4-3.

**W-S6-4 · CL · Decision card renderer and tap (M)**
- Files: new `src/components/cards/DecisionCard.tsx` (assistant-ui option/approval pattern; 2 to 4 buttons; pending state while the response is in flight; chosen and expired states), `src/components/cards/registry.tsx`, `src/routes/Room.tsx` (pass `selfUserId` and `onCardAction` like `onVotePoll`), `src/workspace/matrix.ts` (`sendCardResponse`, already added in W-S4-7), `test/Cards.test.tsx`, `test/Accessibility.test.tsx`.
- Build: a response is **not** queued in the offline outbox. When offline, the buttons are disabled with "You're offline".
- AC:
  - [ ] The requester sees enabled buttons and others see read-only text.
  - [ ] A tap sends exactly one `duo.card.response`, and the UI waits for the daemon's edit (no optimistic state change).
  - [ ] Keyboard and screen-reader labels work.
  - [ ] The copy passes the vocabulary test.
- Depends on: W-S4-8.

---

### Story S7: Inline approval

**Acceptance criteria (PRD v0.4, verbatim):**
> **S7 (v1, A) Inline approval.** Given a visitor asks the duo to do something at tier T3/T4. When the duo receives it. Then the owner sees an approval card inline in the chat, the visitor sees "Needs {owner}'s OK", and nothing happens without approval.

**Technical AC**
- [ ] A workspace question that matches a **registered** action (DD `src/actions/registry.ts`) at tier T3 creates a `pending_actions` row. One at T4 creates a `pending_t4_requests` row. T0 to T2 matches keep the existing question path in Phase 1.
- [ ] The task goes to `needs_decision`. The visitor's card shows "This needs {owner}'s OK before anything happens." The approval card (action description, topic, reversibility, the visitor's words) is **owner-only**: `/ws card-updated` plus `GET /cards/:id`, rendered inline in the room through the `RoomDrafts` slot. It is never sent as a Matrix event.
- [ ] Approve (T3) calls `approvePendingAction` with the existing no-op execute. T4 requires the confirm card's second step, then `confirmAndExecuteT4Request` (same `confirmedBy` semantics as `POST /actions/t4/:id/confirm`). Deny sets a new `denied` status.
- [ ] After a decision, the visitor's card is edited to `done`: "{owner} approved this and will take it from here." / "{owner} didn't approve this." No executor runs (PRD §7).
- [ ] An expired request makes the card `failed` ("This request expired").

**W-S7-1 · DD · HTTP routes for T3 pending actions (S)**
- Files: `src/actions/approvals.ts` (add `"denied"` to `PENDING_ACTION_STATUSES` and a `denyPendingAction`), new routes in `src/serve/server.ts` or `src/serve/owner-routes.ts` (`GET /actions/pending`, `POST /actions/pending/:id/approve`, `POST /actions/pending/:id/deny`), `test/binding.test.ts` / new `test/serve-pending-actions.test.ts`.
- AC:
  - [ ] Routes are owner-auth only.
  - [ ] The not_found, not_pending and expired errors match `ApprovePendingActionResult`.
  - [ ] Deny is idempotent.
  - [ ] The CLI behaviour (`src/commands/actions.ts`) is unchanged.
- Depends on: none.

**W-S7-2 · DD · Match workspace questions to registered actions (M)**
- Files: new `src/actions/request-intent.ts` (given the question text and the registered actions list, return `{actionId} | null` using one inference call, with a strict confidence threshold; an empty registry short-circuits to `null`), new `test/action-request-intent.test.ts`.
- AC:
  - [ ] With an empty registry there is no inference call.
  - [ ] A clear request returns the action id.
  - [ ] An ordinary question returns `null`.
  - [ ] The model output is validated against registered ids only.
- Depends on: none. **[unverified]** whether any actions are registered in the pilot duo. If none are, S7 cannot be demonstrated without seeding one (see Q3).

**W-S7-3 · DD · Wire action requests into the task, card and approval flow (M)**
- Files: `src/serve/workspace-wiring.ts` (run the intent check before `answerPublicly` and create the pending request through `createPendingAction`/`createT4Request`), `src/workspace/service.ts` (new answer-pipeline result `needs_approval`; sends the visitor card), `src/serve/task-routes.ts` (`POST /cards/:id/respond` for owner approval and confirm cards; on resolve, edits the visitor card), `src/serve/ws.ts` (`publishCard`), `test/workspace-service.test.ts`, `test/serve-task-routes.test.ts`, `test/t4-guard.test.ts`.
- AC:
  - [ ] T3 request: visitor card in `needs_decision`, owner `card-updated`, and nothing executes until approve.
  - [ ] T4 request: approve without the confirm step is refused (400).
  - [ ] Approve or deny edits the visitor card once.
  - [ ] The owner-only card payload never reaches the transport (assert the fake transport's sent payloads).
  - [ ] `src/workspace` still does not import `src/actions` (it goes through the injected pipeline).
- Depends on: W-S7-1, W-S7-2, W-S4-5, W-S4-6.

**W-S7-4 · CL · Owner approval and confirm cards inline in the room (M)**
- Files: new `src/components/cards/ApprovalCard.tsx` and `src/components/cards/ConfirmCard.tsx` (reuse the copy and the AlertDialog "Review and confirm…" behaviour from `src/routes/Confirmations.tsx`), `src/components/RoomDrafts.tsx` (renders `useOwnerCards(roomId)`), `src/api/queries.ts` (respond mutation), `src/components/useDraftDecision.ts` (if shared), `test/Confirmations.test.tsx`, `test/Cards.test.tsx`.
- AC:
  - [ ] Only owner sessions render these cards.
  - [ ] T4 needs the second confirm step.
  - [ ] One action can be in flight at a time ("one at a time", as in `Confirmations.tsx`).
  - [ ] When asleep or offline, the card shows the existing honest reasons (`Confirmations.tsx` l.22–27).
  - [ ] The visitor's Matrix card updates after the daemon's edit (integration test with the mock daemon).
- Depends on: W-S4-9, W-S7-3.

---

## 4. Risks (short)

| Risk | Mitigation |
|---|---|
| **Privacy invariant regresses**: a card carries corpus, sources or draft text | There is one builder (`cards.ts`) whose inputs take only asker-safe primitives. The POISON tests are extended to every kind. Owner cards are never built for Matrix. **Top risk.** |
| Decision options leak what the corpus contains ("2025 vs 2026 circular" reveals that both exist) | Options come from the question and from allowed topic names only; see Q4 |
| Action-intent false positives turn questions into approval requests | Strict threshold. Registered actions only. An empty registry short-circuits |
| Edit volume and Synapse rate limits **[unverified limits]** | Edits are throttled (at most 3 milestones, 10 s coalescing). No text streaming over Matrix |
| Spoofed cards | CL renders cards only from duo ids. DD validates the responder. Synapse guard optional (W-S4-11) |
| Element and other clients see "* …" edit fallbacks | Accepted for the pilot. Fallback bodies are written to read sensibly |
| Hosted multi-tenant `/ws` and task routes behave differently **[unverified: `src/hosted/server.ts` wiring of `createServer` per tenant not read]** | Check before W-S4-6 merges |
| Scope creep into Phase 2/3 cards | Reserved kinds are refused by the builder and have no renderer |

## 5. Open questions for shin

1. **Event names.** Keep `duo.card` / `duo.card.response` as the comparison doc proposes, or use a reverse-DNS namespace (e.g. `sg.gov.duo.card`) as Matrix recommends for custom types? Default: keep `duo.card` (federation is off).
2. **Ack threshold.** Is 2 s right for "within a few seconds"? Should a fast passed-on still always show the task chip? The plan says yes.
3. **S7 demo.** Are any actions registered in the pilot duo? If not, may we seed one T3 and one T4 sample action for the pilot?
4. **Decision options.** May they name topic labels the asker could see, or only rephrase the asker's own words?
5. **Non-duo clients.** Is "Choose in the duo app" acceptable for decision cards, or do you want a text-reply fallback ("reply 1 or 2") in Phase 1?
6. **Group rooms.** Only the asker may choose on a decision card. Confirm?
7. **"Why?" for visitors** (S3). Do the existing sources, evidence-age and trust lines in `RoomDuoAnswer` count, or should a visitor-side Why? be added?

## 5a. Resolved open questions

Decided by the Principal Product Manager on 20 Oct 2026. These answers supersede the defaults and options in §5.

1. **Event names.** Keep the event types `duo.card` and `duo.card.response`, defined in ONE constant. No `sg.gov` (reverse-DNS) namespace.
2. **Ack threshold.** 2 s (`DUO_WORKSPACE_ACK_AFTER_MS` default 2000). A fast passed-on request still shows the task chip.
3. **S7 demo.** Seed one T3 and one T4 SAMPLE action on the pilot duo, clearly labelled as samples. Nothing executes.
4. **Decision options.** Options only rephrase the asker's own words. They never name topic labels.
5. **Non-duo clients.** No "reply 1 or 2" text fallback in Phase 1. The decision card's fallback is "Choose in the duo app" only.
6. **Group rooms.** Only the asker can choose on a decision card. Everyone else sees it read-only.
7. **"Why?" for visitors** (S3). No new visitor "Why?" button. The existing sources, evidence-age and trust lines in `RoomDuoAnswer` satisfy S3.

## 6. Implementation order (for Sonnet), with sizes

1. W-S4-1 spec (S). **shin approves**
2. W-S1-1 (S), W-S1-2 (S), W-S1-3 (S), W-S2-1 (S, partly)
3. W-S4-2 (M), W-S4-4 (M), W-S4-7 (M)
4. W-S4-3 (M), W-S3-1 (S), W-S4-6 (S), W-S4-8 (M)
5. W-S4-5 (M), W-S3-2 (S), W-S4-9 (S), W-S4-10 (S), W-S2-1 (finish)
6. W-S5-2 (S), W-S5-1 (M), W-S5-3 (S)
7. W-S6-1 (M), W-S6-2 (M), W-S6-3 (M), W-S6-4 (M)
8. W-S7-1 (S), W-S7-2 (M), W-S7-3 (M), W-S7-4 (M)
9. Optional: W-S4-11 (S)

**Totals:** 28 work items (27 required, plus 1 optional, W-S4-11) across 7 stories:

| Story | Items |
|---|---|
| S1 | 3 |
| S2 | 1 |
| S3 | 2 |
| S4 | 11 (incl. the optional W-S4-11) |
| S5 | 3 |
| S6 | 4 |
| S7 | 4 |

The 27 required items are 13 S and 14 M, roughly 20 developer-days. That fits the comparison doc's "~2–3 weeks" only if nothing slips. The exit check is: S1 to S7 pass in a two-person pilot room.

*Plan only. No code changed, no PRs, no issues, not shared.*
