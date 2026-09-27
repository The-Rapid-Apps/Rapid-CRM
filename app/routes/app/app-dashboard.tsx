/**
 * One app's dashboard — the page you land on when you pick an app.
 *
 * Mirrors Mantle's app home: five headline figures, then the blocks that say
 * where the money is coming from and why merchants leave.
 *
 * Assembles the EXISTING report builders rather than querying afresh. Every
 * figure here already has a definition somewhere in this codebase, and a second
 * one computed slightly differently is how two pages start disagreeing about
 * the same number. `getPortfolioReport` scoped to one app is exactly what this
 * page needs; `getRevenueReport` supplies collected revenue.
 */
import {
  BlockStack,
  Button,
  Card,
  EmptyState,
  InlineGrid,
  InlineStack,
  Link as PolarisLink,
  Page,
  Pagination,
  ProgressBar,
  SkeletonBodyText,
  SkeletonDisplayText,
  Tabs,
  Text,
  Tooltip,
} from "@shopify/polaris";
import type { ReactNode } from "react";
import { Suspense, useState } from "react";
import { Await, useAsyncError, useNavigate } from "react-router";
import type { Route } from "./+types/app-dashboard";
import { prisma } from "~/lib/db.server";
import { requireCurrentOrganization } from "~/lib/current-org.server";
import { formatDateTime, formatMoney } from "~/lib/format";
import { EMPTY_STATE_IMAGE } from "~/lib/ui";
import { appMonogramDataUri } from "~/components/app-identity";
import { planDetailUrl } from "~/lib/plan-detail-url";
import { COMMITTED_MRR, composeMrr } from "~/lib/reports/mrr-components";
import {
  customerLabel,
  resolveCustomerNames,
} from "~/lib/customer-name.server";
import {
  BarChart,
  ChartLegend,
  LineChart,
  MantleChartTooltip,
  PolarisVizProvider,
} from "./reports";
import {
  compactMoney,
  useBarChartTheme,
  useChartTheme,
  useRevenueChartTheme,
} from "~/lib/chart-theme";
import {
  getAppOverviewBasics,
  resolveAnalyticsRange,
} from "~/lib/reports/analytics.server";
import { readPersistedPartnerSubscriptionActivity } from "~/lib/shopify/partner-subscriptions.server";
import {
  buildObservedPlans,
  buildPlanSubscriptionFlow,
  buildShopSubscriptionSummaries,
  buildPersistedPartnerAnalytics,
  partnerLifecycleReadiness,
} from "~/lib/shopify/partner-mrr.server";

/** The app's own mark beside its name, falling back to the monogram the
 * sidebar and app picker already use for an app with no logo. */
function AppLogo({ app }: { app: { name: string; logoUrl: string | null } }) {
  return (
    <img
      src={app.logoUrl ?? appMonogramDataUri(app.name)}
      alt=""
      width={36}
      height={36}
      style={{ borderRadius: 8, display: "block" }}
    />
  );
}

/** Events per page in the Overview feed. Smaller than the plan page's 25:
 * this is a summary column beside five other cards, not the subject of the
 * page, and a long list pushes everything below it off screen. */
const EVENT_PAGE_SIZE = 10;

