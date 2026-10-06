import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDir } from "./helpers/temp-dir.js";
import { appendDraft, recordDraftOutcome } from "../src/drafting/draft-log.js";
import { writeTopicsFile } from "../src/derivation/topics.js";
import { upsertRefusal } from "../src/trust/refusals.js";
import { appendPublicAnswerLogEntry } from "../src/permissions/public-answer-log.js";
import {
  awayAnswerContext,
  AWAY_SCOPES,
  dismissAwaySummary,
  endAwayNow,
  getAwayState,
  InvalidAwayError,
  listTopicOptions,
  MAX_AWAY_DAYS,
  NotAwayError,
  setAway,
} from "../src/trust/away.js";
import { createEncryptedStore } from "../src/store/store.js";

const tempDir = useTempDir();
const PASSPHRASE = "pw";

function storePath(): string {
  return join(tempDir(), "data", "duo.db");
}

function duoDir(): string {
  return join(tempDir(), "duo");
}

function init(): string {
  const path = storePath();
  createEncryptedStore(path, PASSPHRASE);
  return path;
}

describe("setAway — #270: starts or replaces the one active period", () => {
  it("starts a period with scope 'may_do' and no topics", () => {
    const path = init();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const until = new Date("2026-01-02T00:00:00.000Z");
    const period = setAway(path, PASSPHRASE, duoDir(), { until, scope: "may_do" }, now);
    expect(period).toMatchObject({ scope: "may_do", until: until.toISOString(), extraTopics: [], endedAt: null, endedEarly: false });
  });

  it("starts a period with scope 'may_do_and_topics', resolving known topic ids to their labels", () => {
    const path = init();
    writeTopicsFile(duoDir(), [{ id: "topic-1", label: "Facilities", createdAt: "2026-01-01T00:00:00.000Z" }]);
    const now = new Date("2026-01-01T00:00:00.000Z");
    const period = setAway(path, PASSPHRASE, duoDir(), { until: new Date("2026-01-02T00:00:00.000Z"), scope: "may_do_and_topics", extraTopicIds: ["topic-1"] }, now);
    expect(period.extraTopics).toEqual([{ id: "topic-1", label: "Facilities" }]);
  });

  it("replaces the active period's own settings in place — same id, same startedAt", () => {
    const path = init();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const first = setAway(path, PASSPHRASE, duoDir(), { until: new Date("2026-01-02T00:00:00.000Z"), scope: "may_do" }, now);
    const replaced = setAway(path, PASSPHRASE, duoDir(), { until: new Date("2026-01-05T00:00:00.000Z"), scope: "may_do" }, new Date("2026-01-01T06:00:00.000Z"));
    expect(replaced.id).toBe(first.id);
    expect(replaced.startedAt).toBe(first.startedAt);
    expect(replaced.until).toBe("2026-01-05T00:00:00.000Z");
  });

  it("rejects a past until", () => {
    const path = init();
    const now = new Date("2026-01-02T00:00:00.000Z");
    expect(() => setAway(path, PASSPHRASE, duoDir(), { until: new Date("2026-01-01T00:00:00.000Z"), scope: "may_do" }, now)).toThrow(InvalidAwayError);
  });

  it(`rejects an until more than ${MAX_AWAY_DAYS} days out`, () => {
    const path = init();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const tooFar = new Date(now.getTime() + (MAX_AWAY_DAYS + 1) * 24 * 60 * 60 * 1000);
    expect(() => setAway(path, PASSPHRASE, duoDir(), { until: tooFar, scope: "may_do" }, now)).toThrow(InvalidAwayError);
  });

  it("rejects an unknown scope", () => {
    const path = init();
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(() =>
      setAway(path, PASSPHRASE, duoDir(), { until: new Date("2026-01-02T00:00:00.000Z"), scope: "literally_anything" as never }, now),
    ).toThrow(InvalidAwayError);
  });

  it("rejects an unknown topic id in extraTopicIds", () => {
    const path = init();
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(() =>
      setAway(path, PASSPHRASE, duoDir(), { until: new Date("2026-01-02T00:00:00.000Z"), scope: "may_do_and_topics", extraTopicIds: ["nope"] }, now),
    ).toThrow(InvalidAwayError);
  });

  it("rejects a topic that is on the never-answer list", () => {
    const path = init();
    writeTopicsFile(duoDir(), [{ id: "topic-1", label: "Headcount", createdAt: "2026-01-01T00:00:00.000Z" }]);
    upsertRefusal(duoDir(), "Headcount", "Never speak for me on this.");
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(() =>
      setAway(path, PASSPHRASE, duoDir(), { until: new Date("2026-01-02T00:00:00.000Z"), scope: "may_do_and_topics", extraTopicIds: ["topic-1"] }, now),
    ).toThrow(InvalidAwayError);
  });

  it("ignores extraTopicIds when scope is 'may_do'", () => {
    const path = init();
    writeTopicsFile(duoDir(), [{ id: "topic-1", label: "Facilities", createdAt: "2026-01-01T00:00:00.000Z" }]);
    const now = new Date("2026-01-01T00:00:00.000Z");
    const period = setAway(path, PASSPHRASE, duoDir(), { until: new Date("2026-01-02T00:00:00.000Z"), scope: "may_do", extraTopicIds: ["topic-1"] }, now);
    expect(period.extraTopics).toEqual([]);
  });
});

