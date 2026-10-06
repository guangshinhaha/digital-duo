import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  InvalidRefusalError,
  confirmNoRefusals,
  deriveNeverAnswerSubject,
  findConflictingRefusal,
  findRefusalByHeading,
  hasRefusalsDecision,
  parseNeverAnswerInput,
  readRefusalsFile,
  removeNeverAnswerRule,
  renameNeverAnswerRule,
  requireRefusalsDecision,
  RefusalConflictError,
  RefusalNotFoundError,
  RefusalsNotDecidedError,
  saveNeverAnswerRule,
  suggestNeverAnswerSubject,
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

describe("deriveNeverAnswerSubject — #269: the subject read off the owner's own sentence", () => {
  it("strips the common 'I never answer about X' frame", () => {
    expect(deriveNeverAnswerSubject("I never answer about budget approvals")).toBe("budget approvals");
  });

  it("strips 'I don't answer questions about X'", () => {
    expect(deriveNeverAnswerSubject("I don't answer questions about salary bands.")).toBe("salary bands");
  });

  it("strips 'won't discuss X'", () => {
    expect(deriveNeverAnswerSubject("I won't discuss layoffs")).toBe("layoffs");
  });

  it("falls back to the whole sentence when no frame matches", () => {
    expect(deriveNeverAnswerSubject("budget approvals")).toBe("budget approvals");
  });

  it("truncates an unreasonably long subject", () => {
    const long = "x".repeat(200);
    const subject = deriveNeverAnswerSubject(long);
    expect(subject.length).toBeLessThanOrEqual(80);
    expect(subject.endsWith("...")).toBe(true);
  });
});

describe("suggestNeverAnswerSubject — #259 → #269: starting words off a dismissed question", () => {
  it("strips a leading 'what is' and the trailing '?'", () => {
    expect(suggestNeverAnswerSubject("What is the budget for the marketing campaign?")).toBe("the budget for the marketing campaign");
  });

  it("strips 'how much' questions", () => {
    expect(suggestNeverAnswerSubject("How much does the team spend on contractors?")).toBe("the team spend on contractors");
  });

  it("falls back to the question verbatim when no opener matches", () => {
    expect(suggestNeverAnswerSubject("Budget approvals.")).toBe("Budget approvals.".replace(/[?]+$/, "").trim());
  });
});

describe("parseNeverAnswerInput — the wire shape POST/PUT /mirror/refusals accept", () => {
  it("reads { rule } as heading-from-sentence plus the sentence kept as the reason", () => {
    expect(parseNeverAnswerInput({ rule: "I never answer about budget approvals" })).toEqual({
      heading: "budget approvals",
      reason: "I never answer about budget approvals",
    });
  });

  it("reads { subject, reason? } directly, defaulting a missing reason to empty", () => {
    expect(parseNeverAnswerInput({ subject: "Budget approvals", reason: "Finance owns this." })).toEqual({
      heading: "Budget approvals",
      reason: "Finance owns this.",
    });
    expect(parseNeverAnswerInput({ subject: "Budget approvals" })).toEqual({ heading: "Budget approvals", reason: "" });
  });

  it("rejects a blank rule, a blank subject, or an unrecognised shape", () => {
    expect(() => parseNeverAnswerInput({ rule: "   " })).toThrow(InvalidRefusalError);
    expect(() => parseNeverAnswerInput({ subject: "  " })).toThrow(InvalidRefusalError);
    expect(() => parseNeverAnswerInput({})).toThrow(InvalidRefusalError);
    expect(() => parseNeverAnswerInput(null)).toThrow(InvalidRefusalError);
    expect(() => parseNeverAnswerInput("a string")).toThrow(InvalidRefusalError);
  });
});

describe("saveNeverAnswerRule — POST /mirror/refusals: add, or edit an existing subject in place", () => {
  it("adds a new rule from a free-text sentence", () => {
    const refusals = saveNeverAnswerRule(duoDir(), { rule: "I never answer about budget approvals" });
    expect(refusals).toEqual([{ heading: "budget approvals", reason: "I never answer about budget approvals" }]);
  });

  it("allows an empty reason — the proactive-offer flow sends { subject } alone", () => {
    const refusals = saveNeverAnswerRule(duoDir(), { subject: "budget approvals" });
    expect(refusals).toEqual([{ heading: "budget approvals", reason: "" }]);
  });

  it("adding an existing subject (case-insensitively) edits it in place rather than duplicating it", () => {
    saveNeverAnswerRule(duoDir(), { subject: "Budget approvals", reason: "first" });
    const updated = saveNeverAnswerRule(duoDir(), { subject: "BUDGET APPROVALS", reason: "second" });
    expect(updated).toEqual([{ heading: "BUDGET APPROVALS", reason: "second" }]);
    expect(readRefusalsFile(duoDir())).toHaveLength(1);
  });
});

describe("renameNeverAnswerRule — PUT /mirror/refusals/:heading", () => {
  it("renames and rewords a rule in place", () => {
    saveNeverAnswerRule(duoDir(), { subject: "Budget approvals", reason: "old reason" });
    const updated = renameNeverAnswerRule(duoDir(), "Budget approvals", { subject: "Headcount", reason: "new reason" });
    expect(updated).toEqual([{ heading: "Headcount", reason: "new reason" }]);
  });

  it("404s (RefusalNotFoundError) for an unknown heading", () => {
    expect(() => renameNeverAnswerRule(duoDir(), "Nope", { subject: "x" })).toThrow(RefusalNotFoundError);
  });

  it("400s (RefusalConflictError) renaming onto a DIFFERENT existing rule's subject", () => {
    saveNeverAnswerRule(duoDir(), { subject: "Budget approvals" });
    saveNeverAnswerRule(duoDir(), { subject: "Headcount" });
    expect(() => renameNeverAnswerRule(duoDir(), "Budget approvals", { subject: "Headcount" })).toThrow(RefusalConflictError);
  });

  it("renaming a rule onto its own current subject (just rewording) is not a conflict", () => {
    saveNeverAnswerRule(duoDir(), { subject: "Budget approvals", reason: "old" });
    const updated = renameNeverAnswerRule(duoDir(), "Budget approvals", { subject: "Budget approvals", reason: "new" });
    expect(updated).toEqual([{ heading: "Budget approvals", reason: "new" }]);
  });
});

describe("removeNeverAnswerRule — DELETE /mirror/refusals/:heading", () => {
  it("removes one rule, leaving the others and decided: true", () => {
    saveNeverAnswerRule(duoDir(), { subject: "Budget approvals" });
    saveNeverAnswerRule(duoDir(), { subject: "Headcount" });
    const updated = removeNeverAnswerRule(duoDir(), "Budget approvals");
    expect(updated).toEqual([{ heading: "Headcount", reason: "" }]);
  });

  it("removing the last one leaves decided: true (the file still exists, just empty)", () => {
    saveNeverAnswerRule(duoDir(), { subject: "Budget approvals" });
    removeNeverAnswerRule(duoDir(), "Budget approvals");
    expect(hasRefusalsDecision(duoDir())).toBe(true);
    expect(readRefusalsFile(duoDir())).toEqual([]);
  });

  it("404s (RefusalNotFoundError) for an unknown heading", () => {
    expect(() => removeNeverAnswerRule(duoDir(), "Nope")).toThrow(RefusalNotFoundError);
  });
});
