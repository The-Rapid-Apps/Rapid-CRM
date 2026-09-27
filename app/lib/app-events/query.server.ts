/**
 * App Events read model — a unified, per-app event feed merged at query time
 * from three existing source tables (no dedicated `app_events` table):
 *
 *   - account_lifecycle_events (+ uninstall_event_details)  → activity
 *   - partner_subscription_events (Shopify billing lifecycle) → subscription
 *   - flex_billing_events (flex subscribe/upgrade/downgrade/charge) → subscription
 *
 * The `charges` table is intentionally excluded from the default feed — it
 * overlaps the two subscription sources above and would double-count. It can
 * be added later behind a source toggle (see the plan's follow-ups).
 *
 * Pagination is offset-based to match the rest of the app. Because rows come
 * from several tables, each in-scope source is queried for the first
 * `page * PAGE_SIZE` rows (bounded by the date window), the results are
 * merge-sorted by (occurredAt, id) desc in memory, then the page window is
 * sliced. The default 30-day window keeps per-app volume small; narrow the
 * date range for deep history.
 */

import type { Prisma } from "../../../generated/prisma/client";
import { prisma } from "~/lib/db.server";
import {
  type AppEvent,
  type AppEventFilters,
  FLEX_TYPE_MAP,
  LIFECYCLE_TYPE_MAP,
  PAGE_SIZE,
  PARTNER_TYPE_MAP,
  USAGE_BILLED_TYPES,
  scopeFromTypes,
} from "./types";

/** Hard cap on rows a single CSV export will serialize. */
export const EXPORT_ROW_CAP = 10_000;

type DateBounds = { gte?: Date; lte?: Date };

/** Resolve a source's normalized type set, honoring the type + billing filters. */
function normalizedTargets(
  map: Record<string, string>,
  selectedSubscriptionTypes: string[],
  billing: string[],
): { rawTypes: string[]; unconstrained: boolean } {
  const selected = new Set(selectedSubscriptionTypes);
  const billingSet = new Set(billing);
  const rawTypes: string[] = [];
  for (const [raw, norm] of Object.entries(map)) {
    // Type filter (OR within category); empty selection = all types.
    if (selected.size > 0 && !selected.has(norm)) continue;
    // Billing-type filter.
    if (billingSet.size > 0) {
      const isUsage = USAGE_BILLED_TYPES.has(norm);
      if (isUsage && !billingSet.has("usage")) continue;
      if (!isUsage && !billingSet.has("recurring")) continue;
    }
    rawTypes.push(raw);
  }
  return { rawTypes, unconstrained: selected.size === 0 && billingSet.size === 0 };
}

function dateBounds(filters: AppEventFilters): DateBounds {
  const bounds: DateBounds = {};
  if (filters.from) bounds.gte = new Date(`${filters.from}T00:00:00.000Z`);
  if (filters.to) bounds.lte = new Date(`${filters.to}T23:59:59.999Z`);
  return bounds;
}

// --- Per-source builders. Each returns a Prisma `where` (or null to skip). ---

function lifecycleWhere(
  appId: string,
  filters: AppEventFilters,
  bounds: DateBounds,
): Prisma.AccountLifecycleEventWhereInput | null {
  const { includeActivity, activityTypes } = scopeFromTypes(filters.types);
  if (!includeActivity) return null;
  const rawTypes = Object.entries(LIFECYCLE_TYPE_MAP)
    .filter(([, norm]) => activityTypes.length === 0 || activityTypes.includes(norm))
    .map(([raw]) => raw);
  if (rawTypes.length === 0) return null;
  const where: Prisma.AccountLifecycleEventWhereInput = {
    appId,
    type: { in: rawTypes as any },
    ...(bounds.gte || bounds.lte ? { occurredAt: bounds } : {}),
  };
  if (filters.q) {
    where.OR = [
      { appInstall: { shopDomain: { contains: filters.q } } },
      { uninstallDetail: { reason: { contains: filters.q } } },
    ];
  }
  return where;
}

function partnerWhere(
  appId: string,
  filters: AppEventFilters,
  bounds: DateBounds,
): Prisma.PartnerSubscriptionEventWhereInput | null {
  const { includeSubscription, subscriptionTypes } = scopeFromTypes(
    filters.types,
  );
  if (!includeSubscription) return null;
  // Partner events have no plan-interval linkage; an interval filter excludes them.
  if (filters.intervals.length > 0) return null;
  const { rawTypes } = normalizedTargets(
    PARTNER_TYPE_MAP,
    subscriptionTypes,
    filters.billing,
  );
  if (rawTypes.length === 0) return null;
  const where: Prisma.PartnerSubscriptionEventWhereInput = {
    appId,
    test: false,
    type: { in: rawTypes },
    ...(bounds.gte || bounds.lte ? { occurredAt: bounds } : {}),
    ...(filters.plans.length ? { chargeName: { in: filters.plans } } : {}),
  };
  if (filters.q) {
    where.OR = [
      { shopDomain: { contains: filters.q } },
      { chargeName: { contains: filters.q } },
    ];
  }
  return where;
}

