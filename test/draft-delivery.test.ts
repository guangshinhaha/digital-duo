import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDir } from "./helpers/temp-dir.js";
import { listCorrectionCandidates } from "../src/corrections/queue.js";
import { muteChannel, unmuteChannel } from "../src/drafting/channel-mutes.js";
import { appendDraft, getDraft, type DraftProvenance } from "../src/drafting/draft-log.js";
import { describeChannels, recordOutcomeAndDeliver, type ChannelAdapter, type ChannelDeliveryRequest } from "../src/drafting/delivery.js";
import { createEncryptedStore, withDatabase, type Database } from "../src/store/store.js";

const tempDir = useTempDir();
const PASSPHRASE = "pw";

function initStore(): string {
  const storePath = join(tempDir(), "data", "duo.db");
  createEncryptedStore(storePath, PASSPHRASE);
  return storePath;
}

const CHANNEL: DraftProvenance = {
  origin: "channel",
  channelKind: "slack",
  askerRef: "directory.json#sam",
  threadId: "C0123456789.1660000000",
  permalink: "https://example.slack.com/archives/C0123456789/p1660000000000000",
};

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

describe("recordOutcomeAndDeliver — the delivery seam (#170)", () => {
  it("a sent channel draft reaches its adapter with the final text and records delivered", async () => {
    const storePath = initStore();
    const draftId = appendChannelDraft(storePath);
    const requests: ChannelDeliveryRequest[] = [];
    const slack: ChannelAdapter = {
      channelKind: "slack",
      label: "a channel",
      async status() {
        return { state: "connected", lastActivityAt: null };
      },
      async deliver(request) {
        requests.push(request);
      },
    };

    await recordOutcomeAndDeliver(storePath, PASSPHRASE, draftId, "sent", undefined, { channelAdapters: [slack] });

    expect(requests).toEqual([
      {
        askerRef: "directory.json#sam",
        threadId: "C0123456789.1660000000",
        permalink: "https://example.slack.com/archives/C0123456789/p1660000000000000",
        text: "point them at the runbook",
      },
    ]);
    expect(getDraft(storePath, PASSPHRASE, draftId)?.delivery).toEqual({ state: "delivered" });
  });

  it("an edited outcome delivers the edited text, not the original draft", async () => {
    const storePath = initStore();
    const draftId = appendChannelDraft(storePath, "the original draft text");
    const requests: ChannelDeliveryRequest[] = [];
    const slack: ChannelAdapter = {
      channelKind: "slack",
      label: "a channel",
      async status() {
        return { state: "connected", lastActivityAt: null };
      },
      async deliver(request) {
        requests.push(request);
      },
    };

    await recordOutcomeAndDeliver(storePath, PASSPHRASE, draftId, "edited", "the edited text they actually sent", { channelAdapters: [slack] });

    expect(requests.map((request) => request.text)).toEqual(["the edited text they actually sent"]);
    expect(getDraft(storePath, PASSPHRASE, draftId)?.delivery).toEqual({ state: "delivered" });
  });

  it("delivery state is pending while the adapter is in flight — recorded at handoff, not only at settlement", async () => {
    const storePath = initStore();
    const draftId = appendChannelDraft(storePath);
    let seenInFlight: unknown;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slack: ChannelAdapter = {
      channelKind: "slack",
      label: "a channel",
      async status() {
        return { state: "connected", lastActivityAt: null };
      },
      async deliver() {
        // The draft is readable *from inside the adapter*: pending was
        // written before deliver() was ever called.
        seenInFlight = getDraft(storePath, PASSPHRASE, draftId)?.delivery;
        await gate;
      },
    };

    const call = recordOutcomeAndDeliver(storePath, PASSPHRASE, draftId, "sent", undefined, { channelAdapters: [slack] });
    release();
    await call;

    expect(seenInFlight).toEqual({ state: "pending" });
    expect(getDraft(storePath, PASSPHRASE, draftId)?.delivery).toEqual({ state: "delivered" });
  });

  it("a failed delivery is recorded against the draft, never raised as the call's result — the outcome stands", async () => {
    const storePath = initStore();
    const draftId = appendChannelDraft(storePath);
    const failure = new Error("Slack API returned 500");
    const slack: ChannelAdapter = {
      channelKind: "slack",
      label: "a channel",
      async status() {
        return { state: "connected", lastActivityAt: null };
      },
      async deliver() {
        throw failure;
      },
    };

    const result = await recordOutcomeAndDeliver(storePath, PASSPHRASE, draftId, "sent", undefined, { channelAdapters: [slack] });

    // The call resolves normally (sent with no sentText classifies nothing).
    expect(result).toBeUndefined();
    const draft = getDraft(storePath, PASSPHRASE, draftId);
    expect(draft?.outcome).toBe("sent");
    expect(draft?.outcomeRecordedAt).not.toBeNull();
    expect(draft?.delivery).toEqual({ state: "failed", reason: "Slack API returned 500" });
  });

  it("a failed delivery costs nothing on the correction side either: the candidate queued before delivery still stands", async () => {
    const storePath = initStore();
    const draftId = appendChannelDraft(storePath, "alpha beta gamma delta");
    const slack: ChannelAdapter = {
      channelKind: "slack",
      label: "a channel",
      async status() {
        return { state: "connected", lastActivityAt: null };
      },
      async deliver() {
        throw new Error("network unreachable");
      },
    };

    await recordOutcomeAndDeliver(storePath, PASSPHRASE, draftId, "edited", "epsilon zeta eta theta", { channelAdapters: [slack] });

    expect(getDraft(storePath, PASSPHRASE, draftId)?.delivery).toEqual({ state: "failed", reason: "network unreachable" });
    const candidates = listCorrectionCandidates(storePath, PASSPHRASE);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ kind: "substance", draftId, sentText: "epsilon zeta eta theta" });
  });

  it("an owner-asked draft delivers nothing, and that is not an error — no adapter is even consulted", async () => {
    const storePath = initStore();
    const draftId = appendDraft(storePath, PASSPHRASE, {
      question: "what do I think about X?",
      threadContext: null,
      draftText: "a draft",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.8,
      sources: [],
      provenance: { origin: "owner" },
    });
    let deliverCalled = false;
    const slack: ChannelAdapter = {
      channelKind: "slack",
      label: "a channel",
      async status() {
        return { state: "connected", lastActivityAt: null };
      },
      async deliver() {
        deliverCalled = true;
      },
    };

    await recordOutcomeAndDeliver(storePath, PASSPHRASE, draftId, "sent", undefined, { channelAdapters: [slack] });

    expect(deliverCalled).toBe(false);
    const draft = getDraft(storePath, PASSPHRASE, draftId);
    expect(draft?.outcome).toBe("sent");
    expect(draft?.delivery).toBeNull();
  });

  it("a draft of unknown origin (written before provenance existed) delivers nothing and fails nothing", async () => {
    const storePath = initStore();
    const draftId = appendDraft(storePath, PASSPHRASE, {
      question: "legacy",
      threadContext: null,
      draftText: "a",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.8,
      sources: [],
    });

    await recordOutcomeAndDeliver(storePath, PASSPHRASE, draftId, "sent", undefined, { channelAdapters: [] });

    expect(getDraft(storePath, PASSPHRASE, draftId)?.delivery).toBeNull();
  });

  it("a channel kind with no connected adapter records a failure naming the kind — honest, not an error", async () => {
    const storePath = initStore();
    const draftId = appendChannelDraft(storePath);
    let deliverCalled = false;
    const email: ChannelAdapter = {
      channelKind: "email",
      label: "a channel",
      async status() {
        return { state: "connected", lastActivityAt: null };
      },
      async deliver() {
        deliverCalled = true;
      },
    };

    await recordOutcomeAndDeliver(storePath, PASSPHRASE, draftId, "sent", undefined, { channelAdapters: [email] });

    expect(deliverCalled).toBe(false);
    const delivery = getDraft(storePath, PASSPHRASE, draftId)?.delivery;
    expect(delivery).toMatchObject({ state: "failed" });
    if (delivery?.state === "failed") {
      expect(delivery.reason).toContain("slack");
    }
  });

  it("a discarded channel draft delivers nothing — nothing was sent", async () => {
    const storePath = initStore();
    const draftId = appendChannelDraft(storePath);
    let deliverCalled = false;
    const slack: ChannelAdapter = {
      channelKind: "slack",
      label: "a channel",
      async status() {
        return { state: "connected", lastActivityAt: null };
      },
      async deliver() {
        deliverCalled = true;
      },
    };

    await recordOutcomeAndDeliver(storePath, PASSPHRASE, draftId, "discarded", undefined, { channelAdapters: [slack] });

    expect(deliverCalled).toBe(false);
    expect(getDraft(storePath, PASSPHRASE, draftId)?.delivery).toBeNull();
  });

  it("a sent outcome with no final text at all (escalated draft, no sentText) records a failure rather than delivering emptiness", async () => {
    const storePath = initStore();
    const draftId = appendChannelDraft(storePath, null);
    let deliverCalled = false;
    const slack: ChannelAdapter = {
      channelKind: "slack",
      label: "a channel",
      async status() {
        return { state: "connected", lastActivityAt: null };
      },
      async deliver() {
        deliverCalled = true;
      },
    };

    await recordOutcomeAndDeliver(storePath, PASSPHRASE, draftId, "sent", undefined, { channelAdapters: [slack] });

    expect(deliverCalled).toBe(false);
    const delivery = getDraft(storePath, PASSPHRASE, draftId)?.delivery;
    expect(delivery).toMatchObject({ state: "failed" });
  });

  it("an unknown draft id still throws DraftNotFound — nothing is recorded, nothing is delivered", async () => {
    const storePath = initStore();
    await expect(
      recordOutcomeAndDeliver(storePath, PASSPHRASE, "not-a-real-id", "sent", undefined, { channelAdapters: [] }),
    ).rejects.toThrow(/No draft found with id/);
  });

  it("a store from before the delivery columns existed migrates on open: old rows read delivery null, new sends record state", async () => {
    const storePath = initStore();
    // The drafts table exactly as it shipped after #169's provenance
    // migration but before delivery — a real store from an already-running
    // daemon. CREATE TABLE IF NOT EXISTS will not add the columns, so the
    // ALTER path is the only thing standing between this row and
    // "table drafts has no column named delivery_state".
    withDatabase(storePath, PASSPHRASE, true, (db: Database) => {
      db.exec(`
        CREATE TABLE drafts (
          id TEXT PRIMARY KEY,
          question TEXT NOT NULL,
          thread_context TEXT,
          draft_text TEXT,
          escalated INTEGER NOT NULL,
          escalation_reason TEXT,
          confidence_score REAL NOT NULL,
          sources TEXT NOT NULL,
          created_at TEXT NOT NULL,
          outcome TEXT,
          outcome_recorded_at TEXT,
          sent_text TEXT,
          refused INTEGER NOT NULL DEFAULT 0,
          escalation_threshold REAL NOT NULL DEFAULT 0.55,
          provenance TEXT
        ) STRICT
      `);
      db.prepare(
        `INSERT INTO drafts (id, question, thread_context, draft_text, escalated, confidence_score, sources, created_at, refused, escalation_threshold, provenance)
         VALUES ('legacy-1', 'q', NULL, 'a', 0, 0.8, '[]', '2026-01-01T00:00:00.000Z', 0, 0.55, ?)`,
      ).run(JSON.stringify(CHANNEL));
    });

    const legacy = getDraft(storePath, PASSPHRASE, "legacy-1");
    expect(legacy?.provenance).toEqual(CHANNEL);
    expect(legacy?.delivery).toBeNull();

    const requests: ChannelDeliveryRequest[] = [];
    const slack: ChannelAdapter = {
      channelKind: "slack",
      label: "a channel",
      async status() {
        return { state: "connected", lastActivityAt: null };
      },
      async deliver(request) {
        requests.push(request);
      },
    };
    await recordOutcomeAndDeliver(storePath, PASSPHRASE, "legacy-1", "sent", undefined, { channelAdapters: [slack] });
    expect(requests).toHaveLength(1);
    expect(getDraft(storePath, PASSPHRASE, "legacy-1")?.delivery).toEqual({ state: "delivered" });
  });
});

