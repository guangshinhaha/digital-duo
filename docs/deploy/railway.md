# Deploying on Railway (POC)

> A proof-of-concept deploy so the owner can use the duo day to day. It runs on third-party
> infrastructure (Railway) with hosted inference (OpenRouter). That is org mode's shape
> (`docs/workspace/org-mode-deployment.md`) with Railway as the operator, and it waives
> `v1-tech-design.md` §1.1 for this deployment. The owner accepted this for the POC on
> 2026-09-26.

## Shape

One Railway project, five services, two repos:

| Service | Source | Public? | What it is |
|---|---|---|---|
| `duo-daemon` | `guangshinhaha/digital-duo` (root) | yes, HTTPS | `duo serve`, with a volume at `/data` |
| `ollama` | `guangshinhaha/digital-duo`, root dir `deploy/ollama` | **no** (private network only) | `nomic-embed-text` embeddings on CPU, volume at `/root/.ollama` |
| `duo-web` | `guangshinhaha/duo` (root) | yes, HTTPS | The static web client (Caddy) |
| `synapse` | `guangshinhaha/digital-duo`, root dir `deploy/synapse` | yes, HTTPS (the client listener: client API and `/_synapse/admin`; no federation) | The Matrix homeserver for the hosted workspace, media on a volume at `/data` |
| `Postgres` | Railway's PostgreSQL template | **no** (private network only) | Synapse's database, volume at `/var/lib/postgresql/data` |

`synapse` and `Postgres` are the hosted workspace's message store ("Synapse and Postgres" below).
The repos stay independent. The web client learns the daemon's URL only at pairing time, on its
Setup screen, and the daemon allows the web client's origin via `DUO_CORS_ORIGINS`.

Railway's edge terminates TLS and is the only inbound path, so the daemon binds `::` with
`--behind-proxy` (`deploy/start.sh`). Without that flag, a wildcard bind is still refused.

## Daemon variables (`duo-daemon`)

| Variable | Value |
|---|---|
| `DUO_PASSPHRASE` | A long random secret. It encrypts the store. **Keep a copy elsewhere:** losing it loses the store. |
| `DUO_PROVIDER` | `openrouter` |
| `DUO_OPENROUTER_API_KEY` | Your OpenRouter key |
| `DUO_OPENROUTER_MODEL` | Optional. Defaults to `openrouter/auto` (OpenRouter picks the model per prompt). |
| `DUO_OLLAMA_HOST` | `http://${{ollama.RAILWAY_PRIVATE_DOMAIN}}:11434` |
| `DUO_OLLAMA_NUM_THREAD` | The `ollama` service's vCPU limit, e.g. `4`. Ollama sizes its threads to the host's 48 cores, not the container's quota, and the throttling makes each embedding take 15–30s (the "Ollama unreachable … timeout" on the Embed step). |
| `DUO_CORS_ORIGINS` | `https://${{duo-web.RAILWAY_PUBLIC_DOMAIN}}` |
| `DUO_OWNER_NAME` | Your name, as public answers attribute it |

### Hosted mode and Matrix (optional)

Only when the daemon serves a multi-org hosted workspace with a Synapse next to it
(`hosted-mode.md`, `hosted-workspace.md`). Set the first two together; one without the other
refuses to start.

| Variable | What it does |
|---|---|
| `DUO_WORKSPACE_PRIVATE_URL` | Where the daemon reaches Synapse, on the private network: `http://synapse.railway.internal:8008` (https, or http on a `*.railway.internal` host). Used for the admin API only. |
| `DUO_WORKSPACE_ADMIN_TOKEN` | The `@workspace-admin` service account's access token. It acts as any user, so keep it in the daemon's variables only and never share it with a duo. |
| `DUO_WORKSPACE_SERVER_NAME` | Optional. Synapse's `server_name` (`duo`). Unset, the daemon reads it from the admin token's own user id. It is permanent once accounts exist. |
| `DUO_WORKSPACE_PUBLIC_URL` | The https address clients are given for Synapse. It is not used to call Synapse. |

