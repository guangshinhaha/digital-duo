import { describe, expect, it } from "vitest";
import { InvalidTaskTransitionError, transition, type TaskEvent, type TaskState } from "../src/tasks/state.js";

/**
 * Pins the one state machine docs/workspace/cards.md §8 names:
 * `acknowledged → working → needs_decision → working → done | failed`,
 * plus `acknowledged → done`, `acknowledged → needs_decision`, and any
 * state → `failed`. Every transition is a named event, not an arbitrary
 * target state — so a caller cannot ask for a move the spec never allowed
 * just by naming a different string.
 */

const ALL_STATES: readonly TaskState[] = ["acknowledged", "working", "needs_decision", "done", "failed"];
const ALL_EVENTS: readonly TaskEvent[] = ["start_working", "need_decision", "resume_working", "complete", "fail"];

/** Every (state, event) pair this machine allows, and the state it lands in. */
const ALLOWED: readonly { from: TaskState; event: TaskEvent; to: TaskState }[] = [
  { from: "acknowledged", event: "start_working", to: "working" },
  { from: "working", event: "need_decision", to: "needs_decision" },
  { from: "needs_decision", event: "resume_working", to: "working" },
  { from: "working", event: "complete", to: "done" },
  { from: "acknowledged", event: "complete", to: "done" },
  { from: "acknowledged", event: "need_decision", to: "needs_decision" },
  { from: "acknowledged", event: "fail", to: "failed" },
  { from: "working", event: "fail", to: "failed" },
  { from: "needs_decision", event: "fail", to: "failed" },
];

describe("transition — every allowed move succeeds and lands in the right state", () => {
  for (const { from, event, to } of ALLOWED) {
    it(`${from} --${event}--> ${to}`, () => {
      expect(transition({ state: from }, event)).toBe(to);
    });
  }

  it("any state can fail, including done and failed themselves per 'any state → failed' — except these two are terminal below", () => {
    // "any state → failed" from cards.md §8 is read literally for the three
    // non-terminal states above; done/failed are terminal (see the
    // exhaustive refusal test below) — a completed or already-failed task
    // has nothing left to fail from.
    for (const from of ["acknowledged", "working", "needs_decision"] as const) {
      expect(transition({ state: from }, "fail")).toBe("failed");
    }
  });
});

describe("transition — every other (state, event) pair throws InvalidTaskTransitionError", () => {
  const allowedSet = new Set(ALLOWED.map(({ from, event }) => `${from}:${event}`));

  for (const from of ALL_STATES) {
    for (const event of ALL_EVENTS) {
      if (allowedSet.has(`${from}:${event}`)) {
        continue;
      }
      it(`${from} --${event}--> throws`, () => {
        expect(() => transition({ state: from }, event)).toThrow(InvalidTaskTransitionError);
      });
    }
  }

  it("done and failed are terminal — no event moves out of them", () => {
    for (const from of ["done", "failed"] as const) {
      for (const event of ALL_EVENTS) {
        expect(() => transition({ state: from }, event)).toThrow(InvalidTaskTransitionError);
      }
    }
  });

  it("names the offending state and event in the thrown error", () => {
    expect(() => transition({ state: "done" }, "start_working")).toThrow(/done/);
    expect(() => transition({ state: "done" }, "start_working")).toThrow(/start_working/);
  });
});