export async function loader({ request }: Route.LoaderArgs) {
  const org = await requireCurrentOrganization(request);
  const url = new URL(request.url);

  const apps = await prisma.app.findMany({
    where: { organizationId: org.id, removed: false },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      logoUrl: true,
      // Decides whether persisted Partner facts can serve this app's numbers.
      billingEventsBackfillCompletedAt: true,
      billingSalesBackfillCompletedAt: true,
    },
  });
  const requested = url.searchParams.get("appId")?.trim() ?? "";
  const app = apps.find((candidate) => candidate.id === requested) ?? null;
  const appList = apps.map(({ id, name, logoUrl }) => ({ id, name, logoUrl }));
  if (!app) {
    return {
      app: null,
      apps: appList,
      periodStart: "",
      periodEnd: "",
      comparisonStart: "",
      report: null,
      windowRevenue: 0,
      allTime: 0,
      dailyRevenue: [],
      topActive: [],
      topChurned: [],
      activity: [],
      currency: "USD",
      planFlow: null,
      topPlans: null,
      eventPage: 1,
      eventPages: 1,
    };
  }

  /* Mantle's headline figures are all "last 30 days", and its two revenue
     tiles are a 30-day window beside an all-time total. */
  const range = resolveAnalyticsRange("last_30_days");
  const query = { organizationId: org.id, appId: app.id };

  /* Mantle draws every one of these charts against the preceding window of the
     same length. Rather than reconstruct twice — the Partner rebuild is the
     expensive part of this page — the range is DOUBLED and split in half
     afterwards, so both series come out of one pass. */
  const span = range.end.getTime() - range.start.getTime();
  const comparisonStart = new Date(range.start.getTime() - span);
  const doubled = { ...range, start: comparisonStart, interval: "day" as const };

  /* Apps that bill through Shopify keep nothing in the local `Subscription`
     table — their subscriptions live in the Partner mirror — so
     `getPortfolioReport` alone returns an empty `recurring` for them, which is
     how this page first showed 0 subscriptions and $0 revenue for an app
     with thousands of paying merchants.
     `/api/metrics` solves it by merging the Partner reconstruction into the
     local portfolio, and this uses that same pair rather than a second
     definition of MRR — two pages disagreeing about one number is the failure
     worth designing against here. */
  const readiness = partnerLifecycleReadiness([app]);
  /* MEASURED ALTERNATIVE, NOT TAKEN — leave this note before trying it again.

     `PartnerDailyMrrSnapshot` holds a finalized row per (app, day) with MRR,
     active subscriptions, per-plan MRR and the movement decomposition, and
     reading 60 of those rows is far cheaper than reconstructing the same
     numbers from raw facts. `/api/metrics` uses it. Wiring it in here
     measured NO faster end to end, because the snapshot carries no trials and
     no per-plan flow, so `loadPartnerFacts` still runs for those two, and that
     load IS the cost. It also moved the headline MRR slightly, because
     snapshot rows exist only for finalized days.

     Worth revisiting only once trials and plan flow have snapshot columns of
     their own; until then it trades a number for no speed. */
  const partnerPending = readiness.coverage.applied
    ? buildPersistedPartnerAnalytics({ readiness, range: doubled })
    : null;

  /* Both revenue tiles read settled Partner sale facts — the same table, one
     windowed and one not — so they can never disagree about what counts as
     revenue. `getRevenueReport` is deliberately NOT used: it reads the local
     billing tables, which are empty for Shopify-billed apps, and reported
     $0.00 beside a large all-time total. */
  /* WHY THIS IS NOT MANTLE'S DEFINITION.

     Mantle's spec (§4.4) counts subscription DOCUMENTS — `value_count(id)`
     with an as-of predicate — not subscriptions producing MRR. That was tried
     here, and measured worse: counting every lifecycle-live charge overshot
     Mantle's count by several percent, while the MRR-bearing count below
     landed within a handful of subscriptions.

     Neither definition matches every app, which means the residual is data, not
     arithmetic: charges stuck at FROZEN, most long dead with a cancellation we
     never received (the same ghost-record gap the never-billed work chased).
     Until those are reconciled, the count that agrees with our own MRR is the
     honest one.

     The lifecycle count is deliberately NOT computed here as well: a query on
     every page load whose result nothing displays is cost with no reader. The
     measurement above is the record of it. */
  /* Daily collected revenue, for the "All paid transactions" chart. Grouped in
     SQL rather than pulled row-by-row: a busy app settles tens of thousands of
     sales a month and the chart only ever needs one number per day. */
  const dailyRevenuePromise = prisma.$queryRawUnsafe<
    Array<{ day: string; total: number }>
  >(
    `SELECT DATE_FORMAT(occurredAt, '%Y-%m-%d') AS day,
            SUM(grossAmount) AS total
       FROM partner_subscription_sale_facts
      WHERE appId = ? AND occurredAt >= ? AND occurredAt < ?
      GROUP BY day ORDER BY day`,
    app.id,
    comparisonStart,
    range.end,
  );

  /* Top customers, straight off the per-shop state the sync maintains — the
     same rows the Customers page reads, so the two cannot disagree about what
     a shop is worth. `activeChargeCount` is what separates Active from
     Churned; a shop with none has stopped paying but keeps its lifetime
     value. */
  const topActivePromise = prisma.partnerCustomerState.findMany({
    where: { appId: app.id, activeChargeCount: { gt: 0 } },
    orderBy: { mrr: "desc" },
    take: 5,
    select: { shopDomain: true, mrr: true, lifetimeValue: true, currencyCode: true },
  });
  const topChurnedPromise = prisma.partnerCustomerState.findMany({
    where: { appId: app.id, activeChargeCount: 0, saleCount: { gt: 0 } },
    orderBy: { lifetimeValue: "desc" },
    take: 5,
    select: { shopDomain: true, mrr: true, lifetimeValue: true, currencyCode: true },
  });

  /* Top plans, from the same reader the Plans page uses so the card and that
     page cannot disagree. NOT `recurring.planSeries`, which groups by name
     alone: the card needs a price and a cadence to link to a plan, and
     "Starter" is two plans here ($15 monthly and $119.88 annual). Shares the
     already-cached fact load, so it adds no query of its own. */
  const topPlansPromise = buildObservedPlans({ appId: app.id });

  /* Per-plan gains and losses, counted off the movement fold so an upgrade is
     not reported as one subscription lost and another gained. */
  const planFlowPromise = buildPlanSubscriptionFlow({
    appId: app.id,
    start: range.start,
    end: range.end,
  });

  /* The display currency, read straight off the sale facts.

     The charts that do NOT wait for `report` still have to label an axis, and
     `report.recurring.currencies[0].currency` is exactly what they used to
     read — which would have dragged them back behind the slow half. Same
     table those figures come from and, as the tiles already assume, one
     currency per app in practice, so the two cannot disagree. */
  const currencyPromise = prisma.$queryRawUnsafe<Array<{ currencyCode: string }>>(
    `SELECT currencyCode FROM partner_subscription_sale_facts
      WHERE appId = ? GROUP BY currencyCode ORDER BY COUNT(*) DESC LIMIT 1`,
    app.id,
  );

  /* The events feed pages in place rather than sending you to /app/events for
     the thirteenth row. `skip` is what asks the reader for a total. */
  const eventPage = Math.max(1, Number(url.searchParams.get("epage") ?? 1) || 1);
  const activityPromise = readPersistedPartnerSubscriptionActivity(
    [{ id: app.id, name: app.name }],
    EVENT_PAGE_SIZE,
    (eventPage - 1) * EVENT_PAGE_SIZE,
  );

  /* STREAMED, NOT AWAITED — this is what makes the page paint immediately.

     These two are the whole cost of the page: the Partner reconstruction and
     the portfolio report together run about 6s warm and 12s cold for Rapi
     Bundle, against ~300ms for everything else on this loader combined.
     Awaiting them here meant the browser got nothing at all until they
     finished, so a page whose revenue tiles, transactions chart, top
     customers and event feed were ready in a fraction of a second sat blank
     for twelve.

     Returned as promises instead, they stream in behind skeletons while the
     rest of the page is already interactive. This makes NO number different —
     the same builders, the same arguments — which is the reason to prefer it
     over the snapshot path measured above. */
  const reportPromise = Promise.all([
    getAppOverviewBasics(query, range),
    partnerPending,
  ]).then(([basics, partner]) => ({
    /* Assembled here rather than merged into a `PortfolioReport`, because this
       page displays four things and that type carries twenty. Building the
       full report to read a quarter of it is what cost ~6s a request. */
    recurring: partner?.recurring ?? null,
    trials: partner?.recurring.trials ?? null,
    installs: { activeNow: basics.activeInstalls },
    uninstallReasons: basics.uninstallReasons,
  }));

  const [
    windowRows,
    allTimeRows,
    dailyRevenue,
    topActive,
    topChurned,
    activity,
    currencyRows,
  ] = await Promise.all([
    prisma.partnerSubscriptionSaleFact.aggregate({
      where: {
        appId: app.id,
        occurredAt: { gte: range.start, lt: range.end },
      },
      _sum: { grossAmount: true },
    }),
    prisma.partnerSubscriptionSaleFact.aggregate({
      where: { appId: app.id },
      _sum: { grossAmount: true },
    }),
    dailyRevenuePromise,
    topActivePromise,
    topChurnedPromise,
    activityPromise,
    currencyPromise,
  ]);

  const windowRevenue = Number(windowRows._sum.grossAmount ?? 0);
  const allTime = Number(allTimeRows._sum.grossAmount ?? 0);

  /* The same three-line tooltip the plan page shows, for the shops on this
     page of events only — folding for every shop to describe twenty of them is
     work nobody reads. */
  const eventShops = [
    ...new Set(activity.events.map((event) => event.shopDomain).filter(Boolean)),
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

  const names = await resolveCustomerNames([
    ...topActive.map((row) => row.shopDomain),
    ...topChurned.map((row) => row.shopDomain),
    ...activity.events.map((event) => event.shopDomain),
  ]);

  const money = (rows: typeof topActive) =>
    rows.map((row) => ({
      shopDomain: row.shopDomain,
      name: customerLabel(row.shopDomain, names),
      mrr: Number(row.mrr),
      lifetimeValue: Number(row.lifetimeValue),
      currency: row.currencyCode,
    }));

  return {
    /* The visible window; the loader fetched twice this much so the charts can
       draw a previous-period comparison. */
    periodStart: range.start.toISOString(),
    periodEnd: range.end.toISOString(),
    comparisonStart: comparisonStart.toISOString(),
    app: { id: app.id, name: app.name, logoUrl: app.logoUrl },
    apps: appList,
    windowRevenue,
    allTime,
    dailyRevenue: dailyRevenue.map((row) => ({
      day: row.day,
      total: Number(row.total),
    })),
    topActive: money(topActive),
    topChurned: money(topChurned),
    eventPage,
    eventPages: Math.max(
      1,
      Math.ceil((activity.total ?? activity.events.length) / EVENT_PAGE_SIZE),
    ),
    activity: activity.events.map((event) => ({
      ...event,
      name: customerLabel(event.shopDomain, names),
      installedAt: installedAt.get(event.shopDomain)?.toISOString() ?? null,
      trialEndsAt: summaries.get(event.shopDomain)?.trialEndsAt?.toISOString() ?? null,
      currentPlan: (() => {
        const plan = summaries.get(event.shopDomain)?.currentPlan;
        return plan
          ? `${plan.plan}: ${formatMoney(plan.amount, event.currencyCode)} ${
              plan.interval === "ANNUAL" ? "per year" : "every 30 days"
            }`
          : null;
      })(),
    })),
    currency: currencyRows[0]?.currencyCode ?? "USD",
    report: reportPromise,
    planFlow: planFlowPromise,
    topPlans: topPlansPromise,
  };
}

