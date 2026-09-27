import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, type TestContext } from "node:test";
import { prisma } from "../app/lib/db.server";
import {
  ApiRateLimitError,
  enforceAppRateLimit,
} from "../app/lib/api-rate-limit.server";
import {
  confirmNativeDiscountRedemption,
  releaseNativeDiscountRedemption,
  reserveNativeDiscount,
} from "../app/lib/native-discounts.server";
import { action as resolveAction } from "../app/routes/api/native-discount-resolve";

after(async () => {
  await prisma.$disconnect();
});

async function fixture(t: TestContext) {
  const suffix = randomUUID().slice(0, 8);
  const organization = await prisma.organization.create({
    data: { name: `Native discounts ${suffix}` },
  });
  const app = await prisma.app.create({
    data: {
      organizationId: organization.id,
      name: `Native app ${suffix}`,
      handle: `native-discounts-${suffix}`,
      shopifyApiKey: `shopify-${suffix}`,
      shopifyApiSecret: `secret-${suffix}`,
      apiKey: `native-api-${suffix}`,
    },
  });
  t.after(async () => {
    await prisma.discountRedemption.deleteMany({ where: { appId: app.id } });
    await prisma.discount.deleteMany({ where: { appId: app.id } });
    await prisma.apiRateLimitBucket.deleteMany({ where: { appId: app.id } });
    await prisma.app.deleteMany({ where: { id: app.id } });
    await prisma.organization.deleteMany({ where: { id: organization.id } });
  });
  return { organization, app, suffix };
}

function requestFor(
  appId: string,
  overrides: Partial<Parameters<typeof reserveNativeDiscount>[0]> = {},
) {
  return {
    appId,
    code: "SAVE20",
    shopDomain: "native-test.myshopify.com",
    externalPlanKey: "pro-monthly",
    listPrice: "100",
    currencyCode: "USD",
    idempotencyKey: randomUUID(),
    ...overrides,
  };
}

test("native percentage discounts return Shopify-ready values and are idempotent", async (t) => {
  const { app } = await fixture(t);
  await prisma.discount.create({
    data: {
      appId: app.id,
      organizationId: app.organizationId,
      apps: { create: { appId: app.id } },
      code: "SAVE20",
      normalizedCode: "SAVE20",
      orgCodeKey: "SAVE20",
      externalPlanKey: "pro-monthly",
      type: "PERCENTAGE",
      value: "20",
      durationIntervals: 3,
      maxRedemptionsPerShop: 1,
    },
  });
  const params = requestFor(app.id);
  const first = await reserveNativeDiscount(params);
  assert.equal(first.valid, true);
  if (!first.valid) return;
  assert.deepEqual(first.shopifyDiscount, {
    value: { percentage: 0.2 },
    durationLimitInIntervals: 3,
  });
  assert.equal(first.redemption.priceAfterDiscount.toFixed(2), "80.00");

  const retry = await reserveNativeDiscount(params);
  assert.equal(retry.valid, true);
  if (retry.valid) assert.equal(retry.redemption.id, first.redemption.id);

  const mismatch = await reserveNativeDiscount(
    requestFor(app.id, { externalPlanKey: "starter-monthly" }),
  );
  assert.deepEqual(mismatch, { valid: false, reason: "PLAN_MISMATCH" });
});

test("native fixed discounts enforce currency and release campaign capacity", async (t) => {
  const { app } = await fixture(t);
  await prisma.discount.create({
    data: {
      appId: app.id,
      organizationId: app.organizationId,
      apps: { create: { appId: app.id } },
      code: "SAVE20",
      normalizedCode: "SAVE20",
      orgCodeKey: "SAVE20",
      type: "AMOUNT",
      value: "25",
      currencyCode: "USD",
      maxRedemptions: 1,
    },
  });
  const wrongCurrency = await reserveNativeDiscount(
    requestFor(app.id, { currencyCode: "EUR" }),
  );
  assert.deepEqual(wrongCurrency, {
    valid: false,
    reason: "CURRENCY_MISMATCH",
  });

  const first = await reserveNativeDiscount(requestFor(app.id));
  assert.equal(first.valid, true);
  if (!first.valid) return;
  assert.deepEqual(first.shopifyDiscount, { value: { amount: "25.00" } });
  const exhausted = await reserveNativeDiscount(
    requestFor(app.id, { shopDomain: "another-shop.myshopify.com" }),
  );
  assert.deepEqual(exhausted, { valid: false, reason: "EXHAUSTED" });

  await releaseNativeDiscountRedemption({
    appId: app.id,
    redemptionId: first.redemption.id,
  });
  const afterRelease = await reserveNativeDiscount(
    requestFor(app.id, { shopDomain: "another-shop.myshopify.com" }),
  );
  assert.equal(afterRelease.valid, true);
});

test("redemption confirmation is idempotent and pins the Shopify subscription", async (t) => {
  const { app } = await fixture(t);
  await prisma.discount.create({
    data: {
      appId: app.id,
      organizationId: app.organizationId,
      apps: { create: { appId: app.id } },
      code: "SAVE20",
      normalizedCode: "SAVE20",
      orgCodeKey: "SAVE20",
      value: "10",
    },
  });
  const resolution = await reserveNativeDiscount(requestFor(app.id));
  assert.equal(resolution.valid, true);
  if (!resolution.valid) return;
  const shopifySubscriptionId = "gid://shopify/AppSubscription/123456";
  const confirmed = await confirmNativeDiscountRedemption({
    appId: app.id,
    redemptionId: resolution.redemption.id,
    shopifySubscriptionId,
  });
  assert.equal(confirmed.status, "APPLIED");
  assert.equal(confirmed.shopifySubscriptionId, shopifySubscriptionId);
  const retry = await confirmNativeDiscountRedemption({
    appId: app.id,
    redemptionId: resolution.redemption.id,
    shopifySubscriptionId,
  });
  assert.equal(retry.id, confirmed.id);
  await assert.rejects(
    releaseNativeDiscountRedemption({
      appId: app.id,
      redemptionId: confirmed.id,
    }),
    /already applied/i,
  );
});

test("native resolver authenticates, returns no-store responses, and limits callers", async (t) => {
  const { app, suffix } = await fixture(t);
  await prisma.discount.create({
    data: {
      appId: app.id,
      organizationId: app.organizationId,
      apps: { create: { appId: app.id } },
      code: "SAVE20",
      normalizedCode: "SAVE20",
      orgCodeKey: "SAVE20",
      value: "15",
    },
  });
  const response = await resolveAction({
    request: new Request("http://localhost/api/discounts/resolve", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${app.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `resolve-${suffix}`,
      },
      body: JSON.stringify({
        code: "save20",
        shopDomain: `${suffix}.myshopify.com`,
        externalPlanKey: "annual-pro",
        listPrice: "200",
        currencyCode: "usd",
      }),
    }),
    params: {},
    context: {},
  } as never);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const body = await response.json();
  assert.equal(body.valid, true);
  assert.equal(body.shopifyDiscount.value.percentage, 0.15);

  const now = new Date("2026-07-26T18:40:00.000Z");
  await enforceAppRateLimit({
    appId: app.id,
    routeKey: `test-${suffix}`,
    limit: 1,
    now,
  });
  await assert.rejects(
    enforceAppRateLimit({
      appId: app.id,
      routeKey: `test-${suffix}`,
      limit: 1,
      now,
    }),
    (error: unknown) =>
      error instanceof ApiRateLimitError && error.retryAfterSeconds === 60,
  );
});
