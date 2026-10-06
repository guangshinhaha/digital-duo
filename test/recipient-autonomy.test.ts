import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeEmbeddingProvider } from "./fixtures/fake-embedding-provider.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { loadConfig } from "../src/config.js";
import { considerAutonomousSend, listAutonomousHolds } from "../src/drafting/autonomous-send.js";
import type { ChannelAdapter, ChannelDeliveryRequest } from "../src/drafting/delivery.js";
import { appendDraft, getDraft, recordDraftOutcome, type DismissReason, type DraftProvenance, type DraftRecipient } from "../src/drafting/draft-log.js";
import { getScheduledSend, holdAutonomousSend, listScheduledSends, stopAutonomousSend } from "../src/drafting/scheduled-sends.js";
import { announceNewDraft } from "../src/serve/autonomy-routes.js";
import { ScheduledSendRunner } from "../src/serve/scheduled-send-runner.js";
import { createServer, type ServeDeps } from "../src/serve/server.js";
import type { DraftReadyHub } from "../src/serve/ws.js";
import { createDeviceToken } from "../src/serve/tokens.js";
import { createEncryptedStore, withDatabase } from "../src/store/store.js";
import {
  acceptAutonomyOffer,
  activeAutonomyGrant,
  AUTONOMY_OFFER_COOLDOWN_DAYS,
  AUTONOMY_OFFER_MIN_DECIDED,
  computeTrackRecords,
  declineAutonomyOffer,
  DEFAULT_AUTONOMY_HOLD_SECONDS,
  getAutonomyOffers,
  getTrackRecord,
  listAutonomyGrants,
  meetsAutonomyThreshold,
  readAutonomySettings,
  revokeAutonomyGrant,
  writeAutonomySettings,
  type DecidedReply,
} from "../src/trust/recipient-autonomy.js";

const tempDir = useTempDir();
const PASSPHRASE = "pw";
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-06T12:00:00.000Z");

const WEI: DraftRecipient = { id: "@wei:example.org", name: "Wei" };
const WEI_KEY = "recipient:@wei:example.org";
const CHANNEL: DraftProvenance = { origin: "channel", channelKind: "matrix", askerRef: "@wei:example.org", threadId: "!room:example.org", permalink: null };

function initStore(): string {
  const storePath = join(tempDir(), "data", "duo.db");
  createEncryptedStore(storePath, PASSPHRASE);
  return storePath;
}

interface ReplyOptions {
  readonly recipient?: DraftRecipient | null;
  readonly provenance?: DraftProvenance;
  readonly confidence?: number;
  readonly text?: string | null;
}

function appendReply(storePath: string, options: ReplyOptions = {}): string {
  const text = options.text === undefined ? "the runbook is on the wiki" : options.text;
  return appendDraft(storePath, PASSPHRASE, {
    question: "where's the runbook?",
    threadContext: null,
    draftText: text,
    escalated: text === null,
    escalationReason: text === null ? "no evidence" : null,
    confidenceScore: options.confidence ?? 0.9,
    sources: [],
    escalationThreshold: 0.55,
    provenance: options.provenance ?? CHANNEL,
    recipient: options.recipient === undefined ? WEI : options.recipient,
  });
}

type Handling = "sent" | "edited" | "discarded";

/** Appends one reply and decides it at `at` (outcome_recorded_at is backdated directly, as only the clock differs). */
function decide(storePath: string, handling: Handling, at: Date, options: ReplyOptions & { dismissReason?: DismissReason } = {}): string {
  const id = appendReply(storePath, options);
  recordDraftOutcome(storePath, PASSPHRASE, id, handling, handling === "edited" ? "a changed reply" : undefined, options.dismissReason);
  withDatabase(storePath, PASSPHRASE, true, (db) => {
    db.prepare(`UPDATE drafts SET outcome_recorded_at = ? WHERE id = ?`).run(at.toISOString(), id);
  });
  return id;
}

