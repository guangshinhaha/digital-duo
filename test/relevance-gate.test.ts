import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDir } from "./helpers/temp-dir.js";
import { classifyMention, matchesRefusedSubject, RELEVANCE_GATE_TARGET_PRECISION } from "../src/drafting/relevance-gate.js";
import { listGateDecisions } from "../src/drafting/gate-log.js";
import { runRelevanceGate } from "../src/drafting/gate.js";
import { readRefusalsFile } from "../src/drafting/refusals.js";
import { createEncryptedStore } from "../src/store/store.js";

const tempDir = useTempDir();
const PASSPHRASE = "pw";

function initStore(): string {
  const storePath = join(tempDir(), "data", "duo.db");
  createEncryptedStore(storePath, PASSPHRASE);
  return storePath;
}

function duoDir(): string {
  return join(tempDir(), "duo");
}

function writeRefusalsFile(dir: string, subjects: string[]): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "refusals.md"), `# Refusals\n\n${subjects.map((s) => `- ${s}`).join("\n")}\n`, "utf8");
}

describe("classifyMention — a genuine question passes (AC1)", () => {
  it("passes a question that asks the owner something", () => {
    expect(classifyMention("Can you review the budget doc before Friday?")).toEqual({
      passes: true,
      reason: "genuine_question",
    });
  });

  it("passes a question-word opener with no question mark", () => {
    expect(classifyMention("Do you have the vacation policy handy")).toEqual({
      passes: true,
      reason: "genuine_question",
    });
  });
});

describe("classifyMention — noise is refused (AC2)", () => {
  it.each([
    "Thanks for the update!",
    "FYI the deploy went out fine.",
    "Adding you to this thread for visibility.",
    "Great job on the launch, cheers!",
  ])("blocks %j as noise", (text) => {
    expect(classifyMention(text)).toEqual({ passes: false, reason: "noise" });
  });
});

describe("classifyMention — an ambiguous mention defaults to silence (AC3)", () => {
  it("blocks a mention with no question and no noise signal", () => {
    expect(classifyMention("The migration is still running.")).toEqual({ passes: false, reason: "ambiguous" });
  });

  it("blocks a mention carrying both noise and question signals", () => {
    expect(classifyMention("Thanks for that — is it due Friday?")).toEqual({ passes: false, reason: "ambiguous" });
  });
});

describe("classifyMention — a refused subject never reaches drafting (AC4)", () => {
  it("blocks a question-shaped mention that touches a refusal, before any noise/question check", () => {
    expect(classifyMention("What's my compensation for this quarter?", ["compensation"])).toEqual({
      passes: false,
      reason: "refused_subject",
    });
  });

  it("matchesRefusedSubject names the specific refusal matched", () => {
    expect(matchesRefusedSubject("What's my salary?", ["compensation", "salary"])).toBe("salary");
    expect(matchesRefusedSubject("What time is the meeting?", ["compensation", "salary"])).toBeUndefined();
  });
});

describe("RELEVANCE_GATE_TARGET_PRECISION — stated and asymmetric", () => {
  it("is a high precision target, not a balanced precision/recall target", () => {
    expect(RELEVANCE_GATE_TARGET_PRECISION).toBeGreaterThanOrEqual(0.9);
  });
});

describe("readRefusalsFile", () => {
  it("returns [] when duo/refusals.md doesn't exist yet", () => {
    expect(readRefusalsFile(duoDir())).toEqual([]);
  });

  it("parses bullet lines, ignoring headings and prose", () => {
    const dir = duoDir();
    writeRefusalsFile(dir, ["compensation", "performance reviews"]);
    expect(readRefusalsFile(dir)).toEqual(["compensation", "performance reviews"]);
  });
});

describe("runRelevanceGate — every decision is logged (#31 checklist)", () => {
  it("logs a passing decision with its input", () => {
    const storePath = initStore();
    const outcome = runRelevanceGate(storePath, PASSPHRASE, duoDir(), { text: "Can you send the report?", from: "alice" });
    expect(outcome.passes).toBe(true);
    expect(outcome.reason).toBe("genuine_question");

    const entries = listGateDecisions(storePath, PASSPHRASE);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      mentionText: "Can you send the report?",
      from: "alice",
      passes: true,
      reason: "genuine_question",
    });
    expect(entries[0].id).toBe(outcome.logId);
  });

  it("logs a blocked decision the same way, and reads duo/refusals.md for refusal checks", () => {
    const storePath = initStore();
    const dir = duoDir();
    writeRefusalsFile(dir, ["compensation"]);

    const outcome = runRelevanceGate(storePath, PASSPHRASE, dir, { text: "What's my compensation this year?" });
    expect(outcome).toMatchObject({ passes: false, reason: "refused_subject" });

    const outcome2 = runRelevanceGate(storePath, PASSPHRASE, dir, { text: "Thanks so much!" });
    expect(outcome2).toMatchObject({ passes: false, reason: "noise" });

    const entries = listGateDecisions(storePath, PASSPHRASE);
    expect(entries.map((e) => e.reason)).toEqual(["refused_subject", "noise"]);
  });
});
