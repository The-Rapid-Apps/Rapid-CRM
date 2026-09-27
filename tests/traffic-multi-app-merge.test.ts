import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeTrafficSourceReports,
  type TrafficSourceRow,
  type TrafficSourcesReport,
} from "../app/lib/reports/traffic-sources.server";

/**
 * The "All apps" traffic aggregate.
 *
 * GA4 is per-app (one property, one dataset each), so there is no query that
 * spans apps — the aggregate is built by merging one report per app. The
 * merge is where this goes wrong quietly rather than loudly: an off-by-one in
 * a trend array, a null MRR summed as zero, or paging before re-sorting all
 * produce a plausible-looking number that is simply not the total. Hence
 * these assert the arithmetic directly.
 */

const PERIOD_START = "2026-06-12T00:00:00.000Z";
const PERIOD_END = "2026-09-10T00:00:00.000Z";
const BUCKETS = [
  { periodStart: "2026-09-08T00:00:00.000Z", periodEnd: "2026-09-09T00:00:00.000Z" },
  { periodStart: "2026-09-09T00:00:00.000Z", periodEnd: "2026-09-10T00:00:00.000Z" },
];

const CONTEXT = {
  periodStart: PERIOD_START,
  periodEnd: PERIOD_END,
  dimensions: ["source"] as const,
  funnelEvents: ["listing_view", "installed"] as const,
  filters: {},
  page: 1,
  pageSize: 10,
};

function merge(
  reports: TrafficSourcesReport[],
  overrides: Partial<typeof CONTEXT> = {},
) {
  return mergeTrafficSourceReports(reports, {
    ...CONTEXT,
    dimensions: [...CONTEXT.dimensions],
    funnelEvents: [...CONTEXT.funnelEvents],
    ...overrides,
  } as Parameters<typeof mergeTrafficSourceReports>[1]);
}

function row(
  source: string,
  listingView: number,
  installed: number,
  trend: { listing_view: number[]; installed: number[] },
  extras: Partial<Pick<TrafficSourceRow, "mrr" | "clv" | "compare">> = {},
): TrafficSourceRow {
  return {
    dimensions: { source } as TrafficSourceRow["dimensions"],
    funnel: { listing_view: listingView, installed },
    trend,
    // `??` would turn an explicit `mrr: null` (the "unavailable" case these
    // tests exist to pin down) back into 0.
    mrr: "mrr" in extras ? extras.mrr! : 0,
    clv: extras.clv ?? null,
    ...(extras.compare ? { compare: extras.compare } : {}),
  };
}

function report(
  rows: TrafficSourceRow[],
  overrides: Partial<TrafficSourcesReport> = {},
): TrafficSourcesReport {
  const totals = { listing_view: 0, installed: 0 };
  const totalsTrend = {
    listing_view: new Array(BUCKETS.length).fill(0) as number[],
    installed: new Array(BUCKETS.length).fill(0) as number[],
  };
  for (const r of rows) {
    totals.listing_view += r.funnel.listing_view ?? 0;
    totals.installed += r.funnel.installed ?? 0;
    for (let i = 0; i < BUCKETS.length; i++) {
      totalsTrend.listing_view[i] += r.trend.listing_view?.[i] ?? 0;
      totalsTrend.installed[i] += r.trend.installed?.[i] ?? 0;
    }
  }
  return {
    available: true,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    dimensions: ["source"],
    funnelEvents: ["listing_view", "installed"],
    filters: {},
    availableValues: { source: rows.map((r) => r.dimensions.source) },
    rows,
    totals,
    totalsTrend,
    trendBuckets: BUCKETS,
    page: 1,
    totalPages: 1,
    compareRange: null,
    ...overrides,
  };
}

test("rows sharing a dimension value are summed, not duplicated", () => {
  const a = report([
    row("shopify", 100, 40, { listing_view: [60, 40], installed: [25, 15] }),
  ]);
  const b = report([
    row("shopify", 7, 3, { listing_view: [4, 3], installed: [2, 1] }),
  ]);

  const merged = merge([a, b]);

  assert.equal(merged.available, true);
  assert.equal(merged.rows.length, 1, "one row per dimension value, not one per app");
  assert.deepEqual(merged.rows[0].funnel, { listing_view: 107, installed: 43 });
  assert.deepEqual(merged.rows[0].trend.listing_view, [64, 43]);
  assert.deepEqual(merged.rows[0].trend.installed, [27, 16]);
});

