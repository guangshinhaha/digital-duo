import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { handleMcpRequest, MCP_METHOD_NOT_ALLOWED } from "../serve/mcp.js";
import type { ServeDeps } from "../serve/server.js";
import type { VerifiedIdentity } from "./google.js";
import { OAuthError, type OAuthStore } from "./oauth.js";

/** What the OAuth routes need from the hosted server that owns them. */
export interface OAuthContext {
  /** This server's public origin: the OAuth issuer and the base of the MCP address. */
  readonly publicUrl: string;
  /** The web app that hosts the sign-in page the owner is sent to. */
  readonly webUrl: string;
  readonly store: OAuthStore;
  /** Verifies a sign-in credential, answering the failure itself; undefined means the reply is already sent. */
  identify(credential: unknown, request: FastifyRequest, reply: FastifyReply): Promise<VerifiedIdentity | undefined>;
  signInBlocked(ip: string): boolean;
  /** The duo a signed-in identity owns, or undefined when it owns none. Never claims a duo. */
  duoForIdentity(identity: VerifiedIdentity): { readonly duoId: string; readonly ownerName: string } | undefined;
  depsFor(duoId: string): ServeDeps | undefined;
}

const SCOPE = "duo:save";
/**
 * Claude's own servers make the registration and token calls, so many owners share a few source addresses and one
 * budget: registration is generous (the client cap and the unused-client grace are the real bound), and failed token
 * calls are counted per client as well as per address.
 */
const REGISTER_MAX_PER_HOUR = 300;
const TOKEN_MAX_FAILURES_PER_WINDOW = 30;
const TOKEN_FAILURE_WINDOW_MS = 15 * 60_000;

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

/** A small per-address counter: `blocked` says whether the address is over its budget, `record` spends one. */
function limiter(max: number, windowMs: number) {
  const windows = new Map<string, { start: number; count: number }>();
  const prune = () => {
    for (const [key, window] of windows) {
      if (Date.now() - window.start > windowMs) {
        windows.delete(key);
      }
    }
  };
  return {
    blocked(ip: string): boolean {
      const window = windows.get(ip);
      return window !== undefined && Date.now() - window.start <= windowMs && window.count >= max;
    },
    record(ip: string): void {
      prune();
      const window = windows.get(ip);
      if (!window || Date.now() - window.start > windowMs) {
        windows.set(ip, { start: Date.now(), count: 1 });
      } else {
        window.count += 1;
      }
    },
  };
}

