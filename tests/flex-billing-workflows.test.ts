import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, type TestContext } from "node:test";
import {
  createBillingAccessToken,
  verifyBillingAccessToken,
} from "../app/lib/billing-access.server";
import { prisma } from "../app/lib/db.server";
import {
  checkFlexBillingSubscription,
  collectOutstandingFlexBillingCharges,
} from "../app/lib/flex/charge.server";
import {
  createDiscountForOrganization,
  DiscountManagementError,
} from "../app/lib/flex/discount-management.server";
import {
  attachDiscountToSubscription,
  calculateDiscountEndsAt,
  findEligibleDiscountByCode,
  normalizeDiscountCode,
} from "../app/lib/flex/discounts.server";
import { lockKey, withLock } from "../app/lib/flex/lock.server";
import {
  activateSubscription,
  subscribe,
  type SubscribeDependencies,
} from "../app/lib/flex/subscribe.server";
import {
  cancelSubscription,
  SubscriptionManagementError,
} from "../app/lib/flex/subscription-management.server";
import { ingestUsage } from "../app/lib/flex/auto-upgrade.server";
import { partnerShopGid } from "../app/lib/shopify/partner.server";

interface Fixture {
  organization: { id: string };
  app: { id: string };
  install: { id: string };
  monthlyPlan: { id: string };
  alternatePlan: { id: string };
}

