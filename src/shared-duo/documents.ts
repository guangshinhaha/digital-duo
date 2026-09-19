/**
 * The convention a shared duo's authored knowledge documents follow so a
 * freshness date travels with the document text itself, without a schema
 * change to #65's general Duo primitive — `knowledge.documents` stays a
 * plain `string[]`, so the general `Duo`/`AuthoredKnowledgeSource` (#67,
 * #68) needs no changes at all. Same "read a marking off the text" idiom
 * #48's `detectClassification` uses for a record's classification: one
 * required prefix, `"<Title> (updated YYYY-MM-DD): <body>"`, parsed back
 * out here rather than carried as a second, parallel field that could
 * drift out of sync with the string `duo.knowledge.retrieve()` actually
 * matches against.
 */
export interface PublishedDocument {
  readonly title: string;
  /** ISO calendar date (YYYY-MM-DD), read straight off the document's own prefix. */
  readonly updatedAt: string;
  /** The body, with the "<Title> (updated ...): " prefix stripped. */
  readonly text: string;
  /** The original, unparsed string. */
  readonly raw: string;
}

const DOCUMENT_PATTERN = /^(.+) \(updated (\d{4}-\d{2}-\d{2})\):\s*([\s\S]*)$/;

/** Thrown when a shared duo's configured document text doesn't carry the required title/date prefix — checked at load time, same as #67/#68's other shared-duo constraints, rather than failing later when something tries to cite it. */
export class MalformedPublishedDocumentError extends Error {
  constructor(raw: string) {
    super(
      `Shared duo document doesn't follow the required "<Title> (updated YYYY-MM-DD): <body>" convention: "${raw}"`,
    );
    this.name = "MalformedPublishedDocumentError";
  }
}

/**
 * True only for a date string that is both shaped like YYYY-MM-DD *and* a
 * real calendar date — the regex above accepts any digits in each slot
 * (e.g. "2026-13-45"), and `Date` silently rolls an invalid month/day over
 * into the next one rather than rejecting it, so a typo in the persona
 * file would otherwise pass validation and then quietly compute nonsense
 * for staleness rather than failing loudly at load time.
 */
function isRealCalendarDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Parses one authored document string into its title, update date, and body. Throws MalformedPublishedDocumentError, naming the offending string, when the required prefix is absent or the date isn't a real calendar date. */
export function parsePublishedDocument(raw: string): PublishedDocument {
  const match = DOCUMENT_PATTERN.exec(raw);
  if (!match) {
    throw new MalformedPublishedDocumentError(raw);
  }
  const [, title, updatedAt, text] = match;
  if (!isRealCalendarDate(updatedAt)) {
    throw new MalformedPublishedDocumentError(raw);
  }
  return { title, updatedAt, text, raw };
}

/**
 * How long a document may go unrevisited before an answer citing it flags
 * it as possibly stale (#69 AC3, "an answer drawn from a document not
 * updated in a long time"). Deliberately generous — a procedural policy
 * document doesn't change weekly — and named as a constant so the
 * threshold is one place to reconsider, not buried in a comparison.
 */
export const STALE_AFTER_DAYS = 180;

/** Whether `updatedAt` (an ISO YYYY-MM-DD date) is older than STALE_AFTER_DAYS relative to `asOf` (defaults to now). `asOf` is a parameter, not always `new Date()`, so staleness is deterministic to test. */
export function isStale(updatedAt: string, asOf: Date = new Date()): boolean {
  const updatedMs = new Date(`${updatedAt}T00:00:00Z`).getTime();
  const ageDays = (asOf.getTime() - updatedMs) / (1000 * 60 * 60 * 24);
  return ageDays > STALE_AFTER_DAYS;
}
