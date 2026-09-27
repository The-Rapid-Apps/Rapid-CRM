import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";
import { deriveAccountLifecycleEvents } from "~/lib/customer-events/derive.server";
import { pollAccountLifecycleEvents } from "~/lib/customer-events/poll.server";
import { requireCurrentOrganization } from "~/lib/current-org.server";
import { prisma } from "~/lib/db.server";
import { markInstallSnapshotDirty } from "~/lib/reports/install-snapshot.server";
import { invalidateLivePartnerAnalyticsCache } from "~/lib/shopify/partner-analytics.server";
import { invalidatePersistedPartnerMrrCache } from "~/lib/shopify/partner-mrr.server";
import {
  invalidatePartnerSubscriptionActivityCache,
  readPersistedPartnerSubscriptionActivity,
} from "~/lib/shopify/partner-subscriptions.server";
import { syncOrganizationPartnerSubscriptionFacts } from "~/lib/shopify/partner-subscription-sync.server";
import { syncOrganizationTrafficEvents } from "~/lib/reports/traffic-events-sync.server";

const querySchema = z
  .object({ appId: z.string().trim().min(1).max(191).optional() })
  .strict();

/**
 * Imports a bounded chunk of immutable Shopify lifecycle/sale facts and warms
 * the short-lived activity cache. Derived metrics are always calculated at
 * read time and are never persisted.
 */
