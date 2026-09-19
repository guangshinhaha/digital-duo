import type { Duo } from "../duo/entity.js";

/**
 * Reserved duo id for synthetic-persona test fixtures (#66,
 * test/fixtures/synthetic-persona.ts). A duo carrying this id is never
 * real — the id itself is the fixture's "do not use for real answers"
 * marking, so no display surface needs separate fixture-detection
 * bookkeeping beyond checking the id it already has to read anyway.
 *
 * Deliberately production code (not under test/, unlike the fixture data
 * itself): a future real-world duo surface — a Slack integration (epic
 * e8) most concretely — needs to call assertNotSyntheticFixture at
 * runtime, and code under test/ is excluded from this project's build
 * (tsconfig.json's "exclude": ["test"]) and would not exist in a compiled
 * CLI at all.
 */
export const SYNTHETIC_PERSONA_FIXTURE_ID = "fixture:synthetic-persona";

/** Whether `duo` is the synthetic-persona fixture (or any duo sharing its reserved id) rather than a real duo. */
export function isSyntheticFixture(duo: Duo): boolean {
  return duo.id === SYNTHETIC_PERSONA_FIXTURE_ID;
}

/**
 * Thrown by assertNotSyntheticFixture — names the duo and the surface it
 * was refused on, so a future misuse fails loudly rather than a fixture
 * quietly answering as if it were a real duo.
 */
export class SyntheticFixtureNotAllowedError extends Error {
  constructor(duoId: string, surface: string) {
    super(`duo "${duoId}" is a synthetic-persona test fixture and cannot be used on the "${surface}" surface`);
    this.name = "SyntheticFixtureNotAllowedError";
  }
}

/**
 * The one gate a real-world duo surface must call before using a duo it
 * didn't itself construct as known-real. AC3 ("cannot be used on a Slack
 * surface") is satisfied structurally: once epic e8 builds a Slack
 * integration, it calls this before ever posting or drafting with a given
 * duo, and this fixture fails it by construction.
 */
export function assertNotSyntheticFixture(duo: Duo, surface: string): void {
  if (isSyntheticFixture(duo)) {
    throw new SyntheticFixtureNotAllowedError(duo.id, surface);
  }
}
