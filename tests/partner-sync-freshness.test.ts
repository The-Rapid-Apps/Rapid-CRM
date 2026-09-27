import assert from "node:assert/strict";
import test from "node:test";
import { METRICS_RESPONSE_HEADERS } from "../app/routes/api/metrics";
import {
  buildPartnerSubscriptionFreshness,
  PARTNER_SUBSCRIPTION_EVENTS_QUERY,
  PARTNER_SUBSCRIPTION_SALES_QUERY,
} from "../app/lib/shopify/partner-subscription-sync.server";

function app(params: {
  id: string;
  eventsAt: string | null;
  salesAt: string | null;
  historyComplete?: boolean;
}) {
  const completedAt = params.historyComplete
    ? new Date("2026-07-01T00:00:00.000Z")
    : null;
  return {
    id: params.id,
    name: params.id,
    billingEventsSyncedAt: params.eventsAt ? new Date(params.eventsAt) : null,
    billingEventsBackfillCompletedAt: completedAt,
    billingSalesSyncedAt: params.salesAt ? new Date(params.salesAt) : null,
    billingSalesBackfillCompletedAt: completedAt,
  };
}

test("Partner freshness uses the oldest completed stream across all apps", () => {
  const freshness = buildPartnerSubscriptionFreshness({
    apps: [
      app({
        id: "app-1",
        eventsAt: "2026-08-03T12:00:10.000Z",
        salesAt: "2026-08-03T12:00:08.000Z",
        historyComplete: true,
      }),
      app({
        id: "app-2",
        eventsAt: "2026-08-03T12:00:06.000Z",
        salesAt: "2026-08-03T12:00:04.000Z",
        historyComplete: true,
      }),
    ],
    requestedAt: new Date("2026-08-03T12:00:00.000Z"),
    now: new Date("2026-08-03T12:00:12.000Z"),
  });

  assert.equal(freshness.fresh, true);
  assert.equal(freshness.exact, true);
  assert.equal(freshness.historyComplete, true);
  assert.equal(freshness.freshThrough, "2026-08-03T12:00:04.000Z");
  assert.equal(freshness.lagMs, 8_000);
  assert.equal(freshness.appsReady, 2);
});

test("Partner freshness never claims current when one stream is missing or old", () => {
  const freshness = buildPartnerSubscriptionFreshness({
    apps: [
      app({
        id: "app-1",
        eventsAt: "2026-08-03T12:00:10.000Z",
        salesAt: null,
      }),
    ],
    requestedAt: new Date("2026-08-03T12:00:00.000Z"),
    now: new Date("2026-08-03T12:00:12.000Z"),
  });

  assert.equal(freshness.fresh, false);
  assert.equal(freshness.exact, false);
  assert.equal(freshness.freshThrough, null);
  assert.equal(freshness.lagMs, null);
  assert.equal(freshness.historyComplete, false);
});

test("Partner freshness is current only when every stream crossed the request watermark", () => {
  const freshness = buildPartnerSubscriptionFreshness({
    apps: [
      app({
        id: "app-1",
        eventsAt: "2026-08-03T12:00:10.000Z",
        salesAt: "2026-08-03T11:59:59.000Z",
        historyComplete: true,
      }),
    ],
    requestedAt: new Date("2026-08-03T12:00:00.000Z"),
    now: new Date("2026-08-03T12:00:12.000Z"),
  });

  assert.equal(freshness.fresh, false);
  assert.equal(freshness.freshThrough, "2026-08-03T11:59:59.000Z");
  assert.equal(freshness.lagMs, 13_000);
  assert.equal(freshness.apps[0]?.fresh, false);
});

test("recent Shopify data can be fresh while historical backfill remains incomplete", () => {
  const freshness = buildPartnerSubscriptionFreshness({
    apps: [
      app({
        id: "app-1",
        eventsAt: "2026-08-03T12:00:10.000Z",
        salesAt: "2026-08-03T12:00:08.000Z",
        historyComplete: false,
      }),
    ],
    requestedAt: new Date("2026-08-03T12:00:00.000Z"),
    now: new Date("2026-08-03T12:00:12.000Z"),
  });

  assert.equal(freshness.fresh, true);
  assert.equal(freshness.exact, false);
  assert.equal(freshness.historyComplete, false);
  assert.equal(freshness.appsReady, 0);
  assert.equal(freshness.apps[0]?.historyComplete, false);
});

test("an empty Shopify app scope is never reported as current", () => {
  const freshness = buildPartnerSubscriptionFreshness({
    apps: [],
    requestedAt: new Date("2026-08-03T12:00:00.000Z"),
    now: new Date("2026-08-03T12:00:12.000Z"),
  });

  assert.equal(freshness.fresh, false);
  assert.equal(freshness.historyComplete, false);
  assert.equal(freshness.freshThrough, null);
  assert.equal(freshness.appsTotal, 0);
});

test("Navigation freshness can use a bounded staleness threshold", () => {
  const now = new Date("2026-08-03T12:20:00.000Z");
  const freshness = buildPartnerSubscriptionFreshness({
    apps: [
      app({
        id: "app-1",
        eventsAt: "2026-08-03T12:05:00.000Z",
        salesAt: "2026-08-03T12:04:00.000Z",
        historyComplete: true,
      }),
    ],
    requestedAt: now,
    freshAfter: new Date("2026-08-03T12:00:00.000Z"),
    now,
  });

  assert.equal(freshness.requestedAt, now.toISOString());
  assert.equal(freshness.fresh, true);
  assert.equal(freshness.freshThrough, "2026-08-03T12:04:00.000Z");
});

test("metrics responses cannot be reused after a Shopify refresh", () => {
  assert.equal(METRICS_RESPONSE_HEADERS["Cache-Control"], "private, no-store");
});

test("latest-window Shopify queries are bounded by the refresh request watermark", () => {
  assert.match(
    PARTNER_SUBSCRIPTION_EVENTS_QUERY,
    /\$occurredAtMax:\s*DateTime/,
  );
  assert.match(
    PARTNER_SUBSCRIPTION_EVENTS_QUERY,
    /occurredAtMax:\s*\$occurredAtMax/,
  );
  assert.match(PARTNER_SUBSCRIPTION_SALES_QUERY, /\$createdAtMax:\s*DateTime/);
  assert.match(
    PARTNER_SUBSCRIPTION_SALES_QUERY,
    /createdAtMax:\s*\$createdAtMax/,
  );
});
