# The card protocol (v1)

Phase 0 exit for the interaction-model PRD v0.4, Phase 1 (`docs/plans/phase1-build-plan.md` §2,
work item W-S4-1). This is the schema every other Phase 1 work item builds against — nothing
else in S4, S5, S6 or S7 starts until this doc is in place. **shin approves it**; that approval
is the Phase 0 exit gate. Work continues against this draft in the meantime, since the only
thing the approval gates is whether the shape stays as written here.

## 1. Why a card, and why not stream text

The workspace adapter sends only `{msgtype: "m.text", body}` today
(`src/workspace/payload.ts`, `buildAnswerEvent`/`buildFailedAnswerEvent`/
`buildAttachmentRefusalEvent` — "the ONLY constructors of an outbound workspace payload",
pinned by `test/workspace-payload.test.ts`). A duo that cannot answer at once needs to tell the
visitor it is working and later update that in place, without turning into a chat transcript of
play-by-play. A card is a single Matrix message the daemon owns and edits; nothing else changes
it.

Two things stay as they are and are not reopened here:
- Streamed text (MSC4357-shaped edits of ordinary text) stays off Matrix. Streaming stays on the
  owner's SSE (`POST /drafts/stream`).
- Draft content, evidence, and anything else listed in `docs/workspace-platform.md` §5 as
  forbidden to the workspace store never crosses into a card. §9 below amends that section's
  text to say so explicitly.

## 2. Event types and content (Matrix, visitor-visible)

**Card message.** Event type `m.room.message`, msgtype `duo.card`. Sent only by the duo's own
Matrix account. Both `duo.card` and `duo.card.response` (below) are defined once, in one
constant, each — no reverse-DNS namespace (resolved question Q1, Phase 1 build plan §5a).