function flexWhere(
  appId: string,
  orgId: string,
  filters: AppEventFilters,
  bounds: DateBounds,
): Prisma.FlexBillingEventWhereInput | null {
  const { includeSubscription, subscriptionTypes } = scopeFromTypes(
    filters.types,
  );
  if (!includeSubscription) return null;
  const { rawTypes } = normalizedTargets(
    FLEX_TYPE_MAP,
    subscriptionTypes,
    filters.billing,
  );
  if (rawTypes.length === 0) return null;
  const where: Prisma.FlexBillingEventWhereInput = {
    organizationId: orgId,
    // Flex events have no appId column — scope through the subscription's install.
    subscription: {
      appInstall: { appId },
      ...(filters.plans.length ? { plan: { name: { in: filters.plans } } } : {}),
    },
    type: { in: rawTypes as any },
    ...(bounds.gte || bounds.lte ? { date: bounds } : {}),
    ...(filters.intervals.length ? { interval: { in: filters.intervals } } : {}),
  };
  if (filters.q) {
    where.subscription = {
      ...(where.subscription as object),
      OR: [
        { appInstall: { shopDomain: { contains: filters.q } } },
        { plan: { name: { contains: filters.q } } },
      ],
    };
  }
  return where;
}

// --- Projections to the normalized AppEvent shape ---------------------------

const num = (v: Prisma.Decimal | number | null | undefined): number | null =>
  v == null ? null : Number(v);

async function fetchLifecycle(
  where: Prisma.AccountLifecycleEventWhereInput,
  take: number,
): Promise<AppEvent[]> {
  const rows = await prisma.accountLifecycleEvent.findMany({
    where,
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take,
    select: {
      id: true,
      type: true,
      occurredAt: true,
      appInstall: { select: { shopDomain: true } },
      uninstallDetail: { select: { reason: true, reasonCode: true } },
    },
  });
  return rows.map((r) => ({
    id: `life_${r.id}`,
    category: "activity" as const,
    type: LIFECYCLE_TYPE_MAP[r.type] ?? "custom",
    customName: null,
    occurredAt: r.occurredAt.toISOString(),
    shopDomain: r.appInstall?.shopDomain ?? null,
    planName: null,
    amount: null,
    currency: null,
    reason: r.uninstallDetail?.reason ?? null,
    metadata: r.uninstallDetail?.reasonCode
      ? { reasonCode: r.uninstallDetail.reasonCode }
      : null,
  }));
}

async function fetchPartner(
  where: Prisma.PartnerSubscriptionEventWhereInput,
  take: number,
): Promise<AppEvent[]> {
  const rows = await prisma.partnerSubscriptionEvent.findMany({
    where,
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take,
    select: {
      id: true,
      type: true,
      occurredAt: true,
      shopDomain: true,
      chargeName: true,
      chargePlatformId: true,
      amount: true,
      currencyCode: true,
      billingOn: true,
    },
  });
  return rows.map((r) => ({
    id: `pse_${r.id}`,
    category: "subscription" as const,
    type: PARTNER_TYPE_MAP[r.type] ?? "subscription_activated",
    customName: null,
    occurredAt: r.occurredAt.toISOString(),
    shopDomain: r.shopDomain,
    planName: r.chargeName || null,
    amount: num(r.amount),
    currency: r.currencyCode,
    reason: null,
    metadata: {
      chargePlatformId: r.chargePlatformId,
      ...(r.billingOn ? { billingOn: r.billingOn.toISOString() } : {}),
    },
  }));
}

