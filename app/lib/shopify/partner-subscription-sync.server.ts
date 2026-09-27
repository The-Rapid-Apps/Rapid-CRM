import { createHash, randomUUID } from "node:crypto";
import type {
  App,
  Prisma,
  ShopifyPartnerConnection,
} from "../../../generated/prisma/client";
import { prisma } from "../db.server";
import { logger } from "../logger.server";
import {
  effectivePartnerCredentials,
  partnerGraphqlWithCredentials,
} from "./partner.server";
import {
  backfillDailySnapshots,
  markMrrSnapshotDirty,
  writeTrailingDailySnapshots,
} from "./partner-mrr-snapshot.server";
import {
  backfillCustomerStateFromInstalls,
  backfillPartnerState,
  upsertPartnerStateForCharges,
} from "./partner-state-sync.server";

const log = logger.scope("partner-subscription-sync");
const EVENT_OVERLAP_MS = 60 * 60_000;
const SALE_OVERLAP_MS = 48 * 60 * 60_000;
const LATEST_BOOTSTRAP_MS = 35 * 24 * 60 * 60_000;
export const PARTNER_SYNC_FRESHNESS_MS = 5 * 60_000;
// Longer than the 20-minute cron sync window; renewed after every cursor write.
const BILLING_SYNC_LEASE_MS = 25 * 60_000;
const SHOPIFY_ANALYTICS_EPOCH = new Date("2006-01-01T00:00:00.000Z");

export const PARTNER_SUBSCRIPTION_EVENTS_QUERY = `
  query SubscriptionLifecycleEvents(
    $appId: ID!
    $after: String
    $occurredAtMin: DateTime
    $occurredAtMax: DateTime
  ) {
    app(id: $appId) {
      events(
        first: 100
        after: $after
        occurredAtMin: $occurredAtMin
        occurredAtMax: $occurredAtMax
        types: [
          SUBSCRIPTION_CHARGE_ACCEPTED
          SUBSCRIPTION_CHARGE_ACTIVATED
          SUBSCRIPTION_CHARGE_CANCELED
          SUBSCRIPTION_CHARGE_DECLINED
          SUBSCRIPTION_CHARGE_EXPIRED
          SUBSCRIPTION_CHARGE_FROZEN
          SUBSCRIPTION_CHARGE_UNFROZEN
        ]
      ) {
        edges {
          cursor
          node {
            type
            occurredAt
            shop {
              id
              myshopifyDomain
            }
            ... on AppSubscriptionEvent {
              charge {
                id
                name
                amount {
                  amount
                  currencyCode
                }
                billingOn
                test
              }
            }
          }
        }
        pageInfo {
          hasNextPage
        }
      }
    }
  }
`;

export const PARTNER_SUBSCRIPTION_SALES_QUERY = `
  query SubscriptionSaleFacts(
    $appId: ID!
    $after: String
    $createdAtMin: DateTime!
    $createdAtMax: DateTime!
  ) {
    transactions(
      first: 100
      after: $after
      appId: $appId
      createdAtMin: $createdAtMin
      createdAtMax: $createdAtMax
      types: [APP_SUBSCRIPTION_SALE]
    ) {
      edges {
        cursor
        node {
          id
          createdAt
          ... on AppSubscriptionSale {
            billingInterval
            chargeId
            grossAmount {
              amount
              currencyCode
            }
            netAmount {
              amount
              currencyCode
            }
            shopifyFee {
              amount
              currencyCode
            }
            shop {
              id
              myshopifyDomain
            }
          }
        }
      }
      pageInfo {
        hasNextPage
      }
    }
  }
`;

type SyncableApp = Pick<
  App,
  | "id"
  | "organizationId"
  | "name"
  | "shopifyAppId"
  | "partnerApiToken"
  | "partnerOrganizationId"
  | "billingEventsSyncedAt"
  | "billingEventsIncrementalCursor"
  | "billingEventsIncrementalMinAt"
  | "billingEventsIncrementalMaxAt"
  | "billingEventsBackfillCursor"
  | "billingEventsBackfillMaxAt"
  | "billingEventsBackfillCompletedAt"
  | "billingSalesSyncedAt"
  | "billingSalesIncrementalCursor"
  | "billingSalesIncrementalMinAt"
  | "billingSalesIncrementalMaxAt"
  | "billingSalesBackfillCursor"
  | "billingSalesBackfillMaxAt"
  | "billingSalesBackfillCompletedAt"
  | "billingSyncLeaseToken"
  | "billingSyncLeaseExpiresAt"
  | "mrrSnapshotSyncedAt"
  | "mrrSnapshotBackfillCursor"
  | "mrrSnapshotBackfillCompletedAt"
  | "mrrSnapshotDirtyFrom"
  | "partnerStateBackfillCursor"
  | "partnerStateBackfillCompletedAt"
  | "partnerStateInstallBackfillCursor"
  | "partnerStateInstallBackfillCompletedAt"
> & {
  partnerConnection: Pick<
    ShopifyPartnerConnection,
    "partnerOrganizationId" | "encryptedAccessToken"
  > | null;
};