describe("endAwayNow — #270: 'I'm back'", () => {
  it("ends the active period early", () => {
    const path = init();
    const now = new Date("2026-01-01T00:00:00.000Z");
    setAway(path, PASSPHRASE, duoDir(), { until: new Date("2026-01-02T00:00:00.000Z"), scope: "may_do" }, now);
    const ended = endAwayNow(path, PASSPHRASE, duoDir(), new Date("2026-01-01T06:00:00.000Z"));
    expect(ended.endedEarly).toBe(true);
    expect(ended.endedAt).toBe("2026-01-01T06:00:00.000Z");
  });

  it("409s (NotAwayError) when nothing is active", () => {
    const path = init();
    expect(() => endAwayNow(path, PASSPHRASE, duoDir())).toThrow(NotAwayError);
  });

  it("409s once a period has already lazily expired", () => {
    const path = init();
    const now = new Date("2026-01-01T00:00:00.000Z");
    setAway(path, PASSPHRASE, duoDir(), { until: new Date("2026-01-02T00:00:00.000Z"), scope: "may_do" }, now);
    expect(() => endAwayNow(path, PASSPHRASE, duoDir(), new Date("2026-01-03T00:00:00.000Z"))).toThrow(NotAwayError);
  });
});

describe("getAwayState — lazy expiry: an away period that has passed its until stops being active on the next read", () => {
  it("reports active while before until, and moves to last (ended, not early) once past it", () => {
    const path = init();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const until = new Date("2026-01-02T00:00:00.000Z");
    setAway(path, PASSPHRASE, duoDir(), { until, scope: "may_do" }, now);

    const whileActive = getAwayState(path, PASSPHRASE, duoDir(), new Date("2026-01-01T12:00:00.000Z"));
    expect(whileActive.active).not.toBeNull();
    expect(whileActive.statusLine).toContain("away until");

    const afterExpiry = getAwayState(path, PASSPHRASE, duoDir(), new Date("2026-01-03T00:00:00.000Z"));
    expect(afterExpiry.active).toBeNull();
    expect(afterExpiry.last).toMatchObject({ endedAt: until.toISOString(), endedEarly: false });
    expect(afterExpiry.statusLine).toBeNull();
    // The return summary is there, not yet dismissed.
    expect(afterExpiry.summary).toMatchObject({ ended: true });
  });

  it("scopes and maxDays are always reported, even with no period ever set", () => {
    const path = init();
    const state = getAwayState(path, PASSPHRASE, duoDir());
    expect(state).toEqual({ active: null, last: null, statusLine: null, summary: null, scopes: AWAY_SCOPES, maxDays: MAX_AWAY_DAYS });
  });
});

