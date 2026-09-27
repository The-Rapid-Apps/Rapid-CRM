import { prisma } from "../db.server";
import { logger } from "../logger.server";
import { D, isPositive, type Money } from "../money.server";
import {
  appUsageRecordCreate,
  PrivateAppBillingError,
} from "../shopify/billing.server";
import {
  loadSubscriptionContext,
  usageLine,
  type SubscriptionContext,
} from "./context.server";
import { addInterval, startOfDay } from "./dates";
import { activeDiscountFor, resolveChargeAmount } from "./discounts.server";
import {
  assertDiscountAppCreditReady,
  createDiscountAppCredit,
} from "./app-credit.server";
import { recordSubscriptionCharged } from "./events.server";
import { lockKey, withLock } from "./lock.server";

const log = logger.scope("flex-charge");

export interface ChargeDependencies {
  createUsageRecord: typeof appUsageRecordCreate;
  assertAppCreditReady: typeof assertDiscountAppCreditReady;
  createAppCredit: typeof createDiscountAppCredit;
}

const defaultDependencies: ChargeDependencies = {
  createUsageRecord: appUsageRecordCreate,
  assertAppCreditReady: assertDiscountAppCreditReady,
  createAppCredit: createDiscountAppCredit,
};

// ---------------------------------------------------------------------------
// §4.3 createFlexBillingCharge — post one usage record for the period fee
// ---------------------------------------------------------------------------

export type ChargeCreateResult =
  | { status: "created"; chargeId: string; amount: Money }
  | { status: "soft_noop"; reason: "cap_full" | "not_active" };

async function createFlexBillingCharge(
  ctx: SubscriptionContext,
  params: {
    amount: Money;
    currency: string;
    description: string;
    billingPeriodStart: Date;
    idempotencyKey: string;
  },
  deps: ChargeDependencies,
): Promise<ChargeCreateResult> {
  const line = usageLine(ctx);
  if (!line?.platformId) {
    throw new Error(`Subscription ${ctx.id} has no usage line platformId`);
  }

  const existing = await prisma.charge.findUnique({
    where: { idempotencyKey: params.idempotencyKey },
  });
  if (existing) {
    return {
      status: "created",
      chargeId: existing.id,
      amount: D(existing.amount),
    };
  }

  const res = await deps.createUsageRecord(ctx.appInstall.app, ctx.appInstall, {
    description: params.description,
    amount: params.amount,
    currencyCode: params.currency,
    subscriptionLineItemId: line.platformId,
    idempotencyKey: params.idempotencyKey,
  });

  if (res.status === "soft_noop") {
    // Cap full / not active: DO NOT write a charge row (spec §4.3).
    return { status: "soft_noop", reason: res.reason };
  }

  const charge = await prisma.charge.create({
    data: {
      subscriptionId: ctx.id,
      amount: params.amount,
      chargedAmount: params.amount,
      chargedCurrencyCode: params.currency,
      platformId: res.id,
      idempotencyKey: params.idempotencyKey,
      isCredit: false,
      flexBilling: true,
      status: "ACTIVE",
      description: params.description,
      billingPeriodStart: params.billingPeriodStart,
      occurredAt: new Date(),
    },
  });

  // Best-effort audit + mirror the live balance from Shopify's response.
  await recordSubscriptionCharged({
    organizationId: ctx.appInstall.app.organizationId,
    subscriptionId: ctx.id,
    amount: params.amount,
    currencyCode: params.currency,
    interval: ctx.plan.interval,
    test: ctx.test,
  });
  if (line) {
    await prisma.subscriptionLineItem
      .update({
        where: { id: line.id },
        data: {
          balanceUsed: res.balanceUsed ?? undefined,
          cappedAmount: res.cappedAmount ?? undefined,
        },
      })
      .catch(() => {});
  }

  return { status: "created", chargeId: charge.id, amount: params.amount };
}

// ---------------------------------------------------------------------------
// §4.2 checkFlexBillingSubscription — charge one subscription for one period
// ---------------------------------------------------------------------------

export interface CheckResult {
  charged: boolean;
  reason: string;
}

/**
 * Charge a single subscription for its due period (spec §4.2).
 *
 * `ignoreBillingTime` switches the billing-date gate from exact-timestamp (the
 * cron) to day-level (the collect-outstanding-before-tier-change path, §5.2).
 *
 * Cap-blocked policy (spec §7): if the usage-record post is a soft no-op (cap
 * full / not active) we DO NOT advance the period — so a blocked cycle's fee is
 * retried next run instead of being silently skipped.
 */
