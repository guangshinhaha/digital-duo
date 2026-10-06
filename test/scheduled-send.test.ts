import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeEmbeddingProvider } from "./fixtures/fake-embedding-provider.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { loadConfig } from "../src/config.js";
import { appendDraft, getDraft, recordDraftOutcome, type DraftProvenance } from "../src/drafting/draft-log.js";
import type { ChannelAdapter, ChannelDeliveryRequest } from "../src/drafting/delivery.js";
import {
  cancelScheduledSend,
  getScheduledSend,
  listScheduledSends,
  nextWorkingHoursStart,
  parseWorkingHours,
  scheduleSend,
  type WorkingHours,
} from "../src/drafting/scheduled-sends.js";
import { ScheduledSendRunner } from "../src/serve/scheduled-send-runner.js";
import { createServer, type ServeDeps } from "../src/serve/server.js";
import { createAskToken, createDeviceToken } from "../src/serve/tokens.js";
import { createEncryptedStore } from "../src/store/store.js";

const tempDir = useTempDir();
const PASSPHRASE = "pw";

const CHANNEL: DraftProvenance = { origin: "channel", channelKind: "matrix", askerRef: "@sam:example.org", threadId: "!room:example.org", permalink: null };

function initStore(): string {
  const storePath = join(tempDir(), "data", "duo.db");
  createEncryptedStore(storePath, PASSPHRASE);
  return storePath;
}

function appendChannelDraft(storePath: string, draftText: string | null = "point them at the runbook"): string {
  return appendDraft(storePath, PASSPHRASE, {
    question: "how do I get deploy access?",
    threadContext: null,
    draftText,
    escalated: draftText === null,
    escalationReason: draftText === null ? "no supporting evidence" : null,
    confidenceScore: draftText === null ? 0 : 0.8,
    sources: [],
    provenance: CHANNEL,
  });
}

function recordingAdapter(): { adapter: ChannelAdapter; requests: ChannelDeliveryRequest[] } {
  const requests: ChannelDeliveryRequest[] = [];
  return {
    requests,
    adapter: {
      channelKind: "matrix",
      label: "Workspace",
      async status() {
        return { state: "connected", lastActivityAt: null };
      },
      async deliver(request) {
        requests.push(request);
        return "$event:example.org";
      },
    },
  };
}

const T0 = new Date("2026-10-06T14:00:00.000Z");

describe("scheduled sends — the hold (#261)", () => {
  it("persists a scheduled send without recording any outcome on the draft", () => {
    const storePath = initStore();
    const draftId = appendChannelDraft(storePath);
    const sendAt = new Date(T0.getTime() + 3_600_000);

    scheduleSend(storePath, PASSPHRASE, draftId, { outcome: "sent", sendAt }, T0);

    expect(getScheduledSend(storePath, PASSPHRASE, draftId)).toMatchObject({ draftId, outcome: "sent", sendAt: sendAt.toISOString(), state: "scheduled" });
    expect(listScheduledSends(storePath, PASSPHRASE).map((send) => send.draftId)).toEqual([draftId]);
    expect(getDraft(storePath, PASSPHRASE, draftId)?.outcome).toBeNull();
  });

  it("refuses a past time, a passed-on draft, a blank edit, a settled draft and a second hold", () => {
    const storePath = initStore();
    const draftId = appendChannelDraft(storePath);
    const later = new Date(T0.getTime() + 60_000);
    expect(() => scheduleSend(storePath, PASSPHRASE, draftId, { outcome: "sent", sendAt: new Date(T0.getTime() - 1) }, T0)).toThrow(/future/);
    expect(() => scheduleSend(storePath, PASSPHRASE, appendChannelDraft(storePath, null), { outcome: "sent", sendAt: later }, T0)).toThrow(/text to send/);
    expect(() => scheduleSend(storePath, PASSPHRASE, draftId, { outcome: "edited", sentText: "  ", sendAt: later }, T0)).toThrow(/edited text/);

    scheduleSend(storePath, PASSPHRASE, draftId, { outcome: "sent", sendAt: later }, T0);
    expect(() => scheduleSend(storePath, PASSPHRASE, draftId, { outcome: "sent", sendAt: later }, T0)).toThrow(/already scheduled/);

    const settled = appendChannelDraft(storePath);
    recordDraftOutcome(storePath, PASSPHRASE, settled, "discarded");
    expect(() => scheduleSend(storePath, PASSPHRASE, settled, { outcome: "sent", sendAt: later }, T0)).toThrow(/already recorded/);
  });

  it("can be cancelled, and rescheduled after cancelling", () => {
    const storePath = initStore();
    const draftId = appendChannelDraft(storePath);
    scheduleSend(storePath, PASSPHRASE, draftId, { outcome: "sent", sendAt: new Date(T0.getTime() + 60_000) }, T0);
    cancelScheduledSend(storePath, PASSPHRASE, draftId, T0);
    expect(listScheduledSends(storePath, PASSPHRASE)).toEqual([]);
    expect(() => cancelScheduledSend(storePath, PASSPHRASE, draftId, T0)).toThrow(/No send is scheduled/);
    scheduleSend(storePath, PASSPHRASE, draftId, { outcome: "sent", sendAt: new Date(T0.getTime() + 120_000) }, T0);
    expect(getScheduledSend(storePath, PASSPHRASE, draftId)?.state).toBe("scheduled");
  });
});

