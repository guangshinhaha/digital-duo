import { describe, expect, it, vi } from "vitest";
import { WebPushError } from "web-push";

vi.mock("web-push", async (importOriginal) => {
  const actual = await importOriginal<typeof import("web-push")>();
  return { ...actual, sendNotification: vi.fn() };
});

import { sendNotification } from "web-push";
import { PushGoneError, webPushSender } from "../src/push/sender.js";

const target = { endpoint: "https://push.example/a", keys: { p256dh: "k", auth: "a" } };
const vapid = { subject: "mailto:owner@example.org", publicKey: "pub", privateKey: "priv" };

describe("webPushSender — translating the push service's own words (digital-duo#251)", () => {
  it("resolves on a plain success, passing the subscription, payload and per-call VAPID details straight through", async () => {
    vi.mocked(sendNotification).mockResolvedValueOnce({ statusCode: 201, body: "", headers: {} });
    await webPushSender.send(target, JSON.stringify({ draftId: "d1" }), vapid);
    expect(sendNotification).toHaveBeenCalledWith(
      target,
      JSON.stringify({ draftId: "d1" }),
      expect.objectContaining({ vapidDetails: vapid }),
    );
  });

  it("turns a 410 Gone into PushGoneError", async () => {
    vi.mocked(sendNotification).mockRejectedValueOnce(new WebPushError("gone", 410, {}, "", target.endpoint));
    await expect(webPushSender.send(target, "{}", vapid)).rejects.toBeInstanceOf(PushGoneError);
  });

  it("turns a 404 into PushGoneError too — the push service's other word for gone", async () => {
    vi.mocked(sendNotification).mockRejectedValueOnce(new WebPushError("not found", 404, {}, "", target.endpoint));
    await expect(webPushSender.send(target, "{}", vapid)).rejects.toBeInstanceOf(PushGoneError);
  });

  it("never assumes gone from a transport failure or a 5xx — only the push service's own 404/410 mean that", async () => {
    vi.mocked(sendNotification).mockRejectedValueOnce(new WebPushError("server error", 500, {}, "", target.endpoint));
    const error = await webPushSender.send(target, "{}", vapid).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(PushGoneError);
  });

  it("passes through a non-WebPushError as-is, e.g. a network-level failure", async () => {
    vi.mocked(sendNotification).mockRejectedValueOnce(new Error("ECONNRESET"));
    await expect(webPushSender.send(target, "{}", vapid)).rejects.toThrow("ECONNRESET");
  });
});
