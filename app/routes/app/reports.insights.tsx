import {
  ActionList,
  Banner,
  BlockStack,
  Button,
  ChoiceList,
  Popover,
  Text,
  Toast,
} from "@shopify/polaris";
import {
  CodeIcon,
  DataTableIcon,
  MenuHorizontalIcon,
} from "@shopify/polaris-icons";
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { InsightPie } from "~/components/insight-pie";
import { SavedViewsPicker, SaveViewButton } from "~/components/saved-views";
import type { AnalyticsPeriod } from "~/lib/reports/analytics.shared";
import { formatMoney } from "~/lib/format";
import {
  insightExportFilename,
  insightExportRows,
  insightRowsToCsv,
  insightRowsToJson,
} from "~/lib/reports/insight-export";
import type { TrafficInsightsReport } from "~/lib/reports/traffic-sources.server";
import {
  ADDITIVE_INSIGHT_METRICS,
  INSIGHT_DIMENSIONS,
  INSIGHT_EVENT_LABELS,
  INSIGHT_EVENTS,
  INSIGHT_LABELS,
  INSIGHT_METRIC_LABELS,
  INSIGHT_METRICS,
  type InsightEventKey,
  type InsightMetricKey,
  SHOPLESS_INSIGHT_EVENTS,
} from "~/lib/reports/traffic-sources.shared";
import type {
  InsightsSavedState,
  SavedView,
} from "~/lib/saved-views/saved-view-schemas";
import { PERIOD_LABELS } from "./reports";

/** The URL param carrying the selected event, so a view can be linked. */
export const INSIGHT_EVENT_PARAM = "insightEvent";

export function parseInsightEvent(value: string | null): InsightEventKey {
  return (INSIGHT_EVENTS as readonly string[]).includes(value ?? "")
    ? (value as InsightEventKey)
    : "listing_view";
}

export const INSIGHT_METRIC_PARAM = "insightMetric";

export function parseInsightMetric(value: string | null): InsightMetricKey {
  return (INSIGHT_METRICS as readonly string[]).includes(value ?? "")
    ? (value as InsightMetricKey)
    : "volume";
}

/** Whole dollars on a slice's label would round most averages to the same
 * figure; cents keep them apart. */
const formatUsd = (value: number) => formatMoney(value, "USD");

/**
 * Copies text, falling back to a hidden textarea when the async Clipboard API
 * isn't available. That API exists only in a secure context — https or
 * localhost — and this dashboard has been reached over a plain-http LAN
 * address in development, where it is simply undefined.
 */
async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission refused — fall through to the legacy path.
    }
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand("copy");
  area.remove();
  return ok;
}