describe("ScheduledSendRunner — firing held sends (#261)", () => {
  function runnerAt(storePath: string, now: { value: Date }, adapters: readonly ChannelAdapter[]) {
    return new ScheduledSendRunner({ storePath, passphrase: PASSPHRASE, channelAdapters: () => adapters, now: () => now.value });
  }

  it("fires at its time through the normal delivery path — no client involved — and not before", async () => {
    const storePath = initStore();
    const draftId = appendChannelDraft(storePath);
    const now = { value: T0 };
    scheduleSend(storePath, PASSPHRASE, draftId, { outcome: "edited", sentText: "the edited reply", sendAt: new Date(T0.getTime() + 60_000) }, T0);
    const { adapter, requests } = recordingAdapter();
    const runner = runnerAt(storePath, now, [adapter]);

    await runner.runDue();
    expect(requests).toEqual([]);
    expect(runner.heldDraftIds().has(draftId)).toBe(true);

    now.value = new Date(T0.getTime() + 60_000);
    await runner.runDue();
    runner.stop();

    expect(requests).toEqual([{ askerRef: "@sam:example.org", threadId: "!room:example.org", permalink: null, text: "the edited reply" }]);
    const draft = getDraft(storePath, PASSPHRASE, draftId);
    expect(draft?.outcome).toBe("edited");
    expect(draft?.sentText).toBe("the edited reply");
    expect(draft?.delivery).toEqual({ state: "delivered", eventId: "$event:example.org" });
    expect(getScheduledSend(storePath, PASSPHRASE, draftId)?.state).toBe("sent");
    expect(runner.heldDraftIds().has(draftId)).toBe(false);
  });

  it("survives a restart: a fresh runner on the same store fires what came due while it was down", async () => {
    const storePath = initStore();
    const draftId = appendChannelDraft(storePath);
    scheduleSend(storePath, PASSPHRASE, draftId, { outcome: "sent", sendAt: new Date(T0.getTime() + 60_000) }, T0);
    // The first daemon stops before the send is due…
    const before = runnerAt(storePath, { value: T0 }, []);
    await before.runDue();
    before.stop();
    // …and a new one comes up after it.
    const { adapter, requests } = recordingAdapter();
    const after = runnerAt(storePath, { value: new Date(T0.getTime() + 3_600_000) }, [adapter]);
    await after.runDue();
    after.stop();
    expect(requests.map((request) => request.text)).toEqual(["point them at the runbook"]);
  });

  it("a send cancelled before its time is never delivered", async () => {
    const storePath = initStore();
    const draftId = appendChannelDraft(storePath);
    scheduleSend(storePath, PASSPHRASE, draftId, { outcome: "sent", sendAt: new Date(T0.getTime() + 60_000) }, T0);
    cancelScheduledSend(storePath, PASSPHRASE, draftId, T0);
    const { adapter, requests } = recordingAdapter();
    const runner = runnerAt(storePath, { value: new Date(T0.getTime() + 120_000) }, [adapter]);
    await runner.runDue();
    runner.stop();
    expect(requests).toEqual([]);
    expect(getDraft(storePath, PASSPHRASE, draftId)?.outcome).toBeNull();
  });

  it("a draft settled some other way in the meantime is not delivered again — the hold settles as superseded", async () => {
    const storePath = initStore();
    const draftId = appendChannelDraft(storePath);
    scheduleSend(storePath, PASSPHRASE, draftId, { outcome: "sent", sendAt: new Date(T0.getTime() + 60_000) }, T0);
    recordDraftOutcome(storePath, PASSPHRASE, draftId, "discarded");
    const { adapter, requests } = recordingAdapter();
    const runner = runnerAt(storePath, { value: new Date(T0.getTime() + 120_000) }, [adapter]);
    await runner.runDue();
    runner.stop();
    expect(requests).toEqual([]);
    expect(getScheduledSend(storePath, PASSPHRASE, draftId)?.state).toBe("superseded");
  });
});

