/**
 * Backfills `PartnerDailyPlanMrrSnapshot` for every day an app already has an
 * MRR snapshot row for.
 *
 * `npm run backfill:plan-mrr` (DRY_RUN=1 to report without writing).
 *
 * Needed once, because the table is new: the nightly writer fills it going
 * forward, but "Top plans by MRR" reads history, and on the snapshot path a day
 * with no plan rows is indistinguishable from a day where no plan earned
 * anything. Until this has run, the card reports nothing on that path.
 *
 * Scoped to exactly the days the parent table covers, deliberately — that
 * table's presence is what the read path treats as coverage, so inventing plan
 * rows for days it does not cover would claim data the report cannot use.
 *
 * Safe to re-run: every figure is a pure function of immutable facts, the same
 * property the snapshot itself relies on. Each app's days are deleted and
 * rewritten, so a plan that has since dropped to zero loses its row rather than
 * keeping a stale one.
 */
import { prisma } from "../app/lib/db.server";
import {
  historiesFromFacts,
  resolveOfferCadencePins,
  loadLiveDiscountChecks,
} from "../app/lib/shopify/partner-mrr.server";
import { buildDailySnapshotRows } from "../app/lib/shopify/partner-mrr-snapshot.server";

const DRY_RUN = process.env.DRY_RUN === "1";
const DAY_MS = 86_400_000;
/** MySQL placeholder limits make one giant createMany a bad idea. */
const INSERT_CHUNK = 2_000;
const startOfUtcDay = (at: Date) =>
  new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));

const apps = await prisma.app.findMany({
  select: {
    id: true,
    name: true,
    billingEventsSyncedAt: true,
    billingSalesSyncedAt: true,
  },
});

let totalRows = 0;

for (const app of apps) {
  const bounds = await prisma.partnerDailyMrrSnapshot.aggregate({
    where: { appId: app.id },
    _min: { snapshotDate: true },
    _max: { snapshotDate: true },
  });
  const first = bounds._min.snapshotDate;
  const last = bounds._max.snapshotDate;
  if (!first || !last) {
    console.log(`${app.name.padEnd(22)} no MRR snapshot rows — skipped`);
    continue;
  }

  const periodEnd = new Date(startOfUtcDay(last).getTime() + DAY_MS);
  const [events, sales] = await Promise.all([
    prisma.partnerSubscriptionEvent.findMany({
      where: { appId: app.id, occurredAt: { lt: periodEnd } },
      select: {
        appId: true,
        type: true,
        occurredAt: true,
        shopDomain: true,
        chargePlatformId: true,
        chargeName: true,
        amount: true,
        currencyCode: true,
        billingOn: true,
        test: true,
      },
      orderBy: [{ chargePlatformId: "asc" }, { occurredAt: "asc" }],
    }),
    prisma.partnerSubscriptionSaleFact.findMany({
      where: { appId: app.id, occurredAt: { lt: periodEnd } },
      select: {
        appId: true,
        chargePlatformId: true,
        occurredAt: true,
        billingInterval: true,
        grossAmount: true,
        currencyCode: true,
      },
      orderBy: [{ chargePlatformId: "asc" }, { occurredAt: "asc" }],
    }),
  ]);
  if (events.length === 0) continue;

  const histories = historiesFromFacts(
    events,
    sales,
    await resolveOfferCadencePins(events, sales),
    await loadLiveDiscountChecks([app.id]),
  );

  const days: Date[] = [];
  for (
    let day = startOfUtcDay(first);
    day.getTime() <= startOfUtcDay(last).getTime();
    day = new Date(day.getTime() + DAY_MS)
  ) {
    days.push(day);
  }

  const { planRows } = buildDailySnapshotRows({
    appId: app.id,
    appName: app.name,
    events,
    sales,
    histories,
    days,
    builtFromEventsSyncedAt: app.billingEventsSyncedAt,
    builtFromSalesSyncedAt: app.billingSalesSyncedAt,
  });

  if (!DRY_RUN) {
    await prisma.partnerDailyPlanMrrSnapshot.deleteMany({
      where: { appId: app.id },
    });
    for (let start = 0; start < planRows.length; start += INSERT_CHUNK) {
      await prisma.partnerDailyPlanMrrSnapshot.createMany({
        data: planRows.slice(start, start + INSERT_CHUNK),
      });
    }
  }

  totalRows += planRows.length;
  const plans = [...new Set(planRows.map((row) => row.plan))].sort();
  console.log(
    `${app.name.padEnd(22)} ${String(days.length).padStart(5)} days  ` +
      `${String(planRows.length).padStart(7)} plan rows  ${plans.length} plans: ${plans.join(", ")}`,
  );
}

console.log(
  `\n${DRY_RUN ? "DRY RUN — nothing written" : "written"}: ${totalRows} plan rows`,
);

await prisma.$disconnect();
process.exit(0);
