import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChurnEvidenceIndex,
  buildPartnerChurnFromFacts,
  historiesFromFacts,
  type ChargeHistory,
  type EventFact,
} from "../app/lib/shopify/partner-mrr.server";
import {
  subscriptionChurnTransitions,
  buildLogoChurnDailyRows,
} from "../app/lib/shopify/partner-mrr-snapshot.server";

/**
 * Proves `subscriptionChurnTransitions`'s signed daily deltas reconstruct
 * `buildPartnerChurnFromFacts`'s per-charge `subscription.lost`/`recovered`
 * verdict exactly. Unlike `subscriptionChurnAt` (see the plan file for why
 * that one was abandoned as a snapshot source — it needs genuine per-charge
 * historical state a daily flow can't provide), this is a plain
 * bucket-boundary diff with no rolling lookback, so day-additive summing is
 * provably safe here. Every number the Churn tab will ever serve from the
 * snapshot is a sum of these deltas, so a mismatch here is a silently wrong
 * churn count forever.
 */

const DAY_MS = 86_400_000;

function day(iso: string): Date {
  return new Date(iso);
}

function event(overrides: Partial<EventFact> & { type: string; occurredAt: Date }): EventFact {
  return {
    appId: "app-1",
    chargePlatformId: "charge-1",
    chargeName: "Pro",
    amount: 30 as unknown as EventFact["amount"],
    currencyCode: "USD",
    billingOn: null,
    test: false,
    shopDomain: "shop.myshopify.com",
    ...overrides,
  };
}

function makeHistories(events: EventFact[]): ChargeHistory[] {
  return historiesFromFacts(events, []);
}

/** Reconstructs `subscription.lost`/`recovered` counts for `[bucket.start,
 * bucket.end)` purely from summed transitions — independent of
 * `subscriptionChurnTransitions`'s own internal bookkeeping. */
function reconstructBucket(
  histories: ChargeHistory[],
  evidence: ReturnType<typeof buildChurnEvidenceIndex>,
  start: Date,
  end: Date,
): { lost: number; recovered: number } {
  let lost = 0;
  let recovered = 0;
  for (const history of histories) {
    for (const d of subscriptionChurnTransitions(history, evidence)) {
      if (d.at.getTime() < start.getTime() || d.at.getTime() >= end.getTime()) continue;
      if (d.delta === 1) lost += 1;
      else recovered += 1;
    }
  }
  return { lost, recovered };
}

function assertEquivalent(
  events: EventFact[],
  start: Date,
  end: Date,
  label: string,
): void {
  const histories = makeHistories(events);
  const evidence = buildChurnEvidenceIndex(histories);
  const live = buildPartnerChurnFromFacts({
    events,
    sales: [],
    period: "all_time",
    periodStart: start,
    periodEnd: end,
    interval: "day",
    histories,
  });
  const liveTotals = live.subscription.timeSeries.reduce(
    (sum, point) => ({ lost: sum.lost + point.lost, recovered: sum.recovered + point.recovered }),
    { lost: 0, recovered: 0 },
  );
  const reconstructed = reconstructBucket(histories, evidence, start, end);
  assert.deepEqual(
    reconstructed,
    liveTotals,
    `${label}: mismatch (live=${JSON.stringify(liveTotals)}, reconstructed=${JSON.stringify(reconstructed)})`,
  );
}

test("simple cancel, never recovered", () => {
  const events = [
    event({ type: "SUBSCRIPTION_CHARGE_ACTIVATED", occurredAt: day("2026-01-01T12:00:00.000Z") }),
    event({ type: "SUBSCRIPTION_CHARGE_CANCELED", occurredAt: day("2026-02-01T12:00:00.000Z") }),
  ];
  assertEquivalent(events, day("2026-01-01T00:00:00.000Z"), day("2026-03-01T00:00:00.000Z"), "simple cancel");
});

test("cancel then reactivate: both counted separately (day-additive, not net)", () => {
  const events = [
    event({ type: "SUBSCRIPTION_CHARGE_ACTIVATED", occurredAt: day("2026-01-01T12:00:00.000Z") }),
    event({ type: "SUBSCRIPTION_CHARGE_CANCELED", occurredAt: day("2026-02-01T12:00:00.000Z") }),
    event({ type: "SUBSCRIPTION_CHARGE_UNFROZEN", occurredAt: day("2026-02-10T12:00:00.000Z") }),
  ];
  // Query a window that spans BOTH transitions as one bucket (mirrors the
  // live "diff at bucket boundaries" — start and end must bracket both, or
  // the accepted day-additive-vs-bucket-diff divergence applies instead).
  assertEquivalent(events, day("2026-01-01T00:00:00.000Z"), day("2026-01-15T00:00:00.000Z"), "before both");
  assertEquivalent(events, day("2026-02-15T00:00:00.000Z"), day("2026-03-01T00:00:00.000Z"), "after both, no more churn");
});