Volume: mount at `/data`. The store (`data/duo.db`), the derived `duo/` files and the runtime logs
all live there. The container `cd`s into the volume, and `duo` on its PATH does the same.

## First use

```sh
railway ssh --service duo-daemon       # a shell in the running daemon
duo status                             # provider = openrouter, store exists
duo ask "say hi"                       # proves the OpenRouter key works
duo pair new "my-laptop"               # prints a device token ONCE
```

Open the `duo-web` URL, paste the daemon's `https://…up.railway.app` URL and the token on Setup.

### Building the duo from your history

- **From the app:** Onboarding accepts a pasted `Human:`/`Assistant:` transcript and runs the
  embed job.
- **From a Claude export:** copy `conversations.json` onto the volume, then run
  `duo import claude /data/conversations.json` and `duo embed` in `railway ssh`.

Then derive (terminal only, since the daemon has no route for it):

```sh
duo derive pairs && duo derive topics && duo derive rules && duo derive voice
```

**One writer at a time** (README "Known limitations"): the CLI and the running daemon each write
the whole store file. Don't use the app while a `duo import`, `duo embed` or `duo derive` runs.

## Backups and cost

- Back up the `/data` volume (Railway volume backups). The backup is ciphertext and is useless
  without `DUO_PASSPHRASE`.
- Each draft makes several completions, because it samples 3 times for self-consistency
  (`DUO_CONFIDENCE_SELF_CONSISTENCY_SAMPLES`). Set a credit limit on the OpenRouter key.

## Synapse and Postgres (hosted workspace)

The hosted workspace's Matrix homeserver (decision record `docs/deploy/hosted-workspace.md`,
#229). One Synapse for every org, federation off. `duo-daemon` provisions accounts through its
admin API; clients talk to its public client API. Nothing about it is reachable by other
homeservers.

### Services, volumes, domains

| Service | Volume | Domain |
|---|---|---|
| `synapse` (image `matrixdotorg/synapse`, tag pinned in `deploy/synapse/Dockerfile`) | `synapse-volume` at `/data`: `media_store/` and `signing.key` | public `https://<generated>.up.railway.app` (target port 8008); private `http://synapse.railway.internal:8008` |
| `Postgres` | `postgres-volume` at `/var/lib/postgresql/data` | private only, `postgres.railway.internal:5432` |

The `duo-daemon` reaches Synapse over the **private** URL for the admin API; clients use the
**public** URL. `homeserver.yaml` is not in the repo as a fixed file: `deploy/synapse/start.sh`
renders it from env at every boot (`render_config.py`), after `ensure_db.py` has created the
`synapse` database with the `C` collation Synapse insists on (Railway's Postgres ships only its
default database, so it is made from `template0` the first time; it waits up to about a minute
for Postgres to accept connections, so a slower Postgres does not use up Railway's restart
retries). Synapse itself does **not** run as root: `start.sh` does the setup as root, chowns `/data`,
`/etc/synapse` and the secret file to `991:991` and starts Synapse with `gosu 991:991`, as the base
image's own `/start.py` would. The rendered config, in short:

- **Federation off.** `federation_domain_whitelist: []`, no `federation` listener resource (the
  federation and key routes answer 404), no key servers.
- **Closed.** `enable_registration: false`. `user_directory.search_all_users: false`;
  `require_auth_for_profile_requests` and `limit_profile_requests_to_users_who_share_rooms` on,
  `include_profile_data_on_invite` off (the org walls, `hosted-workspace.md` §11).
- **Generous rate limits** (`rc_message`, `rc_registration`, `rc_joins*`, `rc_invites`: 1000/s,
  burst 10000) so provisioning bursts and many duos' sync traffic are not throttled. `rc_login`
  stays at Synapse's defaults on purpose: the service account's password is the only one on the
  server and failed-login throttling protects it.
