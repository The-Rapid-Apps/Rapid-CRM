/**
 * Developer-issued credentials for the identify API, generated from the app's
 * page instead of an `IDENTIFY_APP_*` env pair and a deploy.
 *
 * The contract a developer gets is the pair every app→platform call already
 * uses: a public **app id** (`App.id`, sent as `X-App-Id`) and a secret
 * **api key** (`X-App-Api-Key`).
 *
 * Three properties are load-bearing:
 *
 *   - **The secret is stored twice, for two jobs.** `tokenHash` (SHA-256,
 *     unique) is what authenticates — one indexed lookup that never decrypts
 *     anything. `secretCipher` is the same secret encrypted at rest, kept
 *     because operators need to read a key back long after issuing it. The
 *     guarantee is "a database dump alone is useless": reading a secret needs
 *     the database AND `CREDENTIAL_ENCRYPTION_KEY`. That is deliberately weaker
 *     than write-only hashing, and it is what being able to show the value
 *     again costs.
 *   - **SHA-256, not a slow KDF.** The secret is 32 random bytes, so there is no
 *     low-entropy password to harden against; the cost of bcrypt/argon2 would
 *     buy nothing and would land on every identify request. This is the same
 *     reasoning as `IdentifiedCustomer.apiTokenHash`.
 *   - **The app id is verified against the key, not trusted.** A key is bound to
 *     one app; presenting it with someone else's app id fails, so a leaked key
 *     cannot be aimed at another tenant.
 */
import { createHash, randomBytes } from "node:crypto";
import { prisma } from "../db.server";
import {
  decryptCredential,
  encryptCredential,
} from "../credential-encryption.server";

/**
 * Distinctive leading marker, so a leaked key is recognisable in a log or a
 * repo by a secret scanner rather than looking like any other base64 blob.
 */
const TOKEN_PREFIX = "rpi_";
/** 32 bytes ⇒ 256 bits of entropy; brute force is not a consideration. */
const SECRET_BYTES = 32;
/** How much of the secret the UI may echo back to identify a key. */
const DISPLAY_PREFIX_LENGTH = 12;
/**
 * `lastUsedAt` is a convenience for operators, not an audit record, so it is
 * written at most once a minute per key. Authentication is otherwise a pure
 * read, and a write on every identify call would be the most expensive part of
 * the hot path.
 */
const LAST_USED_THROTTLE_MS = 60_000;

/** `rpi_<43 base64url chars>`. */
export function generateIdentifySecret(): string {
  return `${TOKEN_PREFIX}${randomBytes(SECRET_BYTES).toString("base64url")}`;
}

/** SHA-256 (hex) of a secret — what `identify_api_keys.tokenHash` stores. */
export function hashIdentifySecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export interface CreatedIdentifyApiKey {
  id: string;
  name: string;
  prefix: string;
  last4: string;
  createdAt: Date;
  /** The plaintext. Also stored encrypted, so it can be read back later. */
  secret: string;
}

/**
 * Issue a key for an app. The caller must already have checked that the app
 * belongs to the acting organization — this does not re-scope.
 */
export async function createIdentifyApiKey(params: {
  appId: string;
  name: string;
  createdById: string | null;
}): Promise<CreatedIdentifyApiKey> {
  const secret = generateIdentifySecret();
  const created = await prisma.identifyApiKey.create({
    data: {
      appId: params.appId,
      name: params.name,
      tokenHash: hashIdentifySecret(secret),
      secretCipher: encryptCredential(secret),
      prefix: secret.slice(0, DISPLAY_PREFIX_LENGTH),
      last4: secret.slice(-4),
      createdById: params.createdById,
    },
    select: { id: true, name: true, prefix: true, last4: true, createdAt: true },
  });
  return { ...created, secret };
}

/** Every key ever issued for an app, live first, newest first. */
export async function listIdentifyApiKeys(appId: string) {
  const keys = await prisma.identifyApiKey.findMany({
    where: { appId },
    orderBy: [{ revokedAt: "asc" }, { createdAt: "desc" }],
    select: {
      id: true,
      name: true,
      prefix: true,
      last4: true,
      lastUsedAt: true,
      revokedAt: true,
      createdAt: true,
      // Whether it CAN be revealed, never the ciphertext itself — the list is
      // sent to the browser, and a secret nobody asked to see should not ride
      // along with it.
      secretCipher: true,
      createdBy: { select: { email: true, name: true } },
    },
  });
  return keys.map(({ secretCipher, createdBy, ...key }) => ({
    ...key,
    revoked: key.revokedAt !== null,
    canReveal: secretCipher !== null,
    createdByLabel: createdBy?.name ?? createdBy?.email ?? null,
  }));
}

