import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "../generated/prisma/client";
import {
  chargeKey,
  contributionAt,
  historiesFromFacts,
} from "../app/lib/shopify/partner-mrr.server";

/**
 * Covers three real bugs found and fixed 2026-08-31, confirmed against live
 * Shopify Partner API data — none of these branches had any prior automated
 * coverage:
 *
 * 1. A mid-cycle plan change's first sale is often a one-off prorated
 *    settle-up, not the real recurring rate — `contributionAt` used to trust
 *    it unconditionally.
 * 2. Two sale facts sharing the exact same `occurredAt` (a base charge and a
 *    proration adjustment, both stamped the same instant) used to resolve to
 *    whichever loaded last, not the larger (real) one.
 * 3. `shopHasPriorSale` used to be a permanent exemption from the
 *    never-billed grace period — a shop that paid anything, ever, stayed
 *    protected forever even after a later charge went genuinely, permanently
 *    silent (a live-confirmed $0 discount).
 */

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

function sale(params: { charge: string; at: string; grossAmount: string }) {
  return {
    appId: "app-1",
    chargePlatformId: params.charge,
    occurredAt: new Date(params.at),
    billingInterval: "EVERY_30_DAYS" as const,
    grossAmount: new Prisma.Decimal(params.grossAmount),
    currencyCode: "USD",
  };
}

const DAY_MS = 86_400_000;

test("an uncorroborated sale below the listed price is not trusted (proration, not a discount)", () => {
  // One plan-change charge, one low sale shortly after activation — exactly
  // the shape of a prorated partial-period settle-up, not a confirmed rate.
  const events = [
    event({
      charge: "pro",
      type: "SUBSCRIPTION_CHARGE_ACTIVATED",
      at: "2026-07-31T00:00:00.000Z",
      amount: "29",
      billingOn: "2026-08-23T00:00:00.000Z",
    }),
  ];
  const sales = [
    sale({ charge: "pro", at: "2026-08-17T00:00:00.000Z", grossAmount: "10.73" }),
  ];
  const histories = historiesFromFacts(events, sales);
  const contribution = contributionAt(histories[0], new Date("2026-08-25T00:00:00.000Z"));

  assert.equal(contribution?.amount, 29, "falls back to the listed price, not the lone low sale");
});

test("a second, corroborating sale at the same amount confirms it's a real recurring rate", () => {
  const events = [
    event({
      charge: "pro",
      type: "SUBSCRIPTION_CHARGE_ACTIVATED",
      at: "2026-07-31T00:00:00.000Z",
      amount: "29",
      billingOn: "2026-08-23T00:00:00.000Z",
    }),
  ];
  const sales = [
    sale({ charge: "pro", at: "2026-08-17T00:00:00.000Z", grossAmount: "20" }),
    sale({ charge: "pro", at: "2026-09-16T00:00:00.000Z", grossAmount: "20" }),
  ];
  const histories = historiesFromFacts(events, sales);
  const contribution = contributionAt(histories[0], new Date("2026-09-20T00:00:00.000Z"));

  assert.equal(contribution?.amount, 20, "a repeated discounted rate is trusted once confirmed");
});

test("a sale at or above the listed price is always trusted immediately, no corroboration needed", () => {
  const events = [
    event({
      charge: "starter",
      type: "SUBSCRIPTION_CHARGE_ACTIVATED",
      at: "2026-07-01T00:00:00.000Z",
      amount: "15",
    }),
  ];
  const sales = [
    sale({ charge: "starter", at: "2026-07-01T00:00:00.000Z", grossAmount: "15" }),
  ];
  const histories = historiesFromFacts(events, sales);
  const contribution = contributionAt(histories[0], new Date("2026-07-05T00:00:00.000Z"));

  assert.equal(contribution?.amount, 15, "the ordinary, unambiguous case is unaffected");
});

test("two sale facts at the identical instant resolve to the larger amount", () => {
  const events = [
    event({
      charge: "elite",
      type: "SUBSCRIPTION_CHARGE_ACTIVATED",
      at: "2026-08-02T00:00:00.000Z",
      amount: "59",
    }),
  ];
  const sales = [
    sale({ charge: "elite", at: "2026-08-12T13:05:56.000Z", grossAmount: "10" }),
    sale({ charge: "elite", at: "2026-08-12T13:05:56.000Z", grossAmount: "59" }),
  ];
  const histories = historiesFromFacts(events, sales);
  const contribution = contributionAt(histories[0], new Date("2026-08-15T00:00:00.000Z"));

  assert.equal(contribution?.amount, 59, "the larger of a same-instant pair wins, regardless of load order");
});

test("a plan-change shop is not zeroed inside the 90-day grace period", () => {
  const events = [
    event({
      charge: "starter",
      type: "SUBSCRIPTION_CHARGE_ACTIVATED",
      at: "2026-01-01T00:00:00.000Z",
      amount: "15",
      billingOn: "2026-01-08T00:00:00.000Z",
    }),
    event({
      charge: "starter",
      type: "SUBSCRIPTION_CHARGE_CANCELED",
      at: "2026-05-01T00:00:00.000Z",
      amount: "15",
    }),
    event({
      charge: "elite",
      type: "SUBSCRIPTION_CHARGE_ACTIVATED",
      at: "2026-05-01T00:00:00.000Z",
      amount: "59",
      billingOn: "2026-05-08T00:00:00.000Z",
      shop: "starter.myshopify.com",
    }),
  ];
  const sales = [
    sale({ charge: "starter", at: "2026-01-08T00:00:00.000Z", grossAmount: "15" }),
  ];
  const histories = historiesFromFacts(events, sales);
  const eliteHistory = histories.find((h) => h.chargePlatformId === "elite")!;
  assert.equal(eliteHistory.shopHasPriorSale, true);

  // 40 days past the elite charge's billingOn, still no sale on it — inside
  // the old 30-day window, but well within the new 90-day plan-change grace.
  const at40 = new Date(new Date("2026-05-08T00:00:00.000Z").getTime() + 40 * DAY_MS);
  const contribution40 = contributionAt(eliteHistory, at40);
  assert.equal(contribution40?.amount, 59, "still trusted within the 90-day plan-change grace period");
});

