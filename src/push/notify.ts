import { getOrCreateVapidKeys, isQuietNow, readPushState, removeSubscription } from "./subscriptions.js";
import { PushGoneError, webPushSender, type PushSender } from "./sender.js";

/**
 * digital-duo#251: "when a draft is written, send each of the owner's
 * subscriptions a push that carries only the draft's id and a fixed line."
 * This is that send — the one function every serving-layer call site that
 * creates a draft the owner needs to look at now calls, mirroring how
 * `draftReady.publish` (the WebSocket twin, `serve/ws.ts`) is called
 * explicitly at each such site rather than baked into the pipeline itself
 * (`draftReply` is reused by eval and calibration tooling that must never
 * have a live side effect like this one fire).
 *
 * Never throws, and never awaited by its callers for the same reason
 * `deliverSentDraft` never is (#170's law restated for a different
 * transport): a push failing must not cost the draft that already exists,
 * or the request that is already on its way back to whoever asked.
 *
 * Silently does nothing when `DUO_PUSH_VAPID_SUBJECT` is not configured —
 * an operator who has not set it up gets no pushes, not a crash and not a
 * placeholder contact address sent to a real push service, which would be
 * exactly the kind of made-up value this codebase never sends as if it
 * were real.
 */
export async function notifyDraftWaiting(
  deps: { readonly storePath: string; readonly passphrase: string; readonly env: NodeJS.ProcessEnv },
  draftId: string,
  sender: PushSender = webPushSender,
): Promise<void> {
  try {
    const subject = deps.env.DUO_PUSH_VAPID_SUBJECT;
    if (!subject) {
      return;
    }
    // One store read for both, not two (the review's own finding on this
    // PR): this runs synchronously, before the first `await`, in a
    // function its callers fire without awaiting — every millisecond
    // spent here still blocks the event loop, and the response the route
    // already sent, until it yields.
    const { subscriptions, vapidKeys } = readPushState(deps.storePath, deps.passphrase);
    if (subscriptions.length === 0) {
      return;
    }
    // The rare path: keys not generated yet (this duo's very first push,
    // ever) is the one case that still needs a write.
    const { publicKey, privateKey } = vapidKeys ?? getOrCreateVapidKeys(deps.storePath, deps.passphrase);
    const payload = JSON.stringify({ draftId });
    const now = new Date();

    await Promise.allSettled(
      subscriptions
        .filter((subscription) => !isQuietNow(subscription.quietHours, now))
        .map(async (subscription) => {
          try {
            await sender.send(subscription, payload, { subject, publicKey, privateKey });
          } catch (error) {
            if (error instanceof PushGoneError) {
              removeSubscription(deps.storePath, deps.passphrase, subscription.deviceId);
              return;
            }
            // #251's own "no retry queue for drafts": this send simply
            // did not happen, and nothing here retries it — but an
            // operator watching this daemon's own logs still needs to
            // know push is failing, or it fails silently forever.
            console.error(`notifyDraftWaiting: push to a registered device failed (not gone, not retried):`, error);
          }
        }),
    );
  } catch (error) {
    // The store-reading calls above (listSubscriptions, getOrCreateVapidKeys)
    // are the one part of this function that could throw synchronously
    // rather than reject a per-subscription send — a locked or corrupted
    // store, say. This function's whole contract to its callers is that it
    // never throws (they fire it without awaiting, exactly as
    // `deliverSentDraft` is never awaited for the same reason): whatever
    // happened here, it must cost nothing on the draft that already exists.
    console.error("notifyDraftWaiting: push notification failed, draft is unaffected:", error);
  }
}
