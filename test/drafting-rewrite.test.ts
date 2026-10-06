import { describe, expect, it } from "vitest";
import { REWRITE_INSTRUCTIONS, RewriteUnavailableError, rewriteOwnerText } from "../src/drafting/rewrite.js";
import type { InferenceProvider } from "../src/provider/types.js";

function providerThatReturns(response: string): InferenceProvider {
  return { name: "fake", async complete() { return response; } };
}

function providerThatEchoesPrompt(): InferenceProvider {
  let lastPrompt = "";
  const provider: InferenceProvider & { lastPrompt(): string } = {
    name: "fake",
    async complete(prompt: string) {
      lastPrompt = prompt;
      return "ok";
    },
    lastPrompt: () => lastPrompt,
  };
  return provider;
}

describe("#263 — rewriteOwnerText", () => {
  it("throws RewriteUnavailableError with no inference provider, rather than returning the input unchanged", async () => {
    await expect(rewriteOwnerText("hey can u send the doc", "proofread", "plain, direct", undefined)).rejects.toBeInstanceOf(RewriteUnavailableError);
  });

  it("returns the provider's completion, trimmed", async () => {
    const result = await rewriteOwnerText("hey can u send the doc", "proofread", "plain, direct", providerThatReturns("  Could you send the document?  "));
    expect(result).toEqual({ text: "Could you send the document?" });
  });

  it("produces a different text than the input (a real rewrite, not an echo)", async () => {
    const original = "hey can u send me the doc when u get a sec thx";
    const result = await rewriteOwnerText(original, "shorter", "plain, direct", providerThatReturns("Send me the doc when you can."));
    expect(result.text).not.toBe(original);
  });

  it("every instruction produces its own distinct prompt, shaped around the owner's voice profile", async () => {
    const provider = providerThatEchoesPrompt();
    for (const instruction of REWRITE_INSTRUCTIONS) {
      await rewriteOwnerText("some text", instruction, "VOICE-MARKER", provider);
      expect(provider.lastPrompt()).toContain("some text");
      expect(provider.lastPrompt()).toContain("VOICE-MARKER");
    }
  });

  it("REWRITE_INSTRUCTIONS is exactly rewrite/shorter/warmer/proofread, the issue's own menu", () => {
    expect(REWRITE_INSTRUCTIONS).toEqual(["rewrite", "shorter", "warmer", "proofread"]);
  });
});
