import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  composeMrr,
  mrrComponentBreakdown,
  type RevenueComponents,
} from "../app/lib/reports/mrr-components";

/**
 * The rule that composes a displayed MRR figure.
 *
 * These cover a real production defect: active trials were added to the
 * headline total and to the most recent bar, but to no earlier bar. The chart
 * therefore showed a different definition of MRR for today than for every day
 * before it, the tooltip's rows did not sum to the "Total" beneath them, and
 * net growth subtracted a trial-free starting figure from a trial-inclusive
 * current one — a phantom of several thousand dollars.
 */

/** Cents, because these are float sums of decimal money. */
const cents = (value: number) => Number(value.toFixed(2));

const ALL: RevenueComponents = { annual: true, usage: true, trials: true };
const COMMITTED: RevenueComponents = { annual: true, usage: true, trials: false };

/** A day mid-history, and the newest day. Same shape — that is the point. */
const historical = {
  monthlySubscriptions: 77893.83,
  annualSubscriptions: 3173.9,
  usageCharges: 0,
  trialSubscriptions: 2030,
  mrr: 83097.73,
};
const newest = {
  monthlySubscriptions: 77610.93,
  annualSubscriptions: 3265.91,
  usageCharges: 0,
  trialSubscriptions: 5149.93,
  mrr: 86026.77,
};

describe("composing a displayed MRR", () => {
  it("counts trial MRR on a historical point, not only the newest one", () => {
    assert.equal(
      cents(composeMrr(historical, ALL)),
      83097.73,
      "a mid-history day must include its own trial run rate",
    );
    assert.equal(cents(composeMrr(newest, ALL)), 86026.77);
  });

  it("excludes trial MRR from committed MRR, at every point alike", () => {
    assert.equal(cents(composeMrr(historical, COMMITTED)), 81067.73);
    assert.equal(cents(composeMrr(newest, COMMITTED)), 80876.84);
  });

  it("applies one rule to both ends of a growth calculation", () => {
    /* The defect: `current` was composed with trials and `starting` without,
       so growth carried the entire current trial band as phantom growth. */
    const honest =
      composeMrr(newest, ALL) - composeMrr(historical, ALL);
    const mixed = composeMrr(newest, ALL) - composeMrr(historical, COMMITTED);
    assert.equal(cents(honest), 2929.04);
    assert.equal(
      cents(mixed - honest),
      2030,
      "mixing definitions inflates growth by the starting trial band",
    );
  });

  it("breaks down into rows that sum to the composed total", () => {
    for (const components of [ALL, COMMITTED]) {
      for (const point of [historical, newest]) {
        const rows = mrrComponentBreakdown(point, components);
        const summed = cents(
          rows.reduce((total, row) => total + row.value, 0),
        );
        assert.equal(
          summed,
          cents(composeMrr(point, components)),
          "the tooltip rows must add up to the Total row beneath them",
        );
      }
    }
  });

  it("annualizes every row by the same multiplier", () => {
    const rows = mrrComponentBreakdown(newest, ALL, 12);
    const summed = cents(rows.reduce((total, row) => total + row.value, 0));
    assert.equal(summed, cents(86026.77 * 12));
  });

  it("falls back to a point's own mrr when components are absent", () => {
    // Points written before the per-component columns existed.
    assert.equal(composeMrr({ mrr: 1234.5 }, ALL), 1234.5);
    assert.equal(composeMrr({ mrr: 1234.5 }, COMMITTED), 1234.5);
  });
});