export function meta() {
  return [{ title: "App dashboard · Rapid Apps" }];
}

/* One colour per plan, reused for that plan's gains AND losses so a reader can
   follow a single plan above and below the axis. Mantle's own legend lists each
   plan once, which only works if both halves share a colour. */
const PLAN_COLORS = [
  "#9364ff",
  "#38a3f5",
  "#ff5cae",
  "#f5b544",
  "#f0803c",
  "#2fbf71",
  "#e0554a",
  "#b9a6ff",
];

/**
 * New and lost subscriptions per day, stacked by plan.
 *
 * Gains go up, losses go down, each plan keeping one colour across both — so a
 * day where Starter gained 3 and lost 1 reads as +3 and -1 rather than a net
 * +2. That distinction is the reason to draw this chart at all: net alone
 * hides churn happening underneath growth.
 *
 * The built-in legend is suppressed because polaris-viz would list every series
 * — two per plan — and repeat each name.
 */
function PlanFlowChart({
  labels,
  plans,
  addedByPlan,
  lostByPlan,
}: {
  labels: string[];
  plans: string[];
  addedByPlan: Map<string, number[]>;
  lostByPlan: Map<string, number[]>;
}) {
  const { themes } = useBarChartTheme(labels.length, 260);
  /* Hiding a plan is a VIEW filter, the same contract as the Reports legend:
     it changes what is drawn, not what anything means, so it lives in
     component state and resets on reload. */
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const toggle = (plan: string) =>
    setHidden((current) => {
      const next = new Set(current);
      if (!next.delete(plan)) next.add(plan);
      return next;
    });

  const visiblePlans = plans.filter((plan) => !hidden.has(plan));

  /* The headline follows the legend: hide a plan and the number above the
     chart is the net of what is still drawn, so it always describes the bars
     underneath it rather than a total the reader cannot see. */
  const netByDay = labels.map((_, day) =>
    visiblePlans.reduce(
      (sum, plan) =>
        sum +
        (addedByPlan.get(plan)?.[day] ?? 0) -
        (lostByPlan.get(plan)?.[day] ?? 0),
      0,
    ),
  );
  const net = netByDay.reduce((sum, value) => sum + value, 0);

  if (plans.length === 0) {
    return (
      <section className="reports-chart-card">
        <div className="reports-chart-header">
          <div>
            <div className="reports-chart-label">
              New and lost subscriptions by plan
            </div>
            <div className="reports-chart-value">0</div>
          </div>
        </div>
        <Text as="p" tone="subdued" variant="bodySm">
          No subscriptions started or ended in this period.
        </Text>
      </section>
    );
  }

  const colorFor = (plan: string) =>
    PLAN_COLORS[plans.indexOf(plan) % PLAN_COLORS.length]!;

  const series = visiblePlans.flatMap((plan) => {
    const color = colorFor(plan);
    const added = addedByPlan.get(plan) ?? [];
    const lost = lostByPlan.get(plan) ?? [];
    return [
      {
        name: plan,
        color,
        data: labels.map((key, day) => ({ key, value: added[day] ?? 0 })),
      },
      {
        // Losses are the same plan, drawn below the axis. The name is only
        // used for the tooltip, which is why it says so in words.
        name: `${plan} lost`,
        color,
        data: labels.map((key, day) => ({ key, value: -(lost[day] ?? 0) })),
      },
    ];
  });

  return (
    <section className="reports-chart-card">
      <div className="reports-chart-header">
        <div>
          <div className="reports-chart-label">
            New and lost subscriptions by plan
          </div>
          <div className="reports-chart-value">
            {arrowCount(net)}
          </div>
        </div>
      </div>
      <Suspense fallback={<div className="reports-chart-canvas" />}>
        <PolarisVizProvider themes={themes} defaultTheme="Mantle">
          <div
            className="reports-chart-canvas"
            aria-label="New and lost subscriptions by plan"
          >
            <BarChart
              data={series}
              type="stacked"
              showLegend={false}
              tooltipOptions={{
                /* Built from the day index rather than from the hovered
                   series, so pointing anywhere on a day's column gives the
                   whole day. polaris-viz would otherwise report only the
                   segment under the cursor, which makes a stacked column
                   readable one plan at a time and never as a day.

                   One row per plan showing its NET for the day, then the
                   day's net — Mantle's shape. The two-row gain/loss split
                   lives in the bars themselves, where the axis gives it
                   meaning; repeating it here doubled the row count and read
                   as a list of unrelated numbers. */
                renderTooltipContent: ({ activeIndex }) => (
                  <MantleChartTooltip
                    title={labels[activeIndex] ?? ""}
                    delta={netByDay[activeIndex] ?? 0}
                    currency=""
                    valueFormatter={(value) => value.toLocaleString()}
                    rows={[
                      ...visiblePlans.map((plan) => ({
                        label: plan,
                        value:
                          (addedByPlan.get(plan)?.[activeIndex] ?? 0) -
                          (lostByPlan.get(plan)?.[activeIndex] ?? 0),
                        color: colorFor(plan),
                      })),
                      {
                        label: "Net change",
                        value: netByDay[activeIndex] ?? 0,
                        color: "#f4a261",
                        total: true as const,
                      },
                    ]}
                  />
                ),
              }}
            />
          </div>
        </PolarisVizProvider>
      </Suspense>
      <ChartLegend
        items={plans.map((plan) => ({ label: plan, color: colorFor(plan) }))}
        hidden={hidden}
        onToggle={toggle}
      />
    </section>
  );
}