interface SubscriptionEventEdge {
  cursor: string;
  node: {
    type: string;
    occurredAt: string;
    shop: { id: string; myshopifyDomain: string };
    charge: {
      id: string;
      name: string;
      amount: { amount: string; currencyCode: string };
      billingOn: string | null;
      test: boolean;
    };
  };
}

interface SubscriptionEventsResponse {
  app: {
    events: {
      edges: SubscriptionEventEdge[];
      pageInfo: { hasNextPage: boolean };
    };
  } | null;
}

interface SubscriptionSaleEdge {
  cursor: string;
  node: {
    id: string;
    createdAt: string;
    billingInterval: "EVERY_30_DAYS" | "ANNUAL" | null;
    chargeId: string | null;
    grossAmount: { amount: string; currencyCode: string } | null;
    /* What actually reached us after Shopify's share. Facts written before
       this field was captured have null here. */
    netAmount: { amount: string; currencyCode: string } | null;
    shopifyFee: { amount: string; currencyCode: string } | null;
    shop: { id: string; myshopifyDomain: string } | null;
  };
}

interface SubscriptionSalesResponse {
  transactions: {
    edges: SubscriptionSaleEdge[];
    pageInfo: { hasNextPage: boolean };
  };
}

export interface PartnerSubscriptionSyncResult {
  appId: string;
  appName: string;
  requestedAt: string;
  eventPages: number;
  eventsFetched: number;
  eventsInserted: number;
  salePages: number;
  salesFetched: number;
  salesInserted: number;
  eventsComplete: boolean;
  salesComplete: boolean;
  eventsFresh: boolean;
  salesFresh: boolean;
  latestEventPages: number;
  latestSalePages: number;
  inProgress?: boolean;
  skipped?: string;
}

export interface PartnerSubscriptionFreshness {
  requestedAt: string;
  freshThrough: string | null;
  lagMs: number | null;
  /** Latest window and the full historical lifecycle are both complete. */
  exact: boolean;
  fresh: boolean;
  historyComplete: boolean;
  appsReady: number;
  appsTotal: number;
  apps: Array<{
    appId: string;
    appName: string;
    eventsFreshThrough: string | null;
    salesFreshThrough: string | null;
    freshThrough: string | null;
    historyComplete: boolean;
    exact: boolean;
    fresh: boolean;
  }>;
}

type FreshnessApp = Pick<
  SyncableApp,
  | "id"
  | "name"
  | "billingEventsSyncedAt"
  | "billingEventsBackfillCompletedAt"
  | "billingSalesSyncedAt"
  | "billingSalesBackfillCompletedAt"
>;

function earliestDate(values: Array<Date | null>): Date | null {
  if (values.some((value) => value === null)) return null;
  return values.reduce<Date | null>(
    (earliest, value) =>
      value && (!earliest || value < earliest) ? value : earliest,
    null,
  );
}

/**
 * Builds the freshness contract shown to report consumers. A zero-row
 * Shopify response still advances the high-water mark, so freshness is based
 * on completed query windows, not the newest fact timestamp.
 */
export function buildPartnerSubscriptionFreshness(params: {
  apps: FreshnessApp[];
  requestedAt?: Date;
  freshAfter?: Date;
  now?: Date;
}): PartnerSubscriptionFreshness {
  const requestedAt = params.requestedAt ?? new Date(0);
  const freshAfter = params.freshAfter ?? requestedAt;
  const now = params.now ?? new Date();
  const apps = params.apps.map((app) => {
    const freshThroughDate = earliestDate([
      app.billingEventsSyncedAt,
      app.billingSalesSyncedAt,
    ]);
    const historyComplete = Boolean(
      app.billingEventsBackfillCompletedAt &&
      app.billingSalesBackfillCompletedAt,
    );
    return {
      appId: app.id,
      appName: app.name,
      eventsFreshThrough: app.billingEventsSyncedAt?.toISOString() ?? null,
      salesFreshThrough: app.billingSalesSyncedAt?.toISOString() ?? null,
      freshThrough: freshThroughDate?.toISOString() ?? null,
      historyComplete,
      exact: Boolean(
        freshThroughDate && freshThroughDate >= freshAfter && historyComplete,
      ),
      fresh: Boolean(freshThroughDate && freshThroughDate >= freshAfter),
    };
  });
  const freshThroughDate = earliestDate(
    apps.map((app) => (app.freshThrough ? new Date(app.freshThrough) : null)),
  );
  const lagMs = freshThroughDate
    ? Math.max(0, now.getTime() - freshThroughDate.getTime())
    : null;
  return {
    requestedAt: requestedAt.toISOString(),
    freshThrough: freshThroughDate?.toISOString() ?? null,
    lagMs,
    fresh:
      apps.length > 0 &&
      apps.every((app) => app.fresh) &&
      Boolean(freshThroughDate),
    exact:
      apps.length > 0 &&
      apps.every((app) => app.exact) &&
      Boolean(freshThroughDate),
    historyComplete:
      apps.length > 0 && apps.every((app) => app.historyComplete),
    appsReady: apps.filter((app) => app.historyComplete).length,
    appsTotal: apps.length,
    apps,
  };
}

