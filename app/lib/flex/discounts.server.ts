import type {
  Discount,
  Prisma,
  RecurringInterval,
  SubscriptionDiscount,
} from "../../../generated/prisma/client";
import { prisma } from "../db.server";
import { D, max, min, ZERO, type Money, type Numeric } from "../money.server";
import { addInterval } from "./dates";

/**
 * Discounts are the crux of the "how do we discount on Shopify native billing?"
 * problem: because flex bills via usage records we control the exact amount, so
 * a discount is just arithmetic applied to the charge before we post it
 * (spec §4.2). No Shopify discount codes required.
 */

/** Canonical form used by the per-organization unique `orgCodeKey`. */
export function normalizeDiscountCode(code: string): string {
  return code.normalize("NFKC").trim().toUpperCase();
}

/**
 * A discount with the apps it is valid in. One discount can cover several
 * apps (DiscountApp); `appId` is only its primary one.
 *
 * `apps` is optional in the type so a bare Discount still type-checks, and
 * eligibility FAILS CLOSED without it: a caller that forgot to load the list
 * gets the discount refused in every app but its primary, never granted in an
 * app it was not meant for. Load it with `DISCOUNT_APPS`.
 */
export type DiscountWithApps = Discount & { apps?: Array<{ appId: string }> };

export const DISCOUNT_APPS = { apps: { select: { appId: true } } } as const;

export function discountCoversApp(discount: DiscountWithApps, appId: string): boolean {
  return discount.appId === appId || Boolean(discount.apps?.some((row) => row.appId === appId));
}

/** WHERE fragment: discounts valid in this app (primary or listed). */
export function discountInApp(appId: string): Prisma.DiscountWhereInput {
  return { OR: [{ appId }, { apps: { some: { appId } } }] };
}

/**
 * The discount a code names for an app — looked up across the organization,
 * since a code is unique per organization now, then checked to cover the app.
 * Falls back to the per-app key for rows that carry no organization-wide key.
 */
export async function findDiscountByCodeForApp(
  client: Pick<Prisma.TransactionClient, "app" | "discount">,
  appId: string,
  normalizedCode: string,
): Promise<DiscountWithApps | null> {
  const app = await client.app.findUnique({ where: { id: appId }, select: { organizationId: true } });
  if (!app) return null;
  const byOrg = await client.discount.findUnique({
    where: { organizationId_orgCodeKey: { organizationId: app.organizationId, orgCodeKey: normalizedCode } },
    include: DISCOUNT_APPS,
  });
  if (byOrg) return discountCoversApp(byOrg, appId) ? byOrg : null;
  return client.discount.findUnique({
    where: { appId_normalizedCode: { appId, normalizedCode } },
    include: DISCOUNT_APPS,
  });
}

/**
 * The organization and code key a discount row must carry. Every writer goes
 * through this so no path can create a code that dodges the unique key.
 */
export async function discountOrgScope(
  client: Pick<Prisma.TransactionClient, "app">,
  appId: string,
  normalizedCode: string | null,
): Promise<{ organizationId: string; orgCodeKey: string | null }> {
  const app = await client.app.findUniqueOrThrow({ where: { id: appId }, select: { organizationId: true } });
  return {
    organizationId: app.organizationId,
    orgCodeKey: normalizedCode || null,
  };
}

export type DiscountEligibilityReason =
  "NOT_FOUND" | "INACTIVE" | "WRONG_APP" | "PLAN_REQUIRED" | "PLAN_MISMATCH";

export type DiscountEligibility =
  { eligible: true } | { eligible: false; reason: DiscountEligibilityReason };

export class DiscountEligibilityError extends Error {
  readonly reason: Exclude<DiscountEligibilityReason, "NOT_FOUND">;

  constructor(reason: Exclude<DiscountEligibilityReason, "NOT_FOUND">) {
    const messages: Record<typeof reason, string> = {
      INACTIVE: "Discount is inactive",
      WRONG_APP: "Discount is not available in this app",
      PLAN_REQUIRED: "Discount is restricted to a plan; provide planId",
      PLAN_MISMATCH: "Discount is not eligible for this plan",
    };
    super(messages[reason]);
    this.name = "DiscountEligibilityError";
    this.reason = reason;
  }
}

/**
 * Check app ownership, active state, and optional plan restriction. Plan-scoped
 * discounts are never treated as generic when the caller omits `planId`.
 */
export function validateDiscountEligibility(
  discount: DiscountWithApps,
  params: { appId: string; planId?: string | null },
): DiscountEligibility {
  if (!discountCoversApp(discount, params.appId)) {
    return { eligible: false, reason: "WRONG_APP" };
  }
  if (!discount.active) {
    return { eligible: false, reason: "INACTIVE" };
  }
  if (discount.planId && !params.planId) {
    return { eligible: false, reason: "PLAN_REQUIRED" };
  }
  if (discount.planId && discount.planId !== params.planId) {
    return { eligible: false, reason: "PLAN_MISMATCH" };
  }
  return { eligible: true };
}

