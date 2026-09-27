import { prisma } from "../db.server";
import { logger } from "../logger.server";
import { D } from "../money.server";
import { startOfMonth } from "./dates";
import { resolveUsageLimitForPlan } from "../plans/features.server";
import { changeTier } from "./tier-change.server";

const log = logger.scope("flex-auto-upgrade");

/** Loop guard: max chained auto-upgrades in one cascade (spec §6 uses 10). */
const MAX_CASCADE_DEPTH = 10;

/**
 * Record a metered usage event and, if it pushes the active subscription past
 * its tier's `limitMax`, trigger an automatic upgrade (spec §6).
 *
 * The spec debounces via a delayed job; here we check inline after ingest. The
 * boundary is STRICT (`>`): usage == limitMax stays on the current tier.
 */
export async function ingestUsage(params: {
  appInstallId: string;
  metric: string;
  quantity: number | string;
  occurredAt?: Date;
  idempotencyKey?: string;
  /**
   * Whether recording this usage may also change the merchant's plan.
   *
   * Defaults to true, because that is what a live usage event means. A
   * BACKFILL passes false: replaying months of history through the live path
   * would move every merchant already over their ceiling onto a pricier plan in
   * one unattended pass — each one a Shopify re-approval or a proration — before
   * anybody had checked the imported numbers. The backfill reports who WOULD
   * breach instead, and moving them is a separate, deliberate step.
   */
  triggerAutoUpgrade?: boolean;
}): Promise<{
  recorded: boolean;
  deduplicated: boolean;
  upgraded: boolean;
}> {
  const key = params.idempotencyKey?.trim() || null;
  let deduplicated = false;
  if (key) {
    const existing = await prisma.usageEvent.findUnique({
      where: { idempotencyKey: key },
      select: {
        id: true,
        appInstallId: true,
        metric: true,
        quantity: true,
      },
    });
    if (existing) {
      if (
        existing.appInstallId !== params.appInstallId ||
        existing.metric !== params.metric ||
        !D(existing.quantity).equals(D(params.quantity))
      ) {
        throw new Error(
          "Idempotency key was already used for another usage event",
        );
      }
      deduplicated = true;
    } else {
      try {
        await prisma.usageEvent.create({
          data: {
            appInstallId: params.appInstallId,
            metric: params.metric,
            quantity: D(params.quantity),
            occurredAt: params.occurredAt ?? new Date(),
            idempotencyKey: key,
          },
        });
      } catch (error) {
        const isUniqueConflict =
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "P2002";
        if (!isUniqueConflict) throw error;
        const raced = await prisma.usageEvent.findUnique({
          where: { idempotencyKey: key },
          select: { appInstallId: true, metric: true, quantity: true },
        });
        if (
          !raced ||
          raced.appInstallId !== params.appInstallId ||
          raced.metric !== params.metric ||
          !D(raced.quantity).equals(D(params.quantity))
        ) {
          throw new Error(
            "Idempotency key was already used for another usage event",
          );
        }
        deduplicated = true;
      }
    }
  } else {
    await prisma.usageEvent.create({
      data: {
        appInstallId: params.appInstallId,
        metric: params.metric,
        quantity: D(params.quantity),
        occurredAt: params.occurredAt ?? new Date(),
      },
    });
  }

  if (params.triggerAutoUpgrade === false) {
    return { recorded: !deduplicated, deduplicated, upgraded: false };
  }
  const result = await checkBillingAutoUpgrade(params.appInstallId);
  return {
    recorded: !deduplicated,
    deduplicated,
    upgraded: result.upgraded,
  };
}

async function getActiveSubscription(appInstallId: string) {
  return prisma.subscription.findFirst({
    where: { appInstallId, status: "ACTIVE", canceledAt: null },
    orderBy: { createdAt: "desc" },
    include: { plan: true },
  });
}

/**
 * Check whether the active subscription should auto-upgrade, and if so route it
 * through the SAME in-place tier-change path as a manual change (so it
 * pro-rates identically), then cascade (spec §6).
 */
