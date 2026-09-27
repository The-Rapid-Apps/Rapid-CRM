import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "../generated/prisma/client";
import {
  buildPartnerTrialsFromFacts,
  historiesFromFacts,
} from "../app/lib/shopify/partner-mrr.server";
import { buildUtcBuckets } from "../app/lib/reports/analytics.server";

/**
 * Covers the "Paid plans only" toolbar filter on Reports > Trials.
 *
 * Free plans are real in this portfolio — "Free", "For Free" and "Gratuit" all
 * activate at $0 and all carry a 30-day trial — but they are a fraction of a
 * percent of volume, so a broken filter looks exactly like "we have no free
 * plans". That is what it looked like before this was wired: the toggle only
 * ever reached the history table, never the charts or the metric cards.
 */

function activation(params: {
  charge: string;
  at: string;
  amount: string;
  billingOn: string;
}) {
  return {
    appId: "app-1",
    type: "SUBSCRIPTION_CHARGE_ACTIVATED",
    occurredAt: new Date(params.at),
    shopDomain: `${params.charge}.myshopify.com`,
    chargePlatformId: params.charge,
    chargeName: params.charge,
    amount: new Prisma.Decimal(params.amount),
    currencyCode: "USD",
    billingOn: new Date(params.billingOn),
    test: false,
  };
}

/** One $0 trial and one $29 trial, both started in the period. */
function fixture() {
  const events = [
    activation({
      charge: "free",
      at: "2026-09-01T00:00:00.000Z",
      amount: "0",
      billingOn: "2026-10-01T00:00:00.000Z",
    }),
    activation({
      charge: "pro",
      at: "2026-09-02T00:00:00.000Z",
      amount: "29",
      billingOn: "2026-10-02T00:00:00.000Z",
    }),
  ];
  const periodStart = new Date("2026-09-01T00:00:00.000Z");
  const periodEnd = new Date("2026-09-20T00:00:00.000Z");
  return buildPartnerTrialsFromFacts({
    histories: historiesFromFacts(events, []),
    periodStart,
    periodEnd,
    buckets: buildUtcBuckets({
      start: periodStart,
      end: periodEnd,
      interval: "day",
    }),
    currentAt: new Date("2026-09-19T23:59:59.999Z"),
  });
}

test("paidOnly drops $0 plans from the summary counts", () => {
  const trials = fixture();

  assert.equal(trials.started, 2, "both trials count when free plans are included");
  assert.ok(trials.paidOnly, "the paid-only variant is always produced");
  assert.equal(trials.paidOnly.started, 1, "the $0 trial is excluded");
  assert.equal(
    trials.activeNow - trials.paidOnly.activeNow,
    1,
    "the free trial is the only difference in the active count",
  );
});

test("paidOnly drops $0 plans from the per-bucket series the charts read", () => {
  const trials = fixture();
  const startedAll = trials.timeSeries.reduce((n, p) => n + p.started, 0);
  const startedPaid = trials.paidOnly!.timeSeries.reduce(
    (n, p) => n + p.started,
    0,
  );

  assert.equal(startedAll, 2);
  assert.equal(startedPaid, 1, "charts follow the toggle, not just the table");
});

test("value sums are identical either way, which is why they have no paid twin", () => {
  const trials = fixture();
  const valueAll = trials.timeSeries.reduce((n, p) => n + (p.startedValue ?? 0), 0);
  const valuePaid = trials.paidOnly!.timeSeries.reduce(
    (n, p) => n + (p.startedValue ?? 0),
    0,
  );

  assert.equal(valueAll, 29, "a $0 plan contributes nothing to a money sum");
  assert.equal(
    valuePaid,
    valueAll,
    "so excluding it cannot change the value — only the counts move",
  );
});
