/**
 * Storage and lookup for the app → platform API key (`App.apiKey`).
 *
 * The key is kept two ways, because it has two jobs that pull in opposite
 * directions:
 *
 *   - **`apiKeyHash`** — SHA-256. Authentication is one indexed lookup on the
 *     hash, so the hot path never needs, and never loads, the plaintext.
 *   - **`apiKeyCipher`** — AES-256-GCM envelope. The key MUST stay recoverable:
 *     it is shown to operators so they can configure their app, which is why
 *     this is encrypted rather than hashed.
 *
 * The honest guarantee is therefore **"a database dump on its own is useless"**:
 * recovering a key needs both the database and `CREDENTIAL_ENCRYPTION_KEY`,
 * which lives only in the environment. That is strictly weaker than the one-way
 * hashing used for identify keys, and it is the strongest option available for a
 * secret that has to be handed back out.
 *
 * ## Migration safety
 *
 * `apiKey` (plaintext) is still written and is still the fallback on every read,
 * so a row the backfill has not reached yet cannot lose authentication. Reads
 * that fall back also repair the row in passing, so traffic alone converges the
 * table. Once `backfill:app-api-keys` reports zero remaining, a follow-up
 * migration drops the plaintext column and the fallbacks go with it.
 */
import { createHash } from "node:crypto";
import type { App } from "../../generated/prisma/client";
import { prisma } from "./db.server";
import {
  decryptCredential,
  encryptCredential,
} from "./credential-encryption.server";

/** SHA-256 (hex) of an api key — what `apps.apiKeyHash` stores. */
export function hashAppApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/**
 * The columns to write for a given plaintext key. Used by creation and by
 * regeneration so the three representations can never drift apart.
 */
export function appApiKeyFields(plaintext: string): {
  apiKey: string;
  apiKeyHash: string;
  apiKeyCipher: string;
} {
  return {
    apiKey: plaintext,
    apiKeyHash: hashAppApiKey(plaintext),
    apiKeyCipher: encryptCredential(plaintext),
  };
}

type KeyBearing = Pick<App, "apiKey" | "apiKeyCipher">;

/**
 * The plaintext key, for the two callers that genuinely need it: webhook
 * signing and showing it to an operator.
 *
 * Prefers the encrypted copy and falls back to the plaintext column. A cipher
 * that cannot be decrypted (key rotated without re-encrypting) falls back too
 * rather than throwing — a webhook that signs with the right secret matters more
 * than refusing to read a row, and the backfill script reports such rows.
 */
export function readAppApiKey(app: KeyBearing): string {
  if (app.apiKeyCipher) {
    try {
      return decryptCredential(app.apiKeyCipher);
    } catch {
      // Fall through to the plaintext column.
    }
  }
  return app.apiKey;
}

/**
 * Resolve an app by a presented api key.
 *
 * Hash lookup first — that is the steady state. The plaintext lookup behind it
 * exists only for rows the backfill has not reached; when it hits, the row is
 * repaired in passing (fire-and-forget, so a failed repair can never fail an
 * authenticated request) and the next call takes the indexed path.
 */
export async function findAppByApiKey(key: string): Promise<App | null> {
  const byHash = await prisma.app.findUnique({
    where: { apiKeyHash: hashAppApiKey(key) },
  });
  if (byHash) return byHash;

  const byPlaintext = await prisma.app.findUnique({ where: { apiKey: key } });
  if (!byPlaintext) return null;

  if (!byPlaintext.apiKeyHash || !byPlaintext.apiKeyCipher) {
    void prisma.app
      .update({
        where: { id: byPlaintext.id },
        data: {
          apiKeyHash: hashAppApiKey(key),
          apiKeyCipher: encryptCredential(key),
        },
      })
      .catch(() => {});
  }
  return byPlaintext;
}
