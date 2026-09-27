/**
 * Standard (Shopify-collected) billing: subscribe and activate.
 *
 * The inverse of `flex/subscribe.server.ts` on the one axis that matters —
 * **Shopify owns the billing clock here.** Consequences, all of them
 * load-bearing (spec §0):
 *
 *   - **No charging cron.** Nothing in this file or downstream of it posts a
 *     charge. Shopify collects on its own cycle. If you find yourself wanting to
 *     bill a standard subscription from a job, the plan belongs on flex.
 *   - **Period dates are a MIRROR, and are left null until Shopify states
 *     them.** Flex computes them at create time because flex advances its own
 *     clock. Guessing them here would put a fabricated `currentPeriodEnd` in
 *     front of an operator until the first reconciliation quietly changed it.
 *   - **Trials are Shopify's.** `trialDays` goes on the subscription and Shopify
 *     runs it; the local trial columns are written as a mirror so
 *     `/v1/customer` can answer "in trial?" without a round trip.
 *   - **Verify before activate.** The return redirect is a trigger, not proof.
 *
 * It deliberately reuses flex's lock and its return route rather than growing a
 * parallel set: one activation lock per install is what makes "exactly one
 * active subscription" enforceable across both rails at once.
 */
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
  appSubscriptionCreateStandard,
  getAppSubscriptionStatus,
} from "../shopify/billing.server";
import { addInterval, startOfDay } from "../flex/dates";
import { lockKey, withLock } from "../flex/lock.server";
import { recordSubscribed } from "../flex/events.server";
import {
  buildStandardLineItems,
  requiresShopifyObject,
  type StandardDiscount,
} from "./line-items";

const log = logger.scope("standard-subscribe");

/** How long a merchant has to approve before the pending row is swept. */
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export class StandardBillingError extends Error {
  constructor(
    message: string,
    readonly status = 422,
  ) {
    super(message);
  }
}

export interface StandardSubscribeParams {
  appInstallId: string;
  planId: string;
  test?: boolean;
  discount?: StandardDiscount | null;
  idempotencyKey?: string;
  /** The subscription this one replaces, cancelled only once this verifies. */
  replacesSubscriptionId?: string;
}

export interface StandardSubscribeResult {
  subscriptionId: string;
  /** Null for a free plan, which is active already and has nothing to approve. */
  confirmationUrl: string | null;
  status: "PENDING" | "ACTIVE";
}

async function loadInstallAndPlan(params: StandardSubscribeParams) {
  const install = await prisma.appInstall.findUnique({
    where: { id: params.appInstallId },
    include: { app: true },
  });
  if (!install) throw new StandardBillingError("Install not found", 404);
  if (install.uninstalledAt) {
    throw new StandardBillingError("App is uninstalled for this shop");
  }

  const plan = await prisma.plan.findUnique({ where: { id: params.planId } });
  if (!plan) throw new StandardBillingError("Plan not found", 404);
  if (plan.appId !== install.appId) {
    throw new StandardBillingError("Plan belongs to a different app");
  }
  if (plan.flexBilling) {
    // The mirror image of flex's own guard. Routing a flex plan through here
    // would price its real amount on the recurring line, which is exactly what
    // flex exists to avoid — and the tier change after it would re-approve.
    throw new StandardBillingError(
      "subscribeStandard() only handles non-flex plans; use flex subscribe()",
    );
  }
  if (!plan.active) {
    throw new StandardBillingError("Plan is not available for new subscriptions");
  }
  return { install, plan };
}

/**
 * Start a standard subscription.
 *
 * Returns a `confirmationUrl` the caller must send the merchant to — except for
 * a free plan, which is active on return (spec §5.6).
 */
