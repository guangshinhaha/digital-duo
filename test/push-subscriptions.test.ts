import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDir } from "./helpers/temp-dir.js";
import {
  InvalidEndpointError,
  InvalidQuietHoursError,
  QUIET_HOURS_OFF,
  getOrCreateVapidKeys,
  isQuietNow,
  listSubscriptions,
  parseQuietHours,
  parseSubscriptionEndpoint,
  readPushState,
  removeSubscription,
  upsertSubscription,
  type QuietHours,
} from "../src/push/subscriptions.js";
import { createEncryptedStore } from "../src/store/store.js";

const tempDir = useTempDir();
const PASSPHRASE = "pw";

function initStore(): string {
  const storePath = join(tempDir(), "data", "duo.db");
  createEncryptedStore(storePath, PASSPHRASE);
  return storePath;
}

function subscription(endpoint = "https://push.example/abc", quietHours: QuietHours = QUIET_HOURS_OFF) {
  return { endpoint, keys: { p256dh: "p256dh-key", auth: "auth-key" }, quietHours };
}

describe("upsertSubscription / listSubscriptions / removeSubscription", () => {
  it("registers a device's subscription and lists it back", () => {
    const storePath = initStore();
    upsertSubscription(storePath, PASSPHRASE, "device-1", subscription());
    const subs = listSubscriptions(storePath, PASSPHRASE);
    expect(subs).toEqual([
      { deviceId: "device-1", endpoint: "https://push.example/abc", keys: { p256dh: "p256dh-key", auth: "auth-key" }, quietHours: QUIET_HOURS_OFF, createdAt: expect.any(String) },
    ]);
  });

  it("re-registering the same device replaces its subscription — one row per device", () => {
    const storePath = initStore();
    upsertSubscription(storePath, PASSPHRASE, "device-1", subscription("https://push.example/old"));
    upsertSubscription(storePath, PASSPHRASE, "device-1", subscription("https://push.example/new"));
    const subs = listSubscriptions(storePath, PASSPHRASE);
    expect(subs).toHaveLength(1);
    expect(subs[0].endpoint).toBe("https://push.example/new");
  });

  it("two devices each get their own row", () => {
    const storePath = initStore();
    upsertSubscription(storePath, PASSPHRASE, "device-1", subscription("https://push.example/a"));
    upsertSubscription(storePath, PASSPHRASE, "device-2", subscription("https://push.example/b"));
    expect(listSubscriptions(storePath, PASSPHRASE).map((s) => s.deviceId).sort()).toEqual(["device-1", "device-2"]);
  });

  it("removing a device's subscription is idempotent — a device with none is a no-op, not an error", () => {
    const storePath = initStore();
    upsertSubscription(storePath, PASSPHRASE, "device-1", subscription());
    removeSubscription(storePath, PASSPHRASE, "device-1");
    expect(listSubscriptions(storePath, PASSPHRASE)).toEqual([]);
    expect(() => removeSubscription(storePath, PASSPHRASE, "device-1")).not.toThrow();
    expect(() => removeSubscription(storePath, PASSPHRASE, "never-registered")).not.toThrow();
  });

  it("a fresh duo has no subscriptions", () => {
    const storePath = initStore();
    expect(listSubscriptions(storePath, PASSPHRASE)).toEqual([]);
  });
});

describe("parseQuietHours — the half-set-window rule, restated server-side", () => {
  it("defaults to off when nothing is supplied", () => {
    expect(parseQuietHours({})).toEqual(QUIET_HOURS_OFF);
  });

  it("accepts manual do-not-disturb alone", () => {
    expect(parseQuietHours({ manual: true })).toEqual({ manual: true, from: null, to: null, timezone: "UTC" });
  });

  it("accepts a daily window with a time zone", () => {
    expect(parseQuietHours({ from: "22:00", to: "07:00", timezone: "Asia/Singapore" })).toEqual({
      manual: false,
      from: "22:00",
      to: "07:00",
      timezone: "Asia/Singapore",
    });
  });

  it("refuses a half-set window — from without to, or to without from", () => {
    expect(() => parseQuietHours({ from: "22:00" })).toThrow(InvalidQuietHoursError);
    expect(() => parseQuietHours({ to: "07:00" })).toThrow(InvalidQuietHoursError);
  });

  it("refuses a malformed HH:MM", () => {
    expect(() => parseQuietHours({ from: "22:00", to: "25:99" })).toThrow(InvalidQuietHoursError);
    expect(() => parseQuietHours({ from: "10pm", to: "07:00" })).toThrow(InvalidQuietHoursError);
  });

  it("refuses a time zone Intl does not recognize, rather than storing it and misbehaving at send time", () => {
    expect(() => parseQuietHours({ timezone: "Mars/Olympus_Mons" })).toThrow(InvalidQuietHoursError);
  });
});

