import { randomUUID } from "node:crypto";
import {
  BILLING_ACCESS_QUERY_PARAM,
  createBillingAccessToken,
} from "../billing-access.server";
import { prisma } from "../db.server";
import { env } from "../env.server";
import { logger } from "../logger.server";
import {
  appSubscriptionCancel,
  appSubscriptionCreate,
  getAppSubscriptionStatus,
} from "../shopify/billing.server";
import { addInterval, startOfDay } from "./dates";
import {
  completeEvent,
  completeProration,
  recordSubscribed,
} from "./events.server";
import { loadSubscriptionContext } from "./context.server";
import {
  assertDiscountEligibility,
  DISCOUNT_APPS,
  attachDiscountToSubscription,
} from "./discounts.server";
import { lockKey, withLock } from "./lock.server";
import { activateStandardSubscription } from "../standard/subscribe.server";

const log = logger.scope("flex-subscribe");

export interface SubscribeParams {
  appInstallId: string;
  planId: string;
  test?: boolean;
  /** Optional discount to attach to the new subscription. */
  discountId?: string;
  /** Preserve an existing discount window during a replacement subscription. */
  discountEndsAt?: Date | null;
  /** Stable client request key. Reusing it returns the original pending result. */
  idempotencyKey?: string;
  /** Cap-full tier-change fallback linkage. */
  replacesSubscriptionId?: string;
  replacementEventId?: string | null;
}

export interface SubscribeResult {
  subscriptionId: string;
  confirmationUrl: string;
}

export interface SubscribeDependencies {
  createShopifySubscription: typeof appSubscriptionCreate;
  getShopifySubscriptionStatus: typeof getAppSubscriptionStatus;
  cancelShopifySubscription: typeof appSubscriptionCancel;
}

const defaultDependencies: SubscribeDependencies = {
  createShopifySubscription: appSubscriptionCreate,
  getShopifySubscriptionStatus: getAppSubscriptionStatus,
  cancelShopifySubscription: appSubscriptionCancel,
};

const APPROVAL_TTL_MS = 48 * 60 * 60 * 1000;

async function existingSubscribeResult(
  installId: string,
  planId: string,
  idempotencyKey: string | undefined,
  replacesSubscriptionId: string | undefined,
  discountId: string | undefined,
): Promise<SubscribeResult | null> {
  if (idempotencyKey) {
    const keyed = await prisma.subscription.findUnique({
      where: { idempotencyKey },
      include: {
        discounts: { select: { discountId: true } },
      },
    });
    if (keyed) {
      const existingDiscountId = keyed.discounts[0]?.discountId;
      if (
        keyed.appInstallId !== installId ||
        keyed.planId !== planId ||
        keyed.replacesSubscriptionId !== (replacesSubscriptionId ?? null) ||
        existingDiscountId !== discountId
      ) {
        throw new Error(
          "Idempotency key was already used with different subscription parameters",
        );
      }
      if (
        keyed.status === "PENDING" &&
        keyed.approvalExpiresAt &&
        keyed.approvalExpiresAt > new Date() &&
        keyed.confirmationUrl
      ) {
        return {
          subscriptionId: keyed.id,
          confirmationUrl: keyed.confirmationUrl,
        };
      }
      if (keyed.status === "PENDING") {
        throw new Error(
          "Subscription creation is still pending reconciliation; retry later",
        );
      }
      throw new Error(
        `Idempotency key belongs to a ${keyed.status.toLowerCase()} subscription; use a new key`,
      );
    }
  }

  const existing = await prisma.subscription.findFirst({
    where: {
      appInstallId: installId,
      status: "PENDING",
      canceledAt: null,
      approvalExpiresAt: { gt: new Date() },
      planId,
      replacesSubscriptionId: replacesSubscriptionId ?? null,
    },
    include: { discounts: { select: { discountId: true } } },
    orderBy: { createdAt: "desc" },
  });
  if (!existing) return null;
  if (!existing.confirmationUrl) {
    throw new Error(
      "A subscription creation is still pending reconciliation; retry later",
    );
  }
  if (existing.discounts[0]?.discountId !== discountId) {
    throw new Error(
      "A pending subscription already exists with a different discount",
    );
  }
  return {
    subscriptionId: existing.id,
    confirmationUrl: existing.confirmationUrl,
  };
}