export async function subscribeStandard(
  params: StandardSubscribeParams,
): Promise<StandardSubscribeResult> {
  const { install, plan } = await loadInstallAndPlan(params);

  if (params.idempotencyKey) {
    const existing = await prisma.subscription.findUnique({
      where: { idempotencyKey: params.idempotencyKey },
      select: { id: true, status: true, confirmationUrl: true },
    });
    if (existing) {
      // Re-answer the original request rather than creating a second
      // subscription — the merchant may simply have refreshed.
      return {
        subscriptionId: existing.id,
        confirmationUrl: existing.confirmationUrl,
        status: existing.status === "ACTIVE" ? "ACTIVE" : "PENDING",
      };
    }
  }

  const now = new Date();
  const test = params.test ?? false;
  /*
    A usage line only when the plan opts in. `usageChargeCappedAmount` is NOT
    NULL and every plan carries one for flex's sake, so treating a non-zero cap
    as the signal would hand a metered line to every flat plan that ever had one
    set — and Shopify would make the merchant approve a line that never bills.
  */
  const planShape = {
    amount: plan.amount.toString(),
    currencyCode: plan.currencyCode,
    interval: plan.interval,
    usageCappedAmount: plan.usageBilling
      ? plan.usageChargeCappedAmount.toString()
      : null,
    usageTerms: plan.flexBillingTerms,
  };

  /*
    The trial window, mirrored.

    Shopify runs it, so this is a local copy for `/v1/customer` and the reports —
    never the authority. `trialConsumedAt` still applies: a cancel/resubscribe
    loop must not mint a second free trial, and that rule is ours because Shopify
    would happily grant one every time.
  */
  const trialing = plan.trialDays > 0 && !install.trialConsumedAt;
  const sod = startOfDay(now);
  const trialEnd = trialing ? addInterval(sod, "DAY", plan.trialDays) : null;

  const subscription = await prisma.subscription.create({
    data: {
      appInstallId: install.id,
      planId: plan.id,
      status: "PENDING",
      test,
      idempotencyKey: params.idempotencyKey || randomUUID(),
      approvalExpiresAt: new Date(now.getTime() + APPROVAL_TTL_MS),
      replacesSubscriptionId: params.replacesSubscriptionId,
      trialStartedAt: trialing ? now : null,
      trialEndsAt: trialEnd,
      /*
        Period dates deliberately absent. Shopify states them and activation
        mirrors them; writing a guess here would show an operator a billing date
        that silently changes on the first sync.
      */
    },
  });

  /* ------------------------------------------------- §5.6 the free shortcut */
  if (!requiresShopifyObject(planShape)) {
    // Nothing for Shopify to collect, so no object and no approval screen. The
    // subscription is simply live, and reconciliation is told to expect a local
    // ACTIVE row with no `shopifySubscriptionId`.
    await activateStandardLocally(subscription.id);
    return {
      subscriptionId: subscription.id,
      confirmationUrl: null,
      status: "ACTIVE",
    };
  }

  const callbackAccess = createBillingAccessToken(install.id, {
    ttlSeconds: APPROVAL_TTL_MS / 1_000,
  });
  const callbackUrl = new URL("/api/flex/return", env.APP_URL);
  callbackUrl.searchParams.set("sid", subscription.id);
  callbackUrl.searchParams.set(BILLING_ACCESS_QUERY_PARAM, callbackAccess.token);

  try {
    const lineItems = buildStandardLineItems(planShape, {
      discount: params.discount ?? null,
    });
    const created = await appSubscriptionCreateStandard(install.app, install, {
      name: plan.name,
      test,
      returnUrl: callbackUrl.toString(),
      lineItems,
      // Shopify's trial, not ours. Zero when the install has already used one.
      trialDays: trialing ? plan.trialDays : 0,
    });

    await prisma.$transaction(async (tx) => {
      await tx.subscriptionLineItem.create({
        data: {
          subscriptionId: subscription.id,
          type: "SUBSCRIPTION",
          platformId: created.recurringLineItemId,
          amount: plan.amount,
          currencyCode: plan.currencyCode,
        },
      });
      if (created.usageLineItemId) {
        await tx.subscriptionLineItem.create({
          data: {
            subscriptionId: subscription.id,
            type: "USAGE",
            platformId: created.usageLineItemId,
            cappedAmount: plan.usageChargeCappedAmount,
            spendPeriodStart: sod,
          },
        });
      }
      await tx.subscription.update({
        where: { id: subscription.id },
        data: {
          shopifySubscriptionId: created.shopifySubscriptionId,
          confirmationUrl: created.confirmationUrl,
          test: created.test,
        },
      });
    });

    return {
      subscriptionId: subscription.id,
      confirmationUrl: created.confirmationUrl,
      status: "PENDING",
    };
  } catch (error) {
    /*
      Mark the pending row dead rather than leaving it to be swept later. It
      holds no Shopify object, so nothing is owed and nothing is collecting;
      leaving it PENDING would let the abandoned-approval sweep report a
      subscription the merchant never saw.
    */
    await prisma.subscription
      .update({
        where: { id: subscription.id },
        data: { status: "DECLINED", canceledAt: new Date() },
      })
      .catch(() => {});
    throw error;
  }
}

/**
 * Activate a subscription that needs no Shopify object (§5.6), or one already
 * verified active.
 *
 * The single-active invariant is enforced HERE, in one transaction with the
 * activation: never zero and never two active subscriptions for an install.
 */
async function activateStandardLocally(subscriptionId: string): Promise<void> {
  const sub = await prisma.subscription.findUniqueOrThrow({
    where: { id: subscriptionId },
    include: { plan: true, appInstall: { include: { app: true } } },
  });
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    await tx.subscription.updateMany({
      where: {
        appInstallId: sub.appInstallId,
        id: { not: sub.id },
        status: { in: ["ACTIVE", "PENDING"] },
      },
      data: { status: "CANCELLED", canceledAt: now },
    });
    await tx.subscription.update({
      where: { id: sub.id },
      data: { status: "ACTIVE", activatedAt: sub.activatedAt ?? now },
    });
    if (sub.trialStartedAt && !sub.appInstall.trialConsumedAt) {
      await tx.appInstall.update({
        where: { id: sub.appInstallId },
        data: { trialConsumedAt: now },
      });
    }
  });

  // Non load-bearing: the event stream must never fail an activation.
  await recordSubscribed({
    organizationId: sub.appInstall.app.organizationId,
    subscriptionId: sub.id,
    amount: sub.plan.amount,
    currencyCode: sub.plan.currencyCode,
    interval: sub.plan.interval,
    test: sub.test,
  }).catch(() => {});
}

