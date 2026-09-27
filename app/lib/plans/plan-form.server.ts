/**
 * One validator for the plan form, shared by **Add plan** and **Edit plan**.
 *
 * It lives here rather than in either route because the two pages submit the
 * same fields and must agree about them exactly. When the create page owned the
 * rules alone, an edit page would have re-typed them — and the copy that drifts
 * is always the one that lets a bad plan through.
 *
 * The rules that are NOT obvious, and why they exist:
 *
 *  - **A flex plan's usage cap must exceed its price.** Flex posts the whole fee
 *    as a usage record, so the ceiling has to clear the fee plus the largest
 *    proration; at parity the first proration silently fails.
 *  - **A standard plan may not be quarterly.** Shopify's `AppPricingInterval`
 *    has no quarterly value, and either mapping mis-bills every renewal.
 *  - **Entitlements are validated before anything is written.** The caller then
 *    writes them only after the plan row succeeds — the other order leaves a
 *    plan behind when a limit is mistyped, so the operator's retry collides on
 *    the plan name.
 *  - **`flexBilling` is not editable.** Pass `existing` and the stored rail
 *    wins over whatever the form posts. The rail decides how each Shopify
 *    subscription was built, so flipping it would have the charge path misread
 *    the ones already collecting.
 */
import { prisma } from "~/lib/db.server";
import { validateFeatureValue, type PlanFeatureType } from "~/lib/plans/features";

/** Up to 12 whole digits and 6 decimals — the shape of `Decimal(18, 6)`. */
export const DECIMAL_PATTERN = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/;

export type PlanInterval = "EVERY_30_DAYS" | "QUARTERLY" | "ANNUAL";

export interface ParsedPlanForm {
  name: string;
  description: string | null;
  amount: number;
  interval: PlanInterval;
  recurringInterval: "MONTH" | "YEAR";
  recurringIntervalCount: number;
  flexBilling: boolean;
  usageBilling: boolean;
  usageChargeCappedAmount: number;
  trialDays: number;
  isPublic: boolean;
  onUsageLimitReached: "NONE" | "UPGRADE";
  autoUpgradeToPlanId: string | null;
  limitMetric: string | null;
  limitMax: number | null;
  /** Business revenue ceiling in USD; null = no cap. App-enforced, never computed here. */
  revenueCapLimit: number | null;
  revenueCapPeriod: "BILLING_PERIOD" | "LIFETIME";
}

export interface PlanEntitlementRow {
  featureId: string;
  value: string;
}

export type PlanFormResult =
  | { error: string }
  | { data: ParsedPlanForm; entitlements: PlanEntitlementRow[] };

export function isPlanFormError(
  result: PlanFormResult,
): result is { error: string } {
  return "error" in result;
}

interface ParseOptions {
  form: FormData;
  appId: string;
  /**
   * Editing: the plan being saved. Its name is excluded from the duplicate
   * check, it may not be its own upgrade target, and — since the rail is fixed
   * at creation — its stored `flexBilling` overrides whatever the form says.
   */
  existing?: { id: string; flexBilling: boolean } | null;
}

