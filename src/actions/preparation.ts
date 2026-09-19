import { randomUUID } from "node:crypto";
import type { Database } from "../store/store.js";
import { withDatabase } from "../store/store.js";
import { getRegisteredAction, registerAction, resolveActionForUse } from "./registry.js";

/**
 * T1 from `docs/concept.md` §6/§88: "Drafts visible only to the owner ...
 * cannot embarrass anyone. Richest training signal." #57's own story:
 * prepare work — drafts, documents, staged tickets — that only the owner
 * can see, never submitted anywhere by this module.
 *
 * Two design decisions, both deliberate:
 *
 * 1. **Visibility is inherited from the store, not re-implemented here.**
 *    `prepareArtifact` writes only into the owner's own encrypted personal
 *    store (`src/store/`, #17) — the same store `duo draft` and every
 *    derivation table already live in. Nobody without the store's
 *    passphrase can read it at all, so "only the owner can see it" (AC1)
 *    is a property this module inherits rather than something it has to
 *    enforce itself. There is no export in this module that writes
 *    anywhere else — no `submit`, `send`, or `share` function exists at
 *    all, and no import from `../shared-duo/` (a structural test asserts
 *    this) — which is what makes AC2 ("no configuration in which T1
 *    output is visible to others") true: there is no code path to a
 *    shared location, not merely a check that refuses one.
 *
 * 2. **The trust grid's autonomy level is deliberately not consulted for
 *    T1.** #56's `resolveActionForUse` is still called — a T1 action must
 *    be genuinely registered as T1 (never assumed) — but the `"ask"` /
 *    `"approve"` / `"auto"` level it returns is ignored. Concept.md
 *    describes T1 as "the cheapest trust in the system... genuinely
 *    incapable of embarrassing anyone," working "at n=1" with zero
 *    configuration (the already-shipped `duo draft` pipeline, #31-#34,
 *    never consults the trust grid either). Gating private preparation
 *    behind a per-topic grant would ask the owner's permission to show
 *    the owner their own private draft, which is a permission that would
 *    never be denied and only ever adds friction the story doesn't ask
 *    for.
 *
 * The issue's own open question — whether a prepared artifact should
 * expire if untouched — is deliberately left unresolved here rather than
 * guessed at: no expiry sweep exists in this module. Introducing timed
 * deletion would need its own policy decision (what counts as
 * "untouched", what an expiry records versus an explicit discard) that
 * the issue itself flags as open, not settled.
 */

export const PREPARED_ARTIFACT_KINDS = ["draft", "document", "ticket"] as const;
export type PreparedArtifactKind = (typeof PREPARED_ARTIFACT_KINDS)[number];

/** The three built-in T1 actions this module registers on demand (idempotent — re-registering with the same risk shape never changes tier or revokes anything, #56's own re-tiering logic only acts on a *rise*). */
function builtInActionId(kind: PreparedArtifactKind): string {
  return `prepare_${kind}`;
}

/**
 * Registers the built-in action only the first time it's used — never
 * re-asserts it on every call. Re-registering unconditionally would make
 * `resolveActionForUse`'s check below vacuous (this function would always
 * just have written the exact shape it's about to check) and would
 * silently undo #56 AC3's re-tiering mechanism the moment anyone else
 * legitimately re-tiers a `prepare_*` action id — the registry, not this
 * module, stays the one source of truth for what an action id currently
 * resolves to.
 */
function ensureBuiltInT1ActionRegistered(storePath: string, passphrase: string, kind: PreparedArtifactKind, topicId: string): void {
  const actionId = builtInActionId(kind);
  if (getRegisteredAction(storePath, passphrase, actionId)) {
    return;
  }
  registerAction(storePath, passphrase, {
    id: actionId,
    description: `Prepare a ${kind}, visible only to the owner, never submitted anywhere`,
    reversible: true,
    obligates: false,
    audience: "owner",
    topicIds: [topicId],
  });
}

export class NotAT1ActionError extends Error {
  constructor(actionId: string) {
    super(`"${actionId}" did not resolve to a T1 (private-preparation) action.`);
    this.name = "NotAT1ActionError";
  }
}

export interface PreparedArtifact {
  readonly id: string;
  readonly actionId: string;
  readonly topicId: string;
  readonly kind: PreparedArtifactKind;
  readonly title: string;
  readonly content: string;
  readonly createdAt: string;
}

interface PreparedArtifactRow {
  id: string;
  action_id: string;
  topic_id: string;
  kind: string;
  title: string;
  content: string;
  created_at: string;
}

function rowToArtifact(row: PreparedArtifactRow): PreparedArtifact {
  return { id: row.id, actionId: row.action_id, topicId: row.topic_id, kind: row.kind as PreparedArtifactKind, title: row.title, content: row.content, createdAt: row.created_at };
}

