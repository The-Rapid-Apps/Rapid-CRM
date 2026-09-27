import { prisma } from "../db.server";
import { logger } from "../logger.server";
import { updateAppWithinBillingLease } from "./partner-subscription-sync.server";

const log = logger.scope("partner-state-sync");

/** Charges processed per backfill tick — small since each upsert is cheap
 * (a handful of events/sales per charge), matching the spirit of the other
 * backfills' chunking without needing their day-bucketed complexity. */
const BACKFILL_CHUNK_SIZE = 500;

export type PartnerSubscriptionStatus =
  | "ACTIVE"
  | "FROZEN"
  | "CANCELLED"
  | "DECLINED"
  | "EXPIRED";

/**
 * Mirrors subscriptions.tsx's currentStatus() exactly — no trial category,
 * since the existing UI/filters have none. Kept here (not imported from the
 * route) because this is server-side sync logic, not route logic; the route
 * itself is rewritten to read `status` off PartnerSubscriptionState instead
 * of computing it.
 */
export function currentStatus(type: string): PartnerSubscriptionStatus {
  if (
    type === "SUBSCRIPTION_CHARGE_ACTIVATED" ||
    type === "SUBSCRIPTION_CHARGE_UNFROZEN"
  ) {
    return "ACTIVE";
  }
  if (type === "SUBSCRIPTION_CHARGE_FROZEN") return "FROZEN";
  if (type === "SUBSCRIPTION_CHARGE_DECLINED") return "DECLINED";
  if (type === "SUBSCRIPTION_CHARGE_EXPIRED") return "EXPIRED";
  return "CANCELLED";
}

function pickLatest<T extends { occurredAt: Date }>(items: T[]): T | undefined {
  let latest: T | undefined;
  for (const item of items) {
    if (!latest || item.occurredAt > latest.occurredAt) latest = item;
  }
  return latest;
}

/**
 * Recomputes PartnerSubscriptionState for exactly the charges that just
 * changed (called from persistEventEdges/persistSaleEdges with the touched
 * chargePlatformIds already on hand — no discovery query needed), then rolls
 * up PartnerCustomerState for every shop those charges belong to. Best-
 * effort, same convention as writeTrailingDailySnapshots/
 * backfillDailySnapshots: must never fail the underlying billing sync.
 */
