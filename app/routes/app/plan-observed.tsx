/**
 * One Shopify-billed plan's page — Mantle's plan detail.
 *
 * Addressed by (name, list price, cadence) rather than an id, because a plan
 * defined in Shopify has no row of ours to carry one. See `planDetailUrl`.
 *
 * Read-only throughout: Mantle's Edit / Duplicate / Share deliberately have no
 * counterpart here, because Shopify owns these plans and we can only observe
 * them. Offering the affordance would be a lie.
 */
import {
  Badge,
  BlockStack,
  Box,
  Card,
  DataTable,
  EmptyState,
  InlineGrid,
  InlineStack,
  Link as PolarisLink,
  Page,
  Pagination,
  Text,
  Tooltip,
} from "@shopify/polaris";
import { useNavigate } from "react-router";
import type { Route } from "./+types/plan-observed";
import { prisma } from "~/lib/db.server";
import { requireCurrentOrganization } from "~/lib/current-org.server";
import { formatDateTime, formatMoney } from "~/lib/format";
import { compactMoney } from "~/lib/chart-theme";
import { EMPTY_STATE_IMAGE } from "~/lib/ui";
import { useBackAction } from "~/lib/use-back-action";
import {
  customerLabel,
  resolveCustomerNames,
} from "~/lib/customer-name.server";
import {
  buildObservedPlanDetail,
  buildShopSubscriptionSummaries,
  partnerLifecycleReadiness,
} from "~/lib/shopify/partner-mrr.server";

const PAGE_SIZE = 20;
const EVENT_PAGE_SIZE = 25;

/** Partner event types read as constants; these are what they mean. */
const EVENT_LABELS: Record<string, string> = {
  SUBSCRIPTION_CHARGE_ACTIVATED: "Subscribed",
  SUBSCRIPTION_CHARGE_CANCELED: "Cancelled",
  SUBSCRIPTION_CHARGE_EXPIRED: "Expired",
  SUBSCRIPTION_CHARGE_FROZEN: "Frozen",
  SUBSCRIPTION_CHARGE_UNFROZEN: "Unfrozen",
  SUBSCRIPTION_CHARGE_DECLINED: "Charge declined",
};

