import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "../generated/prisma/client";
import type { ResolvedAnalyticsRange } from "../app/lib/reports/analytics.server";
import { buildPartnerRevenueFromFacts } from "../app/lib/shopify/partner-mrr.server";
import {
  bucketDailySnapshotRevenue,
  mergeRevenueReports,
} from "../app/lib/shopify/partner-mrr-snapshot.server";

/**
 * `mergeRevenueReports` combines a snapshot-served subset of apps with a
 * live-reconstructed subset (see `buildSnapshotPartnerAnalytics`'s
 * `readyAppIds`/`liveAppIds` split, 2026-08-16) into one report. These tests
 * prove the merge is a plain bucket-for-bucket, currency-for-currency sum —
 * equivalent to what a single, whole-account reconstruction would have
 * produced — not just "doesn't crash."
 */

const RANGE: ResolvedAnalyticsRange = {
  period: "last_30_days",
  start: new Date("2026-07-01T00:00:00.000Z"),
  end: new Date("2026-07-04T00:00:00.000Z"),
  interval: "day",
};

test("merging is equivalent to reconstructing both apps' sales in one pass", () => {
  const readyAppRows = [
    { snapshotDate: new Date("2026-07-01T00:00:00.000Z"), currencyCode: "USD", revenueGross: 10 },
    { snapshotDate: new Date("2026-07-02T00:00:00.000Z"), currencyCode: "USD", revenueGross: 20 },
  ];
  const snapshotRevenue = bucketDailySnapshotRevenue(readyAppRows, RANGE);

  const liveSales = [
    {
      appId: "live-app",
      chargePlatformId: "c1",
      occurredAt: new Date("2026-07-01T12:00:00.000Z"),
      billingInterval: "EVERY_30_DAYS" as const,
      grossAmount: new Prisma.Decimal(5),
      currencyCode: "USD",
    },
    {
      appId: "live-app",
      chargePlatformId: "c1",
      occurredAt: new Date("2026-07-03T12:00:00.000Z"),
      billingInterval: "EVERY_30_DAYS" as const,
      grossAmount: new Prisma.Decimal(7),
      currencyCode: "EUR",
    },
  ];
  const liveRevenue = buildPartnerRevenueFromFacts({
    sales: liveSales,
    period: RANGE.period,
    periodStart: RANGE.start,
    periodEnd: RANGE.end,
    interval: RANGE.interval,
  });

  const merged = mergeRevenueReports(snapshotRevenue, liveRevenue);

  // Reference: reconstruct everything from raw facts in one call.
  const wholeAccountSales = [
    { appId: "ready-app", chargePlatformId: "r1", occurredAt: new Date("2026-07-01T00:00:00.000Z"), billingInterval: "EVERY_30_DAYS" as const, grossAmount: new Prisma.Decimal(10), currencyCode: "USD" },
    { appId: "ready-app", chargePlatformId: "r2", occurredAt: new Date("2026-07-02T00:00:00.000Z"), billingInterval: "EVERY_30_DAYS" as const, grossAmount: new Prisma.Decimal(20), currencyCode: "USD" },
    ...liveSales,
  ];
  const reference = buildPartnerRevenueFromFacts({
    sales: wholeAccountSales,
    period: RANGE.period,
    periodStart: RANGE.start,
    periodEnd: RANGE.end,
    interval: RANGE.interval,
  });

  const byCurrency = (report: typeof merged) =>
    Object.fromEntries(
      report.currencies.map((c) => [
        c.currency,
        { gross: c.value.gross, perBucket: c.timeSeries.map((p) => p.gross) },
      ]),
    );

  assert.deepEqual(byCurrency(merged), byCurrency(reference));
});

test("a currency present in only one side is carried through untouched", () => {
  const snapshotRevenue = bucketDailySnapshotRevenue(
    [{ snapshotDate: new Date("2026-07-01T00:00:00.000Z"), currencyCode: "USD", revenueGross: 42 }],
    RANGE,
  );
  const liveRevenue = buildPartnerRevenueFromFacts({
    sales: [],
    period: RANGE.period,
    periodStart: RANGE.start,
    periodEnd: RANGE.end,
    interval: RANGE.interval,
  });

  const merged = mergeRevenueReports(snapshotRevenue, liveRevenue);
  assert.equal(merged.currencies.length, 1);
  assert.equal(merged.currencies[0]!.currency, "USD");
  assert.equal(merged.currencies[0]!.value.gross, 42);
});