export async function readPartnerSubscriptionFreshness(params: {
  organizationId: string;
  appId?: string;
  now?: Date;
}): Promise<PartnerSubscriptionFreshness> {
  const now = params.now ?? new Date();
  const apps = await prisma.app.findMany({
    where: {
      organizationId: params.organizationId,
      enabled: true,
      removed: false,
      scheduledForDeletionAt: null,
      ...(params.appId ? { id: params.appId } : {}),
    },
    select: {
      id: true,
      name: true,
      billingEventsSyncedAt: true,
      billingEventsBackfillCompletedAt: true,
      billingSalesSyncedAt: true,
      billingSalesBackfillCompletedAt: true,
    },
  });
  return buildPartnerSubscriptionFreshness({
    apps,
    requestedAt: now,
    freshAfter: new Date(now.getTime() - PARTNER_SYNC_FRESHNESS_MS),
    now,
  });
}

function eventDedupeKey(params: {
  appId: string;
  type: string;
  occurredAt: string;
  shopDomain: string;
  chargeId: string;
}): string {
  return createHash("sha256")
    .update(
      [
        params.appId,
        params.type,
        params.occurredAt,
        params.shopDomain,
        params.chargeId,
      ].join("\u001f"),
    )
    .digest("hex");
}

function overlapStart(value: Date | null, overlapMs: number): string | null {
  return value ? new Date(value.getTime() - overlapMs).toISOString() : null;
}

/**
 * Advances sync metadata only while this worker still owns the lease — both
 * a lease renewal and a fencing check: an expired worker may persist an
 * idempotent raw fact, but can never overwrite a newer worker's cursors.
 *
 * `guard` additionally pins the exact field values this worker read before
 * computing `data`. Without it, a worker whose chunk started before an
 * out-of-band cursor reset (e.g. a manual cleanup) can still hold a valid
 * lease and overwrite the reset with its stale next-cursor value, silently
 * reintroducing a skipped range. Caused a real gap in production: one
 * app's state backfill marked itself complete while missing ~2/3 of
 * its charges, traced to exactly this race.
 */
export async function updateAppWithinBillingLease(
  appId: string,
  leaseToken: string,
  data: Prisma.AppUpdateManyMutationInput,
  guard?: Prisma.AppWhereInput,
): Promise<void> {
  const now = new Date();
  const updated = await prisma.app.updateMany({
    where: {
      id: appId,
      billingSyncLeaseToken: leaseToken,
      billingSyncLeaseExpiresAt: { gt: now },
      ...guard,
    },
    data: {
      ...data,
      billingSyncLeaseExpiresAt: new Date(
        now.getTime() + BILLING_SYNC_LEASE_MS,
      ),
    },
  });
  if (updated.count !== 1) {
    throw new Error(
      "Shopify billing synchronization lease was lost or cursor changed underneath this worker; cursor progress was not changed.",
    );
  }
}

async function persistEventEdges(
  appId: string,
  edges: SubscriptionEventEdge[],
): Promise<number> {
  if (!edges.length) return 0;
  // Precompute each edge's dedupe key; the recent lane re-fetches an
  // overlapping window every tick, so duplicates are skipped on insert.
  const keyed = edges.map((edge) => ({
    edge,
    dedupeKey: eventDedupeKey({
      appId,
      type: edge.node.type,
      occurredAt: edge.node.occurredAt,
      shopDomain: edge.node.shop.myshopifyDomain,
      chargeId: edge.node.charge.id,
    }),
  }));
  const inserted = await prisma.partnerSubscriptionEvent.createMany({
    data: keyed.map(({ edge: { node }, dedupeKey }) => ({
      appId,
      dedupeKey,
      type: node.type,
      occurredAt: new Date(node.occurredAt),
      shopDomain: node.shop.myshopifyDomain,
      shopPlatformId: node.shop.id,
      chargePlatformId: node.charge.id,
      chargeName: node.charge.name,
      amount: node.charge.amount.amount,
      currencyCode: node.charge.amount.currencyCode,
      billingOn: node.charge.billingOn ? new Date(node.charge.billingOn) : null,
      test: node.charge.test,
    })),
    skipDuplicates: true,
  });
  // This page can land events from anywhere in the app's history (the
  // backfill lane walks backward on purpose) — mark the earliest dirty so
  // the snapshot writer rewrites forward from there.
  //
  // Only when something was actually new: the recent-lane sync re-fetches a
  // rolling overlap window on every tick, so `edges` is often 100%
  // already-in-DB facts. Dirtying unconditionally on a no-op batch made an
  // app's `mrrSnapshotDirtyFrom` keep re-appearing right after the writer
  // cleared it, pinned to the overlap window's fixed start — leaving it
  // perpetually dirty and never able to use its own snapshot fast path (see
  // `evaluateSnapshotCompleteness`'s per-app readiness split).
  if (inserted.count === 0) return 0;
  const earliest = edges.reduce<Date | null>((min, { node }) => {
    const at = new Date(node.occurredAt);
    return !min || at < min ? at : min;
  }, null);
  if (earliest) await markMrrSnapshotDirty(appId, earliest);
  // Best-effort — recompute just the charges this batch touched, not a
  // full-table rebuild.
  await upsertPartnerStateForCharges(
    appId,
    edges.map(({ node }) => node.charge.id),
  );
  return inserted.count;
}

