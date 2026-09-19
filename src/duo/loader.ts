import { readFileSync } from "node:fs";
import { Duo } from "./entity.js";
import type { DuoDefinition, KnowledgeSourceConfig, Owner, PersonaDefinition } from "./types.js";

/**
 * Thrown when a raw duo definition doesn't match the expected shape. The
 * message always names the field at fault, so a broken definition file
 * fails with a clear, specific reason rather than a generic type error.
 */
export class DuoDefinitionError extends Error {}

function fail(context: string, detail: string): never {
  throw new DuoDefinitionError(`Invalid duo definition (${context}): ${detail}`);
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

function asStringArray(value: unknown, context: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    fail(context, "expected an array of strings");
  }
  return value as string[];
}

function parseOwner(value: unknown, context: string): Owner {
  const raw = asRecord(value, context);
  const kind = raw.kind;
  if (kind === "none") {
    return { kind: "none" };
  }
  if (kind === "person" || kind === "role") {
    return {
      kind,
      id: asString(raw.id, `${context}.id`),
      name: asString(raw.name, `${context}.name`),
    };
  }
  fail(`${context}.kind`, `expected "person", "role", or "none", got ${JSON.stringify(kind)}`);
}

function parsePersona(value: unknown, context: string): PersonaDefinition {
  const raw = asRecord(value, context);
  return { voice: asString(raw.voice, `${context}.voice`) };
}

function parseKnowledge(value: unknown, context: string): KnowledgeSourceConfig {
  const raw = asRecord(value, context);
  const kind = raw.kind;
  if (kind === "derived") {
    return { kind, storePath: asString(raw.storePath, `${context}.storePath`) };
  }
  if (kind === "authored") {
    return { kind, documents: asStringArray(raw.documents, `${context}.documents`) };
  }
  fail(`${context}.kind`, `expected "derived" or "authored", got ${JSON.stringify(kind)}`);
}

/**
 * Validates a raw, already-parsed value against the DuoDefinition shape.
 * Takes `unknown` deliberately — a definition can come from JSON on disk, a
 * literal object in a test, or eventually another config format — and
 * throws DuoDefinitionError naming the first field at fault rather than
 * letting a malformed definition surface as an unrelated crash later.
 */
export function parseDuoDefinition(value: unknown): DuoDefinition {
  const raw = asRecord(value, "definition");
  return {
    id: asString(raw.id, "definition.id"),
    owner: parseOwner(raw.owner, "definition.owner"),
    persona: parsePersona(raw.persona, "definition.persona"),
    standingOrders: asStringArray(raw.standingOrders, "definition.standingOrders"),
    refusals: asStringArray(raw.refusals, "definition.refusals"),
    knowledge: parseKnowledge(raw.knowledge, "definition.knowledge"),
  };
}

/** Validates a raw definition and constructs the Duo entity in one step. */
export function createDuo(definition: unknown): Duo {
  return new Duo(parseDuoDefinition(definition));
}

/**
 * Reads a duo definition from a JSON file on disk and constructs it. The
 * only in-scope authoring interface (v1-spec.md §3) is a configuration
 * file; this is its loader.
 */
export function loadDuoFromFile(path: string): Duo {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return createDuo(raw);
}
