import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolveDimensionValue, type DimensionRow } from "../app/lib/reports/traffic-dimensions.local";

/**
 * Mandatory equivalence test (per the plan): the JS port of the SQL
 * dimension expressions must produce byte-identical output to the live
 * BigQuery expressions, verified against REAL production `page_location`/
 * `page_referrer`/`traffic_source` values pulled directly from Rapi Bundle's
 * GA4 export (2026-08-16) — not synthetic guesses. A mismatch here is a
 * silently wrong dimension value shown to the user, not a crash.
 */

interface Sample {
  event_name: string;
  page_location: string | null;
  page_referrer: string | null;
  campaign: string | null;
  ts_source: string | null;
  surface_type_sql: string | null;
  search_term_sql: string | null;
  campaign_sql: string | null;
  referrer_site_sql: string | null;
  source_sql: string | null;
}

const samples: Sample[] = JSON.parse(
  readFileSync(
    new URL("fixtures/traffic-dimension-samples.json", import.meta.url),
    "utf8",
  ),
);

function toRow(sample: Sample): DimensionRow {
  return {
    pageLocation: sample.page_location,
    pageReferrer: sample.page_referrer,
    campaign: sample.campaign,
    trafficSourceName: null,
    trafficSourceMedium: null,
    trafficSourceSource: sample.ts_source,
    language: null,
    country: null,
  };
}

test(`real production sample fixture is non-trivial (${samples.length} rows)`, () => {
  assert.ok(samples.length >= 30, "fixture should hold a meaningful sample");
  assert.ok(
    samples.some((s) => s.source_sql === "(direct)"),
    "fixture should cover the direct case",
  );
  assert.ok(
    samples.some((s) => s.search_term_sql),
    "fixture should cover a real search-term value",
  );
  assert.ok(
    samples.some((s) => s.source_sql && s.source_sql !== "(direct)" && s.ts_source === "(direct)"),
    "fixture should cover the self-referral-override case (apps.shopify.com, l.facebook.com, etc.)",
  );
});

test("source: JS port matches live BigQuery output for every sample", () => {
  for (const sample of samples) {
    const actual = resolveDimensionValue("source", toRow(sample));
    const expected = sample.source_sql ?? "(not set)";
    assert.equal(
      actual,
      expected,
      `source mismatch for page_location=${sample.page_location} referrer=${sample.page_referrer} ts_source=${sample.ts_source}`,
    );
  }
});

test("surface_type: JS port matches live BigQuery output for every sample", () => {
  for (const sample of samples) {
    const actual = resolveDimensionValue("surface_type", toRow(sample));
    const expected = sample.surface_type_sql ?? "(not set)";
    assert.equal(actual, expected, `surface_type mismatch for page_location=${sample.page_location}`);
  }
});

// search_term, medium and language moved to new definitions on 2026-09-24;
// their parity is pinned against fresh BigQuery output in
// traffic-url-dimensions.test.ts. This fixture's `search_term_sql` predates it.

test("campaign: JS port matches live BigQuery output for every sample", () => {
  for (const sample of samples) {
    const actual = resolveDimensionValue("campaign", toRow(sample));
    const expected = sample.campaign_sql ?? "(not set)";
    assert.equal(actual, expected, `campaign mismatch for page_location=${sample.page_location}`);
  }
});

/**
 * The regression this dimension actually had: it read the `campaign` event
 * param, which is null on ~99% of real events, so a campaign-filtered report
 * showed 3 page views where Mantle showed 99. Pinned separately from the
 * parity loop above, since a fixture reshuffle could otherwise lose it.
 */
test("campaign ignores the stored event-param column", () => {
  const row: DimensionRow = {
    pageLocation: "https://apps.shopify.com/x?utm_campaign=bundle",
    pageReferrer: null,
    campaign: "something-else",
    trafficSourceName: null,
    trafficSourceMedium: null,
    trafficSourceSource: null,
    language: null,
    country: null,
  };
  assert.equal(resolveDimensionValue("campaign", row), "bundle");
  assert.equal(
    resolveDimensionValue("campaign", { ...row, pageLocation: null }),
    "(not set)",
  );
});

test("referrer_site: JS port matches live BigQuery output for every sample", () => {
  for (const sample of samples) {
    const actual = resolveDimensionValue("referrer_site", toRow(sample));
    const expected = sample.referrer_site_sql ?? "(not set)";
    assert.equal(actual, expected, `referrer_site mismatch for ${sample.page_referrer}`);
  }
});

/**
 * The regression: reading page_referrer whole split one site across every
 * path and query string it was linked from (2,338 rows for 130 real sites on
 * Rapi Bundle). Every listing-page URL below is one site.
 */
test("referrer_site collapses a site's URLs to one host", () => {
  const base: DimensionRow = {
    pageLocation: null,
    pageReferrer: null,
    campaign: null,
    trafficSourceName: null,
    trafficSourceMedium: null,
    trafficSourceSource: null,
    language: null,
    country: null,
  };
  for (const url of [
    "https://apps.shopify.com/rapi",
    "https://apps.shopify.com/rapi?locale=es",
    "https://apps.shopify.com/search?q=bundle",
  ]) {
    assert.equal(
      resolveDimensionValue("referrer_site", { ...base, pageReferrer: url }),
      "apps.shopify.com",
    );
  }
  assert.equal(
    resolveDimensionValue("referrer_site", { ...base, pageReferrer: "not-a-url" }),
    "(not set)",
  );
});

test("native dimensions (country/traffic_source_name) pass through untouched", () => {
  const row: DimensionRow = {
    pageLocation: null,
    pageReferrer: null,
    campaign: null,
    trafficSourceName: "google / organic",
    trafficSourceMedium: "organic",
    trafficSourceSource: "google",
    language: "en-us",
    country: "United States",
  };
  assert.equal(resolveDimensionValue("country", row), "United States");
  assert.equal(resolveDimensionValue("traffic_source_name", row), "google / organic");
});

test("every dimension defaults to (not set) when its underlying field is null", () => {
  const empty: DimensionRow = {
    pageLocation: null,
    pageReferrer: null,
    campaign: null,
    trafficSourceName: null,
    trafficSourceMedium: null,
    trafficSourceSource: null,
    language: null,
    country: null,
  };
  for (const key of [
    "source",
    "medium",
    "search_term",
    "referrer_site",
    "traffic_source_name",
    "campaign",
    "surface_type",
    "surface_detail",
    "surface_inter_position",
    "surface_intra_position",
    "language",
    "country",
  ] as const) {
    assert.equal(resolveDimensionValue(key, empty), "(not set)", `${key} should default`);
  }
});

test("regex extraction matches a bare substring, mirroring BigQuery's own imprecision (not a real query-string parser)", () => {
  // "surface_type=" appears as a value fragment, not a real query param key — the SQL
  // REGEXP_EXTRACT would match it too (no key-boundary anchor), so the JS
  // port must reproduce that, not "fix" it.
  const row: DimensionRow = {
    pageLocation: "https://apps.shopify.com/rapi?other=surface_type=sneaky&x=1",
    pageReferrer: null,
    campaign: null,
    trafficSourceName: null,
    trafficSourceMedium: null,
    trafficSourceSource: null,
    language: null,
    country: null,
  };
  assert.equal(resolveDimensionValue("surface_type", row), "sneaky");
});
