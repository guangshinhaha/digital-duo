# Digital Duo

Your AI counterpart. A platform where a person creates a digital agent of themselves — their
voice, their knowledge, and their authorised actions — that colleagues can consult, and that
eventually acts on their behalf within limits they set.

Not a clone. A **duo**: a second you that holds your context, works inside boundaries you grant,
and never poses as you.

> **Status:** concept converged, pre-build. Internal GovTech project. Pilot = author + immediate team.

## The bet

A knowledge base is not documents — it is **decisions**. What makes a duo worth consulting is
that it knows what you would say *no* to, what you would push back on, what you would escalate.
That lives in past Slack threads and AI chat history, not in uploaded PDFs.

The output is a **readable, editable list of standing orders** — not a black-box fine-tune. When
someone asks "why did it do that," you open a file and point at a line.

## v1 in one loop

```
someone asks you in Slack
      ↓
your duo drafts a reply — visible only to you
      ↓
you send / edit / ignore
      ↓
the edit becomes a standing order
```

Private drafting first, because it delivers value at a team size of one and carries zero
embarrassment risk. Public answering comes when the duo is good enough that withholding it
is annoying.

## Docs

| Doc | What's in it |
|---|---|
| [`docs/concept.md`](docs/concept.md) | Product thesis, the wedge, trust ladder, the Mirror onboarding, consent design, risks |
| [`docs/v1-spec.md`](docs/v1-spec.md) | v1 scope, what's deferred and why, sequencing, pilot success criteria |
| [`docs/import-adapters.md`](docs/import-adapters.md) | The `Record` schema and adapter contract — how new sources slot in |
| [`docs/v1-tech-design.md`](docs/v1-tech-design.md) | Technical design, the adversarial review that reshaped it, and build order |
| [`docs/client-design.md`](docs/client-design.md) | The Mac and phone clients, the `duo serve` daemon behind them, and what that costs |

Backlog: **13 epics, 72 issues** across phase 1 (private drafting), phase 1.5 (a shared
document-grounded duo), phase 2 (public answering, permissions, trust) and phase 3 (actions,
role duos).

## Principles

- **Trust is per-topic and per-action, never global.** Promote slowly, demote fast.
- **Anything external or irreversible is never autonomous.** A stated principle, not a caveat — `docs/concept.md` §6, on T4 actions: "Never autonomous. Product principle, not a limitation." Enforced structurally, not by convention: no trust-grid cell for T4 can exist (a database `CHECK` constraint, not just an absent grant), and every T4 action requires a separate, explicit human confirmation at the moment of execution (`src/actions/t4-guard.ts`).
- **The user never writes their personality — they approve a draft of it.**
- **Self-created duos only**, always labelled, instantly killable.
- **Start with what needs no one's permission.** Every approval you wait on is a week not shipped.
- **A persona without decision history is a commodity.** Never build a persona-authoring product, and never call a duo an employee.

## License

TBD
