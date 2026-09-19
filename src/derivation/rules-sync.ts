import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withDatabase } from "../store/store.js";
import {
  RULE_ORIGINS,
  RULE_REVIEW_STATUSES,
  RULE_STATUSES,
  deleteRule,
  listRuleEvidence,
  listRules,
  putRule,
  type Rule,
  type RuleOrigin,
  type RuleReviewStatus,
  type RuleStatus,
} from "./rules.js";

/**
 * `duo/rules/*.md` is the source of truth for humans (v1-tech-design.md
 * §1.3); the `rules` table is a projection for retrieval. "Hand-edits to
 * the files win, and a sync step reconciles them" — this is that step.
 * One file per rule (AC4), named `<rule id>.md` so identity never depends
 * on successfully parsing a file's contents (needed for AC2: a file with
 * broken frontmatter must still be recognized as *this* rule's file, not
 * mistaken for a missing one).
 */
function rulesDir(duoDir: string): string {
  return join(duoDir, "rules");
}

function ruleFilePath(duoDir: string, ruleId: string): string {
  return join(rulesDir(duoDir), `${ruleId}.md`);
}

/**
 * Which rule ids have ever had a file written for them. Needed to tell
 * apart "this rule was just induced and has never been materialized to a
 * file yet" (write one) from "this rule's file existed and was deleted"
 * (AC3 — remove it from the store instead). A hidden bookkeeping file
 * rather than a `rules` table column: it's sync's own state, not part of
 * what #25 already shipped, and keeping it file-side means #25 needed no
 * migration for #26 to build on it.
 */
function syncStatePath(duoDir: string): string {
  return join(rulesDir(duoDir), ".sync-state.json");
}

function readSyncState(duoDir: string): Set<string> {
  const path = syncStatePath(duoDir);
  if (!existsSync(path)) {
    return new Set();
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return new Set(Array.isArray(parsed) ? (parsed as string[]) : []);
}

function writeSyncState(duoDir: string, ids: ReadonlySet<string>): void {
  writeFileSync(syncStatePath(duoDir), `${JSON.stringify([...ids].sort(), null, 2)}\n`, "utf8");
}

/** Thrown for a rule file whose frontmatter can't be trusted — named so callers report the exact file and problem (AC2) rather than guessing. */
export class MalformedRuleFileError extends Error {
  readonly file: string;

  constructor(file: string, detail: string) {
    super(`Malformed rule file "${file}": ${detail}`);
    this.name = "MalformedRuleFileError";
    this.file = file;
  }
}

function yamlScalar(value: string | number | null): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "number") {
    return String(value);
  }
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function unquote(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return trimmed;
}

/**
 * Serializes a rule to the exact narrow frontmatter format `parseRuleFile`
 * reads back — not general YAML, just enough structure for a human to read
 * and edit safely (AC4) and for this module to parse deterministically.
 */
export function serializeRuleFile(rule: Rule, evidence: readonly string[]): string {
  const evidenceBlock =
    evidence.length === 0 ? "evidence: []" : `evidence:\n${evidence.map((id) => `  - ${yamlScalar(id)}`).join("\n")}`;
  const frontmatter = [
    `id: ${yamlScalar(rule.id)}`,
    `topic: ${yamlScalar(rule.topicId)}`,
    `status: ${rule.status}`,
    `support: ${rule.supportCount}`,
    `consistency: ${rule.consistency}`,
    `created_at: ${yamlScalar(rule.createdAt)}`,
    `last_confirmed_at: ${yamlScalar(rule.lastConfirmedAt)}`,
    // #28: the owner's own review decision, written into the same file the
    // owner already hand-edits — approving/rejecting/promoting (#28) rewrites
    // these two lines, which is what makes the decision visible in the file
    // itself and durable across the next `duo derive sync` ("files win").
    `review_status: ${rule.reviewStatus}`,
    `origin: ${rule.origin}`,
    evidenceBlock,
  ].join("\n");
  return `---\n${frontmatter}\n---\n\n${rule.text}\n`;
}

interface ParsedRuleFile {
  rule: Rule;
  evidence: string[];
}

