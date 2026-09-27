import { randomUUID } from "node:crypto";
import type { Discount, Plan } from "../../../generated/prisma/client";
import { prisma } from "../db.server";
import { logger } from "../logger.server";
import { D, isPositive, min, type Money } from "../money.server";
import {
  appCreditCreate,
  appUsageRecordCreate,
  getUsageLineBalance,
} from "../shopify/billing.server";
import {
  isPartnerApiConfigured,
  partnerApiConfigurationIssue,
  partnerApiUnavailableReason,
  partnerShopGid,
} from "../shopify/partner.server";
import {
  loadSubscriptionContext,
  usageLine,
  type SubscriptionContext,
} from "./context.server";
import { collectOutstandingFlexBillingCharges } from "./charge.server";
import {
  activeDiscountFor,
  assertDiscountEligibility,
  DISCOUNT_APPS,
  type DiscountWithApps,
  attachDiscountToSubscription,
  resolveChargeAmount,
  validateDiscountEligibility,
} from "./discounts.server";
import {
  completeEvent,
  completeProration,
  createTierChangeEvent,
} from "./events.server";
import { computeProration } from "./proration";
import { lockKey, withLock } from "./lock.server";
import { subscribe } from "./subscribe.server";

const log = logger.scope("flex-tier-change");

export interface ChangeTierParams {
  subscriptionId: string;
  newPlanId: string;
  /** Set when an auto-upgrade drives this change (spec §6). */
  triggeredByUsageChargeId?: string;
  /** Optional discount to apply on the new tier (else the active one transfers). */
  discountId?: string;
}

export type ChangeTierResult =
  | { status: "changed"; subscriptionId: string }
  | {
      status: "confirmation_required";
      subscriptionId: string;
      confirmationUrl: string;
    };

function inTrial(ctx: SubscriptionContext, now: Date): boolean {
  return Boolean(ctx.trialEndsAt && ctx.trialEndsAt > now);
}

/**
 * In-place tier change, flex → flex (spec §5). Reuses the ONE Shopify
 * subscription — no re-approval — unless an upgrade proration can't fit under
 * the cap, in which case it falls back to a fresh confirmable subscription.
 */
