import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "../generated/prisma/client";
import {
  contributionAt,
  historiesFromFacts,
  nativeDiscountChargesFromHistories,
  unverifiedChargePricesFromHistories,
  type EventFact,
} from "../app/lib/shopify/partner-mrr.server";

const NOW = new Date("2026-09-25T12:00:00Z");
const CHARGE = "gid://partners/AppSubscriptionCharge/123";
function event(overrides: Partial<EventFact> = {}): EventFact {
  return {
    appId: "app-1",
    shopDomain: "example.myshopify.com",
    chargePlatformId: CHARGE,
    chargeName: "Monthly",
    type: "SUBSCRIPTION_CHARGE_ACTIVATED",
    occurredAt: new Date("2026-08-01T00:00:00Z"),
    billingOn: new Date("2026-08-08T00:00:00Z"),
    amount: new Prisma.Decimal(29),
    currencyCode: "USD",
    test: false,
    ...overrides,
  };
}
const redemption = {
  appId: "app-1",
  shopDomain: "example.myshopify.com",
  shopifySubscriptionId: "gid://shopify/AppSubscription/123",
};

test("a zeroed monthly charge is checked before the 60-day stale threshold", () => {
  const histories = historiesFromFacts([event()], []);
  assert.equal(contributionAt(histories[0], NOW)?.amount, 0);
  assert.equal(unverifiedChargePricesFromHistories(histories, NOW).length, 1);

  histories[0].liveDiscountEffectiveAmount = 23.2;
  assert.equal(contributionAt(histories[0], NOW)?.amount, 23.2);
  assert.equal(unverifiedChargePricesFromHistories(histories, NOW).length, 0);
});

test("a zeroed annual charge is eligible even though the stale selector skips annual plans", () => {
  const histories = historiesFromFacts([event({
    chargeName: "Annual",
    amount: new Prisma.Decimal(240),
    occurredAt: new Date("2026-06-01T00:00:00Z"),
    billingOn: new Date("2026-06-08T00:00:00Z"),
  })], []);
  assert.equal(contributionAt(histories[0], NOW)?.amount, 0);
  assert.equal(unverifiedChargePricesFromHistories(histories, NOW).length, 1);
  histories[0].liveDiscountEffectiveAmount = 20;
  assert.equal(contributionAt(histories[0], NOW)?.amount, 20);
});

test("a verified free price is not treated as an unknown price", () => {
  const histories = historiesFromFacts([event()], []);
  histories[0].liveDiscountEffectiveAmount = 0;
  assert.equal(unverifiedChargePricesFromHistories(histories, NOW).length, 0);
});

test("a new native discount without a trial or sale is selected by exact subscription", () => {
  const histories = historiesFromFacts([event({
    occurredAt: new Date("2026-09-24T00:00:00Z"),
    billingOn: null,
  })], []);
  assert.equal(contributionAt(histories[0], NOW)?.kind, "monthly");
  assert.equal(contributionAt(histories[0], NOW)?.amount, 29);
  assert.equal(unverifiedChargePricesFromHistories(histories, NOW).length, 1);
  assert.deepEqual(nativeDiscountChargesFromHistories(histories, [redemption], NOW), [
    { shopDomain: redemption.shopDomain, chargePlatformId: CHARGE },
  ]);
});

test("native discount evidence cannot select another charge, app, or shop", () => {
  const histories = historiesFromFacts([event()], []);
  for (const mismatch of [
    { ...redemption, shopifySubscriptionId: "gid://shopify/AppSubscription/456" },
    { ...redemption, shopifySubscriptionId: null },
    { ...redemption, appId: "app-2" },
    { ...redemption, shopDomain: "other.myshopify.com" },
  ]) {
    assert.deepEqual(nativeDiscountChargesFromHistories(histories, [mismatch], NOW), []);
  }
});

test("canceled, frozen, test, and live-confirmed inactive charges stay excluded", () => {
  const canceled = historiesFromFacts([event(), event({
    type: "SUBSCRIPTION_CHARGE_CANCELED",
    occurredAt: new Date("2026-09-20T00:00:00Z"),
  })], []);
  const frozen = historiesFromFacts([event(), event({
    type: "SUBSCRIPTION_CHARGE_FROZEN",
    occurredAt: new Date("2026-09-20T00:00:00Z"),
  })], []);
  const testCharge = historiesFromFacts([event({ test: true })], []);
  const inactive = historiesFromFacts([event()], []);
  inactive[0].liveSubscriptionInactiveSince = new Date("2026-09-20T00:00:00Z");
  for (const histories of [canceled, frozen, testCharge, inactive]) {
    assert.deepEqual(unverifiedChargePricesFromHistories(histories, NOW), []);
    assert.deepEqual(nativeDiscountChargesFromHistories(histories, [redemption], NOW), []);
  }
});

test("a recorded sale ends the unverified-price check; a future sale does not", () => {
  const histories = historiesFromFacts([event()], [{
    appId: "app-1",
    chargePlatformId: CHARGE,
    occurredAt: new Date("2026-09-26T00:00:00Z"),
    billingInterval: "EVERY_30_DAYS",
    grossAmount: new Prisma.Decimal(29),
    currencyCode: "USD",
  }]);
  assert.equal(unverifiedChargePricesFromHistories(histories, NOW).length, 1);
  assert.equal(unverifiedChargePricesFromHistories(histories, new Date("2026-09-27T00:00:00Z")).length, 0);
});
