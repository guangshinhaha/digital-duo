import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolveOrCreatePassphrase } from "../store/passphrase.js";
import { listActiveRules } from "../derivation/rule-review.js";
import { readTopicsFile } from "../derivation/topics.js";
import { loadRoleDuoDefinition, writeRoleDuoDefinition } from "./loader.js";
import type { RoleDuoDefinition, RoleHolder } from "./types.js";

/**
 * One holder's rule, attributed — #72 AC1's "each rule attributed to who
 * established it and when." `establishedAt` is the rule's own createdAt
 * (when the holder's derivation first produced it), not lastConfirmedAt,
 * which keeps moving every time re-induction reconfirms unchanged evidence.
 */
export interface AttributedStandingOrder {
  readonly ruleId: string;
  readonly topicLabel: string;
  readonly text: string;
  readonly holderId: string;
  readonly holderName: string;
  readonly establishedAt: string;
}

/** Two or more holders decided the same question (topic label) differently — #72 AC2: shown, never averaged into one synthesised rule. */
export interface StandingOrderConflict {
  readonly topicLabel: string;
  readonly positions: readonly AttributedStandingOrder[];
}

/** #72 AC3: a holder whose material was left out of seeding, and why — reported rather than silently dropped. */
export interface ExcludedHolder {
  readonly holderId: string;
  readonly holderName: string;
  readonly reason: string;
}

export interface RoleDuoSeed {
  readonly roleId: string;
  readonly roleName: string;
  readonly seededAt: string;
  /** One holder's rule per non-conflicting topic label — the role duo's actual standing orders. */
  readonly standingOrders: readonly AttributedStandingOrder[];
  readonly conflicts: readonly StandingOrderConflict[];
  readonly excludedHolders: readonly ExcludedHolder[];
  readonly includedHolderIds: readonly string[];
  readonly currentHolderId: string;
  /** #72 AC4: true when exactly one holder's material was actually used, regardless of how many people have held the post in total. */
  readonly singleHolderBasis: boolean;
  /** #72 AC4's honest statement of basis, stated in these words whenever `singleHolderBasis` is true. */
  readonly basisStatement: string;
}

/** Thrown when a role's definition names no current holder (heldUntil === null on exactly one holder) — out of scope per #72: "creating a role duo for a post nobody currently holds." */
export class NoCurrentHolderError extends Error {
  constructor(roleId: string) {
    super(`Role "${roleId}" has no current holder (no holder with heldUntil: null) — a role duo cannot be seeded for a post nobody holds`);
    this.name = "NoCurrentHolderError";
  }
}

/** Thrown when more than one holder claims to currently hold the post — the definition file is internally inconsistent and must be fixed by hand before seeding. */
export class AmbiguousCurrentHolderError extends Error {
  constructor(roleId: string, holderIds: readonly string[]) {
    super(`Role "${roleId}" names more than one current holder (${holderIds.join(", ")}) — fix duo/role-duos before seeding`);
    this.name = "AmbiguousCurrentHolderError";
  }
}

function exclusionReason(consent: RoleHolder["consent"]): string | undefined {
  switch (consent) {
    case "given":
      return undefined;
    case "withheld":
      return "did not consent to sharing their material with the role duo";
    case "withdrawn":
      return "withdrew their earlier consent";
    case "unreachable":
      return "could not be asked for consent (no longer reachable)";
  }
}

