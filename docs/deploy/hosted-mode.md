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
