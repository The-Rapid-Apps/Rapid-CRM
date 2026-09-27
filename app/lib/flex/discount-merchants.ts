/**
 * Whether a merchant who used a discount is still getting it — the Active /
 * Expired split on a discount's page. Pure, so the rules are tested directly.
 *
 * Two sources, because discounts reach merchants two ways:
 *   - native Shopify billing: an APPLIED DiscountRedemption, whose live state
 *     is the Shopify subscription's (PartnerSubscriptionState);
 *   - flex billing: a SubscriptionDiscount window on our own Subscription.
 */

export type MerchantDiscountState =
  | { active: true; note: string | null }
  | { active: false; reason: string };

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

/** Rough months per billing interval, read off the app's plan key. */
function monthsPerInterval(externalPlanKey: string): number {
  return /(year|annual)/i.test(externalPlanKey) ? 12 : 1;
}

const ENDED_STATUS: Record<string, string> = {
  CANCELLED: "Canceled",
  DECLINED: "Declined",
  EXPIRED: "Expired",
  FROZEN: "Frozen",
};

export function nativeRedemptionState(params: {
  appliedAt: Date | null;
  durationIntervals: number | null;
  externalPlanKey: string;
  /** The Shopify subscription's current status, or null when not synced yet. */
  subscriptionStatus: string | null;
  now: Date;
}): MerchantDiscountState {
  const ended = params.subscriptionStatus ? ENDED_STATUS[params.subscriptionStatus] : undefined;
  if (ended) return { active: false, reason: ended };

  if (params.durationIntervals && params.appliedAt) {
    const endsAt =
      params.appliedAt.getTime() +
      params.durationIntervals * monthsPerInterval(params.externalPlanKey) * MONTH_MS;
    if (endsAt <= params.now.getTime()) return { active: false, reason: "Discount period over" };
  }
  return {
    active: true,
    // Honest about what we could not see, rather than guessing either way.
    note: params.subscriptionStatus ? null : "Subscription status not synced yet",
  };
}

export function flexDiscountState(params: {
  endsAt: Date | null;
  subscriptionStatus: string;
  canceledAt: Date | null;
  now: Date;
}): MerchantDiscountState {
  if (params.canceledAt || ENDED_STATUS[params.subscriptionStatus]) {
    return { active: false, reason: ENDED_STATUS[params.subscriptionStatus] ?? "Canceled" };
  }
  if (params.endsAt && params.endsAt <= params.now) {
    return { active: false, reason: "Discount period over" };
  }
  if (params.subscriptionStatus === "PENDING") {
    return { active: true, note: "Awaiting merchant approval" };
  }
  return { active: true, note: null };
}