async function persistSaleEdges(
  appId: string,
  edges: SubscriptionSaleEdge[],
): Promise<number> {
  if (!edges.length) return 0;
  const inserted = await prisma.partnerSubscriptionSaleFact.createMany({
    data: edges.map(({ node }) => ({
      appId,
      transactionPlatformId: node.id,
      chargePlatformId: node.chargeId,
      occurredAt: new Date(node.createdAt),
      shopDomain: node.shop?.myshopifyDomain ?? null,
      shopPlatformId: node.shop?.id ?? null,
      billingInterval: node.billingInterval,
      grossAmount: node.grossAmount?.amount ?? null,
      netAmount: node.netAmount?.amount ?? null,
      shopifyFee: node.shopifyFee?.amount ?? null,
      currencyCode: node.grossAmount?.currencyCode ?? null,
    })),
    skipDuplicates: true,
  });
  // See the matching comment in `persistEventEdges`.
  if (inserted.count === 0) return 0;
  const earliest = edges.reduce<Date | null>((min, { node }) => {
    const at = new Date(node.createdAt);
    return !min || at < min ? at : min;
  }, null);
  if (earliest) await markMrrSnapshotDirty(appId, earliest);
  await upsertPartnerStateForCharges(
    appId,
    edges
      .map(({ node }) => node.chargeId)
      .filter((chargeId): chargeId is string => Boolean(chargeId)),
  );
  return inserted.count;
}

/**
 * Completes a fixed recent event window before any historical cursor is
 * resumed. Pagination order does not affect correctness because the watermark
 * advances only after every page inside the immutable min/max bounds is read.
 */
async function syncLatestEventPages(
  app: SyncableApp,
  maxPages: number,
  fetchStartedAt: Date,
  leaseToken: string,
): Promise<{
  pages: number;
  fetched: number;
  inserted: number;
  fresh: boolean;
}> {
  const credentials = effectivePartnerCredentials(app);
  if (!credentials || !app.shopifyAppId) {
    return { pages: 0, fetched: 0, inserted: 0, fresh: false };
  }
  // Skip the live Shopify round-trip when this app is already fresh (no
  // in-progress window, last sync within threshold). Without this, every
  // interactive trigger re-hit Partner API needlessly, measured contributing
  // ~5s to /api/metrics-sync per call (2026-08-09).
  if (
    !app.billingEventsIncrementalMinAt &&
    !app.billingEventsIncrementalMaxAt &&
    app.billingEventsSyncedAt &&
    app.billingEventsSyncedAt.getTime() >=
      fetchStartedAt.getTime() - PARTNER_SYNC_FRESHNESS_MS
  ) {
    return { pages: 0, fetched: 0, inserted: 0, fresh: true };
  }
  let syncedAt = app.billingEventsSyncedAt;
  let windowMin = app.billingEventsIncrementalMinAt;
  let windowMax = app.billingEventsIncrementalMaxAt;
  let after = app.billingEventsIncrementalCursor;
  let pages = 0;
  let fetched = 0;
  let inserted = 0;
  let fresh = false;

  // The cursor and both bounds form one immutable Relay connection. A partial
  // legacy state cannot be resumed safely, so restart that one window and let
  // the raw-fact unique keys absorb the overlap.
  if (!windowMin || !windowMax) {
    const baseline =
      syncedAt ??
      app.billingEventsBackfillCompletedAt ??
      new Date(fetchStartedAt.getTime() - LATEST_BOOTSTRAP_MS);
    windowMin = new Date(baseline.getTime() - EVENT_OVERLAP_MS);
    windowMax = fetchStartedAt;
    after = null;
    await updateAppWithinBillingLease(app.id, leaseToken, {
      billingEventsIncrementalCursor: null,
      billingEventsIncrementalMinAt: windowMin,
      billingEventsIncrementalMaxAt: windowMax,
    });
  }

  while (pages < maxPages) {
    const response: SubscriptionEventsResponse =
      await partnerGraphqlWithCredentials<SubscriptionEventsResponse>(
        credentials,
        PARTNER_SUBSCRIPTION_EVENTS_QUERY,
        {
          appId: app.shopifyAppId,
          after,
          occurredAtMin: windowMin.toISOString(),
          occurredAtMax: windowMax.toISOString(),
        },
      );
    if (!response.app) {
      throw new Error("Shopify Partner app was not found during event sync.");
    }
    const edges: SubscriptionEventEdge[] = response.app.events.edges;
    pages += 1;
    fetched += edges.length;
    inserted += await persistEventEdges(app.id, edges);
    const hasNextPage = response.app.events.pageInfo.hasNextPage;
    after = edges.at(-1)?.cursor ?? null;
    if (hasNextPage) {
      if (!after) {
        throw new Error(
          "Shopify returned an invalid subscription-event cursor.",
        );
      }
      await updateAppWithinBillingLease(app.id, leaseToken, {
        billingEventsIncrementalCursor: after,
        billingEventsIncrementalMinAt: windowMin,
        billingEventsIncrementalMaxAt: windowMax,
      });
      continue;
    }

    // This exact min/max window is fully covered. The fenced write makes the
    // watermark and cursor reset atomic for the current owner.
    await updateAppWithinBillingLease(app.id, leaseToken, {
      billingEventsSyncedAt: windowMax,
      billingEventsIncrementalCursor: null,
      billingEventsIncrementalMinAt: null,
      billingEventsIncrementalMaxAt: null,
    });
    syncedAt = !syncedAt || windowMax > syncedAt ? windowMax : syncedAt;

    if (syncedAt >= fetchStartedAt) {
      fresh = true;
      break;
    }

    // A resumed window may end before this request began. Use any remaining
    // page budget to immediately open the next contiguous window.
    windowMin = new Date(syncedAt.getTime() - EVENT_OVERLAP_MS);
    windowMax = fetchStartedAt;
    after = null;
    await updateAppWithinBillingLease(app.id, leaseToken, {
      billingEventsIncrementalCursor: null,
      billingEventsIncrementalMinAt: windowMin,
      billingEventsIncrementalMaxAt: windowMax,
    });
  }
  return { pages, fetched, inserted, fresh };
}

