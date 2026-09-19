import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { ProviderConfigError } from "../src/provider/types.js";

describe("loadConfig", () => {
  it("applies documented defaults when nothing is set", () => {
    const config = loadConfig({});
    expect(config.storePath).toBe("data/duo.db");
    expect(config.duoDir).toBe("duo");
    expect(config.ollama.host).toBe("http://localhost:11434");
    expect(config.providerName).toBeUndefined();
    expect(config.ollama.model).toBeUndefined();
    expect(config.ollama.embeddingModel).toBe("nomic-embed-text");
  });

  it("uses exactly the given values with no defaults applied over them", () => {
    const config = loadConfig({
      DUO_STORE_PATH: "/tmp/x.db",
      DUO_DIR: "/tmp/duo-out",
      DUO_PROVIDER: "ollama",
      DUO_OLLAMA_HOST: "http://h:1",
      DUO_OLLAMA_MODEL: "llama3",
      DUO_OLLAMA_EMBEDDING_MODEL: "custom-embed",
    });
    expect(config).toEqual({
      providerName: "ollama",
      storePath: "/tmp/x.db",
      duoDir: "/tmp/duo-out",
      ollama: { host: "http://h:1", model: "llama3", embeddingModel: "custom-embed" },
    });
  });

  it("never throws regardless of input", () => {
    expect(() => loadConfig({})).not.toThrow();
    expect(() => loadConfig({ DUO_PROVIDER: "not-a-real-provider" })).not.toThrow();
  });
});

describe("ProviderConfigError", () => {
  it("names the missing key in its message", () => {
    const error = new ProviderConfigError("DUO_PROVIDER");
    expect(error.message).toContain("DUO_PROVIDER");
    expect(error.missingKey).toBe("DUO_PROVIDER");
  });

  it("includes optional detail in its message", () => {
    const error = new ProviderConfigError("DUO_PROVIDER", "unknown-provider");
    expect(error.message).toContain("DUO_PROVIDER");
    expect(error.message).toContain("unknown-provider");
  });
});
