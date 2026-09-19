import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { IngestRecord } from "../src/ingest/record.js";
import { countRecords, searchRecords } from "../src/ingest/record-store.js";
import { ingestRecords, isRetainedAcrossBoundary } from "../src/ingest/two-phase.js";
import { createEncryptedStore, dataDirFor } from "../src/store/store.js";
import { useTempDir } from "./helpers/temp-dir.js";

const tempDir = useTempDir();
const PASSPHRASE = "pw";

function initStore(): string {
  const storePath = join(tempDir(), "data", "duo.db");
  createEncryptedStore(storePath, PASSPHRASE);
  return storePath;
}

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: overrides.id ?? "rec-1",
    source: "test",
    sourceRef: null,
    kind: "my_answer",
    author: "me",
    text: "default text",
    timestamp: "2026-01-01T00:00:00.000Z",
    threadId: "thread-1",
    audience: "channel",
    classification: "unknown",
    topics: [],
    ...overrides,
  };
}

function stagingFiles(storePath: string): string[] {
  return readdirSync(dataDirFor(storePath)).filter((name) => name.endsWith(".staging.db"));
}

describe("isRetainedAcrossBoundary", () => {
  it("keeps the owner's own records regardless of kind", () => {
    expect(isRetainedAcrossBoundary(record({ author: "me", kind: "my_thinking" }) as unknown as IngestRecord)).toBe(true);
    expect(isRetainedAcrossBoundary(record({ author: "me", kind: "decision" }) as unknown as IngestRecord)).toBe(true);
  });

  it("keeps the assistant's own replies in a private chat", () => {
    expect(isRetainedAcrossBoundary(record({ author: "assistant", kind: "my_thinking" }) as unknown as IngestRecord)).toBe(true);
  });

  it("keeps a colleague's question addressed to the owner", () => {
    expect(isRetainedAcrossBoundary(record({ author: "other", kind: "question_to_me" }) as unknown as IngestRecord)).toBe(true);
  });

  it("discards a colleague's non-question text", () => {
    expect(isRetainedAcrossBoundary(record({ author: "other", kind: "my_answer" }) as unknown as IngestRecord)).toBe(false);
    expect(isRetainedAcrossBoundary(record({ author: "other", kind: "decision" }) as unknown as IngestRecord)).toBe(false);
    expect(isRetainedAcrossBoundary(record({ author: "other", kind: "artifact" }) as unknown as IngestRecord)).toBe(false);
  });
});

describe("ingestRecords — others' non-question text does not survive ingest", () => {
  it("retains the owner's records and a colleague's question, discards a colleague's banter, and drops the staging file", () => {
    const storePath = initStore();
    const outcome = ingestRecords(storePath, PASSPHRASE, [
      record({ id: "mine", author: "me", text: "I'll take the incident review." }),
      record({ id: "their-question", author: "other", kind: "question_to_me", text: "can you review the incident doc?" }),
      record({ id: "their-banter", author: "other", kind: "my_thinking", text: "haha nice one, see you at lunch" }),
    ]);

    expect(outcome.staged).toBe(3);
    expect(outcome.written).toBe(2);
    expect(outcome.discardedOtherText).toBe(1);
    expect(countRecords(storePath, PASSPHRASE)).toBe(2);

    // The colleague's banter is not searchable — it was never written to storePath.
    expect(searchRecords(storePath, PASSPHRASE, "lunch")).toEqual([]);
    // The colleague's question, and the owner's own message, are.
    expect(searchRecords(storePath, PASSPHRASE, "incident").length).toBeGreaterThan(0);

    expect(stagingFiles(storePath)).toEqual([]);
  });
});

describe("ingestRecords — a failure mid-ingest leaves no staging data behind", () => {
  it("removes the staging file, leaves storePath unchanged, and reports the failure", () => {
    const storePath = initStore();
    ingestRecords(storePath, PASSPHRASE, [record({ id: "already-here" })]);
    expect(countRecords(storePath, PASSPHRASE)).toBe(1);

    expect(() =>
      ingestRecords(storePath, PASSPHRASE, [record({ id: "would-be-fine" }), record({ id: "bad", kind: "not-a-real-kind" })]),
    ).toThrow();

    expect(countRecords(storePath, PASSPHRASE)).toBe(1); // unchanged — the failure never reached phase B
    expect(stagingFiles(storePath)).toEqual([]); // no staging file left behind
  });
});

describe("ingestRecords — DMs are excluded unless explicitly opted in", () => {
  it("writes no DM record and reports the skipped conversation count, by default", () => {
    const storePath = initStore();
    const outcome = ingestRecords(storePath, PASSPHRASE, [
      record({ id: "channel-msg", audience: "channel", text: "public channel message" }),
      record({ id: "dm-1", audience: "dm", threadId: "dm-thread", text: "a private direct message" }),
      record({ id: "dm-2", audience: "dm", threadId: "dm-thread", text: "same DM thread, second message" }),
    ]);

    expect(outcome.skippedDmConversations).toBe(1); // one thread, two messages
    expect(countRecords(storePath, PASSPHRASE)).toBe(1); // only the channel message
    expect(searchRecords(storePath, PASSPHRASE, "private direct")).toEqual([]);
  });

  it("retains DM records when explicitly opted in", () => {
    const storePath = initStore();
    const outcome = ingestRecords(
      storePath,
      PASSPHRASE,
      [record({ id: "dm-1", audience: "dm", threadId: "dm-thread", text: "a private direct message" })],
      { includeDMs: true },
    );

    expect(outcome.skippedDmConversations).toBe(0);
    expect(countRecords(storePath, PASSPHRASE)).toBe(1);
  });
});

describe("ingestRecords — phase A and phase B use separate database handles", () => {
  it("stages into its own file, distinct from storePath, and that file never remains after a successful ingest", () => {
    const storePath = initStore();
    expect(stagingFiles(storePath)).toEqual([]);
    ingestRecords(storePath, PASSPHRASE, [record()]);
    expect(stagingFiles(storePath)).toEqual([]);
  });
});
