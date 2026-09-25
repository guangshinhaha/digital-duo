import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  InvalidJevFixtureError,
  fixtureSha256,
  loadJevMultiwayTasks,
  loadJevTraces,
} from "../src/eval/jev-fixtures.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A minimal well-formed fixture document the mutation helpers below break in exactly one way each. */
function validTasksDoc(): Record<string, unknown> {
  const task = (id: string, correct: string) => ({
    id,
    scenario: "A synthetic scenario sentence.",
    goal: "A synthetic goal sentence.",
    candidates: [
      { id: "a", description: "Option A" },
      { id: "b", description: "Option B" },
      { id: "c", description: "Option C" },
      { id: "d", description: "Option D" },
    ],
    correct,
  });
  return { provenance: { synthetic: true }, items: [task("t1", "a"), task("t2", "b")] };
}

function writeTasksFile(mutate: (doc: Record<string, unknown>) => void): string {
  const doc = validTasksDoc();
  mutate(doc);
  return writeTemp("tasks.json", doc);
}

function writeTracesFile(mutate: (doc: Record<string, unknown>) => void): string {
  const doc: Record<string, unknown> = {
    provenance: { synthetic: true },
    items: [
      {
        id: "r1",
        goal: "A synthetic trace goal.",
        steps: [
          {
            page: "A synthetic page state.",
            candidates: [
              { id: "next", description: "Continue" },
              { id: "back", description: "Go back" },
              { id: "home", description: "Home" },
            ],
            correct: "next",
          },
        ],
      },
    ],
  };
  mutate(doc);
  return writeTemp("traces.json", doc);
}

function writeTemp(name: string, doc: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "jev-fixtures-"));
  tempDirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(doc));
  return path;
}

describe("loadJevMultiwayTasks — the checked-in fixture loads whole (R8/KTD11)", () => {
  it("loads all 20 authored tasks, each with 4–6 candidates and a correct pick among them", () => {
    const tasks = loadJevMultiwayTasks("eval/jev-multiway-tasks.json");
    expect(tasks).toHaveLength(20);
    for (const task of tasks) {
      expect(task.candidates.length).toBeGreaterThanOrEqual(4);
      expect(task.candidates.length).toBeLessThanOrEqual(6);
      expect(task.candidates.map((c) => c.id)).toContain(task.correct);
    }
    expect(new Set(tasks.map((t) => t.id)).size).toBe(20);
  });

  it("refuses a file whose provenance does not declare synthetic content (R9: egress eligibility is declared, not assumed)", () => {
    const path = writeTasksFile((doc) => {
      (doc.provenance as Record<string, unknown>).synthetic = false;
    });
    expect(() => loadJevMultiwayTasks(path)).toThrow(InvalidJevFixtureError);
    expect(() => loadJevMultiwayTasks(path)).toThrow(/synthetic/i);
  });
});

