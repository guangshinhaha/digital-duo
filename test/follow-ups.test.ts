import { describe, expect, it } from "vitest";
import { suggestFollowUps } from "../src/drafting/follow-ups.js";
import type { InferenceProvider } from "../src/provider/types.js";

function providerThatReturns(response: string): InferenceProvider {
  return { name: "fake", async complete() { return response; } };
}

function providerThatThrows(): InferenceProvider {
  return {
    name: "fake",
    async complete() {
      throw new Error("provider unreachable (fake)");
    },
  };
}

describe("duo#305 — suggestFollowUps", () => {
  it("returns none with no inference provider configured, never throwing", async () => {
    const result = await suggestFollowUps("What's my leave policy?", "Five days per quarter.", undefined);
    expect(result).toEqual({ followUps: [] });
  });

  it("returns none when the provider fails, never throwing", async () => {
    const result = await suggestFollowUps("What's my leave policy?", "Five days per quarter.", providerThatThrows());
    expect(result).toEqual({ followUps: [] });
  });

  it("returns none on an unparseable response", async () => {
    const result = await suggestFollowUps("q", "a", providerThatReturns("not json at all"));
    expect(result).toEqual({ followUps: [] });
  });

  it("returns the provider's follow-ups, trimmed", async () => {
    const provider = providerThatReturns(JSON.stringify({ followUps: ["  Does it roll over?  ", "Who approves it?"] }));
    const result = await suggestFollowUps("What's my leave policy?", "Five days per quarter.", provider);
    expect(result.followUps).toEqual(["Does it roll over?", "Who approves it?"]);
  });

  it("caps at three and de-duplicates", async () => {
    const provider = providerThatReturns(
      JSON.stringify({ followUps: ["A", "A", "B", "C", "D"] }),
    );
    const result = await suggestFollowUps("q", "a", provider);
    expect(result.followUps).toEqual(["A", "B", "C"]);
  });

  it("drops blank entries", async () => {
    const provider = providerThatReturns(JSON.stringify({ followUps: ["", "   ", "Real one"] }));
    const result = await suggestFollowUps("q", "a", provider);
    expect(result.followUps).toEqual(["Real one"]);
  });

  it("never calls the provider for a blank answer", async () => {
    let called = false;
    const provider: InferenceProvider = {
      name: "fake",
      async complete() {
        called = true;
        return "{}";
      },
    };
    const result = await suggestFollowUps("q", "   ", provider);
    expect(result).toEqual({ followUps: [] });
    expect(called).toBe(false);
  });
});
