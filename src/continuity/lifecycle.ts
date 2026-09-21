import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { revokeAllAutonomy } from "../trust/grid.js";
import { assertSafeDataDir, dataDirFor, deleteStoreFiles, listStoreFiles } from "../store/store.js";
import { appendLifecycleEvent } from "./lifecycle-log.js";

/**
 * `docs/concept.md` §11: "duos are self-created and instantly killable,"
 * and a duo outliving its owner's employment without an explicit decision
 * is the accountability gap the review flagged. Every state transition
 * here is a deliberate, named act — never inferred, never automatic.
 */
export const DUO_LIFECYCLE_STATUSES = ["active", "archived", "orphaned"] as const;
export type DuoLifecycleStatus = (typeof DUO_LIFECYCLE_STATUSES)[number];

export interface DuoLifecycleRecord {
  readonly status: DuoLifecycleStatus;
  readonly archivedBy: string | null;
  readonly archivedAt: string | null;
  readonly orphanedBy: string | null;
  readonly orphanedAt: string | null;
  readonly orphanReason: string | null;
  /** Set once a transfer completes (see transfer.ts) — who it came from/went to and when, kept as history even though `status` stays `"active"` afterward (a transfer changes ownership, not liveness). */
  readonly transferredFrom: string | null;
  readonly transferredTo: string | null;
  readonly transferredAt: string | null;
}

const DEFAULT_LIFECYCLE: DuoLifecycleRecord = {
  status: "active",
  archivedBy: null,
  archivedAt: null,
  orphanedBy: null,
  orphanedAt: null,
  orphanReason: null,
  transferredFrom: null,
  transferredTo: null,
  transferredAt: null,
};

function lifecycleFilePath(duoDir: string): string {
  return join(duoDir, "lifecycle.json");
}

/** Returns the default ("active", nothing recorded) when the file doesn't exist yet — a brand-new duo has no lifecycle history, not an error. */
export function readLifecycle(duoDir: string): DuoLifecycleRecord {
  const path = lifecycleFilePath(duoDir);
  if (!existsSync(path)) {
    return DEFAULT_LIFECYCLE;
  }
  return { ...DEFAULT_LIFECYCLE, ...(JSON.parse(readFileSync(path, "utf8")) as Partial<DuoLifecycleRecord>) };
}

