import { z } from "zod";
import {
  INSIGHT_EVENTS,
  INSIGHT_METRICS,
} from "~/lib/reports/traffic-sources.shared";

/**
 * What each report stores in a saved view (`SavedReportView.state`), and the
 * only place that decides it. Client-safe: the UI builds states against these
 * types and the server validates every write and read with them.
 *
 * Reads are lenient on purpose — a field that no longer parses falls back to
 * its default rather than hiding the whole saved view — because a report's
 * options change over time (funnel events have been removed before) and a
 * team's saved filters shouldn't vanish when they do.
 */

const isoRange = z.object({ start: z.string(), end: z.string() }).nullable();

/** "a,,b" and a trailing comma never meant empty keys; the legacy reader
 * dropped them with `.filter(Boolean)`, and so does this. */
const keyList = z
  .array(z.string())
  .catch([])
  .transform((keys) => keys.filter(Boolean));

/** The Traffic trends report: its whole view, as the legacy
 * `traffic_saved_filters` table held it (the migration copies into this shape). */
export const trafficSavedStateSchema = z.object({
  dimensions: keyList,
  funnelEvents: keyList,
  filters: z.record(z.string(), z.array(z.string())).catch({}),
  /** `null` or "" is the page's "All apps". */
  appId: z.string().nullable().catch(null),
  period: z.string().nullable().catch(null),
  dateRange: isoRange.catch(null),
  compareMode: z.string().nullable().catch(null),
  compareRange: isoRange.catch(null),
});

/** Traffic source insights: app, period, Event and Metric. */
export const insightsSavedStateSchema = z.object({
  appId: z.string().nullable().catch(null),
  period: z.string().nullable().catch(null),
  event: z.enum(INSIGHT_EVENTS).catch("listing_view"),
  metric: z.enum(INSIGHT_METRICS).catch("volume"),
});

/** Every report that offers saved views. Adding one here is the whole
 * storage side of giving a report saved filters. */
export const SAVED_VIEW_SCHEMAS = {
  traffic: trafficSavedStateSchema,
  insights: insightsSavedStateSchema,
} as const;

export type SavedViewReport = keyof typeof SAVED_VIEW_SCHEMAS;

export type SavedViewState<R extends SavedViewReport> = z.output<
  (typeof SAVED_VIEW_SCHEMAS)[R]
>;

export type TrafficSavedState = SavedViewState<"traffic">;
export type InsightsSavedState = SavedViewState<"insights">;

export interface SavedView<S> {
  id: string;
  name: string;
  state: S;
}

/** Longest label the `name` column (VARCHAR(191)) holds. */
export const SAVED_VIEW_NAME_MAX = 191;

export function isSavedViewReport(value: string): value is SavedViewReport {
  return Object.hasOwn(SAVED_VIEW_SCHEMAS, value);
}
