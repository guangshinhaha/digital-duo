# Digital Duo — Org-Mode Deployment

> Decision record for #161. Status: **PROPOSED** — this document becomes the decision when the
> PR carrying it is merged. External claims (systemd, Synapse, Matrix push, Sygnal) verified
> against their sources on 2026-09-25; sources at the end.
>
> Sits on three merged records and amends a founding posture. `workspace-platform.md` (#185)
> decided the org runs the homeserver; `workspace/asleep-duo.md` (#188 §8) kept org-hosted
> daemons "a deployment mode an owner or org may choose"; `workspace/org-read.md` (#191) set the
> operator-honesty frame this record applies one layer down. What was left open for #161 — and
> is decided here — is the deployment model itself: co-location, reachability, orchestration,
> the push direction, the operator concession said plainly, and the shape of org-paid inference.

---

## 1. The decision

1. **Org mode is the org running the workspace homeserver — already decided, #185 — and
   optionally co-locating per-person duo daemons on org hardware beside it.** Same `duo serve`
   code, one process, one encrypted store, one passphrase per person. No multi-tenant rewrite,
   now or later (§2). *Amended 2026-09-26 for the hosted POC: `docs/deploy/hosted-mode.md` serves
   many such duos from one process — still one unchanged app and one store per person, not a
   multi-tenant rewrite.*

   *Amended again 2026-09-26 (#229): the hosted POC also runs one shared Synapse for many orgs,
   separated by rules the daemon and a Synapse module enforce, not by one homeserver per org.
   That amends this record's "the org runs the homeserver" for the hosted deployment only, and
   is decided, with its limits, in `docs/deploy/hosted-workspace.md`. Daemons are still one app
   and one store per person.*
2. **The pilot default stays daemons-on-own-hardware** (#188 §8: "a deployment mode an owner or
   org may choose … availability is then a deployment property, not a platform guarantee").
   Co-location is the always-on option; personal hardware is not deprecated by this record and
   loses nothing (§2).
3. **Reachability in org mode is one public HTTPS endpoint — the front — TLS terminated there,
   the shipped bearer-token auth behind it.** Tailnet-only remains the daemon's rule on
   personal hardware. The daemon's bind discipline never changes: an explicit interface or
   loopback, never a wildcard (§3).
4. **Multi-daemon ops on one box is boring on purpose:** a systemd template unit per daemon,
   one OS user per daemon, per-store encrypted backups that deliberately exclude passphrases,
   one thin reverse-proxy front routing each client to its daemon (§4).
5. **Push, when it is built, originates at the workspace homeserver.** A personal daemon is
   never a push origin; a co-located one does not need to be (§5).
6. **Co-location changes the threat model, and this record says so:** the operator of the box
   can read plaintext artifacts and holds each daemon's passphrase material in memory. This
   amends `v1-tech-design.md` §1.1's founding posture by owner decision (2026-09-20); the
   amendment block beside §1.1 points here (§6).
7. **Org-paid inference goes through an org gateway:** org keys, per-person metering and spend
   caps — all at the gateway, none in the provider adapters. `src/provider/`'s abstraction is
   untouched; local-model config stays the zero-cost option. The gateway is future build work;
   this record fixes its shape, not its build (§7).

## 2. The model, on the merged architecture

**Org mode adds a place daemons may run. It does not change what a daemon is.**

- **Per-person, unchanged.** Each co-located daemon is exactly the process that would otherwise
  run on its owner's Mac: one `duo serve`, one encrypted SQLite store (AES-256-GCM under a
  scrypt-derived key from the owner's passphrase), one passphrase, one filesystem identity. No
  shared process, no shared store, no daemon-to-daemon path in code. Two daemons on the box are
  as separate as two daemons on two laptops — they reach each other's duos the way any two
  daemons do, as Matrix users over the homeserver (#187/#189), not by local shortcut.
- **The default is unchanged.** The pilot's daemons run on owners' hardware; a duo that is
  offline is handled by hold-and-deliver (#188), and that behaviour stays correct whether or
  not anybody co-locates. A co-located duo is simply online whenever the box is — a deployment
  property, never a platform assumption.
- **The choice is per duo, and mixed is normal.** An org where some daemons run on personal
  Macs and some on the box is the expected shape, not a misconfiguration. An owner who declines
  co-location concedes nothing and gains nothing.
- **Mobility is a directory.** A daemon is `duo/` plus `data/duo.db` plus its passphrase; it
  moves between personal and org hardware unchanged — copy, restart, re-point the client. Its
  workspace identity (its Matrix credentials) lives in the daemon and travels with it.
  Migration is not an export format, and none is built.

## 3. Reachability: the front is public; the daemon is not

**Decision: org-mode deployments expose exactly one public HTTPS endpoint — the front on the
org box — with TLS terminated at the front and the daemon's shipped bearer-token device/ask
auth behind it. Tailnet-only stays the rule on personal hardware.**

The weighing, so it is not re-litigated:

- **The homeserver is internet-reachable by necessity.** A workplace messaging tool whose phone
  client can only sync through a VPN is not a workplace tool; once 443 on the org box exists
  for the homeserver, hiding daemon reachability on a second, VPN-only network buys org mode
  nothing.
- **G3 argues for public, not against it.** `client-design.md` G3's finding is that managed
  endpoints "commonly block both halves: MDM profiles restrict background LaunchAgents, and
  VPN-shaped software is a standard blocklist entry." Tailnet-only org mode would hang client
  reachability on exactly the policy G3 flags as likely-blocked. Public-with-auth removes the
  VPN from the client's requirements entirely: the managed Mac runs a client pointed at an org
  URL — no LaunchDaemon, no mesh VPN, nothing for MDM to block that any sanctioned SaaS would
  not also need — and G4's phone fallback (the web client) works off-tailnet too. The posture
  `v1-tech-design.md` §1.1 actually forbade was a public endpoint **on the owner's machine**;
  that stays forbidden. This endpoint is the org's, on the org's box, behind the org's auth.
- **The cost, stated.** An internet-reachable front is an attack surface on a box holding N
  running daemons with decrypted corpora in memory. It is the same surface the homeserver
  already presents, governed the same way (`org-read.md` §2–§3); authentication is the shipped
  token layer with per-IP rate limiting. One deployment detail is flagged, not solved here:
  behind the proxy the daemon's per-IP limiter sees the proxy's address, so connection-rate
  limiting is the front's job and the daemon's limiter is defense in depth.

**What does not change, mechanically:** `duo serve` still refuses wildcard binds and requires
an explicit host — and loopback is an explicitly supported choice, so co-location is zero code
change: each daemon binds `127.0.0.1` and the front is the only inbound listener on the box.
§5's connection direction is untouched — the daemon dials out to the workspace server (over
loopback when co-located), and an owner's Mac still opens no inbound port. The client repo
needs nothing for the basics: its Setup screen already takes any daemon base URL (#161).

## 4. One box, N daemons

Deployment-record level, not an ops manual — the shape is fixed here, the runbook is not.

- **Supervision.** One systemd service per daemon via a template unit: `duo@.service` yields
  `duo@alice.service`, `duo@bob.service` (template units and the `%i` instance specifier are
  stock systemd — §9); `Restart=always`; reconnect is already idempotent (#186). A macOS office
  box uses one launchd daemon per person. Boring on purpose — this must not grow into an
  orchestrator.
- **Isolation.** One OS user per daemon (`User=` in the unit — stock systemd, §9), with that
  person's `duo/` and `data/` under their own home directory. Filesystem permissions keep one
  daemon process from reading another's store at rest. This is isolation between daemons, not
  against the operator — §6 is the honest statement of that line.
- **Ports and routing.** One loopback port per daemon from a managed range. The front routes by
  subdomain (`alice.duo.example.org` → that person's port), which needs no path rewriting. The
  front terminates TLS — the same shape Synapse itself is deployed in (§9) — and routes; that
  is its whole job. It is deliberately thin: routing is its only intelligence, and the daemon's
  own token auth remains the identity layer, so authentication never accretes into the proxy.
- **Backups.** The org backs up each store — ciphertext — and each `duo/` directory, on its own
  schedule. **What deliberately does not get backed up: any passphrase.** A backup without its
  owner's passphrase is inert by design; that is §5's boundary expressing itself in ops, not a
  gap to close. Restore is copy-files-back plus the owner supplying the passphrase. Offboarding
  is the mobility case run in reverse: the person takes `duo/`, a store copy, and their
  passphrase, and re-homes on personal hardware.

## 5. Push, when it comes

**Direction, decided; detail, deferred. The workspace homeserver is the natural push origin. A
personal daemon never is, and a co-located one does not need to be.**

Matrix's own architecture puts the origin there: "a client's homeserver forwards information
about received events to the push gateway," and the gateway "submits a push notification to the
push notification provider (e.g. APNS, GCM)" (§9). A daemon has no platform credentials, no
stable public identity, and — on personal hardware — no public endpoint, which §1.1 still
forbids. Making any daemon a push origin would reopen that question one daemon at a time.

Same box, same decision: an org that can host N daemons can host a push gateway beside the
homeserver (Sygnal, Apache-2.0, is the reference implementation — §9), or point at a hosted
one. Note what org mode does *not* un-forbid: `client-design.md`'s "true background push would
need a relay with a public endpoint, which 1.1 forbids" remains true for personal-hardware
duos until the parked AR-10/v2 relay question is decided on its own record. Deferred, again on
purpose: gateway choice (self-hosted vs hosted vs UnifiedPush), key custody, and notification
content rules. What is fixed here is the direction, so nobody builds daemon-originated push.

## 6. The operator, plainly

`v1-tech-design.md` §1.1 founded the product on "no data at rest on third-party
infrastructure." Org mode, chosen per duo, waives that sentence — by the owner's decision of
2026-09-20, recorded here, and pointed at from §1.1 by a dated amendment block. On personal
hardware the machine's operator and the corpus's owner are the same person. Co-location splits
the role, and the split is stated exactly:

**What the operator of the box gains:**

- Every plaintext artifact in a person's `duo/` — rules, refusals, voice — readable directly
  off the filesystem.
- Each daemon's passphrase material: the supervisor supplies `DUO_PASSPHRASE` at every start
  (or captures it at the prompt), and the running process holds the derived key in memory.
- Therefore the store's entire contents — corpus, drafts awaiting review, escalation queues —
  any time, without the owner's knowledge: dump process memory, or re-derive the key from the
  held passphrase.
- Every request between a client and its daemon, because the front terminates TLS: the
  questions an owner types into their own client, the drafts they open, the actions they take
  on them — all of it passes through the operator's proxy.
- Metadata: run times, question arrival (already visible to the org as workspace records —
  `org-read.md` §3), and inference traffic patterns if the gateway is used (§7).
- The ciphertext, indefinitely, via backups.

**No cryptographic barrier stands between the operator and a corpus on their machine.** What
per-person store encryption still defends in org mode: stolen disks, leaked or mis-filed
backups, other daemons' processes — everyone who is not the operator. The passphrase defends
the store against everything except the party whose supervisor typed it in. Governance is
therefore accountability, not prevention — `org-read.md` §3's frame, one layer down: few
hands, named roles, break-glass monitoring — and the choice remains per duo, so an owner who
declines concedes nothing.

**What the operator does not gain, equally exactly:** the workspace server still holds no
corpus, passphrase, derived rules or draft evidence — `workspace-platform.md` §5 has not
moved, because its line governs the workspace *store*, and that store holds messages and
nothing else regardless of where any daemon runs. Duo answers still travel without their
evidence (`org-read.md` §5). Other members' clients see exactly what they would if each daemon
were on its owner's Mac. And nothing in this concession comes from code: every capability
listed above is stock administrator access to a machine a daemon was placed on, or to the
proxy in front of it — the product added no operator feature, and none is reachable from the
workspace server's APIs.

## 7. Org-paid inference: the gateway

**The shape: an org gateway in front of inference providers. Org keys live only there.
Per-person metering and spend caps live only there too.** The daemon's provider interface
stays `complete(prompt) → text` — the gateway is where org concerns live, precisely so they
never leak into the provider layer.

The contract surface, recorded for whoever builds it:

- `src/provider/` gains one more `InferenceProvider` implementation — an `org-gateway` entry —
  whose `complete()` speaks HTTPS to the gateway with a per-daemon credential. It resolves
  through the existing registry and config; R3 (no provider imports outside `src/provider/`)
  and R6 (swappability) hold; no call site changes at all.
- **Metering lives at the gateway, never in the provider adapters.** Adapters never learn
  about orgs, budgets, persons or quotas; attribution is the per-daemon credential presented
  at the gateway. Spend caps are configured and enforced gateway-side.
- Cap exhaustion reaches the daemon as an ordinary `ProviderError` and degrades the way
  provider unavailability already degrades — deterministic fallback, escalation — never a
  silent switch to another provider (R4's no-silent-fallback rule).
- **Embeddings are not gateway traffic.** They run locally via Ollama unconditionally
  (`v1-tech-design.md` §1.2) and stay on the daemon's host — the org box for co-located
  daemons, which is local to that box.
- Local-model config remains the zero-cost, policy-maximalist option; a deployment picks it
  org-wide or per duo, and nothing here makes it second-class.

One trust note, same honesty as §6: the gateway is org infrastructure. A personal-hardware
daemon pointed at it sends its prompts — not its corpus — over the org's gateway; that is the
owner's choice to make knowingly, exactly like co-location.

For #14: this closes its who-pays half for the org case — one org bill survives a workplace
finance process where per-person BYOK does not. The other half of #14, which model may
legally see the corpus, is untouched by billing topology. The gateway itself is future build
work; this record decides the shape and nothing more.

## 8. What this record does not decide

- **The gateway build** — protocol details, credential issuance, dashboards, provider signup.
  §7's contract is the whole commitment.
- **Application-service-managed duo accounts at scale** — `workspace-platform.md` §6's later
  shape. The pilot stays one Matrix account per duo; co-location does not reopen it.
- **Any change to `workspace-platform.md` §5 — none.** The workspace server keeps holding
  messages and nothing corpus-shaped; co-located daemons keep per-person encrypted stores. The
  operator's gains are the deployment-layer ones stated in §6, not store-layer ones.
- **Push detail** (§5): gateway choice, custody, notification content.
- **Ops runbook detail** (§4): front implementation, port allocation scheme, restore
  procedures, certificate mechanics.
- **#193's sweep.** The dated block added beside `v1-tech-design.md` §1.1 is a pointer, not
  the rewrite; #193 owns carrying this record's amendment into its §1.1 rewrite, alongside the
  two-store statement `org-read.md` §7 already requires of it.

## 9. Sources (verified 2026-09-25)

- systemd template units — "A template unit must have a single '@' at the end of the unit name
  prefix (right before the type suffix)"; "The name of the full unit is formed by inserting
  the instance name between '@' and the unit type suffix"; `%i` = instance name —
  systemd.unit(5), <https://man.archlinux.org/man/systemd.unit.5> (mirror of
  <https://www.freedesktop.org/software/systemd/man/systemd.unit.html>, which rejects
  automated fetches)
- systemd `User=` — "Set the UNIX user or group that the processes are executed as" —
  systemd.exec(5), <https://man.archlinux.org/man/systemd.exec.5>
- Synapse deployment via reverse proxy — "put a reverse proxy such as nginx, Apache, Caddy,
  HAProxy or relayd in front of Synapse", exposing 443 without running Synapse as root —
  <https://matrix-org.github.io/synapse/latest/reverse_proxy.html>
- Matrix push architecture — homeserver forwards events to a push gateway; gateway submits to
  the provider (APNS/GCM) — Push Gateway API,
  <https://spec.matrix.org/latest/push-gateway-api/>
- Sygnal — Apache-2.0 reference Push Gateway for Matrix; maintained at
  <https://github.com/element-hq/sygnal> since the matrix-org repository was archived
  2025-07-21
- G3/G4, tailnet transport, "passphrase at start only", the push/1.1 note — `client-design.md`
  in the client repo (guangshinhaha/duo), read from source this session; cited, not edited
- Repo internals, read from source: `src/serve/bind.ts` (wildcard refusal; loopback an
  explicit supported choice), `src/serve/passphrase.ts` (`DUO_PASSPHRASE` or interactive
  prompt; no disk fallback), `src/provider/types.ts` and `src/provider/registry.ts` (the
  interface, R3/R4/R6), `src/store/crypto.ts` (AES-256-GCM under a scrypt-derived key)
- Issues #161 and #14, and the merged records `workspace-platform.md`, `asleep-duo.md`,
  `org-read.md`, `v1-tech-design.md` — read from source this session