/** The one place `duo/lifecycle.json` is ever written — exported so transfer.ts can update `transferredFrom`/`transferredTo`/`transferredAt` on completion without duplicating this file's I/O. */
export function writeLifecycle(duoDir: string, record: DuoLifecycleRecord): void {
  mkdirSync(duoDir, { recursive: true });
  writeFileSync(lifecycleFilePath(duoDir), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

export class InvalidLifecycleActionError extends Error {}

/** Thrown by `assertOwnerConsultable`/`assertPredecessorConsultable` — named so a caller can distinguish "archived" from "orphaned" without parsing the message, and the message itself always names who decided/reported it and when. */
export class DuoNotConsultableError extends Error {
  readonly status: DuoLifecycleStatus;

  constructor(status: DuoLifecycleStatus, detail: string) {
    super(detail);
    this.name = "DuoNotConsultableError";
    this.status = status;
  }
}

/**
 * #63 AC1: archives the duo with an explicit decision — records who and
 * when, and revokes every autonomy grant outright (never partially: an
 * archived duo has no live autonomy left to exercise). Refuses to archive
 * an already-orphaned duo silently overwriting that fact; archiving an
 * already-archived duo is allowed (re-recording the same decision is
 * harmless and sometimes exactly what re-running the command means).
 */
export function archiveDuo(storePath: string, passphrase: string, duoDir: string, lifecycleLogPath: string, decidedBy: string): DuoLifecycleRecord {
  const trimmed = decidedBy.trim();
  if (trimmed.length === 0) {
    throw new InvalidLifecycleActionError("Archiving a duo requires naming who decided it.");
  }
  const current = readLifecycle(duoDir);
  if (current.status === "orphaned") {
    throw new InvalidLifecycleActionError(
      `This duo was declared orphaned (by ${current.orphanedBy} on ${current.orphanedAt}) — archive it only once someone has confirmed who is deciding this, not silently over an orphan declaration.`,
    );
  }
  const now = new Date().toISOString();
  const revokedCells = revokeAllAutonomy(storePath, passphrase, `archived by ${trimmed}`);
  const record: DuoLifecycleRecord = { ...current, status: "archived", archivedBy: trimmed, archivedAt: now };
  writeLifecycle(duoDir, record);
  appendLifecycleEvent(lifecycleLogPath, { eventType: "archived", actor: trimmed, detail: { revokedCells } });
  return record;
}

/**
 * #63 AC4: records the deliberate, human-reported fact that an owner has
 * left with no archival or transfer ever performed — there is no way for
 * this codebase to detect that on its own (no HR/identity integration
 * exists), so, like every other thing this codebase can't verify itself
 * (a refusal, a classification marking, #72's consent), it becomes an
 * explicit act someone takes responsibility for by name.
 */
export function declareOrphaned(duoDir: string, lifecycleLogPath: string, reportedBy: string, reason: string): DuoLifecycleRecord {
  const trimmedReporter = reportedBy.trim();
  const trimmedReason = reason.trim();
  if (trimmedReporter.length === 0) {
    throw new InvalidLifecycleActionError("Declaring a duo orphaned requires naming who is reporting it.");
  }
  if (trimmedReason.length === 0) {
    throw new InvalidLifecycleActionError("Declaring a duo orphaned requires a reason.");
  }
  const current = readLifecycle(duoDir);
  if (current.status === "archived") {
    throw new InvalidLifecycleActionError(
      `This duo is already archived (by ${current.archivedBy} on ${current.archivedAt}) — archival already accounts for its ownership; declaring it orphaned on top would contradict that recorded decision.`,
    );
  }
  const now = new Date().toISOString();
  const record: DuoLifecycleRecord = { ...current, status: "orphaned", orphanedBy: trimmedReporter, orphanedAt: now, orphanReason: trimmedReason };
  writeLifecycle(duoDir, record);
  appendLifecycleEvent(lifecycleLogPath, { eventType: "orphan_declared", actor: trimmedReporter, detail: { reason: trimmedReason } });
  return record;
}

/** #63 AC1: the owner's own live surface (`duo draft`) must refuse once archived — an archived duo "stops answering in the present tense" — and, like every surface, refuses once orphaned. */
export function assertOwnerConsultable(duoDir: string): void {
  const record = readLifecycle(duoDir);
  if (record.status === "archived") {
    throw new DuoNotConsultableError(
      "archived",
      `This duo was archived by ${record.archivedBy} on ${record.archivedAt} and no longer answers in the present tense. ` +
        "Consult it as a historical record instead (\`duo continuity consult\`).",
    );
  }
  if (record.status === "orphaned") {
    throw new DuoNotConsultableError(
      "orphaned",
      `This duo has no accountable owner (declared orphaned by ${record.orphanedBy} on ${record.orphanedAt}: ${record.orphanReason}). ` +
        "It cannot answer for someone unreachable.",
    );
  }
}

/** #63 AC4: even the historical-record surface (`duo continuity consult`, #61) must refuse once orphaned — an archived duo still names someone accountable to frame the answer around; an orphaned one names nobody. */
export function assertPredecessorConsultable(duoDir: string): void {
  const record = readLifecycle(duoDir);
  if (record.status === "orphaned") {
    throw new DuoNotConsultableError(
      "orphaned",
      `This duo has no accountable owner (declared orphaned by ${record.orphanedBy} on ${record.orphanedAt}: ${record.orphanReason}). ` +
        "It cannot answer for someone unreachable.",
    );
  }
}

/** Thrown instead of touching the filesystem when `duoDir` resolves to somewhere `endDuo` must never recursively delete — the same guard `assertSafeDataDir` applies to the encrypted store's directory, mirrored here for the derived-output directory. */
export class UnsafeDuoDirError extends Error {
  constructor(duoDir: string) {
    super(
      `Refusing to use "${duoDir}" as the duo's derived-output directory: it is the current directory, the home ` +
        'directory, or the filesystem root. Set DUO_DIR to its own dedicated subdirectory (e.g. "duo"), since ' +
        "ending a duo deletes that whole directory.",
    );
    this.name = "UnsafeDuoDirError";
  }
}

function assertSafeDuoDir(duoDir: string): string {
  const resolved = resolve(duoDir);
  const unsafe = new Set([resolve(process.cwd()), resolve(homedir()), resolve("/")]);
  if (unsafe.has(resolved)) {
    throw new UnsafeDuoDirError(resolved);
  }
  return resolved;
}

function listFilesRecursive(dir: string, base: string = dir): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(fullPath, base));
    } else if (entry.isFile()) {
      files.push(relative(base, fullPath));
    }
  }
  return files.sort();
}

