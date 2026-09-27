/**
 * The Overview's Insights card — Mantle's short list of "here is something
 * that changed" lines, each with somewhere to go and look.
 *
 * Pure: counts in, sentences out. Kept out of the route so the thresholds and
 * the wording have one home and a test can reach them.
 *
 * Mantle's list also carries a review insight ("1 negative review in the last
 * 7 days"). We have no review data — no model, no sync, and the Partner API
 * exposes none — so that line is absent rather than faked.
 */

export type InsightTone = "positive" | "warning" | "info";

export interface OverviewInsight {
  /** Stable across reloads, so a dismissal can be remembered by id. */
  id: string;
  tone: InsightTone;
  message: string;
  actionLabel: string;
  actionUrl: string;
}

/**
 * Below this, a change is noise rather than news: install volumes swing a
 * couple of percent week to week on their own, and an insight that fires
 * every day is one nobody reads.
 *
 * 5%, not 10%. At 10% the real portfolio produced exactly ONE insight — a
 * +9.6% month of installs and a -6.7% week of uninstalls both fell under the
 * bar, while Mantle's own card reports a change of precisely that size
 * ("Installs have declined 10% over the last month"). A threshold that hides
 * the very moves the card exists to report is the wrong threshold.
 */
const MATERIAL_CHANGE = 0.05;

function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return (current - previous) / previous;
}

const formatPercent = (value: number): string =>
  `${Math.abs(value * 100).toFixed(0)}%`;

export function buildOverviewInsights(counts: {
  installs30: number;
  installs30Previous: number;
  uninstalls7: number;
  uninstalls7Previous: number;
  installs7: number;
}): OverviewInsight[] {
  const insights: OverviewInsight[] = [];

  const installChange = percentChange(
    counts.installs30,
    counts.installs30Previous,
  );
  if (installChange !== null && Math.abs(installChange) >= MATERIAL_CHANGE) {
    insights.push({
      id: "installs-30d",
      tone: installChange > 0 ? "positive" : "warning",
      message: `Installs have ${installChange > 0 ? "grown" : "declined"} ${formatPercent(installChange)} over the last month.`,
      actionLabel: "View report",
      actionUrl: "/app/reports?report=traffic",
    });
  }

  const uninstallChange = percentChange(
    counts.uninstalls7,
    counts.uninstalls7Previous,
  );
  if (uninstallChange !== null && Math.abs(uninstallChange) >= MATERIAL_CHANGE) {
    insights.push({
      id: "uninstalls-7d",
      /* A FALL in uninstalls is the good direction, so the tone is inverted
         against the install insight above rather than following the sign. */
      tone: uninstallChange > 0 ? "warning" : "positive",
      message: `Uninstalls ${uninstallChange > 0 ? "up" : "down"} ${formatPercent(uninstallChange)} this week.`,
      actionLabel: "View customers",
      actionUrl: "/app/uninstalls",
    });
  }

  const net = counts.installs7 - counts.uninstalls7;
  insights.push({
    id: "week-net",
    tone: net >= 0 ? "positive" : "warning",
    message: `This week: ${counts.installs7.toLocaleString()} installs, ${counts.uninstalls7.toLocaleString()} uninstalls (${net >= 0 ? "+" : "−"}${Math.abs(net).toLocaleString()} net).`,
    actionLabel: "View report",
    actionUrl: "/app/reports?report=traffic",
  });

  return insights;
}