function redirectWith(base: string, params: Record<string, string | undefined>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

/** A query parameter as one string: a repeated parameter arrives as an array and is not a value. */
function single(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Issue #240: the daemon as the claude.ai connector's OAuth server and MCP
 * resource. Claude finds this through the metadata below, registers itself,
 * sends the owner to the web app to sign in with Google, and trades the code
 * it gets back for tokens that name one duo. The signed-in owner's own duo is
 * the only one a token can ever reach: there is no way to ask for another.
 *
 * Registered on the hosted front's control app, because "which duo does this
 * Google account own" is a hosted-mode question. The front sends `/mcp`,
 * `/oauth/*` and `/.well-known/oauth-*` here; `/mcp/<secret>` still goes to
 * a duo's own app, where it is refused once sign-in connectors are on.
 */
export function registerOAuthRoutes(control: FastifyInstance, ctx: OAuthContext): void {
  const resource = `${ctx.publicUrl}/mcp`;
  const metadataUrl = `${ctx.publicUrl}/.well-known/oauth-protected-resource`;

  const registrations = limiter(REGISTER_MAX_PER_HOUR, 60 * 60_000);
  const tokenFailures = limiter(TOKEN_MAX_FAILURES_PER_WINDOW, TOKEN_FAILURE_WINDOW_MS);

  // RFC 9728: what the MCP address is protected by. Claude reads this after the first 401.
  const protectedResource = async () => ({
    resource,
    authorization_servers: [ctx.publicUrl],
    bearer_methods_supported: ["header"],
    scopes_supported: [SCOPE],
    resource_name: "Digital Duo",
  });
  control.get("/.well-known/oauth-protected-resource", protectedResource);
  control.get("/.well-known/oauth-protected-resource/mcp", protectedResource);

  // RFC 8414: where to register, send the owner, and trade codes.
  control.get("/.well-known/oauth-authorization-server", async () => ({
    issuer: ctx.publicUrl,
    authorization_endpoint: `${ctx.publicUrl}/oauth/authorize`,
    token_endpoint: `${ctx.publicUrl}/oauth/token`,
    registration_endpoint: `${ctx.publicUrl}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [SCOPE],
  }));

  // RFC 7591: Claude registers itself. Open by design, so it is rate limited and only Claude's own callback addresses are accepted.
  control.post<{ Body: { client_name?: unknown; redirect_uris?: unknown } }>("/oauth/register", async (request, reply) => {
    if (registrations.blocked(request.ip)) {
      reply.code(429).send({ error: "invalid_client_metadata", error_description: "Too many registrations from this address; try again later." });
      return;
    }
    registrations.record(request.ip);
    try {
      const client = ctx.store.registerClient({ clientName: request.body?.client_name, redirectUris: request.body?.redirect_uris });
      reply.code(201);
      return {
        client_id: client.id,
        client_name: client.name,
        redirect_uris: client.redirectUris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        client_id_issued_at: Math.floor(Date.parse(client.createdAt) / 1000),
      };
    } catch (error) {
      if (error instanceof OAuthError) {
        reply.code(400).send({ error: error.code, error_description: error.message });
        return;
      }
      throw error;
    }
  });

  // The owner arrives here from Claude. A request that names no known client or address is answered with an error page and
  // never redirected (a redirect could send someone to an address an attacker chose); every other problem goes back to Claude.
  control.get<{ Querystring: Record<string, unknown> }>("/oauth/authorize", async (request, reply) => {
    const query = request.query;
    const client = ctx.store.getClient(single(query.client_id) ?? "");
    const redirectUri = single(query.redirect_uri);
    if (!client || !redirectUri || !client.redirectUris.includes(redirectUri)) {
      reply.code(400).send(errorBody("invalid_request", "This connection request is not valid. Start again from Claude."));
      return;
    }
    const state = single(query.state);
    const back = (error: string, description: string) => reply.redirect(redirectWith(redirectUri, { error, error_description: description, state }), 302);
    if (query.state !== undefined && state === undefined) {
      return back("invalid_request", "state must be a single value.");
    }
    if (query.response_type !== "code") {
      return back("unsupported_response_type", "Only the authorization code flow is supported.");
    }
    const codeChallenge = single(query.code_challenge);
    if (!codeChallenge || !PKCE_CHALLENGE.test(codeChallenge) || query.code_challenge_method !== "S256") {
      return back("invalid_request", "A PKCE code challenge (S256) is required.");
    }
    if (query.resource !== undefined && query.resource !== resource) {
      return back("invalid_target", "That resource is not served here.");
    }
    try {
      const pending = ctx.store.beginAuthorization({ client, redirectUri, state, codeChallenge });
      reply.redirect(`${ctx.webUrl}/#connect?host=${encodeURIComponent(ctx.publicUrl)}&request=${pending.id}`, 302);
    } catch (error) {
      if (error instanceof OAuthError) {
        return back(error.code, error.message);
      }
      throw error;
    }
  });

  // What the web app's sign-in page shows before the owner decides.
  control.get<{ Params: { id: string } }>("/oauth/requests/:id", async (request, reply) => {
    const pending = ctx.store.getAuthorization(request.params.id);
    if (!pending) {
      reply.code(404).send(errorBody("request_expired", "This connection request has expired. Start again from Claude."));
      return;
    }
    return { clientName: pending.clientName };
  });

  control.post<{ Params: { id: string }; Body: { credential?: unknown } }>("/oauth/requests/:id/approve", async (request, reply) => {
    if (ctx.signInBlocked(request.ip)) {
      reply.code(429).send(errorBody("rate_limited", "Too many failed sign-ins from this address; try again later."));
      return;
    }
    const pending = ctx.store.getAuthorization(request.params.id);
    if (!pending) {
      reply.code(404).send(errorBody("request_expired", "This connection request has expired. Start again from Claude."));
      return;
    }
    const identity = await ctx.identify(request.body?.credential, request, reply);
    if (!identity) {
      return;
    }
    const duo = ctx.duoForIdentity(identity);
    if (!duo) {
      reply.code(404).send(errorBody("no_duo", "There's no duo for this Google account, so nothing was connected."));
      return;
    }
    // Two approvals of one request can both get past the sign-in check above; only the one that takes it is given a code.
    const taken = ctx.store.takeAuthorization(pending.id);
    if (!taken) {
      reply.code(404).send(errorBody("request_expired", "This connection request has expired. Start again from Claude."));
      return;
    }
    const code = ctx.store.issueCode(taken, duo.duoId);
    return { redirectTo: redirectWith(taken.redirectUri, { code, state: taken.state }), ownerName: duo.ownerName };
  });

  control.post<{ Params: { id: string } }>("/oauth/requests/:id/deny", async (request, reply) => {
    const pending = ctx.store.takeAuthorization(request.params.id);
    if (!pending) {
      reply.code(404).send(errorBody("request_expired", "This connection request has expired."));
      return;
    }
    return { redirectTo: redirectWith(pending.redirectUri, { error: "access_denied", error_description: "The owner declined.", state: pending.state }) };
  });

  // RFC 6749 §3.2: trade a code (with its PKCE verifier) or a refresh token for tokens. Registered as its own plugin so
  // the form body type this endpoint needs is accepted here and nowhere else on the control app.
  control.register(async (scope) => {
    scope.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, raw, done) => {
      done(null, Object.fromEntries(new URLSearchParams(raw as string)));
    });

    scope.post<{ Body: Record<string, unknown> }>("/oauth/token", async (request, reply) => {
      reply.header("Cache-Control", "no-store").header("Pragma", "no-cache");
      const body = request.body ?? {};
      const clientId = asString(body.client_id);
      // Claude's servers share addresses across owners, so failures are counted per client as well as per address.
      const failureKey = `${request.ip}|${clientId ?? ""}`;
      if (tokenFailures.blocked(failureKey)) {
        reply.code(429).send({ error: "invalid_request", error_description: "Too many failed attempts; try again later." });
        return;
      }
      try {
        let tokens;
        if (body.grant_type === "authorization_code") {
          const code = asString(body.code);
          const redirectUri = asString(body.redirect_uri);
          const codeVerifier = asString(body.code_verifier);
          if (!clientId || !code || !redirectUri || !codeVerifier) {
            throw new OAuthError("invalid_request", "client_id, code, redirect_uri and code_verifier are required.");
          }
          tokens = ctx.store.exchangeCode({ code, clientId, redirectUri, codeVerifier });
        } else if (body.grant_type === "refresh_token") {
          const refreshToken = asString(body.refresh_token);
          if (!clientId || !refreshToken) {
            throw new OAuthError("invalid_request", "client_id and refresh_token are required.");
          }
          tokens = ctx.store.refresh({ refreshToken, clientId });
        } else {
          reply.code(400).send({ error: "unsupported_grant_type", error_description: "grant_type must be authorization_code or refresh_token." });
          return;
        }
        return { access_token: tokens.accessToken, token_type: "Bearer", expires_in: tokens.expiresInSeconds, refresh_token: tokens.refreshToken, scope: SCOPE };
      } catch (error) {
        if (error instanceof OAuthError) {
          tokenFailures.record(failureKey);
          reply.code(400).send({ error: error.code, error_description: error.message });
          return;
        }
        throw error;
      }
    });
  });

  // The MCP address itself. The token names the duo; without a valid one Claude is pointed at the metadata and starts the sign-in.
  const challenge = (reply: FastifyReply, invalidToken: boolean) =>
    reply
      .code(401)
      .header("WWW-Authenticate", `Bearer resource_metadata="${metadataUrl}"${invalidToken ? ', error="invalid_token"' : ""}`)
      .send({ jsonrpc: "2.0", error: { code: -32001, message: "Sign in to connect Claude to your duo." }, id: null });

  control.post("/mcp", async (request, reply) => {
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
    if (!token) {
      return challenge(reply, false);
    }
    const verified = ctx.store.verifyAccess(token);
    const deps = verified ? ctx.depsFor(verified.duoId) : undefined;
    if (!deps) {
      return challenge(reply, true);
    }
    await handleMcpRequest(deps, request, reply);
  });
  control.get("/mcp", async (_request, reply) => reply.code(405).header("Allow", "POST").send(MCP_METHOD_NOT_ALLOWED));
  control.delete("/mcp", async (_request, reply) => reply.code(405).header("Allow", "POST").send(MCP_METHOD_NOT_ALLOWED));
}