/** The count counterpart to `arrowMoney`, for the plan-flow headline. */
function arrowCount(value: number): string {
  const arrow = value > 0 ? "↑ " : value < 0 ? "↓ " : "";
  return `${arrow}${Math.abs(value).toLocaleString()}`;
}

/**
 * The three lines Mantle shows when hovering an event: when the merchant
 * installed, when their trial ended, and what they are on now.
 *
 * Lines are dropped rather than blanked — a merchant who never trialled has no
 * trial date, and "Trial ended —" invents a fact. "Current subscription" is
 * what they are on TODAY, which need not be what the event is about: a
 * "Cancelled" row whose tooltip shows a live plan means they moved, not left.
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

/** Partner event types read as constants; these are what they mean. */
const EVENT_LABELS: Record<string, string> = {
  SUBSCRIPTION_CHARGE_ACTIVATED: "Subscribed",
  SUBSCRIPTION_CHARGE_CANCELED: "Cancelled",
  SUBSCRIPTION_CHARGE_EXPIRED: "Expired",
  SUBSCRIPTION_CHARGE_FROZEN: "Frozen",
  SUBSCRIPTION_CHARGE_UNFROZEN: "Unfrozen",
  SUBSCRIPTION_CHARGE_DECLINED: "Charge declined",
};

function eventLabel(type: string): string {
  return EVENT_LABELS[type] ?? type.replace(/_/g, " ").toLowerCase();
}

