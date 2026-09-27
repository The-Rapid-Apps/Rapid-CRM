import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { env } from "./env.server";

const ENVELOPE_VERSION = "v1";
const IV_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;
const INVALID_ENVELOPE_MESSAGE = "Invalid credential envelope";
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

function deriveKey(keyMaterial: string): Buffer {
  if (!keyMaterial) {
    throw new Error("Credential encryption key material is required");
  }
  return createHash("sha256").update(keyMaterial, "utf8").digest();
}

function decodeBase64Url(value: string, allowEmpty = false): Buffer {
  if ((!allowEmpty && value.length === 0) || !BASE64URL_PATTERN.test(value)) {
    throw new Error(INVALID_ENVELOPE_MESSAGE);
  }

  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new Error(INVALID_ENVELOPE_MESSAGE);
  }
  return decoded;
}

/**
 * Encrypt a credential using a fresh 96-bit IV and a key derived from the
 * configured master key. The versioned envelope supports future key/format
 * migrations without storing plaintext credentials.
 */
export function encryptCredential(
  plaintext: string,
  keyMaterial: string = env.CREDENTIAL_ENCRYPTION_KEY,
): string {
  const key = deriveKey(keyMaterial);
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, {
    authTagLength: AUTH_TAG_LENGTH_BYTES,
  });
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    ENVELOPE_VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

/**
 * Decrypt a v1 credential envelope. Every malformed envelope, authentication
 * failure, wrong key, or invalid UTF-8 payload fails with the same error.
 */
export function decryptCredential(
  envelope: string,
  keyMaterial: string = env.CREDENTIAL_ENCRYPTION_KEY,
): string {
  try {
    const parts = envelope.split(":");
    if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) {
      throw new Error(INVALID_ENVELOPE_MESSAGE);
    }

    const iv = decodeBase64Url(parts[1]);
    const tag = decodeBase64Url(parts[2]);
    const ciphertext = decodeBase64Url(parts[3], true);
    if (iv.length !== IV_LENGTH_BYTES || tag.length !== AUTH_TAG_LENGTH_BYTES) {
      throw new Error(INVALID_ENVELOPE_MESSAGE);
    }

    const decipher = createDecipheriv(
      "aes-256-gcm",
      deriveKey(keyMaterial),
      iv,
      { authTagLength: AUTH_TAG_LENGTH_BYTES },
    );
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
  } catch {
    throw new Error(INVALID_ENVELOPE_MESSAGE);
  }
}