async function syncLatestSalePages(
  app: SyncableApp,
  maxPages: number,
  fetchStartedAt: Date,
  leaseToken: string,
): Promise<{
  pages: number;
  fetched: number;
  inserted: number;
  fresh: boolean;
}> {
  const credentials = effectivePartnerCredentials(app);
  if (!credentials || !app.shopifyAppId) {
    return { pages: 0, fetched: 0, inserted: 0, fresh: false };
  }
  // See the matching short-circuit in `syncLatestEventPages` above.
  if (
    !app.billingSalesIncrementalMinAt &&
    !app.billingSalesIncrementalMaxAt &&
    app.billingSalesSyncedAt &&
    app.billingSalesSyncedAt.getTime() >=
      fetchStartedAt.getTime() - PARTNER_SYNC_FRESHNESS_MS
  ) {
    return { pages: 0, fetched: 0, inserted: 0, fresh: true };
  }
  let syncedAt = app.billingSalesSyncedAt;
  let windowMin = app.billingSalesIncrementalMinAt;
  let windowMax = app.billingSalesIncrementalMaxAt;
  let after = app.billingSalesIncrementalCursor;
  let pages = 0;
  let fetched = 0;
  let inserted = 0;
  let fresh = false;

  if (!windowMin || !windowMax) {
    const baseline =
      syncedAt ??
      app.billingSalesBackfillCompletedAt ??
      new Date(fetchStartedAt.getTime() - LATEST_BOOTSTRAP_MS);
    windowMin = new Date(baseline.getTime() - SALE_OVERLAP_MS);
    windowMax = fetchStartedAt;
    after = null;
    await updateAppWithinBillingLease(app.id, leaseToken, {
      billingSalesIncrementalCursor: null,
      billingSalesIncrementalMinAt: windowMin,
      billingSalesIncrementalMaxAt: windowMax,
    });
  }

  while (pages < maxPages) {
    const response: SubscriptionSalesResponse =
      await partnerGraphqlWithCredentials<SubscriptionSalesResponse>(
        credentials,
        PARTNER_SUBSCRIPTION_SALES_QUERY,
        {
          appId: app.shopifyAppId,
          after,
          createdAtMin: windowMin.toISOString(),
          createdAtMax: windowMax.toISOString(),
        },
      );
    const edges: SubscriptionSaleEdge[] = response.transactions.edges;
    pages += 1;
    fetched += edges.length;
    inserted += await persistSaleEdges(app.id, edges);
    const hasNextPage = response.transactions.pageInfo.hasNextPage;
    after = edges.at(-1)?.cursor ?? null;
    if (hasNextPage) {
      if (!after) {
        throw new Error(
          "Shopify returned an invalid subscription-sale cursor.",
        );
      }
      await updateAppWithinBillingLease(app.id, leaseToken, {
        billingSalesIncrementalCursor: after,
        billingSalesIncrementalMinAt: windowMin,
        billingSalesIncrementalMaxAt: windowMax,
      });
      continue;
    }

    await updateAppWithinBillingLease(app.id, leaseToken, {
      billingSalesSyncedAt: windowMax,
      billingSalesIncrementalCursor: null,
      billingSalesIncrementalMinAt: null,
      billingSalesIncrementalMaxAt: null,
    });
    syncedAt = !syncedAt || windowMax > syncedAt ? windowMax : syncedAt;

    if (syncedAt >= fetchStartedAt) {
      fresh = true;
      break;
    }

    windowMin = new Date(syncedAt.getTime() - SALE_OVERLAP_MS);
    windowMax = fetchStartedAt;
    after = null;
    await updateAppWithinBillingLease(app.id, leaseToken, {
      billingSalesIncrementalCursor: null,
      billingSalesIncrementalMinAt: windowMin,
      billingSalesIncrementalMaxAt: windowMax,
    });
  }
  return { pages, fetched, inserted, fresh };
}

async function syncEventPages(
  app: SyncableApp,
  maxPages: number,
  fetchStartedAt: Date,
  leaseToken: string,
): Promise<
  Pick<
    PartnerSubscriptionSyncResult,
    "eventPages" | "eventsFetched" | "eventsInserted" | "eventsComplete"
  >