/** `count` decided replies, one a day ending yesterday, oldest first. `handlingAt(i)` picks each one's handling (i = 0 is the oldest). */
function history(storePath: string, count: number, handlingAt: (index: number) => Handling = () => "sent", options: ReplyOptions = {}): string[] {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    ids.push(decide(storePath, handlingAt(index), new Date(NOW.getTime() - (count - index) * DAY), options));
  }
  return ids;
}

function reply(handling: DecidedReply["handling"], daysAgo: number, dismissReason: string | null = null): DecidedReply {
  return { recipientKey: WEI_KEY, recipientName: "Wei", handling, dismissReason, decidedAt: new Date(NOW.getTime() - daysAgo * DAY).toISOString() };
}

describe("track record — the evidence (#266)", () => {
  it("counts sent-unedited vs edited vs dismissed per person, from the owner's decisions on replies", () => {
    const storePath = initStore();
    history(storePath, 6, (i) => (i === 0 ? "edited" : i === 1 ? "discarded" : "sent"));
    const record = getTrackRecord(storePath, PASSPHRASE, WEI_KEY);
    expect(record).toMatchObject({ recipientName: "Wei", considered: 6, sentUnedited: 4, edited: 1, dismissed: 1 });
    expect(record?.uneditedShare).toBeCloseTo(4 / 6);
  });

  it("ignores owner-asked drafts, escalations and undecided drafts — only replies the owner judged count", () => {
    const storePath = initStore();
    decide(storePath, "sent", new Date(NOW.getTime() - DAY), { provenance: { origin: "owner" } });
    appendReply(storePath); // pending
    appendReply(storePath, { text: null }); // escalated
    decide(storePath, "sent", new Date(NOW.getTime() - DAY));
    expect(getTrackRecord(storePath, PASSPHRASE, WEI_KEY)?.considered).toBe(1);
  });

  it("a 'sent' whose recorded text differs, or that the owner shaped, is not unedited", () => {
    const storePath = initStore();
    const id = appendReply(storePath);
    recordDraftOutcome(storePath, PASSPHRASE, id, "sent", "something else entirely");
    expect(getTrackRecord(storePath, PASSPHRASE, WEI_KEY)).toMatchObject({ sentUnedited: 0, edited: 1 });
  });

  it("keys a reply with no stated recipient by its channel asker", () => {
    const storePath = initStore();
    decide(storePath, "sent", NOW, { recipient: null });
    expect(getTrackRecord(storePath, PASSPHRASE, "channel:matrix:@wei:example.org")).toMatchObject({ recipientName: "@wei:example.org", considered: 1 });
  });

  it("a send the duo made by itself does not count toward the record that earned it", () => {
    const storePath = initStore();
    const id = appendReply(storePath);
    holdAutonomousSend(storePath, PASSPHRASE, id, 0, NOW);
    recordDraftOutcome(storePath, PASSPHRASE, id, "sent");
    withDatabase(storePath, PASSPHRASE, true, (db) => db.prepare(`UPDATE scheduled_sends SET state = 'sent' WHERE draft_id = ?`).run(id));
    expect(getTrackRecord(storePath, PASSPHRASE, WEI_KEY)).toBeUndefined();
  });
});

