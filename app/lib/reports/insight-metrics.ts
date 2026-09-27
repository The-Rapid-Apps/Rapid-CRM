import type { InsightMetricKey } from "~/lib/reports/traffic-sources.shared";

/**
 * The revenue metrics of the Traffic source insights report, per customer and
 * per slice. Pure, so the definitions are pinned by tests rather than by
 * whatever the query happened to return.
 *
 * Definitions match the Customers page and the Top customers card:
 * - CLV — everything the shop has paid this app, gross.
 * - Spend — AMR: CLV over months billed, an annual payment counting as twelve.
 */

export interface CustomerRevenue {
  /** Lifetime gross paid to this app. */
  clv: number;
  /** Months billed, an annual sale counting as twelve. */
  months: number;
}

/** A customer who never paid is a real zero, not a missing value: they did
 * the event and brought no revenue. Leaving them out would make every source
 * look as valuable as its few paying customers. */
const NO_REVENUE: CustomerRevenue = { clv: 0, months: 0 };

export function customerValue(
  revenue: CustomerRevenue | undefined,
  metric: Exclude<InsightMetricKey, "volume">,
): number {
  const { clv, months } = revenue ?? NO_REVENUE;
  if (metric.endsWith("_clv")) return clv;
  return months > 0 ? clv / months : 0;
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** One slice's value from its customers' values. */
export function summarizeMetric(
  values: number[],
  metric: Exclude<InsightMetricKey, "volume">,
): number {
  if (values.length === 0) return 0;
  if (metric === "total_clv") return values.reduce((n, v) => n + v, 0);
  if (metric.startsWith("average_")) {
    return values.reduce((n, v) => n + v, 0) / values.length;
  }
  return median([...values].sort((a, b) => a - b));
}
