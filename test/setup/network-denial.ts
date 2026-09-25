/**
 * Suite-wide network denial (KTD10 / Verification Contract): every unstubbed
 * non-loopback `fetch` in any test throws. This repo has no CI, so the suite
 * itself is the only place the Jev spike's zero-egress guarantee (R9) can be
 * enforced — with this file active, the suite cannot leave the machine even
 * when the owner's shell still exports `DUO_JEV_API_KEY`.
 *
 * Loopback (`127.0.0.1`, `::1`, `localhost`) stays reachable: loopback cannot
 * leave the machine, and `test/serve-cli.test.ts` exercises a real loopback
 * server through an unstubbed fetch. Everything else is denied by default.
 *
 * A test that needs to script fetch responses overrides this wrapper with the
 * repo's usual `vi.stubGlobal("fetch", vi.fn(...))` pattern (see
 * test/provider.test.ts) — an explicit stub always wins over the denial.
 */
const realFetch = globalThis.fetch.bind(globalThis);

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "[::1]"]);

function hostnameOf(input: RequestInfo | URL): string {
  const url = input instanceof Request ? input.url : String(input);
  return new URL(url).hostname;
}

globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  let hostname: string;
  try {
    hostname = hostnameOf(input);
  } catch {
    throw new Error(
      `[network-denial] unstubbed fetch with an unparseable target (${String(input)}) — stub fetch with vi.stubGlobal if this test means to make it`,
    );
  }
  if (LOOPBACK_HOSTS.has(hostname)) {
    return realFetch(input, init);
  }
  throw new Error(
    `[network-denial] unstubbed non-loopback fetch blocked: ${hostname} — the suite must not egress; stub fetch with vi.stubGlobal if this is intentional in a test`,
  );
}) as typeof fetch;
