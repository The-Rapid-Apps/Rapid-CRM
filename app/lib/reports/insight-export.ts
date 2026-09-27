import { csvCell } from "~/lib/csv";

/**
 * CSV and JSON for a Traffic source insights pie — the "Copy to clipboard" and
 * "Download" menu on each card, as Mantle offers.
 *
 * Pure and client-safe, so the escaping rules can be tested directly: that is
 * where exports go wrong.
 */

export interface InsightExportRow {
  value: string;
  /** Events for Volume; USD, rounded to the cent, for a revenue metric. */
  count: number;
  /** Share of this pie, as a percentage rounded to one decimal. */
  percentage: number;
}

/**
 * Every recorded value, not just the eight the pie colours.
 *
 * The pie folds its tail into "Other" because a chart can't show 200 slices; a
 * spreadsheet can, and an export that repeated the fold would throw away
 * exactly the detail someone downloads it for.
 */
export function insightExportRows(
  slices: ReadonlyArray<{ value: string; count: number }>,
  total: number,
  money = false,
): InsightExportRow[] {
  return slices.map((slice) => ({
    value: slice.value,
    count: money ? Math.round(slice.count * 100) / 100 : slice.count,
    percentage:
      total === 0 ? 0 : Math.round((slice.count / total) * 1000) / 10,
  }));
}

/* Quoting and the CSV-injection guard live in ~/lib/csv, shared with every
   other export. */
export function insightRowsToCsv(
  rows: InsightExportRow[],
  valueHeader: string,
  countHeader = "Count",
): string {
  const lines = [
    [csvCell(valueHeader), csvCell(countHeader), "Percentage"].join(","),
    ...rows.map((row) =>
      [csvCell(row.value), String(row.count), String(row.percentage)].join(
        ",",
      ),
    ),
  ];
  // CRLF is RFC 4180's line ending, and what Excel expects.
  return lines.join("\r\n");
}

/** `countKey` renames the number for a revenue metric — a field called
 * "count" holding dollars would be misread by whatever consumes the file. */
export function insightRowsToJson(
  rows: InsightExportRow[],
  countKey = "count",
): string {
  return JSON.stringify(
    rows.map((row) => ({
      value: row.value,
      [countKey]: row.count,
      percentage: row.percentage,
    })),
    null,
    2,
  );
}

/** `traffic-insights-search-term-page-views-2026-09-24.csv`, with the metric
 * after the event when it isn't Volume. */
export function insightExportFilename(params: {
  dimensionLabel: string;
  eventLabel: string;
  metricLabel?: string;
  date: Date;
  extension: "csv" | "json";
}): string {
  const slug = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  const metric = params.metricLabel ? `-${slug(params.metricLabel)}` : "";
  return `traffic-insights-${slug(params.dimensionLabel)}-${slug(
    params.eventLabel,
  )}${metric}-${params.date.toISOString().slice(0, 10)}.${params.extension}`;
}
