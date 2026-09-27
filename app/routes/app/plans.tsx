import {
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  DataTable,
  Icon,
  InlineStack,
  Link,
  Page,
  SkeletonBodyText,
  Tabs,
  Text,
  TextField,
  Tooltip,
} from "@shopify/polaris";
import { Suspense, useMemo, useState } from "react";
import { Await, Form, useNavigate, useNavigation, useSubmit } from "react-router";
import {
  ArchiveIcon,
  CashDollarIcon,
  EditIcon,
  SearchIcon,
  UndoIcon,
} from "@shopify/polaris-icons";
import type { Route } from "./+types/plans";
import { AppName } from "~/components/app-identity";
import { AppPicker } from "~/components/app-picker";
import { ConfirmDialog } from "~/components/confirm-dialog";
import { ProductEmptyState } from "~/components/product-empty-state";
import { planDetailUrl } from "~/lib/plan-detail-url";
import { prisma } from "~/lib/db.server";
import {
  buildObservedPlans,
  partnerLifecycleReadiness,
} from "~/lib/shopify/partner-mrr.server";
import { matchObservedPlans } from "~/lib/shopify/observed-plan-match";
import { requireCurrentOrganization } from "~/lib/current-org.server";
import { formatMoney } from "~/lib/format";

const INTERVAL_LABEL: Record<string, string> = {
  EVERY_30_DAYS: "every 30 days",
  QUARTERLY: "quarterly",
  ANNUAL: "per year",
};