describe("the documented threshold (#266)", () => {
  const clean = (count: number, spanDays = 30) => Array.from({ length: count }, (_, i) => reply("unedited", (spanDays * (i + 1)) / count));

  it("is met by twenty clean replies spread over more than a week", () => {
    expect(meetsAutonomyThreshold(computeTrackRecords(clean(AUTONOMY_OFFER_MIN_DECIDED))[0])).toBe(true);
  });

  it("is not met by nineteen", () => {
    expect(meetsAutonomyThreshold(computeTrackRecords(clean(AUTONOMY_OFFER_MIN_DECIDED - 1))[0])).toBe(false);
  });

  it("allows one change in twenty (95%) but not two (90%)", () => {
    const one = [...clean(19), reply("edited", 40)];
    const two = [...clean(18), reply("edited", 40), reply("edited", 41)];
    expect(meetsAutonomyThreshold(computeTrackRecords(one)[0])).toBe(true);
    expect(meetsAutonomyThreshold(computeTrackRecords(two)[0])).toBe(false);
  });

  it("is not met when one of the last five was changed, however good the rest", () => {
    const records = [...clean(24, 40), reply("edited", 0.1)];
    expect(meetsAutonomyThreshold(computeTrackRecords(records)[0])).toBe(false);
  });

  it("is not met by a burst — twenty replies inside one week", () => {
    expect(meetsAutonomyThreshold(computeTrackRecords(clean(20, 5))[0])).toBe(false);
  });

  it("is blocked outright by a dismissal for wrong facts or 'shouldn't answer'", () => {
    const records = [...clean(25, 40), reply("dismissed", 39, "wrong_facts")];
    expect(computeTrackRecords(records)[0].disqualified).toBe(true);
    expect(meetsAutonomyThreshold(computeTrackRecords(records)[0])).toBe(false);
  });

  it("looks only at the most recent thirty, so an old rough patch ages out", () => {
    const records = [...clean(30, 30), reply("edited", 50), reply("edited", 51), reply("edited", 52)];
    expect(computeTrackRecords(records)[0].considered).toBe(30);
    expect(meetsAutonomyThreshold(computeTrackRecords(records)[0])).toBe(true);
  });
});

describe("offers, accept and decline (#266)", () => {
  it("raises an offer past the threshold that states the evidence in plain words", () => {
    const storePath = initStore();
    history(storePath, 20);
    const offers = getAutonomyOffers(storePath, PASSPHRASE, NOW);
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ recipientKey: WEI_KEY, recipientName: "Wei", holdSeconds: DEFAULT_AUTONOMY_HOLD_SECONDS });
    expect(offers[0].evidence).toBe(
      "You've sent all of my last 20 replies to Wei without changing a word. May I answer Wei myself? I'd hold each answer for 30 seconds first, so you can stop or edit it.",
    );
  });

  it("raises no offer below the threshold", () => {
    const storePath = initStore();
    history(storePath, 19);
    expect(getAutonomyOffers(storePath, PASSPHRASE, NOW)).toEqual([]);
  });

  it("accepting grants autonomy for that person only, and the offer goes away", () => {
    const storePath = initStore();
    history(storePath, 20);
    history(storePath, 20, () => "sent", { recipient: { id: "@sam:example.org", name: "Sam" } });
    const grant = acceptAutonomyOffer(storePath, PASSPHRASE, WEI_KEY, NOW);
    expect(grant).toMatchObject({ recipientKey: WEI_KEY, recipientName: "Wei", revokedAt: null });
    expect(grant.evidence.sentUnedited).toBe(20);
    expect(activeAutonomyGrant(storePath, PASSPHRASE, WEI_KEY)).toBeDefined();
    expect(activeAutonomyGrant(storePath, PASSPHRASE, "recipient:@sam:example.org")).toBeUndefined();
    expect(getAutonomyOffers(storePath, PASSPHRASE, NOW).map((offer) => offer.recipientKey)).toEqual(["recipient:@sam:example.org"]);
    expect(listAutonomyGrants(storePath, PASSPHRASE).map((g) => g.recipientKey)).toEqual([WEI_KEY]);
  });

  it("refuses to accept or decline an offer that is not pending", () => {
    const storePath = initStore();
    history(storePath, 5);
    expect(() => acceptAutonomyOffer(storePath, PASSPHRASE, WEI_KEY, NOW)).toThrow(/No autonomy offer/);
    expect(() => declineAutonomyOffer(storePath, PASSPHRASE, WEI_KEY, NOW)).toThrow(/No autonomy offer/);
  });

  it("declining suppresses the same offer for the cooldown, then it may return", () => {
    const storePath = initStore();
    history(storePath, 20);
    declineAutonomyOffer(storePath, PASSPHRASE, WEI_KEY, NOW);
    expect(getAutonomyOffers(storePath, PASSPHRASE, NOW)).toEqual([]);
    expect(getAutonomyOffers(storePath, PASSPHRASE, new Date(NOW.getTime() + (AUTONOMY_OFFER_COOLDOWN_DAYS - 1) * DAY))).toEqual([]);
    expect(getAutonomyOffers(storePath, PASSPHRASE, new Date(NOW.getTime() + (AUTONOMY_OFFER_COOLDOWN_DAYS + 1) * DAY))).toHaveLength(1);
  });

  it("revoking takes autonomy back and keeps the offer quiet for the cooldown too", () => {
    const storePath = initStore();
    history(storePath, 20);
    acceptAutonomyOffer(storePath, PASSPHRASE, WEI_KEY, NOW);
    revokeAutonomyGrant(storePath, PASSPHRASE, WEI_KEY, NOW);
    expect(activeAutonomyGrant(storePath, PASSPHRASE, WEI_KEY)).toBeUndefined();
    expect(listAutonomyGrants(storePath, PASSPHRASE)).toEqual([]);
    expect(getAutonomyOffers(storePath, PASSPHRASE, NOW)).toEqual([]);
    expect(() => revokeAutonomyGrant(storePath, PASSPHRASE, WEI_KEY, NOW)).toThrow(/no standing autonomy/);
  });
});

