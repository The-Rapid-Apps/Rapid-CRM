import type {
  ChurnReport,
  LtvReport,
  PortfolioReport,
  RevenueReport,
} from "~/lib/reports/analytics.server";
import { COMMITTED_MRR, composeMrr } from "~/lib/reports/mrr-components";

/**
 * The Overview's headline metrics, in Mantle's own three groups.
 *
 * Client-safe (`.ts`, no Prisma) because the Overview fetches its reports from
 * /api/metrics/* in the browser rather than through the loader — see that
 * page's load-time note. Importing `analytics.server.ts` for VALUES here would
 * pull Prisma into the client bundle; only its TYPES are imported, which erase.
 *
 * Nothing here recomputes a metric. Each figure is read from the report that
 * already owns it, so the Overview and Reports can never disagree:
 *   Revenue        MRR + growth rate  <- recurring    Gross earnings <- revenue
 *   Subscriptions  Active             <- recurring    ARPU, LTV      <- ltv
 *   Churn          Revenue, Subscription, Logo        <- churn
 */

export interface OverviewMetric {
  key: string;
  label: string;
  /** Preformatted — the caller owns currency and percentage formatting. */
  value: string;
  /** Period-over-period change. Null when the series is too short to have one. */
  delta: { label: string; direction: "up" | "down" } | null;
  /** Whether a rise is good. Churn rising is bad; MRR rising is good. */
  riseIsGood: boolean;
  /** How the tooltip should render a point of this series. */
  format: "money" | "percent" | "count";
  /** Sparkline shape. Empty renders the card without a chart, not a broken one. */
  series: number[];
  /** Bucket labels aligned index-for-index with `series`, for the tooltip's
   * heading — a chart that says "$12,345.67" without saying which day is a
   * decoration, not a reading. */
  labels: string[];
  /** The same metric one window earlier, plotted dashed against the CURRENT
   * labels (see app-dashboard.tsx's comparison series for why the x positions
   * are shared). Absent unless the report supplied one. */
  comparison?: number[];
  /** What the main series is called in the tooltip. Defaults to `label`;
   * Gross earnings reads "Revenue" there, as Mantle's does. */
  seriesName?: string;
}

export interface OverviewMetricGroup {
  key: "revenue" | "subscriptions" | "churn";
  title: string;
  metrics: OverviewMetric[];
}

const percent = (value: number): string => `${(value * 100).toFixed(2)}%`;

const count = (value: number): string => value.toLocaleString();

/**
 * Change across the series, as a percentage of where it started.
 *
 * Deliberately derived from the report's OWN buckets rather than a second
 * request for the previous period: it costs nothing, and it can't disagree
 * with the sparkline drawn right beside it. The tradeoff is that it measures
 * movement WITHIN the range, where Mantle compares against the preceding one —
 * same direction, not always the same number.
 */
function changeFromSeries(
  series: number[],
): { label: string; direction: "up" | "down" } | null {
  const points = series.filter((value) => Number.isFinite(value));
  if (points.length < 2) return null;
  const first = points[0];
  const last = points[points.length - 1];
  if (first === 0) return null;
  const change = (last - first) / Math.abs(first);
  if (!Number.isFinite(change) || change === 0) return null;
  return {
    label: `${(Math.abs(change) * 100).toFixed(2)}%`,
    direction: change > 0 ? "up" : "down",
  };
}

function absoluteChange(
  value: number,
  format: (value: number) => string,
): { label: string; direction: "up" | "down" } | null {
  if (value === 0) return null;
  return {
    label: format(Math.abs(value)),
    direction: value > 0 ? "up" : "down",
  };
}

/** The reporting currency: whichever carries the most MRR. Multi-currency
 * portfolios are summed for counts but never for money, which can't be added
 * across currencies without a rate — see the revenue banner's USD work. */
function primaryCurrency(
  recurring: PortfolioReport["recurring"] | null,
): string | null {
  if (!recurring || recurring.currencies.length === 0) return null;
  return [...recurring.currencies].sort((a, b) => b.mrr - a.mrr)[0].currency;
}

