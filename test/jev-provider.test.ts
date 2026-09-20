import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { defaultRegistry } from "../src/provider/registry.js";
import { ProviderConfigError, ProviderError } from "../src/provider/types.js";
import { createJevProvider } from "../src/provider/jev-provider.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetchWith(body: string, status = 200) {
  return vi.fn(async () => new Response(body, { status }));
}

describe("createJevProvider — factory (KTD10: config errors before any request)", () => {
  it("throws ProviderConfigError naming DUO_JEV_API_KEY when the key is unset, before any request", () => {
    const config = loadConfig({ DUO_JEV_GATEWAY_URL: "https://api.typesafe.ai" });
    expect(() => createJevProvider(config)).toThrow(ProviderConfigError);
    expect(() => createJevProvider(config)).toThrow(/DUO_JEV_API_KEY/);
  });

  it("throws ProviderConfigError naming DUO_JEV_GATEWAY_URL for a non-https gateway", () => {
    const config = loadConfig({
      DUO_JEV_API_KEY: "sk-test-123",
      DUO_JEV_GATEWAY_URL: "http://api.typesafe.ai",
    });
    expect(() => createJevProvider(config)).toThrow(ProviderConfigError);
    expect(() => createJevProvider(config)).toThrow(/DUO_JEV_GATEWAY_URL/);
    expect(() => createJevProvider(config)).toThrow(/https/i);
  });
});

describe("JevProvider.decide — happy paths and the egress audit", () => {
  it("answers a binary (noul) question and surfaces model + usage; the serialized request body deep-equals the expected fixture-derived payload", async () => {
    const fetchMock = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe("https://api.typesafe.ai/v1/systemone");
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe("Bearer sk-test-123");
        // Exact deep equality, not containment: any extra field or
        // interpolated value fails here (KTD10's request-body audit).
        expect(JSON.parse(init?.body as string)).toEqual({
          state: { mention: "when is the standup?" },
          model: "jev-latest",
          questions: {
            q0: { type: "noul", instructions: "Is this a genuine question the owner would answer?" },
          },
        });
        return new Response(
          JSON.stringify({
            model: "jev-1.13.0",
            answers: { q0: { noul: 0.83 } },
            usage: { input_tokens: 37, output_tokens: 0 },
          }),
          { status: 200 },
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const config = loadConfig({ DUO_JEV_API_KEY: "sk-test-123" });
    const provider = createJevProvider(config);
    const result = await provider.decide({ mention: "when is the standup?" }, [
      { kind: "binary", instructions: "Is this a genuine question the owner would answer?" },
    ]);
    expect(result.answers).toEqual([{ kind: "binary", probability: 0.83 }]);
    expect(result.model).toBe("jev-1.13.0");
    expect(result.usage).toEqual({ inputTokens: 37, outputTokens: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("answers a choice question with pick, probabilities, and confidence (AE3's ranking input)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              model: "jev-1.13.0",
              answers: {
                q0: { choice: "open-settings", probabilities: { "open-settings": 0.7, "search-again": 0.3 }, confidence: 0.9 },
              },
              usage: { input_tokens: 51, output_tokens: 0 },
            }),
            { status: 200 },
          ),
      ),
    );
    const config = loadConfig({ DUO_JEV_API_KEY: "sk-test-123" });
    const provider = createJevProvider(config);
    const result = await provider.decide({ page: "settings menu" }, [
      {
        kind: "choice",
        instructions: "Which action moves toward the goal?",
        criteria: { "open-settings": "Opens the settings page", "search-again": "Repeats the search" },
      },
    ]);
    expect(result.answers).toEqual([
      {
        kind: "choice",
        pick: "open-settings",
        probabilities: { "open-settings": 0.7, "search-again": 0.3 },
        confidence: 0.9,
      },
    ]);
  });
});

describe("JevProvider.decide — failure paths (KTD2 taxonomy)", () => {
  it("throws ProviderError with 'unreachable' wording when fetch rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const config = loadConfig({ DUO_JEV_API_KEY: "sk-test-123" });
    const provider = createJevProvider(config);
    await expect(
      provider.decide({ mention: "hi" }, [{ kind: "binary", instructions: "q?" }]),
    ).rejects.toThrow(/unreachable/i);
  });

  it("carries status and a truncated, key-scrubbed body on non-2xx — the key value never reaches the message", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetchWith(JSON.stringify({ error: "invalid key sk-test-123 (Authorization: Bearer sk-test-123)" }), 401),
    );
    const config = loadConfig({ DUO_JEV_API_KEY: "sk-test-123" });
    const provider = createJevProvider(config);
    const failure = provider.decide({ mention: "hi" }, [{ kind: "binary", instructions: "q?" }]);
    await expect(failure).rejects.toThrow(ProviderError);
    await expect(failure).rejects.toThrow(/401/);
    await expect(failure).rejects.toThrow(/invalid key/);
    await expect(failure).rejects.not.toThrow(/sk-test-123/);
  });

  it("truncates a very long non-2xx body before it enters the message", async () => {
    const longBody = "x".repeat(5_000) + " sk-test-123";
    vi.stubGlobal("fetch", stubFetchWith(longBody, 429));
    const config = loadConfig({ DUO_JEV_API_KEY: "sk-test-123" });
    const provider = createJevProvider(config);
    let message = "";
    await provider
      .decide({ mention: "hi" }, [{ kind: "binary", instructions: "q?" }])
      .catch((error: Error) => {
        message = error.message;
      });
    expect(message).toMatch(/429/);
    expect(message.length).toBeLessThan(1_000);
    expect(message).not.toContain("sk-test-123");
  });

  it("throws ProviderError with non-JSON wording when a 2xx body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json", { status: 200, headers: { "Content-Type": "text/plain" } })),
    );
    const config = loadConfig({ DUO_JEV_API_KEY: "sk-test-123" });
    const provider = createJevProvider(config);
    await expect(
      provider.decide({ mention: "hi" }, [{ kind: "binary", instructions: "q?" }]),
    ).rejects.toThrow(/non-JSON/i);
  });

  it("throws ProviderError with unexpected-shape wording when a 2xx response is missing answers", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetchWith(JSON.stringify({ model: "jev-1.13.0", usage: { input_tokens: 1, output_tokens: 0 } })),
    );
    const config = loadConfig({ DUO_JEV_API_KEY: "sk-test-123" });
    const provider = createJevProvider(config);
    await expect(
      provider.decide({ mention: "hi" }, [{ kind: "binary", instructions: "q?" }]),
    ).rejects.toThrow(/unexpected response shape/i);
  });
});

describe("registry guard — Jev never enters the production registry (KTD3/G1)", () => {
  it("defaultRegistry keys remain exactly ['ollama']", () => {
    expect(Object.keys(defaultRegistry)).toEqual(["ollama"]);
  });
});