```jsonc
{
  "msgtype": "duo.card",
  "body": "<plain-text fallback, see §5>",
  "m.mentions": {},                       // cards never ping; S6 may mention the requester (W-S6-3)
  "duo.card": {
    "v": 1,                               // schema major version
    "rev": 3,                             // monotonically increasing per card; every edit bumps it
    "card_id": "c_01J…",                  // daemon-issued ULID, stable across edits
    "kind": "task" | "decision" | "result" | "confirm",   // DuoCardV1's Phase 1 kinds; the
                                                           // Matrix builder accepts only task,
                                                           // decision and result — it refuses
                                                           // confirm (owner-only, §7)
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

Reserved for later phases — the builder refuses them in Phase 1: `form`, `created` ("desk duo
created"), `permissions`, `draft`, `approval`. **`approval` and `draft` are owner-only for ever**
and must never be built for Matrix, in any phase.

**Card response.** Event type `duo.card.response`. It is not an `m.room.message`, so other
clients do not render it as a message row. Sent by a person's client.

```jsonc
{
  "m.relates_to": { "rel_type": "m.reference", "event_id": "$cardEventId" },
  "duo.card.response": { "v": 1, "card_id": "c_01J…", "action_id": "o1", "values": {} }
}
```

## 3. Edits (update in place)

Only the daemon changes a card, and it does so with a same-sender replacement:

```jsonc
{
  "msgtype": "duo.card",
  "body": "* <fallback>",
  "m.new_content": { "msgtype": "duo.card", "body": "<fallback>", "duo.card": { /* full card, rev+1 */ } },
  "m.relates_to": { "rel_type": "m.replace", "event_id": "$card" }
}
```

- Every edit carries the **whole** card, never a delta.
- The client shows the replacement with the highest `rev` from the card's own sender. It breaks
  ties by `origin_server_ts`.
- A replacement from anyone else is ignored — the existing CL fold rule (`src/workspace/matrix.ts`,
  same-sender `m.replace` fold), extended to the card msgtype.
- Clients never change card state themselves. A tap sends `duo.card.response`; the daemon
  validates it and edits the card. There is no optimistic client-side state change.

## 4. Versioning

- `v` is the major version. Within v1, fields may be added, never removed or redefined.
- A client that sees an unknown `v` or `kind` renders the `body` fallback through the normal
  duo-text path — never a broken card.
- The daemon drops responses carrying an unknown `v`.
- `rev` orders edits within one card; it is never reset.

## 5. Fallback `body` (what Element and other clients see)

Every fallback is built **only** from asker-visible strings the existing projection already
allows (§6). Copy below is checked against CL `docs/vocabulary.md`: no "employee", "assistant",
"teammate", "staff", "chatbot", "intern", "agent", "bot" or "hire" anywhere in a card string.

| Card / state | Fallback `body` |
|---|---|
| Task, `acknowledged` from a `passed_on` outcome | exactly today's asker text (`PUBLIC_PASSED_ON_MESSAGE` or the not-granted variant, `src/permissions/public-answer.ts`) — a pre-card client sees exactly what it sees today |
| Task, `acknowledged` from the ack timer | "Looking into this — I'll update this message." |
| Task, `done` | the result text, followed by each link as `label: url` |
| Decision, `open` | "To answer, I need to know which you mean: A · B · C. Choose in the duo app." (resolved Q5: no text-reply fallback in Phase 1) |
| Task, `needs_decision` (T3/T4 approval pending) | "This needs {owner}'s OK before anything happens." |
| Decision, `chosen` | "Chosen by {name}." |
| Decision, `expired` | "This request expired." |

## 6. Anti-spoofing

- CL renders a card only when `isDuoUserId(sender)` (`src/workspace/identity.ts`). A `duo.card`
  sent by a person renders as plain text, never as a card.
- The daemon acts on a `duo.card.response` only when **all** of these hold:
  - it references a card event the daemon itself sent (lookup in `workspace_cards` by event id)
  - the card is still open
  - `action_id` is one of that card's options
  - the sender equals the card's `requester` (or the owner, where the card explicitly allows that)
- Optional defence in depth (W-S4-11): the Synapse org wall refuses `duo.card` msgtypes from any
  sender whose localpart does not start with `duo-`.

## 7. Which channel carries which card

| Card | Channel | Who sees it | Why |
|---|---|---|---|
| Task card (ack, milestones, done/failed) | Matrix `duo.card` | everyone in the room; only the requester can act | S4/S5: the visitor must see the chip |
| Decision card | Matrix `duo.card` | room; only the requester can choose | S6 |
| Result (task `done` with `result`) | Matrix `duo.card` edit | room | S5 |
| "Needs {owner}'s OK" (task in `needs_decision`, `lines` only) | Matrix `duo.card` | room | S7 |
| **Approval card** (T3/T4: action description, topic, reversibility, draft reply) | **daemon HTTP + `/ws` only** | owner devices only | contains owner-facing internals; drafts must never transit the workspace |
| **Confirm card** (T4 second step, "Review and confirm…") | **daemon HTTP + `/ws` only** | owner only | Phase 1 uses confirm only for T4 approval |
| Owner's task view (draftId, confidence, gate reasons) | **daemon HTTP + `/ws` only** | owner only | the D5 owner task list |

Owner channel signals (`src/serve/ws.ts`, CL `src/api/ws.ts`) carry ids and state only, matching
the existing `draft-ready` pattern — never content:
- `{type:"task-updated", taskId, roomId, state}`
- `{type:"card-updated", cardId, roomId, audience:"owner"}`

The client fetches `GET /tasks/:id` or `GET /cards/:id` over authenticated HTTP. Owner taps go to
`POST /cards/:id/respond {actionId, values}`.

**Offline behaviour (design rule, Interaction Flows §3 / F2):** Send, Confirm and Create are
disabled when offline. They are never queued for later delivery.

## 8. Task state machine (PRD D5)

`acknowledged → working → needs_decision → working → done | failed`. Also allowed:
- `acknowledged → done` — an answer that arrives after the ack
- `acknowledged → needs_decision`
- any state → `failed`

Every transition is checked by a single pure function (`src/tasks/state.ts`, W-S4-4); any other
transition throws.

- Visitor-visible milestone edits: **at most one per state change, at most 3 in total per task**,
  not counting the final `done`/`failed`. Edits less than 10 s apart are coalesced. The ack
  threshold is `DUO_WORKSPACE_ACK_AFTER_MS`, default 2000 ms (resolved Q2); the coalescing window
  is configured alongside it.
- Visitors see only their own tasks (cards carry `requester`, and only the requester can act).
  The owner sees all tasks.

## 9. The privacy invariant, amended (#186 AC5)

The rule in `src/workspace/payload.ts` becomes: outbound workspace payloads are built only in
`src/workspace/payload.ts` and `src/workspace/cards.ts`, and they carry only:
- asker-visible text (`outcome.text` / `outcome.message`)
- fixed copy (this doc, §5)
- option labels that pass the decision guard (W-S6-1) — they rephrase the asker's own words only,
  never a topic label or evidence text (resolved Q4)
- `matrix.to` permalinks into the same room
- `mxc://` references already shared in that room
- the requester's own user id

