import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, type TestContext } from "node:test";
import { prisma } from "../app/lib/db.server";
import type { ResolvedAnalyticsRange } from "../app/lib/reports/analytics.server";
import {
  buildSnapshotPartnerRecurringSeries,
  mergeRecurringSeriesReports,
  type SnapshotPartnerRecurring,
} from "../app/lib/shopify/partner-mrr-snapshot.server";

/**
 * `buildSnapshotPartnerRecurringSeries` is the full-time-series counterpart
 * to `buildSnapshotPartnerRecurring` (which only reads two boundary days for
 * the Dashboard's summary cards) — needed by Reports' `mrr`/`portfolio`/
 * `ltv` metrics, which render a per-bucket chart. These tests prove the
 * bucket-to-day mapping picks each bucket's *last* day (a stock, never
 * summed across days) and fails closed on a coverage gap, against a real
 * database — the day-boundary arithmetic is the part a pure fixture can't
 * cover. `mergeRecurringSeriesReports` is pure logic, tested separately.
 */

function id(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}`;
}

async function cleanupApp(appId: string, organizationId: string): Promise<void> {
  await prisma.partnerDailyMrrSnapshot.deleteMany({ where: { appId } });
  await prisma.app.deleteMany({ where: { id: appId } });
  await prisma.organization.deleteMany({ where: { id: organizationId } });
}

async function fixtureApp(t: TestContext): Promise<string> {
  const suffix = id("recurring-series");
  const organization = await prisma.organization.create({
    data: { name: `Recurring series ${suffix}` },
  });
  const app = await prisma.app.create({
    data: {
      organizationId: organization.id,
      name: `Recurring series app ${suffix}`,
      handle: `recurring-series-${suffix}`,
      shopifyApiKey: `key-${suffix}`,
      shopifyApiSecret: `secret-${suffix}`,
    },
  });
  t.after(() => cleanupApp(app.id, organization.id));
  return app.id;
}

after(async () => {
  await prisma.$disconnect();
});

function day(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00.000Z`);
}

async function seedDay(
  appId: string,
  dateStr: string,
  mrr: number,
  activeSubscriptions: number,
  currencyCode = "USD",
): Promise<void> {
  await prisma.partnerDailyMrrSnapshot.create({
    data: {
      appId,
      snapshotDate: day(dateStr),
      currencyCode,
      mrr,
      arr: mrr * 12,
      monthlySubscriptions: mrr,
      annualSubscriptions: 0,
      trialSubscriptions: 0,
      usageCharges: 0,
      activeSubscriptions,
      revenueGross: 0,
      revenueCredits: 0,
      revenueNet: 0,
      subscriptionChurnedCount: 0,
      subscriptionRecoveredCount: 0,
      churnedRevenueLost: 0,
    },
  });
}

const NOW = new Date("2026-02-08T12:00:00.000Z"); // "today"

test("day-interval buckets each pick their own day's stock, not a sum", async (t) => {
  const appId = await fixtureApp(t);
  await seedDay(appId, "2026-02-01", 100, 5);
  await seedDay(appId, "2026-02-02", 150, 7);
  await seedDay(appId, "2026-02-03", 200, 9);

  const range: ResolvedAnalyticsRange = {
    period: "last_30_days",
    start: day("2026-02-01"),
    end: day("2026-02-04"),
    interval: "day",
  };
  const result = await buildSnapshotPartnerRecurringSeries({
    readyAppIds: [appId],
    range,
    now: NOW,
  });

  assert.ok(result);
  assert.equal(result!.timeSeries.length, 3);
  assert.equal(result!.timeSeries[0]!.mrr, 100);
  assert.equal(result!.timeSeries[0]!.activeSubscriptions, 5);
  assert.equal(result!.timeSeries[1]!.mrr, 150);
  assert.equal(result!.timeSeries[2]!.mrr, 200);
  // The boundary summary: starting = first day, current = last covered day.
  assert.equal(result!.currencies[0]!.startingMrr, 100);
  assert.equal(result!.currencies[0]!.mrr, 200);
  assert.equal(result!.currencies[0]!.netMrrGrowth, 100);
});

