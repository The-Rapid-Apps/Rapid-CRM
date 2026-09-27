import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveFeature, UNLIMITED } from "../app/lib/plans/features";

/**
 * Which statement of a usage ceiling wins.
 *
 * `Plan.limitMax` and a LIMIT feature entitlement keyed on `Plan.limitMetric`
 * hold the same number for the same purpose. Once both exist they drift, and
 * then the app shows a merchant one ceiling — it reads the entitlement through
 * `GET /v1/customer` — while auto-upgrade charges them at another.
 *
 * `resolveUsageLimitForPlan` needs a database, so the decision TABLE is asserted
 * here against the same pure resolver it uses, and the wiring is covered by
 * `tests/flex-billing-workflows`. The rows are the cases that cost money.
 */

const limitFeature = {
  key: "revenue_cap_limit",
  name: "Revenue cap limit",
  description: null,
  type: "LIMIT" as const,
  defaultValue: "100",
  visibleToCustomers: true,
  sortOrder: 0,
};

const entitlement = (value: string) => ({
  key: "revenue_cap_limit",
  value,
  trialValue: null,
});

describe("the ceiling the app enforces is the ceiling billing must use", () => {
  it("a stated entitlement is a usable number", () => {
    const resolved = resolveFeature(limitFeature, entitlement("10000"));
    assert.equal(resolved.limit, 10000);
    assert.equal(resolved.unlimited, false);
    assert.equal(resolved.malformed, false);
  });

  it("unlimited means never upgrade, not a very large ceiling", () => {
    // The distinction matters: a huge number would still upgrade eventually.
    const resolved = resolveFeature(limitFeature, entitlement(UNLIMITED));
    assert.equal(resolved.unlimited, true);
    assert.equal(resolved.limit, null);
  });

  it("a mistyped entitlement is malformed, and must stop the upgrade", () => {
    /*
      The load-bearing case. `resolveUsageLimitForPlan` returns
      `malformed: true` and `limit: null`, and `checkBillingAutoUpgrade` then
      does NOTHING — it does not fall back to `plan.limitMax`.

      Falling back would move a merchant to a more expensive plan on the strength
      of a number the operator plainly mistyped. Declining to upgrade costs only
      revenue, and a corrected value recovers it.
    */
    const resolved = resolveFeature(limitFeature, entitlement("10,000"));
    assert.equal(resolved.malformed, true);
    assert.equal(resolved.limit, null);
    assert.equal(
      resolved.unlimited,
      false,
      "malformed must not be mistaken for unlimited — that would also skip the upgrade, but for the wrong reason and without a warning",
    );
  });

  it("a plan with no entitlement row still has the feature default", () => {
    // Free advertises $100/mo, which is the default rather than an override, so
    // the ceiling must still resolve for a plan that overrides nothing.
    const resolved = resolveFeature(limitFeature, undefined);
    assert.equal(resolved.limit, 100);
    assert.equal(resolved.source, "default");
  });

  it("the trial ceiling applies only inside the trial", () => {
    const withTrial = {
      key: "revenue_cap_limit",
      value: "1000",
      trialValue: "10000",
    };
    assert.equal(
      resolveFeature(limitFeature, withTrial, { inTrial: true }).limit,
      10000,
      "a generous trial ceiling must not upgrade somebody mid-trial",
    );
    assert.equal(
      resolveFeature(limitFeature, withTrial, { inTrial: false }).limit,
      1000,
    );
  });
});
