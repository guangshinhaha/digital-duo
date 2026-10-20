import { z } from "zod";

/**
 * #186 AC5 / W-S4-2: the whitelisted card builder. Together with
 * `src/workspace/payload.ts` this is the ONLY place an outbound workspace
 * payload is constructed (docs/workspace/cards.md §9, the amended
 * invariant in docs/workspace-platform.md §5). The wire shape, limits and
 * fallback copy below are copied verbatim from `docs/workspace/cards.md`
 * §2-§5 — that doc is the authority; this file is its one TypeScript
 * projection.
 *
 * The input type (`DuoCardV1Input`) is deliberately narrow: it takes only
 * strings that already came from `outcome.text`/`outcome.message`, fixed
 * copy (cards.md §5's table), option labels, `matrix.to` permalinks,
 * `mxc://` refs and the requester's own user id. There is no field here
 * shaped like a draftId, logEntryId, topicId, confidence, a source id or
 * label, evidence text, rule text, or an ownerNotice — a caller cannot pass
 * what the type has no slot for. This is the single most important
 * invariant in this file; test/workspace-payload.test.ts's POISON scan
 * pins it by trying to smuggle poison through every owner-facing-shaped
 * field and asserting it never appears in the output.
 *
 * Limits (title ≤ 80, ≤ 3 lines of ≤ 200 chars, decision options 2-4,
 * ≤ 3 milestones) are enforced by `DuoCardSchema` below — a zod schema
 * matching cards.md §2's wire limits exactly. Over-limit input THROWS
 * (`CardValidationError`) rather than silently trimming: this repo's house
 * style is to refuse rather than mutate data the caller didn't ask to have
 * mutated (the same stance `workspaceSettingsFrom` takes on a bad timing
 * knob), and a silent trim here would be a silent, unlogged loss of
 * asker-visible text — worse than a thrown, caller-visible error during
 * development.
 */

/** Phase 1 kinds the wire protocol lists (cards.md §2). Only `task`, `decision` and `result` are ever built by this module. */
const PHASE1_KINDS = ["task", "decision", "result", "confirm"] as const;

/** Every kind this builder refuses outright — `confirm` is owner-only in Phase 1 (cards.md §2/§7); the rest are reserved, unbuilt in any phase yet. */
const REFUSED_KINDS = new Set(["confirm", "form", "created", "permissions", "draft", "approval"]);

/** Thrown when `buildCardEvent`/`buildCardEdit` is asked for a kind the Matrix builder refuses — `confirm` (owner-only, §7) or any reserved kind (`form`, `created`, `permissions`, `draft`, `approval`). */
export class ReservedCardKindError extends Error {
  constructor(kind: string) {
    super(`The Matrix card builder refuses to build kind ${JSON.stringify(kind)} — it is owner-only or reserved for a later phase (docs/workspace/cards.md §2/§7). Only "task", "decision" and "result" are built for Matrix in Phase 1.`);
    this.name = "ReservedCardKindError";
  }
}

/** Thrown when an input violates one of the wire schema's hard limits (title/line length, line count, decision option count, milestone count). This module refuses rather than trims — see the file's doc comment for why. */
export class CardValidationError extends Error {
  constructor(detail: string) {
    super(`Refusing to build a duo.card: ${detail}`);
    this.name = "CardValidationError";
  }
}

const TITLE_MAX = 80;
const LINE_MAX = 200;
const LINES_MAX = 3;
const MILESTONES_MAX = 3;
const DECISION_OPTIONS_MIN = 2;
const DECISION_OPTIONS_MAX = 4;

/** One decision option as it rides the wire — the asker's own rephrased words only (cards.md §9), never a topic label or evidence text. */
const CardOptionSchema = z.object({ id: z.string().min(1), label: z.string().min(1).max(LINE_MAX) });

/** A result link — a `matrix.to` permalink into the same room, with the asker-visible label it is shown under. */
const CardLinkSchema = z.object({ label: z.string().min(1).max(LINE_MAX), url: z.string().min(1) });

/** A result file — an `mxc://` reference already shared in the room, plus its already-known facts. */
const CardFileSchema = z.object({
  name: z.string().min(1),
  mxc: z.string().min(1),
  mimetype: z.string().min(1),
  size: z.number().int().nonnegative(),
});

const CardResultSchema = z.object({
  text: z.string().min(1),
  links: z.array(CardLinkSchema).default([]),
  files: z.array(CardFileSchema).default([]),
});

const CardMilestoneSchema = z.object({
  state: z.string().min(1),
  label: z.string().min(1).max(LINE_MAX),
  ts: z.number(),
});

const CardChosenSchema = z.object({ option_id: z.string().min(1), by: z.string().min(1) });

