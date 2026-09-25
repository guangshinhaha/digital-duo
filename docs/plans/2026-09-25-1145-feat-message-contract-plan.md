---
title: "The message/event contract our side - Plan"
type: feat
date: 2026-09-25
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# The message/event contract our side - Plan (#189)

## Goal Capsule

- **Objective:** Ship the typed message/event contract the client repo and the daemon build against (conversations, messages, membership, read state, ordering/paging), the one parsing layer that wraps Matrix wire shapes into it, and the daemon-side durable read state #219 deferred here (dedupe across restarts + backlog age/rate policy). No message store is written — Matrix remains the store (platform record §1).
- **Means:** A new `src/workspace/messages.ts` (contract types + parsing + ordering/paging, fixture-tested), a new `src/workspace/read-state.ts` (policy + injected persistence interface), a new `src/serve/workspace-read-state.ts` (the SQLite-through-`withDatabase` implementation, outside the import-scanned boundary), and additive seam/settings changes to carry `origin_server_ts` and the backlog knobs.
- **Authority hierarchy:** issue #189's ACs; `docs/workspace-platform.md` (MERGED) — "Do not write a message store", §6 duo identity is structural; PR #219's successor notes (in-process 10k FIFO dedupe, at-least-once send-failure forget, durable read state + backlog policy land here).
- **Stop conditions:** all ACs mapped to tests; full suite + typecheck green under pinned Node 22.22.3; the workspace egress/import scans stay green and unweakened.
- **Territory:** `src/workspace/questions.ts` + new files are primary; `asker.ts`/`settings.ts`/transport-seam edits strictly additive (sibling #187 chain works concurrently); the SQLite impl lives in `src/serve/` precisely because the pinned scan forbids `src/workspace/**` importing `../store/` — the store arrives by injection, the same discipline the answer pipeline uses.

---

## Key Decisions

- **Contract, not store.** The deliverable is the typed surface (`Conversation`, `Message`, `MessageAuthor`…) plus one parsing layer from realistic Matrix sync JSON. Matrix/Synapse keeps conversations, messages, membership, receipts, ordering, paging as library capability (record §1); we own only the vocabulary.
- **Duo authorship is structural.** `MessageAuthor = PersonAuthor | DuoAuthor`, disjoint discriminated kinds derived from the authoring Matrix user id (`@duo-<owner>:server` localpart convention, record §6). No flag on a person, no owner reference on a duo message. The daemon side gets the matching guard: another duo's message is never a question (`directQuestionFrom`), closing the duo-to-duo loop #219 flagged.
- **Durable read state by injection.** `DuoReadState` (`hasRead`/`markRead`) is defined in `src/workspace/read-state.ts`; the encrypted-store implementation (`workspace_read_events` table via `withDatabase`) lives in `src/serve/workspace-read-state.ts` because the pinned import scan forbids `src/workspace/**` reaching into `../store/`. `runServe` wires it; the service takes it optionally so existing tests (no store) keep today's behavior.
- **At-least-once stays.** The durable row is written **after** a successful send (and immediately for policy-skipped events), so a crash mid-draft re-answers on restart (replay) rather than permanently suppressing a question; a crash after send-before-record can double-answer — the same at-least-once stance #219 documented, now surviving restarts. Send-failure still forgets the in-process mark; the durable row was never written.
- **Backlog policy = age window + rate bound, both knobs.** `DUO_WORKSPACE_BACKLOG_MAX_AGE_MS` (default 3,600,000 = 1h): a question event older than the window is marked read, never answered — no zombie answers to last night's messages on wake. `DUO_WORKSPACE_MAX_ANSWERS_PER_MINUTE` (default 30, sliding 60s window counted at send): a flood — replayed or live — cannot pin the answering pipeline (an LLM draft per question); excess events are marked read and logged owner-side. The table prunes rows older than the age window: beyond it the age policy is the protection, so the durable memory spans exactly the window it needs.
- **Ordering stated, paging pure.** Total order = `(sentAt, id)` — the homeserver's `origin_server_ts` with the event id breaking exact-millisecond ties; paging is backwards, cursor = an event id, exclusive; `pageMessages` returns the `limit` messages strictly below the cursor, oldest→newest, with `hasMoreBefore`. Written in the module doc so the client repo builds on stated behavior.
- **Conversation kinds from stated rules.** `channel` = `m.room.create` `content.type === "m.channel"` (our org-homeserver convention, federation off); else `direct` = exactly two joined members (the same definition `directQuestionFrom` uses); else `group`. `is_direct` is deliberately not trusted over membership — membership is the truth a client can verify.
- **v1 parsing scope.** `m.room.message`/`m.text` bodies, `m.replace` edits (folded into the original, orphan replacements render standalone), `m.thread` parents (rich-reply `m.in_reply_to` is not a thread parent), `m.receipt` `m.read` read positions, membership state, room name. Redactions, files (#190), E2EE (#191), invite/leave rooms (#192) are out of scope and said so.
- **All store-touching work is serialized on the answering chain.** Durable checks/marks run inside `answerChain`, never in `receive()` — the encrypted store's decrypt-to-temp-file dance (`duo.db.rw-tmp`) is not re-entrant, and a timeline event arriving mid-draft must not open the store concurrently with the pipeline.

## Requirements (AC → tests)

- **R1 conversations as objects:** `conversationsFromSync` over a realistic two-room sync fixture returns direct + channel + group conversations with membership; a duo member appears alongside people with a distinct author kind.
- **R2 messages first-class:** `messagesFromTimeline` returns messages with author (person vs duo, unambiguous), body, time, edit state (folded `m.replace`), and thread parent (`m.thread`).
- **R3 read state per person per conversation:** `Conversation.readPositions` from `m.receipt` events, latest per user.
- **R4 ordering/paging stable:** `compareMessages` totality/stability; `pageMessages` walks a long conversation without drops or duplicates.
- **R5 duo authorship structural:** kind derives from user id; serialized authors carry exactly `kind`+`userId`; a duo message cannot render as its owner; another duo's direct message is not a question (loop guard).
- **R6 durable read state:** restart (fresh service, same store) does not re-answer an event the previous process answered; policy-skipped events are marked; send-failure is not recorded and re-answers on replay; `runServe` end-to-end restart test.
- **R7 backlog policy:** stale events skipped + marked + logged; flood beyond the rate bound skipped + marked; knobs validated (positive; count a positive integer) with sane defaults; everything documented in code docs + PR body.

## Files

- New: `src/workspace/messages.ts`, `src/workspace/read-state.ts`, `src/serve/workspace-read-state.ts`, `test/workspace-messages.test.ts`, `test/workspace-read-state.test.ts`.
- Edited (additive): `src/workspace/transport.ts` (+`originServerTs`), `src/workspace/matrix-transport.ts` (populate it), `src/workspace/questions.ts` (duo-sender guard), `src/workspace/settings.ts` (+backlog knobs + validation), `src/workspace/service.ts` (serialized durable path + policy), `src/config.ts` (+2 env knobs), `src/commands/serve.ts` (wire `readState`), plus mechanical fixture updates in the four affected workspace tests and the serve test.