describe("start of working hours (#261)", () => {
  const SINGAPORE: WorkingHours = { start: "09:00", end: "18:00", timezone: "Asia/Singapore", days: [1, 2, 3, 4, 5] };

  it("before today's start on a working day resolves to today's start", () => {
    // Tue 2026-10-06 07:30 SGT = 2026-10-05T23:30Z.
    expect(nextWorkingHoursStart(new Date("2026-10-05T23:30:00Z"), SINGAPORE).toISOString()).toBe("2026-10-06T01:00:00.000Z");
  });

  it("late on a Friday resolves to Monday morning, skipping the weekend", () => {
    // Fri 2026-10-09 22:00 SGT = 14:00Z → Mon 2026-10-12 09:00 SGT = 01:00Z.
    expect(nextWorkingHoursStart(new Date("2026-10-09T14:00:00Z"), SINGAPORE).toISOString()).toBe("2026-10-12T01:00:00.000Z");
  });

  it("during working hours resolves to the next day's start, not now", () => {
    // Tue 11:00 SGT → Wed 09:00 SGT.
    expect(nextWorkingHoursStart(new Date("2026-10-06T03:00:00Z"), SINGAPORE).toISOString()).toBe("2026-10-07T01:00:00.000Z");
  });

  it("follows the zone's own offset across a daylight-saving change", () => {
    const newYork: WorkingHours = { ...SINGAPORE, timezone: "America/New_York" };
    // Sat 2026-10-31 → Mon 2026-11-02 09:00 EST (DST ended Sun 1 Nov) = 14:00Z.
    expect(nextWorkingHoursStart(new Date("2026-10-31T15:00:00Z"), newYork).toISOString()).toBe("2026-11-02T14:00:00.000Z");
  });

  it("validates the setting", () => {
    expect(() => parseWorkingHours({ start: "9am", end: "18:00", timezone: "UTC", days: [1] })).toThrow(/HH:MM/);
    expect(() => parseWorkingHours({ start: "09:00", end: "08:00", timezone: "UTC", days: [1] })).toThrow(/after start/);
    expect(() => parseWorkingHours({ start: "09:00", end: "18:00", timezone: "Mars/Olympus", days: [1] })).toThrow(/time zone/);
    expect(() => parseWorkingHours({ start: "09:00", end: "18:00", timezone: "UTC", days: [] })).toThrow(/days/);
  });
});

