# Digital Duo — What the Org Can Read

> Decision record for #191 (parent #184). Status: **PROPOSED** — this document becomes the
> decision when the PR carrying it is merged. Every Synapse and Matrix capability claim below
> was verified against its source on 2026-09-25; sources listed at the end.
>
> This record sits inside the boundary `workspace-platform.md` §5 draws, and does not move it.
> The corpus, the passphrase, the derived rules and a draft's evidence never touch org
> infrastructure. What is decided here is the other side of that line: the workspace server
> holds every message anyone sent — `#184` calls it "its own sensitive store with its own
> administrators" — and this decides what those administrators, and the organisation they
> answer to, can read. Before anyone can.

---

## 1. The decision

1. **Workspace messages are readable by the org that hosts them.** Rooms are **not
   end-to-end encrypted by default**. Encryption is applied where the deployment controls
   it: TLS in transit, volume encryption at rest. The keys to both are held by the workspace
   infrastructure administrators, in the same custody as the database credentials. No
   cryptographic barrier stands between the org and message content — what stands there is
   role, process and audit (§3).
2. **E2EE is opt-in per room, and off in the pilot.** The platform record's reasoning stands:
   in an E2EE room the server stores only ciphertext, and keys stay on members' machines.
   But on org-operated infrastructure E2EE is resistance to compromise, not denial to the
   org, and it costs a workplace tool more than it pays (§2). Admitting E2EE rooms is a
   security-review decision, recorded the way federation is (`workspace-platform.md` §7).
3. **Administrator reads are deliberate, named, and logged — by us, not by Synapse.** Synapse
   writes no compliance-grade record of who read what, and the worst path (direct database
   access) writes no application log at all. The pilot's control is accountability, stated
   honestly to members as such: a logged export path for every sanctioned read, break-glass
   monitoring for the paths that cannot be closed, few hands, separation of roles (§3).
4. **Messages are records.** Retention follows the org's records rules, enforced by
   Synapse's retention and purge facilities. Deletion is real on the live server and bounded
   by backup rotation — redaction alone is hiding, not erasure. A member who leaves takes
   their identity with them and leaves their messages behind (§4).
5. **A duo answer travels without its evidence.** Provenance, sources and grounding chunks
   never accompany a sent answer; they stay in the daemon, with the corpus they index. What
   the room sees is text the owner chose to send — nothing more (§5).
6. **The asymmetry a member acts on:** everything sent in a message is a record on org
   infrastructure, including who talks to whom and when; nothing about a member's documents —
   not their text, not their names, not the evidence the duo consulted — reaches the server,
   even when a duo answers from them (§6).

## 2. Encryption and keys

**Decision: rooms are server-readable by default; E2EE is off in the pilot.**

The question is not whether E2EE works — it does, and the platform record already relies on
its mechanics for the corpus boundary. The question is whether the org should be
cryptographically locked out of its own workplace records. In a government pilot it should
not be. Official communications are records: they carry retention duties, investigation
duties, legal hold. A workplace store the org cannot read cannot meet any of them — an
investigation fails at the protocol layer, and the demand moves to a channel with no audit
at all. Readability, governed by §3, is the posture the pilot exists to demonstrate.

What E2EE-by-default would cost this specific architecture, concretely:

- **Keys would live on members' machines — including duos'.** A duo's room keys sit in the
  owner's daemon. That is exactly where §5 wants them, but it makes the duo a key-holder of
  record for its rooms, and the duo is asleep when the owner's laptop is (AR-10). A member
  joining an E2EE room can only decrypt history through session keys re-shared by the online
  clients of existing members (or a server-stored key backup — which puts backup keys back
  on the server). Room history that waits on someone's Mac being open is broken for a
  workplace tool.
- **Key loss becomes records loss.** A tool that silently loses history when a device dies
  has a data-loss incident, not a privacy win.
- **Verification becomes a daily tax** — every member, every duo, every device, before
  anyone trusts a key.

And the honesty that settles it: **E2EE on org-operated infrastructure does not deny the
org.** The homeserver controls device lists and key distribution; an actively malicious one
can inject a device into an account or steal message keys at invite time (CVE-2024-47824;
the matrix.org implementation guide is written around exactly this adversary). So the real
choice is not "org can read" versus "org cannot read" — it is "the org reads in the open,
governed by an audit trail" versus "the org reads by acting maliciously, ungoverned". The
pilot takes the governable option and spends its effort on §3 instead.

At rest, the plain facts: Synapse has no at-rest encryption of its own — events live in the
database, media as files on the local disk. The deployment requirement is therefore volume
encryption on the server, TLS on every connection, and credentials held by named roles. The
people who could decrypt the volume are the same people who could read the database — one
custody chain, stated once, honestly (§3), not two illusions.