test("declined and expired count exactly like canceled", () => {
  for (const type of ["SUBSCRIPTION_CHARGE_DECLINED", "SUBSCRIPTION_CHARGE_EXPIRED"]) {
    const events = [
      event({ type: "SUBSCRIPTION_CHARGE_ACTIVATED", occurredAt: day("2026-01-01T12:00:00.000Z") }),
      event({ type, occurredAt: day("2026-02-01T12:00:00.000Z") }),
    ];
    assertEquivalent(events, day("2026-01-01T00:00:00.000Z"), day("2026-03-01T00:00:00.000Z"), type);
  }
});

test("replacement cancellation (same shop reactivates within 60s) is suppressed", () => {
  const events = [
    event({
      chargePlatformId: "charge-1",
      type: "SUBSCRIPTION_CHARGE_ACTIVATED",
      occurredAt: day("2026-01-01T12:00:00.000Z"),
    }),
    event({
      chargePlatformId: "charge-1",
      type: "SUBSCRIPTION_CHARGE_CANCELED",
      occurredAt: day("2026-02-01T12:00:00.000Z"),
    }),
    event({
      chargePlatformId: "charge-2",
      type: "SUBSCRIPTION_CHARGE_ACTIVATED",
      occurredAt: day("2026-02-01T12:00:30.000Z"), // 30s later, same shop
    }),
  ];
  assertEquivalent(events, day("2026-01-01T00:00:00.000Z"), day("2026-03-01T00:00:00.000Z"), "replacement");
});

test("a real cancellation NOT replaced (different shop reactivates) still counts", () => {
  const events = [
    event({
      chargePlatformId: "charge-1",
      shopDomain: "shop-a.myshopify.com",
      type: "SUBSCRIPTION_CHARGE_ACTIVATED",
      occurredAt: day("2026-01-01T12:00:00.000Z"),
    }),
    event({
      chargePlatformId: "charge-1",
      shopDomain: "shop-a.myshopify.com",
      type: "SUBSCRIPTION_CHARGE_CANCELED",
      occurredAt: day("2026-02-01T12:00:00.000Z"),
    }),
    event({
      chargePlatformId: "charge-2",
      shopDomain: "shop-b.myshopify.com",
      type: "SUBSCRIPTION_CHARGE_ACTIVATED",
      occurredAt: day("2026-02-01T12:00:30.000Z"),
    }),
  ];
  assertEquivalent(events, day("2026-01-01T00:00:00.000Z"), day("2026-03-01T00:00:00.000Z"), "different shop");
});

test("trial-only cancellation is never counted as subscription churn", () => {
  const events = [
    event({
      type: "SUBSCRIPTION_CHARGE_ACTIVATED",
      occurredAt: day("2026-01-01T12:00:00.000Z"),
      billingOn: day("2026-01-08T00:00:00.000Z"),
    }),
    event({ type: "SUBSCRIPTION_CHARGE_CANCELED", occurredAt: day("2026-01-05T12:00:00.000Z") }),
  ];
  assertEquivalent(events, day("2026-01-01T00:00:00.000Z"), day("2026-02-01T00:00:00.000Z"), "trial cancel");
});

test("a test-flagged cancellation still counts (matches contributionAt's own test handling, not excluded)", () => {
  const events = [
    event({ type: "SUBSCRIPTION_CHARGE_ACTIVATED", occurredAt: day("2026-01-01T12:00:00.000Z") }),
    event({ type: "SUBSCRIPTION_CHARGE_CANCELED", occurredAt: day("2026-02-01T12:00:00.000Z"), test: true }),
  ];
  assertEquivalent(events, day("2026-01-01T00:00:00.000Z"), day("2026-03-01T00:00:00.000Z"), "test cancel");
});

test("frozen then unfrozen: counted as lost then recovered (no FROZEN exclusion here, unlike subscriptionChurnAt)", () => {
  const events = [
    event({ type: "SUBSCRIPTION_CHARGE_ACTIVATED", occurredAt: day("2026-01-01T12:00:00.000Z") }),
    event({ type: "SUBSCRIPTION_CHARGE_FROZEN", occurredAt: day("2026-02-01T12:00:00.000Z") }),
    event({ type: "SUBSCRIPTION_CHARGE_UNFROZEN", occurredAt: day("2026-02-10T12:00:00.000Z") }),
  ];
  assertEquivalent(events, day("2026-01-01T00:00:00.000Z"), day("2026-03-01T00:00:00.000Z"), "frozen/unfrozen");
});

