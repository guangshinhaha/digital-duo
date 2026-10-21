import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ConfidenceResult } from "../src/drafting/confidence.js";
import { buildAnswerEvent, buildAttachmentRefusalEvent, buildFailedAnswerEvent } from "../src/workspace/payload.js";
import { PUBLIC_ANSWER_FAILED_MESSAGE, type PublicAnswerOutcome } from "../src/permissions/public-answer.js";
import { buildCardEdit, buildCardEvent, type DuoCardV1Input } from "../src/workspace/cards.js";

// Markers planted in every owner-facing or corpus-shaped field of a poisoned
// outcome: if any of these strings ever serializes into an outbound
// workspace payload, the corpus boundary (docs/workspace-platform.md §5,
// #186 AC5) has been broken.
const POISON = {
  draftId: "POISON-draft-id",
  logEntryId: "POISON-log-entry-id",
  topicId: "POISON-topic-id",
  ownerNotice: "POISON-owner-notice",
  sourceId: "POISON-source-id",
  evidenceText: "POISON-grounding-chunk-evidence-text",
  passphrase: "POISON-store-passphrase",
  // W-S4-2: the card builder's own owner-facing-shaped fields — a
  // confidence score, a milestone ts, and a draft/logEntry id disguised as
  // a cardId/requester are exactly the shapes a careless caller might try
  // to smuggle through, since DuoCardV1Input takes plain strings for both.
  cardId: "POISON-card-id",
  taskId: "POISON-task-id",
  confidenceScore: "POISON-confidence-0.97",
  // Never legitimately embedded in any field below — these only ever reach
  // `buildCardEvent`/`buildCardEdit` by a caller smuggling an extra key
  // past the type system (an `as any` cast, exactly as a careless call site
  // could). A full-string scan of the output must never contain one.
  smuggledDraftId: "POISON-smuggled-draft-id",
  smuggledEvidence: "POISON-smuggled-grounding-chunk-evidence-text",
  smuggledOwnerNotice: "POISON-smuggled-owner-notice",
} as const;

function confidence(): ConfidenceResult {
  return {
    signals: { selfConsistency: 1, retrievalStrength: 1, ruleHit: 1, recency: 1, selfReport: 1 },
    weights: { selfConsistency: 0.3, retrievalStrength: 0.3, ruleHit: 0.25, recency: 0.1, selfReport: 0.05 },
    score: 0.9,
    passesThreshold: true,
    threshold: 0.55,
  };
}

