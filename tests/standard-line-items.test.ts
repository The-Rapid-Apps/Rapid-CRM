import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildStandardLineItems,
  hasUsageLine,
  requiresShopifyObject,
  toShopifyInterval,
  UnsupportedIntervalError,
  type StandardPlanShape,
} from "../app/lib/standard/line-items";

/**
 * What Shopify is asked to bill, per billing model (spec §5).
 *
 * Every case here is one where getting it wrong is invisible until somebody
 * reconciles a month of revenue: a wrong interval, a usage line created for a
 * plan that has no usage, a Shopify object created for a free plan, a discount
 * silently dropped.
 */

const plan = (over: Partial<StandardPlanShape> = {}): StandardPlanShape => ({
  amount: "29",
  currencyCode: "USD",
  interval: "EVERY_30_DAYS",
  ...over,
});

const recurringOf = (items: ReturnType<typeof buildStandardLineItems>) =>
  items.find((i) => "appRecurringPricingDetails" in i.plan)?.plan as
    | { appRecurringPricingDetails: Record<string, never> }
    | undefined;

describe("5.1 flat-rate recurring", () => {
  it("prices the recurring line at the plan's amount", () => {
    const items = buildStandardLineItems(plan());
    assert.equal(items.length, 1);
    const details = (items[0]!.plan as never as {
      appRecurringPricingDetails: {
        price: { amount: string; currencyCode: string };
        interval: string;
      };
    }).appRecurringPricingDetails;
    assert.deepEqual(details.price, { amount: "29.00", currencyCode: "USD" });
    assert.equal(details.interval, "EVERY_30_DAYS");
  });

  it("adds NO usage line for a plan that has no usage", () => {
    // Flex always has one; standard must not, or the merchant approves a
    // metered line that never bills.
    assert.equal(hasUsageLine(buildStandardLineItems(plan())), false);
  });

  it("sends a decimal string, not a float", () => {
    const items = buildStandardLineItems(plan({ amount: 9.9 }));
    const details = (items[0]!.plan as never as {
      appRecurringPricingDetails: { price: { amount: string } };
    }).appRecurringPricingDetails;
    assert.equal(details.price.amount, "9.90");
  });
});

describe("5.2 annual vs 30-day", () => {
  it("sends ANNUAL verbatim", () => {
    // A 30-day line created where annual was meant under-bills 12x.
    const items = buildStandardLineItems(plan({ amount: "479.88", interval: "ANNUAL" }));
    const details = (items[0]!.plan as never as {
      appRecurringPricingDetails: { interval: string; price: { amount: string } };
    }).appRecurringPricingDetails;
    assert.equal(details.interval, "ANNUAL");
    assert.equal(details.price.amount, "479.88");
  });

  it("REFUSES quarterly rather than mapping it", () => {
    /*
      The load-bearing refusal. `PlanInterval` has QUARTERLY and Shopify's
      AppPricingInterval does not. Mapping to EVERY_30_DAYS under-bills 3x,
      mapping to ANNUAL over-bills 4x, and both are silent on every renewal.
    */
    assert.throws(
      () => buildStandardLineItems(plan({ interval: "QUARTERLY" })),
      UnsupportedIntervalError,
    );
    assert.throws(() => toShopifyInterval("QUARTERLY"), (error: Error) => {
      assert.match(error.message, /only EVERY_30_DAYS and ANNUAL/);
      return true;
    });
  });
});

describe("5.3 usage-based / metered", () => {
  const metered = plan({ amount: "0", usageCappedAmount: "100", usageTerms: "$1 per order" });

  it("creates a usage line with the cap and terms", () => {
    const items = buildStandardLineItems(metered);
    assert.equal(items.length, 1, "no recurring line for a $0 base");
    const details = (items[0]!.plan as never as {
      appUsagePricingDetails: {
        terms: string;
        cappedAmount: { amount: string; currencyCode: string };
      };
    }).appUsagePricingDetails;
    assert.equal(details.terms, "$1 per order");
    assert.deepEqual(details.cappedAmount, { amount: "100.00", currencyCode: "USD" });
  });

  it("refuses a usage line with no terms", () => {
    // Shopify shows `terms` on the approval screen; blank is dishonest.
    assert.throws(
      () => buildStandardLineItems(plan({ amount: "0", usageCappedAmount: "100" })),
      /needs customer-facing `terms`/,
    );
  });

  it("ignores a zero cap — a line that can never bill", () => {
    assert.equal(
      requiresShopifyObject(plan({ amount: "0", usageCappedAmount: "0" })),
      false,
    );
  });
});

