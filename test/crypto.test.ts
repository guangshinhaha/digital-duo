import { describe, expect, it } from "vitest";
import { decrypt, DecryptionError, encrypt } from "../src/store/crypto.js";

describe("encrypt/decrypt", () => {
  it("round-trips plaintext under the right passphrase", () => {
    const plaintext = Buffer.from("some sqlite bytes, in spirit");
    const encrypted = encrypt(plaintext, "correct-passphrase");
    expect(decrypt(encrypted, "correct-passphrase")).toEqual(plaintext);
  });

  it("never emits the plaintext as a substring of the ciphertext", () => {
    const plaintext = Buffer.from("SQLite format 3\0 secret government content");
    const encrypted = encrypt(plaintext, "correct-passphrase");
    expect(encrypted.includes(plaintext)).toBe(false);
  });

  it("produces different ciphertext for the same plaintext and passphrase (random salt/iv per call)", () => {
    const plaintext = Buffer.from("same bytes every time");
    const a = encrypt(plaintext, "pw");
    const b = encrypt(plaintext, "pw");
    expect(a.equals(b)).toBe(false);
  });

  it("throws DecryptionError, not a raw crypto exception, on the wrong passphrase", () => {
    const encrypted = encrypt(Buffer.from("hello"), "right");
    expect(() => decrypt(encrypted, "wrong")).toThrow(DecryptionError);
  });

  it("throws DecryptionError on a tampered ciphertext (auth tag catches it)", () => {
    const encrypted = encrypt(Buffer.from("hello"), "pw");
    const tampered = Buffer.from(encrypted);
    tampered[tampered.length - 1] ^= 0xff;
    expect(() => decrypt(tampered, "pw")).toThrow(DecryptionError);
  });

  it("throws DecryptionError on a truncated buffer instead of throwing an out-of-range error", () => {
    expect(() => decrypt(Buffer.from([1, 2, 3]), "pw")).toThrow(DecryptionError);
  });
});