/**
 * The return-URL handler's work for a standard subscription.
 *
 * Order of operations is the spec's §4 and is load-bearing: **verify** against
 * Shopify → **mirror** its dates → **activate self and cancel others in one
 * transaction**. On a verify failure nothing changes locally and the merchant is
 * simply returned; the reconciliation pass heals it if the charge really did
 * activate.
 */
export async function activateStandardSubscription(
  subscriptionId: string,
): Promise<{ activated: boolean; reason?: string }> {
  const initial = await prisma.subscription.findUnique({
    where: { id: subscriptionId },
    select: {
      appInstallId: true,
      appInstall: { select: { app: { select: { organizationId: true } } } },
    },
  });
  if (!initial) return { activated: false, reason: "not_found" };

  // The SAME lock flex activation takes, so the two rails cannot both activate
  // for one install at once and leave two active subscriptions behind.
  return withLock(
    lockKey(
      initial.appInstall.app.organizationId,
      `activate:${initial.appInstallId}`,
    ),
    async () => {
      const sub = await prisma.subscription.findUnique({
        where: { id: subscriptionId },
        include: { plan: true, appInstall: { include: { app: true } } },
      });
      if (!sub) return { activated: false, reason: "not_found" };
      if (sub.plan.flexBilling) {
        return { activated: false, reason: "not_a_standard_plan" };
      }
      if (sub.status === "ACTIVE" && sub.activatedAt) {
        return { activated: true }; // idempotent — the merchant refreshed
      }
      if (sub.status !== "PENDING" && sub.status !== "EXPIRED") {
        return { activated: false, reason: `local_status_${sub.status.toLowerCase()}` };
      }

      // A free plan has no Shopify object to verify against (§5.6).
      if (!sub.shopifySubscriptionId) {
        await activateStandardLocally(sub.id);
        return { activated: true };
      }

      const live = await getAppSubscriptionStatus(
        sub.appInstall.app,
        sub.appInstall,
        sub.shopifySubscriptionId,
      );
      if (!live) return { activated: false, reason: "shopify_unknown" };
      if (live.status.toUpperCase() !== "ACTIVE") {
        // Not an error: the merchant may still be on the approval screen, or
        // declined. Nothing local changes.
        log.info("standard activation declined by Shopify status", {
          subscriptionId,
          shopifyStatus: live.status,
        });
        return { activated: false, reason: `shopify_${live.status.toLowerCase()}` };
      }

      const now = new Date();
      const periodEnd = live.currentPeriodEnd
        ? new Date(live.currentPeriodEnd)
        : null;

      await prisma.$transaction(async (tx) => {
        await tx.subscription.updateMany({
          where: {
            appInstallId: sub.appInstallId,
            id: { not: sub.id },
            status: { in: ["ACTIVE", "PENDING"] },
          },
          data: { status: "CANCELLED", canceledAt: now },
        });
        await tx.subscription.update({
          where: { id: sub.id },
          data: {
            status: "ACTIVE",
            activatedAt: sub.activatedAt ?? now,
            // Mirrored from Shopify, never computed.
            currentPeriodStart: sub.currentPeriodStart ?? now,
            currentPeriodEnd: periodEnd,
            nextBillingDate: periodEnd,
            billingCycleAnchor: sub.billingCycleAnchor ?? now,
          },
        });
        if (sub.trialStartedAt && !sub.appInstall.trialConsumedAt) {
          await tx.appInstall.update({
            where: { id: sub.appInstallId },
            data: { trialConsumedAt: now },
          });
        }
      });

      /*
        Cancel the replaced subscription only NOW — new before old (§0.5). It is
        cancelled on Shopify too, and an "already uninstalled" failure is
        tolerated per-subscription rather than failing the activation that has
        already happened.
      */
      if (sub.replacesSubscriptionId) {
        const previous = await prisma.subscription.findUnique({
          where: { id: sub.replacesSubscriptionId },
          select: { id: true, shopifySubscriptionId: true, canceledAt: true },
        });
        if (previous?.shopifySubscriptionId && !previous.canceledAt) {
          await appSubscriptionCancel(sub.appInstall.app, sub.appInstall, {
            shopifySubscriptionId: previous.shopifySubscriptionId,
          }).catch((error: unknown) => {
            log.warn("could not cancel the replaced Shopify subscription", {
              subscriptionId: previous.id,
              message: error instanceof Error ? error.message : String(error),
            });
          });
        }
      }

      await recordSubscribed({
        organizationId: sub.appInstall.app.organizationId,
        subscriptionId: sub.id,
        amount: sub.plan.amount,
        currencyCode: sub.plan.currencyCode,
        interval: sub.plan.interval,
        test: sub.test,
      }).catch(() => {});

      return { activated: true };
    },
  );
}