/** Every file currently under `duoDir` — the derived-output half of what `endDuo` reports and deletes (topics.json, rules/*.md, voice.md, refusals.md, lifecycle.json, transfers.json, and anything else this codebase ever writes there). */
export function listDuoDirFiles(duoDir: string): string[] {
  if (!existsSync(duoDir) || !statSync(duoDir).isDirectory()) {
    return [];
  }
  return listFilesRecursive(duoDir);
}

export interface EndDuoResult {
  /** Whether `confirmed` was true and deletion actually ran. */
  readonly confirmed: boolean;
  readonly storeDataDir: string;
  /** Files under the store's data directory, relative paths — the corpus, its embeddings, and its passphrase. */
  readonly storePaths: readonly string[];
  readonly duoDir: string;
  /** Files under `duoDir`, relative paths — the derived artifacts and standing orders. */
  readonly duoDirPaths: readonly string[];
}

/**
 * #63 AC3: ends a duo completely — the encrypted store's whole data
 * directory (via #17's `deleteStoreFiles`, exactly what `duo purge`
 * already does to it) *and* `duoDir` (which `duo purge` deliberately never
 * touches — #17/#26's own "never purged by `duo purge`" invariant for
 * that directory stays true; this is a separate, stronger, and
 * intentionally distinct action, not a change to `duo purge`'s existing
 * contract). Without `confirmed`, this only ever reads the filesystem and
 * reports what *would* be deleted — the same "describe, then require an
 * explicit confirm" shape `duo purge` established, so a caller can show the
 * owner what's about to disappear before it's irreversible.
 */
export function endDuo(storePath: string, duoDir: string, confirmed: boolean): EndDuoResult {
  assertSafeDataDir(storePath);
  const safeDuoDir = assertSafeDuoDir(duoDir);
  const storeDataDir = dataDirFor(storePath);
  const storePaths = listStoreFiles(storePath);
  const duoDirPaths = listDuoDirFiles(duoDir);

  if (confirmed) {
    if (storePaths.length > 0) {
      deleteStoreFiles(storePath);
    }
    if (duoDirPaths.length > 0) {
      rmSync(duoDir, { recursive: true, force: true });
    }
  }

  return { confirmed, storeDataDir, storePaths, duoDir: safeDuoDir, duoDirPaths };
}

/**
 * Appends the "ended" event, meant to be called *after* `endDuo` has
 * already run with `confirmed: true` and returned exactly what it
 * deleted. This is safe precisely because the log lives in its own
 * directory (see lifecycle-log.ts's own doc comment), never inside the
 * store's data directory or `duoDir` — so calling it after, once the
 * outcome is known for certain, records what actually happened rather
 * than what was merely *about* to happen (had the deletion itself failed
 * partway, this would then correctly never run at all).
 */
export function recordEndDuo(lifecycleLogPath: string, decidedBy: string, result: EndDuoResult): void {
  appendLifecycleEvent(lifecycleLogPath, {
    eventType: "ended",
    actor: decidedBy,
    detail: { storeDataDir: result.storeDataDir, storePaths: result.storePaths, duoDir: result.duoDir, duoDirPaths: result.duoDirPaths },
  });
}

/**
 * #181: `endDuo` plus the audit event, as one act — the exact composition
 * `duo lifecycle end` performs, in the module so the HTTP surface calls
 * the same two steps in the same order rather than a route re-deriving
 * the "log only what actually got deleted" sequencing. The audit is
 * written only when the deletion really ran *and* really deleted
 * something, mirroring the command wiring exactly.
 */
export function endDuoAndRecord(storePath: string, duoDir: string, lifecycleLogPath: string, decidedBy: string, confirmed: boolean): EndDuoResult {
  const result = endDuo(storePath, duoDir, confirmed);
  if (confirmed && (result.storePaths.length > 0 || result.duoDirPaths.length > 0)) {
    recordEndDuo(lifecycleLogPath, decidedBy, result);
  }
  return result;
}