async function fetchFlex(
  where: Prisma.FlexBillingEventWhereInput,
  take: number,
): Promise<AppEvent[]> {
  const rows = await prisma.flexBillingEvent.findMany({
    where,
    orderBy: [{ date: "desc" }, { id: "desc" }],
    take,
    select: {
      id: true,
      type: true,
      date: true,
      amount: true,
      currencyCode: true,
      interval: true,
      proration: true,
      prorationAmount: true,
      subscription: {
        select: {
          appInstall: { select: { shopDomain: true } },
          plan: { select: { name: true } },
        },
      },
    },
  });
  return rows.map((r) => ({
    id: `flex_${r.id}`,
    category: "subscription" as const,
    type: FLEX_TYPE_MAP[r.type] ?? "subscription_started",
    customName: null,
    occurredAt: r.date.toISOString(),
    shopDomain: r.subscription?.appInstall?.shopDomain ?? null,
    planName: r.subscription?.plan?.name ?? null,
    amount: num(r.amount),
    currency: r.currencyCode ?? null,
    reason: null,
    metadata: {
      ...(r.interval ? { interval: r.interval } : {}),
      ...(r.proration ? { proration: true } : {}),
      ...(r.prorationAmount != null
        ? { prorationAmount: num(r.prorationAmount) }
        : {}),
    },
  }));
}

// --- Public API ------------------------------------------------------------

export type AppEventsResult = {
  events: AppEvent[];
  page: number;
  total: number;
  totalPages: number;
  /** Total matching the filters but ignoring `q` — for the search placeholder. */
  scopeTotal: number;
};

type Source = {
  count: () => Promise<number>;
  fetch: (take: number) => Promise<AppEvent[]>;
};

/** Build the list of in-scope source queries for the given app + filters. */
function buildSources(
  appId: string,
  orgId: string,
  filters: AppEventFilters,
): Source[] {
  const bounds = dateBounds(filters);
  const sources: Source[] = [];

  const life = lifecycleWhere(appId, filters, bounds);
  if (life)
    sources.push({
      count: () => prisma.accountLifecycleEvent.count({ where: life }),
      fetch: (take) => fetchLifecycle(life, take),
    });

  const partner = partnerWhere(appId, filters, bounds);
  if (partner)
    sources.push({
      count: () => prisma.partnerSubscriptionEvent.count({ where: partner }),
      fetch: (take) => fetchPartner(partner, take),
    });

  const flex = flexWhere(appId, orgId, filters, bounds);
  if (flex)
    sources.push({
      count: () => prisma.flexBillingEvent.count({ where: flex }),
      fetch: (take) => fetchFlex(flex, take),
    });

  return sources;
}

function sortDesc(a: AppEvent, b: AppEvent): number {
  if (a.occurredAt !== b.occurredAt)
    return a.occurredAt < b.occurredAt ? 1 : -1;
  return a.id < b.id ? 1 : -1;
}

export async function loadAppEvents(args: {
  appId: string;
  orgId: string;
  filters: AppEventFilters;
  page: number;
}): Promise<AppEventsResult> {
  const { appId, orgId, filters, page } = args;
  const sources = buildSources(appId, orgId, filters);
  const limit = page * PAGE_SIZE;

  const [counts, batches, scopeTotal] = await Promise.all([
    Promise.all(sources.map((s) => s.count())),
    Promise.all(sources.map((s) => s.fetch(limit))),
    // Search placeholder counts the same filter set ignoring `q`.
    filters.q
      ? Promise.all(
          buildSources(appId, orgId, { ...filters, q: "" }).map((s) =>
            s.count(),
          ),
        ).then((c) => c.reduce((a, b) => a + b, 0))
      : Promise.resolve(null),
  ]);

  const total = counts.reduce((a, b) => a + b, 0);
  const merged = batches.flat().sort(sortDesc);
  const events = merged.slice((page - 1) * PAGE_SIZE, limit);

  return {
    events,
    page,
    total,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    scopeTotal: scopeTotal ?? total,
  };
}

/** All matching events (capped), newest first — for CSV export. */
export async function loadAppEventsForExport(args: {
  appId: string;
  orgId: string;
  filters: AppEventFilters;
}): Promise<AppEvent[]> {
  const sources = buildSources(args.appId, args.orgId, args.filters);
  const batches = await Promise.all(
    sources.map((s) => s.fetch(EXPORT_ROW_CAP)),
  );
  return batches.flat().sort(sortDesc).slice(0, EXPORT_ROW_CAP);
}

/** Distinct plan/charge names for the Plan filter popover. */
export async function loadPlanFilterOptions(
  appId: string,
): Promise<string[]> {
  const [plans, partnerNames] = await Promise.all([
    prisma.plan.findMany({
      where: { appId },
      select: { name: true },
      orderBy: { name: "asc" },
    }),
    prisma.partnerSubscriptionEvent.findMany({
      where: { appId },
      distinct: ["chargeName"],
      select: { chargeName: true },
      take: 200,
    }),
  ]);
  const names = new Set<string>();
  for (const p of plans) if (p.name) names.add(p.name);
  for (const p of partnerNames) if (p.chargeName) names.add(p.chargeName);
  return [...names].sort((a, b) => a.localeCompare(b));
}
