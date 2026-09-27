import assert from "node:assert/strict";
import test, { after } from "node:test";
import { prisma } from "../app/lib/db.server";
import {
  capReportInterval,
  getLtvReportFromRecurring,
  RANGE_QUANTUM_MS,
  resolveReportRange,
} from "../app/lib/reports/analytics.server";
import type { RecurringPoint } from "../app/lib/reports/analytics.server";
import { partnerLifecycleReadiness } from "../app/lib/shopify/partner-mrr.server";

const QUERY = { organizationId: "org-quantization", period: "last_30_days" } as const;

after(async () => {
  await prisma.$disconnect();
});

test("capReportInterval coarsens an explicit day request across a multi-year range", () => {
  // The exact production failure (2026-08-16): "All time" x "Daily" on a
  // years-old account produced ~1700 daily buckets, each costing a full
  // O(histories) scan for mrr/churn — a 504 timeout, not a cache miss.
  const start = new Date("2021-12-15T00:00:00.000Z");
  const end = new Date("2026-08-16T00:00:00.000Z");
  assert.equal(capReportInterval("day", start, end), "month");
});

test("capReportInterval leaves an explicit day request alone for a narrow range", () => {
  const start = new Date("2026-07-17T00:00:00.000Z");
  const end = new Date("2026-08-16T00:00:00.000Z");
  assert.equal(capReportInterval("day", start, end), "day");
});

test("capReportInterval never fines up — week stays week even for a narrow range", () => {
  const start = new Date("2026-08-01T00:00:00.000Z");
  const end = new Date("2026-08-16T00:00:00.000Z");
  assert.equal(capReportInterval("week", start, end), "week");
});

test("report ranges are quantized so requests seconds apart share a cache key", async () => {
  // Every downstream cache and dedupe key is built from the resolved range. An
  // unquantized `now` carries milliseconds, so two requests a second apart used
  // to mint different keys and guarantee a miss on every single request.
  const first = await resolveReportRange({
    ...QUERY,
    now: new Date("2026-07-24T12:31:56.789Z"),
  });
  const second = await resolveReportRange({
    ...QUERY,
    now: new Date("2026-07-24T12:34:59.001Z"),
  });

  assert.equal(first.end.toISOString(), "2026-07-24T12:30:00.000Z");
  assert.equal(first.end.getTime(), second.end.getTime());
  assert.equal(first.start.getTime(), second.start.getTime());
  assert.equal(first.start.toISOString(), "2026-06-25T00:00:00.000Z");
  assert.equal(first.interval, "day");
});

test("a quantized range still advances once the window rolls over", async () => {
  const before = await resolveReportRange({
    ...QUERY,
    now: new Date("2026-07-24T12:34:59.999Z"),
  });
  const after = await resolveReportRange({
    ...QUERY,
    now: new Date("2026-07-24T12:35:00.000Z"),
  });
  assert.equal(after.end.getTime() - before.end.getTime(), RANGE_QUANTUM_MS);
});

test("the cache TTL and the range quantum stay equal", () => {
  // They are two halves of one decision: a quantum shorter than the TTL expires
  // cached work unused, a longer one serves a window whose entry already aged
  // out. Pinned so a change to one is a deliberate change to both.
  assert.equal(RANGE_QUANTUM_MS, 5 * 60_000);
});

function syncRow(overrides: Record<string, Date | null | string> = {}) {
  return {
    id: "app-1",
    billingEventsBackfillCompletedAt: new Date("2026-07-01T00:00:00.000Z"),
    billingSalesBackfillCompletedAt: new Date("2026-07-01T00:00:00.000Z"),
    ...overrides,
  } as Parameters<typeof partnerLifecycleReadiness>[0][number];
}

test("persisted lifecycle applies only when every app finished both backfills", () => {
  assert.equal(partnerLifecycleReadiness([syncRow()]).coverage.applied, true);

  // No apps in scope is not "complete" — it has nothing to be complete about.
  assert.equal(partnerLifecycleReadiness([]).coverage.applied, false);

  assert.equal(
    partnerLifecycleReadiness([
      syncRow({ billingSalesBackfillCompletedAt: null }),
    ]).coverage.applied,
    false,
  );

  // One lagging app disqualifies the whole scope, otherwise an "All apps"
  // report would silently mix reconstructed and estimated MRR.
  assert.equal(
    partnerLifecycleReadiness([
      syncRow(),
      syncRow({ id: "app-2", billingEventsBackfillCompletedAt: null }),
    ]).coverage.applied,
    false,
  );
});

function recurringPoint(overrides: Partial<RecurringPoint> = {}): RecurringPoint {
  return {
    periodStart: "2026-06-25T00:00:00.000Z",
    periodEnd: "2026-07-24T12:34:00.000Z",
    currency: "USD",
    monthlySubscriptions: 100,
    annualSubscriptions: 0,
    usageCharges: 0,
    trialSubscriptions: 0,
    mrr: 100,
    arr: 1200,
    activeSubscriptions: 2,
    activeCustomers: 2,
    provisional: false,
    ...overrides,
  };
}

/**
 * Counts `appInstall.findMany` calls made while `run` executes. Installs are the
 * heaviest read in the reporting path, so "was it read at all?" is the thing
 * worth asserting, not just the number that came out.
 */
async function countInstallLoads(run: () => Promise<unknown>): Promise<number> {
  const delegate = prisma.appInstall as unknown as Record<string, unknown>;
  const original = delegate.findMany as (...args: unknown[]) => unknown;
  let calls = 0;
  delegate.findMany = (...args: unknown[]) => {
    calls += 1;
    return original.apply(delegate, args);
  };
  try {
    await run();
  } finally {
    delegate.findMany = original;
  }
  return calls;
}

test("LTV from a reconstructed series does not read installs", async () => {
  const now = new Date("2026-07-24T12:34:56.789Z");
  const query = { ...QUERY, now };
  const range = await resolveReportRange(query);
  const recurring = {
    currencies: [],
    timeSeries: [recurringPoint({ monthlySubscriptionChurnRate: 0.05 })],
  };

  let report: Awaited<ReturnType<typeof getLtvReportFromRecurring>> | undefined;
  const loads = await countInstallLoads(async () => {
    report = await getLtvReportFromRecurring(query, recurring, range);
  });

  // The series already carries a paid churn rate, so the install-based logo
  // fallback is unreachable — loading installs here was pure waste.
  assert.equal(loads, 0);
  const point = report?.currencies[0]?.timeSeries[0];
  assert.equal(point?.churnBasis, "subscription");
  // ARPU 100/2 = 50, over a 0.05 churn rate.
  assert.equal(point?.value, 1000);
});

test("LTV still reads installs when the series has no churn rate to use", async () => {
  const now = new Date("2026-07-24T12:34:56.789Z");
  const query = { ...QUERY, now };
  const range = await resolveReportRange(query);
  const recurring = { currencies: [], timeSeries: [recurringPoint()] };

  let report: Awaited<ReturnType<typeof getLtvReportFromRecurring>> | undefined;
  const loads = await countInstallLoads(async () => {
    report = await getLtvReportFromRecurring(query, recurring, range);
  });

  assert.equal(loads, 1);
  assert.equal(report?.currencies[0]?.timeSeries[0]?.churnBasis, "logo");
});