They never carry draftId, logEntryId, topicId, confidence, sources (ids **or** labels, as already
pinned), evidence, rule text, ownerNotice or draft text. §6 of `docs/workspace-platform.md`
carries the short amendment note; see also the doc comment in `src/workspace/payload.ts`.

## 10. Test plan

Extends the existing egress and import-boundary scans rather than replacing them.

| Area | Test file | What it pins |
|---|---|---|
| Builder output shape and limits | `test/workspace-cards.test.ts` (new) | every builder output validates against the zod schema; over-limit inputs trimmed/rejected; reserved kinds throw |
| Privacy invariant, extended | `test/workspace-payload.test.ts` | POISON markers planted in every owner-facing field never appear in any card output, for every card kind; the workspace egress/import-boundary scan still passes with `cards.ts` added |
| Transport send/edit/response | `test/workspace-matrix-transport.test.ts` | `sendCard`/`editCard` content matches exactly what the builder produced; responses delivered for live and replayed events; malformed responses dropped; the duo's own echoes ignored |
| Task + card store, state machine | `test/tasks-state.test.ts`, `test/tasks-store.test.ts` (new) | every allowed transition succeeds, every other one throws; `milestone_count` never exceeds 3; `rev` strictly increases; store lives in the encrypted store |
| Ack timer, outcome → card mapping | `test/workspace-service.test.ts`, `test/workspace-settings.test.ts` | fast vs. slow answer/passed-on card counts; ack timing with fake timers; withdrawn consent sends nothing |
| Owner channel | `test/serve-ws.test.ts`, `test/serve-task-routes.test.ts` (new) | signals carry ids/state only; routes are device-token owner auth only; revoked devices stop receiving signals |
| CL Matrix seam | `test/WorkspaceMatrixSeam.test.ts` (new) | card projection, person-sent spoof rejected as text, stranger's replace ignored, unknown `v` falls back, poll behaviour unchanged |
| CL rendering | `test/Cards.test.tsx` (new), `test/Vocabulary.test.ts` | task/decision/result chip rendering, state in text not colour alone, no avatar prop (AR-13), every card string passes the vocabulary check |
| Optional: org wall | `deploy/synapse/modules/duo_org_wall/tests/test_rules.py` | person-sent `duo.card` refused; duo-sent passes; all other events unaffected (W-S4-11) |

## 11. Card copy vocabulary check

Every fixed string in §5 and every error sentence this spec introduces was checked against CL
`docs/vocabulary.md`'s three rules: never "employee", "assistant", "teammate", "staff",
"chatbot", "intern", "agent" or "bot"; always attributed; always labelled. None of the strings in
this doc name the duo as anything but "it" or imply the owner is speaking — every card is
visibly the duo's own message (sent by the duo's own account, never the owner's).

"Desk duo" only (no new usage here) follows the same vocabulary; Phase 1 cards do not mention
desk duos at all (the `created` kind is reserved, unbuilt, see §2).