export function buildOverviewMetricGroups(params: {
  recurring: PortfolioReport["recurring"] | null;
  revenue: (RevenueReport & { comparison?: RevenueReport["currencies"] }) | null;
  ltv: LtvReport | null;
  churn: ChurnReport | null;
  formatMoney: (value: number, currency?: string) => string;
}): OverviewMetricGroup[] {
  const { recurring, revenue, ltv, churn, formatMoney } = params;
  const currency = primaryCurrency(recurring);
  const money = (value: number) => formatMoney(value, currency ?? undefined);

  const summary = currency
    ? (recurring?.currencies.find((entry) => entry.currency === currency) ??
      null)
    : null;
  const bucketLabels =
    recurring?.timeSeries
      .filter((point) => !currency || point.currency === currency)
      .map((point) => point.periodStart) ?? [];
  const mrrSeries =
    recurring?.timeSeries
      .filter((point) => !currency || point.currency === currency)
      .map((point) => point.mrr) ?? [];
  /* Bucket-over-bucket change, so the first bucket has no rate — hence the
     labels are sliced to match. */
  const growthRateSeries = mrrSeries
    .map((value, index) =>
      index === 0 || mrrSeries[index - 1] === 0
        ? null
        : (value - mrrSeries[index - 1]) / mrrSeries[index - 1],
    )
    .filter((value): value is number => value !== null);
  const activeSeries =
    recurring?.timeSeries
      .filter((point) => !currency || point.currency === currency)
      .map((point) => point.activeSubscriptions) ?? [];

  const revenueCurrency =
    revenue?.currencies.find((entry) => entry.currency === currency) ??
    revenue?.currencies[0] ??
    null;
  const ltvCurrency =
    ltv?.currencies.find((entry) => entry.currency === currency) ??
    ltv?.currencies[0] ??
    null;
  const revenueComparison =
    revenue?.comparison?.find((entry) => entry.currency === currency) ??
    revenue?.comparison?.[0] ??
    null;
  const revenueChurn = churn?.grossRevenue.currencies[0] ?? null;

  return [
    {
      key: "revenue",
      title: "Revenue",
      metrics: [
        {
          key: "mrr",
          label: "MRR",
          /* COMMITTED MRR, matching what Reports headlines — the raw `mrr`
             field is GROSS, with active trials folded in. */
          value: summary ? money(composeMrr(summary, COMMITTED_MRR)) : "—",
          delta: summary
            ? absoluteChange(summary.netMrrGrowth, money)
            : null,
          riseIsGood: true,
          series: mrrSeries,
          format: "money",
          labels: bucketLabels,
        },
        {
          key: "mrr_growth",
          label: "MRR growth rate",
          value: summary ? percent(summary.growthRate) : "—",
          delta: changeFromSeries(mrrSeries),
          riseIsGood: true,
          /* Its OWN series, not MRR's: the tile reports a rate, so a tooltip
             reading off the MRR line would answer a different question than
             the figure above it. */
          series: growthRateSeries,
          format: "percent",
          labels: bucketLabels.slice(1),
        },
        {
          key: "gross_earnings",
          label: "Gross earnings",
          /* Mantle labels this series "Revenue" in the tooltip while the tile
             above says "Gross earnings" — the tile names the metric, the
             tooltip names the line it sits beside. */
          seriesName: "Revenue",
          comparison: revenueComparison?.timeSeries.map((point) => point.gross),
          value: revenueCurrency ? money(revenueCurrency.value.gross) : "—",
          delta: changeFromSeries(
            revenueCurrency?.timeSeries.map((point) => point.gross) ?? [],
          ),
          riseIsGood: true,
          series: revenueCurrency?.timeSeries.map((point) => point.gross) ?? [],
          format: "money",
          labels: revenueCurrency?.timeSeries.map((point) => point.periodStart) ?? [],
        },
      ],
    },
    {
      key: "subscriptions",
      title: "Subscriptions",
      metrics: [
        {
          key: "active",
          label: "Active",
          value: recurring
            ? count(
                recurring.currencies.reduce(
                  (sum, entry) => sum + entry.activeSubscriptions,
                  0,
                ),
              )
            : "—",
          delta: changeFromSeries(activeSeries),
          riseIsGood: true,
          series: activeSeries,
          format: "count",
          labels: bucketLabels,
        },
        {
          key: "arpu",
          label: "ARPU",
          value: ltvCurrency ? money(ltvCurrency.arpu) : "—",
          delta: changeFromSeries(
            ltvCurrency?.timeSeries.map((point) => point.arpu) ?? [],
          ),
          riseIsGood: true,
          series: ltvCurrency?.timeSeries.map((point) => point.arpu) ?? [],
          format: "money",
          labels: ltvCurrency?.timeSeries.map((point) => point.periodStart) ?? [],
        },
        {
          key: "ltv",
          label: "LTV",
          /* Null is a real state, not zero: LTV is undefined when churn is
             zero, and showing $0 would read as "worthless customers". */
          value:
            ltvCurrency && ltvCurrency.value !== null
              ? money(ltvCurrency.value)
              : "—",
          delta: changeFromSeries(
            ltvCurrency?.timeSeries
              .map((point) => point.value)
              .filter((value): value is number => value !== null) ?? [],
          ),
          riseIsGood: true,
          series:
            ltvCurrency?.timeSeries
              .map((point) => point.value)
              .filter((value): value is number => value !== null) ?? [],
          format: "money",
          labels: ltvCurrency?.timeSeries.filter((point) => point.value !== null).map((point) => point.periodStart) ?? [],
        },
      ],
    },
    {
      key: "churn",
      title: "Churn",
      metrics: [
        {
          key: "revenue_churn",
          label: "Revenue",
          value: revenueChurn ? percent(revenueChurn.value.rate) : "—",
          delta: changeFromSeries(
            revenueChurn?.timeSeries.map((point) => point.rate) ?? [],
          ),
          riseIsGood: false,
          series: revenueChurn?.timeSeries.map((point) => point.rate) ?? [],
          format: "percent",
          labels: revenueChurn?.timeSeries.map((point) => point.periodStart) ?? [],
        },
        {
          key: "subscription_churn",
          label: "Subscription",
          value: churn ? percent(churn.subscription.value) : "—",
          delta: changeFromSeries(
            churn?.subscription.timeSeries.map((point) => point.rate) ?? [],
          ),
          riseIsGood: false,
          series: churn?.subscription.timeSeries.map((point) => point.rate) ?? [],
          format: "percent",
          labels: churn?.subscription.timeSeries.map((point) => point.periodStart) ?? [],
        },
        {
          key: "logo_churn",
          label: "Logo",
          value: churn ? percent(churn.logo.value) : "—",
          delta: changeFromSeries(
            churn?.logo.timeSeries.map((point) => point.rate) ?? [],
          ),
          riseIsGood: false,
          series: churn?.logo.timeSeries.map((point) => point.rate) ?? [],
          format: "percent",
          labels: churn?.logo.timeSeries.map((point) => point.periodStart) ?? [],
        },
      ],
    },
  ];
}