function normalizeText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Seeds a role duo from every consenting holder's already-derived, already
 * owner-approved rules (`listActiveRules` — #28/#29's active-rule filter,
 * never raw corpus material a contributor could not have shared themselves,
 * per #72's own out-of-scope note). Rules are matched across holders'
 * separate stores by topic *label* — the human-comparable "same question" —
 * since topic ids are local to each holder's own store and never comparable
 * across them.
 *
 * Writes the seed to `<definitionPath>` with `.json` replaced by
 * `.seed.json` — a derived output, regenerated on every call, the same
 * "regenerated projection, not hand-edited" convention `duo/topics.json`'s
 * DB table and `duo/rules/*.md` use elsewhere in this codebase.
 */
export function seedRoleDuo(definitionPath: string): RoleDuoSeed {
  const definition = loadRoleDuoDefinition(definitionPath);
  const seed = computeRoleDuoSeed(definition);
  writeSeedFile(definitionPath, seed);
  return seed;
}

/** The pure computation behind `seedRoleDuo`, exported for tests and for `withdrawHolderConsent` to reuse without re-reading a file it already has in memory. */
export function computeRoleDuoSeed(definition: RoleDuoDefinition): RoleDuoSeed {
  const currentHolders = definition.holders.filter((holder) => holder.heldUntil === null);
  if (currentHolders.length === 0) {
    throw new NoCurrentHolderError(definition.roleId);
  }
  if (currentHolders.length > 1) {
    throw new AmbiguousCurrentHolderError(
      definition.roleId,
      currentHolders.map((holder) => holder.holderId),
    );
  }
  const currentHolderId = currentHolders[0].holderId;

  const excludedHolders: ExcludedHolder[] = [];
  const included: RoleHolder[] = [];
  for (const holder of definition.holders) {
    const reason = exclusionReason(holder.consent);
    if (reason) {
      excludedHolders.push({ holderId: holder.holderId, holderName: holder.holderName, reason });
    } else {
      included.push(holder);
    }
  }

  const attributed: AttributedStandingOrder[] = [];
  for (const holder of included) {
    const rules = listActiveRules(holder.storePath, resolveOrCreatePassphrase(holder.storePath), holder.duoDir);
    const topicsById = new Map(readTopicsFile(holder.duoDir).map((topic) => [topic.id, topic.label]));
    for (const rule of rules) {
      const topicLabel = topicsById.get(rule.topicId) ?? rule.topicId;
      attributed.push({
        ruleId: rule.id,
        topicLabel,
        text: rule.text,
        holderId: holder.holderId,
        holderName: holder.holderName,
        establishedAt: rule.createdAt,
      });
    }
  }

  const byLabel = new Map<string, AttributedStandingOrder[]>();
  for (const order of attributed) {
    const key = normalizeText(order.topicLabel);
    const bucket = byLabel.get(key);
    if (bucket) {
      bucket.push(order);
    } else {
      byLabel.set(key, [order]);
    }
  }

  const standingOrders: AttributedStandingOrder[] = [];
  const conflicts: StandingOrderConflict[] = [];
  for (const orders of byLabel.values()) {
    const distinctTexts = new Set(orders.map((order) => normalizeText(order.text)));
    if (distinctTexts.size > 1) {
      // #72 AC2: both (all) positions are shown, dated and attributed; no
      // averaged rule is added to standingOrders for this label at all.
      conflicts.push({ topicLabel: orders[0].topicLabel, positions: [...orders].sort((a, b) => a.establishedAt.localeCompare(b.establishedAt)) });
    } else {
      standingOrders.push(...orders);
    }
  }
  standingOrders.sort((a, b) => a.topicLabel.localeCompare(b.topicLabel) || a.establishedAt.localeCompare(b.establishedAt));
  conflicts.sort((a, b) => a.topicLabel.localeCompare(b.topicLabel));

  const includedHolderIds = [...new Set(attributed.map((order) => order.holderId))].sort();
  const singleHolderBasis = includedHolderIds.length <= 1;
  const basisStatement = singleHolderBasis
    ? includedHolderIds.length === 0
      ? `This role duo has no seeded standing orders yet — no consenting holder's rules were available.`
      : `This role duo reflects one holder's practice (${attributed[0]?.holderName ?? includedHolderIds[0]}), not the accumulated practice of the desk.`
    : `This role duo reflects the accumulated practice of ${includedHolderIds.length} holders of this post.`;

  return {
    roleId: definition.roleId,
    roleName: definition.roleName,
    seededAt: new Date().toISOString(),
    standingOrders,
    conflicts,
    excludedHolders,
    includedHolderIds,
    currentHolderId,
    singleHolderBasis,
    basisStatement,
  };
}

/** `<definitionPath>` with its extension replaced by `.seed.json` — where `seedRoleDuo` persists its output. */
export function seedFilePath(definitionPath: string): string {
  return definitionPath.replace(/\.json$/, "") + ".seed.json";
}

function writeSeedFile(definitionPath: string, seed: RoleDuoSeed): void {
  const path = seedFilePath(definitionPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(seed, null, 2)}\n`, "utf8");
}

/**
 * #72's "withdrawal by a contributor removes their material and the rules
 * resting only on it" checkbox: flips `holderId`'s consent to `"withdrawn"`
 * in the definition file (a durable, auditable change to the one
 * hand-authored record of who has consented) and re-seeds immediately, so
 * the seed file on disk stops citing that holder's rules — and any
 * conflict that rested only on their position collapses back into a plain
 * standing order — the moment withdrawal is recorded, not on some later
 * run.
 */
export function withdrawHolderConsent(definitionPath: string, holderId: string): RoleDuoSeed {
  const definition = loadRoleDuoDefinition(definitionPath);
  const holder = definition.holders.find((candidate) => candidate.holderId === holderId);
  if (!holder) {
    throw new RoleHolderNotFoundError(definition.roleId, holderId);
  }
  const updated: RoleDuoDefinition = {
    ...definition,
    holders: definition.holders.map((candidate) => (candidate.holderId === holderId ? { ...candidate, consent: "withdrawn" } : candidate)),
  };
  // Computed against the in-memory `updated` definition *before* anything
  // is written to disk: if seeding fails (a holder's store unreadable, no
  // current holder left, ...), neither file is touched, so the definition
  // never ends up recording a withdrawal that the seed on disk doesn't
  // actually reflect yet.
  const seed = computeRoleDuoSeed(updated);
  writeRoleDuoDefinition(definitionPath, updated);
  writeSeedFile(definitionPath, seed);
  return seed;
}

export class RoleHolderNotFoundError extends Error {
  constructor(roleId: string, holderId: string) {
    super(`Role "${roleId}" names no holder "${holderId}"`);
    this.name = "RoleHolderNotFoundError";
  }
}
