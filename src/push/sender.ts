import { WebPushError, sendNotification } from "web-push";

/**
 * digital-duo#251: one push, sent. Transport-agnostic on purpose (the same
 * reasoning `ChannelAdapter` states for delivery, #170): today the only
 * implementation is Web Push, but the shape below names nothing web-push-
 * specific, so an APNs or FCM sender for a native app can implement it
 * later without this module's callers changing.
 */
export interface PushSender {
  /**
   * Sends one push. Resolves on success. Rejects with `PushGoneError` when
   * the push service reports this subscription no longer exists (its own
   * signal to stop sending to it, never inferred from anything else);
   * rejects with a plain `Error` for any other failure. Never retried by
   * this module — #251's own "no retry queue for drafts."
   */
  send(subscription: PushSubscriptionTarget, payload: string, vapid: VapidDetails): Promise<void>;
}

export interface PushSubscriptionTarget {
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
}

export interface VapidDetails {
  /** A "https:" URL or "mailto:" address the push service may contact about abuse — the VAPID spec's own requirement, not this daemon's choosing. */
  readonly subject: string;
  readonly publicKey: string;
  readonly privateKey: string;
}

/** The push service's own word that a subscription is gone — a 404 or 410, the two statuses every Web Push implementation (and the spec itself) uses for "stop sending here," never assumed from a timeout or a 5xx. */
export class PushGoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PushGoneError";
  }
}

/**
 * A push held for at most a day: #251's own "no retry queue" already means
 * nothing is resent, so there is no reason for the push service to keep
 * offering a stale "a draft is waiting" to a device that reconnects a week
 * later — the app itself is still the truth of what is waiting, this is
 * only the tap on the shoulder.
 */
const TTL_SECONDS = 24 * 60 * 60;

/** The real sender, backed by the `web-push` library. VAPID details are passed per call, never through the library's global `setVapidDetails` — this daemon can serve more than one duo's store in one process (hosted mode), and each has its own keys. */
export const webPushSender: PushSender = {
  async send(subscription, payload, vapid) {
    try {
      await sendNotification(subscription, payload, {
        vapidDetails: vapid,
        TTL: TTL_SECONDS,
      });
    } catch (error) {
      if (error instanceof WebPushError && (error.statusCode === 404 || error.statusCode === 410)) {
        throw new PushGoneError(`push service reports this subscription gone (HTTP ${error.statusCode})`);
      }
      throw error;
    }
  },
};
