# Digital Duo — Import & Adapters

> The ingest contract. Designed so a future gov-tool connector is a small file, not a refactor.
> Last updated: 2026-09-18

## 1. Principle

The **normalisation layer is the stable thing**. Every source is a swappable adapter behind it.

Two rules keep this honest:

1. **Adapters never interpret.** An adapter maps raw source data to `Record[]` and stops. All
   derivation — topics, voice, standing orders — happens downstream, so any new source inherits
   the entire pipeline for free.
2. **`classification` exists from day one, unused.** v1 does not implement the permission model,
   but the field is in the schema so there is no migration when it lands.

```
raw source ──▶ Adapter ──▶ Record[] ──▶ Derivation ──▶ Signals ──▶ Standing Orders
                                                                        │
                                             owner edits / corrections ◀┘
```

## 2. The Record schema

```
Record {
  id              stable, content-hashed
  source          slack | claude-export | chatgpt-export | files | paste | <gov-tool>
  source_ref      deep link back to the original, if the source has one
  kind            question_to_me | my_answer | my_thinking | decision | artifact
  author          me | other | assistant
  text
  timestamp
  thread_id       groups a conversation; null for standalone artifacts
  audience        private | dm | channel | public
  classification  unset by default — field present, logic deferred
  topics[]        derived downstream, never read from source
}
```

### Notes on the fields

- **`kind`** is the load-bearing one. `question_to_me` + `my_answer` pairs are the training spine;
  `my_thinking` (chat with an assistant) trains reasoning and voice but is **never quotable as a
  stated position**; `decision` is what standing orders are mined from.
- **`author: other`** records are read at ingest for context, used to derive, then **dropped**.
  They are not retained. See the consent design in `concept.md`.
- **`audience`** drives both consent (DMs opt-in only) and, later, the asker-scoped permission model.
- **`topics`** are always derived. If a source offers tags, ignore them — consistency across
  sources matters more than fidelity to any one of them.

## 3. Import modes, ordered by permission needed

| Mode | Needs | When |
|---|---|---|
| **File upload** — Claude/ChatGPT export `.json`, Slack export, folder of docs | Nothing | **v1, first** |
| **Paste a conversation** | Nothing | v1 — ~20 lines and makes testing trivial |
| **Slack app scoped to the owner** | Workspace app install | v1, later |
| **Live capture** (records as you chat) | Varies | Later |
| **Gov tools** | Documentation not yet in hand | Stub the adapter, fill in when known |

**Start with what needs no one's permission.** A duo trained on your own Claude export can exist
this week without a single request filed. Every approval you wait on is a week not shipped.

## 4. Source characteristics

What each source actually contributes, and how to weight it:

| Source | Uniquely good for | Weakness | Crawl order |
|---|---|---|---|
| **Slack** | Decisions in context, refusals, the interruption pattern, who-asks-what | Terse; reasoning missing | 1st — carries the ROI story |
| **LLM chat history** | Reasoning, standards, voice, what "good" means | No social context | 2nd — carries the personality |
| **Docs / circulars** | Facts, SOPs, authoritative answers | Stale, high volume, low marginal value | 3rd |

**Slack teaches what you decide. LLM history teaches how you think. Docs teach what is true.**

## 5. Adapter checklist

For each new adapter:

- [ ] Maps to `Record` and nothing else — no interpretation, no topic assignment
- [ ] Emits stable `id`s so re-import is idempotent
- [ ] Populates `source_ref` where the source has addressable links
- [ ] Classifies `kind` correctly — especially `my_thinking` vs `my_answer`, which must not be conflated
- [ ] Sets `audience` honestly; defaults to the most private plausible value
- [ ] Never ingests DMs unless explicitly opted in, per conversation
- [ ] Discards `author: other` text after derivation
- [ ] Handles partial/re-import without duplicating

## 6. Derivation outputs

From `Record[]`, the derivation pass produces:

| Output | Source signal |
|---|---|
| **Topic taxonomy** | Clustering over `question_to_me` |
| **Interruption baseline** | Volume and distribution of `question_to_me` — the Mirror's headline |
| **Voice profile** | `my_answer` phrasing, length, hedging, register |
| **Standing orders** | Repeated `my_answer` + `decision` patterns, as editable plain-English rules |
| **Refusal rules** | Mined where possible — but **primarily hand-written**, see below |
| **Escalation policy** | Where the owner deferred, routed, or checked with someone |
| **Asker graph** | Who asks what — later becomes the permission default |

### The survivorship caveat

Derivation sees what was **said**, never what was declined, ignored, or quietly routed elsewhere
— and that restraint is the bottleneck person's actual skill. The pipeline will learn helpfulness
and will not learn discernment.

So refusals are **prompted for explicitly during the Mirror step, not derived.** Five hand-written
lines, and they are the highest-value text in the system.
