import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDir } from "./helpers/temp-dir.js";
import { isChannelMuted, muteChannel, readMutedChannels, unmuteChannel } from "../src/drafting/channel-mutes.js";

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
