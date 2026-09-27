import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, type TestContext } from "node:test";
import { prisma } from "../app/lib/db.server";
import {
  backfillCustomerStateFromInstalls,
  syncCustomerStateForInstall,
  upsertPartnerStateForCharges,
} from "../app/lib/shopify/partner-state-sync.server";

/**
 * Proves `upsertPartnerStateForCharges`'s per-charge `PartnerSubscriptionState`
 * and per-shop `PartnerCustomerState` rollup match subscriptions.tsx's/
 * customers.tsx's own existing live-reconstruction semantics — status
 * mapping, annual-to-monthly MRR normalization, the attention-count set
 * (FROZEN/DECLINED only, not CANCELLED/EXPIRED — a real narrowing in the
 * existing code, preserved deliberately, not "fixed"), and the multi-currency
 * tie-break (largest active-MRR currency wins; falls back to the lifetime-
 * sales currency when there's no active charge at all).
 */

function id(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}`;
}

function day(n: number): Date {
  return new Date(Date.UTC(2026, 0, 1 + n));
}

async function cleanupOrganization(organizationId: string): Promise<void> {
  const apps = await prisma.app.findMany({ where: { organizationId }, select: { id: true } });
  const appIds = apps.map((app) => app.id);
  if (appIds.length) {
    await prisma.partnerSubscriptionState.deleteMany({ where: { appId: { in: appIds } } });
    await prisma.partnerCustomerState.deleteMany({ where: { appId: { in: appIds } } });
    await prisma.partnerSubscriptionSaleFact.deleteMany({ where: { appId: { in: appIds } } });
    await prisma.partnerSubscriptionEvent.deleteMany({ where: { appId: { in: appIds } } });
    await prisma.appInstall.deleteMany({ where: { appId: { in: appIds } } });
    await prisma.app.deleteMany({ where: { id: { in: appIds } } });
  }
  await prisma.organization.deleteMany({ where: { id: organizationId } });
}

async function fixtureApp(t: TestContext): Promise<{ appId: string }> {
  const suffix = id("partner-state-sync");
  const organization = await prisma.organization.create({
    data: { name: `Partner state sync ${suffix}` },
  });
  t.after(() => cleanupOrganization(organization.id));
  const app = await prisma.app.create({
    data: {
      organizationId: organization.id,
      name: `Partner state sync app ${suffix}`,
      handle: `partner-state-sync-${suffix}`,
      shopifyApiKey: `key-${suffix}`,
      shopifyApiSecret: `secret-${suffix}`,
    },
  });
  return { appId: app.id };
}

async function seedEvent(
  appId: string,
  overrides: {
    chargePlatformId: string;
    type: string;
    occurredAt: Date;
    shopDomain: string;
    chargeName?: string;
    amount?: number;
    currencyCode?: string;
    billingOn?: Date | null;
    test?: boolean;
  },
): Promise<void> {
  await prisma.partnerSubscriptionEvent.create({
    data: {
      appId,
      dedupeKey: id("event"),
      chargeName: "Pro",
      amount: 30,
      currencyCode: "USD",
      billingOn: null,
      test: false,
      ...overrides,
    },
  });
}

async function seedSale(
  appId: string,
  overrides: {
    chargePlatformId: string;
    occurredAt: Date;
    billingInterval?: string | null;
    grossAmount?: number | null;
    currencyCode?: string | null;
    shopDomain?: string | null;
  },
): Promise<void> {
  await prisma.partnerSubscriptionSaleFact.create({
    data: {
      appId,
      transactionPlatformId: id("sale"),
      billingInterval: "EVERY_30_DAYS",
      grossAmount: 30,
      currencyCode: "USD",
      ...overrides,
    },
  });
}

after(async () => {
  await prisma.$disconnect();
});

test("active charge: status ACTIVE, monthly cadence not normalized", async (t) => {
  const { appId } = await fixtureApp(t);
  const chargeId = id("charge");
  await seedEvent(appId, {
    chargePlatformId: chargeId,
    type: "SUBSCRIPTION_CHARGE_ACTIVATED",
    occurredAt: day(0),
    shopDomain: "shop-a.myshopify.com",
    amount: 30,
  });
  await seedSale(appId, {
    chargePlatformId: chargeId,
    occurredAt: day(1),
    billingInterval: "EVERY_30_DAYS",
    grossAmount: 30,
  });

  await upsertPartnerStateForCharges(appId, [chargeId]);

  const state = await prisma.partnerSubscriptionState.findUniqueOrThrow({
    where: { appId_chargePlatformId: { appId, chargePlatformId: chargeId } },
  });
  assert.equal(state.status, "ACTIVE");
  assert.equal(Number(state.amount), 30);
  assert.equal(Number(state.approvedAmount), 30);
  assert.equal(state.billingInterval, "EVERY_30_DAYS");
});

test("annual charge: amount normalized to monthly for the customer rollup, approvedAmount stays raw", async (t) => {
  const { appId } = await fixtureApp(t);
  const chargeId = id("charge");
  await seedEvent(appId, {
    chargePlatformId: chargeId,
    type: "SUBSCRIPTION_CHARGE_ACTIVATED",
    occurredAt: day(0),
    shopDomain: "shop-annual.myshopify.com",
    amount: 360,
  });
  await seedSale(appId, {
    chargePlatformId: chargeId,
    occurredAt: day(1),
    billingInterval: "ANNUAL",
    grossAmount: 360,
  });

  await upsertPartnerStateForCharges(appId, [chargeId]);

  const state = await prisma.partnerSubscriptionState.findUniqueOrThrow({
    where: { appId_chargePlatformId: { appId, chargePlatformId: chargeId } },
  });
  assert.equal(Number(state.amount), 30, "360/12 = 30 monthly-normalized");
  assert.equal(Number(state.approvedAmount), 360, "approvedAmount stays the raw event amount");
});

test("frozen/canceled: status mapping and the attention-count narrowing (FROZEN/DECLINED only)", async (t) => {
  const { appId } = await fixtureApp(t);
  const frozenId = id("charge-frozen");
  const canceledId = id("charge-canceled");
  await seedEvent(appId, {
    chargePlatformId: frozenId,
    type: "SUBSCRIPTION_CHARGE_FROZEN",
    occurredAt: day(0),
    shopDomain: "shop-b.myshopify.com",
  });
  await seedEvent(appId, {
    chargePlatformId: canceledId,
    type: "SUBSCRIPTION_CHARGE_CANCELED",
    occurredAt: day(0),
    shopDomain: "shop-b.myshopify.com",
  });

  await upsertPartnerStateForCharges(appId, [frozenId, canceledId]);

  const frozen = await prisma.partnerSubscriptionState.findUniqueOrThrow({
    where: { appId_chargePlatformId: { appId, chargePlatformId: frozenId } },
  });
  const canceled = await prisma.partnerSubscriptionState.findUniqueOrThrow({
    where: { appId_chargePlatformId: { appId, chargePlatformId: canceledId } },
  });
  assert.equal(frozen.status, "FROZEN");
  assert.equal(canceled.status, "CANCELLED");

  const customer = await prisma.partnerCustomerState.findUniqueOrThrow({
    where: { appId_shopDomain: { appId, shopDomain: "shop-b.myshopify.com" } },
  });
  assert.equal(customer.activeChargeCount, 0);
  assert.equal(
    customer.attentionChargeCount,
    1,
    "only the FROZEN charge counts as attention — CANCELLED does not, matching customers.tsx's existing narrower set",
  );
});

test("customer rollup: mixed active+attention charges for one shop", async (t) => {
  const { appId } = await fixtureApp(t);
  const activeId = id("charge-active");
  const frozenId = id("charge-frozen");
  await seedEvent(appId, {
    chargePlatformId: activeId,
    type: "SUBSCRIPTION_CHARGE_ACTIVATED",
    occurredAt: day(0),
    shopDomain: "shop-c.myshopify.com",
    amount: 50,
  });
  await seedSale(appId, { chargePlatformId: activeId, occurredAt: day(1), grossAmount: 50 });
  await seedEvent(appId, {
    chargePlatformId: frozenId,
    type: "SUBSCRIPTION_CHARGE_FROZEN",
    occurredAt: day(2),
    shopDomain: "shop-c.myshopify.com",
  });

  await upsertPartnerStateForCharges(appId, [activeId, frozenId]);

  const customer = await prisma.partnerCustomerState.findUniqueOrThrow({
    where: { appId_shopDomain: { appId, shopDomain: "shop-c.myshopify.com" } },
  });
  assert.equal(customer.activeChargeCount, 1);
  assert.equal(customer.attentionChargeCount, 1);
  assert.equal(Number(customer.mrr), 50);
  assert.equal(customer.currencyCode, "USD");
});

test("a charge whose shopDomain changed over its lifetime (Shopify data redaction) rolls up under BOTH shops, matching customers.tsx's shop-scoped partition — not PartnerSubscriptionState's charge-scoped one", async (t) => {
  const { appId } = await fixtureApp(t);
  const chargeId = id("charge-redacted");
  // The charge started life under a real shop, then Shopify's own
  // data-redaction process (after that shop purged its data) reassigns
  // *later* events for the same still-existing charge to a placeholder
  // domain. Earlier raw events keep the real shop — raw facts are immutable.
  await seedEvent(appId, {
    chargePlatformId: chargeId,
    type: "SUBSCRIPTION_CHARGE_ACTIVATED",
    occurredAt: day(0),
    shopDomain: "original-shop.myshopify.com",
    amount: 10,
  });
  await seedEvent(appId, {
    chargePlatformId: chargeId,
    type: "SUBSCRIPTION_CHARGE_FROZEN",
    occurredAt: day(1),
    shopDomain: "original-shop.myshopify.com",
  });
  await seedEvent(appId, {
    chargePlatformId: chargeId,
    type: "SUBSCRIPTION_CHARGE_CANCELED",
    occurredAt: day(2),
    shopDomain: "REDACTED",
  });

  await upsertPartnerStateForCharges(appId, [chargeId]);

  // PartnerSubscriptionState is intentionally charge-scoped (matches
  // subscriptions.tsx) — the globally-latest event wins, attributing the
  // charge to REDACTED/CANCELLED.
  const state = await prisma.partnerSubscriptionState.findUniqueOrThrow({
    where: { appId_chargePlatformId: { appId, chargePlatformId: chargeId } },
  });
  assert.equal(state.shopDomain, "REDACTED");
  assert.equal(state.status, "CANCELLED");

  // But customers.tsx partitions per-shop, so the ORIGINAL shop's own latest
  // event (FROZEN) must still show up as an attention charge for that shop —
  // it must not be swallowed just because the charge later got reassigned.
  const originalShop = await prisma.partnerCustomerState.findUniqueOrThrow({
    where: {
      appId_shopDomain: { appId, shopDomain: "original-shop.myshopify.com" },
    },
  });
  assert.equal(originalShop.activeChargeCount, 0);
  assert.equal(originalShop.attentionChargeCount, 1);

  const redactedShop = await prisma.partnerCustomerState.findUniqueOrThrow({
    where: { appId_shopDomain: { appId, shopDomain: "REDACTED" } },
  });
  assert.equal(redactedShop.activeChargeCount, 0);
  assert.equal(redactedShop.attentionChargeCount, 0);
});

test("multi-currency tie-break: the currency with the larger active MRR total wins", async (t) => {
  const { appId } = await fixtureApp(t);
  const usdCharge = id("charge-usd");
  const eurCharge = id("charge-eur");
  await seedEvent(appId, {
    chargePlatformId: usdCharge,
    type: "SUBSCRIPTION_CHARGE_ACTIVATED",
    occurredAt: day(0),
    shopDomain: "shop-multi.myshopify.com",
    amount: 10,
    currencyCode: "USD",
  });
  await seedSale(appId, {
    chargePlatformId: usdCharge,
    occurredAt: day(1),
    grossAmount: 10,
    currencyCode: "USD",
  });
  await seedEvent(appId, {
    chargePlatformId: eurCharge,
    type: "SUBSCRIPTION_CHARGE_ACTIVATED",
    occurredAt: day(0),
    shopDomain: "shop-multi.myshopify.com",
    amount: 100,
    currencyCode: "EUR",
  });
  await seedSale(appId, {
    chargePlatformId: eurCharge,
    occurredAt: day(1),
    grossAmount: 100,
    currencyCode: "EUR",
  });

  await upsertPartnerStateForCharges(appId, [usdCharge, eurCharge]);

  const customer = await prisma.partnerCustomerState.findUniqueOrThrow({
    where: { appId_shopDomain: { appId, shopDomain: "shop-multi.myshopify.com" } },
  });
  assert.equal(customer.currencyCode, "EUR", "EUR has the larger active total (100 > 10)");
  assert.equal(Number(customer.mrr), 100);
});

test("no active charges: currency falls back to the lifetime-sales currency", async (t) => {
  const { appId } = await fixtureApp(t);
  const chargeId = id("charge-ended");
  await seedEvent(appId, {
    chargePlatformId: chargeId,
    type: "SUBSCRIPTION_CHARGE_EXPIRED",
    occurredAt: day(0),
    shopDomain: "shop-ended.myshopify.com",
  });
  await seedSale(appId, {
    chargePlatformId: chargeId,
    occurredAt: day(-1),
    grossAmount: 20,
    currencyCode: "GBP",
    shopDomain: "shop-ended.myshopify.com",
  });

  await upsertPartnerStateForCharges(appId, [chargeId]);

  const customer = await prisma.partnerCustomerState.findUniqueOrThrow({
    where: { appId_shopDomain: { appId, shopDomain: "shop-ended.myshopify.com" } },
  });
  assert.equal(customer.activeChargeCount, 0);
  assert.equal(Number(customer.mrr), 0);
  assert.equal(customer.currencyCode, "GBP");
  assert.equal(Number(customer.lifetimeValue), 20);
  assert.equal(customer.saleCount, 1);
});

test("oauthConnected reflects AppInstall's accessToken/uninstalledAt at write time", async (t) => {
  const { appId } = await fixtureApp(t);
  const chargeId = id("charge");
  const shopDomain = "shop-oauth.myshopify.com";
  await prisma.appInstall.create({
    data: { appId, shopDomain, installedAt: day(0), accessToken: "shpat_test" },
  });
  await seedEvent(appId, {
    chargePlatformId: chargeId,
    type: "SUBSCRIPTION_CHARGE_ACTIVATED",
    occurredAt: day(1),
    shopDomain,
  });

  await upsertPartnerStateForCharges(appId, [chargeId]);

  const customer = await prisma.partnerCustomerState.findUniqueOrThrow({
    where: { appId_shopDomain: { appId, shopDomain } },
  });
  assert.equal(customer.oauthConnected, true);
});

test("test charges never get a PartnerSubscriptionState row, matching the live query's `WHERE e.test = 0`", async (t) => {
  const { appId } = await fixtureApp(t);
  const testChargeId = id("charge-test");
  await seedEvent(appId, {
    chargePlatformId: testChargeId,
    type: "SUBSCRIPTION_CHARGE_ACTIVATED",
    occurredAt: day(0),
    shopDomain: "shop-dev.myshopify.com",
    test: true,
  });

  await upsertPartnerStateForCharges(appId, [testChargeId]);

  const state = await prisma.partnerSubscriptionState.findUnique({
    where: { appId_chargePlatformId: { appId, chargePlatformId: testChargeId } },
  });
  assert.equal(state, null, "a wholly-test charge must not produce a state row");

  const customer = await prisma.partnerCustomerState.findUnique({
    where: { appId_shopDomain: { appId, shopDomain: "shop-dev.myshopify.com" } },
  });
  assert.equal(customer, null, "no non-test activity for this shop means no customer row either");
});

test("install-only shop (installed, never subscribed) gets a PartnerCustomerState row via syncCustomerStateForInstall", async (t) => {
  const { appId } = await fixtureApp(t);
  const shopDomain = "install-only.myshopify.com";
  await prisma.appInstall.create({
    data: { appId, shopDomain, installedAt: day(0), accessToken: "shpat_test" },
  });

  // No PartnerSubscriptionEvent at all for this shop — matches customers.tsx's
  // live query, which treats a shop in app_installs alone as a customer too.
  await syncCustomerStateForInstall(appId, shopDomain);

  const customer = await prisma.partnerCustomerState.findUniqueOrThrow({
    where: { appId_shopDomain: { appId, shopDomain } },
  });
  assert.equal(customer.activeChargeCount, 0);
  assert.equal(customer.attentionChargeCount, 0);
  assert.equal(Number(customer.mrr), 0);
  assert.equal(Number(customer.lifetimeValue), 0);
  assert.equal(customer.saleCount, 0);
  assert.equal(customer.oauthConnected, true);
  assert.equal(customer.firstSeen.getTime(), day(0).getTime());
});

test("backfillCustomerStateFromInstalls discovers install-only shops the charge-keyed backfill never sees", async (t) => {
  const { appId } = await fixtureApp(t);
  const shopA = "backfill-a.myshopify.com";
  const shopB = "backfill-b.myshopify.com";
  await prisma.appInstall.create({ data: { appId, shopDomain: shopA, installedAt: day(0) } });
  await prisma.appInstall.create({ data: { appId, shopDomain: shopB, installedAt: day(1) } });

  const app = await prisma.app.findUniqueOrThrow({
    where: { id: appId },
    select: { id: true, partnerStateInstallBackfillCursor: true, partnerStateInstallBackfillCompletedAt: true },
  });
  const leaseToken = id("lease");
  await prisma.app.update({
    where: { id: appId },
    data: {
      billingSyncLeaseToken: leaseToken,
      billingSyncLeaseExpiresAt: new Date(Date.now() + 60_000),
    },
  });

  await backfillCustomerStateFromInstalls(app, leaseToken);

  const customers = await prisma.partnerCustomerState.findMany({
    where: { appId },
    orderBy: { shopDomain: "asc" },
  });
  assert.deepEqual(
    customers.map((c) => c.shopDomain),
    [shopA, shopB],
  );

  // Same two-phase pattern as backfillPartnerState: the first call processes
  // the chunk and advances the cursor; completion is only detected on the
  // NEXT call, once the cursor-bounded query itself returns zero rows.
  const afterFirstChunk = await prisma.app.findUniqueOrThrow({
    where: { id: appId },
    select: { id: true, partnerStateInstallBackfillCursor: true, partnerStateInstallBackfillCompletedAt: true },
  });
  await backfillCustomerStateFromInstalls(afterFirstChunk, leaseToken);

  const refreshed = await prisma.app.findUniqueOrThrow({
    where: { id: appId },
    select: { partnerStateInstallBackfillCompletedAt: true },
  });
  assert.ok(refreshed.partnerStateInstallBackfillCompletedAt, "the second call detects exhaustion and marks completion");
});
