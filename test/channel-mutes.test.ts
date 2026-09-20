import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDir } from "./helpers/temp-dir.js";
import {
  InvalidMuteKeyError,
  isChannelMuted,
  isThreadMuted,
  muteChannel,
  muteThread,
  readMutedChannels,
  readMutedPolicy,
  unmuteChannel,
  unmuteThread,
} from "../src/drafting/channel-mutes.js";

const tempDir = useTempDir();

function duoDir(): string {
  return join(tempDir(), "duo");
}

describe("channel mutes — visible and reversible (#47 AC3)", () => {
  it("starts with nothing muted", () => {
    expect(readMutedChannels(duoDir())).toEqual([]);
    expect(isChannelMuted(duoDir(), "#general")).toBe(false);
  });

  it("mutes a channel, and the setting is visible in the file's own list", () => {
    const dir = duoDir();
    const channels = muteChannel(dir, "#eng-support");
    expect(channels).toEqual(["#eng-support"]);
    expect(isChannelMuted(dir, "#eng-support")).toBe(true);
    expect(readMutedChannels(dir)).toEqual(["#eng-support"]);
  });

  it("is idempotent — muting an already-muted channel changes nothing", () => {
    const dir = duoDir();
    muteChannel(dir, "#eng-support");
    const channels = muteChannel(dir, "#eng-support");
    expect(channels).toEqual(["#eng-support"]);
  });

  it("matches case-insensitively", () => {
    const dir = duoDir();
    muteChannel(dir, "#Eng-Support");
    expect(isChannelMuted(dir, "#eng-support")).toBe(true);
  });

  it("unmutes — reversible, and reports honestly when there was nothing to reverse", () => {
    const dir = duoDir();
    muteChannel(dir, "#eng-support");
    const result = unmuteChannel(dir, "#eng-support");
    expect(result.wasMuted).toBe(true);
    expect(result.channels).toEqual([]);
    expect(isChannelMuted(dir, "#eng-support")).toBe(false);

    const secondResult = unmuteChannel(dir, "#eng-support");
    expect(secondResult.wasMuted).toBe(false);
  });

  it("leaves other channels muted when one is unmuted", () => {
    const dir = duoDir();
    muteChannel(dir, "#eng-support");
    muteChannel(dir, "#hr-questions");
    unmuteChannel(dir, "#eng-support");
    expect(readMutedChannels(dir)).toEqual(["#hr-questions"]);
  });
});

describe("thread-scoped mutes — the same one store, scope below channel level (#172)", () => {
  it("mutes a thread within a channel without muting the channel", () => {
    const dir = duoDir();
    const entries = muteThread(dir, "#eng-support", "C0123456789.1660000000");
    expect(entries).toEqual(["#eng-support/C0123456789.1660000000"]);
    expect(isThreadMuted(dir, "#eng-support", "C0123456789.1660000000")).toBe(true);
    expect(isChannelMuted(dir, "#eng-support")).toBe(false);
    expect(isThreadMuted(dir, "#eng-support", "C9999999999.1660000001")).toBe(false);
  });

  it("matches case-insensitively, exactly like channel mutes", () => {
    const dir = duoDir();
    muteThread(dir, "#Eng-Support", "C0123456789.1660000000");
    expect(isThreadMuted(dir, "#eng-support", "c0123456789.1660000000")).toBe(true);
  });

  it("is idempotent — re-muting the same thread changes nothing", () => {
    const dir = duoDir();
    muteThread(dir, "#eng-support", "C0123456789.1660000000");
    expect(muteThread(dir, "#eng-support", "C0123456789.1660000000")).toEqual(["#eng-support/C0123456789.1660000000"]);
  });

  it("unmutes a thread reversibly and honestly, leaving channel mutes alone", () => {
    const dir = duoDir();
    muteChannel(dir, "#general");
    muteThread(dir, "#eng-support", "C0123456789.1660000000");

    const result = unmuteThread(dir, "#eng-support", "C0123456789.1660000000");
    expect(result.wasMuted).toBe(true);
    expect(isThreadMuted(dir, "#eng-support", "C0123456789.1660000000")).toBe(false);
    expect(readMutedChannels(dir)).toEqual(["#general"]);

    const second = unmuteThread(dir, "#eng-support", "C0123456789.1660000000");
    expect(second.wasMuted).toBe(false);
  });

  it("readMutedPolicy splits the one store by scope: channel entries and thread entries", () => {
    const dir = duoDir();
    muteChannel(dir, "#general");
    muteThread(dir, "#eng-support", "C0123456789.1660000000");
    expect(readMutedPolicy(dir)).toEqual({
      muted: ["#general"],
      mutedThreads: [{ channel: "#eng-support", threadId: "C0123456789.1660000000" }],
    });
  });

  it("a store from before threads existed reads back with no threads — the file shape never changed", () => {
    const dir = duoDir();
    muteChannel(dir, "#eng-support");
    expect(readMutedPolicy(dir)).toEqual({ muted: ["#eng-support"], mutedThreads: [] });
  });

  it("refuses \"/\" in either part — the separator scopes a thread within a channel, so it cannot also be data", () => {
    const dir = duoDir();
    expect(() => muteThread(dir, "#eng/support", "C0123456789.1660000000")).toThrow(InvalidMuteKeyError);
    expect(() => muteThread(dir, "#eng-support", "C012/456789")).toThrow(InvalidMuteKeyError);
    expect(readMutedChannels(dir)).toEqual([]);
  });
});
