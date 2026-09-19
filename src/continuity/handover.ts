import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildInterruptionPortrait } from "../derivation/portrait.js";
import { describeRuleWithEvidence, listActiveRules, type RuleEvidenceExchange } from "../derivation/rule-review.js";
import { listDrafts } from "../drafting/draft-log.js";
import { dataDirFor } from "../store/store.js";
import { hasRefusalsDecision, readRefusalsFile } from "../trust/refusals.js";

/**
 * `docs/concept.md` §4, #62's own user story: "the duo already holds the
 * topic taxonomy, the standing orders, the refusals, the asker graph, and
 * the open threads — which is most of a real handover, assembled from
 * evidence rather than from memory on the last week." This module only
 * assembles what #23/#24/#25/#27/#28/#29/#32/#34 already derived — nothing
 * here re-derives a topic, re-scores a rule, or re-runs the drafting
 * pipeline.
 *
 * Design decision on the issue's own flagged open question ("should the
 * pack be a document, a seeded duo for the successor, or both"): a
 * document. Seeding a duo *for* a specific successor would duplicate #72's
 * role-duo seeding (multi-holder, consent-gated) for a single-holder case
 * it isn't designed for, and this issue's own out-of-scope note ("transfer
 * of the duo itself — that is #13.3") makes clear the pack is a handover
 * artifact, not a transfer mechanism (#63's job).
 */

/**
 * One item in a handover pack section — every section's items carry `id`
 * (stable, and *prefixed per section* — e.g. a rule and the topic it was
 * derived from can share the same underlying id, `rules.ts`'s own
 * one-rule-per-topic convention, and a bare id would then cut both at
 * once) and `excluded` (#62 AC2: the owner cuts an item by flipping this,
 * never by it silently vanishing).
 */
export interface HandoverRecurringQuestion {
  readonly id: string;
  readonly excluded: boolean;
  readonly label: string;
  readonly count: number;
  readonly share: number;
}

export interface HandoverStandingOrder {
  readonly id: string;
  readonly excluded: boolean;
  readonly topicId: string;
  readonly text: string;
  readonly supportCount: number;
  readonly evidence: readonly RuleEvidenceExchange[];
}

export interface HandoverRefusal {
  readonly id: string;
  readonly excluded: boolean;
  readonly heading: string;
  readonly reason: string;
}

/** "Who asks about what" — busiest *threads*, not resolved to individual people, the same honest stand-in #27's own portrait already states (`IngestRecord` carries no per-person asker identity yet). */
export interface HandoverAskerActivity {
  readonly id: string;
  readonly excluded: boolean;
  readonly threadId: string;
  readonly count: number;
  readonly share: number;
}

/** An escalated question nobody has ever recorded a final disposition for (`duo draft-outcome`/`duo draft-answer`) — a real thread still open, traceable back to its own draft row. */
export interface HandoverOpenThread {
  readonly id: string;
  readonly excluded: boolean;
  readonly question: string;
  readonly escalationReason: string | null;
  readonly createdAt: string;
}

export interface HandoverPack {
  readonly generatedAt: string;
  readonly recurringQuestions: readonly HandoverRecurringQuestion[];
  readonly standingOrders: readonly HandoverStandingOrder[];
  readonly refusals: readonly HandoverRefusal[];
  readonly askerActivity: readonly HandoverAskerActivity[];
  readonly openThreads: readonly HandoverOpenThread[];
  /** #62 AC3: what this pack could not cover, stated plainly — a thin corpus produces an honest, shorter pack, never a padded one. */
  readonly gaps: readonly string[];
}

/**
 * Assembles a handover pack purely from what has already been derived —
 * #23/#24/#27's interruption portrait for recurring questions and thread
 * activity, #25/#28/#29's active rules (with #28's own evidence-tracing) for
 * standing orders, `duo/refusals.md` verbatim for refusals, and any
 * escalated draft with no recorded outcome for open threads. Every item's
 * `excluded` starts false — nothing is cut yet; that's a later, explicit
 * review step (see `regenerateHandoverDraft`/`shareHandoverPack` below).
 * Read-only: this never writes anything.
 */
