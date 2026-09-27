import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "../generated/prisma/client";
import {
  buildPartnerChurnFromFacts,
  buildPartnerRecurringFromFacts,
  buildPartnerRevenueFromFacts,
} from "../app/lib/shopify/partner-mrr.server";

function event(params: {
  charge: string;
  type: string;
  at: string;
  amount: string;
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
    currencyCode: "USD",
    billingOn: params.billingOn ? new Date(params.billingOn) : null,
    test: false,
  };
}

function sale(params: {
  charge: string;
  at: string;
  interval: "EVERY_30_DAYS" | "ANNUAL";
}) {
  return {
    appId: "app-1",
    chargePlatformId: params.charge,
    occurredAt: new Date(params.at),
    billingInterval: params.interval,
    grossAmount: null,
    currencyCode: "USD",
  };
}

test("Partner lifecycle MRR separates monthly, annual, and active trials", () => {
  const report = buildPartnerRecurringFromFacts({
    events: [
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
        charge: "trial",
        type: "SUBSCRIPTION_CHARGE_ACTIVATED",
        at: "2026-07-01T00:00:00.000Z",
        amount: "50",
        // Shopify's first billing date is the end of the seven-day trial.
        billingOn: "2026-07-08T00:00:00.000Z",
      }),
    ],
    sales: [
      sale({
        charge: "monthly",
        at: "2026-07-01T00:00:00.000Z",
        interval: "EVERY_30_DAYS",
      }),
      sale({
        charge: "annual",
        at: "2026-07-01T00:00:00.000Z",
        interval: "ANNUAL",
      }),
    ],
    periodStart: new Date("2026-07-01T00:00:00.000Z"),
    periodEnd: new Date("2026-07-05T00:00:00.000Z"),
    interval: "day",
  });

  assert.deepEqual(report.currencies, [
    {
      currency: "USD",
      mrr: 250,
      arr: 3000,
      monthlySubscriptions: 100,
      annualSubscriptions: 100,
      usageCharges: 0,
      trialSubscriptions: 50,
      startingMrr: 250,
      netMrrGrowth: 0,
      growthRate: 0,
      activeSubscriptions: 2,
      activeCustomers: 3,
    },
  ]);
  assert.equal(report.trials.activeNow, 1);
  assert.equal(report.timeSeries.at(-1)?.activePayingCustomers, 2);
});

test("a future renewal date is not treated as a trial end", () => {
  const report = buildPartnerRecurringFromFacts({
    events: [
      event({
        charge: "paid-with-future-renewal",
        type: "SUBSCRIPTION_CHARGE_ACTIVATED",
        at: "2026-07-01T00:00:00.000Z",
        amount: "29",
        // Partner AppSubscription.billingOn is the next billing date. A paid
        // subscription can therefore have a future value without being a trial.
        billingOn: "2026-07-22T00:00:00.000Z",
      }),
    ],
    /*
      The sale is what makes this subscription PAID, which is the whole premise of
      the test — and it was missing.

      It passed anyway until `a0803bf`, for the wrong reason: the inferred-trial
      window was then capped at 8 days, so a renewal 21 days out fell outside it
      and nothing had to be paid for the charge to read as non-trial. Widening the
      cap to one billing cadence removed that accident and left the test red on
      `main`, asserting a guarantee its own fixture never set up.

      With a sale present the real guard applies: `shopHasPriorSale` excludes a
      shop that has paid from trial inference entirely, whatever `billingOn` says.
      That is the behaviour this test is named for.
    */
    sales: [
      sale({
        charge: "paid-with-future-renewal",
        at: "2026-07-01T00:00:00.000Z",
        interval: "EVERY_30_DAYS",
      }),
    ],
    periodStart: new Date("2026-07-01T00:00:00.000Z"),
    periodEnd: new Date("2026-07-10T00:00:00.000Z"),
    interval: "day",
  });

  assert.equal(report.currencies[0]?.monthlySubscriptions, 29);
  assert.equal(report.currencies[0]?.trialSubscriptions, 0);
  assert.equal(report.currencies[0]?.mrr, 29);
  assert.equal(report.trials.activeNow, 0);
});