/**
 * Procedure: subscribe (spec §3).
 *
 * Creates ONE Shopify subscription with a $0 recurring line + a capped usage
 * line, sends `trialDays: 0` to Shopify (trials are local), persists the usage
 * line GID, and COLLAPSES the first period to today so the next cron bills in
 * advance. Does NOT charge here, and does NOT write a `subscribed` audit event
 * (that happens at activation, spec §7).
 */
export async function subscribe(
  params: SubscribeParams,
  dependencies: Partial<SubscribeDependencies> = {},
): Promise<SubscribeResult> {
  const deps = { ...defaultDependencies, ...dependencies };
  const install = await prisma.appInstall.findUnique({
    where: { id: params.appInstallId },
    include: { app: true },
  });
  if (!install) throw new Error(`AppInstall ${params.appInstallId} not found`);
  if (install.uninstalledAt) {
    throw new Error(`AppInstall ${params.appInstallId} is uninstalled`);
  }
  if (
    !install.app.enabled ||
    install.app.removed ||
    install.app.scheduledForDeletionAt
  ) {
    throw new Error("App is not enabled for new subscriptions");
  }
  if (install.app.distribution !== "PUBLIC") {
    throw new Error("Flex billing requires a publicly distributed Shopify app");
  }

  const plan = await prisma.plan.findUnique({ where: { id: params.planId } });
  if (!plan) throw new Error(`Plan ${params.planId} not found`);
  if (plan.appId !== install.appId) {
    throw new Error("Plan does not belong to the same app as the install");
  }
  if (!plan.flexBilling) {
    throw new Error("subscribe() only handles flex plans");
  }
  if (!plan.active || !plan.isPublic) {
    throw new Error("Plan is not available for new subscriptions");
  }

  if (params.discountId) {
    const discount = await prisma.discount.findUnique({
      where: { id: params.discountId },
      include: DISCOUNT_APPS,
    });
    if (!discount) throw new Error(`Discount ${params.discountId} not found`);
    assertDiscountEligibility(discount, {
      appId: install.appId,
      planId: plan.id,
    });
  }

  const requestedIdempotencyKey = params.idempotencyKey?.trim();
  if (
    requestedIdempotencyKey &&
    (requestedIdempotencyKey.length < 8 || requestedIdempotencyKey.length > 191)
  ) {
    throw new Error("Idempotency key must be between 8 and 191 characters");
  }

  const subscribeKey = lockKey(
    install.app.organizationId,
    `subscribe:${install.id}`,
  );
  return withLock(subscribeKey, async () => {
    const previousResult = await existingSubscribeResult(
      install.id,
      plan.id,
      requestedIdempotencyKey,
      params.replacesSubscriptionId,
      params.discountId,
    );
    if (previousResult) return previousResult;

    if (!params.replacesSubscriptionId) {
      const active = await prisma.subscription.findFirst({
        where: {
          appInstallId: install.id,
          status: "ACTIVE",
          canceledAt: null,
        },
        select: { id: true },
      });
      if (active) {
        throw new Error(
          `App install already has active subscription ${active.id}`,
        );
      }
    } else {
      const replacement = await prisma.subscription.findFirst({
        where: {
          replacesSubscriptionId: params.replacesSubscriptionId,
          status: "PENDING",
          approvalExpiresAt: { gt: new Date() },
        },
        select: { id: true },
      });
      if (replacement) {
        throw new Error(
          `Subscription already has pending replacement ${replacement.id}`,
        );
      }
    }

    const test = params.test ?? false;
    const now = new Date();
    const sod = startOfDay(now);
    const trialing =
      !params.replacesSubscriptionId &&
      plan.trialDays > 0 &&
      !install.trialConsumedAt;
    const trialEnd = trialing ? addInterval(sod, "DAY", plan.trialDays) : null;
    const idempotencyKey = requestedIdempotencyKey || randomUUID();

    // 1. Create the PENDING subscription first so we have an id for the returnUrl.
    const subscription = await prisma.subscription.create({
      data: {
        appInstallId: install.id,
        planId: plan.id,
        status: "PENDING",
        test,
        idempotencyKey,
        approvalExpiresAt: new Date(now.getTime() + APPROVAL_TTL_MS),
        replacesSubscriptionId: params.replacesSubscriptionId,
        replacementEventId: params.replacementEventId ?? null,
        currentPeriodStart: sod,
        currentPeriodEnd: trialEnd ?? sod,
        nextBillingDate: trialEnd ?? sod,
        billingCycleAnchor: sod,
        trialStartedAt: trialing ? now : null,
        trialEndsAt: trialEnd,
      },
    });

    const callbackAccess = createBillingAccessToken(install.id, {
      ttlSeconds: APPROVAL_TTL_MS / 1_000,
    });
    const callbackUrl = new URL("/api/flex/return", env.APP_URL);
    callbackUrl.searchParams.set("sid", subscription.id);
    callbackUrl.searchParams.set(
      BILLING_ACCESS_QUERY_PARAM,
      callbackAccess.token,
    );
    const returnUrl = callbackUrl.toString();

    let createdShopify:
      | {
          shopifySubscriptionId: string;
          usageLineItemId: string;
          confirmationUrl: string;
          test: boolean;
        }
      | undefined;
    try {
      // 2/3. Create the Shopify subscription ($0 recurring + capped usage, trialDays 0).
      const res = await deps.createShopifySubscription(install.app, install, {
        name: plan.name,
        test,
        currencyCode: plan.currencyCode,
        cappedAmount: plan.usageChargeCappedAmount,
        terms: plan.flexBillingTerms,
        returnUrl,
      });
      createdShopify = res;

      // 4. Persist the Shopify ids and the all-important usage line GID.
      await prisma.$transaction(async (tx) => {
        const usageLine = await tx.subscriptionLineItem.create({
          data: {
            subscriptionId: subscription.id,
            type: "USAGE",
            platformId: res.usageLineItemId,
            cappedAmount: plan.usageChargeCappedAmount,
            spendPeriodStart: sod,
          },
        });
        await tx.subscriptionLineItem.create({
          data: { subscriptionId: subscription.id, type: "SUBSCRIPTION" },
        });
        await tx.subscription.update({
          where: { id: subscription.id },
          data: {
            shopifySubscriptionId: res.shopifySubscriptionId,
            usageLineItemId: usageLine.id,
            confirmationUrl: res.confirmationUrl,
            test: res.test,
          },
        });
        if (params.discountId) {
          await attachDiscountToSubscription(
            {
              subscriptionId: subscription.id,
              discountId: params.discountId,
              startsAt: sod,
              ...(params.discountEndsAt !== undefined
                ? { endsAt: params.discountEndsAt }
                : {}),
            },
            tx,
          );
        }
      });

      log.info("subscription created (pending approval)", {
        subscriptionId: subscription.id,
        shop: install.shopDomain,
        plan: plan.name,
      });

      return {
        subscriptionId: subscription.id,
        confirmationUrl: res.confirmationUrl,
      };
    } catch (err) {
      // If Shopify creation succeeded but local persistence failed, cancel the
      // remote object before deleting our reconciliation handle. When cleanup
      // itself fails, keep a FROZEN row with the remote id for safe manual
      // reconciliation instead of losing track of a potentially billable sub.
      if (createdShopify) {
        try {
          await deps.cancelShopifySubscription(install.app, install, {
            shopifySubscriptionId: createdShopify.shopifySubscriptionId,
            prorate: false,
          });
        } catch (cleanupError) {
          await prisma.subscription.update({
            where: { id: subscription.id },
            data: {
              status: "FROZEN",
              shopifySubscriptionId: createdShopify.shopifySubscriptionId,
              confirmationUrl: createdShopify.confirmationUrl,
            },
          });
          throw new Error(
            `Subscription persistence failed and Shopify cleanup also failed; ${subscription.id} is frozen for reconciliation: ${
              cleanupError instanceof Error
                ? cleanupError.message
                : String(cleanupError)
            }`,
            { cause: err },
          );
        }
      }
      await prisma.subscription
        .delete({ where: { id: subscription.id } })
        .catch(() => {});
      throw err;
    }
  });
}