## 3. Who can read message content, and what is written down when they do

| Role | Holds | Can read content | How it is logged |
|---|---|---|---|
| Room member | their account | every room they are in | normal message flow — no admin log |
| Compliance/investigation role | export-tool authority | any room, via the export path only | every export recorded: requester, scope, stated basis (§4) |
| Workspace administrator | Matrix server-admin rights | any non-E2EE room — `POST /_synapse/admin/v1/users/<id>/login` mints a token for any user, creates no device, and the target cannot tell | break-glass: token use is not user-visible in Matrix; monitored at the host |
| Infrastructure administrator | host, database and backup credentials | everything, directly | break-glass: no application log exists for a database read; session-level logging on the host |

Two things must be said plainly, because a government pilot will ask:

- **"Can" and "may" are different questions, and Synapse answers only the first.** The
  Admin API lets a server admin impersonate any user invisibly; the database lets whoever
  holds its credentials read every table; neither writes a log line that would survive an
  inquiry. We do not claim otherwise. What the pilot builds is the accountability layer
  Synapse lacks: the sanctioned path for reading content is a **separate export service**
  we operate, which authenticates the requester, records who/what/why to an append-only
  log, and emits a transcript plus media under the room's classification. Admin accounts are
  few, the compliance role and the infrastructure role are held by different people, and
  break-glass paths sit behind host-level session logging. Prevention is not on offer;
  detection and discipline are. Members are told this in exactly those words.
- **The export service is ours, calling the stock Admin API over HTTPS — Synapse stays
  unmodified**, so `workspace-platform.md` §4's internal-unmodified deployment posture holds
  and no AGPL question is opened.

This is the audit trail the issue's expectations demand — administrator accountability —
built where the platform provides none.

## 4. Retention, deletion, export, and leaving

**Retention.** Messages live as long as the org's records rules say, not forever and not
indefinitely. Mechanism: Synapse's message retention policies — a `default_policy` bounded
by `allowed_lifetime_min`/`max`, enforced by periodic purge jobs. Verified caveats, accepted:
an expired event stops being served immediately but leaves the database at the next purge
run; Synapse never deletes a room's last message, it hides it; purged space needs a VACUUM
back. (The feature follows MSC1763 and is marked experimental — acceptable inside a
deployment we operate end to end, re-checked at scale-up.)

**Deletion.** The honest version: *deleted* means gone from the live server, and gone from
backups when they age out. Redaction prunes an event, but servers commonly retain redacted
content deliberately (moderation) and every backup keeps its copies — redaction is a hiding
act, not erasure. The instruments that actually remove content on this single,
federation-off server are the admin purge APIs: purge history before a point, or delete a
room outright with `force_purge`. Backup rotation is therefore part of the deletion story
and is stated to members as the deletion horizon.

**Export and legal hold.** An investigation or a hold uses §3's export path: transcript and
media, logged, classification-inherited. A hold suspends retention purging for the room and
suspends backup rotation for the affected volumes — an expiring message under hold is
exported first.

**When a member leaves.** Their messages are records and **stay**. Offboarding deactivates
the account with `erase` — Synapse removes the identity: profile, devices, E2EE keys, tokens,
and the user leaves all rooms. It explicitly does **not** delete sent messages; what they
sent remains visible to everyone who was in the room at the time, and to the compliance
export, while users who join later no longer see the erased author's history. That split —
identity gone, words retained — is the workplace norm and is decided here rather than
rediscovered per departure.

