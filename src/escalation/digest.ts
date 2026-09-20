import { randomUUID } from "node:crypto";
import type { Database } from "../store/store.js";
import { withDatabase } from "../store/store.js";
import { ensureDraftLogSchema } from "../drafting/draft-log.js";
import { ensureStandingOrderCandidateSchema } from "../drafting/standing-order-candidates.js";
import { classifyUrgency } from "./urgency.js";

/**
 * The batched-digest mechanic named in `docs/concept.md` §10 as "the
 * fastest way to kill this" if built wrong: "escalations must batch into
 * a digest; only a narrow urgent class interrupts live."
 *
 * Built directly over #32's existing `drafts` table (`escalated: true`
 * rows) rather than a parallel escalation-tracking mechanism — every
 * escalation, whether from the owner's own `duo draft` or from a
 * colleague's public question via #43's `answerPublicly` (which calls the
 * same `draftReply` pipeline underneath), already lands there. This
 * module adds exactly one thing `drafts` doesn't carry: an idempotent
 * urgency classification per draft, synced lazily (recomputed over
 * whatever's newly escalated on each call, the same "recompute rather
 * than push" idiom #24/#25's derivation passes use) rather than requiring
 * `draftReply` itself to know anything about digests.
 */

export function ensureEscalationDigestSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS escalation_urgency_log (
      draft_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      urgency TEXT NOT NULL CHECK (urgency IN ('urgent', 'normal')),
      acknowledged_at TEXT,
      digested_at TEXT
    ) STRICT
  `);
  // The sent-digest record is append-only (AC1's "one message" is a real,
  // reconstructible event) — same two-trigger pattern as audit_log/
  // trust_ledger/public_answer_log. escalation_urgency_log above is
  // deliberately *not* append-only: acknowledged_at/digested_at are
  // working state a draft legitimately moves through once each, the same
  // shape trust_cells' own mutable columns use.
  db.exec(`
    CREATE TABLE IF NOT EXISTS escalation_digests (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      item_count INTEGER NOT NULL,
      items TEXT NOT NULL
    ) STRICT
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS escalation_digests_append_only_no_update
    BEFORE UPDATE ON escalation_digests
    BEGIN
      SELECT RAISE(ABORT, 'escalation_digests is append-only: a sent digest is never edited');
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS escalation_digests_append_only_no_delete
    BEFORE DELETE ON escalation_digests
    BEGIN
      SELECT RAISE(ABORT, 'escalation_digests is append-only: a sent digest is never deleted');
    END
  `);
}

interface EscalatedDraftRow {
  id: string;
  question: string;
  thread_context: string | null;
}

/**
 * Classifies every escalated draft not yet in `escalation_urgency_log` and
 * inserts it — idempotent (the table's `draft_id` primary key makes a
 * re-run over an already-classified draft a no-op via `INSERT OR IGNORE`),
 * so calling this before every read below is always safe and cheap once
 * the corpus is caught up.
 */
function syncEscalationUrgencyLog(db: Database): void {
  ensureDraftLogSchema(db);
  ensureEscalationDigestSchema(db);
  const rows = db
    .prepare(
      `
      SELECT drafts.id, drafts.question, drafts.thread_context
      FROM drafts
      LEFT JOIN escalation_urgency_log ON escalation_urgency_log.draft_id = drafts.id
      WHERE drafts.escalated = 1 AND escalation_urgency_log.draft_id IS NULL
    `,
    )
    .all() as unknown as EscalatedDraftRow[];
  if (rows.length === 0) {
    return;
  }
  const insert = db.prepare(
    `INSERT OR IGNORE INTO escalation_urgency_log (draft_id, created_at, urgency, acknowledged_at, digested_at) VALUES (?, ?, ?, NULL, NULL)`,
  );
  const now = new Date().toISOString();
  for (const row of rows) {
    const urgency = classifyUrgency(`${row.question} ${row.thread_context ?? ""}`);
    insert.run(row.id, now, urgency);
  }
}

/** Every draft id the owner has already answered directly (#34's `duo draft-answer`, which queues one of these) — #46 AC4: "answered in the thread before the digest is dropped," so it never counts as still outstanding, whether for the digest or the urgent-interrupt check. */
function resolvedDraftIds(db: Database): Set<string> {
  ensureStandingOrderCandidateSchema(db);
  const rows = db.prepare(`SELECT DISTINCT draft_id FROM standing_order_candidates`).all() as unknown as { draft_id: string }[];
  return new Set(rows.map((row) => row.draft_id));
}

export interface EscalationDigestItem {
  readonly draftId: string;
  readonly question: string;
  readonly threadContext: string | null;
  readonly escalationReason: string | null;
  readonly createdAt: string;
}

interface DraftContextRow {
  id: string;
  question: string;
  thread_context: string | null;
  escalation_reason: string | null;
  created_at: string;
}

function readDraftItems(db: Database, draftIds: readonly string[]): EscalationDigestItem[] {
  if (draftIds.length === 0) {
    return [];
  }
  const placeholders = draftIds.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT id, question, thread_context, escalation_reason, created_at FROM drafts WHERE id IN (${placeholders}) ORDER BY created_at, id`)
    .all(...draftIds) as unknown as DraftContextRow[];
  return rows.map((row) => ({
    draftId: row.id,
    question: row.question,
    threadContext: row.thread_context,
    escalationReason: row.escalation_reason,
    createdAt: row.created_at,
  }));
}

export interface UrgentEscalationCheckResult {
  readonly items: readonly EscalationDigestItem[];
}

