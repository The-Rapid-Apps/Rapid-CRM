import { useEffect, useMemo, useState } from "react";
import { useFilterState } from "~/lib/use-filter-state";
import {
  Badge,
  BlockStack,
  Button,
  Card,
  DescriptionList,
  EmptyState,
  IndexTable,
  InlineGrid,
  InlineStack,
  Page,
  Pagination,
  Select,
  Tabs,
  Text,
  TextField,
} from "@shopify/polaris";
import { Form, useNavigate, useRevalidator, useSubmit } from "react-router";
import type { Prisma } from "../../../generated/prisma/client";
import type { Route } from "./+types/api-logs";
import { prisma } from "~/lib/db.server";
import { requireCurrentOrganization } from "~/lib/current-org.server";
import { EMPTY_STATE_IMAGE } from "~/lib/ui";
import { AppPicker } from "~/components/app-picker";

const PAGE_SIZE = 50;

const PERIOD_OPTIONS = [
  { label: "Last hour", value: "1h" },
  { label: "Last 24 hours", value: "24h" },
  { label: "Last 7 days", value: "7d" },
  { label: "Last 30 days", value: "30d" },
];

const METHOD_OPTIONS = [
  { label: "All methods", value: "" },
  ...["GET", "POST", "PUT", "PATCH", "DELETE"].map((value) => ({
    label: value,
    value,
  })),
];

const STATUS_OPTIONS = [
  { label: "All statuses", value: "" },
  { label: "Successful (2xx)", value: "success" },
  { label: "Redirected (3xx)", value: "redirect" },
  { label: "Client errors (4xx)", value: "client_error" },
  { label: "Server errors (5xx)", value: "server_error" },
];

function periodStart(period: string) {
  const hours =
    period === "1h"
      ? 1
      : period === "7d"
        ? 24 * 7
        : period === "30d"
          ? 24 * 30
          : 24;
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

function statusRange(status: string) {
  if (status === "success") return { gte: 200, lt: 300 };
  if (status === "redirect") return { gte: 300, lt: 400 };
  if (status === "client_error") return { gte: 400, lt: 500 };
  if (status === "server_error") return { gte: 500, lt: 600 };
  return undefined;
}

function detailUrl(
  id: string | null,
  filters: {
    q: string;
    appId: string;
    method: string;
    status: string;
    period: string;
    page: number;
  },
) {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.appId) params.set("appId", filters.appId);
  if (filters.method) params.set("method", filters.method);
  if (filters.status) params.set("status", filters.status);
  params.set("period", filters.period);
  if (filters.page > 1) params.set("page", String(filters.page));
  if (id) params.set("selected", id);
  return `/app/api-logs?${params}`;
}

function toSerializableLog<T extends { durationMs: { toString(): string } }>(
  log: T,
) {
  return { ...log, durationMs: log.durationMs.toString() };
}

export async function loader({ request }: Route.LoaderArgs) {
  const org = await requireCurrentOrganization(request);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 255);
  const requestedAppId = url.searchParams.get("appId") ?? "";
  const requestedPeriod = url.searchParams.get("period") ?? "24h";
  const period = PERIOD_OPTIONS.some(
    (option) => option.value === requestedPeriod,
  )
    ? requestedPeriod
    : "24h";
  const requestedMethod = (url.searchParams.get("method") ?? "").toUpperCase();
  const method = METHOD_OPTIONS.some(
    (option) => option.value === requestedMethod,
  )
    ? requestedMethod
    : "";
  const requestedStatus = url.searchParams.get("status") ?? "";
  const status = STATUS_OPTIONS.some(
    (option) => option.value === requestedStatus,
  )
    ? requestedStatus
    : "";
  const requestedPage = Number.parseInt(
    url.searchParams.get("page") ?? "1",
    10,
  );
  const page =
    Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;

  const apps = await prisma.app.findMany({
    where: {
      organizationId: org.id,
      removed: false,
      scheduledForDeletionAt: null,
    },
    orderBy: { name: "asc" },
    select: { id: true, name: true, logoUrl: true },
  });
  const appId = apps.some((app) => app.id === requestedAppId)
    ? requestedAppId
    : "";

  const where: Prisma.ApiRequestLogWhereInput = {
    organizationId: org.id,
    createdAt: { gte: periodStart(period) },
    ...(appId ? { appId } : {}),
    ...(method ? { method } : {}),
    ...(statusRange(status) ? { status: statusRange(status) } : {}),
    ...(q
      ? {
          OR: [
            { path: { contains: q } },
            { customer: { contains: q } },
            { requestId: { contains: q } },
          ],
        }
      : {}),
  };

  const [total, logs, aggregate] = await Promise.all([
    prisma.apiRequestLog.count({ where }),
    prisma.apiRequestLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { app: { select: { id: true, name: true } } },
    }),
    prisma.apiRequestLog.aggregate({
      where,
      _avg: { durationMs: true },
    }),
  ]);

  const selectedId = url.searchParams.get("selected");
  const selected =
    (selectedId
      ? await prisma.apiRequestLog.findFirst({
          where: { id: selectedId, organizationId: org.id },
          include: { app: { select: { id: true, name: true } } },
        })
      : logs[0]) ?? null;

  return {
    apps,
    logs: logs.map(toSerializableLog),
    selected: selected ? toSerializableLog(selected) : null,
    total,
    page,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    averageDurationMs: aggregate._avg.durationMs?.toString() ?? null,
    filters: { q, appId, method, status, period },
  };
}

