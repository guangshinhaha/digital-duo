import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createOllamaEmbeddingProvider } from "../src/provider/ollama-embedding-provider.js";
import { ProviderConfigError, ProviderError } from "../src/provider/types.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createOllamaEmbeddingProvider", () => {
  it("resolves the model from config (default nomic-embed-text) with no explicit configuration needed", () => {
    const config = loadConfig({});
    const provider = createOllamaEmbeddingProvider(config);
    expect(provider.name).toBe("ollama");
    expect(provider.model).toBe("nomic-embed-text");
  });

  it("uses an explicitly configured embedding model", () => {
    const config = loadConfig({ DUO_OLLAMA_EMBEDDING_MODEL: "custom-embed" });
    expect(createOllamaEmbeddingProvider(config).model).toBe("custom-embed");
  });
});

describe("OllamaEmbeddingProvider.embed", () => {
  it("returns the embedding vector on a successful response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toBe("http://h:1/api/embeddings");
        const body = JSON.parse(init.body as string);
        expect(body).toEqual({ model: "nomic-embed-text", prompt: "hi" });
        return new Response(JSON.stringify({ embedding: [0.1, 0.2, 0.3] }), { status: 200 });
      }),
    );
    const provider = createOllamaEmbeddingProvider(loadConfig({ DUO_OLLAMA_HOST: "http://h:1" }));
    await expect(provider.embed("hi")).resolves.toEqual([0.1, 0.2, 0.3]);
  });

  it("throws naming Ollama as unreachable when fetch rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const provider = createOllamaEmbeddingProvider(loadConfig({ DUO_OLLAMA_HOST: "http://h:1" }));
    await expect(provider.embed("hi")).rejects.toThrow(ProviderError);
    await expect(provider.embed("hi")).rejects.toThrow(/unreachable/i);
  });

  it("throws naming the model and response status on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("model not found", { status: 404 })),
    );
    const provider = createOllamaEmbeddingProvider(loadConfig({ DUO_OLLAMA_HOST: "http://h:1" }));
    await expect(provider.embed("hi")).rejects.toThrow(/nomic-embed-text/);
    await expect(provider.embed("hi")).rejects.toThrow(/404/);
  });

  it("throws a ProviderError, not a raw SyntaxError, when a 2xx response body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json", { status: 200 })),
    );
    const provider = createOllamaEmbeddingProvider(loadConfig({ DUO_OLLAMA_HOST: "http://h:1" }));
    await expect(provider.embed("hi")).rejects.toThrow(ProviderError);
    await expect(provider.embed("hi")).rejects.not.toThrow(SyntaxError);
  });

  it("throws a ProviderError naming an unexpected shape when the response has no embedding array", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ nope: true }), { status: 200 })),
    );
    const provider = createOllamaEmbeddingProvider(loadConfig({ DUO_OLLAMA_HOST: "http://h:1" }));
    await expect(provider.embed("hi")).rejects.toThrow(/unexpected embedding response shape/i);
  });
});

describe("createOllamaEmbeddingProvider — defensive config check", () => {
  it("throws ProviderConfigError if the model were ever empty (config.ts always defaults it, so this documents the guard)", () => {
    const config = loadConfig({});
    config.ollama.embeddingModel = "";
    expect(() => createOllamaEmbeddingProvider(config)).toThrow(ProviderConfigError);
  });
});
