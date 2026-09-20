import type { EditClassifier, ClassifyAndQueueResult } from "../corrections/classify.js";
import { recordDraftOutcomeAndClassify } from "../corrections/classify.js";
import { isChannelMuted } from "./channel-mutes.js";
import { getDraft, recordDeliveryOutcome, type DraftRecord, type SettableDraftOutcome } from "./draft-log.js";

/**
 * The delivery seam (#170): one channel-agnostic interface. Recording
 * `sent` or `edited` on a draft hands the final text to the adapter that
 * owns the draft's origin channel, and records what happened against the
 * draft — pending, delivered, or failed with a reason.
 *
 * This is a module, not a route handler, on purpose (invariant #1): the
 * daemon's `POST /drafts/:id/outcome` and the CLI's `duo draft-outcome`
 * both call `recordOutcomeAndDeliver` below, so neither surface owns any
 * delivery behaviour of its own.
 *
 * No real transport ships here — "any specific adapter's transport" is
 * #170's own out-of-scope list. A daemon with no adapter registered for a
 * draft's channel kind records an honest failure naming the kind.
 */
export interface ChannelAdapter {
  /** Which `provenance.channelKind` this adapter owns — how a draft's origin is matched to its deliverer. */
  readonly channelKind: string;
  /**
   * #171: the label this adapter wants shown for the channel it owns.
   * Supplied by the adapter so no surface — client screen, CLI, route —
   * ever has to recognise a product name to render one.
   */
  readonly label: string;
  /**
   * #171: this channel's health as the adapter itself sees it — the
   * owner-facing answer to "why has nothing arrived today." Async by
   * nature: a real transport probes its connection over the network.
   */
  status(): Promise<ChannelStatus>;
  /**
   * Hands the final text to the channel. Resolves on success; throws on
   * transport failure (the message becomes the draft's recorded failure
   * reason). Async by nature — a real transport is a network call.
   */
  deliver(request: ChannelDeliveryRequest): Promise<void>;
}

/** A channel's connection state plus when it last carried anything — both reported by the adapter, which is the only side that can know (#171). */
export interface ChannelStatus {
  readonly state: "connected" | "failed";
  /** Present iff `state` is "failed" — a reason the owner can act on, in the adapter's own words. */
  readonly reason?: string;
  /** When this channel last carried anything (ISO-8601), both directions — mentions in, deliveries out — or null if it never has. */
  readonly lastActivityAt: string | null;
}

/** Everything an adapter needs to put a reply back where the question came from — drawn from the draft's own provenance (#169). */
export interface ChannelDeliveryRequest {
  readonly askerRef: string;
  readonly threadId: string | null;
  readonly permalink: string | null;
  readonly text: string;
}

/**
 * The full "record an outcome and deliver it" orchestration (#170): the
 * outcome and its correction signal are recorded first, exactly as
 * `recordDraftOutcomeAndClassify` already did, and only then is the final
 * text handed to the origin channel. That ordering is the issue's own
 * requirement — the correction signal and the delivery are two different
 * concerns and must fail independently, so a transport error can never
 * cost the training signal.
 *
 * Delivery failures are recorded against the draft and never raised:
 * this function resolves with the classification result whatever
 * happened on the wire. Only the outcome-recording errors propagate
 * (unknown draft id, blank edit) — those mean nothing was recorded at
 * all, which the caller must see.
 */
export async function recordOutcomeAndDeliver(
  storePath: string,
  passphrase: string,
  draftId: string,
  outcome: SettableDraftOutcome,
  sentText: string | undefined,
  options: { readonly classifier?: EditClassifier; readonly channelAdapters?: readonly ChannelAdapter[] } = {},
): Promise<ClassifyAndQueueResult | undefined> {
  const result = await recordDraftOutcomeAndClassify(storePath, passphrase, draftId, outcome, sentText, options.classifier);

  // Only sent/edited deliver — "discarded" means nothing was sent, and an
  // owner-asked draft is not a reply to anybody (checked in
  // deliverSentDraft, via the draft's provenance).
  if (outcome !== "sent" && outcome !== "edited") {
    return result;
  }
  const draft = getDraft(storePath, passphrase, draftId);
  if (draft) {
    await deliverSentDraft(storePath, passphrase, draft, sentText ?? draft.draftText ?? undefined, options.channelAdapters ?? []);
  }
  return result;
}

