# Hosted mode — many duos, one server, invite-only

> Decision record, 2026-09-26. Amends `docs/workspace/org-mode-deployment.md` §1.1 ("no
> multi-tenant rewrite, now or later") for the hosted POC, by owner decision. Why: once the duo
> runs on a server rather than an owner's Mac, "one server per person" makes trying it a
> provisioning job. People should be able to get their own duo from an invite link.

## The decision

1. **One process serves many duos, and each duo is still exactly a `duo serve` app.** Every duo
   is an unchanged `createServer(deps)` over its own encrypted store under
   `hosted/users/<id>/`, with its own passphrase, device tokens, ask links and `duo/` folder. It
   is not a multi-tenant rewrite: no shared tables, no tenant column, and no change to any core
   module. A front (`src/hosted/server.ts`) strips `/t/<id>` from the URL and hands the request
   (or WebSocket upgrade) to that duo's own never-listening HTTP server. So each duo sees exactly
   the routes, auth, rate limiting and socket it would see alone.
2. **Invite-only.** An admin mints a single-use, expiring invite (`duo hosted invite <name>` on
   the server, or `POST /hosted/invites` with `DUO_HOSTED_ADMIN_TOKEN`). Redeeming it
   (`POST /hosted/signup`) creates the duo and its first device token in one step. Codes are
   stored only as hashes, and a used or expired code is refused.
3. **The server holds every duo's key.** Each duo's random passphrase is stored in
   `hosted/registry.json`, encrypted under `DUO_HOSTED_MASTER_KEY`. So the registry alone (a
   backup, a stolen disk) opens nothing, but the running process opens everything. This is org
   mode §6's operator concession applied to every hosted duo, and pilot users are told so. Duos
   work all the time (drafts, ask links) without their owner logged in. A per-user,
   password-derived key can replace this later without changing the shape above.
4. **The terminal-only steps are app routes.** A hosted user has no shell, so these are now
   routes that call the same module functions as their CLI commands:
   - `POST /corpus/import-claude`
   - `POST|GET /corpus/derive` (pairs → topics → rules → voice, as a job)
   - `GET|POST /ask-links`, `POST /ask-links/:id/revoke`
   - `POST /devices`
   - `GET /trust/promotions`, `POST /trust/promotions/:topicId/:tier`, `POST /trust/grant`
     (T4 is still refused and logged)

   They're owner-only by construction, because the auth hook refuses ask tokens on every route
   but `/ask`.
5. **The pre-hosted duo keeps its address.** A single-owner store at `DUO_STORE_PATH` with
   `DUO_PASSPHRASE` set is served at the bare origin, so its pairings and ask links keep working.
6. **Not in hosted mode:** the Matrix workspace connection (one outbound connection per duo is
   its own decision) and per-duo inference billing (every duo shares the server's OpenRouter
   key; org mode §7's gateway is still the answer for real metering).

   > **Amended 2026-09-26 (#229):** the Matrix workspace connection is now in scope for hosted
   > mode, as a multi-org workspace on one shared Synapse, with each duo holding its own
   > provisioned account. Orgs, account naming, the org wall and its limits are decided in
   > `docs/deploy/hosted-workspace.md`. Per-duo inference billing stays out, as above.
   >
   > **Built 2026-09-26 (#236):** see "Each duo's own workspace connection" below.

## Sign-in (added 2026-09-26)

- **Google sign-in, bound once.** With `DUO_HOSTED_GOOGLE_CLIENT_ID` set, redeeming an invite
  requires a Google sign-in. The personal duo is bound to that account's stable subject id, one personal duo
  per account. An account may also own up to five desk duos, each its own tenant bound to the same subject with
  `kind: "desk"`. `POST /hosted/login` mints a device token for the personal duo, and the app reaches its desk duos
  from there. That device shows up in the duo's device list and can be revoked like any other.
- **Verified without an SDK.** The server checks the token's RS256 signature against Google's
  published keys, plus audience, issuer, expiry and verified email (`src/hosted/google.ts`). No
  client secret is involved. Google is one `IdentityVerifier`, so an agency IdP (TechPass,
  Entra ID) is another implementation of it, not a redesign.
- **Admins are emails.** Anyone listed in `DUO_HOSTED_ADMIN_EMAILS` gets an admin account and can
  mint invites with their own device token (the app's Invite people page). The first admin to
  sign in claims the pre-hosted root duo, and after that only that Google account opens it.
- **Invites can be locked to an email.** Only that Google account can redeem such an invite.
- **The Google project is in Testing mode.** Only its listed test users can sign in, up to 100.
  Add each invitee's Gmail under Google Auth Platform → Audience → Test users, or complete
  Branding and publish.

## Orgs (added 2026-09-26, epic #228)

- **Every duo belongs to exactly one org.** An org is `{ id, name, createdAt }` in
  `hosted/registry.json`; membership is the duo's `orgId` (the pre-hosted root duo, which is not
  a tenant, is placed by the registry's `rootOrgId`). Org names are unique, ignoring case.
- **Invites carry an org.** `POST /hosted/invites` takes an optional `orgId`; with none the
  invite goes to the default org, so an invite made the old way still works. Redeeming it puts the
  new duo in that org, and `POST /hosted/login` and `/hosted/signup` return the duo's `orgId`.
- **The super admin** is anyone in `DUO_HOSTED_ADMIN_EMAILS` (or the server-side
  `DUO_HOSTED_ADMIN_TOKEN`). The list is re-read from the process environment on every request,
  not from a flag stored at sign-up, so removing an email from a running process's env withdraws
  admin on the next request. A platform that only changes env vars by redeploying
  applies the change on that redeploy. Admin-ness is judged on the email stored with the
  duo, and every `POST /hosted/login` refreshes that email from the verified Google identity.
  The privilege still follows an address, not a person: if an admin address is reassigned to
  someone else, revoke the old account's devices (its duo's device list) as well as editing the
  list. The super admin routes (`/hosted/orgs*` and the rest of `/hosted/*`) answer 401 with no
  credential and 403 for any other caller (a garbage or revoked token is a 403 too, on `/hosted/*`
  only). Every `/hosted/*` route stays super admin only: an org admin's device gets the same 403 as
  a member's. Org admins (#254, below) use the own-org routes inside their duo instead (`<basePath>/org*`),
  which are per-duo device-token routes: a missing, bad or revoked token there is a 401.
  Deleting an org is out of scope (a follow-up).
- **Org ids are lowercase letters and digits only.** They are embedded in Matrix account names
  (`@<orgId>.<handle>:<server>`, split on the first dot), which are permanent. The registry
  refuses to load a file with any other org id, and never generates one. Org names are
  NFKC-normalized, trimmed, must not contain control or invisible (zero-width, bidi) characters,
  and stay unique ignoring case.
- **The root duo is a member of its org in the registry itself.** The server records it once
  (`rootDuo` in `registry.json`) when it serves a pre-hosted root duo, so `listOrgMembers` and
  the member counts do not depend on call order.
- **Migration is versioned and lazy.** A registry file with no `version` (v1) is read as
  version 2 in memory: a default org (`id: "default"`, name "Default") is created and every
  tenant, invite and the root duo go in it. Ids, URLs and device tokens do not change. Nothing
  is rewritten until the registry next writes (which keeps the original as
  `registry.json.v1.bak`, never overwriting an existing one), and migrating twice gives the
  same result. On every load a tenant or invite with no `orgId` (written by a rolled-back
  pre-orgs build) is put in the default org. A file from a newer version is refused. A write
  that fails leaves the in-memory registry as it was.

Routes (all super admin only; POST for rename because CORS allows only GET and POST):

| Route | What |
|---|---|
| `GET /hosted/orgs` | `[{ id, name, createdAt, memberCount }]` |
| `POST /hosted/orgs` `{ name }` | create; 201, 400 on a bad name, 409 if the name is taken |
| `POST /hosted/orgs/:orgId/rename` `{ name }` | rename; 404 for an unknown org, 409 `org_name_taken` if another org has the name |
| `GET /hosted/orgs/:orgId/members` | `[{ duoId, name, email, isRoot, joinedAt, isAdmin, superAdmin, orgRole, appointedBy, appointedByName, appointedAt, orgAdminLog, verified, answeringEnabled, answeringRevoked }]` (`verified`/`answeringEnabled`/`answeringRevoked`: duo#318) |
| `POST /hosted/orgs/:orgId/admins/:duoId/grant` | appoint a member as org admin, as `super-admin`; `{ member, changed }` |
| `POST /hosted/orgs/:orgId/admins/:duoId/revoke` | revoke the role, and may revoke the org's last org admin; `{ member, changed }`. Revoking a member who holds no role is 200 `changed: false`; revoking `root` is 409 `root_not_appointable`, as granting it is |
| `POST /hosted/orgs/:orgId/members/:duoId/answering/revoke` | duo#318: stops a member's duo answering colleagues at all, as `super-admin`; `{ member, changed }`. 404 `not_found` for a member who left or `root` (never a target) |
| `POST /hosted/orgs/:orgId/members/:duoId/answering/restore` | duo#318: lets the duo answer colleagues again; `{ member, changed }` |
| `POST /hosted/invites` `{ name, orgId?, email?, expiresInHours? }` | as before, plus the org |

`duoId` is the tenant id, or `root` for the pre-hosted root duo. `isAdmin` and `superAdmin` are the same
fact (the super admin, from the env); `orgRole` is `member` or `org_admin`.

### Org admins (#254)

A member can be made org admin of their own org by the super admin or another org admin
(`docs/deploy/hosted-workspace.md` §7 has the model: roles, the last-admin rule, the audit list).
`POST /hosted/login` and `/hosted/signup` keep `isAdmin` (the super admin) and gain
`orgRole: "member" | "org_admin"`. An org admin's app calls routes inside its own duo, under the
duo's `basePath` (`/t/<id>`, or empty for the root duo), with the duo's device token:

| Route (under `<basePath>`) | Who | What |
|---|---|---|
| `GET /org` | any signed-in member | `{ org: { id, name }, role, superAdmin, verified, answeringEnabled }`: how the app learns and refreshes its role (`verified`/`answeringEnabled`: duo#318, the signed-in duo's own) |
| `GET /org/members` | org admin | the org's members, as the super admin's list above |
| `GET /org/invites` | org admin | `[{ id, name, email, orgId, createdAt, expiresAt }]`, this org's pending invites only |
| `POST /org/invites` `{ name, email?, expiresInHours? }` | org admin | 201 `{ id, name, email, orgId, expiresAt, code, link }`; always this org. `name` at most 80 characters (400 beyond); 409 `too_many_invites` when the org already has 50 unused, unexpired invites (expired ones are dropped as a new one is made) |
| `POST /org/rename` `{ name }` | org admin | `{ org: { id, name } }`; also renames the org's Space. A name another org has is the generic 409 `name_unavailable` |
| `POST /org/admins/:duoId/grant` | org admin | `{ member, changed }`; idempotent |
| `POST /org/admins/:duoId/revoke` | org admin | `{ member, changed }`; 409 `last_org_admin` for the last one |
| `POST /org/members/:duoId/answering/revoke` | org admin | duo#318: `{ member, changed }`; stops a member of this org answering colleagues; 409 `super_admin_protected` for the super admin's own duo |
| `POST /org/members/:duoId/answering/restore` | org admin | duo#318: `{ member, changed }`; same refusals as the revoke above |

Errors: 401 no or bad device token (also an ask link or a connector token: these routes take a
device token only); 403 `forbidden` for everything that is not the caller's to do (one body); 404
`not_found` for a `:duoId` that is not in the caller's org (or, for the answering routes, `root`:
never a target there); 409 `last_org_admin`, `root_not_appointable` (granting or revoking `root`),
`super_admin_protected` (an org admin acting on another super admin, including that super admin's
answering, duo#318), `name_unavailable`, `too_many_invites`; 400 `bad_request`. The super admin's own
routes above keep the specific `org_name_taken` and have no invite cap. `org_name_taken` is never sent
to an org admin, who sees no other org's name.
The routes exist only in hosted mode (`ServeDeps.orgAdmin`, bound to one duo in
`src/hosted/server.ts`; the logic is `src/hosted/org-admin.ts`).

### Verification and answering (duo#318)

Every tenant carries `verified` (set once, at sign-up: true iff it signed up through an identity
provider — `identityVerifier` configured — false for a typed-name sign-up with none configured) and
`answeringRevoked` (absent means enabled; set to `{ since, by }` by an org admin's or the super
admin's revoke, cleared by restore). The root duo always reads `verified: true,
answeringEnabled: true` — it is never a target of the answering routes. `HostedRegistry.verificationStatus(duoId)`
is the one live read (`{ verified, answeringEnabled }`), and `ServeDeps.verification`
(`src/serve/server.ts`) is the per-duo handle hosted mode builds from it (`verificationAccessFor` in
`src/hosted/server.ts`), bound like `orgAdmin` and `workspaceSession` above it.

**`verified` is an informational label only — it gates nothing.** `src/permissions/public-answer.ts`'s
gate (checked before `POST /ask`'s ask-link branch and the workspace answering pipeline ever call
`answerPublicly`) reads `answeringEnabled` alone. A deployment with no `identityVerifier` configured
signs up every duo unverified, by design (the typed-name path, this doc's §"Routes" above), and must
keep answering normally — gating on `verified` there would silently break that deployment style. A
paused duo's colleagues see the fixed `PUBLIC_ANSWERING_PAUSED_MESSAGE`, deliberately as vague as the
other asker-visible outcomes in that module.

Code that needs org membership imports from `src/hosted/registry.ts` (`HostedRegistry`, reachable
as `hosted.registry`) and `src/hosted/orgs.ts` (types and constants):

```ts
registry.orgOf(duoId: string): HostedOrg | undefined          // duoId is a tenant id or ROOT_DUO_ID
registry.listOrgMembers(orgId: string): OrgMember[]           // throws OrgNotFoundError
registry.listOrgs(): HostedOrgSummary[]                       // with memberCount
registry.createOrg(name) / registry.renameOrg(orgId, name)    // OrgNameError, OrgNameTakenError, OrgNotFoundError
registry.createInvite(name, expiresAt, email?, orgId?)        // orgId defaults to DEFAULT_ORG_ID
```

`registry.tenants()` and `registry.invites()` carry `orgId` on every row. Later issues
(provisioned accounts, spaces, the org boundary) should read org membership through these and not
re-derive it.

## Matrix accounts (added 2026-09-26, #232)

Decision record: `hosted-workspace.md`. When the Synapse admin variables (below) are set, the
daemon creates every duo's two accounts through Synapse's admin API. Nobody registers on the
homeserver, and neither account has a password.

- **Names** carry the org: the person is `@<orgId>.<handle>:<server>`, their personal duo
  `@duo-<orgId>.<handle>:<server>`, and each desk duo `@duo-<orgId>.<handle>.<deskId>:<server>`. The extra segment
  keeps every desk duo derivable back to exactly one owner, so the mapping stays an owner→duos function (one owner,
  up to six duos; never two owners for one duo) with no mapping table. Display names are `<name>'s duo` and
  `<name>'s <role> desk`. `<handle>` is the tenant id, or `root` for the pre-hosted root
  duo (which gets accounts too).
- **When.** After an invite is redeemed, before the sign-up answers, but bounded: sign-up waits a
  few seconds for Synapse and then answers regardless. A Synapse that is down, slow or refusing
  never blocks an invite. The duo is marked pending in the registry (`matrixPending`, with the
  attempt count and a scrubbed reason) and retried by a timer that checks every minute. Retries back
  off per duo: a duo that has failed n times waits one minute x 2^(n-1) after its last attempt,
  capped at 30 minutes, so a Synapse that is down or hanging costs each duo one attempt, one
  registry write and one log line per backoff, not per tick. A sweep never overlaps the previous
  one, and shutdown (`close()`) lets the duo in flight finish and starts no other.
- **Backfill.** At startup the daemon provisions every duo, and the root duo, that lacks accounts.
  `duo hosted provision` (`POST /hosted/matrix/provision`, super admin) does the same on demand
  and prints counts: provisioned, already done, pending (Synapse's fault, retried) and needs
  attention (`failed`). Both are safe to repeat: a provisioned duo costs no call, and the account
  calls are idempotent `PUT`s. One duo's unexpected error is that duo's `failed` outcome and
  a log line naming the error type; it does not stop the sweep or turn the route into a 500.
- **Needs attention.** Recorded accounts that do not fit the duo's org or the configured server
  are reported as `failed` and logged, and nothing is written or retried: the daemon never
  re-provisions over them. Fix the registry or the variable, then run `duo hosted provision`.
- **The duo's access token** is minted through the admin login API without an expiry (the
  daemon holds it for good), and stored in the registry encrypted under `DUO_HOSTED_MASTER_KEY`
  like the duo's passphrase. It is read only by `registry.duoMatrixToken(duoId)`. No route
  returns it or its ciphertext (`GET /hosted/duos` shows only the account ids and a date), it is
  not logged, and it is not in a duo's env.
- **A duo's env is an allowlist** (`TENANT_ENV_ALLOWLIST` in `src/hosted/server.ts`), no longer
  the whole process env, so `DUO_WORKSPACE_ADMIN_TOKEN` (which acts as any user),
  `DUO_HOSTED_MASTER_KEY` and `DUO_HOSTED_ADMIN_TOKEN` cannot reach a duo. The root duo keeps its
  env minus those three.
- **Not to do.** Never call `/logout/all` as `@workspace-admin`: it would expire every token the
  daemon minted. Provisioning cannot recreate a token it has lost; it mints a new one only for a
  duo that has none recorded.
- **One window it cannot close.** The token is minted by Synapse, then written to the registry:
  two steps. If the process dies between them, or the write keeps failing (a full disk), the
  token exists on the duo's account, never expires and is recorded nowhere, and the next run mints
  another. The daemon retries the write once at once (the token is already in hand, so that cannot
  double-mint) and, if it still fails, logs `minted a Matrix token for duo <id> but could not store
  it` with no token in it. When you see that line or a crash right after provisioning, revoke the
  duo account's stray tokens as an operator (Synapse admin API, that one user only, never
  `/logout/all` as `@workspace-admin`) and run `duo hosted provision` again.

Read side, for the work that builds on this (`src/hosted/registry.ts`, `src/hosted/matrix-accounts.ts`):

```ts
registry.matrixAccounts(duoId): HostedMatrixAccounts | undefined  // { personUserId, duoUserId, duoTokenCipher, provisionedAt }
registry.duoMatrixToken(duoId): string | undefined                // decrypted; daemon-internal only
registry.matrixPending(duoId): MatrixPending | undefined
hosted.matrix?.provision(duoId) / .provisionAll() / .retryPending() / .pendingDuoIds() / .stop()
```

## Workspace session for the signed-in app (added 2026-09-26, #233)

The app has no homeserver form. A signed-in person asks their own duo for a Matrix session, and the
daemon mints one for their own account and returns it with the public homeserver URL.

`POST <basePath>/workspace/session` with `Authorization: Bearer <the caller's device token>` (the one
`/hosted/login` or `/hosted/signup` returned), where `basePath` is the `basePath` of that same
`/hosted/login` or `/hosted/signup` answer: `/t/<tenantId>` for a tenant duo (so
`POST /t/<tenantId>/workspace/session`), and `""` for the root duo (`POST /workspace/session` at the
bare origin; its login answers `tenantId: null`, `basePath: ""`). The client keeps `basePath` with its
token. Like every other per-duo route, the caller is verified by that duo's own device-token auth
(its store only, a 5 second cache, evicted at once when a device is revoked, its own per-address
failure limiter), so the daemon never searches other duos for the token and nothing the caller sends
can name an account: the account is the person recorded for the duo the route is mounted on. The
body is ignored, with or without `Content-Type: application/json`. CORS as the other duo routes
(`Retry-After` is exposed). There is no `/hosted/workspace/session` any more. Source:
`src/hosted/workspace-session.ts`, `registerWorkspaceSessionRoutes` in `src/serve/server.ts`.

```jsonc
// 200, Cache-Control: no-store
{
  "homeserverUrl": "https://matrix.example.com",   // DUO_WORKSPACE_PUBLIC_URL, never the private URL
  "userId": "@<orgId>.<handle>:<server>",          // the caller's own person account
  "accessToken": "syt_...",
  "deviceId": null,                                 // admin-minted tokens have no device (below)
  "expiresAt": "2026-09-27T12:00:00.000Z"           // ISO 8601; the token stops working then
}
```

| Status | `error.code` | When |
|---|---|---|
| 401 | `unauthorized` | No bearer token, or one that is not a device of THIS duo (unknown, revoked, another duo's, an ask link). Sign in again. |
| 403 | `no_duo` | The server-side `DUO_HOSTED_ADMIN_TOKEN`: it belongs to no duo, so it has no account. A super admin's own signed-in device is a duo and works. |
| 404 | `workspace_not_configured` | No Synapse admin variables, or no `DUO_WORKSPACE_PUBLIC_URL`. Hide the workspace feature. (An unknown `/t/<id>` is the front's 404 `not_found`.) |
| 429 | `rate_limited` | This duo's auth limiter: 10 unrecognised tokens from one address within a minute. Shared with that duo's other routes, not with sign-in. |
| 503 | `workspace_pending` | The duo's accounts are not created yet (Synapse was down at sign-up; the retry timer is on it). `Retry-After: 60`. Costs Synapse no call. |
| 503 | `workspace_unavailable` | Synapse is down, slow (5 second cut-off), or refused. `Retry-After: 60`. |

Errors are `{ "error": { "code", "message" } }`, never a stack or Synapse's own text. A 401 or 429
from the duo's auth hook has the same shape. A duo whose store is unreadable (truncated) answers
its own routes with Fastify's 500, as it does for every other route; it cannot affect another duo.

`DELETE <basePath>/workspace/session` (same auth, same 401 and 404) answers `204` and drops the
token the daemon holds, so the next `POST` mints a new one. It is the client's answer to Matrix
`M_UNKNOWN_TOKEN` (it signed out, or Synapse dropped the token). A token minted less than 10 seconds
ago is kept, so a client stuck in a `DELETE`-then-`POST` loop cannot mint per turn: retry after a
few seconds.

- **Expiry, and when to call again.** Every token is minted with a 24 hour `valid_until_ms`
  (Synapse's default is a token that never expires). Call again when `expiresAt` is within an hour,
  or after `DELETE` when Matrix answers `M_UNKNOWN_TOKEN`. Schedule from `expiresAt`, not on a
  fixed interval.
- **A client loop cannot mint without bound.** A token with at least 6 hours left is handed out
  again, so a duo costs at most one mint per 18 hours plus one per daemon restart and per `DELETE`
  after the cooldown. Concurrent calls share one mint, and a failed mint is remembered for 5
  seconds so a Synapse that is down is not asked once per request. The mint has its own 5 second
  timeout (`synapseTimeoutMs` to override), not provisioning's 10.
- **The daemon keeps the token, in memory only** (never on disk or in the registry; gone on
  restart), so it can end it. When a device of the duo is revoked (`POST /t/<id>/devices/<id>/revoke`)
  or the duo is ended, it makes a best-effort Matrix `POST /_matrix/client/v3/logout` with that token
  and forgets it, so a session a revoked device was holding stops working now, not at `expiresAt`.
  The duo's other devices get `M_UNKNOWN_TOKEN` and ask again. If Synapse cannot be reached at that
  moment the token lives until `expiresAt`, and a log line records the failure by duo id.
- **No device.** Synapse creates no device for an admin-minted token, so `deviceId` is `null`.
  Creating one is only needed for end-to-end encryption, which the POC does not use.
- **Sign-out is the client's.** The client calls Matrix `POST /_matrix/client/v3/logout` with its own
  `accessToken` on `homeserverUrl`, forgets the session, and may then call `DELETE` above so the
  daemon forgets it too. If it cannot (offline, a lost device), the token stays valid until
  `expiresAt`; that bound is why the expiry is short.
- **The daemon does not probe the token.** Synapse records the address and user agent of any
  authenticated call against the token it was made with (`user_ips`, throttled to once per 2 minutes
  per token and address; checked against Synapse v1.161.0), and `whoami` is no exception. A
  probe every few seconds would have made the daemon the person's "last seen" client. So a client
  that signed out and asks again is given the same, dead, token until it calls `DELETE`.

## Org spaces (added 2026-09-26, #234)

Decision record: `hosted-workspace.md` §6.1, §12. When Synapse is configured, every org gets a
Matrix **Space** named after it and a **`#general`** room inside it, and each member's person
account and duo account are put into both. With `search_all_users: false`, sharing a room is what
makes people findable, so the org's Space is what makes an org's members findable to each other and
to nobody else. It is a place and a directory scope; the wall itself is the Synapse module (#235).

- **Both rooms are private.** They are created as `@workspace-admin` with `visibility: private`
  and the `private_chat` preset (invite-only); the client method cannot make a public room. A public
  room would put everyone in it into every org's directory search. `@workspace-admin` stays in both,
  because the admin join API needs an admin in the room.
- **Members are force-joined**, no invite to accept: `POST /_synapse/admin/v1/join/<room>` as the
  service account, once per account per room (four joins per member, each preceded by a members check). That call runs as the target
  user, so it passes through the org module like the user's own join. A member is joined only to
  their own org's rooms, and only when both account ids carry that org; a mismatch is reported as
  `failed` and nothing is joined.
- **When.** Creating an org (`POST /hosted/orgs`) makes its rooms; redeeming an invite provisions
  the accounts and then joins them; renaming an org (`POST /hosted/orgs/:id/rename`) renames the
  Space (`#general` keeps its name). Each waits a few seconds for Synapse and then answers
  regardless: an outage never blocks an org or an invite. The org or member is marked pending
  (`spacePending`, attempts and a scrubbed reason) and the same timer as the accounts retries it
  with the same backoff.
- **Idempotent.** Progress is recorded step by step (Space id, `#general` id, the link, the name
  written), so a run that dies half way resumes and a room that exists is not created again by a
  re-run. A member who is recorded in (`matrixSpaces`) costs no call. Each join first asks Synapse
  who is in the room (`GET /_synapse/admin/v1/rooms/<room>/members`) and skips an account already
  there, because the admin join API invites first and Synapse refuses that invite with
  `403 M_FORBIDDEN` for a user who is already in. A member is recorded only after all four joins, so
  a run that died after one is finished by the next without that error.
- **Room creation is deduplicated only inside Synapse's memory.** Each room is created with
  `PUT /createRoom/<txnId>` and a stable id (`org-<orgId>-space`, `org-<orgId>-general`), which makes
  Synapse return the same room to a repeat of the request by the same token for 30 minutes. That
  cache is in memory, so a Synapse restart or the 30 minutes ends it. It covers a lost response
  (a timeout, or a 5xx after Synapse made the room) and a registry write that fails, when the retry
  comes inside the window. It does not cover a retry after the window or a Synapse restart: then
  the same id makes another room, so a registry that keeps failing (or a failed write followed by a
  late retry) leaves a stray, unreferenced room per attempt. The daemon logs the id of a room it
  could not record, so an operator can find and delete it; a room whose response was lost past the
  window has no logged id and is found by name among the service account's rooms.
- **Only the service account can invite.** The `private_chat` preset lets any member invite
  (`invite: 0`), so both rooms are created with `invite: 100` (and `events_default: 100` on the
  Space, so members cannot post there). This is a second lock: the org module (#235,
  `railway.md`, "The org wall module") refuses a cross-org invite whatever the power levels say, and
  refuses the admin-API join of another org's account into these rooms. The service account, who holds
  100 as the creator, is unaffected: it still joins members and sends `m.space.child` and `m.room.name`.
- **Backfill.** Startup and `duo hosted provision` (`POST /hosted/matrix/provision`) run the
  accounts first and then the spaces, for every org (the default org included, even when empty),
  every member, and the root duo. The answer keeps its old fields and gains `spaces`: org counts,
  member counts (`waiting` is a member whose accounts are still owed) and per-item status.

Registry fields (all optional, on a v2 file, so older builds and older files are unaffected):
`orgs[].spaceRoomId`, `generalRoomId`, `spaceSyncedName`, `generalLinked`, `spacePending`;
`tenants[].matrixSpaces` (`{ spaceRoomId, generalRoomId, joinedAt }`), `spacePending`;
top level `rootMatrixSpaces`, `rootSpacePending`.

```ts
registry.org(orgId)?.spaceRoomId / .generalRoomId              // an org's Space and #general
registry.matrixSpaces(duoId) / registry.spacePending(duoId)
hosted.spaces?.ensureOrg(orgId) / .syncMember(duoId) / .syncAll() / .retryPending() / .hasRetryDue()
```

## Each duo's own workspace connection (added 2026-09-26, #236)

Decision record: `hosted-workspace.md` §8, §12. Every hosted duo (each tenant, and the root duo) whose Matrix
accounts are provisioned holds ONE outbound connection to the workspace, as its own account
(`@duo-<orgId>.<handle>:<server>`), and answers there exactly as a `duo serve` duo does: from its own
corpus, with the same outcomes (answered, passed on, declined), and a passed-on question waits in that
owner's Escalations. Source: `src/hosted/duo-workspace.ts` (`DuoWorkspaceConnections`), the per-duo service
in `src/serve/workspace-wiring.ts` (the same function `duo serve` builds its service with).

- **Credentials are the duo's, from the registry.** The token is `registry.duoMatrixToken(duoId)`, read
  when the connection starts and held only by that duo's service. The homeserver is
  `DUO_WORKSPACE_PRIVATE_URL` (https, or http on `*.railway.internal`; the same rule as `duo serve`'s
  `DUO_WORKSPACE_HOMESERVER`, which hosted mode ignores along with `DUO_WORKSPACE_ACCESS_TOKEN` and
  `DUO_WORKSPACE_USER_ID`). The timing knobs and the backlog policy (`DUO_WORKSPACE_RECONNECT_*`,
  `DUO_WORKSPACE_PRESENCE_INTERVAL_MS`, `DUO_WORKSPACE_BACKLOG_MAX_AGE_MS`,
  `DUO_WORKSPACE_MAX_ANSWERS_PER_MINUTE`) are shared by all duos, and a bad one refuses to boot.
- **Lifecycle follows the registry.** The daemon subscribes to the registry's writes
  (`registry.onChange`) and re-checks every duo on each one: accounts appear (after #232 provisioning, at
  boot or later, including a sign-up that outran Synapse), the connection starts; the token is re-minted
  (`setMatrixAccounts` again), it restarts on the new token; the accounts go, it stops. `close()` stops
  every connection. `DuoWorkspaceConnections.detach(duoId)` stops one duo's (there is no duo-removal route
  yet). A token Synapse refuses (`M_UNKNOWN_TOKEN`) ends that duo's connection, with a log line, and the
  dead credential is never retried. It comes back on a new token: see **Recovery** below.
- **Never on the boot path.** Reconciling only queues. Building a duo's service (it decrypts that duo's
  store once) and dialing happen later off a timer, one duo at a time, so a Synapse that is down or slow
  costs the listener, sign-up and invite redemption nothing.
- **A cap and a stagger on every dial.** At most `DUO_HOSTED_WORKSPACE_MAX_DIALS` duos (default 5) are
  dialing at once, and dials start at least `DUO_HOSTED_WORKSPACE_STAGGER_MS` (default 500) apart, so 100
  duos at boot make a trickle of 2 new sessions a second, not a burst. This holds for reconnects as well as
  first dials: each reconnect rebuilds the client and runs a full initial sync, so a Synapse restart that
  drops every duo at once sends them back through the same slots, in order. A duo gives its slot back when
  its attempt connects, fails, is refused, or has held it 30 seconds. Between attempts the service's own
  backoff applies, with a fixed per-duo jitter (x1.0 to x1.5 on the delays).
- **Recovery.** Two failures heal without a restart, each on a jittered, capped backoff (one minute, doubling
  to thirty, x1.0 to x1.5 per duo). (1) A duo whose service cannot be built (a store that will not open, a full
  disk) is `failed`, logged with the scrubbed error message, and tried again. (2) A duo Synapse refuses
  (`revoked`: its Synapse database was reset or restored from before the token was minted) is given a
  fresh never-expiring token by the daemon (`MatrixProvisioner.remintToken`: both accounts are put again, a
  token is minted, stored encrypted in the registry, and the write restarts the connection). It tries at
  most 5 times until a token connects, then logs that an admin must act. An admin can do it at once with
  `duo hosted provision --remint <duoId>` (`POST /hosted/matrix/remint {duoId}`, admin token); this
  does not end the old token on Synapse, so on a duo that still works it leaves the old one valid there. The
  room joins of a reset Synapse (`#234`) are not redone by a re-mint; run `duo hosted provision` after it.
- **Isolated.** Each duo has its own service, transport, backoff, read state and consent record, and all
  work on a duo runs on that duo's own chain: one duo's failure or hang waits on nothing of another's. A
  duo whose store cannot be opened is `failed` alone. Two duos never share a corpus, a log, a member cache
  or an answer path.
- **Logs name the duo and never the token.** Every line is `hosted: duo <id>: ...`, and the duo's token (and
  anything shaped like a Matrix access token) is replaced with `[redacted]` before a line leaves.
  matrix-js-sdk's logging is silent by default (it is process-wide, verbose, and cannot name a duo);
  `DUO_HOSTED_WORKSPACE_SDK_LOG` raises it, and what the SDK client then logs goes through the same
  per-duo, scrubbed log as every other line, as `matrix sdk <level>: ...`. **What this does not cover:**
  matrix-js-sdk 42.4.0 still calls its process-wide logger directly from `models/room.js`,
  `models/event.js`, `models/event-timeline-set.js` and `sync.js`. Those lines (a room's state warnings,
  sync notices) cannot name a duo, are not filtered by this variable and are not scrubbed. They carry room
  and event ids and SDK messages, not the access token (the SDK sends the token only in a header), but
  treat the daemon's stdout as sensitive and do not rely on the scrub for them.
- **Observable.** `GET /hosted/duos` (admin) adds `workspace: { phase, attempts }` per duo: `none` (no
  accounts yet), `queued`, `connecting`, `connected`, `revoked` (Synapse refused the token; being re-minted),
  `stopped`, or `failed` (its store would not open; being retried). It comes from the daemon's memory and carries no token.
- **The owner's consent routes work per duo.** `GET /t/<id>/workspace/invites` and the allow/refuse/withdraw
  routes act on that duo's own service (`deps.workspace` is a live view, undefined until the duo has one).
  As on a personal daemon, a duo joins a room only on its owner's explicit allow: a colleague who starts a
  direct room with `@duo-...` creates an invitation the owner decides on; nothing auto-joins.
- **Off switch.** `DUO_HOSTED_WORKSPACE_CONNECT=0` provisions accounts as before but opens no connection.
  Only `1`, `true`, `on`, `yes` (or empty) and `0`, `false`, `off`, `no` are accepted, in any case; any other
  value refuses to boot, so a typo cannot leave the connections on while you think they are off.

```ts
hosted.workspace?.states(): DuoConnectionState[]          // { duoId, userId, phase, attempts }, no token
hosted.workspace?.serviceFor(duoId): WorkspaceService | undefined
hosted.workspace?.attach(duoId, duo) / .detach(duoId) / .reconcile() / .stop()
registry.onChange(listener): () => void                   // called after every registry write that lands
```

Resource numbers for N connections in one process are in `hosted-workspace.md` §8.

## Ending a duo (#275)

`duo hosted end <duoId>` removes a hosted duo for good — a test tenant left over from verification, or any
duo an operator has decided to remove. Super admin only (`requireAdmin`, like every other `duo hosted ...`
command): the server-side admin token or a super admin's own signed-in device.

```sh
duo hosted end <duoId>     # find duoId with `duo hosted org members <orgId>` (`duo hosted org list` for the org ids)
```

In order:

1. **Both Matrix accounts are deactivated** (`SynapseAdmin.deactivateUser`, `POST
   /_synapse/admin/v1/deactivate/<user_id>`) with `erase: true` — a hosted duo is always a throwaway/managed
   account, never one a person could want reinstated later, so this is the right call every time, not a
   suspension. Deactivation revokes every access token the account held and parts it from every room it was
   in, which is how it disappears from its org's Space, `#general`, and any other room, with no separate
   call. An account Synapse has never heard of (404) is read as already gone, not a failure.
2. **Its live workspace connection, if any, is dropped** (`DuoWorkspaceConnections.detach`) right away,
   rather than left for the next registry-change sweep to notice.
3. **Its registry entry is removed** (`HostedRegistry.removeTenant`): the encrypted passphrase, the Matrix
   account records and the token cipher, and so its row in `duo hosted org members <orgId>`. Its redeemed
   invite, if any, is left as historical record (same as every other append-only log here) — it just points
   at an id nothing answers to any more.
4. **Its mounted app is unmounted**: `/t/<duoId>/...` answers 404 immediately, not only after a restart.

**Never blocked by Synapse.** A deactivation Synapse refuses for a reason other than 404 (an outage, a
wrong admin token) is reported back (`errors: [...]`) but does not stop the registry entry from being
removed — a duo that cannot be reached must not become impossible to remove from the roster. Run `duo
hosted end <duoId>` again once Synapse is reachable to retry the Matrix side; the registry half is already
done and is itself idempotent.

**Refuses the root duo** with a clear `root_not_endable` error: it is not a tenant and is never disposable.

**Idempotent.** Ending a duo already ended, or one that never existed, answers `{ found: false, ... }` —
not an error — so the command is safe to re-run.

```ts
POST /hosted/duos/:duoId/end   // admin token or a super admin's device; 400 for the root duo
// -> { duoId, found, deactivated: { person, duo }, errors: string[] }  — never a token
```

## Variables (in addition to `railway.md`'s)

| Variable | What |
|---|---|
| `DUO_HOSTED_MASTER_KEY` | Encrypts every duo's passphrase in the registry. Losing it loses every hosted duo. |
| `DUO_HOSTED_ADMIN_TOKEN` | Authorises minting invites. |
| `DUO_HOSTED_PUBLIC_URL` | The daemon's public origin, used to build invite links. |
| `DUO_HOSTED_WEB_URL` | The web app's origin, used to build invite links. |
| `DUO_HOSTED_ROOT` | Optional. Defaults to `hosted` (under the volume). |
| `DUO_HOSTED_GOOGLE_CLIENT_ID` | The Google OAuth web client id. Public, not a secret. |
| `DUO_HOSTED_ADMIN_EMAILS` | Comma-separated admin Google emails. |
| `DUO_WORKSPACE_PRIVATE_URL` | Synapse as the daemon reaches it, e.g. `http://synapse.railway.internal:8008` (https, or http on a `*.railway.internal` host). With `DUO_WORKSPACE_ADMIN_TOKEN` it turns provisioning on; one without the other refuses to start. |
| `DUO_WORKSPACE_ADMIN_TOKEN` | The `@workspace-admin` service account's token. Acts as any user: never in a duo's env, a route or a log. |
| `DUO_WORKSPACE_SERVER_NAME` | Optional. Synapse's `server_name` (`duo`). When unset it is read from the admin token's own user id. |
| `DUO_WORKSPACE_PUBLIC_URL` | The https address clients are given for Synapse, returned as `homeserverUrl` by `POST <basePath>/workspace/session`. Without it that route answers 404. |
| `DUO_HOSTED_WORKSPACE_CONNECT` | Optional. `0`, `false`, `off` or `no` stops hosted duos opening workspace connections (accounts are still provisioned); `1`, `true`, `on`, `yes` or empty leaves them on (the default, whenever the Synapse variables are set). Anything else refuses to boot. Case-insensitive. |
| `DUO_HOSTED_WORKSPACE_MAX_DIALS` | Optional. How many duos may be dialing (first dials and reconnects) at once. Whole number of at least 1. Default 5. |
| `DUO_HOSTED_WORKSPACE_STAGGER_MS` | Optional. Least time between two duos starting to dial. 0 or more. Default 500. |
| `DUO_HOSTED_WORKSPACE_SDK_LOG` | Optional. `silent` (default), `error`, `warn`, `info`, `debug` or `trace`: how much of the matrix-js-sdk client's logging is let through, into the duo's own scrubbed log. The SDK's process-wide logger is not covered (see above). For debugging a real Synapse. |
| `DUO_WORKSPACE_RECONNECT_INITIAL_MS`, `_RECONNECT_MAX_MS`, `_PRESENCE_INTERVAL_MS`, `_BACKLOG_MAX_AGE_MS`, `_MAX_ANSWERS_PER_MINUTE` | The `duo serve` timing and backlog knobs; every hosted duo's connection uses them (defaults 1 s, 60 s, 4 min, 1 h, 30). |

## Inviting someone

```sh
railway ssh -i ~/.ssh/railway_ed25519 -s duo-daemon
duo hosted invite "Sam"          # prints a single-use link, valid 7 days
```

Sam opens the link, types his name, and lands in onboarding with his own duo.

## Orgs from the terminal

```sh
duo hosted org create "Platform team"          # prints the new org's id
duo hosted org list                            # id, name, member count
duo hosted org rename <id> "Platform"
duo hosted org members <id>                    # role marks: super admin, org admin (who appointed, when)
duo hosted org admin grant <orgId> <duoId>     # appoint an org admin (super admin power)
duo hosted org admin revoke <orgId> <duoId>    # revoke one, even an org's last
duo hosted invite "Kim" --org <id>             # without --org: the default org
```

```sh
duo hosted provision                           # create any Matrix accounts, org Spaces and member joins still missing; safe to repeat
```

```sh
duo hosted end <duoId>                         # end a duo for good: deactivates its Matrix accounts, drops its registry entry; see "Ending a duo" above
```

Like `invite`, these talk to the running daemon with `DUO_HOSTED_ADMIN_TOKEN`.