export async function loader({ request }: Route.LoaderArgs) {
  const org = await requireCurrentOrganization(request);
  const now = new Date();

  const apps = await prisma.app.findMany({
    where: { organizationId: org.id },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      logoUrl: true,
      // Decides whether Partner charges can stand in for an empty catalogue.
      billingEventsBackfillCompletedAt: true,
      billingSalesBackfillCompletedAt: true,
    },
  });

  /* The sidebar's per-app navigation links here with `?appId=`, so the page has
     to honour it or "Rapid Bundle > Plans" would list every app's catalogue
     under that heading.

     Validated against this organization's own apps rather than trusted: the
     value arrives from the URL, and an id from another tenant must read as
     "All apps" instead of selecting something. An absent or unknown id is the
     cross-app view, which is what this page has always shown. */
  const requestedAppId =
    new URL(request.url).searchParams.get("appId")?.trim() ?? "";
  const appId = apps.some((app) => app.id === requestedAppId)
    ? requestedAppId
    : "";
  /* Reused by the plan query and both count queries, so a scoped page cannot
     end up with plans from one app and counts from all of them. */
  const appScope = appId
    ? { appId }
    : { app: { organizationId: org.id } };

  const plans = await prisma.plan.findMany({
      where: appScope,
      include: {
        app: { select: { name: true, logoUrl: true } },
        autoUpgradeTo: { select: { name: true } },
      },
      orderBy: [{ appId: "asc" }, { sortOrder: "asc" }, { amount: "asc" }],
    });

  /*
    Two counts per plan, the pair Mantle's list shows: how many merchants are
    still inside a trial, and how many are past one.

    Grouped counts rather than a query per row, so the page costs a fixed number
    of statements whatever the catalogue size. Deliberately NOT revenue: MRR and
    earnings need the reports engine's period arithmetic, and a cheap
    approximation on a list page would quietly disagree with the reports.
  */
  const [trialGroups, customerGroups] = await Promise.all([
    prisma.subscription.groupBy({
      by: ["planId"],
      where: {
        plan: appScope,
        status: "ACTIVE",
        canceledAt: null,
        trialEndsAt: { gt: now },
      },
      _count: { _all: true },
    }),
    prisma.subscription.groupBy({
      by: ["planId"],
      where: {
        plan: appScope,
        status: "ACTIVE",
        canceledAt: null,
        OR: [{ trialEndsAt: null }, { trialEndsAt: { lte: now } }],
      },
      _count: { _all: true },
    }),
  ]);
  /* An app that bills through Shopify keeps no catalogue here — its plans are
     defined in Shopify and we only ever see them as names on charges. Rather
     than show "No plans yet" for an app Mantle lists fifteen plans for, read
     them back off the Partner data.

     Only when the catalogue is genuinely empty: an app that does have plans
     here is flex-billed, and mixing observed rows into its catalogue would
     blur what this org offers with what Shopify happens to be charging.

     Streamed, not awaited — it folds every charge the app has ever had, which
     is seconds on a cold cache. The catalogue table paints immediately. */
  const scopedApp = appId ? apps.find((app) => app.id === appId) : null;
  const observedPlans =
    plans.length === 0 && scopedApp &&
    partnerLifecycleReadiness([scopedApp]).coverage.applied
      ? buildObservedPlans({ appId: scopedApp.id })
      : null;

  /*
    Standard plans are billed by Shopify, so they never get a local
    Subscription row and the counts above are zero for every one of them —
    their merchants live in the Partner data instead. Read those back and
    attach them to the plan each group is (see observed-plan-match.ts).

    Streamed like `observedPlans`, and for the same reason: it folds every
    charge per app, which is seconds cold. Flex plans are left to the local
    counts, which is where their subscriptions are.
  */
  const standardPlansByApp = new Map<string, typeof plans>();
  for (const plan of plans) {
    if (plan.flexBilling) continue;
    standardPlansByApp.set(plan.appId, [...(standardPlansByApp.get(plan.appId) ?? []), plan]);
  }
  const shopifyBilledApps = apps.filter(
    (app) =>
      standardPlansByApp.has(app.id) &&
      partnerLifecycleReadiness([app]).coverage.applied,
  );
  const shopifyCounts =
    shopifyBilledApps.length > 0
      ? Promise.all(
          shopifyBilledApps.map(async (app) => {
            const observed = await buildObservedPlans({ appId: app.id });
            const match = matchObservedPlans(
              (standardPlansByApp.get(app.id) ?? []).map((plan) => ({
                id: plan.id,
                name: plan.name,
                amount: Number(plan.amount),
                interval: plan.interval,
                currency: plan.currencyCode,
              })),
              observed,
            );
            return match.byPlanId;
          }),
        ).then((perApp) => ({
          byPlanId: Object.assign({}, ...perApp) as Record<
            string,
            { customers: number; trials: number; mrr: number }
          >,
        }))
      : null;

  const trialCount = new Map(trialGroups.map((g) => [g.planId, g._count._all]));
  const customerCount = new Map(
    customerGroups.map((g) => [g.planId, g._count._all]),
  );

  return {
    apps: apps.map(({ id, name, logoUrl }) => ({ id, name, logoUrl })),
    appId,
    appName: scopedApp?.name ?? "",
    observedPlans,
    shopifyCounts,
    plans: plans.map((p) => ({
      id: p.id,
      appId: p.appId,
      app: p.app.name,
      appLogoUrl: p.app.logoUrl,
      name: p.name,
      description: p.description,
      amount: Number(p.amount),
      currency: p.currencyCode,
      interval: p.interval,
      cap: Number(p.usageChargeCappedAmount),
      trialDays: p.trialDays,
      active: p.active,
      isPublic: p.isPublic,
      flexBilling: p.flexBilling,
      usageBilling: p.usageBilling,
      autoUpgrade: p.onUsageLimitReached === "UPGRADE",
      upgradesTo: p.autoUpgradeTo?.name ?? null,
      limit: p.limitMax ? `${p.limitMetric} > ${p.limitMax}` : null,
      trials: trialCount.get(p.id) ?? 0,
      customers: customerCount.get(p.id) ?? 0,
    })),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const org = await requireCurrentOrganization(request);
  const form = await request.formData();
  const appId = String(form.get("appId") ?? "");
  const app = await prisma.app.findFirst({
    where: { id: appId, organizationId: org.id },
  });
  if (!app) return { error: "Choose a valid app" };

  /*
    Archiving is `active: false` and never a row delete: subscriptions,
    discounts and entitlements all reference a plan, and merchants already on it
    must keep resolving it. What changes is that it stops being offered.

    Creation now lives on its own page (`/app/plans/new`), so this action only
    ever flips availability — an unknown intent is rejected rather than falling
    through to something.
  */
  const intent = String(form.get("intent") ?? "");
  if (intent !== "archive-plan" && intent !== "restore-plan") {
    return { error: "Unknown action" };
  }

  const planId = String(form.get("planId") ?? "");
  const target = await prisma.plan.findFirst({
    where: { id: planId, appId: app.id },
    select: { id: true, name: true },
  });
  if (!target) return { error: "Plan not found" };

  const archiving = intent === "archive-plan";
  await prisma.plan.update({
    where: { id: target.id },
    data: { active: !archiving },
  });

  return {
    ok: true,
    message: `${archiving ? "Archived" : "Restored"} ${target.name}`,
  };
}

