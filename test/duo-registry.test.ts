import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDir } from "./helpers/temp-dir.js";
import { listAvailableDuos } from "../src/duo/registry.js";

const tempDir = useTempDir();

describe("listAvailableDuos (client-tech-design.md G-c)", () => {
  it("lists only the personal duo when no shared-duo persona file exists", () => {
    const personaPath = join(tempDir(), "shared-duo", "persona.json");
    const duos = listAvailableDuos({ DUO_SHARED_PERSONA_PATH: personaPath });
    expect(duos).toEqual([{ kind: "personal" }]);
  });

  it("adds the shared duo once its persona file resolves to a human owner", () => {
    const personaPath = join(tempDir(), "shared-duo", "persona.json");
    mkdirSync(join(tempDir(), "shared-duo"), { recursive: true });
    writeFileSync(
      personaPath,
      JSON.stringify({
        id: "shared-duo",
        owner: { kind: "person", id: "alex", name: "Alex" },
        persona: { voice: "plain" },
        standingOrders: [],
        refusals: [],
        knowledge: { kind: "authored", documents: [] },
      }),
    );

    const duos = listAvailableDuos({ DUO_SHARED_PERSONA_PATH: personaPath });
    expect(duos).toEqual([{ kind: "personal" }, { kind: "shared", ownerId: "alex", ownerName: "Alex" }]);
  });

  it("omits the shared duo, without throwing, when its persona file is malformed", () => {
    const personaPath = join(tempDir(), "shared-duo", "persona.json");
    mkdirSync(join(tempDir(), "shared-duo"), { recursive: true });
    writeFileSync(personaPath, "not valid json");

    const duos = listAvailableDuos({ DUO_SHARED_PERSONA_PATH: personaPath });
    expect(duos).toEqual([{ kind: "personal" }]);
  });

  it("omits the shared duo when its owner isn't a human (loadSharedDuo's own SharedDuoOwnershipError)", () => {
    const personaPath = join(tempDir(), "shared-duo", "persona.json");
    mkdirSync(join(tempDir(), "shared-duo"), { recursive: true });
    writeFileSync(
      personaPath,
      JSON.stringify({
        id: "shared-duo",
        owner: { kind: "none" },
        persona: { voice: "plain" },
        standingOrders: [],
        refusals: [],
        knowledge: { kind: "authored", documents: [] },
      }),
    );

    const duos = listAvailableDuos({ DUO_SHARED_PERSONA_PATH: personaPath });
    expect(duos).toEqual([{ kind: "personal" }]);
  });
});
