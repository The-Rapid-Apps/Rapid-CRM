/**
 * Traffic Source Report — everything specific to the "Traffic" tab (pivot,
 * funnel-event, and per-dimension filter pickers; the custom date-range
 * picker; the per-row trend charts; and the panel itself). Split out of
 * reports.tsx so our part of that file stays independent of the manager's
 * Revenue/Growth/Churn/etc. panels — that file changes under both of us
 * constantly, and this cuts our shared merge-conflict surface way down.
 *
 * A few chart/formatting helpers (`percent`, `MetricCard`, `chartPeriodLabel`,
 * `INTERVAL_LABELS`, `MANTLE_CHART_THEME`, `PolarisVizProvider`/`BarChart`/
 * `LineChart`) are still genuinely shared with the manager's Revenue/Growth
 * charts, so they stay defined in reports.tsx (exported) and are imported
 * back here — reports.tsx importing `TrafficSourcesPanel` from this file
 * while this file imports those helpers from reports.tsx is a circular
 * import between the two, but it's safe here because every one of those
 * imports is only ever used inside a component/render body, never at module
 * top-level, so by the time anything actually runs both modules have
 * finished evaluating.
 */
import {
  Banner,
  BlockStack,
  Button,
  Card,
  Checkbox,
  DataTable,
  DatePicker,
  EmptyState,
  InlineStack,
  Modal,
  Pagination,
  Popover,
  RadioButton,
  Spinner,
  Text,
  TextField,
  Tooltip,
} from "@shopify/polaris";
import {
  type CSSProperties,
  Suspense,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useFetcher, useNavigate, useNavigation } from "react-router";
import type { Route } from "./+types/reports";
import type { AnalyticsInterval } from "~/lib/reports/analytics.server";
import type { AnalyticsPeriod } from "~/lib/reports/analytics.shared";
import type {
  DimensionFilters,
  TrendBucket,
} from "~/lib/reports/traffic-sources.server";
import { SavedViewsPicker, SaveViewButton } from "~/components/saved-views";
import type {
  SavedView,
  TrafficSavedState,
} from "~/lib/saved-views/saved-view-schemas";
import {
  DEFAULT_FUNNEL_EVENTS,
  DEFAULT_PIVOT_DIMENSIONS,
  FUNNEL_EVENTS,
  type FunnelEventKey,
  PIVOT_DIMENSIONS,
  type PivotDimensionKey,
} from "~/lib/reports/traffic-sources.shared";
import { EMPTY_STATE_IMAGE } from "~/lib/ui";
import { ConfirmDialog } from "~/components/confirm-dialog";
import { formatMoney } from "~/lib/format";
import { useTheme } from "~/lib/theme";
import { MANTLE_CHART_THEME, MANTLE_CHART_THEME_LIGHT } from "~/lib/chart-theme";
import {
  addUtcDays,
  DATE_RANGE_PRESETS,
  localCalendarDateToUtc,
  shortDate,
  utcDayStart,
  utcToLocalCalendarDate,
} from "~/lib/date-range";
import {
  BarChart,
  chartPeriodLabel,
  LineChart,
  percent,
  PERIOD_LABELS,
  PolarisVizProvider,
} from "./reports";

export const TRAFFIC_PAGE_SIZE = 20;

/**
 * Full precision, not just the calendar day — needed so sub-day presets
 * ("Last 12 hours") survive the URL round-trip instead of getting rounded to
 * midnight. Whole-day presets/custom picks still serialize fine as an exact
 * midnight instant.
 */
export function isoDate(date: Date): string {
  return date.toISOString();
}

/** Accepts either a plain "YYYY-MM-DD" or a full ISO instant. */
export function parseIsoDateUtc(value: string): Date | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** True when `date` lands exactly on a UTC calendar-day boundary — used to
 * tell a whole-day range (needs +1 day to become an exclusive end) apart
 * from a precise sub-day instant (already exact, e.g. "Last 12 hours"). */
export function isUtcMidnight(date: Date): boolean {
  return (
    date.getUTCHours() === 0 &&
    date.getUTCMinutes() === 0 &&
    date.getUTCSeconds() === 0 &&
    date.getUTCMilliseconds() === 0
  );
}

export type CompareMode = "none" | "previous_period" | "previous_year" | "custom";

export function trafficUrl(
  params: {
    page?: number;
    dimensions?: PivotDimensionKey[];
    funnelEvents?: FunnelEventKey[];
    filters?: DimensionFilters;
    /** Explicit calendar-day override (inclusive on both ends). Every caller
     * must pass this through if one is currently active (mirroring
     * `filters`) — omitting it here always means "no override," which would
     * silently drop back to the shared Period selector's range. */
    dateRange?: { start: Date; end: Date };
    /** The active "Compare to" selection. Every caller must pass this
     * through if one is currently active (mirroring `dateRange`) — omitting
     * it always means "no comparison," silently clearing the user's choice. */
    compare?: { mode: CompareMode; range?: { start: Date; end: Date } };
  },
  period: AnalyticsPeriod,
  appId: string,
  interval: AnalyticsInterval,
): string {
  const search = new URLSearchParams({
    report: "traffic",
    period,
    interval,
    trafficPage: String(params.page ?? 1),
  });
  if (params.dimensions?.length) {
    search.set("trafficDims", params.dimensions.join(","));
  }
  if (params.funnelEvents?.length) {
    search.set("trafficFunnel", params.funnelEvents.join(","));
  }
  if (params.filters) {
    for (const [key, values] of Object.entries(params.filters)) {
      if (values && values.length > 0) search.set(`filter_${key}`, values.join(","));
    }
  }
  if (params.dateRange) {
    search.set("trafficStart", isoDate(params.dateRange.start));
    search.set("trafficEnd", isoDate(params.dateRange.end));
  }
  if (params.compare && params.compare.mode !== "none") {
    search.set("trafficCompare", params.compare.mode);
    if (params.compare.mode === "custom" && params.compare.range) {
      search.set("trafficCompareStart", isoDate(params.compare.range.start));
      search.set("trafficCompareEnd", isoDate(params.compare.range.end));
    }
  }
  if (appId) search.set("appId", appId);
  return `/app/reports?${search.toString()}`;
}