/** Parses exactly what serializeRuleFile writes — a hand-edit is expected to keep this shape; anything else is reported via MalformedRuleFileError rather than silently misread. */
export function parseRuleFile(filePath: string, content: string): ParsedRuleFile {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") {
    throw new MalformedRuleFileError(filePath, "expected the file to start with a --- frontmatter delimiter");
  }
  const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closingIndex === -1) {
    throw new MalformedRuleFileError(filePath, "no closing --- frontmatter delimiter found");
  }

  const fields = new Map<string, string>();
  const evidence: string[] = [];
  let i = 1;
  while (i < closingIndex) {
    const line = lines[i];
    const match = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (!match) {
      throw new MalformedRuleFileError(filePath, `unrecognized frontmatter line ${i + 1}: "${line}"`);
    }
    const [, key, rest] = match;
    if (key === "evidence") {
      if (rest.trim() !== "" && rest.trim() !== "[]") {
        throw new MalformedRuleFileError(filePath, `expected "evidence:" to be followed by a list or [], got "${rest}"`);
      }
      i += 1;
      while (i < closingIndex && /^\s*-\s+/.test(lines[i])) {
        evidence.push(unquote(lines[i].replace(/^\s*-\s+/, "")));
        i += 1;
      }
      continue;
    }
    fields.set(key, unquote(rest));
    i += 1;
  }

  const body = lines
    .slice(closingIndex + 1)
    .join("\n")
    .trim();

  const id = fields.get("id");
  const topicId = fields.get("topic");
  const status = fields.get("status");
  const supportRaw = fields.get("support");
  const consistencyRaw = fields.get("consistency");
  const createdAt = fields.get("created_at");
  const lastConfirmedAtRaw = fields.get("last_confirmed_at");
  const reviewStatusRaw = fields.get("review_status");
  const originRaw = fields.get("origin");

  if (!id) {
    throw new MalformedRuleFileError(filePath, 'missing required field "id"');
  }
  if (!topicId) {
    throw new MalformedRuleFileError(filePath, 'missing required field "topic"');
  }
  if (!status || !(RULE_STATUSES as readonly string[]).includes(status)) {
    throw new MalformedRuleFileError(filePath, `field "status" must be one of ${RULE_STATUSES.join(", ")}, got "${status}"`);
  }
  const supportCount = Number(supportRaw);
  if (supportRaw === undefined || !Number.isInteger(supportCount) || supportCount < 0) {
    throw new MalformedRuleFileError(filePath, `field "support" must be a non-negative integer, got "${supportRaw}"`);
  }
  const consistency = Number(consistencyRaw);
  if (consistencyRaw === undefined || Number.isNaN(consistency)) {
    throw new MalformedRuleFileError(filePath, `field "consistency" must be a number, got "${consistencyRaw}"`);
  }
  if (!createdAt) {
    throw new MalformedRuleFileError(filePath, 'missing required field "created_at"');
  }
  if (body.length === 0) {
    throw new MalformedRuleFileError(filePath, "rule body (the markdown text after frontmatter) is empty");
  }
  // Optional, defaulting rather than required: a file written before #28
  // shipped (or a hand-edit that only touches the fields it cares about)
  // has neither field, and that must still parse — "pending"/"derived" are
  // exactly what a rule that has never been reviewed already means.
  if (reviewStatusRaw !== undefined && !(RULE_REVIEW_STATUSES as readonly string[]).includes(reviewStatusRaw)) {
    throw new MalformedRuleFileError(
      filePath,
      `field "review_status" must be one of ${RULE_REVIEW_STATUSES.join(", ")}, got "${reviewStatusRaw}"`,
    );
  }
  if (originRaw !== undefined && !(RULE_ORIGINS as readonly string[]).includes(originRaw)) {
    throw new MalformedRuleFileError(filePath, `field "origin" must be one of ${RULE_ORIGINS.join(", ")}, got "${originRaw}"`);
  }

  return {
    rule: {
      id,
      topicId,
      status: status as RuleStatus,
      supportCount,
      consistency,
      createdAt,
      lastConfirmedAt: lastConfirmedAtRaw === undefined || lastConfirmedAtRaw === "null" ? null : lastConfirmedAtRaw,
      reviewStatus: (reviewStatusRaw as RuleReviewStatus | undefined) ?? "pending",
      origin: (originRaw as RuleOrigin | undefined) ?? "derived",
      text: body,
    },
    evidence,
  };
}

