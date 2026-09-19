import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findConflictingRefusal, readRefusalsFile } from "../src/trust/refusals.js";
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
