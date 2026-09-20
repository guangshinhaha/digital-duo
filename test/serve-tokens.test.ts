import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDir } from "./helpers/temp-dir.js";
import {
  AskTokenNotFoundError,
  createAskToken,
  createDeviceToken,
  DeviceTokenNotFoundError,
  listAskTokens,
  listDeviceTokens,
  revokeAskToken,
  revokeDeviceToken,
  touchLastSeen,
  verifyAskToken,
  verifyDeviceToken,
} from "../src/serve/tokens.js";
import { createEncryptedStore } from "../src/store/store.js";

const tempDir = useTempDir();
const PASSPHRASE = "pw";

function initStore(): string {
  const storePath = join(tempDir(), "data", "duo.db");
  createEncryptedStore(storePath, PASSPHRASE);
  return storePath;
}

describe("device tokens (client-tech-design.md Part 2)", () => {
  it("mints a token that verifies, and never stores the raw token", () => {
    const storePath = initStore();
    const paired = createDeviceToken(storePath, PASSPHRASE, "iPhone");

    const verified = verifyDeviceToken(storePath, PASSPHRASE, paired.token);
    expect(verified?.id).toBe(paired.id);
    expect(verified?.name).toBe("iPhone");

    const listed = listDeviceTokens(storePath, PASSPHRASE);
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(paired.token);
  });

  it("rejects an unknown token", () => {
    const storePath = initStore();
    expect(verifyDeviceToken(storePath, PASSPHRASE, "not-a-real-token")).toBeUndefined();
  });

  it("rejects a revoked token immediately", () => {
    const storePath = initStore();
    const paired = createDeviceToken(storePath, PASSPHRASE, "iPhone");
    revokeDeviceToken(storePath, PASSPHRASE, paired.id);
    expect(verifyDeviceToken(storePath, PASSPHRASE, paired.token)).toBeUndefined();
  });

  it("revoking an already-revoked device is a no-op, not an error", () => {
    const storePath = initStore();
    const paired = createDeviceToken(storePath, PASSPHRASE, "iPhone");
    revokeDeviceToken(storePath, PASSPHRASE, paired.id);
    expect(() => revokeDeviceToken(storePath, PASSPHRASE, paired.id)).not.toThrow();
  });

  it("revoking an unknown device id fails loudly, naming it", () => {
    const storePath = initStore();
    expect(() => revokeDeviceToken(storePath, PASSPHRASE, "not-a-real-id")).toThrow(DeviceTokenNotFoundError);
  });

  it("touchLastSeen updates last_seen_at without touching the token hash or revocation", () => {
    const storePath = initStore();
    const paired = createDeviceToken(storePath, PASSPHRASE, "iPhone");
    expect(listDeviceTokens(storePath, PASSPHRASE)[0].lastSeenAt).toBeNull();

    touchLastSeen(storePath, PASSPHRASE, paired.id);

    const after = listDeviceTokens(storePath, PASSPHRASE)[0];
    expect(after.lastSeenAt).not.toBeNull();
    expect(verifyDeviceToken(storePath, PASSPHRASE, paired.token)?.id).toBe(paired.id);
  });

  it("lists devices oldest first", () => {
    const storePath = initStore();
    const first = createDeviceToken(storePath, PASSPHRASE, "Mac");
    const second = createDeviceToken(storePath, PASSPHRASE, "iPhone");
    expect(listDeviceTokens(storePath, PASSPHRASE).map((d) => d.id)).toEqual([first.id, second.id]);
  });
});

describe("ask links (issue #158)", () => {
  it("mints an ask token that verifies, and never stores the raw token", () => {
    const storePath = initStore();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const minted = createAskToken(storePath, PASSPHRASE, "Sam", expiresAt);

    const verified = verifyAskToken(storePath, PASSPHRASE, minted.token);
    expect(verified?.id).toBe(minted.id);
    expect(verified?.name).toBe("Sam");
    expect(verified?.expiresAt).toBe(expiresAt);

    const listed = listAskTokens(storePath, PASSPHRASE);
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(minted.token);
  });

  it("rejects an unknown ask token", () => {
    const storePath = initStore();
    expect(verifyAskToken(storePath, PASSPHRASE, "not-a-real-token")).toBeUndefined();
  });

  it("rejects a revoked ask token immediately", () => {
    const storePath = initStore();
    const minted = createAskToken(storePath, PASSPHRASE, "Sam", new Date(Date.now() + 60 * 60 * 1000).toISOString());
    revokeAskToken(storePath, PASSPHRASE, minted.id);
    expect(verifyAskToken(storePath, PASSPHRASE, minted.token)).toBeUndefined();
  });

  it("rejects an expired ask token and never renews it", () => {
    const storePath = initStore();
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const minted = createAskToken(storePath, PASSPHRASE, "Sam", past);

    expect(verifyAskToken(storePath, PASSPHRASE, minted.token)).toBeUndefined();

    // "Not silently renewed": the original expiry is still what the store
    // holds, and a second verification still refuses.
    const listed = listAskTokens(storePath, PASSPHRASE);
    expect(listed).toHaveLength(1);
    expect(listed[0].expiresAt).toBe(past);
    expect(verifyAskToken(storePath, PASSPHRASE, minted.token)).toBeUndefined();
  });

  it("minting an ask token creates no device token", () => {
    const storePath = initStore();
    const minted = createAskToken(storePath, PASSPHRASE, "Sam", new Date(Date.now() + 60 * 60 * 1000).toISOString());

    expect(listDeviceTokens(storePath, PASSPHRASE)).toEqual([]);
    expect(verifyDeviceToken(storePath, PASSPHRASE, minted.token)).toBeUndefined();
  });

  it("revoking an already-revoked ask link is a no-op, not an error", () => {
    const storePath = initStore();
    const minted = createAskToken(storePath, PASSPHRASE, "Sam", new Date(Date.now() + 60 * 60 * 1000).toISOString());
    revokeAskToken(storePath, PASSPHRASE, minted.id);
    expect(() => revokeAskToken(storePath, PASSPHRASE, minted.id)).not.toThrow();
  });

  it("revoking an unknown ask-link id fails loudly, naming it", () => {
    const storePath = initStore();
    expect(() => revokeAskToken(storePath, PASSPHRASE, "not-a-real-id")).toThrow(AskTokenNotFoundError);
    expect(() => revokeAskToken(storePath, PASSPHRASE, "not-a-real-id")).toThrow(/not-a-real-id/);
  });

  it("lists ask links oldest first", () => {
    const storePath = initStore();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const first = createAskToken(storePath, PASSPHRASE, "Sam", expiresAt);
    const second = createAskToken(storePath, PASSPHRASE, "Rae", expiresAt);
    expect(listAskTokens(storePath, PASSPHRASE).map((l) => l.id)).toEqual([first.id, second.id]);
  });
});
