import assert from "node:assert/strict";
import test from "node:test";
import {
  insightsSavedStateSchema,
  isSavedViewReport,
  trafficSavedStateSchema,
} from "../app/lib/saved-views/saved-view-schemas";

test("only registered reports accept saved views", () => {
  assert.equal(isSavedViewReport("traffic"), true);
  assert.equal(isSavedViewReport("insights"), true);
  assert.equal(isSavedViewReport("toString"), false, "not fooled by Object.prototype");
  assert.equal(isSavedViewReport("mrr"), false);
});

test("traffic state: the shape the migration writes reads back unchanged", () => {
  const state = {
    dimensions: ["source", "medium"],
    funnelEvents: ["listing_view", "installed"],
    filters: { country: ["Spain"] },
    appId: null,
    period: "last_30_days",
    dateRange: { start: "2026-08-01T00:00:00.000Z", end: "2026-08-26T00:00:00.000Z" },
    compareMode: "custom",
    compareRange: { start: "2026-07-01T00:00:00.000Z", end: "2026-07-26T00:00:00.000Z" },
  };
  assert.deepEqual(trafficSavedStateSchema.parse(state), state);
});

test("traffic state: a broken field falls back instead of hiding the view", () => {
  const parsed = trafficSavedStateSchema.parse({
    dimensions: ["source", "", "medium"],
    funnelEvents: "not-a-list",
    filters: null,
    appId: 42,
    period: null,
    dateRange: { start: "x" },
    compareMode: null,
    compareRange: null,
  });
  assert.deepEqual(parsed.dimensions, ["source", "medium"], "empty keys dropped, like the old reader");
  assert.deepEqual(parsed.funnelEvents, []);
  assert.deepEqual(parsed.filters, {});
  assert.equal(parsed.appId, null);
  assert.equal(parsed.dateRange, null);
});

test("insights state: unknown event or metric falls back to the report defaults", () => {
  assert.deepEqual(
    insightsSavedStateSchema.parse({ appId: "a1", period: "last_90_days", event: "subscribed", metric: "median_clv" }),
    { appId: "a1", period: "last_90_days", event: "subscribed", metric: "median_clv" },
  );
  const parsed = insightsSavedStateSchema.parse({ appId: null, period: null, event: "gone", metric: "gone" });
  assert.equal(parsed.event, "listing_view");
  assert.equal(parsed.metric, "volume");
});

test("a state that isn't an object is rejected, not guessed at", () => {
  assert.equal(trafficSavedStateSchema.safeParse("nope").success, false);
  assert.equal(insightsSavedStateSchema.safeParse(null).success, false);
});
