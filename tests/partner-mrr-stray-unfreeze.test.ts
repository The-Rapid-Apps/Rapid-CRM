import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "../generated/prisma/client";
import { chargeKey, contributionAt, historiesFromFacts } from "../app/lib/shopify/partner-mrr.server";

/**
 * Covers a real bug found and fixed 2026-09-01, confirmed against live
 * Shopify Partner API data (24/36 and 4/5 sampled "ghost" charges across two
 * apps): a stray SUBSCRIPTION_CHARGE_FROZEN -> SUBSCRIPTION_CHARGE_UNFROZEN
 * pair arriving *after* a real SUBSCRIPTION_CHARGE_CANCELED made an
 * already-dead charge look active again — `contributionAt` used to check
 * only whichever event was chronologically last, with no memory of what
 * came before it.
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

test("a stray FROZEN/UNFROZEN pair after CANCELED does not revive the charge", () => {
  const events = [
    event({ charge: "c1", type: "SUBSCRIPTION_CHARGE_ACTIVATED", at: "2026-01-01T00:00:00.000Z", amount: "29" }),
    event({ charge: "c1", type: "SUBSCRIPTION_CHARGE_CANCELED", at: "2026-02-01T00:00:00.000Z", amount: "29" }),
    event({ charge: "c1", type: "SUBSCRIPTION_CHARGE_FROZEN", at: "2026-03-01T00:00:00.000Z", amount: "29" }),
    event({ charge: "c1", type: "SUBSCRIPTION_CHARGE_UNFROZEN", at: "2026-03-02T00:00:00.000Z", amount: "29" }),
  ];
  const histories = historiesFromFacts(events, []);
  const contribution = contributionAt(histories[0], new Date("2026-06-01T00:00:00.000Z"));

  assert.equal(contribution, null, "the charge stays dead — a stray unfreeze after cancellation is not a reactivation");
});

test("an ordinary FROZEN/UNFROZEN with no prior cancellation still reactivates normally", () => {
  const events = [
    event({ charge: "c1", type: "SUBSCRIPTION_CHARGE_ACTIVATED", at: "2026-01-01T00:00:00.000Z", amount: "29" }),
    event({ charge: "c1", type: "SUBSCRIPTION_CHARGE_FROZEN", at: "2026-02-01T00:00:00.000Z", amount: "29" }),
    event({ charge: "c1", type: "SUBSCRIPTION_CHARGE_UNFROZEN", at: "2026-02-05T00:00:00.000Z", amount: "29" }),
  ];
  const histories = historiesFromFacts(events, []);
  const contribution = contributionAt(histories[0], new Date("2026-06-01T00:00:00.000Z"));

  assert.equal(contribution?.amount, 29, "a genuine payment-retry freeze/unfreeze on an active charge still works");
});

test("a charge currently frozen (no unfreeze yet) contributes nothing", () => {
  const events = [
    event({ charge: "c1", type: "SUBSCRIPTION_CHARGE_ACTIVATED", at: "2026-01-01T00:00:00.000Z", amount: "29" }),
    event({ charge: "c1", type: "SUBSCRIPTION_CHARGE_FROZEN", at: "2026-02-01T00:00:00.000Z", amount: "29" }),
  ];
  const histories = historiesFromFacts(events, []);
  const contribution = contributionAt(histories[0], new Date("2026-06-01T00:00:00.000Z"));

  assert.equal(contribution, null, "still frozen, not yet unfrozen — no contribution, same as before this fix");
});

test("a genuine re-ACTIVATED after the stray pair revives the charge for real", () => {
  const events = [
    event({ charge: "c1", type: "SUBSCRIPTION_CHARGE_ACTIVATED", at: "2026-01-01T00:00:00.000Z", amount: "29" }),
    event({ charge: "c1", type: "SUBSCRIPTION_CHARGE_CANCELED", at: "2026-02-01T00:00:00.000Z", amount: "29" }),
    event({ charge: "c1", type: "SUBSCRIPTION_CHARGE_FROZEN", at: "2026-03-01T00:00:00.000Z", amount: "29" }),
    event({ charge: "c1", type: "SUBSCRIPTION_CHARGE_UNFROZEN", at: "2026-03-02T00:00:00.000Z", amount: "29" }),
    event({ charge: "c1", type: "SUBSCRIPTION_CHARGE_ACTIVATED", at: "2026-04-01T00:00:00.000Z", amount: "39" }),
  ];
  const histories = historiesFromFacts(events, []);
  const contribution = contributionAt(histories[0], new Date("2026-06-01T00:00:00.000Z"));

  assert.equal(contribution?.amount, 39, "a real new ACTIVATED after the stray pair is a genuine re-subscribe");
});

test("historiesFromFacts' terminal field agrees with contributionAt for the bug case", () => {
  const events = [
    event({ charge: "c1", type: "SUBSCRIPTION_CHARGE_ACTIVATED", at: "2026-01-01T00:00:00.000Z", amount: "29" }),
    event({ charge: "c1", type: "SUBSCRIPTION_CHARGE_CANCELED", at: "2026-02-01T00:00:00.000Z", amount: "29" }),
    event({ charge: "c1", type: "SUBSCRIPTION_CHARGE_FROZEN", at: "2026-03-01T00:00:00.000Z", amount: "29" }),
    event({ charge: "c1", type: "SUBSCRIPTION_CHARGE_UNFROZEN", at: "2026-03-02T00:00:00.000Z", amount: "29" }),
  ];
  const histories = historiesFromFacts(events, []);

  assert.equal(histories[0].terminal, true, "the final real state is dead, so this charge is correctly terminal");
});

test("historiesFromFacts' terminal field is false for a genuinely still-active charge", () => {
  const events = [
    event({ charge: "c1", type: "SUBSCRIPTION_CHARGE_ACTIVATED", at: "2026-01-01T00:00:00.000Z", amount: "29" }),
  ];
  const histories = historiesFromFacts(events, []);

  assert.equal(histories[0].terminal, false);
});

/**
 * Covers the live-subscription-status fallback added 2026-09-02: a charge
 * that's gone quiet with no terminal event at all can be resolved by a live
 * Shopify check instead of the local AccountLifecycleEvent data (confirmed
 * unsafe by real data — see the plan for why that approach was dropped).
 * The critical property under test is that this is never retroactive.
 */