function nonce(label: string): string {
  return `${label}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

async function cleanupOrganization(organizationId: string): Promise<void> {
  const apps = await prisma.app.findMany({
    where: { organizationId },
    select: { id: true },
  });
  const appIds = apps.map(({ id }) => id);
  const installs = appIds.length
    ? await prisma.appInstall.findMany({
        where: { appId: { in: appIds } },
        select: { id: true },
      })
    : [];
  const installIds = installs.map(({ id }) => id);

  await prisma.flexLock.deleteMany({
    where: { key: { startsWith: `flex:${organizationId}:` } },
  });
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
  await prisma.user.deleteMany({ where: { organizationId } });
  await prisma.organization.deleteMany({ where: { id: organizationId } });
}

async function createFixture(t: TestContext, label: string): Promise<Fixture> {
  const id = nonce(label);
  const organization = await prisma.organization.create({
    data: { name: `Workflow test ${id}` },
  });
  t.after(() => cleanupOrganization(organization.id));

  const app = await prisma.app.create({
    data: {
      organizationId: organization.id,
      name: `App ${id}`,
      handle: `workflow-${id}`,
      shopifyApiKey: `api-${id}`,
      shopifyApiSecret: `secret-${id}`,
      distribution: "PUBLIC",
    },
  });
  const install = await prisma.appInstall.create({
    data: {
      appId: app.id,
      shopDomain: `${id}.myshopify.com`,
      shopPlatformId: "123456789",
      accessToken: "test-access-token",
      scope: "write_own_subscription",
    },
  });
  const monthlyPlan = await prisma.plan.create({
    data: {
      appId: app.id,
      name: "Monthly",
      amount: "20",
      usageChargeCappedAmount: "100",
      recurringInterval: "MONTH",
      recurringIntervalCount: 1,
      trialDays: 7,
    },
  });
  const alternatePlan = await prisma.plan.create({
    data: {
      appId: app.id,
      name: "Quarterly",
      amount: "50",
      usageChargeCappedAmount: "200",
      interval: "QUARTERLY",
      recurringInterval: "MONTH",
      recurringIntervalCount: 3,
    },
  });

  return { organization, app, install, monthlyPlan, alternatePlan };
}

after(async () => {
  await prisma.$disconnect();
});

test("billing access tokens validate signature, expiry, and install binding", async (t) => {
  const fixture = await createFixture(t, "billing-token");
  const otherInstall = await prisma.appInstall.create({
    data: {
      appId: fixture.app.id,
      shopDomain: `${nonce("other")}.myshopify.com`,
    },
  });
  const issuedAt = new Date("2026-07-24T10:00:00.000Z");
  const grant = createBillingAccessToken(fixture.install.id, {
    now: issuedAt,
    ttlSeconds: 60,
  });

  assert.equal(
    verifyBillingAccessToken(
      grant.token,
      fixture.install.id,
      new Date("2026-07-24T10:00:59.000Z"),
    )?.installId,
    fixture.install.id,
  );
  assert.equal(
    verifyBillingAccessToken(
      grant.token,
      fixture.install.id,
      new Date("2026-07-24T10:01:00.000Z"),
    ),
    null,
  );
  assert.equal(
    verifyBillingAccessToken(grant.token, otherInstall.id, issuedAt),
    null,
  );

  const [payload, signature] = grant.token.split(".");
  const tamperedSignature = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
  const tampered = `${payload}.${tamperedSignature}`;
  assert.equal(
    verifyBillingAccessToken(tampered, fixture.install.id, issuedAt),
    null,
  );
});

test("Partner shop ids accept numeric and canonical GID forms", () => {
  assert.equal(partnerShopGid("123456789"), "gid://partners/Shop/123456789");
  assert.equal(
    partnerShopGid("gid://partners/Shop/123456789"),
    "gid://partners/Shop/123456789",
  );
  assert.throws(() => partnerShopGid("not-a-shop"), /Partner shop id/i);
});

test("discount management normalizes, validates, scopes, and persists duration", async (t) => {
  const fixture = await createFixture(t, "discount");
  assert.equal(normalizeDiscountCode("  Ｓｐｒｉｎｇ_25  "), "SPRING_25");

  const discount = await createDiscountForOrganization(
    fixture.organization.id,
    {
      appId: fixture.app.id,
      planId: fixture.monthlyPlan.id,
      code: "  spring_25  ",
      type: "PERCENTAGE",
      value: "25",
      discountMethod: "PRICE_REDUCTION",
      durationIntervals: "2",
      description: "Two monthly periods",
    },
  );
  assert.equal(discount.code, "SPRING_25");
  assert.equal(discount.normalizedCode, "SPRING_25");

  await assert.rejects(
    createDiscountForOrganization(fixture.organization.id, {
      appId: fixture.app.id,
      planId: fixture.monthlyPlan.id,
      code: "SPRING_25",
      type: "PERCENTAGE",
      value: "10",
      discountMethod: "PRICE_REDUCTION",
    }),
    (error: unknown) =>
      error instanceof DiscountManagementError &&
      error.field === "code" &&
      /already exists/i.test(error.message),
  );
  await assert.rejects(
    createDiscountForOrganization(fixture.organization.id, {
      appId: fixture.app.id,
      code: "TOO_MUCH",
      type: "PERCENTAGE",
      value: "100.01",
      discountMethod: "PRICE_REDUCTION",
    }),
    (error: unknown) =>
      error instanceof DiscountManagementError &&
      error.field === "value" &&
      /at most 100/i.test(error.message),
  );

  const eligible = await findEligibleDiscountByCode({
    appId: fixture.app.id,
    planId: fixture.monthlyPlan.id,
    code: " spring_25 ",
  });
  assert.equal(eligible.valid, true);
  const mismatched = await findEligibleDiscountByCode({
    appId: fixture.app.id,
    planId: fixture.alternatePlan.id,
    code: "SPRING_25",
  });
  assert.deepEqual(mismatched, {
    valid: false,
    reason: "PLAN_MISMATCH",
  });
  const missingPlan = await findEligibleDiscountByCode({
    appId: fixture.app.id,
    code: "SPRING_25",
  });
  assert.deepEqual(missingPlan, {
    valid: false,
    reason: "PLAN_REQUIRED",
  });

  const startsAt = new Date("2026-01-31T00:00:00.000Z");
  const subscription = await prisma.subscription.create({
    data: {
      appInstallId: fixture.install.id,
      planId: fixture.monthlyPlan.id,
      status: "ACTIVE",
      activatedAt: startsAt,
      currentPeriodStart: startsAt,
      currentPeriodEnd: new Date("2026-02-28T00:00:00.000Z"),
      nextBillingDate: new Date("2026-02-28T00:00:00.000Z"),
      billingCycleAnchor: startsAt,
    },
  });
  const attached = await attachDiscountToSubscription({
    subscriptionId: subscription.id,
    discountId: discount.id,
    startsAt,
  });
  assert.equal(attached.startsAt.toISOString(), startsAt.toISOString());
  assert.equal(attached.endsAt?.toISOString(), "2026-03-30T23:59:59.999Z");
  assert.equal(
    calculateDiscountEndsAt({
      startsAt,
      durationIntervals: 2,
      recurringInterval: "MONTH",
      recurringIntervalCount: 1,
    })?.toISOString(),
    "2026-03-30T23:59:59.999Z",
  );

  const wrongPlanSubscription = await prisma.subscription.create({
    data: {
      appInstallId: fixture.install.id,
      planId: fixture.alternatePlan.id,
      status: "PENDING",
    },
  });
  await assert.rejects(
    attachDiscountToSubscription({
      subscriptionId: wrongPlanSubscription.id,
      discountId: discount.id,
    }),
    /not eligible for this plan/i,
  );
});

test("subscribe retries return one pending subscription and one Shopify request", async (t) => {
  const fixture = await createFixture(t, "subscribe-idempotency");
  let createCalls = 0;
  const createShopifySubscription: SubscribeDependencies["createShopifySubscription"] =
    async () => {
      createCalls += 1;
      return {
        shopifySubscriptionId: "gid://shopify/AppSubscription/pending",
        usageLineItemId: "gid://shopify/AppSubscriptionLineItem/usage",
        confirmationUrl: "https://example.test/confirm/pending",
        test: true,
      };
    };
  const input = {
    appInstallId: fixture.install.id,
    planId: fixture.monthlyPlan.id,
    idempotencyKey: `subscribe:${randomUUID()}`,
    test: true,
  };

  const first = await subscribe(input, { createShopifySubscription });
  const retry = await subscribe(input, { createShopifySubscription });

  assert.deepEqual(retry, first);
  assert.equal(createCalls, 1);
  assert.equal(
    await prisma.subscription.count({
      where: { appInstallId: fixture.install.id, status: "PENDING" },
    }),
    1,
  );
  assert.equal(
    await prisma.subscriptionLineItem.count({
      where: { subscriptionId: first.subscriptionId },
    }),
    2,
  );
  await assert.rejects(
    subscribe(
      { ...input, planId: fixture.alternatePlan.id },
      { createShopifySubscription },
    ),
    /different subscription parameters/i,
  );
  assert.equal(createCalls, 1);
});

test("subscribe rejects a duplicate active subscription before calling Shopify", async (t) => {
  const fixture = await createFixture(t, "subscribe-duplicate");
  await prisma.subscription.create({
    data: {
      appInstallId: fixture.install.id,
      planId: fixture.monthlyPlan.id,
      status: "ACTIVE",
      activatedAt: new Date(),
    },
  });
  let createCalls = 0;
  const createShopifySubscription: SubscribeDependencies["createShopifySubscription"] =
    async () => {
      createCalls += 1;
      throw new Error("Shopify should not be called");
    };

  await assert.rejects(
    subscribe(
      {
        appInstallId: fixture.install.id,
        planId: fixture.alternatePlan.id,
        idempotencyKey: `duplicate:${randomUUID()}`,
      },
      { createShopifySubscription },
    ),
    /already has active subscription/i,
  );
  assert.equal(createCalls, 0);
});

test("an install cannot consume its local trial twice", async (t) => {
  const fixture = await createFixture(t, "trial-once");
  let createCalls = 0;
  const createShopifySubscription: SubscribeDependencies["createShopifySubscription"] =
    async () => {
      createCalls += 1;
      return {
        shopifySubscriptionId: `gid://shopify/AppSubscription/trial-${createCalls}`,
        usageLineItemId: `gid://shopify/AppSubscriptionLineItem/trial-${createCalls}`,
        confirmationUrl: `https://example.test/confirm/trial-${createCalls}`,
        test: true,
      };
    };
  const first = await subscribe(
    {
      appInstallId: fixture.install.id,
      planId: fixture.monthlyPlan.id,
      idempotencyKey: `trial-first:${randomUUID()}`,
      test: true,
    },
    { createShopifySubscription },
  );
  await activateSubscription(first.subscriptionId, {
    getShopifySubscriptionStatus: async () => ({
      status: "ACTIVE",
      currentPeriodEnd: null,
    }),
  });
  const consumedInstall = await prisma.appInstall.findUniqueOrThrow({
    where: { id: fixture.install.id },
  });
  assert.ok(consumedInstall.trialConsumedAt);

  await cancelSubscription(
    {
      subscriptionId: first.subscriptionId,
      appId: fixture.app.id,
    },
    {
      cancelShopifySubscription: async () => ({ status: "CANCELLED" }),
    },
  );
  const second = await subscribe(
    {
      appInstallId: fixture.install.id,
      planId: fixture.monthlyPlan.id,
      idempotencyKey: `trial-second:${randomUUID()}`,
      test: true,
    },
    { createShopifySubscription },
  );
  const secondSubscription = await prisma.subscription.findUniqueOrThrow({
    where: { id: second.subscriptionId },
  });
  assert.equal(secondSubscription.trialStartedAt, null);
  assert.equal(secondSubscription.trialEndsAt, null);
});

