import {
  ActionList,
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  Checkbox,
  ChoiceList,
  DataTable,
  EmptyState,
  InlineGrid,
  InlineStack,
  Page,
  Pagination,
  Popover,
  Select,
  SkeletonBodyText,
  SkeletonDisplayText,
  Spinner,
  Text,
  TextField,
  Tooltip,
} from "@shopify/polaris";
import {
  compactMoney,
  useBarChartTheme,
  useChartTheme,
  useRevenueChartTheme,
} from "~/lib/chart-theme";
import { createPortal } from "react-dom";
import "@shopify/polaris-viz/build/esm/styles.css";
import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Link, useNavigate, useNavigation, useSearchParams } from "react-router";
import type { Route } from "./+types/reports";
import type {
  TrialExpiryPoint,
  TrialHistoryRow,
} from "~/lib/shopify/partner-mrr.server";
import type { TrialSummary } from "~/lib/reports/analytics.server";

/** What /api/metrics/trials returns: the range's history, the forward expiry
 * pipeline, and the row-level trials behind the history table. */
type TrialsPayload = TrialSummary & {
  expirySchedule: TrialExpiryPoint[];
  /** ONE page of trials, already filtered server-side — see the fetch effect
   * in `UsagePanel` for why searching in the browser was wrong. */
  history: TrialHistoryRow[];
  historyPage: number;
  historyPageCount: number;
  /** Totals over every matching trial in the period, not over this page. */
  historyMatched: number;
  historyActive: number;
  historyValue: number;
};
import { AppName } from "~/components/app-identity";
import {
  REPORT_META,
  REPORTS,
  type ReportName as CatalogReportName,
} from "~/lib/reports/report-catalog";
import { requireCurrentOrganization } from "~/lib/current-org.server";
import { AppPicker } from "~/components/app-picker";
import { RevenueChartArea } from "~/components/revenue-chart-area";
import {
  COMMITTED_MRR,
  composeMrr,
  mrrComponentBreakdown,
  type RevenueComponents as SharedRevenueComponents,
} from "~/lib/reports/mrr-components";
import { prisma } from "~/lib/db.server";
import { env } from "~/lib/env.server";
import { listSavedViews } from "~/lib/saved-views/saved-views.server";
import { formatDate, formatDateTime, formatMoney } from "~/lib/format";
import { PAGE_CONTENT_ANCHOR_ID } from "~/lib/page-content-anchor";
import { EMPTY_STATE_IMAGE } from "~/lib/ui";
import type {
  AnalyticsInterval,
  AnalyticsReports,
  ChurnReport,
  LtvReport,
  PortfolioReport,
  RevenueReport,
} from "~/lib/reports/analytics.server";
import type {
  MrrMovementSummary,
  MrrMovementBucket,
  MrrMovementCategory,
} from "~/lib/reports/mrr-movement.shared";
import { MRR_MOVEMENT_ROWS } from "~/lib/reports/mrr-movement.shared";
import {
  autoInterval,
  resolveAnalyticsRange,
} from "~/lib/reports/analytics.server";
import {
  ANALYTICS_INTERVALS,
  ANALYTICS_PERIODS,
  type AnalyticsPeriod,
} from "~/lib/reports/analytics.shared";
import type { DimensionFilters } from "~/lib/reports/traffic-sources.server";
import {
  findTrafficAllTimeStart,
  getTrafficInsights,
  getTrafficSourcesReportForApps,
  type TrafficAppScope,
} from "~/lib/reports/traffic-sources.server";
import {
  DEFAULT_FUNNEL_EVENTS,
  DEFAULT_PIVOT_DIMENSIONS,
  FUNNEL_EVENTS,
  type FunnelEventKey,
  PIVOT_DIMENSIONS,
  type PivotDimensionKey,
} from "~/lib/reports/traffic-sources.shared";
import { shortDate } from "~/lib/date-range";
import {
  type CompareMode,
  isUtcMidnight,
  parseIsoDateUtc,
  TRAFFIC_PAGE_SIZE,
  TrafficSourcesPanel,
} from "./reports.traffic";
import {
  INSIGHT_EVENT_PARAM,
  INSIGHT_METRIC_PARAM,
  parseInsightEvent,
  parseInsightMetric,
  TrafficInsightsPanel,
} from "./reports.insights";

type ReportName = CatalogReportName;
const PRODUCT_USAGE_ENABLED = false;

/** Mantle's own explanations, kept close to its wording so the two products
 * describe the same metric the same way. */
const TRIAL_INFO = {
  conversion: {
    intro:
      "An overview of how many new customers are converting from trial to paid.",
    points: [
      "Converted: the total value of subscriptions that have converted from trial to paid.",
      "Canceled: the total value of subscriptions that have canceled their trial.",
      "Conversion rate: the percentage of new customers that have converted from trial to paid.",
    ],
  },
  active: {
    intro:
      "An overview of new customers who are currently in their trial period.",
    points: [
      "Active: the total value of active subscriptions that are currently on trial.",
      "Canceled: the total value of trials that have been canceled.",
      "Retention rate: the percentage of new customers that are still in their trial period.",
    ],
  },
  history: {
    intro:
      "Trials that started in the selected period, with the plan each is on and how it ended.",
    points: [
      "On trial: the trial is running and has not been canceled or converted.",
      "Churned during trial: the trial was canceled before it ended.",
      "Paying: the trial converted to a paid subscription.",
    ],
  },
} as const;

/** The ⓘ beside a heading: a short intro, then the terms it uses. */
function InfoTip({
  content,
}: {
  content: { intro: string; points: readonly string[] };
}) {
  return (
    <Tooltip
      content={
        <div className="reports-infotip">
          <p>{content.intro}</p>
          <ul>
            {content.points.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
        </div>
      }
    >
      <span className="reports-infotip-trigger" aria-label="About this metric">
        ⓘ
      </span>
    </Tooltip>
  );
}

/** The trial charts' stats follow the value/count toggle above them, so a
 * count is never rendered with a currency symbol in front of it. */
function formatTrialAmount(value: number, asValue: boolean): string {
  return asValue ? formatMoney(value) : Math.round(value).toLocaleString();
}

const TRIAL_STATUS_LABELS: Record<"all" | TrialHistoryRow["status"], string> = {
  all: "All statuses",
  on_trial: "On trial",
  paying: "Paying",
  churned_during_trial: "Churned during trial",
};

const TRIAL_STATUS_META: Record<
  TrialHistoryRow["status"],
  { label: string; tone: "info" | "success" | "warning" }
> = {
  on_trial: { label: "On trial", tone: "info" },
  paying: { label: "Paying", tone: "success" },
  churned_during_trial: { label: "Churned during trial", tone: "warning" },
};
const MANUAL_SYNC_MAX_ATTEMPTS = 3;

function retryAfterMilliseconds(value: string | null, fallbackSeconds: number) {
  if (!value) return fallbackSeconds * 1_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(1, seconds) * 1_000;
  const retryAt = Date.parse(value);
  return Number.isNaN(retryAt)
    ? fallbackSeconds * 1_000
    : Math.max(1_000, retryAt - Date.now());
}

export const PolarisVizProvider = lazy(async () => ({
  default: (await import("@shopify/polaris-viz")).PolarisVizProvider,
}));
export const BarChart = lazy(async () => ({
  default: (await import("@shopify/polaris-viz")).BarChart,
}));
export const LineChart = lazy(async () => ({
  default: (await import("@shopify/polaris-viz")).LineChart,
}));
export const ComboChart = lazy(async () => ({
  default: (await import("@shopify/polaris-viz")).ComboChart,
}));

export const PERIOD_LABELS: Record<AnalyticsPeriod, string> = {
  last_30_days: "Last 30 days",
  last_90_days: "Last 90 days",
  last_12_months: "Last 12 months",
  year_to_date: "Year to date",
  all_time: "All time",
};

export const INTERVAL_LABELS: Record<AnalyticsInterval, string> = {
  day: "Daily",
  week: "Weekly",
  month: "Monthly",
};

// Reports are computed live on every request, not from a precomputed table —
// wider periods walk more history and cost more. Surfaced as help text next
// to the Period picker so the cost is visible before the user clicks Apply,
// rather than as a silent wait. `last_30_days` (the default) needs no note.
const PERIOD_HELP_TEXT: Partial<Record<AnalyticsPeriod, string>> = {
  last_90_days: "May take a few seconds longer to load than Last 30 days.",
  last_12_months:
    "Wider ranges recompute more history — this may take noticeably longer to load.",
  year_to_date:
    "Wider ranges recompute more history — this may take noticeably longer to load.",
  all_time:
    "Scans your full account history — this can take significantly longer to load.",
};

/**
 * Card titles and descriptions, taken verbatim from Mantle's own Reports index
 * so a reader moving between the two finds the same report under the same name.
 *
 * There was an `overview` card here too, ours rather than Mantle's. It was
 * removed once `growth` grew the MRR-changes decomposition: the two showed the
 * same MRR/ARR/growth figures off the same series, and two cards claiming the
 * same numbers is how a reader learns to distrust both.
 */

/**
 * The index's sections, using Mantle's own section names.
 *
 * Reports are reached from a card grid rather than a tab strip: eight tabs put
 * every report one click away but gave none of them room to say what it is, and
 * the strip only grows. `?report=` still selects one, so the fetch and
 * freshness machinery below is untouched — absent, this page is the index.
 */
const REPORT_GROUPS = [
  {
    id: "acquisition",
    title: "Acquisition and growth",
    reports: ["traffic", "insights", "usage"],
  },
  {
    id: "revenue",
    title: "Revenue and billing",
    reports: ["growth", "revenue", "ltv"],
  },
  {
    id: "retention",
    title: "Retention and feedback",
    reports: ["churn", "retention"],
  },
] as const satisfies ReadonlyArray<{
  id: string;
  title: string;
  reports: readonly ReportName[];
}>;

/* Fails to compile when a report is added to `REPORTS` but to no group here.
   Without it, a new report builds cleanly and is simply missing from the
   index — reachable only by typing `?report=` by hand, which is exactly how
   Traffic source insights first shipped. */
type GroupedReport = (typeof REPORT_GROUPS)[number]["reports"][number];
const EVERY_REPORT_IS_GROUPED: Record<
  Exclude<ReportName, GroupedReport>,
  never
> = {};
void EVERY_REPORT_IS_GROUPED;

type RevenueComponents = SharedRevenueComponents;

type PartnerFreshnessView = {
  requestedAt: string;
  freshThrough: string | null;
  lagMs: number | null;
  exact: boolean;
  fresh: boolean;
  historyComplete: boolean;
  appsReady: number;
  appsTotal: number;
};

type MetricsSyncResponse = {
  error?: string;
  fresh?: boolean;
  freshness?: PartnerFreshnessView;
  errors?: string[];
  inProgress?: boolean;
};

function reportUrl(
  report: ReportName,
  period: AnalyticsPeriod,
  appId: string,
  interval: AnalyticsInterval,
): string {
  const params = new URLSearchParams({ report, period, interval });
  if (appId) params.set("appId", appId);
  return `/app/reports?${params.toString()}`;
}

function filterRecurringRevenue(
  data: PortfolioReport,
  components: RevenueComponents,
): PortfolioReport {
  const rawPoints = data.recurring.timeSeries;
  const timeSeries = rawPoints.map((point) => {
    const mrr = composeMrr(point, components);
    return { ...point, mrr, arr: mrr * 12 };
  });
  const currencies = data.recurring.currencies.map((currency) => {
    const points = timeSeries.filter(
      (point) => point.currency === currency.currency,
    );
    const currentMrr = composeMrr(currency, components);
    /* Composed by the same function, so growth is a like-for-like difference.
       It used to read `points[0].mrr` — a figure built under the old
       last-point-only trial rule — and subtract it from a trial-inclusive
       current one, overstating net growth by the whole current trial MRR. */
    const startingMrr = points[0]?.mrr ?? currentMrr;
    const netMrrGrowth = currentMrr - startingMrr;
    return {
      ...currency,
      mrr: currentMrr,
      arr: currentMrr * 12,
      startingMrr,
      netMrrGrowth,
      growthRate: startingMrr > 0 ? netMrrGrowth / startingMrr : 0,
    };
  });
  return {
    ...data,
    /* `movement` passes through untouched. The revenue-component toggles
       (annual/usage/trials) reshape a STOCK by including or excluding parts of
       today's MRR; the movement ledger is a flow already booked at the first
       paid charge, so there is nothing in it for those toggles to select. */
    recurring: {
      currencies,
      timeSeries,
      movement: data.recurring.movement,
      planSeries: data.recurring.planSeries,
    },
    forecast: currencies.map((currency) => ({
      currency: currency.currency,
      monthlyRunRate: currency.mrr,
      annualRunRate: currency.arr,
    })),
  };
}

export function percent(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "percent",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(value);
}

/** Shared tooltip body for the trial charts, matching the other reports. */
function ChartTooltipCard({
  title,
  rows,
  floating,
}: {
  title: string;
  rows: Array<{ label: string; value: string; color: string }>;
  /** Viewport coordinates of the cursor, when this renders in a body portal. */
  floating?: { x: number; y: number };
}) {
  return (
    <div
      className={
        floating
          ? "reports-chart-tooltip reports-chart-tooltip--floating"
          : "reports-chart-tooltip"
      }
      style={
        floating
          ? {
              /* Clamped so the card can't run off the right or bottom edge;
                 the width/height below match the CSS. */
              left: Math.min(floating.x + 16, window.innerWidth - 290),
              top: Math.min(floating.y + 16, window.innerHeight - 170),
            }
          : undefined
      }
    >
      <div className="reports-chart-tooltip__title">{title}</div>
      {rows.map((row) => (
        <div key={row.label} className="reports-chart-tooltip__row">
          <span
            aria-hidden="true"
            className="reports-chart-tooltip__dot"
            style={{ background: row.color }}
          />
          <span>{row.label}</span>
          <strong>{row.value}</strong>
        </div>
      ))}
    </div>
  );
}

/**
 * One of Mantle's trial charts: a headline rate, two money stats, and a combo
 * plot of value bars against that rate.
 */
function TrialComboCard({
  title,
  rate,
  stats,
  wonLabel,
  lostLabel,
  rateLabel,
  points,
  valueMode,
  info,
}: {
  title: string;
  rate: number;
  stats: Array<{ label: string; value: string }>;
  wonLabel: string;
  lostLabel: string;
  rateLabel: string;
  points: Array<{ key: string; won: number; lost: number }>;
  /** Whether the bars carry money or a count — decides the left axis format. */
  valueMode: boolean;
  info: { intro: string; points: readonly string[] };
}) {
  const canvasRef = useRef<HTMLDivElement>(null);
  /* Pixel bounds of the plot, cached per hover pass. Re-read on enter rather
     than per move: they can't change mid-hover, and 30 getBoundingClientRect
     calls per mousemove is layout thrash. */
  const bandRef = useRef<{ left: number; width: number; count: number } | null>(
    null,
  );
  const [hover, setHover] = useState<{
    index: number;
    x: number;
    y: number;
  } | null>(null);

  /* Measured from polaris-viz's own hover targets: each band renders a
     <g data-type="BarGroup" data-index> around a full-height transparent rect,
     so first and last give the plot's extent exactly — no re-deriving their
     scale math, which is what went wrong when the tooltip was positioned from
     the values polaris-viz computes. */
  const measureBands = () => {
    const groups = canvasRef.current?.querySelectorAll<SVGGElement>(
      '[data-type="BarGroup"][aria-hidden="false"]',
    );
    if (!groups || groups.length === 0) return (bandRef.current = null);
    const first = groups[0].getBoundingClientRect();
    const last = groups[groups.length - 1].getBoundingClientRect();
    return (bandRef.current = {
      left: first.left,
      width: (last.right - first.left) / groups.length,
      count: groups.length,
    });
  };

  const hoveredPoint = hover ? (points[hover.index] ?? null) : null;

  const chart = useMemo(
    () => (
      <ComboChart
        /* Renders nothing: the tooltip is ours (below), because ComboChart
               neither portals nor positions its own correctly. This keeps the
               crosshair and bar highlight, which are right. */
        renderTooltipContent={() => null}
        showLegend
        data={[
          {
            shape: "Bar",
            series: [
              {
                name: wonLabel,
                data: points.map((point) => ({
                  key: point.key,
                  value: point.won,
                })),
                color: "#9668ff",
              },
              {
                name: lostLabel,
                data: points.map((point) => ({
                  key: point.key,
                  value: point.lost,
                })),
                color: "#c9cccf",
              },
            ],
            yAxisOptions: {
              labelFormatter: (value) =>
                valueMode
                  ? compactMoney(Number(value), "USD")
                  : Number(value).toLocaleString(),
            },
          },
          {
            shape: "Line",
            series: [
              {
                name: rateLabel,
                data: points.map((point) => ({
                  key: point.key,
                  /* Per-bucket rate, so the line reads against its own axis
                         rather than being a flat restatement of the headline. */
                  value:
                    point.won + point.lost === 0
                      ? 0
                      : (point.won / (point.won + point.lost)) * 100,
                })),
                color: "#ff9d3b",
              },
            ],
            yAxisOptions: {
              labelFormatter: (value) => `${Number(value).toFixed(0)}%`,
            },
          },
        ]}
      />
    ),
    [points, valueMode, wonLabel, lostLabel, rateLabel],
  );

  return (
    <section className="reports-chart-card">
      <div className="reports-chart-header">
        <div>
          <div className="reports-chart-label">
            {title}
            <InfoTip content={info} />
          </div>
          <div className="reports-chart-value">{percent(rate)}</div>
        </div>
        <div className="reports-trial-stats">
          {stats.map((stat) => (
            <div key={stat.label}>
              <span>{stat.label}</span>
              <strong>{stat.value}</strong>
            </div>
          ))}
        </div>
      </div>
      <div
        className="reports-chart-canvas"
        aria-label={title}
        ref={canvasRef}
        onMouseEnter={measureBands}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(event) => {
          const band = bandRef.current ?? measureBands();
          if (!band || band.width <= 0) return;
          const index = Math.floor((event.clientX - band.left) / band.width);
          if (index < 0 || index >= band.count || !points[index]) {
            setHover(null);
            return;
          }
          setHover({ index, x: event.clientX, y: event.clientY });
        }}
      >
        {chart}
      </div>
      {hover && hoveredPoint && typeof document !== "undefined"
        ? createPortal(
            <ChartTooltipCard
              floating={{ x: hover.x, y: hover.y }}
              title={hoveredPoint.key}
              rows={[
                {
                  label: wonLabel,
                  value: formatTrialAmount(hoveredPoint.won, valueMode),
                  color: "#9668ff",
                },
                {
                  label: lostLabel,
                  value: formatTrialAmount(hoveredPoint.lost, valueMode),
                  color: "#c9cccf",
                },
                {
                  label: rateLabel,
                  value: percent(
                    hoveredPoint.won + hoveredPoint.lost === 0
                      ? 0
                      : hoveredPoint.won /
                          (hoveredPoint.won + hoveredPoint.lost),
                  ),
                  color: "#ff9d3b",
                },
              ]}
            />,
            document.body,
          )
        : null}
    </section>
  );
}

