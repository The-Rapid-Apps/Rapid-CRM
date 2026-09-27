import {
  Badge,
  BlockStack,
  Button,
  Card,
  Checkbox,
  EmptyState,
  FormLayout,
  IndexTable,
  InlineGrid,
  InlineStack,
  Page,
  Pagination,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { CreditCardIcon, RefreshIcon } from "@shopify/polaris-icons";
import { useState } from "react";
import { Form } from "react-router";
import { Prisma } from "../../../generated/prisma/client";
import type { Route } from "./+types/subscriptions";
import { cachedWithRedis } from "~/lib/cache/redis-cache.server";
import { AppLogo } from "~/components/app-identity";
import { AppPicker } from "~/components/app-picker";
import { prisma } from "~/lib/db.server";
import { requireCurrentOrganization } from "~/lib/current-org.server";
import { env } from "~/lib/env.server";
import { formatDate, formatDateTime, formatMoney } from "~/lib/format";
import { EMPTY_STATE_IMAGE } from "~/lib/ui";

const PAGE_SIZE = 50;
const PARTNER_STATUSES = [
  "ACTIVE",
  "FROZEN",
  "CANCELLED",
  "DECLINED",
  "EXPIRED",
] as const;
type PartnerStatus = (typeof PARTNER_STATUSES)[number];

type PartnerSubscriptionRow = {
  id: string;
  appId: string;
  appName: string;
  appLogoUrl: string | null;
  type: string;
  occurredAt: Date;
  shopDomain: string;
  chargePlatformId: string;
  chargeName: string;
  amount: Prisma.Decimal;
  currencyCode: string;
  billingOn: Date | null;
  billingInterval: string | null;
  totalCount: bigint | number;
};

type StatusCountRow = { type: string; total: bigint | number };

/**
 * Short-TTL cache for this page's query results, same rationale and pattern
 * as `traffic-sources.server.ts`'s `trafficReportCache`: the underlying
 * `ROW_NUMBER() OVER(PARTITION BY appId, chargePlatformId ...)` query costs
 * ~1s regardless of index tuning (confirmed via EXPLAIN 2026-08-08 — MySQL
 * falls back to a temp-table sort for the window function even with a
 * matching index forced), and this data doesn't need to be fresher than a
 * couple minutes for an internal admin list. Keyed by every filter that
 * affects the result. Redis-backed (Shape A) — see `trafficReportCache`'s
 * updated doc comment for why, including why no manual entry cap is needed.
 */
const SUBSCRIPTIONS_CACHE_TTL_MS = 2 * 60_000;
const SUBSCRIPTIONS_CACHE_KEY_PREFIX = "subscriptions-page:";
/** Separate namespace from the live path's cache key so a mid-rollout mix of
 * ready/not-ready apps (or the flag flipping) never serves a stale
 * cross-path cache hit. */
const PARTNER_STATE_CACHE_KEY_PREFIX = "subscriptions-page-partner-state:";

interface SubscriptionsPageData {
  rows: PartnerSubscriptionRow[];
  hasNextPage: boolean;
  totalCount: number;
  statusRows: StatusCountRow[];
}

function buildListUrl(
  filters: { q: string; appId: string; status: string; includeTest: boolean },
  page: number,
): string {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.appId) params.set("appId", filters.appId);
  if (filters.status) params.set("status", filters.status);
  // Preserve the test toggle across pagination and re-filters.
  if (filters.includeTest) params.set("test", "on");
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `?${query}` : "?";
}

function statusPredicate(status: PartnerStatus | "") {
  switch (status) {
    case "ACTIVE":
      return Prisma.sql`AND ranked.type IN ('SUBSCRIPTION_CHARGE_ACTIVATED', 'SUBSCRIPTION_CHARGE_UNFROZEN')`;
    case "FROZEN":
      return Prisma.sql`AND ranked.type = 'SUBSCRIPTION_CHARGE_FROZEN'`;
    case "CANCELLED":
      return Prisma.sql`AND ranked.type = 'SUBSCRIPTION_CHARGE_CANCELED'`;
    case "DECLINED":
      return Prisma.sql`AND ranked.type = 'SUBSCRIPTION_CHARGE_DECLINED'`;
    case "EXPIRED":
      return Prisma.sql`AND ranked.type = 'SUBSCRIPTION_CHARGE_EXPIRED'`;
    default:
      return Prisma.empty;
  }
}