export async function upsertPartnerStateForCharges(
  appId: string,
  chargePlatformIds: string[],
): Promise<void> {
  const uniqueIds = [...new Set(chargePlatformIds)];
  if (uniqueIds.length === 0) return;
  try {
    const [events, sales] = await Promise.all([
      prisma.partnerSubscriptionEvent.findMany({
        // Matches subscriptions.tsx's/customers.tsx's own live queries
        // exactly (`WHERE e.test = 0`) — found via the production parity
        // check (2026-08-17): without this, test charges (common on dev/
        // staging apps) got their own PartnerSubscriptionState rows the live
        // reconstruction has never shown, inflating counts on exactly the
        // apps where it'd be most visible (its dev and staging copies).
        where: { appId, chargePlatformId: { in: uniqueIds }, test: false },
        select: {
          chargePlatformId: true,
          type: true,
          occurredAt: true,
          shopDomain: true,
          chargeName: true,
          amount: true,
          currencyCode: true,
          billingOn: true,
        },
      }),
      prisma.partnerSubscriptionSaleFact.findMany({
        where: { appId, chargePlatformId: { in: uniqueIds } },
        select: {
          chargePlatformId: true,
          occurredAt: true,
          billingInterval: true,
          grossAmount: true,
          currencyCode: true,
        },
      }),
    ]);

    const eventsByCharge = new Map<string, typeof events>();
    for (const event of events) {
      const list = eventsByCharge.get(event.chargePlatformId);
      if (list) list.push(event);
      else eventsByCharge.set(event.chargePlatformId, [event]);
    }
    const salesByCharge = new Map<string, typeof sales>();
    for (const sale of sales) {
      if (!sale.chargePlatformId) continue;
      const list = salesByCharge.get(sale.chargePlatformId);
      if (list) list.push(sale);
      else salesByCharge.set(sale.chargePlatformId, [sale]);
    }

    const touchedShops = new Set<string>();
    for (const chargePlatformId of uniqueIds) {
      const chargeEvents = eventsByCharge.get(chargePlatformId);
      if (!chargeEvents || chargeEvents.length === 0) continue;
      const lastEvent = pickLatest(chargeEvents)!;
      const lastSale = pickLatest(salesByCharge.get(chargePlatformId) ?? []);

      // Matches customers.tsx's own inline MRR formula exactly (see the
      // model's doc comment in schema.prisma for why this isn't routed
      // through contributionAt()).
      const rawAmount = Number(lastSale?.grossAmount ?? lastEvent.amount);
      const monthlyAmount =
        lastSale?.billingInterval === "ANNUAL" ? rawAmount / 12 : rawAmount;
      const currencyCode = lastSale?.currencyCode ?? lastEvent.currencyCode;

      const data = {
        shopDomain: lastEvent.shopDomain,
        chargeName: lastEvent.chargeName,
        status: currentStatus(lastEvent.type),
        amount: monthlyAmount,
        approvedAmount: Number(lastEvent.amount),
        currencyCode,
        billingInterval: lastSale?.billingInterval ?? null,
        nextBillingOn: lastEvent.billingOn,
        lastEventAt: lastEvent.occurredAt,
        lastEventType: lastEvent.type,
      };
      await prisma.partnerSubscriptionState.upsert({
        where: { appId_chargePlatformId: { appId, chargePlatformId } },
        create: { appId, chargePlatformId, ...data },
        update: data,
      });
      // Every shopDomain this charge's own events have ever carried, not
      // just the latest one's — a shop that Shopify's data-redaction process
      // later reassigned this charge away from still needs its rollup
      // recomputed (e.g. to reflect this charge's last-known FROZEN/DECLINED
      // status before the reassignment), and it's cheap since a charge's
      // event history is always small.
      for (const event of chargeEvents) touchedShops.add(event.shopDomain);
    }

    for (const shopDomain of touchedShops) {
      await recomputeCustomerState(appId, shopDomain);
    }
  } catch (error) {
    log.warn("partner state upsert failed", {
      appId,
      chargeCount: uniqueIds.length,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Rolls up one shop's PartnerCustomerState from its own (already small)
 * PartnerSubscriptionState rows, PartnerSubscriptionSaleFact lifetime totals,
 * and AppInstall — a direct port of customers.tsx's own inline rollup logic,
 * including its multi-currency tie-break (pick the currency with the
 * largest active MRR total; fall back to the lifetime-sales currency if the
 * shop has no active charges) so the numbers match today's live
 * reconstruction exactly.
 */
/**
 * Public, self-guarding entry point for callers outside this file — every
 * site that creates/changes an AppInstall row (the customer-events derive
 * loop, the install/uninstall API routes, the uninstall webhook) must call
 * this after its own write, since customers.tsx's live query treats a
 * "customer" as any shop in EITHER PartnerSubscriptionEvent OR AppInstall,
 * not just shops with a subscription charge. Found via the production
 * parity check (2026-08-17): install-only shops (installed, never
 * subscribed) were silently absent from PartnerCustomerState entirely,
 * since the only trigger before this was persistEventEdges/persistSaleEdges.
 * Best-effort, same non-throwing convention as upsertPartnerStateForCharges.
 */
export async function syncCustomerStateForInstall(
  appId: string,
  shopDomain: string,
): Promise<void> {
  try {
    await recomputeCustomerState(appId, shopDomain);
  } catch (error) {
    log.warn("partner customer state install-triggered sync failed", {
      appId,
      shopDomain,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Deliberately does NOT read PartnerSubscriptionState here, even though that
 * table already holds per-charge status. subscriptions.tsx's live query
 * partitions "latest event per charge" by `(appId, chargePlatformId)` alone
 * (PartnerSubscriptionState matches that), but customers.tsx's live query
 * partitions by `(appId, shopDomain, chargePlatformId)` — scoped to the
 * shop's OWN events. The two disagree exactly when a charge's shopDomain
 * changes over its lifetime (observed in production: Shopify's data-
 * redaction process reassigns a purged shop's later events to a placeholder
 * domain while its earlier events keep the real one) — borrowing
 * PartnerSubscriptionState's globally-scoped row would attribute the
 * charge's current status to the wrong shop, or drop it from the original
 * shop's rollup entirely. Recomputing shop-scoped status directly from raw
 * events here keeps this rollup byte-for-byte matched to customers.tsx.
 */
async function recomputeCustomerState(
  appId: string,
  shopDomain: string,
): Promise<void> {
  const [shopEvents, saleGroups, install] = await Promise.all([
    prisma.partnerSubscriptionEvent.findMany({
      where: { appId, shopDomain, test: false },
      select: {
        chargePlatformId: true,
        type: true,
        occurredAt: true,
        amount: true,
        currencyCode: true,
      },
    }),
    prisma.partnerSubscriptionSaleFact.groupBy({
      by: ["currencyCode"],
      where: { appId, shopDomain, grossAmount: { not: null } },
      _sum: { grossAmount: true },
      _count: { _all: true },
    }),
    prisma.appInstall.findFirst({
      where: { appId, shopDomain },
      select: { accessToken: true, uninstalledAt: true, installedAt: true },
    }),
  ]);

  if (shopEvents.length === 0 && !install) return;

  const eventsByCharge = new Map<string, typeof shopEvents>();
  for (const event of shopEvents) {
    const list = eventsByCharge.get(event.chargePlatformId);
    if (list) list.push(event);
    else eventsByCharge.set(event.chargePlatformId, [event]);
  }
  const currentEvents = [...eventsByCharge.values()].map(
    (events) => pickLatest(events)!,
  );
  const activeEvents = currentEvents.filter(
    (event) =>
      event.type === "SUBSCRIPTION_CHARGE_ACTIVATED" ||
      event.type === "SUBSCRIPTION_CHARGE_UNFROZEN",
  );
  const attentionChargeCount = currentEvents.filter(
    (event) =>
      event.type === "SUBSCRIPTION_CHARGE_FROZEN" ||
      event.type === "SUBSCRIPTION_CHARGE_DECLINED",
  ).length;

  const activeChargeIds = activeEvents.map((event) => event.chargePlatformId);
  const sales =
    activeChargeIds.length > 0
      ? await prisma.partnerSubscriptionSaleFact.findMany({
          where: { appId, chargePlatformId: { in: activeChargeIds } },
          select: {
            chargePlatformId: true,
            occurredAt: true,
            billingInterval: true,
            grossAmount: true,
            currencyCode: true,
          },
        })
      : [];
  const salesByCharge = new Map<string, typeof sales>();
  for (const sale of sales) {
    if (!sale.chargePlatformId) continue;
    const list = salesByCharge.get(sale.chargePlatformId);
    if (list) list.push(sale);
    else salesByCharge.set(sale.chargePlatformId, [sale]);
  }

  const mrrByCurrency = new Map<string, number>();
  for (const event of activeEvents) {
    const lastSale = pickLatest(salesByCharge.get(event.chargePlatformId) ?? []);
    const currencyCode = lastSale?.currencyCode ?? event.currencyCode;
    const amount = Number(lastSale?.grossAmount ?? event.amount);
    const monthlyAmount =
      lastSale?.billingInterval === "ANNUAL" ? amount / 12 : amount;
    mrrByCurrency.set(
      currencyCode,
      (mrrByCurrency.get(currencyCode) ?? 0) + monthlyAmount,
    );
  }
  const currencyCode =
    [...mrrByCurrency.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ??
    saleGroups[0]?.currencyCode ??
    "USD";
  const mrr = mrrByCurrency.get(currencyCode) ?? 0;
  const lifetime = saleGroups.find((group) => group.currencyCode === currencyCode);

  const eventOccurredAts = shopEvents.map((event) => event.occurredAt);
  const minEventAt =
    eventOccurredAts.length > 0
      ? new Date(Math.min(...eventOccurredAts.map((d) => d.getTime())))
      : null;
  const maxEventAt =
    eventOccurredAts.length > 0
      ? new Date(Math.max(...eventOccurredAts.map((d) => d.getTime())))
      : null;
  const firstSeenCandidates = [minEventAt, install?.installedAt].filter(
    (value): value is Date => Boolean(value),
  );
  const lastActivityCandidates = [
    maxEventAt,
    install?.uninstalledAt ?? install?.installedAt,
  ].filter((value): value is Date => Boolean(value));
  const firstSeen =
    firstSeenCandidates.length > 0
      ? new Date(Math.min(...firstSeenCandidates.map((d) => d.getTime())))
      : install!.installedAt;
  const lastActivity =
    lastActivityCandidates.length > 0
      ? new Date(Math.max(...lastActivityCandidates.map((d) => d.getTime())))
      : firstSeen;

  const data = {
    firstSeen,
    lastActivity,
    activeChargeCount: activeEvents.length,
    attentionChargeCount,
    mrr,
    currencyCode,
    lifetimeValue: Number(lifetime?._sum.grossAmount ?? 0),
    saleCount: lifetime?._count._all ?? 0,
    oauthConnected: Boolean(install?.accessToken && !install.uninstalledAt),
  };
  await prisma.partnerCustomerState.upsert({
    where: { appId_shopDomain: { appId, shopDomain } },
    create: { appId, shopDomain, ...data },
    update: data,
  });
}

export interface PartnerStateBackfillApp {
  id: string;
  partnerStateBackfillCursor: string | null;
  partnerStateBackfillCompletedAt: Date | null;
}

/**
 * One-time historical backfill, walking distinct chargePlatformIds forward
 * in a resumable, chunked pass — much simpler than the day-bucketed MRR/
 * Traffic backfills since this table is identity-keyed, not time-series (see
 * the plan/schema doc comments for why no dirty-watermark is needed here).
 * Best-effort, same non-throwing convention as the sibling backfills.
 */
export async function backfillPartnerState(
  app: PartnerStateBackfillApp,
  leaseToken: string,
): Promise<void> {
  if (app.partnerStateBackfillCompletedAt) return;
  try {
    const rows = await prisma.partnerSubscriptionEvent.findMany({
      where: {
        appId: app.id,
        test: false,
        ...(app.partnerStateBackfillCursor
          ? { chargePlatformId: { gt: app.partnerStateBackfillCursor } }
          : {}),
      },
      distinct: ["chargePlatformId"],
      orderBy: { chargePlatformId: "asc" },
      select: { chargePlatformId: true },
      take: BACKFILL_CHUNK_SIZE,
    });

    if (rows.length === 0) {
      await updateAppWithinBillingLease(
        app.id,
        leaseToken,
        { partnerStateBackfillCompletedAt: new Date() },
        { partnerStateBackfillCursor: app.partnerStateBackfillCursor },
      );
      log.info("partner state backfill completed", { appId: app.id });
      return;
    }

    const chargePlatformIds = rows.map((row) => row.chargePlatformId);
    await upsertPartnerStateForCharges(app.id, chargePlatformIds);
    await updateAppWithinBillingLease(
      app.id,
      leaseToken,
      { partnerStateBackfillCursor: chargePlatformIds[chargePlatformIds.length - 1] },
      { partnerStateBackfillCursor: app.partnerStateBackfillCursor },
    );
    log.info("partner state backfill chunk written", {
      appId: app.id,
      charges: chargePlatformIds.length,
    });
  } catch (error) {
    log.warn("partner state backfill chunk failed", {
      appId: app.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export interface PartnerStateInstallBackfillApp {
  id: string;
  partnerStateInstallBackfillCursor: string | null;
  partnerStateInstallBackfillCompletedAt: Date | null;
}

/**
 * Second, separate one-time backfill pass — walks AppInstall (not
 * PartnerSubscriptionEvent) so every install-only shop (installed, never
 * subscribed) gets a PartnerCustomerState row too, matching customers.tsx's
 * live "customer = any shop in EITHER table" definition. Found missing via
 * the production parity check (2026-08-17) — see PartnerStateInstallBackfillApp's
 * schema doc for why this is a separate pass from backfillPartnerState above.
 * Deliberately runs AFTER backfillPartnerState completes for the app (so a
 * shop with both installs and charges gets its charges counted correctly the
 * first time recomputeCustomerState runs for it, not left mid-way).
 */
export async function backfillCustomerStateFromInstalls(
  app: PartnerStateInstallBackfillApp,
  leaseToken: string,
): Promise<void> {
  if (app.partnerStateInstallBackfillCompletedAt) return;
  try {
    const rows = await prisma.appInstall.findMany({
      where: {
        appId: app.id,
        ...(app.partnerStateInstallBackfillCursor
          ? { shopDomain: { gt: app.partnerStateInstallBackfillCursor } }
          : {}),
      },
      orderBy: { shopDomain: "asc" },
      select: { shopDomain: true },
      take: BACKFILL_CHUNK_SIZE,
    });

    if (rows.length === 0) {
      await updateAppWithinBillingLease(
        app.id,
        leaseToken,
        { partnerStateInstallBackfillCompletedAt: new Date() },
        { partnerStateInstallBackfillCursor: app.partnerStateInstallBackfillCursor },
      );
      log.info("partner customer state install backfill completed", { appId: app.id });
      return;
    }

    for (const row of rows) {
      await recomputeCustomerState(app.id, row.shopDomain);
    }
    const lastShopDomain = rows[rows.length - 1].shopDomain;
    await updateAppWithinBillingLease(
      app.id,
      leaseToken,
      { partnerStateInstallBackfillCursor: lastShopDomain },
      { partnerStateInstallBackfillCursor: app.partnerStateInstallBackfillCursor },
    );
    log.info("partner customer state install backfill chunk written", {
      appId: app.id,
      shops: rows.length,
    });
  } catch (error) {
    log.warn("partner customer state install backfill chunk failed", {
      appId: app.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
