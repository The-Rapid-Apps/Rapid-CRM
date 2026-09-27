import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import {
  ActionList,
  Badge,
  Banner,
  BlockStack,
  Button,
  ButtonGroup,
  Card,
  InlineStack,
  Page,
  Popover,
  TextField,
  SkeletonBodyText,
  SkeletonDisplayText,
  Text,
} from "@shopify/polaris";
import {
  AppsIcon,
  ChartLineIcon,
  ConnectIcon,
  SearchIcon,
  CreditCardIcon,
} from "@shopify/polaris-icons";
import { Link } from "react-router";
import type { Route } from "./+types/overview";
import type {
  ChurnReport,
  LtvReport,
  PortfolioReport,
  RevenueReport,
} from "~/lib/reports/analytics.server";
import type { TrialSummary } from "~/lib/reports/analytics.server";
import type { TrialExpiryPoint } from "~/lib/shopify/partner-mrr.server";

/** The trials endpoint's payload: the range's history plus the forward
 * pipeline, which is not bounded by that range. */
type TrialsPayload = TrialSummary & { expirySchedule: TrialExpiryPoint[] };

/** Revenue plus the preceding window, when `compare=1` was asked for. */
type RevenueWithComparison = RevenueReport & {
  comparison?: RevenueReport["currencies"];
};
import {
  buildOverviewMetricGroups,
  type OverviewMetric,
} from "~/lib/reports/overview-metrics";
import {
  MRR_MOVEMENT_ROWS,
  type MrrMovementSummary,
} from "~/lib/reports/mrr-movement.shared";
import { compactMoney, useChartTheme } from "~/lib/chart-theme";
import {
  ANALYTICS_PERIODS,
  type AnalyticsPeriod,
} from "~/lib/reports/analytics.shared";
import { AppPicker } from "~/components/app-picker";
import { RecentReviewsCard } from "~/components/recent-reviews-card";
import { getRecentReviews } from "~/lib/reviews/recent-reviews.server";
import { AppName } from "~/components/app-identity";
import {
  REPORT_META,
  REPORTS,
} from "~/lib/reports/report-catalog";
import { PERIOD_LABELS } from "./reports";
import type { PartnerSubscriptionActivity } from "~/lib/shopify/partner-subscriptions.server";
import { prisma } from "~/lib/db.server";
import {
  getRecentInstalls,
  type RecentInstall,
} from "~/lib/reports/recent-installs.server";
import {
  getTopCustomers,
  type TopCustomer,
  type TopCustomerStatus,
} from "~/lib/reports/top-customers.server";
import { reasonLabel } from "./uninstalls";
import {
  buildOverviewInsights,
  type OverviewInsight,
} from "~/lib/reports/overview-insights";
import { requireCurrentOrganization } from "~/lib/current-org.server";
import { formatDateTime, formatMoney } from "~/lib/format";

/* Lazy for the reason reports.tsx does it: polaris-viz is a large dependency
   and the Overview paints its cards long before any chart is needed. */
const PolarisVizProvider = lazy(async () => ({
  default: (await import("@shopify/polaris-viz")).PolarisVizProvider,
}));
const LineChart = lazy(async () => ({
  default: (await import("@shopify/polaris-viz")).LineChart,
}));
const BarChart = lazy(async () => ({
  default: (await import("@shopify/polaris-viz")).BarChart,
}));
const DonutChart = lazy(async () => ({
  default: (await import("@shopify/polaris-viz")).DonutChart,
}));

/** The rail's fixed destinations. Mantle lets merchants curate these in
 * customize mode; ours are the workspace actions this page already offered. */
const QUICK_LINKS = [
  { label: "Manage apps", url: "/app/apps" },
  { label: "Browse subscriptions", url: "/app/subscriptions" },
  { label: "Shopify connections", url: "/app/connections" },
  { label: "Customers", url: "/app/customers" },
] as const;

