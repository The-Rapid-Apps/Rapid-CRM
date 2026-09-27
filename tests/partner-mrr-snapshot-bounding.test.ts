import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, type TestContext } from "node:test";
import { prisma } from "../app/lib/db.server";
import { historiesFromFacts, contributionAt } from "../app/lib/shopify/partner-mrr.server";
import { loadTrailingAppFacts } from "../app/lib/shopify/partner-mrr-snapshot.server";

/**
 * Proves the "opening balance" bound in `loadTrailingAppFacts` doesn't lose
 * a charge that was activated long before the trailing window and has had no
 * events since — the exact case the bounding design has to get right, since
 * a naive "just fetch each charge's single latest pre-window event" bound
 * would still get *this* case right, but silently break `activatedAt`
 * (and therefore trial-window detection) for a charge with *multiple*
 * pre-window events where the true first ACTIVATED event isn't the latest
 * one. This fixture exercises the first, simpler case directly against a
 * real database (the query itself is real SQL, not something a pure-fixture
 * test can cover); the second case is exercised in
 * tests/partner-mrr.test.ts's pure `historiesFromFacts` fixtures instead.
 */

function id(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}`;
}

async function cleanupApp(appId: string, organizationId: string): Promise<void> {
  await prisma.partnerSubscriptionEvent.deleteMany({ where: { appId } });
  await prisma.partnerSubscriptionSaleFact.deleteMany({ where: { appId } });
  await prisma.app.deleteMany({ where: { id: appId } });
  await prisma.organization.deleteMany({ where: { id: organizationId } });
}

async function fixtureApp(t: TestContext): Promise<string> {
  const suffix = id("bounding");
  const organization = await prisma.organization.create({
    data: { name: `Bounding ${suffix}` },
  });
  const app = await prisma.app.create({
    data: {
      organizationId: organization.id,
      name: `Bounding app ${suffix}`,
      handle: `bounding-${suffix}`,
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

test("an old-but-still-active charge with no recent events survives the trailing-window bound", async (t) => {
  const appId = await fixtureApp(t);
  const chargePlatformId = `gid://shopify/AppSubscription/${randomUUID()}`;

  // Activated 90 days ago — well before any trailing window — and nothing
  // has happened to it since. The unbounded read would obviously include
  // this event; the bounded read must too, via the opening balance.
  await prisma.partnerSubscriptionEvent.create({
    data: {
      appId,
      dedupeKey: id("dedupe"),
      type: "SUBSCRIPTION_CHARGE_ACTIVATED",
      occurredAt: new Date("2026-05-01T00:00:00.000Z"),
      shopDomain: "old-active-charge.myshopify.com",
      chargePlatformId,
      chargeName: "Growth",
      amount: "29.99",
      currencyCode: "USD",
      billingOn: new Date("2026-05-01T00:00:00.000Z"),
      test: false,
    },
  });
  await prisma.partnerSubscriptionSaleFact.create({
    data: {
      appId,
      transactionPlatformId: id("txn"),
      chargePlatformId,
      occurredAt: new Date("2026-05-02T00:00:00.000Z"),
      billingInterval: "EVERY_30_DAYS",
      grossAmount: "29.99",
      currencyCode: "USD",
    },
  });

  const trailingFloor = new Date("2026-07-25T00:00:00.000Z"); // 7 days before todayStart
  const todayStart = new Date("2026-08-01T00:00:00.000Z");

  const { events, sales } = await loadTrailingAppFacts(
    appId,
    trailingFloor,
    todayStart,
  );

  assert.equal(events.length, 1, "opening balance must include the old activation event");
  assert.equal(events[0].type, "SUBSCRIPTION_CHARGE_ACTIVATED");

  const histories = historiesFromFacts(events, sales);
  assert.equal(histories.length, 1);
  assert.equal(
    histories[0].activatedAt?.toISOString(),
    "2026-05-01T00:00:00.000Z",
    "activatedAt must be the true activation date, not lost by bounding",
  );

  // The charge must show as actively contributing on every trailing day,
  // exactly as the unbounded read would report it.
  const midWindow = new Date("2026-07-28T00:00:00.000Z");
  const contribution = contributionAt(histories[0], midWindow);
  assert.ok(contribution, "an old-but-active charge must still contribute mid-window");
  assert.equal(contribution?.kind, "monthly");
});

