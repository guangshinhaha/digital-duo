# Attachment semantics — decision record (#183)

**Status: PROPOSED — awaiting owner ratification on #183.** Nothing here is built; the upload
route this unblocks comes after ratification. Companion to `trust-surface.md` (#179) and
`workspace-platform.md` (#185/#194): a decision written down so the two things "attach a file"
could mean stop looking like one accidental feature.

## The question

"Attach a file" looks like one feature and is two (#183):

1. **Ephemeral grounding** — ask about this document, use it for this draft, do not keep it.
   The attachment must appear in the draft's sources or the provenance rail starts lying.
2. **Corpus import** — keep this, index it, let it move the derived rules. That changes what
   the duo believes, permanently.

## The decision

**v1 supports both, distinctly labelled, with ephemeral grounding as the default "attach"
semantic and corpus import as a separate, explicitly labelled, owner-only act.** Client #66
("share files and images in a conversation") already pins the labelling from the UI side —
"sharing is not importing… importing it is a separate, explicitly labelled act" — and this
record is the core half of that same line.

### 1. Ephemeral grounding (the default; built first)

An attachment rides the *question*, not the corpus:

- **Where the bytes live:** the workspace, not the duo. The workspace server already holds
  "identity, conversations, messages, read state and files" (`workspace-platform.md:89`) —
  persistence there is the sharer's act, done before the duo is involved. The daemon reads the
  file at draft time (dialing out, as it does for every workspace call) and drops the bytes
  when the draft completes. Nothing content-bearing is written anywhere in the duo: no record,
  no embedding, no draft-log copy.
- **How it appears in sources:** `DraftSource` (`src/drafting/draft-log.ts:7-11`) gains a third
  kind, `"attachment"`. Its `id` is the workspace's own file reference; its `label` is the
  filename/kind plus a short preview fragment, built with the same `truncate(80) +
  stripMarkingLine` idiom `buildSources` already uses for rule and evidence labels
  (`src/drafting/pipeline.ts:64-80`). The draft log stores `id + label` only — the rail stays
  honest without the corpus retaining anything.
- **Grounding mechanics (requirement, not design):** an attachment must count as grounding for
  the pipeline's no-evidence gate (`src/drafting/pipeline.ts:157` — otherwise a fresh duo
  escalates every attachment question as groundless), but must not inflate confidence: it is
  *provided* material — kin to a rule hit, not to retrieved evidence — so retrieval strength
  stays corpus-honest. The exact confidence treatment is the implementation issue's to tune,
  constrained from both ends: an attachment-only draft must neither pass on fake retrieval
  strength nor escalate as if it had no grounding at all. The no-provider extractive fallback
  can quote the attachment verbatim (with the strip below), so ephemeral grounding works with
  no inference provider configured.
- **Deletion:** if the file is deleted in the workspace, future drafts lose the grounding.
  Past drafts' source rows keep their `id` and `label` — a dead link plus an honest label,
  exactly how the audit trail treats every other reference to something outside the store.

### 2. Corpus import (separate, explicit, owner-only)

Importing a document into the corpus is the *existing* ingest path, verbatim: two-phase ingest,
`detectClassification` at the boundary, the configured ceiling discarding above-ceiling
material (`discardedAboveCeiling` — "never written to the retained store at all",
`src/ingest/two-phase.ts:66-67`), the work-relevance gate, records + embeddings, and the
Mirror/rules moving afterwards — permanent by design. The route shape is #176's
import-from-text; "attach" must not be able to reach it. Askers cannot import; only the owner
can, and the act is labelled as what it is.

### Retention, side by side

| | Ephemeral grounding | Corpus import |
| --- | --- | --- |
| Retained by the duo | Nothing — `id + label` in that draft's sources row only | Records, embeddings, derived rules |
| Where content lives | The workspace (sharer's persistence; deletable there) | The encrypted store |
| Mirror / derivation | Never moves | Moves, permanently |
| Who may do it | Any asker, on their own question | Owner only, explicitly labelled |
| Classification | Refused above ceiling (below), stripped from echoes within | Ceiling discard at ingest, as today |

## The classification path for a marked document

**Refused above the owner's configured ceiling — an escalation naming the marking. Within the
ceiling: used, with every echo of its text stripped. Never quarantined.**

Three defenses, from the #164 precedent and the ceiling machinery:

1. **#164's strip was explicitly cosmetic — content beneath it had already been admitted.**
   The strip added in #155/#164 exists because echo readers were "already cleared for the
   content beneath it" (its own commit rationale): ingest's ceiling had already made the
   retention decision. An ephemeral attachment has passed no ceiling anywhere. Stripping its
   marking and grounding on it anyway would have the draft pipeline mint a clearance decision
   no boundary ever made — a new judgement wearing #164's clothes.
2. **The ceiling machinery refuses rather than quarantines at its one existing chokepoint.**
   Above-ceiling material is discarded outright at phase B (`src/ingest/two-phase.ts:113-114`)
   — "never written to the retained store at all." A quarantine would invent a third state —
   held-but-unadmitted content — that nothing else in the system has, and there is nothing to
   rescue: the workspace already holds the file, so core-side quarantine would just be a
   second, unguarded copy of content the ceiling rejected.
3. **Refusal is the honest shape for the asker too.** The escalation names the marking and
   says the duo won't ground on material above its owner's configured ceiling — the same
   refusal-shaped honesty the pipeline already gives refused subjects (#34 AC2: no internal
   draft composed and then withheld; nothing below the check ever runs). A silent strip would
   return an answer the asker cannot know was grounded on marked material.

Within the ceiling, the #164 idiom applies verbatim to every echo: source labels, extractive
quotes — and, on the provider path, prompt assembly, which closes #164's recorded residual
("prompts still embed raw marking-bearing text") for this new path. The attachment's marking
is stripped before the prompt is built, not just after.

## Limits (named for the implementer)

- **Type, v1: `text/plain` and `text/markdown` only.** No extraction pipeline exists (no PDF,
  no office formats); a binary blob that isn't an image is refused with its reason stated.
- **Images are out of v1, blocked on #14.** A vision-capable inference provider is a hard
  dependency for reading one, and *which provider may process this corpus at all* is still an
  open decision (core #14). The text embedding provider also cannot embed images, so there is
  no retrieval analog to lean on. Client #66's render half is separately gated on the
  workspace message-store contract (#190's open "files" work).
- **Size: a bound exists and is enforced at the door.** Proposed: 256 KiB of extracted text
  per attachment, at most 3 attachments per question (a prompt-budget bound — the attachment
  rides `buildDraftPrompt`'s context). Enforced on declared length *before* the body is read;
  the refusal states the limit and keeps the message (client #66's recoverable-failure AC).
  The numbers are a tunable constant for the implementation issue; the decision is that the
  bound is enforced before bytes enter the daemon, not after.
- **Provider: none required for ephemeral text grounding** (the extractive fallback path
  works, per above); the provider path carries the strip requirement. Corpus import needs the
  embedding provider, exactly as #176's import already does.

## What would reopen this

- Core #14 deciding a vision-capable provider (images move from "blocked" to a scoped
  follow-up) — or deciding permanently against one (images stay out, no longer as a
  dependency note but as policy).
- The workspace files contract (#190) landing with a reference shape that can't serve as a
  `DraftSource.id` (the rail's honesty depends on that id being stable and dereferenceable by
  the asker).
- A v2 need to ground on above-ceiling material ephemerally under some explicit
  owner-granted clearance — which would be a *new* boundary decision, argued on its own
  merits, not a loosening of this one.

Until ratified, nothing changes: no upload route exists, and the provenance rail carries only
rules and corpus evidence.
