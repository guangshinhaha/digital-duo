import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ConfidenceResult } from "../src/drafting/confidence.js";
import { buildAnswerEvent, buildFailedAnswerEvent } from "../src/workspace/payload.js";
import { PUBLIC_ANSWER_FAILED_MESSAGE, type PublicAnswerOutcome } from "../src/permissions/public-answer.js";

// Markers planted in every owner-facing or corpus-shaped field of a poisoned
// outcome: if any of these strings ever serializes into an outbound
// workspace payload, the corpus boundary (docs/workspace-platform.md §5,
// #186 AC5) has been broken.
const POISON = {
  draftId: "POISON-draft-id",
  logEntryId: "POISON-log-entry-id",
  topicId: "POISON-topic-id",
  ownerNotice: "POISON-owner-notice",
  sourceId: "POISON-source-id",
  evidenceText: "POISON-grounding-chunk-evidence-text",
  passphrase: "POISON-store-passphrase",
} as const;

function confidence(): ConfidenceResult {
  return {
    signals: { selfConsistency: 1, retrievalStrength: 1, ruleHit: 1, recency: 1, selfReport: 1 },
    weights: { selfConsistency: 0.3, retrievalStrength: 0.3, ruleHit: 0.25, recency: 0.1, selfReport: 0.05 },
    score: 0.9,
    passesThreshold: true,
    threshold: 0.55,
  };
}

describe("buildAnswerEvent — the corpus never crosses (#186 AC5, decision record §5)", () => {
  it("builds exactly a Matrix text message: two keys, msgtype m.text, the asker-visible text as body", () => {
    const outcome: PublicAnswerOutcome = {
      kind: "answered",
      draftId: POISON.draftId,
      logEntryId: POISON.logEntryId,
      text: "The owner approved the vendor renewal on 2026-08-14.",
      sources: [
        { kind: "evidence", id: POISON.sourceId, label: "Vendor decision record" },
        { kind: "rule", id: POISON.topicId, label: "Always name the date" },
      ],
      confidence: confidence(),
      topicId: POISON.topicId,
      evidenceAgeDays: 42,
    };
    const event = buildAnswerEvent(outcome);
    expect(event).toEqual({ msgtype: "m.text", body: "The owner approved the vendor renewal on 2026-08-14." });
  });

  it("serializes none of the owner-facing or corpus-shaped outcome fields — the payload cannot carry what it never copies", () => {
    const outcome: PublicAnswerOutcome = {
      kind: "answered",
      draftId: POISON.draftId,
      logEntryId: POISON.logEntryId,
      // The one sanctioned carrier: the composed asker-visible text. The
      // structured source entries (ids, labels — where evidence-shaped
      // strings would ride if they crossed) are not copied; only `text` is.
      text: "Approved on 2026-08-14.",
      sources: [
        { kind: "evidence", id: POISON.sourceId, label: POISON.evidenceText },
        { kind: "rule", id: POISON.topicId, label: "rule label" },
      ],
      confidence: confidence(),
      topicId: POISON.topicId,
      evidenceAgeDays: 42,
    };
    const serialized = JSON.stringify(buildAnswerEvent(outcome));
    // What must never appear: identifiers, provenance and evidence-shaped
    // content living in the outcome's non-asker-visible fields.
    for (const forbidden of [POISON.draftId, POISON.logEntryId, POISON.topicId, POISON.sourceId, POISON.evidenceText, POISON.ownerNotice]) {
      expect(serialized).not.toContain(forbidden);
    }
    // The asker-visible text IS carried (it is the answer). The structural
    // guarantee is about everything else, and about the builder having no
    // path that could copy anything else — pinned by the key-shape test
    // above and the type-level fact that AnswerEventContent has two fields.
    expect(serialized).toContain("Approved on 2026-08-14.");
  });

  it("carries the passed-on message, not the escalation internals, on a passed_on outcome", () => {
    const outcome: PublicAnswerOutcome = {
      kind: "passed_on",
      draftId: POISON.draftId,
      logEntryId: POISON.logEntryId,
      message: "I can't answer that one for you directly — I've passed it on to the owner, and they'll follow up.",
      topicId: POISON.topicId,
      ownerNotice: POISON.ownerNotice,
    };
    const event = buildAnswerEvent(outcome);
    expect(event.body).toContain("passed it on to the owner");
    expect(JSON.stringify(event)).not.toContain(POISON.ownerNotice);
  });

  it("carries the refusal message on a declined_refused outcome", () => {
    const outcome: PublicAnswerOutcome = {
      kind: "declined_refused",
      draftId: POISON.draftId,
      logEntryId: POISON.logEntryId,
      message: "That's not something I speak for the owner on. I've passed it on to them, without saying anything more about it here.",
    };
    expect(buildAnswerEvent(outcome).body).toContain("not something I speak for the owner on");
  });

  it("keeps the pipeline-failure event identical to POST /ask's asker-visible 500 text — one vocabulary, no transport tells", () => {
    // The linkage is structural, not disciplinary: buildFailedAnswerEvent
    // and the /ask 500 body (src/serve/server.ts) import the SAME
    // PUBLIC_ANSWER_FAILED_MESSAGE constant — no hand-rolled copy exists
    // that could drift. This pins the value and the event shape.
    expect(buildFailedAnswerEvent()).toEqual({ msgtype: "m.text", body: PUBLIC_ANSWER_FAILED_MESSAGE });
    expect(PUBLIC_ANSWER_FAILED_MESSAGE).toBe("Something went wrong answering that.");
  });

  it("plants no passphrase-shaped value anywhere it could copy — the builder's input is the outcome, and the outcome carries no passphrase", () => {
    // The strongest honest form of this assertion: the payload type has
    // exactly two string fields, and this test fails to compile if anyone
    // adds a third — because `toEqual({ msgtype, body })` above is checked
    // against the literal shape. What a reviewer should take from this
    // file: there is no code path from the store passphrase (config/env)
    // into buildAnswerEvent; the only argument is a PublicAnswerOutcome.
    expect(Object.keys(buildAnswerEvent({ kind: "declined_refused", draftId: "d", logEntryId: "l", message: "m" })).sort()).toEqual([
      "body",
      "msgtype",
    ]);
    expect(JSON.stringify(buildAnswerEvent({ kind: "declined_refused", draftId: "d", logEntryId: "l", message: "m" }))).not.toContain(
      POISON.passphrase,
    );
  });
});

