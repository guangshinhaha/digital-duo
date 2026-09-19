import type { InferenceProvider } from "../../src/provider/types.js";

/**
 * Test-only InferenceProvider used solely to prove R6 (provider swap
 * requires no call-site change). Never imported from src/ — production
 * ships exactly one implementation (Ollama) per the settled decision.
 */
export const fakeProvider: InferenceProvider = {
  name: "fake",
  async complete(prompt: string): Promise<string> {
    return `fake-response:${prompt}`;
  },
};
