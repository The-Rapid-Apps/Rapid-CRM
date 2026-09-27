import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "../generated/prisma/client";
import {
  buildPartnerRecurringFromFacts,
  buildPartnerRevenueFromFacts,
} from "../app/lib/shopify/partner-mrr.server";
import {
  buildDailySnapshotRows,
  bucketDailySnapshotRevenue,
} from "../app/lib/shopify/partner-mrr-snapshot.server";

// Same fixture-builder shape as tests/partner-mrr.test.ts, duplicated locally
// per this repo's own convention (see reports-range-quantization.test.ts's
// own syncRow() rather than importing one).
function event(params: {
  charge: string;
  type: string;
  at: string;
  amount: string;
  currency?: string;
  billingOn?: string;
  shop?: string;
}) {
  return {
    appId: "app-1",
    type: params.type,
    occurredAt: new Date(params.at),
    shopDomain: params.shop ?? `${params.charge}.myshopify.com`,
    chargePlatformId: params.charge,
    chargeName: params.charge,
    amount: new Prisma.Decimal(params.amount),
    currencyCode: params.currency ?? "USD",
    billingOn: params.billingOn ? new Date(params.billingOn) : null,
    test: false,
  };
}

function sale(params: {
  charge: string;
  at: string;
  interval: "EVERY_30_DAYS" | "ANNUAL";
  gross: string;
  currency?: string;
}) {
  return {
    appId: "app-1",
    chargePlatformId: params.charge,
    occurredAt: new Date(params.at),
    billingInterval: params.interval,
    grossAmount: new Prisma.Decimal(params.gross),
    currencyCode: params.currency ?? "USD",
  };
}