> {
  const credentials = effectivePartnerCredentials(app);
  if (!credentials || !app.shopifyAppId) {
    return {
      eventPages: 0,
      eventsFetched: 0,
      eventsInserted: 0,
      eventsComplete: false,
    };
  }

  const initialBackfill = !app.billingEventsBackfillCompletedAt;
  if (!initialBackfill) {
    return {
      eventPages: 0,
      eventsFetched: 0,
      eventsInserted: 0,
      eventsComplete: true,
    };
  }
  // A cursor created before fixed-window support cannot safely be combined
  // with a new upper bound. Restart it once; immutable raw facts deduplicate.
  let after = app.billingEventsBackfillMaxAt
    ? app.billingEventsBackfillCursor
    : null;
  const windowMax = app.billingEventsBackfillMaxAt ?? fetchStartedAt;
  await updateAppWithinBillingLease(app.id, leaseToken, {
    billingEventsBackfillCursor: after,
    billingEventsBackfillMaxAt: windowMax,
  });
  let eventPages = 0;
  let eventsFetched = 0;
  let eventsInserted = 0;
  let complete = false;

  while (eventPages < maxPages) {
    const response =
      await partnerGraphqlWithCredentials<SubscriptionEventsResponse>(
        credentials,
        PARTNER_SUBSCRIPTION_EVENTS_QUERY,
        {
          appId: app.shopifyAppId,
          after,
          occurredAtMin: null,
          occurredAtMax: windowMax.toISOString(),
        },
      );
    if (!response.app) {
      throw new Error("Shopify Partner app was not found during event sync.");
    }
    const edges = response.app.events.edges;
    eventPages++;
    eventsFetched += edges.length;

    eventsInserted += await persistEventEdges(app.id, edges);

    const hasNextPage = response.app.events.pageInfo.hasNextPage;
    after = edges.at(-1)?.cursor ?? null;
    if (!hasNextPage) {
      complete = true;
      break;
    }
    if (!after) {
      throw new Error("Shopify returned an invalid subscription-event cursor.");
    }
    await updateAppWithinBillingLease(app.id, leaseToken, {
      billingEventsBackfillCursor: after,
      billingEventsBackfillMaxAt: windowMax,
    });
  }

  await updateAppWithinBillingLease(
    app.id,
    leaseToken,
    complete
      ? {
          billingEventsBackfillCursor: null,
          billingEventsBackfillMaxAt: null,
          billingEventsBackfillCompletedAt: windowMax,
        }
      : {
          billingEventsBackfillCursor: after,
          billingEventsBackfillMaxAt: windowMax,
        },
  );

  return {
    eventPages,
    eventsFetched,
    eventsInserted,
    eventsComplete: complete,
  };
}

async function syncSalePages(
  app: SyncableApp,
  maxPages: number,
  fetchStartedAt: Date,
  leaseToken: string,
): Promise<
  Pick<
    PartnerSubscriptionSyncResult,
    "salePages" | "salesFetched" | "salesInserted" | "salesComplete"
  >
> {
  const credentials = effectivePartnerCredentials(app);
  if (!credentials || !app.shopifyAppId) {
    return {
      salePages: 0,
      salesFetched: 0,
      salesInserted: 0,
      salesComplete: false,
    };
  }

  const initialBackfill = !app.billingSalesBackfillCompletedAt;
  if (!initialBackfill) {
    return {
      salePages: 0,
      salesFetched: 0,
      salesInserted: 0,
      salesComplete: true,
    };
  }
  let after = app.billingSalesBackfillMaxAt
    ? app.billingSalesBackfillCursor
    : null;
  const windowMax = app.billingSalesBackfillMaxAt ?? fetchStartedAt;
  await updateAppWithinBillingLease(app.id, leaseToken, {
    billingSalesBackfillCursor: after,
    billingSalesBackfillMaxAt: windowMax,
  });
  let salePages = 0;
  let salesFetched = 0;
  let salesInserted = 0;
  let complete = false;

  while (salePages < maxPages) {
    const response =
      await partnerGraphqlWithCredentials<SubscriptionSalesResponse>(
        credentials,
        PARTNER_SUBSCRIPTION_SALES_QUERY,
        {
          appId: app.shopifyAppId,
          after,
          createdAtMin: SHOPIFY_ANALYTICS_EPOCH.toISOString(),
          createdAtMax: windowMax.toISOString(),
        },
      );
    const edges = response.transactions.edges;
    salePages++;
    salesFetched += edges.length;

    salesInserted += await persistSaleEdges(app.id, edges);

    const hasNextPage = response.transactions.pageInfo.hasNextPage;
    after = edges.at(-1)?.cursor ?? null;
    if (!hasNextPage) {
      complete = true;
      break;
    }
    if (!after) {
      throw new Error("Shopify returned an invalid subscription-sale cursor.");
    }
    await updateAppWithinBillingLease(app.id, leaseToken, {
      billingSalesBackfillCursor: after,
      billingSalesBackfillMaxAt: windowMax,
    });
  }

  await updateAppWithinBillingLease(
    app.id,
    leaseToken,
    complete
      ? {
          billingSalesBackfillCursor: null,
          billingSalesBackfillMaxAt: null,
          billingSalesBackfillCompletedAt: windowMax,
        }
      : {
          billingSalesBackfillCursor: after,
          billingSalesBackfillMaxAt: windowMax,
        },
  );

  return {
    salePages,
    salesFetched,
    salesInserted,
    salesComplete: complete,
  };
}

