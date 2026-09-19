import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const ALGORITHM = "aes-256-gcm";

/** Thrown when a ciphertext fails to decrypt: wrong passphrase, or the bytes were corrupted or truncated. */
export class DecryptionError extends Error {
  constructor(cause: unknown) {
    super(`Failed to decrypt: wrong passphrase, or the data is corrupted (${cause instanceof Error ? cause.message : String(cause)})`);
    this.name = "DecryptionError";
  }
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LENGTH);
}

/**
 * Encrypts `plaintext` under `passphrase` using AES-256-GCM with a random
 * salt and IV per call. The salt, IV, and auth tag travel alongside the
 * ciphertext in one self-contained buffer (salt | iv | tag | ciphertext), so
 * decrypt() needs nothing beyond that buffer and the passphrase.
 */
export function encrypt(plaintext: Buffer, passphrase: string): Buffer {
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, authTag, ciphertext]);
}

/**
 * Reverses encrypt(). Throws DecryptionError (never a raw crypto exception)
 * when the passphrase is wrong or the buffer was tampered with or
 * truncated — GCM's auth tag check makes both cases detectable rather than
 * silently returning garbage.
 */
export function decrypt(encrypted: Buffer, passphrase: string): Buffer {
  if (encrypted.length < SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new DecryptionError("ciphertext too short to contain salt, iv, and auth tag");
  }
  const salt = encrypted.subarray(0, SALT_LENGTH);
  const iv = encrypted.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const authTag = encrypted.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = encrypted.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
  try {
    const key = deriveKey(passphrase, salt);
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (error) {
    throw new DecryptionError(error);
  }
}