export async function loader({ request }: Route.LoaderArgs) {
  const org = await requireCurrentOrganization(request);

  const apps = await prisma.app.findMany({
    where: {
      organizationId: org.id,
      enabled: true,
      removed: false,
      scheduledForDeletionAt: null,
    },
    orderBy: { name: "asc" },
    select: { id: true, name: true, logoUrl: true, appStoreHandle: true },
  });

  /* Step 3's list cards. All four are plain indexed queries (measured 22-187ms
     together), so they ride the loader rather than the client-side metric
     fetches — there is nothing here worth a spinner. Fixed 30-day window: the
     page's period filter is client state and these are server-rendered, which
     is why each card says "Last 30 days" rather than following the toolbar. */
  const now = new Date();
  const appIds = apps.map((app) => app.id);
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const previousSince = new Date(now.getTime() - 60 * 86_400_000);

  const [
    topCustomerRows,
    recentInstallRows,
    reasonsNow,
    reasonsBefore,
    recentReviews,
  ] = await Promise.all([
    getTopCustomers({ appIds, status: "active" }),
    getRecentInstalls({ appIds }),
    prisma.uninstallEventDetail.groupBy({
      by: ["reasonCode"],
      _count: { _all: true },
      where: { event: { appId: { in: appIds }, occurredAt: { gte: since } } },
      orderBy: { _count: { reasonCode: "desc" } },
      take: 6,
    }),
    prisma.uninstallEventDetail.groupBy({
      by: ["reasonCode"],
      _count: { _all: true },
      where: {
        event: {
          appId: { in: appIds },
          occurredAt: { gte: previousSince, lt: since },
        },
      },
    }),
    getRecentReviews(appIds, now),
  ]);

  /* Step 4's insights. Five counts, 53ms together — cheap enough to sit in
     the loader beside the cards rather than behind another fetch. */
  const lifecycleWindow = (days: number, offsetDays = 0) => ({
    gte: new Date(now.getTime() - (days + offsetDays) * 86_400_000),
    lt: new Date(now.getTime() - offsetDays * 86_400_000),
  });
  const countLifecycle = (
    type: "INSTALLED" | "UNINSTALLED",
    occurredAt: { gte: Date; lt: Date },
  ) =>
    prisma.accountLifecycleEvent.count({
      where: { appId: { in: appIds }, type, occurredAt },
    });

  const [
    installs30,
    installs30Previous,
    uninstalls7,
    uninstalls7Previous,
    installs7,
  ] = await Promise.all([
    countLifecycle("INSTALLED", lifecycleWindow(30)),
    countLifecycle("INSTALLED", lifecycleWindow(30, 30)),
    countLifecycle("UNINSTALLED", lifecycleWindow(7)),
    countLifecycle("UNINSTALLED", lifecycleWindow(7, 7)),
    countLifecycle("INSTALLED", lifecycleWindow(7)),
  ]);

  const previousByReason = new Map(
    reasonsBefore.map((row) => [row.reasonCode, row._count._all]),
  );

  /* Only what the cards' app pickers need. The connection/freshness status
     went with the App readiness card — that page (/app/apps) still reports it,
     and recomputing it here for nobody meant a freshness pass per load. */
  const appHealth = apps.map((app) => ({
    id: app.id,
    name: app.name,
    logoUrl: app.logoUrl,
    appStoreHandle: app.appStoreHandle,
  }));

  return {
    orgName: org.name,
    appHealth,
    topCustomers: topCustomerRows,
    recentInstalls: recentInstallRows,
    uninstallReasons: reasonsNow.map((row) => {
      const previous = previousByReason.get(row.reasonCode) ?? 0;
      return {
        reasonCode: row.reasonCode,
        count: row._count._all,
        previous,
        /* Null rather than 100% when nothing happened last period: a jump
           from zero has no percentage, and rendering one invents a trend. */
        changePercent:
          previous === 0 ? null : (row._count._all - previous) / previous,
      };
    }),
    insights: buildOverviewInsights({
      installs30,
      installs30Previous,
      uninstalls7,
      uninstalls7Previous,
      installs7,
    }),
    recentReviews,
    now: now.toISOString(),
  };
}

const EVENT_META: Record<
  string,
  { label: string; tone: "success" | "info" | "warning" | "critical" }
> = {
  SUBSCRIPTION_CHARGE_ACTIVATED: { label: "Activated", tone: "success" },
  SUBSCRIPTION_CHARGE_UNFROZEN: { label: "Unfrozen", tone: "info" },
  SUBSCRIPTION_CHARGE_FROZEN: { label: "Frozen", tone: "warning" },
  SUBSCRIPTION_CHARGE_CANCELED: { label: "Canceled", tone: "critical" },
  SUBSCRIPTION_CHARGE_DECLINED: { label: "Declined", tone: "critical" },
  SUBSCRIPTION_CHARGE_EXPIRED: { label: "Expired", tone: "critical" },
};

/** Mantle's chart tooltip: the bucket, then one dot-labelled row per series.
 * Values arrive PREFORMATTED so money, percentages and counts each read the
 * way their own metric does. */