describe("describeChannels — what this duo is reachable through (#171)", () => {
  function adapter(kind: string, label: string, status: () => Promise<{ state: "connected" | "failed"; reason?: string; lastActivityAt: string | null }>): ChannelAdapter {
    return { channelKind: kind, label, status, async deliver() {} };
  }

  it("returns one row per adapter: kind, the adapter's own label, state, last activity, mute state", async () => {
    const duoDir = join(tempDir(), "duo");
    const rows = await describeChannels(
      [
        adapter("slack", "Acme Slack", async () => ({ state: "connected", lastActivityAt: "2026-09-20T10:00:00.000Z" })),
        adapter("email", "Work inbox", async () => ({ state: "connected", lastActivityAt: null })),
      ],
      duoDir,
    );
    expect(rows).toEqual([
      { kind: "slack", label: "Acme Slack", state: "connected", lastActivityAt: "2026-09-20T10:00:00.000Z", muted: false },
      { kind: "email", label: "Work inbox", state: "connected", lastActivityAt: null, muted: false },
    ]);
  });

  it("a broken channel says so, with its adapter's own reason — passed through verbatim, never re-worded", async () => {
    const duoDir = join(tempDir(), "duo");
    const rows = await describeChannels(
      [
        adapter("slack", "Acme Slack", async () => ({
          state: "failed",
          reason: "auth token expired — reconnect where the credentials live",
          lastActivityAt: "2026-09-19T10:00:00.000Z",
        })),
      ],
      duoDir,
    );
    expect(rows).toEqual([
      {
        kind: "slack",
        label: "Acme Slack",
        state: "failed",
        reason: "auth token expired — reconnect where the credentials live",
        lastActivityAt: "2026-09-19T10:00:00.000Z",
        muted: false,
      },
    ]);
  });

  it("a status probe that crashes renders as a broken channel, never a thrown surface — this list is the 'why is it quiet' screen", async () => {
    const duoDir = join(tempDir(), "duo");
    const rows = await describeChannels(
      [
        {
          channelKind: "slack",
          label: "Acme Slack",
          async status() {
            throw new Error("probe timed out");
          },
          async deliver() {},
        },
      ],
      duoDir,
    );
    expect(rows).toEqual([{ kind: "slack", label: "Acme Slack", state: "failed", reason: "probe timed out", lastActivityAt: null, muted: false }]);
  });

  it("mute state comes from the CLI's own store — same file, same case-insensitive match as `duo mentions`", async () => {
    const duoDir = join(tempDir(), "duo");
    const slack = adapter("slack", "Acme Slack", async () => ({ state: "connected", lastActivityAt: null }));

    expect((await describeChannels([slack], duoDir))[0].muted).toBe(false);

    muteChannel(duoDir, "Slack"); // what `duo mentions mute Slack` writes
    expect((await describeChannels([slack], duoDir))[0].muted).toBe(true);

    unmuteChannel(duoDir, "slack");
    expect((await describeChannels([slack], duoDir))[0].muted).toBe(false);
  });

  it("no adapters is an empty list — a duo with no channels is a supported configuration, not an error", async () => {
    expect(await describeChannels([], join(tempDir(), "duo"))).toEqual([]);
  });
});
