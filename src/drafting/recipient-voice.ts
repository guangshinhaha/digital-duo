import { computeVoiceStats, type VoiceStats } from "../derivation/voice.js";
import { detectClassification, stripMarkingLine } from "../ingest/record.js";
import type { Database } from "../store/store.js";
import { withDatabase } from "../store/store.js";
import { ensureDraftLogSchema, type DraftRecipient } from "./draft-log.js";

/**
 * guangshinhaha/duo#262: drafts that sound like the owner *to each person*.
 *
 * The general voice profile (`duo/voice.md`, `derivation/voice.ts`) describes
 * how the owner writes to everyone at once. This module narrows the same
 * feature extraction to one recipient: the owner's own approved sends and
 * edits to that person, read straight from the draft log (`sent` outcomes
 * use the sent text when one was recorded, else the draft text the owner
 * kept unchanged; `edited` outcomes use what the owner actually sent). No
 * separate model and no copy of the data — the draft log already holds every
 * approved send, so the per-recipient signal is a query plus the voice
 * profile's own `computeVoiceStats`, extended with the few features that
 * only make sense per relationship (formality, first name vs title,
 * habitual greeting and sign-off).
 *
 * Scoping: everything here reads and writes the one store it is handed.
 * A hosted daemon gives every duo its own encrypted store
 * (`hosted/server.ts`'s `tenantPaths`), so one duo's — and so one org's —
 * learned relationships can never be read while drafting for another.
 */

/**
 * Below this many approved sends to one person, the general voice applies
 * unchanged. One or two messages are an anecdote, not a relationship: a
 * single curt reply would otherwise make every future draft to that person
 * curt. Five is enough for the rates below to mean something while still
 * being reachable within a week or two of real use.
 */
export const RECIPIENT_ADAPTATION_MIN_SENDS = 5;

/** The most recent sends a profile is computed over — recent enough to follow a relationship that has changed, enough to be stable. */
const MAX_SENDS_CONSIDERED = 50;

/** How many recent sends are quoted into the prompt as examples of the tone. */
const EXAMPLE_COUNT = 3;
const EXAMPLE_MAX_CHARS = 280;

/** A habit counts as "usually" once it shows up in at least this share of sends. */
const HABIT_THRESHOLD = 0.4;

const FORMAL_PATTERNS: readonly RegExp[] = [
  /^\s*dear\b/i,
  /\b(kind|best|warm)?\s*regards\b/i,
  /\bsincerely\b/i,
  /\bplease find\b/i,
  /\bi would (like|be grateful|appreciate)\b/i,
  /\bat your (earliest )?convenience\b/i,
  /\b(mr|mrs|ms|dr|prof)\.?\s+[A-Z]/,
  /\b(sir|madam)\b/i,
];
const CASUAL_PATTERNS: readonly RegExp[] = [
  /^\s*(hey|heya|hiya|yo|sup)\b/i,
  /\b(lol|haha+|btw|thx|np|gonna|wanna|yep|nope|cool|omg|tbh)\b/i,
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u,
  /!!/,
  /^\s*[a-z]/,
];
const TITLE_PATTERN = /\b(mr|mrs|ms|dr|prof)\.?\s+[A-Z]|\b(sir|madam)\b/i;
const CONTRACTION_PATTERN = /\b\w+'(s|re|ll|ve|d|m|t)\b/i;
const EMOJI_PATTERN = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

const GREETING_OPENERS = ["dear", "hi", "hey", "hello", "heya", "hiya", "yo", "morning", "good morning", "good afternoon", "afternoon"];
const SIGN_OFFS = ["kind regards", "best regards", "warm regards", "regards", "best", "cheers", "thanks", "thank you", "thx", "many thanks", "sincerely", "talk soon", "ttyl"];

export type RecipientRegister = "formal" | "neutral" | "casual";