test("replacement approval cancels the old remote subscription and atomically swaps local state", async (t) => {
  const fixture = await createFixture(t, "replacement");
  const oldSubscription = await prisma.subscription.create({
    data: {
      appInstallId: fixture.install.id,
      planId: fixture.monthlyPlan.id,
      status: "ACTIVE",
      activatedAt: new Date("2026-06-01T00:00:00.000Z"),
      shopifySubscriptionId: "gid://shopify/AppSubscription/old",
      currentPeriodStart: new Date("2026-07-01T00:00:00.000Z"),
      currentPeriodEnd: new Date("2026-08-01T00:00:00.000Z"),
      nextBillingDate: new Date("2026-08-01T00:00:00.000Z"),
    },
  });
  const replacement = await prisma.subscription.create({
    data: {
      appInstallId: fixture.install.id,
      planId: fixture.alternatePlan.id,
      status: "PENDING",
      test: true,
      shopifySubscriptionId: "gid://shopify/AppSubscription/new",
      replacesSubscriptionId: oldSubscription.id,
      approvalExpiresAt: new Date(Date.now() + 60_000),
    },
  });

  const statusChecks: string[] = [];
  const cancellations: string[] = [];
  const getShopifySubscriptionStatus: SubscribeDependencies["getShopifySubscriptionStatus"] =
    async (_app, _install, shopifySubscriptionId) => {
      statusChecks.push(shopifySubscriptionId);
      return { status: "ACTIVE", currentPeriodEnd: null };
    };
  const cancelShopifySubscription: SubscribeDependencies["cancelShopifySubscription"] =
    async (_app, _install, params) => {
      cancellations.push(params.shopifySubscriptionId);
      return { status: "CANCELLED" };
    };

  const result = await activateSubscription(replacement.id, {
    getShopifySubscriptionStatus,
    cancelShopifySubscription,
  });
  assert.deepEqual(result, { activated: true });
  assert.deepEqual(statusChecks, [
    "gid://shopify/AppSubscription/new",
    "gid://shopify/AppSubscription/old",
  ]);
  assert.deepEqual(cancellations, ["gid://shopify/AppSubscription/old"]);

  const [oldAfter, replacementAfter] = await Promise.all([
    prisma.subscription.findUniqueOrThrow({
      where: { id: oldSubscription.id },
    }),
    prisma.subscription.findUniqueOrThrow({ where: { id: replacement.id } }),
  ]);
  assert.equal(oldAfter.status, "CANCELLED");
  assert.ok(oldAfter.canceledAt);
  assert.equal(replacementAfter.status, "ACTIVE");
  assert.ok(replacementAfter.activatedAt);
  assert.equal(
    await prisma.subscription.count({
      where: {
        appInstallId: fixture.install.id,
        status: "ACTIVE",
        canceledAt: null,
      },
    }),
    1,
  );
  assert.deepEqual(
    await activateSubscription(replacement.id, {
      getShopifySubscriptionStatus,
      cancelShopifySubscription,
    }),
    { activated: true },
  );
  assert.equal(
    await prisma.flexBillingEvent.count({
      where: { subscriptionId: replacement.id, type: "SUBSCRIBED" },
    }),
    1,
  );
});

