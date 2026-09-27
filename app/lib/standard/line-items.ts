/**
 * Turning a plan into the line items Shopify should bill — standard billing.
 *
 * This is the one thing that varies per billing model (spec §5), so it lives
 * apart from the mutation that sends it and is pure, which is what lets the
 * money-shaped cases be asserted without a Shopify account.
 *
 * The difference from flex, in one line: flex pins a **$0** recurring line and
 * expresses every price as a usage record so a tier change never re-approves;
 * standard puts the **real price** on the recurring line and lets Shopify
 * collect on its own cycle. Nothing here posts a charge.
 */

/** Shopify's `AppPricingInterval`. It has exactly these two values. */
export type ShopifyPricingInterval = "EVERY_30_DAYS" | "ANNUAL";

export interface StandardPlanShape {
  /** The recurring price. `0` ⇒ free (see `requiresShopifyObject`). */
  amount: string | number;
  currencyCode: string;
  /** This platform's `PlanInterval`, which has one value Shopify lacks. */
  interval: "EVERY_30_DAYS" | "ANNUAL" | "QUARTERLY";
  /**
   * The usage line's ceiling. A usage line is added only when this is present
   * AND positive — a `0` cap is a line that can never be billed against, which
   * Shopify would still make the merchant approve.
   */
  usageCappedAmount?: string | number | null;
  /** Customer-facing text Shopify shows on the usage line. Required with one. */
  usageTerms?: string | null;
}

/** A discount on the RECURRING line. Shopify has no usage-line discount. */
export type StandardDiscount =
  | { kind: "amount"; amount: string | number; durationLimitInIntervals?: number }
  | { kind: "percentage"; percentage: number; durationLimitInIntervals?: number };

export class UnsupportedIntervalError extends Error {}

export interface RecurringLineItem {
  plan: {
    appRecurringPricingDetails: {
      price: { amount: string; currencyCode: string };
      interval: ShopifyPricingInterval;
      discount?: {
        value: { amount?: string; percentage?: number };
        durationLimitInIntervals?: number;
      };
    };
  };
}

export interface UsageLineItem {
  plan: {
    appUsagePricingDetails: {
      terms: string;
      cappedAmount: { amount: string; currencyCode: string };
    };
  };
}

export type StandardLineItem = RecurringLineItem | UsageLineItem;

/** Shopify wants a decimal string; a float would round in transit. */
function money(value: string | number): string {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Not a billable amount: ${String(value)}`);
  }
  return parsed.toFixed(2);
}

function isPositive(value: string | number | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

/**
 * Map this platform's interval to Shopify's, or refuse.
 *
 * `QUARTERLY` exists in `PlanInterval` and does NOT exist in Shopify's
 * `AppPricingInterval`. Refusing is the only safe answer: mapping it to
 * `EVERY_30_DAYS` under-bills by 3× and mapping it to `ANNUAL` over-bills by 4×,
 * both silently and both on every renewal thereafter. The spec makes the same
 * point about a 30-day line created where annual was meant (§5.2) — the failure
 * is invisible until somebody reconciles a year of revenue.
 */
export function toShopifyInterval(
  interval: StandardPlanShape["interval"],
): ShopifyPricingInterval {
  if (interval === "EVERY_30_DAYS" || interval === "ANNUAL") return interval;
  throw new UnsupportedIntervalError(
    `Shopify billing has no ${interval} interval — it supports only EVERY_30_DAYS ` +
      `and ANNUAL. A ${interval} plan cannot be billed on the standard rail; ` +
      `price it monthly or annually, or put it on flex billing.`,
  );
}

/**
 * Refuse a negative amount before anything can interpret it as free.
 *
 * Without this, `isPositive` reads `-5` as "not positive", the recurring line is
 * skipped, and a plan the operator mistyped becomes a FREE plan that activates
 * locally and never bills. Silently. Both entry points below call this, because
 * either one reached first would otherwise make that decision.
 */
function assertBillableAmounts(plan: StandardPlanShape): void {
  for (const [label, value] of [
    ["amount", plan.amount],
    ["usageCappedAmount", plan.usageCappedAmount],
  ] as const) {
    if (value === null || value === undefined) continue;
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error(`Not a billable amount for ${label}: ${String(value)}`);
    }
  }
}

/**
 * Whether this plan needs a Shopify object at all.
 *
 * A `$0` recurring price with no usage line has nothing for Shopify to collect,
 * and creating a subscription for it would send the merchant through an approval
 * screen to agree to pay nothing. Spec §5.6: activate locally, create nothing,
 * and teach reconciliation that such a subscription having no Shopify id is
 * EXPECTED rather than an orphan.
 *
 * A `$0` base WITH a usage line still needs one — the usage line is the charge.
 */
export function requiresShopifyObject(plan: StandardPlanShape): boolean {
  assertBillableAmounts(plan);
  return isPositive(plan.amount) || isPositive(plan.usageCappedAmount);
}

/**
 * The line items for one plan.
 *
 * Covers every model the spec lists, chosen by the plan's own shape rather than
 * by a mode flag: a positive price yields a recurring line, a positive cap
 * yields a usage line, and hybrid is simply both. A discount attaches to the
 * recurring line ONLY — Shopify has no concept of a discounted usage line, so
 * accepting one for a usage-only plan would silently ignore it.
 */
export function buildStandardLineItems(
  plan: StandardPlanShape,
  options: { discount?: StandardDiscount | null } = {},
): StandardLineItem[] {
  assertBillableAmounts(plan);
  const items: StandardLineItem[] = [];
  const interval = toShopifyInterval(plan.interval);

  if (isPositive(plan.amount)) {
    const recurring: RecurringLineItem = {
      plan: {
        appRecurringPricingDetails: {
          price: { amount: money(plan.amount), currencyCode: plan.currencyCode },
          interval,
        },
      },
    };
    const discount = options.discount;
    if (discount) {
      recurring.plan.appRecurringPricingDetails.discount = {
        value:
          discount.kind === "amount"
            ? { amount: money(discount.amount) }
            : { percentage: discount.percentage },
        ...(discount.durationLimitInIntervals !== undefined
          ? { durationLimitInIntervals: discount.durationLimitInIntervals }
          : {}),
      };
    }
    items.push(recurring);
  } else if (options.discount) {
    throw new Error(
      "A discount needs a recurring line to attach to; Shopify cannot discount a usage line.",
    );
  }

  if (isPositive(plan.usageCappedAmount)) {
    if (!plan.usageTerms?.trim()) {
      // Shopify shows `terms` to the merchant on the approval screen, and an
      // empty string is both rejected and, if it were not, dishonest.
      throw new Error("A usage line needs customer-facing `terms`.");
    }
    items.push({
      plan: {
        appUsagePricingDetails: {
          terms: plan.usageTerms.trim(),
          cappedAmount: {
            amount: money(plan.usageCappedAmount as string | number),
            currencyCode: plan.currencyCode,
          },
        },
      },
    });
  }

  if (items.length === 0) {
    // Only reachable when the caller skipped `requiresShopifyObject`.
    throw new Error(
      "This plan is free with no usage line, so it must be activated locally " +
        "without creating a Shopify subscription (see requiresShopifyObject).",
    );
  }
  return items;
}

/** Whether a built set contains a usage line, i.e. whose GID must be persisted. */
export function hasUsageLine(items: StandardLineItem[]): boolean {
  return items.some((item) => "appUsagePricingDetails" in item.plan);
}
