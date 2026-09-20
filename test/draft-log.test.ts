import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDir } from "./helpers/temp-dir.js";
import { DEFAULT_CONFIDENCE_ESCALATION_THRESHOLD } from "../src/config.js";
import { appendDraft, DraftNotFoundError, ensureDraftLogSchema, getDraft, listDrafts, recordDraftOutcome } from "../src/drafting/draft-log.js";
import { createEncryptedStore, withDatabase, type Database } from "../src/store/store.js";

const tempDir = useTempDir();
const PASSPHRASE = "pw";

function initStore(): string {
  const storePath = join(tempDir(), "data", "duo.db");
  createEncryptedStore(storePath, PASSPHRASE);
  return storePath;
}

describe("appendDraft / getDraft", () => {
  it("round-trips a drafted (non-escalated) entry", () => {
    const storePath = initStore();
    const id = appendDraft(storePath, PASSPHRASE, {
      question: "How much leave do I get?",
      threadContext: null,
      draftText: "Five days per quarter.",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.8,
      sources: [{ kind: "rule", id: "topic-leave", label: "standing order: five days" }],
    });

    const draft = getDraft(storePath, PASSPHRASE, id);
    expect(draft).toMatchObject({
      id,
      question: "How much leave do I get?",
      draftText: "Five days per quarter.",
      escalated: false,
      confidenceScore: 0.8,
      outcome: null,
    });
    expect(draft?.sources).toEqual([{ kind: "rule", id: "topic-leave", label: "standing order: five days" }]);
  });

  it("defaults refused to false and escalationThreshold to DEFAULT_CONFIDENCE_ESCALATION_THRESHOLD when the caller omits them", () => {
    const storePath = initStore();
    const id = appendDraft(storePath, PASSPHRASE, {
      question: "q",
      threadContext: null,
      draftText: "a",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.8,
      sources: [],
    });
    const draft = getDraft(storePath, PASSPHRASE, id);
    expect(draft?.refused).toBe(false);
    expect(draft?.escalationThreshold).toBe(DEFAULT_CONFIDENCE_ESCALATION_THRESHOLD);
  });

  it("the drafts table's own SQL-level DEFAULT for escalation_threshold matches DEFAULT_CONFIDENCE_ESCALATION_THRESHOLD — catches the three hand-kept-in-sync 0.55 literals (config.ts, CREATE TABLE, ALTER TABLE) drifting apart, not just appendDraft's JS-level fallback", () => {
    const storePath = initStore();
    withDatabase(storePath, PASSPHRASE, true, (db) => {
      ensureDraftLogSchema(db);
      // Bypasses appendDraft (and its own `?? DEFAULT_CONFIDENCE_ESCALATION_THRESHOLD`
      // fallback) entirely, so this exercises only the column's SQL-level
      // DEFAULT — the literal in the CREATE TABLE/ALTER TABLE DDL.
      db.prepare(
        `INSERT INTO drafts (id, question, thread_context, draft_text, escalated, escalation_reason, confidence_score, sources, created_at) VALUES ('sql-default-test', 'q', NULL, 'a', 0, NULL, 0.8, '[]', ?)`,
      ).run(new Date().toISOString());
    });
    const draft = getDraft(storePath, PASSPHRASE, "sql-default-test");
    expect(draft?.escalationThreshold).toBe(DEFAULT_CONFIDENCE_ESCALATION_THRESHOLD);
  });

  it("round-trips a refused escalation with a non-default threshold", () => {
    const storePath = initStore();
    const id = appendDraft(storePath, PASSPHRASE, {
      question: "q",
      threadContext: null,
      draftText: null,
      escalated: true,
      escalationReason: "refused subject",
      confidenceScore: 0,
      sources: [],
      refused: true,
      escalationThreshold: 0.7,
    });
    const draft = getDraft(storePath, PASSPHRASE, id);
    expect(draft?.refused).toBe(true);
    expect(draft?.escalationThreshold).toBe(0.7);
  });

  it("round-trips an escalated entry with a null draftText", () => {
    const storePath = initStore();
    const id = appendDraft(storePath, PASSPHRASE, {
      question: "What's my bonus?",
      threadContext: "prior context",
      draftText: null,
      escalated: true,
      escalationReason: "no supporting evidence",
      confidenceScore: 0.1,
      sources: [],
    });
    const draft = getDraft(storePath, PASSPHRASE, id);
    expect(draft?.draftText).toBeNull();
    expect(draft?.escalated).toBe(true);
    expect(draft?.escalationReason).toBe("no supporting evidence");
    expect(draft?.threadContext).toBe("prior context");
  });

  it("returns undefined for an unknown id", () => {
    const storePath = initStore();
    expect(getDraft(storePath, PASSPHRASE, "nope")).toBeUndefined();
  });
});