test("cancellation only mirrors locally after Shopify succeeds", async (t) => {
  const fixture = await createFixture(t, "safe-cancel");
  const subscription = await prisma.subscription.create({
    data: {
      appInstallId: fixture.install.id,
      planId: fixture.monthlyPlan.id,
      status: "ACTIVE",
      activatedAt: new Date(),
      shopifySubscriptionId: "gid://shopify/AppSubscription/cancel",
    },
  });

  await assert.rejects(
    cancelSubscription(
      {
        subscriptionId: subscription.id,
        appId: fixture.app.id,
      },
      {
        cancelShopifySubscription: async () => {
          throw new Error("remote unavailable");
        },
      },
    ),
    (error: unknown) =>
      error instanceof SubscriptionManagementError &&
      error.status === 502 &&
      /remote unavailable/i.test(error.message),
  );

  const afterFailure = await prisma.subscription.findUniqueOrThrow({
    where: { id: subscription.id },
  });
  assert.equal(afterFailure.status, "ACTIVE");
  assert.equal(afterFailure.canceledAt, null);

  await cancelSubscription(
    {
      subscriptionId: subscription.id,
      appId: fixture.app.id,
    },
    {
      cancelShopifySubscription: async () => ({ status: "CANCELLED" }),
    },
  );
  const afterSuccess = await prisma.subscription.findUniqueOrThrow({
    where: { id: subscription.id },
  });
  assert.equal(afterSuccess.status, "CANCELLED");
  assert.ok(afterSuccess.canceledAt);
});

