import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, type TestContext } from "node:test";
import { Prisma } from "../generated/prisma/client";
import { prisma } from "../app/lib/db.server";
import {
  historiesFromFacts,
  resolveOfferCadencePins,
} from "../app/lib/shopify/partner-mrr.server";

/**
 * `resolveOfferCadencePins` is the fix for a real production bug: the
 * cross-charge cadence/amount inference `historiesFromFacts` has always
 * needed for charges lacking their own explicit `billingInterval` used to
 * recompute a majority-vote/median live, from whatever sales existed at call
 * time — so an old charge's inferred value could silently change weeks
 * later, purely because sibling charges' new data shifted the aggregate.
 * These tests prove the fix: pin once, on first need, and never recompute —
 * even after the evidence that would have produced a *different* answer
 * shows up later.
 */

function id(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}`;
}

async function cleanupApp(appId: string, organizationId: string): Promise<void> {
  await prisma.partnerOfferCadenceInference.deleteMany({ where: { appId } });
  await prisma.partnerSubscriptionEvent.deleteMany({ where: { appId } });
  await prisma.partnerSubscriptionSaleFact.deleteMany({ where: { appId } });
  await prisma.app.deleteMany({ where: { id: appId } });
  await prisma.organization.deleteMany({ where: { id: organizationId } });
}

async function fixtureApp(t: TestContext): Promise<string> {
  const suffix = id("offer-cadence-pin");
  const organization = await prisma.organization.create({
    data: { name: `Offer cadence pin ${suffix}` },
  });
  const app = await prisma.app.create({
    data: {
      organizationId: organization.id,
      name: `Offer cadence pin app ${suffix}`,
      handle: `offer-cadence-pin-${suffix}`,
      shopifyApiKey: `key-${suffix}`,
      shopifyApiSecret: `secret-${suffix}`,
    },
  });
  t.after(() => cleanupApp(app.id, organization.id));
  return app.id;
}

after(async () => {
  await prisma.$disconnect();
});

function event(appId: string, params: {
  charge: string;
  type: string;
  at: string;
  amount: string;
  chargeName?: string;
}) {
  return {
    appId,
    type: params.type,
    occurredAt: new Date(params.at),
    shopDomain: `${params.charge}.myshopify.com`,
    chargePlatformId: params.charge,
    chargeName: params.chargeName ?? "Pro Plan",
    amount: new Prisma.Decimal(params.amount),
    currencyCode: "USD",
    billingOn: null,
    test: false,
  };
}

function sale(params: {
  appId: string;
  charge: string;
  at: string;
  interval: "EVERY_30_DAYS" | "ANNUAL";
  amount: string;
}) {
  return {
    appId: params.appId,
    chargePlatformId: params.charge,
    occurredAt: new Date(params.at),
    billingInterval: params.interval,
    grossAmount: new Prisma.Decimal(params.amount),
    currencyCode: "USD",
  };
}

test("a charge with its own explicit sale interval never consults a pin", async (t) => {
  const appId = await fixtureApp(t);
  const events = [
    event(appId, { charge: "c1", type: "SUBSCRIPTION_CHARGE_ACTIVATED", at: "2026-01-01T00:00:00.000Z", amount: "29" }),
  ];
  const sales = [
    sale({ appId, charge: "c1", at: "2026-01-01T00:00:00.000Z", interval: "ANNUAL", amount: "29" }),
  ];
  const pins = await resolveOfferCadencePins(events, sales);
  assert.equal(pins.size, 0, "no pin needed — the charge has its own explicit interval");

  const histories = historiesFromFacts(events, sales, pins);
  assert.equal(histories[0]!.inferredInterval, null);
  assert.equal(histories[0]!.inferredEffectiveAmount, null);

  const persisted = await prisma.partnerOfferCadenceInference.count({ where: { appId } });
  assert.equal(persisted, 0, "nothing should ever be written for an offer that needed no inference");
});

test("a charge lacking explicit interval data gets a pin computed and persisted", async (t) => {
  const appId = await fixtureApp(t);
  const events = [
    // c1 has its own explicit annual sale — the evidence source.
    event(appId, { charge: "c1", type: "SUBSCRIPTION_CHARGE_ACTIVATED", at: "2026-01-01T00:00:00.000Z", amount: "29" }),
    // c2 shares the same offer (name + amount) but never got an explicit interval.
    event(appId, { charge: "c2", type: "SUBSCRIPTION_CHARGE_ACTIVATED", at: "2026-01-05T00:00:00.000Z", amount: "29" }),
  ];
  const sales = [
    sale({ appId, charge: "c1", at: "2026-01-01T00:00:00.000Z", interval: "ANNUAL", amount: "29" }),
  ];

  const pins = await resolveOfferCadencePins(events, sales);
  const histories = historiesFromFacts(events, sales, pins);
  const c2 = histories.find((h) => h.chargePlatformId === "c2")!;
  assert.equal(c2.inferredInterval, "ANNUAL");
  assert.equal(c2.inferredEffectiveAmount, 29);

  const row = await prisma.partnerOfferCadenceInference.findUnique({
    where: { appId_chargeName_amount: { appId, chargeName: "pro plan", amount: new Prisma.Decimal("29.000000") } },
  });
  assert.ok(row, "the pin must be persisted, not just returned for this one call");
  assert.equal(row!.interval, "ANNUAL");
});

test("once pinned, new sibling-charge evidence that would flip the answer does NOT change it — the core regression test", async (t) => {
  const appId = await fixtureApp(t);

  // Round 1: one annual charge with explicit data, one charge needing inference.
  const firstEvents = [
    event(appId, { charge: "c1", type: "SUBSCRIPTION_CHARGE_ACTIVATED", at: "2026-01-01T00:00:00.000Z", amount: "29" }),
    event(appId, { charge: "c2", type: "SUBSCRIPTION_CHARGE_ACTIVATED", at: "2026-01-05T00:00:00.000Z", amount: "29" }),
  ];
  const firstSales = [
    sale({ appId, charge: "c1", at: "2026-01-01T00:00:00.000Z", interval: "ANNUAL", amount: "29" }),
  ];
  const firstPins = await resolveOfferCadencePins(firstEvents, firstSales);
  const firstHistories = historiesFromFacts(firstEvents, firstSales, firstPins);
  assert.equal(firstHistories.find((h) => h.chargePlatformId === "c2")!.inferredInterval, "ANNUAL");

  // Round 2 (weeks later, in the real bug): FOUR new monthly charges with
  // their own explicit sales settle for the same offer — enough to flip a
  // freshly-recomputed majority vote to EVERY_30_DAYS. c2 was never touched.
  const laterEvents = [
    ...firstEvents,
    event(appId, { charge: "c3", type: "SUBSCRIPTION_CHARGE_ACTIVATED", at: "2026-02-01T00:00:00.000Z", amount: "29" }),
    event(appId, { charge: "c4", type: "SUBSCRIPTION_CHARGE_ACTIVATED", at: "2026-02-02T00:00:00.000Z", amount: "29" }),
    event(appId, { charge: "c5", type: "SUBSCRIPTION_CHARGE_ACTIVATED", at: "2026-02-03T00:00:00.000Z", amount: "29" }),
    event(appId, { charge: "c6", type: "SUBSCRIPTION_CHARGE_ACTIVATED", at: "2026-02-04T00:00:00.000Z", amount: "29" }),
  ];
  const laterSales = [
    ...firstSales,
    sale({ appId, charge: "c3", at: "2026-02-01T00:00:00.000Z", interval: "EVERY_30_DAYS", amount: "29" }),
    sale({ appId, charge: "c4", at: "2026-02-02T00:00:00.000Z", interval: "EVERY_30_DAYS", amount: "29" }),
    sale({ appId, charge: "c5", at: "2026-02-03T00:00:00.000Z", interval: "EVERY_30_DAYS", amount: "29" }),
    sale({ appId, charge: "c6", at: "2026-02-04T00:00:00.000Z", interval: "EVERY_30_DAYS", amount: "29" }),
  ];

  // Sanity check: recomputing the OLD way (no pins) with this later evidence
  // really would flip the vote — proving this test exercises the actual bug,
  // not a scenario that never diverges.
  const unpinnedHistories = historiesFromFacts(laterEvents, laterSales);
  assert.equal(
    unpinnedHistories.find((h) => h.chargePlatformId === "c2")!.inferredInterval,
    "EVERY_30_DAYS",
    "sanity check: the old unpinned computation DOES flip with this new evidence",
  );

  // The actual fix: resolving pins again picks up c2's ALREADY-PERSISTED
  // pin and leaves it exactly as first resolved.
  const laterPins = await resolveOfferCadencePins(laterEvents, laterSales);
  const laterHistories = historiesFromFacts(laterEvents, laterSales, laterPins);
  assert.equal(
    laterHistories.find((h) => h.chargePlatformId === "c2")!.inferredInterval,
    "ANNUAL",
    "the pinned value must stay ANNUAL — new sibling evidence must never retroactively change it",
  );

  const pinCount = await prisma.partnerOfferCadenceInference.count({ where: { appId } });
  assert.equal(pinCount, 1, "still exactly one pin row for this one offer, not rewritten");
});

test("an offer with zero resolved evidence anywhere is left unpinned, not pinned to null forever", async (t) => {
  const appId = await fixtureApp(t);
  const events = [
    event(appId, { charge: "c1", type: "SUBSCRIPTION_CHARGE_ACTIVATED", at: "2026-01-01T00:00:00.000Z", amount: "15", chargeName: "Mystery Plan" }),
  ];
  const sales: ReturnType<typeof sale>[] = [];

  const pins = await resolveOfferCadencePins(events, sales);
  assert.equal(pins.size, 0);

  const persisted = await prisma.partnerOfferCadenceInference.count({ where: { appId } });
  assert.equal(persisted, 0, "no evidence anywhere yet — must not persist a permanent null pin");

  const histories = historiesFromFacts(events, sales, pins);
  // No pin, no name pattern, no billingOn distance evidence — historiesFromFacts's
  // own fallback chain (name-pattern -> billingOn-distance -> default) is
  // exercised downstream by contributionAt, unaffected by this change.
  assert.equal(histories[0]!.inferredInterval, null);
});

test("resolving pins twice in a row for the same offer only ever creates one row", async (t) => {
  const appId = await fixtureApp(t);
  const events = [
    event(appId, { charge: "c1", type: "SUBSCRIPTION_CHARGE_ACTIVATED", at: "2026-01-01T00:00:00.000Z", amount: "9.99" }),
    event(appId, { charge: "c2", type: "SUBSCRIPTION_CHARGE_ACTIVATED", at: "2026-01-02T00:00:00.000Z", amount: "9.99" }),
  ];
  const sales = [
    sale({ appId, charge: "c1", at: "2026-01-01T00:00:00.000Z", interval: "EVERY_30_DAYS", amount: "9.99" }),
  ];

  await resolveOfferCadencePins(events, sales);
  await resolveOfferCadencePins(events, sales);
  const count = await prisma.partnerOfferCadenceInference.count({ where: { appId } });
  assert.equal(count, 1);
});