describe("recordDraftOutcome — the outcome is recorded against the draft (#32 AC3)", () => {
  it("stores sent/edited/discarded with a timestamp", () => {
    const storePath = initStore();
    const id = appendDraft(storePath, PASSPHRASE, {
      question: "q",
      threadContext: null,
      draftText: "a",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.9,
      sources: [],
    });

    recordDraftOutcome(storePath, PASSPHRASE, id, "edited");
    const draft = getDraft(storePath, PASSPHRASE, id);
    expect(draft?.outcome).toBe("edited");
    expect(draft?.outcomeRecordedAt).not.toBeNull();
  });

  it("throws DraftNotFoundError for an unknown id, rather than silently no-op-ing", () => {
    const storePath = initStore();
    expect(() => recordDraftOutcome(storePath, PASSPHRASE, "nope", "sent")).toThrow(DraftNotFoundError);
  });

  it("stores the sent text when supplied (#37: needed to diff draft vs sent at all)", () => {
    const storePath = initStore();
    const id = appendDraft(storePath, PASSPHRASE, {
      question: "q",
      threadContext: null,
      draftText: "a draft",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.9,
      sources: [],
    });

    recordDraftOutcome(storePath, PASSPHRASE, id, "edited", "an edited sent version");
    const draft = getDraft(storePath, PASSPHRASE, id);
    expect(draft?.sentText).toBe("an edited sent version");
  });

  it("leaves sentText null when it isn't supplied", () => {
    const storePath = initStore();
    const id = appendDraft(storePath, PASSPHRASE, {
      question: "q",
      threadContext: null,
      draftText: "a draft",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.9,
      sources: [],
    });

    recordDraftOutcome(storePath, PASSPHRASE, id, "sent");
    expect(getDraft(storePath, PASSPHRASE, id)?.sentText).toBeNull();
  });
});

describe("listDrafts", () => {
  it("lists every draft, oldest first", () => {
    const storePath = initStore();
    const first = appendDraft(storePath, PASSPHRASE, {
      question: "q1",
      threadContext: null,
      draftText: "a1",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.7,
      sources: [],
    });
    const second = appendDraft(storePath, PASSPHRASE, {
      question: "q2",
      threadContext: null,
      draftText: null,
      escalated: true,
      escalationReason: "thin",
      confidenceScore: 0.2,
      sources: [],
    });
    const drafts = listDrafts(storePath, PASSPHRASE);
    expect(drafts.map((draft) => draft.id)).toEqual([first, second]);
  });

  it("is empty on a fresh store", () => {
    const storePath = initStore();
    expect(listDrafts(storePath, PASSPHRASE)).toEqual([]);
  });

  it("filters to pending (undispositioned) drafts only, oldest first", () => {
    const storePath = initStore();
    const pending = appendDraft(storePath, PASSPHRASE, {
      question: "still pending",
      threadContext: null,
      draftText: "a",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.7,
      sources: [],
    });
    const dispositioned = appendDraft(storePath, PASSPHRASE, {
      question: "already handled",
      threadContext: null,
      draftText: "b",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.7,
      sources: [],
    });
    recordDraftOutcome(storePath, PASSPHRASE, dispositioned, "sent", undefined);

    expect(listDrafts(storePath, PASSPHRASE, { outcome: "pending" }).map((draft) => draft.id)).toEqual([pending]);
  });

  it("filters to a concrete outcome", () => {
    const storePath = initStore();
    const sent = appendDraft(storePath, PASSPHRASE, {
      question: "q1",
      threadContext: null,
      draftText: "a",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.7,
      sources: [],
    });
    const discarded = appendDraft(storePath, PASSPHRASE, {
      question: "q2",
      threadContext: null,
      draftText: "b",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.7,
      sources: [],
    });
    recordDraftOutcome(storePath, PASSPHRASE, sent, "sent", undefined);
    recordDraftOutcome(storePath, PASSPHRASE, discarded, "discarded", undefined);

    expect(listDrafts(storePath, PASSPHRASE, { outcome: "sent" }).map((draft) => draft.id)).toEqual([sent]);
  });

  it("caps results with limit", () => {
    const storePath = initStore();
    for (let i = 0; i < 3; i += 1) {
      appendDraft(storePath, PASSPHRASE, {
        question: `q${i}`,
        threadContext: null,
        draftText: "a",
        escalated: false,
        escalationReason: null,
        confidenceScore: 0.7,
        sources: [],
      });
    }
    expect(listDrafts(storePath, PASSPHRASE, { limit: 2 })).toHaveLength(2);
  });

  it("excludes drafts created at or after the before cursor", () => {
    const storePath = initStore();
    const first = appendDraft(storePath, PASSPHRASE, {
      question: "q1",
      threadContext: null,
      draftText: "a",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.7,
      sources: [],
    });
    const firstDraft = getDraft(storePath, PASSPHRASE, first);
    appendDraft(storePath, PASSPHRASE, {
      question: "q2",
      threadContext: null,
      draftText: "b",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.7,
      sources: [],
    });

    const cutoff = new Date(new Date(firstDraft!.createdAt).getTime() + 1).toISOString();
    expect(listDrafts(storePath, PASSPHRASE, { before: cutoff }).map((draft) => draft.id)).toEqual([first]);
  });
});

