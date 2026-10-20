import { describe, expect, it } from "vitest";
import {
  buildCardEdit,
  buildCardEvent,
  CardValidationError,
  DuoCardSchema,
  fallbackBodyOf,
  ReservedCardKindError,
  type DuoCardV1Input,
} from "../src/workspace/cards.js";

// Markers planted in every owner-facing or corpus-shaped field a card
// builder's input could theoretically carry, mirroring
// test/workspace-payload.test.ts's POISON convention — this file only
// double-checks the builder's own validation and shape; the cross-kind
// privacy scan lives in workspace-payload.test.ts (extended for cards.ts).

function task(overrides: Partial<Extract<DuoCardV1Input, { kind: "task" }>> = {}): DuoCardV1Input {
  return {
    kind: "task",
    cardId: "c_01TASK",
    state: "acknowledged",
    requester: "@alice:workspace",
    title: "Checking with Ana",
    lines: ["Passed to Ana. You'll get a reply here."],
    ...overrides,
  } as DuoCardV1Input;
}

function decision(overrides: Partial<Extract<DuoCardV1Input, { kind: "decision" }>> = {}): DuoCardV1Input {
  return {
    kind: "decision",
    cardId: "c_01DEC",
    state: "open",
    requester: "@alice:workspace",
    title: "Which circular?",
    options: [
      { id: "o1", label: "The 2025 circular" },
      { id: "o2", label: "The 2024 circular" },
    ],
    ...overrides,
  } as DuoCardV1Input;
}

function result(overrides: Partial<Extract<DuoCardV1Input, { kind: "result" }>> = {}): DuoCardV1Input {
  return {
    kind: "result",
    cardId: "c_01RES",
    state: "done",
    requester: "@alice:workspace",
    title: "Done",
    result: { text: "Approved on 2026-08-14.", links: [], files: [] },
    ...overrides,
  } as DuoCardV1Input;
}

describe("buildCardEvent — every output validates against the wire schema", () => {
  it("builds a task card at rev 1 that validates against DuoCardSchema", () => {
    const event = buildCardEvent(task());
    expect(event.msgtype).toBe("duo.card");
    expect(event["m.mentions"]).toEqual({});
    expect(event["duo.card"].rev).toBe(1);
    expect(event["duo.card"].v).toBe(1);
    expect(() => DuoCardSchema.parse(event["duo.card"])).not.toThrow();
  });

  it("builds a decision card that validates against DuoCardSchema", () => {
    const event = buildCardEvent(decision());
    expect(() => DuoCardSchema.parse(event["duo.card"])).not.toThrow();
  });

  it("builds a result card that validates against DuoCardSchema", () => {
    const event = buildCardEvent(result());
    expect(() => DuoCardSchema.parse(event["duo.card"])).not.toThrow();
  });

  it("sets body to the fallback computed by fallbackBodyOf", () => {
    const input = task({ state: "acknowledged" });
    const event = buildCardEvent(input);
    expect(event.body).toBe(fallbackBodyOf(input));
  });
});

describe("buildCardEvent — reserved and owner-only kinds refuse to build for Matrix", () => {
  const reserved = ["confirm", "form", "created", "permissions", "draft", "approval"] as const;

  for (const kind of reserved) {
    it(`throws ReservedCardKindError for kind ${kind}`, () => {
      expect(() => buildCardEvent({ kind, cardId: "c_x", state: "open", requester: "@alice:workspace", title: "x" } as unknown as DuoCardV1Input)).toThrow(
        ReservedCardKindError,
      );
    });
  }
});

describe("buildCardEvent — over-limit inputs throw CardValidationError (the chosen deterministic rule — see cards.ts's doc comment)", () => {
  it("throws when title exceeds 80 chars", () => {
    expect(() => buildCardEvent(task({ title: "x".repeat(81) }))).toThrow(CardValidationError);
  });

  it("accepts a title at exactly 80 chars", () => {
    expect(() => buildCardEvent(task({ title: "x".repeat(80) }))).not.toThrow();
  });

  it("throws when more than 3 lines are given", () => {
    expect(() => buildCardEvent(task({ lines: ["a", "b", "c", "d"] }))).toThrow(CardValidationError);
  });

  it("throws when a line exceeds 200 chars", () => {
    expect(() => buildCardEvent(task({ lines: ["x".repeat(201)] }))).toThrow(CardValidationError);
  });

  it("accepts a line at exactly 200 chars", () => {
    expect(() => buildCardEvent(task({ lines: ["x".repeat(200)] }))).not.toThrow();
  });

  it("throws when decision options are fewer than 2", () => {
    expect(() => buildCardEvent(decision({ options: [{ id: "o1", label: "only one" }] }))).toThrow(CardValidationError);
  });

  it("throws when decision options exceed 4", () => {
    expect(() =>
      buildCardEvent(
        decision({
          options: [
            { id: "o1", label: "a" },
            { id: "o2", label: "b" },
            { id: "o3", label: "c" },
            { id: "o4", label: "d" },
            { id: "o5", label: "e" },
          ],
        }),
      ),
    ).toThrow(CardValidationError);
  });

  it("accepts exactly 4 decision options", () => {
    expect(() =>
      buildCardEvent(
        decision({
          options: [
            { id: "o1", label: "a" },
            { id: "o2", label: "b" },
            { id: "o3", label: "c" },
            { id: "o4", label: "d" },
          ],
        }),
      ),
    ).not.toThrow();
  });

  it("throws when more than 3 milestones are given", () => {
    expect(() =>
      buildCardEvent(
        task({
          milestones: [
            { state: "working", label: "a", ts: 1 },
            { state: "working", label: "b", ts: 2 },
            { state: "working", label: "c", ts: 3 },
            { state: "working", label: "d", ts: 4 },
          ],
        }),
      ),
    ).toThrow(CardValidationError);
  });

  it("accepts exactly 3 milestones", () => {
    expect(() =>
      buildCardEvent(
        task({
          milestones: [
            { state: "working", label: "a", ts: 1 },
            { state: "working", label: "b", ts: 2 },
            { state: "working", label: "c", ts: 3 },
          ],
        }),
      ),
    ).not.toThrow();
  });
});

