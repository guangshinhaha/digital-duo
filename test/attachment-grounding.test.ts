import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  attachmentGroundingDoor,
  GROUNDING_ATTACHMENT_MIME_TYPES,
  MAX_ATTACHMENTS_PER_QUESTION,
  MAX_ATTACHMENT_BYTES,
} from "../src/drafting/attachment-grounding.js";
import type { ClassificationLevel } from "../src/ingest/record.js";
import type { WorkspaceFileFetcher, WorkspaceFileReference } from "../src/workspace/transport.js";

/**
 * #190: the attachment grounding door, as code against the decision record
 * (docs/workspace/attachments.md). What these tests pin is the record's own
 * load-bearing claims: the check ORDER (§6/§7 — declarations before any
 * body is read; the ceiling before any grounding), the refusal wording
 * (§7 — every refusal names the limit broken), the strip-at-the-door
 * (§6 — every downstream echo inherits a text that never carried a
 * marking), and — structurally — that sharing is not importing (§4).
 */

const OFFICIAL_OPEN: ClassificationLevel = "official_open";
const RESTRICTED: ClassificationLevel = "restricted";

function ref(overrides: Partial<WorkspaceFileReference> = {}): WorkspaceFileReference {
  return { reference: "mxc://workspace/abc123", name: "notes.txt", mimeType: "text/plain", size: 10, ...overrides };
}

/** A fetcher over a reference→text table, recording every call — the "was the body read at all" evidence. */
function fetcherWith(files: Record<string, string>, overrides: { exceededMaxBytes?: boolean } = {}) {
  const calls: { reference: string; maxBytes: number }[] = [];
  const fetcher: WorkspaceFileFetcher = async (reference, options) => {
    calls.push({ reference, maxBytes: options.maxBytes });
    const body = files[reference];
    if (body === undefined) {
      throw new Error(`no such file ${reference}`);
    }
    return { bytes: new TextEncoder().encode(body), exceededMaxBytes: overrides.exceededMaxBytes ?? false };
  };
  return { fetcher, calls };
}

describe("attachmentGroundingDoor — the record's limits, pinned as constants (attachments.md §7)", () => {
  it("is exactly 32 KiB of text per attachment, at most 3 per question, text/plain and text/markdown only", () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(32 * 1024);
    expect(MAX_ATTACHMENTS_PER_QUESTION).toBe(3);
    expect(GROUNDING_ATTACHMENT_MIME_TYPES).toEqual(["text/plain", "text/markdown"]);
  });
});

describe("attachmentGroundingDoor — declarations decided before any body is read (§7)", () => {
  it("never calls fetchFile for a count refusal: four attachments, fetcher untouched, refusal names 3 and 4", async () => {
    const { fetcher, calls } = fetcherWith({});
    const door = attachmentGroundingDoor(OFFICIAL_OPEN);
    const result = await door(
      [ref({ reference: "mxc://w/1" }), ref({ reference: "mxc://w/2" }), ref({ reference: "mxc://w/3" }), ref({ reference: "mxc://w/4" })],
      fetcher,
    );
    expect(result).toEqual({ kind: "refused", message: expect.stringContaining("at most 3 attachments") });
    expect(result.kind === "refused" && result.message).toContain("this question carries 4");
    expect(calls).toEqual([]);
  });

  it("refuses an image without reading it, citing the open provider decision — and the file stays shared", async () => {
    const { fetcher, calls } = fetcherWith({});
    const result = await attachmentGroundingDoor(OFFICIAL_OPEN)([ref({ name: "photo.png", mimeType: "image/png" })], fetcher);
    expect(result.kind).toBe("refused");
    expect(result.kind === "refused" && result.message).toContain("can't read images");
    expect(result.kind === "refused" && result.message).toContain("photo.png");
    expect(result.kind === "refused" && result.message).toContain("stays shared");
    expect(calls).toEqual([]);
  });

  it("refuses an undeclared type without reading it, naming the real reason — no extraction pipeline", async () => {
    const { fetcher, calls } = fetcherWith({});
    const result = await attachmentGroundingDoor(OFFICIAL_OPEN)([ref({ mimeType: null })], fetcher);
    expect(result.kind).toBe("refused");
    expect(result.kind === "refused" && result.message).toContain("type wasn't declared");
    expect(result.kind === "refused" && result.message).toContain("no extraction pipeline");
    expect(calls).toEqual([]);
  });

  it("refuses a document type without reading it, naming the type and the real reason", async () => {
    const { fetcher, calls } = fetcherWith({});
    const result = await attachmentGroundingDoor(OFFICIAL_OPEN)([ref({ name: "report.pdf", mimeType: "application/pdf" })], fetcher);
    expect(result.kind).toBe("refused");
    expect(result.kind === "refused" && result.message).toContain("application/pdf");
    expect(result.kind === "refused" && result.message).toContain("no extraction pipeline");
    expect(calls).toEqual([]);
  });

  it("refuses an over-bound declared size without reading it, naming 32.0 KiB and the import-shaped reason", async () => {
    const { fetcher, calls } = fetcherWith({});
    const result = await attachmentGroundingDoor(OFFICIAL_OPEN)([ref({ size: 45 * 1024 })], fetcher);
    expect(result.kind).toBe("refused");
    expect(result.kind === "refused" && result.message).toContain("45.0 KiB");
    expect(result.kind === "refused" && result.message).toContain("32.0 KiB");
    expect(result.kind === "refused" && result.message).toContain("import");
    expect(calls).toEqual([]);
  });

  it("decides type before size when both are broken — the PDF's refusal is the type's, not the size's", async () => {
    const { fetcher, calls } = fetcherWith({});
    const result = await attachmentGroundingDoor(OFFICIAL_OPEN)([ref({ mimeType: "application/pdf", size: 45 * 1024 })], fetcher);
    expect(result.kind === "refused" && result.message).toContain("application/pdf");
    expect(calls).toEqual([]);
  });

  it("decides count before type — five files including an image is a count refusal", async () => {
    const { fetcher, calls } = fetcherWith({});
    const result = await attachmentGroundingDoor(OFFICIAL_OPEN)(
      Array.from({ length: 5 }, (_, i) => ref({ reference: `mxc://w/${i}`, mimeType: i === 0 ? "image/png" : "text/plain" })),
      fetcher,
    );
    expect(result.kind === "refused" && result.message).toContain("at most 3 attachments");
    expect(calls).toEqual([]);
  });
});