async function syncPartnerSubscriptionFactsUnlocked(
  app: SyncableApp,
  leaseToken: string,
  options: {
    maxEventPages?: number;
    maxSalePages?: number;
    maxLatestEventPages?: number;
    maxLatestSalePages?: number;
    backfill?: boolean;
  } = {},
): Promise<PartnerSubscriptionSyncResult> {
  const fetchStartedAt = new Date();
  const credentials = effectivePartnerCredentials(app);
  if (!credentials || !app.shopifyAppId) {
    return {
      appId: app.id,
      appName: app.name,
      requestedAt: fetchStartedAt.toISOString(),
      eventPages: 0,
      eventsFetched: 0,
      eventsInserted: 0,
      salePages: 0,
      salesFetched: 0,
      salesInserted: 0,
      eventsComplete: false,
      salesComplete: false,
      eventsFresh: false,
      salesFresh: false,
      latestEventPages: 0,
      latestSalePages: 0,
      skipped: "Partner connection or Shopify App ID is missing.",
    };
  }

  const maxEventPages = Math.max(1, options.maxEventPages ?? 20);
  const maxSalePages = Math.max(1, options.maxSalePages ?? 20);
  const latestEvents = await syncLatestEventPages(
    app,
    Math.max(1, options.maxLatestEventPages ?? 5),
    fetchStartedAt,
    leaseToken,
  );
  const latestSales = await syncLatestSalePages(
    app,
    Math.max(1, options.maxLatestSalePages ?? 5),
    fetchStartedAt,
    leaseToken,
  );
  const syncApp: SyncableApp = {
    ...app,
    billingEventsSyncedAt: latestEvents.fresh
      ? fetchStartedAt
      : app.billingEventsSyncedAt,
    billingSalesSyncedAt: latestSales.fresh
      ? fetchStartedAt
      : app.billingSalesSyncedAt,
  };
  const runBackfill = options.backfill !== false;
  const events =
    runBackfill && !syncApp.billingEventsBackfillCompletedAt
      ? await syncEventPages(syncApp, maxEventPages, fetchStartedAt, leaseToken)
      : {
          eventPages: 0,
          eventsFetched: 0,
          eventsInserted: 0,
          eventsComplete: Boolean(syncApp.billingEventsBackfillCompletedAt),
        };
  const sales =
    runBackfill && !syncApp.billingSalesBackfillCompletedAt
      ? await syncSalePages(syncApp, maxSalePages, fetchStartedAt, leaseToken)
      : {
          salePages: 0,
          salesFetched: 0,
          salesInserted: 0,
          salesComplete: Boolean(syncApp.billingSalesBackfillCompletedAt),
        };
  const result = {
    appId: app.id,
    appName: app.name,
    requestedAt: fetchStartedAt.toISOString(),
    eventPages: latestEvents.pages + events.eventPages,
    eventsFetched: latestEvents.fetched + events.eventsFetched,
    eventsInserted: latestEvents.inserted + events.eventsInserted,
    salePages: latestSales.pages + sales.salePages,
    salesFetched: latestSales.fetched + sales.salesFetched,
    salesInserted: latestSales.inserted + sales.salesInserted,
    eventsComplete: events.eventsComplete,
    salesComplete: sales.salesComplete,
    eventsFresh: latestEvents.fresh,
    salesFresh: latestSales.fresh,
    latestEventPages: latestEvents.pages,
    latestSalePages: latestSales.pages,
  };
  // Snapshot writes are best-effort — both functions swallow their own
  // errors since raw facts matter more than this derived cache.
  await writeTrailingDailySnapshots(syncApp, leaseToken, fetchStartedAt);
  if (runBackfill) {
    await backfillDailySnapshots(syncApp, leaseToken, fetchStartedAt);
    await backfillPartnerState(syncApp, leaseToken);
    await backfillCustomerStateFromInstalls(syncApp, leaseToken);
  }

  log.info("Partner subscription facts sync chunk completed", result);
  return result;
}

function inProgressResult(
  app: SyncableApp,
  requestedAt: Date,
): PartnerSubscriptionSyncResult {
  return {
    appId: app.id,
    appName: app.name,
    requestedAt: requestedAt.toISOString(),
    eventPages: 0,
    eventsFetched: 0,
    eventsInserted: 0,
    salePages: 0,
    salesFetched: 0,
    salesInserted: 0,
    eventsComplete: Boolean(app.billingEventsBackfillCompletedAt),
    salesComplete: Boolean(app.billingSalesBackfillCompletedAt),
    eventsFresh: false,
    salesFresh: false,
    latestEventPages: 0,
    latestSalePages: 0,
    inProgress: true,
  };
}