describe("workspace egress surface — structural pin on what src/workspace may import (the R2/KTD10 idiom, applied to the corpus boundary)", () => {
  const srcRoot = fileURLToPath(new URL("../src/workspace", import.meta.url));

  // Recursive on purpose: a future src/workspace/<sub>/ directory is scanned
  // like the top level — the walk is the guard's reach, not decoration (the
  // repo's egress scan in test/gitignore.test.ts uses the same walk shape).
  function workspaceFiles(): string[] {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
        } else if (entry.name.endsWith(".ts")) {
          files.push(path);
        }
      }
    };
    walk(srcRoot);
    return files;
  }

  // Every form a module specifier can take: static `import … from "x"`
  // (single- or multi-line), side-effect `import "x"`, dynamic
  // `await import("x")`, and re-export `export … from "x"`. A from-only
  // shape is blind to exactly the forms a boundary crosser would reach for
  // first — src/commands/serve.ts already uses the dynamic form by design.
  // Over-matching (a comment quoting `from "…"`) fails the scan loudly,
  // which is the safe direction for a guard.
  function importSpecifiers(text: string): string[] {
    const specifiers: string[] = [];
    for (const match of text.matchAll(/from\s*["']([^"']+)["']/g)) {
      specifiers.push(match[1]!);
    }
    for (const match of text.matchAll(/\bimport\s*["']([^"']+)["']/g)) {
      specifiers.push(match[1]!);
    }
    for (const match of text.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)) {
      specifiers.push(match[1]!);
    }
    return specifiers;
  }

  it("captures every import form — static, side-effect, dynamic, and re-export — so the scans below cannot be walked around", () => {
    const captured = importSpecifiers(
      [
        'import { a } from "../store/store.js";',
        'import type { T } from "matrix-js-sdk";',
        'import "../ingest/embeddings.js";',
        'const sdk = await import("matrix-js-sdk");',
        'export { helper } from "../trust/rules.js";',
      ].join("\n"),
    );
    expect(captured).toHaveLength(5);
    expect(captured).toEqual(
      expect.arrayContaining(["../store/store.js", "matrix-js-sdk", "../ingest/embeddings.js", "../trust/rules.js"]),
    );
  });

  it("imports matrix-js-sdk in exactly one file — the adapter — so the seam stays SDK-free everywhere else", () => {
    const importers = workspaceFiles().filter((path) => importSpecifiers(readFileSync(path, "utf8")).includes("matrix-js-sdk"));
    expect(importers.map((path) => path.split("/").pop())).toEqual(["matrix-transport.ts"]);
  });

  it("never imports a corpus-bearing module in any form — the pipeline arrives by injection, not by reach-in", () => {
    const forbidden = /^\.\.\/(store|ingest|derivation|drafting|corrections|trust)\//;
    const offenders = workspaceFiles().filter((path) =>
      importSpecifiers(readFileSync(path, "utf8")).some((specifier) => forbidden.test(specifier)),
    );
    expect(offenders).toEqual([]);
  });

  it("uses no network primitive of its own — only the SDK adapter talks to the network", () => {
    const networkModules = new Set([
      "http",
      "https",
      "net",
      "tls",
      "dgram",
      "undici",
      "ws",
      "node:http",
      "node:https",
      "node:net",
      "node:tls",
      "node:dgram",
    ]);
    const offenders = workspaceFiles().filter((path) => {
      const text = readFileSync(path, "utf8");
      const callSites = /\bfetch\s*\(|\bnew\s+WebSocket\b/.test(text);
      const imports = importSpecifiers(text).some((specifier) => networkModules.has(specifier));
      return callSites || imports;
    });
    expect(offenders).toEqual([]);
  });

  it("opens no listener — the workspace connection is outbound only (#186 AC2)", () => {
    const offenders = workspaceFiles().filter((path) => /\blisten\s*\(|createServer\s*\(/.test(readFileSync(path, "utf8")));
    expect(offenders).toEqual([]);
  });

  // #187 AC4: nobody gets a duo they did not create. The enforcement is
  // structural, not disciplinary: the module that talks to the homeserver
  // has no provisioning primitive at all, so a member joining the workspace
  // cannot be handed a duo by this code — or by an administrator through
  // it. The only duo-credential creation that exists is local pairing
  // (#186's env-token shape), on the owner's machine, per the platform
  // decision §6.
  it("contains no account-provisioning primitive — the module cannot create, register, or administer workspace users (#187 AC4)", () => {
    // Every form of user creation the SDK (and Synapse's admin surface)
    // names: the client-side register calls, admin-API paths, and the raw
    // registration endpoint. The adapter is the only SDK importer, and the
    // seam above pins that — this scan pins the calls themselves, wherever
    // they would appear.
    const provisioning = /\bregister(User|Request|Guest)?\s*\(|\bcreateAccount\b|\/_synapse\/admin|\/register\b|\bdeactivateAccount\b/;
    const offenders = workspaceFiles().filter((path) => provisioning.test(readFileSync(path, "utf8")));
    expect(offenders).toEqual([]);
  });
});