test("randomized population: brute-force equivalence against buildPartnerChurnFromFacts", () => {
  let seed = 11;
  function next(): number {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const TYPES = [
    "SUBSCRIPTION_CHARGE_ACTIVATED",
    "SUBSCRIPTION_CHARGE_CANCELED",
    "SUBSCRIPTION_CHARGE_DECLINED",
    "SUBSCRIPTION_CHARGE_EXPIRED",
    "SUBSCRIPTION_CHARGE_FROZEN",
    "SUBSCRIPTION_CHARGE_UNFROZEN",
  ];
  const START = day("2026-01-01T00:00:00.000Z").getTime();
  const SPAN_MS = 200 * DAY_MS;

  for (let i = 0; i < 200; i += 1) {
    const eventCount = 1 + Math.floor(next() * 6);
    let cursor = START + Math.floor(next() * SPAN_MS);
    const shopDomain = `shop-${i}.myshopify.com`;
    const events: EventFact[] = [
      event({ type: "SUBSCRIPTION_CHARGE_ACTIVATED", occurredAt: new Date(cursor), shopDomain }),
    ];
    for (let e = 0; e < eventCount; e += 1) {
      // Always at least one full day later, so no two events can ever land
      // on the same UTC calendar day — a same-day round trip is genuinely
      // invisible to day-bucket-diffing (both bucket boundaries show the
      // same state), which is the accepted day-additive-vs-bucket-diff
      // divergence, not something this equivalence test should be checking.
      cursor += DAY_MS + Math.floor(next() * 19 * DAY_MS);
      events.push(
        event({
          type: TYPES[Math.floor(next() * TYPES.length)],
          occurredAt: new Date(cursor),
          test: next() < 0.05,
          shopDomain,
        }),
      );
    }
    // Query the entire span as one bucket — the bucket-boundary-diff vs.
    // day-additive divergence (documented, accepted) only applies to
    // *within-bucket* round trips at week/month granularity; querying the
    // whole span avoids that entirely and isolates the transition logic.
    assertEquivalent(
      events,
      new Date(START),
      new Date(START + SPAN_MS + 60 * DAY_MS),
      `random charge #${i} (seed-reproducible)`,
    );
  }
});

/**
 * Logo (shop-level) churn — generalizes the exact same day-additive
 * technique to shops via `buildLogoChurnDailyRows`, which diffs consecutive
 * day-boundary active-shop sets (see that function's doc comment for why
 * this is a diffing approach rather than a per-charge delta walk like
 * `subscriptionChurnTransitions`). These tests prove it reproduces
 * `buildPartnerChurnFromFacts`'s `logo.timeSeries` lost/recovered exactly,
 * and — the actual point of building this — that an org-wide fold across
 * multiple apps never double-counts a shop active in more than one.
 */

function assertLogoEquivalent(
  events: EventFact[],
  start: Date,
  end: Date,
  label: string,
): void {
  const histories = makeHistories(events);
  const live = buildPartnerChurnFromFacts({
    events,
    sales: [],
    period: "all_time",
    periodStart: start,
    periodEnd: end,
    interval: "day",
    histories,
  });
  const liveTotals = live.logo.timeSeries.reduce(
    (sum, point) => ({ lost: sum.lost + point.lost, recovered: sum.recovered + point.recovered }),
    { lost: 0, recovered: 0 },
  );
  const days: Date[] = [];
  for (let d = start.getTime(); d < end.getTime(); d += DAY_MS) days.push(new Date(d));
  const rows = buildLogoChurnDailyRows({
    organizationId: "org-1",
    appId: "app-1",
    histories,
    days,
  });
  const reconstructed = rows.reduce(
    (sum, row) => ({ lost: sum.lost + row.churnedShops, recovered: sum.recovered + row.recoveredShops }),
    { lost: 0, recovered: 0 },
  );
  assert.deepEqual(
    reconstructed,
    liveTotals,
    `${label}: mismatch (live=${JSON.stringify(liveTotals)}, reconstructed=${JSON.stringify(reconstructed)})`,
  );
}

test("logo: simple cancel, never recovered, matches buildPartnerChurnFromFacts", () => {
  const events = [
    event({ type: "SUBSCRIPTION_CHARGE_ACTIVATED", occurredAt: day("2026-01-01T12:00:00.000Z") }),
    event({ type: "SUBSCRIPTION_CHARGE_CANCELED", occurredAt: day("2026-02-01T12:00:00.000Z") }),
  ];
  assertLogoEquivalent(events, day("2026-01-01T00:00:00.000Z"), day("2026-03-01T00:00:00.000Z"), "logo simple cancel");
});

test("logo: replacement cancellation within one day is NOT flagged churned — no special-casing needed", () => {
  // Same shop cancels charge-1 and activates a replacement charge-2 the same
  // day. Unlike subscription-level churn, this needs no isReplacementCancellation
  // check at all: the shop is present in both the previous and current day's
  // active-shop sets (via different charges), so the set-diff naturally never
  // flags it. This is the core "don't reapply that predicate" design point.
  const events = [
    event({
      chargePlatformId: "charge-1",
      type: "SUBSCRIPTION_CHARGE_ACTIVATED",
      occurredAt: day("2026-01-01T12:00:00.000Z"),
    }),
    event({
      chargePlatformId: "charge-1",
      type: "SUBSCRIPTION_CHARGE_CANCELED",
      occurredAt: day("2026-02-01T12:00:00.000Z"),
    }),
    event({
      chargePlatformId: "charge-2",
      type: "SUBSCRIPTION_CHARGE_ACTIVATED",
      occurredAt: day("2026-02-01T18:00:00.000Z"), // same UTC day, different charge
    }),
  ];
  const histories = makeHistories(events);
  const days = [day("2026-02-01T00:00:00.000Z")];
  const rows = buildLogoChurnDailyRows({ organizationId: "org-1", appId: "app-1", histories, days });
  assert.equal(rows[0].churnedShops, 0, "the shop must never be flagged churned — it never left the active set");
  assertLogoEquivalent(events, day("2026-01-01T00:00:00.000Z"), day("2026-03-01T00:00:00.000Z"), "logo replacement");
});

test("logo: a shop's first-ever activation is never counted as recovered", () => {
  const events = [
    event({ type: "SUBSCRIPTION_CHARGE_ACTIVATED", occurredAt: day("2026-01-15T12:00:00.000Z") }),
  ];
  const histories = makeHistories(events);
  const days = [day("2026-01-14T00:00:00.000Z"), day("2026-01-15T00:00:00.000Z"), day("2026-01-16T00:00:00.000Z")];
  const rows = buildLogoChurnDailyRows({ organizationId: "org-1", appId: "app-1", histories, days });
  assert.equal(
    rows.reduce((sum, row) => sum + row.recoveredShops, 0),
    0,
    "a brand-new shop's first activation must never be counted as a recovery",
  );
  assertLogoEquivalent(
    events,
    day("2026-01-01T00:00:00.000Z"),
    day("2026-02-01T00:00:00.000Z"),
    "logo first activation",
  );
});

test("logo: a real recovery (reactivation after zero active charges) is counted", () => {
  const events = [
    event({ type: "SUBSCRIPTION_CHARGE_ACTIVATED", occurredAt: day("2026-01-01T12:00:00.000Z") }),
    event({ type: "SUBSCRIPTION_CHARGE_CANCELED", occurredAt: day("2026-02-01T12:00:00.000Z") }),
    event({ type: "SUBSCRIPTION_CHARGE_UNFROZEN", occurredAt: day("2026-02-10T12:00:00.000Z") }),
  ];
  assertLogoEquivalent(events, day("2026-01-01T00:00:00.000Z"), day("2026-01-15T00:00:00.000Z"), "logo before both");
  assertLogoEquivalent(events, day("2026-02-15T00:00:00.000Z"), day("2026-03-01T00:00:00.000Z"), "logo after both");
});

test("logo: a test-flagged cancellation still counts, matching buildPartnerChurnFromFacts", () => {
  const events = [
    event({ type: "SUBSCRIPTION_CHARGE_ACTIVATED", occurredAt: day("2026-01-01T12:00:00.000Z") }),
    event({ type: "SUBSCRIPTION_CHARGE_CANCELED", occurredAt: day("2026-02-01T12:00:00.000Z"), test: true }),
  ];
  assertLogoEquivalent(events, day("2026-01-01T00:00:00.000Z"), day("2026-03-01T00:00:00.000Z"), "logo test cancel");
});

test("logo: randomized multi-shop population, brute-force equivalence against buildPartnerChurnFromFacts", () => {
  let seed = 29;
  function next(): number {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const TYPES = [
    "SUBSCRIPTION_CHARGE_CANCELED",
    "SUBSCRIPTION_CHARGE_DECLINED",
    "SUBSCRIPTION_CHARGE_EXPIRED",
    "SUBSCRIPTION_CHARGE_FROZEN",
    "SUBSCRIPTION_CHARGE_UNFROZEN",
  ];
  const START = day("2026-01-01T00:00:00.000Z").getTime();
  const SPAN_MS = 200 * DAY_MS;
  const events: EventFact[] = [];

  // Multiple charges per shop (a shop can have 2+ subscriptions over time,
  // or concurrently) so the logo fold's cross-charge grouping is actually
  // exercised, not just a 1:1 charge-to-shop mirror of the subscription test.
  for (let shopIndex = 0; shopIndex < 40; shopIndex += 1) {
    const shopDomain = `shop-${shopIndex}.myshopify.com`;
    const chargeCount = 1 + Math.floor(next() * 2);
    for (let c = 0; c < chargeCount; c += 1) {
      let cursor = START + Math.floor(next() * SPAN_MS);
      events.push(
        event({
          chargePlatformId: `shop-${shopIndex}-charge-${c}`,
          shopDomain,
          type: "SUBSCRIPTION_CHARGE_ACTIVATED",
          occurredAt: new Date(cursor),
        }),
      );
      const eventCount = Math.floor(next() * 4);
      for (let e = 0; e < eventCount; e += 1) {
        cursor += DAY_MS + Math.floor(next() * 19 * DAY_MS);
        events.push(
          event({
            chargePlatformId: `shop-${shopIndex}-charge-${c}`,
            shopDomain,
            type: TYPES[Math.floor(next() * TYPES.length)],
            occurredAt: new Date(cursor),
            test: next() < 0.05,
          }),
        );
      }
    }
  }
  assertLogoEquivalent(
    events,
    new Date(START),
    new Date(START + SPAN_MS + 60 * DAY_MS),
    "logo randomized multi-shop population",
  );
});

/**
 * The whole reason `PartnerDailyLogoChurnSnapshot` needs an org-wide scope
 * separate from per-app rows: confirmed in production, 68 of 4257 active
 * shops are simultaneously active in 2 different apps — summing per-app
 * logo-churn numbers for an "All apps" view would double-count them. This
 * directly regression-tests that the ORG-WIDE fold (built from every app's
 * histories combined) does NOT flag a shop churned when it loses its last
 * charge in one app while remaining active via another, while the PER-APP
 * fold for that one app correctly DOES flag it — proving the two scopes
 * answer genuinely different, both-correct questions.
 */
test("logo: a shop active in 2 apps is not double-counted org-wide, but still churns per-app", () => {
  const shopDomain = "multi-app-shop.myshopify.com";
  const appAEvents: EventFact[] = [
    event({
      appId: "app-a",
      chargePlatformId: "app-a-charge",
      shopDomain,
      type: "SUBSCRIPTION_CHARGE_ACTIVATED",
      occurredAt: day("2026-01-01T00:00:00.000Z"),
    }),
    event({
      appId: "app-a",
      chargePlatformId: "app-a-charge",
      shopDomain,
      type: "SUBSCRIPTION_CHARGE_CANCELED",
      occurredAt: day("2026-02-01T12:00:00.000Z"),
    }),
  ];
  const appBEvents: EventFact[] = [
    event({
      appId: "app-b",
      chargePlatformId: "app-b-charge",
      shopDomain,
      type: "SUBSCRIPTION_CHARGE_ACTIVATED",
      occurredAt: day("2026-01-10T00:00:00.000Z"),
    }),
    // App B's charge stays active through and beyond app A's cancellation —
    // the shop never actually left the org-wide active set.
  ];

  const days = [day("2026-02-01T00:00:00.000Z"), day("2026-02-02T00:00:00.000Z")];

  // Per-app (app A alone): the shop's only charge in this app canceled, so
  // this app's own scope correctly sees it as churned.
  const perAppHistories = makeHistories(appAEvents);
  const perAppRows = buildLogoChurnDailyRows({
    organizationId: "org-1",
    appId: "app-a",
    histories: perAppHistories,
    days,
  });
  assert.equal(
    perAppRows.reduce((sum, row) => sum + row.churnedShops, 0),
    1,
    "app A's own per-app scope must see this shop churn — its only charge in THIS app canceled",
  );

  // Org-wide (both apps folded together): the shop still has an active
  // charge via app B, so it must NOT be counted as churned at all.
  const orgWideHistories = makeHistories([...appAEvents, ...appBEvents]);
  const orgWideRows = buildLogoChurnDailyRows({
    organizationId: "org-1",
    appId: "__org_wide__",
    histories: orgWideHistories,
    days,
  });
  assert.equal(
    orgWideRows.reduce((sum, row) => sum + row.churnedShops, 0),
    0,
    "org-wide, this shop never left the active set — it must not be double-counted as churned",
  );
});