describe("scheduled send routes (#261)", () => {
  function setup(overrides: Partial<ServeDeps> = {}) {
    const storePath = initStore();
    const config = loadConfig();
    const deps: ServeDeps = {
      storePath,
      passphrase: PASSPHRASE,
      duoDir: join(tempDir(), "duo"),
      lifecycleLogPath: join(tempDir(), "lifecycle-runtime", "events.json"),
      embeddingProvider: createFakeEmbeddingProvider(),
      inferenceProvider: undefined,
      confidenceConfig: config.confidence,
      classificationCeiling: config.classificationCeiling,
      ownerName: "Owner",
      env: {},
      ...overrides,
    };
    const device = createDeviceToken(storePath, PASSPHRASE, "laptop");
    const app = createServer(deps);
    return { app, storePath, auth: { authorization: `Bearer ${device.token}` } };
  }

  it("a held draft leaves Waiting on you, is listed as scheduled, and returns when cancelled", async () => {
    const { app, auth, storePath } = setup();
    const draftId = appendChannelDraft(storePath);
    const sendAt = new Date(Date.now() + 3_600_000).toISOString();

    const scheduled = await app.inject({ method: "POST", url: `/drafts/${draftId}/schedule`, headers: auth, payload: { sendAt } });
    expect(scheduled.statusCode).toBe(201);
    expect(scheduled.json()).toMatchObject({ draftId, sendAt, state: "scheduled" });

    const pending = (await app.inject({ method: "GET", url: "/drafts?outcome=pending", headers: auth })).json() as { id: string }[];
    expect(pending.map((draft) => draft.id)).not.toContain(draftId);
    const list = (await app.inject({ method: "GET", url: "/scheduled-sends", headers: auth })).json() as { draftId: string; draft: { id: string } }[];
    expect(list.map((send) => send.draft.id)).toEqual([draftId]);

    expect((await app.inject({ method: "POST", url: `/drafts/${draftId}/schedule`, headers: auth, payload: { sendAt } })).statusCode).toBe(409);
    expect((await app.inject({ method: "DELETE", url: `/drafts/${draftId}/schedule`, headers: auth })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: `/drafts/${draftId}/schedule`, headers: auth })).statusCode).toBe(404);
    const after = (await app.inject({ method: "GET", url: "/drafts?outcome=pending", headers: auth })).json() as { id: string }[];
    expect(after.map((draft) => draft.id)).toContain(draftId);
    await app.close();
  });

  it("refuses a past time, an unknown draft, and an ask token", async () => {
    const { app, auth, storePath } = setup();
    const draftId = appendChannelDraft(storePath);
    expect((await app.inject({ method: "POST", url: `/drafts/${draftId}/schedule`, headers: auth, payload: { sendAt: "2000-01-01T00:00:00Z" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/drafts/${draftId}/schedule`, headers: auth, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/drafts/nope/schedule`, headers: auth, payload: { sendAt: new Date(Date.now() + 60_000).toISOString() } })).statusCode).toBe(404);
    const ask = createAskToken(storePath, PASSPHRASE, "Sam", new Date(Date.now() + 3_600_000).toISOString());
    const refused = await app.inject({ method: "GET", url: "/scheduled-sends", headers: { authorization: `Bearer ${ask.token}` } });
    expect(refused.statusCode).toBe(401);
    await app.close();
  });

  it("schedules for the start of working hours from the saved setting", async () => {
    const { app, auth, storePath } = setup();
    const saved = await app.inject({
      method: "PUT",
      url: "/settings/working-hours",
      headers: auth,
      payload: { start: "08:30", end: "17:30", timezone: "Asia/Singapore", days: [1, 2, 3, 4, 5] },
    });
    expect(saved.statusCode).toBe(200);
    const read = (await app.inject({ method: "GET", url: "/settings/working-hours", headers: auth })).json() as WorkingHours & { nextStart: string };
    expect(read).toMatchObject({ start: "08:30", timezone: "Asia/Singapore" });
    expect(read.nextStart).toBe(nextWorkingHoursStart(new Date(), read).toISOString());

    const draftId = appendChannelDraft(storePath);
    const scheduled = await app.inject({ method: "POST", url: `/drafts/${draftId}/schedule`, headers: auth, payload: { at: "working-hours" } });
    expect(scheduled.statusCode).toBe(201);
    const sendAt = (scheduled.json() as { sendAt: string }).sendAt;
    expect(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Singapore", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(sendAt))).toBe("08:30");
    expect((await app.inject({ method: "PUT", url: "/settings/working-hours", headers: auth, payload: { start: "x" } })).statusCode).toBe(400);
    await app.close();
  });

  it("the daemon delivers it at its time on its own — no client request triggers the send", async () => {
    const { adapter, requests } = recordingAdapter();
    const { app, auth, storePath } = setup({ channelAdapters: [adapter] });
    const draftId = appendChannelDraft(storePath);
    const scheduled = await app.inject({
      method: "POST",
      url: `/drafts/${draftId}/schedule`,
      headers: auth,
      payload: { sendAt: new Date(Date.now() + 1_500).toISOString() },
    });
    expect(scheduled.statusCode).toBe(201);
    // From here no client calls anything: the "device" is gone.
    const deadline = Date.now() + 8_000;
    while (requests.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(requests.map((request) => request.text)).toEqual(["point them at the runbook"]);
    expect(getDraft(storePath, PASSPHRASE, draftId)?.delivery).toEqual({ state: "delivered", eventId: "$event:example.org" });
    await app.close();
  });

  it("sending a held draft directly releases its hold", async () => {
    const { app, auth, storePath } = setup();
    const draftId = appendChannelDraft(storePath);
    await app.inject({ method: "POST", url: `/drafts/${draftId}/schedule`, headers: auth, payload: { sendAt: new Date(Date.now() + 3_600_000).toISOString() } });
    expect((await app.inject({ method: "POST", url: `/drafts/${draftId}/outcome`, headers: auth, payload: { outcome: "sent" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/scheduled-sends", headers: auth })).json()).toEqual([]);
    expect(getScheduledSend(storePath, PASSPHRASE, draftId)?.state).toBe("superseded");
    await app.close();
  });
});