export function assertDiscountEligibility(
  discount: DiscountWithApps,
  params: { appId: string; planId?: string | null },
): void {
  const result = validateDiscountEligibility(discount, params);
  if (!result.eligible) {
    if (result.reason === "NOT_FOUND") {
      // `NOT_FOUND` is only returned by code lookup, never by validation.
      throw new Error("Discount not found");
    }
    throw new DiscountEligibilityError(result.reason);
  }
}

export type DiscountCodeResolution =
  | { valid: true; discount: DiscountWithApps }
  | { valid: false; reason: DiscountEligibilityReason };

/**
 * Resolve a normalized code for an app and enforce the definition's active and
 * plan scope. This is the shared lookup for subscribe and the public resolver.
 */
export async function findEligibleDiscountByCode(params: {
  appId: string;
  code: string;
  planId?: string | null;
}): Promise<DiscountCodeResolution> {
  const normalizedCode = normalizeDiscountCode(params.code);
  if (!normalizedCode) return { valid: false, reason: "NOT_FOUND" };

  const discount = await findDiscountByCodeForApp(prisma, params.appId, normalizedCode);
  if (!discount) return { valid: false, reason: "NOT_FOUND" };

  const eligibility = validateDiscountEligibility(discount, params);
  return eligibility.eligible
    ? { valid: true, discount }
    : { valid: false, reason: eligibility.reason };
}

/** The absolute price to charge after applying a discount to a list amount. */
export function priceAfterDiscount(
  listAmount: Numeric,
  discount: Discount,
): Money {
  const list = D(listAmount);
  switch (discount.type) {
    case "PERCENTAGE": {
      // value is a percent (0-100).
      const factor = D(1).minus(D(discount.value).div(100));
      return max(list.times(factor), ZERO);
    }
    case "AMOUNT":
      return max(list.minus(D(discount.value)), ZERO);
    case "FLAT_PRICE":
      // A malformed or app-wide flat price must never turn a discount into a
      // surcharge on a cheaper plan.
      return min(max(D(discount.value), ZERO), list);
    default:
      return list;
  }
}

/**
 * The discount active on a subscription at `atDate` — the row whose window
 * covers the date (startsAt <= atDate AND (endsAt IS NULL OR endsAt >= atDate))
 * and whose discount is still active. Mirrors spec §4.2 `activeDiscountFor`.
 */
export async function activeDiscountFor(
  subscriptionId: string,
  atDate: Date,
): Promise<DiscountWithApps | null> {
  const subscription = await prisma.subscription.findUnique({
    where: { id: subscriptionId },
    select: {
      planId: true,
      appInstall: { select: { appId: true } },
    },
  });
  if (!subscription) return null;

  const row = await prisma.subscriptionDiscount.findFirst({
    where: {
      subscriptionId,
      startsAt: { lte: atDate },
      OR: [{ endsAt: null }, { endsAt: { gte: atDate } }],
      discount: {
        active: true,
        AND: [
          discountInApp(subscription.appInstall.appId),
          { OR: [{ planId: null }, { planId: subscription.planId }] },
        ],
      },
    },
    orderBy: { startsAt: "desc" },
    // With its apps, so a caller re-checking eligibility (tier change) does
    // not fail closed on a discount valid in a non-primary app.
    include: { discount: { include: DISCOUNT_APPS } },
  });
  return row?.discount ?? null;
}

export interface ResolvedAmount {
  /** Amount to actually charge (post-discount when applicable). */
  amount: Money;
  discount: Discount | null;
  /**
   * true when the discount reduced the charged amount. APP_CREDITS discounts do
   * NOT reduce the charge (the fee stays at list price and a separate credit is
   * issued) so this is false for them (spec §4.2).
   */
  reducedCharge: boolean;
}

/**
 * Resolve the amount to charge for a period given the list amount and the
 * discount active at the period start. PRICE_REDUCTION lowers the charge;
 * APP_CREDITS leaves it at list price.
 */
export function resolveChargeAmount(
  listAmount: Numeric,
  discount: Discount | null,
): ResolvedAmount {
  if (discount && discount.discountMethod !== "APP_CREDITS") {
    return {
      amount: priceAfterDiscount(listAmount, discount),
      discount,
      reducedCharge: true,
    };
  }
  return { amount: D(listAmount), discount, reducedCharge: false };
}

/**
 * Inclusive expiry for a discount lasting `durationIntervals` plan periods.
 * Subtracting 1ms matters because `activeDiscountFor` treats `endsAt` as
 * inclusive; without it a one-interval discount would also match the next
 * interval's exact start.
 */
