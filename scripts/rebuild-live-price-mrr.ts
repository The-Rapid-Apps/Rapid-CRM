/**
 * After deploying the live-price MRR correction, queue affected derived history
 * for the existing bounded snapshot writer. Does not alter billing facts.
 *
 * Preview: node --import tsx scripts/rebuild-live-price-mrr.ts
 * Apply:   node --import tsx scripts/rebuild-live-price-mrr.ts --apply
 */
import "dotenv/config";
import { prisma } from "../app/lib/db.server";
import { closeRedis } from "../app/lib/redis.server";
import { invalidatePersistedPartnerMrrCache } from "../app/lib/shopify/partner-mrr.server";
import { markMrrSnapshotDirty } from "../app/lib/shopify/partner-mrr-snapshot.server";

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--apply")) {
    throw new Error("Usage: rebuild-live-price-mrr.ts [--apply]");
  }
  const apply = args.includes("--apply");
  const checks = await prisma.partnerChargeLiveDiscountCheck.findMany({
    where: { effectiveAmount: { gt: 0 } },
    select: { appId: true, chargePlatformId: true },
  });
  const appIds = [...new Set(checks.map((row) => row.appId))];
  const apps = await prisma.app.findMany({
    where: { id: { in: appIds } },
    select: { id: true, name: true },
  });
  for (const app of apps) {
    const [events, snapshots] = await Promise.all([
      prisma.partnerSubscriptionEvent.aggregate({
        where: {
          appId: app.id,
          chargePlatformId: { in: checks.filter((row) => row.appId === app.id)
            .map((row) => row.chargePlatformId) },
        },
        _min: { occurredAt: true },
      }),
      prisma.partnerDailyMrrSnapshot.aggregate({
        where: { appId: app.id },
        _min: { snapshotDate: true },
      }),
    ]);
    if (!events._min.occurredAt || !snapshots._min.snapshotDate) continue;
    const from = new Date(Math.max(
      events._min.occurredAt.getTime(), snapshots._min.snapshotDate.getTime(),
    ));
    from.setUTCHours(0, 0, 0, 0);
    if (apply) await markMrrSnapshotDirty(app.id, from);
    console.log(JSON.stringify({ app: app.name, from, queued: apply }));
  }
  if (apply) await invalidatePersistedPartnerMrrCache();
  console.log(apply
    ? "Queued. The subscription sync will rebuild daily MRR and plan snapshots."
    : "Preview only. Run with --apply after all workers use the corrected code.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  await prisma.$disconnect();
  await closeRedis();
});