export async function changeTier(
  params: ChangeTierParams,
): Promise<ChangeTierResult> {
  const initial = await loadSubscriptionContext(params.subscriptionId);
  if (!initial)
    throw new Error(`Subscription ${params.subscriptionId} not found`);

  const key = lockKey(
    initial.appInstall.app.organizationId,
    params.subscriptionId,
  );
  return withLock(key, async () => {
    // 1. Collect any outstanding charge first (day-level), so a same-day change
    //    doesn't lose the period's fee (spec §5.1 / §7).
    await collectOutstandingFlexBillingCharges(params.subscriptionId, {
      lockAlreadyHeld: true,
    });

    // Reload to pick up any advanced period dates.
    const prev = await loadSubscriptionContext(params.subscriptionId);
    if (!prev)
      throw new Error(`Subscription ${params.subscriptionId} vanished`);
    if (prev.status !== "ACTIVE") {
      throw new Error(`Subscription ${params.subscriptionId} is not active`);
    }
    if (prev.appInstall.uninstalledAt) {
      throw new Error("Cannot change a subscription for an uninstalled app");
    }
    if (
      !prev.appInstall.app.enabled ||
      prev.appInstall.app.removed ||
      prev.appInstall.app.scheduledForDeletionAt
    ) {
      throw new Error("App is not enabled for tier changes");
    }

    const newPlan = await prisma.plan.findUnique({
      where: { id: params.newPlanId },
    });
    if (!newPlan) throw new Error(`Plan ${params.newPlanId} not found`);
    if (newPlan.appId !== prev.appInstall.appId) {
      throw new Error("New plan does not belong to the same app");
    }
    if (!newPlan.flexBilling)
      throw new Error("changeTier only handles flex → flex");
    if (!newPlan.active || !newPlan.isPublic) {
      throw new Error("Target plan is not available");
    }

    const pendingReplacement = await prisma.subscription.findFirst({
      where: {
        replacesSubscriptionId: prev.id,
        status: "PENDING",
        approvalExpiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        planId: true,
        confirmationUrl: true,
      },
    });
    if (pendingReplacement) {
      if (
        pendingReplacement.planId === newPlan.id &&
        pendingReplacement.confirmationUrl
      ) {
        return {
          status: "confirmation_required",
          subscriptionId: pendingReplacement.id,
          confirmationUrl: pendingReplacement.confirmationUrl,
        };
      }
      throw new Error(
        `Subscription already has pending replacement ${pendingReplacement.id}`,
      );
    }

    const now = new Date();

    // Resolve the discount that will apply to the new subscription.
    const prevDiscount = await activeDiscountFor(params.subscriptionId, now);
    let newDiscount: DiscountWithApps | null = prevDiscount; // transfer by default
    if (params.discountId) {
      newDiscount = await prisma.discount.findUnique({
        where: { id: params.discountId },
        include: DISCOUNT_APPS,
      });
      if (!newDiscount) throw new Error("Discount not found");
      assertDiscountEligibility(newDiscount, {
        appId: prev.appInstall.appId,
        planId: newPlan.id,
      });
    } else if (
      newDiscount &&
      !validateDiscountEligibility(newDiscount, {
        appId: prev.appInstall.appId,
        planId: newPlan.id,
      }).eligible
    ) {
      // A plan-scoped code does not leak onto another plan during transfer.
      newDiscount = null;
    }

    // 2. Day-based proration over the current cycle, on post-discount amounts.
    const prevAmount = resolveChargeAmount(
      prev.plan.amount,
      prevDiscount,
    ).amount;
    const newAmount = resolveChargeAmount(newPlan.amount, newDiscount).amount;
    const periodStart = prev.currentPeriodStart ?? now;
    const periodEnd = prev.currentPeriodEnd ?? now;
    const { netProRated } = computeProration({
      periodStart,
      periodEnd,
      today: now,
      prevAmount,
      newAmount,
    });

    // 3. Write the event NOW. Direction is by LIST PRICE, independent of the
    //    proration sign (spec §5 step 3 / §7).
    const isUpgrade = D(newPlan.amount).greaterThan(prev.plan.amount);
    const eventId = await createTierChangeEvent({
      organizationId: prev.appInstall.app.organizationId,
      type: isUpgrade ? "UPGRADED" : "DOWNGRADED",
      previousSubscriptionId: prev.id,
      amount: newPlan.amount,
      currencyCode: newPlan.currencyCode,
      proration: !netProRated.isZero(),
      prorationAmount: netProRated,
      minutesOnPlanBeforeChange: prev.activatedAt
        ? Math.floor((now.getTime() - prev.activatedAt.getTime()) / 60000)
        : null,
    });

    // 4. Move the money. Default: stay in place. Only a cap-blocked upgrade
    //    flips to the confirmable fallback.
    let continueWithFlexBilling = true;
    if (!inTrial(prev, now)) {
      if (netProRated.greaterThan(0)) {
        continueWithFlexBilling = await upgradeCharge(
          prev,
          newPlan,
          netProRated,
          eventId,
        );
      } else if (netProRated.lessThan(0)) {
        await downgradeCredit(prev, netProRated.abs(), eventId);
      }
      // netProRated == 0 → equal-priced swap: no money, commit in place.
    }

    if (continueWithFlexBilling) {
      const preservingDiscountWindow = Boolean(
        newDiscount && prevDiscount && newDiscount.id === prevDiscount.id,
      );
      const discountEndsAt = preservingDiscountWindow
        ? await currentDiscountEndsAt(
            params.subscriptionId,
            (newDiscount as Discount).id,
          )
        : undefined;
      const newSub = await commitInPlace(prev, newPlan, {
        triggeredByUsageChargeId: params.triggeredByUsageChargeId,
        discountId: newDiscount?.id,
        discountEndsAt,
      });
      await completeEvent(eventId);
      log.info("tier changed in place", {
        from: prev.id,
        to: newSub.id,
        plan: newPlan.name,
        direction: isUpgrade ? "upgrade" : "downgrade",
      });
      return { status: "changed", subscriptionId: newSub.id };
    }

    // Fallback: cap can't fit the upgrade → new confirmable subscription (§5).
    log.warn(
      "upgrade could not fit under cap; creating confirmable subscription",
      {
        subscriptionId: prev.id,
      },
    );
    const preservingDiscountWindow = Boolean(
      newDiscount && prevDiscount && newDiscount.id === prevDiscount.id,
    );
    const fallbackDiscountEndsAt = preservingDiscountWindow
      ? await currentDiscountEndsAt(
          params.subscriptionId,
          (newDiscount as Discount).id,
        )
      : undefined;
    const confirmable = await subscribe({
      appInstallId: prev.appInstallId,
      planId: newPlan.id,
      test: prev.test,
      discountId: newDiscount?.id,
      discountEndsAt: fallbackDiscountEndsAt,
      replacesSubscriptionId: prev.id,
      replacementEventId: eventId,
      idempotencyKey: `replacement:${prev.id}:${newPlan.id}:${
        eventId ?? randomUUID()
      }`,
    });
    // Note: the previous subscription remains active until the merchant approves
    // the new one; the return callback should cancel the old sub on approval.
    return {
      status: "confirmation_required",
      subscriptionId: confirmable.subscriptionId,
      confirmationUrl: confirmable.confirmationUrl,
    };
  });
}

// ---------------------------------------------------------------------------
// §5.a Upgrade charge — gated by remaining cap balance
// ---------------------------------------------------------------------------