test("week-interval bucket uses the last day *within* the week, never a sum across the week's days", async (t) => {
  const appId = await fixtureApp(t);
  // A week bucket starting Monday 2026-02-02 through Sunday 2026-02-08.
  await seedDay(appId, "2026-02-02", 100, 5); // Monday
  await seedDay(appId, "2026-02-03", 110, 5);
  await seedDay(appId, "2026-02-04", 120, 5);
  await seedDay(appId, "2026-02-05", 130, 5);
  await seedDay(appId, "2026-02-06", 140, 5);
  await seedDay(appId, "2026-02-07", 150, 5); // last day fully before "now"

  const range: ResolvedAnalyticsRange = {
    period: "last_30_days",
    start: day("2026-02-02"),
    end: day("2026-02-08"), // exclusive — rangeEndExclusive caps at "today" (02-08) anyway
    interval: "week",
  };
  const result = await buildSnapshotPartnerRecurringSeries({
    readyAppIds: [appId],
    range,
    now: NOW,
  });

  assert.ok(result);
  assert.equal(result!.timeSeries.length, 1);
  // Must be 150 (last day's stock), never 100+110+120+130+140+150.
  assert.equal(result!.timeSeries[0]!.mrr, 150);
  assert.equal(result!.timeSeries[0]!.activeSubscriptions, 5);
});

test("the trailing bucket containing 'today' falls back to yesterday's stock, matching buildSnapshotPartnerRecurring's own convention", async (t) => {
  const appId = await fixtureApp(t);
  await seedDay(appId, "2026-02-06", 100, 5);
  await seedDay(appId, "2026-02-07", 120, 6); // yesterday relative to NOW (02-08)

  const range: ResolvedAnalyticsRange = {
    period: "last_30_days",
    start: day("2026-02-06"),
    end: NOW, // extends into "today" — the last bucket is provisional
    interval: "day",
  };
  const result = await buildSnapshotPartnerRecurringSeries({
    readyAppIds: [appId],
    range,
    now: NOW,
  });

  assert.ok(result);
  // Day-interval buckets: 02-06, 02-07, and a third, provisional bucket for
  // "today" (02-08, partial up to NOW) — buildUtcBuckets always emits one
  // per calendar day touched by the range, including an in-progress one.
  assert.equal(result!.timeSeries.length, 3);
  assert.equal(result!.timeSeries[0]!.mrr, 100);
  assert.equal(result!.timeSeries[0]!.provisional, false);
  assert.equal(result!.timeSeries[1]!.mrr, 120);
  assert.equal(result!.timeSeries[1]!.provisional, false);
  // Today's bucket has no row of its own — falls back to yesterday's stock
  // (rangeEndExclusive - 1 day), same convention buildSnapshotPartnerRecurring
  // already uses for its own "current" boundary value.
  assert.equal(result!.timeSeries[2]!.mrr, 120);
  assert.equal(result!.timeSeries[2]!.provisional, true);
});

test("fails closed (returns null) when a day in range is missing a row", async (t) => {
  const appId = await fixtureApp(t);
  await seedDay(appId, "2026-02-01", 100, 5);
  // 2026-02-02 deliberately missing.
  await seedDay(appId, "2026-02-03", 200, 9);

  const range: ResolvedAnalyticsRange = {
    period: "last_30_days",
    start: day("2026-02-01"),
    end: day("2026-02-04"),
    interval: "day",
  };
  const result = await buildSnapshotPartnerRecurringSeries({
    readyAppIds: [appId],
    range,
    now: NOW,
  });

  assert.equal(result, null);
});

test("sums across apps sharing a currency on the same picked day", async (t) => {
  const appA = await fixtureApp(t);
  const appB = await fixtureApp(t);
  for (const appId of [appA, appB]) {
    await seedDay(appId, "2026-02-01", 10, 1);
    await seedDay(appId, "2026-02-02", 25, 2);
  }

  const range: ResolvedAnalyticsRange = {
    period: "last_30_days",
    start: day("2026-02-01"),
    end: day("2026-02-03"),
    interval: "day",
  };
  const result = await buildSnapshotPartnerRecurringSeries({
    readyAppIds: [appA, appB],
    range,
    now: NOW,
  });

  assert.ok(result);
  assert.equal(result!.timeSeries[0]!.mrr, 20);
  assert.equal(result!.timeSeries[1]!.mrr, 50);
  assert.equal(result!.timeSeries[1]!.activeSubscriptions, 4);
});

