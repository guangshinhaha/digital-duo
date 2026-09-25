import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GateLabelsNotSyntheticError,
  InvalidGateLabelsError,
  loadGateLabels,
  loadGateLabelsForEgress,
} from "../src/eval/gate-labels.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "duo-gate-labels-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeLabels(value: unknown): string {
  const path = join(dir, "labels.json");
  writeFileSync(path, JSON.stringify(value), "utf8");
  return path;
}

describe("loadGateLabels — the hand-labelled set is checked in, so a missing/malformed file is a real problem", () => {
  it("refuses when the file doesn't exist at all, naming the path", () => {
    expect(() => loadGateLabels(join(dir, "nope.json"))).toThrow(InvalidGateLabelsError);
    expect(() => loadGateLabels(join(dir, "nope.json"))).toThrow(/nope\.json/);
  });

  it("loads a well-formed set", () => {
    const path = writeLabels([
      { id: "a", text: "can you review this?", mentionType: "genuine_question", expected: "answerable" },
      { id: "b", text: "thanks!", mentionType: "thanks", expected: "not_answerable" },
    ]);
    const labels = loadGateLabels(path);
    expect(labels).toEqual([
      { id: "a", text: "can you review this?", mentionType: "genuine_question", expected: "answerable" },
      { id: "b", text: "thanks!", mentionType: "thanks", expected: "not_answerable" },
    ]);
  });

  it("refuses a non-array top level", () => {
    const path = writeLabels({ not: "an array" });
    expect(() => loadGateLabels(path)).toThrow(InvalidGateLabelsError);
  });

  it("refuses an entry with a duplicate id", () => {
    const path = writeLabels([
      { id: "a", text: "one", mentionType: "fyi", expected: "not_answerable" },
      { id: "a", text: "two", mentionType: "fyi", expected: "not_answerable" },
    ]);
    expect(() => loadGateLabels(path)).toThrow(/duplicate/i);
  });

  it("refuses an entry with an invalid expected value", () => {
    const path = writeLabels([{ id: "a", text: "one", mentionType: "fyi", expected: "maybe" }]);
    expect(() => loadGateLabels(path)).toThrow(InvalidGateLabelsError);
  });

  it("refuses an entry missing a non-empty text", () => {
    const path = writeLabels([{ id: "a", text: "", mentionType: "fyi", expected: "not_answerable" }]);
    expect(() => loadGateLabels(path)).toThrow(InvalidGateLabelsError);
  });
});

describe("loadGateLabels — the real, checked-in eval/gate-labels.json (#36 AC: lives in the repo, versioned)", () => {
  it("loads and validates cleanly", () => {
    const realPath = fileURLToPath(new URL("../eval/gate-labels.json", import.meta.url));
    const labels = loadGateLabels(realPath);
    expect(labels.length).toBeGreaterThan(0);
    // Every id is unique and every entry has a non-empty mentionType — both
    // already enforced by loadGateLabels itself; this just pins that the
    // real fixture actually satisfies them, not only a synthetic one.
    expect(new Set(labels.map((label) => label.id)).size).toBe(labels.length);
  });
});

const ENVELOPE_ENTRIES = [
  { id: "a", text: "can you review this?", mentionType: "genuine_question", expected: "answerable" },
  { id: "b", text: "thanks!", mentionType: "thanks", expected: "not_answerable" },
];

describe("loadGateLabels — dual shape: legacy array and {provenance, items} envelope both load", () => {
  it("loads the {provenance:{synthetic:true}, items:[...]} envelope identically to a legacy array", () => {
    const path = writeLabels({ provenance: { synthetic: true }, items: ENVELOPE_ENTRIES });
    expect(loadGateLabels(path)).toEqual(ENVELOPE_ENTRIES);
  });

  it("loads an envelope whose provenance is absent or not synthetic — declaration matters only to the egress loader", () => {
    expect(loadGateLabels(writeLabels({ items: ENVELOPE_ENTRIES }))).toEqual(ENVELOPE_ENTRIES);
    expect(loadGateLabels(writeLabels({ provenance: { synthetic: false }, items: ENVELOPE_ENTRIES }))).toEqual(
      ENVELOPE_ENTRIES,
    );
  });

  it("refuses an object with no items array, naming both accepted shapes", () => {
    expect(() => loadGateLabels(writeLabels({ provenance: { synthetic: true } }))).toThrow(InvalidGateLabelsError);
    expect(() => loadGateLabels(writeLabels({ provenance: { synthetic: true }, items: "nope" }))).toThrow(/items/);
  });
});

describe("loadGateLabelsForEgress — the R9 gate: only declared-synthetic labels reach the hosted gateway", () => {
  it("loads the synthetic envelope", () => {
    const path = writeLabels({ provenance: { synthetic: true }, items: ENVELOPE_ENTRIES });
    expect(loadGateLabelsForEgress(path)).toEqual(ENVELOPE_ENTRIES);
  });

  it("refuses a legacy bare array — no declaration means no egress", () => {
    const path = writeLabels(ENVELOPE_ENTRIES);
    expect(() => loadGateLabelsForEgress(path)).toThrow(GateLabelsNotSyntheticError);
    expect(() => loadGateLabelsForEgress(path)).toThrow(/synthetic/);
    expect(() => loadGateLabelsForEgress(path)).toThrow(/R9/);
  });

  it("refuses provenance that does not declare synthetic: true exactly", () => {
    for (const provenance of [{ synthetic: false }, { synthetic: "yes" }, {}]) {
      const path = writeLabels({ provenance, items: ENVELOPE_ENTRIES });
      expect(() => loadGateLabelsForEgress(path)).toThrow(GateLabelsNotSyntheticError);
    }
  });

  it("still validates entries after the provenance check — a synthetic-declared file with a bad entry refuses", () => {
    const path = writeLabels({
      provenance: { synthetic: true },
      items: [{ id: "a", text: "one", mentionType: "fyi", expected: "maybe" }],
    });
    expect(() => loadGateLabelsForEgress(path)).toThrow(InvalidGateLabelsError);
  });

  it("the real, checked-in eval/gate-labels.json passes the egress gate — stage 1 can load it", () => {
    const realPath = fileURLToPath(new URL("../eval/gate-labels.json", import.meta.url));
    expect(loadGateLabelsForEgress(realPath).length).toBe(47);
  });
});