test("a plan-change shop IS zeroed once past the 90-day grace period with still no sale", () => {
  const events = [
    event({
      charge: "starter",
      type: "SUBSCRIPTION_CHARGE_ACTIVATED",
      at: "2026-01-01T00:00:00.000Z",
      amount: "15",
      billingOn: "2026-01-08T00:00:00.000Z",
    }),
    event({
      charge: "starter",
      type: "SUBSCRIPTION_CHARGE_CANCELED",
      at: "2026-05-01T00:00:00.000Z",
      amount: "15",
    }),
    event({
      charge: "elite",
      type: "SUBSCRIPTION_CHARGE_ACTIVATED",
      at: "2026-05-01T00:00:00.000Z",
      amount: "59",
      billingOn: "2026-05-08T00:00:00.000Z",
      shop: "starter.myshopify.com",
    }),
  ];
  const sales = [
    sale({ charge: "starter", at: "2026-01-08T00:00:00.000Z", grossAmount: "15" }),
  ];
  const histories = historiesFromFacts(events, sales);
  const eliteHistory = histories.find((h) => h.chargePlatformId === "elite")!;

  const at100 = new Date(new Date("2026-05-08T00:00:00.000Z").getTime() + 100 * DAY_MS);
  const contribution100 = contributionAt(eliteHistory, at100);
  assert.equal(contribution100?.amount, 0, "zeroed once genuinely past the longer grace period — a live-confirmed permanent discount, not a slow invoice");
});

/**
 * Covers the live-discount-check fallback added 2026-09-01: an ambiguous
 * charge (uncorroborated sale below listed price) can be resolved with a
 * persisted, confirmed-live discount instead of waiting for a second sale.
 */

test("an ambiguous charge with a persisted live-discount check uses it", () => {
  const events = [
    event({
      charge: "pro",
      type: "SUBSCRIPTION_CHARGE_ACTIVATED",
      at: "2026-07-31T00:00:00.000Z",
      amount: "29",
      billingOn: "2026-08-23T00:00:00.000Z",
    }),
  ];
  const sales = [
    sale({ charge: "pro", at: "2026-08-17T00:00:00.000Z", grossAmount: "23.20" }),
  ];
  const histories = historiesFromFacts(events, sales);
  const liveDiscountChecks = new Map([
    [chargeKey("app-1", "pro"), { effectiveAmount: 23.2, inactiveSince: null, trialEndsAt: null, trialEndKnown: false }],
  ]);
  const withLiveCheck = historiesFromFacts(events, sales, undefined, liveDiscountChecks);
  const contribution = contributionAt(withLiveCheck[0], new Date("2026-08-25T00:00:00.000Z"));

  assert.equal(
    contribution?.amount,
    23.2,
    "a confirmed live discount is trusted immediately, instead of defaulting to the listed price",
  );
});

test("an ambiguous charge with no persisted live-discount check falls back exactly as before", () => {
  const events = [
    event({
      charge: "pro",
      type: "SUBSCRIPTION_CHARGE_ACTIVATED",
      at: "2026-07-31T00:00:00.000Z",
      amount: "29",
      billingOn: "2026-08-23T00:00:00.000Z",
    }),
  ];
  const sales = [
    sale({ charge: "pro", at: "2026-08-17T00:00:00.000Z", grossAmount: "23.20" }),
  ];
  const withoutMap = historiesFromFacts(events, sales);
  const withEmptyMap = historiesFromFacts(events, sales, undefined, new Map());
  const at = new Date("2026-08-25T00:00:00.000Z");

  assert.equal(contributionAt(withoutMap[0], at)?.amount, 29, "no live-check map: same as before this feature existed");
  assert.equal(contributionAt(withEmptyMap[0], at)?.amount, 29, "an empty/no-match map behaves identically to no map at all");
});

test("a non-ambiguous charge ignores the live-discount-check map entirely", () => {
  const events = [
    event({
      charge: "starter",
      type: "SUBSCRIPTION_CHARGE_ACTIVATED",
      at: "2026-07-01T00:00:00.000Z",
      amount: "15",
    }),
  ];
  const sales = [
    sale({ charge: "starter", at: "2026-07-01T00:00:00.000Z", grossAmount: "15" }),
  ];
  // A deliberately wrong live-check value — if this were consulted, the
  // assertion below would fail. It must never be, since this sale already
  // matches the listed price (never ambiguous).
  const liveDiscountChecks = new Map([
    [chargeKey("app-1", "starter"), { effectiveAmount: 1, inactiveSince: null, trialEndsAt: null, trialEndKnown: false }],
  ]);
  const histories = historiesFromFacts(events, sales, undefined, liveDiscountChecks);
  const contribution = contributionAt(histories[0], new Date("2026-07-05T00:00:00.000Z"));

  assert.equal(contribution?.amount, 15, "an unambiguous sale is trusted directly, the live-check map is never consulted");
});
