/**
 * W-S4-4: the task state machine, exactly as docs/workspace/cards.md §8
 * states it:
 *
 *   acknowledged → working → needs_decision → working → done | failed
 *
 * plus `acknowledged → done` (an answer that arrives after the ack),
 * `acknowledged → needs_decision`, and any (non-terminal) state → `failed`.
 * `done` and `failed` are terminal — nothing moves out of them.
 *
 * Pure and store-free on purpose (this is its own new module, no store
 * access — `src/tasks/store.ts` is the only caller, and it runs this
 * function inside the same transaction as its own write so an invalid
 * transition throws before anything is persisted). A table-driven pattern,
 * the same style `src/actions/approvals.ts` uses for its own status
 * handling, but kept smaller: there are only five states and five named
 * events, not a general-purpose FSM.
 *
 * `TaskEvent` names each allowed move explicitly rather than letting a
 * caller pass an arbitrary target `TaskState` — the spec's own list above
 * is a list of MOVES, not a reachability matrix, and naming them is what
 * keeps a caller from asking for a jump the spec never allowed just by
 * spelling a different target string.
 */

export type TaskState = "acknowledged" | "working" | "needs_decision" | "done" | "failed";

export type TaskEvent = "start_working" | "need_decision" | "resume_working" | "complete" | "fail";

/** Thrown for any (state, event) pair not in the table below. Names both so a caller can tell at a glance what it tried and from where. */
export class InvalidTaskTransitionError extends Error {
  constructor(state: TaskState, event: TaskEvent) {
    super(`Invalid task transition: cannot apply event "${event}" to a task in state "${state}" (docs/workspace/cards.md §8 names the allowed moves).`);
    this.name = "InvalidTaskTransitionError";
  }
}

/** The minimal shape `transition` needs — callers (the store) pass their own richer task row; only `state` matters here. */
export interface TransitionableTask {
  readonly state: TaskState;
}

/** The whole state machine, as the table it is: `from -> event -> to`. Absence means the move is refused. */
const TRANSITIONS: Readonly<Record<TaskState, Readonly<Partial<Record<TaskEvent, TaskState>>>>> = {
  acknowledged: {
    start_working: "working",
    need_decision: "needs_decision",
    complete: "done",
    fail: "failed",
  },
  working: {
    need_decision: "needs_decision",
    complete: "done",
    fail: "failed",
  },
  needs_decision: {
    resume_working: "working",
    fail: "failed",
  },
  done: {},
  failed: {},
};

/**
 * The single pure function every write path checks before persisting a new
 * state (cards.md §8: "every transition is checked by a single pure
 * function"). Throws `InvalidTaskTransitionError` for anything not in the
 * table above — including every attempt to leave `done` or `failed`, which
 * are terminal.
 */
export function transition(task: TransitionableTask, event: TaskEvent): TaskState {
  const to = TRANSITIONS[task.state][event];
  if (to === undefined) {
    throw new InvalidTaskTransitionError(task.state, event);
  }
  return to;
}