export async function parsePlanForm({
  form,
  appId,
  existing = null,
}: ParseOptions): Promise<PlanFormResult> {
  const name = String(form.get("name") || "").trim();
  const description = String(form.get("description") ?? "").trim();
  const amountRaw = String(form.get("amount") ?? "").trim();
  const capRaw = String(form.get("cap") ?? "").trim();
  const trialDaysRaw = String(form.get("trialDays") ?? "0").trim();
  const limitMetric = String(form.get("limitMetric") ?? "").trim();
  const limitMaxRaw = String(form.get("limitMax") ?? "").trim();
  const revenueCapRaw = String(form.get("revenueCap") ?? "").trim();
  const revenueCapPeriodRaw = String(
    form.get("revenueCapPeriod") ?? "BILLING_PERIOD",
  ).trim();
  const autoUpgradeToPlanId = String(
    form.get("autoUpgradeToPlanId") ?? "",
  ).trim();
  const interval = String(form.get("interval") ?? "EVERY_30_DAYS");
  const isPublic = form.get("isPublic") === "on";
  const flexBilling = existing
    ? existing.flexBilling
    : form.get("flexBilling") === "on";
  const usageBilling = form.get("usageBilling") === "on";

  const amount = Number(amountRaw);
  const trialDays = Number(trialDaysRaw);

  if (!name || !DECIMAL_PATTERN.test(amountRaw) || !Number.isFinite(amount)) {
    return { error: "Name and price are required" };
  }
  if (name.length > 100) {
    return { error: "Plan name must be 100 characters or fewer" };
  }
  if (description.length > 500) {
    return { error: "Description must be 500 characters or fewer" };
  }
  if (amount < 0) return { error: "Price cannot be negative" };
  if (!Number.isInteger(trialDays) || trialDays < 0 || trialDays > 365) {
    return { error: "Trial days must be a whole number from 0 to 365" };
  }
  if (!["EVERY_30_DAYS", "QUARTERLY", "ANNUAL"].includes(interval)) {
    return { error: "Choose a valid billing interval" };
  }
  if (!flexBilling && interval === "QUARTERLY") {
    return {
      error:
        "Shopify billing has no quarterly interval. Price this plan monthly or annually" +
        // On edit the rail is locked, so "enable Flex Billing" is advice the
        // operator cannot act on.
        (existing ? "." : ", or enable Flex Billing."),
    };
  }

  let cap = 0;
  if (flexBilling || usageBilling) {
    if (!DECIMAL_PATTERN.test(capRaw) || !Number.isFinite(Number(capRaw))) {
      return { error: "A usage cap is required for this plan" };
    }
    cap = Number(capRaw);
    if (flexBilling && cap <= amount) {
      return {
        error:
          "Usage cap must be greater than the plan price so billing and proration have headroom",
      };
    }
    if (!flexBilling && cap <= 0) {
      return { error: "A metered plan needs a usage cap above zero" };
    }
  }

  if (Boolean(limitMetric) !== Boolean(limitMaxRaw)) {
    return { error: "Limit metric and limit max must be provided together" };
  }
  const limitMax = limitMaxRaw ? Number(limitMaxRaw) : null;
  if (limitMaxRaw && !DECIMAL_PATTERN.test(limitMaxRaw)) {
    return {
      error: "Limit max must have no more than 12 whole and 6 decimal digits",
    };
  }
  if (limitMax !== null && (!Number.isFinite(limitMax) || limitMax <= 0)) {
    return { error: "Limit max must be greater than zero" };
  }
  if (limitMetric && !autoUpgradeToPlanId) {
    return { error: "Choose the plan this usage limit should upgrade to" };
  }

  // Revenue cap: always USD, optional (blank = no cap). We only STORE it — the
  // app converts merchant revenue to USD and enforces — so validation is just
  // shape. A zero or negative cap is a mistake, not "unlimited" (that's blank).
  let revenueCapLimit: number | null = null;
  if (revenueCapRaw) {
    if (!DECIMAL_PATTERN.test(revenueCapRaw)) {
      return {
        error:
          "Revenue cap (USD) must be a number with no more than 12 whole and 6 decimal digits, or blank for no cap",
      };
    }
    revenueCapLimit = Number(revenueCapRaw);
    if (!Number.isFinite(revenueCapLimit) || revenueCapLimit <= 0) {
      return {
        error: "Revenue cap must be greater than zero — leave it blank for no cap",
      };
    }
  }
  const revenueCapPeriod =
    revenueCapPeriodRaw === "LIFETIME" ? "LIFETIME" : "BILLING_PERIOD";

  const duplicate = await prisma.plan.findFirst({
    where: {
      appId,
      name,
      ...(existing ? { id: { not: existing.id } } : {}),
    },
    select: { id: true },
  });
  if (duplicate) {
    return { error: `A plan named "${name}" already exists for this app` };
  }

  let resolvedUpgradeTo: string | null = null;
  if (autoUpgradeToPlanId) {
    if (existing && autoUpgradeToPlanId === existing.id) {
      return { error: "A plan cannot automatically upgrade to itself" };
    }
    const target = await prisma.plan.findFirst({
      where: {
        id: autoUpgradeToPlanId,
        appId,
        active: true,
        isPublic: true,
        flexBilling: true,
      },
      select: { id: true, amount: true },
    });
    if (!target) {
      return { error: "Choose a valid active plan from the same app" };
    }
    if (Number(target.amount.toString()) <= amount) {
      return { error: "Automatic upgrade target must cost more than this plan" };
    }
    if (existing) {
      const cycle = await findsItsWayBack(target.id, existing.id);
      if (cycle) {
        return {
          error: `That upgrade chain loops back to this plan (via ${cycle}). A merchant on it would be bounced between tiers forever.`,
        };
      }
    }
    resolvedUpgradeTo = target.id;
  }

  const cadence =
    interval === "ANNUAL"
      ? { recurringInterval: "YEAR" as const, recurringIntervalCount: 1 }
      : interval === "QUARTERLY"
        ? { recurringInterval: "MONTH" as const, recurringIntervalCount: 3 }
        : { recurringInterval: "MONTH" as const, recurringIntervalCount: 1 };

  /*
    Entitlements. Only rows that DIFFER from a feature's default are returned —
    absence means the default, so a stored copy would both bloat the table and
    stop tracking a default somebody later changes.
  */
  const entitlements: PlanEntitlementRow[] = [];
  if (form.get("differentiates") === "on") {
    const features = await prisma.planFeature.findMany({
      where: { appId, archivedAt: null },
      select: { id: true, name: true, type: true, defaultValue: true },
    });
    for (const feature of features) {
      const type = feature.type as PlanFeatureType;
      const submitted =
        type === "BOOLEAN"
          ? form.get(`feat:${feature.id}`) === "on"
            ? "true"
            : "false"
          : String(form.get(`feat:${feature.id}`) ?? "").trim();
      // Blank on a non-boolean means "leave it at the default".
      if (type !== "BOOLEAN" && submitted === "") continue;
      const invalid = validateFeatureValue(type, submitted);
      if (invalid) return { error: `${feature.name}: ${invalid}` };
      if (submitted === feature.defaultValue) continue;
      entitlements.push({ featureId: feature.id, value: submitted });
    }
  }

  return {
    data: {
      name,
      description: description || null,
      amount,
      interval: interval as PlanInterval,
      ...cadence,
      flexBilling,
      usageBilling: !flexBilling && usageBilling,
      usageChargeCappedAmount: cap,
      trialDays,
      isPublic,
      onUsageLimitReached: limitMetric ? "UPGRADE" : "NONE",
      autoUpgradeToPlanId: resolvedUpgradeTo,
      limitMetric: limitMetric || null,
      limitMax,
      revenueCapLimit,
      revenueCapPeriod,
    },
    entitlements,
  };
}