/** "Sep 13" — the axis label Mantle uses on these charts. */
function shortDay(iso: string): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Every UTC day in [start, end), as `YYYY-MM-DD`. */
function eachDay(start: string, end: string): string[] {
  const days: string[] = [];
  const cursor = new Date(start);
  const stop = new Date(end);
  while (cursor < stop) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

/**
 * "↑ $3,717.86" — Mantle's arrow-and-magnitude form for a signed figure.
 *
 * The direction is an arrow rather than a minus sign because these figures sit
 * beside each other in a summary row, where "-$412.00" next to "$3,470.00"
 * reads as two unrelated amounts; an arrow reads as a direction at a glance.
 * `compact` gives the "$3.72K" form Mantle uses in that summary row, where the
 * headline above it already carries the exact figure.
 */
/**
 * A summary figure whose leading arrow carries the direction in colour.
 *
 * The arrow is coloured rather than the whole figure: at 12px a fully tinted
 * amount competes with the headline above it, and the same green/red pairing
 * is already what `MantleChartTooltip` uses for its delta — so a rise reads
 * the same colour wherever it appears on this page.
 */
function SummaryValue({ text }: { text: string }) {
  const { isDark } = useChartTheme();
  const arrow = text.startsWith("↑") ? "↑" : text.startsWith("↓") ? "↓" : "";
  if (!arrow) {
    return (
      <Text as="span" variant="bodySm" fontWeight="semibold">
        {text}
      </Text>
    );
  }
  const color =
    arrow === "↑"
      ? isDark
        ? "#33e38c"
        : "#0c8f52"
      : isDark
        ? "#ff7070"
        : "#c9342b";
  return (
    <Text as="span" variant="bodySm" fontWeight="semibold">
      <span style={{ color }}>{arrow}</span>
      {text.slice(arrow.length)}
    </Text>
  );
}

function arrowFor(value: number): string {
  return value > 0 ? "↑ " : value < 0 ? "↓ " : "";
}

function arrowMoney(value: number, currency: string, compact = false): string {
  const arrow = arrowFor(value);
  const amount = compact
    ? compactMoney(Math.abs(value), currency)
    : formatMoney(Math.abs(value), currency);
  return `${arrow}${amount}`;
}

/**
 * A chart with its previous-period comparison behind it, in the same card
 * Mantle uses and the same one the Reports page already renders.
 *
 * The markup is deliberately `reports-chart-card` rather than a Polaris `Card`:
 * those classes carry the dark-surface treatment, the header/label/value type
 * scale and the legend styling that the rest of this app's charts use, so a
 * chart here cannot drift from a chart there.
 *
 * `isComparison` is what makes the second line dashed — polaris-viz's own
 * comparison affordance, rather than a colour we would have to keep in step
 * with the theme.
 */
function ComparisonChart({
  title,
  headline,
  currency,
  labels,
  seriesName,
  values,
  comparisonValues,
  summary,
  empty,
}: {
  title: string;
  headline: string;
  currency: string;
  labels: string[];
  seriesName: string;
  values: number[];
  comparisonValues: number[];
  summary: Array<{
    label: string;
    value: string;
    /** A second reading of the same figure — an amount and its percentage,
     * say. Given one, the entry renders as a button that cycles between them,
     * which is how Mantle lets this column be read either way without
     * spending a second column on it. */
    alternate?: string;
  }>;
  empty: string;
}) {
  /* `useRevenueChartTheme`, not `useBarChartTheme`: this draws LINES, and the
     base theme leaves `line.width` at 10 — the width a bar wants, not a line.
     It rendered these two charts as thick ribbons that swallowed their own
     detail. The revenue theme overrides it to 1.5, which is what the Reports
     MRR charts already use. */
  const { themes } = useRevenueChartTheme(labels.length);
  /* Which reading a toggling summary entry is showing. One flag for the card
     rather than one per entry: only ever one entry offers an alternate, and a
     per-entry map would be state nothing reads. */
  const [showAlternate, setShowAlternate] = useState(false);
  const hasData =
    values.some((value) => value !== 0) ||
    comparisonValues.some((value) => value !== 0);

  const series = [
    {
      name: seriesName,
      data: labels.map((key, index) => ({ key, value: values[index] ?? 0 })),
    },
    {
      name: "Previous period",
      isComparison: true,
      /* Plotted against the CURRENT period's labels on purpose: the point of
         the dashed line is "the same day one window ago", so the two have to
         share an x position. */
      data: labels.map((key, index) => ({
        key,
        value: comparisonValues[index] ?? 0,
      })),
    },
  ];

  return (
    <section className="reports-chart-card">
      <div className="reports-chart-header">
        <div>
          <div className="reports-chart-label">{title}</div>
          <div className="reports-chart-value">{headline}</div>
        </div>
        <InlineStack gap="400">
          {summary
            .filter((entry) => entry.label || entry.value)
            .map((entry) => {
              const shown =
                entry.alternate && showAlternate ? entry.alternate : entry.value;
              const body = (
                <BlockStack gap="050">
                  {entry.label ? (
                    <Text as="span" tone="subdued" variant="bodySm">
                      {entry.label}
                    </Text>
                  ) : null}
                  {shown ? <SummaryValue text={shown} /> : null}
                </BlockStack>
              );
              return entry.alternate ? (
                <button
                  key={entry.label}
                  type="button"
                  className="reports-chart-summary-toggle"
                  onClick={() => setShowAlternate((current) => !current)}
                  aria-label={`${entry.label}: ${shown}. Show ${
                    showAlternate ? entry.value : entry.alternate
                  }`}
                >
                  {body}
                </button>
              ) : (
                <div key={`${entry.label}-${entry.value}`}>{body}</div>
              );
            })}
        </InlineStack>
      </div>

      {hasData ? (
        <Suspense fallback={<div className="reports-chart-canvas" />}>
          <PolarisVizProvider themes={themes} defaultTheme="Mantle">
            <div className="reports-chart-canvas" aria-label={title}>
              <LineChart
                data={series}
                showLegend={false}
                tooltipOptions={{
                  renderTooltipContent: ({ activeIndex, data: tooltip }) => (
                    <MantleChartTooltip
                      title={labels[activeIndex] ?? ""}
                      delta={values[activeIndex] ?? 0}
                      currency={currency}
                      rows={(tooltip[0]?.data ?? [])
                        .filter((row) => !row.isHidden)
                        .map((row) => ({
                          label: String(row.key),
                          value: Number(row.value ?? 0),
                          color:
                            typeof row.color === "string" ? row.color : "#9364ff",
                        }))}
                    />
                  ),
                }}
                xAxisOptions={{ allowLineWrap: false }}
              />
            </div>
          </PolarisVizProvider>
        </Suspense>
      ) : (
        <Text as="p" tone="subdued" variant="bodySm">
          {empty}
        </Text>
      )}

      <div className="reports-chart-legend" aria-label="Chart legend">
        <span>
          <i style={{ background: "#9364ff" }} aria-hidden="true" />
          {seriesName}
        </span>
        <span>
          <i className="reports-chart-legend-dash" aria-hidden="true" />
          Previous period
        </span>
      </div>
    </section>
  );
}

/**
 * One streamed block: a skeleton until the loader's promise resolves, and a
 * contained failure if it never does.
 *
 * Each slow block gets its own boundary rather than one around the whole page,
 * so the MRR card does not hold up the plan chart and neither holds up the
 * parts that were ready immediately.
 *
 * `errorElement` is not optional politeness. A rejected streamed promise with
 * nowhere local to land escapes to the route error boundary and replaces the
 * ENTIRE page with a stack trace — which is what a stream timeout did here,
 * throwing away tiles, revenue and the event feed that had all rendered
 * successfully in 300ms. Caught here, one slow builder costs its own card and
 * nothing else.
 */
function Deferred<T>({
  value,
  fallback,
  children,
}: {
  value: Promise<T>;
  fallback: ReactNode;
  children: (resolved: T) => ReactNode;
}) {
  return (
    <Suspense fallback={fallback}>
      <Await resolve={value} errorElement={<DeferredError />}>
        {children as never}
      </Await>
    </Suspense>
  );
}

/** What one streamed block shows when its data never arrived. */
function DeferredError() {
  const error = useAsyncError();
  const timedOut =
    error instanceof Error && /timeout/i.test(error.message);
  return (
    <Card>
      <BlockStack gap="200">
        <Text as="p" variant="bodySm" fontWeight="semibold">
          {timedOut ? "This section timed out" : "This section failed to load"}
        </Text>
        <Text as="p" tone="subdued" variant="bodySm">
          {timedOut
            ? "The figures behind it took too long to rebuild. Reloading usually works — the result is cached once it completes."
            : "Reload the page to try again."}
        </Text>
      </BlockStack>
    </Card>
  );
}

/** Placeholder with the same frame as the card it stands in for, so nothing
 * jumps when the real content arrives. */
function CardSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <Card>
      <BlockStack gap="300">
        <SkeletonDisplayText size="small" />
        <SkeletonBodyText lines={lines} />
      </BlockStack>
    </Card>
  );
}

