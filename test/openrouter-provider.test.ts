import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { resolveProvider } from "../src/provider/registry.js";
import { ProviderConfigError, ProviderError } from "../src/provider/types.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function configured(extra: Record<string, string> = {}) {
  return loadConfig({ DUO_PROVIDER: "openrouter", DUO_OPENROUTER_API_KEY: "sk-or-test", ...extra });
}

describe("openrouter provider", () => {
  it("throws ProviderConfigError naming DUO_OPENROUTER_API_KEY when the key is unset", () => {
    expect(() => resolveProvider(loadConfig({ DUO_PROVIDER: "openrouter" }))).toThrow(/DUO_OPENROUTER_API_KEY/);
  });

  it("refuses a non-https base URL rather than sending the key in plaintext", () => {
    expect(() => resolveProvider(configured({ DUO_OPENROUTER_BASE_URL: "http://example.com" }))).toThrow(
      ProviderConfigError,
    );
  });

  it("posts the prompt as one user message to /chat/completions with the default auto model", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "drafted" } }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = resolveProvider(configured());
    expect(provider.name).toBe("openrouter");
    await expect(provider.complete("hello")).resolves.toBe("drafted");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-or-test");
    expect(JSON.parse(init.body as string)).toEqual({
      model: "openrouter/auto",
      messages: [{ role: "user", content: "hello" }],
    });
  });

  it("honours DUO_OPENROUTER_MODEL", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "x" } }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await resolveProvider(configured({ DUO_OPENROUTER_MODEL: "anthropic/claude-sonnet-5" })).complete("q");
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).model).toBe("anthropic/claude-sonnet-5");
  });

  it("reports a non-2xx response as ProviderError with its status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no credits", { status: 402 })));
    await expect(resolveProvider(configured()).complete("q")).rejects.toThrow(/402 no credits/);
  });

  it("reports an unexpected response shape as ProviderError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [] }), { status: 200 })));
    await expect(resolveProvider(configured()).complete("q")).rejects.toBeInstanceOf(ProviderError);
  });

  it("reports a network failure as ProviderError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNRESET");
      }),
    );
    await expect(resolveProvider(configured()).complete("q")).rejects.toThrow(/unreachable.*ECONNRESET/);
  });
});