test("totals equal the sum of every app's totals, and trends sum to them", () => {
  const a = report([
    row("shopify", 100, 40, { listing_view: [60, 40], installed: [25, 15] }),
    row("(direct)", 50, 30, { listing_view: [20, 30], installed: [10, 20] }),
  ]);
  const b = report([
    row("google", 9, 1, { listing_view: [5, 4], installed: [1, 0] }),
  ]);

  const merged = merge([a, b]);

  assert.deepEqual(merged.totals, { listing_view: 159, installed: 71 });
  for (const key of ["listing_view", "installed"] as const) {
    const series = merged.totalsTrend[key]!;
    assert.equal(series.length, BUCKETS.length);
    assert.equal(
      series.reduce((sum, value) => sum + value, 0),
      merged.totals[key],
      `${key} trend must sum to its total`,
    );
  }
});

test("merged rows are re-sorted busiest-first BEFORE paging", () => {
  // Small on its own in either app, biggest once merged — the case that makes
  // merging already-paged results wrong.
  const a = report([
    row("big-in-a", 100, 1, { listing_view: [100, 0], installed: [1, 0] }),
    row("split", 60, 1, { listing_view: [60, 0], installed: [1, 0] }),
  ]);
  const b = report([
    row("split", 90, 1, { listing_view: [90, 0], installed: [1, 0] }),
  ]);

  const merged = merge([a, b], { pageSize: 1 });

  assert.equal(merged.totalPages, 2);
  assert.equal(merged.rows.length, 1);
  assert.equal(
    merged.rows[0].dimensions.source,
    "split",
    "150 merged beats 100, even though it was second in its own app",
  );
});

test("paging reports the merged row count, not any one app's", () => {
  const a = report([
    row("a1", 10, 1, { listing_view: [10, 0], installed: [1, 0] }),
    row("a2", 9, 1, { listing_view: [9, 0], installed: [1, 0] }),
  ]);
  const b = report([
    row("b1", 8, 1, { listing_view: [8, 0], installed: [1, 0] }),
  ]);

  const merged = merge([a, b], { pageSize: 2 });
  assert.equal(merged.totalPages, 2);
  assert.equal(merged.page, 1);
  assert.deepEqual(merged.rows.map((r) => r.dimensions.source), ["a1", "a2"]);

  const second = merge([a, b], { pageSize: 2, page: 2 });
  assert.deepEqual(second.rows.map((r) => r.dimensions.source), ["b1"]);

  // Out-of-range pages clamp instead of returning an empty table.
  assert.equal(merge([a, b], { pageSize: 2, page: 99 }).page, 2);
});

test("MRR sums across apps; null means unavailable and is never counted as 0", () => {
  const a = report([
    row("shopify", 10, 1, { listing_view: [10, 0], installed: [1, 0] }, { mrr: 120.5 }),
    row("google", 5, 1, { listing_view: [5, 0], installed: [1, 0] }, { mrr: null }),
  ]);
  const b = report([
    row("shopify", 4, 1, { listing_view: [4, 0], installed: [1, 0] }, { mrr: 30 }),
    row("google", 2, 1, { listing_view: [2, 0], installed: [1, 0] }, { mrr: null }),
  ]);

  const merged = merge([a, b]);
  const byKey = new Map(merged.rows.map((r) => [r.dimensions.source, r]));

  assert.equal(byKey.get("shopify")!.mrr, 150.5);
  assert.equal(
    byKey.get("google")!.mrr,
    null,
    "no app could report MRR, so the aggregate must not claim $0",
  );
});

test("one app's real MRR survives another app's unavailable MRR", () => {
  const a = report([
    row("shopify", 10, 1, { listing_view: [10, 0], installed: [1, 0] }, { mrr: 90 }),
  ]);
  const b = report([
    row("shopify", 4, 1, { listing_view: [4, 0], installed: [1, 0] }, { mrr: null }),
  ]);

  assert.equal(merge([a, b]).rows[0].mrr, 90);
});

