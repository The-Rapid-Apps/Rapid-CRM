import { randomUUID } from "node:crypto";
import type { App, Prisma } from "../../../generated/prisma/client";
import { prisma } from "../db.server";
import { logger } from "../logger.server";
import {
  effectivePartnerCredentials,
  partnerGraphqlWithCredentials,
} from "../shopify/partner.server";

const log = logger.scope("customer-events-poll");

/**
 * Account-lifecycle event types only (spec §2.1) — subscription/charge event
 * types are deliberately excluded; PartnerSubscriptionEvent is the billing
 * lifecycle source for this platform.
 *
 * Both bounds are supplied deliberately. A cursor may only be resumed with the
 * exact same connection arguments, so each lane persists its min/max window
 * until Shopify reports that every page has been read.
 */
export const ACCOUNT_LIFECYCLE_EVENTS_QUERY = `
  query AccountLifecycleEvents(
    $appId: ID!
    $after: String
    $occurredAtMin: DateTime
    $occurredAtMax: DateTime
  ) {
    app(id: $appId) {
      events(
        first: 50
        after: $after
        occurredAtMin: $occurredAtMin
        occurredAtMax: $occurredAtMax
        types: [
          RELATIONSHIP_INSTALLED
          RELATIONSHIP_UNINSTALLED
          RELATIONSHIP_REACTIVATED
          RELATIONSHIP_DEACTIVATED
        ]
      ) {
        edges {
          cursor
          node {
            type
            occurredAt
            shop {
              id
              name
              myshopifyDomain
            }
            ... on RelationshipUninstalled {
              reason
              description
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

// Partner events can arrive slightly late or out of order. The overlap and the
// RawPartnerEvent unique key make re-reading this range idempotent.
export const LIFECYCLE_OVERLAP_BUFFER_MS = 60 * 60 * 1000;
// On a first refresh, prioritize a useful recent view instead of blocking on
// the app's entire history. Older facts are imported by the backfill lane.
export const FIRST_RECENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const LIFECYCLE_FRESHNESS_MS = 5 * 60 * 1000;
// Longer than the longest expected scheduled request; every cursor write also
// renews and fences this lease.
const LIFECYCLE_SYNC_LEASE_MS = 30 * 60 * 1000;

interface EventEdge {
  cursor: string;
  node: {
    type: string;
    occurredAt: string;
    /* `name` is the merchant's store name — the only source we have for it.
       The Partner API has no shop lookup (`shop(id:)` does not exist on
       QueryRoot), so this feed is the one place it ever appears. */
    shop: { id: string; name?: string | null; myshopifyDomain: string };
    reason?: string | null;
    description?: string | null;
  };
}

interface EventsQueryResult {
  app: {
    events: {
      edges: EventEdge[];
      pageInfo: { hasNextPage: boolean };
    };
  } | null;
}

export type PollableApp = Pick<
  App,
  | "id"
  | "shopifyAppId"
  | "partnerApiToken"
  | "partnerOrganizationId"
  | "lifecycleEventsSyncedAt"
  | "lifecycleEventsIncrementalCursor"
  | "lifecycleEventsIncrementalMinAt"
  | "lifecycleEventsIncrementalMaxAt"
  | "lifecycleEventsBackfillCursor"
  | "lifecycleEventsBackfillMaxAt"
  | "lifecycleEventsBackfillCompletedAt"
> & {
  partnerConnection?: {
    partnerOrganizationId: string;
    encryptedAccessToken: string;
  } | null;
};

export interface LifecycleWindow {
  after: string | null;
  occurredAtMin: Date;
  occurredAtMax: Date;
  resumed: boolean;
}

export interface LifecycleFreshness {
  freshThrough: Date | null;
  lagMs: number | null;
  fresh: boolean;
  historyComplete: boolean;
  exact: boolean;
}

export interface AccountLifecyclePollResult extends LifecycleFreshness {
  fetched: number;
  complete: boolean;
  recentComplete: boolean;
  inProgress?: boolean;
  skipped?: string;
}

type LifecycleState = Pick<
  PollableApp,
  | "lifecycleEventsSyncedAt"
  | "lifecycleEventsIncrementalCursor"
  | "lifecycleEventsIncrementalMinAt"
  | "lifecycleEventsIncrementalMaxAt"
  | "lifecycleEventsBackfillCompletedAt"
>;

/** Pure planning helper used by tests and the poller. */
export function planRecentLifecycleWindow(
  app: LifecycleState,
  requestedAt: Date,
): LifecycleWindow {
  const hasFixedWindow =
    app.lifecycleEventsIncrementalMinAt !== null &&
    app.lifecycleEventsIncrementalMaxAt !== null;
  if (hasFixedWindow) {
    return {
      after: app.lifecycleEventsIncrementalCursor,
      occurredAtMin: app.lifecycleEventsIncrementalMinAt!,
      occurredAtMax: app.lifecycleEventsIncrementalMaxAt!,
      resumed: true,
    };
  }

  const occurredAtMin = app.lifecycleEventsSyncedAt
    ? new Date(
        app.lifecycleEventsSyncedAt.getTime() - LIFECYCLE_OVERLAP_BUFFER_MS,
      )
    : new Date(requestedAt.getTime() - FIRST_RECENT_WINDOW_MS);
  return {
    after: null,
    occurredAtMin,
    occurredAtMax: requestedAt,
    resumed: false,
  };
}

export function lifecycleFreshness(
  app: Pick<
    PollableApp,
    "lifecycleEventsSyncedAt" | "lifecycleEventsBackfillCompletedAt"
  >,
  requestedAt = new Date(),
): LifecycleFreshness {
  const freshThrough = app.lifecycleEventsSyncedAt;
  const lagMs = freshThrough
    ? Math.max(0, requestedAt.getTime() - freshThrough.getTime())
    : null;
  const fresh = lagMs !== null && lagMs <= LIFECYCLE_FRESHNESS_MS;
  const historyComplete = Boolean(app.lifecycleEventsBackfillCompletedAt);
  return {
    freshThrough,
    lagMs,
    fresh,
    historyComplete,
    exact: fresh && historyComplete,
  };
}

async function updateAppUnderLease(
  appId: string,
  leaseToken: string,
  data: Prisma.AppUpdateManyMutationInput,
): Promise<void> {
  const updated = await prisma.app.updateMany({
    where: { id: appId, lifecycleSyncLeaseToken: leaseToken },
    data: {
      ...data,
      lifecycleSyncLeaseExpiresAt: new Date(
        Date.now() + LIFECYCLE_SYNC_LEASE_MS,
      ),
    },
  });
  if (updated.count !== 1) {
    throw new Error(
      "Account lifecycle synchronization lease was lost; cursor was not advanced",
    );
  }
}

async function persistRawPage(appId: string, edges: EventEdge[]) {
  const rows = edges.map(({ node }) => ({
    appId,
    type: node.type,
    occurredAt: new Date(node.occurredAt),
    shopDomain: node.shop.myshopifyDomain,
    shopPlatformId: node.shop.id,
    shopName: node.shop.name?.trim() || null,
    reason: node.reason ?? null,
    description: node.description ?? null,
  }));
  if (rows.length === 0) return;

  try {
    await prisma.rawPartnerEvent.createMany({
      data: rows,
      skipDuplicates: true,
    });
  } catch (batchError) {
    // One malformed event must not hide valid siblings. Cursor advancement is
    // refused if even one row still fails after the individual retry.
    log.warn("raw partner event batch failed; retrying rows individually", {
      appId,
      err: String(batchError),
    });
    let persistenceErrors = 0;
    for (const row of rows) {
      await prisma.rawPartnerEvent
        .upsert({
          where: {
            appId_type_occurredAt_shopDomain: {
              appId: row.appId,
              type: row.type,
              occurredAt: row.occurredAt,
              shopDomain: row.shopDomain,
            },
          },
          create: row,
          update: {},
        })
        .catch((err) => {
          persistenceErrors += 1;
          log.error("failed to persist raw partner event", {
            appId,
            err: String(err),
          });
        });
    }
    if (persistenceErrors > 0) {
      throw new Error(
        `${persistenceErrors} Partner events failed to persist; sync cursor was not advanced`,
      );
    }
  }
}

async function fetchEventPage(
  app: PollableApp,
  after: string | null,
  occurredAtMin: Date | null,
  occurredAtMax: Date,
): Promise<{ edges: EventEdge[]; hasNextPage: boolean }> {
  const credentials = effectivePartnerCredentials(app);
  if (!credentials || !app.shopifyAppId) {
    throw new Error("Partner credentials or Shopify App ID are unavailable");
  }
  const data = await partnerGraphqlWithCredentials<EventsQueryResult>(
    credentials,
    ACCOUNT_LIFECYCLE_EVENTS_QUERY,
    {
      appId: app.shopifyAppId,
      after,
      occurredAtMin: occurredAtMin?.toISOString() ?? null,
      occurredAtMax: occurredAtMax.toISOString(),
    },
  );
  return {
    edges: data.app?.events.edges ?? [],
    hasNextPage: Boolean(data.app?.events.pageInfo.hasNextPage),
  };
}

async function syncRecentWindow(
  app: PollableApp,
  leaseToken: string,
  requestedAt: Date,
  maxPages: number,
): Promise<{
  fetched: number;
  pages: number;
  complete: boolean;
  window: LifecycleWindow;
}> {
  const window = planRecentLifecycleWindow(app, requestedAt);
  if (!window.resumed) {
    // Clear a cursor left by an incomplete/legacy window before changing its
    // bounds. Resumed cursors always keep both bounds immutable.
    await updateAppUnderLease(app.id, leaseToken, {
      lifecycleEventsIncrementalCursor: null,
      lifecycleEventsIncrementalMinAt: window.occurredAtMin,
      lifecycleEventsIncrementalMaxAt: window.occurredAtMax,
    });
  }

  let after = window.after;
  let fetched = 0;
  let pages = 0;
  while (pages < maxPages) {
    pages += 1;
    const page = await fetchEventPage(
      app,
      after,
      window.occurredAtMin,
      window.occurredAtMax,
    );
    await persistRawPage(app.id, page.edges);
    fetched += page.edges.length;

    if (!page.hasNextPage || page.edges.length === 0) {
      // The first completed recent window also fixes the exclusive historical
      // boundary. A legacy cursor cannot be reused with these new arguments.
      await updateAppUnderLease(app.id, leaseToken, {
        lifecycleEventsSyncedAt: window.occurredAtMax,
        lifecycleEventsIncrementalCursor: null,
        lifecycleEventsIncrementalMinAt: null,
        lifecycleEventsIncrementalMaxAt: null,
        ...(app.lifecycleEventsBackfillCompletedAt ||
        app.lifecycleEventsBackfillMaxAt
          ? {}
          : {
              lifecycleEventsBackfillCursor: null,
              lifecycleEventsBackfillMaxAt: window.occurredAtMin,
            }),
      });
      return { fetched, pages, complete: true, window };
    }

    after = page.edges.at(-1)?.cursor ?? null;
    if (!after) {
      throw new Error("Shopify returned an invalid account-event cursor");
    }
    await updateAppUnderLease(app.id, leaseToken, {
      lifecycleEventsIncrementalCursor: after,
    });
  }
  return { fetched, pages, complete: false, window };
}

async function syncHistoricalWindow(
  app: PollableApp,
  leaseToken: string,
  fallbackMaxAt: Date,
  maxPages: number,
): Promise<{ fetched: number; pages: number; complete: boolean }> {
  if (app.lifecycleEventsBackfillCompletedAt) {
    return { fetched: 0, pages: 0, complete: true };
  }

  // The upper bound is set once and never changes while its cursor is active.
  // Reset legacy cursors that were created without a persisted upper bound.
  const occurredAtMax = app.lifecycleEventsBackfillMaxAt ?? fallbackMaxAt;
  let after = app.lifecycleEventsBackfillMaxAt
    ? app.lifecycleEventsBackfillCursor
    : null;
  if (!app.lifecycleEventsBackfillMaxAt) {
    await updateAppUnderLease(app.id, leaseToken, {
      lifecycleEventsBackfillCursor: null,
      lifecycleEventsBackfillMaxAt: occurredAtMax,
    });
  }

  let fetched = 0;
  let pages = 0;
  while (pages < maxPages) {
    pages += 1;
    const page = await fetchEventPage(app, after, null, occurredAtMax);
    await persistRawPage(app.id, page.edges);
    fetched += page.edges.length;

    if (!page.hasNextPage || page.edges.length === 0) {
      await updateAppUnderLease(app.id, leaseToken, {
        lifecycleEventsBackfillCursor: null,
        lifecycleEventsBackfillMaxAt: occurredAtMax,
        lifecycleEventsBackfillCompletedAt: new Date(),
      });
      return { fetched, pages, complete: true };
    }

    after = page.edges.at(-1)?.cursor ?? null;
    if (!after) {
      throw new Error("Shopify returned an invalid account-event cursor");
    }
    await updateAppUnderLease(app.id, leaseToken, {
      lifecycleEventsBackfillCursor: after,
    });
  }
  return { fetched, pages, complete: false };
}

async function pollWithLease(
  app: PollableApp,
  leaseToken: string,
  requestedAt: Date,
  maxPages: number,
): Promise<AccountLifecyclePollResult> {
  const recent = await syncRecentWindow(app, leaseToken, requestedAt, maxPages);
  let fetched = recent.fetched;
  let historyComplete = Boolean(app.lifecycleEventsBackfillCompletedAt);

  // Recent facts always win. Historical work only consumes the leftover page
  // budget after the recent window has reached its fixed upper bound.
  const remainingPages = maxPages - recent.pages;
  if (recent.complete && remainingPages > 0 && !historyComplete) {
    const historical = await syncHistoricalWindow(
      app,
      leaseToken,
      recent.window.occurredAtMin,
      remainingPages,
    );
    fetched += historical.fetched;
    historyComplete = historical.complete;
  }

  const state = {
    lifecycleEventsSyncedAt: recent.complete
      ? recent.window.occurredAtMax
      : app.lifecycleEventsSyncedAt,
    lifecycleEventsBackfillCompletedAt: historyComplete ? new Date() : null,
  };
  const freshness = lifecycleFreshness(state, requestedAt);
  return {
    fetched,
    complete: historyComplete,
    recentComplete: recent.complete,
    ...freshness,
  };
}

/**
 * Poll one app's Partner API account-lifecycle feed. The recent lane is always
 * processed before a bounded historical lane. Shopify access is read-only;
 * only immutable raw facts and cursor/watermark metadata are persisted.
 */
export async function pollAccountLifecycleEvents(
  app: PollableApp,
  options: { maxPages?: number; requestedAt?: Date } = {},
): Promise<AccountLifecyclePollResult> {
  const requestedAt = options.requestedAt ?? new Date();
  const maxPages = Math.max(1, options.maxPages ?? 10);
  const currentFreshness = lifecycleFreshness(app, requestedAt);

  // Skip the lease + live Shopify poll entirely when already confirmed fresh
  // and no recent window is mid-pagination — same rationale as the matching
  // short-circuit in partner-subscription-sync.server.ts's
  // syncLatestEventPages/syncLatestSalePages: every interactive trigger
  // otherwise re-hit Shopify even when nothing could have changed since the
  // last check moments ago.
  if (
    !app.lifecycleEventsIncrementalMinAt &&
    !app.lifecycleEventsIncrementalMaxAt &&
    currentFreshness.fresh
  ) {
    return {
      fetched: 0,
      complete: currentFreshness.historyComplete,
      recentComplete: true,
      ...currentFreshness,
    };
  }

  if (!app.shopifyAppId) {
    log.warn("skipping — app.shopifyAppId not set", { appId: app.id });
    return {
      fetched: 0,
      complete: currentFreshness.historyComplete,
      recentComplete: false,
      skipped: "Shopify App ID is not configured",
      ...currentFreshness,
    };
  }
  if (!effectivePartnerCredentials(app)) {
    return {
      fetched: 0,
      complete: currentFreshness.historyComplete,
      recentComplete: false,
      skipped: "Partner API credentials are not configured",
      ...currentFreshness,
    };
  }

  const leaseToken = randomUUID();
  const now = new Date();
  const acquired = await prisma.app.updateMany({
    where: {
      id: app.id,
      OR: [
        { lifecycleSyncLeaseToken: null },
        { lifecycleSyncLeaseExpiresAt: null },
        { lifecycleSyncLeaseExpiresAt: { lte: now } },
      ],
    },
    data: {
      lifecycleSyncLeaseToken: leaseToken,
      lifecycleSyncLeaseExpiresAt: new Date(
        now.getTime() + LIFECYCLE_SYNC_LEASE_MS,
      ),
    },
  });
  if (acquired.count !== 1) {
    return {
      fetched: 0,
      complete: currentFreshness.historyComplete,
      recentComplete: false,
      inProgress: true,
      ...currentFreshness,
    };
  }

  try {
    // Re-read after lease acquisition. Never resume a cursor from the stale app
    // snapshot a caller loaded before waiting for another worker.
    const freshApp = await prisma.app.findFirst({
      where: { id: app.id, lifecycleSyncLeaseToken: leaseToken },
      include: { partnerConnection: true },
    });
    if (!freshApp) {
      throw new Error("Account lifecycle synchronization lease was lost");
    }

    log.info("poll starting", {
      appId: app.id,
      requestedAt: requestedAt.toISOString(),
      recentCursor: freshApp.lifecycleEventsIncrementalCursor,
      historicalCursor: freshApp.lifecycleEventsBackfillCursor,
    });
    const result = await pollWithLease(
      freshApp,
      leaseToken,
      requestedAt,
      maxPages,
    );
    log.info("poll chunk finished", {
      appId: app.id,
      fetched: result.fetched,
      recentComplete: result.recentComplete,
      historyComplete: result.historyComplete,
      fresh: result.fresh,
    });
    return result;
  } finally {
    await prisma.app.updateMany({
      where: { id: app.id, lifecycleSyncLeaseToken: leaseToken },
      data: {
        lifecycleSyncLeaseToken: null,
        lifecycleSyncLeaseExpiresAt: null,
      },
    });
  }
}
