# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Serve credentials

### Device token
A long-lived pairing credential that carries full owner power on every daemon route, minted for one named device and verified on each request it bears.
*Avoid:* pairing token

Lifecycle: no expiry — it works until revoked. Verification tolerates a short stale-success window so a polling client keeps cheap request checks (a revoked device stops working within one ordinary polling interval; successes inside that window are intended, not a defect). A successful verification may also refresh the device's last-seen record.

### Ask token
A short-lived, ask-only credential minted one per person, authorizing exactly one capability — asking the duo a question — and never a device pairing: it grants nothing on any owner route, and its refusal there is structural, not a permission check.
*Avoid:* ask link

Lifecycle: expiry is mandatory and is the sole limit (there is no use count); the raw value is displayed exactly once, at mint. Revocation and expiry take effect on the very next verification with no tolerance window — an ask token must never inherit the device token's stale-success cache tolerance without an explicit, stated policy.

## Answer outcomes

### Answer outcome (answered / passed on / declined)
The three-kind result every ask surface returns, regardless of who is asking or over which surface: answered (with sources), passed on (escalated to the owner), or declined (refused). The shared duo's flat decline states normalize into the same kinds — out of scope maps to passed on, not-a-decision-maker to declined.
*Avoid:* inventing per-surface outcome vocabularies

## Hosted workspace

### Org (hosted)
A named group of duos on one hosted server, held in the hosted registry: every duo, including the pre-hosted root duo, belongs to exactly one, and an invite names the org it admits people into. Duos made before orgs existed live in the default org (id `default`).
*Avoid:* tenant (a tenant is one hosted duo, not a group of them), team

### Super admin
Anyone whose Google email is listed in `DUO_HOSTED_ADMIN_EMAILS`, plus the server-side admin token: the only callers who may create, rename and list orgs, list any org's members, and invite into an org. Read live from the env on every request, so removing an email withdraws the privilege. A caller with no credential is refused 401, any other caller 403.
*Avoid:* org admin (a different role: it manages one org only)

### Org admin
A member of a hosted org who manages that org, appointed by the super admin or another org admin: they list its members and pending invites, invite people into it, rename it and appoint or revoke other org admins in it. Stored on the member's registry record as `orgAdmin` (who appointed them and when, by stable id), and read fresh on every request, so an appointment or a revoke reaches a signed-in person on their next request. The last org admin of an org can be revoked only by the super admin. In the chat an org admin has exactly a member's power.
*Avoid:* admin (unqualified: ambiguous with the super admin), `isAdmin` (a record of the super admin at sign-up, not this role)
