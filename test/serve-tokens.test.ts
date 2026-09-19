import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDir } from "./helpers/temp-dir.js";
import { createDeviceToken, DeviceTokenNotFoundError, listDeviceTokens, revokeDeviceToken, touchLastSeen, verifyDeviceToken } from "../src/serve/tokens.js";
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