describe("dismissAwaySummary — idempotent", () => {
  it("clears the return summary off the last ended period", () => {
    const path = init();
    setAway(path, PASSPHRASE, duoDir(), { until: new Date("2026-01-02T00:00:00.000Z"), scope: "may_do" }, new Date("2026-01-01T00:00:00.000Z"));
    endAwayNow(path, PASSPHRASE, duoDir(), new Date("2026-01-01T06:00:00.000Z"));

    expect(getAwayState(path, PASSPHRASE, duoDir()).summary).not.toBeNull();
    dismissAwaySummary(path, PASSPHRASE);
    expect(getAwayState(path, PASSPHRASE, duoDir()).summary).toBeNull();
    // Dismissing again is a no-op, not an error.
    expect(() => dismissAwaySummary(path, PASSPHRASE)).not.toThrow();
  });

  it("is a no-op when nothing has ever ended", () => {
    const path = init();
    expect(() => dismissAwaySummary(path, PASSPHRASE)).not.toThrow();
  });
});

describe("awayAnswerContext.allowsTopic — the answer-time check", () => {
  it("true for a topic added under 'may_do_and_topics', while active", () => {
    const path = init();
    writeTopicsFile(duoDir(), [{ id: "topic-1", label: "Facilities", createdAt: "2026-01-01T00:00:00.000Z" }]);
    const now = new Date("2026-01-01T00:00:00.000Z");
    setAway(path, PASSPHRASE, duoDir(), { until: new Date("2026-01-02T00:00:00.000Z"), scope: "may_do_and_topics", extraTopicIds: ["topic-1"] }, now);
    const context = awayAnswerContext(path, PASSPHRASE, duoDir(), new Date("2026-01-01T12:00:00.000Z"));
    expect(context.allowsTopic("topic-1")).toBe(true);
    expect(context.allowsTopic("topic-2")).toBe(false);
  });

  it("false once now is at or past until, even if the row hasn't been lazily closed yet", () => {
    const path = init();
    writeTopicsFile(duoDir(), [{ id: "topic-1", label: "Facilities", createdAt: "2026-01-01T00:00:00.000Z" }]);
    setAway(path, PASSPHRASE, duoDir(), { until: new Date("2026-01-02T00:00:00.000Z"), scope: "may_do_and_topics", extraTopicIds: ["topic-1"] }, new Date("2026-01-01T00:00:00.000Z"));
    const context = awayAnswerContext(path, PASSPHRASE, duoDir(), new Date("2026-01-03T00:00:00.000Z"));
    expect(context.allowsTopic("topic-1")).toBe(false);
  });

  it("false for scope 'may_do' regardless of topic", () => {
    const path = init();
    setAway(path, PASSPHRASE, duoDir(), { until: new Date("2026-01-02T00:00:00.000Z"), scope: "may_do" }, new Date("2026-01-01T00:00:00.000Z"));
    const context = awayAnswerContext(path, PASSPHRASE, duoDir(), new Date("2026-01-01T12:00:00.000Z"));
    expect(context.allowsTopic("topic-1")).toBe(false);
  });

  it("false when nobody is away", () => {
    const path = init();
    expect(awayAnswerContext(path, PASSPHRASE, duoDir()).allowsTopic("topic-1")).toBe(false);
  });
});

describe("awayAnswerContext.statusLine", () => {
  it("names the extra topics when the scope adds any", () => {
    const path = init();
    writeTopicsFile(duoDir(), [{ id: "topic-1", label: "Facilities", createdAt: "2026-01-01T00:00:00.000Z" }]);
    setAway(path, PASSPHRASE, duoDir(), { until: new Date("2026-01-02T00:00:00.000Z"), scope: "may_do_and_topics", extraTopicIds: ["topic-1"] }, new Date("2026-01-01T00:00:00.000Z"));
    const line = awayAnswerContext(path, PASSPHRASE, duoDir(), new Date("2026-01-01T12:00:00.000Z")).statusLine;
    expect(line).toContain("Facilities");
  });

  it("is null when nobody is away", () => {
    const path = init();
    expect(awayAnswerContext(path, PASSPHRASE, duoDir()).statusLine).toBeNull();
  });
});

describe("listTopicOptions — GET /topics", () => {
  it("returns every topic's id and label, nothing else", () => {
    writeTopicsFile(duoDir(), [
      { id: "topic-1", label: "Facilities", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "topic-2", label: "Travel", createdAt: "2026-01-02T00:00:00.000Z" },
    ]);
    expect(listTopicOptions(duoDir())).toEqual([
      { id: "topic-1", label: "Facilities" },
      { id: "topic-2", label: "Travel" },
    ]);
  });

  it("returns [] when the duo has no topics yet", () => {
    expect(listTopicOptions(duoDir())).toEqual([]);
  });
});

