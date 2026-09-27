/**
 * Org-wide logo-churn snapshot writer, standalone (2026-08-18).
 *
 * Split out of `syncOrganizationPartnerSubscriptionFacts` (which only ever
 * runs inside the web-serving cluster) because the org-wide logo fold is a
 * full cross-app `historiesFromFacts` reconstruction (~2s of synchronous CPU
 * work) that was intermittently blocking real user requests on whichever
 * worker hit it on the ~5-minute cadence.
 *
 * Unlike every other sync lane, this writer needs neither a lease
 * (`Organization` has none) nor in-process cache locality, so it doesn't need
 * to run inside the web process — it talks to the database directly as its
 * own pm2 cron process (see `ecosystem.config.cjs`'s
 * `rapid-org-logo-churn` entry).
 *
 * Run: npm run sync:org-logo-churn
 */
import "dotenv/config";
import { prisma } from "../app/lib/db.server";
import { closeRedis } from "../app/lib/redis.server";
import {
  backfillOrgLogoSnapshot,
  writeTrailingOrgLogoSnapshot,
} from "../app/lib/shopify/partner-mrr-snapshot.server";
import { logJson, logJsonError } from "./lib/script-log";

async function main(): Promise<void> {
  const now = new Date();
  const organizations = await prisma.organization.findMany({
    select: { id: true },
  });
  for (const organization of organizations) {
    await writeTrailingOrgLogoSnapshot(organization.id, now);
    // Always attempted now (the old inline call gated this behind a
    // `backfill: true` flag nothing ever sent). Cheap no-op once
    // `Organization.logoSnapshotBackfillCompletedAt` is set.
    await backfillOrgLogoSnapshot(organization.id, now);
  }
  logJson("sync-org-logo-churn", "run finished", {
    organizations: organizations.length,
  });
}

main()
  .catch((error) => {
    logJsonError("sync-org-logo-churn", "run crashed", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  })
  .finally(async () => {
    // Unlike sync-shopify.ts (loopback HTTP only), this imports the Prisma
    // and Redis clients directly — both must be closed or ioredis's socket
    // keeps the event loop alive and the process never exits on its own.
    await Promise.all([prisma.$disconnect(), closeRedis()]);
  });
