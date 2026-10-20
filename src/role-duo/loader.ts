import { readFileSync, writeFileSync } from "node:fs";
import { ROLE_HOLDER_CONSENT_VALUES, type RoleDuoDefinition, type RoleHolder, type RoleHolderConsent } from "./types.js";

/** Thrown when a role-duo definition file doesn't match the expected shape. Names the field at fault, same convention `duo/loader.ts`'s DuoDefinitionError uses. */
export class RoleDuoDefinitionError extends Error {}

function fail(context: string, detail: string): never {
  throw new RoleDuoDefinitionError(`Invalid role-duo definition (${context}): ${detail}`);
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(context, "expected an object");
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(context, "expected a non-empty string");
  }
  return value as string;
}

function asNullableString(value: unknown, context: string): string | null {
  if (value === null) {
    return null;
  }
  return asString(value, context);
}

function asConsent(value: unknown, context: string): RoleHolderConsent {
  if (typeof value !== "string" || !(ROLE_HOLDER_CONSENT_VALUES as readonly string[]).includes(value)) {
    fail(context, `expected one of ${ROLE_HOLDER_CONSENT_VALUES.join(", ")}, got ${JSON.stringify(value)}`);
  }
  return value as RoleHolderConsent;
}

function parseHolder(value: unknown, context: string): RoleHolder {
  const raw = asRecord(value, context);
  return {
    holderId: asString(raw.holderId, `${context}.holderId`),
    holderName: asString(raw.holderName, `${context}.holderName`),
    storePath: asString(raw.storePath, `${context}.storePath`),
    duoDir: asString(raw.duoDir, `${context}.duoDir`),
    heldFrom: asString(raw.heldFrom, `${context}.heldFrom`),
    heldUntil: asNullableString(raw.heldUntil ?? null, `${context}.heldUntil`),
    consent: asConsent(raw.consent, `${context}.consent`),
  };
}

/** Validates a raw, already-parsed value against the RoleDuoDefinition shape. Takes `unknown` for the same reason `parseDuoDefinition` does (see duo/loader.ts). */
export function parseRoleDuoDefinition(value: unknown): RoleDuoDefinition {
  const raw = asRecord(value, "definition");
  const holdersRaw = raw.holders;
  if (!Array.isArray(holdersRaw)) {
    fail("definition.holders", "expected an array");
  }
  const holders = (holdersRaw as unknown[]).map((holder, index) => parseHolder(holder, `definition.holders[${index}]`));
  const holderIds = new Set<string>();
  for (const holder of holders) {
    if (holderIds.has(holder.holderId)) {
      fail("definition.holders", `duplicate holderId "${holder.holderId}"`);
    }
    holderIds.add(holder.holderId);
  }
  return {
    roleId: asString(raw.roleId, "definition.roleId"),
    roleName: asString(raw.roleName, "definition.roleName"),
    holders,
  };
}

/** Reads a role-duo definition file from disk and validates it. */
export function loadRoleDuoDefinition(path: string): RoleDuoDefinition {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return parseRoleDuoDefinition(raw);
}

/**
 * Writes a role-duo definition back to disk — the one place this file is
 * ever written by code, used only by `withdrawHolderConsent` (see seed.ts)
 * to flip a holder's own consent value. Every other change to who has held
 * the post is a hand-edit proposed as a reviewable diff, same convention
 * `shared-duo/persona.json` uses. Desk duos (concept.md §12, 2026-10-20) are
 * written by the daemon's create route instead; seeded multi-holder role duos
 * keep the hand-edit convention.
 */
export function writeRoleDuoDefinition(path: string, definition: RoleDuoDefinition): void {
  writeFileSync(path, `${JSON.stringify(definition, null, 2)}\n`, "utf8");
}