export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  const requestedAt = new Date();
  const organization = await requireCurrentOrganization(request);
  const parsed = querySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid sync query", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  if (parsed.data.appId) {
    const ownsApp = await prisma.app.count({
      where: {
        id: parsed.data.appId,
        organizationId: organization.id,
        enabled: true,
        removed: false,
        scheduledForDeletionAt: null,
      },
    });
    if (!ownsApp) {
      return Response.json({ error: "App not found" }, { status: 404 });
    }
  }

  const apps = await prisma.app.findMany({
    where: {
      organizationId: organization.id,
      enabled: true,
      removed: false,
      scheduledForDeletionAt: null,
      ...(parsed.data.appId ? { id: parsed.data.appId } : {}),
    },
    select: {
      id: true,
      name: true,
      shopifyAppId: true,
      partnerApiToken: true,
      partnerOrganizationId: true,
      lifecycleEventsSyncedAt: true,
      lifecycleEventsIncrementalCursor: true,
      lifecycleEventsIncrementalMinAt: true,
      lifecycleEventsIncrementalMaxAt: true,
      lifecycleEventsBackfillCursor: true,
      lifecycleEventsBackfillMaxAt: true,
      lifecycleEventsBackfillCompletedAt: true,
      partnerConnection: {
        select: {
          partnerOrganizationId: true,
          encryptedAccessToken: true,
        },
      },
    },
  });
  // Keep Partner calls sequential. The API allows four requests/second per
  // client, so overlapping a backfill with the activity refresh causes 429s.
  const facts = await syncOrganizationPartnerSubscriptionFacts({
    organizationId: organization.id,
    appId: parsed.data.appId,
    // Interactive refreshes only synchronize the newest fixed windows. The
    // scheduled worker owns historical backfill so a browser request remains
    // responsive regardless of account age.
    maxEventPages: 0,
    maxSalePages: 0,
    maxLatestEventPages: 5,
    maxLatestSalePages: 5,
    backfill: false,
  });
  // Best-effort, independent of the billing/lifecycle sync above (different
  // upstream — BigQuery, not the Partner API — and its own failure modes).
  // Errors here must never affect this route's `fresh`/`inProgress`/status
  // code, only show up in the response's `errors` list for visibility.
  // Interactive triggers only run the recent lane (backfill: false), same
  // reasoning as billing sync above: a cron backstop owns historical
  // backfill so a browser request stays responsive on old accounts.
  const trafficEventsErrors: string[] = [];
  try {
    const trafficEvents = await syncOrganizationTrafficEvents({
      organizationId: organization.id,
      appId: parsed.data.appId,
      backfill: false,
    });
    trafficEventsErrors.push(
      ...trafficEvents.errors.map((error) => `${error.appName}: ${error.message}`),
    );
  } catch (error) {
    trafficEventsErrors.push(
      error instanceof Error ? error.message : "Traffic events sync failed.",
    );
  }

  const lifecycleResults: Array<{
    appId: string;
    appName: string;
    fetched: number;
    derived: number;
    derivationInProgress: boolean;
    derivationPending: boolean;
    fresh: boolean;
    freshThrough: string | null;
    recentComplete: boolean;
    historyComplete: boolean;
    inProgress: boolean;
    skipped?: string;
  }> = [];
  const lifecycleErrors: string[] = [];
  // Account/install events use their own immutable cursor connection. Keep
  // calls sequential and bounded so billing freshness remains the fast path.
  for (const app of apps) {
    try {
      // One page is deliberately the entire interactive budget. Because the
      // recent lane always consumes the first page, no historical page can run
      // here; an unfinished recent window resumes on the next refresh.
      const lifecycle = await pollAccountLifecycleEvents(app, {
        maxPages: 1,
        requestedAt,
      });
      const derivation =
        !lifecycle.inProgress && !lifecycle.skipped
          ? await deriveAccountLifecycleEvents(app.id, {
              limit: 100,
              // Apply the newest current-state facts first. The scheduler
              // drains older history independently for long-range reports.
              newestFirst: true,
            })
          : { derived: 0, hasMore: false, inProgress: false, earliestOccurredAt: null };
      if (derivation.earliestOccurredAt) {
        await markInstallSnapshotDirty(app.id, derivation.earliestOccurredAt);
      }
      lifecycleResults.push({
        appId: app.id,
        appName: app.name,
        fetched: lifecycle.fetched,
        derived: derivation.derived,
        derivationInProgress: derivation.inProgress,
        derivationPending: derivation.hasMore,
        fresh: lifecycle.fresh,
        freshThrough: lifecycle.freshThrough?.toISOString() ?? null,
        recentComplete: lifecycle.recentComplete,
        historyComplete: lifecycle.historyComplete,
        inProgress: lifecycle.inProgress === true,
        ...(lifecycle.skipped ? { skipped: lifecycle.skipped } : {}),
      });
    } catch (error) {
      lifecycleErrors.push(
        `${app.name}: ${error instanceof Error ? error.message : "Shopify account lifecycle sync failed."}`,
      );
    }
  }
  // Clear again after writes so a read racing this sync cannot leave an old
  // process-local snapshot alive for the next dashboard request — but only
  // for apps that actually got new data. This used to unconditionally
  // invalidate every app on every trigger (dashboard mount, 5-min interval,
  // tab refocus), which wiped the live-Shopify-transaction cache even when
  // the sync above found nothing new to fetch — forcing /api/metrics/mrr's
  // live fallback to re-hit Shopify's Partner API from scratch every time
  // (measured 3.7-4.2s, 2026-08-09). Scoping to apps with a real change lets
  // that cache actually do its job between triggers.
  const appsWithNewFacts = facts.results
    .filter((result) => result.eventsInserted > 0 || result.salesInserted > 0)
    .map((result) => result.appId);
  const appsWithLifecycleChanges = lifecycleResults
    .filter((result) => result.derived > 0)
    .map((result) => result.appId);
  const changedAppIds = [
    ...new Set([...appsWithNewFacts, ...appsWithLifecycleChanges]),
  ];
  /**
   * Did this sync actually write anything a report would read? Everything that
   * follows — cache invalidation here, and the client's decision to refetch —
   * hangs off this, so a routine "nothing new" poll costs nothing downstream.
   */
  const dataChanged = changedAppIds.length > 0;
  void invalidateLivePartnerAnalyticsCache(appsWithNewFacts);
  void invalidatePartnerSubscriptionActivityCache(changedAppIds);
  // Also conditional now. This clear used to be unconditional, on the reasoning
  // that the cache behind it only reads already-persisted rows — which was
  // harmless while that cache's key was minted fresh per request and never hit
  // anyway. Now that the key is quantized and the cache genuinely serves repeat
  // loads, clearing it on every mount / 5-minute tick / tab refocus would throw
  // the reconstruction away before anyone could reuse it.
  if (dataChanged) void invalidatePersistedPartnerMrrCache();
  const activity = await readPersistedPartnerSubscriptionActivity(apps);
  const usableResults = facts.results.filter((result) => !result.skipped);
  const unavailable = apps.length === 0 || usableResults.length === 0;
  const requestedAtMs = requestedAt.getTime();
  const lifecycleFresh =
    apps.length > 0 &&
    lifecycleResults.length === apps.length &&
    lifecycleErrors.length === 0 &&
    lifecycleResults.every(
      (result) =>
        result.recentComplete &&
        !result.inProgress &&
        !result.skipped &&
        result.fresh &&
        result.freshThrough !== null &&
        new Date(result.freshThrough).getTime() >= requestedAtMs,
    );
  const fresh = facts.fresh && lifecycleFresh;
  const inProgress =
    facts.results.some((result) => result.inProgress) ||
    lifecycleResults.some((result) => result.inProgress);
  const lifecycleDerivationPending = lifecycleResults.some(
    (result) => result.derivationInProgress || result.derivationPending,
  );
  const skippedErrors = facts.results.flatMap((result) =>
    result.skipped ? [`${result.appName}: ${result.skipped}`] : [],
  );
  const billingRefreshedAt = facts.freshness.freshThrough;
  const lifecycleRefreshedAt =
    apps.length > 0 &&
    lifecycleResults.length === apps.length &&
    lifecycleResults.every((result) => result.freshThrough !== null)
      ? new Date(
          Math.min(
            ...lifecycleResults.map((result) =>
              new Date(result.freshThrough!).getTime(),
            ),
          ),
        ).toISOString()
      : null;
  const refreshedAt =
    billingRefreshedAt && lifecycleRefreshedAt
      ? new Date(
          Math.min(
            new Date(billingRefreshedAt).getTime(),
            new Date(lifecycleRefreshedAt).getTime(),
          ),
        ).toISOString()
      : null;
  return Response.json(
    {
      ...(unavailable
        ? { error: "No selected app has a usable Shopify Partner connection." }
        : {}),
      requestedAt: requestedAt.toISOString(),
      refreshedAt,
      billingRefreshedAt,
      lifecycleRefreshedAt,
      dataChanged,
      fresh,
      billingFresh: facts.fresh,
      lifecycleFresh,
      lifecycleDerivationPending,
      freshness: facts.freshness,
      historyComplete: facts.freshness.historyComplete,
      lifecycleHistoryComplete:
        lifecycleResults.length === apps.length &&
        lifecycleResults.every((result) => result.historyComplete),
      inProgress,
      apps: apps.length,
      events: activity.events.length,
      errors: [
        ...activity.errors.map((error) => `${error.appName}: ${error.message}`),
        ...facts.errors.map((error) => `${error.appName}: ${error.message}`),
        ...skippedErrors,
        ...lifecycleErrors,
        ...lifecycleResults.flatMap((result) =>
          result.skipped ? [`${result.appName}: ${result.skipped}`] : [],
        ),
        ...trafficEventsErrors,
      ],
      facts,
      lifecycle: lifecycleResults,
      rawFactsPersisted: true,
      calculatedMetricsPersisted: false,
    },
    {
      status: unavailable ? 503 : fresh ? 200 : 202,
      headers: {
        "Cache-Control": "no-store",
        ...(!fresh && !unavailable
          ? { "Retry-After": inProgress ? "5" : "2" }
          : {}),
      },
    },
  );
}
