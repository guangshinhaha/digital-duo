import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MissingHumanOwnerError } from "../src/duo/entity.js";
import { createDuo, DuoDefinitionError, loadDuoFromFile, parseDuoDefinition } from "../src/duo/loader.js";
import type { DuoDefinition } from "../src/duo/types.js";
import { useTempDir } from "./helpers/temp-dir.js";

function definition(overrides: Partial<DuoDefinition> = {}): DuoDefinition {
  return {
    id: "alex",
    owner: { kind: "person", id: "u1", name: "Alex" },
    persona: { voice: "plain, direct" },
    standingOrders: ["always cite sources"],
    refusals: ["never share salary data"],
    knowledge: { kind: "authored", documents: ["the leave policy is 14 days"] },
    ...overrides,
  };
}

describe("createDuo — resolving from a definition, not a global", () => {
  it("resolves persona, standing orders, and refusals straight from the definition", () => {
    const duo = createDuo(definition({ id: "priya", persona: { voice: "warm" } }));
    expect(duo.id).toBe("priya");
    expect(duo.persona.voice).toBe("warm");
    expect(duo.standingOrders).toEqual(["always cite sources"]);
    expect(duo.refusals).toEqual(["never share salary data"]);
  });

  it("loading a second duo with different fields never changes the first (no process-level state)", () => {
    const first = createDuo(definition({ id: "first", persona: { voice: "formal" } }));
    const second = createDuo(
      definition({
        id: "second",
        owner: { kind: "role", id: "r1", name: "Duty Desk" },
        persona: { voice: "casual" },
        knowledge: { kind: "derived", storePath: "data/second.db" },
      }),
    );
    expect(first.id).toBe("first");
    expect(first.persona.voice).toBe("formal");
    expect(first.owner.kind).toBe("person");
    expect(second.id).toBe("second");
    expect(second.persona.voice).toBe("casual");
    expect(second.owner.kind).toBe("role");
  });
});

describe("owner with no human backing", () => {
  it("a role-owned duo loads without error", () => {
    const duo = createDuo(definition({ owner: { kind: "role", id: "desk", name: "Clearance Desk" } }));
    expect(duo.owner).toEqual({ kind: "role", id: "desk", name: "Clearance Desk" });
  });

  it("an owner-less (synthetic) duo loads without error", () => {
    const duo = createDuo(definition({ owner: { kind: "none" } }));
    expect(duo.owner).toEqual({ kind: "none" });
  });

  it("requireHumanOwner succeeds and returns the owner when it is a person", () => {
    const duo = createDuo(definition({ owner: { kind: "person", id: "u1", name: "Alex" } }));
    expect(duo.requireHumanOwner("escalation")).toEqual({ kind: "person", id: "u1", name: "Alex" });
  });

  it("requireHumanOwner throws MissingHumanOwnerError naming the action and the owner's actual kind (role)", () => {
    const duo = createDuo(definition({ id: "desk-duo", owner: { kind: "role", id: "desk", name: "Duty Desk" } }));
    expect(() => duo.requireHumanOwner("escalation")).toThrow(MissingHumanOwnerError);
    expect(() => duo.requireHumanOwner("escalation")).toThrow(/escalation/);
    expect(() => duo.requireHumanOwner("escalation")).toThrow(/desk-duo/);
    expect(() => duo.requireHumanOwner("escalation")).toThrow(/"role"/);
  });

  it("requireHumanOwner throws MissingHumanOwnerError naming the action when the owner is absent", () => {
    const duo = createDuo(definition({ owner: { kind: "none" } }));
    expect(() => duo.requireHumanOwner("approval")).toThrow(/approval/);
    expect(() => duo.requireHumanOwner("approval")).toThrow(/"none"/);
  });
});

describe("knowledge sources — pluggable between derived and authored", () => {
  it("an authored duo retrieves from its documents through the KnowledgeSource interface", async () => {
    const duo = createDuo(
      definition({ knowledge: { kind: "authored", documents: ["leave policy: 14 days", "unrelated note"] } }),
    );
    expect(duo.knowledge.kind).toBe("authored");
    const results = await duo.knowledge.retrieve("leave policy");
    expect(results).toEqual([{ text: "leave policy: 14 days", source: "authored" }]);
  });

  it("an authored duo's retrieval never touches the derivation pipeline", async () => {
    const duo = createDuo(definition({ knowledge: { kind: "authored", documents: ["leave policy: 14 days"] } }));
    // No DerivedKnowledgeSource is ever constructed for this duo, so there is
    // nothing that could throw the "not implemented yet" error it raises.
    await expect(duo.knowledge.retrieve("something unrelated")).resolves.toEqual([]);
  });

  it("a derived duo resolves to the derived kind but fails loudly, naming the store, since the pipeline isn't built yet", async () => {
    const duo = createDuo(definition({ knowledge: { kind: "derived", storePath: "data/duo.db" } }));
    expect(duo.knowledge.kind).toBe("derived");
    await expect(duo.knowledge.retrieve("anything")).rejects.toThrow(/data\/duo\.db/);
  });
});

describe("parseDuoDefinition — validation", () => {
  it("throws DuoDefinitionError naming the field when owner.kind is invalid", () => {
    const raw = { ...definition(), owner: { kind: "robot" } };
    expect(() => parseDuoDefinition(raw)).toThrow(DuoDefinitionError);
    expect(() => parseDuoDefinition(raw)).toThrow(/definition\.owner\.kind/);
  });

  it("throws DuoDefinitionError naming the field when a person owner is missing a name", () => {
    const raw = { ...definition(), owner: { kind: "person", id: "u1" } };
    expect(() => parseDuoDefinition(raw)).toThrow(/definition\.owner\.name/);
  });

  it("throws DuoDefinitionError naming the field when knowledge.kind is invalid", () => {
    const raw = { ...definition(), knowledge: { kind: "vector-db" } };
    expect(() => parseDuoDefinition(raw)).toThrow(/definition\.knowledge\.kind/);
  });

  it("throws DuoDefinitionError naming the field when standingOrders is not an array of strings", () => {
    const raw = { ...definition(), standingOrders: "not an array" };
    expect(() => parseDuoDefinition(raw)).toThrow(/definition\.standingOrders/);
  });
});

describe("loadDuoFromFile", () => {
  const tempDir = useTempDir();

  it("reads and validates a definition from a JSON file", () => {
    const path = join(tempDir(), "duo.json");
    writeFileSync(path, JSON.stringify(definition({ id: "from-file" })));
    const duo = loadDuoFromFile(path);
    expect(duo.id).toBe("from-file");
  });
});