describe("attachmentGroundingDoor — the ceiling, checked on the decoded body before any grounding (§6)", () => {
  it("refuses above-ceiling material naming the marking and the ceiling, having reasoned about nothing", async () => {
    const { fetcher, calls } = fetcherWith({ "mxc://workspace/abc123": "secret\nthe launch date is March 3rd" });
    const result = await attachmentGroundingDoor(OFFICIAL_OPEN)([ref()], fetcher);
    expect(result.kind).toBe("refused");
    expect(result.kind === "refused" && result.message).toContain("marked secret");
    expect(result.kind === "refused" && result.message).toContain("official_open");
    // The body WAS read — the ceiling is a content decision, made on the
    // decoded text (§6), after the declarations and before grounding.
    expect(calls).toHaveLength(1);
  });

  it("grounds within-ceiling material with the marking stripped at the door — nothing downstream ever receives it", async () => {
    const { fetcher } = fetcherWith({ "mxc://workspace/abc123": "restricted\nthe launch date is March 3rd" });
    const result = await attachmentGroundingDoor(RESTRICTED)([ref()], fetcher);
    expect(result).toEqual({
      kind: "grounded",
      grounding: [
        {
          reference: "mxc://workspace/abc123",
          name: "notes.txt",
          mimeType: "text/plain",
          text: "the launch date is March 3rd",
        },
      ],
    });
  });

  it("grounds unmarked text — the asker supplied it and no gate minted a clearance for it", async () => {
    const { fetcher } = fetcherWith({ "mxc://workspace/abc123": "no marking anywhere, just text" });
    const result = await attachmentGroundingDoor(OFFICIAL_OPEN)([ref()], fetcher);
    expect(result.kind).toBe("grounded");
    expect(result.kind === "grounded" && result.grounding[0]!.text).toBe("no marking anywhere, just text");
  });
});

