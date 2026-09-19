import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  discardArtifact,
  getPreparedArtifact,
  listDiscardSignals,
  listPreparedArtifacts,
  NotAT1ActionError,
  prepareArtifact,
  PreparedArtifactNotFoundError,
} from "../src/actions/preparation.js";
import { registerAction, resolveActionForUse } from "../src/actions/registry.js";
import { grantAutonomy } from "../src/trust/grants.js";
import { createEncryptedStore } from "../src/store/store.js";
import { useTempDir } from "./helpers/temp-dir.js";

const tempDir = useTempDir();
const PASSPHRASE = "pw";

function initStore(): string {
  const storePath = join(tempDir(), "data", "duo.db");
  createEncryptedStore(storePath, PASSPHRASE);
  return storePath;
}

function duoDir(): string {
  return join(tempDir(), "duo");
}

describe("prepareArtifact — an artifact is prepared and visible only to the owner (#57 AC1)", () => {
  it("creates a prepared artifact, labelled by kind, retrievable afterward", () => {
    const storePath = initStore();
    const artifact = prepareArtifact(storePath, PASSPHRASE, duoDir(), { kind: "draft", topicId: "topic-a", title: "Reply to Jamie", content: "Sure, I can do Thursday." });

    expect(artifact.kind).toBe("draft");
    expect(artifact.title).toBe("Reply to Jamie");
    expect(getPreparedArtifact(storePath, PASSPHRASE, artifact.id)).toEqual(artifact);
  });

  it("auto-registers the built-in action as genuinely T1, never a higher tier", () => {
    const storePath = initStore();
    prepareArtifact(storePath, PASSPHRASE, duoDir(), { kind: "document", topicId: "topic-a", title: "Weekly report", content: "..." });
    const outcome = resolveActionForUse(storePath, PASSPHRASE, duoDir(), "prepare_document", "topic-a");
    expect(outcome).toMatchObject({ status: "resolved", tier: "T1" });
  });

  it("prepares an artifact regardless of the trust grid's autonomy level for the topic — T1 is never gated on a grant", () => {
    const storePath = initStore();
    // No grant at all, and no topic in topics.json — the level would
    // resolve to "ask" if it were consulted, which it deliberately isn't.
    const artifact = prepareArtifact(storePath, PASSPHRASE, duoDir(), { kind: "ticket", topicId: "never-granted-topic", title: "Route this", content: "..." });
    expect(artifact.id).toBeTruthy();
  });

  it("succeeds identically whether or not some unrelated grant exists", () => {
    const storePath = initStore();
    grantAutonomy(storePath, PASSPHRASE, duoDir(), { scopeText: "unrelated", tier: "T0" }); // no-op, no matching topic — just proves grants.ts machinery doesn't interfere
    const artifact = prepareArtifact(storePath, PASSPHRASE, duoDir(), { kind: "draft", topicId: "topic-a", title: "x", content: "y" });
    expect(artifact.kind).toBe("draft");
  });

  it("refuses when the built-in action was somehow re-tiered away from T1 (defensive — the registry, not this module, is the source of truth)", () => {
    const storePath = initStore();
    // Force the built-in action to a higher tier by re-registering it with
    // a different risk shape under the same id before this module ever
    // touches it — simulates a future bug or a deliberate reconfiguration.
    registerAction(storePath, PASSPHRASE, { id: "prepare_draft", description: "tampered", reversible: true, obligates: true, audience: "internal", topicIds: ["topic-a"] });
    expect(() => prepareArtifact(storePath, PASSPHRASE, duoDir(), { kind: "draft", topicId: "topic-a", title: "x", content: "y" })).toThrow(NotAT1ActionError);
  });
});

describe("prepareArtifact — preparation never leaks into a shared space (#57 AC2)", () => {
  it("preparation.ts imports nothing from ../shared-duo/", () => {
    const path = fileURLToPath(new URL("../src/actions/preparation.ts", import.meta.url));
    const source = readFileSync(path, "utf8");
    expect(source).not.toMatch(/from ["']\.\.\/shared-duo\//);
  });

  it("this module exports no submit/send/share function — there is no configuration in which a prepared artifact leaves the store", async () => {
    const module = await import("../src/actions/preparation.js");
    const exportNames = Object.keys(module);
    expect(exportNames.some((name) => /submit|send|share|publish/i.test(name))).toBe(false);
  });
});

describe("discardArtifact — discarding is one action and leaves nothing (#57 AC3)", () => {
  it("removes the artifact entirely", () => {
    const storePath = initStore();
    const artifact = prepareArtifact(storePath, PASSPHRASE, duoDir(), { kind: "draft", topicId: "topic-a", title: "x", content: "y" });
    discardArtifact(storePath, PASSPHRASE, artifact.id);
    expect(getPreparedArtifact(storePath, PASSPHRASE, artifact.id)).toBeUndefined();
    expect(listPreparedArtifacts(storePath, PASSPHRASE)).toEqual([]);
  });

  it("records the discard as a signal that survives the artifact's deletion", () => {
    const storePath = initStore();
    const artifact = prepareArtifact(storePath, PASSPHRASE, duoDir(), { kind: "ticket", topicId: "topic-a", title: "Route it", content: "y" });
    discardArtifact(storePath, PASSPHRASE, artifact.id, "wrong assignee");

    const signals = listDiscardSignals(storePath, PASSPHRASE);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ artifactId: artifact.id, kind: "ticket", title: "Route it", note: "wrong assignee" });
  });

  it("throws for an unknown id, changing nothing", () => {
    const storePath = initStore();
    expect(() => discardArtifact(storePath, PASSPHRASE, "no-such-id")).toThrow(PreparedArtifactNotFoundError);
    expect(listDiscardSignals(storePath, PASSPHRASE)).toEqual([]);
  });
});

describe("listPreparedArtifacts — everything prepared is visible in one place, and only there", () => {
  it("lists every artifact, oldest first", () => {
    const storePath = initStore();
    prepareArtifact(storePath, PASSPHRASE, duoDir(), { kind: "draft", topicId: "topic-a", title: "first", content: "a" });
    prepareArtifact(storePath, PASSPHRASE, duoDir(), { kind: "document", topicId: "topic-a", title: "second", content: "b" });
    const artifacts = listPreparedArtifacts(storePath, PASSPHRASE);
    expect(artifacts.map((a) => a.title)).toEqual(["first", "second"]);
  });
});