/**
 * The plaintext secret of one key, for showing it back to an operator.
 *
 * Scoped by `appId` as well as id, so a forged form field cannot read another
 * app's secret. Returns null for a revoked key and for one issued before
 * secrets were stored — those exist only as a hash and can only be rotated.
 *
 * Deliberately a separate call rather than part of `listIdentifyApiKeys`: this
 * way a secret crosses the wire only when someone explicitly asks to see it,
 * instead of being embedded in every render of the page.
 */
export async function revealIdentifyApiKey(params: {
  id: string;
  appId: string;
}): Promise<string | null> {
  const key = await prisma.identifyApiKey.findFirst({
    where: { id: params.id, appId: params.appId, revokedAt: null },
    select: { secretCipher: true },
  });
  if (!key?.secretCipher) return null;
  try {
    return decryptCredential(key.secretCipher);
  } catch {
    // Encryption key rotated without re-encrypting: the key still authenticates
    // (that runs off the hash), it just cannot be displayed.
    return null;
  }
}

/**
 * Revoke a key. Scoped by `appId` as well as id so a forged form field cannot
 * revoke another app's key. Idempotent: revoking an already-revoked key is a
 * no-op rather than an error.
 */
export async function revokeIdentifyApiKey(params: {
  id: string;
  appId: string;
}): Promise<boolean> {
  const result = await prisma.identifyApiKey.updateMany({
    where: { id: params.id, appId: params.appId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count > 0;
}

/**
 * Fire-and-forget: a failed bookkeeping write must never fail a request that
 * authenticated correctly.
 */
function touchLastUsed(id: string, lastUsedAt: Date | null): void {
  if (
    lastUsedAt &&
    Date.now() - lastUsedAt.getTime() < LAST_USED_THROTTLE_MS
  ) {
    return;
  }
  void prisma.identifyApiKey
    .update({ where: { id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});
}

/**
 * Resolve a presented `(appId, secret)` pair to the authenticated app id, or
 * null.
 *
 * One indexed lookup on the hash — no scan, and no comparison of the secret
 * itself, because finding the row IS the comparison. Rejects a revoked key, a
 * key belonging to a different app than the one presented, and a key whose app
 * is disabled/removed (matching `requireApiApp`, so disabling an app closes
 * every surface at once).
 */
/**
 * The app a generated key belongs to, from the secret alone.
 *
 * Separate from {@link resolveIdentifyApiKey} because the wider platform API
 * treats `X-App-Id` as optional and verifies it only when present, while
 * identify requires it. Both end up in the same place: find the row by the hash
 * of the secret, reject it if revoked or its app is disabled.
 */
export async function appIdForIdentifySecret(
  secret: string,
): Promise<string | null> {
  if (!secret || !secret.startsWith(TOKEN_PREFIX)) return null;

  const key = await prisma.identifyApiKey.findUnique({
    where: { tokenHash: hashIdentifySecret(secret) },
    select: {
      id: true,
      appId: true,
      revokedAt: true,
      lastUsedAt: true,
      app: {
        select: { enabled: true, removed: true, scheduledForDeletionAt: true },
      },
    },
  });

  if (!key || key.revokedAt !== null) return null;
  if (!key.app.enabled || key.app.removed || key.app.scheduledForDeletionAt) {
    return null;
  }

  touchLastUsed(key.id, key.lastUsedAt);
  return key.appId;
}

export async function resolveIdentifyApiKey(
  appId: string,
  secret: string,
): Promise<string | null> {
  if (!appId || !secret) return null;
  /*
    Every issued key starts with TOKEN_PREFIX, so anything else cannot be in the
    table and is rejected without a query. This matters because authentication
    runs BEFORE the identify rate limiter: without it, unauthenticated scanner
    traffic would cost one SELECT per request. Rejecting on a public, structural
    property leaks nothing a caller does not already know.
  */
  if (!secret.startsWith(TOKEN_PREFIX)) return null;

  const key = await prisma.identifyApiKey.findUnique({
    where: { tokenHash: hashIdentifySecret(secret) },
    select: {
      id: true,
      appId: true,
      revokedAt: true,
      lastUsedAt: true,
      app: {
        select: { enabled: true, removed: true, scheduledForDeletionAt: true },
      },
    },
  });

  if (!key || key.revokedAt !== null) return null;
  if (key.appId !== appId) return null;
  if (!key.app.enabled || key.app.removed || key.app.scheduledForDeletionAt) {
    return null;
  }

  touchLastUsed(key.id, key.lastUsedAt);
  return key.appId;
}