function ChartSkeleton({ title }: { title: string }) {
  return (
    <section className="reports-chart-card">
      <div className="reports-chart-header">
        <div>
          <div className="reports-chart-label">{title}</div>
          <SkeletonDisplayText size="medium" />
        </div>
      </div>
      <div className="reports-chart-canvas" />
    </section>
  );
}

function TilesSkeleton() {
  return (
    <InlineGrid columns={{ xs: 1, sm: 2, md: 3, lg: 5 }} gap="300">
      {[0, 1, 2, 3, 4].map((index) => (
        <Card key={index}>
          <BlockStack gap="200">
            <SkeletonBodyText lines={1} />
            <SkeletonDisplayText size="medium" />
          </BlockStack>
        </Card>
      ))}
    </InlineGrid>
  );
}

function Tile({
  label,
  value,
  delta,
}: {
  label: string;
  value: string;
  /** Percentage change against the previous period; omitted when there is no
   * meaningful comparison rather than shown as a misleading 0%. */
  delta?: number | null;
}) {
  return (
    <Card>
      <BlockStack gap="100">
        <Text as="span" tone="subdued" variant="bodySm">
          {label}
        </Text>
        <InlineStack gap="200" blockAlign="baseline" wrap={false}>
          <Text as="span" variant="headingLg" fontWeight="bold">
            {value}
          </Text>
          {delta != null && Number.isFinite(delta) && delta !== 0 ? (
            <Text
              as="span"
              variant="bodySm"
              tone={delta > 0 ? "success" : "critical"}
            >
              {delta > 0 ? "↑" : "↓"} {Math.abs(delta).toFixed(1)}%
            </Text>
          ) : null}
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

export default function AppDashboard({ loaderData }: Route.ComponentProps) {
  const {
    periodStart,
    periodEnd,
    comparisonStart,
    app,
    apps,
    report,
    windowRevenue,
    allTime,
    dailyRevenue,
    currency,
    planFlow,
    topPlans,
    eventPage,
    eventPages,
    topActive,
    topChurned,
    activity,
  } = loaderData;
  const [customerTab, setCustomerTab] = useState(0);
  const navigate = useNavigate();

  if (!app || !report) {
    return (
      <Page title="App dashboard" fullWidth>
        <Card>
          <EmptyState heading="Choose an app" image={EMPTY_STATE_IMAGE}>
            <p>
              {apps.length
                ? "Pick an app from the sidebar to see its dashboard."
                : "Connect an app first — this page summarises one app at a time."}
            </p>
          </EmptyState>
        </Card>
      </Page>
    );
  }

  /* Split the doubled window down the middle: the second half is what the
     chart shows, the first half is the dashed comparison behind it. Both are
     plotted against the CURRENT period's day labels, which is what makes
     "same day last month" line up vertically the way Mantle's does. */
  const visibleDays = eachDay(periodStart, periodEnd);
  const comparisonDays = eachDay(comparisonStart, periodStart);

  /* Days with no settled sale are absent from the SQL grouping, so they are
     filled with zero — a gap would make the line jump between distant days and
     read as a trend that did not happen. */
  const revenueByDay = new Map(dailyRevenue.map((row) => [row.day, row.total]));
  const revenueNow = visibleDays.map((day) => revenueByDay.get(day) ?? 0);
  const revenueBefore = comparisonDays.map((day) => revenueByDay.get(day) ?? 0);
  const revenueTotal = revenueNow.reduce((sum, value) => sum + value, 0);
  const revenueBeforeTotal = revenueBefore.reduce((sum, value) => sum + value, 0);
  const revenueChange = revenueTotal - revenueBeforeTotal;

  const labels = visibleDays.map(shortDay);

  /* Paging the events feed keeps the app in the URL — this page is addressed
     by `?appId=`, and dropping it would land on the "choose an app" state. */
  const goToEventPage = (next: number) =>
    navigate(`/app/dashboard?appId=${app.id}&epage=${next}`);

  return (
    /* Page's own header is not used here. Polaris types `title` as a plain
       string, so there is no slot to the LEFT of it for the app's logo —
       `titleMetadata` only ever renders after the title. The header is one
       row, so owning it costs less than working around that. */
    <Page fullWidth>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center" wrap={false}>
          <InlineStack gap="300" blockAlign="center" wrap={false}>
            <AppLogo app={app} />
            <BlockStack gap="050">
              <Text as="h1" variant="headingLg" fontWeight="bold">
                {app.name}
              </Text>
              <Text as="p" tone="subdued" variant="bodySm">
                Last 30 days
              </Text>
            </BlockStack>
          </InlineStack>
          <Button url={`/app/apps/${app.id}`}>App settings</Button>
        </InlineStack>

        <Deferred value={report} fallback={<TilesSkeleton />}>
          {(resolved) => {
            const money = resolved.recurring?.currencies[0] ?? null;
            return (
              <InlineGrid columns={{ xs: 1, sm: 2, md: 3, lg: 5 }} gap="300">
                <Tile
                  label="Users"
                  value={resolved.installs.activeNow.toLocaleString()}
                />
                <Tile
                  label="Subscriptions"
                  value={(money?.activeSubscriptions ?? 0).toLocaleString()}
                  delta={money?.growthRate}
                />
                <Tile
                  label="Active trials"
                  value={(resolved.trials?.activeNow ?? 0).toLocaleString()}
                />
                <Tile
                  label="30 day revenue"
                  value={compactMoney(windowRevenue, "USD")}
                />
                <Tile
                  label="All-time revenue"
                  value={compactMoney(allTime, "USD")}
                />
              </InlineGrid>
            );
          }}
        </Deferred>

        <InlineGrid columns={{ xs: 1, lg: ["twoThirds", "oneThird"] }} gap="400">
          <BlockStack gap="400">
            <Deferred value={report} fallback={<CardSkeleton lines={2} />}>
              {(resolved) => {
                const money = resolved.recurring?.currencies[0] ?? null;
                return (
                  <Card>
                    <BlockStack gap="200">
                      <Text as="h2" variant="headingMd">
                        Monthly recurring revenue
                      </Text>
                      <Text as="p" variant="heading2xl" fontWeight="bold">
                        {/* COMMITTED MRR, the same composition Reports
                            headlines. `money.mrr` is the GROSS run rate with
                            the trial band folded in — rendering it here put
                            this card several thousand dollars above the
                            Reports page and above Mantle on the same day. The
                            trial value keeps its own line below. */}
                        {formatMoney(
                          composeMrr(money ?? {}, COMMITTED_MRR),
                          money?.currency ?? currency,
                        )}
                      </Text>
                      <Text as="p" tone="subdued" variant="bodySm">
                        {(money?.activeSubscriptions ?? 0).toLocaleString()} active
                        subscriptions ·{" "}
                        {formatMoney(
                          money?.trialSubscriptions ?? 0,
                          money?.currency ?? currency,
                        )}{" "}
                        on trial
                      </Text>
                    </BlockStack>
                  </Card>
                );
              }}
            </Deferred>

            <Deferred
              value={report}
              fallback={
                <ChartSkeleton title="Total change in subscription revenue" />
              }
            >
              {(resolved) => {
                const byDay = new Map(
                  (resolved.recurring?.movement?.[0]?.buckets ?? []).map(
                    (bucket) => [
                      (bucket.periodStart ?? "").slice(0, 10),
                      bucket.net,
                    ],
                  ),
                );
                const now = visibleDays.map((day) => byDay.get(day) ?? 0);
                const before = comparisonDays.map((day) => byDay.get(day) ?? 0);
                const net = now.reduce((sum, value) => sum + value, 0);
                const netBefore = before.reduce((sum, value) => sum + value, 0);
                return (
                  <ComparisonChart
                    title="Total change in subscription revenue"
                    headline={arrowMoney(net, currency)}
                    currency={currency}
                    labels={labels}
                    seriesName="Net change"
                    values={now}
                    comparisonValues={before}
                    summary={[
                      {
                        label: "Last 30 days",
                        value: arrowMoney(net, currency, true),
                      },
                      {
                        label: "Previous period",
                        value: arrowMoney(netBefore, currency, true),
                      },
                    ]}
                    empty="No recorded movement in this period."
                  />
                );
              }}
            </Deferred>

            <Deferred
              value={planFlow}
              fallback={
                <ChartSkeleton title="New and lost subscriptions by plan" />
              }
            >
              {(points) => {
                /* Plans ordered by how much they moved, so the busiest keep
                   stable colours and the legend leads with what matters. */
                const totals = new Map<string, number>();
                for (const point of points) {
                  totals.set(
                    point.plan,
                    (totals.get(point.plan) ?? 0) + point.added + point.lost,
                  );
                }
                const plans = [...totals.entries()]
                  .sort((left, right) => right[1] - left[1])
                  .slice(0, PLAN_COLORS.length)
                  .map(([plan]) => plan);

                const added = new Map<string, number[]>();
                const lost = new Map<string, number[]>();
                for (const plan of plans) {
                  added.set(plan, visibleDays.map(() => 0));
                  lost.set(plan, visibleDays.map(() => 0));
                }
                const dayIndex = new Map(
                  visibleDays.map((day, index) => [day, index]),
                );
                for (const point of points) {
                  const index = dayIndex.get(point.day);
                  if (index === undefined || !added.has(point.plan)) continue;
                  added.get(point.plan)![index] += point.added;
                  lost.get(point.plan)![index] += point.lost;
                }
                return (
                  <PlanFlowChart
                    labels={labels}
                    plans={plans}
                    addedByPlan={added}
                    lostByPlan={lost}
                  />
                );
              }}
            </Deferred>

            <ComparisonChart
              title="All paid transactions"
              headline={formatMoney(revenueTotal, currency)}
              currency={currency}
              labels={labels}
              seriesName="Revenue"
              values={revenueNow}
              comparisonValues={revenueBefore}
              /* One column, and it reports the CHANGE against the previous
                 window rather than the total — the total is already the
                 headline two lines above, so a column repeating it says
                 nothing. Clicking swaps the amount for the same change as a
                 percentage. The percentage is omitted when there is no prior
                 revenue to divide by: an app's first billing month would
                 otherwise read as an infinite rise. */
              summary={[
                {
                  label: "Last 30 days",
                  value: arrowMoney(revenueChange, currency),
                  ...(revenueBeforeTotal
                    ? {
                        alternate: `${arrowFor(revenueChange)}${Math.abs(
                          (revenueChange / revenueBeforeTotal) * 100,
                        ).toFixed(2)}%`,
                      }
                    : {}),
                },
              ]}
              empty="No settled transactions in this period."
            />

            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  Billed usage and one-time charges
                </Text>
                <Text as="p" variant="heading2xl" fontWeight="bold">
                  {formatMoney(0, currency)}
                </Text>
                {/* Not a chart with no data — a statement. No Rapi app bills
                    usage or sells one-time purchases, so this is structurally
                    zero rather than awaiting a sync. Drawing a flat line would
                    imply otherwise. */}
                <Text as="p" tone="subdued" variant="bodySm">
                  No app is billing usage charges or one-time purchases.
                </Text>
              </BlockStack>
            </Card>
          </BlockStack>

          <BlockStack gap="400">
            <Deferred value={topPlans} fallback={<CardSkeleton lines={5} />}>
              {(plans) => (
                <Card>
                  <BlockStack gap="300">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="h2" variant="headingMd">
                        Top plans
                      </Text>
                      <PolarisLink url={`/app/plans?appId=${app.id}`}>
                        View all
                      </PolarisLink>
                    </InlineStack>
                    {plans.length === 0 ? (
                      <Text as="p" tone="subdued" variant="bodySm">
                        No plan revenue in this period.
                      </Text>
                    ) : (
                      <BlockStack gap="300">
                        {plans.slice(0, 5).map((plan) => (
                          <InlineStack
                            key={`${plan.plan}-${plan.amount}-${plan.interval}`}
                            align="space-between"
                            blockAlign="start"
                            wrap={false}
                            gap="200"
                          >
                            <BlockStack gap="050">
                              {/* The plan's own page, addressed by its full
                                  identity — name alone would land on whichever
                                  of two same-named plans sorted first. */}
                              <PolarisLink
                                url={planDetailUrl(app.id, plan)}
                                removeUnderline
                              >
                                {plan.plan}
                              </PolarisLink>
                              <Text as="span" tone="subdued" variant="bodySm">
                                {formatMoney(plan.amount, plan.currency)}
                                {plan.interval === "ANNUAL" ? " /yr" : " /mo"}
                              </Text>
                            </BlockStack>
                            <InlineStack gap="400" wrap={false}>
                              <BlockStack gap="050" inlineAlign="end">
                                <Text as="span" tone="subdued" variant="bodySm">
                                  MRR
                                </Text>
                                <Text as="span" fontWeight="semibold">
                                  {compactMoney(plan.mrr, plan.currency)}
                                </Text>
                              </BlockStack>
                              <BlockStack gap="050" inlineAlign="end">
                                <Text as="span" tone="subdued" variant="bodySm">
                                  LTV
                                </Text>
                                <Text as="span" fontWeight="semibold">
                                  {compactMoney(plan.lifetimeValue, plan.currency)}
                                </Text>
                              </BlockStack>
                            </InlineStack>
                          </InlineStack>
                        ))}
                      </BlockStack>
                    )}
                  </BlockStack>
                </Card>
              )}
            </Deferred>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Top customers
                </Text>
                {/* Active and Churned come from the same per-shop rows; the
                    difference is whether any charge is still live. A churned
                    shop keeps its lifetime value, which is the point of
                    listing it. */}
                <Tabs
                  fitted
                  tabs={[
                    { id: "active", content: "Active" },
                    { id: "churned", content: "Churned" },
                  ]}
                  selected={customerTab}
                  onSelect={setCustomerTab}
                />
                {(customerTab === 0 ? topActive : topChurned).length === 0 ? (
                  <Text as="p" tone="subdued" variant="bodySm">
                    {customerTab === 0
                      ? "No paying customers yet."
                      : "No churned customers with recorded revenue."}
                  </Text>
                ) : (
                  <BlockStack gap="200">
                    {(customerTab === 0 ? topActive : topChurned).map((customer) => (
                      <BlockStack gap="050" key={customer.shopDomain}>
                        <PolarisLink
                          url={`/app/customers/${encodeURIComponent(customer.shopDomain)}?app=${app.id}`}
                          removeUnderline
                        >
                          {customer.name}
                        </PolarisLink>
                        <InlineStack gap="300">
                          <Text as="span" tone="subdued" variant="bodySm">
                            AMR: {formatMoney(customer.mrr, customer.currency)}
                          </Text>
                          <Text as="span" tone="subdued" variant="bodySm">
                            CLV: {formatMoney(customer.lifetimeValue, customer.currency)}
                          </Text>
                        </InlineStack>
                      </BlockStack>
                    ))}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>

            <Deferred value={report} fallback={<CardSkeleton lines={6} />}>
              {(resolved) => {
                const reasons = resolved.uninstallReasons.slice(0, 6);
                const worstReason = reasons[0]?.count ?? 0;
                return (
                  <Card>
                    <BlockStack gap="300">
                      <InlineStack align="space-between" blockAlign="center">
                        <Text as="h2" variant="headingMd">
                          Uninstall reasons
                        </Text>
                        <PolarisLink url={`/app/uninstalls?appId=${app.id}`}>
                          View more
                        </PolarisLink>
                      </InlineStack>
                      {reasons.length === 0 ? (
                        <Text as="p" tone="subdued" variant="bodySm">
                          No uninstalls with a recorded reason in this period.
                        </Text>
                      ) : (
                        <BlockStack gap="300">
                          {reasons.map((reason) => (
                            <BlockStack gap="100" key={reason.reasonCode}>
                              <InlineStack align="space-between" blockAlign="center">
                                <Text as="span" variant="bodySm">
                                  {reason.reasonCode.replace(/_/g, " ")}
                                </Text>
                                <Text
                                  as="span"
                                  variant="bodySm"
                                  fontWeight="semibold"
                                >
                                  {reason.count.toLocaleString()}
                                </Text>
                              </InlineStack>
                              {/* Scaled to the largest reason, not to the
                                  total: the question these answer is which
                                  reason dominates. */}
                              <ProgressBar
                                size="small"
                                progress={
                                  worstReason
                                    ? (reason.count / worstReason) * 100
                                    : 0
                                }
                              />
                            </BlockStack>
                          ))}
                        </BlockStack>
                      )}
                    </BlockStack>
                  </Card>
                );
              }}
            </Deferred>

            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Events
                  </Text>
                  <PolarisLink url={`/app/events?appId=${app.id}`}>View all</PolarisLink>
                </InlineStack>
                {activity.length === 0 ? (
                  <Text as="p" tone="subdued" variant="bodySm">
                    No subscription activity recorded yet.
                  </Text>
                ) : (
                  <BlockStack gap="300">
                    {activity.map((event) => (
                      <Tooltip
                        key={`${event.chargeId}:${event.type}:${event.occurredAt}`}
                        preferredPosition="below"
                        content={<EventTooltip event={event} />}
                      >
                      <BlockStack gap="050">
                        <InlineStack align="space-between" blockAlign="center" wrap={false}>
                          <Text as="span" variant="bodySm" fontWeight="semibold">
                            {eventLabel(event.type)}
                          </Text>
                          <Text as="span" tone="subdued" variant="bodySm">
                            {formatDateTime(event.occurredAt)}
                          </Text>
                        </InlineStack>
                        {/* Clickable, like every other merchant on this
                            page — an event is about someone, and reading it
                            usually raises the question "who?". */}
                        {/* No `tone="subdued"`: that grey overrode the link
                            colour and made a clickable row look like static
                            text. Blue is the only thing telling a reader this
                            goes somewhere. */}
                        <PolarisLink
                          url={`/app/customers/${encodeURIComponent(event.shopDomain)}?app=${app.id}`}
                          removeUnderline
                        >
                          <Text as="span" variant="bodySm" truncate>
                            {event.name}
                            {event.chargeName ? ` · ${event.chargeName}` : ""}
                          </Text>
                        </PolarisLink>
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
          </BlockStack>
        </InlineGrid>
      </BlockStack>
    </Page>
  );
}
