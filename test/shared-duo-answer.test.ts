import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Duo } from "../src/duo/entity.js";
import type { DuoDefinition } from "../src/duo/types.js";
import { answerSharedDuo } from "../src/shared-duo/answer.js";
import { createEncryptedStore, withDatabase } from "../src/store/store.js";
import { useTempDir } from "./helpers/temp-dir.js";

function definition(overrides: Partial<DuoDefinition> = {}): DuoDefinition {
  return {
    id: "shared-duo",
    owner: { kind: "person", id: "dana-cole", name: "Dana Cole" },
    persona: { voice: "plain, procedural" },
    standingOrders: ["answer only from the configured documents"],
    refusals: ["does not decide anything on the team's behalf"],
    knowledge: {
      kind: "authored",
      documents: [
        "Leave requests: submit through the HR portal at least 5 working days in advance.",
        "Expense claims: attach original receipts and submit within 30 days of the expense.",
      ],
    },
    ...overrides,
  };
}

describe("answerSharedDuo — every claim traces to a configured source (#68 AC1)", () => {
  it("answers a covered question by quoting the matching document verbatim, and cites it", async () => {
    const duo = new Duo(definition());
    const result = await answerSharedDuo(duo, "leave requests");
    expect(result.declined).toBe(false);
    expect(result.citations).toEqual([
      { text: "Leave requests: submit through the HR portal at least 5 working days in advance.", source: "authored" },
    ]);
    expect(result.text).toBe("Leave requests: submit through the HR portal at least 5 working days in advance.");
  });

  it("never draws in a document that wasn't a match, even when other documents exist", async () => {
    const duo = new Duo(definition());
    const result = await answerSharedDuo(duo, "leave requests");
    expect(result.text).not.toContain("Expense claims");
  });
});

describe("answerSharedDuo — a question outside the sources is declined and escalated (#68 AC2)", () => {
  it("says the material doesn't cover it and names the owner, rather than generalising", async () => {
    const duo = new Duo(definition());
    const result = await answerSharedDuo(duo, "what is the parking policy");
    expect(result.declined).toBe(true);
    expect(result.citations).toEqual([]);
    expect(result.text).toContain("Dana Cole");
    expect(result.text).not.toMatch(/leave|expense/i);
  });
});

describe("answerSharedDuo — a personal corpus is unreachable by construction (#68 AC3)", () => {
  const tempDir = useTempDir();
  const PASSPHRASE = "personal-owner-passphrase";

  function createPersonalStoreWithSecret(): string {
    const storePath = join(tempDir(), "data", "someones-personal-duo.db");
    createEncryptedStore(storePath, PASSPHRASE);
    withDatabase(storePath, PASSPHRASE, true, (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS records (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL,
          source_ref TEXT,
          kind TEXT NOT NULL,
          author TEXT NOT NULL,
          text TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          thread_id TEXT,
          audience TEXT NOT NULL,
          classification TEXT,
          topics TEXT NOT NULL DEFAULT '[]'
        ) STRICT
      `);
      db.prepare(
        `INSERT INTO records (id, source, kind, author, text, timestamp, audience)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "rec-1",
        "paste",
        "my_thinking",
        "me",
        "TOP-SECRET-PERSONAL-SALARY-FIGURE-42",
        new Date().toISOString(),
        "private",
      );
    });
    return storePath;
  }

  it("a shared duo cannot read a personal duo's store even when one exists on the same machine", async () => {
    const personalStorePath = createPersonalStoreWithSecret();

    const duo = new Duo(definition());
    const result = await answerSharedDuo(duo, "salary figure");

    // The shared duo has no path to that store at all — no storePath, no
    // passphrase — so it has nothing to read, and the answer can only ever
    // come from its own configured documents.
    expect(result.declined).toBe(true);
    expect(result.text).not.toContain("TOP-SECRET-PERSONAL-SALARY-FIGURE-42");

    // The personal store itself is untouched: still readable with its own
    // passphrase, still holding exactly the one record written above.
    const stillThere = withDatabase(personalStorePath, PASSPHRASE, false, (db) => {
      return db.prepare(`SELECT text FROM records WHERE id = ?`).get("rec-1") as { text: string } | undefined;
    });
    expect(stillThere?.text).toBe("TOP-SECRET-PERSONAL-SALARY-FIGURE-42");
  });

  it("neither src/shared-duo/answer.ts nor loader.ts imports anything from src/store/ — the boundary is structural, not a prompt instruction", () => {
    const answerSource = readFileSync(new URL("../src/shared-duo/answer.ts", import.meta.url), "utf8");
    const loaderSource = readFileSync(new URL("../src/shared-duo/loader.ts", import.meta.url), "utf8");
    // Matches an actual import or call, not merely the word appearing in a
    // doc comment explaining why the boundary holds.
    const touchesStore = /from ["'][^"']*store\/store\.js["']|require\(["']node:sqlite["']\)|withDatabase\(/;
    expect(answerSource).not.toMatch(touchesStore);
    expect(loaderSource).not.toMatch(touchesStore);
  });
});
