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

Like `invite`, these talk to the running daemon with `DUO_HOSTED_ADMIN_TOKEN`.