test("a charge with no events before the trailing window is unaffected by the opening balance", async (t) => {
  const appId = await fixtureApp(t);
  const chargePlatformId = `gid://shopify/AppSubscription/${randomUUID()}`;

  // Activated INSIDE the trailing window — the windowed fetch alone must
  // already carry this; the opening-balance query should return nothing for
  // this charge.
  await prisma.partnerSubscriptionEvent.create({
    data: {
      appId,
      dedupeKey: id("dedupe"),
      type: "SUBSCRIPTION_CHARGE_ACTIVATED",
      occurredAt: new Date("2026-07-27T00:00:00.000Z"),
      shopDomain: "new-charge.myshopify.com",
      chargePlatformId,
      chargeName: "Starter",
      amount: "9.99",
      currencyCode: "USD",
      test: false,
    },
  });

  const trailingFloor = new Date("2026-07-25T00:00:00.000Z");
  const todayStart = new Date("2026-08-01T00:00:00.000Z");

  const { events } = await loadTrailingAppFacts(appId, trailingFloor, todayStart);
  assert.equal(events.length, 1);
  assert.equal(events[0].occurredAt.toISOString(), "2026-07-27T00:00:00.000Z");
});

test("activatedAt survives when the true first activation isn't the latest pre-window event", async (t) => {
  const appId = await fixtureApp(t);
  const chargePlatformId = `gid://shopify/AppSubscription/${randomUUID()}`;

  // Activated, then frozen, then unfrozen — all before the trailing window,
  // and nothing since. A naive bound that keeps only each charge's single
  // latest pre-window row would retain the UNFROZEN event and lose the
  // original ACTIVATED event entirely, silently breaking `activatedAt`.
  await prisma.partnerSubscriptionEvent.createMany({
    data: [
      {
        appId,
        dedupeKey: id("dedupe"),
        type: "SUBSCRIPTION_CHARGE_ACTIVATED",
        occurredAt: new Date("2026-01-01T00:00:00.000Z"),
        shopDomain: "reactivated-charge.myshopify.com",
        chargePlatformId,
        chargeName: "Growth",
        amount: "29.99",
        currencyCode: "USD",
        test: false,
      },
      {
        appId,
        dedupeKey: id("dedupe"),
        type: "SUBSCRIPTION_CHARGE_FROZEN",
        occurredAt: new Date("2026-03-01T00:00:00.000Z"),
        shopDomain: "reactivated-charge.myshopify.com",
        chargePlatformId,
        chargeName: "Growth",
        amount: "29.99",
        currencyCode: "USD",
        test: false,
      },
      {
        appId,
        dedupeKey: id("dedupe"),
        type: "SUBSCRIPTION_CHARGE_UNFROZEN",
        occurredAt: new Date("2026-04-01T00:00:00.000Z"),
        shopDomain: "reactivated-charge.myshopify.com",
        chargePlatformId,
        chargeName: "Growth",
        amount: "29.99",
        currencyCode: "USD",
        test: false,
      },
    ],
  });

  const trailingFloor = new Date("2026-07-25T00:00:00.000Z");
  const todayStart = new Date("2026-08-01T00:00:00.000Z");

  const { events, sales } = await loadTrailingAppFacts(
    appId,
    trailingFloor,
    todayStart,
  );

  // Opening balance must carry exactly the two representative rows: the true
  // first ACTIVATED event and the true latest (UNFROZEN) event — not all
  // three, and not just the latest one.
  assert.equal(events.length, 2);
  const types = events.map((event) => event.type).sort();
  assert.deepEqual(types, ["SUBSCRIPTION_CHARGE_ACTIVATED", "SUBSCRIPTION_CHARGE_UNFROZEN"]);

  const histories = historiesFromFacts(events, sales);
  assert.equal(
    histories[0].activatedAt?.toISOString(),
    "2026-01-01T00:00:00.000Z",
    "activatedAt must be the original activation, not the latest pre-window event",
  );
});