describe("listDrafts paging direction — a paged read must reach the newest window (guangshinhaha/duo#29)", () => {
  /**
   * appendDraft stamps `createdAt` as it runs, and a tight loop can land two
   * drafts on the same millisecond — which would make "newest" ambiguous and
   * an exclusive `before` cursor skip a same-timestamp sibling. This sleeps
   * the given milliseconds synchronously (Atomics.wait on a shared buffer),
   * so each seeded draft gets a distinct timestamp without turning these
   * tests async.
   */
  function sleepSync(milliseconds: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  }

  /** Seeds `count` drafts, oldest first, with guaranteed-distinct timestamps; returns their ids and a createdAt lookup. */
  function seedDrafts(storePath: string, count: number): { ids: string[]; createdAtOf: (id: string) => string } {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      ids.push(
        appendDraft(storePath, PASSPHRASE, {
          question: `q${i}`,
          threadContext: null,
          draftText: "a",
          escalated: false,
          escalationReason: null,
          confidenceScore: 0.7,
          sources: [],
        }),
      );
      if (i < count - 1) {
        sleepSync(2);
      }
    }
    return { ids, createdAtOf: (id) => getDraft(storePath, PASSPHRASE, id)!.createdAt };
  }

  it("with limit, returns the newest drafts first — not the oldest window that an ascending LIMIT can never move past", () => {
    const storePath = initStore();
    const { ids } = seedDrafts(storePath, 3); // ids[0] oldest … ids[2] newest
    expect(listDrafts(storePath, PASSPHRASE, { limit: 2 }).map((draft) => draft.id)).toEqual([ids[2], ids[1]]);
  });

  it("a backward walk composes: page two, via before, continues exactly where page one ended", () => {
    const storePath = initStore();
    const { ids, createdAtOf } = seedDrafts(storePath, 3);

    const pageOne = listDrafts(storePath, PASSPHRASE, { limit: 2 }).map((draft) => draft.id);
    expect(pageOne).toEqual([ids[2], ids[1]]);

    // The cursor is the oldest item page one returned; `before` is exclusive,
    // so page two is everything strictly older — the adjacent older page, not
    // a re-read from the beginning of history.
    const pageTwo = listDrafts(storePath, PASSPHRASE, { limit: 2, before: createdAtOf(pageOne[pageOne.length - 1]) }).map(
      (draft) => draft.id,
    );
    expect(pageTwo).toEqual([ids[0]]);

    // Disjoint, and together exactly the whole log.
    expect(pageOne.filter((id) => pageTwo.includes(id))).toEqual([]);
    expect([...pageOne, ...pageTwo]).toEqual([ids[2], ids[1], ids[0]]);
  });

  it("a cursor past the oldest draft answers an empty page, not an error", () => {
    const storePath = initStore();
    const { ids, createdAtOf } = seedDrafts(storePath, 2);
    const before = new Date(new Date(createdAtOf(ids[0])).getTime() - 1).toISOString();
    expect(listDrafts(storePath, PASSPHRASE, { limit: 2, before })).toEqual([]);
  });

  it("without limit, the order stays oldest-first — byte-identical to the un-paged behaviour this fix must not change", () => {
    const storePath = initStore();
    const { ids } = seedDrafts(storePath, 3);
    expect(listDrafts(storePath, PASSPHRASE).map((draft) => draft.id)).toEqual(ids);
    // And with only a before cursor, still oldest-first within the window.
    const { createdAtOf } = { createdAtOf: (id: string) => getDraft(storePath, PASSPHRASE, id)!.createdAt };
    expect(listDrafts(storePath, PASSPHRASE, { before: createdAtOf(ids[2]) }).map((draft) => draft.id)).toEqual([ids[0], ids[1]]);
  });
});