export function calculateDiscountEndsAt(params: {
  startsAt: Date;
  durationIntervals: number | null;
  recurringInterval: RecurringInterval;
  recurringIntervalCount: number;
}): Date | null {
  if (params.durationIntervals == null) return null;
  if (
    !Number.isSafeInteger(params.durationIntervals) ||
    params.durationIntervals <= 0 ||
    !Number.isSafeInteger(params.recurringIntervalCount) ||
    params.recurringIntervalCount <= 0
  ) {
    throw new Error(
      "Discount duration and plan interval count must be positive integers",
    );
  }
  const totalIntervals =
    params.durationIntervals * params.recurringIntervalCount;
  if (!Number.isSafeInteger(totalIntervals)) {
    throw new Error("Discount duration is too large");
  }

  const exclusiveEnd = addInterval(
    params.startsAt,
    params.recurringInterval,
    totalIntervals,
  );
  return new Date(exclusiveEnd.getTime() - 1);
}

type DiscountTransaction = Pick<
  Prisma.TransactionClient,
  "discount" | "subscription" | "subscriptionDiscount"
>;

export interface AttachDiscountParams {
  subscriptionId: string;
  discountId: string;
  /**
   * Defaults to the subscription's current period start, which ensures a
   * just-created discount applies to the collapsed first billing period.
   */
  startsAt?: Date;
  /**
   * Preserve an existing expiry during an in-place tier change. When omitted,
   * durationIntervals is calculated against the target subscription's cadence.
   */
  endsAt?: Date | null;
}

async function attachDiscount(
  params: AttachDiscountParams,
  tx: DiscountTransaction,
): Promise<SubscriptionDiscount> {
  const [subscription, discount] = await Promise.all([
    tx.subscription.findUnique({
      where: { id: params.subscriptionId },
      select: {
        id: true,
        planId: true,
        currentPeriodStart: true,
        trialEndsAt: true,
        plan: {
          select: {
            recurringInterval: true,
            recurringIntervalCount: true,
          },
        },
        appInstall: { select: { appId: true } },
      },
    }),
    tx.discount.findUnique({ where: { id: params.discountId }, include: DISCOUNT_APPS }),
  ]);

  if (!subscription) {
    throw new Error(`Subscription ${params.subscriptionId} not found`);
  }
  if (!discount) {
    throw new Error(`Discount ${params.discountId} not found`);
  }
  assertDiscountEligibility(discount, {
    appId: subscription.appInstall.appId,
    planId: subscription.planId,
  });

  const startsAt =
    params.startsAt ?? subscription.currentPeriodStart ?? new Date();
  // A local trial is not a paid billing interval. Keep the discount visible
  // during the trial, but start a limited duration's interval clock at trial
  // end so the first paid period receives the discount.
  const durationStartsAt =
    subscription.trialEndsAt && subscription.trialEndsAt > startsAt
      ? subscription.trialEndsAt
      : startsAt;
  const endsAt =
    params.endsAt !== undefined
      ? params.endsAt
      : calculateDiscountEndsAt({
          startsAt: durationStartsAt,
          durationIntervals: discount.durationIntervals,
          recurringInterval: subscription.plan.recurringInterval,
          recurringIntervalCount: subscription.plan.recurringIntervalCount,
        });

  // A newly attached discount replaces any other window active at this point.
  // Otherwise an older forever-discount could unexpectedly become active again
  // after the newer, limited-duration discount expires.
  await tx.subscriptionDiscount.updateMany({
    where: {
      subscriptionId: subscription.id,
      discountId: { not: discount.id },
      startsAt: { lte: startsAt },
      OR: [{ endsAt: null }, { endsAt: { gte: startsAt } }],
    },
    data: { endsAt: new Date(startsAt.getTime() - 1) },
  });

  // The compound unique key makes retries idempotent while still updating a
  // transferred discount's window.
  return tx.subscriptionDiscount.upsert({
    where: {
      subscriptionId_discountId: {
        subscriptionId: subscription.id,
        discountId: discount.id,
      },
    },
    create: {
      subscriptionId: subscription.id,
      discountId: discount.id,
      startsAt,
      endsAt,
    },
    update: { startsAt, endsAt },
  });
}

/**
 * Attach an eligible discount and calculate its duration window. Pass the
 * caller's Prisma transaction when subscription creation/tier change must be
 * atomic; without one this helper opens its own transaction.
 */
export function attachDiscountToSubscription(
  params: AttachDiscountParams,
  tx?: Prisma.TransactionClient,
): Promise<SubscriptionDiscount> {
  if (tx) return attachDiscount(params, tx);
  return prisma.$transaction((transaction) =>
    attachDiscount(params, transaction),
  );
}

/**
 * End all discount windows that are active at `atDate`. The stored expiry is
 * one millisecond before `atDate`, matching the inclusive window predicate.
 */
export async function expireSubscriptionDiscounts(
  subscriptionId: string,
  atDate = new Date(),
  tx?: Prisma.TransactionClient,
): Promise<number> {
  const expire = async (client: DiscountTransaction) => {
    const result = await client.subscriptionDiscount.updateMany({
      where: {
        subscriptionId,
        startsAt: { lte: atDate },
        OR: [{ endsAt: null }, { endsAt: { gte: atDate } }],
      },
      data: { endsAt: new Date(atDate.getTime() - 1) },
    });
    return result.count;
  };

  if (tx) return expire(tx);
  return prisma.$transaction((transaction) => expire(transaction));
}