/**
 * The wire shape of `duo.card`'s own content object (cards.md §2), as a
 * zod schema — the one validator `buildCardEvent`/`buildCardEdit` run
 * every output through before returning it. Fields not relevant to a given
 * kind are simply absent; nothing here is kind-exclusive at the schema
 * level (the spec's own `v1` stance: fields may be added, never redefined).
 */
export const DuoCardSchema = z.object({
  v: z.literal(1),
  rev: z.number().int().positive(),
  card_id: z.string().min(1),
  kind: z.enum(PHASE1_KINDS),
  state: z.string().min(1),
  task_id: z.string().min(1).optional(),
  requester: z.string().min(1),
  title: z.string().min(1).max(TITLE_MAX),
  lines: z.array(z.string().max(LINE_MAX)).max(LINES_MAX).optional(),
  options: z.array(CardOptionSchema).min(DECISION_OPTIONS_MIN).max(DECISION_OPTIONS_MAX).optional(),
  chosen: CardChosenSchema.optional(),
  milestones: z.array(CardMilestoneSchema).max(MILESTONES_MAX).optional(),
  result: CardResultSchema.optional(),
  expires_ts: z.number().optional(),
});

export type DuoCardV1 = z.infer<typeof DuoCardSchema>;

/** The `duo.card` message content `buildCardEvent`/`buildCardEdit` produce — a brand-new card's event body. */
export interface DuoCardEventContent {
  readonly msgtype: "duo.card";
  readonly body: string;
  readonly "m.mentions": Record<string, never>;
  readonly "duo.card": DuoCardV1;
}

/** The `duo.card` edit content (cards.md §3): a same-sender `m.replace`, carrying the FULL new card. */
export interface DuoCardEditContent {
  readonly msgtype: "duo.card";
  readonly body: string;
  readonly "m.new_content": DuoCardEventContent;
  readonly "m.relates_to": { readonly rel_type: "m.replace"; readonly event_id: string };
}

/**
 * The asker-safe input shape for one Phase 1 card kind. Every field is
 * either a fixed asker-visible string (already projected through
 * `outcome.text`/`message`, or fixed copy), an option label, a permalink,
 * an mxc reference, or the requester's own user id — see the file's doc
 * comment. `cardId` is the daemon-issued ULID the caller tracks across
 * edits (cards.md §2's `card_id`); `rev` is threaded by the caller through
 * `buildCardEdit`'s own parameter, not carried on this input type, so a
 * fresh `buildCardEvent` call can never be asked to start at anything but
 * rev 1.
 */
export type DuoCardV1Input =
  | {
      readonly kind: "task";
      readonly cardId: string;
      readonly state: "acknowledged" | "working" | "needs_decision" | "done" | "failed";
      readonly requester: string;
      readonly title: string;
      readonly taskId?: string;
      readonly lines?: readonly string[];
      readonly milestones?: readonly { readonly state: string; readonly label: string; readonly ts: number }[];
      readonly result?: { readonly text: string; readonly links?: readonly { readonly label: string; readonly url: string }[]; readonly files?: readonly { readonly name: string; readonly mxc: string; readonly mimetype: string; readonly size: number }[] };
    }
  | {
      readonly kind: "decision";
      readonly cardId: string;
      readonly state: "open" | "chosen" | "expired";
      readonly requester: string;
      readonly title: string;
      readonly taskId?: string;
      readonly options: readonly { readonly id: string; readonly label: string }[];
      readonly chosen?: { readonly optionId: string; readonly by: string };
      readonly expiresTs?: number;
    }
  | {
      readonly kind: "result";
      readonly cardId: string;
      readonly state: "done" | "failed";
      readonly requester: string;
      readonly title: string;
      readonly taskId?: string;
      readonly result: { readonly text: string; readonly links?: readonly { readonly label: string; readonly url: string }[]; readonly files?: readonly { readonly name: string; readonly mxc: string; readonly mimetype: string; readonly size: number }[] };
    };

/** Refuses up front — before any field is even read — any kind this Matrix builder does not build. */
function refuseReservedKind(kind: string): void {
  if (REFUSED_KINDS.has(kind)) {
    throw new ReservedCardKindError(kind);
  }
}