export async function checkBillingAutoUpgrade(
  appInstallId: string,
  cascadeDepth = 0,
): Promise<{ upgraded: boolean }> {
  if (cascadeDepth >= MAX_CASCADE_DEPTH) {
    log.warn("auto-upgrade cascade depth cap reached", { appInstallId });
    return { upgraded: false };
  }

  const sub = await getActiveSubscription(appInstallId);
  if (!sub) return { upgraded: false };

  const plan = sub.plan;
  // Bail unless the current plan is flex, has upgrade enabled, and points at a
  // flex target with a usage band.
  if (
    !plan.flexBilling ||
    plan.onUsageLimitReached !== "UPGRADE" ||
    !plan.autoUpgradeToPlanId ||
    !plan.limitMetric
  ) {
    return { upgraded: false };
  }

  /*
    The ceiling comes from ONE place, and it is preferably the entitlement.

    `Plan.limitMax` and a LIMIT feature entitlement keyed on `limitMetric` both
    state the same number for the same purpose. Once both exist they drift, and
    then a merchant is shown one ceiling by the app — which reads the entitlement
    through `GET /v1/customer` — and upgraded at another. `resolveUsageLimitForPlan`
    prefers the entitlement for exactly that reason.
  */
  const ceiling = await resolveUsageLimitForPlan(plan);
  if (ceiling.malformed) {
    // Do NOTHING rather than fall back to `limitMax`: falling back would charge
    // a merchant more on the strength of a value the operator plainly mistyped.
    log.warn("auto-upgrade skipped — the usage-limit entitlement is unparseable", {
      subscriptionId: sub.id,
      metric: plan.limitMetric,
    });
    return { upgraded: false };
  }
  if (ceiling.unlimited) {
    // An unlimited tier has nothing to be upgraded off.
    return { upgraded: false };
  }
  if (ceiling.limit === null) return { upgraded: false };

  if (
    ceiling.source === "entitlement" &&
    plan.limitMax != null &&
    !D(plan.limitMax).equals(D(ceiling.limit))
  ) {
    // Not fatal — the entitlement is authoritative — but somebody has to know,
    // because the two will keep diverging until one of them is deleted.
    log.warn("plan.limitMax disagrees with the usage-limit entitlement", {
      planId: plan.id,
      metric: plan.limitMetric,
      limitMax: plan.limitMax.toString(),
      entitlement: String(ceiling.limit),
      note: "The entitlement wins. Clear plan.limitMax or align it.",
    });
  }
  const effectiveLimit = D(ceiling.limit);

  const target = await prisma.plan.findUnique({
    where: { id: plan.autoUpgradeToPlanId },
  });
  if (
    !target ||
    !target.flexBilling ||
    !target.active ||
    target.appId !== plan.appId ||
    !D(target.amount).greaterThan(plan.amount)
  ) {
    log.warn("auto-upgrade target is invalid", {
      subscriptionId: sub.id,
    });
    return { upgraded: false };
  }

  // Usage value over the configured window.
  const now = new Date();
  const windowStart =
    plan.usageLimitsPeriod === "MONTH_TO_DATE"
      ? startOfMonth(now)
      : (sub.currentPeriodStart ?? startOfMonth(now));

  const agg = await prisma.usageEvent.aggregate({
    where: {
      appInstallId,
      metric: plan.limitMetric,
      occurredAt: { gte: windowStart },
    },
    _sum: { quantity: true },
  });
  const value = D(agg._sum.quantity ?? 0);

  // Strict boundary: only upgrade once the ceiling is exceeded (spec §6).
  if (!value.greaterThan(effectiveLimit)) {
    return { upgraded: false };
  }

  // Pending-upgrade dedupe (loop guard): bail if a live sub already sits on the
  // target plan.
  const existingOnTarget = await prisma.subscription.findFirst({
    where: {
      appInstallId,
      planId: target.id,
      status: { in: ["PENDING", "ACTIVE"] },
      canceledAt: null,
    },
  });
  if (existingOnTarget) {
    log.info("auto-upgrade skipped — already on/pending target plan", {
      appInstallId,
      target: target.id,
    });
    return { upgraded: false };
  }

  log.info("auto-upgrading", {
    subscriptionId: sub.id,
    from: plan.name,
    to: target.name,
    metric: plan.limitMetric,
    value: value.toString(),
    limit: effectiveLimit.toString(),
    limitSource: ceiling.source,
  });

  const result = await changeTier({
    subscriptionId: sub.id,
    newPlanId: target.id,
    triggeredByUsageChargeId: `auto:${plan.id}:${plan.limitMetric}`,
  });

  if (result.status !== "changed") {
    // Fell back to a confirmable subscription — can't cascade until approved.
    log.warn("auto-upgrade needs merchant confirmation; cascade halted", {
      appInstallId,
    });
    return { upgraded: false };
  }

  // Cascade (NOT deduped) up to the depth cap.
  await checkBillingAutoUpgrade(appInstallId, cascadeDepth + 1);

  return { upgraded: true };
}
