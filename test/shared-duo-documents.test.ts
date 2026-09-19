import { describe, expect, it } from "vitest";
import { isStale, MalformedPublishedDocumentError, parsePublishedDocument, STALE_AFTER_DAYS } from "../src/shared-duo/documents.js";

describe("parsePublishedDocument", () => {
  it("splits a well-formed document into title, update date, and body", () => {
    const doc = parsePublishedDocument("Leave requests (updated 2026-06-01): submit through the HR portal.");
    expect(doc).toEqual({
      title: "Leave requests",
      updatedAt: "2026-06-01",
      text: "submit through the HR portal.",
      raw: "Leave requests (updated 2026-06-01): submit through the HR portal.",
    });
  });

  it("throws MalformedPublishedDocumentError, naming the offending string, when the prefix is absent", () => {
    expect(() => parsePublishedDocument("just some text")).toThrow(MalformedPublishedDocumentError);
    expect(() => parsePublishedDocument("just some text")).toThrow(/just some text/);
  });

  it("rejects a date that isn't YYYY-MM-DD", () => {
    expect(() => parsePublishedDocument("Title (updated June 2026): body")).toThrow(MalformedPublishedDocumentError);
  });

  it("rejects a date shaped like YYYY-MM-DD that isn't a real calendar date, rather than silently rolling it over", () => {
    expect(() => parsePublishedDocument("Title (updated 2026-13-45): body")).toThrow(MalformedPublishedDocumentError);
    expect(() => parsePublishedDocument("Title (updated 2026-02-30): body")).toThrow(MalformedPublishedDocumentError);
  });
});

describe("isStale", () => {
  it("is false for a document updated well within the threshold", () => {
    const asOf = new Date("2026-09-19T00:00:00Z");
    expect(isStale("2026-08-01", asOf)).toBe(false);
  });

  it(`is true for a document older than ${STALE_AFTER_DAYS} days`, () => {
    const asOf = new Date("2026-09-19T00:00:00Z");
    expect(isStale("2024-01-01", asOf)).toBe(true);
  });

  it("is false exactly at the threshold boundary and true just past it", () => {
    const asOf = new Date(`2026-01-01T00:00:00Z`);
    const justUnder = new Date(asOf.getTime() - (STALE_AFTER_DAYS - 1) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const justOver = new Date(asOf.getTime() - (STALE_AFTER_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    expect(isStale(justUnder, asOf)).toBe(false);
    expect(isStale(justOver, asOf)).toBe(true);
  });
});