describe("getAwayState — the summary classifies by outcome, and a passed-on question's 'waiting' off the draft's own outcome", () => {
  it("sorts answered/passedOn/declined, and flags viaAwayTopic and waiting correctly", () => {
    const path = init();
    writeTopicsFile(duoDir(), [{ id: "topic-1", label: "Facilities", createdAt: "2026-01-01T00:00:00.000Z" }]);
    // appendPublicAnswerLogEntry stamps its own rows with the real wall
    // clock (it takes no injectable `now`), so the period's own window
    // has to straddle *that* clock too — a fixed past date (as the rest
    // of this file uses, since setAway/getAwayState both take an
    // explicit `now`) would put every logged entry outside the window.
    const now = new Date();
    const until = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    setAway(path, PASSPHRASE, duoDir(), { until, scope: "may_do_and_topics", extraTopicIds: ["topic-1"] }, now);

    const answeredDraftId = appendDraft(path, PASSPHRASE, {
      question: "where is the fire exit",
      threadContext: null,
      draftText: "By the lifts.",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.9,
      sources: [],
      refused: false,
    });
    appendPublicAnswerLogEntry(path, PASSPHRASE, {
      question: "where is the fire exit",
      askerRef: "colleague-1",
      topicId: "topic-1",
      outcome: "answered",
      text: "By the lifts.",
      draftId: answeredDraftId,
      askLinkId: null,
      askerResolved: null,
      clearanceApplied: "official_open",
    });

    const waitingDraftId = appendDraft(path, PASSPHRASE, {
      question: "what's the budget",
      threadContext: null,
      draftText: "Some figure.",
      escalated: true,
      escalationReason: "not granted",
      confidenceScore: 0.5,
      sources: [],
      refused: false,
    });
    appendPublicAnswerLogEntry(path, PASSPHRASE, {
      question: "what's the budget",
      askerRef: "colleague-2",
      topicId: "topic-2",
      outcome: "passed_on",
      text: "passed on",
      draftId: waitingDraftId,
      askLinkId: null,
      askerResolved: null,
      clearanceApplied: "official_open",
    });

    const handledDraftId = appendDraft(path, PASSPHRASE, {
      question: "what's the other budget",
      threadContext: null,
      draftText: "Some other figure.",
      escalated: true,
      escalationReason: "not granted",
      confidenceScore: 0.5,
      sources: [],
      refused: false,
    });
    recordDraftOutcome(path, PASSPHRASE, handledDraftId, "sent");
    appendPublicAnswerLogEntry(path, PASSPHRASE, {
      question: "what's the other budget",
      askerRef: "colleague-3",
      topicId: "topic-2",
      outcome: "passed_on",
      text: "passed on",
      draftId: handledDraftId,
      askLinkId: null,
      askerResolved: null,
      clearanceApplied: "official_open",
    });

    const declinedDraftId = appendDraft(path, PASSPHRASE, {
      question: "what's the headcount plan",
      threadContext: null,
      draftText: null,
      escalated: true,
      escalationReason: "refused subject",
      confidenceScore: 0,
      sources: [],
      refused: true,
    });
    appendPublicAnswerLogEntry(path, PASSPHRASE, {
      question: "what's the headcount plan",
      askerRef: "colleague-4",
      topicId: null,
      outcome: "declined_refused",
      text: "declined",
      draftId: declinedDraftId,
      askLinkId: null,
      askerResolved: null,
      clearanceApplied: "official_open",
    });

    const state = getAwayState(path, PASSPHRASE, duoDir(), new Date(now.getTime() + 60 * 60 * 1000));
    expect(state.summary?.ended).toBe(false);
    expect(state.summary?.answered).toEqual([
      { question: "where is the fire exit", askerRef: "colleague-1", at: expect.any(String), draftId: answeredDraftId, topicId: "topic-1", viaAwayTopic: true },
    ]);
    expect(state.summary?.passedOn).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ draftId: waitingDraftId, waiting: true }),
        expect.objectContaining({ draftId: handledDraftId, waiting: false }),
      ]),
    );
    expect(state.summary?.declined).toEqual([
      { question: "what's the headcount plan", askerRef: "colleague-4", at: expect.any(String), draftId: declinedDraftId, topicId: null },
    ]);
  });
});
