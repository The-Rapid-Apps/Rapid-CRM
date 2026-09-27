import type { LoaderFunctionArgs } from "react-router";
import { z } from "zod";
import { requireCurrentOrganization } from "~/lib/current-org.server";
import { cachedWithRedis } from "~/lib/cache/redis-cache.server";
import { resolveDomainsMatchingNameOrWebsite } from "~/lib/customer-name.server";
import { TRIAL_HISTORY_PAGE_SIZE } from "~/lib/reports/analytics.shared";
import { metricsQuerySchema } from "~/lib/reports/metrics-query";
import { filterTrialHistory } from "~/lib/reports/trial-history-filter";
import { prisma } from "~/lib/db.server";
import { env } from "~/lib/env.server";
import {
  getChurnReport,
  getAnalyticsReports,
  getLtvReport,
  getLtvReportFromRecurring,
  getPortfolioReport,
  getRevenueReport,
  resolveReportRange,
} from "~/lib/reports/analytics.server";
import type { RevenueReport } from "~/lib/reports/analytics.server";
import {
  ANALYTICS_INTERVALS,
  ANALYTICS_PERIODS,
} from "~/lib/reports/analytics.shared";
import { applyLivePartnerAnalytics } from "~/lib/shopify/partner-analytics.server";
import {
  buildPersistedPartnerAnalytics,
  buildPartnerTrialsForRange,
  buildTrialExpirySchedule,
  buildTrialHistoryFacts,
  hydrateTrialHistory,
  mergePartnerAnalyticsIntoPortfolio,
  partnerLifecycleReadiness,
} from "~/lib/shopify/partner-mrr.server";
import {
  buildSnapshotPartnerAnalytics,
  buildSnapshotPartnerChurnSeries,
  buildSnapshotPartnerRecurring,
  buildSnapshotPartnerRecurringSeries,
  mergeRecurringReports,
  mergeRecurringSeriesReports,
  mergeRevenueReports,
  partnerSnapshotReadiness,
} from "~/lib/shopify/partner-mrr-snapshot.server";
import { readPersistedPartnerSubscriptionActivity } from "~/lib/shopify/partner-subscriptions.server";
import { readPartnerSubscriptionFreshness } from "~/lib/shopify/partner-subscription-sync.server";

/** Long enough that the 8s fold is paid once per view rather than per
 * visitor; short enough that a converted trial shows up the same session. */
const TRIALS_CACHE_MS = 5 * 60_000;

export const METRICS_RESPONSE_HEADERS = {
  "Cache-Control": "private, no-store",
} as const;

/**
 * Re-enabled 2026-08-18 after fixing real drift in `historiesFromFacts`'s
 * cross-charge cadence/amount inference, which was recomputed live and could
 * silently reclassify a charge weeks later as sibling sales settled. Fixed by
 * pinning each offer's inference once via `resolveOfferCadencePins`/
 * `PartnerOfferCadenceInference` (see its schema.prisma doc comment).
 * `PartnerDailyMrrSnapshot` was rebuilt and re-parity-checked across all apps
 * with zero discrepancies.
 */
const RECURRING_SERIES_SNAPSHOT_ENABLED = true;


const metricSchema = z.enum([
  "all",
  "portfolio",
  "mrr",
  "revenue",
  "recurring",
  "ltv",
  "churn",
  "activity",
  "trials",
]);

