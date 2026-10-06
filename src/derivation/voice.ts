import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { InferenceProvider } from "../provider/types.js";
import { withDatabase } from "../store/store.js";
import { ensureRecordsSchema } from "../ingest/record-store.js";

/**
 * v1-tech-design.md §1.5 step 5: statistical where possible (median
 * length, hedge rate, formatting, emoji, greeting/sign-off habits),
 * LLM-described only for register. Computed over the owner's own text
 * (`author: "me"`) — this profile is what the owner sounds like, not what
 * anyone else in the corpus sounds like.
 */
export interface VoiceStats {
  readonly sampleSize: number;
  readonly medianWordCount: number;
  readonly hedgeRate: number;
  readonly bulletRate: number;
  readonly emojiRate: number;
  readonly greetingRate: number;
  readonly signOffRate: number;
}

const HEDGE_WORDS = ["maybe", "probably", "i think", "not sure", "possibly", "might", "perhaps", "i guess", "kind of", "sort of"];
const GREETING_WORDS = ["hi", "hey", "hello", "morning", "afternoon"];
const SIGN_OFF_WORDS = ["thanks", "cheers", "best", "regards", "thank you"];
// Covers the common emoji blocks without pulling in a dedicated library —
// enough for a rate estimate, not a full Unicode emoji classifier.
const EMOJI_PATTERN = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

function wordCount(text: string): number {
  return text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length;
}

function median(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function containsAny(lower: string, words: readonly string[]): boolean {
  return words.some((word) => lower.includes(word));
}

function startsWithAny(lower: string, words: readonly string[]): boolean {
  return words.some((word) => lower.startsWith(word));
}

/**
 * The statistical half of the voice profile, over any set of the owner's own
 * texts. Exported so duo#262's per-recipient adaptation
 * (`drafting/recipient-voice.ts`) measures the same features, the same way,
 * over the narrower set of messages the owner sent to one person — one
 * extractor, two scopes, never a parallel definition of "median length".
 */
export function computeVoiceStats(texts: readonly string[]): VoiceStats {
  if (texts.length === 0) {
    return { sampleSize: 0, medianWordCount: 0, hedgeRate: 0, bulletRate: 0, emojiRate: 0, greetingRate: 0, signOffRate: 0 };
  }
  const rate = (predicate: (text: string) => boolean): number => texts.filter(predicate).length / texts.length;
  return {
    sampleSize: texts.length,
    medianWordCount: median(texts.map(wordCount)),
    hedgeRate: rate((text) => containsAny(text.toLowerCase(), HEDGE_WORDS)),
    bulletRate: rate((text) => /^\s*[-*]\s+/m.test(text)),
    emojiRate: rate((text) => EMOJI_PATTERN.test(text)),
    greetingRate: rate((text) => startsWithAny(text.trim().toLowerCase(), GREETING_WORDS)),
    signOffRate: rate((text) => containsAny(text.toLowerCase().slice(-60), SIGN_OFF_WORDS)),
  };
}

/** No-provider default: a plain-language description built entirely from the computed stats, never invented. */
export function defaultRegisterDescription(stats: VoiceStats): string {
  if (stats.sampleSize === 0) {
    return "Not enough of the owner's own writing has been ingested yet to describe their voice.";
  }
  const hedging = stats.hedgeRate >= 0.3 ? "frequently hedged" : stats.hedgeRate >= 0.1 ? "occasionally hedged" : "direct and unhedged";
  const length = stats.medianWordCount <= 15 ? "terse" : stats.medianWordCount <= 40 ? "moderate-length" : "long-form";
  const emoji = stats.emojiRate >= 0.2 ? "uses emoji fairly often" : stats.emojiRate > 0 ? "uses emoji occasionally" : "rarely uses emoji";
  return `Based on ${stats.sampleSize} sample(s): ${length}, ${hedging} in tone, and ${emoji}.`;
}

export type RegisterDescriber = (stats: VoiceStats, sampleTexts: readonly string[]) => Promise<string>;

/** LLM-described register (v1-tech-design.md §1.5 step 5). Falls back to defaultRegisterDescription on any failure — the statistical half of the profile never depends on this succeeding. */
export function createLlmRegisterDescriber(provider: InferenceProvider): RegisterDescriber {
  return async (stats, sampleTexts) => {
    try {
      const response = await provider.complete(
        [
          "These are sample messages written by one person at work:",
          ...sampleTexts.map((text) => `- ${text}`),
          "Describe their writing register/tone in one or two plain-English sentences — formality, warmth, directness. No preamble.",
        ].join("\n"),
      );
      const cleaned = response.trim();
      return cleaned.length > 0 ? cleaned : defaultRegisterDescription(stats);
    } catch {
      return defaultRegisterDescription(stats);
    }
  };
}

function renderVoiceMarkdown(stats: VoiceStats, register: string): string {
  const percent = (rate: number): string => `${Math.round(rate * 100)}%`;
  return [
    "# Voice profile",
    "",
    "Derived from the owner's own messages. Statistical measures come directly from the corpus; the",
    "register description below may be LLM-assisted. Edit this file directly — nothing overwrites it",
    "automatically once it exists; delete it and re-run `duo derive voice` to regenerate.",
    "",
    `- Sample size: ${stats.sampleSize} message(s)`,
    `- Median length: ${stats.medianWordCount} words`,
    `- Hedge rate: ${percent(stats.hedgeRate)} (uses words like "maybe", "probably", "I think")`,
    `- Bullet-point rate: ${percent(stats.bulletRate)}`,
    `- Emoji rate: ${percent(stats.emojiRate)}`,
    `- Greeting rate: ${percent(stats.greetingRate)} (opens with "hi"/"hey"/"hello"/...)`,
    `- Sign-off rate: ${percent(stats.signOffRate)} (closes with "thanks"/"cheers"/"best"/...)`,
    "",
    "## Register",
    "",
    register,
    "",
  ].join("\n");
}

export interface VoiceProfileOptions {
  describeRegister?: RegisterDescriber;
  /** Overwrite an existing duo/voice.md rather than leaving a hand-edited file untouched. Defaults to false. */
  force?: boolean;
}

export interface VoiceProfileResult {
  readonly written: boolean;
  readonly stats: VoiceStats;
  readonly register: string;
}

// Must match src/corrections/review.ts's own CORRECTIONS_HEADING constant —
// that module owns writing the section, this module only has to recognize
// and preserve it when `force` overwrites the rest of the file.
const CORRECTIONS_HEADING = "## Corrections";

/**
 * The "## Corrections" section, verbatim, if `path`'s current content has
 * one — so a `force` rewrite can carry it forward. #38/#39 append durable,
 * provenance-carrying correction entries there; voice.ts's own overwrite
 * has no way to reconstruct that log, so it must preserve rather than
 * discard it.
 */
function readExistingCorrectionsSection(path: string): string | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  const existing = readFileSync(path, "utf8");
  const index = existing.indexOf(CORRECTIONS_HEADING);
  return index === -1 ? undefined : existing.slice(index).trimEnd();
}