function utcDay(iso: string): Date {
  const d = new Date(iso);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function daysBetween(startIso: string, endIsoExclusive: string): Date[] {
  const days: Date[] = [];
  let cursor = utcDay(startIso);
  const end = utcDay(endIsoExclusive);
  while (cursor.getTime() < end.getTime()) {
    days.push(cursor);
    cursor = new Date(cursor.getTime() + 86_400_000);
  }
  return days;
}

const EVENTS = [
  event({
    charge: "monthly",
    type: "SUBSCRIPTION_CHARGE_ACTIVATED",
    at: "2026-07-01T00:00:00.000Z",
    amount: "100",
  }),
  event({
    charge: "annual",
    type: "SUBSCRIPTION_CHARGE_ACTIVATED",
    at: "2026-07-01T00:00:00.000Z",
    amount: "1200",
  }),
  event({
    charge: "annual",
    type: "SUBSCRIPTION_CHARGE_CANCELED",
    at: "2026-07-15T00:00:00.000Z",
    amount: "1200",
  }),
];

const SALES = [
  sale({
    charge: "monthly",
    at: "2026-07-02T00:00:00.000Z",
    interval: "EVERY_30_DAYS",
    gross: "100",
  }),
  sale({
    charge: "annual",
    at: "2026-07-03T00:00:00.000Z",
    interval: "ANNUAL",
    gross: "1200",
  }),
];

test("buildDailySnapshotRows: mrr is 0 before activation and the charge amount from the activation day forward", () => {
  const { rows } = buildDailySnapshotRows({
    appId: "app-1",
    events: EVENTS,
    sales: SALES,
    days: daysBetween("2026-06-29T00:00:00.000Z", "2026-07-03T00:00:00.000Z"),
    builtFromEventsSyncedAt: null,
    builtFromSalesSyncedAt: null,
  });
  const byDay = new Map(rows.map((row) => [row.snapshotDate.toISOString(), row]));
  assert.equal(byDay.get("2026-06-29T00:00:00.000Z")?.mrr, 0);
  assert.equal(byDay.get("2026-06-30T00:00:00.000Z")?.mrr, 0);
  // Both charges activate exactly at 2026-07-01T00:00:00.000Z — active from
  // that day forward (contributionAt takes the last event at-or-before `at`,
  // and `at` for day D is D's end minus 1ms, well after the activation).
  assert.equal(byDay.get("2026-07-01T00:00:00.000Z")?.mrr, 200);
  assert.equal(byDay.get("2026-07-02T00:00:00.000Z")?.mrr, 200);
});

test("buildDailySnapshotRows: cancellation mid-range drops mrr from the cancellation day forward", () => {
  const { rows } = buildDailySnapshotRows({
    appId: "app-1",
    events: EVENTS,
    sales: SALES,
    days: daysBetween("2026-07-13T00:00:00.000Z", "2026-07-17T00:00:00.000Z"),
    builtFromEventsSyncedAt: null,
    builtFromSalesSyncedAt: null,
  });
  const byDay = new Map(rows.map((row) => [row.snapshotDate.toISOString(), row]));
  assert.equal(byDay.get("2026-07-13T00:00:00.000Z")?.mrr, 200);
  assert.equal(byDay.get("2026-07-14T00:00:00.000Z")?.mrr, 200);
  // Canceled at 2026-07-15T00:00:00.000Z — from that day forward only the
  // monthly charge ($100) contributes.
  assert.equal(byDay.get("2026-07-15T00:00:00.000Z")?.mrr, 100);
  assert.equal(byDay.get("2026-07-16T00:00:00.000Z")?.mrr, 100);
});

test("buildDailySnapshotRows: a day with zero contribution in a currency still gets an explicit row", () => {
  const { rows } = buildDailySnapshotRows({
    appId: "app-1",
    events: EVENTS,
    sales: SALES,
    days: daysBetween("2026-06-29T00:00:00.000Z", "2026-06-30T00:00:00.000Z"),
    builtFromEventsSyncedAt: null,
    builtFromSalesSyncedAt: null,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.currencyCode, "USD");
  assert.equal(rows[0]?.mrr, 0);
  assert.equal(rows[0]?.activeSubscriptions, 0);
});

test("parity (day interval): buildDailySnapshotRows matches buildPartnerRecurringFromFacts/buildPartnerRevenueFromFacts exactly, per day", () => {
  const periodStart = utcDay("2026-07-01T00:00:00.000Z");
  const periodEnd = utcDay("2026-07-20T00:00:00.000Z");
  const days = daysBetween(periodStart.toISOString(), periodEnd.toISOString());

  const { rows: snapshotRows } = buildDailySnapshotRows({
    appId: "app-1",
    events: EVENTS,
    sales: SALES,
    days,
    builtFromEventsSyncedAt: null,
    builtFromSalesSyncedAt: null,
  });

  const live = buildPartnerRecurringFromFacts({
    events: EVENTS,
    sales: SALES,
    periodStart,
    periodEnd,
    interval: "day",
  });
  const liveRevenue = buildPartnerRevenueFromFacts({
    sales: SALES,
    period: "all_time",
    periodStart,
    periodEnd,
    interval: "day",
  });

  const liveByDay = new Map(
    live.timeSeries.map((point) => [point.periodStart, point]),
  );
  const revenueByDay = new Map(
    liveRevenue.currencies
      .flatMap((currency) =>
        currency.timeSeries.map((point) => ({ ...point, currency: currency.currency })),
      )
      .map((point) => [point.periodStart, point]),
  );

  for (const row of snapshotRows) {
    const liveKey = row.snapshotDate.toISOString();
    const livePoint = liveByDay.get(liveKey);
    assert.ok(livePoint, `expected a live point for ${liveKey}`);
    assert.equal(row.mrr, livePoint!.mrr, `mrr mismatch on ${liveKey}`);
    assert.equal(row.arr, livePoint!.arr, `arr mismatch on ${liveKey}`);
    assert.equal(
      row.monthlySubscriptions,
      livePoint!.monthlySubscriptions,
      `monthlySubscriptions mismatch on ${liveKey}`,
    );
    assert.equal(
      row.annualSubscriptions,
      livePoint!.annualSubscriptions,
      `annualSubscriptions mismatch on ${liveKey}`,
    );
    assert.equal(
      row.trialSubscriptions,
      livePoint!.trialSubscriptions,
      `trialSubscriptions mismatch on ${liveKey}`,
    );
    assert.equal(
      row.activeSubscriptions,
      livePoint!.activeSubscriptions,
      `activeSubscriptions mismatch on ${liveKey}`,
    );

    const revenuePoint = revenueByDay.get(liveKey);
    assert.equal(
      row.revenueGross,
      revenuePoint?.gross ?? 0,
      `revenueGross mismatch on ${liveKey}`,
    );
    assert.equal(
      row.revenueNet,
      revenuePoint?.net ?? 0,
      `revenueNet mismatch on ${liveKey}`,
    );
  }
});

test("parity (week/month bucketing): bucketDailySnapshotRevenue matches buildPartnerRevenueFromFacts summed per bucket", () => {
  const periodStart = utcDay("2026-07-01T00:00:00.000Z");
  const periodEnd = utcDay("2026-08-01T00:00:00.000Z");
  const days = daysBetween(periodStart.toISOString(), periodEnd.toISOString());

  const { rows: snapshotRows } = buildDailySnapshotRows({
    appId: "app-1",
    events: EVENTS,
    sales: SALES,
    days,
    builtFromEventsSyncedAt: null,
    builtFromSalesSyncedAt: null,
  });

  for (const interval of ["week", "month"] as const) {
    const liveRevenue = buildPartnerRevenueFromFacts({
      sales: SALES,
      period: "all_time",
      periodStart,
      periodEnd,
      interval,
    });
    const bucketed = bucketDailySnapshotRevenue(snapshotRows, {
      period: "all_time",
      start: periodStart,
      end: periodEnd,
      interval,
    });

    assert.deepEqual(
      bucketed.currencies.map((c) => c.value),
      liveRevenue.currencies.map((c) => c.value),
      `${interval} bucket totals mismatch`,
    );
    for (const currency of liveRevenue.currencies) {
      const bucketedCurrency = bucketed.currencies.find(
        (c) => c.currency === currency.currency,
      );
      assert.ok(bucketedCurrency, `missing currency ${currency.currency} at ${interval}`);
      assert.deepEqual(
        bucketedCurrency!.timeSeries.map((p) => p.gross),
        currency.timeSeries.map((p) => p.gross),
        `${interval} per-bucket gross mismatch for ${currency.currency}`,
      );
    }
  }
});

/* The plan-snapshot counterpart to the parity test above. `PartnerDailyPlanMrrSnapshot`
   exists purely so the snapshot read path can serve "Top plans by MRR", so what
   has to hold is that its rows reproduce the live reconstruction's own per-plan
   grouping exactly — otherwise the card silently changes shape depending on
   which path served the request, which is the failure this table was added to
   fix in the first place. */
test("parity (plans): buildDailySnapshotRows' plan rows match buildPartnerRecurringFromFacts' planSeries", () => {
  const periodStart = utcDay("2026-07-01T00:00:00.000Z");
  const periodEnd = utcDay("2026-07-20T00:00:00.000Z");
  const days = daysBetween(periodStart.toISOString(), periodEnd.toISOString());
  const appNames = new Map([["app-1", "Rapi Bundle"]]);

  const { planRows } = buildDailySnapshotRows({
    appId: "app-1",
    appName: "Rapi Bundle",
    events: EVENTS,
    sales: SALES,
    days,
    builtFromEventsSyncedAt: null,
    builtFromSalesSyncedAt: null,
  });

  const live = buildPartnerRecurringFromFacts({
    events: EVENTS,
    sales: SALES,
    periodStart,
    periodEnd,
    interval: "day",
    appNames,
  });
  const liveSeries = live.planSeries ?? [];
  assert.ok(liveSeries.length > 0, "fixture should produce at least one plan");

  // Both sides keyed the same way: (day, currency, plan) -> MRR.
  const snapshotByKey = new Map(
    planRows.map((row) => [
      `${row.snapshotDate.toISOString()}|${row.currencyCode}|${row.plan}`,
      row.mrr,
    ]),
  );
  for (const series of liveSeries) {
    for (const point of series.points) {
      const key = `${point.periodStart}|${series.currency}|${series.plan}`;
      const snapshotMrr = snapshotByKey.get(key) ?? 0;
      assert.equal(
        snapshotMrr,
        point.mrr,
        `plan mrr mismatch for ${key}: snapshot ${snapshotMrr} vs live ${point.mrr}`,
      );
      snapshotByKey.delete(key);
    }
  }
  // Nothing left over: a plan row the live path never produced would put MRR on
  // the chart that the MRR total does not contain.
  const leftover = [...snapshotByKey].filter(([, mrr]) => mrr !== 0);
  assert.deepEqual(leftover, [], "snapshot produced plan rows the live path did not");
});

/* A plan dropping to zero must stop producing rows, not carry its last value
   forward — the reason the writer deletes the days it rewrites instead of
   upserting. Without that, a churned plan keeps its MRR on the card forever. */
test("buildDailySnapshotRows: a plan with no MRR produces no row for that day", () => {
  const days = daysBetween("2026-07-01T00:00:00.000Z", "2026-07-20T00:00:00.000Z");
  const { planRows } = buildDailySnapshotRows({
    appId: "app-1",
    appName: "Rapi Bundle",
    events: EVENTS,
    sales: SALES,
    days,
    builtFromEventsSyncedAt: null,
    builtFromSalesSyncedAt: null,
  });
  assert.ok(planRows.length > 0, "fixture should produce plan rows");
  assert.equal(
    planRows.some((row) => row.mrr === 0),
    false,
    "no plan row should carry zero MRR",
  );
  for (const row of planRows) {
    assert.ok(
      row.activeSubscriptions > 0,
      `a plan row with MRR must count at least one charge (${row.plan})`,
    );
  }
});
