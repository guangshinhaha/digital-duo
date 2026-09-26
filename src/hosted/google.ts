import { createPublicKey, verify, type JsonWebKey } from "node:crypto";

/**
 * Who signed in, as hosted mode's account layer needs it. Google is the
 * first identity provider, not an assumption: the hosted server only ever
 * sees an `IdentityVerifier`, so an agency IdP (TechPass, Entra ID) is
 * another implementation of this one interface, not a redesign.
 */
export interface VerifiedIdentity {
  /** The provider's stable subject id — what a duo is bound to (emails can change). */
  readonly subject: string;
  readonly email: string;
  readonly name: string | undefined;
}

export interface IdentityVerifier {
  verify(credential: string): Promise<VerifiedIdentity>;
}

export class IdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityError";
  }
}

const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const CLOCK_SKEW_SECONDS = 60;
const JWKS_TTL_MS = 60 * 60_000;

interface Jwk extends JsonWebKey {
  kid?: string;
}

function decodeSegment(segment: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new IdentityError("Malformed sign-in credential.");
  }
}

/**
 * Verifies a Google Identity Services ID token (the `credential` the "Sign
 * in with Google" button hands the web app): RS256 signature against
 * Google's published keys, then audience (our client id), issuer, expiry,
 * and a verified email. No SDK, no client secret — an ID token is verifiable
 * with public keys alone.
 */
export function googleIdentityVerifier(clientId: string, fetchImpl: typeof fetch = fetch): IdentityVerifier {
  let cache: { keys: Jwk[]; fetchedAt: number } | undefined;

  const keys = async (forceRefresh: boolean): Promise<Jwk[]> => {
    if (!forceRefresh && cache && Date.now() - cache.fetchedAt < JWKS_TTL_MS) {
      return cache.keys;
    }
    const response = await fetchImpl(GOOGLE_JWKS_URL);
    if (!response.ok) {
      throw new IdentityError(`Could not fetch Google's signing keys (HTTP ${response.status}).`);
    }
    const body = (await response.json()) as { keys?: Jwk[] };
    cache = { keys: body.keys ?? [], fetchedAt: Date.now() };
    return cache.keys;
  };

  return {
    async verify(credential: string): Promise<VerifiedIdentity> {
      const parts = credential.split(".");
      if (parts.length !== 3) {
        throw new IdentityError("Malformed sign-in credential.");
      }
      const [headerSegment, payloadSegment, signatureSegment] = parts;
      const header = decodeSegment(headerSegment);
      if (header.alg !== "RS256" || typeof header.kid !== "string") {
        throw new IdentityError("Unsupported sign-in credential.");
      }
      // Google rotates keys; an unknown kid means our cache is stale, so
      // refetch once before refusing.
      let jwk = (await keys(false)).find((key) => key.kid === header.kid);
      if (!jwk) {
        jwk = (await keys(true)).find((key) => key.kid === header.kid);
      }
      if (!jwk) {
        throw new IdentityError("Sign-in credential was signed by an unknown key.");
      }
      const valid = verify(
        "RSA-SHA256",
        Buffer.from(`${headerSegment}.${payloadSegment}`),
        createPublicKey({ key: jwk, format: "jwk" }),
        Buffer.from(signatureSegment, "base64url"),
      );
      if (!valid) {
        throw new IdentityError("Sign-in credential signature is invalid.");
      }

      const claims = decodeSegment(payloadSegment);
      const now = Math.floor(Date.now() / 1000);
      if (claims.aud !== clientId) {
        throw new IdentityError("Sign-in credential is for a different app.");
      }
      if (typeof claims.iss !== "string" || !GOOGLE_ISSUERS.has(claims.iss)) {
        throw new IdentityError("Sign-in credential has an unexpected issuer.");
      }
      if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_SECONDS < now) {
        throw new IdentityError("Sign-in credential has expired; sign in again.");
      }
      if (typeof claims.sub !== "string" || typeof claims.email !== "string" || claims.email_verified !== true) {
        throw new IdentityError("Your Google account's email must be verified.");
      }
      return {
        subject: claims.sub,
        email: claims.email.toLowerCase(),
        name: typeof claims.name === "string" && claims.name.trim() ? claims.name.trim() : undefined,
      };
    },
  };
}
