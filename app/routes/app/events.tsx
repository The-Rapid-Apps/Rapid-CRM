import { useState } from "react";
import {
  Badge,
  BlockStack,
  Button,
  Card,
  EmptyState,
  IndexTable,
  InlineGrid,
  InlineStack,
  Page,
  Pagination,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { Form, useNavigate } from "react-router";
import type { Prisma } from "../../../generated/prisma/client";
import type { Route } from "./+types/events";
import { AppPicker } from "~/components/app-picker";
import { prisma } from "~/lib/db.server";
import { requireCurrentOrganization } from "~/lib/current-org.server";
import { formatDateTime, formatMoney } from "~/lib/format";
import { EMPTY_STATE_IMAGE } from "~/lib/ui";

const PAGE_SIZE = 50;

const EVENT_OPTIONS = [
  { label: "All lifecycle events", value: "" },
  { label: "Activated", value: "SUBSCRIPTION_CHARGE_ACTIVATED" },
  { label: "Unfrozen", value: "SUBSCRIPTION_CHARGE_UNFROZEN" },
  { label: "Frozen", value: "SUBSCRIPTION_CHARGE_FROZEN" },
  { label: "Canceled", value: "SUBSCRIPTION_CHARGE_CANCELED" },
  { label: "Declined", value: "SUBSCRIPTION_CHARGE_DECLINED" },
  { label: "Expired", value: "SUBSCRIPTION_CHARGE_EXPIRED" },
];

const PERIOD_OPTIONS = [
  { label: "Last 7 days", value: "7d" },
  { label: "Last 30 days", value: "30d" },
  { label: "Last 90 days", value: "90d" },
  { label: "All time", value: "all" },
];

const EVENT_META: Record<
  string,
  {
    label: string;
    tone: "success" | "info" | "warning" | "critical" | "attention";
  }
> = {
  SUBSCRIPTION_CHARGE_ACTIVATED: { label: "Activated", tone: "success" },
  SUBSCRIPTION_CHARGE_UNFROZEN: { label: "Unfrozen", tone: "info" },
  SUBSCRIPTION_CHARGE_FROZEN: { label: "Frozen", tone: "warning" },
  SUBSCRIPTION_CHARGE_CANCELED: { label: "Canceled", tone: "critical" },
  SUBSCRIPTION_CHARGE_DECLINED: { label: "Declined", tone: "critical" },
  SUBSCRIPTION_CHARGE_EXPIRED: { label: "Expired", tone: "attention" },
};

function periodStart(period: string) {
  const days = period === "7d" ? 7 : period === "90d" ? 90 : 30;
  if (period === "all") return null;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function pageUrl(
  page: number,
  filters: { q: string; appId: string; type: string; period: string },
) {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.appId) params.set("appId", filters.appId);
  if (filters.type) params.set("type", filters.type);
  params.set("period", filters.period);
  if (page > 1) params.set("page", String(page));
  return `/app/events?${params.toString()}`;
}

export async function loader({ request }: Route.LoaderArgs) {
  const org = await requireCurrentOrganization(request);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 255);
  const requestedAppId = url.searchParams.get("appId") ?? "";
  const requestedType = url.searchParams.get("type") ?? "";
  const requestedPeriod = url.searchParams.get("period") ?? "30d";
  const period = PERIOD_OPTIONS.some(
    (option) => option.value === requestedPeriod,
  )
    ? requestedPeriod
    : "30d";
  const type = EVENT_OPTIONS.some((option) => option.value === requestedType)
    ? requestedType
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
    select: {
      id: true,
      name: true,
      logoUrl: true,
      billingEventsSyncedAt: true,
      billingEventsBackfillCompletedAt: true,
    },
  });
  const appId = apps.some((app) => app.id === requestedAppId)
    ? requestedAppId
    : "";
  const start = periodStart(period);
  // Filtering by `appId IN (...)` directly (using the org-scoped app list
  // already fetched above) instead of a relational `app: { organizationId }`
  // join produces a much better query plan — confirmed via EXPLAIN
  // (2026-08-09): the relational join forces MySQL into a per-app nested
  // loop + temp-table sort to merge results back into occurredAt order,
  // while filtering directly on `appId` lets it do a single sorted range
  // scan on the existing `(appId, occurredAt)` index instead.
  const baseWhere: Prisma.PartnerSubscriptionEventWhereInput = {
    appId: appId ? appId : { in: apps.map((app) => app.id) },
    test: false,
    ...(q ? { shopDomain: { contains: q } } : {}),
    ...(start ? { occurredAt: { gte: start } } : {}),
  };
  const where: Prisma.PartnerSubscriptionEventWhereInput = {
    ...baseWhere,
    ...(type ? { type } : {}),
  };

  const [total, grouped, records] = await Promise.all([
    prisma.partnerSubscriptionEvent.count({ where }),
    prisma.partnerSubscriptionEvent.groupBy({
      by: ["type"],
      where: baseWhere,
      _count: { _all: true },
    }),
    prisma.partnerSubscriptionEvent.findMany({
      where,
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        type: true,
        occurredAt: true,
        shopDomain: true,
        chargeName: true,
        chargePlatformId: true,
        amount: true,
        currencyCode: true,
        billingOn: true,
        app: { select: { id: true, name: true } },
      },
    }),
  ]);

  const counts = Object.fromEntries(
    grouped.map((entry) => [entry.type, entry._count._all]),
  );
  const activations =
    (counts.SUBSCRIPTION_CHARGE_ACTIVATED ?? 0) +
    (counts.SUBSCRIPTION_CHARGE_UNFROZEN ?? 0);
  const cancellations =
    (counts.SUBSCRIPTION_CHARGE_CANCELED ?? 0) +
    (counts.SUBSCRIPTION_CHARGE_DECLINED ?? 0) +
    (counts.SUBSCRIPTION_CHARGE_EXPIRED ?? 0);
  const stateChanges =
    (counts.SUBSCRIPTION_CHARGE_FROZEN ?? 0) +
    (counts.SUBSCRIPTION_CHARGE_UNFROZEN ?? 0);

  return {
    apps: apps.map((app) => ({
      id: app.id,
      name: app.name,
      logoUrl: app.logoUrl,
      syncedAt: app.billingEventsSyncedAt?.toISOString() ?? null,
      historyReady: Boolean(app.billingEventsBackfillCompletedAt),
    })),
    events: records.map((event) => ({
      id: event.id,
      type: event.type,
      occurredAt: event.occurredAt.toISOString(),
      shopDomain: event.shopDomain,
      chargeName: event.chargeName,
      chargePlatformId: event.chargePlatformId,
      amount: Number(event.amount),
      currencyCode: event.currencyCode,
      billingOn: event.billingOn?.toISOString() ?? null,
      app: event.app,
    })),
    filters: { q, appId, type, period },
    page,
    total,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    summary: {
      all: grouped.reduce((sum, entry) => sum + entry._count._all, 0),
      activations,
      cancellations,
      stateChanges,
    },
  };
}