describe("the undo-window setting (#268)", () => {
  it("defaults to 30 seconds and saves a new value", () => {
    const storePath = initStore();
    expect(readAutonomySettings(storePath, PASSPHRASE)).toEqual({ holdSeconds: 30 });
    writeAutonomySettings(storePath, PASSPHRASE, { holdSeconds: 60 });
    expect(readAutonomySettings(storePath, PASSPHRASE)).toEqual({ holdSeconds: 60 });
  });

  it("0 disables the hold only with explicit confirmation", () => {
    const storePath = initStore();
    expect(() => writeAutonomySettings(storePath, PASSPHRASE, { holdSeconds: 0 })).toThrow(/confirmNoHold/);
    expect(readAutonomySettings(storePath, PASSPHRASE).holdSeconds).toBe(30);
    writeAutonomySettings(storePath, PASSPHRASE, { holdSeconds: 0, confirmNoHold: true });
    expect(readAutonomySettings(storePath, PASSPHRASE).holdSeconds).toBe(0);
  });

  it("refuses nonsense", () => {
    const storePath = initStore();
    for (const holdSeconds of [-1, 1.5, 601, "30"]) {
      expect(() => writeAutonomySettings(storePath, PASSPHRASE, { holdSeconds })).toThrow(/whole number/);
    }
  });
});

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

function granted(storePath: string): void {
  history(storePath, 20);
  acceptAutonomyOffer(storePath, PASSPHRASE, WEI_KEY, NOW);
}