export async function loader({ request }: Route.LoaderArgs) {
  const org = await requireCurrentOrganization(request);
  const url = new URL(request.url);

  const appId = url.searchParams.get("appId")?.trim() ?? "";
  const plan = url.searchParams.get("plan")?.trim() ?? "";
  const amount = Number(url.searchParams.get("amount") ?? NaN);
  const rawInterval = url.searchParams.get("interval") ?? "";
  /* Explicit wins; anything else is resolved from this plan's own sale facts
     below. Callers that know the cadence (the Plans table) pass it; the
     workspace search deliberately does not, because resolving it there costs
     ~1.1s across every app's charges — see searchPlans in
     global-search.server.ts. Defaulting to EVERY_30_DAYS instead would
     silently describe an ANNUAL plan as monthly. */
  const explicitInterval =
    rawInterval === "ANNUAL"
      ? "ANNUAL"
      : rawInterval === "EVERY_30_DAYS"
        ? "EVERY_30_DAYS"
        : null;
  let interval: "ANNUAL" | "EVERY_30_DAYS" = explicitInterval ?? "EVERY_30_DAYS";
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
  const eventPage = Math.max(1, Number(url.searchParams.get("epage") ?? 1) || 1);

  const app = appId
    ? await prisma.app.findFirst({
        where: { id: appId, organizationId: org.id, removed: false },
        select: {
          id: true,
          name: true,
          billingEventsBackfillCompletedAt: true,
          billingSalesBackfillCompletedAt: true,
        },
      })
    : null;

  if (!app || !plan || !Number.isFinite(amount)) {
    return { app: null, plan: null, detail: null, events: [], interval, page: 1, eventPage: 1, eventPages: 1 };
  }
  if (!partnerLifecycleReadiness([app]).coverage.applied) {
    return { app: { id: app.id, name: app.name }, plan, detail: null, events: [], interval, page: 1, eventPage: 1, eventPages: 1 };
  }

  /* The plan's own events, matched on the charge name AND amount the plan is
     keyed by — name alone would pull in the other "Starter" or the other three
     "Monthly Plan"s. */
  const eventWhere = { appId: app.id, chargeName: plan, amount, test: false };

  if (!explicitInterval) {
    /* Scoped to this one plan, so it reads a handful of charges rather than
       the whole app: the latest sale for any charge carrying this plan's name
       and price tells us the cadence. No sale yet (a brand-new or never-billed
       plan) leaves the monthly default, which is what it was before. */
    const latestSale = await prisma.partnerSubscriptionSaleFact.findFirst({
      where: {
        appId: app.id,
        billingInterval: { not: null },
        chargePlatformId: {
          in: (
            await prisma.partnerSubscriptionEvent.findMany({
              where: eventWhere,
              select: { chargePlatformId: true },
              distinct: ["chargePlatformId"],
              take: 25,
            })
          ).map((row) => row.chargePlatformId),
        },
      },
      orderBy: { occurredAt: "desc" },
      select: { billingInterval: true },
    });
    if (latestSale?.billingInterval === "ANNUAL") interval = "ANNUAL";
  }
  const [detail, eventTotal] = await Promise.all([
    buildObservedPlanDetail({ appId: app.id, plan, amount, interval }),
    prisma.partnerSubscriptionEvent.count({ where: eventWhere }),
  ]);
  const eventPages = Math.max(1, Math.ceil(eventTotal / EVENT_PAGE_SIZE));
  const safeEventPage = Math.min(eventPage, eventPages);
  const events = await prisma.partnerSubscriptionEvent.findMany({
    where: eventWhere,
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    skip: (safeEventPage - 1) * EVENT_PAGE_SIZE,
    take: EVENT_PAGE_SIZE,
    select: {
      type: true,
      occurredAt: true,
      shopDomain: true,
      amount: true,
      currencyCode: true,
      chargePlatformId: true,
    },
  });

  /* The tooltip's three lines, for the shops on THIS page of events only.
     `installedAt` is ours; the trial end and the shop's current plan come off
     the fold, which this request has already paid for. */
  const eventShops = [
    ...new Set(events.map((event) => event.shopDomain).filter((d): d is string => Boolean(d))),
  ];
  const [installs, summaries] = await Promise.all([
    eventShops.length
      ? prisma.appInstall.findMany({
          where: { appId: app.id, shopDomain: { in: eventShops } },
          select: { shopDomain: true, installedAt: true },
        })
      : [],
    buildShopSubscriptionSummaries({ appId: app.id, shopDomains: eventShops }),
  ]);
  const installedAt = new Map(installs.map((row) => [row.shopDomain, row.installedAt]));

  /* Store names for everyone on this screen — the subscriber page and the
     events beside it — in one query rather than per row. */
  const names = await resolveCustomerNames([
    ...eventShops,
    ...(detail?.subscribers ?? []).map((row) => row.shopDomain),
  ]);

  /* Paged here rather than in the builder: the fold has to walk every charge
     to answer anything at all, so the whole list is already in memory and a
     page is a slice. Clamped so a stale ?page= past the end shows the last
     page instead of an empty table. */
  const totalPages = detail
    ? Math.max(1, Math.ceil(detail.subscribers.length / PAGE_SIZE))
    : 1;
  const safePage = Math.min(page, totalPages);

  return {
    app: { id: app.id, name: app.name },
    plan,
    interval,
    page: safePage,
    detail: detail
      ? {
          ...detail.plan,
          subscribers: detail.subscribers
            .slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)
            .map((row) => ({
              ...row,
              name: customerLabel(row.shopDomain, names),
              since: row.since?.toISOString() ?? null,
            })),
          subscriberTotal: detail.subscribers.length,
          totalPages,
        }
      : null,
    eventPage: safeEventPage,
    eventPages,
    events: events.map((event) => {
      const shop = event.shopDomain ?? "";
      const summary = summaries.get(shop);
      return {
        type: event.type,
        occurredAt: event.occurredAt.toISOString(),
        shopDomain: shop,
        name: customerLabel(shop, names),
        amount: Number(event.amount),
        currency: event.currencyCode,
        chargeId: event.chargePlatformId,
        installedAt: installedAt.get(shop)?.toISOString() ?? null,
        trialEndsAt: summary?.trialEndsAt?.toISOString() ?? null,
        currentPlan: summary?.currentPlan
          ? `${summary.currentPlan.plan}: ${formatMoney(
              summary.currentPlan.amount,
              event.currencyCode,
            )} ${summary.currentPlan.interval === "ANNUAL" ? "per year" : "every 30 days"}`
          : null,
      };
    }),
  };
}

export function meta() {
  return [{ title: "Plan · Rapid" }];
}