/** The general voice profile's statistics, over sends to one person only, plus the per-relationship features. */
export interface RecipientVoiceFeatures extends VoiceStats {
  /** Share of sends with a formal marker minus share with a casual one: -1 (always casual) to 1 (always formal). */
  readonly formalityScore: number;
  readonly register: RecipientRegister;
  readonly exclamationRate: number;
  readonly contractionRate: number;
  /** Share of sends addressing the recipient by their first name — 0 when no name is known to look for. */
  readonly firstNameRate: number;
  /** Share of sends using an honorific (Mr/Ms/Dr/Prof/sir/madam). */
  readonly titleRate: number;
  /** The opener the owner habitually uses with this person ("hey", "dear", …), or null when there isn't one. */
  readonly habitualGreeting: string | null;
  /** The sign-off the owner habitually uses with this person ("cheers", "regards", …), or null when there isn't one. */
  readonly habitualSignOff: string | null;
}

export interface RecipientVoice {
  readonly recipient: DraftRecipient;
  readonly sampleSize: number;
  readonly features: RecipientVoiceFeatures;
  /** Up to three recent sends, newest first, marking-stripped and truncated — quoted into the prompt as the tone to match. */
  readonly examples: readonly string[];
}

/** What GET/DELETE `/people/:id/voice-adaptation` report — enough for a person's profile to say whether drafts to them are tuned, and on how much. */
export interface RecipientVoiceStatus {
  readonly recipientId: string;
  readonly recipientName: string | null;
  /** Approved sends to this person counted since the last reset. */
  readonly sampleSize: number;
  readonly threshold: number;
  /** True when drafts to this person are conditioned on the features below. */
  readonly active: boolean;
  /** Null until `active`: below the threshold there is nothing worth showing. */
  readonly features: RecipientVoiceFeatures | null;
  /** When the owner last reset this relationship's learned tone, or null if never. */
  readonly resetAt: string | null;
}

export function ensureRecipientVoiceSchema(db: Database): void {
  ensureDraftLogSchema(db);
  // A reset is a watermark, not a deletion: the draft rows behind it are the
  // correction loop's and the eval's history too, and must survive. Only
  // sends recorded after `reset_at` count toward this person's profile.
  db.exec(`
    CREATE TABLE IF NOT EXISTS recipient_voice_resets (
      recipient_ref TEXT PRIMARY KEY,
      reset_at TEXT NOT NULL
    ) STRICT
  `);
}

interface SendRow {
  draft_text: string | null;
  sent_text: string | null;
  outcome: string;
  recipient_name: string | null;
}

function readResetAt(db: Database, recipientId: string): string | null {
  const row = db.prepare(`SELECT reset_at FROM recipient_voice_resets WHERE recipient_ref = ?`).get(recipientId) as { reset_at: string } | undefined;
  return row?.reset_at ?? null;
}

/** The text the owner actually sent for one approved draft row, or undefined when there is none to learn from. */
function sentTextOf(row: SendRow): string | undefined {
  const text = row.outcome === "edited" ? row.sent_text : (row.sent_text ?? row.draft_text);
  if (text === null || text.trim().length === 0) {
    return undefined;
  }
  return stripMarkingLine({ text, classification: detectClassification(text) }).trim();
}

interface RecipientSends {
  readonly texts: readonly string[];
  readonly latestName: string | null;
  readonly resetAt: string | null;
}

function readRecipientSends(db: Database, recipientId: string): RecipientSends {
  ensureRecipientVoiceSchema(db);
  const resetAt = readResetAt(db, recipientId);
  const rows = db
    .prepare(
      `
      SELECT draft_text, sent_text, outcome, recipient_name
      FROM drafts
      WHERE recipient_ref = ? AND outcome IN ('sent', 'edited') AND (? IS NULL OR outcome_recorded_at > ?)
      ORDER BY outcome_recorded_at DESC, id DESC
      LIMIT ?
    `,
    )
    .all(recipientId, resetAt, resetAt, MAX_SENDS_CONSIDERED) as unknown as SendRow[];
  const texts = rows.map(sentTextOf).filter((text): text is string => text !== undefined);
  const latestName = rows.find((row) => row.recipient_name !== null)?.recipient_name ?? null;
  return { texts, latestName, resetAt };
}

