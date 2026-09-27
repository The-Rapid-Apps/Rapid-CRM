/**
 * Every recorded uninstall, one row each — Mantle's "Uninstall reasons" page.
 *
 * The dashboard card ranks reasons; this answers the question that card
 * provokes, which is always "who, and when". Reads `UninstallEventDetail`
 * joined to its lifecycle event, the same rows the card counts, so the two
 * cannot disagree about what an uninstall is.
 */
import {
  Badge,
  BlockStack,
  Box,
  Card,
  Icon,
  InlineStack,
  Link as PolarisLink,
  Page,
  Pagination,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { SearchIcon } from "@shopify/polaris-icons";
import { DataTable } from "@shopify/polaris";
import { useNavigate } from "react-router";
import type { Route } from "./+types/uninstalls";
import { prisma } from "~/lib/db.server";
import { requireCurrentOrganization } from "~/lib/current-org.server";
import { formatMoney } from "~/lib/format";
import { AppPicker } from "~/components/app-picker";
import { useFilterState } from "~/lib/use-filter-state";
import {
  customerLabel,
  resolveCustomerNames,
} from "~/lib/customer-name.server";

const PAGE_SIZE = 25;

/** Reason codes read as tokens; these are the words Mantle shows. */
const REASON_LABELS: Record<string, string> = {
  unknown_other: "Other",
  high_cost: "Expensive or unexpected cost",
  limited_features: "Doesn't satisfy needs",
  poor_support: "Poor support",
  hard_to_setup: "Hard to set up",
  security_or_privacy_issues: "Security or privacy concerns",
  not_compatible_or_not_working: "Not compatible or not working",
  app_performance_issues: "App performance issues",
  found_alternative: "Found an alternative",
  prefer_native_features: "Prefers native features",
  testing_multiple_apps: "Testing multiple apps",
  unexpected_charges: "Unexpected charges",
  not_needed_anymore: "No longer needed",
  not_using: "Not using app now",
  store_closing_or_pausing: "Store is closing or pausing",
  deactivated: "Deactivated / closed account",
  scheduled_cancellation: "Scheduled cancellation",
};

export function reasonLabel(code: string): string {
  return REASON_LABELS[code] ?? code.replace(/_/g, " ");
}

export async function loader({ request }: Route.LoaderArgs) {
  const org = await requireCurrentOrganization(request);
  const url = new URL(request.url);

  const apps = await prisma.app.findMany({
    where: { organizationId: org.id, removed: false },
    orderBy: { name: "asc" },
    select: { id: true, name: true, logoUrl: true },
  });

  /* Validated against this org's own apps rather than trusted — the value
     arrives from the URL, and an id from another tenant must read as "all
     apps" instead of selecting something. */
  const requestedAppId = url.searchParams.get("appId")?.trim() ?? "";
  const appId = apps.some((app) => app.id === requestedAppId)
    ? requestedAppId
    : "";
  const reason = url.searchParams.get("reason")?.trim() ?? "";
  const q = url.searchParams.get("q")?.trim() ?? "";
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);

  const where = {
    event: {
      appInstall: {
        ...(appId ? { appId } : { app: { organizationId: org.id } }),
        ...(q ? { shopDomain: { contains: q } } : {}),
      },
    },
    ...(reason ? { reasonCode: reason } : {}),
  };

  /* Reason options come from the rows themselves, not the preset list: a code
     nobody has ever uninstalled for is a filter that can only return nothing. */
  const [total, rows, reasonGroups] = await Promise.all([
    prisma.uninstallEventDetail.count({ where }),
    prisma.uninstallEventDetail.findMany({
      where,
      orderBy: { event: { occurredAt: "desc" } },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        reason: true,
        description: true,
        reasonCode: true,
        isStoreClosure: true,
        event: {
          select: {
            occurredAt: true,
            appInstall: {
              select: {
                shopDomain: true,
                installedAt: true,
                appId: true,
                app: { select: { name: true, logoUrl: true } },
              },
            },
          },
        },
      },
    }),
    prisma.uninstallEventDetail.groupBy({
      by: ["reasonCode"],
      where: {
        event: {
          appInstall: appId ? { appId } : { app: { organizationId: org.id } },
        },
      },
      _count: { _all: true },
      orderBy: { _count: { reasonCode: "desc" } },
    }),
  ]);

  /* Lifetime value per shop, from the same per-shop state the Customers page
     reads. One query for the page rather than one per row. */
  const clvRows = rows.length
    ? await prisma.partnerCustomerState.findMany({
        where: {
          OR: rows.map((row) => ({
            appId: row.event.appInstall.appId,
            shopDomain: row.event.appInstall.shopDomain,
          })),
        },
        select: { appId: true, shopDomain: true, lifetimeValue: true, currencyCode: true },
      })
    : [];
  const clvByShop = new Map(
    clvRows.map((row) => [
      `${row.appId}:${row.shopDomain}`,
      { value: Number(row.lifetimeValue), currency: row.currencyCode },
    ]),
  );

  const names = await resolveCustomerNames(
    rows.map((row) => row.event.appInstall.shopDomain),
  );

  return {
    apps,
    appId,
    reason,
    q,
    page,
    total,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    reasons: reasonGroups.map((group) => ({
      code: group.reasonCode,
      count: group._count._all,
    })),
    rows: rows.map((row) => {
      const install = row.event.appInstall;
      const clv = clvByShop.get(`${install.appId}:${install.shopDomain}`);
      return {
        id: row.id,
        occurredAt: row.event.occurredAt.toISOString(),
        installedAt: install.installedAt.toISOString(),
        shopDomain: install.shopDomain,
        name: customerLabel(install.shopDomain, names),
        appId: install.appId,
        appName: install.app.name,
        appLogoUrl: install.app.logoUrl,
        reasonCode: row.reasonCode,
        description: row.description ?? row.reason ?? null,
        isStoreClosure: row.isStoreClosure,
        clv: clv?.value ?? null,
        currency: clv?.currency ?? "USD",
      };
    }),
  };
}

