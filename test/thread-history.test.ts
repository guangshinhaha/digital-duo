import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDir } from "./helpers/temp-dir.js";
import { appendDraft, recordDeliveryOutcome, type DraftProvenance } from "../src/drafting/draft-log.js";
import type { ChannelAdapter, RawThreadMessage } from "../src/drafting/delivery.js";
import { readThreadMessages } from "../src/drafting/thread-history.js";
import { createEncryptedStore } from "../src/store/store.js";

const tempDir = useTempDir();
const PASSPHRASE = "pw";

function initStore(): string {
  const storePath = join(tempDir(), "data", "duo.db");
  createEncryptedStore(storePath, PASSPHRASE);
  return storePath;
}

function threadProvenance(threadId: string, askerRef = "directory.json#sam"): DraftProvenance {
  return { origin: "channel", channelKind: "slack", askerRef, threadId, permalink: null };
}

function appendThreadDraft(storePath: string, threadId: string): string {
  return appendDraft(storePath, PASSPHRASE, {
    question: "how do I get deploy access?",
    threadContext: null,
    draftText: "point them at the runbook",
    escalated: false,
    escalationReason: null,
    confidenceScore: 0.8,
    sources: [],
    provenance: threadProvenance(threadId),
  });
}

function adapterOf(history: ChannelAdapter["history"], channelKind = "slack"): ChannelAdapter {
  return {
    channelKind,
    label: "a channel",
    async status() {
      return { state: "connected", lastActivityAt: null };
    },
    async deliver() {},
    history,
  };
}

const raw = (id: string, at: string, senderRef: string, text: string): RawThreadMessage => ({ id, at, senderRef, text });

describe("readThreadMessages — a bridged chat's surrounding messages (digital-duo#248)", () => {
  it("returns the empty result the client already falls back to when nothing is registered for the channel", async () => {
    const storePath = initStore();
    const messages = await readThreadMessages(storePath, PASSPHRASE, [], "slack", "t1");
    expect(messages).toEqual([]);
  });

  it("returns empty for a channel that has an adapter but no history capability — not every channel can read its own past", async () => {
    const storePath = initStore();
    const adapter = adapterOf(undefined);
    const messages = await readThreadMessages(storePath, PASSPHRASE, [adapter], "slack", "t1");
    expect(messages).toEqual([]);
  });

  it("returns empty, never throws, when the adapter's own read fails", async () => {
    const storePath = initStore();
    const adapter = adapterOf(async () => {
      throw new Error("Slack said no");
    });
    await expect(readThreadMessages(storePath, PASSPHRASE, [adapter], "slack", "t1")).resolves.toEqual([]);
  });

  it("reads a real thread, oldest first, regardless of what order the adapter hands them back in", async () => {
    const storePath = initStore();
    const adapter = adapterOf(async () => [
      raw("m3", "2026-01-01T00:00:03.000Z", "U_sam", "third"),
      raw("m1", "2026-01-01T00:00:01.000Z", "U_sam", "first"),
      raw("m2", "2026-01-01T00:00:02.000Z", "U_sam", "second"),
    ]);
    const messages = await readThreadMessages(storePath, PASSPHRASE, [adapter], "slack", "t1");
    expect(messages.map((m) => m.text)).toEqual(["first", "second", "third"]);
  });

  it("marks a message as the owner's own only when it matches a draft actually delivered to this exact channel and thread", async () => {
    const storePath = initStore();
    const draftId = appendThreadDraft(storePath, "t1");
    recordDeliveryOutcome(storePath, PASSPHRASE, draftId, { state: "delivered", eventId: "m2" });

    const adapter = adapterOf(async () => [
      raw("m1", "2026-01-01T00:00:01.000Z", "U_sam", "the question"),
      raw("m2", "2026-01-01T00:00:02.000Z", "U_owner", "the owner's reply"),
    ]);
    const messages = await readThreadMessages(storePath, PASSPHRASE, [adapter], "slack", "t1");
    expect(messages).toEqual([
      { id: "m1", at: "2026-01-01T00:00:01.000Z", senderRef: "U_sam", text: "the question", fromOwner: false },
      { id: "m2", at: "2026-01-01T00:00:02.000Z", senderRef: "U_owner", text: "the owner's reply", fromOwner: true },
    ]);
  });

  it("never marks a message from a different thread, even one delivered on the same channel with the same event id", async () => {
    const storePath = initStore();
    const elsewhere = appendThreadDraft(storePath, "some-other-thread");
    recordDeliveryOutcome(storePath, PASSPHRASE, elsewhere, { state: "delivered", eventId: "m1" });

    const adapter = adapterOf(async () => [raw("m1", "2026-01-01T00:00:01.000Z", "U_sam", "coincidentally the same id")]);
    const messages = await readThreadMessages(storePath, PASSPHRASE, [adapter], "slack", "t1");
    expect(messages).toEqual([{ id: "m1", at: "2026-01-01T00:00:01.000Z", senderRef: "U_sam", text: "coincidentally the same id", fromOwner: false }]);
  });

  it("never marks a message from a draft that is only pending or failed — only an actual delivery counts", async () => {
    const storePath = initStore();
    const pending = appendThreadDraft(storePath, "t1");
    recordDeliveryOutcome(storePath, PASSPHRASE, pending, { state: "pending" });
    const failed = appendThreadDraft(storePath, "t1");
    recordDeliveryOutcome(storePath, PASSPHRASE, failed, { state: "failed", reason: "timed out" });

    // Neither write above carries an eventId at all, so this is really
    // asserting the read never crashes or false-matches on drafts with no
    // eventId to match against.
    const adapter = adapterOf(async () => [raw("m1", "2026-01-01T00:00:01.000Z", "U_sam", "hi")]);
    const messages = await readThreadMessages(storePath, PASSPHRASE, [adapter], "slack", "t1");
    expect(messages).toEqual([{ id: "m1", at: "2026-01-01T00:00:01.000Z", senderRef: "U_sam", text: "hi", fromOwner: false }]);
  });

  it("a message whose delivered draft carried no eventId (an adapter with nothing to give, or a pre-#247 row) still appears, just unmarked", async () => {
    const storePath = initStore();
    const draftId = appendThreadDraft(storePath, "t1");
    recordDeliveryOutcome(storePath, PASSPHRASE, draftId, { state: "delivered" }); // no eventId

    const adapter = adapterOf(async () => [raw("m1", "2026-01-01T00:00:01.000Z", "U_owner", "the reply that went out")]);
    const messages = await readThreadMessages(storePath, PASSPHRASE, [adapter], "slack", "t1");
    expect(messages).toEqual([{ id: "m1", at: "2026-01-01T00:00:01.000Z", senderRef: "U_owner", text: "the reply that went out", fromOwner: false }]);
  });

  it("matches only the adapter whose channelKind names this thread's channel — a same-shaped thread id on another channel never crosses over", async () => {
    const storePath = initStore();
    const teams = adapterOf(async () => [raw("m1", "2026-01-01T00:00:01.000Z", "U_x", "wrong channel")], "teams");
    const slack = adapterOf(async () => [raw("m1", "2026-01-01T00:00:01.000Z", "U_sam", "right channel")], "slack");
    const messages = await readThreadMessages(storePath, PASSPHRASE, [teams, slack], "slack", "t1");
    expect(messages.map((m) => m.text)).toEqual(["right channel"]);
  });
});
