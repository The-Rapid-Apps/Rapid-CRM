/**
 * Which components make up a displayed MRR figure, and the one function that
 * composes them.
 *
 * Extracted from `routes/app/reports.tsx` so the rule has a single definition
 * and a test. It previously existed three times over — the headline total, the
 * stacked series, and the tooltip breakdown — and the copies had drifted:
 * active trials were added to the total and to the most recent bar, but to no
 * earlier bar. "Total" therefore disagreed with the sum of its own rows on
 * every day but the last, and net growth subtracted a trial-free starting
 * figure from a trial-inclusive current one.
 */

export interface RevenueComponents {
  annual: boolean;
  usage: boolean;
  trials: boolean;
}

/**
 * The headline definition: COMMITTED recurring revenue.
 *
 * Trials off, everything else on. A merchant mid-trial has promised nothing
 * yet, so counting their plan price is a forecast rather than a run rate, and
 * every comparable tool — Mantle included — reports MRR without it and trial
 * value separately.
 *
 * Exported so the Reports toolbar's default and the Overview cards are the
 * same object rather than the same literal typed twice. They disagreed once
 * already: Reports composed without trials while the Overview rendered the
 * gross `mrr` field, leaving the two several thousand dollars apart on the
 * same day and the Overview several thousand away from Mantle.
 */
export const COMMITTED_MRR: RevenueComponents = {
  annual: true,
  usage: true,
  trials: false,
};

export interface MrrParts {
  monthlySubscriptions?: number | null;
  annualSubscriptions?: number | null;
  usageCharges?: number | null;
  trialSubscriptions?: number | null;
  /** Fallback for a point that predates the per-component columns. */
  mrr?: number;
}

/**
 * Every component is a point-in-time RUN RATE, trials included.
 *
 * An earlier version treated active trials as belonging only to the most recent
 * point, on the grounds that they are "a point-in-time snapshot, not a per-day
 * amount". But so are monthly and annual subscriptions in an MRR chart: money
 * actually collected on a day is the Revenue report, a different series. Trial
 * MRR on 9 August is exactly as meaningful as monthly MRR on 9 August, and the
 * daily snapshot rows have carried it per day all along.
 */
export function composeMrr(
  parts: MrrParts,
  components: RevenueComponents,
): number {
  return (
    (parts.monthlySubscriptions ?? parts.mrr ?? 0) +
    (components.annual ? (parts.annualSubscriptions ?? 0) : 0) +
    (components.usage ? (parts.usageCharges ?? 0) : 0) +
    (components.trials ? (parts.trialSubscriptions ?? 0) : 0)
  );
}

/**
 * The same components as labelled rows, in the order they stack.
 *
 * Shares `composeMrr`'s rule by construction: the rows are the addends, so a
 * caller can assert `sum(rows) === composeMrr(...)` and the tooltip can never
 * again disagree with the total it sits under.
 */
export function mrrComponentBreakdown(
  parts: MrrParts,
  components: RevenueComponents,
  multiplier = 1,
): Array<{ label: string; value: number }> {
  const rows = [
    {
      label: "Monthly subscriptions",
      value: parts.monthlySubscriptions ?? parts.mrr ?? 0,
    },
  ];
  if (components.annual) {
    rows.push({
      label: "Annual subscriptions",
      value: parts.annualSubscriptions ?? 0,
    });
  }
  if (components.usage) {
    rows.push({ label: "Usage charges", value: parts.usageCharges ?? 0 });
  }
  if (components.trials) {
    rows.push({ label: "Trial MRR", value: parts.trialSubscriptions ?? 0 });
  }
  return rows.map((row) => ({ ...row, value: row.value * multiplier }));
}