test("a live-confirmed-inactive charge stops contributing from the check onward", () => {
  const events = [
    event({ charge: "c1", type: "SUBSCRIPTION_CHARGE_ACTIVATED", at: "2026-01-01T00:00:00.000Z", amount: "29" }),
  ];
  const liveDiscountChecks = new Map([
    [chargeKey("app-1", "c1"), { effectiveAmount: null, inactiveSince: new Date("2026-06-01T00:00:00.000Z"), trialEndsAt: null, trialEndKnown: false }],
  ]);
  const histories = historiesFromFacts(events, [], undefined, liveDiscountChecks);

  assert.equal(
    contributionAt(histories[0], new Date("2026-06-15T00:00:00.000Z")),
    null,
    "at or after the check, the charge is treated as dead",
  );
});

test("a live-confirmed-inactive charge does NOT rewrite history before the check", () => {
  const events = [
    event({ charge: "c1", type: "SUBSCRIPTION_CHARGE_ACTIVATED", at: "2026-01-01T00:00:00.000Z", amount: "29" }),
  ];
  const liveDiscountChecks = new Map([
    [chargeKey("app-1", "c1"), { effectiveAmount: null, inactiveSince: new Date("2026-06-01T00:00:00.000Z"), trialEndsAt: null, trialEndKnown: false }],
  ]);
  const histories = historiesFromFacts(events, [], undefined, liveDiscountChecks);

  const beforeCheck = contributionAt(histories[0], new Date("2026-03-01T00:00:00.000Z"));
  assert.equal(
    beforeCheck?.amount,
    29,
    "a historical bucket predating the live check must not be zeroed out — we don't know it was already dead that far back",
  );
});

test("a charge with no live check (or checked and still active) is unaffected", () => {
  const events = [
    event({ charge: "c1", type: "SUBSCRIPTION_CHARGE_ACTIVATED", at: "2026-01-01T00:00:00.000Z", amount: "29" }),
  ];
  const withoutMap = historiesFromFacts(events, []);
  const withNullInactive = historiesFromFacts(
    events,
    [],
    undefined,
    new Map([[chargeKey("app-1", "c1"), { effectiveAmount: null, inactiveSince: null, trialEndsAt: null, trialEndKnown: false }]]),
  );
  const at = new Date("2026-06-15T00:00:00.000Z");

  assert.equal(contributionAt(withoutMap[0], at)?.amount, 29);
  assert.equal(contributionAt(withNullInactive[0], at)?.amount, 29);
});