describe("ensureDraftLogSchema — migrating a pre-existing drafts table", () => {
  /** The exact 12-column shape `drafts` had before `refused`/`escalation_threshold` existed — reproduces a real `duo serve`/`duo draft` store that ran before this change, since `CREATE TABLE IF NOT EXISTS` alone is a no-op against a table that already exists. */
  function createPreMigrationDraftsTable(db: Database): void {
    db.exec(`
      CREATE TABLE drafts (
        id TEXT PRIMARY KEY,
        question TEXT NOT NULL,
        thread_context TEXT,
        draft_text TEXT,
        escalated INTEGER NOT NULL,
        escalation_reason TEXT,
        confidence_score REAL NOT NULL,
        sources TEXT NOT NULL,
        created_at TEXT NOT NULL,
        outcome TEXT,
        outcome_recorded_at TEXT,
        sent_text TEXT
      ) STRICT
    `);
  }

  it("adds the missing columns to a table created before they existed, rather than throwing on the next append", () => {
    const storePath = initStore();
    withDatabase(storePath, PASSPHRASE, true, (db) => {
      createPreMigrationDraftsTable(db);
    });

    // Before the fix this threw: "table drafts has no column named refused"
    // — CREATE TABLE IF NOT EXISTS never alters a table that already exists.
    const id = appendDraft(storePath, PASSPHRASE, {
      question: "q",
      threadContext: null,
      draftText: "a",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.8,
      sources: [],
    });

    const draft = getDraft(storePath, PASSPHRASE, id);
    expect(draft?.refused).toBe(false);
    expect(draft?.escalationThreshold).toBe(0.55);
  });

  it("running the migration twice is a no-op, not an error", () => {
    const storePath = initStore();
    withDatabase(storePath, PASSPHRASE, true, (db) => {
      createPreMigrationDraftsTable(db);
      ensureDraftLogSchema(db);
      expect(() => ensureDraftLogSchema(db)).not.toThrow();
    });
  });
});

