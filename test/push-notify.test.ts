import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { useTempDir } from "./helpers/temp-dir.js";
import { notifyDraftWaiting } from "../src/push/notify.js";
import { listSubscriptions, upsertSubscription, type QuietHours } from "../src/push/subscriptions.js";
import { PushGoneError, type PushSender, type PushSubscriptionTarget, type VapidDetails } from "../src/push/sender.js";
import { createEncryptedStore } from "../src/store/store.js";

const tempDir = useTempDir();
const PASSPHRASE = "pw";

function initStore(): string {
  const storePath = join(tempDir(), "data", "duo.db");
  createEncryptedStore(storePath, PASSPHRASE);
  return storePath;
}

function depsOf(storePath: string, env: NodeJS.ProcessEnv = { DUO_PUSH_VAPID_SUBJECT: "mailto:owner@example.org" }) {
  return { storePath, passphrase: PASSPHRASE, env };
}

function fakeSender(): PushSender & { sent: Array<{ subscription: PushSubscriptionTarget; payload: string; vapid: VapidDetails }>; fail?: (endpoint: string) => Error | undefined } {
  const sent: Array<{ subscription: PushSubscriptionTarget; payload: string; vapid: VapidDetails }> = [];
  return {
    sent,
    async send(subscription, payload, vapid) {
      const failure = this.fail?.(subscription.endpoint);
      if (failure) {
        throw failure;
      }
      sent.push({ subscription, payload, vapid });
    },
  };
}