/** Created on demand, matching every other table in this codebase. Deliberately not append-only (unlike action_attempts/audit_log/trust_ledger) — a prepared artifact is meant to be deleted entirely on discard (AC3), which is the opposite guarantee. */
function ensurePreparationSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS prepared_artifacts (
      id TEXT PRIMARY KEY,
      action_id TEXT NOT NULL,
      topic_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT
  `);
}

export interface PreparationDiscardSignal {
  readonly id: string;
  readonly artifactId: string;
  readonly kind: PreparedArtifactKind;
  readonly title: string;
  readonly preparedAt: string;
  readonly discardedAt: string;
  readonly note: string | null;
}

interface DiscardRow {
  id: string;
  artifact_id: string;
  kind: string;
  title: string;
  prepared_at: string;
  discarded_at: string;
  note: string | null;
}

function rowToSignal(row: DiscardRow): PreparationDiscardSignal {
  return { id: row.id, artifactId: row.artifact_id, kind: row.kind as PreparedArtifactKind, title: row.title, preparedAt: row.prepared_at, discardedAt: row.discarded_at, note: row.note };
}

/**
 * A discard is a real, recorded signal that this preparation was not
 * wanted (AC3) — kept even after the artifact row itself is deleted
 * entirely, which is why this is its own table rather than a status flag
 * on `prepared_artifacts`. Not append-only-enforced with DB triggers like
 * `audit_log`/`trust_ledger`/`action_attempts`: those exist to make a
 * refusal or a security-relevant event non-repudiable; this is a training
 * signal for the correction loop, not a trust boundary, and no export in
 * this module updates or deletes one regardless.
 */
function ensurePreparationSignalsSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS preparation_discard_signals (
      id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      prepared_at TEXT NOT NULL,
      discarded_at TEXT NOT NULL,
      note TEXT
    ) STRICT
  `);
}

/**
 * Prepares an artifact — a draft, document, or staged ticket — visible
 * only to the owner. Confirms via #56's registry that the corresponding
 * built-in action genuinely resolves to T1 (auto-registering it on demand
 * with a fixed, safe risk shape) before writing anything; refuses
 * (`NotAT1ActionError`) if a topic's history somehow retiered it away from
 * T1 — see this module's own doc comment for why the grid's autonomy
 * *level* is otherwise ignored here.
 */
export function prepareArtifact(
  storePath: string,
  passphrase: string,
  duoDir: string,
  input: { kind: PreparedArtifactKind; topicId: string; title: string; content: string },
): PreparedArtifact {
  const actionId = builtInActionId(input.kind);
  ensureBuiltInT1ActionRegistered(storePath, passphrase, input.kind, input.topicId);

  const resolution = resolveActionForUse(storePath, passphrase, duoDir, actionId, input.topicId);
  if (resolution.status !== "resolved" || resolution.tier !== "T1") {
    throw new NotAT1ActionError(actionId);
  }

  return withDatabase(storePath, passphrase, true, (db) => {
    ensurePreparationSchema(db);
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    db.prepare(`INSERT INTO prepared_artifacts (id, action_id, topic_id, kind, title, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      id,
      actionId,
      input.topicId,
      input.kind,
      input.title,
      input.content,
      createdAt,
    );
    return { id, actionId, topicId: input.topicId, kind: input.kind, title: input.title, content: input.content, createdAt };
  });
}

export function getPreparedArtifact(storePath: string, passphrase: string, id: string): PreparedArtifact | undefined {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensurePreparationSchema(db);
    const row = db.prepare(`SELECT * FROM prepared_artifacts WHERE id = ?`).get(id) as PreparedArtifactRow | undefined;
    return row ? rowToArtifact(row) : undefined;
  });
}

/** Every prepared artifact, oldest first — all of it, by construction, "prepared by the duo and not submitted anywhere" (AC1), since nothing in this module ever submits one. */
export function listPreparedArtifacts(storePath: string, passphrase: string): PreparedArtifact[] {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensurePreparationSchema(db);
    const rows = db.prepare(`SELECT * FROM prepared_artifacts ORDER BY created_at ASC`).all() as unknown as PreparedArtifactRow[];
    return rows.map(rowToArtifact);
  });
}

export class PreparedArtifactNotFoundError extends Error {
  constructor(id: string) {
    super(`No prepared artifact with id "${id}".`);
    this.name = "PreparedArtifactNotFoundError";
  }
}

/**
 * Discards a prepared artifact: removed entirely (AC3 — "leaves nothing"),
 * and the discard itself is recorded as a signal, in the same transaction,
 * so it survives even though the artifact row it describes does not.
 */
export function discardArtifact(storePath: string, passphrase: string, id: string, note?: string): PreparationDiscardSignal {
  return withDatabase(storePath, passphrase, true, (db) => {
    ensurePreparationSchema(db);
    ensurePreparationSignalsSchema(db);

    const row = db.prepare(`SELECT * FROM prepared_artifacts WHERE id = ?`).get(id) as PreparedArtifactRow | undefined;
    if (!row) {
      throw new PreparedArtifactNotFoundError(id);
    }

    db.prepare(`DELETE FROM prepared_artifacts WHERE id = ?`).run(id);

    const signalId = randomUUID();
    const discardedAt = new Date().toISOString();
    db.prepare(`INSERT INTO preparation_discard_signals (id, artifact_id, kind, title, prepared_at, discarded_at, note) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      signalId,
      row.id,
      row.kind,
      row.title,
      row.created_at,
      discardedAt,
      note ?? null,
    );

    return { id: signalId, artifactId: row.id, kind: row.kind as PreparedArtifactKind, title: row.title, preparedAt: row.created_at, discardedAt, note: note ?? null };
  });
}

/** Every discard signal ever recorded, oldest first — the training-signal read: which prepared artifacts were never wanted, and (when given) why. */
export function listDiscardSignals(storePath: string, passphrase: string): PreparationDiscardSignal[] {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensurePreparationSignalsSchema(db);
    const rows = db.prepare(`SELECT * FROM preparation_discard_signals ORDER BY discarded_at ASC`).all() as unknown as DiscardRow[];
    return rows.map(rowToSignal);
  });
}
