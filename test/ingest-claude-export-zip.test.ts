import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { extractConversationsJson } from "../src/ingest/adapters/claude-export-zip.js";
import { MalformedExportError } from "../src/ingest/adapters/claude-export.js";

function zipOf(entries: Record<string, string>): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  for (const [name, contents] of Object.entries(entries)) {
    files[name] = strToU8(contents);
  }
  return zipSync(files, { level: 0 });
}

describe("extractConversationsJson", () => {
  it("returns conversations.json's contents from a top-level zip entry", () => {
    const json = JSON.stringify([{ uuid: "a", chat_messages: [] }]);
    const zip = zipOf({ "conversations.json": json, "users.json": "{}" });

    expect(extractConversationsJson(zip)).toBe(json);
  });

  it("finds conversations.json nested a directory deep", () => {
    const json = JSON.stringify([{ uuid: "a", chat_messages: [] }]);
    const zip = zipOf({ "export/conversations.json": json });

    expect(extractConversationsJson(zip)).toBe(json);
  });

  it("refuses a file that isn't a zip at all", () => {
    const notAZip = new TextEncoder().encode("hello, I am definitely not a zip file");

    expect(() => extractConversationsJson(notAZip)).toThrow(MalformedExportError);
  });

  it("refuses a zip with no conversations.json inside", () => {
    const zip = zipOf({ "users.json": "{}", "projects.json": "[]" });

    let thrown: unknown;
    try {
      extractConversationsJson(zip);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MalformedExportError);
    expect((thrown as Error).message).toMatch(/conversations\.json/);
    expect((thrown as Error).message).toMatch(/users\.json/);
  });

  it("refuses an empty zip", () => {
    const zip = zipOf({});

    expect(() => extractConversationsJson(zip)).toThrow(MalformedExportError);
  });
});