describe("notifyDraftWaiting — the id-only push (digital-duo#251)", () => {
  it("does nothing when no VAPID contact is configured — never a fabricated one sent to a real push service", async () => {
    const storePath = initStore();
    upsertSubscription(storePath, PASSPHRASE, "device-1", { endpoint: "https://push.example/a", keys: { p256dh: "k", auth: "a" }, quietHours: { manual: false, from: null, to: null, timezone: "UTC" } });
    const sender = fakeSender();
    await notifyDraftWaiting(depsOf(storePath, {}), "draft-1", sender);
    expect(sender.sent).toEqual([]);
  });

  it("does nothing when no device has registered for push", async () => {
    const storePath = initStore();
    const sender = fakeSender();
    await notifyDraftWaiting(depsOf(storePath), "draft-1", sender);
    expect(sender.sent).toEqual([]);
  });

  it("sends only the draft id and a fixed line — never the question or the draft's text, which this function never even sees", async () => {
    const storePath = initStore();
    upsertSubscription(storePath, PASSPHRASE, "device-1", { endpoint: "https://push.example/a", keys: { p256dh: "k", auth: "a" }, quietHours: { manual: false, from: null, to: null, timezone: "UTC" } });
    const sender = fakeSender();
    await notifyDraftWaiting(depsOf(storePath), "draft-42", sender);
    expect(sender.sent).toHaveLength(1);
    expect(JSON.parse(sender.sent[0].payload)).toEqual({ draftId: "draft-42" });
    expect(sender.sent[0].subscription.endpoint).toBe("https://push.example/a");
    expect(sender.sent[0].vapid.subject).toBe("mailto:owner@example.org");
  });

  it("sends to every registered device", async () => {
    const storePath = initStore();
    upsertSubscription(storePath, PASSPHRASE, "device-1", { endpoint: "https://push.example/a", keys: { p256dh: "k", auth: "a" }, quietHours: { manual: false, from: null, to: null, timezone: "UTC" } });
    upsertSubscription(storePath, PASSPHRASE, "device-2", { endpoint: "https://push.example/b", keys: { p256dh: "k", auth: "a" }, quietHours: { manual: false, from: null, to: null, timezone: "UTC" } });
    const sender = fakeSender();
    await notifyDraftWaiting(depsOf(storePath), "draft-1", sender);
    expect(sender.sent.map((s) => s.subscription.endpoint).sort()).toEqual(["https://push.example/a", "https://push.example/b"]);
  });

  it("holds a push back for a device in its own quiet hours, and sends to every other device unaffected", async () => {
    const storePath = initStore();
    const quiet: QuietHours = { manual: true, from: null, to: null, timezone: "UTC" };
    const awake: QuietHours = { manual: false, from: null, to: null, timezone: "UTC" };
    upsertSubscription(storePath, PASSPHRASE, "quiet-device", { endpoint: "https://push.example/quiet", keys: { p256dh: "k", auth: "a" }, quietHours: quiet });
    upsertSubscription(storePath, PASSPHRASE, "awake-device", { endpoint: "https://push.example/awake", keys: { p256dh: "k", auth: "a" }, quietHours: awake });
    const sender = fakeSender();
    await notifyDraftWaiting(depsOf(storePath), "draft-1", sender);
    expect(sender.sent.map((s) => s.subscription.endpoint)).toEqual(["https://push.example/awake"]);
  });

  it("what quiet hours held back is simply not sent — no queue, no later catch-up", async () => {
    const storePath = initStore();
    upsertSubscription(storePath, PASSPHRASE, "device-1", { endpoint: "https://push.example/a", keys: { p256dh: "k", auth: "a" }, quietHours: { manual: true, from: null, to: null, timezone: "UTC" } });
    const sender = fakeSender();
    await notifyDraftWaiting(depsOf(storePath), "draft-1", sender);
    await notifyDraftWaiting(depsOf(storePath), "draft-2", sender);
    expect(sender.sent).toEqual([]);
  });

  it("drops a subscription the push service reports gone, and leaves every other one alone", async () => {
    const storePath = initStore();
    upsertSubscription(storePath, PASSPHRASE, "gone-device", { endpoint: "https://push.example/gone", keys: { p256dh: "k", auth: "a" }, quietHours: { manual: false, from: null, to: null, timezone: "UTC" } });
    upsertSubscription(storePath, PASSPHRASE, "live-device", { endpoint: "https://push.example/live", keys: { p256dh: "k", auth: "a" }, quietHours: { manual: false, from: null, to: null, timezone: "UTC" } });
    const sender = fakeSender();
    sender.fail = (endpoint) => (endpoint === "https://push.example/gone" ? new PushGoneError("410") : undefined);
    await notifyDraftWaiting(depsOf(storePath), "draft-1", sender);
    expect(listSubscriptions(storePath, PASSPHRASE).map((s) => s.deviceId)).toEqual(["live-device"]);
  });

  it("never throws and never drops the subscription for an ordinary send failure — no retry queue, but no data loss either", async () => {
    const storePath = initStore();
    upsertSubscription(storePath, PASSPHRASE, "flaky-device", { endpoint: "https://push.example/flaky", keys: { p256dh: "k", auth: "a" }, quietHours: { manual: false, from: null, to: null, timezone: "UTC" } });
    const sender = fakeSender();
    sender.fail = () => new Error("network hiccup");
    await expect(notifyDraftWaiting(depsOf(storePath), "draft-1", sender)).resolves.toBeUndefined();
    expect(listSubscriptions(storePath, PASSPHRASE).map((s) => s.deviceId)).toEqual(["flaky-device"]);
  });

  it("logs an ordinary send failure — never retried, but not silent either, or push going wrong would have no trace at all (digital-duo#268 review)", async () => {
    const storePath = initStore();
    upsertSubscription(storePath, PASSPHRASE, "flaky-device", { endpoint: "https://push.example/flaky", keys: { p256dh: "k", auth: "a" }, quietHours: { manual: false, from: null, to: null, timezone: "UTC" } });
    const sender = fakeSender();
    sender.fail = () => new Error("network hiccup");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await notifyDraftWaiting(depsOf(storePath), "draft-1", sender);
      expect(logged).toHaveBeenCalledWith(expect.stringContaining("push to a registered device failed"), expect.any(Error));
    } finally {
      logged.mockRestore();
    }
  });

  it("never logs anything for a gone subscription — that path already has its own outcome, dropping the row", async () => {
    const storePath = initStore();
    upsertSubscription(storePath, PASSPHRASE, "gone-device", { endpoint: "https://push.example/gone", keys: { p256dh: "k", auth: "a" }, quietHours: { manual: false, from: null, to: null, timezone: "UTC" } });
    const sender = fakeSender();
    sender.fail = () => new PushGoneError("410");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await notifyDraftWaiting(depsOf(storePath), "draft-1", sender);
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  it("never throws even when the store read itself fails — a locked or corrupted store must cost nothing on the draft that already exists", async () => {
    const sender = fakeSender();
    await expect(notifyDraftWaiting(depsOf("/no/such/store/duo.db"), "draft-1", sender)).resolves.toBeUndefined();
    expect(sender.sent).toEqual([]);
  });

  it("uses this duo's own VAPID keys, the same ones on every call — not regenerated per send", async () => {
    const storePath = initStore();
    upsertSubscription(storePath, PASSPHRASE, "device-1", { endpoint: "https://push.example/a", keys: { p256dh: "k", auth: "a" }, quietHours: { manual: false, from: null, to: null, timezone: "UTC" } });
    const sender = fakeSender();
    await notifyDraftWaiting(depsOf(storePath), "draft-1", sender);
    await notifyDraftWaiting(depsOf(storePath), "draft-2", sender);
    expect(sender.sent[0].vapid.publicKey).toBe(sender.sent[1].vapid.publicKey);
    expect(sender.sent[0].vapid.publicKey).toEqual(expect.any(String));
  });
});
