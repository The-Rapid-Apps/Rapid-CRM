/**
 * Keeping the standard-billing mirror honest (spec §7).
 *
 * Shopify gives almost no webhooks: it does not tell you when a cycle rolls
 * over, when a charge freezes on a failed payment, or when a merchant cancels
 * from the admin. The local row is a MIRROR of one `AppSubscription`, so
 * something has to re-read the original on a schedule. This is that something,
 * and it is the only thing that moves a standard subscription's period dates.
 *
 * Three rules it must not break:
 *
 *   - **It never invents state.** Every field written here comes from Shopify's
 *     answer. A subscription Shopify cannot be asked about is left alone and
 *     reported, not guessed at.
 *   - **It never clobbers an already-set `canceledAt`.** A cancellation is a
 *     local decision as often as a remote one, and re-activating a row because
 *     Shopify still reports the charge active during its notice period would
 *     resurrect a subscription the merchant ended.
 *   - **A free plan having no Shopify object is EXPECTED**, not an orphan.
 *     `$0`-with-no-usage never creates one (§5.6), so flagging those would make
 *     the report useless exactly where it matters.
 *
 * Idempotent: it re-runs safely and converges.
 */
import { prisma } from "../db.server";
import { logger } from "../logger.server";
import { getAppSubscriptionStatus } from "../shopify/billing.server";

const log = logger.scope("standard-reconcile");

/** Shopify's `AppSubscriptionStatus` mapped onto ours. */
function localStatus(
  shopifyStatus: string,
): "ACTIVE" | "FROZEN" | "CANCELLED" | "DECLINED" | "EXPIRED" | null {
  switch (shopifyStatus.toUpperCase()) {
    case "ACTIVE":
      return "ACTIVE";
    case "FROZEN":
      return "FROZEN";
    case "CANCELLED":
      return "CANCELLED";
    case "DECLINED":
      return "DECLINED";
    case "EXPIRED":
      return "EXPIRED";
    default:
      // A status Shopify has added since this was written. Reported, not
      // guessed — mapping an unknown status onto ACTIVE would keep billing a
      // subscription that may have ended.
      return null;
  }
}

export interface StandardReconcileSummary {
  checked: number;
  periodsUpdated: number;
  statusesChanged: number;
  /** Local ACTIVE rows Shopify has no record of, excluding expected free plans. */
  orphans: number;
  unknownStatuses: number;
  errors: number;
}

/**
 * Re-read every live standard subscription from Shopify and mirror what it says.
 *
 * `pageSize` bounds one run's Admin API spend; the sweep is ordered by id so
 * successive runs cover everything without a cursor.
 */
export async function reconcileStandardSubscriptions(
  options: { pageSize?: number; now?: Date } = {},
): Promise<StandardReconcileSummary> {
  const now = options.now ?? new Date();
  const summary: StandardReconcileSummary = {
    checked: 0,
    periodsUpdated: 0,
    statusesChanged: 0,
    orphans: 0,
    unknownStatuses: 0,
    errors: 0,
  };

  const candidates = await prisma.subscription.findMany({
    where: {
      status: { in: ["ACTIVE", "FROZEN"] },
      billingProvider: "SHOPIFY",
      plan: { flexBilling: false },
      appInstall: {
        uninstalledAt: null,
        app: { enabled: true, removed: false, scheduledForDeletionAt: null },
      },
    },
    select: {
      id: true,
      status: true,
      canceledAt: true,
      currentPeriodEnd: true,
      shopifySubscriptionId: true,
      appInstall: { include: { app: true } },
    },
    orderBy: { id: "asc" },
    take: options.pageSize ?? 200,
  });

  for (const sub of candidates) {
    summary.checked += 1;

    if (!sub.shopifySubscriptionId) {
      /*
        No Shopify object. Expected for a free plan (§5.6) and impossible
        otherwise, since `subscribeStandard` only activates without one when
        `requiresShopifyObject` is false. Not counted as an orphan — a report
        that cries wolf on every free merchant is a report nobody reads.
      */
      continue;
    }

    try {
      const live = await getAppSubscriptionStatus(
        sub.appInstall.app,
        sub.appInstall,
        sub.shopifySubscriptionId,
      );

      if (!live) {
        // Shopify has no such charge, but the local row says active. Reported
        // rather than repaired: deleting or cancelling on the strength of one
        // failed lookup would end a live subscription on a transient error.
        summary.orphans += 1;
        log.warn("standard subscription has no Shopify counterpart", {
          subscriptionId: sub.id,
          shopifySubscriptionId: sub.shopifySubscriptionId,
        });
        continue;
      }

      const mapped = localStatus(live.status);
      if (!mapped) {
        summary.unknownStatuses += 1;
        log.warn("unmapped Shopify subscription status", {
          subscriptionId: sub.id,
          shopifyStatus: live.status,
        });
        continue;
      }

      const periodEnd = live.currentPeriodEnd
        ? new Date(live.currentPeriodEnd)
        : null;
      const periodMoved =
        periodEnd !== null &&
        sub.currentPeriodEnd?.getTime() !== periodEnd.getTime();

      const data: Record<string, unknown> = {};

      if (periodMoved) {
        /*
          The cycle rolled. `currentPeriodStart` becomes the END of the period
          just closed, which is the only start date Shopify's answer supports —
          it reports the end, not the start.
        */
        data.currentPeriodStart = sub.currentPeriodEnd ?? now;
        data.currentPeriodEnd = periodEnd;
        data.nextBillingDate = periodEnd;
      }

      if (mapped !== sub.status) {
        if (sub.canceledAt && mapped === "ACTIVE") {
          /*
            Locally cancelled while Shopify still reports the charge active —
            normal during a notice period. Leaving it is the point: flipping it
            back to ACTIVE would resurrect a subscription the merchant ended.
          */
          log.info("keeping a locally cancelled subscription cancelled", {
            subscriptionId: sub.id,
            shopifyStatus: live.status,
          });
        } else {
          data.status = mapped;
          if (mapped === "FROZEN") data.frozenAt = now;
          if (mapped === "ACTIVE") data.frozenAt = null;
          if (
            (mapped === "CANCELLED" || mapped === "EXPIRED") &&
            !sub.canceledAt
          ) {
            data.canceledAt = now;
          }
          summary.statusesChanged += 1;
        }
      }

      if (Object.keys(data).length > 0) {
        await prisma.subscription.update({ where: { id: sub.id }, data });
        if (periodMoved) summary.periodsUpdated += 1;
      }
    } catch (error) {
      // One shop's failure must not end the sweep — a revoked token or an
      // uninstalled shop is per-subscription, not fatal.
      summary.errors += 1;
      log.warn("standard reconciliation failed for one subscription", {
        subscriptionId: sub.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  log.info("standard reconciliation finished", { ...summary });
  return summary;
}