test("APP_CREDITS charges list price and issues a separate credit", async (t) => {
  const fixture = await createFixture(t, "app-credit");
  const previousPeriodStart = new Date("2025-12-01T00:00:00.000Z");
  const nextPeriodStart = new Date("2026-01-01T00:00:00.000Z");
  const subscription = await prisma.subscription.create({
    data: {
      appInstallId: fixture.install.id,
      planId: fixture.monthlyPlan.id,
      status: "ACTIVE",
      activatedAt: previousPeriodStart,
      currentPeriodStart: previousPeriodStart,
      currentPeriodEnd: nextPeriodStart,
      nextBillingDate: nextPeriodStart,
      billingCycleAnchor: previousPeriodStart,
    },
  });
  const line = await prisma.subscriptionLineItem.create({
    data: {
      subscriptionId: subscription.id,
      type: "USAGE",
      platformId: "gid://shopify/AppSubscriptionLineItem/app-credit",
      cappedAmount: "100",
      spendPeriodStart: previousPeriodStart,
    },
  });
  await prisma.subscription.update({
    where: { id: subscription.id },
    data: { usageLineItemId: line.id },
  });
  const discount = await prisma.discount.create({
    data: {
      appId: fixture.app.id,
      organizationId: fixture.organization.id,
      apps: { create: { appId: fixture.app.id } },
      planId: fixture.monthlyPlan.id,
      code: "CREDIT20",
      normalizedCode: "CREDIT20",
      orgCodeKey: "CREDIT20",
      type: "PERCENTAGE",
      value: "20",
      discountMethod: "APP_CREDITS",
    },
  });
  await attachDiscountToSubscription({
    subscriptionId: subscription.id,
    discountId: discount.id,
    startsAt: nextPeriodStart,
  });

  const postedAmounts: string[] = [];
  const creditedDiscounts: string[] = [];
  const result = await checkFlexBillingSubscription(subscription.id, false, {
    assertAppCreditReady: () => undefined,
    createUsageRecord: async (_app, _install, params) => {
      postedAmounts.push(params.amount.toString());
      return {
        status: "created",
        id: "gid://shopify/AppUsageRecord/app-credit",
        balanceUsed: null,
        cappedAmount: null,
      };
    },
    createAppCredit: async (_ctx, appliedDiscount) => {
      creditedDiscounts.push(appliedDiscount.id);
      return { created: true, amount: appliedDiscount.value };
    },
  });

  assert.equal(result.charged, true);
  assert.deepEqual(postedAmounts, ["20"]);
  assert.deepEqual(creditedDiscounts, [discount.id]);
  const charge = await prisma.charge.findFirstOrThrow({
    where: { subscriptionId: subscription.id, isCredit: false },
  });
  assert.equal(charge.amount.toString(), "20");
});

