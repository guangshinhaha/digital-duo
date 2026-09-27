import { describe, expect, it } from "vitest";
import { SynapseAdmin, SynapseAdminError, SynapseConfigError, assertSynapseBaseUrl } from "../src/hosted/synapse-admin.js";
import { createFakeSynapse, FAKE_ADMIN_TOKEN, FAKE_SYNAPSE_URL } from "./helpers/fake-synapse.js";

function client(fake = createFakeSynapse(), extra: { timeoutMs?: number } = {}) {
  return { fake, admin: new SynapseAdmin({ baseUrl: FAKE_SYNAPSE_URL, adminToken: FAKE_ADMIN_TOKEN, fetch: fake.fetch, ...extra }) };
}

async function failureOf(work: Promise<unknown>): Promise<SynapseAdminError> {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(SynapseAdminError);
    return error as SynapseAdminError;
  }
  throw new Error("expected the call to fail");
}

describe("SynapseAdmin — the admin API client", () => {
  it("creates an account with a display name, no password, and admin explicitly false", async () => {
    const { fake, admin } = client();
    await expect(admin.putUser("@k7m2x9pq.abc:duo.test", { displayName: "Sam" })).resolves.toEqual({ created: true });
    expect(fake.users.get("@k7m2x9pq.abc:duo.test")).toEqual({ displayname: "Sam", admin: false, hasPassword: false });
    const request = fake.requests[0]!;
    expect(request.method).toBe("PUT");
    expect(request.path).toBe("/_synapse/admin/v2/users/%40k7m2x9pq.abc%3Aduo.test");
    expect(request.body).toEqual({ displayname: "Sam", admin: false });
  });

  it("re-putting an existing account answers created: false", async () => {
    const { admin } = client();
    await admin.putUser("@a.b:duo.test", { displayName: "Sam" });
    await expect(admin.putUser("@a.b:duo.test", { displayName: "Sam" })).resolves.toEqual({ created: false });
  });

  it("a replay demotes an account that somehow became an admin", async () => {
    const { fake, admin } = client();
    await admin.putUser("@a.b:duo.test", { displayName: "Sam" });
    fake.users.get("@a.b:duo.test")!.admin = true;
    await admin.putUser("@a.b:duo.test", { displayName: "Sam" });
    expect(fake.users.get("@a.b:duo.test")!.admin).toBe(false);
  });

  it("mints a token that never expires only when told to, and sends valid_until_ms otherwise", async () => {
    const { fake, admin } = client();
    await admin.putUser("@duo-a.b:duo.test", { displayName: "x" });
    const forever = await admin.mintToken("@duo-a.b:duo.test", { neverExpires: true });
    const bounded = await admin.mintToken("@duo-a.b:duo.test", { validUntilMs: 1_800_000_000_000 });
    expect(forever).toMatch(/^syt_minted_/);
    expect(fake.minted.map((entry) => entry.validUntilMs)).toEqual([null, 1_800_000_000_000]);
    expect(fake.requests.at(-1)!.body).toEqual({ valid_until_ms: 1_800_000_000_000 });
    expect(fake.requests.at(-2)!.body).toEqual({});
    expect(bounded).not.toBe(forever);
  });

  it("reads Synapse's server name from the admin token's own user id", async () => {
    const { admin } = client(createFakeSynapse({ serverName: "chat.example" }));
    await expect(admin.whoAmI()).resolves.toBe("@workspace-admin:chat.example");
  });

  it("sends the admin token only as a bearer header, and refuses redirects", async () => {
    const { fake, admin } = client();
    await admin.putUser("@a.b:duo.test", { displayName: "Sam" });
    const request = fake.requests[0]!;
    expect(request.authorization).toBe(`Bearer ${FAKE_ADMIN_TOKEN}`);
    expect(request.path).not.toContain(FAKE_ADMIN_TOKEN);
    expect(request.redirect).toBe("error");
  });

  it("an outage is a retryable error that quotes neither the network error nor the token", async () => {
    const { fake, admin } = client();
    fake.down = true;
    const error = await failureOf(admin.putUser("@a.b:duo.test", { displayName: "Sam" }));
    expect(error.retryable).toBe(true);
    expect(error.status).toBeNull();
    expect(error.message).toBe("Synapse admin API PUT /_synapse/admin/v2/users/<id> could not be reached");
    expect(`${error.message} ${error.stack}`).not.toContain("ECONNREFUSED");
    expect(`${error.message} ${error.stack}`).not.toContain(FAKE_ADMIN_TOKEN);
  });

  it("a timeout is a retryable error", async () => {
    const { fake, admin } = client(createFakeSynapse(), { timeoutMs: 20 });
    fake.hangNext();
    const error = await failureOf(admin.whoAmI());
    expect(error.retryable).toBe(true);
    expect(error.message).toMatch(/timed out/);
  });

  it("an error response quotes only status and a well-formed errcode, never the body", async () => {
    const { fake, admin } = client();
    fake.failNext(1, 503, "M_LIMIT_EXCEEDED");
    const error = await failureOf(admin.putUser("@a.b:duo.test", { displayName: "Sam" }));
    expect(error.message).toBe("Synapse admin API PUT /_synapse/admin/v2/users/<id> failed: HTTP 503 M_LIMIT_EXCEEDED");
    expect(error.retryable).toBe(true);
    expect(error.message).not.toContain(FAKE_ADMIN_TOKEN);

    fake.failNext(1, 500, `M_${"x"} not an errcode ${FAKE_ADMIN_TOKEN}`);
    const odd = await failureOf(admin.putUser("@a.b:duo.test", { displayName: "Sam" }));
    expect(odd.errcode).toBeNull();
    expect(odd.message).not.toContain(FAKE_ADMIN_TOKEN);
  });

  it("a wrong admin token is a permanent (not retryable) 401", async () => {
    const fake = createFakeSynapse();
    const admin = new SynapseAdmin({ baseUrl: FAKE_SYNAPSE_URL, adminToken: "wrong", fetch: fake.fetch });
    const error = await failureOf(admin.putUser("@a.b:duo.test", { displayName: "Sam" }));
    expect(error).toMatchObject({ status: 401, errcode: "M_UNKNOWN_TOKEN", retryable: false });
    expect(error.message).not.toContain("wrong");
  });

  it("minting for a user that does not exist is a permanent 404", async () => {
    const { admin } = client();
    const error = await failureOf(admin.mintToken("@nobody.x:duo.test", { neverExpires: true }));
    expect(error).toMatchObject({ status: 404, retryable: false });
  });

  it("a login answer with no access token is an error, not an empty token", async () => {
    const admin = new SynapseAdmin({
      baseUrl: FAKE_SYNAPSE_URL,
      adminToken: FAKE_ADMIN_TOKEN,
      fetch: async () => new Response(JSON.stringify({ something: "else" }), { status: 200 }),
    });
    await failureOf(admin.mintToken("@a.b:duo.test", { neverExpires: true }));
  });
});

describe("assertSynapseBaseUrl — where the admin token may be sent", () => {
  it("accepts https anywhere and http only on *.railway.internal", () => {
    expect(assertSynapseBaseUrl("https://matrix.example.com/")).toBe("https://matrix.example.com");
    expect(assertSynapseBaseUrl("http://synapse.railway.internal:8008")).toBe("http://synapse.railway.internal:8008");
  });

  it("refuses plain http elsewhere, garbage, embedded credentials, and an empty token", () => {
    for (const bad of ["http://matrix.example.com", "http://railway.internal", "http://x.railway.internal.evil.example", "not a url", "https://user:pw@matrix.example.com"]) {
      expect(() => assertSynapseBaseUrl(bad)).toThrow(SynapseConfigError);
    }
    expect(() => new SynapseAdmin({ baseUrl: FAKE_SYNAPSE_URL, adminToken: "" })).toThrow(SynapseConfigError);
  });

  it("a config error never contains the URL it rejected (it may carry a credential)", () => {
    try {
      assertSynapseBaseUrl("https://user:hunter2@matrix.example.com");
    } catch (error) {
      expect((error as Error).message).not.toContain("hunter2");
    }
  });
});