function statusTone(status: number) {
  if (status >= 500) return "critical" as const;
  if (status >= 400) return "warning" as const;
  if (status >= 300) return "info" as const;
  return "success" as const;
}

function formatDate(value: string | Date) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value));
}

function formatPayload(value: unknown) {
  if (value === null || value === undefined) return "No payload captured.";
  return JSON.stringify(value, null, 2);
}

export default function ApiLogsPage({ loaderData }: Route.ComponentProps) {
  const {
    apps,
    logs,
    selected,
    total,
    page,
    totalPages,
    averageDurationMs,
    filters,
  } = loaderData;
  const navigate = useNavigate();
  const submit = useSubmit();
  const revalidator = useRevalidator();
  const [live, setLive] = useState(false);
  const [tab, setTab] = useState(0);
  const [q, setQ] = useFilterState(filters.q);
  const [appId, setAppId] = useFilterState(filters.appId);
  const [method, setMethod] = useFilterState(filters.method);
  const [status, setStatus] = useFilterState(filters.status);
  const [period, setPeriod] = useFilterState(filters.period);

  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => revalidator.revalidate(), 5_000);
    return () => window.clearInterval(timer);
  }, [live, revalidator]);

  useEffect(() => setTab(0), [selected?.id]);

  useEffect(() => {
    setQ(filters.q);
    setAppId(filters.appId);
    setMethod(filters.method);
    setStatus(filters.status);
    setPeriod(filters.period);
  }, [
    filters.appId,
    filters.method,
    filters.period,
    filters.q,
    filters.status,
  ]);

  const applyFilters = () => {
    const data = new FormData();
    if (q.trim()) data.set("q", q.trim());
    if (appId) data.set("appId", appId);
    if (method) data.set("method", method);
    if (status) data.set("status", status);
    data.set("period", period);
    submit(data, { method: "get", action: "/app/api-logs" });
  };

  const currentFilters = useMemo(() => ({ ...filters, page }), [filters, page]);
  const pageUrl = (nextPage: number) =>
    detailUrl(null, { ...currentFilters, page: nextPage });

  const detailItems = selected
    ? [
        { term: "Request ID", description: selected.requestId },
        {
          term: "HTTP status",
          description: (
            <Badge tone={statusTone(selected.status)}>
              {String(selected.status)}
            </Badge>
          ),
        },
        { term: "Time", description: formatDate(selected.createdAt) },
        {
          term: "Duration",
          description: `${Number(selected.durationMs).toLocaleString(
            undefined,
            {
              maximumFractionDigits: 3,
            },
          )} ms`,
        },
        { term: "IP address", description: selected.ipAddress ?? "—" },
        { term: "Customer", description: selected.customer ?? "—" },
        { term: "App", description: selected.app?.name ?? "Deleted app" },
        { term: "User agent", description: selected.userAgent ?? "—" },
      ]
    : [];

  const payload =
    tab === 0
      ? selected?.responseBody
      : tab === 1
        ? selected?.requestBody
        : {
            request: selected?.requestHeaders,
            response: selected?.responseHeaders,
          };

  return (
    <Page
      title="API logs"
      subtitle="Inspect requests made by your apps to the Rapid platform API."
      fullWidth
      primaryAction={{
        content: live ? "Live stream on" : "Start live stream",
        loading: revalidator.state !== "idle",
        onAction: () => setLive((active) => !active),
      }}
      secondaryActions={[
        {
          content: "Refresh",
          onAction: () => revalidator.revalidate(),
          loading: revalidator.state !== "idle",
        },
      ]}
    >
      <BlockStack gap="400">
        <Card>
          <Form
            method="get"
            onSubmit={(event) => {
              event.preventDefault();
              applyFilters();
            }}
          >
            <BlockStack gap="300">
              <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="300">
                <Select
                  label="Time range"
                  options={PERIOD_OPTIONS}
                  value={period}
                  onChange={setPeriod}
                />
                <AppPicker value={appId} apps={apps} onChange={setAppId} />
                <Select
                  label="Status"
                  options={STATUS_OPTIONS}
                  value={status}
                  onChange={setStatus}
                />
                <Select
                  label="Method"
                  options={METHOD_OPTIONS}
                  value={method}
                  onChange={setMethod}
                />
              </InlineGrid>
              <InlineStack gap="300" blockAlign="end" wrap={false}>
                <div className="api-log-search">
                  <TextField
                    label="Search"
                    labelHidden
                    placeholder="Search by URL, customer, or request ID"
                    value={q}
                    onChange={setQ}
                    autoComplete="off"
                    clearButton
                    onClearButtonClick={() => setQ("")}
                  />
                </div>
                <Button variant="primary" submit>
                  Apply filters
                </Button>
                <Button url="/app/api-logs">Reset</Button>
              </InlineStack>
              <InlineStack gap="500">
                <Text as="p" tone="subdued">
                  {total.toLocaleString()} requests
                </Text>
                <Text as="p" tone="subdued">
                  Average response:{" "}
                  {averageDurationMs
                    ? `${Number(averageDurationMs).toFixed(1)} ms`
                    : "—"}
                </Text>
                {live ? (
                  <Badge tone="success">Refreshing every 5 seconds</Badge>
                ) : null}
              </InlineStack>
            </BlockStack>
          </Form>
        </Card>

        {logs.length === 0 ? (
          <Card>
            <EmptyState
              heading={
                filters.q || filters.appId || filters.method || filters.status
                  ? "No API requests match these filters"
                  : "No API requests captured yet"
              }
              image={EMPTY_STATE_IMAGE}
              action={
                filters.q || filters.appId || filters.method || filters.status
                  ? { content: "Clear filters", url: "/app/api-logs" }
                  : { content: "View API keys", url: "/app/apps" }
              }
            >
              <p>
                Authenticated calls to the Flex Billing and Discounts APIs will
                appear here automatically.
              </p>
            </EmptyState>
          </Card>
        ) : (
          <div className="api-logs-workbench">
            <Card padding="0">
              <div className="api-logs-table">
                <IndexTable
                  resourceName={{ singular: "request", plural: "requests" }}
                  itemCount={logs.length}
                  selectable={false}
                  headings={[
                    { title: "Status" },
                    { title: "Request" },
                    { title: "App" },
                    { title: "Customer" },
                    { title: "Time" },
                  ]}
                >
                  {logs.map((log, index) => (
                    <IndexTable.Row
                      id={log.id}
                      key={log.id}
                      position={index}
                      selected={selected?.id === log.id}
                      onClick={() =>
                        navigate(detailUrl(log.id, currentFilters))
                      }
                    >
                      <IndexTable.Cell>
                        <Badge tone={statusTone(log.status)}>
                          {String(log.status)}
                        </Badge>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text as="span" fontWeight="semibold">
                          {log.method} {log.path}
                        </Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        {log.app?.name ?? "Deleted app"}
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        {log.customer ?? "Unknown"}
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        {formatDate(log.createdAt)}
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  ))}
                </IndexTable>
              </div>
              <div className="api-logs-pagination">
                <Text as="p" tone="subdued">
                  Page {page} of {totalPages}
                </Text>
                <Pagination
                  hasPrevious={page > 1}
                  onPrevious={() => navigate(pageUrl(page - 1))}
                  hasNext={page < totalPages}
                  onNext={() => navigate(pageUrl(page + 1))}
                />
              </div>
            </Card>

            <Card padding="0">
              {selected ? (
                <div className="api-log-detail">
                  <div className="api-log-detail__header">
                    <BlockStack gap="100">
                      <Text as="h2" variant="headingMd">
                        {selected.method} {selected.path}
                      </Text>
                      {selected.query ? (
                        <Text as="p" tone="subdued">
                          ?{selected.query}
                        </Text>
                      ) : null}
                    </BlockStack>
                  </div>
                  <div className="api-log-detail__meta">
                    <DescriptionList items={detailItems} gap="tight" />
                  </div>
                  <div className="api-log-detail__payload">
                    <Tabs
                      tabs={[
                        { id: "response", content: "Response" },
                        { id: "request", content: "Request" },
                        { id: "headers", content: "Headers" },
                      ]}
                      selected={tab}
                      onSelect={setTab}
                    >
                      <pre className="api-log-code">
                        <code>{formatPayload(payload)}</code>
                      </pre>
                    </Tabs>
                  </div>
                </div>
              ) : null}
            </Card>
          </div>
        )}
      </BlockStack>
    </Page>
  );
}