async function checkFlexBillingSubscriptionUnderLock(
  subscriptionId: string,
  ignoreBillingTime = false,
  deps: ChargeDependencies = defaultDependencies,
): Promise<CheckResult> {
  // Re-load under the lock: state may have changed since selection.
  const ctx = await loadSubscriptionContext(subscriptionId);
  if (!ctx) return { charged: false, reason: "not_found" };
  if (
    ctx.status !== "ACTIVE" ||
    !ctx.activatedAt ||
    ctx.canceledAt ||
    ctx.frozenAt ||
    !ctx.plan.flexBilling
  ) {
    return { charged: false, reason: "not_chargeable" };
  }

  const now = new Date();
  if (ctx.pausedUntil && ctx.pausedUntil > now) {
    return { charged: false, reason: "paused" };
  }
  if (ctx.pausedUntil) {
    await prisma.subscription.update({
      where: { id: subscriptionId },
      data: { pausedUntil: null },
    });
  }
  if (!ctx.currentPeriodEnd || !ctx.nextBillingDate) {
    return { charged: false, reason: "no_period" };
  }
  const inFuture = ignoreBillingTime
    ? startOfDay(ctx.nextBillingDate) > startOfDay(now)
    : ctx.nextBillingDate > now;
  if (inFuture) return { charged: false, reason: "billing_date_in_future" };

  // Next period starts where the current one ended.
  const nextPeriodStart = ctx.currentPeriodEnd;
  const nextPeriodEnd = addInterval(
    ctx.currentPeriodEnd,
    ctx.plan.recurringInterval,
    ctx.plan.recurringIntervalCount,
  );

  // Discount-aware amount (spec §4.2). APP_CREDITS discounts don't reduce here.
  const discount = await activeDiscountFor(subscriptionId, nextPeriodStart);
  const resolved = resolveChargeAmount(ctx.plan.amount, discount);
  const chargeAmount = resolved.amount;
  const currency = ctx.plan.currencyCode;
  deps.assertAppCreditReady(ctx, discount);

  let charged = false;
  let billedSpend: Money = D(0);

  if (isPositive(chargeAmount)) {
    const result = await createFlexBillingCharge(
      ctx,
      {
        amount: chargeAmount,
        currency,
        description: `Subscription charge for period ${nextPeriodStart.toISOString().slice(0, 10)} to ${nextPeriodEnd.toISOString().slice(0, 10)}`,
        billingPeriodStart: nextPeriodStart,
        idempotencyKey: `subscription:${subscriptionId}:period:${nextPeriodStart.toISOString()}`,
      },
      deps,
    );
    if (result.status === "soft_noop") {
      // Cap-blocked: do NOT advance — retry next run (spec §7).
      log.warn("charge blocked; not advancing period", {
        subscriptionId,
        reason: result.reason,
      });
      return { charged: false, reason: `blocked_${result.reason}` };
    }
    charged = true;
    billedSpend = chargeAmount;
    if (discount?.discountMethod === "APP_CREDITS") {
      await deps.createAppCredit(ctx, discount, nextPeriodStart);
    }
  }
  // else: $0 (e.g. 100%-off discount) — skip Shopify, still advance (§7).

  // Advance the clock. Reached on a successful charge OR a $0 rollover.
  const line = usageLine(ctx);
  await prisma.$transaction(async (tx) => {
    await tx.subscription.update({
      where: { id: subscriptionId },
      data: {
        currentPeriodStart: nextPeriodStart,
        currentPeriodEnd: nextPeriodEnd,
        nextBillingDate: nextPeriodEnd,
      },
    });
    if (line) {
      await tx.subscriptionLineItem.update({
        where: { id: line.id },
        data: {
          currentPeriodBilledSpend: billedSpend,
          spendPeriodStart: nextPeriodStart,
        },
      });
    }
  });

  return {
    charged,
    reason: charged ? "charge_created" : "zero_amount_rollover",
  };
}