function downloadText(filename: string, text: string, csv: boolean) {
  /* A UTF-8 byte-order mark on CSV only: without it Excel assumes the
     system code page and turns values like 像素 into mojibake. JSON parsers
     reject a BOM, so it never goes there. */
  const blob = new Blob([csv ? `\uFEFF${text}` : text], {
    type: csv ? "text/csv;charset=utf-8" : "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // After the click has been dispatched, or some browsers cancel the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Mantle's per-card menu: copy or download this pie's data as CSV or JSON. */
function InsightCardMenu({
  dimensionLabel,
  eventLabel,
  metric,
  slices,
  total,
  onResult,
}: {
  dimensionLabel: string;
  eventLabel: string;
  metric: InsightMetricKey;
  slices: ReadonlyArray<{ value: string; count: number }>;
  total: number;
  onResult: (message: string, isError?: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const volume = metric === "volume";

  const render = (format: "csv" | "json") => {
    const rows = insightExportRows(slices, total, !volume);
    return format === "csv"
      ? insightRowsToCsv(
          rows,
          dimensionLabel,
          volume ? "Count" : `${INSIGHT_METRIC_LABELS[metric]} (USD)`,
        )
      : insightRowsToJson(rows, volume ? "count" : `${metric}_usd`);
  };

  const copy = async (format: "csv" | "json") => {
    setOpen(false);
    const ok = await copyText(render(format));
    onResult(
      ok
        ? `Copied ${dimensionLabel} as ${format.toUpperCase()}`
        : "Couldn't copy — your browser blocked clipboard access",
      !ok,
    );
  };

  const download = (format: "csv" | "json") => {
    setOpen(false);
    downloadText(
      insightExportFilename({
        dimensionLabel,
        eventLabel,
        metricLabel: volume ? undefined : INSIGHT_METRIC_LABELS[metric],
        date: new Date(),
        extension: format,
      }),
      render(format),
      format === "csv",
    );
  };

  return (
    <div
      className={`insight-card__menu${open ? " insight-card__menu--open" : ""}`}
    >
      <Popover
        active={open}
        activator={
          <Button
            icon={MenuHorizontalIcon}
            onClick={() => setOpen((value) => !value)}
            accessibilityLabel={`Export ${dimensionLabel}`}
          />
        }
        onClose={() => setOpen(false)}
        preferredAlignment="right"
      >
        <ActionList
          actionRole="menuitem"
          sections={[
            {
              title: "Copy to clipboard",
              items: [
                { content: "CSV", icon: DataTableIcon, onAction: () => copy("csv") },
                { content: "JSON", icon: CodeIcon, onAction: () => copy("json") },
              ],
            },
            {
              title: "Download",
              items: [
                { content: "CSV", icon: DataTableIcon, onAction: () => download("csv") },
                { content: "JSON", icon: CodeIcon, onAction: () => download("json") },
              ],
            },
          ]}
        />
      </Popover>
    </div>
  );
}

/**
 * Traffic source insights: one pie per dimension, all answering the same
 * question — "where did this event come from?" — for the chosen app, period
 * and event.
 *
 * App and period come from the page-level controls every report shares; only
 * the event is this report's own. It lives in the URL rather than in state
 * because changing it needs fresh data from the loader, and a URL is also what
 * makes a view shareable.
 */
export function TrafficInsightsPanel({
  report,
  appId,
  period,
  apps,
  savedViews,
}: {
  report: TrafficInsightsReport;
  /** The page-level app ("" is All apps) and period — part of a saved view. */
  appId: string;
  period: AnalyticsPeriod;
  apps: Array<{ id: string; name: string }>;
  savedViews: Array<SavedView<InsightsSavedState>>;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const [eventOpen, setEventOpen] = useState(false);
  const [metricOpen, setMetricOpen] = useState(false);
  const [toast, setToast] = useState<{ message: string; error: boolean } | null>(
    null,
  );
  const event = report.event;
  /* What the server actually drew, not what the URL asked for: a revenue
     metric on Page views comes back as Volume. The URL keeps the request, so
     switching back to a shop event restores it. */
  const metric = report.metric;
  const shopless = SHOPLESS_INSIGHT_EVENTS.has(event);
  const volume = metric === "volume";
  const formatValue = volume ? undefined : formatUsd;

  const setParam = (key: string, value: string) =>
    setSearchParams(
      (params) => {
        params.set(key, value);
        return params;
      },
      /* A dropdown change is not a navigation the reader should be able to
         "go back" through, and it must not jump them to the top. */
      { replace: true, preventScrollReset: true },
    );

  const chooseEvent = (next: InsightEventKey) => {
    setEventOpen(false);
    if (next !== event) setParam(INSIGHT_EVENT_PARAM, next);
  };

  const chooseMetric = (next: InsightMetricKey) => {
    setMetricOpen(false);
    if (next !== metric) setParam(INSIGHT_METRIC_PARAM, next);
  };

  /* A saved view is what's on screen: the drawn metric, not a revenue metric
     the URL asked for on an event that can't show one. */
  const savedViewProps = {
    report: "insights" as const,
    current: { appId: appId || null, period, event, metric },
    describe: (state: InsightsSavedState) => [
      state.appId
        ? (apps.find((app) => app.id === state.appId)?.name ?? "Unknown app")
        : "All apps",
      state.period
        ? (PERIOD_LABELS[state.period as AnalyticsPeriod] ?? state.period)
        : PERIOD_LABELS[period],
      `Event: ${INSIGHT_EVENT_LABELS[state.event]}`,
      `Metric: ${INSIGHT_METRIC_LABELS[state.metric]}`,
    ],
  };

  const applySavedView = (state: InsightsSavedState) => {
    const params = new URLSearchParams({
      report: "insights",
      period: state.period ?? period,
      [INSIGHT_EVENT_PARAM]: state.event,
      [INSIGHT_METRIC_PARAM]: state.metric,
    });
    if (state.appId) params.set("appId", state.appId);
    navigate(`/app/reports?${params.toString()}`);
  };

  /* Judged on the URL, not on what's drawn: a revenue metric chosen on Page
     views shows as Volume but is still a setting Reset clears. */
  const isFiltered =
    event !== "listing_view" ||
    parseInsightMetric(searchParams.get(INSIGHT_METRIC_PARAM)) !== "volume";

  /** Event and Metric back to their defaults; app and period stay. */
  const resetView = () =>
    setSearchParams(
      (params) => {
        params.delete(INSIGHT_EVENT_PARAM);
        params.delete(INSIGHT_METRIC_PARAM);
        return params;
      },
      { replace: true, preventScrollReset: true },
    );

  return (
    <BlockStack gap="400">
      <div className="reports-trial-toolbar">
        <SavedViewsPicker
          {...savedViewProps}
          views={savedViews}
          apply={applySavedView}
          reset={resetView}
        />
        <Popover
          active={eventOpen}
          activator={
            <Button disclosure onClick={() => setEventOpen((open) => !open)}>
              {`Event: ${INSIGHT_EVENT_LABELS[event]}`}
            </Button>
          }
          autofocusTarget="first-node"
          onClose={() => setEventOpen(false)}
        >
          <div className="reports-trial-choice">
            <ChoiceList
              title="Event"
              titleHidden
              choices={INSIGHT_EVENTS.map((key) => ({
                label: INSIGHT_EVENT_LABELS[key],
                value: key,
              }))}
              selected={[event]}
              onChange={(selected) =>
                chooseEvent(selected[0] as InsightEventKey)
              }
            />
          </div>
        </Popover>
        <Popover
          active={metricOpen}
          activator={
            <Button disclosure onClick={() => setMetricOpen((open) => !open)}>
              {`Metric: ${INSIGHT_METRIC_LABELS[metric]}`}
            </Button>
          }
          autofocusTarget="first-node"
          onClose={() => setMetricOpen(false)}
        >
          <div className="reports-trial-choice">
            <ChoiceList
              title="Metric"
              titleHidden
              choices={INSIGHT_METRICS.map((key) => ({
                label: INSIGHT_METRIC_LABELS[key],
                value: key,
                disabled: shopless && key !== "volume",
              }))}
              selected={[metric]}
              onChange={(selected) =>
                chooseMetric(selected[0] as InsightMetricKey)
              }
            />
            {shopless ? (
              <Text as="p" variant="bodySm" tone="subdued">
                Page views and Add app clicks happen before a visitor has a
                store, so there&apos;s no customer revenue to measure.
              </Text>
            ) : null}
          </div>
        </Popover>
        {isFiltered ? <Button onClick={resetView}>Reset filters</Button> : null}
        <SaveViewButton {...savedViewProps} />
      </div>

      {!volume ? (
        <Text as="p" variant="bodySm" tone="subdued">
          {metric.endsWith("_clv")
            ? "CLV is everything a customer has paid this app. Each customer counts once per slice; customers who never paid count as $0."
            : "Spend is a customer's average monthly payment, an annual plan counting as twelve months. Each customer counts once per slice; customers who never paid count as $0."}
        </Text>
      ) : null}

      {!report.available ? (
        <Banner tone="warning" title="Traffic data isn't available">
          <p>{report.error ?? "This app has no traffic data configured."}</p>
        </Banner>
      ) : (
        <div className="insight-grid">
          {INSIGHT_DIMENSIONS.map((dimension) => (
            <section
              key={dimension}
              className="reports-chart-card insight-card"
            >
              <Text as="h2" variant="headingMd">
                {INSIGHT_LABELS[dimension]}
              </Text>
              <InsightPie
                title={`${INSIGHT_LABELS[dimension]} — ${INSIGHT_EVENT_LABELS[event]}, ${INSIGHT_METRIC_LABELS[metric]}`}
                data={report.pies[dimension].slices}
                total={report.pies[dimension].total}
                valueLabel={volume ? "Count" : INSIGHT_METRIC_LABELS[metric]}
                formatValue={formatValue}
                additive={ADDITIVE_INSIGHT_METRICS.has(metric)}
                emptyText={
                  volume || report.total === 0
                    ? undefined
                    : "No revenue from these customers yet."
                }
              />
              {/* Said out loud because the percentages exclude these: a pie
                  that quietly shrinks its denominator reads as the whole. */}
              {/* Nothing to export from an empty pie. */}
              {report.pies[dimension].total > 0 ? (
                <InsightCardMenu
                  dimensionLabel={INSIGHT_LABELS[dimension]}
                  eventLabel={INSIGHT_EVENT_LABELS[event]}
                  metric={metric}
                  slices={report.pies[dimension].slices}
                  total={report.pies[dimension].total}
                  onResult={(message, isError) =>
                    setToast({ message, error: Boolean(isError) })
                  }
                />
              ) : null}
              {report.pies[dimension].unset > 0 ? (
                <Text as="p" variant="bodySm" tone="subdued">
                  {`Excludes ${report.pies[dimension].unset.toLocaleString()}${volume ? "" : " customers"} with no ${INSIGHT_LABELS[dimension].toLowerCase()} recorded.`}
                </Text>
              ) : null}
            </section>
          ))}
        </div>
      )}

      {toast ? (
        <Toast
          content={toast.message}
          error={toast.error}
          onDismiss={() => setToast(null)}
        />
      ) : null}
    </BlockStack>
  );
}
