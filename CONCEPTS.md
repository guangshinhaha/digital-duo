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
