import assert from "node:assert/strict";
import test from "node:test";
import {
  decryptCredential,
  encryptCredential,
} from "../app/lib/credential-encryption.server";

const KEY = "credential-encryption-test-key";
const OTHER_KEY = "a-different-credential-encryption-test-key";
const PLAINTEXT = "shpat_plaintext-secret/sentinel:🔒";

function replaceFirstCharacter(value: string): string {
  const replacement = value[0] === "A" ? "B" : "A";
  return `${replacement}${value.slice(1)}`;
}

test("credential encryption round-trips UTF-8 plaintext", () => {
  const envelope = encryptCredential(PLAINTEXT, KEY);

  assert.match(envelope, /^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
  assert.equal(decryptCredential(envelope, KEY), PLAINTEXT);
});

test("encrypting the same credential uses a fresh random IV", () => {
  const first = encryptCredential(PLAINTEXT, KEY);
  const second = encryptCredential(PLAINTEXT, KEY);

  assert.notEqual(first, second);
  assert.notEqual(first.split(":")[1], second.split(":")[1]);
  assert.equal(decryptCredential(first, KEY), PLAINTEXT);
  assert.equal(decryptCredential(second, KEY), PLAINTEXT);
});

test("wrong keys and tampered authenticated data fail closed", () => {
  const envelope = encryptCredential(PLAINTEXT, KEY);
  const [version, iv, tag, ciphertext] = envelope.split(":");

  assert.throws(
    () => decryptCredential(envelope, OTHER_KEY),
    new Error("Invalid credential envelope"),
  );
  assert.throws(
    () =>
      decryptCredential(
        [version, iv, replaceFirstCharacter(tag), ciphertext].join(":"),
        KEY,
      ),
    new Error("Invalid credential envelope"),
  );
  assert.throws(
    () =>
      decryptCredential(
        [version, iv, tag, replaceFirstCharacter(ciphertext)].join(":"),
        KEY,
      ),
    new Error("Invalid credential envelope"),
  );
});

test("malformed and unsupported envelopes fail closed", () => {
  const malformed = [
    "",
    "v1",
    "v1:abc:def",
    "v1:abc:def:ghi:extra",
    "v2:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA:abc",
    "v1:not+base64url:AAAAAAAAAAAAAAAAAAAAAA:abc",
    "v1:AA:AAAAAAAAAAAAAAAAAAAAAA:abc",
    "v1:AAAAAAAAAAAAAAAA:AA:abc",
    "v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA:abc=",
  ];

  for (const envelope of malformed) {
    assert.throws(
      () => decryptCredential(envelope, KEY),
      new Error("Invalid credential envelope"),
      envelope,
    );
  }
});

test("the stored envelope never contains plaintext", () => {
  const envelope = encryptCredential(PLAINTEXT, KEY);

  assert.equal(envelope.includes(PLAINTEXT), false);
  assert.equal(envelope.includes("plaintext-secret"), false);
});