test("a 100%-off period advances locally without posting a Shopify usage record", async (t) => {
  const fixture = await createFixture(t, "zero-charge");
  const periodStart = new Date("2025-12-01T00:00:00.000Z");
  const nextPeriodStart = new Date("2026-01-01T00:00:00.000Z");
  const expectedPeriodEnd = new Date("2026-02-01T00:00:00.000Z");
  const subscription = await prisma.subscription.create({
    data: {
      appInstallId: fixture.install.id,
      planId: fixture.monthlyPlan.id,
      status: "ACTIVE",
      activatedAt: periodStart,
      currentPeriodStart: periodStart,
      currentPeriodEnd: nextPeriodStart,
      nextBillingDate: nextPeriodStart,
      billingCycleAnchor: periodStart,
      trialStartedAt: periodStart,
      trialEndsAt: nextPeriodStart,
    },
  });
  const line = await prisma.subscriptionLineItem.create({
    data: {
      subscriptionId: subscription.id,
      type: "USAGE",
      platformId: "gid://shopify/AppSubscriptionLineItem/zero",
      cappedAmount: "100",
      currentPeriodBilledSpend: "12",
      spendPeriodStart: periodStart,
    },
  });
  await prisma.subscription.update({
    where: { id: subscription.id },
    data: { usageLineItemId: line.id },
  });
  const discount = await prisma.discount.create({
    data: {
      appId: fixture.app.id,
      organizationId: fixture.organization.id,
      apps: { create: { appId: fixture.app.id } },
      planId: fixture.monthlyPlan.id,
      code: "FREE",
      normalizedCode: "FREE",
      orgCodeKey: "FREE",
      type: "PERCENTAGE",
      value: "100",
      discountMethod: "PRICE_REDUCTION",
    },
  });
  await attachDiscountToSubscription({
    subscriptionId: subscription.id,
    discountId: discount.id,
    startsAt: nextPeriodStart,
  });

  let usageRecordCalls = 0;
  const result = await checkFlexBillingSubscription(subscription.id, false, {
    createUsageRecord: async () => {
      usageRecordCalls += 1;
      throw new Error("Shopify should not be called for a zero amount");
    },
  });

  assert.deepEqual(result, {
    charged: false,
    reason: "zero_amount_rollover",
  });
  assert.equal(usageRecordCalls, 0);
  assert.equal(
    await prisma.charge.count({ where: { subscriptionId: subscription.id } }),
    0,
  );
  const afterCharge = await prisma.subscription.findUniqueOrThrow({
    where: { id: subscription.id },
  });
  assert.equal(
    afterCharge.currentPeriodStart?.toISOString(),
    nextPeriodStart.toISOString(),
  );
  assert.equal(
    afterCharge.currentPeriodEnd?.toISOString(),
    expectedPeriodEnd.toISOString(),
  );
  assert.equal(
    afterCharge.nextBillingDate?.toISOString(),
    expectedPeriodEnd.toISOString(),
  );
  assert.equal(
    afterCharge.trialStartedAt?.toISOString(),
    periodStart.toISOString(),
  );
  assert.equal(
    afterCharge.trialEndsAt?.toISOString(),
    nextPeriodStart.toISOString(),
  );
  const lineAfter = await prisma.subscriptionLineItem.findUniqueOrThrow({
    where: { id: line.id },
  });
  assert.equal(lineAfter.currentPeriodBilledSpend.toString(), "0");
  assert.equal(
    lineAfter.spendPeriodStart?.toISOString(),
    nextPeriodStart.toISOString(),
  );
});