/**
 * Walk the upgrade chain from `startId` and report the plan whose target is
 * `lookingFor`, or null.
 *
 * Only edit can create a cycle: a plan being created has no id yet, so nothing
 * can point at it. Editing an existing one can close the loop (A→B, then B→A),
 * and the auto-upgrade sweep would then move a merchant back and forth on every
 * run. Bounded by the chain length it has already walked, so a pre-existing
 * cycle elsewhere cannot hang this.
 */
async function findsItsWayBack(
  startId: string,
  lookingFor: string,
): Promise<string | null> {
  const seen = new Set<string>([lookingFor]);
  let current: string | null = startId;
  while (current && !seen.has(current)) {
    seen.add(current);
    const next: { name: string; autoUpgradeToPlanId: string | null } | null =
      await prisma.plan.findUnique({
        where: { id: current },
        select: { name: true, autoUpgradeToPlanId: true },
      });
    if (!next) return null;
    if (next.autoUpgradeToPlanId === lookingFor) return next.name;
    current = next.autoUpgradeToPlanId;
  }
  return null;
}

/**
 * The cap every live subscription on this plan was approved for, and how many
 * there are.
 *
 * Load-bearing on edit. A flex charge is a usage record against the line item's
 * **approved** cap, and that cap was fixed when the merchant approved the
 * subscription — raising `plan.amount` later does not raise it. When the fee no
 * longer fits, `createFlexBillingCharge` returns `soft_noop: cap_full`, the
 * period does not advance, and the merchant simply stops being billed. Nothing
 * errors and nothing alerts; the revenue just stops.
 *
 * So the edit action refuses a price that would not fit. The way to charge more
 * than an approved cap allows is a tier change, which re-approves.
 */
export async function liveCapCeiling(
  planId: string,
): Promise<{ subscriptions: number; minCap: number | null }> {
  const lines = await prisma.subscriptionLineItem.findMany({
    where: {
      // USAGE only: the recurring line carries no cap, and an ADDON's ceiling
      // is its own, not the one the plan fee is posted against.
      type: "USAGE",
      cappedAmount: { not: null },
      subscription: {
        planId,
        status: "ACTIVE",
        canceledAt: null,
      },
    },
    select: { cappedAmount: true },
  });
  if (lines.length === 0) return { subscriptions: 0, minCap: null };
  const caps = lines.map((l) => Number(l.cappedAmount));
  return { subscriptions: lines.length, minCap: Math.min(...caps) };
}