describe("buildCardEdit — same-sender replacement per cards.md §3", () => {
  it("bumps rev by 1 from the previous revision and wraps the full card in m.new_content", () => {
    const first = buildCardEvent(task({ state: "acknowledged" }));
    expect(first["duo.card"].rev).toBe(1);
    const edit = buildCardEdit("$firstEventId", task({ state: "working" }), first["duo.card"].rev);
    expect(edit["m.relates_to"]).toEqual({ rel_type: "m.replace", event_id: "$firstEventId" });
    expect(edit["m.new_content"]["duo.card"].rev).toBe(2);
    expect(edit["m.new_content"]["duo.card"].state).toBe("working");
    expect(edit["m.new_content"].msgtype).toBe("duo.card");
    expect(edit.msgtype).toBe("duo.card");
  });

  it("sets the top-level body to '* ' + fallback, per the spec's edit example", () => {
    const input = task({ state: "done", result: undefined });
    const edit = buildCardEdit("$e1", input, 1);
    expect(edit.body).toBe(`* ${fallbackBodyOf(input)}`);
  });

  it("validates the new content's card against the schema", () => {
    const edit = buildCardEdit("$e1", decision({ state: "chosen", chosen: { optionId: "o1", by: "@alice:workspace" } }), 1);
    expect(() => DuoCardSchema.parse(edit["m.new_content"]["duo.card"])).not.toThrow();
  });

  it("refuses reserved kinds the same way buildCardEvent does", () => {
    expect(() =>
      buildCardEdit("$e1", { kind: "confirm", cardId: "c_x", state: "open", requester: "@alice:workspace", title: "x" } as unknown as DuoCardV1Input, 1),
    ).toThrow(ReservedCardKindError);
  });
});

describe("fallbackBodyOf — the exact copy table from cards.md §5", () => {
  it("task/acknowledged from a passed-on outcome uses exactly the asker-visible passed-on text given", () => {
    const passedOnText = "I can't answer that one for you directly — I've passed it on to the owner, and they'll follow up.";
    const body = fallbackBodyOf(task({ state: "acknowledged", lines: [passedOnText] }));
    expect(body).toBe(passedOnText);
  });

  it("task/acknowledged from the ack timer is the fixed string", () => {
    const body = fallbackBodyOf(task({ state: "acknowledged", lines: ["Looking into this — I'll update this message."] }));
    expect(body).toBe("Looking into this — I'll update this message.");
  });

  it("task/done is the result text, followed by each link as 'label: url'", () => {
    const body = fallbackBodyOf(
      result({
        result: {
          text: "Approved on 2026-08-14.",
          links: [{ label: "Ana's reply", url: "https://matrix.to/#/!room/$event" }],
          files: [],
        },
      }),
    );
    expect(body).toBe("Approved on 2026-08-14.\nAna's reply: https://matrix.to/#/!room/$event");
  });

  it("task/done with multiple links lists each on its own line", () => {
    const body = fallbackBodyOf(
      result({
        result: {
          text: "Done.",
          links: [
            { label: "A", url: "https://matrix.to/#/!a/$1" },
            { label: "B", url: "https://matrix.to/#/!b/$2" },
          ],
          files: [],
        },
      }),
    );
    expect(body).toBe("Done.\nA: https://matrix.to/#/!a/$1\nB: https://matrix.to/#/!b/$2");
  });

  it("decision/open is the fixed choice sentence built from option labels", () => {
    const body = fallbackBodyOf(
      decision({
        options: [
          { id: "o1", label: "A" },
          { id: "o2", label: "B" },
          { id: "o3", label: "C" },
        ],
      }),
    );
    expect(body).toBe("To answer, I need to know which you mean: A · B · C. Choose in the duo app.");
  });

  it("task/needs_decision names the owner", () => {
    const body = fallbackBodyOf(task({ state: "needs_decision", lines: ["This needs Alice's OK before anything happens."] }));
    expect(body).toBe("This needs Alice's OK before anything happens.");
  });

  it("decision/chosen names who chose", () => {
    const body = fallbackBodyOf(
      decision({
        state: "chosen",
        chosen: { optionId: "o1", by: "@alice:workspace" },
        options: [
          { id: "o1", label: "A" },
          { id: "o2", label: "B" },
        ],
      }),
    );
    expect(body).toBe("Chosen by @alice:workspace.");
  });

  it("decision/expired is the fixed string", () => {
    const body = fallbackBodyOf(
      decision({
        state: "expired",
        options: [
          { id: "o1", label: "A" },
          { id: "o2", label: "B" },
        ],
      }),
    );
    expect(body).toBe("This request expired.");
  });
});
