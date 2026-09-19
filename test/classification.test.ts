import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRecord, type RecordInput } from "../src/ingest/record.js";
import { getRecord, listRecords, searchRecords, writeRecords } from "../src/ingest/record-store.js";
import { ingestRecords } from "../src/ingest/two-phase.js";
import {
  DEFAULT_CLASSIFICATION_CEILING,
  enforceClassificationCeiling,
  InvalidClassificationCeilingError,
  isVisibleToClearance,
  isWithinCeiling,
  parseClassificationCeiling,
} from "../src/permissions/classification.js";
import { createEncryptedStore } from "../src/store/store.js";
import { useTempDir } from "./helpers/temp-dir.js";

const tempDir = useTempDir();
const PASSPHRASE = "pw";

function initStore(): string {
  const storePath = join(tempDir(), "data", "duo.db");
  createEncryptedStore(storePath, PASSPHRASE);
  return storePath;
}

let counter = 0;
function recordInput(overrides: Partial<RecordInput> & { text: string }): RecordInput {
  counter += 1;
  return {
    source: "test",
    sourceRef: null,
    kind: "my_answer",
    author: "me",
    timestamp: `2026-01-01T00:00:${String(counter).padStart(2, "0")}.000Z`,
    threadId: `t${counter}`,
    audience: "channel",
    ...overrides,
  };
}

describe("parseClassificationCeiling", () => {
  it("accepts every real classification level", () => {
    for (const level of ["official_open", "official_closed", "restricted", "confidential", "secret"]) {
      expect(parseClassificationCeiling(level)).toBe(level);
    }
  });

  it("rejects an unknown value, and rejects 'unknown' itself — the ceiling is a policy choice among marked levels only", () => {
    expect(() => parseClassificationCeiling("top-secret")).toThrow(InvalidClassificationCeilingError);
    expect(() => parseClassificationCeiling("unknown")).toThrow(InvalidClassificationCeilingError);
  });

  it("defaults to the most conservative real-world default, not the most permissive", () => {
    expect(DEFAULT_CLASSIFICATION_CEILING).toBe("official_open");
  });
});

describe("isWithinCeiling", () => {
  it("admits a record at or below the ceiling, refuses one above it", () => {
    expect(isWithinCeiling("official_open", "restricted")).toBe(true);
    expect(isWithinCeiling("restricted", "restricted")).toBe(true);
    expect(isWithinCeiling("confidential", "restricted")).toBe(false);
    expect(isWithinCeiling("secret", "official_open")).toBe(false);
  });

  it("always admits 'unknown' — unmarked material is exempt from ceiling-based ingest exclusion (#48 AC2)", () => {
    expect(isWithinCeiling("unknown", "official_open")).toBe(true);
  });
});

describe("isVisibleToClearance", () => {
  it("admits a record at or below the asker's clearance, refuses one above it", () => {
    expect(isVisibleToClearance("official_open", "restricted")).toBe(true);
    expect(isVisibleToClearance("confidential", "restricted")).toBe(false);
  });

  it("never defaults 'unknown' material to the most permissive value — it requires top clearance, the opposite", () => {
    expect(isVisibleToClearance("unknown", "official_open")).toBe(false);
    expect(isVisibleToClearance("unknown", "confidential")).toBe(false);
    expect(isVisibleToClearance("unknown", "secret")).toBe(true);
  });
});

describe("ingestRecords — classification above the ceiling is never written to the store (#48 AC1)", () => {
  it("stages an above-ceiling record in phase A but discards it in phase B; no read path ever surfaces it", () => {
    const storePath = initStore();
    const openRecord = createRecord(recordInput({ text: "OFFICIAL (OPEN)\nfine for everyone" }));
    const secretRecord = createRecord(recordInput({ text: "SECRET\nthe launch date is the 3rd" }));
    const outcome = ingestRecords(storePath, PASSPHRASE, [openRecord, secretRecord], { ceiling: "official_open" });

    expect(outcome.staged).toBe(2);
    expect(outcome.written).toBe(1);
    expect(outcome.discardedAboveCeiling).toBe(1);

    const stored = listRecords(storePath, PASSPHRASE);
    expect(stored).toHaveLength(1);
    expect(stored[0].classification).toBe("official_open");

    // No code path can read the excluded record — not by id, not by search.
    expect(getRecord(storePath, PASSPHRASE, secretRecord.id)).toBeUndefined();
    expect(searchRecords(storePath, PASSPHRASE, "launch date")).toEqual([]);
  });

  it("unmarked ('unknown') material is retained even under the strictest ceiling — it's recorded, not silently open (#48 AC2)", () => {
    const storePath = initStore();
    const outcome = ingestRecords(storePath, PASSPHRASE, [createRecord(recordInput({ text: "no marking here at all" }))], {
      ceiling: "official_open",
    });
    expect(outcome.discardedAboveCeiling).toBe(0);
    expect(outcome.written).toBe(1);
    expect(listRecords(storePath, PASSPHRASE)[0].classification).toBe("unknown");
  });

  it("defaults to DEFAULT_CLASSIFICATION_CEILING when no ceiling option is passed", () => {
    const storePath = initStore();
    const outcome = ingestRecords(storePath, PASSPHRASE, [createRecord(recordInput({ text: "SECRET\nvery sensitive" }))]);
    expect(outcome.discardedAboveCeiling).toBe(1);
    expect(outcome.written).toBe(0);
  });
});

describe("enforceClassificationCeiling — a ceiling change re-evaluates the corpus (#48 AC3)", () => {
  it("removes material that sits above a newly-lowered ceiling and reports it, leaving compliant material untouched", () => {
    const storePath = initStore();
    const restricted = createRecord(recordInput({ text: "RESTRICTED\nteam roster" }));
    const secret = createRecord(recordInput({ text: "SECRET\nthe launch date is the 3rd" }));
    const unmarked = createRecord(recordInput({ text: "no marking here at all" }));
    writeRecords(storePath, PASSPHRASE, [restricted, secret, unmarked]);

    const outcome = enforceClassificationCeiling(storePath, PASSPHRASE, "restricted");
    expect(outcome.removed).toBe(1);
    expect(outcome.removedIds).toEqual([secret.id]);

    expect(getRecord(storePath, PASSPHRASE, secret.id)).toBeUndefined();
    expect(getRecord(storePath, PASSPHRASE, restricted.id)).toBeDefined();
    // Unknown material is exempt from ceiling re-evaluation — a ceiling
    // change is a policy decision about marked material only.
    expect(getRecord(storePath, PASSPHRASE, unmarked.id)).toBeDefined();
  });

  it("removes nothing, and reports zero, when the whole corpus already sits within the ceiling", () => {
    const storePath = initStore();
    writeRecords(storePath, PASSPHRASE, [createRecord(recordInput({ text: "OFFICIAL (OPEN)\nfine for everyone" }))]);
    const outcome = enforceClassificationCeiling(storePath, PASSPHRASE, "secret");
    expect(outcome).toEqual({ removed: 0, removedIds: [] });
  });
});
