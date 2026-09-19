import { createKnowledgeSource } from "./knowledge.js";
import type { DuoDefinition, KnowledgeSource, Owner, PersonaDefinition } from "./types.js";

/**
 * Thrown when an operation requires a human owner — escalation, approval —
 * but this duo's owner is a role or is absent. Names the duo and the
 * owner's actual kind rather than letting a person-only assumption fail as
 * an undefined-property error somewhere downstream.
 */
export class MissingHumanOwnerError extends Error {
  constructor(duoId: string, owner: Owner, action: string) {
    super(`${action} requires a human owner, but duo "${duoId}" has owner kind "${owner.kind}"`);
    this.name = "MissingHumanOwnerError";
  }
}

/**
 * A duo, resolved entirely from its definition. Constructing one touches no
 * process-level state — every field, including the knowledge source, comes
 * from the definition passed to the constructor — so loading a second duo
 * in the same process never affects the first.
 */
export class Duo {
  readonly id: string;
  readonly owner: Owner;
  readonly persona: PersonaDefinition;
  readonly standingOrders: readonly string[];
  readonly refusals: readonly string[];
  readonly knowledge: KnowledgeSource;

  constructor(definition: DuoDefinition) {
    this.id = definition.id;
    this.owner = definition.owner;
    this.persona = definition.persona;
    this.standingOrders = definition.standingOrders;
    this.refusals = definition.refusals;
    this.knowledge = createKnowledgeSource(definition.knowledge);
  }

  /**
   * Returns this duo's owner narrowed to a person, or throws
   * MissingHumanOwnerError naming what's missing. Every call site that
   * needs a human — escalation, approval — must go through this rather than
   * assume `owner` is a person.
   */
  requireHumanOwner(action: string): Owner & { kind: "person" } {
    if (this.owner.kind !== "person") {
      throw new MissingHumanOwnerError(this.id, this.owner, action);
    }
    return this.owner;
  }
}