Files (#190) inherit this whole section unchanged: org-readable, same export path, same
retention, same horizon.

## 5. Duo answers: what travels with an answer

**Decision: provenance never accompanies the send.**

`workspace-platform.md` §5 already fixes the moment: a draft that is sent becomes a message
by the owner's explicit act; until then nothing about it transits the workspace. This record
fixes what crosses at that moment: **the answer text, and nothing else.** The grounding
chunks, the source list, the retrieval metadata — everything the daemon used to derive the
answer — stays in the daemon, local, with the corpus it came from. One distinction so this
is not over-read: a question asked in the room is itself a message, and is workspace data
the moment it is sent, like any other. What never crosses is the derivation — the evidence
the daemon assembled to produce its answer.

The reason is the issue's own warning: an answer's evidence can reveal more than the answer
does. Sources are an index into a corpus. Sending them puts corpus-derived data onto org
infrastructure — which documents exist, what they say, what the owner was working on when
they asked. A citation list is a fingerprint of the corpus; §5 forbids the corpus, and it
forbids the fingerprint for the same reason. This is the one place this record had to check
itself: org-readable answers are fine (they are messages), org-readable evidence is not.

Consequences, stated so the client work does not have to infer them:

- If a reader needs an answer's basis, **the sender composes it into the text** — the room
  sees only words a person or a duo chose to send. A quoted line with its source named in
  the sentence is content the owner sent; an attached structured citation set is not, and is
  not built.
- The owner sees full provenance **locally, always** — the daemon keeps it beside the draft,
  which §5 already confines to the owner's machine.
- **The rule is unchanged in an E2EE room.** E2EE changes who on the server can read what
  was sent; it does not change what is sent. The corpus boundary is never traded for room
  confidentiality.

## 6. The asymmetry, stated for a member

| What | Where it lives | Who can read it |
|---|---|---|
| Messages, files, reactions, read state — and who talks to whom, and when | the org's workspace server | The room's members; the org's administrators through the logged path, under a stated basis (§3) |
| Your corpus, passphrase, derived rules, drafts and their evidence, and every duo answer's provenance | your Mac, inside your daemon | You. Not the org, not an administrator, not by any server API — the only path to it is your machine |

The rule to quote:

> **Treat everything you send as a government record. Nothing you import, ask, or draft
> reaches the server — even when your duo answers from your documents, only the words sent
> become workspace data.**

A member's lever is what they send, never what they import. The corpus side of the table is
absolute (`workspace-platform.md` §5 — moving it is a change to epic #184, not a config
sweep); the message side is governed by this record plus org policy, and can be tightened by
policy without touching the architecture.

## 7. What this decision does not decide

- **#190 (files)** — inherits this read model wholesale; what remains theirs is limits,
  classification handling (#183) and the upload path.
- **#192 (consent)** — who may address a duo in a shared room is a consent question, not a
  readability one; this record only fixes that a consented answer still travels without
  evidence (§5).
- **#193 (design docs)** — §1.1's rewrite must carry the two-store statement this record
  supplies: messages are org-readable records on org infrastructure; corpora never leave the
  owner's machine.
- **E2EE room UX** — verification flows, key backup, device management are not built while
  the default is off; they become real work only if a security review admits E2EE rooms
  (§2), and that review owns them.

## 8. Sources (verified 2026-09-25)

- Synapse User Admin API — login as user (`POST /_synapse/admin/v1/users/<user_id>/login`,
  "does not generate a new device … the target user should not be able to tell"); deactivate
  with `erase` (explicitly does not "delete sent and received messages"; messages remain
  visible to room members at the time, hidden from users who join afterwards); account-data
  and whois read endpoints —
  <https://matrix-org.github.io/synapse/latest/admin_api/user_admin_api.html>
- Synapse message retention policies (MSC1763; `default_policy`, `allowed_lifetime_min/max`,
  purge jobs; "it will never delete the last message in a room"; expired events persist
  until the next purge job; VACUUM) —
  <https://matrix-org.github.io/synapse/latest/message_retention_policies.html>
- Synapse Purge History API — <https://matrix-org.github.io/synapse/latest/admin_api/purge_history_api.html>
- Synapse Delete Room admin API (shuts down a room; `force_purge`) —
  <https://matrix-org.github.io/synapse/latest/admin_api/rooms.html>
- Matrix spec, room history visibility — the default is `shared` ("for backwards-compatibility
  reasons"); `joined` hides pre-join history —
  <https://spec.matrix.org/latest/client-server-api/#room-history-visibility>
- matrix-js-sdk PR #5216, "Only share history if room history visibility is shared"
  (MSC4268, merged 2026-03-16) — room-history keys reach new joiners through the clients of
  existing members, which choose whether to share them —
  <https://github.com/matrix-org/matrix-js-sdk/pull/5216>
- CVE-2024-47824 — "Malicious homeservers can steal message keys" (matrix-react-sdk, invite
  path), Oct 2024 — <https://nvd.nist.gov/vuln/detail/CVE-2024-47824>
- matrix.org, End-to-End Encryption implementation guide (Olm/Megolm; footnote: "This
  prevents a malicious or compromised homeserver replacing the keys for the device with those
  of another") — <https://matrix.org/docs/matrix-concepts/end-to-end-encryption/>
- matrix.org, Moderation in Matrix — "It is common for servers not to immediately delete
  redacted messages from their database" (deliberate moderation behaviour) —
  <https://matrix.org/docs/older/moderation/>
- Synapse configuration manual — `database` and `media_store_path` (events in the database,
  media on the local filesystem; no at-rest encryption option exists) —
  <https://matrix-org.github.io/synapse/latest/usage/configuration/config_documentation.html>
- Erethon, "What a malicious matrix homeserver admin can do" (Jul 2022) — a worked walkthrough
  of device injection by a homeserver admin — <https://blog.erethon.com/>