function currentStatus(type: string): PartnerStatus {
  if (
    type === "SUBSCRIPTION_CHARGE_ACTIVATED" ||
    type === "SUBSCRIPTION_CHARGE_UNFROZEN"
  ) {
    return "ACTIVE";
  }
  if (type === "SUBSCRIPTION_CHARGE_FROZEN") return "FROZEN";
  if (type === "SUBSCRIPTION_CHARGE_DECLINED") return "DECLINED";
  if (type === "SUBSCRIPTION_CHARGE_EXPIRED") return "EXPIRED";
  return "CANCELLED";
}

function statusTone(status: PartnerStatus): "success" | "warning" | "critical" {
  if (status === "ACTIVE") return "success";
  if (status === "FROZEN") return "warning";
  return "critical";
}

function cadenceLabel(interval: string | null): string {
  if (interval === "ANNUAL") return "Annual";
  if (interval === "EVERY_30_DAYS") return "Every 30 days";
  return "Not classified";
}

function asNumber(value: bigint | number | undefined): number {
  return Number(value ?? 0);
}

/**
 * Fast path reading PartnerSubscriptionState directly — plain indexed
 * queries, no window function, no raw SQL. Produces the exact same
 * `SubscriptionsPageData` shape the live path does, including grouping
 * `statusRows` by the RAW Shopify event type (via the stored `lastEventType`
 * column, not the collapsed `status` column) so every line below this
 * function's call site — the active/frozen/ended tallies, per-row
 * `currentStatus()`/`cadenceLabel()` calls — runs completely unchanged
 * regardless of which path served the data.
 */
async function fetchPartnerStatePage(params: {
  appId: string;
  q: string;
  status: PartnerStatus | "";
  offset: number;
  appNames: Map<string, string>;
  appLogos: Map<string, string | null>;
}): Promise<SubscriptionsPageData> {
  const where = {
    ...(params.appId ? { appId: params.appId } : {}),
    ...(params.q ? { shopDomain: { contains: params.q } } : {}),
    ...(params.status ? { status: params.status } : {}),
  };
  const [rowsPlusOne, totalCount, statusRows] = await Promise.all([
    prisma.partnerSubscriptionState.findMany({
      where,
      orderBy: [{ lastEventAt: "desc" }, { chargePlatformId: "desc" }],
      take: PAGE_SIZE + 1,
      skip: params.offset,
    }),
    prisma.partnerSubscriptionState.count({ where }),
    // Deliberately NOT filtered by `params.status` — the live path's
    // statusRows always reflects every status regardless of the current
    // status filter, since the summary cards (Active/Frozen/Ended) are
    // meant to show the whole picture, not just the filtered slice.
    prisma.partnerSubscriptionState.groupBy({
      by: ["lastEventType"],
      where: {
        ...(params.appId ? { appId: params.appId } : {}),
        ...(params.q ? { shopDomain: { contains: params.q } } : {}),
      },
      _count: { _all: true },
    }),
  ]);

  return {
    rows: rowsPlusOne.slice(0, PAGE_SIZE).map((row) => ({
      id: `${row.appId}:${row.chargePlatformId}`,
      appId: row.appId,
      appName: params.appNames.get(row.appId) ?? "Unknown app",
      appLogoUrl: params.appLogos.get(row.appId) ?? null,
      type: row.lastEventType,
      occurredAt: row.lastEventAt,
      shopDomain: row.shopDomain,
      chargePlatformId: row.chargePlatformId,
      chargeName: row.chargeName,
      amount: row.approvedAmount,
      currencyCode: row.currencyCode,
      billingOn: row.nextBillingOn,
      billingInterval: row.billingInterval,
      totalCount,
    })),
    hasNextPage: rowsPlusOne.length > PAGE_SIZE,
    totalCount,
    statusRows: statusRows.map((row) => ({
      type: row.lastEventType,
      total: row._count._all,
    })),
  };
}

