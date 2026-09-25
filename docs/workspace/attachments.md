# Digital Duo — Attachment Semantics Decision

> Decision record for #183 (parent #184). Status: **PROPOSED** — this document becomes the
> decision when the PR carrying it is merged. Every code citation below was verified against
> `main` on 2026-09-25.
>
> Companion to `workspace-platform.md` (#185) and `trust-surface.md` (#179): the workspace
> epic's third written-down boundary. #184 draws the line between the two stores; this record
> draws the one between the two things "attach a file to a question" could mean, so the upload
> route (#190) builds against a decision instead of an accident.

---

## 1. The decision

**"Attach" means ephemeral grounding. It never means import. Both semantics exist in v1 and
stay distinctly labelled: the attach control grounds the one draft it rode with and retains
nothing; corpus import remains the separate, explicitly labelled, owner-only act of the
existing ingest path, unchanged.**

Concretely:

- An attachment rides the *question*, not the corpus. It may ground that one draft, it appears
  in that draft's sources, and the duo retains nothing from it — no record, no embedding, no
  copy.
- The file itself lives where the sharer put it: the workspace's file store (#190), which
  `workspace-platform.md` §5 already lists among the things the workspace holds ("identity,
  conversations, messages, read state and files").
- Importing a document into the corpus is what it already is: the two-phase ingest path with
  its classification ceiling, its retention boundary, and its effect on the derived rules.
  "Attach" must not be able to reach it.

## 2. Why both, and why only one of them is the attach control

The split is not a convenience, it is the product's own line, already pinned from three
directions:

- **The client story pins the labelling.** `guangshinhaha/duo#66` ("share files and images in
  a conversation") states it as an acceptance criterion: "it does not enter any duo's corpus,
  and importing it is a separate, explicitly labelled act", and separately requires that
  "the attachment appears in the answer's sources, so provenance stays honest."
- **#190 pins the deferral.** Its body names "the line between a file shared with people and
  a document imported into a duo's corpus, which are different acts with different
  consequences (see #183)", and its classification AC says the behaviour "matches whatever
  #183 decides, applied here rather than reinvented."
- **The consequences are asymmetric.** Ephemeral grounding is reversible by construction —
  nothing is retained, so nothing has to be undone. Import is permanent — it writes records
  and embeddings, moves the derived rules, and changes what the Mirror shows afterwards. A
  permanent, corpus-changing act does not belong one tap away from a conversation message;
  it stays behind the owner's explicit, labelled decision. That asymmetry, not
  implementation order, is why ephemeral grounding is the default semantic of "attach".

Import also needs nothing new from this record: it already exists end to end, most recently
over HTTP (#176, merged as #213). The missing half is the one worth building — today a duo
cannot use a document it has not been given permanently, and "ask about this document" is a
different ask from "believe this document".

## 3. Ephemeral grounding — the default semantic

- **Where the bytes live.** The workspace, not the duo. The daemon fetches the file over its
  outbound workspace connection at draft time, exactly as it dials out for every other
  workspace call (`workspace-platform.md` §5's connection-direction rule is not touched).
- **Exactly when it is gone.** The text lives in daemon memory for the duration of one draft
  pipeline call. When that call returns — draft or escalation, its one row written — the
  bytes are dropped. They are never written to the duo's disk: no record, no embedding, no
  draft-log copy, no staging file (ingest's staging database is part of the import path and
  is not involved). A crash drops them with the process. The only durable duo-side trace of
  an attachment is the source row described next. One implementation guard earns stating:
  the attachment must not ride `threadContext`, which *is* persisted on the draft row — it
  is a per-call input to the prompt, nothing more.
- **The one transit path, acknowledged rather than pretended away.** A draft that quotes an
  attachment and is then sent becomes a message by the owner's explicit act — §5 of
  `workspace-platform.md` already says exactly that about sent drafts. From there its text
  is workspace data like any message, and what adapters later ingest from conversations is
  the retention boundary's question, not this record's. Two things hold even on that path:
  the strip in §6 keeps every echo marking-free at the source, and the act that put the
  content there was the owner's send, not the attachment's presence.
- **How it appears in sources.** `DraftSource` (`src/drafting/draft-log.ts:7-11`) gains a
  third kind, `"attachment"`. Its `id` is the workspace's own file reference; its `label` is
  the filename and type plus a short preview fragment, built with the same
  `truncate(…, 80)` + `stripMarkingLine` idiom `buildSources` already uses for rule and
  evidence labels (`src/drafting/pipeline.ts:57-83`). The draft log stores `id` and `label`
  only — the provenance rail tells the truth without the corpus retaining anything.
- **Grounding mechanics (requirement on the implementation, not a design here).** An
  attachment must count as grounding for the pipeline's no-evidence gate
  (`src/drafting/pipeline.ts:157`), or a fresh duo escalates every attachment question as
  groundless. It must not inflate confidence as if it were retrieved evidence: it is
  *provided* material, kin to a rule hit, so retrieval strength stays corpus-honest. The
  implementation tunes between those two ends. The no-provider extractive fallback can quote
  an attachment verbatim (with the strip in §6), so ephemeral grounding works with no
  inference provider configured at all.
- **Deletion.** If the file is deleted in the workspace, future drafts lose the grounding.
  Past drafts' source rows keep their `id` and `label` — a dead link plus an honest label,
  the same treatment the audit trail gives every other reference to something outside the
  store.
- **Scope of one attachment's reach.** Because nothing is retained and nothing is embedded,
  no later question can retrieve it: an attachment grounds only the draft it rode with.
  Public answering (#43/#44) cites what retrieval returns under its own clearance ceiling,
  so an attachment cannot surface there — that is a consequence of no-retrieval in v1, and
  any future surface that accepted attachments directly would need its own boundary
  decision in the shape of §9's third bullet, not a silent widening of this one.

## 4. Corpus import — unchanged, explicit, owner-only

Importing a document is the existing path, verbatim: two-phase ingest (`src/ingest/two-phase.ts`),
`detectClassification` at the boundary (`src/ingest/record.ts:127`), the configured ceiling
discarding above-ceiling material (`discardedAboveCeiling` — "never written to the retained
store at all", `src/ingest/two-phase.ts:66-67`, filter at `:113-114`), the retention
boundary, records plus embeddings, and the Mirror and derived rules moving afterwards.
Permanent by design. The route shape is #176's import route. Askers cannot import; only the
owner can, and the act is labelled as import.

## 5. Retention, side by side

| | Ephemeral grounding | Corpus import |
|---|---|---|
| Retained by the duo | Nothing — `id` + `label` in that draft's sources row only | Records, embeddings, derived rules |
| Where the content lives | The workspace (sharer's persistence; deletable there) | The owner's encrypted store |
| Mirror / derivation | Never moves | Moves, permanently |
| Who may do it | Any asker, on their own question | Owner only, explicitly labelled |
| Classification | Refused above ceiling, echoes stripped within (§6) | Ceiling discard at ingest, as today |

## 6. The classification path for a marked upload

**A document marked above the owner's configured ceiling is refused — an escalation naming
the marking. A document marked within the ceiling is used, with every echo of its text
stripped. Nothing is ever quarantined.**

**Who applies it, and when.** The duo, at its own door — never the workspace. The ceiling is
the owner's policy (`DUO_CLASSIFICATION_CEILING`, default `official_open`,
`src/permissions/classification.ts:5`, wired at `src/config.ts:170`), and two duos in one
conversation may legitimately differ: one may ground where another refuses. The check is the
same read ingest makes — `detectClassification` off the attachment's first line, compared
against the configured ceiling — and it runs *before anything else*: before grounding, before
prompt assembly, before any model sees the text. That is the #34 shape (a refused subject
escalates "without reasoning about it"; nothing below the check ever runs). Import applies
the same machinery at its own existing point: phase B's ceiling discard.

The workspace applies nothing and strips nothing. It stores and serves the file verbatim to
conversation members per #190's own ACs — a workspace-side strip would blind every duo's
`detectClassification`, turning a marked document into an "unknown" one at the one boundary
that reads markings.

Three defenses for refused-rather-than-stripped-or-quarantined:

1. **The #164 strip was explicitly cosmetic — the content beneath it had already been
   admitted.** The strip added by #155/#164 exists because echo readers were "already
   cleared for the content beneath it": ingest's ceiling had already made the retention
   decision, and the raw stamp added nothing but noise. An ephemeral attachment has passed
   no ceiling anywhere. Stripping its marking and grounding on it anyway would have the
   draft pipeline mint a clearance decision no boundary ever made — a new judgement wearing
   #164's clothes.
2. **The ceiling machinery refuses rather than quarantines at its one existing chokepoint.**
   Above-ceiling material is discarded outright at phase B — "never written to the retained
   store at all" — and the staging database is deleted in a `finally`. A quarantine would
   invent a third state, held-but-unadmitted, that nothing else in the system has; and there
   is nothing to rescue, because the workspace already holds the file. A core-side
   quarantine would just be a second, unguarded copy of content the ceiling rejected.
3. **Refusal is the honest shape for the asker.** The escalation names the marking and says
   the duo will not ground on material above its owner's configured ceiling. A silent strip
   would return an answer the asker cannot know was grounded on marked material.

**Unmarked material ("unknown") grounds.** The asker supplied the file; they are not a third
party to their own content, and unknown did not become more trusted — it never entered a
gate. Nor is anyone else exposed: #190's own first AC already serves a shared file to every
member of the conversation it was shared in, so a draft that quotes it shows the room
nothing it cannot already see. The existing two-gate design governs the *retained store*:
`isWithinCeiling` exempts unknown at ingest so it is "recorded honestly as unknown" rather
than silently dropped (`src/permissions/classification.ts:40-45`), and
`isVisibleToClearance` then demands top-level clearance before any answer shows it
(`:57-62`) — unmarked material never defaults to the most permissive value. An ephemeral
attachment is retained nowhere and shown to no third party, so neither gate is implicated;
the marked case above is the one that carries real exposure, and it is refused outright.

**Within the ceiling, every echo strips** — source labels, extractive quotes, and, on the
provider path, prompt assembly: the marking is stripped before the prompt is built, not only
after. That closes #164's recorded residual ("`buildDraftPrompt` still embeds raw
marking-bearing rule/evidence text into provider-path prompts") for this new path, instead
of inheriting it. The strip inherits `stripMarkingLine`'s known edge unchanged
(`src/ingest/record.ts:151-164`): a marking sharing its first line with real text after a
colon is left intact rather than risked — the same edge #155 shipped with.

## 7. Limits — named, with reasons

- **Type, for grounding: `text/plain` and `text/markdown` only.** No extraction pipeline
  exists in v1 — a PDF or office document is refused at the duo's door with its reason
  stated (no extraction, not "unsupported" hand-waving), and the message is kept, per
  duo#66's recoverable-failure AC. People may still *share* any type in a conversation:
  #190's store-and-serve half is for people, and the render half of duo#66 does not depend
  on any duo reading the file. The limit drawn here is what a *duo* may ground on.
- **Images: shared yes, grounded no — blocked on #14.** Reading an image needs a
  vision-capable inference provider, and *which provider may process this corpus at all* is
  still undecided (core #14, open; the working default is local Ollama, whose 7–30B-class
  default has no vision, and the text embedding provider cannot embed images either, so
  there is no retrieval analog to lean on). Until #14's ADR names a provider and the maximum
  classification of data that may reach it, a duo asked about an image escalates honestly —
  "I can't read images" — rather than pretending. This is a named dependency, not an
  assumption that it will resolve favourably.
- **Size: 32 KiB of text per attachment, at most 3 attachments per question, enforced at the
  door before the body is read — and the read is cut at the bound if a declared size
  understates the body.** The refusal names the limit and keeps the message. Reasoning: an
  attachment rides the draft prompt alongside the voice profile, standing order, evidence
  and question (`buildDraftPrompt`, `src/drafting/generate.ts:10-37`), and the default
  stack is local Ollama at 7–30B, where the smallest supported contexts sit around 8k
  tokens. 32 KiB is roughly 8k tokens of text: one whole attachment plus the rest of the
  prompt fits that floor without truncation games. A document that genuinely needs to be
  larger is import-shaped — chunked, embedded, retrieved — not prompt-shaped, and the
  refusal says so. With several attachments, prompt assembly still has to fit the
  configured model's context; that is the implementing issue's to honour. The numbers are a
  tunable constant; the decision is that the bound is enforced *before* bytes enter the
  daemon, not after.
- **Provider: none required for ephemeral text grounding** — the extractive fallback path
  works with zero providers, which is what makes this semantic safe to ship before #14
  resolves. The provider path carries the strip-before-prompt requirement of §6. Corpus
  import needs the embedding provider, exactly as #176's import already does. If #14 later
  admits a hosted provider, attachments are corpus-equivalent data and the ADR's stated
  maximum classification must cover them.

## 8. What #190 consumes from this record

- The upload route implements the §7 limits and the §6 behaviour "applied here rather than
  reinvented" — its own AC. Storage-side it serves people (any type within its limits);
  grounding-side it exposes a stable file reference the duo can use as a `DraftSource.id`.
- The workspace never classifies and never strips; it serves files verbatim (§6).
- One contract dependency, stated so it is not discovered late: the provenance rail's honesty
  depends on #190's file reference being stable and dereferenceable by the asker. If the
  files contract lands with a reference shape that cannot serve as a `DraftSource.id`, that
  reopens this record (§9).

## 9. What would reopen this

- #14 deciding a vision-capable provider — images move from "blocked on a dependency" to a
  scoped follow-up — or deciding permanently against one, which turns "no images" from a
  dependency note into policy.
- #190's files contract landing without a reference shape usable as a stable,
  asker-dereferenceable `DraftSource.id` (§8).
- A v2 need to ground ephemerally on above-ceiling material under some explicit
  owner-granted clearance. That would be a new boundary decision argued on its own merits,
  not a loosening of this one.

Until ratified, nothing changes: no upload route exists, and the provenance rail carries
only rules and corpus evidence.