export function MetricCard({
  label,
  value,
  detail,
  color,
}: {
  label: string;
  value: string;
  detail?: string;
  /** A dot beside the value, matching this metric's line color in a nearby chart. */
  color?: string;
}) {
  return (
    <div className="reports-metric-card">
      <BlockStack gap="150">
        <div className="reports-metric-label">{label}</div>
        <div className="reports-metric-value">
          {color ? (
            <span
              className="reports-metric-dot"
              aria-hidden="true"
              style={{ background: color }}
            />
          ) : null}
          {value}
        </div>
        {detail ? <div className="reports-metric-detail">{detail}</div> : null}
      </BlockStack>
    </div>
  );
}

type TableCell = string | number | ReactNode;

function ChunkedDataTable({
  columnContentTypes,
  headings,
  rows,
  chunkSize = 20,
}: {
  columnContentTypes: Array<"text" | "numeric">;
  headings: ReactNode[];
  rows: TableCell[][];
  chunkSize?: number;
}) {
  const [visibleRows, setVisibleRows] = useState(chunkSize);

  useEffect(() => setVisibleRows(chunkSize), [chunkSize, rows.length]);

  const shown = Math.min(visibleRows, rows.length);
  return (
    <DataTable
      columnContentTypes={columnContentTypes}
      headings={headings}
      rows={rows.slice(0, shown)}
      increasedTableDensity
      stickyHeader
      pagination={
        rows.length > chunkSize
          ? {
              hasPrevious: shown > chunkSize,
              hasNext: shown < rows.length,
              onPrevious: () =>
                setVisibleRows((current) =>
                  Math.max(chunkSize, current - chunkSize),
                ),
              onNext: () =>
                setVisibleRows((current) =>
                  Math.min(rows.length, current + chunkSize),
                ),
              label: `Showing 1–${shown} of ${rows.length}`,
            }
          : undefined
      }
    />
  );
}

