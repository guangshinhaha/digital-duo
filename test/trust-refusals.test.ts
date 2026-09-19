import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  InvalidRefusalError,
  confirmNoRefusals,
  findConflictingRefusal,
  findRefusalByHeading,
  hasRefusalsDecision,
  readRefusalsFile,
  requireRefusalsDecision,
  RefusalsNotDecidedError,
  upsertRefusal,
  writeRefusalsFile,
} from "../src/trust/refusals.js";
import { writeTopicsFile } from "../src/derivation/topics.js";
import { useTempDir } from "./helpers/temp-dir.js";

const tempDir = useTempDir();

function duoDir(): string {
  return join(tempDir(), "duo");
}

function writeRefusals(text: string): void {
  mkdirSync(duoDir(), { recursive: true });
  writeFileSync(join(duoDir(), "refusals.md"), text, "utf8");
}

describe("readRefusalsFile", () => {
  it("returns [] when the file doesn't exist yet", () => {
    expect(readRefusalsFile(duoDir())).toEqual([]);
  });

  it("parses one section per ## heading, with the body as the reason", () => {
    writeRefusals(
      [
        "# Refusals",
        "",
        "Things this duo will never do autonomously.",
        "",
        "## Headcount",
        "",
        "Never speak for me on comp, headcount, or anything touching a renewal.",
        "",
        "## Prod exceptions",
        "",
        "Always push back, never approve.",
        "",
      ].join("\n"),
    );

    const refusals = readRefusalsFile(duoDir());
    expect(refusals).toEqual([
      { heading: "Headcount", reason: "Never speak for me on comp, headcount, or anything touching a renewal." },
      { heading: "Prod exceptions", reason: "Always push back, never approve." },
    ]);
  });

  it("drops the preamble before the first heading", () => {
    writeRefusals("Some intro text with no heading at all.\n\n## Only heading\nreason text\n");
    expect(readRefusalsFile(duoDir())).toEqual([{ heading: "Only heading", reason: "reason text" }]);
  });
});

describe("findConflictingRefusal", () => {
  it("matches a topic by its current label, case-insensitively", () => {
    writeTopicsFile(duoDir(), [{ id: "topic-1", label: "Headcount", createdAt: "2026-01-01T00:00:00.000Z" }]);
    writeRefusals("## headcount\nNever speak for me on this.\n");

    const conflict = findConflictingRefusal(duoDir(), "topic-1");
    expect(conflict?.heading).toBe("headcount");
  });

  it("also matches by topic id directly", () => {
    writeRefusals("## topic-1\nreason\n");
    const conflict = findConflictingRefusal(duoDir(), "topic-1", "Some unrelated label");
    expect(conflict?.heading).toBe("topic-1");
  });

  it("returns undefined when nothing conflicts", () => {
    writeTopicsFile(duoDir(), [{ id: "topic-1", label: "Headcount", createdAt: "2026-01-01T00:00:00.000Z" }]);
    writeRefusals("## Something else entirely\nreason\n");
    expect(findConflictingRefusal(duoDir(), "topic-1")).toBeUndefined();
  });

  it("returns undefined when there is no refusals.md at all", () => {
    writeTopicsFile(duoDir(), [{ id: "topic-1", label: "Headcount", createdAt: "2026-01-01T00:00:00.000Z" }]);
    expect(findConflictingRefusal(duoDir(), "topic-1")).toBeUndefined();
  });
});

describe("hasRefusalsDecision / requireRefusalsDecision — the onboarding gate (#29 AC2)", () => {
  it("is false, and the gate throws, before duo/refusals.md exists at all", () => {
    expect(hasRefusalsDecision(duoDir())).toBe(false);
    expect(() => requireRefusalsDecision(duoDir())).toThrow(RefusalsNotDecidedError);
  });

  it("is true once the owner has recorded a real refusal", () => {
    upsertRefusal(duoDir(), "Headcount", "Never speak for me on this.");
    expect(hasRefusalsDecision(duoDir())).toBe(true);
    expect(() => requireRefusalsDecision(duoDir())).not.toThrow();
  });

  it("is true once the owner has deliberately confirmed there are none — a real, recorded choice, not a default", () => {
    confirmNoRefusals(duoDir());
    expect(hasRefusalsDecision(duoDir())).toBe(true);
    expect(readRefusalsFile(duoDir())).toEqual([]);
    expect(existsSync(join(duoDir(), "refusals.md"))).toBe(true);
  });
});

describe("upsertRefusal — AC1: a refusal is captured to duo/refusals.md", () => {
  it("writes a new refusal that readRefusalsFile then returns", () => {
    const refusals = upsertRefusal(duoDir(), "Headcount", "Never speak for me on comp or headcount.");
    expect(refusals).toEqual([{ heading: "Headcount", reason: "Never speak for me on comp or headcount." }]);
    expect(readRefusalsFile(duoDir())).toEqual(refusals);
  });

  it("edits an existing refusal's reason in place, case-insensitively, rather than duplicating it", () => {
    upsertRefusal(duoDir(), "Headcount", "First reason.");
    const updated = upsertRefusal(duoDir(), "HEADCOUNT", "Updated reason.");
    expect(updated).toEqual([{ heading: "HEADCOUNT", reason: "Updated reason." }]);
    expect(readRefusalsFile(duoDir())).toHaveLength(1);
  });

  it("keeps other refusals untouched when adding a new one", () => {
    upsertRefusal(duoDir(), "Headcount", "reason one");
    upsertRefusal(duoDir(), "Prod exceptions", "reason two");
    expect(readRefusalsFile(duoDir()).map((r) => r.heading)).toEqual(["Headcount", "Prod exceptions"]);
  });

  it("rejects an empty heading or reason", () => {
    expect(() => upsertRefusal(duoDir(), "  ", "a reason")).toThrow(InvalidRefusalError);
    expect(() => upsertRefusal(duoDir(), "Headcount", "  ")).toThrow(InvalidRefusalError);
  });
});

describe("confirmNoRefusals — AC2: choosing none is a deliberate recorded choice", () => {
  it("refuses to discard refusals that already exist", () => {
    upsertRefusal(duoDir(), "Headcount", "reason");
    expect(() => confirmNoRefusals(duoDir())).toThrow(InvalidRefusalError);
    expect(readRefusalsFile(duoDir())).toHaveLength(1); // untouched
  });
});

describe("findRefusalByHeading — matching a label before its topic exists (rule-review.ts's writeRuleByHand)", () => {
  it("matches case-insensitively", () => {
    upsertRefusal(duoDir(), "Expense approvals", "Never approve expenses alone.");
    expect(findRefusalByHeading(duoDir(), "expense approvals")?.reason).toBe("Never approve expenses alone.");
    expect(findRefusalByHeading(duoDir(), "something else")).toBeUndefined();
  });
});

describe("writeRefusalsFile — round-trips through readRefusalsFile", () => {
  it("writes a file readRefusalsFile parses back to the same refusals", () => {
    const refusals = [
      { heading: "Headcount", reason: "Never speak on comp." },
      { heading: "Prod exceptions", reason: "Always push back." },
    ];
    writeRefusalsFile(duoDir(), refusals);
    expect(readRefusalsFile(duoDir())).toEqual(refusals);
  });
});