export default function PlanObserved({ loaderData }: Route.ComponentProps) {
  const { app, plan, detail, events, interval, page, eventPage, eventPages } =
    loaderData;
  const navigate = useNavigate();
  const backAction = useBackAction({
    content: "Plans",
    url: app ? `/app/plans?appId=${app.id}` : "/app/plans",
  });

  if (!app || !plan || !detail) {
    return (
      <Page title="Plan" backAction={backAction} fullWidth>
        <Card>
          <EmptyState heading="Plan not found" image={EMPTY_STATE_IMAGE}>
            <p>
              This plan has no merchants on it right now, so there is nothing to
              read off the charges. Plans appear here only while someone is
              subscribed to them.
            </p>
          </EmptyState>
        </Card>
      </Page>
    );
  }

  const cadence = interval === "ANNUAL" ? "per year" : "every 30 days";

  /* Paging rewrites the URL rather than holding state, so the plan's identity
     travels with it — drop any of the four params and the page has no idea
     which plan it is showing. */
  const goTo = (changes: { page?: number; epage?: number }) => {
    const params = new URLSearchParams({
      appId: app.id,
      plan,
      amount: String(detail.amount),
      interval,
      page: String(changes.page ?? page),
      /* Both paginators write both numbers, so paging the events list does not
         silently reset the subscriber table to page 1 underneath it. */
      epage: String(changes.epage ?? eventPage),
    });
    navigate(`/app/plans/observed?${params}`);
  };
  const goToPage = (next: number) => goTo({ page: next });
  const goToEventPage = (next: number) => goTo({ epage: next });

  return (
    <Page
      title={plan}
      subtitle={`${formatMoney(detail.amount, detail.currency)} ${cadence} · ${app.name}`}
      backAction={backAction}
      fullWidth
      titleMetadata={<Badge tone="success">Billed through Shopify</Badge>}
    >
      <BlockStack gap="400">
        <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="300">
          <Tile label="Subscribers" value={detail.customers.toLocaleString()} />
          <Tile label="Active trials" value={detail.trials.toLocaleString()} />
          <Tile label="MRR" value={compactMoney(detail.mrr, detail.currency)} />
          <Tile
            label="All-time"
            value={compactMoney(detail.lifetimeValue, detail.currency)}
          />
        </InlineGrid>

        <InlineGrid columns={{ xs: 1, lg: ["twoThirds", "oneThird"] }} gap="400">
          <Card padding="0">
            <Box padding="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  Subscribers
                </Text>
                <Text as="span" tone="subdued" variant="bodySm">
                  {detail.subscriberTotal.toLocaleString()} total, by lifetime
                  value
                </Text>
              </InlineStack>
            </Box>
            {detail.subscribers.length === 0 ? (
              <Box padding="600">
                <Text as="p" alignment="center" tone="subdued">
                  Nobody is on this plan right now.
                </Text>
              </Box>
            ) : (
              <Box paddingInline="300" paddingBlockEnd="300">
                <div className="reports-traffic-table">
                  <DataTable
                    /* Mantle also shows the merchant's own Shopify plan
                       (Basic / Shopify / Pause and Build). That is the
                       merchant's subscription to SHOPIFY, which the Partner
                       feed never tells us, so the column is left out rather
                       than filled with dashes. */
                    /* Only the two money columns are centred. Name and Since
                       read as a list and a date, and centring them makes the
                       left edge ragged with nothing gained. */
                    columnContentTypes={["text", "text", "text", "text"]}
                    headings={["Name", "AMR", "CLV", "Since"].map((heading) => (
                      <div
                        key={heading}
                        style={{
                          textAlign:
                            heading === "AMR" || heading === "CLV"
                              ? "center"
                              : "left",
                        }}
                      >
                        {heading}
                      </div>
                    ))}
                    rows={detail.subscribers.map((row) => [
                      <BlockStack gap="050" key={`n-${row.shopDomain}`}>
                        <PolarisLink
                          url={`/app/customers/${encodeURIComponent(row.shopDomain)}?app=${app.id}`}
                          removeUnderline
                        >
                          {row.name}
                        </PolarisLink>
                        {/* The domain stays underneath: it is the identity the
                            name stands in for, and a store called "PB & J"
                            is not findable without it. */}
                        <Text as="span" tone="subdued" variant="bodySm">
                          {row.shopDomain}
                          {row.onTrial ? " · On trial" : ""}
                        </Text>
                      </BlockStack>,
                      <div key={`a-${row.shopDomain}`} style={{ textAlign: "center" }}>
                        {formatMoney(row.amount, row.currency)}
                      </div>,
                      <div key={`c-${row.shopDomain}`} style={{ textAlign: "center" }}>
                        {formatMoney(row.lifetimeValue, row.currency)}
                      </div>,
                      <span key={`s-${row.shopDomain}`}>
                        {row.since ? formatDateTime(row.since) : "—"}
                      </span>,
                    ])}
                  />
                </div>
              </Box>
            )}
            {detail.totalPages > 1 ? (
              <Box padding="300" borderColor="border" borderBlockStartWidth="025">
                <InlineStack align="center">
                  <Pagination
                    hasPrevious={page > 1}
                    hasNext={page < detail.totalPages}
                    onPrevious={() => goToPage(page - 1)}
                    onNext={() => goToPage(page + 1)}
                    label={`Page ${page} of ${detail.totalPages}`}
                  />
                </InlineStack>
              </Box>
            ) : null}
          </Card>

          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Events
              </Text>
              {events.length === 0 ? (
                <Text as="p" tone="subdued" variant="bodySm">
                  No recorded activity on this plan.
                </Text>
              ) : (
                <BlockStack gap="300">
                  {events.map((event) => (
                    <Tooltip
                      key={`${event.chargeId}:${event.type}:${event.occurredAt}`}
                      preferredPosition="below"
                      content={<EventTooltip event={event} />}
                    >
                      <BlockStack gap="050">
                        <InlineStack
                          align="space-between"
                          blockAlign="center"
                          wrap={false}
                        >
                          <Text as="span" variant="bodySm" fontWeight="semibold">
                            {EVENT_LABELS[event.type] ??
                              event.type.replace(/_/g, " ").toLowerCase()}
                          </Text>
                          <Text as="span" tone="subdued" variant="bodySm">
                            {formatDateTime(event.occurredAt)}
                          </Text>
                        </InlineStack>
                        <InlineStack gap="100" wrap={false}>
                          {/* Clickable like the subscriber rows above — the
                              event names a merchant, and the next question is
                              always about them. */}
                          <PolarisLink
                            url={`/app/customers/${encodeURIComponent(event.shopDomain)}?app=${app.id}`}
                            removeUnderline
                          >
                            <Text as="span" variant="bodySm" truncate>
                              {event.name}
                            </Text>
                          </PolarisLink>
                          <Text as="span" tone="subdued" variant="bodySm">
                            · {formatMoney(event.amount, event.currency)}
                          </Text>
                        </InlineStack>
                      </BlockStack>
                    </Tooltip>
                  ))}
                </BlockStack>
              )}
              {eventPages > 1 ? (
                <InlineStack align="center">
                  <Pagination
                    hasPrevious={eventPage > 1}
                    hasNext={eventPage < eventPages}
                    onPrevious={() => goToEventPage(eventPage - 1)}
                    onNext={() => goToEventPage(eventPage + 1)}
                    label={`Page ${eventPage} of ${eventPages}`}
                  />
                </InlineStack>
              ) : null}
            </BlockStack>
          </Card>
        </InlineGrid>
      </BlockStack>
    </Page>
  );
}