export default function Events({ loaderData }: Route.ComponentProps) {
  const { apps, events, filters, page, total, totalPages, summary } =
    loaderData;
  const navigate = useNavigate();
  const [q, setQ] = useState(filters.q);
  const [appId, setAppId] = useState(filters.appId);
  const [type, setType] = useState(filters.type);
  const [period, setPeriod] = useState(filters.period);
  const syncedApps = apps.filter((app) => app.syncedAt).length;
  const historyReadyApps = apps.filter((app) => app.historyReady).length;

  const rows = events.map((event, index) => {
    const meta = EVENT_META[event.type] ?? {
      label: event.type.replaceAll("_", " "),
      tone: "info" as const,
    };
    return (
      <IndexTable.Row id={event.id} key={event.id} position={index}>
        <IndexTable.Cell>
          <Badge tone={meta.tone}>{meta.label}</Badge>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <div className="activity-shop-cell">
            <strong>{event.shopDomain}</strong>
            <span>{event.app.name}</span>
          </div>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <div className="activity-charge-cell">
            <strong>{event.chargeName || "Shopify app charge"}</strong>
            <span>{event.chargePlatformId}</span>
          </div>
        </IndexTable.Cell>
        <IndexTable.Cell>
          {formatMoney(event.amount, event.currencyCode)}
        </IndexTable.Cell>
        <IndexTable.Cell>
          {event.billingOn ? formatDateTime(event.billingOn) : "—"}
        </IndexTable.Cell>
        <IndexTable.Cell>{formatDateTime(event.occurredAt)}</IndexTable.Cell>
      </IndexTable.Row>
    );
  });

  return (
    <Page
      title="Activity"
      subtitle="Immutable Shopify subscription lifecycle audit trail"
      fullWidth
      secondaryActions={[
        { content: "Manage connections", url: "/app/connections" },
      ]}
    >
      <div className="activity-workspace">
        <BlockStack gap="500">
          <section className="activity-context">
            <div>
              <div className="activity-eyebrow">
                <i />
                Partner event stream
              </div>
              <Text as="h2" variant="headingMd">
                Billing lifecycle, in one reliable timeline
              </Text>
              <Text as="p" tone="subdued">
                Read-only Shopify events are persisted as an immutable audit
                trail. Test charges are excluded.
              </Text>
            </div>
            <InlineStack gap="500" wrap={false}>
              <div className="activity-context-stat">
                <span>Apps reporting</span>
                <strong>
                  {syncedApps}/{apps.length}
                </strong>
              </div>
              <div className="activity-context-stat">
                <span>History ready</span>
                <strong>
                  {historyReadyApps}/{apps.length}
                </strong>
              </div>
            </InlineStack>
          </section>

          <InlineGrid columns={{ xs: 2, md: 4 }} gap="300">
            <div className="activity-summary-card">
              <span>All events</span>
              <strong>{summary.all.toLocaleString()}</strong>
              <small>In the selected scope</small>
            </div>
            <div className="activity-summary-card">
              <span>Activations</span>
              <strong>{summary.activations.toLocaleString()}</strong>
              <small>Activated or unfrozen</small>
            </div>
            <div className="activity-summary-card">
              <span>Cancellations</span>
              <strong>{summary.cancellations.toLocaleString()}</strong>
              <small>Canceled, declined, or expired</small>
            </div>
            <div className="activity-summary-card">
              <span>State changes</span>
              <strong>{summary.stateChanges.toLocaleString()}</strong>
              <small>Frozen and unfrozen</small>
            </div>
          </InlineGrid>

          <Card>
            <Form method="get">
              <BlockStack gap="400">
                <InlineGrid columns={{ xs: 1, sm: 2, lg: 4 }} gap="300">
                  <TextField
                    label="Shop domain"
                    name="q"
                    value={q}
                    onChange={setQ}
                    placeholder="Search myshopify.com"
                    autoComplete="off"
                    clearButton
                    onClearButtonClick={() => setQ("")}
                  />
                  <AppPicker
                    value={appId}
                    onChange={setAppId}
                    apps={apps}
                  />
                  <Select
                    label="Event"
                    name="type"
                    options={EVENT_OPTIONS}
                    value={type}
                    onChange={setType}
                  />
                  <Select
                    label="Period"
                    name="period"
                    options={PERIOD_OPTIONS}
                    value={period}
                    onChange={setPeriod}
                  />
                </InlineGrid>
                <InlineStack gap="200">
                  <Button variant="primary" submit>
                    Apply filters
                  </Button>
                  <Button url="/app/events">Reset</Button>
                </InlineStack>
              </BlockStack>
            </Form>
          </Card>

          <Card padding="0">
            <div className="activity-table-header">
              <div>
                <Text as="h2" variant="headingMd">
                  Lifecycle events
                </Text>
                <Text as="p" tone="subdued">
                  {total.toLocaleString()} matching{" "}
                  {total === 1 ? "event" : "events"}
                </Text>
              </div>
              <Badge tone="info">Live Shopify data</Badge>
            </div>
            {events.length === 0 ? (
              <EmptyState
                heading={
                  filters.q || filters.appId || filters.type
                    ? "No events match these filters"
                    : "No Shopify lifecycle events yet"
                }
                image={EMPTY_STATE_IMAGE}
                action={
                  filters.q || filters.appId || filters.type
                    ? { content: "Clear filters", url: "/app/events" }
                    : {
                        content: "Check connections",
                        url: "/app/connections",
                      }
                }
              >
                <p>
                  {filters.q || filters.appId || filters.type
                    ? "Try broadening the app, event, or shop filters."
                    : "Events appear after a connected app completes its Shopify Partner synchronization."}
                </p>
              </EmptyState>
            ) : (
              <>
                <IndexTable
                  resourceName={{ singular: "event", plural: "events" }}
                  itemCount={events.length}
                  selectable={false}
                  headings={[
                    { title: "Event" },
                    { title: "Shop" },
                    { title: "Charge" },
                    { title: "Plan amount" },
                    { title: "Billing date" },
                    { title: "Occurred" },
                  ]}
                >
                  {rows}
                </IndexTable>
                <div className="activity-pagination">
                  <Text as="p" tone="subdued">
                    Page {page.toLocaleString()} of{" "}
                    {totalPages.toLocaleString()}
                  </Text>
                  <Pagination
                    hasPrevious={page > 1}
                    onPrevious={() => navigate(pageUrl(page - 1, filters))}
                    hasNext={page < totalPages}
                    onNext={() => navigate(pageUrl(page + 1, filters))}
                    label={`Page ${page} of ${totalPages}`}
                  />
                </div>
              </>
            )}
          </Card>
        </BlockStack>
      </div>
    </Page>
  );
}
