import { describe, expect, it } from "vitest";
import { CATCH_UP_MAX_MESSAGES, CatchUpUnavailableError, summarizeCatchUp, type CatchUpMessageInput } from "../src/drafting/catch-up.js";
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

function messages(n: number): CatchUpMessageInput[] {
  return Array.from({ length: n }, (_, i) => ({ from: `person-${i}`, text: `message ${i}` }));
}

describe("duo#280/#281 — summarizeCatchUp", () => {
  it("throws CatchUpUnavailableError with no inference provider configured", async () => {
    await expect(summarizeCatchUp(messages(3), undefined)).rejects.toBeInstanceOf(CatchUpUnavailableError);
  });

  it("returns an empty, unavailable-free result for no messages at all, without calling the provider", async () => {
    let called = false;
    const provider: InferenceProvider = {
      name: "fake",
      async complete() {
        called = true;
        return "{}";
      },
    };
    const result = await summarizeCatchUp([], provider);
    expect(result).toEqual({ bullets: [], oneLine: "" });
    expect(called).toBe(false);
  });

  it("returns the provider's bullets and one-line gist, indices unchanged when under the window cap", async () => {
    const provider = providerThatReturns(
      JSON.stringify({ bullets: [{ index: 1, text: "Decided to ship Friday." }], oneLine: "Ship date moved to Friday." }),
    );
    const result = await summarizeCatchUp(
      [
        { from: "Alice", text: "how's the release going" },
        { from: "Bob", text: "let's ship Friday" },
      ],
      provider,
    );
    expect(result).toEqual({ bullets: [{ index: 1, text: "Decided to ship Friday." }], oneLine: "Ship date moved to Friday." });
  });

  it("never fabricates a bullet: drops an index that doesn't name a real message in the window", async () => {
    const provider = providerThatReturns(JSON.stringify({ bullets: [{ index: 99, text: "made up" }], oneLine: "Nothing much happened." }));
    const result = await summarizeCatchUp(messages(3), provider);
    expect(result.bullets).toEqual([]);
  });

  it("drops a bullet with blank text even when its index is real", async () => {
    const provider = providerThatReturns(JSON.stringify({ bullets: [{ index: 0, text: "   " }], oneLine: "Nothing much happened." }));
    const result = await summarizeCatchUp(messages(3), provider);
    expect(result.bullets).toEqual([]);
  });

  it("throws CatchUpUnavailableError on an unparseable model response, never a guessed summary", async () => {
    const provider = providerThatReturns("sure, here's a summary: things happened");
    await expect(summarizeCatchUp(messages(3), provider)).rejects.toBeInstanceOf(CatchUpUnavailableError);
  });

  it("throws CatchUpUnavailableError when oneLine is blank, even with valid bullets", async () => {
    const provider = providerThatReturns(JSON.stringify({ bullets: [], oneLine: "   " }));
    await expect(summarizeCatchUp(messages(3), provider)).rejects.toBeInstanceOf(CatchUpUnavailableError);
  });

  it("throws CatchUpUnavailableError when the provider itself fails", async () => {
    await expect(summarizeCatchUp(messages(3), providerThatThrows())).rejects.toBeInstanceOf(CatchUpUnavailableError);
  });

  it("windows down to the most recent CATCH_UP_MAX_MESSAGES and re-bases returned indices back onto the full input", async () => {
    const all = messages(CATCH_UP_MAX_MESSAGES + 10);
    let seenPrompt = "";
    const provider: InferenceProvider = {
      name: "fake",
      async complete(prompt) {
        seenPrompt = prompt;
        // Index 0 in the *windowed* prompt is really the 11th original message (offset 10).
        return JSON.stringify({ bullets: [{ index: 0, text: "oldest message still in the window" }], oneLine: "Caught up." });
      },
    };
    const result = await summarizeCatchUp(all, provider);
    expect(seenPrompt).not.toContain("message 0\n");
    expect(seenPrompt).toContain("message 10");
    expect(result.bullets).toEqual([{ index: 10, text: "oldest message still in the window" }]);
  });
});