async function upgradeCharge(
  prev: SubscriptionContext,
  newPlan: Plan,
  net: Money,
  eventId: string | null,
): Promise<boolean> {
  const line = usageLine(prev);
  if (!line?.platformId || !prev.shopifySubscriptionId) return false;

  // Refetch live balance from Shopify (spec §5.a).
  const balance = await getUsageLineBalance(
    prev.appInstall.app,
    prev.appInstall,
    prev.shopifySubscriptionId,
    line.platformId,
  );
  if (!balance) return false;

  const balanceRemaining = balance.cappedAmount.minus(balance.balanceUsed);
  const hasEnough =
    balance.cappedAmount.greaterThanOrEqualTo(newPlan.amount) &&
    balanceRemaining.greaterThanOrEqualTo(net);
  if (!hasEnough) {
    log.warn("upgrade proration does not fit under cap → fallback", {
      subscriptionId: prev.id,
      cappedAmount: balance.cappedAmount.toString(),
      balanceUsed: balance.balanceUsed.toString(),
      net: net.toString(),
    });
    return false; // → confirmable-subscription fallback
  }

  const chargeKey = `upgrade:${prev.id}:${newPlan.id}:${
    prev.currentPeriodStart?.toISOString() ?? "none"
  }`;
  const existingCharge = await prisma.charge.findUnique({
    where: { idempotencyKey: chargeKey },
  });
  if (existingCharge?.status === "ACTIVE" && existingCharge.platformId) {
    await completeProration(eventId, {
      prorationPlatformId: existingCharge.platformId,
      prorationAmount: existingCharge.amount,
    });
    return true;
  }
  if (existingCharge) {
    throw new Error(`Upgrade charge ${chargeKey} is pending reconciliation`);
  }

  const res = await appUsageRecordCreate(prev.appInstall.app, prev.appInstall, {
    description: "Pro-rated charge for subscription upgrade",
    amount: net,
    currencyCode: newPlan.currencyCode,
    subscriptionLineItemId: line.platformId,
    idempotencyKey: chargeKey,
  });
  if (res.status === "soft_noop") return false; // cap raced full → fallback

  await prisma.charge.create({
    data: {
      subscriptionId: prev.id,
      amount: net,
      chargedAmount: net,
      chargedCurrencyCode: newPlan.currencyCode,
      platformId: res.id,
      idempotencyKey: chargeKey,
      isCredit: false,
      flexBilling: true,
      status: "ACTIVE",
      description: "Pro-rated charge for subscription upgrade",
      occurredAt: new Date(),
    },
  });
  await completeProration(eventId, { prorationPlatformId: res.id });
  return true;
}

// ---------------------------------------------------------------------------
// §5.b Downgrade credit — Partner API, capped at what was collected
// ---------------------------------------------------------------------------

async function downgradeCredit(
  prev: SubscriptionContext,
  theoretical: Money,
  eventId: string | null,
): Promise<void> {
  const app = prev.appInstall.app;

  // Cap at what was actually collected this period (spec §5.b / §7).
  const collectedAgg = await prisma.charge.aggregate({
    where: {
      subscriptionId: prev.id,
      flexBilling: true,
      isCredit: false,
      occurredAt: { gte: prev.currentPeriodStart ?? new Date(0) },
    },
    _sum: { amount: true },
  });
  const collected = D(collectedAgg._sum.amount ?? 0);
  const actualCredit = min(theoretical, collected);

  if (!isPositive(actualCredit)) {
    // Nothing collected yet (e.g. day-1 downgrade) → $0 credit (§9 scenario 7).
    await completeProration(eventId, { prorationAmount: 0 });
    return;
  }

  // Partner API gate. Downgrade credits are irreversible; if the Partner API
  // isn't wired up (the unconfirmed prerequisite), no-op LOUDLY rather than fail.
  if (app.disableDowngradeCredits) {
    log.warn("downgrade credit skipped by explicit app policy", {
      subscriptionId: prev.id,
      reason: partnerApiUnavailableReason(app),
      wouldHaveCredited: actualCredit.toString(),
    });
    await completeProration(eventId, { prorationAmount: 0 });
    return;
  }
  if (!isPartnerApiConfigured(app)) {
    throw new Error(
      `Downgrade credit requires Partner API access: ${
        partnerApiConfigurationIssue(app) ?? "unavailable"
      }. Configure Partner credits or explicitly disable downgrade credits for this app.`,
    );
  }

  if (!prev.appInstall.shopPlatformId) {
    log.warn(
      "downgrade credit skipped — no shopPlatformId for Partner shop gid",
      {
        subscriptionId: prev.id,
      },
    );
    await completeProration(eventId, { prorationAmount: 0 });
    return;
  }
  const shopId = partnerShopGid(prev.appInstall.shopPlatformId);

  const creditKey = `downgrade:${prev.id}:${prev.currentPeriodStart?.toISOString() ?? "none"}`;
  const existingCredit = await prisma.charge.findUnique({
    where: { idempotencyKey: creditKey },
  });
  if (existingCredit?.status === "ACTIVE" && existingCredit.platformId) {
    await completeProration(eventId, {
      prorationPlatformId: existingCredit.platformId,
      prorationAmount: existingCredit.amount,
    });
    return;
  }
  if (existingCredit) {
    throw new Error(
      `Downgrade credit ${creditKey} is pending reconciliation; refusing a duplicate Partner credit`,
    );
  }

  const pendingCredit = await prisma.charge.create({
    data: {
      subscriptionId: prev.id,
      amount: actualCredit,
      chargedAmount: actualCredit,
      chargedCurrencyCode: prev.plan.currencyCode,
      idempotencyKey: creditKey,
      isCredit: true,
      flexBilling: true,
      status: "PENDING",
      description: "Pro-rated credit for subscription downgrade",
      occurredAt: new Date(),
    },
  });
  const res = await appCreditCreate(app, {
    amount: actualCredit,
    currencyCode: prev.plan.currencyCode,
    shopId,
    description: `Pro-rated credit for subscription downgrade [${creditKey}]`,
    test: prev.test,
  });
  await prisma.charge.update({
    where: { id: pendingCredit.id },
    data: { platformId: res.id, status: "ACTIVE" },
  });
  // Rewrite the event's proration amount to the POSITIVE actual credit (§1.5).
  await completeProration(eventId, {
    prorationPlatformId: res.id,
    prorationAmount: actualCredit,
  });
}