- **Postgres backend**, media and signing key on the volume, one client listener bound to `::`
  (Railway's private network is IPv6) with `x_forwarded` (Railway's edge terminates TLS).

Deploy or update it from a checkout, the same way `ollama` is deployed (no GitHub source is
connected): `cd deploy/synapse && railway up --service synapse --detach`.

### `synapse` variables

| Variable | Value |
|---|---|
| `SYNAPSE_SERVER_NAME` | `duo`. **Permanent**: it is baked into every Matrix user id (`@workspace-admin:duo`). Changing it means a new server. |
| `SYNAPSE_PUBLIC_BASEURL` | `https://${{RAILWAY_PUBLIC_DOMAIN}}` |
| `PORT` | `8008` (the listener port and the domain's target port) |
| `SYNAPSE_REGISTRATION_SHARED_SECRET` | **Set only for the one-time bootstrap, then unset.** A random secret (`openssl rand -hex 32`). It is admin-equivalent: it can create admin accounts even with `enable_registration: false`. With it unset the shared-secret API is off. Rendered into a `0600` file inside the container, never into `homeserver.yaml`. Currently unset. |
| `SYNAPSE_ADMIN_PASSWORD` | A long random secret (`openssl rand -hex 32`; `create_admin.py` refuses anything under 32 characters). The password of `@workspace-admin`, the one account that has one. Kept permanently, unlike the record's "discarded" (`hosted-workspace.md` §5, dated note): it is how a fresh token is minted (below). |
| `SYNAPSE_DB_HOST` / `_PORT` / `_USER` / `_PASSWORD` | `${{Postgres.RAILWAY_PRIVATE_DOMAIN}}`, `5432`, `${{Postgres.PGUSER}}`, `${{Postgres.PGPASSWORD}}` |
| `SYNAPSE_DB_ADMIN_DATABASE` | `${{Postgres.PGDATABASE}}`: the service's default database, connected to once to create Synapse's |
| `SYNAPSE_DB_NAME` | `synapse` |
| `SYNAPSE_MAX_UPLOAD_SIZE`, `SYNAPSE_LOG_LEVEL`, `SYNAPSE_DB_SSLMODE` | Optional. Defaults `50M`, `INFO`, `prefer`. |

### `duo-daemon` variables added for the workspace

| Variable | Value | Used for |
|---|---|---|
| `DUO_WORKSPACE_ADMIN_TOKEN` | The `@workspace-admin:duo` access token | The admin API (below). The only Synapse admin. |
| `DUO_WORKSPACE_PRIVATE_URL` | `http://${{synapse.RAILWAY_PRIVATE_DOMAIN}}:8008` | The daemon's calls to the admin API |
| `DUO_WORKSPACE_PUBLIC_URL` | `https://${{synapse.RAILWAY_PUBLIC_DOMAIN}}` | The homeserver URL handed to clients |

These were set with `--skip-deploys`, so they take effect at the daemon's next deploy.
**`DUO_WORKSPACE_HOMESERVER` is deliberately not set yet.** `duo serve` reads it with
`DUO_WORKSPACE_ACCESS_TOKEN` and `DUO_WORKSPACE_USER_ID` as an all-or-nothing trio and refuses to
boot on a partial set, and it requires `https`, which the private URL is not. Hosted mode
switches to `DUO_WORKSPACE_HOMESERVER` (the private URL) in #232; until then the daemon must
not have it set.

### The admin API and its credential

`@workspace-admin:duo` is the single Synapse admin. The daemon authenticates with
`Authorization: Bearer $DUO_WORKSPACE_ADMIN_TOKEN` on `${DUO_WORKSPACE_PRIVATE_URL}/_synapse/admin/…`
(`docs/deploy/hosted-workspace.md` §5 lists the calls). Do not call `/logout/all` as this
account: it invalidates every token it minted.

Bootstrap (once, on a fresh server), from inside Synapse. The token is the only line printed:

1. Set `SYNAPSE_ADMIN_PASSWORD` and `SYNAPSE_REGISTRATION_SHARED_SECRET` on `synapse` (random,
   `openssl rand -hex 32`) and redeploy it.
2. `railway ssh --service synapse -- python /create_admin.py` registers `@workspace-admin`
   through the shared-secret API (`POST /_synapse/admin/v1/register`, HMAC of a nonce) and prints
   its access token. `login-as-user` cannot mint a token for the caller itself, which is why
   this account is registered rather than created by the admin API.
3. Put the token in `DUO_WORKSPACE_ADMIN_TOKEN` on `duo-daemon`, and nowhere else.
4. **Unset `SYNAPSE_REGISTRATION_SHARED_SECRET` and redeploy `synapse`.** (`railway variable
   delete` alone does not redeploy.) Unset, `POST /_synapse/admin/v1/register` answers `400
   Shared secret registration is not enabled`; `enable_registration: false` does not do that.

To mint a fresh token later (rotation, or a lost one), run the same command: with the secret
unset it logs in with `SYNAPSE_ADMIN_PASSWORD` instead. Set the new token on `duo-daemon`, then
log the old one out (`POST /_matrix/client/v3/logout` with it). This account is the one
exception to "nobody has a password": its password exists only in that Synapse variable. Password
login is on the public listener, which is why the value must be long and random. If the shared
secret is not set (or the service was not restarted since it was), `create_admin.py` says
"shared-secret registration is not enabled" instead of registering.

**The admin API is on the public domain too.** Synapse serves `/_synapse/admin` from the same
client listener as the client API, and Railway's edge cannot filter paths, so it answers on the
public URL (unauthenticated calls get `401`). Its protection is the strength of the token and
the shared secret. Filtering it needs a path-filtering proxy in front (not done for the POC).

### Checking it

```sh
curl -s https://<synapse-domain>/_matrix/client/versions                # 200, versions list
curl -s -o /dev/null -w '%{http_code}\n' https://<synapse-domain>/_matrix/federation/v1/version   # 404
curl -s -o /dev/null -w '%{http_code}\n' https://<synapse-domain>/_synapse/admin/v2/users         # 401 without a token
```

From the daemon (its image has no `curl`), over the private network:

```sh
railway ssh --service duo-daemon -- node -e "fetch(process.env.DUO_WORKSPACE_PRIVATE_URL+'/_synapse/admin/v2/users?limit=1',{headers:{authorization:'Bearer '+process.env.DUO_WORKSPACE_ADMIN_TOKEN}}).then(r=>console.log(r.status))"
```

`200` means the private network, the token and the admin flag all work. (A running daemon only
sees `DUO_WORKSPACE_*` once it has been redeployed after they were set.)

### Backups and redeploys

- **Two stores, back up both together.** Postgres holds accounts, rooms and messages; the
  `synapse-volume` holds the media and `signing.key`. Use Railway volume backups on
  `postgres-volume` and `synapse-volume` (Postgres also has point-in-time recovery: `railway
  postgres`). A database restored without the matching media (or the reverse) leaves dangling
  references. Losing `signing.key` changes the server's signing identity (Synapse would generate a new
  one); keep it in the volume backup.
- **Redeploys are safe.** Both stores live on volumes, `start.sh` is idempotent (`ensure_db.py`
  is a no-op once the database exists), and the config is re-rendered from env each boot. Verified
  on 2026-09-26: after a redeploy the admin account, its token, the signing key and an uploaded
  media file were all intact.
  The first boot of the image that drops to `991:991` chowns the existing (root-owned) volume
  contents once, recursively; check the media and the login still work after it.
- **Upgrading Synapse:** bump the tag in `deploy/synapse/Dockerfile` and `railway up`. Synapse
  migrates its schema on start and does not support downgrades: take a Postgres backup first.
- `SYNAPSE_ADMIN_PASSWORD` lives only in that Railway variable; if it is lost, the account
  cannot be logged into again (set the shared secret and register a differently named admin, or
  reset the password in the database).