/**
 * Regression for a real bug found 2026-09-03: the opening balance used to
 * fetch only each charge's single latest pre-window event, which is enough
 * for a "last event wins" active-check but NOT for the split
 * lifecycle/freeze check introduced by the 2026-09-01 stray-unfreeze fix.
 * With ACTIVATED -> CANCELED -> FROZEN -> UNFROZEN all pre-window, the latest
 * event is the UNFROZEN, so the CANCELED was dropped and the charge's
 * `lifecycleEvents` contained only an ACTIVATED — reviving a dead charge and
 * reintroducing the exact bug that fix removed, but *only* in the trailing
 * lane (the backfill reads full history, so it stayed correct). That seam is
 * how it surfaced: trailing days read higher than backfilled ones.
 */
test("a pre-window stray FROZEN/UNFROZEN after CANCELED stays dead through the bound", async (t) => {
  const appId = await fixtureApp(t);
  const chargePlatformId = `gid://shopify/AppSubscription/${randomUUID()}`;
  const shopDomain = "stray-unfreeze-bound.myshopify.com";

  const events: Array<[string, string]> = [
    ["SUBSCRIPTION_CHARGE_ACTIVATED", "2026-05-01T00:00:00.000Z"],
    ["SUBSCRIPTION_CHARGE_CANCELED", "2026-05-20T00:00:00.000Z"],
    ["SUBSCRIPTION_CHARGE_FROZEN", "2026-06-01T00:00:00.000Z"],
    ["SUBSCRIPTION_CHARGE_UNFROZEN", "2026-06-02T00:00:00.000Z"],
  ];
  for (const [type, occurredAt] of events) {
    await prisma.partnerSubscriptionEvent.create({
      data: {
        appId,
        dedupeKey: id("dedupe"),
        type,
        occurredAt: new Date(occurredAt),
        shopDomain,
        chargePlatformId,
        chargeName: "Growth",
        amount: "29.99",
        currencyCode: "USD",
        billingOn: new Date("2026-05-01T00:00:00.000Z"),
        test: false,
      },
    });
  }

  const trailingFloor = new Date("2026-07-25T00:00:00.000Z");
  const todayStart = new Date("2026-08-01T00:00:00.000Z");

  const { events: bounded, sales } = await loadTrailingAppFacts(
    appId,
    trailingFloor,
    todayStart,
  );

  // The CANCELED is the load-bearing row: without it the charge looks alive.
  assert.ok(
    bounded.some((event) => event.type === "SUBSCRIPTION_CHARGE_CANCELED"),
    "the opening balance must carry the latest LIFECYCLE event, not just the latest event overall",
  );

  const histories = historiesFromFacts(bounded, sales);
  assert.equal(histories.length, 1);
  assert.equal(
    contributionAt(histories[0], new Date("2026-07-28T00:00:00.000Z")),
    null,
    "a charge cancelled pre-window must not be revived by a stray unfreeze the bound preserved",
  );

  // The bounded read must agree with what the unbounded (backfill) read sees —
  // a seam between the two lanes is exactly how this bug became visible.
  const unbounded = await prisma.partnerSubscriptionEvent.findMany({
    where: { appId },
    orderBy: [{ chargePlatformId: "asc" }, { occurredAt: "asc" }],
  });
  const unboundedHistories = historiesFromFacts(unbounded, sales);
  assert.equal(
    contributionAt(unboundedHistories[0], new Date("2026-07-28T00:00:00.000Z")),
    contributionAt(histories[0], new Date("2026-07-28T00:00:00.000Z")),
    "bounded (trailing) and unbounded (backfill) lanes must agree",
  );
});