function rate(texts: readonly string[], predicate: (text: string) => boolean): number {
  return texts.length === 0 ? 0 : texts.filter(predicate).length / texts.length;
}

function normalise(line: string): string {
  return line
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The most common value among `found` if it shows up in at least HABIT_THRESHOLD of all `total` sends — else null. Ties go to the longer phrase, then alphabetical, for a deterministic answer. */
function habitual(found: readonly (string | undefined)[], total: number): string | null {
  const counts = new Map<string, number>();
  for (const value of found) {
    if (value !== undefined) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]))[0];
  return best !== undefined && total > 0 && best[1] / total >= HABIT_THRESHOLD ? best[0] : null;
}

/** Longest listed phrase `normalised` starts with (as whole words), so "good morning" beats "morning" and "hiring" is never "hi". */
function matchPhrase(normalised: string, phrases: readonly string[]): string | undefined {
  return [...phrases].sort((a, b) => b.length - a.length).find((phrase) => normalised === phrase || normalised.startsWith(`${phrase} `));
}

function openerOf(text: string): string | undefined {
  const firstLine = text.split("\n").find((line) => line.trim().length > 0) ?? "";
  return matchPhrase(normalise(firstLine), GREETING_OPENERS);
}

function signOffOf(text: string): string | undefined {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  // A sign-off is its own short line ("Cheers,") or the tail of a one-liner
  // ("…by Friday. Thanks!") — check the last line, then its last sentence.
  const last = lines[lines.length - 1] ?? "";
  const lastSentence = last.split(/[.!?]\s+/).pop() ?? last;
  for (const candidate of [last, lastSentence]) {
    const words = normalise(candidate);
    if (words.split(" ").length <= 4) {
      const match = matchPhrase(words, SIGN_OFFS);
      if (match !== undefined) {
        return match;
      }
    }
  }
  return undefined;
}