// ---------------------------------------------------------------------------
// §5.c Commit in place — reuse the one Shopify subscription
// ---------------------------------------------------------------------------

async function commitInPlace(
  prev: SubscriptionContext,
  newPlan: Plan,
  opts: {
    triggeredByUsageChargeId?: string;
    discountId?: string;
    discountEndsAt?: Date | null;
  },
): Promise<{ id: string }> {
  const prevUsage = usageLine(prev);

  return prisma.$transaction(async (tx) => {
    // Cancel the previous subscription LOCALLY only (skipShopify) — we reuse the
    // single Shopify subscription.
    await tx.subscription.update({
      where: { id: prev.id },
      data: { status: "CANCELLED", canceledAt: new Date() },
    });

    // Create the new subscription, copying the cycle + Shopify linkage forward.
    const newSub = await tx.subscription.create({
      data: {
        appInstallId: prev.appInstallId,
        planId: newPlan.id,
        status: "ACTIVE",
        test: prev.test,
        activatedAt: new Date(),
        currentPeriodStart: prev.currentPeriodStart,
        currentPeriodEnd: prev.currentPeriodEnd,
        nextBillingDate: prev.nextBillingDate,
        billingCycleAnchor: prev.billingCycleAnchor,
        shopifySubscriptionId: prev.shopifySubscriptionId,
        trialStartedAt: prev.trialStartedAt,
        trialEndsAt: prev.trialEndsAt,
        triggeredByUsageChargeId: opts.triggeredByUsageChargeId,
      },
    });

    // Copy the usage line (same Shopify GID) + a fresh recurring line row.
    const newUsage = await tx.subscriptionLineItem.create({
      data: {
        subscriptionId: newSub.id,
        type: "USAGE",
        platformId: prevUsage?.platformId ?? null,
        cappedAmount:
          prevUsage?.cappedAmount ?? newPlan.usageChargeCappedAmount,
        balanceUsed: prevUsage?.balanceUsed ?? D(0),
        spendPeriodStart: prev.currentPeriodStart,
      },
    });
    await tx.subscriptionLineItem.create({
      data: { subscriptionId: newSub.id, type: "SUBSCRIPTION" },
    });
    await tx.subscription.update({
      where: { id: newSub.id },
      data: { usageLineItemId: newUsage.id },
    });

    // Transfer the eligible discount.
    if (opts.discountId) {
      await attachDiscountToSubscription(
        {
          subscriptionId: newSub.id,
          discountId: opts.discountId,
          startsAt: prev.currentPeriodStart ?? new Date(),
          ...(opts.discountEndsAt !== undefined
            ? { endsAt: opts.discountEndsAt }
            : {}),
        },
        tx,
      );
    }

    return { id: newSub.id };
  });
}

/** The endsAt of the active discount row, so a transferred discount keeps it. */
async function currentDiscountEndsAt(
  subscriptionId: string,
  discountId: string,
): Promise<Date | null> {
  const row = await prisma.subscriptionDiscount.findFirst({
    where: { subscriptionId, discountId },
    orderBy: { startsAt: "desc" },
  });
  return row?.endsAt ?? null;
}