describe("what granted autonomy does — held, never instant (#266 + #268)", () => {
  it("a new confident reply to a granted person is held for the undo window, not sent and not left waiting", () => {
    const storePath = initStore();
    granted(storePath);
    const draftId = appendReply(storePath);
    const decision = considerAutonomousSend(storePath, PASSPHRASE, draftId, NOW);
    expect(decision.held).toBe(true);
    const held = getScheduledSend(storePath, PASSPHRASE, draftId);
    expect(held).toMatchObject({ autonomous: true, outcome: "sent", state: "scheduled", sendAt: new Date(NOW.getTime() + 30_000).toISOString() });
    expect(getDraft(storePath, PASSPHRASE, draftId)?.outcome).toBeNull();
    expect(listAutonomousHolds(storePath, PASSPHRASE).map((send) => send.draftId)).toEqual([draftId]);
  });

  it("stays a normal draft without a grant, for an owner-asked draft, for a hedged draft, and for an escalation", () => {
    const storePath = initStore();
    expect(considerAutonomousSend(storePath, PASSPHRASE, appendReply(storePath), NOW)).toEqual({ held: false, reason: "no_grant" });
    granted(storePath);
    expect(considerAutonomousSend(storePath, PASSPHRASE, appendReply(storePath, { provenance: { origin: "owner" } }), NOW)).toEqual({ held: false, reason: "not_a_reply" });
    expect(considerAutonomousSend(storePath, PASSPHRASE, appendReply(storePath, { confidence: 0.6 }), NOW)).toEqual({ held: false, reason: "hedged" });
    expect(considerAutonomousSend(storePath, PASSPHRASE, appendReply(storePath, { text: null }), NOW)).toEqual({ held: false, reason: "no_text" });
    expect(considerAutonomousSend(storePath, PASSPHRASE, appendReply(storePath, { recipient: { id: "@sam:example.org", name: "Sam" } }), NOW)).toEqual({
      held: false,
      reason: "no_grant",
    });
    expect(listScheduledSends(storePath, PASSPHRASE)).toEqual([]);
  });

  it("the window elapsing delivers it normally, through the delivery seam", async () => {
    const storePath = initStore();
    granted(storePath);
    const draftId = appendReply(storePath);
    considerAutonomousSend(storePath, PASSPHRASE, draftId, NOW);
    const { adapter, requests } = recordingAdapter();
    const now = { value: NOW };
    const runner = new ScheduledSendRunner({ storePath, passphrase: PASSPHRASE, channelAdapters: () => [adapter], now: () => now.value });

    await runner.runDue();
    expect(requests).toEqual([]);

    now.value = new Date(NOW.getTime() + 30_000);
    await runner.runDue();
    runner.stop();
    expect(requests.map((request) => request.text)).toEqual(["the runbook is on the wiki"]);
    expect(getDraft(storePath, PASSPHRASE, draftId)).toMatchObject({ outcome: "sent", delivery: { state: "delivered" } });
    expect(getScheduledSend(storePath, PASSPHRASE, draftId)?.state).toBe("sent");
  });

  it("Stop inside the window means nothing is posted, and the draft waits on the owner again", async () => {
    const storePath = initStore();
    granted(storePath);
    const draftId = appendReply(storePath);
    considerAutonomousSend(storePath, PASSPHRASE, draftId, NOW);
    stopAutonomousSend(storePath, PASSPHRASE, draftId, NOW);
    const { adapter, requests } = recordingAdapter();
    const runner = new ScheduledSendRunner({ storePath, passphrase: PASSPHRASE, channelAdapters: () => [adapter], now: () => new Date(NOW.getTime() + 60_000) });
    await runner.runDue();
    runner.stop();
    expect(requests).toEqual([]);
    expect(getDraft(storePath, PASSPHRASE, draftId)?.outcome).toBeNull();
    expect(listScheduledSends(storePath, PASSPHRASE)).toEqual([]);
  });

  it("Stop after it went is refused rather than pretending — the reply was sent", () => {
    const storePath = initStore();
    granted(storePath);
    const draftId = appendReply(storePath);
    considerAutonomousSend(storePath, PASSPHRASE, draftId, NOW);
    // The runner has recorded the outcome and is mid-delivery: the hold still reads "scheduled".
    recordDraftOutcome(storePath, PASSPHRASE, draftId, "sent");
    expect(() => stopAutonomousSend(storePath, PASSPHRASE, draftId, NOW)).toThrow(/No send is scheduled/);
  });

  it("a zero-second hold (explicitly confirmed) still goes through the hold, due at once", () => {
    const storePath = initStore();
    granted(storePath);
    writeAutonomySettings(storePath, PASSPHRASE, { holdSeconds: 0, confirmNoHold: true });
    const draftId = appendReply(storePath);
    considerAutonomousSend(storePath, PASSPHRASE, draftId, NOW);
    expect(getScheduledSend(storePath, PASSPHRASE, draftId)).toMatchObject({ autonomous: true, sendAt: NOW.toISOString() });
  });
});

