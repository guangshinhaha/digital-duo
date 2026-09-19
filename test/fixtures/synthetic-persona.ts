import { createDuo } from "../../src/duo/loader.js";
import type { Duo } from "../../src/duo/entity.js";
import { SYNTHETIC_PERSONA_FIXTURE_ID } from "../../src/drafting/fixture-guard.js";

/**
 * #66: a development primitive, not a feature. The draft pipeline (#31's
 * relevance gate, #32's drafting, #33's confidence, #34's escalation) all
 * need something to run against before real derivation exists and before
 * any real corpus does. This is a hand-authored duo — owner.kind: "none",
 * per concept.md §12: synthetic personas are duos with nobody backing them
 * — with hand-authored standing orders and an authored knowledge source
 * (#65's AuthoredKnowledgeSource), so it needs no encrypted store, no
 * embeddings, and no derivation run at all to be usable.
 *
 * Its id is SYNTHETIC_PERSONA_FIXTURE_ID (src/drafting/fixture-guard.ts) —
 * that reserved id is what any real surface checks against before using a
 * duo, which is why the guard itself lives in production code even though
 * this fixture's own construction lives here, alongside the tests.
 */
export { SYNTHETIC_PERSONA_FIXTURE_ID };

const STANDING_ORDERS = [
  "Office hours are 9am to 5pm, Monday to Friday, in the team's local timezone.",
  "The on-call rotation for any given week is published in the #oncall channel.",
  "New hires get their laptop from IT on their first day, not before.",
] as const;

const REFUSALS = ["compensation", "salary", "performance reviews"] as const;

/**
 * Builds the fixture duo. Deterministic: no randomness, no clock reads, no
 * I/O — the same call always produces the same Duo, which is what makes
 * AC2's "same standing orders selected, same decisions made" possible to
 * assert on in a regression test.
 */
export function createSyntheticPersonaFixture(): Duo {
  return createDuo({
    id: SYNTHETIC_PERSONA_FIXTURE_ID,
    owner: { kind: "none" },
    persona: {
      voice: "[SYNTHETIC FIXTURE — do not use for real answers] Direct, brief, plain language, no hedging.",
    },
    standingOrders: [...STANDING_ORDERS],
    refusals: [...REFUSALS],
    knowledge: { kind: "authored", documents: [...STANDING_ORDERS] },
  });
}
