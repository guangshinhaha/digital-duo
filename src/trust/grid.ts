import type { Database } from "../store/store.js";
import { withDatabase } from "../store/store.js";
import { readTopicsFile } from "../derivation/topics.js";

/**
 * `docs/concept.md` §6: "Trust is granted per (topic × tier)" — the grid
 * this module models. T4 (external/irreversible) is deliberately excluded:
 * concept.md calls it "never autonomous, product principle, not a
 * limitation," so it is structurally outside the grid rather than merely a
 * policy value the grid could theoretically set. There is no cell to grant,
 * promote, or accidentally default to allow for a tier that was never a
 * dimension of this table in the first place.
 */
export const TRUST_TIERS = ["T0", "T1", "T2", "T3"] as const;
export type TrustTier = (typeof TRUST_TIERS)[number];

export function isTrustTier(value: string): value is TrustTier {
  return (TRUST_TIERS as readonly string[]).includes(value);
}

/**
 * Ordered rungs a cell climbs one at a time. `"ask"` is the safe default
 * every genuinely untouched cell resolves to (#52 AC: "no code path
 * defaults an unknown cell to allow") — a cell only ever leaves it through
 * an explicit grant (#53) or an earned promotion (#54).
 */
export const AUTONOMY_LEVELS = ["ask", "approve", "auto"] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

/** The rung one step more autonomous, or undefined at the top ("auto"). */
export function nextLevel(level: AutonomyLevel): AutonomyLevel | undefined {
  return AUTONOMY_LEVELS[AUTONOMY_LEVELS.indexOf(level) + 1];
}

/** The rung one step more cautious, or undefined at the floor ("ask"). */
export function previousLevel(level: AutonomyLevel): AutonomyLevel | undefined {
  const index = AUTONOMY_LEVELS.indexOf(level);
  return index <= 0 ? undefined : AUTONOMY_LEVELS[index - 1];
}

/** Whether a cell's current level was reached by the ledger (#54's promotion path) or handed over outright (#53's standing-order grants) — concept.md §6's "two routes to autonomy." */
export type TrustCellSource = "earned" | "granted";

/** Whether the last promotion offer at this cell was declined — used to gate re-offering (#54 AC2), never to gate anything else. */
export type LastOfferStatus = "declined" | null;

export interface TrustCell {
  readonly topicId: string;
  readonly tier: TrustTier;
  readonly level: AutonomyLevel;
  readonly source: TrustCellSource;
  /** Consecutive clean (uncorrected) instances recorded at this cell's current level since it last moved. Resets to 0 on every promotion and every demotion (#55 AC3) — it counts evidence for the *next* move, not history in general. */
  readonly cleanStreak: number;
  /** The cleanStreak value at which the most recent promotion offer was declined, or null if none was ever declined (or a later promotion/demotion reset it). */
  readonly lastOfferStreak: number | null;
  readonly lastOfferStatus: LastOfferStatus;
  /** False for exactly one read after a demotion — cleared by the first caller that consumes it (#55 AC2's one-time announcement). True otherwise, including for a cell that has never been demoted. */
  readonly demotionAnnounced: boolean;
  readonly updatedAt: string;
}

interface TrustCellRow {
  topic_id: string;
  tier: string;
  level: string;
  source: string;
  clean_streak: number;
  last_offer_streak: number | null;
  last_offer_status: string | null;
  demotion_announced: number;
  updated_at: string;
}

function rowToCell(row: TrustCellRow): TrustCell {
  return {
    topicId: row.topic_id,
    tier: row.tier as TrustTier,
    level: row.level as AutonomyLevel,
    source: row.source as TrustCellSource,
    cleanStreak: row.clean_streak,
    lastOfferStreak: row.last_offer_streak,
    lastOfferStatus: row.last_offer_status as LastOfferStatus,
    demotionAnnounced: row.demotion_announced === 1,
    updatedAt: row.updated_at,
  };
}

/**
 * Created on demand, matching every other table in this codebase
 * (ensureRecordsSchema et al.) rather than only at `duo init`.
 *
 * The `tier` CHECK constraint (#60 AC1) is the database-level half of T4's
 * structural exclusion — `TrustTier`/`isTrustTier` already made it a
 * compile-time impossibility to pass "T4" through this module's own typed
 * functions (#52), but a `CHECK` constraint holds even against a caller
 * that reaches the database directly (raw SQL, a future migration, a bug
 * that widens `tier`'s type) the same way `src/permissions/audit.ts`'s
 * `BEFORE UPDATE`/`BEFORE DELETE` triggers hold against code that never
 * called this module's own functions at all. There is and can be no row in
 * this table for T4 — not "none granted yet", literally none insertable —
 * so no configuration, grant, or promotion can ever produce autonomous T4
 * execution through the grid.
 */