/**
 * Activate a subscription after the merchant approves (called by the
 * charge-return callback). Confirms the Shopify subscription is ACTIVE,
 * marks it activated, RE-COLLAPSES the period to the approval day (so the first
 * charge is prepayment on the next cron), and stores the `subscribed` event.
 * Idempotent.
 */
export async function activateSubscription(
  subscriptionId: string,
  dependencies: Partial<SubscribeDependencies> = {},
): Promise<{ activated: boolean; reason?: string }> {
  const deps = { ...defaultDependencies, ...dependencies };
  const initial = await loadSubscriptionContext(subscriptionId);
  if (!initial) return { activated: false, reason: "not_found" };
  const key = lockKey(
    initial.appInstall.app.organizationId,
    `activate:${initial.appInstallId}`,
  );
  return withLock(key, () =>
    activateSubscriptionUnderLock(subscriptionId, deps),
  );
}

async function activateSubscriptionUnderLock(
  subscriptionId: string,
  deps: SubscribeDependencies,
): Promise<{ activated: boolean; reason?: string }> {
  const ctx = await loadSubscriptionContext(subscriptionId);
  if (!ctx) return { activated: false, reason: "not_found" };
  if (ctx.status === "ACTIVE" && ctx.activatedAt) {
    await recordSubscribed({
      organizationId: ctx.appInstall.app.organizationId,
      subscriptionId,
      amount: ctx.plan.amount,
      currencyCode: ctx.plan.currencyCode,
      interval: ctx.plan.interval,
      test: ctx.test,
    });
    return { activated: true }; // idempotent
  }
  if (ctx.status !== "PENDING" && ctx.status !== "EXPIRED") {
    return {
      activated: false,
      reason: `local_status_${ctx.status.toLowerCase()}`,
    };
  }
  if (!ctx.shopifySubscriptionId) {
    return { activated: false, reason: "no_shopify_subscription" };
  }
  // Confirm the merchant actually approved.
  const status = await deps.getShopifySubscriptionStatus(
    ctx.appInstall.app,
    ctx.appInstall,
    ctx.shopifySubscriptionId,
  );
  if (!status || status.status !== "ACTIVE") {
    if (ctx.approvalExpiresAt && ctx.approvalExpiresAt <= new Date()) {
      await prisma.subscription.update({
        where: { id: subscriptionId },
        data: { status: "EXPIRED" },
      });
      return { activated: false, reason: "approval_expired" };
    }
    log.warn("activation skipped — Shopify subscription not active", {
      subscriptionId,
      shopifyStatus: status?.status,
    });
    return {
      activated: false,
      reason: `shopify_status_${status?.status ?? "unknown"}`,
    };
  }

  const now = new Date();
  const sod = startOfDay(now);
  const trialing = Boolean(
    !ctx.replacesSubscriptionId &&
    ctx.plan.trialDays > 0 &&
    !ctx.appInstall.trialConsumedAt,
  );
  const trialEndsAt = trialing
    ? addInterval(sod, "DAY", ctx.plan.trialDays)
    : null;
  const periodEnd = trialEndsAt ?? sod;

  const otherActive = await prisma.subscription.findFirst({
    where: {
      appInstallId: ctx.appInstallId,
      id: { not: subscriptionId },
      status: "ACTIVE",
      canceledAt: null,
    },
  });

  if (ctx.replacesSubscriptionId) {
    if (!otherActive || otherActive.id !== ctx.replacesSubscriptionId) {
      return { activated: false, reason: "replacement_target_not_active" };
    }
    if (otherActive.shopifySubscriptionId) {
      const oldStatus = await deps.getShopifySubscriptionStatus(
        ctx.appInstall.app,
        ctx.appInstall,
        otherActive.shopifySubscriptionId,
      );
      if (oldStatus?.status === "ACTIVE") {
        await deps.cancelShopifySubscription(
          ctx.appInstall.app,
          ctx.appInstall,
          {
            shopifySubscriptionId: otherActive.shopifySubscriptionId,
            prorate: false,
          },
        );
      }
    }
  } else if (otherActive) {
    // A duplicate approval must never create a second live subscription.
    await deps.cancelShopifySubscription(ctx.appInstall.app, ctx.appInstall, {
      shopifySubscriptionId: ctx.shopifySubscriptionId,
      prorate: false,
    });
    await prisma.subscription.update({
      where: { id: subscriptionId },
      data: { status: "CANCELLED", canceledAt: now },
    });
    return { activated: false, reason: "active_subscription_exists" };
  }

  await prisma.$transaction(async (tx) => {
    if (ctx.replacesSubscriptionId) {
      await tx.subscription.update({
        where: { id: ctx.replacesSubscriptionId },
        data: { status: "CANCELLED", canceledAt: now },
      });
    }
    await tx.subscription.update({
      where: { id: subscriptionId },
      data: {
        status: "ACTIVE",
        activatedAt: now,
        approvalExpiresAt: null,
        // Collapse to the approval day (or keep trial end) — spec §3.
        currentPeriodStart: sod,
        currentPeriodEnd: periodEnd,
        nextBillingDate: periodEnd,
        billingCycleAnchor: sod,
        trialStartedAt: trialing ? now : null,
        trialEndsAt,
      },
    });
    if (trialing && !ctx.appInstall.trialConsumedAt) {
      await tx.appInstall.update({
        where: { id: ctx.appInstallId },
        data: { trialConsumedAt: now },
      });
    }
    for (const application of ctx.discounts) {
      await attachDiscountToSubscription(
        {
          subscriptionId,
          discountId: application.discountId,
          startsAt: sod,
          ...(ctx.replacesSubscriptionId ? { endsAt: application.endsAt } : {}),
        },
        tx,
      );
    }
  });

  // Store the (otherwise virtual) subscribed event on activation, spec §7.
  await recordSubscribed({
    organizationId: ctx.appInstall.app.organizationId,
    subscriptionId,
    amount: ctx.plan.amount,
    currencyCode: ctx.plan.currencyCode,
    interval: ctx.plan.interval,
    test: ctx.test,
  });
  if (ctx.replacementEventId) {
    await completeProration(ctx.replacementEventId, { prorationAmount: 0 });
    await completeEvent(ctx.replacementEventId);
  }

  log.info("subscription activated", { subscriptionId, trialing });
  return { activated: true };
}

