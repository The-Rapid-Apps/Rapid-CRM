import assert from "node:assert/strict";
import test from "node:test";
import { customerValue, summarizeMetric } from "../app/lib/reports/insight-metrics";

test("CLV is lifetime paid; spend is that over months billed", () => {
  const revenue = { clv: 120, months: 12 };
  assert.equal(customerValue(revenue, "total_clv"), 120);
  assert.equal(customerValue(revenue, "median_clv"), 120);
  assert.equal(customerValue(revenue, "average_spend"), 10);
});

test("a customer who never paid counts as zero, not as missing", () => {
  assert.equal(customerValue(undefined, "average_clv"), 0);
  assert.equal(customerValue(undefined, "median_spend"), 0, "no 0/0 NaN");
  assert.equal(summarizeMetric([0, 0, 90], "average_clv"), 30);
});

test("total, average and median per slice", () => {
  assert.equal(summarizeMetric([10, 20, 60], "total_clv"), 90);
  assert.equal(summarizeMetric([10, 20, 60], "average_clv"), 30);
  assert.equal(summarizeMetric([60, 10, 20], "median_clv"), 20, "sorted, not input order");
  assert.equal(summarizeMetric([10, 20, 30, 40], "median_spend"), 25, "even count averages the middle pair");
  assert.equal(summarizeMetric([], "average_spend"), 0);
});