test("CLV is dropped for rows more than one app contributed to, and kept otherwise", () => {
  const a = report([
    row("shopify", 10, 1, { listing_view: [10, 0], installed: [1, 0] }, { clv: 400 }),
    row("only-in-a", 3, 1, { listing_view: [3, 0], installed: [1, 0] }, { clv: 250 }),
  ]);
  const b = report([
    row("shopify", 4, 1, { listing_view: [4, 0], installed: [1, 0] }, { clv: 900 }),
  ]);

  const merged = merge([a, b]);
  const byKey = new Map(merged.rows.map((r) => [r.dimensions.source, r]));

  assert.equal(
    byKey.get("shopify")!.clv,
    null,
    "two apps' ARPU/churn ratios cannot be added — no value beats a wrong one",
  );
  assert.equal(
    byKey.get("only-in-a")!.clv,
    250,
    "a single-app row keeps its exact CLV",
  );
});

test("compare-period figures merge the same way as the main period", () => {
  const a = report([
    row("shopify", 10, 1, { listing_view: [10, 0], installed: [1, 0] }, {
      compare: { listing_view: 8, installed: 2 },
    }),
  ]);
  const b = report([
    row("shopify", 4, 1, { listing_view: [4, 0], installed: [1, 0] }, {
      compare: { listing_view: 1, installed: 1 },
    }),
  ]);

  assert.deepEqual(merge([a, b]).rows[0].compare, {
    listing_view: 9,
    installed: 3,
  });
});

test("filter options are the union across apps, deduped", () => {
  const a = report([
    row("shopify", 10, 1, { listing_view: [10, 0], installed: [1, 0] }),
    row("(direct)", 5, 1, { listing_view: [5, 0], installed: [1, 0] }),
  ]);
  const b = report([
    row("google", 4, 1, { listing_view: [4, 0], installed: [1, 0] }),
    row("shopify", 2, 1, { listing_view: [2, 0], installed: [1, 0] }),
  ]);

  assert.deepEqual(merge([a, b]).availableValues.source, [
    "shopify",
    "(direct)",
    "google",
  ]);
});

test("an unconfigured app is skipped silently; a failing one is flagged", () => {
  const good = report([
    row("shopify", 10, 4, { listing_view: [10, 0], installed: [4, 0] }),
  ]);
  const unconfigured = report([], {
    available: false,
    error: "GA4/BigQuery is not configured for this app.",
  });
  const broken = report([], { available: false, error: "BigQuery quota exceeded." });

  const withUnconfigured = merge([good, unconfigured]);
  assert.equal(withUnconfigured.available, true);
  assert.equal(
    withUnconfigured.partialErrors,
    undefined,
    "an app with no GA4 export has no traffic to omit",
  );
  assert.deepEqual(withUnconfigured.totals, { listing_view: 10, installed: 4 });

  const withBroken = merge([good, broken]);
  assert.equal(withBroken.available, true, "one app failing must not blank the page");
  assert.deepEqual(withBroken.partialErrors, ["BigQuery quota exceeded."]);
});

test("every app failing is reported as a failure, not as zero traffic", () => {
  const merged = merge([
    report([], { available: false, error: "BigQuery quota exceeded." }),
    report([], { available: false, error: "GA4/BigQuery is not configured for this app." }),
  ]);

  assert.equal(merged.available, false);
  assert.match(merged.error!, /quota exceeded/);
  assert.deepEqual(merged.rows, []);
  assert.deepEqual(merged.totals, {});
});

test("trend arrays are copied, never aliased into an input report", () => {
  const source = report([
    row("shopify", 10, 1, { listing_view: [6, 4], installed: [1, 0] }),
  ]);
  const before = [...source.rows[0].trend.listing_view!];

  const merged = merge([source, report([
    row("shopify", 2, 0, { listing_view: [2, 0], installed: [0, 0] }),
  ])]);

  assert.deepEqual(merged.rows[0].trend.listing_view, [8, 4]);
  assert.deepEqual(
    source.rows[0].trend.listing_view,
    before,
    "merging must not mutate the per-app report it read",
  );
});