export function generateHandoverPack(storePath: string, passphrase: string, duoDir: string): HandoverPack {
  const portrait = buildInterruptionPortrait(storePath, passphrase, duoDir);
  const gaps: string[] = [];

  let recurringQuestions: HandoverRecurringQuestion[];
  let askerActivity: HandoverAskerActivity[];
  if (portrait.tooThin) {
    recurringQuestions = [];
    askerActivity = [];
    gaps.push(
      `Too little history to characterise recurring questions or thread activity yet ` +
        `(${portrait.totalQuestions} of the ${portrait.minimumQuestionsToCharacterize} questions needed).`,
    );
  } else {
    recurringQuestions = portrait.topicBreakdown.map((topic) => ({
      id: `topic:${topic.topicId}`,
      excluded: false,
      label: topic.label,
      count: topic.count,
      share: topic.share,
    }));
    askerActivity = portrait.busiestThreads.map((thread) => ({
      id: `thread:${thread.threadId}`,
      excluded: false,
      threadId: thread.threadId,
      count: thread.count,
      share: thread.share,
    }));
  }

  const activeRules = listActiveRules(storePath, passphrase, duoDir);
  let standingOrders: HandoverStandingOrder[];
  if (activeRules.length === 0) {
    standingOrders = [];
    gaps.push("No standing orders have been approved yet — nothing here reflects a signed-off decision.");
  } else {
    standingOrders = activeRules.map((rule) => {
      const { evidence } = describeRuleWithEvidence(storePath, passphrase, rule.id);
      return { id: `rule:${rule.id}`, excluded: false, topicId: rule.topicId, text: rule.text, supportCount: rule.supportCount, evidence };
    });
  }

  let refusals: HandoverRefusal[];
  if (!hasRefusalsDecision(duoDir)) {
    refusals = [];
    gaps.push('No decision about refusals has been recorded yet (`duo mirror refusals add`/`confirm-none`).');
  } else {
    // A recorded, deliberate "none" is not a gap — readRefusalsFile
    // returning [] here is an honest fact, not a shortfall.
    refusals = readRefusalsFile(duoDir).map((refusal, index) => ({
      id: `refusal-${index}`,
      excluded: false,
      heading: refusal.heading,
      reason: refusal.reason,
    }));
  }

  const openDrafts = listDrafts(storePath, passphrase).filter((draft) => draft.escalated && draft.outcome === null);
  const openThreads: HandoverOpenThread[] = openDrafts.map((draft) => ({
    id: `draft:${draft.id}`,
    excluded: false,
    question: draft.question,
    escalationReason: draft.escalationReason,
    createdAt: draft.createdAt,
  }));

  return {
    generatedAt: new Date().toISOString(),
    recurringQuestions,
    standingOrders,
    refusals,
    askerActivity,
    openThreads,
    gaps,
  };
}

/**
 * Where the *unreviewed* draft lives — the encrypted store's own (gitignored)
 * data directory, never `duoDir` (#62 AC2's own point: a generated pack may
 * contain something personal or inappropriate to pass on, so it must not
 * land somewhere git-tracked, or in anyone else's reach, before the owner
 * has reviewed and cut it). `duo purge` already deletes this whole
 * directory, so an abandoned draft is cleaned up by that existing
 * mechanism, without this module needing its own cleanup path.
 */
export function handoverDraftPath(storePath: string): string {
  return join(dataDirFor(storePath), "handover-draft.json");
}

/**
 * Thrown when the draft file can't be parsed as JSON, or its shape doesn't
 * match — deliberately checked here rather than left to surface as a raw
 * `SyntaxError` or a silently-wrong boolean somewhere downstream. This
 * matters specifically because the draft is designed to be hand-edited
 * (see `cutHandoverItem`'s own doc comment): a typo like `"excluded":
 * "false"` (a non-empty *string*, which JavaScript treats as truthy) would
 * otherwise leave an item the owner meant to un-cut silently excluded —
 * exactly the kind of quiet failure #62 AC2's "nothing is shared without
 * an explicit act" promise depends on not happening unnoticed.
 */
export class HandoverDraftMalformedError extends Error {
  constructor(path: string, detail: string) {
    super(`Malformed handover draft at "${path}": ${detail}`);
    this.name = "HandoverDraftMalformedError";
  }
}

function assertHandoverItemShape(item: unknown, sectionName: string): void {
  if (typeof item !== "object" || item === null) {
    throw new HandoverDraftMalformedError(sectionName, `an item in "${sectionName}" is not an object`);
  }
  const record = item as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) {
    throw new HandoverDraftMalformedError(sectionName, `an item in "${sectionName}" has a missing or non-string id`);
  }
  if (typeof record.excluded !== "boolean") {
    throw new HandoverDraftMalformedError(sectionName, `"${sectionName}[${record.id}].excluded" must be true or false, got ${JSON.stringify(record.excluded)}`);
  }
}

function assertHandoverSectionShape(value: unknown, sectionName: string): void {
  if (!Array.isArray(value)) {
    throw new HandoverDraftMalformedError(sectionName, `"${sectionName}" must be an array`);
  }
  for (const item of value) {
    assertHandoverItemShape(item, sectionName);
  }
}

