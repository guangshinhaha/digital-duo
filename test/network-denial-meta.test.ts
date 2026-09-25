import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Meta-test for test/setup/network-denial.ts itself: the suite's zero-egress
 * guarantee (R9) rests on that wrapper being armed and registered, and
 * nothing else asserted either fact — a silently unregistered setup file, or
 * a deny branch that stopped firing, would leave the guarantee unenforced
 * with every other test still green.
 */
describe("network-denial setup — the suite's zero-egress guarantee is actually armed (KTD10/R9)", () => {
  it("the deny branch fires: an unstubbed non-loopback fetch throws the network-denial error synchronously", () => {
    // .invalid is a reserved TLD that can never resolve — but the denial
    // throws before any DNS lookup, so this makes no network attempt. The
    // wrapper is a plain function: it throws rather than rejecting.
    expect(() => fetch("https://egress-forbidden.invalid/anything")).toThrow(/\[network-denial\]/);
    expect(() => fetch("https://egress-forbidden.invalid/anything")).toThrow(/egress-forbidden\.invalid/);
  });

  it("loopback passes through to the real fetch, not the denial wrapper", async () => {
    // Port 1 on loopback: nothing listens, so the *real* fetch fails with a
    // connection error — proving the request escaped the wrapper. A denial
    // misfire here would carry the [network-denial] message instead.
    let error: Error | undefined;
    try {
      await fetch("http://127.0.0.1:1/");
    } catch (caught) {
      error = caught as Error;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).not.toMatch(/network-denial/);
  });

  it("the setup file is registered in vitest.config.ts setupFiles — an unregistered denial arms nothing", () => {
    const config = readFileSync(fileURLToPath(new URL("../vitest.config.ts", import.meta.url)), "utf8");
    expect(config).toMatch(/setupFiles/);
    expect(config).toContain("test/setup/network-denial.ts");
  });
});
