/**
 * Populate `apps.apiKeyHash` and `apps.apiKeyCipher` from the plaintext
 * `apps.apiKey`.
 *
 * Step two of removing the app → platform API key from plaintext at rest: the
 * migration adds the columns, this fills them, and a follow-up migration drops
 * `apiKey` once this reports nothing remaining.
 *
 * Changes no key and breaks nothing: every row keeps the exact same secret, so
 * authentication, webhook signatures and what the UI shows are all unaffected.
 * Idempotent — rows already carrying both columns are skipped, so it is safe to
 * re-run, and safe to run while the app is serving.
 *
 * Verifies each row after writing by decrypting the envelope back and comparing
 * it to the plaintext. A cipher that does not round-trip is reported and the
 * row is left with its plaintext intact rather than being trusted.
 *
 * Run: npm run backfill:app-api-keys
 */
import "dotenv/config";
import { prisma } from "../app/lib/db.server";
import {
  appApiKeyFields,
  hashAppApiKey,
} from "../app/lib/app-api-key.server";
import { decryptCredential } from "../app/lib/credential-encryption.server";
import { logJson, logJsonError } from "./lib/script-log";

async function main(): Promise<void> {
  const apps = await prisma.app.findMany({
    select: { id: true, name: true, apiKey: true, apiKeyHash: true, apiKeyCipher: true },
    orderBy: { createdAt: "asc" },
  });

  let filled = 0;
  let skipped = 0;
  const failures: Array<{ id: string; name: string; error: string }> = [];

  for (const app of apps) {
    if (app.apiKeyHash && app.apiKeyCipher) {
      skipped += 1;
      continue;
    }
    try {
      const fields = appApiKeyFields(app.apiKey);
      // Round-trip before trusting the envelope: a cipher that cannot be read
      // back would silently break webhook signing later, which is the one
      // failure this migration must not introduce.
      if (decryptCredential(fields.apiKeyCipher) !== app.apiKey) {
        throw new Error("encrypted copy did not decrypt back to the same key");
      }
      await prisma.app.update({
        where: { id: app.id },
        data: {
          apiKeyHash: fields.apiKeyHash,
          apiKeyCipher: fields.apiKeyCipher,
        },
      });
      filled += 1;
    } catch (error) {
      failures.push({
        id: app.id,
        name: app.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const remaining = await prisma.app.count({
    where: { OR: [{ apiKeyHash: null }, { apiKeyCipher: null }] },
  });

  logJson("backfill-app-api-keys", "finished", {
    apps: apps.length,
    filled,
    skipped,
    failed: failures.length,
    remaining,
  });

  if (failures.length) {
    logJsonError("backfill-app-api-keys", "rows could not be backfilled", {
      failures,
      note: "These still authenticate from the plaintext column. Check CREDENTIAL_ENCRYPTION_KEY before dropping apps.apiKey.",
    });
    process.exitCode = 1;
    return;
  }

  if (remaining === 0) {
    // Sanity check the steady-state path actually resolves for every row.
    const sample = await prisma.app.findMany({
      select: { id: true, apiKey: true, apiKeyHash: true },
    });
    const mismatched = sample.filter(
      (app) => app.apiKeyHash !== hashAppApiKey(app.apiKey),
    );
    if (mismatched.length) {
      logJsonError("backfill-app-api-keys", "hash does not match plaintext", {
        ids: mismatched.map((app) => app.id),
      });
      process.exitCode = 1;
      return;
    }
    logJson("backfill-app-api-keys", "every app is ready", {
      note: "apps.apiKey can now be dropped in a follow-up migration.",
    });
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    logJsonError("backfill-app-api-keys", "failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    await prisma.$disconnect();
    process.exit(1);
  });