/** Validates a raw, already-JSON-parsed value against the HandoverPack shape before it's trusted as one — every section must be an array of objects each carrying a non-empty string `id` and a strictly boolean `excluded`. */
function assertHandoverPackShape(raw: unknown, path: string): HandoverPack {
  if (typeof raw !== "object" || raw === null) {
    throw new HandoverDraftMalformedError(path, "expected an object");
  }
  const record = raw as Record<string, unknown>;
  for (const sectionName of ["recurringQuestions", "standingOrders", "refusals", "askerActivity", "openThreads"] as const) {
    assertHandoverSectionShape(record[sectionName], sectionName);
  }
  if (typeof record.generatedAt !== "string") {
    throw new HandoverDraftMalformedError(path, '"generatedAt" must be a string');
  }
  if (!Array.isArray(record.gaps)) {
    throw new HandoverDraftMalformedError(path, '"gaps" must be an array');
  }
  return raw as HandoverPack;
}

function readHandoverDraft(storePath: string): HandoverPack | undefined {
  const path = handoverDraftPath(storePath);
  if (!existsSync(path)) {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new HandoverDraftMalformedError(path, `could not parse as JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  return assertHandoverPackShape(raw, path);
}

function writeHandoverDraft(storePath: string, pack: HandoverPack): void {
  const path = handoverDraftPath(storePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(pack, null, 2)}\n`, "utf8");
}

function carryForwardExclusions<T extends { id: string; excluded: boolean }>(fresh: readonly T[], previous: readonly T[] | undefined): T[] {
  if (!previous) {
    return [...fresh];
  }
  const previouslyExcluded = new Set(previous.filter((item) => item.excluded).map((item) => item.id));
  return fresh.map((item) => (previouslyExcluded.has(item.id) ? { ...item, excluded: true } : item));
}

/**
 * Regenerates the handover pack from current derived data and writes it to
 * the draft path, carrying forward any earlier `excluded` decisions (by
 * item id) so re-running `duo continuity handover generate` after new
 * evidence lands never silently un-cuts something the owner already
 * decided was personal or inappropriate — the same "hand-edits/decisions
 * survive re-derivation" idiom `rules-sync.ts`/`rules.ts`'s `reviewStatus`
 * preservation already use elsewhere in this codebase.
 */
export function regenerateHandoverDraft(storePath: string, passphrase: string, duoDir: string): HandoverPack {
  const fresh = generateHandoverPack(storePath, passphrase, duoDir);
  const previous = readHandoverDraft(storePath);
  const merged: HandoverPack = {
    ...fresh,
    recurringQuestions: carryForwardExclusions(fresh.recurringQuestions, previous?.recurringQuestions),
    standingOrders: carryForwardExclusions(fresh.standingOrders, previous?.standingOrders),
    refusals: carryForwardExclusions(fresh.refusals, previous?.refusals),
    askerActivity: carryForwardExclusions(fresh.askerActivity, previous?.askerActivity),
    openThreads: carryForwardExclusions(fresh.openThreads, previous?.openThreads),
  };
  writeHandoverDraft(storePath, merged);
  return merged;
}

/** Thrown by `cutHandoverItem`/`shareHandoverPack` when no draft exists yet — `duo continuity handover generate` must run first. */
export class NoHandoverDraftError extends Error {
  constructor() {
    super("No handover draft exists yet. Run `duo continuity handover generate` first.");
    this.name = "NoHandoverDraftError";
  }
}

/** Thrown by `cutHandoverItem` when `itemId` doesn't match any item in any section of the draft. */
export class HandoverItemNotFoundError extends Error {
  constructor(itemId: string) {
    super(`No handover item with id "${itemId}" in the current draft.`);
    this.name = "HandoverItemNotFoundError";
  }
}

function eachSection(pack: HandoverPack): readonly (readonly { id: string; excluded: boolean }[])[] {
  return [pack.recurringQuestions, pack.standingOrders, pack.refusals, pack.askerActivity, pack.openThreads];
}

/**
 * #62 AC2: marks one item excluded by id — the CLI convenience for "cut
 * this" alongside hand-editing `excluded: true` directly in the draft
 * file, which stays just as valid (this function reads and rewrites
 * exactly that same file). Cutting is reversible by editing the file back,
 * same as every other hand-editable derived artifact in this codebase.
 */
export function cutHandoverItem(storePath: string, itemId: string): HandoverPack {
  const draft = readHandoverDraft(storePath);
  if (!draft) {
    throw new NoHandoverDraftError();
  }
  const found = eachSection(draft).some((section) => section.some((item) => item.id === itemId));
  if (!found) {
    throw new HandoverItemNotFoundError(itemId);
  }
  const cut = <T extends { id: string; excluded: boolean }>(items: readonly T[]): T[] =>
    items.map((item) => (item.id === itemId ? { ...item, excluded: true } : item));
  const updated: HandoverPack = {
    ...draft,
    recurringQuestions: cut(draft.recurringQuestions),
    standingOrders: cut(draft.standingOrders),
    refusals: cut(draft.refusals),
    askerActivity: cut(draft.askerActivity),
    openThreads: cut(draft.openThreads),
  };
  writeHandoverDraft(storePath, updated);
  return updated;
}

function formatPercent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/** Renders the final, shareable document — every excluded item (whether cut by hand-edit or `cutHandoverItem`) is left out entirely, not merely marked. */
export function renderHandoverDocument(pack: HandoverPack): string {
  const lines: string[] = [`# Handover pack`, "", `Generated ${pack.generatedAt}.`, ""];

  lines.push("## Recurring questions", "");
  const questions = pack.recurringQuestions.filter((item) => !item.excluded);
  if (questions.length === 0) {
    lines.push("(none)");
  } else {
    for (const item of questions) {
      lines.push(`- ${item.label} — asked ${item.count} time(s), ${formatPercent(item.share)} of all questions`);
    }
  }

  lines.push("", "## Standing orders", "");
  const orders = pack.standingOrders.filter((item) => !item.excluded);
  if (orders.length === 0) {
    lines.push("(none)");
  } else {
    for (const item of orders) {
      lines.push(`- ${item.text}`);
      for (const exchange of item.evidence) {
        if (exchange.questionText !== null || exchange.answerText !== null) {
          lines.push(`  - evidence: Q: "${exchange.questionText ?? "(removed)"}" — A: "${exchange.answerText ?? "(removed)"}"`);
        }
      }
    }
  }

  lines.push("", "## Refusals", "");
  const refusals = pack.refusals.filter((item) => !item.excluded);
  if (refusals.length === 0) {
    lines.push("(none recorded)");
  } else {
    for (const item of refusals) {
      lines.push(`- ${item.heading}: ${item.reason}`);
    }
  }

  lines.push("", "## Who asks about what", "");
  const activity = pack.askerActivity.filter((item) => !item.excluded);
  if (activity.length === 0) {
    lines.push("(no thread activity recorded)");
  } else {
    lines.push("(busiest threads — not resolved to individual people; the corpus carries no per-person asker identity yet)");
    for (const item of activity) {
      lines.push(`- thread ${item.threadId}: ${item.count} question(s), ${formatPercent(item.share)}`);
    }
  }

  lines.push("", "## Open threads", "");
  const open = pack.openThreads.filter((item) => !item.excluded);
  if (open.length === 0) {
    lines.push("(none open)");
  } else {
    for (const item of open) {
      const reason = item.escalationReason ? `: ${item.escalationReason}` : "";
      lines.push(`- "${item.question}" (escalated ${item.createdAt}${reason})`);
    }
  }

  if (pack.gaps.length > 0) {
    lines.push("", "## What this pack could not cover", "");
    for (const gap of pack.gaps) {
      lines.push(`- ${gap}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export interface SharedHandoverSummary {
  readonly outputPath: string;
  readonly sharedAt: string;
  readonly includedCounts: {
    readonly recurringQuestions: number;
    readonly standingOrders: number;
    readonly refusals: number;
    readonly askerActivity: number;
    readonly openThreads: number;
  };
  readonly excludedCount: number;
}

/**
 * #62 AC2's one explicit act: reads the reviewed draft (whatever it
 * currently says — cuts made by hand-edit or by `cutHandoverItem` alike),
 * renders the final document, and writes it to `outputPath`. Nothing else
 * in this module ever writes to `outputPath`, and nothing runs this
 * automatically — sharing only ever happens because this was called.
 */
export function shareHandoverPack(storePath: string, outputPath: string): SharedHandoverSummary {
  const draft = readHandoverDraft(storePath);
  if (!draft) {
    throw new NoHandoverDraftError();
  }
  const document = renderHandoverDocument(draft);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, document, "utf8");

  const sections = eachSection(draft);
  const includedCountOf = (items: readonly { excluded: boolean }[]) => items.filter((item) => !item.excluded).length;
  const excludedCount = sections.reduce((sum, section) => sum + section.filter((item) => item.excluded).length, 0);

  return {
    outputPath,
    sharedAt: new Date().toISOString(),
    includedCounts: {
      recurringQuestions: includedCountOf(draft.recurringQuestions),
      standingOrders: includedCountOf(draft.standingOrders),
      refusals: includedCountOf(draft.refusals),
      askerActivity: includedCountOf(draft.askerActivity),
      openThreads: includedCountOf(draft.openThreads),
    },
    excludedCount,
  };
}