/**
 * Hands one sent draft's final text to the adapter owning its origin
 * channel, recording the delivery state at handoff and at settlement.
 * Never throws: every failure — no adapter connected, no text to send, a
 * transport error — is recorded against the draft as
 * `{ state: "failed", reason }`, because the outcome that caused the
 * delivery attempt already stands (#170 AC2).
 *
 * A draft whose origin is not a channel (owner, unknown) delivers
 * nothing and records nothing: there is nowhere to deliver to, and that
 * is not an error (#170 AC3).
 */
export async function deliverSentDraft(
  storePath: string,
  passphrase: string,
  draft: DraftRecord,
  text: string | undefined,
  channelAdapters: readonly ChannelAdapter[],
): Promise<void> {
  const provenance = draft.provenance;
  if (provenance.origin !== "channel") {
    return;
  }
  if (text === undefined || text.trim().length === 0) {
    recordDeliveryOutcome(storePath, passphrase, draft.id, { state: "failed", reason: "no final text to deliver" });
    return;
  }
  const adapter = channelAdapters.find((candidate) => candidate.channelKind === provenance.channelKind);
  if (!adapter) {
    recordDeliveryOutcome(storePath, passphrase, draft.id, {
      state: "failed",
      reason: `no connected adapter for channel kind "${provenance.channelKind}"`,
    });
    return;
  }
  // Pending is written before the adapter is ever called: durable truth at
  // handoff, so a daemon that dies mid-delivery leaves an honest row.
  recordDeliveryOutcome(storePath, passphrase, draft.id, { state: "pending" });
  try {
    await adapter.deliver({
      askerRef: provenance.askerRef,
      threadId: provenance.threadId,
      permalink: provenance.permalink,
      text,
    });
    recordDeliveryOutcome(storePath, passphrase, draft.id, { state: "delivered" });
  } catch (error) {
    recordDeliveryOutcome(storePath, passphrase, draft.id, {
      state: "failed",
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/** One row of #171's channels list — a channel in a shape that names no product: everything the client renders is either the adapter's own string or a daemon-owned fixed value. */
export interface ChannelSummary {
  readonly kind: string;
  /** The adapter's own label, passed through verbatim. */
  readonly label: string;
  readonly state: "connected" | "failed";
  /** Present iff `state` is "failed" — the adapter's own reason, never re-worded. */
  readonly reason?: string;
  readonly lastActivityAt: string | null;
  readonly muted: boolean;
}

/**
 * "What this duo is reachable through" (#171): one row per registered
 * adapter, its self-reported health, and whether it is muted — the screen
 * the owner opens to find out why it is quiet, so nothing here may throw.
 * A status probe that crashes renders as a broken channel with the error's
 * message as the reason, not a failed read: a transport too broken to
 * answer its own health check *is* the answer.
 *
 * Mute state is the CLI's own store (`duo/muted-channels.json`, read by
 * `duo mentions muted`) matched case-insensitively against the adapter's
 * channel kind — one store, not two. The per-thread generalization (#172)
 * extends that vocabulary below channel level; it does not replace it.
 * No registered adapters is the supported empty list, not an error.
 */
export async function describeChannels(adapters: readonly ChannelAdapter[], duoDir: string): Promise<ChannelSummary[]> {
  return Promise.all(
    adapters.map(async (adapter): Promise<ChannelSummary> => {
      let status: ChannelStatus;
      try {
        status = await adapter.status();
      } catch (error) {
        return {
          kind: adapter.channelKind,
          label: adapter.label,
          state: "failed",
          reason: error instanceof Error ? error.message : String(error),
          lastActivityAt: null,
          muted: isChannelMuted(duoDir, adapter.channelKind),
        };
      }
      return {
        kind: adapter.channelKind,
        label: adapter.label,
        state: status.state,
        ...(status.reason !== undefined ? { reason: status.reason } : {}),
        lastActivityAt: status.lastActivityAt,
        muted: isChannelMuted(duoDir, adapter.channelKind),
      };
    }),
  );
}