/**
 * Computes the voice profile and writes it to `duo/voice.md`. Unlike the
 * rules sync, this never merges a hand-edit back in — voice.md has no
 * database projection anything else reads, so there's nothing to
 * reconcile. Instead it simply refuses to clobber an existing file unless
 * `force` is set (AC4: "readable prose the owner can edit directly" — an
 * edit that vanishes on the next derivation run wouldn't be). When `force`
 * does overwrite, an existing "## Corrections" section (#38/#39) is carried
 * forward rather than silently discarded — it's a separate, append-only log
 * this function doesn't own and has no way to recompute.
 */
export async function runVoiceProfile(
  storePath: string,
  passphrase: string,
  duoDir: string,
  options: VoiceProfileOptions = {},
): Promise<VoiceProfileResult> {
  const describeRegister = options.describeRegister ?? ((stats) => Promise.resolve(defaultRegisterDescription(stats)));
  const path = join(duoDir, "voice.md");

  const texts = withDatabase(storePath, passphrase, false, (db) => {
    ensureRecordsSchema(db);
    const rows = db.prepare(`SELECT text FROM records WHERE author = 'me'`).all() as unknown as { text: string }[];
    return rows.map((row) => row.text);
  });

  const stats = computeVoiceStats(texts);
  const register = await describeRegister(stats, texts.slice(0, 5));

  if (existsSync(path) && !options.force) {
    return { written: false, stats, register };
  }

  const preservedCorrections = readExistingCorrectionsSection(path);
  const markdown = renderVoiceMarkdown(stats, register);
  const content = preservedCorrections ? `${markdown.trimEnd()}\n\n${preservedCorrections}\n` : markdown;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  return { written: true, stats, register };
}
