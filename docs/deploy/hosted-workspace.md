# Hosted workspace — many orgs, one Synapse, org walls enforced by us

> Decision record for #229 (parent epic #228), 2026-09-26. Status: **DECIDED** when the PR
> carrying it merges. It is the source of truth that #230–#236 and the client issues cite.
> Amends two earlier records, each with a dated note pointing here: `hosted-mode.md` item 6
> ("Not in hosted mode: the Matrix workspace connection") and
> `docs/workspace/org-mode-deployment.md` §1.1 ("no multi-tenant rewrite").
>
> Every Synapse claim below was checked on 2026-09-26 against Synapse's own documentation and
> source (`element-hq/synapse`, `develop`, which is v1.162.0rc1; latest release v1.161.0,
> published 2026-09-15). Where documentation and source disagree, that is said. Claims not yet
> proven against a running Synapse are marked **verify in #N**. Sources are in §12.

## 1. The decision

1. **One shared Synapse for every org, federation off.** Orgs are separated by rules we
   enforce, not by infrastructure. Creating an org is a registry write plus a Matrix Space,
   never a deploy (§2).
2. **The daemon's hosted registry is the source of truth for orgs and membership.** Synapse
   holds accounts, rooms and messages, and nothing that decides who belongs to which org (§3).
3. **The daemon creates every Matrix account, person and duo, through the Synapse admin API.**
   Public registration is off, no person or duo account has a password (the one exception is the
   service account, `@workspace-admin`, §5), and no one ever types a homeserver address (§5).
4. **An account's org is written into its Matrix user id.** `@<orgId>.<handle>:<server>` for a
   person and `@duo-<orgId>.<handle>:<server>` for their duo. The Synapse module reads the org
   from the id string: no round trip, no lookup, no state to drift (§4).
5. **The org wall has three layers:** the user directory (scoping), a Matrix Space per org
   (placement), and a Synapse module (enforcement). Only the module is a hard wall (§6).
6. **The wall has stated limits.** It does not stop the operator, the daemon's admin account,
   or a misconfigured module, and it does not protect message content from Railway (§6.4).
7. **One super admin role, no org admins in the POC.** The super admin is who
   `DUO_HOSTED_ADMIN_EMAILS` names today. It is a registry role and is not a Synapse admin (§7).
8. **Posture:** every org's messages sit on Railway. POC only, not for classified or sensitive
   government material. `workspace-platform.md` §5's forbidden-store list is unchanged (§9).
9. **Homeserver: Synapse**, because it is the only candidate with the module API and the HTTP
   admin API this design needs (§10).

## 2. One shared Synapse, or one homeserver per org

| | One shared Synapse (**chosen**) | One homeserver per org (rejected for the POC) |
|---|---|---|
| Create an org | A registry row and a Space. Seconds, from an app button. | Provision a Synapse and Postgres pair, a volume, a domain and secrets. A deploy, not a button. |
| Isolation | Rules we enforce (§6). One Synapse process and one database hold every org. | Strong by construction: separate process, database, media and keys. |
| Cost on Railway | One service pair, however many orgs. | Two services per org, plus their volumes. |
| The wall depends on | Our module being loaded and correct. | Nothing of ours. |

**Why shared.** The POC's job is to let a super admin make a team and invite people by pressing
a button. A per-org homeserver turns that button into infrastructure provisioning, and #228's
whole point is that it stays a button.

**What would make us revisit.** Any one of these moves an org to its own homeserver:

- a real org's security review declines "rules on a shared server" as isolation;
- an org needs its own keys, retention, or jurisdiction for its messages;
- an org needs federation, or its own domain for user ids;
- a module bypass is found that we cannot close (the wall is only as strong as that module);
- one org's load degrades the others (rate limits are per user, not per org).

**What that revisit costs, so nobody assumes it is free.** Matrix user ids embed the server name
and message history does not move between homeservers. Moving an org means new accounts on a
new server and a fresh history there. The registry-as-source-of-truth decision (§3) and the
derived naming (§4) are what keep that a re-provisioning job rather than a redesign.

## 3. Orgs live in the hosted registry

The registry (`src/hosted/registry.ts`, `hosted/registry.json`) is already the record of who has
a duo and which invites exist. It gains orgs and the Matrix accounts it provisions. Types are
sketched here so #231 and #232 share names. Field names are binding, exact code shape is not.

```ts
interface HostedOrg {
  readonly id: string;          // immutable. Lowercase letters and digits only, never a dot or hyphen (§4). "default" for the migrated org.
  readonly name: string;        // display name. Renamable; nothing on the Matrix side is derived from it.
  readonly createdAt: string;
  readonly spaceRoomId?: string;    // set by #234 when the org's Space exists
  readonly generalRoomId?: string;  // set by #234 if #general is built
}

interface HostedMatrixAccounts {
  readonly personUserId: string;    // @<orgId>.<handle>:<server>
  readonly duoUserId: string;       // duoUserIdFor(personUserId), which returns string | null: asserted non-null when provisioning
  readonly duoTokenCipher: string;  // base64 of encrypt(duoAccessToken, DUO_HOSTED_MASTER_KEY), like passphraseCipher
  readonly provisionedAt: string;
}

// HostedTenant gains:  orgId: string (required after migration);  matrix?: HostedMatrixAccounts
// HostedInvite gains:  orgId: string
// RegistryFile gains:  orgs: HostedOrg[]
// RootClaim gains:     matrix?: HostedMatrixAccounts   (the pre-hosted root duo, handle "root")
```

Rules the code must keep:

- **Exactly one org per tenant.** `orgId` is set at signup from the invite the person redeemed,
  and never changes. A person moving orgs is out of scope (§4 explains why it is also
  expensive).
- **Org ids are generated once and never reused.** They are 8 characters from the existing
  tenant-id alphabet (`abcdefghijkmnpqrstuvwxyz23456789`), except the migrated org, whose id is
  the literal `default`.
- **Migration on first load.** A registry with no `orgs` gets one org, `{ id: "default", name:
  "Default" }`. Every existing tenant, every outstanding invite, and the root duo land in it.
  Existing duos keep their `/t/<id>` URLs, since the URL never contained an org.
- **Invites name an org.** Redeeming one puts the new tenant in that org. `duo hosted invite
  "Sam"` with no `--org` means the default org, so the flow already documented in
  `hosted-mode.md` keeps working.