export async function loader({ request }: Route.LoaderArgs) {
  const org = await requireCurrentOrganization(request);
  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim().slice(0, 255) ?? "";
  const requestedAppId = url.searchParams.get("appId")?.trim() ?? "";
  const requestedStatus = url.searchParams.get("status")?.trim() ?? "";
  const status = PARTNER_STATUSES.includes(requestedStatus as PartnerStatus)
    ? (requestedStatus as PartnerStatus)
    : "";
  const requestedPage = Number(url.searchParams.get("page") ?? "1");
  const page =
    Number.isSafeInteger(requestedPage) && requestedPage > 0
      ? requestedPage
      : 1;
  // Opt-in: include test/dev-store subscriptions (Shopify test charges), for
  // verifying billing on a development store. Off by default so the list keeps
  // showing only real merchants.
  const includeTest = url.searchParams.get("test") === "on";

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
      billingEventsBackfillCompletedAt: true,
      billingEventsSyncedAt: true,
      partnerStateBackfillCompletedAt: true,
    },
  });
  const appId = apps.some((app) => app.id === requestedAppId)
    ? requestedAppId
    : "";
  const filters = { q, appId, status, includeTest };
  // All-or-nothing across whatever's in scope (one app if filtered, every
  // app otherwise) — matches the same rule used for every other read-path
  // flag tonight. Per-app partial serving is a further refinement, not
  // needed yet at only 5 apps total.
  const appsInScope = appId ? apps.filter((app) => app.id === appId) : apps;
  const partnerStateReady =
    env.PARTNER_STATE_READ_PATH_ENABLED &&
    appsInScope.length > 0 &&
    appsInScope.every((app) => app.partnerStateBackfillCompletedAt);
  // The fast-path table (partner_subscription_states) carries no `test` flag,
  // so it cannot surface test rows. When the operator opts into test data, fall
  // back to the raw-events path, which does carry it.
  const useFastPath = partnerStateReady && !includeTest;
  const appFilter = appId ? Prisma.sql`AND e.appId = ${appId}` : Prisma.empty;
  // Exclude Shopify test charges unless explicitly asked for.
  const testFilter = includeTest ? Prisma.empty : Prisma.sql`AND e.test = 0`;
  const searchFilter = q
    ? Prisma.sql`AND e.shopDomain LIKE ${`%${q}%`}`
    : Prisma.empty;
  const currentStatusFilter = statusPredicate(status);
  const offset = (page - 1) * PAGE_SIZE;

  const rankedCte = Prisma.sql`
    WITH ranked AS (
      SELECT
        e.id,
        e.appId,
        a.name AS appName,
        a.logoUrl AS appLogoUrl,
        e.type,
        e.occurredAt,
        e.shopDomain,
        e.chargePlatformId,
        e.chargeName,
        e.amount,
        e.currencyCode,
        e.billingOn,
        ROW_NUMBER() OVER (
          PARTITION BY e.appId, e.chargePlatformId
          ORDER BY e.occurredAt DESC, e.id DESC
        ) AS rowNumber
      FROM partner_subscription_events e
      INNER JOIN apps a ON a.id = e.appId
      WHERE
        a.organizationId = ${org.id}
        AND a.removed = 0
        AND a.scheduledForDeletionAt IS NULL
        ${testFilter}
        ${appFilter}
        ${searchFilter}
    )
  `;

  const appNames = new Map(apps.map((app) => [app.id, app.name]));
  const appLogos = new Map(apps.map((app) => [app.id, app.logoUrl]));
  const cacheKeyParts = [
    org.id,
    appId,
    q,
    status,
    String(page),
    includeTest ? "test" : "live",
  ].join("␟");
  const redisKey = `${useFastPath ? PARTNER_STATE_CACHE_KEY_PREFIX : SUBSCRIPTIONS_CACHE_KEY_PREFIX}${cacheKeyParts}`;
  const pageData = await cachedWithRedis(
    redisKey,
    SUBSCRIPTIONS_CACHE_TTL_MS,
    async (): Promise<SubscriptionsPageData> => {
      if (useFastPath) {
        return fetchPartnerStatePage({
          appId,
          q,
          status,
          offset,
          appNames,
          appLogos,
        });
      }
      // `COUNT(*) OVER()` folds the status-filtered total into the same pass
      // as the paginated rows — a window function evaluates before LIMIT, so
      // this still reflects the full matching set, not just this page.
      // Removes what was a separate, equally expensive (~1s) COUNT query.
      const [rowsPlusOne, statusRows] = await Promise.all([
        prisma.$queryRaw<PartnerSubscriptionRow[]>(Prisma.sql`
          ${rankedCte}
          SELECT
            ranked.id,
            ranked.appId,
            ranked.appName,
            ranked.appLogoUrl,
            ranked.type,
            ranked.occurredAt,
            ranked.shopDomain,
            ranked.chargePlatformId,
            ranked.chargeName,
            ranked.amount,
            ranked.currencyCode,
            ranked.billingOn,
            (
              SELECT sale.billingInterval
              FROM partner_subscription_sale_facts sale
              WHERE
                sale.appId = ranked.appId
                AND sale.chargePlatformId = ranked.chargePlatformId
              ORDER BY sale.occurredAt DESC
              LIMIT 1
            ) AS billingInterval,
            COUNT(*) OVER() AS totalCount
          FROM ranked
          WHERE ranked.rowNumber = 1
          ${currentStatusFilter}
          ORDER BY ranked.occurredAt DESC, ranked.id DESC
          LIMIT ${PAGE_SIZE + 1}
          OFFSET ${offset}
        `),
        prisma.$queryRaw<StatusCountRow[]>(Prisma.sql`
          ${rankedCte}
          SELECT ranked.type, COUNT(*) AS total
          FROM ranked
          WHERE ranked.rowNumber = 1
          GROUP BY ranked.type
        `),
      ]);
      return {
        rows: rowsPlusOne.slice(0, PAGE_SIZE),
        hasNextPage: rowsPlusOne.length > PAGE_SIZE,
        totalCount: asNumber(rowsPlusOne[0]?.totalCount),
        statusRows,
      };
    },
  );

  const { rows, hasNextPage, totalCount, statusRows } = pageData;
  const counts: Map<string, number> = new Map<string, number>(
    statusRows.map((row) => [row.type, asNumber(row.total)]),
  );
  const activeCount =
    (counts.get("SUBSCRIPTION_CHARGE_ACTIVATED") ?? 0) +
    (counts.get("SUBSCRIPTION_CHARGE_UNFROZEN") ?? 0);
  const frozenCount = counts.get("SUBSCRIPTION_CHARGE_FROZEN") ?? 0;
  const endedCount =
    (counts.get("SUBSCRIPTION_CHARGE_CANCELED") ?? 0) +
    (counts.get("SUBSCRIPTION_CHARGE_DECLINED") ?? 0) +
    (counts.get("SUBSCRIPTION_CHARGE_EXPIRED") ?? 0);

  return {
    apps: apps.map((app) => ({
      id: app.id,
      name: app.name,
      logoUrl: app.logoUrl,
      ready: Boolean(app.billingEventsBackfillCompletedAt),
      lastSyncedAt: app.billingEventsSyncedAt?.toISOString() ?? null,
    })),
    filters,
    page,
    totalCount,
    summary: {
      active: activeCount,
      frozen: frozenCount,
      ended: endedCount,
      total: activeCount + frozenCount + endedCount,
    },
    pagination: {
      hasNextPage,
      hasPreviousPage: page > 1,
      nextUrl: hasNextPage ? buildListUrl(filters, page + 1) : undefined,
      previousUrl:
        page > 1 ? buildListUrl(filters, Math.max(1, page - 1)) : undefined,
    },
    subscriptions: rows.map((row) => ({
      id: row.id,
      appId: row.appId,
      app: row.appName,
      appLogoUrl: row.appLogoUrl,
      shop: row.shopDomain,
      chargeName: row.chargeName,
      amount: Number(row.amount),
      currency: row.currencyCode,
      status: currentStatus(row.type),
      cadence: cadenceLabel(row.billingInterval),
      nextBillingDate: row.billingOn?.toISOString() ?? null,
      changedAt: row.occurredAt.toISOString(),
    })),
  };
}

