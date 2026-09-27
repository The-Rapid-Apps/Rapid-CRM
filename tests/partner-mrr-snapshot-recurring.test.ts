import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, type TestContext } from "node:test";
import { prisma } from "../app/lib/db.server";
import type { ResolvedAnalyticsRange } from "../app/lib/reports/analytics.server";
import {
  buildSnapshotPartnerRecurring,
  mergeRecurringReports,
  type SnapshotPartnerRecurring,
} from "../app/lib/shopify/partner-mrr-snapshot.server";

/**
 * `buildSnapshotPartnerRecurring` is the MRR/active-subscriptions/growth
 * counterpart to `buildSnapshotPartnerAnalytics` (revenue) — same
 * PartnerDailyMrrSnapshot table, different fields, and a real database
 * round-trip since the day-boundary lookups are the part a pure fixture
 * can't cover. `mergeRecurringReports` is pure logic, tested separately.
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
  const suffix = id("recurring-snapshot");
  const organization = await prisma.organization.create({
    data: { name: `Recurring snapshot ${suffix}` },
  });
  const app = await prisma.app.create({
    data: {
      organizationId: organization.id,
      name: `Recurring snapshot app ${suffix}`,
      handle: `recurring-snapshot-${suffix}`,
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

const RANGE: ResolvedAnalyticsRange = {
  period: "last_30_days",
  start: new Date("2026-07-01T00:00:00.000Z"),
  end: new Date("2026-07-04T00:00:00.000Z"),
  interval: "day",
};
const NOW = new Date("2026-07-04T12:00:00.000Z"); // "today" per RANGE.end

test("current MRR/activeSubscriptions come from the last covered day, not summed across days", async (t) => {
  const appId = await fixtureApp(t);
  await prisma.partnerDailyMrrSnapshot.createMany({
    data: [
      {
        appId,
        snapshotDate: new Date("2026-07-01T00:00:00.000Z"),
        currencyCode: "USD",
        mrr: 100,
        arr: 1200,
        monthlySubscriptions: 100,
        annualSubscriptions: 0,
        trialSubscriptions: 0,
        usageCharges: 0,
        activeSubscriptions: 5,
        revenueGross: 0,
        revenueCredits: 0,
        revenueNet: 0,
        subscriptionChurnedCount: 0,
        subscriptionRecoveredCount: 0,
        churnedRevenueLost: 0,
      },
      {
        appId,
        snapshotDate: new Date("2026-07-02T00:00:00.000Z"),
        currencyCode: "USD",
        mrr: 150,
        arr: 1800,
        monthlySubscriptions: 150,
        annualSubscriptions: 0,
        trialSubscriptions: 0,
        usageCharges: 0,
        activeSubscriptions: 7,
        revenueGross: 0,
        revenueCredits: 0,
        revenueNet: 0,
        subscriptionChurnedCount: 0,
        subscriptionRecoveredCount: 0,
        churnedRevenueLost: 0,
      },
    ],
  });

  // range.end is "now" (2026-07-04), so the last covered day is 2026-07-03 —
  // there is no row for it, which must fail closed (null), not silently use
  // 2026-07-02's row as if it were "current".
  const missingLastDay = await buildSnapshotPartnerRecurring({
    readyAppIds: [appId],
    range: RANGE,
    now: NOW,
  });
  assert.equal(missingLastDay, null);

  await prisma.partnerDailyMrrSnapshot.create({
    data: {
      appId,
      snapshotDate: new Date("2026-07-03T00:00:00.000Z"),
      currencyCode: "USD",
      mrr: 200,
      arr: 2400,
      monthlySubscriptions: 200,
      annualSubscriptions: 0,
      trialSubscriptions: 0,
      usageCharges: 0,
      activeSubscriptions: 9,
      revenueGross: 0,
      revenueCredits: 0,
      revenueNet: 0,
      subscriptionChurnedCount: 0,
      subscriptionRecoveredCount: 0,
        churnedRevenueLost: 0,
    },
  });

  const result = await buildSnapshotPartnerRecurring({
    readyAppIds: [appId],
    range: RANGE,
    now: NOW,
  });
  assert.ok(result);
  assert.equal(result!.currencies.length, 1);
  const usd = result!.currencies[0]!;
  assert.equal(usd.currency, "USD");
  // current = day 2026-07-03 (last covered day), NOT 100+150+200 summed.
  assert.equal(usd.mrr, 200);
  assert.equal(usd.arr, 2400);
  assert.equal(usd.activeSubscriptions, 9);
  // starting = day 2026-07-01 (rangeStart).
  assert.equal(usd.startingMrr, 100);
  assert.equal(usd.netMrrGrowth, 100);
  assert.equal(usd.growthRate, 1);
  assert.equal(result!.timeSeries.length, 0);
  assert.equal(usd.activeCustomers, 0);
});

test("sums across apps sharing the same currency on the same day", async (t) => {
  const appA = await fixtureApp(t);
  const appB = await fixtureApp(t);
  for (const appId of [appA, appB]) {
    await prisma.partnerDailyMrrSnapshot.createMany({
      data: [
        {
          appId,
          snapshotDate: new Date("2026-07-01T00:00:00.000Z"),
          currencyCode: "USD",
          mrr: 10,
          arr: 120,
          monthlySubscriptions: 10,
          annualSubscriptions: 0,
          trialSubscriptions: 0,
          usageCharges: 0,
          activeSubscriptions: 1,
          revenueGross: 0,
          revenueCredits: 0,
          revenueNet: 0,
          subscriptionChurnedCount: 0,
          subscriptionRecoveredCount: 0,
        churnedRevenueLost: 0,
        },
        {
          appId,
          snapshotDate: new Date("2026-07-03T00:00:00.000Z"),
          currencyCode: "USD",
          mrr: 25,
          arr: 300,
          monthlySubscriptions: 25,
          annualSubscriptions: 0,
          trialSubscriptions: 0,
          usageCharges: 0,
          activeSubscriptions: 2,
          revenueGross: 0,
          revenueCredits: 0,
          revenueNet: 0,
          subscriptionChurnedCount: 0,
          subscriptionRecoveredCount: 0,
        churnedRevenueLost: 0,
        },
      ],
    });
  }

  const result = await buildSnapshotPartnerRecurring({
    readyAppIds: [appA, appB],
    range: RANGE,
    now: NOW,
  });
  assert.ok(result);
  const usd = result!.currencies[0]!;
  assert.equal(usd.mrr, 50);
  assert.equal(usd.startingMrr, 20);
  assert.equal(usd.activeSubscriptions, 4);
});

test("mergeRecurringReports sums per-currency and recomputes growth from the merged stocks", () => {
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
    timeSeries: [],
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
      {
        currency: "EUR",
        mrr: 40,
        arr: 480,
        monthlySubscriptions: 40,
        annualSubscriptions: 0,
        usageCharges: 0,
        trialSubscriptions: 0,
        startingMrr: 40,
        netMrrGrowth: 0,
        growthRate: 0,
        activeSubscriptions: 3,
        activeCustomers: 3,
      },
    ],
    timeSeries: [],
  };

  const merged = mergeRecurringReports(snapshotSide, liveSide);
  assert.equal(merged.currencies.length, 2);
  const usd = merged.currencies.find((c) => c.currency === "USD")!;
  // mrr and startingMrr are summed...
  assert.equal(usd.mrr, 130);
  assert.equal(usd.startingMrr, 100);
  // ...and growth is recomputed from the merged stocks, not summed
  // (20 + 10 = 30 would be a coincidental match here — assert the actual
  // computation, not the sum, so a regression to naive summing is caught).
  assert.equal(usd.netMrrGrowth, 30);
  assert.equal(usd.growthRate, 0.3);
  assert.equal(usd.activeSubscriptions, 7);

  const eur = merged.currencies.find((c) => c.currency === "EUR")!;
  assert.equal(eur.mrr, 40);
  assert.equal(eur.activeSubscriptions, 3);
});