describe("draft provenance (#169) — where a draft came from, structured", () => {
  it("round-trips an adapter-supplied channel provenance verbatim", () => {
    const storePath = initStore();
    const id = appendDraft(storePath, PASSPHRASE, {
      question: "how do I get deploy access?",
      threadContext: "thread text stays exactly what it is — grounding, not provenance",
      draftText: "point them at the runbook",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.8,
      sources: [],
      provenance: {
        origin: "channel",
        channelKind: "slack",
        askerRef: "directory.json#sam",
        threadId: "C0123456789.1660000000",
        permalink: "https://example.slack.com/archives/C0123456789/p1660000000000000",
      },
    });

    const draft = getDraft(storePath, PASSPHRASE, id);
    expect(draft?.provenance).toEqual({
      origin: "channel",
      channelKind: "slack",
      askerRef: "directory.json#sam",
      threadId: "C0123456789.1660000000",
      permalink: "https://example.slack.com/archives/C0123456789/p1660000000000000",
    });
    // threadContext is unchanged and separate: a free-text string cannot
    // answer "which thread, in which channel, from whom" — that is the
    // whole reason provenance is its own field.
    expect(draft?.threadContext).toBe("thread text stays exactly what it is — grounding, not provenance");
  });

  it("round-trips a channel provenance whose adapter could not supply a thread id or permalink", () => {
    const storePath = initStore();
    const id = appendDraft(storePath, PASSPHRASE, {
      question: "q",
      threadContext: null,
      draftText: "a",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.8,
      sources: [],
      provenance: { origin: "channel", channelKind: "email", askerRef: "directory.json#sam", threadId: null, permalink: null },
    });
    expect(getDraft(storePath, PASSPHRASE, id)?.provenance).toEqual({
      origin: "channel",
      channelKind: "email",
      askerRef: "directory.json#sam",
      threadId: null,
      permalink: null,
    });
  });

  it("records the owner origin for a draft the owner asked for — no asker ref, no permalink; it is not a reply to anybody", () => {
    const storePath = initStore();
    const id = appendDraft(storePath, PASSPHRASE, {
      question: "what do I think about X?",
      threadContext: null,
      draftText: "a",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.8,
      sources: [],
      provenance: { origin: "owner" },
    });
    expect(getDraft(storePath, PASSPHRASE, id)?.provenance).toEqual({ origin: "owner" });
  });

  it("a draft written without provenance reads as origin unknown", () => {
    const storePath = initStore();
    const id = appendDraft(storePath, PASSPHRASE, {
      question: "q",
      threadContext: null,
      draftText: "a",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.8,
      sources: [],
    });
    expect(getDraft(storePath, PASSPHRASE, id)?.provenance).toEqual({ origin: "unknown" });
  });

  it("a row written before the provenance column existed migrates and reads as origin unknown, and nothing throws", () => {
    const storePath = initStore();
    // The drafts table exactly as it shipped after the refused/threshold
    // migration but before provenance — a real store from an already-running
    // daemon. CREATE TABLE IF NOT EXISTS alone will not add the column, so
    // ensureDraftLogSchema's ALTER path is the only thing standing between
    // this row and "table drafts has no column named provenance".
    withDatabase(storePath, PASSPHRASE, true, (db) => {
      db.exec(`
        CREATE TABLE drafts (
          id TEXT PRIMARY KEY,
          question TEXT NOT NULL,
          thread_context TEXT,
          draft_text TEXT,
          escalated INTEGER NOT NULL,
          escalation_reason TEXT,
          confidence_score REAL NOT NULL,
          sources TEXT NOT NULL,
          created_at TEXT NOT NULL,
          outcome TEXT,
          outcome_recorded_at TEXT,
          sent_text TEXT,
          refused INTEGER NOT NULL DEFAULT 0,
          escalation_threshold REAL NOT NULL DEFAULT 0.55
        ) STRICT
      `);
      db.prepare(
        `INSERT INTO drafts (id, question, thread_context, draft_text, escalated, confidence_score, sources, created_at, refused, escalation_threshold)
         VALUES ('legacy-1', 'q', NULL, 'a', 0, 0.8, '[]', '2026-01-01T00:00:00.000Z', 0, 0.55)`,
      ).run();
    });

    const draft = getDraft(storePath, PASSPHRASE, "legacy-1");
    expect(draft?.provenance).toEqual({ origin: "unknown" });
    // And the store keeps working: a fresh append after migration carries it.
    const id = appendDraft(storePath, PASSPHRASE, {
      question: "q2",
      threadContext: null,
      draftText: "a2",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.8,
      sources: [],
      provenance: { origin: "owner" },
    });
    expect(getDraft(storePath, PASSPHRASE, id)?.provenance).toEqual({ origin: "owner" });
  });

  it("corrupt provenance JSON reads as unknown rather than throwing on every future read", () => {
    const storePath = initStore();
    const id = appendDraft(storePath, PASSPHRASE, {
      question: "q",
      threadContext: null,
      draftText: "a",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.8,
      sources: [],
      provenance: { origin: "owner" },
    });
    withDatabase(storePath, PASSPHRASE, true, (db) => {
      db.prepare(`UPDATE drafts SET provenance = '{not json' WHERE id = ?`).run(id);
    });
    expect(getDraft(storePath, PASSPHRASE, id)?.provenance).toEqual({ origin: "unknown" });
  });

  it("listDrafts carries provenance too — the Review surface reads the same field", () => {
    const storePath = initStore();
    appendDraft(storePath, PASSPHRASE, {
      question: "q",
      threadContext: null,
      draftText: "a",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.8,
      sources: [],
      provenance: { origin: "channel", channelKind: "slack", askerRef: "directory.json#sam", threadId: "t1", permalink: null },
    });
    const listed = listDrafts(storePath, PASSPHRASE);
    expect(listed).toHaveLength(1);
    expect(listed[0].provenance).toMatchObject({ origin: "channel", channelKind: "slack", askerRef: "directory.json#sam" });
  });
});