describe("isQuietNow — held back, or not, at this exact moment", () => {
  it("manual do-not-disturb always holds, regardless of the window", () => {
    expect(isQuietNow({ manual: true, from: null, to: null, timezone: "UTC" }, new Date("2026-01-01T12:00:00Z"))).toBe(true);
  });

  it("no window at all never holds", () => {
    expect(isQuietNow(QUIET_HOURS_OFF, new Date("2026-01-01T03:00:00Z"))).toBe(false);
  });

  it("a same-day window (09:00–17:00) holds inside it and releases outside it", () => {
    const window: QuietHours = { manual: false, from: "09:00", to: "17:00", timezone: "UTC" };
    expect(isQuietNow(window, new Date("2026-01-01T12:00:00Z"))).toBe(true); // noon
    expect(isQuietNow(window, new Date("2026-01-01T09:00:00Z"))).toBe(true); // start, inclusive
    expect(isQuietNow(window, new Date("2026-01-01T17:00:00Z"))).toBe(false); // end, exclusive
    expect(isQuietNow(window, new Date("2026-01-01T08:00:00Z"))).toBe(false);
  });

  it("an overnight window (22:00–07:00) wraps past midnight", () => {
    const window: QuietHours = { manual: false, from: "22:00", to: "07:00", timezone: "UTC" };
    expect(isQuietNow(window, new Date("2026-01-01T23:00:00Z"))).toBe(true);
    expect(isQuietNow(window, new Date("2026-01-02T03:00:00Z"))).toBe(true);
    expect(isQuietNow(window, new Date("2026-01-01T12:00:00Z"))).toBe(false);
  });

  it("evaluates the window in the subscription's own time zone, not UTC", () => {
    // 09:00 in Asia/Singapore (UTC+8) is 01:00 UTC.
    const window: QuietHours = { manual: false, from: "09:00", to: "17:00", timezone: "Asia/Singapore" };
    expect(isQuietNow(window, new Date("2026-01-01T01:30:00Z"))).toBe(true);
    expect(isQuietNow(window, new Date("2026-01-01T10:30:00Z"))).toBe(false); // 18:30 in Singapore — past the window
  });
});

describe("getOrCreateVapidKeys — this duo's identity, generated once", () => {
  it("generates keys on first use and returns the same ones on every later call — never rotated", () => {
    const storePath = initStore();
    let calls = 0;
    const generate = () => {
      calls += 1;
      return { publicKey: `pub-${calls}`, privateKey: `priv-${calls}` };
    };
    const first = getOrCreateVapidKeys(storePath, PASSPHRASE, generate);
    const second = getOrCreateVapidKeys(storePath, PASSPHRASE, generate);
    expect(first).toEqual({ publicKey: "pub-1", privateKey: "priv-1" });
    expect(second).toEqual(first);
    expect(calls).toBe(1);
  });

  it("defaults to the real generator when none is given — a production caller never has to import web-push just to pass it through", () => {
    const storePath = initStore();
    const keys = getOrCreateVapidKeys(storePath, PASSPHRASE);
    // web-push's own VAPID keys are URL-safe base64: real, distinct, non-empty strings — not asserting an exact value (that's the library's own concern), only that this daemon's default actually reached it.
    expect(keys.publicKey).toEqual(expect.any(String));
    expect(keys.privateKey).toEqual(expect.any(String));
    expect(keys.publicKey.length).toBeGreaterThan(20);
    expect(keys.publicKey).not.toBe(keys.privateKey);
  });
});

describe("parseSubscriptionEndpoint — refusing anywhere this daemon should not be pointed at (digital-duo#268 review: SSRF)", () => {
  it("accepts a real https endpoint, unchanged", () => {
    expect(parseSubscriptionEndpoint("https://fcm.googleapis.com/fcm/send/abc123")).toBe("https://fcm.googleapis.com/fcm/send/abc123");
  });

  it("refuses plain http — a real PushSubscription's endpoint is never anything but https", () => {
    expect(() => parseSubscriptionEndpoint("http://push.example/a")).toThrow(InvalidEndpointError);
  });

  it("refuses a non-URL and a blank string", () => {
    expect(() => parseSubscriptionEndpoint("not a url")).toThrow(InvalidEndpointError);
    expect(() => parseSubscriptionEndpoint("")).toThrow(InvalidEndpointError);
    expect(() => parseSubscriptionEndpoint(undefined)).toThrow(InvalidEndpointError);
  });

  it("refuses a scheme that isn't even a transport this daemon would ever post over — file:, javascript:", () => {
    expect(() => parseSubscriptionEndpoint("file:///etc/passwd")).toThrow(InvalidEndpointError);
    expect(() => parseSubscriptionEndpoint("javascript:alert(1)")).toThrow(InvalidEndpointError);
  });

  it("does not, on its own, exempt an internal-looking https host — this is a protocol check, no allowlist of push-service hosts (matches the scope of the codebase's own precedent, workspace/settings.ts's DUO_WORKSPACE_HOMESERVER check)", () => {
    // Documenting the boundary of this fix rather than asserting a stronger
    // guarantee than it makes: https to *anything* is accepted here, same
    // as the existing DUO_WORKSPACE_HOMESERVER check accepts any https host.
    expect(parseSubscriptionEndpoint("https://169.254.169.254/latest/meta-data/")).toBe("https://169.254.169.254/latest/meta-data/");
  });
});

describe("readPushState — subscriptions and VAPID keys, read together (digital-duo#268 review: one store read, not two)", () => {
  it("reads both in one call, and reports keys as undefined before anything has generated them", () => {
    const storePath = initStore();
    upsertSubscription(storePath, PASSPHRASE, "device-1", subscription());
    const state = readPushState(storePath, PASSPHRASE);
    expect(state.subscriptions).toHaveLength(1);
    expect(state.vapidKeys).toBeUndefined();
  });

  it("reports the keys already generated, without generating new ones — this call never writes", () => {
    const storePath = initStore();
    const generated = getOrCreateVapidKeys(storePath, PASSPHRASE, () => ({ publicKey: "pub", privateKey: "priv" }));
    const state = readPushState(storePath, PASSPHRASE);
    expect(state.vapidKeys).toEqual(generated);
  });
});