function firstNameOf(name: string | null): string | null {
  const first = name?.trim().split(/\s+/)[0];
  return first !== undefined && first.length > 1 ? first : null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Pure feature extraction over the owner's sends to one person — exported for tests and for any future caller that already holds the texts. */
export function computeRecipientVoiceFeatures(texts: readonly string[], recipientName: string | null): RecipientVoiceFeatures {
  const stats = computeVoiceStats(texts);
  const formalRate = rate(texts, (text) => FORMAL_PATTERNS.some((pattern) => pattern.test(text)));
  const casualRate = rate(texts, (text) => CASUAL_PATTERNS.some((pattern) => pattern.test(text)));
  const formalityScore = Math.round((formalRate - casualRate) * 100) / 100;
  const firstName = firstNameOf(recipientName);
  const firstNamePattern = firstName !== null ? new RegExp(`\\b${escapeRegExp(firstName)}\\b`, "i") : null;
  return {
    ...stats,
    formalityScore,
    register: formalityScore >= 0.3 ? "formal" : formalityScore <= -0.3 ? "casual" : "neutral",
    exclamationRate: rate(texts, (text) => text.includes("!")),
    contractionRate: rate(texts, (text) => CONTRACTION_PATTERN.test(text)),
    firstNameRate: firstNamePattern !== null ? rate(texts, (text) => firstNamePattern.test(text)) : 0,
    titleRate: rate(texts, (text) => TITLE_PATTERN.test(text)),
    habitualGreeting: habitual(texts.map(openerOf), texts.length),
    habitualSignOff: habitual(texts.map(signOffOf), texts.length),
  };
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The learned style for drafting to `recipient`, or undefined when there are
 * fewer than RECIPIENT_ADAPTATION_MIN_SENDS approved sends to them since the
 * last reset — the caller then drafts in the general voice, unchanged.
 */
export function deriveRecipientVoice(storePath: string, passphrase: string, recipient: DraftRecipient): RecipientVoice | undefined {
  const sends = withDatabase(storePath, passphrase, false, (db) => readRecipientSends(db, recipient.id));
  if (sends.texts.length < RECIPIENT_ADAPTATION_MIN_SENDS) {
    return undefined;
  }
  const name = recipient.name ?? sends.latestName;
  return {
    recipient: { id: recipient.id, name },
    sampleSize: sends.texts.length,
    features: computeRecipientVoiceFeatures(sends.texts, name),
    examples: sends.texts.slice(0, EXAMPLE_COUNT).map((text) => truncate(text, EXAMPLE_MAX_CHARS)),
  };
}

export function describeRecipientVoice(storePath: string, passphrase: string, recipientId: string): RecipientVoiceStatus {
  const sends = withDatabase(storePath, passphrase, false, (db) => readRecipientSends(db, recipientId));
  const active = sends.texts.length >= RECIPIENT_ADAPTATION_MIN_SENDS;
  return {
    recipientId,
    recipientName: sends.latestName,
    sampleSize: sends.texts.length,
    threshold: RECIPIENT_ADAPTATION_MIN_SENDS,
    active,
    features: active ? computeRecipientVoiceFeatures(sends.texts, sends.latestName) : null,
    resetAt: sends.resetAt,
  };
}

/**
 * Starts this relationship's learned tone over: sends recorded before now
 * stop counting, so drafts to this person fall back to the general voice
 * until RECIPIENT_ADAPTATION_MIN_SENDS new approved sends accumulate. The
 * draft rows themselves are untouched (see ensureRecipientVoiceSchema).
 */
export function resetRecipientVoice(storePath: string, passphrase: string, recipientId: string): RecipientVoiceStatus {
  withDatabase(storePath, passphrase, true, (db) => {
    ensureRecipientVoiceSchema(db);
    db.prepare(
      `INSERT INTO recipient_voice_resets (recipient_ref, reset_at) VALUES (?, ?) ON CONFLICT(recipient_ref) DO UPDATE SET reset_at = excluded.reset_at`,
    ).run(recipientId, new Date().toISOString());
  });
  return describeRecipientVoice(storePath, passphrase, recipientId);
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * The prompt section `buildDraftPrompt` places right after the general
 * voice profile: the measured features in plain words, then a few of the
 * owner's own recent messages to this person as the tone to match.
 */
export function renderRecipientVoiceSection(voice: RecipientVoice): string[] {
  const who = voice.recipient.name ?? "this person";
  const f = voice.features;
  const lines: string[] = [];
  lines.push(
    `How the owner writes to ${who} specifically (measured from ${voice.sampleSize} of their own approved messages to ${who} — where this differs from the general voice profile, follow this):`,
  );
  lines.push(`- Register: ${f.register} (formality ${f.formalityScore >= 0 ? "+" : ""}${f.formalityScore.toFixed(2)} on a -1 casual to +1 formal scale)`);
  lines.push(`- Median length: ${f.medianWordCount} words`);
  lines.push(f.habitualGreeting !== null ? `- Usually opens with "${f.habitualGreeting}"` : `- Opens with a greeting in ${percent(f.greetingRate)} of messages`);
  lines.push(f.habitualSignOff !== null ? `- Usually signs off with "${f.habitualSignOff}"` : `- Signs off in ${percent(f.signOffRate)} of messages`);
  if (voice.recipient.name !== null && firstNameOf(voice.recipient.name) !== null) {
    lines.push(`- Uses their first name in ${percent(f.firstNameRate)} of messages; an honorific (Mr/Ms/Dr/...) in ${percent(f.titleRate)}`);
  } else {
    lines.push(`- Uses an honorific (Mr/Ms/Dr/...) in ${percent(f.titleRate)} of messages`);
  }
  lines.push(`- Contractions in ${percent(f.contractionRate)}; exclamation marks in ${percent(f.exclamationRate)}; emoji in ${percent(f.emojiRate)}; hedging in ${percent(f.hedgeRate)}`);
  if (voice.examples.length > 0) {
    lines.push(`Recent messages the owner sent to ${who} (match the tone, not the content):`);
    for (const example of voice.examples) {
      lines.push(`- "${example}"`);
    }
  }
  return lines;
}