export function meta() {
  return [{ title: "Uninstall reasons · Rapid Apps" }];
}

/** "2 hours ago", "6 days ago" — Mantle's relative uninstall date. */
function timeAgo(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  const units: Array<[number, string]> = [
    [60, "second"],
    [3600, "minute"],
    [86400, "hour"],
    [2592000, "day"],
    [31536000, "month"],
  ];
  if (seconds < 60) return "just now";
  for (let index = 1; index < units.length; index++) {
    const [limit] = units[index]!;
    if (seconds < limit) {
      const value = Math.floor(seconds / units[index - 1]![0]);
      const noun = units[index]![1];
      return `${value} ${noun}${value === 1 ? "" : "s"} ago`;
    }
  }
  const years = Math.floor(seconds / 31536000);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

/** How long the merchant kept it — "4 months", "6 days", "a month". */
function duration(fromIso: string, toIso: string): string {
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const days = Math.floor(ms / 86_400_000);
  if (days < 1) return "less than a day";
  if (days < 45) return `${days} day${days === 1 ? "" : "s"}`;
  const months = Math.round(days / 30);
  if (months < 12) return months === 1 ? "a month" : `${months} months`;
  const years = Math.floor(months / 12);
  return `${years} year${years === 1 ? "" : "s"}`;
}

export default function Uninstalls({ loaderData }: Route.ComponentProps) {
  const { apps, appId, reason, q, page, total, totalPages, reasons, rows } =
    loaderData;
  const navigate = useNavigate();
  const [search, setSearch] = useFilterState(q);

  /* Every control rewrites the URL rather than holding its own state: the page
     is paginated and server-filtered, so the URL has to be the single source of
     truth or Back would land on a view that no longer matches the data. */
  const go = (changes: Record<string, string>) => {
    const params = new URLSearchParams();
    const next = { appId, reason, q, page: "1", ...changes };
    for (const [key, value] of Object.entries(next)) {
      if (value && value !== "1") params.set(key, value);
      else if (key === "page" && value !== "1") params.set(key, value);
    }
    navigate(`/app/uninstalls${params.toString() ? `?${params}` : ""}`);
  };

  return (
    <Page
      title="Uninstall reasons"
      subtitle={`${total.toLocaleString()} recorded uninstall${total === 1 ? "" : "s"}`}
      fullWidth
      backAction={
        appId
          ? { content: "Overview", url: `/app/dashboard?appId=${appId}` }
          : undefined
      }
    >
      <BlockStack gap="400">
        <Card padding="0">
          <Box padding="300">
            <InlineStack gap="200" blockAlign="center" wrap={false}>
              {apps.length > 1 ? (
                <AppPicker
                  labelHidden
                  value={appId}
                  onChange={(value) => go({ appId: value })}
                  apps={apps}
                />
              ) : null}
              <Select
                label="Reason"
                labelHidden
                value={reason}
                onChange={(value) => go({ reason: value })}
                options={[
                  { label: "All reasons", value: "" },
                  ...reasons.map((entry) => ({
                    label: `${reasonLabel(entry.code)} (${entry.count.toLocaleString()})`,
                    value: entry.code,
                  })),
                ]}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <TextField
                  label="Search shops"
                  labelHidden
                  value={search}
                  onChange={setSearch}
                  autoComplete="off"
                  placeholder="Search by shop domain"
                  prefix={<Icon source={SearchIcon} tone="subdued" />}
                  clearButton
                  onClearButtonClick={() => {
                    setSearch("");
                    go({ q: "" });
                  }}
                  onBlur={() => go({ q: search })}
                />
              </div>
            </InlineStack>
          </Box>

          {rows.length === 0 ? (
            <Box padding="600">
              <Text as="p" alignment="center" tone="subdued">
                No uninstalls recorded for this view.
              </Text>
            </Box>
          ) : (
            <Box paddingInline="300" paddingBlockEnd="300">
              <div className="reports-traffic-table">
                <DataTable
                  columnContentTypes={[
                    "text",
                    "text",
                    "text",
                    "text",
                    "text",
                    "text",
                    "text",
                  ]}
                  headings={[
                    "Uninstall date",
                    "Customer",
                    "App",
                    "Reason",
                    "Time to uninstall",
                    "CLV",
                    "Uninstalled when",
                  ].map((heading) => (
                    <div key={heading} style={{ textAlign: "center" }}>
                      {heading}
                    </div>
                  ))}
                  rows={rows.map((row) => [
                    <div key={`d-${row.id}`} style={{ textAlign: "center" }}>
                      {timeAgo(row.occurredAt)}
                    </div>,
                    <div key={`c-${row.id}`} style={{ textAlign: "center" }}>
                      <BlockStack gap="050">
                        {/* Clickable through to the merchant, as Mantle's own
                            uninstall list is — the row names a customer and
                            the next question is always about them. */}
                        <PolarisLink
                          url={`/app/customers/${encodeURIComponent(row.shopDomain)}?app=${row.appId}`}
                          removeUnderline
                        >
                          {row.name}
                        </PolarisLink>
                        <Text as="span" tone="subdued" variant="bodySm">
                          {row.shopDomain}
                        </Text>
                      </BlockStack>
                    </div>,
                    <div key={`a-${row.id}`} style={{ textAlign: "center" }}>
                      {row.appName}
                    </div>,
                    <div key={`r-${row.id}`} style={{ textAlign: "center" }}>
                      <BlockStack gap="050">
                        <Text as="span">{reasonLabel(row.reasonCode)}</Text>
                        {/* The merchant's own words, when they left any —
                            the reason code is our normalization of it. */}
                        {row.description ? (
                          <Text as="span" tone="subdued" variant="bodySm">
                            {row.description}
                          </Text>
                        ) : null}
                      </BlockStack>
                    </div>,
                    <div key={`t-${row.id}`} style={{ textAlign: "center" }}>
                      {duration(row.installedAt, row.occurredAt)}
                    </div>,
                    <div key={`v-${row.id}`} style={{ textAlign: "center" }}>
                      {row.clv === null ? "—" : formatMoney(row.clv, row.currency)}
                    </div>,
                    <div key={`w-${row.id}`} style={{ textAlign: "center" }}>
                      {/* Always "Churned", as Mantle's own column is.

                          This used to read "Store closed" for a
                          `scheduled_cancellation`, which was a claim we cannot
                          support: Shopify's own wording is "App uninstalled as
                          part of scheduled shop cancellation", meaning the
                          SHOP's Shopify subscription was cancelled — not that
                          the merchant's storefront is gone — stores labelled
                          closed this way were found still trading.

                          `isStoreClosure` still exists and still excludes
                          these from product-churn reporting, which is what it
                          was for. It just isn't a fact about the store. */}
                      <Badge tone="critical">Churned</Badge>
                    </div>,
                  ])}
                />
              </div>
            </Box>
          )}
        </Card>

        {totalPages > 1 ? (
          <InlineStack align="center">
            <Pagination
              hasPrevious={page > 1}
              hasNext={page < totalPages}
              onPrevious={() => go({ page: String(page - 1) })}
              onNext={() => go({ page: String(page + 1) })}
              label={`Page ${page} of ${totalPages}`}
            />
          </InlineStack>
        ) : null}
      </BlockStack>
    </Page>
  );
}