test("Partner trial conversion excludes active trials and treats cancellation at expiry as canceled", () => {
  const report = buildPartnerRecurringFromFacts({
    events: [
      event({
        charge: "converted-trial",
        type: "SUBSCRIPTION_CHARGE_ACTIVATED",
        at: "2026-07-01T00:00:00.000Z",
        amount: "30",
        billingOn: "2026-07-08T00:00:00.000Z",
      }),
      event({
        charge: "canceled-trial",
        type: "SUBSCRIPTION_CHARGE_ACTIVATED",
        at: "2026-07-02T00:00:00.000Z",
        amount: "30",
        billingOn: "2026-07-09T00:00:00.000Z",
      }),
      event({
        charge: "canceled-trial",
        type: "SUBSCRIPTION_CHARGE_CANCELED",
        at: "2026-07-09T00:00:00.000Z",
        amount: "30",
      }),
      event({
        charge: "active-trial",
        type: "SUBSCRIPTION_CHARGE_ACTIVATED",
        at: "2026-07-10T00:00:00.000Z",
        amount: "30",
        billingOn: "2026-07-17T00:00:00.000Z",
      }),
    ],
    sales: [
      sale({
        charge: "converted-trial",
        at: "2026-07-08T00:00:00.000Z",
        interval: "EVERY_30_DAYS",
      }),
    ],
    periodStart: new Date("2026-07-01T00:00:00.000Z"),
    periodEnd: new Date("2026-07-15T00:00:00.000Z"),
    interval: "day",
  });

  assert.equal(report.trials.started, 3);
  assert.equal(report.trials.converted, 1);
  assert.equal(report.trials.canceled, 1);
  assert.equal(report.trials.completed, 2);
  assert.equal(report.trials.unresolved, 0);
  assert.equal(report.trials.activeNow, 1);
  assert.equal(report.trials.conversionRate, 0.5);
  assert.equal(report.trials.source, "shopify_partner_inferred");
  assert.equal(
    report.trials.timeSeries.reduce((sum, point) => sum + point.converted, 0),
    1,
  );
  assert.equal(
    report.trials.timeSeries.reduce((sum, point) => sum + point.canceled, 0),
    1,
  );
});

test("Partner lifecycle MRR removes canceled and frozen charges as-of each bucket", () => {
  const report = buildPartnerRecurringFromFacts({
    events: [
      event({
        charge: "cancelled",
        type: "SUBSCRIPTION_CHARGE_ACTIVATED",
        at: "2026-07-01T00:00:00.000Z",
        amount: "40",
      }),
      event({
        charge: "cancelled",
        type: "SUBSCRIPTION_CHARGE_CANCELED",
        at: "2026-07-03T00:00:00.000Z",
        amount: "40",
      }),
      event({
        charge: "frozen",
        type: "SUBSCRIPTION_CHARGE_ACTIVATED",
        at: "2026-07-01T00:00:00.000Z",
        amount: "60",
      }),
      event({
        charge: "frozen",
        type: "SUBSCRIPTION_CHARGE_FROZEN",
        at: "2026-07-04T00:00:00.000Z",
        amount: "60",
      }),
    ],
    sales: [
      sale({
        charge: "cancelled",
        at: "2026-07-01T00:00:00.000Z",
        interval: "EVERY_30_DAYS",
      }),
      sale({
        charge: "frozen",
        at: "2026-07-01T00:00:00.000Z",
        interval: "EVERY_30_DAYS",
      }),
    ],
    periodStart: new Date("2026-07-01T00:00:00.000Z"),
    periodEnd: new Date("2026-07-05T00:00:00.000Z"),
    interval: "day",
  });

  assert.deepEqual(
    report.timeSeries.map((point) => point.mrr),
    [100, 100, 60, 0],
  );
  assert.equal(report.currencies[0]?.mrr, 0);
});

