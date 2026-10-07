import { assembleDailyBrief } from "../duo/daily-brief.js";
import { buildTopicCoverage } from "./coverage.js";

/**
 * duo#305: "suggested questions and follow-ups" — starters for an empty
 * Your duo. Composition-only, the same discipline `coverage.ts` and
 * `daily-brief.ts` already hold to (`client-tech-design.md` Part 0: "adding
 * a surface must not add a behaviour"): nothing here re-derives or
 * re-judges anything, it only reads two reports the daemon already
 * computes and turns their own facts into questions the owner could ask.
 *
 * Two sources, matching the issue's own "How": **coverage gaps** (the
 * most-asked topics with no approved standing order behind them yet —
 * `buildTopicCoverage`'s own most-asked-first `gaps`) and **recent
 * activity** (`assembleDailyBrief`'s counts over the trailing day). A
 * handful of fixed, always-true prompts pad the list so an owner with no
 * history yet — nothing asked, nothing pending — still sees something
 * (AC1: "Empty Your duo shows relevant starters").
 */
export interface StarterSuggestions {
  readonly starters: readonly string[];
}

const MAX_STARTERS = 4;

const GENERAL_STARTERS: readonly string[] = [
  "What do you know about me?",
  "What can you handle on your own?",
  "What should I teach you?",
];

export function buildStarterSuggestions(storePath: string, passphrase: string, duoDir: string): StarterSuggestions {
  const coverage = buildTopicCoverage(storePath, passphrase, duoDir);
  const brief = assembleDailyBrief(storePath, passphrase);

  const starters: string[] = [];

  // Coverage gaps: the most-asked topics the owner hasn't yet backed with
  // a standing order — asking about one is both a real question and a
  // teaching moment, which is exactly what #277's gaps were computed for.
  for (const gap of coverage.gaps.slice(0, 2)) {
    starters.push(`What do you know about ${gap.label}?`);
  }

  // Recent activity: the daily brief's own counts, read in the order a
  // chat interrupts the owner about them (waiting, then passed on, then
  // handled) — never a new read, never a new judgement.
  if (brief.waitingOnYou.length > 0) {
    starters.push("What's waiting on me?");
  } else if (brief.passedOn.length > 0) {
    starters.push("What have you passed on to me recently?");
  } else if (brief.handledByDuo.length > 0) {
    starters.push("What have you handled on your own recently?");
  }

  // Pad with fixed prompts so the empty state is never thin, without
  // repeating one already offered above.
  for (const general of GENERAL_STARTERS) {
    if (starters.length >= MAX_STARTERS) {
      break;
    }
    if (!starters.includes(general)) {
      starters.push(general);
    }
  }

  return { starters: starters.slice(0, MAX_STARTERS) };
}