export function chartPeriodLabel(
  periodStart: string,
  interval: AnalyticsInterval,
): string {
  const date = new Date(periodStart);
  if (interval === "day") {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }).format(date);
  }
  if (interval === "week") {
    return `Week of ${new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }).format(date)}`;
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

/** Exported so the per-app dashboard renders the SAME tooltip as the reports
 * it summarises — two chart tooltips that format money differently is the kind
 * of detail that makes one of them look wrong. */
export function MantleChartTooltip({
  title,
  delta,
  currency,
  rows,
  provisional,
  valueFormatter,
}: {
  title: string;
  delta: number;
  currency: string;
  rows: Array<{
    label: string;
    value: number;
    color: string;
    total?: boolean;
  }>;
  provisional?: boolean;
  /**
   * Overrides the default money formatting for BOTH the rows and the header
   * delta. Needed because this tooltip is now reused by a percentage chart
   * (MRR growth rate), where rendering 6.01 as "$6.01" is simply wrong.
   */
  valueFormatter?: (value: number) => string;
}) {
  const format =
    valueFormatter ?? ((value: number) => formatMoney(value, currency));
  const { isDark } = useChartTheme();
  const direction = delta > 0 ? "↑" : delta < 0 ? "↓" : "—";
  // Success/critical shades are lightened for dark surfaces and deepened for
  // light ones, so the delta keeps its contrast either way.
  const deltaColor =
    delta > 0
      ? isDark
        ? "#33e38c"
        : "#0c8f52"
      : delta < 0
        ? isDark
          ? "#ff7070"
          : "#c9342b"
        : isDark
          ? "#b5b5b5"
          : "#6d7175";

  return (
    <div
      style={{
        minWidth: 300,
        padding: "14px 16px",
        color: isDark ? "#f7f7f7" : "#202223",
        background: isDark ? "#090909" : "#ffffff",
        border: `1px solid ${isDark ? "#333" : "#e1e2e3"}`,
        borderRadius: 10,
        boxShadow: isDark
          ? "0 10px 28px rgba(0, 0, 0, 0.45)"
          : "0 10px 28px rgba(20, 16, 27, 0.16)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: 24,
          marginBottom: 12,
          fontWeight: 700,
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {title}
          {provisional ? <Badge tone="attention">Provisional</Badge> : null}
        </span>
        <span style={{ color: deltaColor, whiteSpace: "nowrap" }}>
          {direction} {format(Math.abs(delta))}
        </span>
      </div>
      <div style={{ display: "grid", gap: 7 }}>
        {rows.map((row) => (
          <div
            key={row.label}
            style={{
              display: "grid",
              gridTemplateColumns: "14px minmax(0, 1fr) auto",
              alignItems: "center",
              gap: 8,
              paddingTop: row.total ? 9 : 0,
              marginTop: row.total ? 3 : 0,
              borderTop: row.total
                ? `1px solid ${isDark ? "#333" : "#e1e2e3"}`
                : undefined,
              fontWeight: row.total ? 700 : 400,
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 10,
                height: 10,
                borderRadius: "50%",
                background: row.color,
              }}
            />
            <span>{row.label}</span>
            <span style={{ fontVariantNumeric: "tabular-nums" }}>
              {format(row.value)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export interface ChartLegendItem {
  label: string;
  color: string;
  /** Renders the dashed key used for a fitted line rather than a color dot. */
  dashed?: true;
  shape?: "line" | "area";
}

/**
 * Clickable chart legend: a click hides that series, another shows it again,
 * matching Mantle's own legend behaviour.
 *
 * Hiding is a VIEW filter and deliberately separate from the "Revenue sources"
 * control, which changes what MRR *means* (whether annual and usage count
 * toward it) and therefore changes the headline figure. This only changes what
 * is drawn, so it lives in component state and resets on reload.
 *
 * The last visible series cannot be hidden — polaris-viz has no meaningful
 * render for an empty series list, and a blank chart with a full legend reads
 * as a bug rather than as a filter.
 */
export function ChartLegend({
  items,
  hidden,
  onToggle,
}: {
  items: ChartLegendItem[];
  hidden: ReadonlySet<string>;
  onToggle: (label: string) => void;
}) {
  const visibleCount = items.filter((item) => !hidden.has(item.label)).length;

  return (
    <div className="reports-chart-legend" aria-label="Chart legend">
      {items.map((item) => {
        const isHidden = hidden.has(item.label);
        const isLastVisible = !isHidden && visibleCount === 1;
        return (
          <button
            key={item.label}
            type="button"
            className={
              isHidden
                ? "reports-chart-legend-item reports-chart-legend-item--hidden"
                : "reports-chart-legend-item"
            }
            aria-pressed={!isHidden}
            disabled={isLastVisible}
            onClick={() => onToggle(item.label)}
          >
            <i
              className={item.dashed ? "reports-chart-legend-dash" :
                item.shape ? `reports-chart-legend-${item.shape}` : undefined}
              style={item.dashed ? undefined : { background: item.color }}
              aria-hidden="true"
            />
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Least-squares fit over a series, evaluated at each point — Mantle's dashed
 * ARR trend line.
 *
 * Fitted, not smoothed: a moving average would still trace every wobble in the
 * data, where the point of this line is to show the underlying slope. Returns
 * the input unchanged when there is nothing to fit.
 */
function linearTrend(values: number[]): number[] {
  const n = values.length;
  if (n < 2) return values;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < n; i += 1) {
    sumX += i;
    sumY += values[i]!;
    sumXY += i * values[i]!;
    sumXX += i * i;
  }
  const denominator = n * sumXX - sumX * sumX;
  if (denominator === 0) return values;
  const slope = (n * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / n;
  return values.map((_, i) => slope * i + intercept);
}

function sampleSeries<T>(items: T[], maximum = 60): T[] {
  if (items.length <= maximum) return items;
  const stride = Math.ceil(items.length / maximum);
  const sampled = items.filter((_, index) => index % stride === 0);
  const last = items.at(-1);
  if (last && sampled.at(-1) !== last) sampled.push(last);
  return sampled;
}

function RevenueChartLabel({ children, description }: {
  children: ReactNode;
  description: string;
}) {
  return (
    <div className="reports-chart-label">
      {children}
      <Tooltip content={description}>
        <button type="button" className="reports-chart-help" aria-label={description}>
          <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true">
            <circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M10 9v5" stroke="currentColor" strokeWidth="1.5" />
            <circle cx="10" cy="6" r="1" fill="currentColor" />
          </svg>
        </button>
      </Tooltip>
    </div>
  );
}

function RecurringRevenueCharts({
  data,
  interval,
  sampled,
  components,
  neverBilledUrl,
}: {
  data: PortfolioReport["recurring"];
  interval: AnalyticsInterval;
  sampled: boolean;
  components: RevenueComponents;
  /** Scoped to the report's current app, so the audit page opens on it. */
  neverBilledUrl: string;
}) {
  const points0 = data.timeSeries.filter(
    (point) => point.currency === data.currencies[0]?.currency,
  );
  /* Sized from the bar count so ~58 monthly bars do not render as hairlines —
     see `useBarChartTheme`. Sampling is applied first so the count matches what
     is actually drawn. */
  const { themes: chartThemes, isDark } = useRevenueChartTheme(
    Math.min(points0.length, 60),
  );
  /* Per-chart, because the two legends are independent: hiding "Annual" on the
     MRR breakdown says nothing about whether ARR's trend line is wanted. */
  const [hiddenMrr, setHiddenMrr] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [hiddenArr, setHiddenArr] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const toggle = (
    setHidden: (next: ReadonlySet<string>) => void,
    current: ReadonlySet<string>,
  ) => (label: string) => {
    const next = new Set(current);
    if (next.has(label)) next.delete(label);
    else next.add(label);
    setHidden(next);
  };
  const currency = data.currencies[0];
  const points = useMemo(
    () =>
      sampleSeries(
        data.timeSeries.filter(
          (point) => point.currency === currency?.currency,
        ),
      ),
    [currency?.currency, data.timeSeries],
  );
  if (!currency || points.length === 0) return null;
  if (points.length === 1 && points[0].provisional) {
    return (
      <Card>
        <BlockStack gap="150">
          <InlineStack align="space-between" blockAlign="center">
            <Text as="p" variant="headingSm">
              Historical chart not loaded
            </Text>
            <Badge tone="info">Current value ready</Badge>
          </InlineStack>
          <Text as="p" variant="bodySm" tone="subdued">
            Exact {INTERVAL_LABELS[interval].toLowerCase()} history is optional
            because Shopify must page through every transaction in the selected
            period. Choose one app and load history only when needed.
          </Text>
        </BlockStack>
      </Card>
    );
  }

  const start = formatDate(points[0].periodStart);
  const end = formatDate(points.at(-1)!.periodEnd);
  const mrrSeries = [
    {
      name: "Monthly subscriptions",
      data: points.map((point) => ({
        key: chartPeriodLabel(point.periodStart, interval),
        value: point.monthlySubscriptions ?? point.mrr,
      })),
      color: "#9668ff",
    },
    ...(components.annual
      ? [
          {
            name: "Annual subscriptions",
            data: points.map((point) => ({
              key: chartPeriodLabel(point.periodStart, interval),
              value: point.annualSubscriptions ?? 0,
            })),
            color: "#4aa3ff",
          },
        ]
      : []),
    ...(components.usage
      ? [
          {
            name: "Usage charges",
            data: points.map((point) => ({
              key: chartPeriodLabel(point.periodStart, interval),
              value: point.usageCharges ?? 0,
            })),
            color: "#e44ad7",
          },
        ]
      : []),
    ...(components.trials
      ? [
          {
            /* Every bar, not just the last. This is the run rate of whoever
               was mid-trial on that day — the daily snapshot rows have
               carried it per day all along, and drawing it only on the
               newest bar made that bar jump relative to its own history.
               (An earlier version here drew it on the last bar only, on the
               theory that trials are a point-in-time figure. So are
               `monthlySubscriptions` and `annualSubscriptions`, which are
               drawn on every bar — so that was inconsistent, not safer.) */
            name: "Trial MRR",
            data: points.map((point) => ({
              // `chartPeriodLabel`, matching every sibling series and the
              // Trend line: polaris-viz aligns series BY KEY, so a series
              // keyed differently renders off-axis.
              key: chartPeriodLabel(point.periodStart, interval),
              value: point.trialSubscriptions ?? 0,
            })),
            color: "#ffb84d",
          },
        ]
      : []),
  ];
  // ARR is an absolute revenue value: keep its area and axis anchored at zero.
  const arrValues = points.map((point) => point.arr);
  const arrSeries = [
    {
      name: "ARR",
      data: points.map((point) => ({
        key: chartPeriodLabel(point.periodStart, interval),
        value: point.arr,
      })),
      color: "#9364ff",
      styleOverride: {
        line: {
          hasArea: false,
          width: 1.5,
        },
      },
    },
    {
      name: "Trend",
      // Keys must match the ARR series exactly — polaris-viz aligns series by
      // key, so a different format here silently draws the trend off-axis.
      data: linearTrend(points.map((point) => point.arr)).map((value, index) => ({
        key: chartPeriodLabel(points[index]!.periodStart, interval),
        // A negative fitted value is not negative recurring revenue.
        value: value < 0 ? null : value,
      })),
      color: isDark ? "#8a8a8a" : "#6d7175",
      styleOverride: {
        line: {
          hasArea: false,
          width: 1,
          // Mantle draws its trend as a thin dashed line, deliberately not in
          // the series color: it is a fitted line, not measured data.
          strokeDasharray: "6 4",
        },
      },
    },
  ];
  /* Filtered rather than dimmed: polaris-viz has no per-series hide, so a
     hidden series is one we simply do not hand it. Explicit `color` on every
     series means dropping one never shifts another's color. */
  const visibleMrrSeries = mrrSeries.filter(
    (series) => !hiddenMrr.has(series.name),
  );
  const visibleArrSeries = arrSeries.filter(
    (series) => !hiddenArr.has(series.name),
  );

  const moneyFormatter = (value: string | number | null) =>
    compactMoney(Number(value ?? 0), currency.currency);
  /* Rows come from the shared breakdown, which returns exactly the addends
     `composeMrr` sums — so the tooltip cannot disagree with the "Total" row
     beneath it, which is what happened while the trial rule was duplicated. */
  const ROW_COLORS: Record<string, string> = {
    "Monthly subscriptions": "#9668ff",
    "Annual subscriptions": "#4aa3ff",
    "Usage charges": "#e44ad7",
    "Trial MRR": "#ffb84d",
  };
  const arrMoneyFormatter = moneyFormatter;
  const componentRows = (
    point: (typeof points)[number],
    annualized = false,
  ) =>
    mrrComponentBreakdown(point, components, annualized ? 12 : 1).map((row) => ({
      ...row,
      color: ROW_COLORS[row.label] ?? "#9668ff",
    }));
  const previousValue = (index: number, field: "mrr" | "arr"): number => {
    if (index > 0) return points[index - 1][field];
    return field === "mrr" ? currency.startingMrr : currency.startingMrr * 12;
  };

  return (
    <Suspense
      fallback={
        <Card>
          <InlineStack gap="200" blockAlign="center">
            <Spinner accessibilityLabel="Loading report charts" size="small" />
            <Text as="p" tone="subdued">
              Loading interactive charts…
            </Text>
          </InlineStack>
        </Card>
      }
    >
      <PolarisVizProvider
        themes={chartThemes}
        defaultTheme="Mantle"
      >
        <BlockStack gap="300">
          <InlineStack align="space-between" blockAlign="center">
            <Text as="h2" variant="headingLg">
              Recurring revenue
            </Text>
            <InlineStack gap="200" blockAlign="center">
              {/* Only the SAMPLED state keeps a badge. "Live Shopify data" said
                  nothing the card's own freshness badge above does not already
                  say, but a sampled trend is a real caveat about the numbers
                  below it and must not disappear with the redundant half. */}
              {sampled ? <Badge tone="attention">Sampled Shopify trend</Badge> : null}
              {/* Here rather than in the page header: it explains an MRR
                  adjustment — active charges that have never billed, which
                  `contributionAt` values at $0 — so it belongs beside the
                  number it explains, not next to "Refresh data" on reports it
                  has nothing to do with. */}
              <Button url={neverBilledUrl}>Never billed charges</Button>
            </InlineStack>
          </InlineStack>
          <InlineGrid columns={{ xs: 1, lg: 2 }} gap="300">
            <section className="reports-chart-card reports-chart-card--recurring">
              <div className="reports-chart-header">
                <div>
                  <RevenueChartLabel description="Monthly recurring revenue from the selected revenue sources.">MRR</RevenueChartLabel>
                  <div className="reports-chart-value">
                    {formatMoney(currency.mrr, currency.currency)}
                  </div>
                </div>
              </div>
              <div
                className="reports-chart-canvas"
                aria-label={`Monthly recurring revenue from ${start} to ${end}`}
              >
                <BarChart
                  data={visibleMrrSeries}
                  type="stacked"
                  showLegend={false}
                  tooltipOptions={{
                    valueFormatter: moneyFormatter,
                    renderTooltipContent: ({ activeIndex }) => {
                      const point = points[activeIndex];
                      if (!point) return null;
                      return (
                        <MantleChartTooltip
                          title={chartPeriodLabel(point.periodStart, interval)}
                          delta={point.mrr - previousValue(activeIndex, "mrr")}
                          currency={currency.currency}
                          provisional={point.provisional}
                          rows={[
                            ...componentRows(point),
                            {
                              label: "Total",
                              value: point.mrr,
                              color: "#e44ad7",
                              total: true,
                            },
                          ]}
                        />
                      );
                    },
                  }}
                  xAxisOptions={{ allowLineWrap: false }}
                  yAxisOptions={{ labelFormatter: moneyFormatter }}
                />
              </div>
              <ChartLegend
                items={mrrSeries.map((series) => ({
                  label: series.name,
                  color:
                    typeof series.color === "string" ? series.color : "#9668ff",
                }))}
                hidden={hiddenMrr}
                onToggle={toggle(setHiddenMrr, hiddenMrr)}
              />
            </section>

            <section className="reports-chart-card reports-chart-card--recurring">
              <div className="reports-chart-header">
                <div>
                  <RevenueChartLabel description="Annual recurring revenue: selected monthly recurring revenue multiplied by 12.">ARR</RevenueChartLabel>
                  <div className="reports-chart-value">
                    {formatMoney(currency.arr, currency.currency)}
                  </div>
                </div>
              </div>
              <div
                className="reports-chart-canvas"
                aria-label={`Annual recurring revenue from ${start} to ${end}`}
              >
                <LineChart
                  data={visibleArrSeries}
                  showLegend={false}
                  slots={{ chart: (scales) => hiddenArr.has("ARR") ? null : (
                    <RevenueChartArea values={arrValues} {...scales} />
                  ) }}
                  tooltipOptions={{
                    valueFormatter: arrMoneyFormatter,
                    /* Rows come from the series polaris-viz reports at this
                       index, not from `points`, so a legend-hidden series drops
                       out of the tooltip too and ARR's fitted Trend gets its own
                       row beside the measured value — reading the gap between
                       them is the whole reason the trend line is drawn.

                       Mantle shows only the line under the cursor. polaris-viz
                       cannot: its line tooltip reports every series at the
                       active index and exposes no cursor position, so which line
                       is nearest is not knowable here without hand-rolling hit
                       detection against the chart's y-scale. */
                    renderTooltipContent: ({ activeIndex, data: tooltip }) => {
                      const point = points[activeIndex];
                      if (!point) return null;
                      const rows = (tooltip[0]?.data ?? [])
                        .filter((row) => !row.isHidden && row.value !== null)
                        .map((row) => ({
                          label: String(row.key),
                          value: Number(row.value ?? 0),
                          color:
                            typeof row.color === "string"
                              ? row.color
                              : "#9364ff",
                        }));
                      return (
                        <MantleChartTooltip
                          title={chartPeriodLabel(point.periodStart, interval)}
                          delta={point.arr - previousValue(activeIndex, "arr")}
                          currency={currency.currency}
                          provisional={point.provisional}
                          rows={rows}
                        />
                      );
                    },
                  }}
                  xAxisOptions={{ allowLineWrap: false }}
                  yAxisOptions={{ labelFormatter: arrMoneyFormatter }}
                />
              </div>
              <ChartLegend
                items={[
                  { label: "ARR", color: "#9364ff", shape: "area" },
                  { label: "Trend", color: "#6d7175", dashed: true },
                ]}
                hidden={hiddenArr}
                onToggle={toggle(setHiddenArr, hiddenArr)}
              />
            </section>
          </InlineGrid>
        </BlockStack>
      </PolarisVizProvider>
    </Suspense>
  );
}

function ReportSkeleton() {
  return (
    <BlockStack gap="400">
      <Card>
        <InlineStack gap="200" blockAlign="center">
          <Spinner accessibilityLabel="Loading Shopify analytics" size="small" />
          <Text as="p" variant="bodyMd">
            Loading Shopify analytics…
          </Text>
        </InlineStack>
      </Card>
      <InlineGrid columns={{ xs: 1, sm: 2, lg: 4 }} gap="300">
        {[0, 1, 2, 3].map((item) => (
          <Card key={item}>
            <BlockStack gap="300">
              <SkeletonBodyText lines={1} />
              <SkeletonDisplayText size="large" />
              <SkeletonBodyText lines={1} />
            </BlockStack>
          </Card>
        ))}
      </InlineGrid>
      <InlineGrid columns={{ xs: 1, lg: 2 }} gap="300">
        {[0, 1].map((item) => (
          <Card key={item}>
            <BlockStack gap="400">
              <SkeletonDisplayText size="small" />
              <SkeletonBodyText lines={8} />
            </BlockStack>
          </Card>
        ))}
      </InlineGrid>
    </BlockStack>
  );
}

export async function loader({ request }: Route.LoaderArgs) {
  const org = await requireCurrentOrganization(request);
  const url = new URL(request.url);
  const requestedReport = url.searchParams.get("report");
  /* Null is the INDEX, not a default report. An unrecognised value lands there
     too, so a stale bookmark reaches something navigable rather than silently
     showing a report the URL did not ask for. */
  const report: ReportName | null = REPORTS.includes(
    requestedReport as ReportName,
  )
    ? (requestedReport as ReportName)
    : null;
  const requestedPeriod = url.searchParams.get("period");
  const period = ANALYTICS_PERIODS.includes(requestedPeriod as AnalyticsPeriod)
    ? (requestedPeriod as AnalyticsPeriod)
    : "last_30_days";
  const requestedInterval = url.searchParams.get("interval");
  const interval = ANALYTICS_INTERVALS.includes(
    requestedInterval as AnalyticsInterval,
  )
    ? (requestedInterval as AnalyticsInterval)
    : period === "last_30_days"
      ? "day"
      : period === "last_90_days"
        ? "week"
        : "month";

  const appRecords = await prisma.app.findMany({
    where: { organizationId: org.id },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      logoUrl: true,
      bigqueryDataset: true,
      gcpProjectId: true,
      trafficEventsBackfillCompletedAt: true,
      trafficEventsSyncedAt: true,
    },
  });
  const apps = appRecords;
  const requestedAppId = url.searchParams.get("appId")?.trim() ?? "";
  const appId = apps.some((app) => app.id === requestedAppId)
    ? requestedAppId
    : "";
  const validDimensionKeys = new Set<string>(
    PIVOT_DIMENSIONS.map((dimension) => dimension.key),
  );
  const requestedDimensions = (
    url.searchParams.get("trafficDims")?.split(",") ?? []
  ).filter((key): key is PivotDimensionKey => validDimensionKeys.has(key));
  const trafficDimensions =
    requestedDimensions.length > 0
      ? requestedDimensions
      : DEFAULT_PIVOT_DIMENSIONS;
  // Every stage in FUNNEL_EVENTS is implemented, so the list itself is the
  // allowlist. This still has to filter: a stale bookmark or saved filter can
  // name a stage that has since been removed (`one_time_charge` was), and
  // passing an unknown key through would reach the report as a funnel with no
  // source behind it.
  const validFunnelKeys = new Set<string>(FUNNEL_EVENTS.map((e) => e.key));
  const requestedFunnelEvents = (
    url.searchParams.get("trafficFunnel")?.split(",") ?? []
  ).filter((key): key is FunnelEventKey => validFunnelKeys.has(key));
  const trafficFunnelEvents =
    requestedFunnelEvents.length > 0
      ? requestedFunnelEvents
      : DEFAULT_FUNNEL_EVENTS;
  const trafficFilters: DimensionFilters = {};
  for (const dimension of PIVOT_DIMENSIONS) {
    const raw = url.searchParams.get(`filter_${dimension.key}`);
    const values = raw?.split(",").filter(Boolean) ?? [];
    if (values.length > 0) trafficFilters[dimension.key] = values;
  }
  const trafficStartParam = url.searchParams.get("trafficStart");
  const trafficEndParam = url.searchParams.get("trafficEnd");
  const trafficStartDate = trafficStartParam
    ? parseIsoDateUtc(trafficStartParam)
    : null;
  const trafficEndDate = trafficEndParam
    ? parseIsoDateUtc(trafficEndParam)
    : null;
  const hasCustomTrafficRange = Boolean(
    trafficStartDate && trafficEndDate && trafficStartDate <= trafficEndDate,
  );
  const compareModeParam = url.searchParams.get("trafficCompare");
  const trafficCompareMode: CompareMode = (
    ["previous_period", "previous_year", "custom"] as CompareMode[]
  ).includes(compareModeParam as CompareMode)
    ? (compareModeParam as CompareMode)
    : "none";
  const compareStartParam = url.searchParams.get("trafficCompareStart");
  const compareEndParam = url.searchParams.get("trafficCompareEnd");

  let trafficSources: Awaited<
    ReturnType<typeof getTrafficSourcesReportForApps>
  > | null = null;
  let trafficDateRange: { start: string; end: string } | null = null;
  let trafficCompareDateRange: { start: string; end: string } | null = null;
  // GA4/BigQuery is per-app (one property, one dataset per app), so there is
  // no single query spanning them — "All apps" is served by running each
  // configured app's report and merging them by dimension-value combination
  // (see `getTrafficSourcesReportForApps`).
  //
  // This used to silently fall back to `apps[0]` instead, which meant the
  // page-level selector could say "All apps" while the panel below it showed
  // a single app alone, with nothing saying so.
  const trafficAppId = appId;
  const trafficSavedFilters =
    report === "traffic" ? await listSavedViews(org.id, "traffic") : [];
  const insightsSavedViews =
    report === "insights" ? await listSavedViews(org.id, "insights") : [];
  // One scope for a chosen app; every app that could have traffic when the
  // selector is on "All apps". An app with neither a dataset nor a completed
  // local backfill has no traffic data at all, so including it would only add
  // a guaranteed-empty report to the merge. Shared by both traffic reports so
  // they can never disagree about which apps "All apps" means.
  //
  // No env-var fallback for the dataset — see traffic-sources.server.ts's
  // getTrafficSourcesReport for why (per-app data, not a shared default).
  const trafficScopes: TrafficAppScope[] = (
    trafficAppId
      ? apps.filter((app) => app.id === trafficAppId)
      : apps.filter(
          (app) => app.bigqueryDataset || app.trafficEventsBackfillCompletedAt,
        )
  ).map((app) => ({
    appId: app.id,
    datasetId: app.bigqueryDataset ?? null,
    projectId: app.gcpProjectId ?? env.GCP_PROJECT_ID ?? null,
    trafficEventsBackfillCompletedAt: app.trafficEventsBackfillCompletedAt ?? null,
    trafficEventsSyncedAt: app.trafficEventsSyncedAt ?? null,
  }));

  /* "All time" needs its start looked up, as the other reports do with
     `findAllTimeStart`; without one it silently means "today". */
  const trafficRange = async () =>
    resolveAnalyticsRange(
      period,
      new Date(),
      period === "all_time"
        ? await findTrafficAllTimeStart(trafficScopes)
        : undefined,
    );

  const trafficInsights =
    report === "insights"
      ? await getTrafficInsights(
          trafficScopes,
          await trafficRange(),
          parseInsightEvent(url.searchParams.get(INSIGHT_EVENT_PARAM)),
          parseInsightMetric(url.searchParams.get(INSIGHT_METRIC_PARAM)),
        )
      : null;

  if (report === "traffic") {
    const requestedTrafficPage = Number(
      url.searchParams.get("trafficPage") ?? "1",
    );
    let range = await trafficRange();
    if (hasCustomTrafficRange) {
      const start = trafficStartDate!;
      const now = new Date();
      // Whole-day presets/custom picks store an inclusive end-of-day date and
      // need +1 day to become an exclusive boundary; precise sub-day presets
      // ("Last 12 hours") are already an exact instant and must be used as-is.
      const endExclusive = isUtcMidnight(trafficEndDate!)
        ? new Date(trafficEndDate!.getTime() + 86_400_000)
        : trafficEndDate!;
      const end = endExclusive > now ? now : endExclusive;
      range = { period, start, end, interval: autoInterval(start, end) };
      trafficDateRange = { start: trafficStartParam!, end: trafficEndParam! };
    }

    let compareRange:
      | { start: Date; end: Date; interval: AnalyticsInterval }
      | undefined;
    if (trafficCompareMode === "previous_period") {
      const spanMs = range.end.getTime() - range.start.getTime();
      const compareEnd = range.start;
      const compareStart = new Date(range.start.getTime() - spanMs);
      compareRange = {
        start: compareStart,
        end: compareEnd,
        interval: autoInterval(compareStart, compareEnd),
      };
    } else if (trafficCompareMode === "previous_year") {
      const compareStart = new Date(range.start);
      compareStart.setUTCFullYear(compareStart.getUTCFullYear() - 1);
      const compareEnd = new Date(range.end);
      compareEnd.setUTCFullYear(compareEnd.getUTCFullYear() - 1);
      compareRange = {
        start: compareStart,
        end: compareEnd,
        interval: autoInterval(compareStart, compareEnd),
      };
    } else if (trafficCompareMode === "custom") {
      const compareStartDate = compareStartParam
        ? parseIsoDateUtc(compareStartParam)
        : null;
      const compareEndDate = compareEndParam
        ? parseIsoDateUtc(compareEndParam)
        : null;
      if (
        compareStartDate &&
        compareEndDate &&
        compareStartDate <= compareEndDate
      ) {
        const now = new Date();
        const compareEndExclusive = isUtcMidnight(compareEndDate)
          ? new Date(compareEndDate.getTime() + 86_400_000)
          : compareEndDate;
        const compareEnd =
          compareEndExclusive > now ? now : compareEndExclusive;
        compareRange = {
          start: compareStartDate,
          end: compareEnd,
          interval: autoInterval(compareStartDate, compareEnd),
        };
        trafficCompareDateRange = {
          start: compareStartParam!,
          end: compareEndParam!,
        };
      }
    }

    trafficSources = await getTrafficSourcesReportForApps(
      trafficScopes,
      range,
      trafficDimensions,
      trafficFunnelEvents,
      Number.isInteger(requestedTrafficPage) ? requestedTrafficPage : 1,
      TRAFFIC_PAGE_SIZE,
      trafficFilters,
      compareRange,
    );
  }

  return {
    apps,
    appId,
    interval,
    period,
    report,
    trafficSources,
    trafficInsights,
    trafficAppId,
    trafficDateRange,
    trafficCompareMode,
    trafficCompareDateRange,
    trafficSavedFilters,
    insightsSavedViews,
  };
}

function RevenuePanel({ data }: { data: RevenueReport }) {
  if (data.currencies.length === 0) {
    return (
      <Card>
        <EmptyState
          heading="No collected revenue in this period"
          image={EMPTY_STATE_IMAGE}
        >
          <p>
            Successful non-test charges will appear here after subscriptions
            begin billing.
          </p>
        </EmptyState>
      </Card>
    );
  }

  return (
    <BlockStack gap="400">
      <Banner tone="info">
        Net collected is gross successful charges minus app credits. Refunds,
        taxes, platform revenue share, and payout windows are not stored yet, so
        this is not a payout report.
      </Banner>
      {data.currencies.map((currency) => (
        <BlockStack gap="300" key={currency.currency}>
          <InlineGrid columns={{ xs: 1, md: 3 }} gap="300">
            <MetricCard
              label={`Gross revenue (${currency.currency})`}
              value={formatMoney(currency.value.gross, currency.currency)}
            />
            <MetricCard
              label={`Credits (${currency.currency})`}
              value={formatMoney(currency.value.credits, currency.currency)}
            />
            <MetricCard
              label={`Net collected (${currency.currency})`}
              value={formatMoney(currency.value.net, currency.currency)}
            />
          </InlineGrid>
          <Card padding="0">
            <ChunkedDataTable
              columnContentTypes={[
                "text",
                "numeric",
                "numeric",
                "numeric",
                "text",
              ]}
              headings={[
                "Period",
                "Gross",
                "Credits",
                "Net collected",
                "State",
              ]}
              rows={currency.timeSeries.map((point) => [
                `${formatDate(point.periodStart)} – ${formatDate(point.periodEnd)}`,
                formatMoney(point.gross, currency.currency),
                formatMoney(point.credits, currency.currency),
                formatMoney(point.net, currency.currency),
                point.provisional ? (
                  <Badge key={`${point.periodStart}-state`} tone="attention">
                    Provisional
                  </Badge>
                ) : (
                  "Complete"
                ),
              ])}
            />
          </Card>
        </BlockStack>
      ))}
    </BlockStack>
  );
}

function LtvPanel({ data }: { data: LtvReport }) {
  if (data.currencies.length === 0) {
    return (
      <Card>
        <EmptyState
          heading="Not enough data to calculate LTV"
          image={EMPTY_STATE_IMAGE}
        >
          <p>
            LTV needs at least one active paid subscription and merchant
            lifecycle history.
          </p>
        </EmptyState>
      </Card>
    );
  }

  const usesSubscriptionChurn = data.currencies.every(
    (currency) => currency.churnBasis === "subscription",
  );

  return (
    <BlockStack gap="400">
      <Banner tone="info">
        {usesSubscriptionChurn
          ? "Predicted LTV is ARPU per active paid subscription divided by the rolling 30-day paid subscription churn rate. Trials and frozen charges are excluded, and reactivations are netted out."
          : "Predicted LTV is ARPU per active paid subscription divided by the rolling 30-day customer-driven logo churn rate."}{" "}
        A zero churn rate is shown as unavailable instead of infinity.
      </Banner>
      {data.currencies.map((currency) => (
        <BlockStack gap="300" key={currency.currency}>
          <InlineGrid columns={{ xs: 1, sm: 2, lg: 4 }} gap="300">
            <MetricCard
              label={`Predicted LTV (${currency.currency})`}
              value={
                currency.value == null
                  ? "—"
                  : formatMoney(currency.value, currency.currency)
              }
              detail={
                currency.value == null
                  ? "Needs measurable rolling churn"
                  : `ARPU ÷ monthly ${currency.churnBasis} churn`
              }
            />
            <MetricCard
              label="ARPU"
              value={formatMoney(currency.arpu, currency.currency)}
              detail={`${currency.activeSubscriptions} active paid subscription${currency.activeSubscriptions === 1 ? "" : "s"}`}
            />
            <MetricCard
              label="MRR"
              value={formatMoney(currency.mrr, currency.currency)}
            />
            <MetricCard
              label={`Rolling 30-day ${currency.churnBasis} churn`}
              value={percent(currency.monthlyChurnRate)}
            />
          </InlineGrid>
          <Card padding="0">
            <ChunkedDataTable
              columnContentTypes={[
                "text",
                "numeric",
                "numeric",
                "numeric",
                "numeric",
              ]}
              headings={[
                "Period",
                "Predicted LTV",
                "ARPU",
                "MRR",
                `Monthly ${currency.churnBasis} churn`,
              ]}
              rows={currency.timeSeries.map((point) => [
                `${formatDate(point.periodStart)} – ${formatDate(point.periodEnd)}`,
                point.value == null
                  ? "—"
                  : formatMoney(point.value, currency.currency),
                formatMoney(point.arpu, currency.currency),
                formatMoney(point.mrr, currency.currency),
                percent(point.monthlyChurnRate),
              ])}
            />
          </Card>
        </BlockStack>
      ))}
    </BlockStack>
  );
}

function ChurnPanel({ data }: { data: ChurnReport }) {
  const countRows = data.logo.timeSeries.map((logo, index) => {
    const subscription = data.subscription.timeSeries[index];
    return [
      `${formatDate(logo.periodStart)} – ${formatDate(logo.periodEnd)}`,
      `${logo.netLost} / ${logo.denominator}`,
      percent(logo.rate),
      `${subscription?.netLost ?? 0} / ${subscription?.denominator ?? 0}`,
      percent(subscription?.rate ?? 0),
      logo.provisional ? (
        <Badge key={`${logo.periodStart}-state`} tone="attention">
          Provisional
        </Badge>
      ) : (
        "Complete"
      ),
    ];
  });

  return (
    <BlockStack gap="400">
      <Banner tone="info">
        Logo churn excludes store closure/deactivation reasons. Subscription
        churn excludes completed upgrades, downgrades, and approved replacement
        rows. Revenue churn currently measures cancellation MRR only.
      </Banner>
      <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
        <MetricCard
          label="Customer-driven logo churn"
          value={percent(data.logo.value)}
          detail={`${data.logo.netLost} net lost / ${data.logo.denominator} active at period start`}
        />
        <MetricCard
          label="Subscription churn"
          value={percent(data.subscription.value)}
          detail={`${data.subscription.netLost} canceled / ${data.subscription.denominator} active at period start`}
        />
      </InlineGrid>
      <Card padding="0">
        <ChunkedDataTable
          columnContentTypes={[
            "text",
            "numeric",
            "numeric",
            "numeric",
            "numeric",
            "text",
          ]}
          headings={[
            "Period",
            "Net logos / start",
            "Logo churn",
            "Canceled subs / start",
            "Subscription churn",
            "State",
          ]}
          rows={countRows}
        />
      </Card>

      {data.grossRevenue.currencies.map((currency) => (
        <BlockStack gap="300" key={currency.currency}>
          <InlineGrid columns={{ xs: 1, md: 3 }} gap="300">
            <MetricCard
              label={`Cancellation MRR lost (${currency.currency})`}
              value={formatMoney(currency.value.lostMrr, currency.currency)}
            />
            <MetricCard
              label={`Starting MRR (${currency.currency})`}
              value={formatMoney(currency.value.startMrr, currency.currency)}
            />
            <MetricCard
              label="Gross revenue churn"
              value={percent(currency.value.rate)}
            />
          </InlineGrid>
          <Card padding="0">
            <ChunkedDataTable
              columnContentTypes={["text", "numeric", "numeric", "numeric"]}
              headings={["Period", "Lost MRR", "Starting MRR", "Churn"]}
              rows={currency.timeSeries.map((point) => [
                `${formatDate(point.periodStart)} – ${formatDate(point.periodEnd)}`,
                formatMoney(point.lostMrr, currency.currency),
                formatMoney(point.startMrr, currency.currency),
                percent(point.rate),
              ])}
            />
          </Card>
        </BlockStack>
      ))}
    </BlockStack>
  );
}

/**
 * Mantle's "MRR changes": a stacked bar per period with a Net change line, over
 * a table whose columns are the periods and whose last column is the range
 * total — the same layout as Mantle's own Monthly recurring revenue report.
 *
 * Gains stack above zero and LOSSES BELOW IT. The stored columns are all
 * positive (see `MrrMovementBucket`); the sign is applied here, once, at the
 * point of display, so the chart and the table cannot disagree about direction.
 *
 * Colors match Mantle's legend order so someone reading both sees the same
 * category in the same color.
 */
const MOVEMENT_COLORS: Record<string, string> = {
  new: "#0f7b52",
  expansion: "#4aa3ff",
  reactivation: "#5fd0a0",
  unfrozen: "#9668ff",
  churn: "#d72c0d",
  contraction: "#f4a3a3",
  frozen: "#e5a72c",
};

/**
 * Mantle's "N metrics" picker, grouped the way Mantle groups it.
 *
 * `Usage charges` is deliberately absent. Mantle lists it under a third
 * "Variable metrics" heading and ships it unchecked; our movement ledger has no
 * usage category at all — the seven below are the seven columns
 * `PartnerDailyMrrSnapshot` stores — so rendering it would be a control that
 * can never do anything.
 */
const MOVEMENT_METRIC_GROUPS: ReadonlyArray<{
  label: string;
  keys: MrrMovementCategory[];
}> = [
  {
    label: "Growth metrics",
    keys: ["new", "reactivation", "expansion", "unfrozen"],
  },
  { label: "Churn metrics", keys: ["churn", "contraction", "frozen"] },
];

function MrrChangesSection({
  movement,
  interval,
}: {
  movement: MrrMovementSummary[];
  interval: AnalyticsInterval;
}) {
  /* Hidden rather than visible, so a category added to `MRR_MOVEMENT_ROWS`
     later shows up by default instead of silently staying off the chart. */
  const [hiddenMetrics, setHiddenMetrics] = useState<Set<MrrMovementCategory>>(
    () => new Set(),
  );
  const [metricsOpen, setMetricsOpen] = useState(false);
  const [typesAsColumns, setTypesAsColumns] = useState(false);
  const [layoutOpen, setLayoutOpen] = useState(false);

  const rows = MRR_MOVEMENT_ROWS.filter((row) => !hiddenMetrics.has(row.key));
  const toggleMetric = (key: MrrMovementCategory) =>
    setHiddenMetrics((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      /* Never let the last one go: an empty stacked chart has no axis to draw
         and reads as "no data" rather than "you hid everything". */
      else if (next.size < MRR_MOVEMENT_ROWS.length - 1) next.add(key);
      return next;
    });

  /* Net is recomputed over the VISIBLE categories, not read from the stored
     `bucket.net`. The table's defining property is that a column adds down to
     Net change; with a category hidden, the stored net would no longer be the
     sum of what is on screen, and the bars would visibly fail to reach the net
     line. */
  const visibleNet = (bucket: MrrMovementBucket) =>
    rows.reduce(
      (sum, row) =>
        sum + (row.loss ? -Number(bucket[row.key]) : Number(bucket[row.key])),
      0,
    );
  /* This chart had no provider at all, so it rendered on polaris-viz's stock
     theme while every chart above it used "Mantle" — visibly off in dark mode.
     Bar count comes from the first currency; the ranges are identical across
     currencies, only the amounts differ. */
  /* 440px, against the 280px every other chart uses. polaris-viz takes the
     plot height from the THEME, not from the element, so the wrapper's CSS
     height alone did nothing but add space under the chart. */
  const { themes: chartThemes } = useBarChartTheme(
    movement[0]?.buckets.length ?? 1,
    440,
  );
  return (
    <Suspense fallback={<ReportSkeleton />}>
    <PolarisVizProvider themes={chartThemes} defaultTheme="Mantle">
    <BlockStack gap="400">
      {movement.map((entry) => {
        const buckets = entry.buckets;
        const label = (bucket: MrrMovementBucket, index: number) =>
          bucket.periodStart
            ? chartPeriodLabel(bucket.periodStart, interval)
            : `#${index + 1}`;

        const series = rows.map((row) => ({
          name: row.label,
          data: buckets.map((bucket, index) => ({
            key: label(bucket, index),
            // Losses render below the axis. `-0` would print as "-0" in a
            // tooltip, so normalize it away.
            value: row.loss
              ? -Number(bucket[row.key]) || 0
              : Number(bucket[row.key]),
          })),
          color: MOVEMENT_COLORS[row.key],
        }));

        const moneyFormatter = (value: string | number | null) =>
          compactMoney(Number(value ?? 0), entry.currency);

        return (
          <BlockStack gap="300" key={entry.currency}>
            <section className="reports-chart-card">
              <div className="reports-chart-header">
                <div>
                  <div className="reports-chart-label">
                    MRR growth · {entry.currency}
                  </div>
                  <div className="reports-chart-value">
                    {visibleNet(entry.total) >= 0 ? "↑ " : "↓ "}
                    {formatMoney(
                      Math.abs(visibleNet(entry.total)),
                      entry.currency,
                    )}
                  </div>
                </div>
                <InlineStack gap="200" blockAlign="center">
                  <Popover
                    active={layoutOpen}
                    activator={
                      <Button
                        disclosure
                        onClick={() => setLayoutOpen((open) => !open)}
                      >
                        Rows
                      </Button>
                    }
                    autofocusTarget="first-node"
                    onClose={() => setLayoutOpen(false)}
                  >
                    <Popover.Pane fixed>
                      <div
                        style={{ padding: "var(--p-space-400)", width: 260 }}
                      >
                        <BlockStack gap="200">
                          <Text as="h3" variant="headingSm">
                            Table layout
                          </Text>
                          <Checkbox
                            label="Show types as rows"
                            checked={!typesAsColumns}
                            onChange={() => setTypesAsColumns(false)}
                          />
                          <Checkbox
                            label="Show types as columns"
                            checked={typesAsColumns}
                            onChange={() => setTypesAsColumns(true)}
                          />
                        </BlockStack>
                      </div>
                    </Popover.Pane>
                  </Popover>
                  <Popover
                    active={metricsOpen}
                    activator={
                      <Button
                        disclosure
                        onClick={() => setMetricsOpen((open) => !open)}
                      >
                        {`${rows.length} metric${rows.length === 1 ? "" : "s"}`}
                      </Button>
                    }
                    autofocusTarget="first-node"
                    onClose={() => setMetricsOpen(false)}
                  >
                    <Popover.Pane fixed>
                      <div
                        style={{ padding: "var(--p-space-400)", width: 240 }}
                      >
                        <BlockStack gap="300">
                          {MOVEMENT_METRIC_GROUPS.map((group) => (
                            <BlockStack gap="200" key={group.label}>
                              <Text as="h3" variant="headingSm">
                                {group.label}
                              </Text>
                              {group.keys.map((key) => {
                                const row = MRR_MOVEMENT_ROWS.find(
                                  (candidate) => candidate.key === key,
                                );
                                if (!row) return null;
                                const checked = !hiddenMetrics.has(key);
                                return (
                                  <Checkbox
                                    key={key}
                                    label={row.label}
                                    checked={checked}
                                    /* The last visible metric cannot be
                                       unchecked — see `toggleMetric`. */
                                    disabled={checked && rows.length === 1}
                                    onChange={() => toggleMetric(key)}
                                  />
                                );
                              })}
                            </BlockStack>
                          ))}
                        </BlockStack>
                      </div>
                    </Popover.Pane>
                  </Popover>
                </InlineStack>
              </div>
              {/* Taller than the other charts on purpose: this one is the only
                  DIVERGING chart, so its plot area is split between gains above
                  the axis and losses below, leaving each bar about half the
                  height it would get on a single-sided chart. */}
              <div
                className="reports-chart-canvas reports-chart-canvas--tall"
                aria-label={`MRR changes in ${entry.currency}`}
              >
                <BarChart
                  data={series}
                  type="stacked"
                  showLegend={false}
                  /* The only chart here that had neither, which is why its
                     y-axis read a bare "1000" while every other chart read
                     "$1.0K", and why 30 date labels stacked vertically. */
                  xAxisOptions={{ allowLineWrap: false }}
                  yAxisOptions={{ labelFormatter: moneyFormatter }}
                  tooltipOptions={{
                    valueFormatter: moneyFormatter,
                    renderTooltipContent: ({ activeIndex }) => {
                      const bucket = buckets[activeIndex];
                      if (!bucket) return null;
                      return (
                        <MantleChartTooltip
                          title={label(bucket, activeIndex)}
                          delta={visibleNet(bucket)}
                          currency={entry.currency}
                          rows={[
                            ...rows
                              .filter((row) => Number(bucket[row.key]) !== 0)
                              .map((row) => ({
                              label: row.label,
                              value: row.loss
                                ? -Number(bucket[row.key])
                                : Number(bucket[row.key]),
                              color: MOVEMENT_COLORS[row.key]!,
                            })),
                            {
                              label: "Net change",
                              value: visibleNet(bucket),
                              color: "#f4a261",
                              total: true,
                            },
                          ]}
                        />
                      );
                    },
                  }}
                />
              </div>
              {/* Not `ChartLegend` — that one is keyed to the revenue-component
                  toggles. Same markup and class so the two look identical. */}
              <div className="reports-chart-legend" aria-label="Chart legend">
                {rows.map((row) => (
                  <span key={row.key}>
                    <i
                      style={{ background: MOVEMENT_COLORS[row.key] }}
                      aria-hidden="true"
                    />
                    {row.label}
                  </span>
                ))}
                <span>
                  <i style={{ background: "#f4a261" }} aria-hidden="true" />
                  Net change
                </span>
              </div>
            </section>
            <Card padding="0">
              {/* Two orientations, matching Mantle's "Rows" control.
                  Types-as-rows (the default) reads as one category over time,
                  which is what a table this wide is usually for; the Total
                  column closes each category. Types-as-columns puts one period
                  per row, which is the shape you want when comparing
                  categories within a single day. Either way the periods run in
                  range order and the aggregate sits last. */}
              <div className="reports-movement-scroll">
                {typesAsColumns ? (
                  <ChunkedDataTable
                    columnContentTypes={[
                      "text",
                      ...rows.map(() => "numeric" as const),
                      "numeric" as const,
                    ]}
                    headings={[
                      "Period",
                      ...rows.map((row) => row.label),
                      "Net change",
                    ]}
                    rows={[
                      ...buckets.map((bucket, index) => [
                        label(bucket, index),
                        ...rows.map((row) =>
                          signedMoney(
                            Number(bucket[row.key]),
                            row.loss,
                            entry.currency,
                          ),
                        ),
                        signedMoney(
                          visibleNet(bucket),
                          undefined,
                          entry.currency,
                        ),
                      ]),
                      boldRow([
                        "Total",
                        ...rows.map((row) =>
                          signedMoney(
                            Number(entry.total[row.key]),
                            row.loss,
                            entry.currency,
                          ),
                        ),
                        signedMoney(
                          visibleNet(entry.total),
                          undefined,
                          entry.currency,
                        ),
                      ]),
                    ]}
                    /* Every period fits in one page here, deliberately: the
                       Total row is the last row, and chunking would hide the
                       one row most worth seeing behind a pager. */
                    chunkSize={buckets.length + 1}
                  />
                ) : (
                  <ChunkedDataTable
                    columnContentTypes={[
                      "text",
                      ...buckets.map(() => "numeric" as const),
                      "numeric" as const,
                    ]}
                    headings={[
                      "Type",
                      ...buckets.map((bucket, index) => label(bucket, index)),
                      "Total",
                    ]}
                    rows={[
                      ...rows.map((row) => [
                        row.label,
                        ...buckets.map((bucket) =>
                          signedMoney(
                            Number(bucket[row.key]),
                            row.loss,
                            entry.currency,
                          ),
                        ),
                        signedMoney(
                          Number(entry.total[row.key]),
                          row.loss,
                          entry.currency,
                        ),
                      ]),
                      boldRow([
                        "Net change",
                        ...buckets.map((bucket) =>
                          signedMoney(
                            visibleNet(bucket),
                            undefined,
                            entry.currency,
                          ),
                        ),
                        signedMoney(
                          visibleNet(entry.total),
                          undefined,
                          entry.currency,
                        ),
                      ]),
                    ]}
                    chunkSize={12}
                  />
                )}
              </div>
            </Card>
          </BlockStack>
        );
      })}
    </BlockStack>
    </PolarisVizProvider>
    </Suspense>
  );
}

/**
 * Marks a table row as the aggregate one.
 *
 * Bolded cell by cell rather than by a CSS `:last-child` rule, because
 * `ChunkedDataTable` renders `rows.slice(0, shown)` — so the aggregate row is
 * only the last RENDERED row when the whole table happens to fit on one page.
 */
function boldRow(cells: string[]): ReactNode[] {
  return cells.map((cell, index) => <strong key={index}>{cell}</strong>);
}

/** Losses print negative; a zero prints as an em dash so the eye skips it. */
function signedMoney(
  amount: number,
  loss: true | undefined,
  currency: string,
): string {
  if (amount === 0) return "—";
  const signed = loss ? -amount : amount;
  return `${signed >= 0 ? "+" : "−"}${formatMoney(Math.abs(signed), currency)}`;
}

/** Mantle's Top-plans palette order, so the same plan keeps the same colour. */
const PLAN_COLORS = [
  "#9668ff",
  "#4aa3ff",
  "#e44ad7",
  "#e5a72c",
  "#f4845f",
  "#5fd0a0",
  "#0f7b52",
  "#8a8a8a",
];

/**
 * Mantle's second row: MRR growth rate, and Top plans by MRR.
 *
 * Both are read off data the page already has — the growth rate is a
 * period-over-period difference of the MRR series, and `planSeries` rides along
 * on the recurring report — so this adds two charts without another request.
 */
function MrrGrowthCharts({
  data,
  interval,
  period,
}: {
  data: PortfolioReport["recurring"];
  interval: AnalyticsInterval;
  period: AnalyticsPeriod;
}) {
  const { themes: chartThemes, isDark } = useRevenueChartTheme();
  const currency = data.currencies[0];
  const points = useMemo(
    () =>
      sampleSeries(
        data.timeSeries.filter(
          (point) => point.currency === currency?.currency,
        ),
      ),
    [currency?.currency, data.timeSeries],
  );
  const [hiddenPlans, setHiddenPlans] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  if (!currency || points.length < 2) return null;

  /* The TRAILING-30-DAY rate the server computes per bucket, not a
     bucket-over-bucket difference.
     
     Verified against Mantle's own CSV export for 2026-08-08..09-08: this
     definition tracks it to 0.1pt on the first three days and 1.25pt mean over
     the month, where bucket-over-bucket reported ~0.2% against Mantle's ~4-5%
     and was simply a different metric. Mantle's final point spikes because its
     "today" bucket is provisional. */
  const rateValues = points.map((point) => point.monthlyMrrGrowthRate ?? 0);
  /* Mantle headlines the LAST point of this chart, not a whole-range figure, so
     the number and the curve agree. Ours previously headlined
     `currency.growthRate` (cumulative across the range) above a
     bucket-over-bucket curve — two different metrics stacked in one card. */
  const headlineRate = rateValues.at(-1) ?? 0;
  const rateSeries = [
    {
      name: "MRR growth rate",
      data: points.map((point, index) => ({
        key: chartPeriodLabel(point.periodStart, interval),
        value: rateValues[index]! * 100,
      })),
      color: "#9364ff",
      styleOverride: { line: { hasArea: false, width: 1.5 } },
    },
    {
      name: "Trend",
      data: linearTrend(rateValues.map((value) => value * 100)).map(
        (value, index) => ({
          key: chartPeriodLabel(points[index]!.periodStart, interval),
          value,
        }),
      ),
      color: isDark ? "#8a8a8a" : "#6d7175",
      styleOverride: {
        line: { hasArea: false, width: 1, strokeDasharray: "6 4" },
      },
    },
  ];
  const percentFormatter = (value: string | number | null) =>
    `${Number(value ?? 0).toFixed(2)}%`;

  const plans = (data.planSeries ?? []).filter(
    (series) => series.currency === currency.currency,
  );
  /* One point per bucket, sampled the same way `points` is so the two charts
     share an x-axis even when the range is long enough to thin it. */
  const planSeries = plans.map((series, index) => ({
    name: series.plan,
    data: sampleSeries(series.points).map((point) => ({
      key: chartPeriodLabel(point.periodStart, interval),
      value: point.mrr,
    })),
    color: PLAN_COLORS[index % PLAN_COLORS.length]!,
    styleOverride: { line: { hasArea: false, width: 1.5 } },
  }));
  const visiblePlanSeries = planSeries.filter(
    (series) => !hiddenPlans.has(series.name),
  );
  const planTotal = plans.reduce((sum, series) => sum + series.current, 0);
  const planChange = plans.reduce((sum, series) => sum + series.change, 0);
  const moneyFormatter = (value: string | number | null) =>
    compactMoney(Number(value ?? 0), currency.currency);

  return (
    <Suspense fallback={<ReportSkeleton />}>
      <PolarisVizProvider themes={chartThemes} defaultTheme="Mantle">
        <InlineGrid columns={{ xs: 1, lg: 2 }} gap="300">
          <section className="reports-chart-card reports-chart-card--recurring">
            <div className="reports-chart-header">
              <div>
                <RevenueChartLabel description="Change in monthly recurring revenue over the trailing 30 days.">MRR growth rate</RevenueChartLabel>
                <div className="reports-chart-value">
                  {percent(headlineRate)}
                </div>
              </div>
            </div>
            <div
              className="reports-chart-canvas"
              aria-label="MRR growth rate over the selected period"
            >
              <LineChart
                data={rateSeries}
                showLegend={false}
                slots={{ chart: (scales) => (
                  <RevenueChartArea values={rateValues.map((value) => value * 100)} {...scales} />
                ) }}
                tooltipOptions={{
                  valueFormatter: percentFormatter,
                  renderTooltipContent: ({ activeIndex, data: tooltip }) => {
                    const point = points[activeIndex];
                    if (!point) return null;
                    return (
                      <MantleChartTooltip
                        title={chartPeriodLabel(point.periodStart, interval)}
                        delta={(rateValues[activeIndex] ?? 0) * 100}
                        currency={currency.currency}
                        valueFormatter={(value) => `${value.toFixed(2)}%`}
                        rows={(tooltip[0]?.data ?? [])
                          .filter((row) => !row.isHidden)
                          .map((row) => ({
                            label: String(row.key),
                            value: Number(row.value ?? 0),
                            color:
                              typeof row.color === "string"
                                ? row.color
                                : "#9364ff",
                          }))}
                      />
                    );
                  },
                }}
                xAxisOptions={{ allowLineWrap: false }}
                yAxisOptions={{ labelFormatter: percentFormatter }}
              />
            </div>
            <div className="reports-chart-legend" aria-label="Chart legend">
              <span>
                <i className="reports-chart-legend-area" style={{ background: "#9364ff" }} aria-hidden="true" />
                MRR growth rate
              </span>
              <span>
                <i className="reports-chart-legend-dash" aria-hidden="true" />
                Trend
              </span>
            </div>
          </section>

          <section className="reports-chart-card reports-chart-card--recurring">
            <div className="reports-chart-header">
              <div>
                <RevenueChartLabel description="Recurring revenue by plan, excluding active trials.">Top plans by MRR</RevenueChartLabel>
                <div className="reports-chart-value">
                  {formatMoney(planTotal, currency.currency)}
                </div>
              </div>
              <div className="reports-chart-comparison">
                <span>{PERIOD_LABELS[period]}</span>
                <strong>
                  <span className={planChange < 0 ? "reports-chart-change--down" : "reports-chart-change--up"}>
                    {planChange > 0 ? "↑ " : planChange < 0 ? "↓ " : ""}
                  </span>
                  {planTotal - planChange > 0
                    ? percent(Math.abs(planChange) / (planTotal - planChange))
                    : formatMoney(Math.abs(planChange), currency.currency)}
                </strong>
              </div>
            </div>
            <div
              className="reports-chart-canvas"
              aria-label="Top plans by monthly recurring revenue"
            >
              {visiblePlanSeries.length > 0 ? (
                <LineChart
                  data={visiblePlanSeries}
                  showLegend={false}
                  tooltipOptions={{
                    valueFormatter: moneyFormatter,
                    renderTooltipContent: ({ activeIndex, data: tooltip }) => {
                      const point = points[activeIndex];
                      /* Period-over-period change in the VISIBLE total, so the
                         header reads like every other chart's. Computed from the
                         series rather than the tooltip payload, which only ever
                         carries the active index — passing 0 rendered a
                         permanent "— $0.00". */
                      const totalAt = (index: number) =>
                        visiblePlanSeries.reduce(
                          (sum, series) => sum + (series.data[index]?.value ?? 0),
                          0,
                        );
                      const delta =
                        activeIndex > 0
                          ? totalAt(activeIndex) - totalAt(activeIndex - 1)
                          : 0;
                      return (
                        <MantleChartTooltip
                          title={
                            point
                              ? chartPeriodLabel(point.periodStart, interval)
                              : ""
                          }
                          delta={delta}
                          currency={currency.currency}
                          rows={(tooltip[0]?.data ?? [])
                            .filter((row) => !row.isHidden)
                            /* Plans sitting at zero in this bucket are noise in
                               a list of eight; the ones carrying revenue are
                               what the card is for. */
                            .filter((row) => Number(row.value ?? 0) > 0)
                            .map((row) => ({
                              label: String(row.key),
                              value: Number(row.value ?? 0),
                              color:
                                typeof row.color === "string"
                                  ? row.color
                                  : "#9668ff",
                            }))
                            .concat(
                              /* Mantle's tooltip closes with a Total, and it is
                                 the number a reader actually wants from a
                                 stacked set of plans. Summed over the VISIBLE
                                 rows, so hiding a plan in the legend changes the
                                 total to match what is drawn. */
                              (() => {
                                const visible = (tooltip[0]?.data ?? []).filter(
                                  (row) =>
                                    !row.isHidden &&
                                    Number(row.value ?? 0) > 0,
                                );
                                if (visible.length === 0) return [];
                                return [
                                  {
                                    label: "Total",
                                    value: visible.reduce(
                                      (sum, row) =>
                                        sum + Number(row.value ?? 0),
                                      0,
                                    ),
                                    color: "#8a8a8a",
                                    total: true as const,
                                  },
                                ];
                              })(),
                            )}
                        />
                      );
                    },
                  }}
                  xAxisOptions={{ allowLineWrap: false }}
                  yAxisOptions={{ labelFormatter: moneyFormatter }}
                />
              ) : null}
            </div>
            <ChartLegend
              items={planSeries.map((series) => ({
                label: series.name,
                color: series.color,
                shape: "line",
              }))}
              hidden={hiddenPlans}
              onToggle={(label) => {
                const next = new Set(hiddenPlans);
                if (next.has(label)) next.delete(label);
                else next.add(label);
                setHiddenPlans(next);
              }}
            />
          </section>
        </InlineGrid>
      </PolarisVizProvider>
    </Suspense>
  );
}

function GrowthPanel({
  data,
  interval,
  sampled,
  components,
  neverBilledUrl,
}: {
  data: PortfolioReport;
  interval: AnalyticsInterval;
  sampled: boolean;
  components: RevenueComponents;
  neverBilledUrl: string;
}) {
  return (
    <BlockStack gap="400">
      {/* Mantle's own pair: MRR as a stacked bar broken down by
          monthly/annual/usage/trials, and ARR as a filled area with a dashed
          trend line. This replaced a plain MRR line plus a net-movement bar
          chart — the movement now has its own section below, decomposed into
          the seven categories, so a second chart of the same net was both
          redundant and the less informative of the two. */}
      <RecurringRevenueCharts
        data={data.recurring}
        interval={interval}
        sampled={sampled}
        components={components}
        neverBilledUrl={neverBilledUrl}
      />
      {/* Mantle has neither the four Starting/Current/Net/Rate metric cards nor
          a per-period MRR/ARR/Active-subscriptions table here; both were ours.
          The cards restated figures the charts already carry, and the growth
          rate now has its own chart below. The table is removed rather than
          moved — `data.recurring.timeSeries` still holds every column it
          showed (periodStart/periodEnd, mrr, arr, activeSubscriptions), so
          bringing it back is a rendering change, not a data one. */}
      <MrrGrowthCharts data={data.recurring} interval={interval} period={data.period} />
      {data.recurring.movement && data.recurring.movement.length > 0 ? (
        <BlockStack gap="200">
          <Text as="h3" variant="headingMd">
            MRR changes
          </Text>
          <MrrChangesSection
            movement={data.recurring.movement}
            interval={interval}
          />
        </BlockStack>
      ) : null}
      {data.recurring.currencies.length === 0 ? (
        <EmptyState
          heading="No recurring revenue history"
          image={EMPTY_STATE_IMAGE}
        >
          <p>Synchronize subscriptions before MRR and ARR growth can appear.</p>
        </EmptyState>
      ) : null}
    </BlockStack>
  );
}

function RetentionPanel({ data }: { data: PortfolioReport }) {
  return (
    <BlockStack gap="400">
      <Banner tone="info">
        Install cohorts use the merchant’s first install month and measure
        whether that shop is active at the end of the selected period.
      </Banner>
      {data.retention.length ? (
        <ChunkedDataTable
          columnContentTypes={["text", "numeric", "numeric", "numeric"]}
          headings={["Install cohort", "Installed", "Retained", "Retention"]}
          rows={data.retention.map((cohort) => [
            cohort.cohort,
            cohort.installed,
            cohort.retained,
            percent(cohort.retentionRate),
          ])}
        />
      ) : (
        <EmptyState
          heading="No install cohorts in this period"
          image={EMPTY_STATE_IMAGE}
        >
          <p>Choose a longer period or another app.</p>
        </EmptyState>
      )}
      {data.uninstallReasons.length ? (
        <Card padding="0">
          <ChunkedDataTable
            columnContentTypes={["text", "numeric", "numeric", "text"]}
            headings={["Uninstall reason", "Count", "Share", "Classification"]}
            rows={data.uninstallReasons.map((reason) => [
              reason.reasonCode.replaceAll("_", " "),
              reason.count,
              percent(reason.share),
              reason.storeClosure ? "Store closure" : "Product churn",
            ])}
          />
        </Card>
      ) : null}
    </BlockStack>
  );
}

function UsagePanel({
  data,
  period,
  appId,
}: {
  data: PortfolioReport;
  period: AnalyticsPeriod;
  appId: string;
}) {
  /**
   * Row-level trials, fetched only when this tab is open.
   *
   * The report itself runs on the `mrr` metric; the history comes from
   * `/api/metrics/trials`, whose ~7s fold is result-cached. Putting it on the
   * shared metric would have charged every Reports tab for a table only this
   * one shows.
   */
  const [trialsPayload, setTrialsPayload] = useState<TrialsPayload | null>(
    null,
  );
  const [historyError, setHistoryError] = useState(false);
  const trialHistory = trialsPayload?.history ?? null;
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyStatus, setHistoryStatus] = useState<
    "all" | TrialHistoryRow["status"]
  >("all");
  const [historyStatusOpen, setHistoryStatusOpen] = useState(false);
  const [historyPage, setHistoryPage] = useState(1);
  /* Mantle's two toolbar toggles, each placed where its data actually
     supports it: the value/count switch drives the charts' Y axis, and the
     paid-plan filter is a row-level predicate the aggregated buckets can't
     express — applying it to only half the page from a shared toolbar would
     be worse than putting it on the half it can answer. */
  const [showTrialValue, setShowTrialValue] = useState(true);
  const [paidPlansOnly, setPaidPlansOnly] = useState(false);

  /* Every trial figure on this tab reads from here, so the cards, both charts
     and the table can't disagree about what "Paid plans only" means.
     `paidOnly` is the same fold with $0 plans dropped; it falls back when the
     local-lifecycle source supplies no variant. */
  const trials = paidPlansOnly
    ? (data.trials.paidOnly ?? data.trials)
    : data.trials;
  const [valueModeOpen, setValueModeOpen] = useState(false);
  const [paidPlansOpen, setPaidPlansOpen] = useState(false);

  /* Typing shouldn't fire a request per keystroke; the server work behind one
     is a Redis read plus a filter over the period's whole trial list. */
  const [debouncedQuery, setDebouncedQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(historyQuery), 300);
    return () => clearTimeout(timer);
  }, [historyQuery]);

  /* A filter that shortens the list can strand the reader past the last page. */
  useEffect(() => {
    setHistoryPage(1);
  }, [debouncedQuery, historyStatus, paidPlansOnly, period, appId]);

  /* Search, status, plan and page are SERVER-side now. They used to be applied
     in the browser to whichever rows had been shipped, which was the newest
     200 of up to ~41k — so a real match outside that slice read as "no such
     trial". The filter values stay out of the response's cache key, so this
     refetch is a cached read, not another fold. */
  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ period, interval: "day" });
    if (appId) params.set("appId", appId);
    if (debouncedQuery.trim()) params.set("historyQuery", debouncedQuery.trim());
    if (historyStatus !== "all") params.set("historyStatus", historyStatus);
    if (paidPlansOnly) params.set("historyPaidOnly", "1");
    if (historyPage > 1) params.set("historyPage", String(historyPage));
    void fetch(`/api/metrics/trials?${params}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    })
      .then(async (response) => {
        if (!response.ok) {
          /* Loud on purpose. This used to be swallowed, and a request the API
             rejected outright looked identical to a search that legitimately
             matched nothing — the table just kept its previous rows. */
          throw new Error(
            `trials request failed: ${response.status} ${await response.text().catch(() => "")}`,
          );
        }
        return response.json() as Promise<{ data?: TrialsPayload }>;
      })
      .then((body) => {
        if (!body.data) throw new Error("trials response carried no data");
        setHistoryError(false);
        const next = body.data;
        /* Typing changes only the table, but the response carries the charts
           too. Keep the previous `expirySchedule` REFERENCE when its contents
           are unchanged, so the Active trials chart isn't rebuilt on every
           keystroke — `trialRetention` and `TrialComboCard`'s memo both key
           off that array's identity. */
        setTrialsPayload((prev) =>
          prev &&
          JSON.stringify(prev.expirySchedule) ===
            JSON.stringify(next.expirySchedule)
            ? { ...next, expirySchedule: prev.expirySchedule }
            : next,
        );
      })
      .catch((error: unknown) => {
        /* An abort is this effect superseding itself, not a failure. */
        if (controller.signal.aborted) return;
        console.error("[reports] trials fetch failed", error);
        setHistoryError(true);
      });
    return () => controller.abort();
  }, [
    period,
    appId,
    debouncedQuery,
    historyStatus,
    paidPlansOnly,
    historyPage,
  ]);

  const historyRows = trialHistory ?? [];
  const historyPages = trialsPayload?.historyPageCount ?? 1;

  const { themes: chartThemes } = useChartTheme();
  const [selectedMetric, setSelectedMetric] = useState(
    data.usage[0]?.metric ?? "",
  );
  useEffect(() => {
    if (!data.usage.some((metric) => metric.metric === selectedMetric)) {
      setSelectedMetric(data.usage[0]?.metric ?? "");
    }
  }, [data.usage, selectedMetric]);

  const usageMetric =
    data.usage.find((metric) => metric.metric === selectedMetric) ??
    data.usage[0];
  /**
   * The two trial charts.
   *
   * The BARS carry value (Mantle labels that axis "Trial value"), but the
   * RATE is a COUNT ratio — its own tooltip says "the percentage of new
   * customers", and its numbers confirm it: 93.75% is 15/16 and 94.12% is
   * 16/17, matching the trial counts shown beside them, and 78.38% is 29/37.
   * An earlier version of this computed both rates from value and happened to
   * land within 0.03pp of the real figure, which is precisely the kind of
   * coincidence that hides a wrong definition.
   */
  const trialConversion = useMemo(() => {
    const points = trials.timeSeries.map((point) => ({
      key: formatDate(point.periodStart),
      won: showTrialValue ? (point.convertedValue ?? 0) : point.converted,
      lost: showTrialValue ? (point.canceledValue ?? 0) : point.canceled,
      /* Counts kept alongside, because the rate never follows the toggle. */
      wonCount: point.converted,
      lostCount: point.canceled,
    }));
    const won = points.reduce((total, point) => total + point.won, 0);
    const lost = points.reduce((total, point) => total + point.lost, 0);
    const wonCount = points.reduce((total, point) => total + point.wonCount, 0);
    const lostCount = points.reduce(
      (total, point) => total + point.lostCount,
      0,
    );
    return {
      points,
      won,
      lost,
      rate: wonCount + lostCount === 0 ? 0 : wonCount / (wonCount + lostCount),
    };
  }, [trials.timeSeries, showTrialValue]);

  /**
   * Active trials is the FORWARD pipeline, not the range's history: Mantle's
   * x-axis runs into next week, because the question is "what is still on
   * trial and when does it bill", which the past cannot answer.
   */
  const expirySchedule = trialsPayload?.expirySchedule;
  const trialRetention = useMemo(() => {
    const schedule = expirySchedule ?? [];
    const points = schedule.map((point) => {
      /* `?? point.activeCount` covers a payload cached before these fields
         existed — the Redis entry outlives a deploy by up to 5 minutes. */
      const activeCount = paidPlansOnly
        ? (point.activeCountPaid ?? point.activeCount)
        : point.activeCount;
      const lostCount = paidPlansOnly
        ? (point.lostCountPaid ?? point.lostCount)
        : point.lostCount;
      return {
        key: formatDate(point.date),
        won: showTrialValue ? point.activeValue : activeCount,
        lost: showTrialValue ? point.lostValue : lostCount,
        wonCount: activeCount,
        lostCount,
      };
    });
    const won = points.reduce((total, point) => total + point.won, 0);
    const lost = points.reduce((total, point) => total + point.lost, 0);
    const wonCount = points.reduce((total, point) => total + point.wonCount, 0);
    const lostCount = points.reduce(
      (total, point) => total + point.lostCount,
      0,
    );
    return {
      points,
      won,
      lost,
      rate: wonCount + lostCount === 0 ? 0 : wonCount / (wonCount + lostCount),
    };
  }, [expirySchedule, showTrialValue, paidPlansOnly]);

  const usageSeries = usageMetric
    ? [
        {
          name: usageMetric.metric,
          data: usageMetric.timeSeries.map((point) => ({
            key: formatDate(point.periodStart),
            value: point.quantity,
          })),
          color: "#9668ff",
          styleOverride: { line: { hasArea: true, width: 4 } },
        },
      ]
    : [];
  const countFormatter = (value: string | number | null) =>
    Number(value ?? 0).toLocaleString(undefined, {
      maximumFractionDigits: 2,
    });
  const trialSource =
    data.trials.source === "shopify_partner_inferred"
      ? "Shopify Partner lifecycle"
      : "Local billing lifecycle";

  return (
    <BlockStack gap="400">
      <InlineGrid columns={{ xs: 1, sm: 2, lg: 4 }} gap="300">
        <MetricCard
          label="Trial conversion"
          value={percent(trials.conversionRate)}
          detail={`${trials.converted.toLocaleString()} converted / ${trials.completed.toLocaleString()} completed`}
        />
        <MetricCard
          label="Active trials"
          value={trials.activeNow.toLocaleString()}
          detail="Not yet included in conversion"
        />
        <MetricCard
          label="Trials started"
          value={trials.started.toLocaleString()}
          detail={
            trials.unresolved > 0
              ? `${trials.unresolved.toLocaleString()} outcomes unresolved`
              : "Started in the selected period"
          }
        />
        <MetricCard
          label="Canceled in trial"
          value={trials.canceled.toLocaleString()}
          detail="Canceled on or before trial expiry"
        />
      </InlineGrid>
      {trials.timeSeries.length ? (
        <Suspense
          fallback={
            <Card>
              <Spinner accessibilityLabel="Loading trial charts" size="small" />
            </Card>
          }
        >
          <PolarisVizProvider themes={chartThemes} defaultTheme="Mantle">
            <div className="reports-trial-toolbar">
              <Popover
                active={valueModeOpen}
                activator={
                  <Button
                    disclosure
                    onClick={() => setValueModeOpen((open) => !open)}
                  >
                    {showTrialValue
                      ? "Display trial value"
                      : "Display trial counts"}
                  </Button>
                }
                autofocusTarget="first-node"
                onClose={() => setValueModeOpen(false)}
              >
                <div className="reports-trial-choice">
                  <ChoiceList
                    title="Display"
                    titleHidden
                    choices={[
                      { label: "Display trial value", value: "value" },
                      { label: "Display trial counts", value: "counts" },
                    ]}
                    selected={[showTrialValue ? "value" : "counts"]}
                    onChange={(selected) => {
                      setShowTrialValue(selected[0] === "value");
                      setValueModeOpen(false);
                    }}
                  />
                </div>
              </Popover>

              <Popover
                active={paidPlansOpen}
                activator={
                  <Button
                    disclosure
                    onClick={() => setPaidPlansOpen((open) => !open)}
                  >
                    {paidPlansOnly ? "Paid plans only" : "Include free plans"}
                  </Button>
                }
                autofocusTarget="first-node"
                onClose={() => setPaidPlansOpen(false)}
              >
                <div className="reports-trial-choice">
                  <ChoiceList
                    title="Plans"
                    titleHidden
                    choices={[
                      { label: "Paid plans only", value: "paid" },
                      { label: "Include free plans", value: "all" },
                    ]}
                    selected={[paidPlansOnly ? "paid" : "all"]}
                    onChange={(selected) => {
                      setPaidPlansOnly(selected[0] === "paid");
                      setPaidPlansOpen(false);
                    }}
                  />
                </div>
              </Popover>
            </div>
            {/* Mantle's pair: value bars on the left axis, a rate line on the
                right. ComboChart takes one DataGroup per shape, each with its
                own yAxisOptions, which is what lets a percentage share a plot
                with dollars. */}
            <InlineGrid columns={{ xs: 1, lg: 2 }} gap="300">
              <TrialComboCard
                title="Trial conversion rate"
                valueMode={showTrialValue}
                info={TRIAL_INFO.conversion}
                rate={trialConversion.rate}
                stats={[
                  {
                    label: "Converted",
                    value: formatTrialAmount(
                      trialConversion.won,
                      showTrialValue,
                    ),
                  },
                  {
                    label: "Canceled",
                    value: formatTrialAmount(
                      trialConversion.lost,
                      showTrialValue,
                    ),
                  },
                ]}
                wonLabel="Converted trials"
                lostLabel="Canceled"
                rateLabel="Conversion rate"
                points={trialConversion.points}
              />
              <TrialComboCard
                title="Active trials"
                valueMode={showTrialValue}
                info={TRIAL_INFO.active}
                rate={trialRetention.rate}
                stats={[
                  {
                    label: "Active",
                    value: formatTrialAmount(
                      trialRetention.won,
                      showTrialValue,
                    ),
                  },
                  {
                    label: "Canceled",
                    value: formatTrialAmount(
                      trialRetention.lost,
                      showTrialValue,
                    ),
                  },
                ]}
                wonLabel="Active trials"
                lostLabel="Canceled"
                rateLabel="Retention rate"
                points={trialRetention.points}
              />
            </InlineGrid>
          </PolarisVizProvider>
        </Suspense>
      ) : null}

      <Card padding="0">
        <div className="reports-trial-history-head">
          <div>
            <Text as="h2" variant="headingMd">
              Trial history
              <InfoTip content={TRIAL_INFO.history} />
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              Trials that started in the selected period
            </Text>
          </div>
          <div className="reports-trial-stats">
            <div>
              <span>Active trials</span>
              <strong>
                {trialsPayload
                  ? trialsPayload.historyActive.toLocaleString()
                  : "—"}
              </strong>
            </div>
            <div>
              <span>Total value</span>
              <strong>{formatMoney(trialsPayload?.historyValue ?? 0)}</strong>
            </div>
          </div>
        </div>

        <div className="reports-trial-history-filters">
          <div className="reports-trial-history-search">
            <TextField
              label="Search trials"
              labelHidden
              placeholder="Search customer or plan"
              value={historyQuery}
              onChange={setHistoryQuery}
              autoComplete="off"
              clearButton
              onClearButtonClick={() => setHistoryQuery("")}
            />
          </div>
          <Popover
            active={historyStatusOpen}
            activator={
              <Button
                disclosure
                onClick={() => setHistoryStatusOpen((open) => !open)}
              >
                {TRIAL_STATUS_LABELS[historyStatus]}
              </Button>
            }
            autofocusTarget="first-node"
            onClose={() => setHistoryStatusOpen(false)}
          >
            <ActionList
              actionRole="menuitem"
              items={(
                ["all", "on_trial", "paying", "churned_during_trial"] as const
              ).map((value) => ({
                content: TRIAL_STATUS_LABELS[value],
                active: historyStatus === value,
                onAction: () => {
                  setHistoryStatusOpen(false);
                  setHistoryStatus(value);
                },
              }))}
            />
          </Popover>
        </div>

        {historyError ? (
          /* Distinct from "no matches": the filters are applied server-side,
             so a rejected request must not read as an empty result. */
          <div className="reports-trial-history-empty">
            <Text as="p" tone="critical">
              Couldn&rsquo;t load trials for this view. Check the browser
              console, then try again.
            </Text>
          </div>
        ) : trialHistory === null ? (
          <div className="reports-trial-history-empty">
            <SkeletonBodyText lines={5} />
          </div>
        ) : historyRows.length === 0 ? (
          <div className="reports-trial-history-empty">
            <Text as="p" tone="subdued">
              No trials match this view.
            </Text>
          </div>
        ) : (
          <div className="reports-trial-history-scroll">
            <table className="reports-trial-history-table">
              <thead>
                <tr>
                  <th scope="col">Customer</th>
                  <th scope="col">Plan</th>
                  <th scope="col">Trial start</th>
                  <th scope="col">Trial end</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {historyRows.map((row) => {
                  const status = TRIAL_STATUS_META[row.status];
                  return (
                    <tr key={`${row.appId}-${row.shopDomain}-${row.startedAt}`}>
                      <td>
                        <Link
                          className="reports-trial-history-link"
                          to={`/app/customers/${encodeURIComponent(row.shopDomain)}?app=${encodeURIComponent(row.appId)}`}
                        >
                          {row.customerName}
                        </Link>
                        <span className="reports-trial-history-sub">
                          {row.shopDomain}
                        </span>
                      </td>
                      <td>
                        <AppName
                          appName={row.planName}
                          logoUrl={row.appLogoUrl}
                        />
                        <span className="reports-trial-history-sub">
                          {`${formatMoney(row.monthlyAmount, row.currency)} ${
                            row.interval === "ANNUAL"
                              ? "per year"
                              : "every 30 days"
                          }`}
                        </span>
                      </td>
                      <td>{formatDate(row.startedAt)}</td>
                      <td>
                        {/* Mantle strikes the scheduled end through when a
                            merchant leaves early, and shows the real date
                            beneath — both facts matter. */}
                        {row.endedAt ? (
                          <>
                            <s className="reports-trial-history-sub">
                              {formatDate(row.expiresAt)}
                            </s>
                            <span>{formatDate(row.endedAt)}</span>
                          </>
                        ) : (
                          formatDate(row.expiresAt)
                        )}
                      </td>
                      <td>
                        <Badge tone={status.tone}>{status.label}</Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {historyPages > 1 ? (
          <div className="reports-trial-history-pagination">
            <Pagination
              hasPrevious={historyPage > 1}
              onPrevious={() => setHistoryPage((page) => page - 1)}
              hasNext={historyPage < historyPages}
              onNext={() => setHistoryPage((page) => page + 1)}
              label={`Page ${historyPage} of ${historyPages}`}
            />
          </div>
        ) : null}
      </Card>

      {PRODUCT_USAGE_ENABLED ? (
        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center">
              <BlockStack gap="100">
                <Text as="h2" variant="headingLg">
                  Product usage
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Telemetry reported by connected apps, separate from Shopify
                  usage-charge revenue.
                </Text>
              </BlockStack>
              <Badge tone={data.usage.length ? "success" : "attention"}>
                {`${data.sourceCoverage.usageEvents.toLocaleString()} event records`}
              </Badge>
            </InlineStack>

            {usageMetric ? (
              <>
                <Select
                  label="Usage metric"
                  options={data.usage.map((metric) => ({
                    label: metric.metric,
                    value: metric.metric,
                  }))}
                  value={usageMetric.metric}
                  onChange={setSelectedMetric}
                />
                <InlineGrid columns={{ xs: 1, md: 3 }} gap="300">
                  <MetricCard
                    label="Total quantity"
                    value={countFormatter(usageMetric.quantity)}
                    detail={
                      usageMetric.changeRate === null
                        ? "No comparable previous-period usage"
                        : `${usageMetric.changeRate >= 0 ? "+" : ""}${percent(
                            usageMetric.changeRate,
                          )} vs previous period`
                    }
                  />
                  <MetricCard
                    label="Event records"
                    value={usageMetric.eventCount.toLocaleString()}
                    detail="Idempotent telemetry records"
                  />
                  <MetricCard
                    label="Shops reporting"
                    value={usageMetric.activeInstalls.toLocaleString()}
                    detail="Distinct app installations"
                  />
                </InlineGrid>
                <Suspense
                  fallback={
                    <Spinner
                      accessibilityLabel="Loading usage chart"
                      size="small"
                    />
                  }
                >
                  <PolarisVizProvider
                    themes={chartThemes}
                    defaultTheme="Mantle"
                  >
                    <section className="reports-chart-card">
                      <div className="reports-chart-header">
                        <div>
                          <div className="reports-chart-label">
                            {usageMetric.metric}
                          </div>
                          <div className="reports-chart-value">
                            {countFormatter(usageMetric.quantity)}
                          </div>
                        </div>
                        <span className="reports-chart-badge">
                          {INTERVAL_LABELS[data.interval]}
                        </span>
                      </div>
                      <div
                        className="reports-chart-canvas"
                        aria-label={`${usageMetric.metric} usage over time`}
                      >
                        <LineChart
                          data={usageSeries}
                          showLegend={false}
                          yAxisOptions={{ labelFormatter: countFormatter }}
                        />
                      </div>
                    </section>
                  </PolarisVizProvider>
                </Suspense>
                <ChunkedDataTable
                  columnContentTypes={["text", "numeric", "numeric", "numeric"]}
                  headings={[
                    "Metric",
                    "Quantity",
                    "Event records",
                    "Shops reporting",
                  ]}
                  rows={data.usage.map((metric) => [
                    metric.metric,
                    countFormatter(metric.quantity),
                    metric.eventCount,
                    metric.activeInstalls,
                  ])}
                />
              </>
            ) : (
              <BlockStack gap="300">
                <EmptyState
                  heading="Connect product usage telemetry"
                  image={EMPTY_STATE_IMAGE}
                >
                  <p>
                    Shopify does not provide your app’s product usage events.
                    Connected apps must send them to this internal endpoint.
                  </p>
                </EmptyState>
                <div className="reports-integration-example">
                  <Text as="p" variant="headingSm">
                    POST /api/flex/usage
                  </Text>
                  <pre>
                    {`{
  "shopDomain": "store.myshopify.com",
  "metric": "orders_processed",
  "quantity": 1,
  "idempotencyKey": "usage_evt_12345678"
}`}
                  </pre>
                </div>
              </BlockStack>
            )}
          </BlockStack>
        </Card>
      ) : null}
    </BlockStack>
  );
}

export default function Reports({ loaderData }: Route.ComponentProps) {
  const {
    appId: initialAppId,
    apps,
    interval: initialInterval,
    period: initialPeriod,
    report,
    trafficSources,
    trafficInsights,
    trafficAppId,
    trafficDateRange,
    trafficCompareMode,
    trafficCompareDateRange,
    trafficSavedFilters,
    insightsSavedViews,
  } = loaderData;
  const navigate = useNavigate();
  /* App and period are no longer local state: the toolbar navigates and reads
     its labels back off the URL, so the control cannot show a filter the
     report is not rendering. Chart interval is gone entirely — the loader
     derives the bucket size from the range. */
  const [periodFilterOpen, setPeriodFilterOpen] = useState(false);
  /*
    Trials default ON here (user's call, 2026-09-20), monthly/annual/usage too.

    This is deliberately NOT `COMMITTED_MRR`, and the difference matters: that
    constant is the committed definition (trials excluded) and stays the basis
    for the Overview's MRR card, so with trials on this report now headlines a
    LARGER figure than the Overview does — by roughly the active trial
    value. It also moves away from Mantle, which reports
    MRR without trials.

    Both were reconciled earlier precisely because they had drifted apart. If
    the two should agree again, the fix is one of: pass COMMITTED_MRR here, or
    give the Overview the same trials-on composition — not a third definition.
  */
  const [revenueComponents, setRevenueComponents] = useState<RevenueComponents>(
    { ...COMMITTED_MRR, trials: true },
  );
  const [revenueFilterOpen, setRevenueFilterOpen] = useState(false);
  const [reports, setReports] = useState<Partial<AnalyticsReports>>({});
  const [sourceErrors, setSourceErrors] = useState<
    Array<{ appId: string; appName: string; message: string }>
  >([]);
  const [historyState, setHistoryState] = useState<{
    recentComplete: boolean;
    annualComplete: boolean;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncPending, setSyncPending] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyTimedOut, setHistoryTimedOut] = useState(false);
  const [historySampled, setHistorySampled] = useState(false);
  // Whether the last "fast" response was already the persisted (exact)
  // Partner reconstruction rather than a live estimate — the auto-upgrade
  // effect below must skip re-verifying it, since re-walking Shopify would
  // just double-check a number that was never an approximation.
  const [fastResultPersisted, setFastResultPersisted] = useState(false);
  const [freshness, setFreshness] = useState<PartnerFreshnessView | null>(null);
  const [syncErrors, setSyncErrors] = useState<
    Array<{ appId: string; appName: string; message: string }>
  >([]);
  const [loadError, setLoadError] = useState("");
  const [reportFilter, setReportFilter] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [requestMode, setRequestMode] = useState<"fast" | "sampled" | "exact">(
    "fast",
  );
  const requestModeRef = useRef(requestMode);
  // Guards the automatic history load so it fires at most once per filter
  // combination, even as freshness polling re-renders the page.
  const autoHistoryRequestedRef = useRef(false);
  const metric =
    report === "revenue"
      ? "revenue"
      : report === "ltv"
        ? "ltv"
        : report === "churn"
          ? "churn"
          : "mrr";
  // Overview/Growth/Trials/Retention share the "mrr" metric — switching among
  // them must not refetch. `report` itself can't drive the effect's deps
  // (it changes on every tab click), so this key is metric-equivalent except
  // for "traffic", which the effect handles separately.
  /* Both traffic reports read GA4/BigQuery, not the billing metrics every
     other tab shares — so neither fetches those metrics, auto-loads billing
     history, or shows the billing freshness badge. The period picker is NOT
     part of this: insights uses the shared one, while Traffic source trends
     has its own date-range control. */
  const usesTrafficData = report === "traffic" || report === "insights";
  const fetchScope = usesTrafficData ? "traffic" : metric;

  useEffect(() => {
    setRequestMode("fast");
    setHistoryTimedOut(false);
    setHistorySampled(false);
    setFastResultPersisted(false);
    autoHistoryRequestedRef.current = false;
  }, [initialAppId, initialInterval, initialPeriod]);

  useEffect(() => {
    requestModeRef.current = requestMode;
  }, [requestMode]);

  // Once Shopify history is fully imported, auto-load the trend without a
  // click — always in *sampled* mode, since an exact scan pages every
  // transaction and would burn Partner API quota before the account has
  // converged. The exact all-app scan stays an explicit user choice.
  //
  // Skipped once `fastResultPersisted` is true: `freshness.exact` says the
  // account's history has converged, but not whether *this* request's "fast"
  // response already came from the persisted (exact) reconstruction. Without
  // this check, an already-exact result triggered a redundant live "sampled"
  // Shopify walk on every load (production, 2026-08-09).
  useEffect(() => {
    if (usesTrafficData || metric !== "mrr") return;
    if (!freshness?.exact || fastResultPersisted) return;
    if (autoHistoryRequestedRef.current) return;
    // Never pre-empt a request the user started, or retry one that just timed
    // out — that would put the page in a refresh loop.
    if (requestMode !== "fast" || historyTimedOut) return;
    if (loading || syncing || historyLoading) return;

    autoHistoryRequestedRef.current = true;
    setRequestMode("sampled");
  }, [
    fastResultPersisted,
    freshness?.exact,
    historyLoading,
    historyTimedOut,
    loading,
    metric,
    report,
    requestMode,
    syncing,
  ]);

  useEffect(() => {
    const handleAutomaticSync = (event: Event) => {
      const detail = (event as CustomEvent).detail as
        | {
            fresh?: boolean;
            dataChanged?: boolean;
            freshness?: PartnerFreshnessView;
          }
        | undefined;
      if (detail?.freshness) setFreshness(detail.freshness);
      setSyncPending(detail?.fresh === false);

      // Background sync runs on mount, every 5 min, and on tab refocus, and
      // usually finds nothing new — refetching regardless meant a redundant
      // full report computation for identical numbers. Only a sync that
      // actually wrote facts should invalidate what's on screen.
      if (detail?.dataChanged !== true) return;

      // Never turn a background freshness check into another sampled/exact
      // Shopify history request or cancel a history request the user started.
      if (requestModeRef.current === "fast") {
        setHistoryTimedOut(false);
        setHistorySampled(false);
        setRefreshKey((current) => current + 1);
      }
    };
    window.addEventListener("shopify-sync-updated", handleAutomaticSync);
    return () =>
      window.removeEventListener("shopify-sync-updated", handleAutomaticSync);
  }, []);

  useEffect(() => {
    // The index shows no data, so it must not pull any: this page's fetch is the
    // most expensive on the dashboard.
    if (report === null) {
      setLoading(false);
      return;
    }
    if (fetchScope === "traffic") {
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    const historyRequest = requestMode !== "fast";
    const params = new URLSearchParams({
      period: initialPeriod,
      interval: initialInterval,
    });
    if (initialAppId) params.set("appId", initialAppId);
    if (metric === "mrr") params.set("mode", requestMode);
    if (refreshKey > 0) params.set("refresh", String(refreshKey));
    if (historyRequest) {
      setHistoryLoading(true);
      setHistoryTimedOut(false);
    } else {
      setLoading(true);
      setLoadError("");
      setSourceErrors([]);
      setHistoryState(null);
      setReports({});
    }

    let exactTimedOut = false;
    const exactTimer = historyRequest
      ? window.setTimeout(() => {
          exactTimedOut = true;
          controller.abort();
        }, 15_000)
      : undefined;

    void fetch(`/api/metrics/${metric}?${params.toString()}`, {
      signal: controller.signal,
      cache: "no-store",
      headers: { Accept: "application/json" },
    })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) {
          throw new Error(
            body.error ?? "Shopify analytics could not be loaded.",
          );
        }
        return body as {
          metric: string;
          data: PortfolioReport | RevenueReport | LtvReport | ChurnReport;
          source?: {
            provider?: string;
            persisted?: boolean;
            annualHistoryComplete?: boolean;
            recentHistoryComplete?: boolean;
            historySampled?: boolean;
            errors?: Array<{
              appId: string;
              appName: string;
              message: string;
            }>;
            freshness?: PartnerFreshnessView;
          };
        };
      })
      .then((response) => {
        if (response.metric === "mrr" || response.metric === "portfolio") {
          setReports({ portfolio: response.data as PortfolioReport });
        } else if (response.metric === "revenue") {
          setReports({ revenue: response.data as RevenueReport });
        } else if (response.metric === "ltv") {
          setReports({ ltv: response.data as LtvReport });
        } else if (response.metric === "churn") {
          setReports({ churn: response.data as ChurnReport });
        }
        setSourceErrors(response.source?.errors ?? []);
        setFreshness(response.source?.freshness ?? null);
        setHistorySampled(response.source?.historySampled ?? false);
        if (!historyRequest) {
          setFastResultPersisted(response.source?.persisted === true);
        }
        if (
          typeof response.source?.recentHistoryComplete === "boolean" &&
          typeof response.source?.annualHistoryComplete === "boolean"
        ) {
          setHistoryState({
            recentComplete: response.source.recentHistoryComplete,
            annualComplete: response.source.annualHistoryComplete,
          });
        }
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") {
          if (historyRequest && exactTimedOut) {
            setHistoryTimedOut(true);
            setRequestMode("fast");
          }
          return;
        }
        if (!historyRequest) {
          setLoadError(
            error instanceof Error
              ? error.message
              : "Shopify analytics could not be loaded.",
          );
        }
      })
      .finally(() => {
        if (historyRequest) setHistoryLoading(false);
        else if (!controller.signal.aborted) setLoading(false);
        if (exactTimer) window.clearTimeout(exactTimer);
      });

    return () => {
      controller.abort();
      if (exactTimer) window.clearTimeout(exactTimer);
    };
  }, [
    initialAppId,
    initialInterval,
    initialPeriod,
    fetchScope,
    refreshKey,
    report,
    requestMode,
    historyTimedOut,
  ]);

  const filteredPortfolio = useMemo(
    () =>
      reports.portfolio
        ? filterRecurringRevenue(reports.portfolio, revenueComponents)
        : undefined,
    [reports.portfolio, revenueComponents],
  );

  /**
   * The interval the DATA came back on, which is not always the one asked for.
   *
   * `capReportInterval` coarsens the request server-side to bound the bucket
   * count — "All time" at daily granularity is ~1,760 buckets and was a real
   * source of 504s — so an all-time report arrives monthly however the Chart
   * interval control is set. Formatting those monthly buckets with the
   * REQUESTED interval is what printed an axis of "Nov 10, 2021 / Nov 1, 2022"
   * against a header claiming a "daily view". Read the envelope instead; fall
   * back to the request only before the first response lands.
   */
  const effectiveInterval: AnalyticsInterval =
    reports.portfolio?.interval ??
    reports.revenue?.interval ??
    reports.churn?.interval ??
    initialInterval;
  /**
   * What the header says the report covers. On Traffic the panel's own picker
   * wins over the (now hidden) period control, so naming the period here would
   * describe a range that isn't being used. Mirrors the traffic toolbar's own
   * label so the two can never disagree.
   */
  const effectiveRangeLabel =
    report === "traffic" && trafficDateRange
      ? `${shortDate(parseIsoDateUtc(trafficDateRange.start)!)} - ${shortDate(
          parseIsoDateUtc(trafficDateRange.end)!,
        )}`
      : PERIOD_LABELS[initialPeriod];
  const [searchParams] = useSearchParams();
  /**
   * Applies a filter change by navigating, so the URL stays the single source
   * of truth for what the report is showing.
   *
   * `interval` is deliberately never written. The loader derives the bucket
   * size from the range, and carrying an explicit interval in the URL is what
   * the removed control did — it let a stale link pin a bucket size that no
   * longer suits the range.
   */
  const applyReportFilters = (next: {
    appId?: string;
    period?: AnalyticsPeriod;
  }) => {
    const params = new URLSearchParams();
    if (report) params.set("report", report);
    const nextAppId = next.appId ?? initialAppId;
    if (nextAppId) params.set("appId", nextAppId);
    params.set("period", next.period ?? initialPeriod);
    // Carry the Traffic panel's own view config across an app/period change.
    // It has its own pivot, funnel-event, per-dimension filter, date-range
    // and compare selections in the URL (`traffic*` / `filter_*` — see
    // `trafficUrl`), and now that the panel's duplicate app picker is gone,
    // this selector is the only way to change app while that view is open.
    // Rebuilding the query string from scratch used to wipe all of it.
    //
    // `interval` is still deliberately omitted (the manager's "track MRR, not
    // daily recurring revenue"); the loader derives one from the period.
    for (const [key, value] of searchParams) {
      if (
        key.startsWith("traffic") ||
        key.startsWith("filter_") ||
        // The insights report's Event and Metric (`insightEvent`, `insightMetric`).
        key.startsWith("insight")
      ) {
        params.set(key, value);
      }
    }
    // The row set changes underneath, so any page but the first is meaningless.
    if (params.has("trafficPage")) params.set("trafficPage", "1");
    navigate(`?${params.toString()}`);
  };
  const neverBilledUrl = `/app/reports/never-billed${
    initialAppId ? `?appId=${initialAppId}` : ""
  }`;
  const selectedAppName =
    apps.find((app) => app.id === initialAppId)?.name ?? "All apps";
  const dataStatus = syncing
    ? "Syncing latest Shopify data"
    : syncPending
      ? "Shopify sync in progress"
      : historyLoading
        ? "Refreshing history"
        : historySampled
          ? "Sampled trend"
          : freshness?.exact
            ? "Current exact billing data"
            : freshness?.fresh
              ? "Latest window synced"
              : freshness?.freshThrough
                ? `Synced ${formatDateTime(freshness.freshThrough)}`
                : "Shopify sync required";
  const dataStatusTone: "success" | "attention" | "warning" =
    syncing || syncPending
      ? "attention"
      : freshness?.exact
        ? "success"
        : freshness?.freshThrough
          ? "attention"
          : "warning";

  async function refreshLiveData() {
    setSyncing(true);
    setSyncPending(false);
    setLoadError("");
    setSyncErrors([]);
    try {
      const params = new URLSearchParams();
      if (initialAppId) params.set("appId", initialAppId);
      const syncUrl = `/api/metrics-sync${params.size ? `?${params.toString()}` : ""}`;
      let latestBody: MetricsSyncResponse | null = null;

      for (let attempt = 0; attempt < MANUAL_SYNC_MAX_ATTEMPTS; attempt += 1) {
        const response = await fetch(syncUrl, {
          method: "POST",
          cache: "no-store",
          headers: { Accept: "application/json" },
        });
        const body = (await response.json()) as MetricsSyncResponse;
        latestBody = body;
        if (!response.ok && response.status !== 202) {
          // 503 here means no app has a usable Shopify Partner connection for
          // billing/lifecycle sync — irrelevant to Traffic, whose GA4/BigQuery
          // sync is independent and best-effort (already reflected in
          // body.errors). Only treat it as fatal for the billing-backed tabs.
          if (response.status === 503 && usesTrafficData) {
            setFreshness(body.freshness ?? null);
            setSyncErrors(
              (body.errors ?? []).map((message) => ({
                appId: "shopify-sync",
                appName: "Shopify",
                message,
              })),
            );
            setSyncPending(false);
            break;
          }
          throw new Error(body.error ?? "Live Shopify refresh failed.");
        }

        setFreshness(body.freshness ?? null);
        setSyncErrors(
          (body.errors ?? []).map((message) => ({
            appId: "shopify-sync",
            appName: "Shopify",
            message,
          })),
        );
        if (body.fresh === true) {
          setSyncPending(false);
          break;
        }

        setSyncPending(true);
        if (attempt < MANUAL_SYNC_MAX_ATTEMPTS - 1) {
          const waitMs = retryAfterMilliseconds(
            response.headers.get("Retry-After"),
            body.inProgress ? 5 : 2,
          );
          await new Promise((resolve) => window.setTimeout(resolve, waitMs));
        }
      }

      setSyncPending(latestBody?.fresh !== true);
      setHistoryTimedOut(false);
      setHistorySampled(false);
      setRequestMode("fast");
      // Re-arm the automatic history load. Without this a manual refresh would
      // drop the chart back to its placeholder and never rebuild it, because
      // the guard below only clears when the filters change.
      autoHistoryRequestedRef.current = false;
      setRefreshKey((current) => current + 1);
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : "Live Shopify refresh failed.",
      );
    } finally {
      setSyncing(false);
    }
  }

  if (report === null) {
    /* Find-as-you-type narrowing of a list already on screen — not a state
       worth putting in the URL. */
    const needle = reportFilter.trim().toLowerCase();
    const groups = REPORT_GROUPS.map((group) => ({
      ...group,
      matches: group.reports.filter(
        (name) =>
          !needle ||
          REPORT_META[name].label.toLowerCase().includes(needle) ||
          REPORT_META[name].description.toLowerCase().includes(needle),
      ),
    })).filter((group) => group.matches.length > 0);

    return (
      <Page
        fullWidth
        title="Reports"
        secondaryActions={[
          {
            content: "Never billed charges",
            url: `/app/reports/never-billed${initialAppId ? `?appId=${initialAppId}` : ""}`,
          },
        ]}
      >
        <div className="reports-workspace">
          <InlineGrid columns={{ xs: 1, md: "18rem 1fr" }} gap="500">
            <BlockStack gap="300">
              <TextField
                label="Filter reports"
                labelHidden
                autoComplete="off"
                placeholder="Filter reports…"
                value={reportFilter}
                onChange={setReportFilter}
                clearButton
                onClearButtonClick={() => setReportFilter("")}
              />
              {/* Section links, not filters: they jump to a heading rather than
                  hiding the rest, so the whole catalogue stays scannable. */}
              <Card padding="0">
                <BlockStack gap="0">
                  {REPORT_GROUPS.map((group) => (
                    <button
                      key={group.id}
                      type="button"
                      className="reports-index-section-link"
                      onClick={() =>
                        document
                          .getElementById(`reports-section-${group.id}`)
                          ?.scrollIntoView({
                            behavior: "smooth",
                            block: "start",
                          })
                      }
                    >
                      <Text as="span" variant="bodySm" fontWeight="medium">
                        {group.title}
                      </Text>
                    </button>
                  ))}
                </BlockStack>
              </Card>
            </BlockStack>

            <BlockStack gap="600">
              {groups.length === 0 ? (
                <Card>
                  <Text as="p" tone="subdued">
                    No report matches “{reportFilter}”.
                  </Text>
                </Card>
              ) : (
                groups.map((group) => (
                  <BlockStack gap="300" key={group.id}>
                    <div id={`reports-section-${group.id}`}>
                      <Text as="h2" variant="headingMd">
                        {group.title}
                      </Text>
                    </div>
                    <div className="reports-index-grid">
                      {group.matches.map((name) => (
                        <Link
                          key={name}
                          className="reports-index-card"
                          to={reportUrl(
                            name,
                            initialPeriod,
                            initialAppId,
                            initialInterval,
                          )}
                        >
                          <Card>
                            <BlockStack gap="150">
                              <Text as="h3" variant="headingSm">
                                {REPORT_META[name].label}
                              </Text>
                              <Text as="p" tone="subdued" variant="bodySm">
                                {REPORT_META[name].description}
                              </Text>
                            </BlockStack>
                          </Card>
                        </Link>
                      ))}
                    </div>
                  </BlockStack>
                ))
              )}
            </BlockStack>
          </InlineGrid>
        </div>
      </Page>
    );
  }

  return (
    <Page
      fullWidth
      title="Reports"
      backAction={{ content: "Reports", url: "/app/reports" }}
      secondaryActions={[
        {
          content: syncing
            ? "Syncing Shopify…"
            : syncPending
              ? "Check sync progress"
              : "Refresh data",
          disabled: loading || historyLoading || syncing,
          onAction: () => void refreshLiveData(),
        },
      ]}
    >
      <div className="reports-workspace">
        <BlockStack gap="400">
          {sourceErrors.length || syncErrors.length ? (
            <Banner
              tone="warning"
              title="Some live financials could not be loaded"
            >
              {[...sourceErrors, ...syncErrors]
                .map((error) => `${error.appName}: ${error.message}`)
                .join(" ")}
            </Banner>
          ) : null}
          {historyState &&
          (!historyState.recentComplete || !historyState.annualComplete) ? (
            <Banner
              tone="info"
              title={
                historyLoading
                  ? `Loading ${
                      requestMode === "sampled" ? "sampled" : "exact"
                    } ${INTERVAL_LABELS[initialInterval].toLowerCase()} history`
                  : historyTimedOut
                    ? "History request stopped"
                    : historySampled
                      ? "Fast sampled trend loaded"
                      : historyState.recentComplete
                        ? "MRR loaded; annual history is still refining"
                        : "Current MRR loaded"
              }
              action={
                historyLoading
                  ? undefined
                  : {
                      content: initialAppId
                        ? historyState.recentComplete
                          ? "Refine annual history"
                          : "Load exact history"
                        : historySampled
                          ? "Refresh sampled trend"
                          : "Load sampled trend",
                      onAction: () => {
                        const nextMode = initialAppId ? "exact" : "sampled";
                        if (requestMode === nextMode) {
                          setRefreshKey((current) => current + 1);
                        } else {
                          setRequestMode(nextMode);
                        }
                      },
                    }
              }
            >
              {historyLoading
                ? "This request stops automatically after 15 seconds so it cannot keep the dashboard refreshing forever."
                : historyTimedOut
                  ? "Shopify could not return the full transaction window within 15 seconds. The current MRR remains available; choose a shorter period before trying again."
                  : historySampled
                    ? "The chart uses a three-day Shopify run-rate sample at each bucket. It shows direction quickly without persisting MRR; choose one app to request exact transaction history."
                    : historyState.recentComplete
                      ? "The exact recent window is ready. Shopify’s trailing-year annual history is warming in the background."
                      : initialAppId
                        ? "The current MRR is ready. Historical transactions are fetched only when you request the chart."
                        : "The current MRR is ready. Select one app to load history; an exact all-app transaction scan is intentionally not started automatically."}
            </Banner>
          ) : null}
          {/* Mantle's toolbar: a compact row of dropdowns that apply on
              selection, rather than a form with an Apply button. The labels
              read from the URL (`initialAppId`/`initialPeriod`), not local
              state, so the control can never show a filter the report is not
              actually rendering.

              There is deliberately NO chart-interval control. It invited
              reading the bars as revenue earned per interval, when every
              series here is MRR — a level sampled per bucket. The bucket size
              is derived from the range by the loader instead. */}
          <section className="reports-toolbar reports-toolbar--inline">
            <InlineStack gap="200" blockAlign="center" wrap>
              {/* The shared picker, not a hand-rolled popover: it draws each
                  app's logo (with a generated monogram where one is missing, so
                  labels stay aligned) and is the same control the rest of
                  Reports uses. `AppPicker` is `fullWidth`, which would stretch
                  across this row, so it is bounded here instead. */}
              <div className="reports-toolbar-control">
                <AppPicker
                  label="App"
                  labelHidden
                  value={initialAppId}
                  apps={apps}
                  onChange={(value) => applyReportFilters({ appId: value })}
                />
              </div>
              {/* Traffic carries its own date picker, and the loader lets it
                  OVERRIDE this one (see resolveAnalyticsRange +
                  hasCustomTrafficRange). Two controls where only one wins read
                  as a contradiction — the toolbar said "Last 30 days" while the
                  chart plotted a year. Only the winning control is shown. */}
              {report === "traffic" ? null : (
                <Popover
                  active={periodFilterOpen}
                  activator={
                    <Button
                      disclosure
                      onClick={() => setPeriodFilterOpen((open) => !open)}
                    >
                      {PERIOD_LABELS[initialPeriod]}
                    </Button>
                  }
                  autofocusTarget="first-node"
                  onClose={() => setPeriodFilterOpen(false)}
                >
                  <ActionList
                    actionRole="menuitem"
                    items={ANALYTICS_PERIODS.map((value) => ({
                      content: PERIOD_LABELS[value],
                      active: initialPeriod === value,
                      onAction: () => {
                        setPeriodFilterOpen(false);
                        applyReportFilters({ period: value });
                      },
                    }))}
                  />
                </Popover>
              )}
              <Popover
                active={revenueFilterOpen}
                activator={
                  <Button
                    disclosure
                    onClick={() => setRevenueFilterOpen((current) => !current)}
                  >
                    Revenue sources
                  </Button>
                }
                autofocusTarget="first-node"
                onClose={() => setRevenueFilterOpen(false)}
              >
                <Popover.Pane fixed>
                  <div style={{ padding: "var(--p-space-400)", width: 280 }}>
                    <BlockStack gap="300">
                      <Text as="h3" variant="headingSm">
                        Include in recurring revenue
                      </Text>
                      <Checkbox
                        label="Annual plans"
                        checked={revenueComponents.annual}
                        onChange={(annual) =>
                          setRevenueComponents((current) => ({
                            ...current,
                            annual,
                          }))
                        }
                      />
                      <Checkbox
                        label="Usage charges"
                        checked={revenueComponents.usage}
                        onChange={(usage) =>
                          setRevenueComponents((current) => ({
                            ...current,
                            usage,
                          }))
                        }
                      />
                      <Checkbox
                        label="Trial MRR"
                        helpText="Adds the plan value of merchants currently mid-trial. On by default here; a trial is not committed revenue, so comparable tools (and this dashboard's Overview) report MRR without it."
                        checked={revenueComponents.trials}
                        onChange={(trials) =>
                          setRevenueComponents((current) => ({
                            ...current,
                            trials,
                          }))
                        }
                      />
                    </BlockStack>
                  </div>
                </Popover.Pane>
              </Popover>
              {loading ? (
                <InlineStack gap="150" blockAlign="center">
                  <Spinner accessibilityLabel="Refreshing report" size="small" />
                  <Text as="span" variant="bodySm" tone="subdued">
                    Updating report…
                  </Text>
                </InlineStack>
              ) : null}
            </InlineStack>
          </section>

          <section className="reports-results-shell">
            <div className="reports-results-header">
              <div>
                <Text as="h2" variant="headingMd">
                  {REPORT_META[report].label}
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  {selectedAppName} · {effectiveRangeLabel} ·{" "}
                  {INTERVAL_LABELS[effectiveInterval].toLowerCase()} view
                </Text>
              </div>
              {usesTrafficData ? null : (
                <Badge tone={historySampled ? "attention" : dataStatusTone}>
                  {historySampled
                    ? "Sampled history"
                    : freshness?.exact
                      ? "Current exact billing data"
                      : freshness?.fresh
                        ? "Latest window synced"
                        : freshness?.freshThrough
                          ? `Synced ${formatDate(freshness.freshThrough)}`
                          : "Sync required"}
                </Badge>
              )}
            </div>
            {/* No tab strip: reports are reached from the index card grid,
                and the page's own backAction returns there. */}
            <div>
              <div className="reports-results-content">
                <div id={PAGE_CONTENT_ANCHOR_ID} />
                {loading ? (
                  <ReportSkeleton />
                ) : loadError ? (
                  <Banner tone="critical" title="Analytics could not be loaded">
                    <BlockStack gap="300">
                      <p>{loadError}</p>
                      <InlineStack>
                        <Button
                          onClick={() =>
                            setRefreshKey((current) => current + 1)
                          }
                        >
                          Try again
                        </Button>
                      </InlineStack>
                    </BlockStack>
                  </Banner>
                ) : report === "insights" && trafficInsights ? (
                  <TrafficInsightsPanel
                    report={trafficInsights}
                    appId={trafficAppId}
                    period={initialPeriod}
                    apps={apps}
                    savedViews={insightsSavedViews}
                  />
                ) : report === "traffic" && trafficSources ? (
                  <TrafficSourcesPanel
                    data={trafficSources}
                    period={initialPeriod}
                    appId={trafficAppId}
                    apps={apps}
                    interval={initialInterval}
                    dateRange={trafficDateRange}
                    compareMode={trafficCompareMode}
                    compareDateRange={trafficCompareDateRange}
                    savedFilters={trafficSavedFilters}
                  />
                ) : report === "revenue" && reports.revenue ? (
                  <RevenuePanel data={reports.revenue} />
                ) : report === "growth" && filteredPortfolio ? (
                  <GrowthPanel
                    data={filteredPortfolio}
                    interval={effectiveInterval}
                    sampled={historySampled}
                    components={revenueComponents}
                    neverBilledUrl={neverBilledUrl}
                  />
                ) : report === "ltv" && reports.ltv ? (
                  <LtvPanel data={reports.ltv} />
                ) : report === "churn" && reports.churn ? (
                  <ChurnPanel data={reports.churn} />
                ) : report === "retention" && filteredPortfolio ? (
                  <RetentionPanel data={filteredPortfolio} />
                ) : filteredPortfolio ? (
                  <UsagePanel
                    data={filteredPortfolio}
                    period={initialPeriod}
                    appId={initialAppId}
                  />
                ) : (
                  <EmptyState
                    heading="No report data returned"
                    image={EMPTY_STATE_IMAGE}
                  >
                    <p>Try refreshing this report.</p>
                  </EmptyState>
                )}
              </div>
            </div>
          </section>
        </BlockStack>
      </div>
    </Page>
  );
}