test("Partner LTV churn uses paid charge states, nets recovery, and excludes frozen charges", () => {
  const report = buildPartnerRecurringFromFacts({
    events: [
      event({
        charge: "cancelled",
        type: "SUBSCRIPTION_CHARGE_ACTIVATED",
        at: "2026-05-01T00:00:00.000Z",
        amount: "40",
      }),
      event({
        charge: "cancelled",
        type: "SUBSCRIPTION_CHARGE_CANCELED",
        at: "2026-07-15T00:00:00.000Z",
        amount: "40",
      }),
      event({
        charge: "recovered",
        type: "SUBSCRIPTION_CHARGE_ACTIVATED",
        at: "2026-05-01T00:00:00.000Z",
        amount: "50",
      }),
      event({
        charge: "recovered",
        type: "SUBSCRIPTION_CHARGE_CANCELED",
        at: "2026-07-10T00:00:00.000Z",
        amount: "50",
      }),
      event({
        charge: "recovered",
        type: "SUBSCRIPTION_CHARGE_ACTIVATED",
        at: "2026-07-20T00:00:00.000Z",
        amount: "50",
      }),
      event({
        charge: "frozen",
        type: "SUBSCRIPTION_CHARGE_ACTIVATED",
        at: "2026-05-01T00:00:00.000Z",
        amount: "60",
      }),
      event({
        charge: "frozen",
        type: "SUBSCRIPTION_CHARGE_FROZEN",
        at: "2026-07-12T00:00:00.000Z",
        amount: "60",
      }),
    ],
    sales: [
      sale({
        charge: "cancelled",
        at: "2026-05-01T00:00:00.000Z",
        interval: "EVERY_30_DAYS",
      }),
      sale({
        charge: "recovered",
        at: "2026-05-01T00:00:00.000Z",
        interval: "EVERY_30_DAYS",
      }),
      sale({
        charge: "frozen",
        at: "2026-05-01T00:00:00.000Z",
        interval: "EVERY_30_DAYS",
      }),
    ],
    periodStart: new Date("2026-07-01T00:00:00.000Z"),
    periodEnd: new Date("2026-08-01T00:00:00.000Z"),
    interval: "month",
  });

  const point = report.timeSeries.at(-1);
  assert.equal(point?.subscriptionChurnDenominator, 3);
  assert.equal(point?.churnedSubscriptions, 1);
  assert.equal(point?.monthlySubscriptionChurnRate, 0.333333);
});

test("Partner sale facts drive revenue without storing a calculated total", () => {
  const sales = [
    {
      ...sale({
        charge: "monthly",
        at: "2026-07-05T00:00:00.000Z",
        interval: "EVERY_30_DAYS",
      }),
      grossAmount: new Prisma.Decimal("19.99"),
    },
    {
      ...sale({
        charge: "annual",
        at: "2026-07-20T00:00:00.000Z",
        interval: "ANNUAL",
      }),
      grossAmount: new Prisma.Decimal("120"),
    },
  ];
  const report = buildPartnerRevenueFromFacts({
    sales,
    period: "last_30_days",
    periodStart: new Date("2026-07-01T00:00:00.000Z"),
    periodEnd: new Date("2026-08-01T00:00:00.000Z"),
    interval: "week",
  });

  assert.equal(report.currencies[0]?.value.gross, 139.99);
  assert.equal(
    report.currencies[0]?.timeSeries.reduce(
      (sum, point) => sum + point.gross,
      0,
    ),
    139.99,
  );
});

test("Partner churn suppresses cancel plus replacement activation plan changes", () => {
  const events = [
    event({
      charge: "old-plan",
      shop: "merchant.myshopify.com",
      type: "SUBSCRIPTION_CHARGE_ACTIVATED",
      at: "2026-06-01T00:00:00.000Z",
      amount: "20",
    }),
    event({
      charge: "old-plan",
      shop: "merchant.myshopify.com",
      type: "SUBSCRIPTION_CHARGE_CANCELED",
      at: "2026-07-15T12:00:00.000Z",
      amount: "20",
    }),
    event({
      charge: "new-plan",
      shop: "merchant.myshopify.com",
      type: "SUBSCRIPTION_CHARGE_ACTIVATED",
      at: "2026-07-15T12:00:30.000Z",
      amount: "40",
    }),
  ];
  const sales = [
    sale({
      charge: "old-plan",
      at: "2026-06-01T00:00:00.000Z",
      interval: "EVERY_30_DAYS",
    }),
    sale({
      charge: "new-plan",
      at: "2026-07-15T12:00:30.000Z",
      interval: "EVERY_30_DAYS",
    }),
  ];
  const report = buildPartnerChurnFromFacts({
    events,
    sales,
    period: "last_30_days",
    periodStart: new Date("2026-07-01T00:00:00.000Z"),
    periodEnd: new Date("2026-08-01T00:00:00.000Z"),
    interval: "month",
  });

  assert.equal(report.logo.netLost, 0);
  assert.equal(report.subscription.netLost, 0);
  assert.equal(report.grossRevenue.currencies[0]?.value.lostMrr, 0);
});
