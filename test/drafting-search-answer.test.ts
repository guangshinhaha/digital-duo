import { describe, expect, it } from "vitest";
import { answerFromSearchHits, type SearchAnswerHit } from "../src/drafting/search-answer.js";
import type { InferenceProvider } from "../src/provider/types.js";

function providerThatReturns(response: string): InferenceProvider {
  return { name: "fake", async complete() { return response; } };
}

function providerThatEchoesPrompt(): InferenceProvider & { lastPrompt(): string } {
  let lastPrompt = "";
  return {
    name: "fake",
    async complete(prompt: string) {
      lastPrompt = prompt;
      return JSON.stringify({ answered: false });
    },
    lastPrompt: () => lastPrompt,
  };
}

const HITS: readonly SearchAnswerHit[] = [
  { id: "$a", text: "Refunds within 30 days are automatic.", from: "Bose" },
  { id: "$b", text: "After that it routes to Finance.", from: "Aisha" },
];

describe("duo#300 — answerFromSearchHits", () => {
  it("is no_answer with no inference provider configured, rather than guessing from the hits", async () => {
    expect(await answerFromSearchHits("what's the refund policy?", HITS, undefined)).toEqual({ kind: "no_answer" });
  });

  it("is no_answer with no hits, even with a provider configured", async () => {
    expect(await answerFromSearchHits("what's the refund policy?", [], providerThatReturns(JSON.stringify({ answered: true, text: "x", citedIndices: [0] })))).toEqual({
      kind: "no_answer",
    });
  });

  it("returns the provider's answer with its cited hits mapped back to their ids", async () => {
    const provider = providerThatReturns(JSON.stringify({ answered: true, text: "Refunds are automatic within 30 days.", citedIndices: [0] }));
    const result = await answerFromSearchHits("what's the refund policy?", HITS, provider);
    expect(result).toEqual({ kind: "answered", text: "Refunds are automatic within 30 days.", citedIds: ["$a"] });
  });

  it("can cite more than one hit, de-duplicated", async () => {
    const provider = providerThatReturns(JSON.stringify({ answered: true, text: "Refunds: 30 days, then Finance.", citedIndices: [0, 1, 1] }));
    const result = await answerFromSearchHits("refund policy?", HITS, provider);
    expect(result).toEqual({ kind: "answered", text: "Refunds: 30 days, then Finance.", citedIds: ["$a", "$b"] });
  });

  it("is no_answer when the model itself says the messages don't answer the question", async () => {
    const provider = providerThatReturns(JSON.stringify({ answered: false }));
    expect(await answerFromSearchHits("what's the weather?", HITS, provider)).toEqual({ kind: "no_answer" });
  });

  it("is no_answer when the model answers but cites nothing — uncited reads as guessed, not sourced", async () => {
    const provider = providerThatReturns(JSON.stringify({ answered: true, text: "Sure, 30 days.", citedIndices: [] }));
    expect(await answerFromSearchHits("refund policy?", HITS, provider)).toEqual({ kind: "no_answer" });
  });

  it("is no_answer when a cited index is out of range, rather than crashing or citing the wrong message", async () => {
    const provider = providerThatReturns(JSON.stringify({ answered: true, text: "Sure, 30 days.", citedIndices: [99] }));
    expect(await answerFromSearchHits("refund policy?", HITS, provider)).toEqual({ kind: "no_answer" });
  });

  it("is no_answer on a malformed completion (not JSON, or missing fields) — never a thrown error", async () => {
    await expect(answerFromSearchHits("q", HITS, providerThatReturns("not json at all"))).resolves.toEqual({ kind: "no_answer" });
    await expect(answerFromSearchHits("q", HITS, providerThatReturns(JSON.stringify({ answered: true })))).resolves.toEqual({ kind: "no_answer" });
  });

  it("is no_answer when the provider itself throws", async () => {
    const throwing: InferenceProvider = { name: "fake", async complete() { throw new Error("boom"); } };
    await expect(answerFromSearchHits("q", HITS, throwing)).resolves.toEqual({ kind: "no_answer" });
  });

  it("never sends more than the given hits — only what the caller's own search already turned up rides the prompt", async () => {
    const provider = providerThatEchoesPrompt();
    await answerFromSearchHits("refund policy?", HITS, provider);
    expect(provider.lastPrompt()).toContain("Refunds within 30 days are automatic.");
    expect(provider.lastPrompt()).toContain("After that it routes to Finance.");
    expect(provider.lastPrompt()).toContain("refund policy?");
  });
});