/**
 * The narrow, live-interrupt path (#46 AC3): every urgent, unresolved
 * escalation not yet acknowledged, marked acknowledged in the same call so
 * it interrupts exactly once rather than on every future check — the same
 * one-time-announcement shape #55's `resolveAutonomyForAnswering` uses for
 * a demotion notice.
 */
export function checkUrgentEscalations(storePath: string, passphrase: string): UrgentEscalationCheckResult {
  return withDatabase(storePath, passphrase, true, (db) => {
    syncEscalationUrgencyLog(db);
    const resolved = resolvedDraftIds(db);
    const rows = db
      .prepare(`SELECT draft_id FROM escalation_urgency_log WHERE urgency = 'urgent' AND acknowledged_at IS NULL`)
      .all() as unknown as { draft_id: string }[];
    const draftIds = rows.map((row) => row.draft_id).filter((id) => !resolved.has(id));
    if (draftIds.length === 0) {
      return { items: [] };
    }
    const now = new Date().toISOString();
    const markAcknowledged = db.prepare(`UPDATE escalation_urgency_log SET acknowledged_at = ? WHERE draft_id = ?`);
    for (const id of draftIds) {
      markAcknowledged.run(now, id);
    }
    return { items: readDraftItems(db, draftIds) };
  });
}

export interface AssembleDigestResult {
  readonly sent: boolean;
  readonly digestId: string | undefined;
  readonly items: readonly EscalationDigestItem[];
}

/**
 * The batched digest itself (#46 AC1/AC2/AC4): every normal-urgency,
 * unresolved escalation not yet included in a previous digest. An empty
 * result writes nothing at all — no `escalation_digests` row, `sent:
 * false` — because "a recurring empty message teaches people to ignore
 * the channel" (#46 AC2's own reasoning, matching #71's usage-report
 * precedent for an honest empty state rather than a hollow ritual one).
 */
export function assembleEscalationDigest(storePath: string, passphrase: string): AssembleDigestResult {
  return withDatabase(storePath, passphrase, true, (db) => {
    syncEscalationUrgencyLog(db);
    const resolved = resolvedDraftIds(db);
    const rows = db
      .prepare(`SELECT draft_id FROM escalation_urgency_log WHERE urgency = 'normal' AND digested_at IS NULL`)
      .all() as unknown as { draft_id: string }[];
    const draftIds = rows.map((row) => row.draft_id).filter((id) => !resolved.has(id));
    if (draftIds.length === 0) {
      return { sent: false, digestId: undefined, items: [] };
    }
    const items = readDraftItems(db, draftIds);
    const digestId = randomUUID();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO escalation_digests (id, created_at, item_count, items) VALUES (?, ?, ?, ?)`).run(
      digestId,
      now,
      items.length,
      JSON.stringify(items),
    );
    const markDigested = db.prepare(`UPDATE escalation_urgency_log SET digested_at = ? WHERE draft_id = ?`);
    for (const id of draftIds) {
      markDigested.run(now, id);
    }
    return { sent: true, digestId, items };
  });
}

export interface SentEscalationDigest {
  readonly id: string;
  readonly createdAt: string;
  readonly itemCount: number;
  readonly items: readonly EscalationDigestItem[];
}

/** Every digest actually sent, oldest first — the owner-facing "what have I already been shown" reconstruction. `paging` is #178's addition for the HTTP surface (limit/cursor, the same vocabulary /search set); omitted, it returns every row, which is what `duo escalations history` has always read. */
export function listEscalationDigests(
  storePath: string,
  passphrase: string,
  paging: { limit?: number; cursor?: number } = {},
): SentEscalationDigest[] {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensureEscalationDigestSchema(db);
    // SQLite's LIMIT -1 means "no cap", so an omitted limit pages by cursor
    // alone and an omitted cursor reads from the top — the paging lives in
    // this one query, never sliced in a caller.
    const rows = db
      .prepare(`SELECT * FROM escalation_digests ORDER BY created_at, id LIMIT ? OFFSET ?`)
      .all(paging.limit ?? -1, paging.cursor ?? 0) as unknown as {
      id: string;
      created_at: string;
      item_count: number;
      items: string;
    }[];
    return rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      itemCount: row.item_count,
      items: JSON.parse(row.items) as EscalationDigestItem[],
    }));
  });
}

export interface EscalationUrgencyRate {
  readonly total: number;
  readonly urgent: number;
  /** 0 when total is 0 — never NaN (same "honest zero" convention #71's usage-report uses for an unused rate). */
  readonly rate: number;
}

/**
 * The drift-visibility number #46 AC3 asks for: "the share of escalations
 * classified urgent is tracked." All-time, over every escalation this
 * codebase has ever classified — not just what's currently outstanding —
 * since drift is about the trend, not the inbox.
 */
export function escalationUrgencyRate(storePath: string, passphrase: string): EscalationUrgencyRate {
  return withDatabase(storePath, passphrase, true, (db) => {
    syncEscalationUrgencyLog(db);
    const rows = db.prepare(`SELECT urgency, COUNT(*) as count FROM escalation_urgency_log GROUP BY urgency`).all() as unknown as {
      urgency: string;
      count: number;
    }[];
    const urgent = rows.find((row) => row.urgency === "urgent")?.count ?? 0;
    const normal = rows.find((row) => row.urgency === "normal")?.count ?? 0;
    const total = urgent + normal;
    return { total, urgent, rate: total === 0 ? 0 : urgent / total };
  });
}
