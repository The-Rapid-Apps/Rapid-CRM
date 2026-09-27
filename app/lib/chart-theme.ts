import type { PartialTheme } from "@shopify/polaris-viz";
import { useTheme } from "~/lib/theme";

/**
 * The validated chart palette, shared by every Polaris Viz chart in this
 * app. One instance, not a
 * copy per surface — this file is what a rebrand or a dark-mode contrast
 * fix touches, once.
 */
export const MANTLE_CHART_THEME = {
  chartContainer: {
    backgroundColor: "transparent",
    borderRadius: "0",
    minHeight: 280,
    padding: "0",
  },
  bar: {
    borderRadius: 4,
    gap: 8,
  },
  grid: {
    color: "#474646",
    showHorizontalLines: true,
  },
  xAxis: {
    labelColor: "#c5c3c3",
  },
  yAxis: {
    backgroundColor: "#242323",
    labelColor: "#c5c3c3",
  },
  line: {
    hasArea: false,
    hasSpline: false,
    pointStroke: "#242323",
    /**
     * polaris-viz defaults this to 10, which draws a band rather than a line —
     * unreadable as soon as two series overlap. Set on the BASE theme so every
     * chart inherits it; `useRevenueChartTheme` still narrows further to 1.5
     * for its single-series charts. Bar charts ignore `line` entirely.
     */
    width: 2.5,
  },
  crossHair: {
    color: "#dedbdf",
    width: 1,
  },
  tooltip: {
    backgroundColor: "#f7f7f7",
    textColor: "#303030",
    titleColor: "#303030",
  },
  legend: {
    backgroundColor: null,
    labelColor: "#c5c3c3",
    valueColor: "#f7f7f7",
  },
} satisfies PartialTheme;

/** Light-mode counterpart of `MANTLE_CHART_THEME`, shared by every chart. */
export const MANTLE_CHART_THEME_LIGHT = {
  chartContainer: {
    backgroundColor: "transparent",
    borderRadius: "0",
    minHeight: 280,
    padding: "0",
  },
  bar: {
    borderRadius: 4,
    gap: 8,
  },
  grid: {
    color: "#e1e2e3",
    showHorizontalLines: true,
  },
  xAxis: {
    labelColor: "#6d7175",
  },
  yAxis: {
    backgroundColor: "#fafafa",
    labelColor: "#6d7175",
  },
  line: {
    hasArea: false,
    hasSpline: false,
    pointStroke: "#fafafa",
    /** Matches the dark theme's width — see its note. */
    width: 2.5,
  },
  crossHair: {
    color: "#8c8c8c",
    width: 1,
  },
  tooltip: {
    backgroundColor: "#202020",
    textColor: "#f7f7f7",
    titleColor: "#f7f7f7",
  },
  legend: {
    backgroundColor: null,
    labelColor: "#6d7175",
    valueColor: "#202223",
  },
} satisfies PartialTheme;

/**
 * The chart palette for the active site theme. Every `PolarisVizProvider` goes
 * through this so a chart can never disagree with the card it sits in — which
 * is what happened when only the Traffic chart adapted and the rest stayed dark
 * on a light page.
 */
export function useChartTheme() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  return {
    isDark,
    themes: {
      Mantle: isDark ? MANTLE_CHART_THEME : MANTLE_CHART_THEME_LIGHT,
    },
  };
}

/** Nominal drawable width of a chart card, for sizing bars against a count. */
const CHART_DRAWABLE_WIDTH = 640;

/**
 * The theme with its bar gap sized for `barCount`, rather than fixed at 8px.
 *
 * A constant gap is a constant only in absolute terms: at 30 bars it is a
 * comfortable ~35% of each band, but at the ~58 monthly bars an "All time"
 * range produces it eats most of the band and leaves a ~4px hairline — bars
 * thinner than the gaps between them, which is what made the all-time MRR
 * chart unreadable. Capping the gap at a third of the band keeps bars the
 * dominant mark at any count, and short ranges are unaffected because the cap
 * only binds once bands get tight.
 *
 * The corner radius is clamped too: a 4px radius on a 5px-wide bar rounds the
 * whole mark into a lozenge and loses the flat top that makes a bar readable.
 */
/**
 * @param minHeight overrides the theme's container height for this chart.
 *
 * Needed because polaris-viz sizes the plot from `chartContainer.minHeight`,
 * NOT from the element it is rendered into — so making the wrapper taller in
 * CSS alone just adds dead space under a 280px chart. A DIVERGING chart needs
 * the extra room more than the others: its plot is split above and below zero,
 * so each bar gets about half the height it would on a single-sided chart.
 */
export function useBarChartTheme(barCount: number, minHeight?: number) {
  const { isDark, themes } = useChartTheme();
  const baseTheme = isDark ? MANTLE_CHART_THEME : MANTLE_CHART_THEME_LIGHT;
  const base =
    minHeight === undefined
      ? baseTheme
      : {
          ...baseTheme,
          chartContainer: { ...baseTheme.chartContainer, minHeight },
        };
  const band = CHART_DRAWABLE_WIDTH / Math.max(1, barCount);
  const gap = Math.max(1, Math.min(base.bar.gap, Math.floor(band / 3)));
  const barWidth = Math.max(1, band - gap);
  const borderRadius = Math.max(
    0,
    Math.min(base.bar.borderRadius, Math.floor(barWidth / 2)),
  );
  return {
    isDark,
    themes: {
      ...themes,
      Mantle: { ...base, bar: { ...base.bar, gap, borderRadius } },
    },
  };
}

/** Compact recurring-revenue reports; other dashboards retain their theme. */
export function useRevenueChartTheme(barCount = 60) {
  const { isDark, themes } = useBarChartTheme(barCount);
  const base = themes.Mantle;
  return {
    isDark,
    themes: {
      Mantle: {
        ...base,
        grid: { ...base.grid, color: isDark ? "#39383a" : "#ececec" },
        xAxis: { ...base.xAxis, labelColor: isDark ? "#c5c3c3" : "#4a4a4a" },
        yAxis: {
          ...base.yAxis,
          backgroundColor: isDark ? "#242323" : "#ffffff",
          labelColor: isDark ? "#c5c3c3" : "#4a4a4a",
        },
        // Width comes from the base theme (2.5) so every line chart in the
        // app matches; only the area/spline flags are forced off here.
        line: { ...base.line, hasSpline: false, hasArea: false },
      },
    },
  };
}

export function compactMoney(value: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}