function SummaryMetric({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: number;
  detail: string;
  tone?: "success" | "warning" | "critical";
}) {
  return (
    <div className="subscriptions-summary-card">
      <InlineStack align="space-between" blockAlign="center" wrap={false}>
        <span>{label}</span>
        {tone ? <Badge tone={tone}>{detail}</Badge> : null}
      </InlineStack>
      <strong>{value.toLocaleString()}</strong>
      {!tone ? <small>{detail}</small> : null}
    </div>
  );
}

export default function Subscriptions({ loaderData }: Route.ComponentProps) {
  const {
    apps,
    filters,
    page,
    pagination,
    subscriptions,
    summary,
    totalCount,
  } = loaderData;
  const hasFilters = Boolean(
    filters.q || filters.appId || filters.status || filters.includeTest,
  );
  const readyApps = apps.filter((app) => app.ready).length;
  const [q, setQ] = useState(filters.q);
  const [appId, setAppId] = useState(filters.appId);
  const [status, setStatus] = useState(filters.status);
  const [includeTest, setIncludeTest] = useState(filters.includeTest);

  const rows = subscriptions.map((subscription, index) => (
    <IndexTable.Row id={subscription.id} key={subscription.id} position={index}>
      <IndexTable.Cell>
        <div className="subscriptions-shop-cell">
          <strong>{subscription.shop}</strong>
          <InlineStack gap="150" blockAlign="center" wrap={false}>
            <AppLogo
              appName={subscription.app}
              logoUrl={subscription.appLogoUrl}
              size="xs"
            />
            <span>{subscription.app}</span>
          </InlineStack>
        </div>
      </IndexTable.Cell>
      <IndexTable.Cell>{subscription.chargeName}</IndexTable.Cell>
      <IndexTable.Cell>
        <Badge tone={statusTone(subscription.status)}>
          {subscription.status}
        </Badge>
      </IndexTable.Cell>
      <IndexTable.Cell>
        {formatMoney(subscription.amount, subscription.currency)}
      </IndexTable.Cell>
      <IndexTable.Cell>{subscription.cadence}</IndexTable.Cell>
      <IndexTable.Cell>
        {formatDate(subscription.nextBillingDate)}
      </IndexTable.Cell>
      <IndexTable.Cell>
        {formatDateTime(subscription.changedAt)}
      </IndexTable.Cell>
    </IndexTable.Row>
  ));

  return (
    <Page
      fullWidth
      title="Subscriptions"
      subtitle="Current Shopify billing state reconstructed from synchronized lifecycle events"
      primaryAction={{
        content: "Refresh lifecycle data",
        url: "/app/connections",
        icon: RefreshIcon,
      }}
      secondaryActions={[
        {
          content: "View revenue reports",
          url: "/app/reports",
          icon: CreditCardIcon,
        },
      ]}
    >
      <div className="subscriptions-workspace">
        <BlockStack gap="400">
          <section className="subscriptions-context">
            <div>
              <div className="subscriptions-eyebrow">
                <i aria-hidden="true" />
                Shopify Partner lifecycle
              </div>
              <Text as="h2" variant="headingMd">
                {readyApps === apps.length && apps.length > 0
                  ? "Subscription data is synchronized"
                  : "Lifecycle synchronization is incomplete"}
              </Text>
              <Text as="p" tone="subdued" variant="bodySm">
                {readyApps} of {apps.length} apps have completed their billing
                event backfill.
              </Text>
            </div>
            <Badge
              tone={
                readyApps === apps.length && apps.length > 0
                  ? "success"
                  : "attention"
              }
            >
              {`${readyApps}/${apps.length} apps ready`}
            </Badge>
          </section>

          <InlineGrid columns={{ xs: 2, sm: 4 }} gap="300">
            <SummaryMetric
              label="All subscriptions"
              value={summary.total}
              detail="Current states"
            />
            <SummaryMetric
              label="Active"
              value={summary.active}
              detail="Live"
              tone="success"
            />
            <SummaryMetric
              label="Frozen"
              value={summary.frozen}
              detail="Paused"
              tone="warning"
            />
            <SummaryMetric
              label="Ended"
              value={summary.ended}
              detail="Churned"
              tone="critical"
            />
          </InlineGrid>

          <Card>
            <Form method="get">
              <FormLayout>
                <InlineGrid columns={{ xs: 1, md: 3 }} gap="300">
                  <TextField
                    label="Shop domain"
                    name="q"
                    placeholder="Search shop domain"
                    value={q}
                    onChange={setQ}
                    clearButton
                    autoComplete="off"
                  />
                  <AppPicker
                    value={appId}
                    onChange={setAppId}
                    apps={apps}
                  />
                  <Select
                    label="Status"
                    name="status"
                    value={status}
                    onChange={setStatus}
                    options={[
                      { label: "All statuses", value: "" },
                      ...PARTNER_STATUSES.map((value) => ({
                        label:
                          value === "CANCELLED"
                            ? "Canceled"
                            : value.charAt(0) + value.slice(1).toLowerCase(),
                        value,
                      })),
                    ]}
                  />
                </InlineGrid>
                <Checkbox
                  label="Include test / dev-store subscriptions"
                  name="test"
                  checked={includeTest}
                  onChange={setIncludeTest}
                  helpText="Shopify test charges (development stores) are hidden by default. Turn this on to verify billing on a test store."
                />
                <InlineStack gap="200">
                  <Button submit variant="primary">
                    Apply filters
                  </Button>
                  {hasFilters ? (
                    <Button url="/app/subscriptions">Clear filters</Button>
                  ) : null}
                </InlineStack>
              </FormLayout>
            </Form>
          </Card>

          <Card padding="0">
            <div className="subscriptions-table-header">
              <div>
                <Text as="h2" variant="headingMd">
                  Current subscriptions
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  {totalCount.toLocaleString()} matching subscription
                  {totalCount === 1 ? "" : "s"} · page {page}
                </Text>
              </div>
              <Badge tone="info">Read-only Shopify data</Badge>
            </div>
            {subscriptions.length === 0 ? (
              <EmptyState
                heading={
                  hasFilters
                    ? "No subscriptions match these filters"
                    : "No synchronized subscriptions yet"
                }
                image={EMPTY_STATE_IMAGE}
                action={
                  hasFilters
                    ? {
                        content: "Clear filters",
                        url: "/app/subscriptions",
                      }
                    : {
                        content: "Manage connections",
                        url: "/app/connections",
                      }
                }
              >
                <p>
                  {hasFilters
                    ? "Try a different shop, app, or lifecycle status."
                    : "Complete the Shopify billing-event synchronization to populate this list."}
                </p>
              </EmptyState>
            ) : (
              <IndexTable
                resourceName={{
                  singular: "subscription",
                  plural: "subscriptions",
                }}
                itemCount={subscriptions.length}
                selectable={false}
                headings={[
                  { title: "Shop" },
                  { title: "Charge" },
                  { title: "Status" },
                  { title: "Approved price" },
                  { title: "Cadence" },
                  { title: "Next billing" },
                  { title: "Last changed" },
                ]}
              >
                {rows}
              </IndexTable>
            )}
          </Card>

          {pagination.hasNextPage || pagination.hasPreviousPage ? (
            <InlineStack align="center">
              <Pagination
                hasNext={pagination.hasNextPage}
                hasPrevious={pagination.hasPreviousPage}
                nextURL={pagination.nextUrl}
                previousURL={pagination.previousUrl}
              />
            </InlineStack>
          ) : null}
        </BlockStack>
      </div>
    </Page>
  );
}
