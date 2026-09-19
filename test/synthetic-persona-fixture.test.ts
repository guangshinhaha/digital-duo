import { describe, expect, it } from "vitest";
import { createSyntheticPersonaFixture, SYNTHETIC_PERSONA_FIXTURE_ID } from "./fixtures/synthetic-persona.js";
import { createDuo } from "../src/duo/loader.js";
import {
  assertNotSyntheticFixture,
  isSyntheticFixture,
  SyntheticFixtureNotAllowedError,
} from "../src/drafting/fixture-guard.js";

describe("createSyntheticPersonaFixture — runs with no corpus (AC1)", () => {
  it("has a fully authored knowledge source needing no encrypted store", () => {
    const duo = createSyntheticPersonaFixture();
    expect(duo.knowledge.kind).toBe("authored");
    expect(duo.owner).toEqual({ kind: "none" });
    expect(duo.standingOrders.length).toBeGreaterThan(0);
  });

  it("retrieval, the pipeline's first real stage, returns a result for a matching question", async () => {
    const duo = createSyntheticPersonaFixture();
    const results = await duo.knowledge.retrieve("office hours");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].text).toContain("9am to 5pm");
  });

  it("returns nothing for a question the fixture has no standing order for", async () => {
    const duo = createSyntheticPersonaFixture();
    const results = await duo.knowledge.retrieve("what is the meaning of life");
    expect(results).toEqual([]);
  });
});

describe("createSyntheticPersonaFixture — deterministic across runs (AC2)", () => {
  it("returns the same standing orders for the same question on repeated calls", async () => {
    const first = await createSyntheticPersonaFixture().knowledge.retrieve("on-call rotation");
    const second = await createSyntheticPersonaFixture().knowledge.retrieve("on-call rotation");
    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(0);
  });

  it("constructs an identical duo definition every time (same id, orders, refusals)", () => {
    const a = createSyntheticPersonaFixture();
    const b = createSyntheticPersonaFixture();
    expect(a.id).toBe(b.id);
    expect(a.standingOrders).toEqual(b.standingOrders);
    expect(a.refusals).toEqual(b.refusals);
  });
});

describe("the fixture cannot be mistaken for a real duo (AC3)", () => {
  it("carries a visible fixture marker in its id and persona voice", () => {
    const duo = createSyntheticPersonaFixture();
    expect(duo.id).toBe(SYNTHETIC_PERSONA_FIXTURE_ID);
    expect(duo.id).toContain("fixture");
    expect(duo.persona.voice).toContain("SYNTHETIC FIXTURE");
  });

  it("isSyntheticFixture identifies it, and not an ordinary duo", () => {
    const fixture = createSyntheticPersonaFixture();
    const real = createDuo({
      id: "real-duo",
      owner: { kind: "person", id: "u1", name: "Alice" },
      persona: { voice: "plain" },
      standingOrders: [],
      refusals: [],
      knowledge: { kind: "authored", documents: [] },
    });
    expect(isSyntheticFixture(fixture)).toBe(true);
    expect(isSyntheticFixture(real)).toBe(false);
  });

  it("assertNotSyntheticFixture refuses the fixture on a Slack surface, naming the duo and surface", () => {
    const fixture = createSyntheticPersonaFixture();
    expect(() => assertNotSyntheticFixture(fixture, "slack")).toThrow(SyntheticFixtureNotAllowedError);
    expect(() => assertNotSyntheticFixture(fixture, "slack")).toThrow(/fixture:synthetic-persona/);
    expect(() => assertNotSyntheticFixture(fixture, "slack")).toThrow(/"slack"/);
  });

  it("assertNotSyntheticFixture passes through a real duo on the same surface", () => {
    const real = createDuo({
      id: "real-duo",
      owner: { kind: "person", id: "u1", name: "Alice" },
      persona: { voice: "plain" },
      standingOrders: [],
      refusals: [],
      knowledge: { kind: "authored", documents: [] },
    });
    expect(() => assertNotSyntheticFixture(real, "slack")).not.toThrow();
  });
});