export async function checkFlexBillingSubscription(
  subscriptionId: string,
  ignoreBillingTime = false,
  dependencies: Partial<ChargeDependencies> = {},
): Promise<CheckResult> {
  const deps = { ...defaultDependencies, ...dependencies };
  const pre = await loadSubscriptionContext(subscriptionId);
  if (!pre) return { charged: false, reason: "not_found" };

  const now = new Date();
  // BEFORE locking: future-paused subs are handled by a separate sweep.
  if (pre.pausedUntil && pre.pausedUntil > now) {
    return { charged: false, reason: "paused" };
  }

  const key = lockKey(pre.appInstall.app.organizationId, subscriptionId);
  return withLock(key, () =>
    checkFlexBillingSubscriptionUnderLock(
      subscriptionId,
      ignoreBillingTime,
      deps,
    ),
  );
}

export interface CollectOutstandingOptions {
  /** changeTier already owns the same per-subscription lock. */
  lockAlreadyHeld?: boolean;
  dependencies?: Partial<ChargeDependencies>;
}

/**
 * Collect any outstanding charge before an in-place tier change (spec §5.2).
 * Uses the day-level gate so a same-day plan change doesn't lose the period's
 * fee. `changeTier` passes `lockAlreadyHeld` to avoid re-entering its own lock.
 */
export async function collectOutstandingFlexBillingCharges(
  subscriptionId: string,
  options: CollectOutstandingOptions = {},
): Promise<CheckResult> {
  const deps = { ...defaultDependencies, ...options.dependencies };
  if (options.lockAlreadyHeld) {
    return checkFlexBillingSubscriptionUnderLock(subscriptionId, true, deps);
  }
  return checkFlexBillingSubscription(subscriptionId, true, deps);
}

// ---------------------------------------------------------------------------
// §4.1 the daily charge cron — selector + batch
// ---------------------------------------------------------------------------

export interface CronSummary {
  processed: number;
  charged: number;
  rolledOver: number;
  skipped: number;
  errors: number;
}

/**
 * Selector matching spec §4.1 (backed by the partial index in migration
 * 1_flex_cron_partial_index). Only activated, non-frozen, non-canceled,
 * non-paused flex subscriptions on live apps whose nextBillingDate has passed.
 */
export async function runChargeCron(now = new Date()): Promise<CronSummary> {
  const summary: CronSummary = {
    processed: 0,
    charged: 0,
    rolledOver: 0,
    skipped: 0,
    errors: 0,
  };
  const pageSize = 200;
  let cursor: string | undefined;

  for (;;) {
    const batch = await prisma.subscription.findMany({
      where: {
        activatedAt: { not: null },
        frozenAt: null,
        canceledAt: null,
        pausedUntil: null,
        status: "ACTIVE",
        billingProvider: "SHOPIFY",
        nextBillingDate: { lt: now },
        plan: { flexBilling: true },
        appInstall: {
          uninstalledAt: null,
          app: { enabled: true, removed: false, scheduledForDeletionAt: null },
        },
      },
      select: { id: true },
      orderBy: { id: "asc" },
      take: pageSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (batch.length === 0) break;

    for (const { id } of batch) {
      summary.processed++;
      try {
        const res = await checkFlexBillingSubscription(id);
        if (res.charged) summary.charged++;
        else if (res.reason === "zero_amount_rollover") summary.rolledOver++;
        else summary.skipped++;
      } catch (err) {
        if (err instanceof PrivateAppBillingError) {
          // Private/dev app can't use the Billing API — skip, don't abort batch (§7).
          summary.skipped++;
          log.warn("skipping private/dev app subscription", { id });
        } else {
          summary.errors++;
          log.error("charge cron: subscription failed", {
            id,
            err: String(err),
          });
        }
      }
    }

    cursor = batch[batch.length - 1].id;
    if (batch.length < pageSize) break;
  }

  log.info("charge cron complete", { ...summary });
  return summary;
}

/**
 * Separate paused-subscription sweep (spec §7): resume subscriptions whose
 * pause window has elapsed, then let the normal path pick them up next run.
 */
export async function runPausedSweep(
  now = new Date(),
): Promise<{ resumed: number }> {
  const due = await prisma.subscription.findMany({
    where: {
      status: "ACTIVE",
      pausedUntil: { not: null, lte: now },
      canceledAt: null,
      frozenAt: null,
    },
    select: {
      id: true,
      appInstall: {
        select: {
          shopDomain: true,
          app: { select: { organizationId: true } },
        },
      },
    },
  });
  for (const sub of due) {
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { pausedUntil: null },
    });
  }
  if (due.length)
    log.info("paused sweep resumed subscriptions", { resumed: due.length });
  return { resumed: due.length };
}
