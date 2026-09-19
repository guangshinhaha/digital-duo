import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { defaultRegistry, resolveProvider } from "../src/provider/registry.js";
import { ProviderConfigError } from "../src/provider/types.js";
import { fakeProvider } from "./fixtures/fake-provider.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveProvider", () => {
  it("throws ProviderConfigError naming DUO_PROVIDER when unset", () => {
    const config = loadConfig({});
    try {
      resolveProvider(config);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderConfigError);
      expect((error as ProviderConfigError).message).toContain("DUO_PROVIDER");
    }
  });

  it("throws ProviderConfigError naming the invalid value, never falling back to ollama", () => {
    const config = loadConfig({ DUO_PROVIDER: "not-a-real-provider" });
    try {
      resolveProvider(config);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderConfigError);
      expect((error as ProviderConfigError).message).toContain("not-a-real-provider");
    }
  });

  it("throws ProviderConfigError naming the value even when it collides with Object.prototype", () => {
    // Guards against a plain bracket lookup silently resolving
    // Object.prototype members (e.g. registry["constructor"]) instead of
    // treating them as unregistered provider names.
    const config = loadConfig({ DUO_PROVIDER: "constructor" });
    try {
      resolveProvider(config);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderConfigError);
      expect((error as ProviderConfigError).message).toContain("constructor");
    }
  });

  it("throws ProviderConfigError naming DUO_OLLAMA_MODEL when ollama is selected but unset", () => {
    const config = loadConfig({ DUO_PROVIDER: "ollama" });
    try {
      resolveProvider(config);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderConfigError);
      expect((error as ProviderConfigError).message).toContain("DUO_OLLAMA_MODEL");
    }
  });

  it("returns an ollama provider when fully configured", () => {
    const config = loadConfig({ DUO_PROVIDER: "ollama", DUO_OLLAMA_MODEL: "llama3" });
    const provider = resolveProvider(config);
    expect(provider.name).toBe("ollama");
  });

  it("Covers R6: swaps to a fake provider via a custom registry with no change to resolveProvider's call signature", () => {
    const config = loadConfig({ DUO_PROVIDER: "fake" });
    const registry = { ...defaultRegistry, fake: () => fakeProvider };
    const provider = resolveProvider(config, registry);
    expect(provider).toBe(fakeProvider);
    expect(provider.name).toBe("fake");
  });
});

describe("OllamaProvider.complete", () => {
  it("returns the completion text on a successful response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toBe("http://h:1/api/generate");
        const body = JSON.parse(init.body as string);
        expect(body).toEqual({ model: "llama3", prompt: "hi", stream: false });
        return new Response(JSON.stringify({ response: "hello" }), { status: 200 });
      }),
    );
    const config = loadConfig({
      DUO_PROVIDER: "ollama",
      DUO_OLLAMA_MODEL: "llama3",
      DUO_OLLAMA_HOST: "http://h:1",
    });
    const provider = resolveProvider(config);
    await expect(provider.complete("hi")).resolves.toBe("hello");
  });

  it("throws naming Ollama as unreachable when fetch rejects (connection refused)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const config = loadConfig({
      DUO_PROVIDER: "ollama",
      DUO_OLLAMA_MODEL: "llama3",
      DUO_OLLAMA_HOST: "http://h:1",
    });
    const provider = resolveProvider(config);
    await expect(provider.complete("hi")).rejects.toThrow(/unreachable/i);
    await expect(provider.complete("hi")).rejects.toThrow(/http:\/\/h:1/);
  });

  it("throws naming the model and response status on a non-2xx response, not 'unreachable'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("model 'llama3' not found, try pulling it first", { status: 404 })),
    );
    const config = loadConfig({
      DUO_PROVIDER: "ollama",
      DUO_OLLAMA_MODEL: "llama3",
      DUO_OLLAMA_HOST: "http://h:1",
    });
    const provider = resolveProvider(config);
    await expect(provider.complete("hi")).rejects.toThrow(/llama3/);
    await expect(provider.complete("hi")).rejects.toThrow(/404/);
    await expect(provider.complete("hi")).rejects.not.toThrow(/unreachable/i);
  });

  it("throws a ProviderError naming the model, not a raw SyntaxError, when a 2xx response body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json", { status: 200, headers: { "Content-Type": "text/plain" } })),
    );
    const config = loadConfig({
      DUO_PROVIDER: "ollama",
      DUO_OLLAMA_MODEL: "llama3",
      DUO_OLLAMA_HOST: "http://h:1",
    });
    const provider = resolveProvider(config);
    await expect(provider.complete("hi")).rejects.toThrow(/non-JSON/i);
    await expect(provider.complete("hi")).rejects.toThrow(/llama3/);
    await expect(provider.complete("hi")).rejects.not.toThrow(SyntaxError);
  });

  it("throws a ProviderError naming an unexpected shape when a 2xx response is valid JSON but null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("null", { status: 200 })),
    );
    const config = loadConfig({
      DUO_PROVIDER: "ollama",
      DUO_OLLAMA_MODEL: "llama3",
      DUO_OLLAMA_HOST: "http://h:1",
    });
    const provider = resolveProvider(config);
    await expect(provider.complete("hi")).rejects.toThrow(/unexpected response shape/i);
  });
});