/**
 * Mantle's three-line event tooltip: when the merchant installed, when their
 * trial ended, and what they are on now.
 *
 * Lines are dropped rather than shown empty — a merchant who never trialled
 * has no trial date, and saying "Trial ended —" invents a fact.
 */
function EventTooltip({
  event,
}: {
  event: {
    installedAt: string | null;
    trialEndsAt: string | null;
    currentPlan: string | null;
  };
}) {
  const lines: Array<[string, string]> = [];
  if (event.installedAt) lines.push(["Installed on", formatDateTime(event.installedAt)]);
  if (event.trialEndsAt) lines.push(["Trial ended", formatDateTime(event.trialEndsAt)]);
  if (event.currentPlan) lines.push(["Current subscription", event.currentPlan]);
  if (lines.length === 0) return <span>No subscription history recorded.</span>;

  return (
    <BlockStack gap="150">
      {lines.map(([label, value]) => (
        <BlockStack gap="025" key={label}>
          <Text as="span" variant="bodySm" fontWeight="semibold">
            {label}
          </Text>
          <Text as="span" variant="bodySm">
            {value}
          </Text>
        </BlockStack>
      ))}
    </BlockStack>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <BlockStack gap="100">
        <Text as="span" tone="subdued" variant="bodySm">
          {label}
        </Text>
        <Text as="p" variant="headingLg" fontWeight="bold">
          {value}
        </Text>
      </BlockStack>
    </Card>
  );
}