describe("autonomy routes (#266, #268)", () => {
  function setup(overrides: Partial<ServeDeps> = {}, prepare?: (storePath: string) => string) {
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
    // Anything held before the daemon boots is read by its runner at start, as after a restart.
    const prepared = prepare?.(storePath);
    const app = createServer(deps);
    return { app, deps, storePath, prepared, auth: { authorization: `Bearer ${device.token}` } };
  }

  /** History dated relative to the real clock, since the routes use it. */
  function realHistory(storePath: string, count: number): void {
    const now = Date.now();
    for (let index = 0; index < count; index += 1) {
      decide(storePath, "sent", new Date(now - (count - index) * DAY));
    }
  }

  it("lists an offer, accepts it into a grant, lists the grant, and revokes it", async () => {
    const { app, auth, storePath } = setup();
    realHistory(storePath, 20);
    const offers = (await app.inject({ method: "GET", url: "/autonomy/offers", headers: auth })).json() as { recipientKey: string; evidence: string }[];
    expect(offers.map((offer) => offer.recipientKey)).toEqual([WEI_KEY]);
    expect(offers[0].evidence).toMatch(/May I answer Wei myself\?/);

    const key = encodeURIComponent(WEI_KEY);
    const accepted = await app.inject({ method: "POST", url: `/autonomy/offers/${key}/accept`, headers: auth });
    expect(accepted.statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: `/autonomy/offers/${key}/accept`, headers: auth })).statusCode).toBe(404);
    const grants = (await app.inject({ method: "GET", url: "/autonomy/grants", headers: auth })).json() as { recipientKey: string }[];
    expect(grants.map((grant) => grant.recipientKey)).toEqual([WEI_KEY]);

    const revoked = await app.inject({ method: "POST", url: `/autonomy/grants/${key}/revoke`, headers: auth });
    expect(revoked.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/autonomy/grants", headers: auth })).json()).toEqual([]);
    expect((await app.inject({ method: "POST", url: `/autonomy/grants/${key}/revoke`, headers: auth })).statusCode).toBe(404);
    await app.close();
  });

  it("declines an offer (204) and it stops being offered", async () => {
    const { app, auth, storePath } = setup();
    realHistory(storePath, 20);
    const key = encodeURIComponent(WEI_KEY);
    expect((await app.inject({ method: "POST", url: `/autonomy/offers/${key}/decline`, headers: auth })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/autonomy/offers", headers: auth })).json()).toEqual([]);
    expect((await app.inject({ method: "POST", url: `/autonomy/offers/${key}/decline`, headers: auth })).statusCode).toBe(404);
    await app.close();
  });

  it("reads and writes the undo window, refusing 0 without confirmation", async () => {
    const { app, auth } = setup();
    expect((await app.inject({ method: "GET", url: "/settings/autonomy", headers: auth })).json()).toEqual({ holdSeconds: 30 });
    expect((await app.inject({ method: "PUT", url: "/settings/autonomy", headers: auth, payload: { holdSeconds: 0 } })).statusCode).toBe(400);
    const off = await app.inject({ method: "PUT", url: "/settings/autonomy", headers: auth, payload: { holdSeconds: 0, confirmNoHold: true } });
    expect(off.json()).toEqual({ holdSeconds: 0 });
    await app.close();
  });

  it("a held send shows in /autonomous-sends (not in pending or /scheduled-sends); Stop returns it to Waiting on you", async () => {
    const { app, auth, prepared } = setup({}, (storePath) => {
      realHistory(storePath, 20);
      acceptAutonomyOffer(storePath, PASSPHRASE, WEI_KEY);
      const id = appendReply(storePath);
      holdAutonomousSend(storePath, PASSPHRASE, id, 3600);
      return id;
    });
    const draftId = prepared!;

    const live = (await app.inject({ method: "GET", url: "/autonomous-sends", headers: auth })).json() as { draftId: string; autonomous: boolean; draft: { id: string } }[];
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ draftId, autonomous: true, draft: { id: draftId } });
    expect((await app.inject({ method: "GET", url: "/scheduled-sends", headers: auth })).json()).toEqual([]);
    const pending = (await app.inject({ method: "GET", url: "/drafts?outcome=pending", headers: auth })).json() as { id: string }[];
    expect(pending.map((draft) => draft.id)).not.toContain(draftId);

    const stopped = await app.inject({ method: "POST", url: `/autonomous-sends/${draftId}/stop`, headers: auth });
    expect(stopped.statusCode).toBe(200);
    expect((stopped.json() as { draft: { id: string; outcome: null } }).draft).toMatchObject({ id: draftId, outcome: null });
    const after = (await app.inject({ method: "GET", url: "/drafts?outcome=pending", headers: auth })).json() as { id: string }[];
    expect(after.map((draft) => draft.id)).toContain(draftId);
    expect((await app.inject({ method: "POST", url: `/autonomous-sends/${draftId}/stop`, headers: auth })).statusCode).toBe(404);
    await app.close();
  });

  it("Edit converts the held send into an editable draft the owner then sends as their own edit", async () => {
    const { adapter, requests } = recordingAdapter();
    const { app, auth, storePath } = setup({ channelAdapters: [adapter] });
    realHistory(storePath, 20);
    acceptAutonomyOffer(storePath, PASSPHRASE, WEI_KEY);
    const draftId = appendReply(storePath);
    holdAutonomousSend(storePath, PASSPHRASE, draftId, 3600);

    const edited = await app.inject({ method: "POST", url: `/autonomous-sends/${draftId}/edit`, headers: auth });
    expect(edited.statusCode).toBe(200);
    expect((edited.json() as { draft: { draftText: string } }).draft.draftText).toBe("the runbook is on the wiki");
    expect(requests).toEqual([]);
    const sent = await app.inject({ method: "POST", url: `/drafts/${draftId}/outcome`, headers: auth, payload: { outcome: "edited", sentText: "the runbook moved — it's in Confluence now" } });
    expect(sent.statusCode).toBe(200);
    expect(requests.map((request) => request.text)).toEqual(["the runbook moved — it's in Confluence now"]);
    await app.close();
  });

  it("revoking a grant also stops a reply to that person still inside its window", async () => {
    const { app, auth, storePath } = setup();
    realHistory(storePath, 20);
    acceptAutonomyOffer(storePath, PASSPHRASE, WEI_KEY);
    const draftId = appendReply(storePath);
    holdAutonomousSend(storePath, PASSPHRASE, draftId, 3600);
    const revoked = await app.inject({ method: "POST", url: `/autonomy/grants/${encodeURIComponent(WEI_KEY)}/revoke`, headers: auth });
    expect((revoked.json() as { stoppedDraftIds: string[] }).stoppedDraftIds).toEqual([draftId]);
    expect((await app.inject({ method: "GET", url: "/autonomous-sends", headers: auth })).json()).toEqual([]);
    await app.close();
  });

  it("announceNewDraft holds a granted reply and tells the owner it is about to go; anything else is announced as waiting", () => {
    const { deps, storePath } = setup();
    realHistory(storePath, 20);
    acceptAutonomyOffer(storePath, PASSPHRASE, WEI_KEY);
    const published: string[] = [];
    const hub = { publish: (id: string) => published.push(id) } as unknown as DraftReadyHub;
    const runner = new ScheduledSendRunner({ storePath, passphrase: PASSPHRASE, channelAdapters: () => [] });
    const reply = appendReply(storePath);
    const owner = appendReply(storePath, { provenance: { origin: "owner" } });
    expect(announceNewDraft(deps, hub, runner, reply).held).toBe(true);
    expect(announceNewDraft(deps, hub, runner, owner)).toEqual({ held: false, reason: "not_a_reply" });
    runner.stop();
    expect(published).toEqual([reply, owner]);
  });
});
