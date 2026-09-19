import { readFileSync } from "node:fs";
import { Duo } from "../duo/entity.js";
import { parseDuoDefinition } from "../duo/loader.js";
import type { DuoDefinition } from "../duo/types.js";
import { loadSharedDuoConfig } from "./config.js";

/**
 * Thrown when a shared duo's persona file names no human owner, or names
 * one that isn't a person (a role or "none"). Unlike the general Duo
 * primitive (#65), which deliberately allows all three owner kinds — a
 * synthetic persona or a role duo is a legitimate later phase — a *shared*
 * duo is Phase 1.5's one narrow bridge case: it has nobody with decision
 * history behind it, so a named human to escalate to and be accountable
 * for it is the one thing that makes shipping it safe (concept.md §12,
 * issue #67 AC2). This is checked at load time, not left to whatever
 * later call happens to reach `requireHumanOwner()` first.
 */
export class SharedDuoOwnershipError extends Error {
  constructor(duoId: string, owner: DuoDefinition["owner"]) {
    super(
      `Shared duo "${duoId}" names no human owner (owner kind is "${owner.kind}"); ` +
        "a shared duo must name a person to escalate to and be accountable for it",
    );
    this.name = "SharedDuoOwnershipError";
  }
}

/**
 * Validates the one constraint specific to a shared duo's definition, on
 * top of the general shape #65's parseDuoDefinition already checked.
 * Exported so it can be exercised directly against a definition object,
 * without needing a file on disk.
 */
export function assertHumanOwner(definition: DuoDefinition): void {
  if (definition.owner.kind !== "person") {
    throw new SharedDuoOwnershipError(definition.id, definition.owner);
  }
}

/**
 * Thrown when a shared duo's persona file configures anything other than
 * `knowledge.kind: "authored"`. This is #68's actual store boundary: the
 * only implementation that can ever touch an encrypted personal store is
 * `DerivedKnowledgeSource` (src/duo/knowledge.ts), which resolves from
 * `knowledge.kind: "derived"` and a `storePath`. Refusing that kind here
 * means a misconfigured persona file can never construct one in the first
 * place — a shared duo's `Duo.knowledge` is *always* the fixed,
 * hand-authored `AuthoredKnowledgeSource`, so there is no code path
 * through which it could read a personal duo's store, enforced by
 * construction rather than by an instruction a prompt could ignore (#68
 * AC3).
 */
export class SharedDuoKnowledgeError extends Error {
  constructor(duoId: string, kind: string) {
    super(
      `Shared duo "${duoId}" is configured with knowledge.kind "${kind}"; a shared duo must be ` +
        'grounded in published material only ("authored"), never a derived/personal store (#68)',
    );
    this.name = "SharedDuoKnowledgeError";
  }
}

/** Validates that a shared duo's knowledge is authored-only. Exported for the same reason assertHumanOwner is. */
export function assertAuthoredKnowledgeOnly(definition: DuoDefinition): void {
  if (definition.knowledge.kind !== "authored") {
    throw new SharedDuoKnowledgeError(definition.id, definition.knowledge.kind);
  }
}

/**
 * Validates a raw, already-parsed value against the shared-duo shape: the
 * general DuoDefinition shape, plus the two constraints above (a human
 * owner, and authored-only knowledge). Takes `unknown` for the same reason
 * parseDuoDefinition does — a definition can come from JSON on disk or a
 * literal object in a test.
 */
export function parseSharedDuoDefinition(value: unknown): DuoDefinition {
  const definition = parseDuoDefinition(value);
  assertHumanOwner(definition);
  assertAuthoredKnowledgeOnly(definition);
  return definition;
}

/** Validates a raw shared-duo definition and constructs the Duo entity in one step. */
export function createSharedDuo(definition: unknown): Duo {
  return new Duo(parseSharedDuoDefinition(definition));
}

/**
 * Reads the shared duo's persona file from disk and constructs it. There
 * is deliberately no counterpart function anywhere in this module that
 * writes one back — the only in-scope authoring interface (v1-spec.md §3,
 * concept.md §12's "never build a persona-authoring product" guardrail)
 * is hand-editing the checked-in file and proposing that as a reviewable
 * diff (#67 AC3), which is a version-control operation, not a runtime one.
 * Defaults to `shared-duo/persona.json` (or `DUO_SHARED_PERSONA_PATH`,
 * loadSharedDuoConfig) when no path is given.
 */
export function loadSharedDuo(path?: string): Duo {
  const personaPath = path ?? loadSharedDuoConfig().personaPath;
  const raw = JSON.parse(readFileSync(personaPath, "utf8"));
  return createSharedDuo(raw);
}
