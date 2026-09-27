import type { ChannelAdapter, RawThreadMessage } from "./delivery.js";
import { listDrafts } from "./draft-log.js";

/**
 * One message in a bridged thread, as the client renders it (digital-duo#248):
 * the channel's own words, and whether this daemon knows it was the owner's
 * own sent reply. `fromOwner` is never the adapter's to say — a channel adapter
 * reports what the channel actually holds, and this daemon is the only side
 * that knows which of those messages were its own drafts, delivered through
 * the seam #247 gave an `eventId` to.
 */
export interface ThreadMessage extends RawThreadMessage {
  readonly fromOwner: boolean;
}

/**
 * digital-duo#248: the messages of one bridged thread, oldest first, so the
 * client's chat can fill in around the questions it already has from
 * `GET /drafts`. Read-only, and never throws — no adapter registered for
 * `channelKind`, an adapter that does not offer `history`, or a read that
 * fails on the wire are all exactly the same thing from here: nothing
 * available, an empty array, which is the "clear empty result" the issue's
 * own acceptance criteria ask for. The client already keeps its
 * questions-only view for that case; this never invents a reason why.
 *
 * `fromOwner` is worked out here, not asked of the adapter: every message
 * whose id matches one of this duo's own drafts, delivered to this exact
 * channel and thread (`provenance.channelKind`/`threadId`, `delivery.eventId`
 * — #247), is the owner's; every other message is the asker's. A draft
 * whose delivery carried no eventId (an adapter that couldn't give one, or
 * one predating #247) simply cannot be matched this way — its message
 * still appears in the read (the channel itself holds it), just not marked
 * as the owner's.
 */
export async function readThreadMessages(
  storePath: string,
  passphrase: string,
  channelAdapters: readonly ChannelAdapter[],
  channelKind: string,
  threadId: string,
): Promise<ThreadMessage[]> {
  const adapter = channelAdapters.find((candidate) => candidate.channelKind === channelKind);
  if (!adapter?.history) {
    return [];
  }
  let raw: readonly RawThreadMessage[];
  try {
    raw = await adapter.history(threadId);
  } catch {
    // The adapter's own read failed — exactly as honest as "nothing
    // available": there is no reason to hand the client an error for a
    // thread it already knows how to show without this.
    return [];
  }

  const ownEventIds = new Set(
    listDrafts(storePath, passphrase)
      .filter(
        (draft) =>
          draft.provenance.origin === "channel" &&
          draft.provenance.channelKind === channelKind &&
          draft.provenance.threadId === threadId &&
          draft.delivery?.state === "delivered" &&
          draft.delivery.eventId !== undefined,
      )
      // The filter above only lets a "delivered" draft with an eventId
      // through, so the cast that follows only narrows what TypeScript
      // cannot itself carry across a `.filter` — every draft() here does
      // have both fields.
      .map((draft) => (draft.delivery as { state: "delivered"; eventId: string }).eventId),
  );

  return [...raw]
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((message) => ({ ...message, fromOwner: ownEventIds.has(message.id) }));
}