export interface RuleSyncSummary {
  /** Rule ids whose DB row was written or updated from a valid file, or freshly materialized to a file. */
  readonly synced: readonly string[];
  /** Rule ids removed from the store because their file was deleted since the last sync (AC3). */
  readonly deleted: readonly string[];
  /** Malformed files: reported, left in place, and the corresponding DB row (if any) left untouched (AC2). */
  readonly malformed: readonly { file: string; reason: string }[];
}

/**
 * Reconciles `duo/rules/*.md` with the `rules` table. Two directions in
 * one pass:
 * - A rule with no file yet (freshly induced by #25's `duo derive rules`)
 *   gets one written, materializing it for the owner to read and edit.
 * - A rule with a *valid* file has that file's content overwrite the DB
 *   row and its evidence — files win (AC1), even over what induction most
 *   recently computed, which is exactly what makes a hand-edit "stick"
 *   across a later re-run.
 * - A rule with a *malformed* file is reported (AC2) and its DB row (if
 *   any) is left exactly as it was; the file itself is never touched.
 * - A rule that *had* a file, now doesn't, is removed from the store along
 *   with its evidence (AC3).
 */
export function syncRulesFiles(storePath: string, passphrase: string, duoDir: string): RuleSyncSummary {
  mkdirSync(rulesDir(duoDir), { recursive: true });

  const dbRules = new Map(listRules(storePath, passphrase).map((rule) => [rule.id, rule]));
  const previouslySynced = readSyncState(duoDir);

  const filenames = readdirSync(rulesDir(duoDir)).filter((name) => name.endsWith(".md"));
  const validFiles = new Map<string, ParsedRuleFile>();
  const malformed: { file: string; reason: string }[] = [];
  const malformedIds = new Set<string>();
  for (const filename of filenames) {
    const id = filename.slice(0, -".md".length);
    const filePath = ruleFilePath(duoDir, id);
    try {
      const parsed = parseRuleFile(filePath, readFileSync(filePath, "utf8"));
      validFiles.set(id, parsed);
    } catch (error) {
      malformed.push({ file: filePath, reason: error instanceof Error ? error.message : String(error) });
      malformedIds.add(id);
    }
  }

  const allIds = new Set([...dbRules.keys(), ...validFiles.keys(), ...malformedIds]);
  const synced: string[] = [];
  const deleted: string[] = [];
  const nextSynced = new Set<string>();
  const toWrite: { rule: Rule; evidence: readonly string[] }[] = [];
  const toDelete: string[] = [];

  for (const id of allIds) {
    if (validFiles.has(id)) {
      const parsed = validFiles.get(id)!;
      toWrite.push({ rule: parsed.rule, evidence: parsed.evidence });
      nextSynced.add(id);
      synced.push(id);
    } else if (malformedIds.has(id)) {
      // Leave the DB row exactly as-is; still has a file, so still "synced".
      nextSynced.add(id);
    } else if (previouslySynced.has(id)) {
      toDelete.push(id);
      deleted.push(id);
    } else if (dbRules.has(id)) {
      // Freshly induced, never materialized — write its file now.
      const rule = dbRules.get(id)!;
      writeFileSync(ruleFilePath(duoDir, id), serializeRuleFile(rule, listRuleEvidence(storePath, passphrase, id)));
      nextSynced.add(id);
      synced.push(id);
    }
  }

  withDatabase(storePath, passphrase, true, (db) => {
    for (const { rule, evidence } of toWrite) {
      putRule(db, rule, evidence);
    }
    for (const id of toDelete) {
      deleteRule(db, id);
    }
  });

  writeSyncState(duoDir, nextSynced);

  return { synced, deleted, malformed };
}