describe("attachmentGroundingDoor — the read, bounded and honest (§3/§7)", () => {
  it("catches a body that overruns the bound even when the declared size understated it", async () => {
    const { fetcher } = fetcherWith({ "mxc://workspace/abc123": "x".repeat(40 * 1024) }, { exceededMaxBytes: true });
    const result = await attachmentGroundingDoor(OFFICIAL_OPEN)([ref({ size: 10 })], fetcher);
    expect(result.kind).toBe("refused");
    expect(result.kind === "refused" && result.message).toContain("32.0 KiB");
    expect(result.kind === "refused" && result.message).toContain("import");
  });

  it("refuses a retrieval failure with a recoverable reason — never a guess, never a silent text-only answer", async () => {
    const { fetcher } = fetcherWith({});
    const result = await attachmentGroundingDoor(OFFICIAL_OPEN)([ref()], fetcher);
    expect(result.kind).toBe("refused");
    expect(result.kind === "refused" && result.message).toContain(`couldn't retrieve "notes.txt"`);
    expect(result.kind === "refused" && result.message).toContain("deleted");
    expect(result.kind === "refused" && result.message).toContain("re-asking");
  });

  it("accepts charset parameters and case-insensitive type declarations — RFC 2045 normalization, not new rules", async () => {
    const { fetcher } = fetcherWith({
      "mxc://w/1": "one",
      "mxc://w/2": "two",
    });
    const result = await attachmentGroundingDoor(OFFICIAL_OPEN)(
      [ref({ reference: "mxc://w/1", mimeType: "text/plain; charset=utf-8" }), ref({ reference: "mxc://w/2", mimeType: "TEXT/MARKDOWN" })],
      fetcher,
    );
    expect(result.kind).toBe("grounded");
    expect(result.kind === "grounded" && result.grounding.map((a) => a.mimeType)).toEqual(["text/plain", "text/markdown"]);
  });

  it("grounds up to the cap in the order the files were shared", async () => {
    const { fetcher } = fetcherWith({ "mxc://w/1": "one", "mxc://w/2": "two", "mxc://w/3": "three" });
    const result = await attachmentGroundingDoor(OFFICIAL_OPEN)(
      [ref({ reference: "mxc://w/1" }), ref({ reference: "mxc://w/2" }), ref({ reference: "mxc://w/3" })],
      fetcher,
    );
    expect(result.kind === "grounded" && result.grounding.map((a) => a.text)).toEqual(["one", "two", "three"]);
  });

  it("bounds a sender-chosen filename and type in every echo — a huge name cannot balloon a refusal, a label, or a prompt header", async () => {
    const huge = "x".repeat(10_000);
    const { fetcher } = fetcherWith({ "mxc://workspace/abc123": "fine text" });
    const refused = await attachmentGroundingDoor(OFFICIAL_OPEN)([ref({ name: huge, mimeType: huge })], fetcher);
    expect(refused.kind).toBe("refused");
    expect(refused.kind === "refused" && refused.message.length).toBeLessThan(600);
    expect(refused.kind === "refused" && refused.message).not.toContain(huge);
    // And on the grounded side: the name that rides downstream is the
    // bounded one, so source labels and prompt headers inherit the bound.
    const grounded = await attachmentGroundingDoor(OFFICIAL_OPEN)([ref({ name: huge })], fetcher);
    expect(grounded.kind === "grounded" && grounded.grounding[0]!.name.length).toBeLessThanOrEqual(80);
  });
});

describe("sharing is not importing — structural pins (#190, attachments.md §4)", () => {
  /** Every static import/re-export specifier in a source file, deduped — the module's own words, read back. */
  function importSpecifiers(path: string): string[] {
    return [...new Set([...readFileSync(path, "utf8").matchAll(/\bfrom\s*["']([^"']+)["']/g)].map((match) => match[1]!))];
  }

  it("the door module imports only the read-only classification helpers and the seam's types — no corpus-bearing module", () => {
    const doorPath = fileURLToPath(new URL("../src/drafting/attachment-grounding.ts", import.meta.url));
    expect(importSpecifiers(doorPath).sort()).toEqual(["../ingest/record.js", "../permissions/classification.js", "../workspace/transport.js"]);
  });

  it("nothing in the import pipeline imports the workspace — there is no module path from a conversation file to the corpus", () => {
    // The import half of the boundary: every module that can write to the
    // corpus through ingest, plus the owner's explicit import command. None
    // of them may even name the workspace seam, so no code path can grow
    // from "a file reference arrived in a conversation" to "it was
    // imported" — importing stays the owner's explicit act (#176).
    const importers = [
      fileURLToPath(new URL("../src/ingest", import.meta.url)),
      fileURLToPath(new URL("../src/commands/import.ts", import.meta.url)),
    ];
    const offenders = importers.flatMap((path) => {
      // src/ingest is a directory: walk its .ts files (flat, by design).
      const files = path.endsWith(".ts") ? [path] : readdirTs(path);
      return files.filter((file) => importSpecifiers(file).some((specifier) => specifier.includes("workspace")));
    });
    expect(offenders).toEqual([]);
  });
});

/** Lists a directory's .ts files (non-recursive — src/ingest is flat). */
function readdirTs(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(dir, name));
}
