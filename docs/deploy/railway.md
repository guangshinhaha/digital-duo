# Deploying on Railway (POC)

> A proof-of-concept deploy so the owner can use the duo day to day. It runs on third-party
> infrastructure (Railway) with hosted inference (OpenRouter). That is org mode's shape
> (`docs/workspace/org-mode-deployment.md`) with Railway as the operator, and it waives
> `v1-tech-design.md` §1.1 for this deployment. The owner accepted this for the POC on
> 2026-09-26.

## Shape

One Railway project, three services, two repos:

| Service | Source | Public? | What it is |
|---|---|---|---|
| `duo-daemon` | `guangshinhaha/digital-duo` (root) | yes, HTTPS | `duo serve`, with a volume at `/data` |
| `ollama` | `guangshinhaha/digital-duo`, root dir `deploy/ollama` | **no** (private network only) | `nomic-embed-text` embeddings on CPU, volume at `/root/.ollama` |
| `duo-web` | `guangshinhaha/duo` (root) | yes, HTTPS | The static web client (Caddy) |

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

## Connect to claude.ai (save from any chat)

The daemon serves an MCP endpoint at `/mcp/<secret>`; the secret is the credential. Mint the URL from a
shell on the daemon:

```sh
railway ssh --service duo-daemon -i ~/.ssh/railway_ed25519
duo connector new       # prints the URL once; a new one replaces the old
```

Then in claude.ai: Settings, Connectors, Add custom connector, paste the URL. In any chat, ask Claude to
"save this to my duo". Claude calls `save_to_duo`; the text is ingested under the duo's classification
ceiling and embedded before Claude answers.

- To feed past chats: after adding the connector, paste the prompt from `GET /connector` (`historyPrompt`) into
  a claude.ai chat. Claude searches your past chats (paid plans) and saves notes with `save_notes_to_duo`, up
  to 50 per call. The notes are Claude's summaries, not exact copies, and only identical text is recognised as
  already saved, so continue from the date range Claude reports rather than re-running the same range.
- The URL is a password. Anyone holding it can write to that duo. Treat a leak by running `duo connector new`.
- Hosted duos use `/t/<duo-id>/mcp/<secret>`, and a secret only ever works for the duo that minted it.
- The app can mint the same URL: `POST /connector` returns `{ path }` once; join it to the duo's base URL.
- This is the POC credential. Replace it with OAuth before anyone other than the owner connects.

## Backups and cost

- Back up the `/data` volume (Railway volume backups). The backup is ciphertext and is useless
  without `DUO_PASSPHRASE`.
- Each draft makes several completions, because it samples 3 times for self-consistency
  (`DUO_CONFIDENCE_SELF_CONSISTENCY_SAMPLES`). Set a credit limit on the OpenRouter key.
