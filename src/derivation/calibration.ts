import { randomUUID } from "node:crypto";
import type { DuoConfig } from "../config.js";
import type { EmbeddingProvider, InferenceProvider } from "../provider/types.js";
import type { Database } from "../store/store.js";
import { withDatabase } from "../store/store.js";
import { recordDraftOutcome, type DraftOutcome } from "../drafting/draft-log.js";
import { draftReply } from "../drafting/pipeline.js";
import { getRecord } from "../ingest/record-store.js";
import { requireRefusalsDecision } from "../trust/refusals.js";
import { listQaPairs } from "./qa-pairs.js";

/**
 * #30, docs/concept.md §7 step 4: comparing the duo's proposed answers
 * against the owner's real past ones on a dozen questions — "far better
 * than a personality questionnaire ... it is also the moment the owner
 * decides whether to keep going, so it has to be honest about the gap
 * rather than flattering."
 *
 * Deliberately reuses #32's real draft pipeline (draftReply) to produce
 * "the duo's proposed answer" rather than a separate, calibration-only
 * generation path — the whole point is to show the owner what the *real*
 * pipeline would have said, not a simulation of it. Every generated item
 * also writes a real row to #32's draft log (appendDraft, inside
 * draftReply) and, once judged, a real outcome via recordDraftOutcome —
 * "edits feed the same pipeline as a corrected draft" (AC1) is literally
 * this: the same appendDraft/recordDraftOutcome functions #32's own `duo
 * draft`/`duo draft-outcome` commands use.
 */

/**
 * Named, not silently glossed over: derivation (#23-#26) has no train/
 * held-out split at all — #25's rule induction runs over every qa_pair in
 * the store unconditionally. The full offline-evaluation harness
 * v1-tech-design.md §1.10 describes (a real time-boundary split, hand-
 * labelled scoring) is a separate, later piece of work (wave W4's `e6`).
 * Calibration's own selection below (most-recent-first, excluding
 * anything already used in a prior session) is a lightweight, self-
 * contained approximation good enough to drive this review loop — not
 * that harness. Surfaced to the owner every time a session starts, in
 * the same spirit as AC2's "honest, not flattering."
 */
export const HELD_OUT_CAVEAT =
  "Note: derivation doesn't yet implement a real train/held-out split (a separate, later eval-harness issue), " +
  "so these questions may have already contributed evidence to the very rules being checked here. Treat this " +
  "as a sanity check on today's duo, not a rigorous held-out evaluation.";

export const CALIBRATION_JUDGEMENTS = ["approved", "rejected", "edited"] as const;
export type CalibrationJudgement = (typeof CALIBRATION_JUDGEMENTS)[number];

const DEFAULT_CALIBRATION_COUNT = 12;

export interface CalibrationItem {
  readonly qaPairId: string;
  readonly questionText: string;
  readonly realAnswerText: string;
  readonly topicId: string | null;
  /** The #32 draft-log row this item's generation wrote — the "feeds the same pipeline" link. */
  readonly draftId: string;
  /** The duo's proposed answer text, or null when it escalated instead of drafting one. */
  readonly proposedText: string | null;
  readonly escalated: boolean;
  readonly escalationReason: string | null;
}

export interface CalibrationSession {
  readonly id: string;
  readonly createdAt: string;
  /** Fixed at session creation — never re-selected on resume, so "resume where they stopped" (AC3) means the same items in the same order. */
  readonly items: readonly CalibrationItem[];
  readonly completedAt: string | null;
}

export interface CalibrationJudgementRecord {
  readonly qaPairId: string;
  readonly judgement: CalibrationJudgement;
  /** Set only for judgement "edited" — the owner's corrected text, the labelled training signal an edit produces (AC1). */
  readonly editedText: string | null;
  readonly judgedAt: string;
}