/** Expire abandoned approval rows so future subscribe attempts are not blocked. */
export async function expirePendingSubscriptions(
  now = new Date(),
): Promise<{ expired: number }> {
  const result = await prisma.subscription.updateMany({
    where: {
      status: "PENDING",
      OR: [
        { approvalExpiresAt: { lte: now } },
        {
          approvalExpiresAt: null,
          createdAt: {
            lte: new Date(now.getTime() - APPROVAL_TTL_MS),
          },
        },
      ],
    },
    data: { status: "EXPIRED" },
  });
  if (result.count)
    log.info("expired pending subscriptions", { expired: result.count });
  return { expired: result.count };
}

/**
 * Recover approvals whose browser callback was lost. Shopify doesn't emit an
 * approval webhook, so the daily scheduler checks recent pending/expired rows
 * against the authoritative remote status before expiring them locally.
 */
export async function reconcilePendingSubscriptionApprovals(
  now = new Date(),
): Promise<{ checked: number; activated: number; errors: number }> {
  const candidates = await prisma.subscription.findMany({
    where: {
      status: { in: ["PENDING", "EXPIRED"] },
      shopifySubscriptionId: { not: null },
      createdAt: {
        gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1_000),
      },
      appInstall: {
        uninstalledAt: null,
        app: {
          enabled: true,
          removed: false,
          scheduledForDeletionAt: null,
        },
      },
    },
    select: { id: true, plan: { select: { flexBilling: true } } },
    orderBy: { createdAt: "asc" },
    take: 200,
  });

  const summary = {
    checked: candidates.length,
    activated: 0,
    errors: 0,
  };
  for (const candidate of candidates) {
    try {
      /*
        Dispatch on the rail, exactly as the return route does.

        This sweep is rail-agnostic by design — an approval callback can be lost
        on either rail — but the ACTIVATIONS are not interchangeable. Running
        flex activation on a standard subscription would collapse its first
        period and post a first charge of our own for a subscription Shopify is
        already collecting on, i.e. bill the merchant twice.
      */
      const result = candidate.plan.flexBilling
        ? await activateSubscription(candidate.id)
        : await activateStandardSubscription(candidate.id);
      if (result.activated) summary.activated += 1;
    } catch (error) {
      summary.errors += 1;
      log.error("pending approval reconciliation failed", {
        subscriptionId: candidate.id,
        error: String(error),
      });
    }
  }
  return summary;
}