- **The registry, not Synapse, answers "who is in org X".** The Matrix id is a copy of the org
  taken at provisioning time. Because a tenant's org never changes, the two cannot drift. A
  reconcile check (does every provisioned id start with its tenant's `orgId`?) is cheap and
  belongs in #232's tests.

## 4. Account naming, and how the module learns an account's org

### 4.1 Naming

| Account | Matrix user id | Example |
|---|---|---|
| Person | `@<orgId>.<handle>:<server>` | `@k7m2x9pq.c4rt8h2wvn:duo` |
| Their duo | `@duo-<orgId>.<handle>:<server>` | `@duo-k7m2x9pq.c4rt8h2wvn:duo` |
| The daemon's service account | `@workspace-admin:<server>` | one account, a Synapse admin |

- `<handle>` is the tenant id (10 characters, already unique and URL-safe). The root duo's handle
  is the literal `root`, which no tenant id can equal. Display names carry the human name (set
  from the Google profile and the duo's name); the id is not meant to be read.
- The duo's id is exactly `duoUserIdFor(personUserId)` in `src/workspace/directory.ts`: prefix
  `duo-` on the localpart. That function, its inverse `duoOwnerUserIdOf`, and the bijection
  claim in its comment are **unchanged**, so the directory keeps working without a mapping
  table.
- The service account has no dot, so it has no org, and it does not start with `duo-`, so the
  directory never mistakes it for a duo. It is the only account with `admin: true`.
- `<server>` is Synapse's `server_name`. It is permanent (it is baked into every user id), so
  #230 picks a stable label and not the generated Railway domain. Federation is off and the
  daemon hands each client the homeserver's base URL directly, so no `.well-known` delegation is
  needed.
- Matrix localparts allow lowercase letters, digits and `. _ = - / +`. Ours use letters, digits,
  one `.`, and (for duos) one leading `duo-`. Org ids and handles never contain `.`, so the first
  dot always separates them.

### 4.2 The module derives the org from the id

```
org_of(user_id):
    local = user_id[1:].split(":", 1)[0]
    local = local.removeprefix("duo-")
    return local.split(".", 1)[0] if "." in local else None
```

`None` means "no org". Only the service account is allowed to have none; the module's config
lists it (`service_accounts`). Any other account without an org marker is refused everything,
because it can only exist if something bypassed the provisioner.

> **Deviation, 2026-09-26 (#235).** The shipped parse is stricter than the sketch: the localpart
> must match `^(duo-)?[a-z0-9]+\.[a-z0-9]+$` and the server part must equal the configured
> `server_name`, or the account has no org. So `@orga.b.c:duo` (a second dot, which the sketch
> would read as org `orga`), an uppercase id and an id on another server are all org-less and
> refused everything. It agrees with the sketch, and with `orgIdOfUserId` in
> `src/hosted/matrix-accounts.ts`, on every id the provisioner can make (org ids and handles are
> `[a-z0-9]+`). The two only differ on ids the provisioner never produces, where "no org" is the
> fail-closed answer the record asks for.

### 4.3 Why this and not the alternatives

We picked **an org marker in the user id**. The others were weighed against four needs: the
marker must be settable only by us, unforgeable by the account holder, readable inside Synapse
with no I/O, and present at the first join, which is the moment the wall matters.

| Option | Verdict |
|---|---|
| **Org id in the localpart** (chosen) | Set only at creation (registration is off, only the daemon creates accounts). A user cannot rename their account. Readable by string parse: no lookup, no cache, nothing to invalidate, no availability dependency. Also solves uniqueness: two orgs can each have a person called Sam without contending for `@sam`. |
| Read it from a daemon endpoint, cached | Adds a network dependency, on Railway's private network, to every invite and join. If the daemon is down or restarting the module must choose between failing open and failing closed. Needs cache invalidation. Rejected: this is the option #235 says to avoid. |
| Membership of the org Space | Circular. The module is what decides who may join a Space, so it cannot also trust Space membership as its input. The admin-API join that puts a new person in the Space calls the module for that very join (§6.2), so at that moment the person is in no Space yet. Also makes the wall depend on room state that a room admin can change. |
| Per-user account data set by the provisioner | Account data is writable by the user through the client API (`PUT /user/{id}/account_data/{type}`), and Synapse's account-data module callbacks are notifications after the fact, not vetoes. A member could rewrite their own org marker. Rejected as forgeable. |
| Synapse user type or external id | `user_type` accepts only `bot`, `support`, or values listed in server config (`user_types.extra_user_types`), so it cannot carry an open set of org ids. External ids are unique per (provider, id), which allows one account per org id, not many. |

**What this costs.** A person cannot change org: it would be a new account and a fresh history.
The POC decision is exactly one org per person, so this is a property to state, not a defect.
Ids are ugly, which is acceptable because every surface shows display names.

## 5. Provisioning: the Synapse admin API contract

The daemon holds one admin access token (`DUO_WORKSPACE_ADMIN_TOKEN`, a Railway variable, never
in the registry or the repo) and calls the admin API over Railway's private network. What #232,
#233 and #234 may rely on, all checked against the Synapse admin docs and source on 2026-09-26:

- **Two URLs, and the https rule (decided).** The daemon reaches Synapse on Railway's private
  network, normally `http://<service>.railway.internal:<port>`, in `DUO_WORKSPACE_HOMESERVER`.
  The URL handed to clients is a different, public https address, carried in
  `DUO_WORKSPACE_PUBLIC_URL` (§8). Today `src/workspace/settings.ts` (lines 86-89) throws on any
  `DUO_WORKSPACE_HOMESERVER` that is not `https:`, so the record cannot be followed as written.
  **Decision:** hosted mode relaxes the https-only rule for hosts ending in `.railway.internal`,
  because tokens on that URL never leave Railway's private network. Any other host still needs
  https. That code change is owned by #232 (settings) and #236 (hosted wiring), not by this
  docs-only record. The scheme of the private address is unverified against a live Railway
  project (`railway.md` names no Synapse service yet): #230 confirms it.

- **Create or update an account, idempotently.** `PUT /_synapse/admin/v2/users/<user_id>` with
  `displayname`, `admin: false` and no `password`. Answers `201` when it created the account and
  `200` when it modified an existing one, so re-running is a no-op. The docs say "it is possible
  to have active users without a password". Person and duo are both created this way, with no
  password on either, which is what makes #232's "no stored password" true. The one account
  with a password is `@workspace-admin` (below).
- **Get a token for an account.** `POST /_synapse/admin/v1/users/<user_id>/login` with an optional
  `valid_until_ms`. Returns `{"access_token": ...}`. Facts that matter:
  - "By default tokens do not expire." Person tokens therefore always set `valid_until_ms`.
    The duo's token is minted without one and stored encrypted (§3).
  - It "does not generate a new device", so the token is **not** in the account's device list
    and has no device id. See §11 for what that means for #233.
  - "To expire the token call the standard `/logout` API with the token." The daemon cannot
    revoke a token it did not keep. Sign-out is the client calling `/logout` with its own token,
    and a leaked person token is bounded only by its expiry (§6.4).
  - "The token will expire if the admin user calls `/logout/all`." Nothing in the daemon may
    ever call `/logout/all` as the service account, or every duo token dies at once.
  - The API "does not allow a user to login as themselves", so the service account can mint
    tokens for others but not for itself (so this API cannot produce the service account's own
    token: see the shared-secret bullet below). It is disabled if Matrix Authentication Service
    is enabled. We do not run it.
- **Put an account into a room.** `POST /_synapse/admin/v1/join/<room_id_or_alias>` with
  `{"user_id": ...}`. The user must be local, and "the server administrator must be in the room
  and have permission to invite users". Read from source: for a non-public room the admin
  first sends an invite (as the admin), then joins as the target. So the service account must be
  a member of every org Space and #general, and the Space must not be public.
- **Shared-secret registration** (`GET`/`POST /_synapse/admin/v1/register`, HMAC of a nonce) is
  how the first admin account is created. It needs `registration_shared_secret` and, per the
  config docs, works "even if this setting [`enable_registration`] is disabled". So
  `enable_registration: false` does not close it: treat the shared secret as admin-equivalent,
  keep it only in Railway variables, and prefer `registration_shared_secret_path` (a file) to
  an inline value in the config, but note that with the `_path` form Synapse creates the secret
  in that file itself when it is missing, so the secret then lives on Synapse's volume and no
  Railway variable holds it. #230 uses the API once to create `@workspace-admin` with a random
  password that is discarded after use. The register request needs a `password` (the MAC covers
  the nonce, user, password and admin flag), and the response returns that account's
  `access_token` and `device_id` directly, so no login step is needed. #230 stores the returned
  token as `DUO_WORKSPACE_ADMIN_TOKEN`. `@workspace-admin` is the one account with a password;
  every person and duo account has none (§1, item 3). After bootstrap #230 **unsets the shared
  secret** (and removes the secret file if `_path` was used): with no shared secret configured
  the API is off, which `enable_registration: false` alone does not achieve.

  > **Deviation, 2026-09-26 (#230, PR #242).** The bootstrap password is **not** discarded.
  > `@workspace-admin`'s password stays in the Railway variable `SYNAPSE_ADMIN_PASSWORD`, because
  > without it a lost or rotated token could only be replaced by re-registering a differently
  > named admin or editing the database. The cost is a second credential on the public listener
  > (password login, `rc_login` at its defaults). It is mitigated by making it a long random
  > value: `create_admin.py` refuses a password under 32 characters, and the runbook uses
  > `openssl rand -hex 32` (256 bits). Every other account still has no password.

## 6. The org wall

### 6.1 Three layers, and which one is a wall

1. **Directory scoping.** `user_directory.search_all_users: false`. The Synapse docs say search
   results then contain "users visible in public rooms and users sharing a room with the
   requester". That is a **visibility** measure: it hides other orgs from search and does
   nothing about someone who types a full user id.
2. **A Matrix Space per org** (#234). Being in the Space is what makes org members share a room,
   hence findable. It is a place and a UX, not a trust anchor (§4.3).
3. **A Synapse module** (#235) that refuses cross-org invites and joins, hides other orgs from
   directory search, and refuses public rooms. This is the only layer that enforces anything.

**The public-room trap.** Because directory search also returns "users visible in public rooms",
a single public room makes everyone in it findable by every org. So the module must refuse
creating, publishing or making a room public (§6.3), and the Space and `#general` are private
(invite-only, or restricted to the Space's members), never `public`.

### 6.2 Module callbacks, as verified

| Callback | Signature (Synapse docs, `develop`) | What we use it for | Notes verified on 2026-09-26 |
|---|---|---|---|
| `user_may_invite` | `async (inviter: str, invitee: str, room_id: str)` | Refuse when `org_of(inviter) != org_of(invitee)` | **Not called when the inviter is a server admin** (source: `room_member.py`). That is why the service account can seed rooms. |
| `user_may_join_room` | `async (user: str, room: str, is_invited: bool)` | Refuse when the user's org differs from the org of any joined or invited member of the room | Docs: "isn't called if the join is performed by a server administrator, or in the context of a room creation". **Admin-API joins are different:** the admin API joins as the *target* user, and the bypass is decided on whether that user is a server admin, so a provisioning join **does** run the module. Our own provisioning must pass it, which is why the org has to be readable from the id before the person is in any room. |
| `user_may_create_room` | `async (user_id: str, room_config: JsonDict)` | Refuse public rooms; refuse an `invite` list that crosses orgs or contains a 3pid; refuse an `initial_state` `m.room.member` entry and a `world_readable` history visibility | `room_config` argument added in **v1.132.0**, and its `initial_state` shape on room upgrade fixed in **v1.140.0** (#18721; the module reads `initial_state` for rule 3, and it is the only check that sees it: Synapse writes those events with no invite, join or spam callback). Pin Synapse at or above **v1.140.0**. **Not called when the creator is a server admin** (`room.py`), like the invite and join callbacks. |
| `user_may_publish_room` | `async (user_id: str, room_id: str)` | Always refuse for non-service accounts | |
| `user_may_send_3pid_invite` | `async (inviter, medium, address, room_id)` | Always refuse (no email or phone invites) | Local only. |
| `check_username_for_spam` | `async (user_profile: UserProfile, requester_id: str) -> bool` | Directory filter: return `True` (hide) when `org_of(profile.user_id) != org_of(requester_id)`, and always for the service account | Returns `True` to **exclude**. `requester_id` was added in Synapse **v1.122.0** (changelog); pin at or above it. **A filter, not a scope:** Synapse applies the search `limit` before this callback (see §6.4), so `search_all_users: false` (shipped) is the real control and this is the second lock. |
| `check_event_for_spam` | `async (event: EventBase)` | Refuse a `m.room.join_rules` state event setting a join rule other than `invite` (or `restricted` to a room of the sender's org), a `m.room.history_visibility` other than `invited`/`joined`/`shared`, and a `m.room.guest_access` other than `forbidden`, so a private room cannot be flipped public or world-readable later | Called for events from clients. **Verified 2026-09-26 (#235)** on v1.161.0: it sees a `PUT /rooms/<id>/state/m.room.join_rules` from a local client, and the `(Codes, dict)` answer reaches the client with our sentence. It does not see room creation, so `user_may_create_room` reads `initial_state` (rule 3), also verified. **Not `user_may_send_state_event`:** it is documented as experimental, it runs before `check_event_for_spam`, and on v1.161.0 it accepts only `NOT_SPAM` or a bare `Codes` (a `(Codes, dict)` pair is logged as an invalid value and answered with a fixed sentence), so it is not registered. The third-party-rules `check_event_allowed` is documented as "very experimental" and points at `check_event_for_spam` instead. |

Return values. **Return only `NOT_SPAM` or `Codes.FORBIDDEN`, never a boolean.** The docs and the
code disagree on booleans: the docs say a deprecated `True` means `FORBIDDEN`, while
`SpamCheckerModuleApiCallbacks.user_may_invite` in current source treats `True` as allowed. For
`check_username_for_spam` a boolean is the documented contract, and there `True` means hide.

> **Deviation, 2026-09-26 (#235).** A refusal is `(Codes.FORBIDDEN, {"error": "<sentence>"})`,
> not a bare `Codes.FORBIDDEN`: it is still `M_FORBIDDEN` and never a boolean, and it is what makes
> "refused with a clear error" true, because Synapse otherwise answers with its own fixed text
> ("Invites have been disabled on this server"). On v1.161.0 this pair is accepted by
> `user_may_invite`, `user_may_join_room`, `user_may_create_room`, `user_may_publish_room`,
> `user_may_send_3pid_invite` and `check_event_for_spam` (checked in the source and against a
> running server: the sentence arrives in `error`). A Synapse that stopped accepting the pair would
> log an invalid value and reject, so the failure is still a refusal. The sentences never name
> another org.

Failure mode. The invite path in current source calls each callback with no exception handler,
so a module that raises makes the request fail rather than pass, and a callback that returns
anything unrecognised is logged and treated as a rejection. Both fail closed.
**Verified 2026-09-26 (#235)** on v1.161.0 for the join, create-room, invite and directory paths,
with a bare module whose callbacks raise: `createRoom`, an invite, a join and a directory search
each answered `500`, and nothing was created or joined. The module does not rely on that: every
callback catches its own errors, refuses (or hides the directory hit) and logs the error's class
name and nothing else, checked with an exception whose message was a marker string that never
reached the log.

Loading. The module is a Python class named in `homeserver.yaml` under `modules:` with a
`config:` block; it receives its parsed config and a `ModuleApi`. For the join check it needs
the room's members: `ModuleApi.get_room_state(room_id, [("m.room.member", None)])` is an async,
local database read (added v1.47.0), not a network call. It is read fresh on every join, on purpose:
a cache of a room's orgs would go stale when the service account invites someone (its invites are
not judged), and the wall's answer would then be wrong. Measured 2026-09-26 on v1.161.0 (SQLite,
one org room, admin-API joins of 400 people one after another): the join took 34 ms at the start
and 78 ms at the end with the module, 33 ms and 75 ms without it, so the read is about 3 ms at 400
members and the growth is Synapse's own. Provisioning an org of N people is N reads of up to N
members (quadratic in count, small in cost); not measured on Postgres or on Railway.

### 6.3 What the module enforces, exactly

For any actor that is not the service account:

1. **Invites.** `org_of(inviter) == org_of(invitee)`, both non-null, else `FORBIDDEN`.
2. **Joins.** Read the room's member events. If any member whose membership is `join` or `invite`
   has an org (the service account has none and is skipped) that differs from the joiner's,
   `FORBIDDEN`. An org-less non-service joiner is refused.
3. **Room creation.** Refuse `visibility: public`, the `public_chat` preset, any 3pid invite,
   and any `initial_state` entry of type `m.room.join_rules` whose `join_rule` is not `invite`
   (or `restricted` to the org's Space), any `m.room.member` entry (whatever it says: a fresh room
   needs none, and Synapse writes these events without asking anyone, so one for another org's user
   would deliver that user an invite with the sender's text), and any `m.room.history_visibility`
   other than `invited`, `joined` or `shared`. Every id in `invite` must share the creator's org. The
   `initial_state` check matters because a room can be created public that way with no
   `visibility` and no preset, and rule 5 never sees it: the initial state events of a new room
   are built by the room-creation handler (`synapse/handlers/room.py`) and do not pass through
   `check_event_for_spam`, whose only call site is
   `synapse/handlers/message.py` (`_create_and_send_nonmember_event_locked`).
4. **Directory.** `check_username_for_spam` hides other orgs and the service account.
5. **Join rules, and who can read.** No room may be made `public` after creation, none may be
   made readable by people outside it (`m.room.history_visibility: world_readable`, which lets any
   account holding the room id read `/messages`, `/initialSync` and `/state`, and an alias is enough
   to get the id), and none may allow guests (`m.room.guest_access` other than `forbidden`), all in
   `check_event_for_spam`. Read this as "no room can be made public *by a member, with the state
   events the module knows*", not "no room can be public": rooms that existed before the module
   are not rewritten, the service account is exempt, and `guest_access: can_join` is **not**
   judged in `createRoom`'s `initial_state`, because Synapse's own `private_chat` preset writes it
   and a room upgrade copies it (the upgrade check in the real-Synapse run found this; guests are
   off on the server, so it has no effect today). Other ways to reach another org are in §6.4.
   "Restricted to the org's Space" is read strictly (2026-09-26, #235): a `restricted` rule is
   allowed only when every `allow` entry names a room whose joined and invited members are all in
   the actor's org (the service account skipped) and that has at least one; `knock`, `public`,
   the legacy `private`, and anything unrecognised are refused, in rules 3 and 5 alike.

The service account is exempt (it is a server admin, so Synapse already skips 1 and 2 for it).
Synapse also never calls `user_may_create_room` for a server admin (`synapse/handlers/room.py`
guards the call with `if not is_requester_admin`), so rule 3 is skipped for any admin account
by Synapse, not by the module's choice, and the module skips it in 5 as well, because the
service account creates the Spaces. This is one more reason never to promote a person account
to admin (§6.4).

### 6.4 What the wall does not stop

Written plainly, because these are what a security reviewer will ask about.

- **The operator and the service account.** Whoever runs the Railway project, the daemon
  process, the Postgres database, the media volume, or holds `DUO_WORKSPACE_ADMIN_TOKEN` can read
  every org's messages in plaintext and can act as any user. Synapse admins bypass the invite
  and join callbacks by design, so nothing in the module constrains that account. This is the
  same operator concession as `org-mode-deployment.md` §6, now spanning orgs. It is a
  **deployment fact, not a code bug**, and the reason the posture is POC-only (§9). Never
  promote a person account to admin: `admin: true` is what exempts an account from the wall.
- **A super admin, in the registry.** The super admin sees every org's name and membership, and
  chooses which org an invite joins. That is metadata, not message content, but it is not
  walled.
- **A module that loads but is wrong.** A module that cannot load at all stops Synapse (exit 1,
  §6.5), so that case is loud. A module that loads and has a bug, or is configured in a way that
  weakens it, leaves the wall gone while Synapse still runs. Mitigations: the real-Synapse harness
  (`tests/real_synapse.py`, with `--mutate-all` to show it notices a weakened wall, §6.5), and
  #235's end-to-end check with two orgs on Railway, **which is not done**. The daemon-side probe
  this section used to recommend (refuse to provision accounts until a deliberate cross-org invite
  between two throwaway accounts is refused) is **not built**: #235 did not build it, and nothing
  in the daemon checks that the wall is up. Building it is the owner's call, and worth making
  before a second organisation is on the server.
- **Message content.** The module is about who can be invited and who can join. It does not
  encrypt anything. Rooms are not required to be end-to-end encrypted in the POC, and even an
  encrypted room does not protect against the operator's access to accounts and tokens.
- **Profile and media metadata.** By default Synapse answers profile lookups for any user id,
  and embeds display name and avatar in invite events. The wall needs
  `require_auth_for_profile_requests: true` plus `limit_profile_requests_to_users_who_share_rooms:
  true` (the second requires the first, or Synapse refuses to start) and
  `include_profile_data_on_invite: false`. Even so, media sits in one shared store; authenticated
  media is on by default (`enable_authenticated_media`), which prevents anonymous download but
  not reading by an authenticated user who has a media URL.
- **Device keys and device names.** `limit_profile_requests_to_users_who_share_rooms` covers
  `/profile` only. `POST /keys/query` answers for any local user id, across orgs, with no shared
  room: the device id, its public keys and `unsigned.device_display_name` (often a personal
  string such as "Carol's private laptop"), observed on v1.161.0. It is a metadata leak, and an
  id that has a device answers differently from one that has none, so it is a weak check that an
  account exists. Synapse has no setting for it. Closing it means refusing or rewriting
  `POST /_matrix/client/*/keys/query` in a proxy in front of the client listener, which also
  breaks end-to-end key exchange; see the to-device bullet for the decision. Recorded, not closed.
  `real_synapse.py` asserts the leak as it is today (labelled `KNOWN GAP`), so a Synapse upgrade
  that closes it is noticed.
- **To-device messages.** Synapse delivers a `PUT /sendToDevice/<type>/<txn>` message to any
  local user id, across orgs, with no shared room and arbitrary content, and the message arrives
  in the recipient's next `/sync` under `to_device` with the sender's id (observed on v1.161.0,
  both directions). The module cannot see it: Synapse has no spam-checker callback for to-device
  messages. That is a one-way message channel across the wall. Closing it needs a proxy rule that
  refuses `sendToDevice` in front of the client listener, and that same rule stops key sharing for
  end-to-end encrypted rooms (Megolm keys travel as to-device messages). **Decision (POC):
  documented as a known gap, not closed.** Duos do not use end-to-end encryption today (§12,
  `#233`: the POC does not depend on E2EE, and admin-minted tokens have no device), so a proxy block, here and for `/keys/query`, is
  feasible later at the price of ruling encrypted rooms out; whether to add it, and before which
  org joins, is the owner's decision (the person who accepted §9's POC posture). Until then, a
  user with a login can send another org's user a message the wall does not stop, so the wall is
  a hard wall for rooms, invites, joins and the directory, not for every Matrix API. `real_synapse.py`
  asserts the delivery as it is today (labelled `KNOWN GAP`).
- **Aliases.** Room aliases resolve for any authenticated user (`GET /directory/room/<alias>`),
  so another org that guesses an alias learns the room id. That alone reads nothing (the room
  stays unreadable while its history visibility is not `world_readable`, which the module now
  refuses); the harness records it as observed. The daemon creates no aliases.
- **Directory `limited`, if `search_all_users` is ever turned on.** With `search_all_users: true`
  (not shipped) Synapse applies the search `limit` in the database query and only then calls
  `check_username_for_spam`, so another org's matches use up result slots, and a short page can
  drop a same-org user, and `limited: true` with no results tells the searcher a matching account
  exists somewhere. The module is a filter, not a scope. The shipped `search_all_users: false`
  queries only users who share a room, so no other-org row reaches the callback; the harness
  asserts that answer for a term matching another org and a term matching nobody is identical
  (no leak), and asserts the leak as it is with the setting on (labelled `KNOWN GAP`).
- **Rooms that already exist, and the service account.** The module changes what can happen from
  now on; a room that was public or world-readable before the redeploy stays so (`railway.md`).
  The service account, being a server admin, is exempt from every callback, including making a
  public room.
- **Guessable ids.** Ids embed the org id and a tenant id. Neither is secret. The wall does not
  rely on ids being unguessable, so this is a metadata note, not a hole.
- **A leaked person token.** Bounded by `valid_until_ms` only (§5). Use a short expiry with
  refresh.
- **Noisy neighbours.** Rate limits (`rc_message`, `rc_invites`, `rc_joins`) are per user or per
  room, not per org, so one org can degrade the others' latency.
- **Everything outside Matrix.** Duos of different orgs still run in one daemon process
  (`hosted-mode.md`). The org wall governs the workspace, not that process or the per-duo stores.
- **Federation.** Off, so no remote server can invite or join. The federation-only callbacks
  (`federated_user_may_invite`) are then unreachable. Turning federation on would need a fresh
  decision.

### 6.5 Verified against a real Synapse (#235, 2026-09-26)

The module (`deploy/synapse/modules/duo_org_wall/`) was run inside `matrix-synapse==1.161.0`
from PyPI (Python 3.13), configured by `render_config.py`'s own output (only the database, port
and paths swapped: SQLite, loopback, a temp dir), with `@workspace-admin` created by
`create_admin.py` and two orgs' people and duos created through the admin API. 101 checks over
HTTP (`tests/real_synapse.py`) plus the daemon's TypeScript provisioning (`MatrixProvisioner`,
`OrgSpaceProvisioner`) against the same server. Both are opt-in; how to run them:
`docs/deploy/railway.md`. What was **observed**:

- **Provisioning joins pass.** The Spaces and `#general` rooms, created the way
  `SynapseAdmin.createPrivateRoom` does, take same-org admin-API joins of a person and a duo
  (`user_may_join_room` is called, with `is_invited=True`, and accepts). The daemon's own
  `OrgSpaceProvisioner.syncMember` did the same for two orgs, and its re-run was a no-op.
- **Cross-org is refused.** An admin-API join of another org's person or duo into a Space or
  `#general`, an org-less account, and a malformed id (two dots) all answer `403 M_FORBIDDEN`. A
  cross-org invite, a DM to another org, a `createRoom` with one cross-org id in `invite`, and a
  3pid invite (both in `createRoom` and on an existing room) are refused with our sentence.
- **Public rooms, every way in.** `visibility: public`, `preset: public_chat`, and an
  `initial_state` `m.room.join_rules` of `public`, `knock` or `private` with no visibility and no
  preset, are refused at creation. A `PUT` of a public `m.room.join_rules` into an existing
  private room is refused (`check_event_for_spam` fired). So is a `world_readable` history
  visibility, in `createRoom`'s `initial_state` and in a state `PUT`; with the alias attack
  (alice aliases a private room, carol resolves the alias and reads `/messages`, `/initialSync`
  and `/state` with the room id) the reads answer `403`, and a control run with **no module**
  shows the same reads answering `200` with the message. Publishing to the room directory is
  refused. Room upgrade works and passes `initial_state` as a list of dicts on 1.161.0, so the
  v1.140.0 shape holds. `initial_state` with `restricted` allowed only for a room of the
  creator's org.
- **Directory.** With `search_all_users: false`, alice sees her org and never the other org, the
  service account, or org-less accounts. With `search_all_users: true` the module alone does the
  same, and a control run with **no module** shows the other org and lets a cross-org invite and
  a public room through, so the checks can detect a missing wall.
- **The service account.** Invites across orgs, sends state events, sees every org in its own
  search, and **creates a public room without the module being asked** (Synapse skips
  `user_may_create_room` for a server admin, as the record says).
- **A module that cannot load stops Synapse** (exit 1: an unknown module path, and a config the
  module's `parse_config` rejects). The wall is not silently absent.
- **Mutation check, re-runnable.** `real_synapse.py --mutate NAME` runs every phase against a
  copy of the module with one line made wrong, and `--mutate-all` runs each of them (`--mutate
  list` names them). The earlier claim that "disabling the invite and join comparisons fails six
  checks" is withdrawn: it could not be reproduced. What is observed now (2026-09-27, v1.161.0;
  a count can differ by one when a wait times out on a loaded machine, what matters is that it is
  not zero): `invite-off` 2, `join-off` 7, `join-ignores-invited` 1, `two-dots` 2,
  `create-invite-list-off` 1, `create-public-off` 1, `create-member-entry-off` 3,
  `create-join-rules-off` 4, `create-history-off` 2, `history-world-readable-ok` 5,
  `event-join-rules-off` 3, `event-history-off` 5, `publish-off` 2, `3pid-off` 1,
  `directory-off` 5, `fails-open` 2. **Two that broke nothing before now break something**: an id
  with two dots is joined into a fresh room (the earlier check was refused only because carol's
  invite already made the room unjoinable), and an org-B invitee who has only been invited counts
  against an org-A joiner. **One is unit-test-only, by design:** `newline-anchor` (parsing with
  `$` instead of a full match, so a trailing newline in an id still parses), because Synapse never
  lets an id with a newline exist and no real request can carry one; `test_rules.py` covers it.
- **Known gaps, asserted as they are** (labelled `KNOWN GAP` in the harness, §6.4): a cross-org
  `sendToDevice` is delivered, `/keys/query` returns another org's device keys and display name,
  and with `search_all_users: true` a limit-1 search answers `limited: true`. If Synapse changes
  one of these the check fails, which is the point: read what it does now and update §6.4.

Findings the record did not have, which the next reader should know:

- **A refused admin-API join leaves the admin's invite pending.** The admin API invites as the
  service account before it joins as the target, and only the join is judged. So after a refused
  cross-org join the target has a pending invite to that room, and its `invite_state` carries the
  room's create, join-rules, member and **name** events (`include_profile_data_on_invite: false`
  does not remove the name). The target cannot accept it (their own join is refused too). The
  daemon never asks for a cross-org join (`OrgSpaceProvisioner` compares both ids' orgs first),
  so this needs a bug or a misused admin token to occur, but it is why that check must stay.
- **A room holding only the service account has no org to compare with.** The first person the
  service account joins there is accepted whatever their org; that person then sets the room's
  org, and another org's join is refused. Not exploitable by a member (only the service account
  can seed such a room, and org rooms are created and joined by the daemon in order), but the
  daemon, not the module, is what puts the right org's first member in.
- **`initial_state` is written without any callback but `user_may_create_room`.** A `createRoom`
  with an `m.room.member` invite entry for another org's user answered `200` and delivered the
  invite (with the sender's `reason`) to that user's next `/sync`; a `world_readable` entry made
  the room readable to other orgs. The first version of the module read only the join rules there.
  Both are now refused, with a check that the invite is not delivered, and each was run against
  the module before the fix (both succeeded) and after (both `403`).
- **The `private_chat` preset writes `guest_access: can_join`,** and a room upgrade copies the
  old room's state into the new room's `initial_state`. Refusing `can_join` at creation therefore
  broke every upgrade (found when the upgrade check failed), so `initial_state` guest access is
  not judged; a member setting `can_join` later by state `PUT` is refused. Guests are off on the
  server, so this has no effect today. A room that already has `world_readable` history cannot be
  upgraded (its `initial_state` carries it): a consequence of the wall, and only for rooms that
  predate it.
- **Synapse's own validation 500s on a non-object `initial_state` entry** before the module is
  asked. Nothing is created; the module's own handling of it is unit-tested.

**Not verified.** The image was not built (no Docker): the `COPY`, the `rm -rf` of the tests,
`compileall`, `chmod -R a+rX` and `ENV PYTHONPATH` lines, and the `gosu` 991 read of `/modules`,
are read, not run; the base image's Python (3.13) and lack of a
`PYTHONPATH` were read from its registry config. Nothing ran on Railway or against Postgres (the
module does no database work of its own; `get_room_state` is Synapse's). The two-orgs end-to-end
check on Railway is **not done** (#235 stays open until it is). Federation was not exercised (off in the config). Load: one
room-state read per join, none for invites, publishes or directory hits; not measured.

## 7. Super admin, and no org admins

- **Super admin** is exactly what exists today: a signed-in Google account whose email is in
  `DUO_HOSTED_ADMIN_EMAILS` (`HostedTenant.isAdmin`), or the server-side `DUO_HOSTED_ADMIN_TOKEN`
  on the box. It creates, renames and lists orgs, lists any org's members, and mints invites
  into a named org.
- **The super admin is a member of one org like everyone else.** In the workspace they see their
  own org and no other. Being super admin is a registry power, and the account has no Synapse
  admin rights. The only Synapse admin is `@workspace-admin`, held by the daemon.
- **No org admins in the POC.** Nobody can invite into an org except the super admin. Deleting
  an org is out of scope too. Both are recorded as follow-ups (#231's own out-of-scope list).
  Adding org admins later means one registry flag and a per-org invite check in the same routes,
  with no change to the Matrix side.

## 8. Sessions and duo connections (context for #233 and #236)

- **A person's session** is minted on demand for the Google-signed-in caller's own account only:
  `POST /_synapse/admin/v1/users/<personUserId>/login` with `valid_until_ms`, returned to the app
  with the public homeserver URL. The route never mints the duo's. The route is per duo
  (`POST /t/<tenantId>/workspace/session`, or `/workspace/session` for the root duo), served by
  that duo's own device-token auth, so the token is verified in one store and no request field
  names an account. **The daemon keeps the token, in memory only** (one live bearer per active
  person, at most 24 hours, never on disk or in the registry, gone on restart), so that it can
  hand the same token out again instead of minting per request, and can end it: when a device of
  the duo is revoked, or the duo is ended, it makes a best-effort Matrix `POST /_matrix/client/v3/logout`
  with that token and forgets it. The daemon never probes the token at Synapse (not even
  `whoami`): any authenticated call as the person makes Synapse record the caller's address and
  user agent against the token (`user_ips`), which would be the daemon's, every few minutes. A
  client whose token Matrix refuses (`M_UNKNOWN_TOKEN`) calls `DELETE` on the same route and asks
  again. The trade-off is that this process's memory holds a live bearer for the people who are
  active in every org.
- **A duo's connection** uses the token from the registry (§3), decrypted in the daemon, in
  place of `DUO_WORKSPACE_ACCESS_TOKEN`. The existing single-owner env variables
  (`DUO_WORKSPACE_HOMESERVER`, `DUO_WORKSPACE_ACCESS_TOKEN`, `DUO_WORKSPACE_USER_ID`) are read
  by the personal-hardware path; hosted mode reads `DUO_WORKSPACE_PRIVATE_URL` (the private URL,
  §5) and `DUO_WORKSPACE_PUBLIC_URL` (the https URL returned to clients) and ignores the other
  two.

  > **Built 2026-09-26 (#236).** `src/hosted/duo-workspace.ts` (`DuoWorkspaceConnections`). The record
  > above said `DUO_WORKSPACE_HOMESERVER` for the private URL; #232 named it `DUO_WORKSPACE_PRIVATE_URL`
  > and that is what is read. One connection per provisioned duo, the root duo included, started when the
  > registry says the duo has accounts (at boot, or later when provisioning completes) and restarted when
  > its token is re-minted, stopped on `close()`. It only queues at boot: dialing, and building each duo's
  > service (one decrypt of that duo's store), happen off a timer, capped and staggered
  > (`DUO_HOSTED_WORKSPACE_MAX_DIALS`, `DUO_HOSTED_WORKSPACE_STAGGER_MS`, defaults 5 and 500 ms). Details
  > and the variable list are in `hosted-mode.md`.
  >
  > Two things the record did not say. **The duo answers in a room it has joined**, and a duo joins a room
  > only when its owner allows the invitation (#192, unchanged): a colleague's first direct message to
  > `@duo-...` is an invitation the owner decides on, then questions in that room are answered. The Space
  > and `#general` the admin API joins the duo to are group rooms, which the duo does not answer in without
  > a recorded allow. **The duo's token is minted by the admin login API and has no device** (§5), so its
  > `/sync` runs without a device id; the fake homeserver in the measurement below cannot show whether
  > Synapse serves that the same way (**verify at the first real deploy**, see §12 #236).
- **A duo's own `env` is built from an allowlist.** `tenantDeps` in `src/hosted/server.ts`
  (lines 117-118) currently spreads the whole process environment (`...shared.env`) into every
  duo's `deps.env`, so once #230 sets `DUO_WORKSPACE_ADMIN_TOKEN` (an acts-as-any-user token)
  each mounted duo's env would hold it, as `DUO_HOSTED_MASTER_KEY` and `DUO_HOSTED_ADMIN_TOKEN`
  already do today. Hosted mode must build a duo's `env` from an allowlist that omits
  `DUO_WORKSPACE_ADMIN_TOKEN`, `DUO_HOSTED_MASTER_KEY` and `DUO_HOSTED_ADMIN_TOKEN`. Owned by
  #236 and #232. Not checked here: whether any per-duo route reads `deps.env` and returns or
  logs values, which the allowlist makes moot.
- **matrix-js-sdk's logging is per client only in part.** Each duo's client is given its own logger, filtered by
  `DUO_HOSTED_WORKSPACE_SDK_LOG` (silent by default) and routed through the duo's scrubbed log. matrix-js-sdk
  42.4.0 still calls its **process-wide** logger directly from `models/room.js`, `models/event.js`,
  `models/event-timeline-set.js` and `sync.js`. Those lines cannot name a duo, are not silenced by the
  variable, and are not scrubbed of the duo's token (which the SDK sends in a header, not in those messages).
  Read the daemon's stdout as sensitive; **verify at the first real deploy** which of them a busy Synapse
  room produces.
- **Resource numbers** for N concurrent sync loops in one process (#236, measured 2026-09-26):

| Duos connected | Daemon heap used | Timers / sockets held (daemon side) | CPU to connect all | CPU when idle | Event loop held, worst |
|---|---|---|---|---|---|
| 0 (baseline) | 24.2 MB | 0 / 0 | 0 | 0.6% of one core | 12 ms |
| 1 | 26.0 MB | 6 / 1 | 0.20 s | 0.5% | 42 ms while connecting |
| 5 | 27.1 MB | 30 / 5 | 0.77 s | 0.5% | 187 ms while connecting |
| 20 | 28.7 MB | 120 / 20 | 2.7 s | 0.4% | 190 ms while connecting |
| 50 | 33.1 MB | 300 / 50 | 6.2 s | 0.4% | 155 ms while connecting |
| 100 | 40.8 MB | 640 / 100 | 11.6 s | 0.5% | 194 ms while connecting |

  **These rows use empty stores.** Each duo's store had no records, so opening it cost the fixed key
  derivation (scrypt) and little else. A store is opened whole (decrypted, read and re-encrypted) on
  every read-state check and every answer, on the one thread that serves all hosted duos, so a real
  corpus costs more than the rows say. Re-measured with each store seeded with 5,000 records (about
  1.9 MB of text; `MEASURE_RECORDS=5000`, 2026-09-27, same machine, one run per row; the 20 and
  larger populated runs were not completed):

| Duos | Records per duo | One open of a store (median, max) | CPU to connect all | Event loop held while connecting, worst | Heap after connecting |
|---|---|---|---|---|---|
| 1 | 0 | 50 ms, 50 ms | 0.18 s | 11 ms | 26.0 MB |
| 1 | 5,000 | 67 ms, 67 ms | 0.18 s | 19 ms | 29.1 MB |
| 5 | 0 | 50 ms, 50 ms | 0.66 s | 112 ms | 26.4 MB |
| 5 | 5,000 | 92 ms, 101 ms | 1.04 s | 123 ms | 28.6 MB |

  A populated store adds roughly 20 to 40 ms per open at 5,000 records, on top of about 50 ms fixed, so
  the "held for up to about 190 ms" figure below is for **empty stores** and is not a bound: it grows
  with store size, and **store size is not measured beyond 5,000 records (about 1.9 MB)**. Size the
  pilot's largest duo, seed a store to match, and read `eventLoopLagMaxMs.whileConnecting` and
  `storeOpenMs` from the script before trusting these figures for it. The script reports one open of
  each store separately (`storeOpenMs`), apart from client construction.

  **Read as:** about **0.17 MB of heap per connected duo** (16.6 MB more than the baseline at 100), about
  **6 timers and 1 socket per duo**, **about 0.12 CPU-seconds per duo once, to connect** (almost all of it
  the synchronous decrypt of that duo's store, which is also why the event loop is held for up to about
  190 ms at a time while duos connect, on empty stores; see above), and **an idle cost that does not grow with N**
  (0.4 to 0.6% of a core with every sync held open). A first connection in the process also pays a one-off
  of roughly 40 MB of resident memory for loading matrix-js-sdk. Resident memory (RSS) on this machine is
  too noisy to give a per-duo figure (it read 78 to 169 MB across the runs above, with no trend against N):
  macOS compresses idle pages, so heap is the number to trust, and the Railway service's own memory graph
  is the check that counts.

  **With the defaults (5 at a time, 500 ms apart) 100 duos take about 55 seconds to all be connected**
  after boot, at most 2 new sessions per second, and every duo is answering as soon as it is in.

  **Method.** `scripts/measure-hosted-workspace.ts <duos> [idleSeconds]` (run under `node --expose-gc`
  through `tsx`, once per N, each in a fresh process). It builds N tenants in a real `HostedRegistry`,
  each with its own encrypted store, records an account and token for each, and attaches them to the
  daemon's real `DuoWorkspaceConnections` with the production defaults. Each connection is the real
  `createMatrixTransport` over a real matrix-js-sdk 42.4.0 client, given the daemon's own `sdkLoggerFor` at its default (silent) level, syncing against a small fake homeserver
  in the same process (it answers the calls a syncing client makes and holds each `/sync` open for the
  client's own 30 s timeout, as Synapse does). Heap is `process.memoryUsage().heapUsed` after a forced GC,
  30 seconds after every duo reported connected; CPU is `process.cpuUsage()` over the connect phase and
  over that 30 s idle window; timers and sockets come from `process.getActiveResourcesInfo()` and are the
  daemon's side: the fake server, in the same process, adds one socket and one hold timer per open `/sync`,
  which are taken out (sockets halved, timers less N and the script's own tick). Machine: Apple
  M1, 8 cores, 16 GB, Node 22.22.3, one run per N.

  **What it does not measure.** Store size beyond what `MEASURE_RECORDS` seeds (see above). The fake homeserver is far lighter than Synapse, so this is the
  **daemon's** side of N sync loops and says nothing about Synapse's own CPU, memory or Postgres load, nor
  about real sync payloads (a duo in many busy rooms holds far more state than an empty room per duo).
  Answers are not in it: drafting is LLM-bound and not a per-connection cost. The Railway container's CPU
  allowance is different from an M1 core: check the deployed service's graphs after the first real deploy.
  After `close()`, matrix-js-sdk leaves its own per-request abort timers (2 or 3 per duo, 80 to 110 s) to
  expire on their own: they are the SDK's, they do not hold a connection, and the daemon exits on
  SIGTERM without waiting for them.

## 9. Posture

- Every org's messages sit on Railway. The owner accepted third-party infrastructure for this
  POC (`railway.md`, 2026-09-26). It is **not cleared for classified or sensitive government
  material**, and this record does not change that.
- `workspace-platform.md` §5 is unchanged. The homeserver holds identity, conversations,
  messages, read state and files, and **never** a corpus, a passphrase, derived rules or draft
  evidence. Hosted provisioning does not move any of those: the registry holds a duo's Matrix
  token encrypted under `DUO_HOSTED_MASTER_KEY`, which is a credential, not corpus.
- Nothing here waives `org-mode-deployment.md` §6. This record widens its operator concession
  from "the box holds N daemons" to "the box also holds N orgs' messages".

## 10. Homeserver choice: Synapse

The wall needs two things from a homeserver: an **in-server hook** that can veto an invite, a
join and a directory hit, and an **HTTP admin API** the daemon can call to create accounts and
mint tokens. Synapse has both (§5, §6). Checked on 2026-09-26:

- **Tuwunel** documents no module or hook mechanism, and administration is by `!admin` commands
  sent in a room. Its published documentation was silent on both when checked.
- **Continuwuity** is the same shape: `!admin` commands, and its documentation lists an "Admin
  API" under what it is "working on".

We found no documented extension point in either that could refuse a cross-org invite, and no
HTTP admin API to provision accounts. That is "not documented", not proof it cannot be done:
revisit if either ships both. Everything about Synapse in this record is what its docs and
source say for the version pinned in #230 (at least v1.140.0).

**Licence consequence.** Synapse is AGPL-3.0. `workspace-platform.md` §4 calls the obligation
effectively nil for an internal, unmodified deployment. This design is neither: it loads our own
module into Synapse, and the POC is reachable from the internet. Whether a module loaded through
`modules:` makes a modified Synapse is a legal question we do not settle here, but the safe
reading is that AGPL §13 applies. The consequence to plan for is that **the module's source is
published**: offered to every user who interacts with the server, in practice a public
repository, with nothing secret in it (its config, including `service_accounts`, is deployment
config and stays out of that source). The module being open source does not weaken the wall,
which never rested on its secrecy. Owned by #235; `workspace-platform.md` §4 has the dated note
(2026-09-26).

## 11. Synapse configuration the other issues rely on

| Setting | Value | Why |
|---|---|---|
| `federation_domain_whitelist` | `[]` | The docs call an empty list "the recommended way of disabling federation". Also do not expose a federation listener. |
| `enable_registration` | `false` | No self-registration. Does **not** disable the shared-secret admin API (§5). |
| `registration_shared_secret` | Railway variable, set only while #230 bootstraps `@workspace-admin`, then **unset** | One-time creation of `@workspace-admin` (§5). Unsetting it disables the shared-secret API, which `enable_registration: false` does not. With `registration_shared_secret_path` Synapse creates the secret on its volume when missing, so no variable holds it: use the plain variable here, since a variable can be unset. |
| `user_directory.search_all_users` | `false` | Directory scoping (§6.1). |
| `user_directory.show_locked_users` | `false` (default) | |
| `require_auth_for_profile_requests` | `true` | Prerequisite of the next line. |
| `limit_profile_requests_to_users_who_share_rooms` | `true` | Stops profile lookups across orgs. |
| `include_profile_data_on_invite` | `false` | Stops the invite event carrying a profile. |
| `allow_public_rooms_without_auth` | `false` (default) | Keep the public room directory private (it should stay empty). |
| `modules` | Our module, with `server_name` and `service_accounts: ["@workspace-admin:<server>"]` | Shipped in #235 (`deploy/synapse/modules/duo_org_wall`, rendered by `render_config.py`) |
| `rc_joins`, `rc_invites`, `rc_message` | Defaults are fine for provisioning | The admin-API join calls the membership handler with `ratelimit=False` (source), so provisioning is not throttled by these. They still bound ordinary users, so #230 checks a burst of duo sync traffic and raises `rc_message` if the duos' answers are throttled. |
| Synapse image tag | Pinned, at least v1.140.0 | `room_config` (v1.132.0), a correct `initial_state` in `room_config` on room upgrade (v1.140.0, #18721; before it, an upgrade passed a list of `((type, state_key), content)` tuples instead of `{type, state_key, content}` dicts), `requester_id` in `check_username_for_spam` (v1.122.0). Not `latest`. |

## 12. Corrections and flags for the child issues

Nothing below is a change of scope. These are places where this record is more specific than
the issue text, or where the issue text needs a small fix. The same corrections are posted as a
comment on each child issue.

- **#230** (Synapse service):
  - Pin Synapse at **v1.140.0 or later**, not `latest` (§11).
  - Bootstrap `@workspace-admin` through the shared-secret `POST /_synapse/admin/v1/register`
    with a random password that is discarded. The response carries the `access_token`; store it
    as `DUO_WORKSPACE_ADMIN_TOKEN`. Login-as-user cannot mint it (§5). This is the one account
    with a password.
  - After bootstrap, **unset** `registration_shared_secret` (and delete the secret file if
    `_path` was used). Unsetting disables the API; `enable_registration: false` does not.
  - Confirm the scheme of the private address (`http://<service>.railway.internal:<port>`).
- **#231** (orgs and super admin):
  - Today's `requireAdmin` (`src/hosted/server.ts`) answers `401` for every caller that fails
    the admin test, including a valid non-admin device. PR #241 (open when this record was
    written) changes it to `401` for no credential and `403` for any presented credential that
    is not a super admin's. That is simpler than resolving the device: a garbage token also
    gets `403`. Word the issue's `403` as "a presented, non-admin credential", not "a signed-in
    non-admin", unless #241 is changed to resolve the device first.
  - Existing invite routes may keep their behaviour.
- **#232** (provisioning):
  - Name accounts as in §4 (org id in the localpart), not `@shin:<server>`. The issue's
    examples were "e.g.". The root duo needs accounts too (handle `root`).
  - `HostedMatrixAccounts.duoUserId` is a `string`, but `duoUserIdFor` returns `string | null`:
    assert non-null when provisioning (§3).
  - Relax the https-only rule in `src/workspace/settings.ts` for hosts ending in
    `.railway.internal`, and read the client-facing URL from `DUO_WORKSPACE_PUBLIC_URL` (§5,
    §8). Shared with #236.
  - Build each duo's `env` from an allowlist, omitting `DUO_WORKSPACE_ADMIN_TOKEN`,
    `DUO_HOSTED_MASTER_KEY` and `DUO_HOSTED_ADMIN_TOKEN` (§8). Shared with #236.
- **#233** (sessions): an admin-minted token has no device, so the route returns
  `deviceId: null` (the transport does not use one). A client needing a device for end-to-end
  encryption would have to create one separately
  (`POST /_synapse/admin/v2/users/<user_id>/devices`); the POC does not depend on E2EE. The
  daemon does hold the token it minted (in memory, §8), so revoking a device ends it with a
  best-effort `/logout`; "sign out revokes" for the client's own sign-out is still the client
  calling `/logout`, and a short `valid_until_ms` is the server-side bound when either fails.
  Return the public URL from `DUO_WORKSPACE_PUBLIC_URL`, not the private one. Shipped in
  PR #244: the route lives on each duo (`/t/<id>/workspace/session`), not under `/hosted`, so the
  device token is verified in the one store it names.
- **#234** (Spaces) must create the Space and `#general` as non-public rooms, keep
  `@workspace-admin` in each, and treat its provisioning joins as calls that pass through the
  module (§6.2).
- **#235** (module):
  - Read the org from the id (§4). The issue's "server-admin exemption" is automatic for
    invites and for its own joins, but not for the target-user joins it performs on members'
    behalf.
  - Add `user_may_publish_room`, `user_may_send_3pid_invite` and a join-rules guard (§6.2).
  - In `user_may_create_room`, also refuse an `initial_state` `m.room.join_rules` that is not
    `invite` (or `restricted` to the org's Space) (§6.3 rule 3): `check_event_for_spam` never
    sees creation events. Verify with a test.
  - Synapse never calls `user_may_create_room` for a server admin, so rule 3 cannot constrain
    any admin account.
  - Requires Synapse v1.140.0 or later for a correct `initial_state` on room upgrade.
  - Licence: the module is loaded into an internet-reachable AGPL Synapse, so plan to publish
    its source (§10).
  - **Shipped 2026-09-26** as `deploy/synapse/modules/duo_org_wall/`, with the deviations in §4.2
    and §6.2 and what was observed in §6.5. Every "verify in #235" above is now settled there.
- **#236** (hosted wiring) owns the resource measurement in §8. The hosted process does not
  open a workspace connection until #232 has stored a token for that duo. It also shares the
  `.railway.internal` https relaxation and the per-duo `env` allowlist with #232.

  > **Built 2026-09-26 (#236).** Both shared items were already in place from #232 (`settings.ts`
  > accepts http on `*.railway.internal`; `TENANT_ENV_ALLOWLIST`). What #236 added is in §8 and in
  > `hosted-mode.md`. **Not verifiable without a real Synapse, and to check at the first deploy:**
  > (1) that `/sync` works for a duo's admin-minted token, which has no device id (§5); (2) that the
  > private `http://<service>.railway.internal:<port>` address is reachable from the daemon with matrix-js-sdk
  > (Railway's private network is IPv6, so Synapse must listen on `::`); (3) that the admin API's
  > invite-then-join of a duo into its org's Space and `#general` does not leave a held invitation for the
  > owner to decide on (the client sees an `invite` membership, and the duo would hold it as pending); (4) the
  > org module (#235) lets a colleague's direct-room invitation to a duo through and the duo's joins and sends
  > in it; (5) that the duo's own token is not throttled by `rc_message` while answering.

## 13. Sources (checked 2026-09-26)

All Synapse docs are the `element-hq/synapse` repository's `develop` branch (v1.162.0rc1,
2026-09-22); the published site is <https://element-hq.github.io/synapse/latest/>.

- Spam checker callbacks (`user_may_invite`, `user_may_join_room`, `user_may_create_room`,
  `user_may_publish_room`, `user_may_send_3pid_invite`, `check_username_for_spam`,
  `check_event_for_spam`, `check_registration_for_spam`, `federated_user_may_invite`):
  <https://element-hq.github.io/synapse/latest/modules/spam_checker_callbacks.html>
- Third-party rules callbacks (`check_event_allowed`, "very experimental"):
  <https://element-hq.github.io/synapse/latest/modules/third_party_rules_callbacks.html>
- Writing and loading a module (`modules:` config, `parse_config`, `ModuleApi`):
  <https://element-hq.github.io/synapse/latest/modules/writing_a_module.html>
- Admin API, users (create/modify, login-as-user, devices, override ratelimit):
  <https://element-hq.github.io/synapse/latest/admin_api/user_admin_api.html>
- Admin API, room membership: <https://element-hq.github.io/synapse/latest/admin_api/room_membership.html>
- Shared-secret registration:
  <https://element-hq.github.io/synapse/latest/admin_api/register_api.html>
- Configuration manual (`user_directory`, `federation_domain_whitelist`, `enable_registration`,
  `registration_shared_secret`, `require_auth_for_profile_requests`,
  `limit_profile_requests_to_users_who_share_rooms`, `include_profile_data_on_invite`,
  `enable_authenticated_media`, `rc_*`, `user_types`):
  <https://element-hq.github.io/synapse/latest/usage/configuration/config_documentation.html>
- User directory internals (public-room and shared-room tables):
  <https://element-hq.github.io/synapse/latest/user_directory.html>
- Synapse source read for behaviour the docs leave out:
  `synapse/handlers/room_member.py` (invite and join bypass for server admins; the spam
  callbacks run for the target of an admin-API join), `synapse/rest/admin/rooms.py`
  (`JoinRoomAliasServlet`), `synapse/module_api/callbacks/spamchecker_callbacks.py`
  (callback return handling, no exception handler on the invite path),
  `synapse/module_api/__init__.py` (`get_room_state`, added v1.47.0), and `CHANGES.md`
  (`room_config` argument v1.132.0; `initial_state` room-upgrade fix v1.140.0, #18721;
  `requester_id` for `check_username_for_spam` v1.122.0).
  Latest release v1.161.0 per the GitHub releases API.
- Tuwunel: <https://github.com/matrix-construct/tuwunel> and
  <https://matrix-construct.github.io/tuwunel/>. Continuwuity: <https://continuwuity.org/introduction>.
  Both read for "module or hook API" and "HTTP admin API"; neither was found documented.
- Repo, read from source: `src/hosted/registry.ts`, `src/hosted/server.ts`,
  `src/workspace/directory.ts` (`duoUserIdFor`, `duoOwnerUserIdOf`), `src/config.ts`
  (`DUO_WORKSPACE_*`), `docs/deploy/hosted-mode.md`, `docs/deploy/railway.md`,
  `docs/workspace/org-mode-deployment.md`, `docs/workspace-platform.md` §5–§7.
