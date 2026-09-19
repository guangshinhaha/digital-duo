import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MalformedExportError, parseClaudeExport } from "../src/ingest/adapters/claude-export.js";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}

describe("parseClaudeExport — an export becomes records", () => {
  it("produces one record per message, with kind my_thinking, author distinguishing the turn, and the thread preserved", () => {
    const result = parseClaudeExport(fixture("claude-export-all-work.json"));
    expect(result.conversationCount).toBe(1);
    expect(result.workRelevantConversationCount).toBe(1);
    expect(result.records).toHaveLength(2);

    const [human, assistant] = result.records;
    expect(human.kind).toBe("my_thinking");
    expect(human.author).toBe("me");
    expect(assistant.kind).toBe("my_thinking");
    expect(assistant.author).toBe("assistant");
    expect(human.threadId).toBe("conv-1");
    expect(assistant.threadId).toBe("conv-1");
    expect(human.threadId).toBe(assistant.threadId);
    expect(human.source).toBe("claude-export");
    expect(human.audience).toBe("private");
    expect(human.classification).toBe("unknown");
    expect(human.topics).toEqual([]);
  });

  it("never produces a my_answer record — my_thinking is distinguishable from my_answer everywhere downstream", () => {
    const result = parseClaudeExport(fixture("claude-export-all-work.json"));
    expect(result.records.every((record) => record.kind === "my_thinking")).toBe(true);
    expect(result.records.some((record) => record.kind === "my_answer")).toBe(false);
  });
});

describe("parseClaudeExport — non-work content is filtered before derivation", () => {
  it("reports the work-relevant fraction and only writes records for that fraction", () => {
    const result = parseClaudeExport(fixture("claude-export-mixed.json"));
    expect(result.conversationCount).toBe(2);
    expect(result.workRelevantConversationCount).toBe(1);
    // Only conv-work's 2 messages become records; conv-personal contributes none.
    expect(result.records).toHaveLength(2);
    expect(result.records.every((record) => record.threadId === "conv-work")).toBe(true);
  });
});

describe("parseClaudeExport — a malformed or unrecognised export is refused", () => {
  it("names invalid JSON as the problem", () => {
    expect(() => parseClaudeExport("not json at all")).toThrow(MalformedExportError);
    expect(() => parseClaudeExport("not json at all")).toThrow(/export/i);
  });

  it("names a non-array top level as the problem", () => {
    expect(() => parseClaudeExport(fixture("claude-export-malformed.json"))).toThrow(MalformedExportError);
    expect(() => parseClaudeExport(fixture("claude-export-malformed.json"))).toThrow(/array/i);
  });

  it("names the offending conversation index when chat_messages is missing", () => {
    const broken = JSON.stringify([{ uuid: "conv-1" }]);
    expect(() => parseClaudeExport(broken)).toThrow(/index 0/);
  });
});
