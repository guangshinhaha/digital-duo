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

## Sign-in (added 2026-09-26)

- **Google sign-in, bound once.** With `DUO_HOSTED_GOOGLE_CLIENT_ID` set, redeeming an invite
  requires a Google sign-in. The duo is bound to that account's stable subject id, one duo per
  account. `POST /hosted/login` with a Google ID token then mints a fresh device token on any
  browser. That device shows up in the duo's device list and can be revoked like any other.
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
  list. Org-admin routes answer 401 with no credential and 403 for any other caller (a garbage
  or revoked token is a 403 too). Org admins who are not the super admin, and deleting an org,
  are out of scope (follow-ups).
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
| `POST /hosted/orgs/:orgId/rename` `{ name }` | rename; 404 for an unknown org |
| `GET /hosted/orgs/:orgId/members` | `[{ duoId, name, email, isRoot, joinedAt, isAdmin }]` |
| `POST /hosted/invites` `{ name, orgId?, email?, expiresInHours? }` | as before, plus the org |

`duoId` is the tenant id, or `root` for the pre-hosted root duo.

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

- **Names** carry the org: the person is `@<orgId>.<handle>:<server>`, their duo
  `@duo-<orgId>.<handle>:<server>`. `<handle>` is the tenant id, or `root` for the pre-hosted root
  duo (which gets accounts too). Display names are the person's name (from the Google profile
  when there is one) and `<name>'s duo`.
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

The app has no homeserver form. A signed-in person asks the daemon for a Matrix session, and the
daemon mints one for their own account and returns it with the public homeserver URL.

`POST /hosted/workspace/session` with `Authorization: Bearer <the caller's device token>` (the one
`/hosted/login` or `/hosted/signup` returned). The body is ignored: nothing the caller sends can
name an account. CORS as the other `/hosted/*` routes. Source: `src/hosted/workspace-session.ts`.

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
| 401 | `unauthorized` | No bearer token, or one that is no duo's device (unknown or revoked). Sign in again. |
| 403 | `no_duo` | The server-side `DUO_HOSTED_ADMIN_TOKEN`: it belongs to no duo, so it has no account. A super admin's own signed-in device is a duo and works. |
| 404 | `workspace_not_configured` | No Synapse admin variables, or no `DUO_WORKSPACE_PUBLIC_URL`. Hide the workspace feature. |
| 429 | `rate_limited` | Too many unrecognised tokens from this address (the sign-in limiter: 10 per 15 minutes). |
| 503 | `workspace_pending` | The duo's accounts are not created yet (Synapse was down at sign-up; the retry timer is on it). `Retry-After: 60`. Costs Synapse no call. |
| 503 | `workspace_unavailable` | Synapse is down, slow (5 second cut-off), or refused. `Retry-After: 60`. |

Errors are `{ "error": { "code", "message" } }`, never a stack or Synapse's own text.

- **Own account only.** The caller is identified by the device token alone (the root duo's store,
  then each tenant's), and the account is the person id recorded for that duo. The route never
  reads the duo's token and takes no `userId` or `duoId`. A recorded person id that is a `duo-`
  account or the service account is refused. The identity lookup is cached for 5 seconds, the
  same window as a duo's own auth, so a revoked device stops opening sessions within seconds.
- **Expiry, and when to call again.** Every token is minted with a 24 hour `valid_until_ms`
  (Synapse's default is a token that never expires, and the daemon cannot revoke one it did not
  keep). Call again when `expiresAt` is within an hour, or when Matrix answers `M_UNKNOWN_TOKEN`.
  Schedule from `expiresAt`, not on a fixed interval.
- **A client loop cannot mint without bound.** A token with at least 6 hours left is handed out
  again, kept in daemon memory only (never on disk or in the registry), so a duo costs at most
  one mint per 18 hours plus one per daemon restart. Concurrent calls share one mint, and a failed
  mint is remembered for 5 seconds so a Synapse that is down is not asked once per request.
  Unrecognised tokens count against the caller's address. The mint has its own 5 second timeout
  (`synapseTimeoutMs` to override), not provisioning's 10.
- **No device.** Synapse creates no device for an admin-minted token, so `deviceId` is `null`.
  Creating one is only needed for end-to-end encryption, which the POC does not use.
- **Sign-out is the client's.** The daemon cannot revoke a person's token: Synapse's only ways
  are `/logout` with that token, or `/logout/all` as the service account, which would expire every
  token the daemon minted. So sign-out means the client calls Matrix `POST /_matrix/client/v3/logout`
  with its own `accessToken` on `homeserverUrl`, then forgets the session. If it cannot (offline, a
  lost device), the token stays valid until `expiresAt`; that bound is why the expiry is short.
- **A signed-out token is not handed out again.** The daemon never sees the client's `/logout`, so
  before reusing a token it asks Synapse (`whoami` as that token, a read) at most once per 5
  seconds, and replaces one Synapse no longer accepts. A client that signs out and asks again
  within those 5 seconds can be given the token it just signed out; if Matrix answers
  `M_UNKNOWN_TOKEN` it should ask again. If Synapse cannot be asked, the cached token is returned.

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
| `DUO_WORKSPACE_PUBLIC_URL` | The https address clients are given for Synapse, returned as `homeserverUrl` by `POST /hosted/workspace/session`. Without it that route answers 404. |

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
duo hosted org members <id>
duo hosted invite "Kim" --org <id>             # without --org: the default org
```

```sh
duo hosted provision                           # create any Matrix accounts still missing; safe to repeat
```

Like `invite`, these talk to the running daemon with `DUO_HOSTED_ADMIN_TOKEN`.