export function ensureTrustSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trust_cells (
      topic_id TEXT NOT NULL,
      tier TEXT NOT NULL CHECK (tier IN ('T0', 'T1', 'T2', 'T3')),
      level TEXT NOT NULL,
      source TEXT NOT NULL,
      clean_streak INTEGER NOT NULL DEFAULT 0,
      last_offer_streak INTEGER,
      last_offer_status TEXT,
      demotion_announced INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (topic_id, tier)
    ) STRICT
  `);
}

/** One cell's current row, or undefined for a cell that has never been touched — callers must treat "no row" as the safe default ("ask"/no autonomy), never as an invitation to invent one. */
export function getCellRow(db: Database, topicId: string, tier: TrustTier): TrustCell | undefined {
  const row = db
    .prepare(`SELECT * FROM trust_cells WHERE topic_id = ? AND tier = ?`)
    .get(topicId, tier) as TrustCellRow | undefined;
  return row ? rowToCell(row) : undefined;
}

/** Every cell that has ever been touched (granted, earned an instance, promoted, or demoted) — untouched cells have no row and are never synthesized into this list. */
export function listCellRows(db: Database): TrustCell[] {
  const rows = db.prepare(`SELECT * FROM trust_cells ORDER BY topic_id, tier`).all() as unknown as TrustCellRow[];
  return rows.map(rowToCell);
}

/** Full replace, insert-or-update — the one write primitive every trust module (grants, promotion, demotion) builds its own transitions on top of, so "what a cell's row looks like" has exactly one writer to reason about. */
export function upsertCellRow(db: Database, cell: TrustCell): void {
  db.prepare(
    `
    INSERT INTO trust_cells
      (topic_id, tier, level, source, clean_streak, last_offer_streak, last_offer_status, demotion_announced, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(topic_id, tier) DO UPDATE SET
      level = excluded.level,
      source = excluded.source,
      clean_streak = excluded.clean_streak,
      last_offer_streak = excluded.last_offer_streak,
      last_offer_status = excluded.last_offer_status,
      demotion_announced = excluded.demotion_announced,
      updated_at = excluded.updated_at
  `,
  ).run(
    cell.topicId,
    cell.tier,
    cell.level,
    cell.source,
    cell.cleanStreak,
    cell.lastOfferStreak,
    cell.lastOfferStatus,
    cell.demotionAnnounced ? 1 : 0,
    cell.updatedAt,
  );
}

export interface AutonomyResolution {
  readonly level: AutonomyLevel;
  /** True when the cell's topic id no longer appears in duo/topics.json (merged or removed) — the cell is reported stale rather than silently obeyed (#52 AC2). */
  readonly stale: boolean;
}

/**
 * The one function anything outside this module should call to find out
 * what a topic × tier cell currently permits (#52 AC1/AC2). A cell that was
 * never touched, and a cell whose topic has since been merged or removed,
 * both resolve to `{ level: "ask", stale: ... }` — never to whatever a
 * stored row happens to say once its topic is gone, and never to "auto" by
 * absence of a row.
 */
export function resolveAutonomy(
  storePath: string,
  passphrase: string,
  duoDir: string,
  topicId: string,
  tier: TrustTier,
): AutonomyResolution {
  const topicExists = readTopicsFile(duoDir).some((topic) => topic.id === topicId);
  return withDatabase(storePath, passphrase, false, (db) => {
    ensureTrustSchema(db);
    const cell = getCellRow(db, topicId, tier);
    if (!cell) {
      return { level: "ask", stale: false };
    }
    if (!topicExists) {
      return { level: "ask", stale: true };
    }
    return { level: cell.level, stale: false };
  });
}

export interface GridRow {
  readonly topicId: string;
  /** undefined when the topic has been merged or removed since this cell was last touched — the stale case #52 AC2 asks to be reported. */
  readonly topicLabel: string | undefined;
  readonly tier: TrustTier;
  readonly level: AutonomyLevel;
  readonly source: TrustCellSource;
  readonly stale: boolean;
}

/** The owner-facing "open the grid" view (#53 AC4): every touched cell, its current level, whether it was earned or granted, and its topic's live label — or a stale flag when that topic no longer exists. */
export function listGrid(storePath: string, passphrase: string, duoDir: string): GridRow[] {
  const labelById = new Map(readTopicsFile(duoDir).map((topic) => [topic.id, topic.label]));
  return withDatabase(storePath, passphrase, false, (db) => {
    ensureTrustSchema(db);
    return listCellRows(db).map((cell) => ({
      topicId: cell.topicId,
      topicLabel: labelById.get(cell.topicId),
      tier: cell.tier,
      level: cell.level,
      source: cell.source,
      stale: !labelById.has(cell.topicId),
    }));
  });
}
