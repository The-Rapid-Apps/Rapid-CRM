import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolveDimensionValue, type DimensionRow } from "../app/lib/reports/traffic-dimensions.local";

/**
 * Search term, medium and language, as redefined for Mantle parity
 * (2026-09-24). Expected values are live BigQuery output of the SQL in
 * traffic-sources.shared.ts: 172 real listing/click/install events from all
 * three apps, picked to cover every branch, plus synthetic edge cases (bad
 * escapes, BOM, Unicode whitespace, Greek sigma) run through BigQuery the same
 * way. When captured, the full 90 days of events matched with zero
 * differences.
 */

interface Sample {
  event_name: string;
  page_location: string | null;
  ts_medium: string | null;
  search_term_sql: string;
  language_sql: string;
  medium_sql: string;
}

const samples: Sample[] = JSON.parse(
  readFileSync(new URL("fixtures/traffic-url-dimension-samples.json", import.meta.url), "utf8"),
);

function toRow(sample: Sample): DimensionRow {
  return {
    pageLocation: sample.page_location,
    pageReferrer: null,
    campaign: null,
    trafficSourceName: null,
    trafficSourceMedium: sample.ts_medium,
    trafficSourceSource: null,
    // Deliberately wrong: the new language must not read device.language.
    language: "xx-device",
    country: null,
  };
}

test(`fixture covers every branch (${samples.length} rows)`, () => {
  const has = (predicate: (s: Sample) => boolean) => samples.some(predicate);
  assert.ok(has((s) => /surface_type=search_ad/.test(s.page_location ?? "") && s.search_term_sql !== "(not set)"));
  assert.ok(has((s) => /%[0-9A-F]{2}/i.test(s.page_location ?? "") && s.search_term_sql !== "(not set)"));
  assert.ok(has((s) => s.medium_sql === "cpc") && has((s) => s.medium_sql === "referral"));
  assert.ok(has((s) => /utm_medium=/.test(s.page_location ?? "")));
  assert.ok(has((s) => s.language_sql !== "en" && s.language_sql !== "(not set)"));
  assert.ok(has((s) => s.page_location === null));
});

for (const key of ["search_term", "language", "medium"] as const) {
  test(`${key}: JS port matches live BigQuery output for every sample`, () => {
    for (const sample of samples) {
      assert.equal(
        resolveDimensionValue(key, toRow(sample)),
        sample[`${key}_sql`],
        `${key} mismatch for page_location=${sample.page_location} medium=${sample.ts_medium}`,
      );
    }
  });
}

test("one search, one row: case, spacing and encoding are normalized", () => {
  const term = (detail: string) =>
    resolveDimensionValue("search_term", {
      ...toRow(samples[0]),
      pageLocation: `https://apps.shopify.com/x?surface_type=search&surface_detail=${detail}`,
    });
  assert.equal(term("Facebook+pixel+"), "facebook pixel");
  assert.equal(term("FACEBOOK+PIXEL"), "facebook pixel");
  assert.equal(term("%E5%83%8F%E7%B4%A0"), "像素");
});