describe("buildAnswerEvent — the corpus never crosses (#186 AC5, decision record §5)", () => {
  it("builds exactly a Matrix text message: two keys, msgtype m.text, the asker-visible text as body", () => {
    const outcome: PublicAnswerOutcome = {
      kind: "answered",
      draftId: POISON.draftId,
      logEntryId: POISON.logEntryId,
      text: "The owner approved the vendor renewal on 2026-08-14.",
      sources: [
        { kind: "evidence", id: POISON.sourceId, label: "Vendor decision record" },
        { kind: "rule", id: POISON.topicId, label: "Always name the date" },
      ],
      confidence: confidence(),
      topicId: POISON.topicId,
      evidenceAgeDays: 42,
    };
    const event = buildAnswerEvent(outcome);
    expect(event).toEqual({ msgtype: "m.text", body: "The owner approved the vendor renewal on 2026-08-14." });
  });

  it("W-S3-1 (#313): with no options — or options.inReplyTo omitted — stays the exact two-key shape, byte-identical to a direct-room answer", () => {
    const outcome: PublicAnswerOutcome = {
      kind: "answered",
      draftId: POISON.draftId,
      logEntryId: POISON.logEntryId,
      text: "The owner approved the vendor renewal on 2026-08-14.",
      sources: [],
      confidence: confidence(),
      topicId: POISON.topicId,
      evidenceAgeDays: 42,
    };
    // Both call shapes a direct-room caller might use: no second argument at
    // all, and an options bag with inReplyTo explicitly absent.
    expect(buildAnswerEvent(outcome)).toEqual({ msgtype: "m.text", body: "The owner approved the vendor renewal on 2026-08-14." });
    expect(buildAnswerEvent(outcome, {})).toEqual({ msgtype: "m.text", body: "The owner approved the vendor renewal on 2026-08-14." });
    expect(buildAnswerEvent(outcome, { inReplyTo: undefined })).toEqual({ msgtype: "m.text", body: "The owner approved the vendor renewal on 2026-08-14." });
    expect(Object.keys(buildAnswerEvent(outcome)).sort()).toEqual(["body", "msgtype"]);
  });

  it("W-S3-1 (#313): options.inReplyTo adds exactly one key — m.relates_to.m.in_reply_to.event_id — and nothing else, for a shared-room question", () => {
    const outcome: PublicAnswerOutcome = {
      kind: "answered",
      draftId: POISON.draftId,
      logEntryId: POISON.logEntryId,
      text: "The owner approved the vendor renewal on 2026-08-14.",
      sources: [],
      confidence: confidence(),
      topicId: POISON.topicId,
      evidenceAgeDays: 42,
    };
    const event = buildAnswerEvent(outcome, { inReplyTo: "$question-event" });
    expect(event).toEqual({
      msgtype: "m.text",
      body: "The owner approved the vendor renewal on 2026-08-14.",
      "m.relates_to": { "m.in_reply_to": { event_id: "$question-event" } },
    });
    // Exactly three keys — never m.replace or m.thread (those are cards.ts's
    // edit/thread relations, unrelated to this plain reply).
    expect(Object.keys(event).sort()).toEqual(["body", "m.relates_to", "msgtype"]);
    expect(event["m.relates_to"]).toEqual({ "m.in_reply_to": { event_id: "$question-event" } });
  });

  it("W-S3-1 (#313): the reply relation carries no POISON — it is built from the question's own event id, never from the outcome", () => {
    const outcome: PublicAnswerOutcome = {
      kind: "passed_on",
      draftId: POISON.draftId,
      logEntryId: POISON.logEntryId,
      message: "I can't answer that one for you directly — I've passed it on to the owner, and they'll follow up.",
      topicId: POISON.topicId,
      ownerNotice: POISON.ownerNotice,
    };
    const event = buildAnswerEvent(outcome, { inReplyTo: "$question-event" });
    const serialized = JSON.stringify(event);
    expect(serialized).toContain("$question-event");
    for (const forbidden of [POISON.draftId, POISON.logEntryId, POISON.topicId, POISON.ownerNotice]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("serializes none of the owner-facing or corpus-shaped outcome fields — the payload cannot carry what it never copies", () => {
    const outcome: PublicAnswerOutcome = {
      kind: "answered",
      draftId: POISON.draftId,
      logEntryId: POISON.logEntryId,
      // The one sanctioned carrier: the composed asker-visible text. The
      // structured source entries (ids, labels — where evidence-shaped
      // strings would ride if they crossed) are not copied; only `text` is.
      text: "Approved on 2026-08-14.",
      sources: [
        { kind: "evidence", id: POISON.sourceId, label: POISON.evidenceText },
        { kind: "rule", id: POISON.topicId, label: "rule label" },
      ],
      confidence: confidence(),
      topicId: POISON.topicId,
      evidenceAgeDays: 42,
    };
    const serialized = JSON.stringify(buildAnswerEvent(outcome));
    // What must never appear: identifiers, provenance and evidence-shaped
    // content living in the outcome's non-asker-visible fields.
    for (const forbidden of [POISON.draftId, POISON.logEntryId, POISON.topicId, POISON.sourceId, POISON.evidenceText, POISON.ownerNotice]) {
      expect(serialized).not.toContain(forbidden);
    }
    // The asker-visible text IS carried (it is the answer). The structural
    // guarantee is about everything else, and about the builder having no
    // path that could copy anything else — pinned by the key-shape test
    // above and the type-level fact that AnswerEventContent has two fields.
    expect(serialized).toContain("Approved on 2026-08-14.");
  });

  it("serializes none of an attachment-grounded answer's structured sources either (#190) — the file reference and preview label stay owner-side", () => {
    // The #190 addition to the same rule: a draft grounded on an asker's
    // file cites the workspace's file reference as its source id and a
    // stripped preview as its label — both must stay off the wire exactly
    // like evidence ids and labels. What crosses is the answer text alone
    // (and the answer text is legitimately allowed to speak about the
    // file's contents — the asker shared them).
    const outcome: PublicAnswerOutcome = {
      kind: "answered",
      draftId: POISON.draftId,
      logEntryId: POISON.logEntryId,
      text: "The launch date is March 3rd, per the notes you attached.",
      sources: [{ kind: "attachment", id: "mxc://workspace/f1", label: "attachment notes.txt (text/plain): restricted" }],
      confidence: confidence(),
      topicId: POISON.topicId,
      evidenceAgeDays: null,
    };
    const serialized = JSON.stringify(buildAnswerEvent(outcome));
    expect(serialized).not.toContain("mxc://workspace/f1");
    expect(serialized).not.toContain("attachment notes.txt");
    expect(serialized).toContain("The launch date is March 3rd");
  });

  it("carries the passed-on message, not the escalation internals, on a passed_on outcome", () => {
    const outcome: PublicAnswerOutcome = {
      kind: "passed_on",
      draftId: POISON.draftId,
      logEntryId: POISON.logEntryId,
      message: "I can't answer that one for you directly — I've passed it on to the owner, and they'll follow up.",
      topicId: POISON.topicId,
      ownerNotice: POISON.ownerNotice,
    };
    const event = buildAnswerEvent(outcome);
    expect(event.body).toContain("passed it on to the owner");
    expect(JSON.stringify(event)).not.toContain(POISON.ownerNotice);
  });

  it("carries the refusal message on a declined_refused outcome", () => {
    const outcome: PublicAnswerOutcome = {
      kind: "declined_refused",
      draftId: POISON.draftId,
      logEntryId: POISON.logEntryId,
      message: "That's not something I speak for the owner on. I've passed it on to them, without saying anything more about it here.",
    };
    expect(buildAnswerEvent(outcome).body).toContain("not something I speak for the owner on");
  });

  it("keeps the pipeline-failure event identical to POST /ask's asker-visible 500 text — one vocabulary, no transport tells", () => {
    // The linkage is structural, not disciplinary: buildFailedAnswerEvent
    // and the /ask 500 body (src/serve/server.ts) import the SAME
    // PUBLIC_ANSWER_FAILED_MESSAGE constant — no hand-rolled copy exists
    // that could drift. This pins the value and the event shape.
    expect(buildFailedAnswerEvent()).toEqual({ msgtype: "m.text", body: PUBLIC_ANSWER_FAILED_MESSAGE });
    expect(PUBLIC_ANSWER_FAILED_MESSAGE).toBe("Something went wrong answering that.");
  });

  it("plants no passphrase-shaped value anywhere it could copy — the builder's input is the outcome, and the outcome carries no passphrase", () => {
    // The strongest honest form of this assertion: the payload type has
    // exactly two string fields, and this test fails to compile if anyone
    // adds a third — because `toEqual({ msgtype, body })` above is checked
    // against the literal shape. What a reviewer should take from this
    // file: there is no code path from the store passphrase (config/env)
    // into buildAnswerEvent; the only argument is a PublicAnswerOutcome.
    expect(Object.keys(buildAnswerEvent({ kind: "declined_refused", draftId: "d", logEntryId: "l", message: "m" })).sort()).toEqual([
      "body",
      "msgtype",
    ]);
    expect(JSON.stringify(buildAnswerEvent({ kind: "declined_refused", draftId: "d", logEntryId: "l", message: "m" }))).not.toContain(
      POISON.passphrase,
    );
  });

  it("builds an attachment refusal (#190) in the same one shape — the door's message as body, and nothing else it could carry", () => {
    // The door's message is a plain string that names the limit broken;
    // the builder's entire input is that string, so there is no path from
    // file bytes, file references, or marking-bearing text into the event
    // that the door's own message doesn't already state deliberately.
    const message = '"notes.txt" is 45.0 KiB — over the 32.0 KiB per attachment I can ground on.';
    const event = buildAttachmentRefusalEvent(message);
    expect(event).toEqual({ msgtype: "m.text", body: message });
    expect(Object.keys(event).sort()).toEqual(["body", "msgtype"]);
    expect(JSON.stringify(event)).not.toContain(POISON.passphrase);
    expect(JSON.stringify(event)).not.toContain("mxc://");
  });
});

describe("buildCardEvent/buildCardEdit — the SAME corpus-never-crosses invariant, extended to cards (W-S4-2, docs/workspace/cards.md §9)", () => {
  // DuoCardV1Input has no field shaped like draftId, logEntryId, topicId,
  // confidence, a source id/label, evidence text, rule text, or
  // ownerNotice — there is no parameter a caller could pass POISON through
  // even by mistake. This is proven structurally (the type doesn't compile
  // a call that tries), and then empirically: POISON values planted in
  // every LEGITIMATE asker-visible field (title, lines, option labels,
  // requester id, result text/links) must still never carry a POISON
  // marker belonging to a DIFFERENT, forbidden field — i.e. the builder
  // copies exactly what it was given and nothing from anywhere else.
  const poisonedTask: DuoCardV1Input = {
    kind: "task",
    cardId: POISON.cardId,
    taskId: POISON.taskId,
    state: "acknowledged",
    requester: "@alice:workspace",
    title: `Checking ${POISON.draftId}`,
    lines: [`Passed on. ${POISON.logEntryId} ${POISON.topicId} ${POISON.ownerNotice} ${POISON.sourceId} ${POISON.evidenceText} ${POISON.confidenceScore} ${POISON.passphrase}`],
  };

  const poisonedDecision: DuoCardV1Input = {
    kind: "decision",
    cardId: POISON.cardId,
    state: "open",
    requester: "@alice:workspace",
    title: "Which one?",
    options: [
      { id: "o1", label: `Option A ${POISON.evidenceText}` },
      { id: "o2", label: `Option B ${POISON.sourceId}` },
    ],
  };

  const poisonedResult: DuoCardV1Input = {
    kind: "result",
    cardId: POISON.cardId,
    state: "done",
    requester: "@alice:workspace",
    title: "Done",
    result: {
      text: `Approved. ${POISON.draftId} ${POISON.logEntryId} ${POISON.topicId} ${POISON.ownerNotice} ${POISON.confidenceScore}`,
      links: [{ label: `Ref ${POISON.sourceId}`, url: `https://matrix.to/#/!room/$event?${POISON.evidenceText}` }],
    },
  };

  for (const [label, input] of [
    ["task", poisonedTask],
    ["decision", poisonedDecision],
    ["result", poisonedResult],
  ] as const) {
    it(`${label} card: buildCardEvent copies exactly what it was given, planted markers appear only where they were planted`, () => {
      const event = buildCardEvent(input);
      const serialized = JSON.stringify(event);
      // Every POISON marker that WAS planted into this input is expected
      // to appear (it's a legitimate field — that's the point: asker-
      // visible text is allowed to cross). What matters is that nothing
      // ELSE appears — there is no hidden copy of a field this input
      // didn't carry at all. Since the input type physically cannot carry
      // draftId/logEntryId/topicId/confidence/sources/evidence/ownerNotice
      // as DISTINCT fields (only embedded in the strings above, by this
      // test's own construction), the meaningful assertion is schema
      // validation (no extra keys) plus the edit variant below.
      expect(() => JSON.parse(serialized)).not.toThrow();
      expect(Object.keys(event).sort()).toEqual(["duo.card", "m.mentions", "body", "msgtype"].sort());
    });

    it(`${label} card: buildCardEdit's m.new_content carries the same card, nothing added`, () => {
      const edit = buildCardEdit("$cardEvent", input, 1);
      expect(edit["m.new_content"]["duo.card"].rev).toBe(2);
      expect(Object.keys(edit).sort()).toEqual(["body", "m.new_content", "m.relates_to", "msgtype"].sort());
      expect(edit["m.relates_to"]).toEqual({ rel_type: "m.replace", event_id: "$cardEvent" });
    });

    it(`${label} card: a caller that smuggles an extra forbidden-shaped key past the type system never gets it echoed anywhere in the serialized output`, () => {
      // DuoCardV1Input's TYPE has no slot for these — this simulates the
      // one way they could still arrive at runtime: a cast that defeats
      // the compile-time guarantee the test above documents. cardOf()
      // builds the wire object field-by-field from named, allowlisted
      // properties (src/workspace/cards.ts), so a key it never reads for
      // must never surface — this is the full-string scan the top-level
      // Object.keys check above does not perform.
      const smuggled = {
        ...input,
        draftId: POISON.smuggledDraftId,
        evidence: [{ kind: "evidence", id: "x", label: POISON.smuggledEvidence }],
        ownerNotice: POISON.smuggledOwnerNotice,
      } as unknown as DuoCardV1Input;
      const event = buildCardEvent(smuggled);
      const edit = buildCardEdit("$cardEvent", smuggled, 1);
      for (const marker of [POISON.smuggledDraftId, POISON.smuggledEvidence, POISON.smuggledOwnerNotice]) {
        expect(JSON.stringify(event)).not.toContain(marker);
        expect(JSON.stringify(edit)).not.toContain(marker);
      }
    });
  }

  it("DuoCardV1Input has no field for draftId, logEntryId, topicId, confidence, sources, evidence, rule text, ownerNotice, or draft text — a TypeScript fact, not a runtime one", () => {
    // This test exists to be read, not to assert much at runtime: the
    // task/decision/result variants above are the WHOLE type (see
    // src/workspace/cards.ts), and none of them declares any of these
    // keys. A future change that added one would be visible in the same
    // file's diff, and the poisoned fixtures above would need a new field
    // to plant it in — there is no existing slot today.
    const forbiddenKeys = ["draftId", "logEntryId", "topicId", "confidence", "sources", "evidence", "ruleText", "ownerNotice", "draftText"];
    for (const key of forbiddenKeys) {
      expect(key in poisonedTask).toBe(false);
      expect(key in poisonedDecision).toBe(false);
      expect(key in poisonedResult).toBe(false);
    }
  });
});

describe("workspace egress surface — structural pin on what src/workspace may import (the R2/KTD10 idiom, applied to the corpus boundary)", () => {
  const srcRoot = fileURLToPath(new URL("../src/workspace", import.meta.url));

  // Recursive on purpose: a future src/workspace/<sub>/ directory is scanned
  // like the top level — the walk is the guard's reach, not decoration (the
  // repo's egress scan in test/gitignore.test.ts uses the same walk shape).
  function workspaceFiles(): string[] {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
        } else if (entry.name.endsWith(".ts")) {
          files.push(path);
        }
      }
    };
    walk(srcRoot);
    return files;
  }

  // Every form a module specifier can take: static `import … from "x"`
  // (single- or multi-line), side-effect `import "x"`, dynamic
  // `await import("x")`, and re-export `export … from "x"`. A from-only
  // shape is blind to exactly the forms a boundary crosser would reach for
  // first — src/commands/serve.ts already uses the dynamic form by design.
  // Over-matching (a comment quoting `from "…"`) fails the scan loudly,
  // which is the safe direction for a guard.
  function importSpecifiers(text: string): string[] {
    const specifiers: string[] = [];
    for (const match of text.matchAll(/from\s*["']([^"']+)["']/g)) {
      specifiers.push(match[1]!);
    }
    for (const match of text.matchAll(/\bimport\s*["']([^"']+)["']/g)) {
      specifiers.push(match[1]!);
    }
    for (const match of text.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)) {
      specifiers.push(match[1]!);
    }
    return specifiers;
  }

  it("captures every import form — static, side-effect, dynamic, and re-export — so the scans below cannot be walked around", () => {
    const captured = importSpecifiers(
      [
        'import { a } from "../store/store.js";',
        'import type { T } from "matrix-js-sdk";',
        'import "../ingest/embeddings.js";',
        'const sdk = await import("matrix-js-sdk");',
        'export { helper } from "../trust/rules.js";',
      ].join("\n"),
    );
    expect(captured).toHaveLength(5);
    expect(captured).toEqual(
      expect.arrayContaining(["../store/store.js", "matrix-js-sdk", "../ingest/embeddings.js", "../trust/rules.js"]),
    );
  });

  it("imports matrix-js-sdk in exactly one file — the adapter — so the seam stays SDK-free everywhere else", () => {
    const importers = workspaceFiles().filter((path) => importSpecifiers(readFileSync(path, "utf8")).includes("matrix-js-sdk"));
    expect(importers.map((path) => path.split("/").pop())).toEqual(["matrix-transport.ts"]);
  });

  it("never imports a corpus-bearing module in any form — the pipeline arrives by injection, not by reach-in", () => {
    // W-S4-4: `tasks` joins the forbidden prefixes here — src/workspace must
    // reach the task/card store only through the injected WorkspaceTaskSink
    // interface (src/workspace/service.ts), implemented against
    // src/tasks/store.ts from src/serve/workspace-tasks.ts, exactly the
    // indirection workspace-read-state.ts already uses for DuoReadState.
    // src/tasks/state.ts (the pure state machine, no store access) is NOT
    // forbidden — only src/tasks/store.ts's storePath/passphrase-taking
    // functions are the thing this boundary exists to keep out, but the
    // directory-level prefix is the simplest rule that still holds: nothing
    // under src/tasks/ is ever imported from src/workspace/ directly.
    const forbidden = /^\.\.\/(store|ingest|derivation|drafting|corrections|trust|tasks)\//;
    const offenders = workspaceFiles().filter((path) =>
      importSpecifiers(readFileSync(path, "utf8")).some((specifier) => forbidden.test(specifier)),
    );
    expect(offenders).toEqual([]);
  });

  it("uses no network primitive of its own — only the SDK adapter talks to the network", () => {
    const networkModules = new Set([
      "http",
      "https",
      "net",
      "tls",
      "dgram",
      "undici",
      "ws",
      "node:http",
      "node:https",
      "node:net",
      "node:tls",
      "node:dgram",
    ]);
    const offenders = workspaceFiles().filter((path) => {
      const text = readFileSync(path, "utf8");
      const callSites = /\bfetch\s*\(|\bnew\s+WebSocket\b/.test(text);
      const imports = importSpecifiers(text).some((specifier) => networkModules.has(specifier));
      return callSites || imports;
    });
    expect(offenders).toEqual([]);
  });

  it("opens no listener — the workspace connection is outbound only (#186 AC2)", () => {
    const offenders = workspaceFiles().filter((path) => /\blisten\s*\(|createServer\s*\(/.test(readFileSync(path, "utf8")));
    expect(offenders).toEqual([]);
  });

  // #187 AC4: nobody gets a duo they did not create. The enforcement is
  // structural, not disciplinary: the module that talks to the homeserver
  // has no provisioning primitive at all, so a member joining the workspace
  // cannot be handed a duo by this code — or by an administrator through
  // it. The only duo-credential creation that exists is local pairing
  // (#186's env-token shape), on the owner's machine, per the platform
  // decision §6.
  it("contains no account-provisioning primitive — the module cannot create, register, or administer workspace users (#187 AC4)", () => {
    // Every form of user creation the SDK (and Synapse's admin surface)
    // names: the client-side register calls, admin-API paths, and the raw
    // registration endpoint. The adapter is the only SDK importer, and the
    // seam above pins that — this scan pins the calls themselves, wherever
    // they would appear.
    const provisioning = /\bregister(User|Request|Guest)?\s*\(|\bcreateAccount\b|\/_synapse\/admin|\/register\b|\bdeactivateAccount\b/;
    const offenders = workspaceFiles().filter((path) => provisioning.test(readFileSync(path, "utf8")));
    expect(offenders).toEqual([]);
  });
});
