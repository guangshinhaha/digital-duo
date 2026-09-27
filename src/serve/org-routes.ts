import type { FastifyInstance, FastifyReply } from "fastify";

/** A refusal the route sends as it is: the status, a stable code and a plain sentence. */
export interface OrgAdminRefusal {
  readonly ok: false;
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

/** Whatever the handle answers: a value (with the status to send it under, 200 by default) or a refusal. */
export type OrgAdminOutcome<T = unknown> = { readonly ok: true; readonly value: T; readonly status?: number } | OrgAdminRefusal;

/**
 * #254: what a hosted duo's app calls to manage its own org. Bound to one duo by whoever builds the deps (hosted
 * mode), like `WorkspaceSessionAccess`: the org and the caller's role come from the duo this app's device-token
 * auth just verified, never from the request, so no route can be pointed at another org. Every method reads the
 * role live from the registry, so an appointment or a revoke reaches a signed-in person on their next request.
 */
export interface OrgAdminAccess {
  /** The duo's org and role; open to every signed-in member (it is how the app learns whether to show its admin screens). */
  overview(): { org: { id: string; name: string }; role: string; superAdmin: boolean } | undefined;
  /** The org's members with role marks and the appoint/revoke history. Org admins only. */
  members(): OrgAdminOutcome;
  /** This org's pending invites, and no other org's. Org admins only. */
  invites(): OrgAdminOutcome;
  /** `{ name, email?, expiresInHours? }`. The invite always lands in this org; the invitee joins as a member. Org admins only. */
  invite(body: unknown): OrgAdminOutcome;
  /** `{ name }`: renames the org and, through the same path as the super admin's rename, its Space. Org admins only. */
  rename(body: unknown): Promise<OrgAdminOutcome>;
  /** Appoints another member of this org. Idempotent. Org admins only. */
  grant(duoId: string): OrgAdminOutcome;
  /** Takes the role from a member of this org (or the caller's own, to step down). Refused for the last org admin. Org admins only. */
  revoke(duoId: string): OrgAdminOutcome;
}

function send<T>(reply: FastifyReply, outcome: OrgAdminOutcome<T>): unknown {
  if (!outcome.ok) {
    reply.code(outcome.status).send({ error: { code: outcome.code, message: outcome.message } });
    return undefined;
  }
  if (outcome.status) {
    reply.code(outcome.status);
  }
  return outcome.value;
}

/**
 * `<basePath>/org*` inside a hosted duo's own app (a tenant's `/t/<id>` is stripped by the front; the root duo has
 * none). The auth hook has verified a device token against this duo's store, with its cache and failure limiter, so
 * these routes only decide by role. Registered only where hosted mode supplied the handle: a personal duo has no orgs.
 */
export function registerOrgRoutes(app: FastifyInstance, access: OrgAdminAccess): void {
  app.get("/org", async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (request.principal?.kind !== "device") {
      reply.code(401).send({ error: { code: "unauthorized", message: "Sign in to see your org." } });
      return;
    }
    const overview = access.overview();
    if (!overview) {
      reply.code(404).send({ error: { code: "not_found", message: "This duo is in no org." } });
      return;
    }
    return overview;
  });

  // Every org-admin route below is device-only (an ask link never reaches them: the hook refuses it on every route but /ask).
  app.get("/org/members", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return send(reply, access.members());
  });
  app.get("/org/invites", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return send(reply, access.invites());
  });
  app.post("/org/invites", async (request, reply) => {
    reply.header("cache-control", "no-store");
    return send(reply, access.invite(request.body));
  });
  app.post("/org/rename", async (request, reply) => {
    reply.header("cache-control", "no-store");
    return send(reply, await access.rename(request.body));
  });

  // Grant and revoke take no body, so a client that sends `Content-Type: application/json` with none must not get
  // Fastify's empty-body 400: own scope, body ignored.
  app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", (_request, _payload, done) => done(null, undefined));
    scope.post<{ Params: { duoId: string } }>("/org/admins/:duoId/grant", async (request, reply) => {
      reply.header("cache-control", "no-store");
      return send(reply, access.grant(request.params.duoId));
    });
    scope.post<{ Params: { duoId: string } }>("/org/admins/:duoId/revoke", async (request, reply) => {
      reply.header("cache-control", "no-store");
      return send(reply, access.revoke(request.params.duoId));
    });
  });
}
