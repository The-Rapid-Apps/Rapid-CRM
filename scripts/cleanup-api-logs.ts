/**
 * Trim `api_request_logs` down to a retention window.
 *
 * The table captures every /api/flex, /api/discounts and /v1 request (see
 * app/lib/api-request-logs.server.ts). The /v1 identify surface
 * is chatty — an installed app calls it repeatedly — so the table grows fast
 * and needs periodic trimming. Scheduled weekly from ecosystem.config.cjs
 * (rapi-management-cleanup-api-logs); safe to run by hand any time.
 *
 * Retention defaults to 30 days so the API-logs page's "Last 30 days" filter
 * stays meaningful. Override with API_LOG_RETENTION_DAYS, or `-- --days N`.
 *
 * Deletes in bounded batches rather than one statement, so a large backlog is
 * trimmed over many short locks instead of one long table lock (which on a hot
 * table would block inserts and stall the API). Idempotent and safe to re-run.
 *
 * Run: npm run cleanup:api-logs [-- --days 30] [-- --batch 5000]
 */
import "dotenv/config";
import { prisma } from "../app/lib/db.server";
import { logJson, logJsonError } from "./lib/script-log";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_BATCH = 5_000;

async function main(): Promise<void> {
  const days = Number(
    arg("days") ?? process.env.API_LOG_RETENTION_DAYS ?? DEFAULT_RETENTION_DAYS,
  );
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error(`Retention must be a positive number of days, got: ${days}`);
  }
  // Inlined into the DELETE below, so it must be a plain positive integer —
  // validate before trusting it in the statement string.
  const batch = Number(arg("batch") ?? DEFAULT_BATCH);
  if (!Number.isInteger(batch) || batch <= 0) {
    throw new Error(`Batch size must be a positive integer, got: ${batch}`);
  }

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  logJson("cleanup-api-logs", "starting", {
    cutoff: cutoff.toISOString(),
    days,
    batch,
  });

  let deleted = 0;
  for (;;) {
    // Prisma's deleteMany has no LIMIT, so this is raw. `batch` is a validated
    // integer (safe to inline); the cutoff is a bound parameter.
    const affected = await prisma.$executeRawUnsafe(
      `DELETE FROM api_request_logs WHERE createdAt < ? LIMIT ${batch}`,
      cutoff,
    );
    deleted += affected;
    if (affected < batch) break;
  }

  const remaining = await prisma.apiRequestLog.count();
  logJson("cleanup-api-logs", "finished", {
    deleted,
    remaining,
    cutoff: cutoff.toISOString(),
  });
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    logJsonError("cleanup-api-logs", "failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    await prisma.$disconnect();
    process.exit(1);
  });