describe("5.4 hybrid (recurring + usage)", () => {
  const hybrid = plan({ usageCappedAmount: "100", usageTerms: "$1 per order" });

  it("sends both lines in one subscription", () => {
    const items = buildStandardLineItems(hybrid);
    assert.equal(items.length, 2);
    assert.ok(recurringOf(items));
    assert.equal(hasUsageLine(items), true);
  });

  it("attaches a discount to the RECURRING line only", () => {
    const items = buildStandardLineItems(hybrid, {
      discount: { kind: "percentage", percentage: 20, durationLimitInIntervals: 3 },
    });
    const details = (items[0]!.plan as never as {
      appRecurringPricingDetails: {
        discount: { value: { percentage: number }; durationLimitInIntervals: number };
      };
    }).appRecurringPricingDetails;
    assert.equal(details.discount.value.percentage, 20);
    assert.equal(details.discount.durationLimitInIntervals, 3);

    const usage = items[1]!.plan as never as { appUsagePricingDetails: Record<string, unknown> };
    assert.equal(
      "discount" in usage.appUsagePricingDetails,
      false,
      "Shopify has no discounted usage line",
    );
  });

  it("refuses a discount with no recurring line to carry it", () => {
    // Silently dropping it would bill the merchant full price for a plan the
    // pricing page showed as discounted.
    assert.throws(
      () =>
        buildStandardLineItems(
          plan({ amount: "0", usageCappedAmount: "100", usageTerms: "x" }),
          { discount: { kind: "amount", amount: "5" } },
        ),
      /cannot discount a usage line/,
    );
  });

  it("supports a fixed-amount discount", () => {
    const items = buildStandardLineItems(plan(), {
      discount: { kind: "amount", amount: "5" },
    });
    const details = (items[0]!.plan as never as {
      appRecurringPricingDetails: { discount: { value: { amount: string } } };
    }).appRecurringPricingDetails;
    assert.equal(details.discount.value.amount, "5.00");
  });
});

describe("5.6 free / $0 plans", () => {
  it("needs no Shopify object at all", () => {
    // Creating one would send the merchant to an approval screen to agree to
    // pay nothing.
    assert.equal(requiresShopifyObject(plan({ amount: "0" })), false);
    assert.equal(requiresShopifyObject(plan({ amount: 0 })), false);
  });

  it("still needs one when a usage line carries the charge", () => {
    assert.equal(
      requiresShopifyObject(plan({ amount: "0", usageCappedAmount: "50" })),
      true,
    );
  });

  it("throws if a caller builds items for a free plan anyway", () => {
    assert.throws(
      () => buildStandardLineItems(plan({ amount: "0" })),
      /activated locally/,
    );
  });

  it("a priced plan does need one", () => {
    assert.equal(requiresShopifyObject(plan()), true);
  });
});

describe("bad input", () => {
  it("refuses a negative price rather than reading it as FREE", () => {
    /*
      Found by this test: without an explicit check, `isPositive(-5)` is false,
      the recurring line is skipped, and a mistyped plan becomes a free plan that
      activates locally and never bills.
    */
    assert.throws(() => buildStandardLineItems(plan({ amount: "-5" })), /billable amount/);
    assert.throws(() => requiresShopifyObject(plan({ amount: "-5" })), /billable amount/);
    assert.throws(
      () => requiresShopifyObject(plan({ amount: "0", usageCappedAmount: "-1" })),
      /billable amount/,
    );
  });
});