/** Projects one input into the wire's `duo.card` object at the given `rev`. Does not validate — callers run the schema afterward. */
function cardOf(input: DuoCardV1Input, rev: number): DuoCardV1 {
  const base = {
    v: 1 as const,
    rev,
    card_id: input.cardId,
    kind: input.kind,
    state: input.state,
    requester: input.requester,
    title: input.title,
    ...(input.taskId !== undefined ? { task_id: input.taskId } : {}),
  };
  if (input.kind === "task") {
    return {
      ...base,
      ...(input.lines !== undefined ? { lines: [...input.lines] } : {}),
      ...(input.milestones !== undefined ? { milestones: input.milestones.map((m) => ({ state: m.state, label: m.label, ts: m.ts })) } : {}),
      ...(input.result !== undefined
        ? {
            result: {
              text: input.result.text,
              links: (input.result.links ?? []).map((l) => ({ label: l.label, url: l.url })),
              files: (input.result.files ?? []).map((f) => ({ name: f.name, mxc: f.mxc, mimetype: f.mimetype, size: f.size })),
            },
          }
        : {}),
    };
  }
  if (input.kind === "decision") {
    return {
      ...base,
      options: input.options.map((o) => ({ id: o.id, label: o.label })),
      ...(input.chosen !== undefined ? { chosen: { option_id: input.chosen.optionId, by: input.chosen.by } } : {}),
      ...(input.expiresTs !== undefined ? { expires_ts: input.expiresTs } : {}),
    };
  }
  // result
  return {
    ...base,
    result: {
      text: input.result.text,
      links: (input.result.links ?? []).map((l) => ({ label: l.label, url: l.url })),
      files: (input.result.files ?? []).map((f) => ({ name: f.name, mxc: f.mxc, mimetype: f.mimetype, size: f.size })),
    },
  };
}

/** Runs the schema and re-throws a zod failure as the one error type this module exposes — callers never need to know zod is involved. */
function validateCard(card: DuoCardV1): DuoCardV1 {
  const parsed = DuoCardSchema.safeParse(card);
  if (!parsed.success) {
    throw new CardValidationError(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
  }
  return parsed.data;
}

/**
 * Builds a brand-new `duo.card` message — rev starts at 1. Throws
 * `ReservedCardKindError` for `confirm` and every reserved kind, and
 * `CardValidationError` for any input that violates the wire schema's
 * limits (title/line length, line count, decision option count, milestone
 * count). The returned event always validates against `DuoCardSchema`.
 */
export function buildCardEvent(card: DuoCardV1Input): DuoCardEventContent {
  refuseReservedKind(card.kind);
  const built = validateCard(cardOf(card, 1));
  return {
    msgtype: "duo.card",
    body: fallbackBodyOf(card),
    "m.mentions": {},
    "duo.card": built,
  };
}

/**
 * Builds an edit of an existing card (cards.md §3): a same-sender
 * `m.replace` whose `m.new_content` carries the FULL new card, at
 * `previousRev + 1`. The caller tracks `previousRev` itself (e.g. the rev
 * the card was last sent or edited at) — this function only ever bumps it
 * by exactly one, so a caller cannot accidentally skip or repeat a
 * revision. Top-level `body` is `"* " + fallback`, per the spec's edit
 * example. Throws the same errors `buildCardEvent` does.
 */
export function buildCardEdit(eventId: string, card: DuoCardV1Input, previousRev: number): DuoCardEditContent {
  refuseReservedKind(card.kind);
  const built = validateCard(cardOf(card, previousRev + 1));
  const fallback = fallbackBodyOf(card);
  return {
    msgtype: "duo.card",
    body: `* ${fallback}`,
    "m.new_content": {
      msgtype: "duo.card",
      body: fallback,
      "m.mentions": {},
      "duo.card": built,
    },
    "m.relates_to": { rel_type: "m.replace", event_id: eventId },
  };
}

/**
 * The plain-text fallback `body` every client without card rendering sees
 * — built ONLY from the fixed copy table in docs/workspace/cards.md §5 and
 * asker-visible strings already on the input (never a field this type
 * doesn't carry). Exported so `buildCardEvent`/`buildCardEdit` and any
 * caller that wants to preview a card's fallback compute it identically.
 */
export function fallbackBodyOf(card: DuoCardV1Input): string {
  refuseReservedKind(card.kind);
  if (card.kind === "task") {
    if (card.state === "done" || card.state === "failed") {
      if (card.result !== undefined) {
        const lines = [card.result.text, ...(card.result.links ?? []).map((link) => `${link.label}: ${link.url}`)];
        return lines.join("\n");
      }
      // A task card can also reach `done`/`failed` with no `result` (a
      // decline or a bare failure, per cards.md's task-state table) — the
      // caller supplies that fixed copy as the first (and only) line.
      return (card.lines ?? [])[0] ?? "";
    }
    // acknowledged / working / needs_decision: the fixed or passed-on copy
    // the caller supplies as the card's one line (cards.md §5's table —
    // every one of these rows is a single fixed or asker-visible sentence).
    return (card.lines ?? [])[0] ?? "";
  }
  if (card.kind === "decision") {
    if (card.state === "chosen") {
      return `Chosen by ${card.chosen?.by ?? ""}.`;
    }
    if (card.state === "expired") {
      return "This request expired.";
    }
    // open: the fixed sentence built from the option labels, in order, joined by " · ".
    return `To answer, I need to know which you mean: ${card.options.map((option) => option.label).join(" · ")}. Choose in the duo app.`;
  }
  // result
  const lines = [card.result.text, ...(card.result.links ?? []).map((link) => `${link.label}: ${link.url}`)];
  return lines.join("\n");
}
