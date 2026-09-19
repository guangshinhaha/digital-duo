import { describe, expect, it } from "vitest";
import { ABANDONED_AFTER_DAYS, buildUsageReport } from "../src/shared-duo/usage-report.js";
import type { SharedDuoUsageEntry } from "../src/shared-duo/usage-log.js";

function entry(overrides: Partial<SharedDuoUsageEntry> = {}): SharedDuoUsageEntry {
  return {
    id: "id",
    createdAt: "2026-08-01T00:00:00.000Z",
    question: "what is the leave policy?",
    askerId: "alice",
    declined: false,
    citedTitles: ["Leave requests"],
    staleCitation: false,
    ...overrides,
  };
}

const ASOF = new Date("2026-09-19T00:00:00Z");

describe("buildUsageReport — usage is reported honestly, not one flattering number (#71 AC1)", () => {
  it("says plainly, in those words, that the duo is not being used when the log is empty (#71 AC4)", () => {
    const report = buildUsageReport([], ASOF);
    expect(report.totalQuestions).toBe(0);
    expect(report.summary).toBe("The shared duo is not being used.");
    expect(report.answerRate).toBe(0);
    expect(report.escalationRate).toBe(0);
    expect(report.lastAskedAt).toBeNull();
    expect(report.daysSinceLastAsk).toBeNull();
    expect(report.abandoned).toBe(false);
  });

  it("counts distinct and repeat askers", () => {
    const entries = [
      entry({ askerId: "alice", createdAt: "2026-09-01T00:00:00.000Z" }),
      entry({ askerId: "alice", createdAt: "2026-09-02T00:00:00.000Z" }),
      entry({ askerId: "bob", createdAt: "2026-09-03T00:00:00.000Z" }),
    ];
    const report = buildUsageReport(entries, ASOF);
    expect(report.totalQuestions).toBe(3);
    expect(report.distinctAskers).toBe(2);
    expect(report.repeatAskers).toBe(1);
  });

  it("counts an asker under different casing as the same person, same normalization unresolvedQuestionGaps uses for questions", () => {
    const entries = [
      entry({ askerId: "Alice", createdAt: "2026-09-01T00:00:00.000Z" }),
      entry({ askerId: "alice", createdAt: "2026-09-02T00:00:00.000Z" }),
    ];
    const report = buildUsageReport(entries, ASOF);
    expect(report.distinctAskers).toBe(1);
    expect(report.repeatAskers).toBe(1);
  });

  it("computes answer and escalation rate from the actual declined/answered split", () => {
    const entries = [
      entry({ declined: false, createdAt: "2026-09-01T00:00:00.000Z" }),
      entry({ declined: false, createdAt: "2026-09-01T00:00:00.000Z" }),
      entry({ declined: true, createdAt: "2026-09-01T00:00:00.000Z" }),
      entry({ declined: true, createdAt: "2026-09-01T00:00:00.000Z" }),
    ];
    const report = buildUsageReport(entries, ASOF);
    expect(report.answeredCount).toBe(2);
    expect(report.declinedCount).toBe(2);
    expect(report.answerRate).toBe(0.5);
    expect(report.escalationRate).toBe(0.5);
  });

  it("buckets the trend by week rather than collapsing everything into one aggregate", () => {
    const entries = [
      entry({ createdAt: "2026-08-03T00:00:00.000Z" }), // a Monday
      entry({ createdAt: "2026-08-04T00:00:00.000Z" }), // same week
      entry({ createdAt: "2026-08-10T00:00:00.000Z" }), // next week (Monday)
    ];
    const report = buildUsageReport(entries, ASOF);
    expect(report.weeklyTrend).toEqual([
      { weekStart: "2026-08-03", questionCount: 2 },
      { weekStart: "2026-08-10", questionCount: 1 },
    ]);
  });

  it("includes unresolved question gaps, reusing #69's grouping exactly (#71 AC3)", () => {
    const entries = [
      entry({ declined: true, question: "what is the parking policy?", createdAt: "2026-09-01T00:00:00.000Z" }),
      entry({ declined: true, question: "what is the parking policy?", createdAt: "2026-09-02T00:00:00.000Z" }),
    ];
    const report = buildUsageReport(entries, ASOF);
    expect(report.gaps).toEqual([{ question: "what is the parking policy?", count: 2 }]);
  });
});

describe("buildUsageReport — abandonment is visible rather than smoothed (#71 AC2)", () => {
  it("flags abandonment and states plainly when it happened, when nothing has been asked in a long time", () => {
    const entries = [
      entry({ createdAt: "2026-08-01T00:00:00.000Z" }),
      entry({ createdAt: "2026-08-02T00:00:00.000Z" }),
    ];
    const report = buildUsageReport(entries, ASOF); // ASOF is 2026-09-19, ~48 days after the last ask
    expect(report.abandoned).toBe(true);
    expect(report.lastAskedAt).toBe("2026-08-02T00:00:00.000Z");
    expect(report.daysSinceLastAsk).toBeGreaterThan(ABANDONED_AFTER_DAYS);
    expect(report.summary).toContain("2026-08-02");
    expect(report.summary).toMatch(/stopped/i);
  });

  it("does not flag abandonment for recent, ongoing usage", () => {
    const entries = [entry({ createdAt: "2026-09-18T00:00:00.000Z" })];
    const report = buildUsageReport(entries, ASOF);
    expect(report.abandoned).toBe(false);
    expect(report.summary).not.toMatch(/stopped/i);
  });

  it("is not abandoned exactly at the threshold, but is just past it", () => {
    const justUnder = new Date(ASOF.getTime() - (ABANDONED_AFTER_DAYS - 1) * 24 * 60 * 60 * 1000).toISOString();
    const justOver = new Date(ASOF.getTime() - (ABANDONED_AFTER_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString();
    expect(buildUsageReport([entry({ createdAt: justUnder })], ASOF).abandoned).toBe(false);
    expect(buildUsageReport([entry({ createdAt: justOver })], ASOF).abandoned).toBe(true);
  });
});