export function ensureCalibrationSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS calibration_sessions (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      items TEXT NOT NULL,
      completed_at TEXT
    ) STRICT
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS calibration_judgements (
      session_id TEXT NOT NULL,
      qa_pair_id TEXT NOT NULL,
      judgement TEXT NOT NULL,
      edited_text TEXT,
      judged_at TEXT NOT NULL,
      PRIMARY KEY (session_id, qa_pair_id)
    ) STRICT
  `);
}

interface SessionRow {
  id: string;
  created_at: string;
  items: string;
  completed_at: string | null;
}

function rowToSession(row: SessionRow): CalibrationSession {
  return {
    id: row.id,
    createdAt: row.created_at,
    items: JSON.parse(row.items) as CalibrationItem[],
    completedAt: row.completed_at,
  };
}

function putSessionRow(db: Database, session: CalibrationSession): void {
  db.prepare(
    `
    INSERT INTO calibration_sessions (id, created_at, items, completed_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET completed_at = excluded.completed_at
  `,
  ).run(session.id, session.createdAt, JSON.stringify(session.items), session.completedAt);
}

/** Every calibration session ever created, oldest first — used both to find an incomplete one to resume and to exclude previously-used qa_pairs from a fresh selection. */
export function listCalibrationSessions(storePath: string, passphrase: string): CalibrationSession[] {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensureCalibrationSchema(db);
    const rows = db.prepare(`SELECT * FROM calibration_sessions ORDER BY created_at, id`).all() as unknown as SessionRow[];
    return rows.map(rowToSession);
  });
}

/** The one incomplete session, if any — since startOrResumeCalibration never creates a second one while one is open, there is at most one. What `duo mirror calibrate judge`/`progress` resolve against, so the CLI never has to expose a session id the owner has to track by hand. */
export function findIncompleteCalibrationSession(storePath: string, passphrase: string): CalibrationSession | undefined {
  return listCalibrationSessions(storePath, passphrase)
    .slice()
    .reverse()
    .find((session) => session.completedAt === null);
}

/** The most recently created session regardless of completion — what `duo mirror calibrate summary` resolves against, so a summary works right after a session finishes without needing its id either. */
export function findLatestCalibrationSession(storePath: string, passphrase: string): CalibrationSession | undefined {
  const sessions = listCalibrationSessions(storePath, passphrase);
  return sessions[sessions.length - 1];
}

export function getCalibrationSession(storePath: string, passphrase: string, sessionId: string): CalibrationSession | undefined {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensureCalibrationSchema(db);
    const row = db.prepare(`SELECT * FROM calibration_sessions WHERE id = ?`).get(sessionId) as SessionRow | undefined;
    return row ? rowToSession(row) : undefined;
  });
}

interface JudgementRow {
  session_id: string;
  qa_pair_id: string;
  judgement: string;
  edited_text: string | null;
  judged_at: string;
}

function rowToJudgement(row: JudgementRow): CalibrationJudgementRecord {
  return {
    qaPairId: row.qa_pair_id,
    judgement: row.judgement as CalibrationJudgement,
    editedText: row.edited_text,
    judgedAt: row.judged_at,
  };
}

/** Every judgement recorded so far for one session, keyed by qa_pair id for O(1) lookup against a session's fixed item list. */
export function listCalibrationJudgements(storePath: string, passphrase: string, sessionId: string): CalibrationJudgementRecord[] {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensureCalibrationSchema(db);
    const rows = db.prepare(`SELECT * FROM calibration_judgements WHERE session_id = ?`).all(sessionId) as unknown as JudgementRow[];
    return rows.map(rowToJudgement);
  });
}

/** Pure: the first item in `session.items` (in order) with no recorded judgement yet, or undefined once every item has one. */
export function nextUnjudgedItem(
  session: CalibrationSession,
  judgements: readonly CalibrationJudgementRecord[],
): CalibrationItem | undefined {
  const judgedIds = new Set(judgements.map((judgement) => judgement.qaPairId));
  return session.items.find((item) => !judgedIds.has(item.qaPairId));
}

export type StartCalibrationResult =
  | { readonly status: "resumed"; readonly session: CalibrationSession }
  | { readonly status: "started"; readonly session: CalibrationSession }
  | { readonly status: "insufficient_history"; readonly available: number; readonly wanted: number };

/**
 * Starts a new calibration session, or hands back an already-incomplete
 * one to resume (AC3) — never re-selects a fresh set of questions while
 * one is in progress, which is what makes "resume where they stopped"
 * true rather than just "start over with a new random sample". Gated by
 * #29's onboarding requirement (AC2's own "finish onboarding" boundary —
 * this is the Mirror's last screen): throws RefusalsNotDecidedError
 * before anything else if the owner hasn't yet made a refusals decision.
 */
export async function startOrResumeCalibration(
  storePath: string,
  passphrase: string,
  duoDir: string,
  embeddingProvider: EmbeddingProvider,
  inferenceProvider: InferenceProvider | undefined,
  confidenceConfig: DuoConfig["confidence"],
  count: number = DEFAULT_CALIBRATION_COUNT,
): Promise<StartCalibrationResult> {
  requireRefusalsDecision(duoDir);

  const existingSessions = listCalibrationSessions(storePath, passphrase);
  const incomplete = existingSessions.find((session) => session.completedAt === null);
  if (incomplete) {
    return { status: "resumed", session: incomplete };
  }

  const usedIds = new Set(existingSessions.flatMap((session) => session.items.map((item) => item.qaPairId)));
  const candidates = listQaPairs(storePath, passphrase)
    .filter((pair) => !usedIds.has(pair.id))
    .sort((a, b) => b.ts.localeCompare(a.ts) || b.id.localeCompare(a.id))
    .slice(0, count);

  if (candidates.length === 0) {
    return { status: "insufficient_history", available: 0, wanted: count };
  }

  const items: CalibrationItem[] = [];
  for (const pair of candidates) {
    const question = getRecord(storePath, passphrase, pair.questionId);
    const answer = getRecord(storePath, passphrase, pair.answerId);
    if (!question || !answer) {
      continue; // a record removed since this pair was extracted — skip rather than crash a whole session over one stale citation
    }
    const draft = await draftReply(
      storePath,
      passphrase,
      duoDir,
      question.text,
      null,
      embeddingProvider,
      inferenceProvider,
      confidenceConfig,
    );
    items.push({
      qaPairId: pair.id,
      questionText: question.text,
      realAnswerText: answer.text,
      topicId: pair.topicId,
      draftId: draft.draftId,
      proposedText: draft.kind === "draft" ? draft.text : null,
      escalated: draft.kind === "escalation",
      escalationReason: draft.kind === "escalation" ? draft.reason : null,
    });
  }

  if (items.length === 0) {
    return { status: "insufficient_history", available: 0, wanted: count };
  }

  const session: CalibrationSession = { id: randomUUID(), createdAt: new Date().toISOString(), items, completedAt: null };
  withDatabase(storePath, passphrase, true, (db) => {
    ensureCalibrationSchema(db);
    putSessionRow(db, session);
  });
  return { status: "started", session };
}

export class CalibrationSessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`No calibration session with id "${sessionId}"`);
    this.name = "CalibrationSessionNotFoundError";
  }
}

export class CalibrationItemNotFoundError extends Error {
  constructor(sessionId: string, qaPairId: string) {
    super(`Calibration session "${sessionId}" has no item for qa_pair "${qaPairId}"`);
    this.name = "CalibrationItemNotFoundError";
  }
}

/** Thrown for a judgement that doesn't make sense for its item — editing an escalation (there is no draft text to edit) or supplying edited text for a non-"edited" judgement. */
export class InvalidCalibrationJudgementError extends Error {}

function outcomeForJudgement(judgement: CalibrationJudgement): DraftOutcome {
  switch (judgement) {
    case "approved":
      return "sent";
    case "rejected":
      return "discarded";
    case "edited":
      return "edited";
  }
}

export interface RecordJudgementResult {
  readonly session: CalibrationSession;
  readonly judgedCount: number;
  readonly totalCount: number;
}

/**
 * Records one judgement (AC1) and, once every item in the session has
 * one, marks the session complete. Re-judging an already-judged item
 * overwrites its previous judgement rather than erroring — the owner
 * working through the comparison should be free to change their mind on
 * an earlier item without restarting.
 *
 * For a non-escalated item, also calls #32's recordDraftOutcome against
 * the real draft-log row this item's generation created — "edits feed
 * the same pipeline as a corrected draft" (AC1), literally reusing the
 * function `duo draft-outcome` itself calls. Skipped for an escalated
 * item: there is no draft text for "sent/edited/discarded" to describe.
 */
export function recordCalibrationJudgement(
  storePath: string,
  passphrase: string,
  sessionId: string,
  qaPairId: string,
  judgement: CalibrationJudgement,
  editedText?: string,
): RecordJudgementResult {
  const session = getCalibrationSession(storePath, passphrase, sessionId);
  if (!session) {
    throw new CalibrationSessionNotFoundError(sessionId);
  }
  const item = session.items.find((candidate) => candidate.qaPairId === qaPairId);
  if (!item) {
    throw new CalibrationItemNotFoundError(sessionId, qaPairId);
  }
  if (judgement === "edited" && item.escalated) {
    throw new InvalidCalibrationJudgementError(
      `qa_pair "${qaPairId}" escalated instead of drafting an answer — there is no draft text to edit. Approve or reject the escalation itself instead.`,
    );
  }
  const trimmedEditedText = editedText?.trim();
  if (judgement === "edited" && (trimmedEditedText === undefined || trimmedEditedText.length === 0)) {
    throw new InvalidCalibrationJudgementError('An "edited" judgement needs non-empty edited text.');
  }
  if (judgement !== "edited" && trimmedEditedText !== undefined && trimmedEditedText.length > 0) {
    throw new InvalidCalibrationJudgementError(`Edited text was given for a "${judgement}" judgement — only "edited" takes one.`);
  }

  const judgedAt = new Date().toISOString();
  withDatabase(storePath, passphrase, true, (db) => {
    ensureCalibrationSchema(db);
    db.prepare(
      `
      INSERT INTO calibration_judgements (session_id, qa_pair_id, judgement, edited_text, judged_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id, qa_pair_id) DO UPDATE SET judgement = excluded.judgement, edited_text = excluded.edited_text, judged_at = excluded.judged_at
    `,
    ).run(sessionId, qaPairId, judgement, trimmedEditedText ?? null, judgedAt);
  });

  if (!item.escalated) {
    recordDraftOutcome(storePath, passphrase, item.draftId, outcomeForJudgement(judgement));
  }

  const judgements = listCalibrationJudgements(storePath, passphrase, sessionId);
  const judgedIds = new Set(judgements.map((j) => j.qaPairId));
  const nowComplete = session.items.every((candidate) => judgedIds.has(candidate.qaPairId));

  const updatedSession: CalibrationSession = { ...session, completedAt: nowComplete ? judgedAt : session.completedAt };
  if (nowComplete && session.completedAt === null) {
    withDatabase(storePath, passphrase, true, (db) => {
      ensureCalibrationSchema(db);
      putSessionRow(db, updatedSession);
    });
  }

  return { session: updatedSession, judgedCount: judgedIds.size, totalCount: session.items.length };
}

export interface CalibrationMismatch {
  readonly qaPairId: string;
  readonly questionText: string;
  readonly realAnswerText: string;
  readonly proposedText: string | null;
  readonly escalated: boolean;
  readonly judgement: CalibrationJudgement;
  readonly editedText: string | null;
}

export interface CalibrationSummary {
  readonly totalItems: number;
  readonly judgedCount: number;
  readonly approvedCount: number;
  readonly rejectedCount: number;
  readonly editedCount: number;
  /** approvedCount / judgedCount; 0, never NaN, when nothing has been judged yet. */
  readonly agreementRate: number;
  /** True when agreementRate is low enough that the run should be reported as a real problem, not glossed over (AC2). */
  readonly lowAgreement: boolean;
  /** Every rejected or edited item, in full — "what it looks like it is getting wrong" (AC2), never suppressed regardless of how bad it looks. */
  readonly mismatches: readonly CalibrationMismatch[];
}

/** Below this agreement rate (with at least one judgement made), a run is reported as a real problem rather than a middling number (AC2). */
const LOW_AGREEMENT_THRESHOLD = 0.5;

/** Pure: computes the honest summary AC2 asks for from a session and its judgements. */
export function buildCalibrationSummary(
  session: CalibrationSession,
  judgements: readonly CalibrationJudgementRecord[],
): CalibrationSummary {
  const byId = new Map(judgements.map((judgement) => [judgement.qaPairId, judgement]));
  let approvedCount = 0;
  let rejectedCount = 0;
  let editedCount = 0;
  const mismatches: CalibrationMismatch[] = [];

  for (const item of session.items) {
    const judgement = byId.get(item.qaPairId);
    if (!judgement) {
      continue;
    }
    if (judgement.judgement === "approved") {
      approvedCount += 1;
    } else if (judgement.judgement === "rejected") {
      rejectedCount += 1;
      mismatches.push({ ...toMismatchBase(item), judgement: judgement.judgement, editedText: null });
    } else {
      editedCount += 1;
      mismatches.push({ ...toMismatchBase(item), judgement: judgement.judgement, editedText: judgement.editedText });
    }
  }

  const judgedCount = judgements.length;
  const agreementRate = judgedCount === 0 ? 0 : approvedCount / judgedCount;

  return {
    totalItems: session.items.length,
    judgedCount,
    approvedCount,
    rejectedCount,
    editedCount,
    agreementRate,
    lowAgreement: judgedCount > 0 && agreementRate < LOW_AGREEMENT_THRESHOLD,
    mismatches,
  };
}

function toMismatchBase(item: CalibrationItem): Omit<CalibrationMismatch, "judgement" | "editedText"> {
  return {
    qaPairId: item.qaPairId,
    questionText: item.questionText,
    realAnswerText: item.realAnswerText,
    proposedText: item.proposedText,
    escalated: item.escalated,
  };
}