test("mergeRecurringSeriesReports merges bucket-for-bucket by (periodStart, currency), summing not overwriting", () => {
  const snapshotSide: SnapshotPartnerRecurring = {
    currencies: [
      {
        currency: "USD",
        mrr: 100,
        arr: 1200,
        monthlySubscriptions: 100,
        annualSubscriptions: 0,
        usageCharges: 0,
        trialSubscriptions: 0,
        startingMrr: 80,
        netMrrGrowth: 20,
        growthRate: 0.25,
        activeSubscriptions: 5,
        activeCustomers: 0,
      },
    ],
    timeSeries: [
      {
        periodStart: "2026-02-01T00:00:00.000Z",
        periodEnd: "2026-02-02T00:00:00.000Z",
        currency: "USD",
        monthlySubscriptions: 80,
        annualSubscriptions: 0,
        usageCharges: 0,
        trialSubscriptions: 0,
        mrr: 80,
        arr: 960,
        activeSubscriptions: 4,
        activeCustomers: 0,
        provisional: false,
      },
      {
        periodStart: "2026-02-02T00:00:00.000Z",
        periodEnd: "2026-02-03T00:00:00.000Z",
        currency: "USD",
        monthlySubscriptions: 100,
        annualSubscriptions: 0,
        usageCharges: 0,
        trialSubscriptions: 0,
        mrr: 100,
        arr: 1200,
        activeSubscriptions: 5,
        activeCustomers: 0,
        provisional: false,
      },
    ],
  };
  const liveSide: SnapshotPartnerRecurring = {
    currencies: [
      {
        currency: "USD",
        mrr: 30,
        arr: 360,
        monthlySubscriptions: 30,
        annualSubscriptions: 0,
        usageCharges: 0,
        trialSubscriptions: 0,
        startingMrr: 20,
        netMrrGrowth: 10,
        growthRate: 0.5,
        activeSubscriptions: 2,
        activeCustomers: 2,
      },
    ],
    timeSeries: [
      {
        periodStart: "2026-02-01T00:00:00.000Z",
        periodEnd: "2026-02-02T00:00:00.000Z",
        currency: "USD",
        monthlySubscriptions: 20,
        annualSubscriptions: 0,
        usageCharges: 0,
        trialSubscriptions: 0,
        mrr: 20,
        arr: 240,
        activeSubscriptions: 1,
        activeCustomers: 1,
        provisional: false,
      },
      {
        periodStart: "2026-02-02T00:00:00.000Z",
        periodEnd: "2026-02-03T00:00:00.000Z",
        currency: "EUR",
        monthlySubscriptions: 15,
        annualSubscriptions: 0,
        usageCharges: 0,
        trialSubscriptions: 0,
        mrr: 15,
        arr: 180,
        activeSubscriptions: 1,
        activeCustomers: 1,
        provisional: false,
      },
    ],
  };

  const merged = mergeRecurringSeriesReports(snapshotSide, liveSide);
  // 2026-02-01 USD: 80 + 20 = 100. 2026-02-02 USD: 100 (no live USD that day)
  // + 2026-02-02 EUR: 15 (no snapshot EUR that day).
  assert.equal(merged.timeSeries.length, 3);
  const feb1Usd = merged.timeSeries.find(
    (p) => p.periodStart === "2026-02-01T00:00:00.000Z" && p.currency === "USD",
  );
  assert.equal(feb1Usd!.mrr, 100);
  assert.equal(feb1Usd!.activeSubscriptions, 5);
  const feb2Usd = merged.timeSeries.find(
    (p) => p.periodStart === "2026-02-02T00:00:00.000Z" && p.currency === "USD",
  );
  assert.equal(feb2Usd!.mrr, 100);
  const feb2Eur = merged.timeSeries.find(
    (p) => p.periodStart === "2026-02-02T00:00:00.000Z" && p.currency === "EUR",
  );
  assert.equal(feb2Eur!.mrr, 15);
});