function TruncatedCell({ value }: { value: string }) {
  return (
    <Tooltip content={value}>
      <div
        style={{
          textAlign: "center",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {value}
      </div>
    </Tooltip>
  );
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * This report's own preset list = the shared set plus "All time", whose
 * start date is specific to this GA4 property's export link date and so
 * can't live in the shared list.
 */
const TRAFFIC_DATE_PRESETS: Array<{
  key: string;
  label: string;
  range: (now: Date) => { start: Date; end: Date };
}> = [
  ...DATE_RANGE_PRESETS,
  {
    key: "all_time",
    label: "All time",
    // GA4/BigQuery export for this property was linked 2024-12-02 (see
    // CLAUDE.md) — a day earlier as a safe buffer rather than hardcoding
    // that exact date in two places.
    range: (now) => ({
      start: new Date(Date.UTC(2024, 11, 1)),
      end: utcDayStart(now),
    }),
  },
];

/**
 * Fixed per-funnel-event color, keyed by the event itself rather than its
 * position in whatever subset is currently selected — so a color never
 * shifts when the funnel-event picker changes, and the stat tile above the
 * combined chart always matches that event's line/legend dot below it.
 */
const FUNNEL_EVENT_COLORS: Partial<Record<FunnelEventKey, string>> = {
  listing_view: "#9668ff",
  add_app_click: "#4aa3ff",
  installed: "#33e38c",
  uninstalled: "#ff7070",
  reinstalled: "#5cd6d6",
  subscribed: "#ffb84d",
  unsubscribed: "#ff5c8a",
  trial_started: "#9be564",
  trial_converted: "#6f9dff",
  upgraded: "#c58aff",
  downgraded: "#f2a65a",
  resubscribed: "#7ad1ff",
  charge_abandoned: "#c9cf3a",
};

/**
 * Funnel stages in increasing depth, for the "Total conversions" figure —
 * which counts the DEEPEST selected stage, matching Mantle (its example reads
 * 288, the same number as its Subscribed tile).
 *
 * Deliberately not just "the last selected funnel event": the picker's order
 * is the canonical `FUNNEL_EVENTS` order, which is a menu, not a funnel —
 * `uninstalled` sits after `installed` and `charge_abandoned` sits last of
 * all. Taking the last selected one would happily report abandoned charges as
 * conversions. Only stages a merchant progresses THROUGH belong here, so
 * uninstall/unsubscribe/downgrade and the plan-change events are all absent,
 * and so is `listing_view` — a page view is the top of the funnel, not a
 * conversion.
 */
const CONVERSION_LADDER: FunnelEventKey[] = [
  "add_app_click",
  "installed",
  "trial_started",
  "trial_converted",
  "subscribed",
];

/** The deepest conversion stage among `active`, or null when none is selected
 * (e.g. a view-only or churn-only breakdown, where no conversion is on show). */
function deepestConversion(active: FunnelEventKey[]): FunnelEventKey | null {
  for (let i = CONVERSION_LADDER.length - 1; i >= 0; i -= 1) {
    if (active.includes(CONVERSION_LADDER[i])) return CONVERSION_LADDER[i];
  }
  return null;
}

function funnelEventColor(key: FunnelEventKey): string {
  return FUNNEL_EVENT_COLORS[key] ?? "#9668ff";
}

function CountChartTooltip({
  title,
  rows,
  dark = true,
}: {
  title: string;
  rows: Array<{ label: string; value: number; color: string }>;
  dark?: boolean;
}) {
  return (
    <div
      style={{
        minWidth: 220,
        padding: "14px 16px",
        color: dark ? "#f7f7f7" : "#202223",
        background: dark ? "#090909" : "#ffffff",
        border: dark ? "1px solid #333" : "1px solid #e1e2e3",
        borderRadius: 10,
        boxShadow: dark
          ? "0 10px 28px rgba(0, 0, 0, 0.45)"
          : "0 10px 28px rgba(0, 0, 0, 0.12)",
      }}
    >
      <div style={{ marginBottom: 10, fontWeight: 700 }}>{title}</div>
      <div style={{ display: "grid", gap: 7 }}>
        {rows.map((row) => (
          <div
            key={row.label}
            style={{
              display: "grid",
              gridTemplateColumns: "14px minmax(0, 1fr) auto",
              alignItems: "center",
              gap: 8,
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
              {row.value.toLocaleString()}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The funnel events as a row of tiles above the trend chart — each one its
 * period total, colour-matched to its line, and clickable.
 *
 * This is both the legend and the chart's tab strip, which is how Mantle does
 * it: the tiles carry the numbers, and clicking one isolates that metric in
 * the graph without leaving the chart or touching the Funnel events picker
 * (that picker chooses which events are *fetched*; these choose which of the
 * fetched ones you are looking at). Clicking the selected tile again puts
 * every series back.
 *
 * Replaces the plain label-and-swatch legend that used to sit *below* the
 * chart and showed no numbers at all — the reason the panel had to be read
 * alongside the table to learn what any line was worth.
 */
function FunnelStatTiles({
  funnelEvents,
  funnelLabels,
  totals,
  selectedKey,
  onSelect,
  hoveredIndex,
  onHoverIndex,
}: {
  funnelEvents: FunnelEventKey[];
  funnelLabels: string[];
  totals: Partial<Record<FunnelEventKey, number>>;
  selectedKey: FunnelEventKey | null;
  onSelect: (key: FunnelEventKey | null) => void;
  hoveredIndex: number | null;
  onHoverIndex: (index: number | null) => void;
}) {
  return (
    <div className="reports-funnel-tiles" role="tablist" aria-label="Funnel events">
      {funnelEvents.map((key, index) => {
        const isSelected = selectedKey === key;
        const color = funnelEventColor(key);
        const description = FUNNEL_EVENTS.find((e) => e.key === key)?.description;
        return (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={isSelected}
            title={description}
            className={[
              "reports-funnel-tile",
              isSelected ? "is-selected" : "",
              // Only dim on hover while nothing is isolated — once a tile is
              // selected the chart is already showing one series, and dimming
              // the others on top of that reads as a second, conflicting state.
              selectedKey === null && hoveredIndex !== null && hoveredIndex !== index
                ? "is-dimmed"
                : "",
            ]
              .filter(Boolean)
              .join(" ")}
            style={{ "--funnel-tile-color": color } as CSSProperties}
            onMouseEnter={() => onHoverIndex(index)}
            onMouseLeave={() => onHoverIndex(null)}
            onFocus={() => onHoverIndex(index)}
            onBlur={() => onHoverIndex(null)}
            onClick={() => onSelect(isSelected ? null : key)}
          >
            <span className="reports-funnel-tile-label">
              <i aria-hidden="true" />
              {funnelLabels[index]}
            </span>
            <span className="reports-funnel-tile-value">
              {(totals[key] ?? 0).toLocaleString()}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Dims a series' line color when another row is hovered in the legend below
 * the chart — matches Mantle: hovering a legend label isolates just that
 * line, fading the rest instead of removing them entirely. */
function hexToRgba(hex: string, alpha: number): string {
  const value = parseInt(hex.slice(1), 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function PivotPicker({
  selected,
  funnelEvents,
  filters,
  dateRange,
  compare,
  period,
  appId,
  interval,
}: {
  selected: PivotDimensionKey[];
  funnelEvents: FunnelEventKey[];
  filters: DimensionFilters;
  dateRange?: { start: Date; end: Date };
  compare?: { mode: CompareMode; range?: { start: Date; end: Date } };
  period: AnalyticsPeriod;
  appId: string;
  interval: AnalyticsInterval;
}) {
  const navigate = useNavigate();
  const navigation = useNavigation();
  const [active, setActive] = useState(false);
  const [pending, setPending] = useState<PivotDimensionKey[] | null>(null);

  useEffect(() => {
    if (navigation.state === "idle") setPending(null);
  }, [navigation.state]);

  const effectiveSelected = pending ?? selected;
  const isApplying = pending !== null;

  const toggleDimension = (key: PivotDimensionKey) => {
    const next = effectiveSelected.includes(key)
      ? effectiveSelected.filter((dimension) => dimension !== key)
      : [...effectiveSelected, key];
    if (next.length === 0) return;
    setPending(next);
    navigate(
      trafficUrl(
        { dimensions: next, funnelEvents, filters, dateRange, compare },
        period,
        appId,
        interval,
      ),
    );
  };

  return (
    <Popover
      active={active}
      onClose={() => setActive(false)}
      activator={
        <Button
          disclosure
          onClick={() => setActive((current) => !current)}
        >{`${effectiveSelected.length} pivot${effectiveSelected.length === 1 ? "" : "s"}`}</Button>
      }
    >
      <Popover.Pane fixed>
        <div
          className="thin-scrollbar"
          style={{
            padding: "var(--p-space-300)",
            minWidth: "240px",
            maxHeight: "320px",
            overflowY: "auto",
          }}
        >
          <BlockStack gap="200">
            {PIVOT_DIMENSIONS.map((dimension) => (
              <Checkbox
                key={dimension.key}
                label={dimension.label}
                checked={effectiveSelected.includes(dimension.key)}
                disabled={isApplying}
                onChange={() => toggleDimension(dimension.key)}
              />
            ))}
          </BlockStack>
        </div>
      </Popover.Pane>
    </Popover>
  );
}

function FunnelPicker({
  selected,
  dimensions,
  filters,
  dateRange,
  compare,
  period,
  appId,
  interval,
}: {
  selected: FunnelEventKey[];
  dimensions: PivotDimensionKey[];
  filters: DimensionFilters;
  dateRange?: { start: Date; end: Date };
  compare?: { mode: CompareMode; range?: { start: Date; end: Date } };
  period: AnalyticsPeriod;
  appId: string;
  interval: AnalyticsInterval;
}) {
  const navigate = useNavigate();
  const navigation = useNavigation();
  const [active, setActive] = useState(false);
  const [pending, setPending] = useState<FunnelEventKey[] | null>(null);

  useEffect(() => {
    if (navigation.state === "idle") setPending(null);
  }, [navigation.state]);

  const effectiveSelected = pending ?? selected;
  const isApplying = pending !== null;

  const toggleEvent = (key: FunnelEventKey) => {
    const next = effectiveSelected.includes(key)
      ? effectiveSelected.filter((k) => k !== key)
      : [...effectiveSelected, key];
    if (next.length === 0) return;
    setPending(next);
    navigate(
      trafficUrl(
        { dimensions, funnelEvents: next, filters, dateRange, compare },
        period,
        appId,
        interval,
      ),
    );
  };

  return (
    <Popover
      active={active}
      onClose={() => setActive(false)}
      activator={
        <Button
          disclosure
          onClick={() => setActive((value) => !value)}
        >{`${effectiveSelected.length} funnel event${effectiveSelected.length === 1 ? "" : "s"}`}</Button>
      }
    >
      <div
        className="thin-scrollbar"
        style={{
          padding: "var(--p-space-300)",
          minWidth: "240px",
          maxHeight: "320px",
          overflowY: "auto",
        }}
      >
        <BlockStack gap="200">
          {FUNNEL_EVENTS.map((event) => (
            <Checkbox
              key={event.key}
              label={event.label}
              checked={effectiveSelected.includes(event.key)}
              disabled={isApplying}
              onChange={() => toggleEvent(event.key)}
            />
          ))}
        </BlockStack>
      </div>
    </Popover>
  );
}

function DimensionFilterPicker({
  dimensionKey,
  dimensionLabel,
  availableValues,
  selected,
  filters,
  dimensions,
  funnelEvents,
  dateRange,
  compare,
  period,
  appId,
  interval,
  labelFor,
}: {
  dimensionKey: PivotDimensionKey;
  dimensionLabel: string;
  availableValues: string[];
  selected: string[];
  filters: DimensionFilters;
  dimensions: PivotDimensionKey[];
  funnelEvents: FunnelEventKey[];
  dateRange?: { start: Date; end: Date };
  compare?: { mode: CompareMode; range?: { start: Date; end: Date } };
  period: AnalyticsPeriod;
  appId: string;
  interval: AnalyticsInterval;
  /** Maps a raw dimension value to its display label. Defaults to the raw value. */
  labelFor?: (value: string) => string;
}) {
  const navigate = useNavigate();
  const navigation = useNavigation();
  const [active, setActive] = useState(false);
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState<string[] | null>(null);

  useEffect(() => {
    if (navigation.state === "idle") setPending(null);
  }, [navigation.state]);

  const effectiveSelected = pending ?? selected;
  const isApplying = pending !== null;
  const filteredValues = search
    ? availableValues.filter((value) =>
        value.toLowerCase().includes(search.toLowerCase()),
      )
    : availableValues;

  const toggleValue = (value: string) => {
    const next = effectiveSelected.includes(value)
      ? effectiveSelected.filter((v) => v !== value)
      : [...effectiveSelected, value];
    setPending(next);
    navigate(
      trafficUrl(
        {
          dimensions,
          funnelEvents,
          filters: { ...filters, [dimensionKey]: next },
          dateRange,
          compare,
        },
        period,
        appId,
        interval,
      ),
    );
  };

  return (
    <Popover
      active={active}
      onClose={() => setActive(false)}
      activator={
        <Button
          disclosure
          onClick={() => setActive((value) => !value)}
        >
          {effectiveSelected.length > 0
            ? `${dimensionLabel} (${effectiveSelected.length})`
            : dimensionLabel}
        </Button>
      }
    >
      <Popover.Pane fixed>
        <div style={{ padding: "var(--p-space-300)", minWidth: "240px" }}>
          <BlockStack gap="200">
            <TextField
              label={dimensionLabel}
              labelHidden
              placeholder={dimensionLabel}
              value={search}
              onChange={setSearch}
              autoComplete="off"
              clearButton
              onClearButtonClick={() => setSearch("")}
            />
            {effectiveSelected.length > 0 ? (
              <BlockStack gap="100">
                {chunk(effectiveSelected, 3).map((row, rowIndex) => (
                  <InlineStack key={rowIndex} gap="100">
                    {row.map((value) => (
                      <span key={value} className="reports-filter-tag">
                        <span className="reports-filter-tag__label">
                          {labelFor ? labelFor(value) : value}
                        </span>
                        <button
                          type="button"
                          className="reports-filter-tag__remove"
                          onClick={() => toggleValue(value)}
                          disabled={isApplying}
                          aria-label={`Remove ${value}`}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </InlineStack>
                ))}
              </BlockStack>
            ) : null}
            <div
              className="thin-scrollbar"
              style={{ maxHeight: "280px", overflowY: "auto" }}
            >
              <BlockStack gap="150">
                {filteredValues.map((value) => (
                  <Checkbox
                    key={value}
                    label={labelFor ? labelFor(value) : value}
                    checked={effectiveSelected.includes(value)}
                    disabled={isApplying}
                    onChange={() => toggleValue(value)}
                  />
                ))}
                {filteredValues.length === 0 ? (
                  <Text as="span" variant="bodySm" tone="subdued">
                    No matches
                  </Text>
                ) : null}
              </BlockStack>
            </div>
          </BlockStack>
        </div>
      </Popover.Pane>
    </Popover>
  );
}

function TrafficDateRangePicker({
  start,
  end,
  dimensions,
  funnelEvents,
  filters,
  compare,
  period,
  appId,
  interval,
}: {
  start: Date;
  end: Date;
  dimensions: PivotDimensionKey[];
  funnelEvents: FunnelEventKey[];
  filters: DimensionFilters;
  compare?: { mode: CompareMode; range?: { start: Date; end: Date } };
  period: AnalyticsPeriod;
  appId: string;
  interval: AnalyticsInterval;
}) {
  const navigate = useNavigate();
  const navigation = useNavigation();
  const [active, setActive] = useState(false);
  const [pending, setPending] = useState<{ start: Date; end: Date } | null>(
    null,
  );
  const [draft, setDraft] = useState<{ start: Date; end: Date }>({
    start,
    end,
  });
  const [visibleMonth, setVisibleMonth] = useState(
    utcToLocalCalendarDate(end).getMonth(),
  );
  const [visibleYear, setVisibleYear] = useState(
    utcToLocalCalendarDate(end).getFullYear(),
  );

  useEffect(() => {
    if (navigation.state === "idle") setPending(null);
  }, [navigation.state]);

  useEffect(() => {
    setDraft({ start, end });
  }, [start, end]);

  const effective = pending ?? { start, end };
  const isApplying = pending !== null;
  const now = useMemo(() => new Date(), []);

  const applyRange = (range: { start: Date; end: Date }) => {
    setPending(range);
    setActive(false);
    navigate(
      trafficUrl(
        { dimensions, funnelEvents, filters, dateRange: range, compare },
        period,
        appId,
        interval,
      ),
    );
  };

  return (
    <Popover
      active={active}
      onClose={() => setActive(false)}
      fluidContent
      activator={
        <Button
          disclosure
          onClick={() => setActive((value) => !value)}
        >{`${shortDate(effective.start)} - ${shortDate(effective.end)}`}</Button>
      }
    >
      <div style={{ display: "flex" }}>
        <div
          className="thin-scrollbar"
          style={{
            borderRight: "1px solid var(--p-color-border)",
            padding: "var(--p-space-150)",
            width: "210px",
            maxHeight: "310px",
            overflowY: "auto",
          }}
        >
          <BlockStack gap="0">
            {TRAFFIC_DATE_PRESETS.map((preset) => {
              const presetRange = preset.range(now);
              const isActive =
                isoDate(presetRange.start) === isoDate(effective.start) &&
                isoDate(presetRange.end) === isoDate(effective.end);
              return (
                <Button
                  key={preset.key}
                  variant={isActive ? "primary" : "tertiary"}
                  textAlign="left"
                  fullWidth
                  disabled={isApplying}
                  onClick={() => applyRange(presetRange)}
                >
                  {preset.label}
                </Button>
              );
            })}
          </BlockStack>
        </div>
        <div style={{ padding: "var(--p-space-200)", width: "320px" }}>
          <BlockStack gap="150">
            <DatePicker
              month={visibleMonth}
              year={visibleYear}
              selected={{
                start: utcToLocalCalendarDate(draft.start),
                end: utcToLocalCalendarDate(draft.end),
              }}
              allowRange
              disableDatesAfter={utcToLocalCalendarDate(now)}
              onMonthChange={(month, year) => {
                setVisibleMonth(month);
                setVisibleYear(year);
              }}
              onChange={(range) =>
                setDraft({
                  start: localCalendarDateToUtc(range.start),
                  end: localCalendarDateToUtc(range.end),
                })
              }
            />
            <InlineStack align="end" gap="200">
              <Button onClick={() => setActive(false)}>Cancel</Button>
              <Button
                variant="primary"
                disabled={isApplying}
                onClick={() => applyRange(draft)}
              >
                Apply
              </Button>
            </InlineStack>
          </BlockStack>
        </div>
      </div>
    </Popover>
  );
}

const COMPARE_OPTIONS: Array<{ key: CompareMode; label: string }> = [
  { key: "none", label: "None" },
  { key: "previous_period", label: "Previous period" },
  { key: "previous_year", label: "Previous year" },
  { key: "custom", label: "Custom period" },
];

/** Same preset+calendar layout as `TrafficDateRangePicker`, reused here for
 * picking a custom "Compare to" period — deliberately simpler (no
 * active-preset highlighting, no pending/loading state) since it's a nested
 * step inside `CompareToPicker`'s own popover rather than a standalone one. */
function CompareCalendarBody({
  now,
  draftDefault,
  onCancel,
  onApply,
}: {
  now: Date;
  draftDefault: { start: Date; end: Date };
  onCancel: () => void;
  onApply: (range: { start: Date; end: Date }) => void;
}) {
  const [draft, setDraft] = useState<{ start: Date; end: Date }>(draftDefault);
  const [visibleMonth, setVisibleMonth] = useState(
    utcToLocalCalendarDate(draftDefault.end).getMonth(),
  );
  const [visibleYear, setVisibleYear] = useState(
    utcToLocalCalendarDate(draftDefault.end).getFullYear(),
  );

  return (
    <div style={{ display: "flex" }}>
      <div
        className="thin-scrollbar"
        style={{
          borderRight: "1px solid var(--p-color-border)",
          padding: "var(--p-space-150)",
          width: "210px",
          maxHeight: "310px",
          overflowY: "auto",
        }}
      >
        <BlockStack gap="0">
          {TRAFFIC_DATE_PRESETS.map((preset) => (
            <Button
              key={preset.key}
              variant="tertiary"
              textAlign="left"
              fullWidth
              onClick={() => onApply(preset.range(now))}
            >
              {preset.label}
            </Button>
          ))}
        </BlockStack>
      </div>
      <div style={{ padding: "var(--p-space-200)", width: "320px" }}>
        <BlockStack gap="150">
          <DatePicker
            month={visibleMonth}
            year={visibleYear}
            selected={{
              start: utcToLocalCalendarDate(draft.start),
              end: utcToLocalCalendarDate(draft.end),
            }}
            allowRange
            disableDatesAfter={utcToLocalCalendarDate(now)}
            onMonthChange={(month, year) => {
              setVisibleMonth(month);
              setVisibleYear(year);
            }}
            onChange={(range) =>
              setDraft({
                start: localCalendarDateToUtc(range.start),
                end: localCalendarDateToUtc(range.end),
              })
            }
          />
          <InlineStack align="end" gap="200">
            <Button onClick={onCancel}>Cancel</Button>
            <Button variant="primary" onClick={() => onApply(draft)}>
              Apply
            </Button>
          </InlineStack>
        </BlockStack>
      </div>
    </div>
  );
}

function CompareToPicker({
  compareMode,
  compareRange,
  dimensions,
  funnelEvents,
  filters,
  dateRange,
  period,
  appId,
  interval,
}: {
  compareMode: CompareMode;
  compareRange?: { start: Date; end: Date };
  dimensions: PivotDimensionKey[];
  funnelEvents: FunnelEventKey[];
  filters: DimensionFilters;
  dateRange?: { start: Date; end: Date };
  period: AnalyticsPeriod;
  appId: string;
  interval: AnalyticsInterval;
}) {
  const navigate = useNavigate();
  const navigation = useNavigation();
  const [active, setActive] = useState(false);
  const [view, setView] = useState<"menu" | "calendar">("menu");
  const [pending, setPending] = useState<CompareMode | null>(null);
  const now = useMemo(() => new Date(), []);

  useEffect(() => {
    if (navigation.state === "idle") setPending(null);
  }, [navigation.state]);

  const effectiveMode = pending ?? compareMode;
  const isApplying = pending !== null;

  const applyCompare = (
    mode: CompareMode,
    range?: { start: Date; end: Date },
  ) => {
    setPending(mode);
    setActive(false);
    setView("menu");
    navigate(
      trafficUrl(
        { dimensions, funnelEvents, filters, dateRange, compare: { mode, range } },
        period,
        appId,
        interval,
      ),
    );
  };

  const label =
    effectiveMode === "none"
      ? "Compare to..."
      : effectiveMode === "previous_period"
        ? "Compare to previous period"
        : effectiveMode === "previous_year"
          ? "Compare to previous year"
          : compareRange
            ? `Compare to ${shortDate(compareRange.start)} - ${shortDate(compareRange.end)}`
            : "Compare to custom period";

  return (
    <Popover
      active={active}
      onClose={() => {
        setActive(false);
        setView("menu");
      }}
      fluidContent={view === "calendar"}
      activator={
        <Button disclosure onClick={() => setActive((value) => !value)}>
          {label}
        </Button>
      }
    >
      {view === "menu" ? (
        <Popover.Pane fixed>
          <div style={{ padding: "var(--p-space-200)", minWidth: "240px" }}>
            <BlockStack gap="0">
              {COMPARE_OPTIONS.map((option) => (
                <div key={option.key} className="reports-compare-option">
                  <RadioButton
                    label={option.label}
                    checked={effectiveMode === option.key}
                    disabled={isApplying}
                    onChange={() => {
                      if (option.key === "custom") {
                        setView("calendar");
                        return;
                      }
                      applyCompare(option.key);
                    }}
                  />
                </div>
              ))}
            </BlockStack>
          </div>
        </Popover.Pane>
      ) : (
        <CompareCalendarBody
          now={now}
          draftDefault={
            compareRange ?? {
              start: addUtcDays(utcDayStart(now), -59),
              end: addUtcDays(utcDayStart(now), -30),
            }
          }
          onCancel={() => setView("menu")}
          onApply={(range) => applyCompare("custom", range)}
        />
      )}
    </Popover>
  );
}

/**
 * ONE chart combining every active funnel event — matches Mantle's own
 * Traffic sources layout: a single multi-series area chart directly under
 * the stat tiles (each line colored the same as its tile's dot), with the
 * breakdown table below it. Replaces the previous design (one chart PER
 * funnel event, each multi-series by table row) — that per-row breakdown
 * is gone; this is the whole-report trend, aggregated across every
 * filtered row via `totalsTrend` (server-computed from the full,
 * unpaginated row set — see traffic-sources.server.ts — so it's never
 * short by whatever didn't fit on the current table page).
 */
function CombinedFunnelTrendChart({
  funnelEvents,
  funnelLabels,
  totals,
  totalsTrend,
  trendBuckets,
  interval,
}: {
  funnelEvents: FunnelEventKey[];
  funnelLabels: string[];
  /** Period totals per funnel event — the numbers on the tiles. */
  totals: Partial<Record<FunnelEventKey, number>>;
  totalsTrend: Partial<Record<FunnelEventKey, number[]>>;
  trendBuckets: TrendBucket[];
  interval: AnalyticsInterval;
}) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const bucketLabels = useMemo(
    () =>
      trendBuckets.map((bucket) =>
        chartPeriodLabel(bucket.periodStart, interval),
      ),
    [trendBuckets, interval],
  );
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  // Which tile is acting as the active tab. Deliberately local state, not a
  // URL param: it changes nothing about what is fetched, so putting it in the
  // URL would send the whole report back to the loader to redraw one chart.
  const [selectedKey, setSelectedKey] = useState<FunnelEventKey | null>(null);
  // A funnel event can disappear from the report (the Funnel events picker,
  // or a saved filter being restored) while it is the selected tab.
  const selected =
    selectedKey && funnelEvents.includes(selectedKey) ? selectedKey : null;
  if (bucketLabels.length === 0 || funnelEvents.length === 0) return null;

  // Isolating a tile draws only that series, so the chart's Y axis rescales to
  // it — the point of the interaction, since a 288-subscriber line is
  // unreadable on an axis sized for 2,929 page views.
  const plotted = selected
    ? funnelEvents
        .map((key, index) => ({ key, index }))
        .filter((entry) => entry.key === selected)
    : funnelEvents.map((key, index) => ({ key, index }));

  /* Follows the tiles, not the isolated view: it describes the funnel the
     report is showing, which does not change because you clicked one line. */
  const conversionKey = deepestConversion(funnelEvents);
  const conversionLabel = conversionKey
    ? (funnelLabels[funnelEvents.indexOf(conversionKey)] ?? conversionKey)
    : null;

  const series = plotted.map(({ key, index }) => ({
    name: funnelLabels[index],
    data: bucketLabels.map((label, bucketIndex) => ({
      key: label,
      value: totalsTrend[key]?.[bucketIndex] ?? 0,
    })),
    color:
      hoveredIndex === null || hoveredIndex === index
        ? funnelEventColor(key)
        : hexToRgba(funnelEventColor(key), 0.15),
  }));

  return (
    <Suspense
      fallback={
        <Card>
          <InlineStack gap="200" blockAlign="center">
            <Spinner accessibilityLabel="Loading traffic chart" size="small" />
            <Text as="p" tone="subdued">
              Loading interactive chart…
            </Text>
          </InlineStack>
        </Card>
      }
    >
      <PolarisVizProvider
        themes={{
          MantleTraffic: isDark ? MANTLE_CHART_THEME : MANTLE_CHART_THEME_LIGHT,
        }}
        defaultTheme="MantleTraffic"
      >
        <section className="reports-chart-card reports-traffic-chart">
          <div className="reports-chart-header">
            <div className="reports-chart-label">Traffic source trends</div>
            <div className="reports-chart-header-actions">
              {conversionKey ? (
                <Tooltip
                  content={`Counts ${conversionLabel} — the deepest funnel stage currently selected.`}
                >
                  <div className="reports-chart-conversions">
                    <span className="reports-chart-conversions-label">
                      Total conversions
                    </span>
                    <span className="reports-chart-conversions-value">
                      {(totals[conversionKey] ?? 0).toLocaleString()}
                    </span>
                  </div>
                </Tooltip>
              ) : null}
              {selected ? (
                <button
                  type="button"
                  className="reports-funnel-tiles-reset"
                  onClick={() => setSelectedKey(null)}
                >
                  Show all events
                </button>
              ) : null}
            </div>
          </div>
          <FunnelStatTiles
            funnelEvents={funnelEvents}
            funnelLabels={funnelLabels}
            totals={totals}
            selectedKey={selected}
            onSelect={setSelectedKey}
            hoveredIndex={hoveredIndex}
            onHoverIndex={setHoveredIndex}
          />
          <div
            className="reports-chart-canvas"
            aria-label={
              selected
                ? `Traffic source trends, ${funnelLabels[funnelEvents.indexOf(selected)]}`
                : "Traffic source trends, all funnel events"
            }
          >
            <LineChart
              data={series}
              showLegend={false}
              tooltipOptions={{
                renderTooltipContent: ({ activeIndex }) => {
                  const label = bucketLabels[activeIndex];
                  if (label === undefined) return null;
                  return (
                    <CountChartTooltip
                      title={label}
                      dark={isDark}
                      rows={plotted.map(({ key, index }) => ({
                        label: funnelLabels[index],
                        value: totalsTrend[key]?.[activeIndex] ?? 0,
                        color: funnelEventColor(key),
                      }))}
                    />
                  );
                },
              }}
              xAxisOptions={{ allowLineWrap: false }}
            />
          </div>
        </section>
      </PolarisVizProvider>
    </Suspense>
  );
}

/** The full view state a saved filter captures/restores — everything needed
 * to rebuild the exact same trafficUrl() the user was looking at. */
interface SavedFilterViewState {
  appId: string;
  appName: string;
  dimensions: PivotDimensionKey[];
  funnelEvents: FunnelEventKey[];
  filters: DimensionFilters;
  period: AnalyticsPeriod;
  dateRange?: { start: Date; end: Date };
  compare: { mode: CompareMode; range?: { start: Date; end: Date } };
}

function filterSummaryPills(source: {
  appName: string;
  dimensions: PivotDimensionKey[];
  funnelEvents: FunnelEventKey[];
  filters: DimensionFilters;
  rangeLabel: string;
  compareLabel: string;
}): string[] {
  const filterCount = Object.values(source.filters).reduce(
    (sum, values) => sum + (values?.length ?? 0),
    0,
  );
  return [
    source.appName,
    `${source.dimensions.length} pivot${source.dimensions.length === 1 ? "" : "s"}`,
    `${source.funnelEvents.length} funnel event${source.funnelEvents.length === 1 ? "" : "s"}`,
    filterCount > 0
      ? `${filterCount} filter${filterCount === 1 ? "" : "s"}`
      : "No filters",
    source.rangeLabel,
    source.compareLabel,
  ];
}

/** The live view as a saved state — the shape the legacy table held, so views
 * saved before and after the move to shared saved views read the same. */
function toTrafficSavedState(view: SavedFilterViewState): TrafficSavedState {
  return {
    dimensions: view.dimensions,
    funnelEvents: view.funnelEvents,
    filters: view.filters as TrafficSavedState["filters"],
    // "" (All apps) was always stored as null; kept so both read alike.
    appId: view.appId || null,
    period: view.period,
    dateRange: view.dateRange
      ? {
          start: view.dateRange.start.toISOString(),
          end: view.dateRange.end.toISOString(),
        }
      : null,
    compareMode: view.compare.mode,
    compareRange: view.compare.range
      ? {
          start: view.compare.range.start.toISOString(),
          end: view.compare.range.end.toISOString(),
        }
      : null,
  };
}

function trafficSavedStatePills(
  state: TrafficSavedState,
  apps: Array<{ id: string; name: string }>,
): string[] {
  const rangeLabel = state.dateRange
    ? `${shortDate(parseIsoDateUtc(state.dateRange.start)!)} - ${shortDate(
        parseIsoDateUtc(state.dateRange.end)!,
      )}`
    : state.period
      ? (PERIOD_LABELS[state.period as AnalyticsPeriod] ?? state.period)
      : "";
  return filterSummaryPills({
    appName: state.appId
      ? (apps.find((app) => app.id === state.appId)?.name ?? "Unknown app")
      : "All apps",
    dimensions: state.dimensions as PivotDimensionKey[],
    funnelEvents: state.funnelEvents as FunnelEventKey[],
    filters: state.filters as DimensionFilters,
    rangeLabel,
    compareLabel:
      !state.compareMode || state.compareMode === "none"
        ? "No comparison"
        : "Compare to…",
  });
}

/** Manual reset, always available in the toolbar (not tucked inside the
 * Saved filters dropdown) — clears pivot/funnel/filters back to defaults
 * without needing to open any picker first. */
function ResetFiltersButton({
  view,
  interval,
}: {
  view: SavedFilterViewState;
  interval: AnalyticsInterval;
}) {
  const navigate = useNavigate();
  return (
    <Button
      onClick={() =>
        navigate(
          trafficUrl(
            {
              dimensions: DEFAULT_PIVOT_DIMENSIONS,
              funnelEvents: DEFAULT_FUNNEL_EVENTS,
              filters: {},
            },
            view.period,
            view.appId,
            interval,
          ),
        )
      }
    >
      Reset filters
    </Button>
  );
}

export function TrafficSourcesPanel({
  data,
  period,
  appId,
  apps,
  interval,
  dateRange,
  compareMode,
  compareDateRange,
  savedFilters,
}: {
  data: NonNullable<Route.ComponentProps["loaderData"]["trafficSources"]>;
  period: AnalyticsPeriod;
  appId: string;
  apps: Array<{ id: string; name: string }>;
  interval: AnalyticsInterval;
  dateRange: { start: string; end: string } | null;
  compareMode: CompareMode;
  compareDateRange: { start: string; end: string } | null;
  savedFilters: Array<SavedView<TrafficSavedState>>;
}) {
  const navigation = useNavigation();
  const navigate = useNavigate();
  const isRefreshing =
    navigation.state === "loading" &&
    new URLSearchParams(navigation.location?.search).get("report") ===
      "traffic";
  // Only threaded through to other pickers when the user has explicitly
  // chosen a custom range — otherwise the shared Period selector keeps
  // governing the date range, same as before this feature existed.
  const activeDateRange = dateRange
    ? {
        start: parseIsoDateUtc(dateRange.start)!,
        end: parseIsoDateUtc(dateRange.end)!,
      }
    : undefined;
  // Threaded through every other picker/pagination link (mirroring
  // `activeDateRange`) so switching a filter or page doesn't silently drop
  // the user's "Compare to" selection.
  const activeCompare = {
    mode: compareMode,
    range: compareDateRange
      ? {
          start: parseIsoDateUtc(compareDateRange.start)!,
          end: parseIsoDateUtc(compareDateRange.end)!,
        }
      : undefined,
  };
  // For display only: derived from the report's actually-resolved range
  // (works whether that came from the shared Period or a custom override),
  // normalized to the inclusive last calendar day for a clean "Jun 28 - Jul
  // 28" label instead of an exact "now" instant.
  const displayStart = utcDayStart(new Date(data.periodStart));
  const displayEnd = utcDayStart(
    new Date(new Date(data.periodEnd).getTime() - 1),
  );
  const currentView: SavedFilterViewState = {
    appId,
    // "" is the page-level selector's "All apps", not an unset value — the
    // in-card app picker that used to force a single app is gone (the two
    // controls could disagree, and the page-level one is authoritative).
    appName: apps.find((app) => app.id === appId)?.name ?? "All apps",
    dimensions: data.dimensions,
    funnelEvents: data.funnelEvents,
    filters: data.filters,
    period,
    dateRange: activeDateRange,
    compare: activeCompare,
  };
  const savedViewProps = {
    report: "traffic" as const,
    current: toTrafficSavedState(currentView),
    describe: (state: TrafficSavedState) => trafficSavedStatePills(state, apps),
  };
  const applySavedView = (state: TrafficSavedState) => {
    const range = (value: { start: string; end: string } | null) =>
      value
        ? { start: parseIsoDateUtc(value.start)!, end: parseIsoDateUtc(value.end)! }
        : undefined;
    navigate(
      trafficUrl(
        {
          dimensions: state.dimensions as PivotDimensionKey[],
          funnelEvents: state.funnelEvents as FunnelEventKey[],
          filters: state.filters as DimensionFilters,
          dateRange: range(state.dateRange),
          compare: {
            mode: (state.compareMode as CompareMode) ?? "none",
            range: range(state.compareRange),
          },
        },
        (state.period as AnalyticsPeriod) ?? period,
        /* null is "All apps" — how every save from that view was stored. It
           used to fall back to the app on screen instead, so a view saved
           across all apps reopened for just one. */
        state.appId ?? "",
        interval,
      ),
    );
  };
  const resetView = () =>
    navigate(
      trafficUrl(
        {
          dimensions: DEFAULT_PIVOT_DIMENSIONS,
          funnelEvents: DEFAULT_FUNNEL_EVENTS,
          filters: {},
        },
        period,
        appId,
        interval,
      ),
    );
  const toolbar = (
    <InlineStack gap="200" blockAlign="center">
      <SavedViewsPicker
        {...savedViewProps}
        views={savedFilters}
        apply={applySavedView}
        reset={resetView}
      />
      <PivotPicker
        selected={data.dimensions}
        funnelEvents={data.funnelEvents}
        filters={data.filters}
        dateRange={activeDateRange}
        compare={activeCompare}
        period={period}
        appId={appId}
        interval={interval}
      />
      <FunnelPicker
        selected={data.funnelEvents}
        dimensions={data.dimensions}
        filters={data.filters}
        dateRange={activeDateRange}
        compare={activeCompare}
        period={period}
        appId={appId}
        interval={interval}
      />
      {data.dimensions.map((key) => {
        const dimensionLabel =
          PIVOT_DIMENSIONS.find((d) => d.key === key)?.label ?? key;
        return (
          <DimensionFilterPicker
            key={key}
            dimensionKey={key}
            dimensionLabel={dimensionLabel}
            availableValues={data.availableValues[key] ?? []}
            selected={data.filters[key] ?? []}
            filters={data.filters}
            dimensions={data.dimensions}
            funnelEvents={data.funnelEvents}
            dateRange={activeDateRange}
            compare={activeCompare}
            period={period}
            appId={appId}
            interval={interval}
          />
        );
      })}
      <TrafficDateRangePicker
        start={displayStart}
        end={displayEnd}
        dimensions={data.dimensions}
        funnelEvents={data.funnelEvents}
        filters={data.filters}
        compare={activeCompare}
        period={period}
        appId={appId}
        interval={interval}
      />
      <CompareToPicker
        compareMode={activeCompare.mode}
        compareRange={activeCompare.range}
        dimensions={data.dimensions}
        funnelEvents={data.funnelEvents}
        filters={data.filters}
        dateRange={activeDateRange}
        period={period}
        appId={appId}
        interval={interval}
      />
      <ResetFiltersButton view={currentView} interval={interval} />
      <SaveViewButton {...savedViewProps} />
    </InlineStack>
  );

  if (!data.available) {
    return (
      <BlockStack gap="400">
        {toolbar}
        <EmptyState
          heading="Connect acquisition analytics"
          image={EMPTY_STATE_IMAGE}
        >
          <p>
            {data.error ??
              "Configure the GA4 BigQuery export to see listing traffic and install conversion."}
          </p>
        </EmptyState>
      </BlockStack>
    );
  }

  if (data.rows.length === 0) {
    return (
      <BlockStack gap="400">
        {toolbar}
        <EmptyState
          heading="No traffic sources found"
          image={EMPTY_STATE_IMAGE}
        >
          <p>Try changing the pivot, funnel events, or date range.</p>
        </EmptyState>
      </BlockStack>
    );
  }

  const dimensionLabels = data.dimensions.map(
    (key) => PIVOT_DIMENSIONS.find((item) => item.key === key)?.label ?? key,
  );
  const funnelLabels = data.funnelEvents.map(
    (key) => FUNNEL_EVENTS.find((e) => e.key === key)?.label ?? key,
  );

  return (
    <BlockStack gap="400">
      {toolbar}
      {data.partialErrors && data.partialErrors.length > 0 ? (
        <Banner tone="warning" title="Some apps are missing from these totals">
          <p>
            {data.partialErrors.length} of this organization&rsquo;s apps could
            not be read, so the numbers below cover the rest only:{" "}
            {data.partialErrors.join(" ")}
          </p>
        </Banner>
      ) : null}
      <div
        className={
          isRefreshing ? "reports-traffic is-loading" : "reports-traffic"
        }
      >
        <CombinedFunnelTrendChart
          funnelEvents={data.funnelEvents}
          funnelLabels={funnelLabels}
          totals={data.totals ?? {}}
          totalsTrend={data.totalsTrend ?? {}}
          trendBuckets={data.trendBuckets}
          interval={interval}
        />
        <div className="reports-traffic-table">
          <DataTable
            truncate
            columnContentTypes={[
              ...dimensionLabels.map(() => "text" as const),
              ...funnelLabels.map(() => "text" as const),
              "text",
              "text",
            ]}
            headings={[...dimensionLabels, ...funnelLabels, "MRR", "CLV"].map(
              (heading) => (
                <div key={heading} style={{ textAlign: "center" }}>
                  {heading}
                </div>
              ),
            )}
            rows={data.rows.map((row) => {
              const formatFunnelCell = (
                funnel: Partial<Record<FunnelEventKey, number>>,
                key: FunnelEventKey,
                index: number,
              ) => {
                const count = funnel[key] ?? 0;
                const previousKey = data.funnelEvents[index - 1];
                return previousKey === undefined
                  ? count.toLocaleString()
                  : `${count.toLocaleString()} (${percent(
                      (funnel[previousKey] ?? 0) > 0
                        ? count / (funnel[previousKey] ?? 0)
                        : 0,
                    )})`;
              };
              const funnelCells = data.funnelEvents.map((key, index) => (
                <div key={key} style={{ textAlign: "center" }}>
                  <TruncatedCell
                    value={formatFunnelCell(row.funnel, key, index)}
                  />
                  {data.compareRange ? (
                    <Text as="span" tone="subdued" variant="bodySm">
                      {formatFunnelCell(row.compare ?? {}, key, index)}
                    </Text>
                  ) : null}
                </div>
              ));
              return [
                ...data.dimensions.map((key) => (
                  <TruncatedCell
                    key={key}
                    value={row.dimensions[key]}
                  />
                )),
                ...funnelCells,
                <TruncatedCell
                  key="mrr"
                  value={row.mrr === null ? "—" : formatMoney(row.mrr)}
                />,
                <TruncatedCell
                  key="clv"
                  value={row.clv === null ? "—" : formatMoney(row.clv)}
                />,
              ];
            })}
          />
        </div>
        {data.totalPages > 1 ? (
          <InlineStack align="center">
            <Pagination
              hasPrevious={data.page > 1}
              previousURL={trafficUrl(
                {
                  page: data.page - 1,
                  dimensions: data.dimensions,
                  funnelEvents: data.funnelEvents,
                  filters: data.filters,
                  dateRange: activeDateRange,
                  compare: activeCompare,
                },
                period,
                appId,
                interval,
              )}
              hasNext={data.page < data.totalPages}
              nextURL={trafficUrl(
                {
                  page: data.page + 1,
                  dimensions: data.dimensions,
                  funnelEvents: data.funnelEvents,
                  filters: data.filters,
                  dateRange: activeDateRange,
                  compare: activeCompare,
                },
                period,
                appId,
                interval,
              )}
              label={`Page ${data.page} of ${data.totalPages}`}
            />
          </InlineStack>
        ) : null}
        {isRefreshing ? (
          <div className="reports-traffic__spinner">
            <Spinner accessibilityLabel="Loading traffic report" size="large" />
          </div>
        ) : null}
      </div>
    </BlockStack>
  );
}