function ChartTooltip({
  title,
  rows,
  dark,
}: {
  title: string;
  rows: Array<{ label: string; value: string; color: string }>;
  dark: boolean;
}) {
  return (
    <div
      style={{
        minWidth: 180,
        padding: "10px 12px",
        color: dark ? "#f7f7f7" : "#202223",
        background: dark ? "#090909" : "#ffffff",
        border: `1px solid ${dark ? "#333" : "#e1e2e3"}`,
        borderRadius: 10,
        boxShadow: "0 10px 28px rgba(0, 0, 0, 0.28)",
      }}
    >
      <div style={{ marginBottom: 8, fontWeight: 700 }}>{title}</div>
      <div style={{ display: "grid", gap: 6 }}>
        {rows.map((row) => (
          <div
            key={row.label}
            style={{
              display: "grid",
              gridTemplateColumns: "12px minmax(0, 1fr) auto",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 9,
                height: 9,
                borderRadius: "50%",
                background: row.color,
              }}
            />
            <span>{row.label}</span>
            <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>
              {row.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Bucket heading for a tooltip, e.g. "Sep 10". */
function bucketLabel(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

const CHART_ACCENT = "#8a6bf1";

/**
 * polaris-viz sizes a chart from `chartContainer.minHeight`, NOT from the
 * element it renders into — see the note on `useBarChartTheme`. The shared
 * theme sets 280px, so a chart dropped into a 48px tile draws 280px tall and
 * spills across the card. Every chart on this page states its own height.
 */
function withChartHeight<T extends { chartContainer: { minHeight: number } }>(
  theme: T,
  minHeight: number,
): T {
  return {
    ...theme,
    chartContainer: { ...theme.chartContainer, minHeight },
  };
}

const DISMISSED_INSIGHTS_KEY = "rapid.overview.dismissedInsights";

const CUSTOMER_STATUS_LABELS: Record<TopCustomerStatus, string> = {
  active: "Active",
  churned: "Churned",
  all: "All",
};

const METRIC_CHART_HEIGHT = 56;
const TRIALS_CHART_HEIGHT = 190;

/** Renders a point the way its own metric reads — the tile above the chart
 * shows a percentage or a currency, and the tooltip must not contradict it. */
function formatMetricPoint(
  value: number,
  format: "money" | "percent" | "count",
): string {
  if (format === "money") return formatMoney(value);
  if (format === "percent") return `${(value * 100).toFixed(2)}%`;
  return value.toLocaleString();
}

/** One metric: figure, period change, and a sparkline of its own series. */
function MetricTile({
  metric,
  loading,
}: {
  metric: OverviewMetric;
  loading: boolean;
}) {
  const { themes, isDark } = useChartTheme();
  /* A rise is good for revenue and bad for churn, so tone is driven by the
     metric, never by the sign alone. */
  const tone =
    metric.delta == null
      ? "subdued"
      : (metric.delta.direction === "up") === metric.riseIsGood
        ? "success"
        : "critical";

  return (
    <div className="overview-metric">
      <Text as="p" variant="bodySm" tone="subdued">
        {metric.label}
      </Text>
      {loading ? (
        <SkeletonDisplayText size="medium" />
      ) : (
        <div className="overview-metric__value">
          <Text as="p" variant="headingLg">
            {metric.value}
          </Text>
          {metric.delta ? (
            <Text as="span" variant="bodySm" tone={tone}>
              {metric.delta.direction === "up" ? "\u2191" : "\u2193"}{" "}
              {metric.delta.label}
            </Text>
          ) : null}
        </div>
      )}
      {metric.series.length > 1 ? (
        <div className="overview-metric__spark">
          <Suspense fallback={null}>
            <PolarisVizProvider
              themes={{
                Mantle: withChartHeight(themes.Mantle, METRIC_CHART_HEIGHT),
              }}
              defaultTheme="Mantle"
            >
              {/* Axes hidden: at 48px these are trend shapes, and axis labels
                  would eat the space the line needs. The tooltip carries the
                  reading instead — hover gives the day and the exact value,
                  which is what an axis would have told you. */}
              <LineChart
                data={[
                  {
                    name: metric.seriesName ?? metric.label,
                    data: metric.series.map((value, index) => ({
                      key: metric.labels[index] ?? String(index),
                      value,
                    })),
                  },
                  ...(metric.comparison
                    ? [
                        {
                          name: "Previous period",
                          isComparison: true,
                          /* Plotted against the CURRENT labels so the two
                             lines share an x position — "the same day one
                             window ago". */
                          data: metric.series.map((_, index) => ({
                            key: metric.labels[index] ?? String(index),
                            value: metric.comparison?.[index] ?? 0,
                          })),
                        },
                      ]
                    : []),
                ]}
                showLegend={false}
                xAxisOptions={{ hide: true }}
                /* YAxisOptions has no `hide` (only the X axis does), so the
                   Y axis is suppressed by giving it no ticks and no reserved
                   width rather than by drawing it in the background colour. */
                yAxisOptions={{ fixedWidth: 0, ticksOverride: [] as number[] }}
                tooltipOptions={{
                  renderTooltipContent: ({ activeIndex }) => {
                    const value = metric.series[activeIndex];
                    if (value === undefined) return null;
                    return (
                      <ChartTooltip
                        dark={isDark}
                        title={bucketLabel(
                          metric.labels[activeIndex] ?? new Date().toISOString(),
                        )}
                        rows={[
                          {
                            label: metric.seriesName ?? metric.label,
                            value: formatMetricPoint(value, metric.format),
                            color: CHART_ACCENT,
                          },
                          ...(metric.comparison
                            ? [
                                {
                                  label: "Previous period",
                                  value: formatMetricPoint(
                                    metric.comparison[activeIndex] ?? 0,
                                    metric.format,
                                  ),
                                  color: "#b7a7f5",
                                },
                              ]
                            : []),
                        ]}
                      />
                    );
                  },
                }}
              />
            </PolarisVizProvider>
          </Suspense>
        </div>
      ) : null}
    </div>
  );
}

/**
 * "$1,234.56 MRR increase from 7 event types", with the seven categories
 * beneath it — Mantle's own row order and signs, read from MRR_MOVEMENT_ROWS
 * so this strip and the Reports movement table can never disagree.
 *
 * Mantle also prints a COUNT per category ("1139 New"). Our movement buckets
 * carry money only, so the counts are absent rather than invented.
 */
function MovementStrip({ movement }: { movement: MrrMovementSummary }) {
  const total = movement.total;
  const net = total.net;
  return (
      <div className="overview-movement">
        <div className="overview-movement__head">
          <Text as="p" variant="headingSm">
            {`${net >= 0 ? "+" : "\u2212"}${formatMoney(Math.abs(net), movement.currency)} MRR ${net >= 0 ? "increase" : "decrease"} from ${MRR_MOVEMENT_ROWS.length} event types`}
          </Text>
        </div>
        <div className="overview-movement__row">
          {MRR_MOVEMENT_ROWS.map((row) => {
            const amount = total[row.key];
            const signed = row.loss ? -amount : amount;
            return (
              <div key={row.key} className="overview-movement__item">
                <Text as="span" variant="bodySm" tone="subdued">
                  {row.label}
                </Text>
                <Text
                  as="span"
                  variant="bodyMd"
                  tone={row.loss ? "critical" : "success"}
                >
                  {`${signed >= 0 ? "+" : "\u2212"}${formatMoney(Math.abs(amount), movement.currency)}`}
                </Text>
              </div>
            );
          })}
        </div>
      </div>
  );
}

export default function Overview({ loaderData }: Route.ComponentProps) {
  const {
    orgName,
    appHealth,
    topCustomers,
    recentInstalls,
    insights,
    uninstallReasons,
    recentReviews,
    now,
  } = loaderData;
  const [recurring, setRecurring] = useState<
    PortfolioReport["recurring"] | null
  >(null);
  /* Mantle's two Overview filters. Local state rather than the URL: they
     drive client-side fetches only, so a round trip through the loader would
     re-render the whole page to change a dropdown. */
  const [appId, setAppId] = useState("");
  const [period, setPeriod] = useState<AnalyticsPeriod>("last_30_days");
  const [periodOpen, setPeriodOpen] = useState(false);
  const { themes: chartThemes, isDark: isDarkTheme } = useChartTheme();
  /* Dismissals live in localStorage, not the database: they are one person's
     "I've seen that", and every insight returns on its own when the number
     behind it changes. Wrapped because storage throws in private windows and
     comes back empty when site data is cleared. */
  const [dismissedInsights, setDismissedInsights] = useState<string[]>([]);
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(DISMISSED_INSIGHTS_KEY);
      if (stored) setDismissedInsights(JSON.parse(stored) as string[]);
    } catch {
      /* no persistence available; dismissals last for this page view only */
    }
  }, []);
  const dismissInsight = (id: string) => {
    setDismissedInsights((current) => {
      const next = current.includes(id) ? current : [...current, id];
      try {
        window.localStorage.setItem(
          DISMISSED_INSIGHTS_KEY,
          JSON.stringify(next),
        );
      } catch {
        /* dismissal still applies for this page view */
      }
      return next;
    });
  };
  const [reportQuery, setReportQuery] = useState("");
  /* The card's own filters, independent of the page's period/app pickers —
     Mantle scopes this card separately too. Fetched from its own endpoint so
     changing them never re-runs the page loader and discards the metric
     fetches already in flight. */
  const [customerStatus, setCustomerStatus] =
    useState<TopCustomerStatus>("active");
  const [customerAppId, setCustomerAppId] = useState("");
  const [installAppId, setInstallAppId] = useState("");
  const [customerStatusOpen, setCustomerStatusOpen] = useState(false);
  const [customerRows, setCustomerRows] = useState<TopCustomer[] | null>(null);
  const [installRows, setInstallRows] = useState<RecentInstall[] | null>(null);
  const [trials, setTrials] = useState<TrialsPayload | null>(null);
  const [trialView, setTrialView] = useState<"active" | "converted">("active");
  const [revenue, setRevenue] = useState<RevenueWithComparison | null>(null);
  const [ltv, setLtv] = useState<LtvReport | null>(null);
  const [churn, setChurn] = useState<ChurnReport | null>(null);
  const [recentEvents, setRecentEvents] = useState<
    PartnerSubscriptionActivity[]
  >([]);
  const [metricsError, setMetricsError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const metricsLoading = recurring == null && !metricsError;

  useEffect(() => {
    const controller = new AbortController();
    const appQuery = appId ? `&appId=${encodeURIComponent(appId)}` : "";
    setMetricsError("");
    setRecurring(null);
    setRevenue(null);
    setLtv(null);
    setChurn(null);
    setTrials(null);
    void fetch(
      `/api/metrics/recurring?period=${period}&interval=day&mode=fast&series=1${appQuery}`,
      {
        signal: controller.signal,
        cache: "no-store",
        headers: { Accept: "application/json" },
      },
    )
      .then(async (response) => {
        const body = (await response.json()) as {
          data?: PortfolioReport["recurring"];
          error?: string;
        };
        if (!response.ok || !body.data) {
          throw new Error(body.error ?? "Portfolio metrics are unavailable.");
        }
        return body.data;
      })
      .then(setRecurring)
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError")
          return;
        setMetricsError(
          error instanceof Error
            ? error.message
            : "Portfolio metrics are unavailable.",
        );
      });
    /* The remaining three of Mantle's four metric sources. Fetched in
       parallel and rendered as each lands, so one slow report never holds the
       other two off screen — same reasoning as the recurring fetch above. */
    const loadReport = <T,>(
      metric: string,
      apply: (value: T) => void,
      extra = "",
    ): void => {
      void fetch(`/api/metrics/${metric}?period=${period}&interval=day${appQuery}${extra}`, {
        signal: controller.signal,
        cache: "no-store",
        headers: { Accept: "application/json" },
      })
        .then(async (response) => {
          const body = (await response.json()) as { data?: T };
          if (response.ok && body.data) apply(body.data);
        })
        .catch(() => undefined);
    };
    loadReport<RevenueWithComparison>("revenue", setRevenue, "&compare=1");
    loadReport<LtvReport>("ltv", setLtv);
    loadReport<ChurnReport>("churn", setChurn);
    /* Slowest of the lot — the fold behind it measures 7.5-10.7s cold. It is
       fetched like the others and simply arrives last; the card renders its
       value half from the recurring series in the meantime. */
    loadReport<TrialsPayload>("trials", setTrials);

    void fetch("/api/metrics/activity", {
      signal: controller.signal,
      cache: "no-store",
      headers: { Accept: "application/json" },
    })
      .then(async (response) => {
        const body = (await response.json()) as {
          data?: {
            events: PartnerSubscriptionActivity[];
            fetchedAt: string;
          };
        };
        if (response.ok && body.data) {
          setRecentEvents(
            body.data.events.filter((event) => !event.test).slice(0, 8),
          );
        }
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [refreshKey, appId, period]);

  useEffect(() => {
    // Only a sync that actually wrote facts makes what is on screen stale; a
    // routine "nothing new" poll should not trigger a second metrics fetch.
    const handleSync = (event: Event) => {
      const detail = (event as CustomEvent).detail as
        | { dataChanged?: boolean }
        | undefined;
      if (detail?.dataChanged === true) setRefreshKey((key) => key + 1);
    };
    window.addEventListener("shopify-sync-updated", handleSync);
    return () => window.removeEventListener("shopify-sync-updated", handleSync);
  }, []);

  const visibleReports = useMemo(() => {
    const needle = reportQuery.trim().toLowerCase();
    return REPORTS.map((key) => ({ key, ...REPORT_META[key] })).filter(
      (report) =>
        !needle ||
        `${report.label} ${report.description}`.toLowerCase().includes(needle),
    );
  }, [reportQuery]);

  /**
   * Both trial series come from the trials report now that its lifecycles
   * carry a monthly amount: active trial VALUE per bucket, and the value of
   * the trials that converted in it. The recurring series' own
   * `trialSubscriptions` says the same thing for "active", but only that one —
   * reading both from one source keeps the toggle's two halves comparable.
   */
  const trialChartPoints = useMemo(() => {
    if (trialView === "active") {
      return (trials?.expirySchedule ?? []).map((point) => ({
        periodStart: point.date,
        value: point.activeValue,
      }));
    }
    return (trials?.timeSeries ?? []).map((point) => ({
      periodStart: point.periodStart,
      value: point.convertedValue ?? 0,
    }));
  }, [trials, trialView]);
  /* Both totals sum, because both series are now FLOWS: trials begun in the
     bucket, and trials converted in it. `activeValue` (the stock of open
     trials) is deliberately not what the column or chart shows — summing it
     would count one trial once per day it stayed open, which is how the Total
     row first read several times the real value of open trials. */
  const trialActiveTotal = (trials?.expirySchedule ?? []).reduce(
    (total, point) => total + point.activeValue,
    0,
  );
  const trialConvertedTotal = (trials?.timeSeries ?? []).reduce(
    (total, point) => total + (point.convertedValue ?? 0),
    0,
  );

  const trialRows = useMemo(() => {
    if (trialView === "active") {
      /* Forward: the next days of the pipeline, earliest first. */
      return (trials?.expirySchedule ?? []).slice(0, 7).map((point) => ({
        periodStart: point.date,
        won: point.activeValue,
        lost: point.lostValue,
      }));
    }
    /* Backward: what actually converted, most recent last. */
    return (trials?.timeSeries ?? []).slice(-7).map((point) => ({
      periodStart: point.periodStart,
      won: point.convertedValue ?? 0,
      lost: point.canceledValue ?? 0,
    }));
  }, [trials, trialView]);
  /**
   * The WHOLE period, not just the visible rows — Mantle's choice, and the
   * reason its Total equals the headline above the chart. The rows below are
   * the most recent slice of that period, so the column deliberately does not
   * add up to the Total on screen; the Total answers "how much in this
   * period", which is the same question the headline answers.
   */
  const trialRowTotals = useMemo(() => {
    if (trialView === "active") {
      return (trials?.expirySchedule ?? []).reduce(
        (totals, point) => ({
          won: totals.won + point.activeValue,
          lost: totals.lost + point.lostValue,
        }),
        { won: 0, lost: 0 },
      );
    }
    return (trials?.timeSeries ?? []).reduce(
      (totals, point) => ({
        won: totals.won + (point.convertedValue ?? 0),
        lost: totals.lost + (point.canceledValue ?? 0),
      }),
      { won: 0, lost: 0 },
    );
  }, [trials, trialView]);

  /* Skips the first render: the loader already supplied the default view
     (active, all apps), so fetching it again on mount would be a wasted
     round trip that briefly blanks the table. */
  const customerFiltersTouched =
    customerStatus !== "active" || customerAppId !== "";
  useEffect(() => {
    if (!customerFiltersTouched) {
      setCustomerRows(null);
      return;
    }
    const controller = new AbortController();
    const params = new URLSearchParams({
      status: customerStatus,
      cards: "customers",
    });
    if (customerAppId) params.set("appId", customerAppId);
    void fetch(`/app/overview/top-customers?${params}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    })
      .then((response) => response.json())
      .then((body: { customers?: TopCustomer[] | null }) => {
        /* `?? []` on purpose: a filter that legitimately matches nothing must
           render the empty state, not silently fall back to the unfiltered
           loader data and look like the filter did nothing. */
        setCustomerRows(body.customers ?? []);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [customerStatus, customerAppId, customerFiltersTouched]);

  useEffect(() => {
    if (!installAppId) {
      setInstallRows(null);
      return;
    }
    const controller = new AbortController();
    const params = new URLSearchParams({
      appId: installAppId,
      cards: "installs",
    });
    void fetch(`/app/overview/top-customers?${params}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    })
      .then((response) => response.json())
      .then((body: { installs?: RecentInstall[] | null }) => {
        setInstallRows(body.installs ?? []);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [installAppId]);

  const visibleCustomers = customerRows ?? topCustomers;
  const visibleInstalls = installRows ?? recentInstalls;

  const appLogos = useMemo(
    () => new Map(appHealth.map((app) => [app.id, app.logoUrl])),
    [appHealth],
  );

  const visibleInsights = useMemo(
    () =>
      (insights as OverviewInsight[]).filter(
        (insight) => !dismissedInsights.includes(insight.id),
      ),
    [insights, dismissedInsights],
  );

  const metricGroups = useMemo(
    () =>
      buildOverviewMetricGroups({
        recurring,
        revenue,
        ltv,
        churn,
        formatMoney,
      }),
    [recurring, revenue, ltv, churn],
  );
  /* Movement is absent unless the range is snapshot-covered — the report says
     so explicitly rather than reporting zeros, so the strip is hidden rather
     than claiming nothing moved. */
  const movement = recurring?.movement?.[0] ?? null;

  return (
    <Page
      fullWidth
      title="Business overview"
      subtitle={`${orgName} · Shopify portfolio`}
      primaryAction={{
        content: "View reports",
        url: "/app/reports",
        icon: ChartLineIcon,
      }}
      secondaryActions={[
        { content: "Manage apps", url: "/app/apps", icon: AppsIcon },
      ]}
    >
      <div className="overview-workspace">
        {/* Mantle's two-column shell: the metrics and lists read down the
            main column, while reference material (reports, payouts, links)
            sits in a narrower rail that stays put. */}
        <div className="overview-shell">
        <BlockStack gap="400">

          {metricsError ? (
            <Banner
              tone="warning"
              title="Revenue metrics could not be loaded"
              action={{
                content: "Try again",
                onAction: () => {
                  setRecurring(null);
                  setRefreshKey((key) => key + 1);
                },
              }}
            >
              {metricsError}
            </Banner>
          ) : null}

          {/* Filter row, the three metric groups and the movement strip
              share ONE surface, as Mantle's do: they're a single reading —
              "here is the business over this range" — and separate cards made
              each figure look like its own unrelated widget. Groups are
              divided horizontally; tiles inside a group are not, so the eye
              runs across a row rather than stopping at every border. */}
          <Card padding="0">
            <div className="overview-filters">
              <AppPicker
                label="App"
                labelHidden
                value={appId}
                apps={appHealth}
                onChange={setAppId}
              />
              <Popover
                active={periodOpen}
                activator={
                  <Button
                    disclosure
                    onClick={() => setPeriodOpen((open) => !open)}
                  >
                    {PERIOD_LABELS[period]}
                  </Button>
                }
                autofocusTarget="first-node"
                onClose={() => setPeriodOpen(false)}
              >
                <ActionList
                  actionRole="menuitem"
                  items={ANALYTICS_PERIODS.map((value) => ({
                    content: PERIOD_LABELS[value],
                    active: period === value,
                    onAction: () => {
                      setPeriodOpen(false);
                      setPeriod(value);
                    },
                  }))}
                />
              </Popover>
            </div>

            <section className="overview-metrics">
              {metricGroups.map((group) => (
                <div key={group.key} className="overview-metrics__group">
                  <Text as="h2" variant="headingSm">
                    {group.title}
                  </Text>
                  <div className="overview-metrics__row">
                    {group.metrics.map((metric) => (
                      <MetricTile
                        key={metric.key}
                        metric={metric}
                        loading={metricsLoading}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </section>

            {movement ? <MovementStrip movement={movement} /> : null}
          </Card>

          <Card padding="0">
            <div className="overview-trials__head">
              <Text as="h2" variant="headingSm">
                Trials
              </Text>
              <ButtonGroup variant="segmented">
                <Button
                  pressed={trialView === "active"}
                  onClick={() => setTrialView("active")}
                >
                  Active
                </Button>
                <Button
                  pressed={trialView === "converted"}
                  onClick={() => setTrialView("converted")}
                >
                  Converted
                </Button>
              </ButtonGroup>
            </div>

            <div className="overview-trials">
              <div className="overview-trials__chart">
                <Text as="p" variant="bodySm" tone="subdued">
                  {trialView === "active"
                    ? "Active trials"
                    : "Converted trials"}
                </Text>
                <Text as="p" variant="headingLg">
                  {formatMoney(
                    trialView === "active" ? trialActiveTotal : trialConvertedTotal,
                  )}
                </Text>
                {trialChartPoints.length > 0 ? (
                  <div className="overview-trials__chart-canvas">
                    <Suspense fallback={null}>
                      <PolarisVizProvider
                        themes={{
                          Mantle: withChartHeight(
                            chartThemes.Mantle,
                            TRIALS_CHART_HEIGHT,
                          ),
                        }}
                        defaultTheme="Mantle"
                      >
                        {/* Axes shown here, unlike the metric sparklines: this
                            chart is the card's subject rather than a trend hint
                            beside a figure, so it gets a dated X axis and a
                            money Y axis. */}
                        <BarChart
                          data={[
                            {
                              name:
                                trialView === "active"
                                  ? "Active trials"
                                  : "Converted trials",
                              data: trialChartPoints.map((point) => ({
                                key: bucketLabel(point.periodStart),
                                value: point.value,
                              })),
                            },
                          ]}
                          showLegend={false}
                          xAxisOptions={{ allowLineWrap: false }}
                          yAxisOptions={{
                            labelFormatter: (value) =>
                              compactMoney(Number(value), "USD"),
                          }}
                          tooltipOptions={{
                            renderTooltipContent: ({ activeIndex }) => {
                              const point = trialChartPoints[activeIndex];
                              if (!point) return null;
                              return (
                                <ChartTooltip
                                  dark={isDarkTheme}
                                  title={bucketLabel(point.periodStart)}
                                  rows={[
                                    {
                                      label:
                                        trialView === "active"
                                          ? "Active trials"
                                          : "Converted trials",
                                      value: formatMoney(point.value),
                                      color: CHART_ACCENT,
                                    },
                                  ]}
                                />
                              );
                            },
                          }}
                        />
                      </PolarisVizProvider>
                    </Suspense>
                  </div>
                ) : (
                  <div className="overview-trials__chart-canvas">
                    <SkeletonBodyText lines={4} />
                  </div>
                )}
                {trials ? (
                  <Text as="p" variant="bodySm" tone="subdued">
                    {`${trials.started.toLocaleString()} started · ${trials.converted.toLocaleString()} converted · ${(trials.conversionRate * 100).toFixed(1)}% conversion`}
                  </Text>
                ) : null}
              </div>

              <div className="overview-trials__table">
                {trials ? (
                  <table className="overview-trials__grid">
                    <thead>
                      <tr>
                        <th scope="col">Date</th>
                        <th scope="col">
                          {trialView === "active" ? "Active" : "Won"}
                        </th>
                        <th scope="col">Lost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {trialRows.map((row) => (
                        <tr key={row.periodStart}>
                          <td>{bucketLabel(row.periodStart)}</td>
                          <td>{formatMoney(row.won)}</td>
                          <td className="overview-trials__lost">
                            {formatMoney(row.lost)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    {/* Pinned, so the totals stay visible while the rows above
                        scroll — Mantle keeps them anchored the same way. */}
                    <tfoot>
                      <tr>
                        <td>Total</td>
                        <td>{formatMoney(trialRowTotals.won)}</td>
                        <td className="overview-trials__lost">
                          {formatMoney(trialRowTotals.lost)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                ) : (
                  <SkeletonBodyText lines={6} />
                )}
              </div>
            </div>
          </Card>

          {/* Mantle's quick-stat row. Every figure here is one another card
              already owns, so these link to where it can be read in full
              rather than being a fifth place a number is computed. */}
          <div className="overview-pills">
            <Link className="overview-pill" to="/app/subscriptions">
              <span className="overview-pill__value">
                {trials ? trials.activeNow.toLocaleString() : "—"}
              </span>
              <span>active trials</span>
              <span aria-hidden="true" className="overview-pill__chevron">
                ›
              </span>
            </Link>
            <Link className="overview-pill" to="/app/reports?report=usage">
              <span className="overview-pill__value">
                {trials ? trials.converted.toLocaleString() : "—"}
              </span>
              <span>trials converted</span>
              <span aria-hidden="true" className="overview-pill__chevron">
                ›
              </span>
            </Link>
            <Link className="overview-pill" to="/app/reports?report=churn">
              <span className="overview-pill__value">
                {churn ? churn.subscription.netLost.toLocaleString() : "—"}
              </span>
              <span>subscriptions lost</span>
              <span aria-hidden="true" className="overview-pill__chevron">
                ›
              </span>
            </Link>
          </div>

          {visibleInsights.length > 0 ? (
            <Card padding="0">
              <div className="overview-card__head">
                <Text as="h2" variant="headingSm">
                  Insights
                </Text>
              </div>
              <div className="overview-insights">
                {visibleInsights.map((insight) => (
                  <div key={insight.id} className="overview-insight">
                    <span
                      aria-hidden="true"
                      className={`overview-insight__dot overview-insight__dot--${insight.tone}`}
                    />
                    <Text as="p">{insight.message}</Text>
                    <Button variant="plain" url={insight.actionUrl}>
                      {insight.actionLabel}
                    </Button>
                    <button
                      type="button"
                      className="overview-insight__dismiss"
                      aria-label={`Dismiss: ${insight.message}`}
                      onClick={() => dismissInsight(insight.id)}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </Card>
          ) : null}

          <RecentReviewsCard reviews={recentReviews} apps={appHealth} now={now} />

          <div className="overview-cards">
            <Card padding="0">
              <div className="overview-card__head">
                <Text as="h2" variant="headingSm">
                  Top customers
                </Text>
                <Button variant="plain" url="/app/customers">
                  View all
                </Button>
              </div>
              <div className="overview-card__filters">
                <Popover
                  active={customerStatusOpen}
                  activator={
                    <Button
                      disclosure
                      onClick={() => setCustomerStatusOpen((open) => !open)}
                    >
                      {CUSTOMER_STATUS_LABELS[customerStatus]}
                    </Button>
                  }
                  autofocusTarget="first-node"
                  onClose={() => setCustomerStatusOpen(false)}
                >
                  <ActionList
                    actionRole="menuitem"
                    items={(
                      ["active", "churned", "all"] as TopCustomerStatus[]
                    ).map((value) => ({
                      content: CUSTOMER_STATUS_LABELS[value],
                      active: customerStatus === value,
                      onAction: () => {
                        setCustomerStatusOpen(false);
                        setCustomerStatus(value);
                      },
                    }))}
                  />
                </Popover>
                <AppPicker
                  label="App"
                  labelHidden
                  value={customerAppId}
                  apps={appHealth}
                  onChange={setCustomerAppId}
                />
              </div>
              {visibleCustomers.length === 0 ? (
                <div className="overview-card__empty">
                  <Text as="p" tone="subdued">
                    {customerStatus === "churned"
                      ? "No churned customers for this selection."
                      : "No customers with billing history for this selection."}
                  </Text>
                </div>
              ) : (
              <table className="overview-card__table">
                <thead>
                  <tr>
                    <th scope="col">Customer</th>
                    <th scope="col">AMR</th>
                    <th scope="col">CLV</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleCustomers.map((customer) => (
                    <tr key={customer.shopDomain}>
                      <td>
                        <Link
                          className="overview-card__link"
                          to={`/app/customers/${encodeURIComponent(customer.shopDomain)}`}
                        >
                          {customer.name}
                        </Link>
                      </td>
                      <td>{formatMoney(customer.amr)}</td>
                      <td>{formatMoney(customer.clv)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              )}
            </Card>

            <Card padding="0">
              <div className="overview-card__head">
                <Text as="h2" variant="headingSm">
                  Recent installs
                </Text>
                <Button variant="plain" url="/app/customers">
                  View all
                </Button>
              </div>
              <div className="overview-card__filters">
                <AppPicker
                  label="App"
                  labelHidden
                  value={installAppId}
                  apps={appHealth}
                  onChange={setInstallAppId}
                />
              </div>
              {visibleInstalls.length === 0 ? (
                <div className="overview-card__empty">
                  <Text as="p" tone="subdued">
                    No installs yet for this selection.
                  </Text>
                </div>
              ) : (
              <div className="overview-card__scroll">
              <table className="overview-card__table overview-card__table--installs">
                <thead>
                  <tr>
                    <th scope="col">Customer</th>
                    <th scope="col">App</th>
                    <th scope="col">Plan</th>
                    <th scope="col">Installed</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleInstalls.map((install) => (
                    <tr key={`${install.appName}-${install.shopDomain}`}>
                      <td>
                        <Link
                          className="overview-card__link"
                          to={`/app/customers/${encodeURIComponent(install.shopDomain)}`}
                        >
                          {install.name}
                        </Link>
                      </td>
                      <td>
                        <AppName
                          appName={install.appName}
                          logoUrl={install.appLogoUrl}
                        />
                      </td>
                      <td>
                        {install.plan ?? (
                          <Text as="span" tone="subdued">
                            —
                          </Text>
                        )}
                      </td>
                      <td>{formatDateTime(install.installedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
              )}
            </Card>

            <Card padding="0">
              <div className="overview-card__head">
                <Text as="h2" variant="headingSm">
                  Recent uninstalls
                </Text>
                <Button variant="plain" url="/app/uninstalls">
                  View report
                </Button>
              </div>
              {uninstallReasons.length > 0 ? (
                <div className="overview-donut">
                  <Suspense fallback={null}>
                    <PolarisVizProvider
                      themes={{
                        Mantle: withChartHeight(chartThemes.Mantle, 210),
                      }}
                      defaultTheme="Mantle"
                    >
                      <DonutChart
                        legendPosition="left"
                        showLegend
                        data={uninstallReasons.map((reason) => ({
                          name: reasonLabel(reason.reasonCode),
                          data: [
                            { key: reason.reasonCode, value: reason.count },
                          ],
                        }))}
                      />
                    </PolarisVizProvider>
                  </Suspense>
                </div>
              ) : null}
              {uninstallReasons.length === 0 ? (
                <div className="overview-card__empty">
                  <Text as="p" tone="subdued">
                    No uninstalls in the last 30 days.
                  </Text>
                </div>
              ) : (
              <table className="overview-card__table">
                <thead>
                  <tr>
                    <th scope="col">Uninstall reason</th>
                    <th scope="col">Uninstalls</th>
                    <th scope="col">vs last period</th>
                    <th scope="col">Change</th>
                  </tr>
                </thead>
                <tbody>
                  {uninstallReasons.map((reason) => (
                    <tr key={reason.reasonCode}>
                      <td>{reasonLabel(reason.reasonCode)}</td>
                      <td>{reason.count.toLocaleString()}</td>
                      <td>{reason.previous.toLocaleString()}</td>
                      <td>
                        {reason.changePercent === null ? (
                          <Text as="span" tone="subdued">
                            —
                          </Text>
                        ) : (
                          <Text
                            as="span"
                            /* More uninstalls is bad, so a rise is critical —
                               the opposite of the revenue tiles. */
                            tone={
                              reason.changePercent > 0 ? "critical" : "success"
                            }
                          >
                            {`${reason.changePercent > 0 ? "+" : ""}${(reason.changePercent * 100).toFixed(0)}%`}
                          </Text>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              )}
            </Card>

          </div>

          <Card padding="0">
            <div className="overview-section-header">
              <div>
                <Text as="h2" variant="headingMd">
                  Recent subscription activity
                </Text>
              </div>
              <Button variant="plain" url="/app/events">
                View all activity
              </Button>
            </div>
            {recentEvents.length === 0 ? (
              <div className="overview-card__empty">
                <Text as="p" tone="subdued">
                  Subscription events appear automatically when Shopify returns
                  activity for a connected app.
                </Text>
              </div>
            ) : (
              <div className="overview-card__scroll">
                <table className="overview-card__table overview-card__table--activity">
                  <thead>
                    {/* Same vocabulary as the Activity page's Lifecycle
                        events table, so the two read as one product rather
                        than two names for the same column. Order stays as
                        asked for here; Activity leads with Event. */}
                    <tr>
                      <th scope="col">Shop</th>
                      <th scope="col">App</th>
                      <th scope="col">Charge</th>
                      <th scope="col">Event</th>
                      <th scope="col">Plan amount</th>
                      <th scope="col">Occurred</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentEvents.map((event) => {
                      const meta = EVENT_META[event.type] ?? {
                        label: event.type
                          .replace(/^SUBSCRIPTION_CHARGE_/, "")
                          .replaceAll("_", " ")
                          .toLowerCase(),
                        tone: "info" as const,
                      };
                      return (
                        <tr
                          key={`${event.appId}:${event.type}:${event.chargeId}:${event.occurredAt}`}
                        >
                          <td>
                            <Link
                              className="overview-card__link"
                              to={`/app/customers/${encodeURIComponent(event.shopDomain)}?app=${encodeURIComponent(event.appId)}`}
                            >
                              {event.shopDomain.replace(".myshopify.com", "")}
                            </Link>
                          </td>
                          <td>
                            <AppName
                              appName={event.appName}
                              logoUrl={appLogos.get(event.appId) ?? null}
                            />
                          </td>
                          <td>{event.chargeName}</td>
                          <td>
                            <Badge tone={meta.tone}>{meta.label}</Badge>
                          </td>
                          <td>
                            {formatMoney(
                              Number(event.amount),
                              event.currencyCode,
                            )}
                          </td>
                          <td>{formatDateTime(event.occurredAt)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </BlockStack>

        <aside className="overview-rail">
          <Card padding="0">
            <div className="overview-rail__head">
              <Text as="h2" variant="headingSm">
                Custom reports
              </Text>
            </div>
            <div className="overview-rail__body">
              <TextField
                label="Search reports"
                labelHidden
                placeholder="Search"
                value={reportQuery}
                onChange={setReportQuery}
                autoComplete="off"
                prefix={<SearchIcon />}
              />
              <div className="overview-rail__links">
                {visibleReports.map((report) => (
                  <Link
                    key={report.key}
                    className="overview-rail__link"
                    to={`/app/reports?report=${report.key}`}
                  >
                    <span>{report.label}</span>
                    <span aria-hidden="true">›</span>
                  </Link>
                ))}
                {visibleReports.length === 0 ? (
                  <Text as="p" variant="bodySm" tone="subdued">
                    {`No report matches “${reportQuery}”.`}
                  </Text>
                ) : null}
              </div>
            </div>
          </Card>

          <Card padding="0">
            <div className="overview-rail__head">
              <Text as="h2" variant="headingSm">
                Quick links
              </Text>
            </div>
            <div className="overview-rail__links overview-rail__body">
              {QUICK_LINKS.map((link) => (
                <Link
                  key={link.url}
                  className="overview-rail__link"
                  to={link.url}
                >
                  <span>{link.label}</span>
                  <span aria-hidden="true">›</span>
                </Link>
              ))}
            </div>
          </Card>
        </aside>
        </div>
      </div>
    </Page>
  );
}