type ObservedPlanRow = Awaited<
  NonNullable<Route.ComponentProps["loaderData"]["observedPlans"]>
>[number];

function ObservedPlansSkeleton() {
  return (
    <Box padding="400">
      <SkeletonBodyText lines={8} />
    </Box>
  );
}

/**
 * Plans read back off Shopify charges, for an app whose catalogue lives in
 * Shopify rather than here.
 *
 * Read-only on purpose, and that is why it is a separate table rather than the
 * catalogue one with its action column hidden: there is no Edit, no Archive
 * and no Availability, because none of those exist on our side. Shopify does
 * not tell us whether a plan is still offered — only that merchants are paying
 * on it — so the column Mantle shows there is omitted rather than guessed at.
 *
 * Everything else deliberately mirrors the catalogue table above: the same
 * search row, the same stacked Amount cell carrying its cadence underneath,
 * the same column content types. The two tables answer different questions and
 * a reader should not have to relearn the layout moving between them.
 */
function ObservedPlans({
  rows,
  apps,
  appId,
  onSelectApp,
}: {
  rows: ObservedPlanRow[];
  apps: Array<{ id: string; name: string; logoUrl: string | null }>;
  appId: string;
  onSelectApp: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? rows.filter((row) => row.plan.toLowerCase().includes(needle))
    : rows;

  return (
    <>
      <Box paddingInline="300" paddingBlockStart="300" paddingBlockEnd="200">
        <InlineStack gap="200" blockAlign="center" wrap={false}>
          {apps.length > 1 ? (
            <AppPicker
              labelHidden
              value={appId}
              onChange={onSelectApp}
              apps={apps}
            />
          ) : null}
          <div style={{ flex: 1, minWidth: 0 }}>
            <TextField
              label="Search plans"
              labelHidden
              value={query}
              onChange={setQuery}
              autoComplete="off"
              placeholder="Search plans"
              prefix={<Icon source={SearchIcon} tone="subdued" />}
              clearButton
              onClearButtonClick={() => setQuery("")}
            />
          </div>
        </InlineStack>
      </Box>

      {visible.length === 0 ? (
        <Box padding="600">
          <Text as="p" alignment="center" tone="subdued">
            No plans match this view.
          </Text>
        </Box>
      ) : (
        /* Inset, because `.reports-traffic-table` brings its own border and
           this sits in a `padding="0"` Card — without the gutter the panel
           would sit flush against the card's own edge. */
        <Box paddingInline="300" paddingBlockEnd="300">
          <div className="reports-traffic-table">
            <DataTable
              /* Every column "text" and every cell centred in its own div — the
                 Traffic sources table's pattern. Polaris's `numeric` type
                 right-aligns, which is what pulled MRR/Trials/Customers to the
                 edges while their headings sat elsewhere. */
              columnContentTypes={["text", "text", "text", "text", "text"]}
              headings={["Name", "Amount", "MRR", "Trials", "Customers"].map(
                (heading) => (
                  <div key={heading} style={{ textAlign: "center" }}>
                    {heading}
                  </div>
                ),
              )}
              rows={visible.map((row) => {
                const key = `${row.plan}-${row.amount}-${row.interval}`;
                return [
                  <div key={`name-${key}`} style={{ textAlign: "center" }}>
                    <Link url={planDetailUrl(appId, row)} removeUnderline>
                      <Text as="span" fontWeight="medium">
                        {row.plan}
                      </Text>
                    </Link>
                  </div>,
                  <div key={`amount-${key}`} style={{ textAlign: "center" }}>
                    <BlockStack gap="050">
                      <Text as="span">
                        {formatMoney(row.amount, row.currency)}
                      </Text>
                      <Text as="span" variant="bodySm" tone="subdued">
                        {INTERVAL_LABEL[row.interval] ?? row.interval.toLowerCase()}
                      </Text>
                    </BlockStack>
                  </div>,
                  <div key={`mrr-${key}`} style={{ textAlign: "center" }}>
                    {formatMoney(row.mrr, row.currency)}
                  </div>,
                  <div key={`trials-${key}`} style={{ textAlign: "center" }}>
                    {row.trials.toLocaleString()}
                  </div>,
                  <div key={`customers-${key}`} style={{ textAlign: "center" }}>
                    {row.customers.toLocaleString()}
                  </div>,
                ];
              })}
            />
          </div>
        </Box>
      )}
    </>
  );
}

type ShopifyCounts = NonNullable<Route.ComponentProps["loaderData"]["shopifyCounts"]>;

/**
 * A plan's Trials or Customers figure: the local subscriptions, plus — for a
 * standard plan — the merchants Shopify bills on it, which arrive streamed.
 */
function PlanCount({
  local,
  planId,
  field,
  shopifyCounts,
}: {
  local: number;
  planId: string;
  field: "trials" | "customers";
  shopifyCounts: ShopifyCounts | null;
}) {
  if (!shopifyCounts) return <>{local.toLocaleString()}</>;
  return (
    <Suspense fallback={<Text as="span" tone="subdued">…</Text>}>
      <Await resolve={shopifyCounts} errorElement={<>{local.toLocaleString()}</>}>
        {(counts) => (
          <>{(local + (counts.byPlanId[planId]?.[field] ?? 0)).toLocaleString()}</>
        )}
      </Await>
    </Suspense>
  );
}

type PlanRow = Route.ComponentProps["loaderData"]["plans"][number];

const TABS = [
  { id: "all", content: "All" },
  { id: "public", content: "Public" },
  { id: "hidden", content: "Hidden" },
  { id: "archived", content: "Archived" },
] as const;

function matchesTab(plan: PlanRow, tab: string) {
  if (tab === "archived") return !plan.active;
  if (tab === "public") return plan.active && plan.isPublic;
  if (tab === "hidden") return plan.active && !plan.isPublic;
  // "All" means every plan still being offered. Archived ones stay one tab
  // away rather than padding every other view.
  return plan.active;
}

function availability(plan: PlanRow) {
  if (!plan.active) return <Badge tone="warning">Archived</Badge>;
  if (!plan.isPublic) return <Badge>Hidden</Badge>;
  return <Badge tone="success">Available</Badge>;
}

export default function Plans({ loaderData, actionData }: Route.ComponentProps) {
  const { apps, appId, appName, observedPlans, plans, shopifyCounts } = loaderData;
  const navigate = useNavigate();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  const [tab, setTab] = useState(0);
  const [query, setQuery] = useState("");
  /* The plan the archive dialog is about — named in the dialog, so what is
     about to stop being offered is read, not trusted. */
  const [archiveTarget, setArchiveTarget] = useState<PlanRow | null>(null);
  const submit = useSubmit();

  const counts = useMemo(
    () => TABS.map((t) => plans.filter((plan) => matchesTab(plan, t.id)).length),
    [plans],
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return plans.filter((plan) => {
      if (!matchesTab(plan, TABS[tab]!.id)) return false;
      if (!needle) return true;
      return (
        plan.name.toLowerCase().includes(needle) ||
        plan.app.toLowerCase().includes(needle) ||
        (plan.description ?? "").toLowerCase().includes(needle)
      );
    });
  }, [plans, tab, query]);

  /* A column repeating the same app name in every row is noise. It earns its
     place only when the list actually spans more than one app — which is no
     longer just "does this org have several apps", since the page can now be
     scoped to one. */
  const multiApp = apps.length > 1 && !appId;

  /* Changing the app rewrites the URL rather than filtering in the browser:
     the loader does the filtering, the sidebar reads the same parameter, and a
     link to this page keeps working. */
  const selectedAppName =
    apps.find((app) => app.id === appId)?.name ?? "this app";

  const selectApp = (next: string) =>
    navigate(next ? `/app/plans?appId=${encodeURIComponent(next)}` : "/app/plans");

  return (
    <Page
      fullWidth
      title="Plans"
      subtitle="The pricing tiers this organization offers"
      primaryAction={
        apps.length
          ? {
              content: "Add plan",
              url: appId
                ? `/app/plans/new?appId=${encodeURIComponent(appId)}`
                : "/app/plans/new",
            }
          : { content: "Add an app first", url: "/app/apps" }
      }
    >
      <BlockStack gap="400">
        {actionData && "error" in actionData && actionData.error ? (
          <Card>
            <Text as="p" tone="critical">
              {actionData.error}
            </Text>
          </Card>
        ) : null}
        {actionData && "ok" in actionData ? (
          <Card>
            <BlockStack gap="100">
              <Text as="p" tone="success">
                {actionData.message}
              </Text>
            </BlockStack>
          </Card>
        ) : null}

        <Card padding="0">
          {plans.length === 0 ? (
            /* Scoped to an app with no plans is a different situation from an
               organization with none: the catalogue may be perfectly healthy
               elsewhere. The secondary action matters as much as the wording —
               the app picker lives in the branch below, so without a way back
               out you would be stuck in an empty app. */
            appId && observedPlans ? (
              /* Shopify-billed: no catalogue here, but the charges know what
                 the plans are. Anything but an empty state, which for Rapi
                 Bundle would claim it has no plans while it bills fifteen. */
              <Suspense fallback={<ObservedPlansSkeleton />}>
                <Await resolve={observedPlans}>
                  {(rows) =>
                    rows.length === 0 ? (
                      <ProductEmptyState
                        title={`No plans for ${selectedAppName} yet`}
                        description="Plans belong to a single app. Add one here, or switch to another app to see its catalogue."
                        icon={CashDollarIcon}
                        action={{
                          content: "Add plan",
                          url: `/app/plans/new?appId=${encodeURIComponent(appId)}`,
                        }}
                        secondaryAction={{
                          content: "View all apps",
                          url: "/app/plans",
                        }}
                      />
                    ) : (
                      <ObservedPlans
                        rows={rows}
                        apps={apps}
                        appId={appId}
                        onSelectApp={selectApp}
                      />
                    )
                  }
                </Await>
              </Suspense>
            ) : appId ? (
              <ProductEmptyState
                title={`No plans for ${selectedAppName} yet`}
                description="Plans belong to a single app. Add one here, or switch to another app to see its catalogue."
                icon={CashDollarIcon}
                action={{
                  content: "Add plan",
                  url: `/app/plans/new?appId=${encodeURIComponent(appId)}`,
                }}
                secondaryAction={{ content: "View all apps", url: "/app/plans" }}
              />
            ) : (
              <ProductEmptyState
                title="Define your first billing plan"
                description="Create a pricing tier to manage billing, trials and automatic upgrades from one place."
                icon={CashDollarIcon}
                action={
                  apps.length
                    ? { content: "Add plan", url: "/app/plans/new" }
                    : { content: "Add an app first", url: "/app/apps" }
                }
              />
            )
          ) : (
            <>
              <Tabs
                tabs={TABS.map((t, i) => ({
                  id: t.id,
                  content: `${t.content}${counts[i] ? ` (${counts[i]})` : ""}`,
                }))}
                selected={tab}
                onSelect={setTab}
              />
              <Box paddingInline="300" paddingBlockEnd="200">
                <InlineStack gap="200" blockAlign="center" wrap={false}>
                  {apps.length > 1 ? (
                    <AppPicker
                      labelHidden
                      value={appId}
                      onChange={selectApp}
                      apps={apps}
                    />
                  ) : null}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <TextField
                      label="Search plans"
                      labelHidden
                      value={query}
                      onChange={setQuery}
                      autoComplete="off"
                      placeholder="Search plans"
                      prefix={<Icon source={SearchIcon} tone="subdued" />}
                      clearButton
                      onClearButtonClick={() => setQuery("")}
                    />
                  </div>
                </InlineStack>
              </Box>

              {visible.length === 0 ? (
                <Box padding="600">
                  <Text as="p" alignment="center" tone="subdued">
                    No plans match this view.
                  </Text>
                </Box>
              ) : (
                <DataTable
                  columnContentTypes={[
                    ...(multiApp ? (["text"] as const) : []),
                    "text",
                    "text",
                    "text",
                    "numeric",
                    "numeric",
                    "text",
                  ]}
                  headings={[
                    ...(multiApp ? ["App"] : []),
                    "Name",
                    "Amount",
                    "Availability",
                    "Trials",
                    "Customers",
                    "",
                  ]}
                  rows={visible.map((p) => [
                    ...(multiApp
                      ? [
                          <AppName
                            key={`app-${p.id}`}
                            appName={p.app}
                            logoUrl={p.appLogoUrl}
                          />,
                        ]
                      : []),
                    <BlockStack gap="050" key={`name-${p.id}`}>
                      <Link url={`/app/plans/${p.id}`} removeUnderline>
                        <Text as="span" fontWeight="medium">
                          {p.name}
                        </Text>
                      </Link>
                      {/* One quiet line of facts rather than a badge per
                          row: nearly every plan is Standard (Shopify-billed),
                          so only the exception, Flex, earns a badge. */}
                      <InlineStack gap="150" blockAlign="center">
                        <Text as="span" variant="bodySm" tone="subdued">
                          {[
                            p.trialDays ? `${p.trialDays}-day trial` : "No trial",
                            p.autoUpgrade
                              ? `${p.limit ?? ""} → ${p.upgradesTo ?? "?"}`
                              : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </Text>
                        {p.flexBilling ? <Badge tone="info">Flex</Badge> : null}
                      </InlineStack>
                    </BlockStack>,
                    <BlockStack gap="050" key={`amount-${p.id}`}>
                      <Text as="span">{formatMoney(p.amount, p.currency)}</Text>
                      <Text as="span" variant="bodySm" tone="subdued">
                        {INTERVAL_LABEL[p.interval] ?? p.interval.toLowerCase()}
                      </Text>
                    </BlockStack>,
                    availability(p),
                    <PlanCount
                      key={`trials-${p.id}`}
                      local={p.trials}
                      planId={p.id}
                      field="trials"
                      shopifyCounts={p.flexBilling ? null : shopifyCounts}
                    />,
                    <PlanCount
                      key={`customers-${p.id}`}
                      local={p.customers}
                      planId={p.id}
                      field="customers"
                      shopifyCounts={p.flexBilling ? null : shopifyCounts}
                    />,
                    <InlineStack gap="100" key={`action-${p.id}`} wrap={false} align="end">
                      <Tooltip content="Edit plan">
                        <Button
                          url={`/app/plans/${p.id}`}
                          variant="tertiary"
                          icon={EditIcon}
                          accessibilityLabel={`Edit ${p.name}`}
                        />
                      </Tooltip>
                      {p.active ? (
                        <Tooltip content="Archive plan">
                          <Button
                            variant="tertiary"
                            tone="critical"
                            icon={ArchiveIcon}
                            accessibilityLabel={`Archive ${p.name}`}
                            disabled={busy}
                            onClick={() => setArchiveTarget(p)}
                          />
                        </Tooltip>
                      ) : (
                        // Restoring is not destructive, so it needs no dialog.
                        <Form method="post">
                          <input type="hidden" name="appId" value={p.appId} />
                          <input type="hidden" name="planId" value={p.id} />
                          <input type="hidden" name="intent" value="restore-plan" />
                          <Tooltip content="Restore plan">
                            <Button
                              submit
                              variant="tertiary"
                              icon={UndoIcon}
                              accessibilityLabel={`Restore ${p.name}`}
                              disabled={busy}
                            />
                          </Tooltip>
                        </Form>
                      )}
                    </InlineStack>,
                  ])}
                />
              )}
            </>
          )}
        </Card>

        {/* The note under the card explains whichever table is above it. */}
        {plans.length === 0 && observedPlans ? (
          <Text as="p" variant="bodySm" tone="subdued">
            {appName} bills merchants through Shopify, so its plans are defined
            there and listed here as charges report them — read-only, and only
            plans someone is currently on, since a plan nobody has subscribed to
            produces no charges for us to see.
          </Text>
        ) : (
          <Text as="p" variant="bodySm" tone="subdued">
            Archiving a plan keeps every merchant already on it billing — it only
            stops being offered.
          </Text>
        )}
      </BlockStack>

      <ConfirmDialog
        open={archiveTarget !== null}
        onClose={() => setArchiveTarget(null)}
        title={archiveTarget ? `Archive ${archiveTarget.name}?` : "Archive plan?"}
        confirmLabel="Archive plan"
        loading={busy}
        onConfirm={() => {
          if (!archiveTarget) return;
          void submit(
            { intent: "archive-plan", appId: archiveTarget.appId, planId: archiveTarget.id },
            { method: "post" },
          );
          setArchiveTarget(null);
        }}
      >
        <BlockStack gap="200">
          <Text as="p">
            {archiveTarget
              ? `${archiveTarget.app} will stop offering ${archiveTarget.name} (${formatMoney(
                  archiveTarget.amount,
                  archiveTarget.currency,
                )} ${INTERVAL_LABEL[archiveTarget.interval] ?? ""}) to new merchants.`
              : null}
          </Text>
          <Text as="p" tone="subdued">
            Merchants already on it keep billing. You can restore it from the
            Archived tab.
          </Text>
        </BlockStack>
      </ConfirmDialog>
    </Page>
  );
}
