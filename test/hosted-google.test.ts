import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { googleIdentityVerifier, IdentityError } from "../src/hosted/google.js";

const CLIENT_ID = "client-123.apps.googleusercontent.com";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };

function token(claims: Record<string, unknown>, kid = "k1", key = privateKey): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), key).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

function goodClaims(overrides: Record<string, unknown> = {}) {
  return {
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    sub: "google-sub-1",
    email: "Sam@Example.com",
    email_verified: true,
    name: "Sam Tan",
    exp: Math.floor(Date.now() / 1000) + 600,
    ...overrides,
  };
}

const fakeFetch = (async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })) as unknown as typeof fetch;

describe("googleIdentityVerifier", () => {
  const verifier = googleIdentityVerifier(CLIENT_ID, fakeFetch);

  it("accepts a correctly signed token and returns subject, lowercased email and name", async () => {
    await expect(verifier.verify(token(goodClaims()))).resolves.toEqual({ subject: "google-sub-1", email: "sam@example.com", name: "Sam Tan" });
  });

  it.each([
    ["another app's audience", { aud: "someone-else" }],
    ["a foreign issuer", { iss: "https://evil.example" }],
    ["an expired token", { exp: Math.floor(Date.now() / 1000) - 3600 }],
    ["an unverified email", { email_verified: false }],
  ])("refuses %s", async (_label, overrides) => {
    await expect(verifier.verify(token(goodClaims(overrides)))).rejects.toBeInstanceOf(IdentityError);
  });

  it("refuses a token signed by a different key", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    await expect(verifier.verify(token(goodClaims(), "k1", other))).rejects.toThrow(/signature/);
  });

  it("refuses an unknown key id and garbage", async () => {
    await expect(verifier.verify(token(goodClaims(), "nope"))).rejects.toThrow(/unknown key/);
    await expect(verifier.verify("not.a.jwt")).rejects.toBeInstanceOf(IdentityError);
  });
});