/**
 * Read-only dashboard metrics API. It uses the signed-in user's organization
 * as the tenant boundary; callers cannot supply or override organizationId.
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
  const organization = await requireCurrentOrganization(request);
  const metric = metricSchema.safeParse(params.metric);
  if (!metric.success) {
    return Response.json(
      { error: "Unknown metric" },
      { status: 404, headers: METRICS_RESPONSE_HEADERS },
    );
  }

  const url = new URL(request.url);
  const parsed = metricsQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid report query", issues: parsed.error.issues },
      { status: 400, headers: METRICS_RESPONSE_HEADERS },
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
      return Response.json(
        { error: "App not found" },
        { status: 404, headers: METRICS_RESPONSE_HEADERS },
      );
    }
  }

  const query = {
    organizationId: organization.id,
    appId: parsed.data.appId,
    period: parsed.data.period,
    interval: parsed.data.interval,
  };
  // Resolve the window ONCE and hand it to every report function below. Letting
  // each of them call `rangeFor` independently re-reads the clock per call, so
  // otherwise-identical loads land on different cache keys and repeat the same
  // query. Every report function takes this as its `suppliedRange` argument.
  const range = await resolveReportRange(query);
  const [apps, freshness] = await Promise.all([
    prisma.app.findMany({
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
        partnerConnection: {
          select: {
            partnerOrganizationId: true,
            encryptedAccessToken: true,
          },
        },
        billingEventsBackfillCompletedAt: true,
        billingSalesBackfillCompletedAt: true,
      },
    }),
    readPartnerSubscriptionFreshness({
      organizationId: organization.id,
      appId: parsed.data.appId,
    }),
  ]);
  if (metric.data === "activity") {
    const data = await readPersistedPartnerSubscriptionActivity(apps);
    return Response.json(
      {
        metric: metric.data,
        data,
        source: {
          provider: "shopify_partner_lifecycle",
          persisted: true,
          calculatedMetricsPersisted: false,
          freshness,
        },
      },
      {
        headers: METRICS_RESPONSE_HEADERS,
      },
    );
  }

  // Cheap verdict on whether persisted Partner facts can serve this report,
  // derived from the `apps` rows already loaded above. It has to be known
  // before any expensive work starts, because when it is true most of the local
  // mirror computation below is thrown away unread.
  const readiness = partnerLifecycleReadiness(apps);
  // Lazily start the full unscoped reconstruction — memoized so every call
  // site shares the same in-flight promise, but NOT kicked off
  // unconditionally: `revenue`/`recurring` have their own snapshot-backed
  // fast paths below and, once apps are snapshot-ready, never need this.
  // Eagerly starting it used to waste CPU running the full reconstruction in
  // the background even when the response came from the snapshot instead.
  //
  // [DIAG] timing carried over from 50b555a; fires once per first trigger —
  // a cache hit reports ~0ms, which is the number to watch.
  const requestedMode = parsed.data.mode;
  let partnerPendingPromise: ReturnType<typeof buildPersistedPartnerAnalytics> | null = null;
  function getPartnerPending() {
    if (!readiness.coverage.applied) return null;
    if (!partnerPendingPromise) {
      const partnerStartedAt = Date.now();
      partnerPendingPromise = buildPersistedPartnerAnalytics({
        readiness,
        range,
      }).then((result) => {
        console.log(
          `[DIAG] persistedPartnerAnalytics metric=${metric.data} mode=${requestedMode}: ${Date.now() - partnerStartedAt}ms`,
        );
        return result;
      });
    }
    return partnerPendingPromise;
  }
  console.log(
    `[DIAG] metric=${metric.data} mode=${parsed.data.mode} coverage=`,
    readiness.coverage,
  );
  // Phase 1 of the daily snapshot table: reads a precomputed row per
  // (app, day) instead of reconstructing from raw facts, for `revenue` only.
  // Gated behind SNAPSHOT_READ_PATH_ENABLED for an instant kill switch.
  // Strictly additive: when `readyAppIds` is empty, every branch below is
  // unchanged from before this existed.
  //
  // Partitioned per-app (2026-08-16), not all-or-nothing: an "All apps"
  // request used to fall back entirely to live reconstruction the moment ONE
  // app was missing a single day of snapshot coverage. Now ready apps are
  // served from the snapshot and only the remaining apps pay for live
  // reconstruction, scoped just to them.
  /**
   * Trials on their own, for the Overview's trials card.
   *
   * Separate from `portfolio` because that report is the page's single most
   * expensive stage and the card needs none of it. The trial fold is itself
   * slow — MEASURED at 7.5-10.7s across ~110k charge histories, and a warm
   * `loadPartnerFacts` cache barely helps because the cost is the fold, not
   * the load — so the RESULT is cached, not just the facts underneath it.
   * Callers fetch this in the background and render the card's cheap half
   * (trial VALUE, which rides along on the recurring series) immediately.
   */
  if (metric.data === "trials") {
    const [trials, expirySchedule, historyFacts] = await cachedWithRedis(
      `trials:${[...readiness.appIds].sort().join(",")}:${range.start.toISOString()}:${range.end.toISOString()}`,
      TRIALS_CACHE_MS,
      () =>
        Promise.all([
          buildPartnerTrialsForRange({ appIds: readiness.appIds, range }),
          /* The forward pipeline is a different question from the range's
             history, and is not bounded by it — trials expire after the range
             ends, which is the whole point of showing them. */
          buildTrialExpirySchedule({ appIds: readiness.appIds }),
          /* EVERY trial in the range, not a page of them. Shares this cache
             entry because it folds the same charge histories — running it
             separately would pay the ~7s fold twice for one view — and the
             filtering below then runs against the whole period instead of a
             slice, which is what made the table's search trustworthy. Held
             without display names: see `buildTrialHistoryFacts`. */
          buildTrialHistoryFacts({ appIds: readiness.appIds, range }),
        ]),
    );

    /* Search and filters are applied HERE, to the cached full set, rather
       than in the browser to whatever rows were shipped. The filter values
       are deliberately NOT part of the cache key above: keystrokes would
       otherwise each miss the cache and pay the fold. */
    const historyStatus = parsed.data.historyStatus;
    const historyPaidOnly = parsed.data.historyPaidOnly;
    const historyQuery = (parsed.data.historyQuery ?? "").toLowerCase();
    /* A customer's store name lives in another table, so matching it by
       scanning these rows is impossible — the name isn't on them. Resolve the
       matching domains once (the same helper the Customers search uses) and
       match by domain instead. */
    const matchingDomains = historyQuery
      ? new Set(await resolveDomainsMatchingNameOrWebsite(historyQuery))
      : null;

    const matched = filterTrialHistory(historyFacts, {
      query: historyQuery,
      status: historyStatus,
      paidOnly: historyPaidOnly,
      matchingDomains,
    });

    const pageSize = TRIAL_HISTORY_PAGE_SIZE;
    const pageCount = Math.max(1, Math.ceil(matched.length / pageSize));
    /* Clamped, not trusted: a filter that shortens the list can leave the
       client asking for a page that no longer exists. */
    const page = Math.min(parsed.data.historyPage, pageCount);
    const history = await hydrateTrialHistory(
      matched.slice((page - 1) * pageSize, page * pageSize),
    );

    return Response.json(
      {
        metric: metric.data,
        data: {
          ...trials,
          expirySchedule,
          history,
          historyPage: page,
          historyPageCount: pageCount,
          /* Totals over the WHOLE match, not the page — the table's "Active
             trials" and "Total value" used to be sums of one page. */
          historyMatched: matched.length,
          historyActive: matched.filter((row) => row.status === "on_trial")
            .length,
          historyValue: matched.reduce(
            (total, row) => total + row.monthlyAmount,
            0,
          ),
        },
        source: { provider: "shopify_partner_lifecycle", persisted: false },
      },
      { headers: METRICS_RESPONSE_HEADERS },
    );
  }

  const snapshotReadiness = env.SNAPSHOT_READ_PATH_ENABLED
    ? await partnerSnapshotReadiness({ appIds: readiness.appIds, range })
    : { applied: false as const, appIds: readiness.appIds, readyAppIds: [], liveAppIds: readiness.appIds, missingDays: -1 };
  const snapshotPending =
    snapshotReadiness.readyAppIds.length > 0
      ? buildSnapshotPartnerAnalytics({
          readyAppIds: snapshotReadiness.readyAppIds,
          range,
        })
      : null;
  // Revenue for whichever apps the snapshot can't cover this request, scoped
  // ONLY to those apps — never a second full-org reconstruction. When every
  // app needs the live path anyway (liveAppIds is the full scope), this is
  // exactly `getPartnerPending()` (identical appIds, identical cache key), so
  // reuse it instead of running the same reconstruction twice; that also
  // keeps this correctly gated on `readiness.coverage.applied` for free,
  // since `getPartnerPending()` already is.
  const revenueLiveAppIds = snapshotReadiness.liveAppIds;
  const revenueLivePending =
    revenueLiveAppIds.length === 0
      ? null
      : revenueLiveAppIds.length === readiness.appIds.length
        ? getPartnerPending()
        : readiness.coverage.applied
          ? buildPersistedPartnerAnalytics({
              readiness: { appIds: revenueLiveAppIds, coverage: readiness.coverage },
              range,
            })
          : null;
  const persistedSource = {
    provider: readiness.coverage.provider,
    persisted: true,
    calculatedMetricsPersisted: false,
    lifecycle: readiness.coverage,
    freshness,
  };
  const localSource = {
    provider: "local_lifecycle_mirror",
    persisted: false,
    lifecycle: readiness.coverage,
    freshness,
  };

  if (metric.data === "ltv") {
    // Snapshot-backed fast path (2026-08-18), same shape as `recurring`
    // above but with the full per-bucket series `getLtvReportFromRecurring`
    // needs. It already falls back to the install-snapshot-backed
    // `logoChurnAtFromSnapshot` path whenever a point lacks
    // `monthlySubscriptionChurnRate` (true for every snapshot-derived point
    // by design), so no LTV-specific churn logic is needed here.
    const recurringSnapshotPending =
      RECURRING_SERIES_SNAPSHOT_ENABLED && snapshotReadiness.readyAppIds.length > 0
        ? buildSnapshotPartnerRecurringSeries({
            readyAppIds: snapshotReadiness.readyAppIds,
            range,
          })
        : null;
    const [recurringSnapshot, liveForRest] = await Promise.all([
      recurringSnapshotPending,
      revenueLivePending,
    ]);
    // Only take the snapshot-first path when the snapshot actually
    // contributed something — with RECURRING_SERIES_SNAPSHOT_ENABLED off,
    // recurringSnapshot is always null and this falls through to the
    // original full-reconstruction path below.
    const recurring = recurringSnapshot
      ? liveForRest
        ? mergeRecurringSeriesReports(recurringSnapshot, liveForRest.recurring)
        : recurringSnapshot
      : null;
    if (recurring) {
      const data = await getLtvReportFromRecurring(query, recurring, range);
      return Response.json(
        {
          metric: metric.data,
          data,
          source: recurringSnapshot
            ? {
                provider: liveForRest
                  ? "shopify_partner_lifecycle_snapshot_partial"
                  : "shopify_partner_lifecycle_snapshot",
                persisted: true,
                calculatedMetricsPersisted: !liveForRest,
                lifecycle: readiness.coverage,
                freshness,
              }
            : {
                ...persistedSource,
                errors: [],
                annualHistoryComplete: true,
                recentHistoryComplete: true,
                historySampled: false,
              },
        },
        { headers: METRICS_RESPONSE_HEADERS },
      );
    }

    // When the lifecycle applies, LTV is derived entirely from the reconstructed
    // recurring series — the local portfolio and the local LTV report were both
    // computed and discarded here.
    const ltvPartnerPending = getPartnerPending();
    const data = ltvPartnerPending
      ? await getLtvReportFromRecurring(
          query,
          (await ltvPartnerPending).recurring,
          range,
        )
      : await getLtvReport(query, range);
    return Response.json(
      {
        metric: metric.data,
        data,
        source: ltvPartnerPending ? persistedSource : localSource,
      },
      {
        headers: METRICS_RESPONSE_HEADERS,
      },
    );
  }

  if (metric.data === "churn") {
    // Snapshot-backed fast path (2026-08-18): `subscription`/`grossRevenue`
    // come from PartnerDailyMrrSnapshot; `logo` (shop-level) comes from
    // PartnerDailyLogoChurnSnapshot, scoped to either one real appId or the
    // org-wide sentinel row — never both, so a shop active in multiple apps
    // is never double-counted (see that model's doc comment). Deliberately
    // all-or-nothing, not partial-merged like mrr/ltv:
    // `buildSnapshotPartnerChurnSeries` returns null on ANY coverage gap in
    // either table, falling through to the full live reconstruction below.
    const churnSnapshotPending = snapshotReadiness.applied
      ? buildSnapshotPartnerChurnSeries({
          organizationId: organization.id,
          mrrReadyAppIds: snapshotReadiness.readyAppIds,
          logoScope: parsed.data.appId
            ? { kind: "single", appId: parsed.data.appId }
            : { kind: "all" },
          range,
        })
      : null;
    const churnSnapshot = await churnSnapshotPending;
    if (churnSnapshot) {
      return Response.json(
        {
          metric: metric.data,
          data: churnSnapshot,
          source: {
            provider: "shopify_partner_lifecycle_snapshot",
            persisted: true,
            calculatedMetricsPersisted: true,
            lifecycle: readiness.coverage,
            freshness,
          },
        },
        { headers: METRICS_RESPONSE_HEADERS },
      );
    }

    // Same story as before this existed: the local churn report was only
    // ever used as the fallback.
    const churnPartnerPending = getPartnerPending();
    const data = churnPartnerPending
      ? (await churnPartnerPending).churn
      : await getChurnReport(query, range);
    return Response.json(
      {
        metric: metric.data,
        data,
        source: churnPartnerPending ? persistedSource : localSource,
      },
      {
        headers: METRICS_RESPONSE_HEADERS,
      },
    );
  }

  if (metric.data === "all") {
    const [local, partner] = await Promise.all([
      getAnalyticsReports(query, range),
      getPartnerPending(),
    ]);
    if (partner) {
      const portfolio = mergePartnerAnalyticsIntoPortfolio(
        local.portfolio,
        partner,
      );
      const ltv = await getLtvReportFromRecurring(
        query,
        portfolio.recurring,
        range,
      );
      return Response.json(
        {
          metric: metric.data,
          data: {
            ...local,
            portfolio,
            revenue: partner.revenue,
            churn: partner.churn,
            ltv,
          },
          source: {
            ...persistedSource,
            errors: [],
            annualHistoryComplete: true,
            recentHistoryComplete: true,
            historySampled: false,
          },
        },
        {
          headers: METRICS_RESPONSE_HEADERS,
        },
      );
    }

    const live = await applyLivePartnerAnalytics(local, apps);
    return Response.json(
      {
        metric: metric.data,
        data: live.reports,
        source: {
          provider: "shopify_partner_api",
          persisted: false,
          calculatedMetricsPersisted: false,
          transactionCount: live.transactionCount,
          errors: live.errors,
          annualHistoryComplete: live.annualHistoryComplete,
          recentHistoryComplete: live.recentHistoryComplete,
          historySampled: live.historySampled,
          lifecycle: readiness.coverage,
          freshness,
        },
      },
      {
        headers: METRICS_RESPONSE_HEADERS,
      },
    );
  }

  // Revenue is served whole from the reconstruction, so the local portfolio —
  // the single most expensive stage in this route — is not needed at all here.
  /**
   * The dashed "Previous period" line, same idea as app-dashboard.tsx's
   * comparison series: the immediately preceding window of equal length,
   * computed with the same report so the two are like for like.
   *
   * Started here rather than inside a branch because `revenue` has TWO return
   * paths — the snapshot one below and the live fallback at the end — and
   * attaching it to only the first silently dropped the line whenever the
   * request took the other. Opt-in via `compare=1`; nothing else asks.
   */
  const revenueComparison =
    metric.data === "revenue" && parsed.data.compare
      ? (async () => {
          const span = range.end.getTime() - range.start.getTime();
          const previous = {
            ...range,
            start: new Date(range.start.getTime() - span),
            end: range.start,
          };
          /* The SNAPSHOT report, not `getRevenueReport` — that one is the
             local portfolio's revenue, which is empty here because earnings
             live in the Partner sale facts. Asking it for the previous window
             returned `currencies: []` every time, and the `?? null` fallback
             turned that into a silently missing line rather than an error. */
          /* Readiness is PER RANGE. Reusing this request's (computed for the
             current window) asked the snapshot for apps it doesn't cover a
             month earlier, and it answered with `currencies: []` — the line
             went missing rather than erroring. */
          const previousReadiness = await partnerSnapshotReadiness({
            appIds: readiness.appIds,
            range: previous,
          });
          if (previousReadiness.readyAppIds.length === 0) return null;
          const previousSnapshot = await buildSnapshotPartnerAnalytics({
            readyAppIds: previousReadiness.readyAppIds,
            range: previous,
          });
          return previousSnapshot?.revenue.currencies ?? null;
        })().catch(() => null)
      : Promise.resolve(null);

  if (metric.data === "revenue") {
    const [snapshot, liveForRest] = await Promise.all([
      snapshotPending,
      revenueLivePending,
    ]);
    const revenue =
      snapshot && liveForRest
        ? mergeRevenueReports(snapshot.revenue, liveForRest.revenue)
        : (snapshot?.revenue ?? liveForRest?.revenue ?? null);
    if (revenue) {
      const comparison = await revenueComparison;
      return Response.json(
        {
          metric: metric.data,
          data: comparison ? { ...revenue, comparison } : revenue,
          source: snapshot
            ? {
                provider: liveForRest
                  ? "shopify_partner_lifecycle_snapshot_partial"
                  : "shopify_partner_lifecycle_snapshot",
                persisted: true,
                calculatedMetricsPersisted: !liveForRest,
                lifecycle: readiness.coverage,
                freshness,
              }
            : {
                ...persistedSource,
                errors: [],
                annualHistoryComplete: true,
                recentHistoryComplete: true,
                historySampled: false,
              },
        },
        {
          headers: METRICS_RESPONSE_HEADERS,
        },
      );
    }
  }

  // Same story as `revenue`: dashboard cards that only need the MRR/ARR/growth
  // summary used to fetch `mrr` and pay for the local portfolio's
  // funnel/retention/trials/usage/install fields, the most expensive stage
  // in this route, without ever rendering them.
  //
  // Snapshot-backed fast path (2026-08-17), mirroring `revenue` above: reads
  // PartnerDailyMrrSnapshot rows instead of reconstructing MRR from the full
  // event/sale history. Only Overview calls this, for its `currencies`
  // summary — see buildSnapshotPartnerRecurring's doc comment for what it
  // deliberately omits and why that's safe here.
  if (metric.data === "recurring") {
    /* The summary builder returns `timeSeries: []` on purpose — the snapshot
       table doesn't persist it. Overview now draws a sparkline per metric, so
       it asks for the series variant; everything else keeps the cheaper
       summary. Both read the same snapshot rows, so the figures agree. */
    const wantsSeries = parsed.data.series === true;
    const recurringSnapshotPending =
      snapshotReadiness.readyAppIds.length > 0
        ? wantsSeries
          ? buildSnapshotPartnerRecurringSeries({
              readyAppIds: snapshotReadiness.readyAppIds,
              range,
            })
          : buildSnapshotPartnerRecurring({
              readyAppIds: snapshotReadiness.readyAppIds,
              range,
            })
        : null;
    const [recurringSnapshot, liveForRest] = await Promise.all([
      recurringSnapshotPending,
      revenueLivePending,
    ]);
    const mergeRecurring = wantsSeries
      ? mergeRecurringSeriesReports
      : mergeRecurringReports;
    const recurring =
      recurringSnapshot && liveForRest
        ? mergeRecurring(recurringSnapshot, liveForRest.recurring)
        : (recurringSnapshot ?? liveForRest?.recurring ?? null);
    if (recurring) {
      return Response.json(
        {
          metric: metric.data,
          data: recurring,
          source: recurringSnapshot
            ? {
                provider: liveForRest
                  ? "shopify_partner_lifecycle_snapshot_partial"
                  : "shopify_partner_lifecycle_snapshot",
                persisted: true,
                calculatedMetricsPersisted: !liveForRest,
                lifecycle: readiness.coverage,
                freshness,
              }
            : {
                ...persistedSource,
                errors: [],
                annualHistoryComplete: true,
                recentHistoryComplete: true,
                historySampled: false,
              },
        },
        {
          headers: METRICS_RESPONSE_HEADERS,
        },
      );
    }
  }

  // Snapshot-backed fast path (2026-08-18) for `mrr`/`portfolio`: reuse the
  // same snapshot-derived recurring series `ltv` above uses. Only taken when
  // it covers at least some apps — otherwise fall through to
  // `getPartnerPending()`, which already computes trials as part of the full
  // reconstruction (taking this branch then would pay for trials twice).
  // `mergePartnerAnalyticsIntoPortfolio` only reads `analytics.recurring`,
  // so this also skips churn computation, which measured as comparably
  // expensive to the recurring bucket loop itself (2s+ at 90 days).
  if (
    RECURRING_SERIES_SNAPSHOT_ENABLED &&
    (metric.data === "mrr" || metric.data === "portfolio")
  ) {
    const recurringSnapshotPending =
      snapshotReadiness.readyAppIds.length > 0
        ? buildSnapshotPartnerRecurringSeries({
            readyAppIds: snapshotReadiness.readyAppIds,
            range,
          })
        : null;
    const recurringSnapshot = await recurringSnapshotPending;
    if (recurringSnapshot) {
      const liveForRest = await revenueLivePending;
      const recurring = liveForRest
        ? mergeRecurringSeriesReports(recurringSnapshot, liveForRest.recurring)
        : recurringSnapshot;
      const [portfolio, trials] = await Promise.all([
        getPortfolioReport(query, range),
        buildPartnerTrialsForRange({ appIds: readiness.appIds, range }),
      ]);
      return Response.json(
        {
          metric: metric.data,
          data: mergePartnerAnalyticsIntoPortfolio(portfolio, {
            recurring: { ...recurring, trials },
          }),
          source: {
            provider: liveForRest
              ? "shopify_partner_lifecycle_snapshot_partial"
              : "shopify_partner_lifecycle_snapshot",
            persisted: true,
            calculatedMetricsPersisted: !liveForRest,
            lifecycle: readiness.coverage,
            freshness,
          },
        },
        { headers: METRICS_RESPONSE_HEADERS },
      );
    }
  }

  // `mrr` / `portfolio` keep the local portfolio because installs, funnel,
  // retention and usage still come from the mirror — but the reconstruction now
  // runs alongside it rather than after it.
  const portfolioStartedAt = Date.now();
  const [portfolio, partner] = await Promise.all([
    getPortfolioReport(query, range).then((result) => {
      console.log(
        `[DIAG] getPortfolioReport metric=${metric.data} mode=${parsed.data.mode}: ${Date.now() - portfolioStartedAt}ms`,
      );
      return result;
    }),
    getPartnerPending(),
  ]);
  if (partner) {
    return Response.json(
      {
        metric: metric.data,
        data: mergePartnerAnalyticsIntoPortfolio(portfolio, partner),
        source: {
          ...persistedSource,
          errors: [],
          annualHistoryComplete: true,
          recentHistoryComplete: true,
          historySampled: false,
        },
      },
      {
        headers: METRICS_RESPONSE_HEADERS,
      },
    );
  }
  const revenue: RevenueReport =
    metric.data === "revenue"
      ? await getRevenueReport(query, range)
      : {
          period: portfolio.period,
          periodStart: portfolio.periodStart,
          periodEnd: portfolio.periodEnd,
          interval: portfolio.interval,
          currencies: [],
        };
  const local = { portfolio, revenue };
  const live = await applyLivePartnerAnalytics(local, apps, {
    fastMrr:
      (metric.data === "mrr" ||
        metric.data === "portfolio" ||
        metric.data === "recurring") &&
      parsed.data.mode !== "exact",
    sampledHistory: parsed.data.mode === "sampled",
    signal: request.signal,
  });
  const fallbackComparison = await revenueComparison;
  const data =
    metric.data === "recurring"
      ? live.reports.portfolio.recurring
      : metric.data === "portfolio" || metric.data === "mrr"
        ? live.reports.portfolio
        : fallbackComparison
          ? { ...live.reports.revenue, comparison: fallbackComparison }
          : live.reports.revenue;

  return Response.json(
    {
      metric: metric.data,
      data,
      source: {
        provider: "shopify_partner_api",
        persisted: false,
        transactionCount: live.transactionCount,
        errors: live.errors,
        annualHistoryComplete: live.annualHistoryComplete,
        recentHistoryComplete: live.recentHistoryComplete,
        historySampled: live.historySampled,
        lifecycle: readiness.coverage,
        freshness,
      },
    },
    {
      headers: METRICS_RESPONSE_HEADERS,
    },
  );
}
