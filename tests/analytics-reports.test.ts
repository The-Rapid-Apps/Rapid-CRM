import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, type TestContext } from "node:test";
import { prisma } from "../app/lib/db.server";
import {
  getChurnReport,
  getCurrentMrrByCurrency,
  getLtvReport,
  getLtvReportFromRecurring,
  getPortfolioReport,
  getRevenueReport,
  monthlyRecurringAmount,
  resolveAnalyticsRange,
} from "../app/lib/reports/analytics.server";

interface ReportFixture {
  organizationId: string;
  appId: string;
  planId: string;
}

function id(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}`;
}

async function cleanupOrganization(organizationId: string): Promise<void> {
  const apps = await prisma.app.findMany({
    where: { organizationId },
    select: { id: true },
  });
  const appIds = apps.map((app) => app.id);
  const installs = appIds.length
    ? await prisma.appInstall.findMany({
        where: { appId: { in: appIds } },
        select: { id: true },
      })
    : [];
  const installIds = installs.map((install) => install.id);

  await prisma.flexBillingEvent.deleteMany({ where: { organizationId } });
  if (installIds.length) {
    await prisma.subscription.deleteMany({
      where: { appInstallId: { in: installIds } },
    });
  }
  if (appIds.length) {
    await prisma.discount.deleteMany({ where: { appId: { in: appIds } } });
    await prisma.appInstall.deleteMany({ where: { appId: { in: appIds } } });
    await prisma.plan.deleteMany({ where: { appId: { in: appIds } } });
    await prisma.app.deleteMany({ where: { id: { in: appIds } } });
  }
  await prisma.organization.deleteMany({ where: { id: organizationId } });
}

async function fixture(
  t: TestContext,
  label: string,
  amount = "100",
): Promise<ReportFixture> {
  const suffix = id(label);
  const organization = await prisma.organization.create({
    data: { name: `Reports ${suffix}` },
  });
  t.after(() => cleanupOrganization(organization.id));
  const app = await prisma.app.create({
    data: {
      organizationId: organization.id,
      name: `Reports app ${suffix}`,
      handle: `reports-${suffix}`,
      shopifyApiKey: `key-${suffix}`,
      shopifyApiSecret: `secret-${suffix}`,
    },
  });
  const plan = await prisma.plan.create({
    data: {
      appId: app.id,
      name: "Monthly",
      amount,
      recurringInterval: "MONTH",
      recurringIntervalCount: 1,
      usageChargeCappedAmount: "500",
    },
  });
  return {
    organizationId: organization.id,
    appId: app.id,
    planId: plan.id,
  };
}

after(async () => {
  await prisma.$disconnect();
});

test("monthly MRR normalizes cadence and only permanent price reductions", () => {
  const at = new Date("2026-06-30T00:00:00.000Z");
  assert.equal(
    monthlyRecurringAmount({
      amount: "1200",
      recurringInterval: "YEAR",
      recurringIntervalCount: 1,
    }),
    100,
  );
  assert.equal(
    monthlyRecurringAmount({
      amount: "90",
      recurringInterval: "MONTH",
      recurringIntervalCount: 3,
    }),
    30,
  );
  assert.equal(
    monthlyRecurringAmount({
      amount: "50",
      recurringInterval: "DAY",
      recurringIntervalCount: 30,
    }),
    50,
  );

  const baseDiscount = {
    startsAt: new Date("2026-01-01T00:00:00.000Z"),
    endsAt: null,
    discount: {
      type: "PERCENTAGE",
      value: "20",
      discountMethod: "PRICE_REDUCTION",
      durationIntervals: null,
    },
  };
  const plan = {
    amount: "100",
    recurringInterval: "MONTH",
    recurringIntervalCount: 1,
  };
  assert.equal(monthlyRecurringAmount(plan, [baseDiscount], at), 80);
  assert.equal(
    monthlyRecurringAmount(
      plan,
      [
        {
          ...baseDiscount,
          endsAt: new Date("2026-12-31T00:00:00.000Z"),
          discount: {
            ...baseDiscount.discount,
            durationIntervals: 3,
          },
        },
      ],
      at,
    ),
    100,
  );
  assert.equal(
    monthlyRecurringAmount(
      plan,
      [
        {
          ...baseDiscount,
          discount: {
            ...baseDiscount.discount,
            discountMethod: "APP_CREDITS",
          },
        },
      ],
      at,
    ),
    100,
  );

  const range = resolveAnalyticsRange(
    "last_30_days",
    new Date("2026-07-24T12:00:00.000Z"),
  );
  assert.equal(range.start.toISOString(), "2026-06-25T00:00:00.000Z");
  assert.equal(range.interval, "day");
});

test("current app MRR keeps live and test subscriptions separate", async (t) => {
  const data = await fixture(t, "current-mrr", "25");
  const activatedAt = new Date("2026-07-01T00:00:00.000Z");
  const installs = await Promise.all(
    ["live", "test"].map((kind) =>
      prisma.appInstall.create({
        data: {
          appId: data.appId,
          shopDomain: `${id(kind)}.myshopify.com`,
          installedAt: activatedAt,
        },
      }),
    ),
  );
  await prisma.subscription.createMany({
    data: [
      {
        appInstallId: installs[0].id,
        planId: data.planId,
        status: "ACTIVE",
        activatedAt,
      },
      {
        appInstallId: installs[1].id,
        planId: data.planId,
        status: "ACTIVE",
        activatedAt,
        test: true,
      },
    ],
  });

  const at = new Date("2026-07-24T12:00:00.000Z");
  assert.deepEqual(
    await getCurrentMrrByCurrency({
      organizationId: data.organizationId,
      appId: data.appId,
      at,
    }),
    [{ currency: "USD", mrr: 25 }],
  );
  assert.deepEqual(
    await getCurrentMrrByCurrency({
      organizationId: data.organizationId,
      appId: data.appId,
      at,
      dataSet: "test",
    }),
    [{ currency: "USD", mrr: 25 }],
  );
});

test("revenue is actual successful charge flow, grouped by currency", async (t) => {
  const data = await fixture(t, "revenue");
  const install = await prisma.appInstall.create({
    data: {
      appId: data.appId,
      shopDomain: `${id("revenue")}.myshopify.com`,
      installedAt: new Date("2025-12-01T00:00:00.000Z"),
    },
  });
  const subscription = await prisma.subscription.create({
    data: {
      appInstallId: install.id,
      planId: data.planId,
      status: "ACTIVE",
      activatedAt: new Date("2025-12-01T00:00:00.000Z"),
    },
  });

  await prisma.charge.createMany({
    data: [
      {
        subscriptionId: subscription.id,
        amount: "100",
        chargedAmount: "80",
        status: "ACTIVE",
        occurredAt: new Date("2026-01-05T00:00:00.000Z"),
      },
      {
        subscriptionId: subscription.id,
        amount: "30",
        chargedAmount: "30",
        status: "ACTIVE",
        occurredAt: new Date("2026-01-10T00:00:00.000Z"),
      },
      {
        subscriptionId: subscription.id,
        amount: "5",
        chargedAmount: "5",
        isCredit: true,
        status: "ACTIVE",
        occurredAt: new Date("2026-01-12T00:00:00.000Z"),
      },
      {
        subscriptionId: subscription.id,
        amount: "999",
        chargedAmount: "999",
        status: "PENDING",
        occurredAt: new Date("2026-01-15T00:00:00.000Z"),
      },
    ],
  });

  const eurPlan = await prisma.plan.create({
    data: {
      appId: data.appId,
      name: "EUR",
      amount: "40",
      currencyCode: "EUR",
      usageChargeCappedAmount: "500",
    },
  });
  const eurSubscription = await prisma.subscription.create({
    data: {
      appInstallId: install.id,
      planId: eurPlan.id,
      status: "ACTIVE",
      activatedAt: new Date("2025-12-01T00:00:00.000Z"),
    },
  });
  await prisma.charge.create({
    data: {
      subscriptionId: eurSubscription.id,
      amount: "40",
      chargedAmount: "40",
      chargedCurrencyCode: "EUR",
      status: "ACTIVE",
      occurredAt: new Date("2026-01-20T00:00:00.000Z"),
    },
  });

  const report = await getRevenueReport({
    organizationId: data.organizationId,
    start: new Date("2026-01-01T00:00:00.000Z"),
    end: new Date("2026-02-01T00:00:00.000Z"),
    now: new Date("2026-02-02T00:00:00.000Z"),
  });
  assert.deepEqual(
    report.currencies.map((currency) => currency.currency),
    ["EUR", "USD"],
  );
  const usd = report.currencies.find((currency) => currency.currency === "USD");
  const eur = report.currencies.find((currency) => currency.currency === "EUR");
  assert.deepEqual(usd?.value, { gross: 110, credits: 5, net: 105 });
  assert.deepEqual(eur?.value, { gross: 40, credits: 0, net: 40 });
});

test("churn uses start-of-period bases and LTV guards/uses rolling logo churn", async (t) => {
  const data = await fixture(t, "churn-ltv");
  const rangeStart = new Date("2026-06-01T00:00:00.000Z");
  const rangeEnd = new Date("2026-07-01T00:00:00.000Z");
  const installs = [];

  for (const label of ["a", "b", "c", "d"]) {
    const install = await prisma.appInstall.create({
      data: {
        appId: data.appId,
        shopDomain: `${id(label)}.myshopify.com`,
        installedAt: new Date("2026-05-01T00:00:00.000Z"),
      },
    });
    installs.push(install);
    await prisma.accountLifecycleEvent.create({
      data: {
        appId: data.appId,
        appInstallId: install.id,
        type: "INSTALLED",
        occurredAt: new Date("2026-05-01T00:00:00.000Z"),
        platformEventId: id(`installed-${label}`),
      },
    });
  }

  const uninstallA = await prisma.accountLifecycleEvent.create({
    data: {
      appId: data.appId,
      appInstallId: installs[0].id,
      type: "UNINSTALLED",
      occurredAt: new Date("2026-06-10T00:00:00.000Z"),
      platformEventId: id("uninstall-a"),
    },
  });
  await prisma.uninstallEventDetail.create({
    data: {
      eventId: uninstallA.id,
      reasonCode: "missing_features",
      reasonCodes: ["missing_features"],
      isStoreClosure: false,
    },
  });
  const uninstallB = await prisma.accountLifecycleEvent.create({
    data: {
      appId: data.appId,
      appInstallId: installs[1].id,
      type: "UNINSTALLED",
      occurredAt: new Date("2026-06-12T00:00:00.000Z"),
      platformEventId: id("uninstall-b"),
    },
  });
  await prisma.uninstallEventDetail.create({
    data: {
      eventId: uninstallB.id,
      reasonCode: "too_expensive",
      reasonCodes: ["too_expensive"],
      isStoreClosure: false,
    },
  });
  await prisma.accountLifecycleEvent.create({
    data: {
      appId: data.appId,
      appInstallId: installs[1].id,
      type: "REINSTALLED",
      occurredAt: new Date("2026-06-20T00:00:00.000Z"),
      platformEventId: id("reinstall-b"),
    },
  });
  const uninstallC = await prisma.accountLifecycleEvent.create({
    data: {
      appId: data.appId,
      appInstallId: installs[2].id,
      type: "UNINSTALLED",
      occurredAt: new Date("2026-06-14T00:00:00.000Z"),
      platformEventId: id("uninstall-c"),
    },
  });
  await prisma.uninstallEventDetail.create({
    data: {
      eventId: uninstallC.id,
      reasonCode: "store_closing_or_pausing",
      reasonCodes: ["store_closing_or_pausing"],
      isStoreClosure: true,
    },
  });

  const subscriptions = [];
  for (const install of installs) {
    subscriptions.push(
      await prisma.subscription.create({
        data: {
          appInstallId: install.id,
          planId: data.planId,
          status: "ACTIVE",
          activatedAt: new Date("2026-05-01T00:00:00.000Z"),
        },
      }),
    );
  }
  await prisma.subscription.update({
    where: { id: subscriptions[0].id },
    data: {
      status: "CANCELLED",
      canceledAt: new Date("2026-06-10T00:00:00.000Z"),
    },
  });
  await prisma.subscription.update({
    where: { id: subscriptions[1].id },
    data: {
      status: "CANCELLED",
      canceledAt: new Date("2026-06-12T00:00:00.000Z"),
    },
  });
  await prisma.flexBillingEvent.create({
    data: {
      organizationId: data.organizationId,
      subscriptionId: subscriptions[1].id,
      previousSubscriptionId: subscriptions[1].id,
      type: "UPGRADED",
      completedAt: new Date("2026-06-12T00:01:00.000Z"),
    },
  });
  await prisma.subscription.create({
    data: {
      appInstallId: installs[1].id,
      planId: data.planId,
      status: "ACTIVE",
      activatedAt: new Date("2026-06-12T00:01:00.000Z"),
    },
  });
  await prisma.subscription.update({
    where: { id: subscriptions[2].id },
    data: {
      status: "CANCELLED",
      canceledAt: new Date("2026-06-14T00:00:00.000Z"),
    },
  });
  await prisma.subscription.create({
    data: {
      appInstallId: installs[2].id,
      planId: data.planId,
      status: "ACTIVE",
      activatedAt: new Date("2026-06-14T00:01:00.000Z"),
      replacesSubscriptionId: subscriptions[2].id,
    },
  });

  const query = {
    organizationId: data.organizationId,
    start: rangeStart,
    end: rangeEnd,
    now: new Date("2026-07-02T00:00:00.000Z"),
  };
  const churn = await getChurnReport(query);
  assert.equal(churn.logo.denominator, 4);
  assert.equal(churn.logo.netLost, 1);
  assert.equal(churn.logo.value, 0.25);
  assert.equal(churn.subscription.denominator, 4);
  assert.equal(churn.subscription.netLost, 1);
  assert.equal(churn.subscription.value, 0.25);
  assert.deepEqual(churn.grossRevenue.currencies[0]?.value, {
    lostMrr: 100,
    startMrr: 400,
    rate: 0.25,
  });

  const ltv = await getLtvReport(query);
  assert.equal(ltv.currencies[0]?.monthlyChurnRate, 0.25);
  assert.equal(ltv.currencies[0]?.arpu, 100);
  assert.equal(ltv.currencies[0]?.value, 400);

  const lifecycleLtv = await getLtvReportFromRecurring(query, {
    currencies: [],
    timeSeries: [
      {
        periodStart: rangeStart.toISOString(),
        periodEnd: rangeEnd.toISOString(),
        currency: "USD",
        monthlySubscriptions: 250,
        annualSubscriptions: 50,
        usageCharges: 0,
        trialSubscriptions: 100,
        mrr: 400,
        arr: 4_800,
        activeSubscriptions: 3,
        activeCustomers: 3,
        provisional: false,
      },
    ],
  });
  assert.equal(lifecycleLtv.currencies[0]?.mrr, 300);
  assert.equal(lifecycleLtv.currencies[0]?.monthlyChurnRate, 0.25);
  assert.equal(lifecycleLtv.currencies[0]?.arpu, 100);
  assert.equal(lifecycleLtv.currencies[0]?.value, 400);

  const noChurn = await getLtvReport({
    organizationId: data.organizationId,
    start: new Date("2026-05-01T00:00:00.000Z"),
    end: new Date("2026-05-20T00:00:00.000Z"),
    now: new Date("2026-07-02T00:00:00.000Z"),
  });
  assert.equal(noChurn.currencies[0]?.monthlyChurnRate, 0);
  assert.equal(noChurn.currencies[0]?.value, null);
});

test("portfolio reports share as-of MRR, install, funnel, retention, and usage scope", async (t) => {
  const data = await fixture(t, "portfolio", "30");
  const active = await prisma.appInstall.create({
    data: {
      appId: data.appId,
      shopDomain: `${id("portfolio-active")}.myshopify.com`,
      installedAt: new Date("2026-06-05T00:00:00.000Z"),
    },
  });
  const churned = await prisma.appInstall.create({
    data: {
      appId: data.appId,
      shopDomain: `${id("portfolio-churned")}.myshopify.com`,
      installedAt: new Date("2026-06-06T00:00:00.000Z"),
      uninstalledAt: new Date("2026-06-20T00:00:00.000Z"),
    },
  });
  await prisma.accountLifecycleEvent.createMany({
    data: [
      {
        appId: data.appId,
        appInstallId: active.id,
        type: "INSTALLED",
        occurredAt: new Date("2026-06-05T00:00:00.000Z"),
        platformEventId: id("portfolio-installed-active"),
      },
      {
        appId: data.appId,
        appInstallId: churned.id,
        type: "INSTALLED",
        occurredAt: new Date("2026-06-06T00:00:00.000Z"),
        platformEventId: id("portfolio-installed-churned"),
      },
      {
        appId: data.appId,
        appInstallId: churned.id,
        type: "UNINSTALLED",
        occurredAt: new Date("2026-06-20T00:00:00.000Z"),
        platformEventId: id("portfolio-uninstalled"),
      },
    ],
  });
  const subscription = await prisma.subscription.create({
    data: {
      appInstallId: active.id,
      planId: data.planId,
      status: "ACTIVE",
      activatedAt: new Date("2026-06-10T00:00:00.000Z"),
    },
  });
  await prisma.charge.create({
    data: {
      subscriptionId: subscription.id,
      amount: "30",
      chargedAmount: "30",
      status: "ACTIVE",
      occurredAt: new Date("2026-06-15T00:00:00.000Z"),
    },
  });
  await prisma.usageEvent.create({
    data: {
      appInstallId: active.id,
      metric: "orders",
      quantity: "12",
      occurredAt: new Date("2026-06-16T00:00:00.000Z"),
    },
  });

  const report = await getPortfolioReport({
    organizationId: data.organizationId,
    appId: data.appId,
    start: new Date("2026-06-01T00:00:00.000Z"),
    end: new Date("2026-07-01T00:00:00.000Z"),
    now: new Date("2026-07-02T00:00:00.000Z"),
  });

  assert.deepEqual(report.recurring.currencies[0], {
    currency: "USD",
    mrr: 30,
    arr: 360,
    monthlySubscriptions: 30,
    annualSubscriptions: 0,
    usageCharges: 0,
    trialSubscriptions: 0,
    startingMrr: 0,
    netMrrGrowth: 30,
    growthRate: 0,
    activeSubscriptions: 1,
    activeCustomers: 1,
  });
  assert.equal(report.installs.activeNow, 1);
  assert.equal(report.installs.installedInPeriod, 2);
  assert.equal(report.installs.uninstalledInPeriod, 1);
  assert.deepEqual(report.funnel, {
    installed: 2,
    subscribed: 1,
    activated: 1,
    paid: 1,
  });
  assert.deepEqual(report.retention, [
    {
      cohort: "2026-06",
      installed: 2,
      retained: 1,
      retentionRate: 0.5,
    },
  ]);
  assert.equal(report.usage.length, 1);
  assert.equal(report.usage[0]?.metric, "orders");
  assert.equal(report.usage[0]?.quantity, 12);
  assert.equal(report.usage[0]?.eventCount, 1);
  assert.equal(report.usage[0]?.activeInstalls, 1);
  assert.equal(report.usage[0]?.previousQuantity, 0);
  assert.equal(report.usage[0]?.changeRate, null);
  assert.equal(
    report.usage[0]?.timeSeries.reduce(
      (sum, point) => sum + point.eventCount,
      0,
    ),
    1,
  );
  assert.equal(report.sourceCoverage.successfulCharges, 1);
});

test("trial conversion uses only matured trials and preserves the exact-expiry cancellation boundary", async (t) => {
  const data = await fixture(t, "trial-report", "30");
  const rows = [
    {
      domain: "converted",
      startedAt: new Date("2026-06-01T00:00:00.000Z"),
      endsAt: new Date("2026-06-08T00:00:00.000Z"),
      canceledAt: null,
      status: "ACTIVE" as const,
    },
    {
      domain: "canceled",
      startedAt: new Date("2026-06-02T00:00:00.000Z"),
      endsAt: new Date("2026-06-09T00:00:00.000Z"),
      canceledAt: new Date("2026-06-09T00:00:00.000Z"),
      status: "CANCELLED" as const,
    },
    {
      domain: "active",
      startedAt: new Date("2026-06-25T00:00:00.000Z"),
      endsAt: new Date("2026-07-03T00:00:00.000Z"),
      canceledAt: null,
      status: "ACTIVE" as const,
    },
  ];

  for (const row of rows) {
    const install = await prisma.appInstall.create({
      data: {
        appId: data.appId,
        shopDomain: `${id(`trial-${row.domain}`)}.myshopify.com`,
        installedAt: row.startedAt,
      },
    });
    await prisma.subscription.create({
      data: {
        appInstallId: install.id,
        planId: data.planId,
        status: row.status,
        activatedAt: row.startedAt,
        trialStartedAt: row.startedAt,
        trialEndsAt: row.endsAt,
        canceledAt: row.canceledAt,
      },
    });
  }

  const report = await getPortfolioReport({
    organizationId: data.organizationId,
    appId: data.appId,
    start: new Date("2026-06-01T00:00:00.000Z"),
    end: new Date("2026-07-01T00:00:00.000Z"),
    now: new Date("2026-07-02T00:00:00.000Z"),
  });

  assert.equal(report.trials.started, 3);
  assert.equal(report.trials.converted, 1);
  assert.equal(report.trials.canceled, 1);
  assert.equal(report.trials.completed, 2);
  assert.equal(report.trials.unresolved, 0);
  assert.equal(report.trials.activeNow, 1);
  assert.equal(report.trials.conversionRate, 0.5);
});
