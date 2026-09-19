import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSharedDuoConfig } from "../src/shared-duo/config.js";
import {
  assertAuthoredKnowledgeOnly,
  assertHumanOwner,
  createSharedDuo,
  loadSharedDuo,
  parseSharedDuoDefinition,
  SharedDuoKnowledgeError,
  SharedDuoOwnershipError,
} from "../src/shared-duo/loader.js";
import type { DuoDefinition } from "../src/duo/types.js";
import { useTempDir } from "./helpers/temp-dir.js";

function definition(overrides: Partial<DuoDefinition> = {}): DuoDefinition {
  return {
    id: "shared-duo",
    owner: { kind: "person", id: "dana-cole", name: "Dana Cole" },
    persona: { voice: "plain, procedural, cites its sources" },
    standingOrders: ["answer only from the configured documents"],
    refusals: ["does not decide anything on the team's behalf"],
    knowledge: { kind: "authored", documents: ["leave policy: 14 days"] },
    ...overrides,
  };
}

describe("loadSharedDuoConfig", () => {
  it("defaults to shared-duo/persona.json", () => {
    expect(loadSharedDuoConfig({}).personaPath).toBe("shared-duo/persona.json");
  });

  it("honours DUO_SHARED_PERSONA_PATH", () => {
    expect(loadSharedDuoConfig({ DUO_SHARED_PERSONA_PATH: "/tmp/other.json" }).personaPath).toBe("/tmp/other.json");
  });
});

describe("a duo loads from its configuration file (#67 AC1)", () => {
  it("resolves persona, standing orders, refusals, and knowledge straight from the definition", () => {
    const duo = createSharedDuo(definition());
    expect(duo.id).toBe("shared-duo");
    expect(duo.persona.voice).toBe("plain, procedural, cites its sources");
    expect(duo.standingOrders).toEqual(["answer only from the configured documents"]);
    expect(duo.refusals).toEqual(["does not decide anything on the team's behalf"]);
  });

  it("answers only from the documents named in its own configuration, and nothing else", async () => {
    const duo = createSharedDuo(
      definition({ knowledge: { kind: "authored", documents: ["leave policy: 14 days", "unrelated note"] } }),
    );
    const results = await duo.knowledge.retrieve("leave policy");
    expect(results).toEqual([{ text: "leave policy: 14 days", source: "authored" }]);
  });
});

describe("a configuration missing a human owner is refused (#67 AC2)", () => {
  it("assertHumanOwner throws SharedDuoOwnershipError, naming the duo, when owner is absent", () => {
    const def = definition({ owner: { kind: "none" } });
    expect(() => assertHumanOwner(def)).toThrow(SharedDuoOwnershipError);
    expect(() => assertHumanOwner(def)).toThrow(/shared-duo/);
    expect(() => assertHumanOwner(def)).toThrow(/"none"/);
  });

  it("assertHumanOwner throws when owner is a role rather than a person", () => {
    const def = definition({ owner: { kind: "role", id: "desk", name: "Duty Desk" } });
    expect(() => assertHumanOwner(def)).toThrow(SharedDuoOwnershipError);
    expect(() => assertHumanOwner(def)).toThrow(/"role"/);
  });

  it("assertHumanOwner is a no-op when owner is a person", () => {
    expect(() => assertHumanOwner(definition())).not.toThrow();
  });

  it("createSharedDuo refuses an owner-less definition before constructing anything", () => {
    expect(() => createSharedDuo(definition({ owner: { kind: "none" } }))).toThrow(SharedDuoOwnershipError);
  });

  it("parseSharedDuoDefinition still runs the general shape validation first", () => {
    const raw = { ...definition(), owner: { kind: "not-a-real-kind" } };
    expect(() => parseSharedDuoDefinition(raw)).toThrow(/definition\.owner\.kind/);
  });
});

describe("a shared duo is grounded in authored-only knowledge (#68 AC3)", () => {
  it("assertAuthoredKnowledgeOnly is a no-op when knowledge.kind is authored", () => {
    expect(() => assertAuthoredKnowledgeOnly(definition())).not.toThrow();
  });

  it("assertAuthoredKnowledgeOnly throws SharedDuoKnowledgeError, naming the duo and kind, for a derived/personal store", () => {
    const def = definition({ knowledge: { kind: "derived", storePath: "data/someones-personal-duo.db" } });
    expect(() => assertAuthoredKnowledgeOnly(def)).toThrow(SharedDuoKnowledgeError);
    expect(() => assertAuthoredKnowledgeOnly(def)).toThrow(/shared-duo/);
    expect(() => assertAuthoredKnowledgeOnly(def)).toThrow(/"derived"/);
  });

  it("createSharedDuo refuses a persona file pointed at a real personal store, before anything is constructed", () => {
    const def = definition({ knowledge: { kind: "derived", storePath: "data/someones-personal-duo.db" } });
    expect(() => createSharedDuo(def)).toThrow(SharedDuoKnowledgeError);
  });
});

describe("loadSharedDuo — reading the persona file from disk", () => {
  const tempDir = useTempDir();

  it("reads and validates a persona file, defaulting to shared-duo/persona.json when no path is given", () => {
    const path = join(tempDir(), "persona.json");
    writeFileSync(path, JSON.stringify(definition({ id: "from-file" })));
    const duo = loadSharedDuo(path);
    expect(duo.id).toBe("from-file");
    expect(duo.owner.kind).toBe("person");
  });

  it("fails naming the missing owner when the file on disk has none", () => {
    const path = join(tempDir(), "unowned.json");
    writeFileSync(path, JSON.stringify(definition({ owner: { kind: "none" } })));
    expect(() => loadSharedDuo(path)).toThrow(SharedDuoOwnershipError);
  });

  it("reads the real checked-in shared-duo/persona.json end to end", () => {
    // Deliberately the actual repo file, not a fixture: #67's AC bullet
    // "Persona files live in the repository and are reviewed like code"
    // is only meaningful if something actually asserts the real file
    // loads. Run from the repo root, same as every other CLI-facing test.
    const duo = loadSharedDuo("shared-duo/persona.json");
    expect(duo.id).toBe("shared-duo");
    expect(duo.owner.kind).toBe("person");
  });
});

describe("no code path in this module writes a persona file", () => {
  it("exports only read/construct operations", async () => {
    const loaderModule = await import("../src/shared-duo/loader.js");
    const exportNames = Object.keys(loaderModule);
    const writeLike = exportNames.filter((name) => /write|save|persist/i.test(name));
    expect(writeLike).toEqual([]);
  });
});