describe("loadJevMultiwayTasks — fail loud, name the offender", () => {
  it("names the configured path when the file is missing", () => {
    const path = join(tmpdir(), "jev-fixtures-no-such-file.json");
    expect(() => loadJevMultiwayTasks(path)).toThrow(InvalidJevFixtureError);
    expect(() => loadJevMultiwayTasks(path)).toThrow(new RegExp(path.replaceAll("/", "\\/")));
  });

  it("rejects a root that is not an object (array root)", () => {
    const path = writeTemp("array-root.json", [validTasksDoc().items]);
    expect(() => loadJevMultiwayTasks(path)).toThrow(/expected a JSON object/i);
  });

  it("rejects items that is not an array, and an empty items array", () => {
    const notArray = writeTasksFile((doc) => {
      doc.items = { t1: "nope" };
    });
    expect(() => loadJevMultiwayTasks(notArray)).toThrow(/items.*array/i);
    const empty = writeTasksFile((doc) => {
      doc.items = [];
    });
    expect(() => loadJevMultiwayTasks(empty)).toThrow(/empty/i);
  });

  it("names the offending entry for a missing required field, and the index when the id itself is missing", () => {
    const path = writeTasksFile((doc) => {
      delete (doc.items as Record<string, unknown>[])[1].scenario;
    });
    expect(() => loadJevMultiwayTasks(path)).toThrow(/t2/);
    expect(() => loadJevMultiwayTasks(path)).toThrow(/scenario/);
    const noId = writeTasksFile((doc) => {
      delete (doc.items as Record<string, unknown>[])[1].id;
    });
    expect(() => loadJevMultiwayTasks(noId)).toThrow(/index 1/);
  });

  it("names the item id when `correct` is not one of its candidates", () => {
    const path = writeTasksFile((doc) => {
      (doc.items as Record<string, unknown>[])[0].correct = "not-a-candidate";
    });
    expect(() => loadJevMultiwayTasks(path)).toThrow(/t1/);
    expect(() => loadJevMultiwayTasks(path)).toThrow(/correct/);
  });

  it("names the duplicated id", () => {
    const path = writeTasksFile((doc) => {
      (doc.items as Record<string, unknown>[])[1].id = "t1";
    });
    expect(() => loadJevMultiwayTasks(path)).toThrow(/t1/);
    expect(() => loadJevMultiwayTasks(path)).toThrow(/duplicate/i);
  });

  it("rejects a malformed JSON file with the path named", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-fixtures-"));
    tempDirs.push(dir);
    const path = join(dir, "broken.json");
    writeFileSync(path, "{ not json");
    expect(() => loadJevMultiwayTasks(path)).toThrow(InvalidJevFixtureError);
  });
});

describe("loadJevTraces — the checked-in fixture loads whole", () => {
  it("loads all 8 authored traces with 3–5 steps each, every step's correct id among its candidates", () => {
    const traces = loadJevTraces("eval/jev-traces.json");
    expect(traces).toHaveLength(8);
    for (const trace of traces) {
      expect(trace.steps.length).toBeGreaterThanOrEqual(3);
      expect(trace.steps.length).toBeLessThanOrEqual(5);
      for (const step of trace.steps) {
        expect(step.candidates.map((c) => c.id)).toContain(step.correct);
      }
    }
    expect(new Set(traces.map((t) => t.id)).size).toBe(8);
  });

  it("rejects a trace step whose correct id is not among that step's candidates, naming trace and step index", () => {
    const path = writeTracesFile((doc) => {
      const trace = (doc.items as Record<string, unknown>[])[0];
      (trace.steps as Record<string, unknown>[])[0].correct = "teleport";
    });
    expect(() => loadJevTraces(path)).toThrow(/r1/);
    expect(() => loadJevTraces(path)).toThrow(/step 0/);
  });

  it("rejects a trace with no steps", () => {
    const path = writeTracesFile((doc) => {
      ((doc.items as Record<string, unknown>[])[0].steps as unknown[]).length = 0;
    });
    expect(() => loadJevTraces(path)).toThrow(/no steps/i);
  });
});

describe("fixtureSha256 — reports record exactly what ran (KTD5)", () => {
  it("returns a stable 64-hex-char hash that changes when the file changes", () => {
    const pathA = writeTemp("hash-a.json", { a: 1 });
    expect(fixtureSha256(pathA)).toMatch(/^[0-9a-f]{64}$/);
    expect(fixtureSha256(pathA)).toBe(fixtureSha256(pathA));
    const pathB = writeTemp("hash-b.json", { a: 2 });
    expect(fixtureSha256(pathB)).not.toBe(fixtureSha256(pathA));
  });

  it("hashes both checked-in fixtures", () => {
    expect(fixtureSha256("eval/jev-multiway-tasks.json")).toMatch(/^[0-9a-f]{64}$/);
    expect(fixtureSha256("eval/jev-traces.json")).toMatch(/^[0-9a-f]{64}$/);
  });
});