async function syncPartnerSubscriptionFactsWithLease(
  app: SyncableApp,
  options: Parameters<typeof syncPartnerSubscriptionFactsUnlocked>[2],
): Promise<PartnerSubscriptionSyncResult> {
  const requestedAt = new Date();
  const leaseToken = randomUUID();
  const acquired = await prisma.app.updateMany({
    where: {
      id: app.id,
      OR: [
        { billingSyncLeaseExpiresAt: null },
        { billingSyncLeaseExpiresAt: { lt: requestedAt } },
      ],
    },
    data: {
      billingSyncLeaseToken: leaseToken,
      billingSyncLeaseExpiresAt: new Date(
        requestedAt.getTime() + BILLING_SYNC_LEASE_MS,
      ),
    },
  });
  if (acquired.count === 0) return inProgressResult(app, requestedAt);

  try {
    // The caller may have loaded this app before waiting behind a different
    // worker. Always begin from cursor state read after acquiring the lease.
    const freshApp = await prisma.app.findFirst({
      where: { id: app.id, billingSyncLeaseToken: leaseToken },
      include: { partnerConnection: true },
    });
    if (!freshApp) return inProgressResult(app, requestedAt);
    return await syncPartnerSubscriptionFactsUnlocked(
      freshApp,
      leaseToken,
      options,
    );
  } finally {
    await prisma.app.updateMany({
      where: { id: app.id, billingSyncLeaseToken: leaseToken },
      data: {
        billingSyncLeaseToken: null,
        billingSyncLeaseExpiresAt: null,
      },
    });
  }
}

/**
 * Uses a database lease for every worker. Concurrent requests return quickly
 * with `inProgress` instead of joining a differently scoped cron or manual
 * request. Shopify calls stay read-only; only immutable facts and sync cursor
 * metadata are written locally.
 */
export async function syncPartnerSubscriptionFacts(
  app: SyncableApp,
  options: Parameters<typeof syncPartnerSubscriptionFactsUnlocked>[2] = {},
): Promise<PartnerSubscriptionSyncResult> {
  return syncPartnerSubscriptionFactsWithLease(app, options);
}

export async function syncOrganizationPartnerSubscriptionFacts(params: {
  organizationId: string;
  appId?: string;
  maxEventPages?: number;
  maxSalePages?: number;
  maxLatestEventPages?: number;
  maxLatestSalePages?: number;
  backfill?: boolean;
}): Promise<{
  requestedAt: string;
  appsProcessed: number;
  eventsFetched: number;
  eventsInserted: number;
  salesFetched: number;
  salesInserted: number;
  complete: boolean;
  fresh: boolean;
  freshness: PartnerSubscriptionFreshness;
  results: PartnerSubscriptionSyncResult[];
  errors: Array<{ appId: string; appName: string; message: string }>;
}> {
  const requestedAt = new Date();
  const apps = await prisma.app.findMany({
    where: {
      organizationId: params.organizationId,
      enabled: true,
      removed: false,
      scheduledForDeletionAt: null,
      ...(params.appId ? { id: params.appId } : {}),
    },
    include: { partnerConnection: true },
  });
  const results: PartnerSubscriptionSyncResult[] = [];
  const errors: Array<{ appId: string; appName: string; message: string }> = [];

  // Keep Partner calls sequential. Parallel app backfills exhaust the Partner
  // API bucket and were the reason the old report page appeared to hang.
  for (const app of apps) {
    try {
      results.push(
        await syncPartnerSubscriptionFacts(app, {
          maxEventPages: params.maxEventPages,
          maxSalePages: params.maxSalePages,
          maxLatestEventPages: params.maxLatestEventPages,
          maxLatestSalePages: params.maxLatestSalePages,
          backfill: params.backfill,
        }),
      );
    } catch (error) {
      errors.push({
        appId: app.id,
        appName: app.name,
        message:
          error instanceof Error
            ? error.message
            : "Shopify Partner sync failed.",
      });
    }
  }

  // The org-wide logo-churn writer deliberately does NOT run from here. This
  // function executes inside the live web-serving cluster, and the org-wide
  // fold is a full cross-app reconstruction (~2s synchronous CPU) that
  // intermittently blocked real user requests when run on this cadence
  // (found in production, 2026-08-18). It doesn't need this file's
  // cache/lease locality, so it runs instead from its own standalone pm2
  // process — see `scripts/sync-org-logo-churn.ts`.
  const refreshedApps = await prisma.app.findMany({
    where: {
      organizationId: params.organizationId,
      enabled: true,
      removed: false,
      scheduledForDeletionAt: null,
      ...(params.appId ? { id: params.appId } : {}),
    },
    select: {
      id: true,
      name: true,
      billingEventsSyncedAt: true,
      billingEventsBackfillCompletedAt: true,
      billingSalesSyncedAt: true,
      billingSalesBackfillCompletedAt: true,
    },
  });
  const freshness = buildPartnerSubscriptionFreshness({
    apps: refreshedApps,
    requestedAt,
  });

  return {
    requestedAt: requestedAt.toISOString(),
    appsProcessed: apps.length,
    eventsFetched: results.reduce((sum, item) => sum + item.eventsFetched, 0),
    eventsInserted: results.reduce((sum, item) => sum + item.eventsInserted, 0),
    salesFetched: results.reduce((sum, item) => sum + item.salesFetched, 0),
    salesInserted: results.reduce((sum, item) => sum + item.salesInserted, 0),
    complete:
      errors.length === 0 &&
      results.length > 0 &&
      results.every((item) => item.eventsComplete && item.salesComplete),
    fresh:
      errors.length === 0 &&
      results.length > 0 &&
      results.every((item) => item.eventsFresh && item.salesFresh) &&
      freshness.fresh,
    freshness,
    results,
    errors,
  };
}