test("collectOutstanding can run under the tier-change lock without re-entering it", async (t) => {
  const fixture = await createFixture(t, "held-lock");
  const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000);
  const subscription = await prisma.subscription.create({
    data: {
      appInstallId: fixture.install.id,
      planId: fixture.monthlyPlan.id,
      status: "ACTIVE",
      activatedAt: new Date(),
      currentPeriodStart: new Date(),
      currentPeriodEnd: future,
      nextBillingDate: future,
    },
  });
  const key = lockKey(fixture.organization.id, subscription.id);

  let timeout: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      withLock(key, () =>
        collectOutstandingFlexBillingCharges(subscription.id, {
          lockAlreadyHeld: true,
          dependencies: {
            createUsageRecord: async () => {
              throw new Error("Shopify should not be called");
            },
          },
        }),
      ),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () =>
            reject(new Error("collectOutstanding re-entered its held lock")),
          2_000,
        );
      }),
    ]);
    assert.deepEqual(result, {
      charged: false,
      reason: "billing_date_in_future",
    });
  } finally {
    if (timeout) clearTimeout(timeout);
  }
});

test("an expired lock holder cannot release its successor's lease", async (t) => {
  const fixture = await createFixture(t, "lock-owner");
  const key = lockKey(fixture.organization.id, "lease-owner");
  const delay = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

  let firstEnteredResolve!: () => void;
  const firstEntered = new Promise<void>((resolve) => {
    firstEnteredResolve = resolve;
  });
  const first = withLock(
    key,
    async () => {
      firstEnteredResolve();
      await delay(90);
    },
    { ttlMs: 40, waitMs: 500, pollMs: 5 },
  );
  await firstEntered;
  await delay(55);

  let secondEnteredResolve!: () => void;
  const secondEntered = new Promise<void>((resolve) => {
    secondEnteredResolve = resolve;
  });
  let releaseSecond!: () => void;
  const holdSecond = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  const second = withLock(
    key,
    async () => {
      secondEnteredResolve();
      await holdSecond;
    },
    { ttlMs: 1_000, waitMs: 500, pollMs: 5 },
  );
  await secondEntered;
  await first;

  assert.ok(
    await prisma.flexLock.findUnique({ where: { key } }),
    "the first holder must not delete the second holder's lease",
  );
  releaseSecond();
  await second;
  assert.equal(await prisma.flexLock.findUnique({ where: { key } }), null);
});

test("metered usage retries are counted exactly once", async (t) => {
  const fixture = await createFixture(t, "usage-idempotency");
  const idempotencyKey = `usage:${randomUUID()}`;

  const first = await ingestUsage({
    appInstallId: fixture.install.id,
    metric: "orders",
    quantity: "3",
    idempotencyKey,
  });
  const retry = await ingestUsage({
    appInstallId: fixture.install.id,
    metric: "orders",
    quantity: "3",
    idempotencyKey,
  });

  assert.deepEqual(first, {
    recorded: true,
    deduplicated: false,
    upgraded: false,
  });
  assert.deepEqual(retry, {
    recorded: false,
    deduplicated: true,
    upgraded: false,
  });
  assert.equal(
    await prisma.usageEvent.count({
      where: { appInstallId: fixture.install.id, metric: "orders" },
    }),
    1,
  );
});
