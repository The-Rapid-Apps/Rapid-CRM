import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  Checkbox,
  Divider,
  EmptyState,
  Icon,
  IndexTable,
  InlineGrid,
  InlineStack,
  Modal,
  Page,
  Select,
  Spinner,
  Tabs,
  Text,
  TextField,
  Toast,
  Tooltip,
} from "@shopify/polaris";
import {
  AlertTriangleIcon,
  CalendarIcon,
  CashDollarIcon,
  ChartVerticalIcon,
  ClipboardIcon,
  ClockIcon,
  CodeIcon,
  CreditCardIcon,
  DiscountIcon,
  InfoIcon,
  NoteIcon,
  PersonIcon,
  ReceiptDollarIcon,
  ViewIcon,
} from "@shopify/polaris-icons";
import { useEffect, useState } from "react";
import { Form, useFetcher, useNavigate, useNavigation, useSearchParams } from "react-router";
import { Prisma } from "../../../generated/prisma/client";
import type { Route } from "./+types/customer-detail";
import { CopyButton } from "~/components/copy-button";
import { StatStrip } from "~/components/stat-strip";
import { prisma } from "~/lib/db.server";
import { requireCurrentOrganization } from "~/lib/current-org.server";
import { requireUser } from "~/lib/auth/session.server";
import { formatDate, formatDateTime, formatMoney } from "~/lib/format";
import { EMPTY_STATE_IMAGE } from "~/lib/ui";
import { subscribe } from "~/lib/flex/subscribe.server";
import {
  appCreditCreate,
  appSubscriptionCancel,
  getAppSubscriptionStatus,
} from "~/lib/shopify/billing.server";
import { partnerShopGid } from "~/lib/shopify/partner.server";
import { useBackAction } from "~/lib/use-back-action";

const ACTIVE_EVENTS = new Set([
  "SUBSCRIPTION_CHARGE_ACTIVATED",
  "SUBSCRIPTION_CHARGE_UNFROZEN",
]);
const ATTENTION_EVENTS = new Set([
  "SUBSCRIPTION_CHARGE_FROZEN",
  "SUBSCRIPTION_CHARGE_DECLINED",
]);

type CurrentChargeRow = {
  id: string;
  type: string;
  occurredAt: Date;
  shopPlatformId: string | null;
  chargePlatformId: string;
  chargeName: string;
  amount: Prisma.Decimal;
  currencyCode: string;
  billingOn: Date | null;
  billingInterval: string | null;
  effectiveAmount: Prisma.Decimal | null;
};

/** Render one identify custom-field value for display (Mantle shows "None" for
 * empty values). Objects/arrays are JSON-encoded; everything else stringified. */
function formatCustomFieldValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "None";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Friendly display names for Shopify's internal plan keys. Unknown keys fall
 * back to the raw value, title-cased. */
/** Friendly display names keyed by the normalized plan name (lower-cased,
 * underscores -> spaces). Unknown values fall back to a title-cased form. */
const SHOPIFY_PLAN_LABELS: Record<string, string> = {
  basic: "Basic Shopify",
  professional: "Shopify",
  shopify: "Shopify",
  unlimited: "Advanced Shopify",
  advanced: "Advanced Shopify",
  plus: "Shopify Plus",
  "shopify plus": "Shopify Plus",
  enterprise: "Shopify Plus",
  starter: "Shopify Starter",
  "shopify starter": "Shopify Starter",
  "staff business": "Shopify (Staff)",
  "npo full": "Shopify for Nonprofits",
  dormant: "Dormant",
  frozen: "Frozen",
  cancelled: "Cancelled",
  trial: "Trial",
  affiliate: "Affiliate",
  "partner test": "Partner Test",
  dev: "Development",
  development: "Development",
  "developer preview": "Developer Preview",
};

/** The merchant's Shopify plan, read from the identify `shopify_plan_name`
 * custom field (falls back to a `plan` field). Null when not captured. */
function shopifyPlanFromCustomFields(
  customFields: Prisma.JsonValue | null | undefined,
): string | null {
  if (!customFields || typeof customFields !== "object" || Array.isArray(customFields)) {
    return null;
  }
  const cf = customFields as Record<string, unknown>;
  const raw = cf.shopify_plan_name ?? cf.shopifyPlanName ?? cf.plan;
  if (raw == null || String(raw).trim() === "") return null;
  const value = String(raw).trim();
  const key = value.toLowerCase().replace(/_/g, " ").trim();
  // Title-case an unknown raw value (e.g. "shopify_plus" -> "Shopify Plus").
  return SHOPIFY_PLAN_LABELS[key] ?? key.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Flatten a stored customFields JSON object into ordered label/value rows. */
function toCustomFieldRows(
  customFields: Prisma.JsonValue | null | undefined,
): { key: string; value: string }[] {
  if (!customFields || typeof customFields !== "object" || Array.isArray(customFields)) {
    return [];
  }
  return Object.entries(customFields).map(([key, value]) => ({
    key,
    value: formatCustomFieldValue(value),
  }));
}

function subscriptionStatus(type: string) {
  if (ACTIVE_EVENTS.has(type)) {
    return { label: "Active", tone: "success" as const };
  }
  if (type === "SUBSCRIPTION_CHARGE_FROZEN") {
    return { label: "Frozen", tone: "warning" as const };
  }
  if (type === "SUBSCRIPTION_CHARGE_DECLINED") {
    return { label: "Declined", tone: "critical" as const };
  }
  if (type === "SUBSCRIPTION_CHARGE_EXPIRED") {
    return { label: "Expired", tone: "attention" as const };
  }
  return { label: "Canceled", tone: "critical" as const };
}

function cadenceLabel(interval: string | null) {
  if (interval === "ANNUAL") return "Annual";
  if (interval === "EVERY_30_DAYS") return "Every 30 days";
  return "Cadence unavailable";
}

function eventLabel(type: string) {
  return type
    .replace("SUBSCRIPTION_CHARGE_", "")
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/^\w/, (letter) => letter.toUpperCase());
}

/** One entry in the merged, chronologically-sorted timeline (§3 of the plan:
 * subscription events + lifecycle events + comments, genuinely interleaved
 * rather than concatenated as two separate slices). */
type TimelineEntry = {
  id: string;
  occurredAt: string;
  kind: "subscription" | "lifecycle" | "comment";
  title: string;
  detail?: string;
};

export async function loader({ request, params }: Route.LoaderArgs) {
  const org = await requireCurrentOrganization(request);
  const shopDomain = params.customerKey;
  if (!shopDomain) throw new Response("Customer not found", { status: 404 });

  const url = new URL(request.url);
  const requestedAppId = url.searchParams.get("app");

  const orgApps = await prisma.app.findMany({
    where: { organizationId: org.id, removed: false, scheduledForDeletionAt: null },
    select: {
      id: true,
      name: true,
      handle: true,
      billingEventsSyncedAt: true,
      billingSalesSyncedAt: true,
    },
  });
  const orgAppIds = orgApps.map((a) => a.id);
  if (orgAppIds.length === 0) throw new Response("Customer not found", { status: 404 });

  // Which of this org's apps has this shop domain installed — the "app
  // pills" list. AppInstall (not PartnerCustomerState) is the source of
  // truth here since it doesn't depend on the fast-path backfill flag.
  const installsForShop = await prisma.appInstall.findMany({
    where: { appId: { in: orgAppIds }, shopDomain },
    orderBy: { installedAt: "asc" },
    select: { appId: true, installedAt: true, uninstalledAt: true },
  });
  if (installsForShop.length === 0) {
    throw new Response("Customer not found", { status: 404 });
  }
  const matchedAppIds = installsForShop.map((i) => i.appId);
  const apps = orgApps.filter((a) => matchedAppIds.includes(a.id));

  const mostRecentlyActiveAppId = [...installsForShop].sort(
    (a, b) =>
      (b.uninstalledAt ?? b.installedAt).getTime() -
      (a.uninstalledAt ?? a.installedAt).getTime(),
  )[0]?.appId;
  const selectedAppId =
    requestedAppId && matchedAppIds.includes(requestedAppId)
      ? requestedAppId
      : mostRecentlyActiveAppId ?? matchedAppIds[0];
  const app = apps.find((a) => a.id === selectedAppId);
  if (!app) throw new Response("Customer not found", { status: 404 });

  const firstSeen = new Date(
    Math.min(...installsForShop.map((i) => i.installedAt.getTime())),
  );

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  // --- Aggregate (across every matched app) — feeds the header stat tiles ---
  const [aggLifetimeGroups, aggRecentGroups, aggCurrentCharges] = await Promise.all([
    prisma.partnerSubscriptionSaleFact.groupBy({
      by: ["currencyCode"],
      where: { appId: { in: matchedAppIds }, shopDomain, grossAmount: { not: null } },
      _sum: { grossAmount: true },
      _count: { _all: true },
    }),
    prisma.partnerSubscriptionSaleFact.groupBy({
      by: ["currencyCode"],
      where: {
        appId: { in: matchedAppIds },
        shopDomain,
        occurredAt: { gte: thirtyDaysAgo },
        grossAmount: { not: null },
      },
      _sum: { grossAmount: true },
      _count: { _all: true },
    }),
    prisma.$queryRaw<CurrentChargeRow[]>(Prisma.sql`
      WITH ranked AS (
        SELECT e.*,
          ROW_NUMBER() OVER (
            PARTITION BY e.appId, e.shopDomain, e.chargePlatformId
            ORDER BY e.occurredAt DESC, e.id DESC
          ) AS rowNumber
        FROM partner_subscription_events e
        WHERE e.appId IN (${Prisma.join(matchedAppIds)})
          AND e.shopDomain = ${shopDomain}
          AND e.test = 0
      )
      SELECT
        ranked.id, ranked.type, ranked.occurredAt, ranked.shopPlatformId,
        ranked.chargePlatformId, ranked.chargeName, ranked.amount,
        ranked.currencyCode, ranked.billingOn,
        (
          SELECT sale.billingInterval FROM partner_subscription_sale_facts sale
          WHERE sale.appId = ranked.appId AND sale.chargePlatformId = ranked.chargePlatformId
          ORDER BY sale.occurredAt DESC, sale.id DESC LIMIT 1
        ) AS billingInterval,
        (
          SELECT sale.grossAmount FROM partner_subscription_sale_facts sale
          WHERE sale.appId = ranked.appId AND sale.chargePlatformId = ranked.chargePlatformId
          ORDER BY sale.occurredAt DESC, sale.id DESC LIMIT 1
        ) AS effectiveAmount
      FROM ranked WHERE ranked.rowNumber = 1 ORDER BY ranked.occurredAt DESC
    `),
  ]);

  const aggActiveCharges = aggCurrentCharges.filter((charge) =>
    ACTIVE_EVENTS.has(charge.type),
  );
  const aggMrrByCurrency = new Map<string, number>();
  for (const charge of aggActiveCharges) {
    const amount = Number(charge.effectiveAmount ?? charge.amount);
    const mrr = charge.billingInterval === "ANNUAL" ? amount / 12 : amount;
    aggMrrByCurrency.set(
      charge.currencyCode,
      (aggMrrByCurrency.get(charge.currencyCode) ?? 0) + mrr,
    );
  }
  const primaryCurrency =
    [...aggMrrByCurrency.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ??
    aggLifetimeGroups[0]?.currencyCode ??
    "USD";
  const mrr = aggMrrByCurrency.get(primaryCurrency) ?? 0;
  const aggLifetimeGroup = aggLifetimeGroups.find((g) => g.currencyCode === primaryCurrency);
  const aggRecentGroup = aggRecentGroups.find((g) => g.currencyCode === primaryCurrency);
  const lifetimeValue = Number(aggLifetimeGroup?._sum.grossAmount ?? 0);
  const saleCount = aggLifetimeGroup?._count._all ?? 0;
  const averageSpend = saleCount > 0 ? lifetimeValue / saleCount : 0;
  const recentRevenue = Number(aggRecentGroup?._sum.grossAmount ?? 0);
  const multipleCurrencies =
    new Set(
      aggLifetimeGroups.map((g) => g.currencyCode).filter((v): v is string => Boolean(v)),
    ).size > 1;

  // --- Selected-app-scoped queries — the per-app panel, unchanged shape
  // from before this page supported multiple apps, just re-parameterized. ---
  const currentCharges = await prisma.$queryRaw<CurrentChargeRow[]>(Prisma.sql`
    WITH ranked AS (
      SELECT e.*,
        ROW_NUMBER() OVER (
          PARTITION BY e.appId, e.shopDomain, e.chargePlatformId
          ORDER BY e.occurredAt DESC, e.id DESC
        ) AS rowNumber
      FROM partner_subscription_events e
      WHERE e.appId = ${app.id}
        AND e.shopDomain = ${shopDomain}
        AND e.test = 0
    )
    SELECT
      ranked.id, ranked.type, ranked.occurredAt, ranked.shopPlatformId,
      ranked.chargePlatformId, ranked.chargeName, ranked.amount,
      ranked.currencyCode, ranked.billingOn,
      (
        SELECT sale.billingInterval FROM partner_subscription_sale_facts sale
        WHERE sale.appId = ranked.appId AND sale.chargePlatformId = ranked.chargePlatformId
        ORDER BY sale.occurredAt DESC, sale.id DESC LIMIT 1
      ) AS billingInterval,
      (
        SELECT sale.grossAmount FROM partner_subscription_sale_facts sale
        WHERE sale.appId = ranked.appId AND sale.chargePlatformId = ranked.chargePlatformId
        ORDER BY sale.occurredAt DESC, sale.id DESC LIMIT 1
      ) AS effectiveAmount
    FROM ranked WHERE ranked.rowNumber = 1 ORDER BY ranked.occurredAt DESC
  `);

  const [
    install,
    recentEvents,
    transactions,
    redemptions,
    apiLogs,
    identifiedCustomer,
    comments,
    subscriptions,
    eligiblePlans,
  ] = await Promise.all([
    prisma.appInstall.findUnique({
      where: { appId_shopDomain: { appId: app.id, shopDomain } },
      select: {
        id: true,
        shopPlatformId: true,
        accessToken: true,
        scope: true,
        installedAt: true,
        uninstalledAt: true,
        lifecycleEvents: {
          orderBy: { occurredAt: "desc" },
          take: 20,
          select: {
            id: true,
            type: true,
            occurredAt: true,
            uninstallDetail: { select: { reason: true, reasonCode: true } },
          },
        },
      },
    }),
    prisma.partnerSubscriptionEvent.findMany({
      where: { appId: app.id, shopDomain, test: false },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: 30,
      select: {
        id: true,
        type: true,
        occurredAt: true,
        chargeName: true,
        amount: true,
        currencyCode: true,
      },
    }),
    prisma.partnerSubscriptionSaleFact.findMany({
      where: { appId: app.id, shopDomain },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: 30,
      select: {
        id: true,
        transactionPlatformId: true,
        chargePlatformId: true,
        occurredAt: true,
        billingInterval: true,
        grossAmount: true,
        currencyCode: true,
      },
    }),
    prisma.discountRedemption.findMany({
      where: { appId: app.id, shopDomain },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        status: true,
        externalPlanKey: true,
        listPrice: true,
        priceAfterDiscount: true,
        currencyCode: true,
        discountType: true,
        discountValue: true,
        reservedAt: true,
        appliedAt: true,
        discount: { select: { code: true, description: true } },
      },
    }),
    prisma.apiRequestLog.findMany({
      where: { organizationId: org.id, appId: app.id, customer: shopDomain },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        method: true,
        path: true,
        status: true,
        durationMs: true,
        createdAt: true,
      },
    }),
    // Custom fields captured via POST /v1/identify. Linked to this customer by
    // myshopify domain (the identify app id is a separate id space from the
    // platform App, so the shop domain is the reliable join key). Newest wins
    // if the same shop was identified more than once.
    prisma.identifiedCustomer.findFirst({
      where: { platform: "shopify", myshopifyDomain: shopDomain },
      orderBy: { updatedAt: "desc" },
      select: { customFields: true, updatedAt: true },
    }),
    prisma.customerComment.findMany({
      where: { organizationId: org.id, shopDomain },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        body: true,
        createdAt: true,
        author: { select: { name: true, email: true } },
      },
    }),
    // The live/mutable billing record (Flex Billing's own model) — distinct
    // from currentCharges above, which is the read-only Partner-sync mirror.
    // This is what the billing-actions card reads/writes: it carries the
    // real Shopify AppSubscription gid the mutations need.
    prisma.subscription.findMany({
      where: { appInstall: { appId: app.id, shopDomain } },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        status: true,
        shopifySubscriptionId: true,
        canceledAt: true,
        plan: { select: { name: true } },
      },
    }),
    // Eligible targets for "Request plan change" — mirrors subscribe()'s own
    // gate exactly so the picker never offers a plan it would reject.
    prisma.plan.findMany({
      where: { appId: app.id, flexBilling: true, active: true, isPublic: true },
      orderBy: { sortOrder: "asc" },
      select: {
        id: true,
        name: true,
        amount: true,
        currencyCode: true,
        interval: true,
      },
    }),
  ]);

  const hasAttention = currentCharges.some((charge) => ATTENTION_EVENTS.has(charge.type));
  const churnRisk = install?.uninstalledAt
    ? { label: "High", tone: "critical" as const, reason: "App uninstalled" }
    : hasAttention
      ? { label: "Attention", tone: "warning" as const, reason: "Frozen or declined charge" }
      : currentCharges.some((c) => ACTIVE_EVENTS.has(c.type))
        ? { label: "Low", tone: "success" as const, reason: "Active Shopify charge" }
        : { label: "Unclassified", tone: undefined, reason: "No active charge" };

  const timeline: TimelineEntry[] = [
    ...recentEvents.map((event) => ({
      id: `subscription:${event.id}`,
      occurredAt: event.occurredAt.toISOString(),
      kind: "subscription" as const,
      title: `${eventLabel(event.type)} · ${event.chargeName}`,
      detail: formatMoney(Number(event.amount), event.currencyCode),
    })),
    ...(install?.lifecycleEvents ?? []).map((event) => ({
      id: `lifecycle:${event.id}`,
      occurredAt: event.occurredAt.toISOString(),
      kind: "lifecycle" as const,
      title: `App ${event.type.toLowerCase()}`,
    })),
    ...comments.map((comment) => ({
      id: `comment:${comment.id}`,
      occurredAt: comment.createdAt.toISOString(),
      kind: "comment" as const,
      title: comment.body,
      detail: comment.author.name ?? comment.author.email,
    })),
  ].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));

  return {
    app: {
      ...app,
      billingEventsSyncedAt: app.billingEventsSyncedAt?.toISOString() ?? null,
      billingSalesSyncedAt: app.billingSalesSyncedAt?.toISOString() ?? null,
    },
    apps: apps.map((a) => ({ id: a.id, name: a.name, selected: a.id === app.id })),
    customer: {
      shopDomain,
      displayName: shopDomain.replace(".myshopify.com", ""),
      shopPlatformId:
        install?.shopPlatformId ?? currentCharges[0]?.shopPlatformId ?? null,
      firstSeen: firstSeen.toISOString(),
      installedAt: install?.installedAt.toISOString() ?? null,
      uninstalledAt: install?.uninstalledAt?.toISOString() ?? null,
      oauthConnected: Boolean(install?.accessToken && !install.uninstalledAt),
      scopes: install?.scope ?? null,
    },
    metrics: {
      currencyCode: primaryCurrency,
      mrr,
      arr: mrr * 12,
      lifetimeValue,
      averageSpend,
      recentRevenue,
      saleCount,
      activeSubscriptions: aggActiveCharges.length,
      churnRisk,
      multipleCurrencies,
    },
    currentCharges: currentCharges.map((charge) => ({
      ...charge,
      amount: Number(charge.amount),
      effectiveAmount:
        charge.effectiveAmount === null ? null : Number(charge.effectiveAmount),
      occurredAt: charge.occurredAt.toISOString(),
      billingOn: charge.billingOn?.toISOString() ?? null,
    })),
    transactions: transactions.map((transaction) => ({
      ...transaction,
      grossAmount: transaction.grossAmount === null ? null : Number(transaction.grossAmount),
      occurredAt: transaction.occurredAt.toISOString(),
    })),
    redemptions: redemptions.map((redemption) => ({
      ...redemption,
      listPrice: Number(redemption.listPrice),
      priceAfterDiscount: Number(redemption.priceAfterDiscount),
      discountValue: Number(redemption.discountValue),
      reservedAt: redemption.reservedAt.toISOString(),
      appliedAt: redemption.appliedAt?.toISOString() ?? null,
    })),
    apiLogs: apiLogs.map((log) => ({
      ...log,
      durationMs: Number(log.durationMs),
      createdAt: log.createdAt.toISOString(),
    })),
    appCustomFields: {
      rows: toCustomFieldRows(identifiedCustomer?.customFields),
      updatedAt: identifiedCustomer?.updatedAt.toISOString() ?? null,
    },
    // The merchant's Shopify plan, captured via the identify custom fields.
    shopifyPlan: shopifyPlanFromCustomFields(identifiedCustomer?.customFields),
    // Store Leads-style shop enrichment data — no real source exists yet
    // (see plan §2); the section renders with this empty array until one is
    // wired up, rather than being hidden like App custom fields.
    customerCustomFields: { rows: [] as { key: string; value: string }[] },
    timeline,
    subscriptions: subscriptions.map((sub) => ({
      id: sub.id,
      status: sub.status,
      shopifySubscriptionId: sub.shopifySubscriptionId,
      canceledAt: sub.canceledAt?.toISOString() ?? null,
      planName: sub.plan.name,
    })),
    eligiblePlans: eligiblePlans.map((plan) => ({
      id: plan.id,
      name: plan.name,
      amount: Number(plan.amount),
      currencyCode: plan.currencyCode,
      interval: plan.interval,
    })),
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const org = await requireCurrentOrganization(request);
  const user = await requireUser(request);
  const shopDomain = params.customerKey;
  if (!shopDomain) throw new Response("Customer not found", { status: 404 });

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "add-comment");

  if (intent === "add-comment") {
    const body = String(formData.get("body") ?? "").trim();
    if (!body) return { error: "Comment can't be empty" };

    await prisma.customerComment.create({
      data: { organizationId: org.id, shopDomain, authorUserId: user.id, body },
    });
    return { ok: true as const };
  }

  if (intent === "request-plan-change") {
    const planId = String(formData.get("planId") ?? "");
    if (!planId) return { error: "Choose a plan." };

    // This intent has no subscriptionId (a customer may have none yet), so
    // it resolves its own app + install scoping independently of the shared
    // subscriptionId-based prologue below.
    const requestedAppId = String(formData.get("appId") ?? "");
    const planChangeApp = await prisma.app.findFirst({
      where: {
        id: requestedAppId,
        organizationId: org.id,
        removed: false,
        scheduledForDeletionAt: null,
      },
      select: { id: true },
    });
    if (!planChangeApp) return { error: "App not found." };

    const targetInstall = await prisma.appInstall.findFirst({
      where: { appId: planChangeApp.id, shopDomain, uninstalledAt: null },
      select: { id: true },
    });
    if (!targetInstall) {
      return { error: "No active install found for this customer on this app." };
    }

    const plan = await prisma.plan.findFirst({
      where: {
        id: planId,
        appId: planChangeApp.id,
        flexBilling: true,
        active: true,
        isPublic: true,
      },
      select: { id: true },
    });
    if (!plan) return { error: "That plan is not available for this app." };

    const currentActive = await prisma.subscription.findFirst({
      where: { appInstallId: targetInstall.id, status: "ACTIVE", canceledAt: null },
      select: { id: true },
    });

    try {
      const result = await subscribe({
        appInstallId: targetInstall.id,
        planId,
        replacesSubscriptionId: currentActive?.id,
      });
      const created = await prisma.subscription.findUnique({
        where: { id: result.subscriptionId },
        select: { approvalExpiresAt: true },
      });
      return {
        ok: true as const,
        confirmationUrl: result.confirmationUrl,
        approvalExpiresAt: created?.approvalExpiresAt?.toISOString() ?? null,
      };
    } catch (error) {
      return {
        error:
          error instanceof Error
            ? error.message
            : "Could not create the plan-change subscription.",
      };
    }
  }

  // Everything below touches real Shopify billing state — always re-load and
  // re-scope from the database by org + shop, never trust an id's ownership
  // from the client.
  const subscriptionId = String(formData.get("subscriptionId") ?? "");
  const subscription = await prisma.subscription.findFirst({
    where: {
      id: subscriptionId,
      appInstall: { shopDomain, app: { organizationId: org.id } },
    },
    select: {
      id: true,
      shopifySubscriptionId: true,
      appInstall: {
        select: {
          accessToken: true,
          scope: true,
          shopDomain: true,
          shopPlatformId: true,
          appId: true,
        },
      },
    },
  });
  if (!subscription) return { error: "Subscription not found." };
  const install = subscription.appInstall;

  const app = await prisma.app.findFirst({
    where: { id: install.appId, organizationId: org.id },
    select: {
      id: true,
      shopifyApiKey: true,
      shopifyApiSecret: true,
      shopifyAppId: true,
      partnerApiToken: true,
      partnerOrganizationId: true,
      disableDowngradeCredits: true,
      partnerConnection: {
        select: { partnerOrganizationId: true, encryptedAccessToken: true },
      },
    },
  });
  if (!app) return { error: "App not found." };

  try {
    if (intent === "check-subscription-status") {
      if (!install.accessToken) {
        return { ok: true as const, freshStatus: null, notConnected: true };
      }
      if (!subscription.shopifySubscriptionId) {
        return { ok: true as const, freshStatus: null };
      }
      const freshStatus = await getAppSubscriptionStatus(
        app,
        install,
        subscription.shopifySubscriptionId,
      );
      return { ok: true as const, freshStatus };
    }

    if (intent === "cancel-subscription") {
      if (!install.accessToken) {
        return {
          error: "This app hasn't connected Shopify billing write access yet.",
        };
      }
      if (!subscription.shopifySubscriptionId) {
        return { error: "No Shopify subscription id on record." };
      }
      await appSubscriptionCancel(app, install, {
        shopifySubscriptionId: subscription.shopifySubscriptionId,
      });
      await prisma.subscription.update({
        where: { id: subscription.id },
        data: { status: "CANCELLED", canceledAt: new Date() },
      });
      return { ok: true as const, message: "Subscription cancelled." };
    }

    if (intent === "issue-credit") {
      if (app.disableDowngradeCredits) {
        return {
          error:
            "Manual app credits are disabled for this app (Apps → settings).",
        };
      }
      if (!install.shopPlatformId) {
        return { error: "No Shopify shop id on record for this customer." };
      }
      const amount = Number(String(formData.get("amount") ?? "").trim());
      if (!Number.isFinite(amount) || amount <= 0) {
        return { error: "Enter a valid credit amount." };
      }
      const currencyCode = String(formData.get("currencyCode") ?? "USD")
        .trim()
        .toUpperCase();
      const description = String(formData.get("description") ?? "").trim();
      if (!description) {
        return { error: "A description is required for an app credit." };
      }

      const credit = await appCreditCreate(app, {
        amount,
        currencyCode,
        shopId: partnerShopGid(install.shopPlatformId),
        description,
        test: false,
      });

      await prisma.charge.create({
        data: {
          subscriptionId: subscription.id,
          amount,
          chargedAmount: amount,
          chargedCurrencyCode: currencyCode,
          platformId: credit.id,
          isCredit: true,
          flexBilling: false,
          status: "ACTIVE",
          description,
        },
      });
      return { ok: true as const, message: "App credit issued." };
    }

    return { error: "Unknown action." };
  } catch (error) {
    return {
      error:
        error instanceof Error ? error.message : "Shopify billing action failed.",
    };
  }
}

type BillingActionResult =
  | { ok?: undefined; error: string }
  | { ok: true; message?: string }
  | {
      ok: true;
      freshStatus: { status: string; currentPeriodEnd: string | null } | null;
      notConnected?: boolean;
    }
  | { ok: true; confirmationUrl: string; approvalExpiresAt: string | null };

/**
 * The four originally-planned buttons are two here: Refund charge has no
 * Shopify mutation to call (refunds are an order-level concept, not app
 * billing) so it's folded into Issue app credit; Request plan change needs
 * its own approval-link design and ships as a separate follow-up.
 */
function BillingActionsCard({
  subscription,
  currency,
  oauthConnected,
  appId,
  eligiblePlans,
}: {
  subscription: {
    id: string;
    status: string;
    shopifySubscriptionId: string | null;
    canceledAt: string | null;
    planName: string;
  } | null;
  currency: string;
  oauthConnected: boolean;
  appId: string;
  eligiblePlans: Array<{
    id: string;
    name: string;
    amount: number;
    currencyCode: string;
    interval: string;
  }>;
}) {
  const cancelFetcher = useFetcher<BillingActionResult>();
  const creditFetcher = useFetcher<BillingActionResult>();
  const checkFetcher = useFetcher<BillingActionResult>();
  const planChangeFetcher = useFetcher<BillingActionResult>();

  const [cancelModalOpen, setCancelModalOpen] = useState(false);
  const [creditModalOpen, setCreditModalOpen] = useState(false);
  const [planChangeModalOpen, setPlanChangeModalOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [selectedPlanId, setSelectedPlanId] = useState("");
  const [planChangeResult, setPlanChangeResult] = useState<{
    confirmationUrl: string;
    approvalExpiresAt: string | null;
  } | null>(null);
  const [showPlanChangeLink, setShowPlanChangeLink] = useState(false);

  const alreadyCancelled = subscription?.status === "CANCELLED";
  const canCancel =
    Boolean(subscription?.shopifySubscriptionId) &&
    oauthConnected &&
    !alreadyCancelled;
  const canCredit = Boolean(subscription);
  const canRequestPlanChange = eligiblePlans.length > 0;

  const [toastMessage, setToastMessage] = useState<string | null>(null);

  useEffect(() => {
    if (cancelFetcher.data?.ok) {
      setCancelModalOpen(false);
      setToastMessage(
        ("message" in cancelFetcher.data && cancelFetcher.data.message) ||
          "Subscription cancelled.",
      );
    }
  }, [cancelFetcher.data]);
  useEffect(() => {
    if (creditFetcher.data?.ok) {
      setCreditModalOpen(false);
      setToastMessage(
        ("message" in creditFetcher.data && creditFetcher.data.message) ||
          "App credit issued.",
      );
    }
  }, [creditFetcher.data]);
  useEffect(() => {
    if (planChangeFetcher.data?.ok && "confirmationUrl" in planChangeFetcher.data) {
      setPlanChangeResult({
        confirmationUrl: planChangeFetcher.data.confirmationUrl,
        approvalExpiresAt: planChangeFetcher.data.approvalExpiresAt,
      });
    }
  }, [planChangeFetcher.data]);

  const openPlanChangeModal = () => {
    setSelectedPlanId("");
    setPlanChangeResult(null);
    setShowPlanChangeLink(false);
    setPlanChangeModalOpen(true);
  };

  const closePlanChangeModal = () => {
    setPlanChangeModalOpen(false);
    setSelectedPlanId("");
    setPlanChangeResult(null);
    setShowPlanChangeLink(false);
  };

  const openCancelModal = () => {
    setCancelModalOpen(true);
    if (subscription) {
      const formData = new FormData();
      formData.set("intent", "check-subscription-status");
      formData.set("subscriptionId", subscription.id);
      checkFetcher.submit(formData, { method: "post" });
    }
  };

  const openCreditModal = () => {
    setAmount("");
    setDescription("");
    setCreditModalOpen(true);
  };

  const submitCancel = () => {
    if (!subscription) return;
    const formData = new FormData();
    formData.set("intent", "cancel-subscription");
    formData.set("subscriptionId", subscription.id);
    cancelFetcher.submit(formData, { method: "post" });
  };

  const submitCredit = () => {
    if (!subscription) return;
    const formData = new FormData();
    formData.set("intent", "issue-credit");
    formData.set("subscriptionId", subscription.id);
    formData.set("amount", amount);
    formData.set("currencyCode", currency);
    formData.set("description", description);
    creditFetcher.submit(formData, { method: "post" });
  };

  const submitPlanChange = () => {
    if (!selectedPlanId) return;
    const formData = new FormData();
    formData.set("intent", "request-plan-change");
    formData.set("appId", appId);
    formData.set("planId", selectedPlanId);
    planChangeFetcher.submit(formData, { method: "post" });
  };

  const cancelBusy = cancelFetcher.state !== "idle";
  const creditBusy = creditFetcher.state !== "idle";
  const checking = checkFetcher.state !== "idle";
  const planChangeBusy = planChangeFetcher.state !== "idle";

  return (
    <BlockStack gap="300">
      <Text as="h3" variant="headingSm">
        Shopify billing actions
      </Text>
      <Text as="p" variant="bodySm" tone="subdued">
        Each operation requires your explicit approval, a fresh Shopify state
        check, and a confirmation screen.
      </Text>

      <InlineStack gap="200" blockAlign="center" wrap>
        <Button disabled={!canRequestPlanChange} onClick={openPlanChangeModal}>
          Request plan change
        </Button>
        <Button disabled={!canCredit} onClick={openCreditModal}>
          Issue app credit
        </Button>
        <Button
          disabled={!canCancel}
          tone="critical"
          onClick={openCancelModal}
        >
          Cancel subscription
        </Button>
      </InlineStack>
      {!canRequestPlanChange ? (
        <Text as="p" tone="subdued" variant="bodySm">
          No eligible plans configured for this app.
        </Text>
      ) : null}
      {!canCredit ? (
        <Text as="p" tone="subdued" variant="bodySm">
          This customer has no Shopify subscription on record, so there's
          nothing to issue a credit against.
        </Text>
      ) : null}
      {!canCancel ? (
        <Text as="p" tone="subdued" variant="bodySm">
          {!subscription
            ? "This customer has no Shopify subscription on record."
            : alreadyCancelled
              ? "This subscription is already cancelled."
              : "Cancellation needs this app's Shopify billing write access, which isn't connected for this customer yet."}
        </Text>
      ) : null}

      {subscription ? (
        <Modal
          open={cancelModalOpen}
          onClose={() => setCancelModalOpen(false)}
          title="Cancel subscription"
          primaryAction={{
            content: "Cancel subscription",
            destructive: true,
            loading: cancelBusy,
            disabled: checking,
            onAction: submitCancel,
          }}
          secondaryActions={[
            { content: "Close", onAction: () => setCancelModalOpen(false) },
          ]}
        >
          <Modal.Section>
            <BlockStack gap="300">
              {cancelFetcher.data && "error" in cancelFetcher.data ? (
                <Banner tone="critical">{cancelFetcher.data.error}</Banner>
              ) : null}
              <Text as="p">
                Plan: <Text as="span" fontWeight="semibold">{subscription.planName}</Text>
              </Text>
              {checking ? (
                <InlineStack gap="200" blockAlign="center">
                  <Spinner size="small" accessibilityLabel="Checking Shopify" />
                  <Text as="span" tone="subdued">
                    Checking the live Shopify status…
                  </Text>
                </InlineStack>
              ) : checkFetcher.data && "freshStatus" in checkFetcher.data ? (
                checkFetcher.data.freshStatus ? (
                  <Text as="p" tone="subdued">
                    {`Shopify currently reports this subscription as ${checkFetcher.data.freshStatus.status}.`}
                  </Text>
                ) : checkFetcher.data.notConnected ? (
                  <Banner tone="warning">
                    Couldn't verify the live status — this app has no stored
                    Shopify access token.
                  </Banner>
                ) : null
              ) : null}
              <Banner tone="warning">
                This cancels the subscription on Shopify for real. It cannot
                be undone from here.
              </Banner>
            </BlockStack>
          </Modal.Section>
        </Modal>
      ) : null}

      {subscription ? (
        <Modal
          open={creditModalOpen}
          onClose={() => setCreditModalOpen(false)}
          title="Issue app credit"
          primaryAction={{
            content: "Issue credit",
            loading: creditBusy,
            disabled: !amount.trim() || !description.trim(),
            onAction: submitCredit,
          }}
          secondaryActions={[
            { content: "Close", onAction: () => setCreditModalOpen(false) },
          ]}
        >
          <Modal.Section>
            <BlockStack gap="300">
              {creditFetcher.data && "error" in creditFetcher.data ? (
                <Banner tone="critical">{creditFetcher.data.error}</Banner>
              ) : null}
              <TextField
                label="Amount"
                type="number"
                autoComplete="off"
                value={amount}
                onChange={setAmount}
                prefix={currency}
              />
              <TextField
                label="Description"
                autoComplete="off"
                value={description}
                onChange={setDescription}
                helpText="Shown to the merchant as the reason for this credit."
                multiline={2}
              />
              <Banner tone="warning">
                App credits cannot be reversed once issued.
              </Banner>
            </BlockStack>
          </Modal.Section>
        </Modal>
      ) : null}

      <Modal
        open={planChangeModalOpen}
        onClose={closePlanChangeModal}
        title="Request plan change"
        primaryAction={
          planChangeResult
            ? { content: "Done", onAction: closePlanChangeModal }
            : {
                content: "Create plan-change link",
                loading: planChangeBusy,
                disabled: !selectedPlanId,
                onAction: submitPlanChange,
              }
        }
        secondaryActions={
          planChangeResult
            ? []
            : [{ content: "Close", onAction: closePlanChangeModal }]
        }
      >
        <Modal.Section>
          <BlockStack gap="300">
            {planChangeResult ? (
              <>
                <Text as="p">
                  Send this link to the merchant. They must open it and
                  approve the new plan for the change to take effect —
                  nothing happens until they do.
                </Text>
                <InlineStack gap="200" blockAlign="center" wrap>
                  <CopyButton
                    value={planChangeResult.confirmationUrl}
                    toastMessage="Confirmation link copied"
                  >
                    Copy link
                  </CopyButton>
                  <Button
                    variant="plain"
                    onClick={() => setShowPlanChangeLink((v) => !v)}
                  >
                    {showPlanChangeLink ? "Hide link" : "Show link"}
                  </Button>
                </InlineStack>
                {showPlanChangeLink ? (
                  <Text as="p" tone="subdued" breakWord>
                    {planChangeResult.confirmationUrl}
                  </Text>
                ) : null}
                {planChangeResult.approvalExpiresAt ? (
                  <Text as="p" tone="subdued" variant="bodySm">
                    {`This link expires ${formatDateTime(planChangeResult.approvalExpiresAt)} if the merchant hasn't approved it by then.`}
                  </Text>
                ) : null}
              </>
            ) : (
              <>
                {planChangeFetcher.data && "error" in planChangeFetcher.data ? (
                  <Banner tone="critical">{planChangeFetcher.data.error}</Banner>
                ) : null}
                <Select
                  label="Plan"
                  options={eligiblePlans.map((plan) => ({
                    label: `${plan.name} — ${formatMoney(plan.amount, plan.currencyCode)}`,
                    value: plan.id,
                  }))}
                  placeholder="Choose a plan"
                  value={selectedPlanId}
                  onChange={setSelectedPlanId}
                />
                <Banner tone="warning">
                  This creates a real, pending Shopify subscription charge.
                  The merchant must open the confirmation link and approve it
                  before anything is billed — nothing changes until they do.
                </Banner>
              </>
            )}
          </BlockStack>
        </Modal.Section>
      </Modal>

      {toastMessage ? (
        <Toast content={toastMessage} onDismiss={() => setToastMessage(null)} />
      ) : null}
    </BlockStack>
  );
}

function OverviewTab({
  loaderData,
}: {
  loaderData: Route.ComponentProps["loaderData"];
}) {
  const {
    app,
    customer,
    metrics,
    currentCharges,
    transactions,
    redemptions,
    apiLogs,
    appCustomFields,
    customerCustomFields,
    subscriptions,
    eligiblePlans,
  } = loaderData;
  const navigate = useNavigate();
  const currency = metrics.currencyCode;
  const activeCharge = currentCharges.find((charge) => ACTIVE_EVENTS.has(charge.type));
  const targetSubscription =
    subscriptions.find((s) => s.status === "ACTIVE") ?? subscriptions[0] ?? null;

  return (
    <BlockStack gap="500">
      {metrics.multipleCurrencies ? (
        <Banner title="Multiple currencies detected" tone="warning">
          <Text as="p">
            Summary cards show {currency}. Other currencies remain visible in
            transaction history and are not converted or combined.
          </Text>
        </Banner>
      ) : null}

      <div className="customer-profile-layout">
        <BlockStack gap="400">
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Install details
              </Text>
              <div className="customer-definition-list">
                <span>Platform ID</span>
                <strong>{customer.shopPlatformId ?? "Unavailable"}</strong>
                <span>First seen</span>
                <strong>{formatDate(customer.firstSeen)}</strong>
                <span>Install state</span>
                <strong>{customer.uninstalledAt ? "Uninstalled" : "Installed"}</strong>
              </div>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  Connection
                </Text>
                <Badge tone={customer.oauthConnected ? "success" : "info"}>
                  {customer.oauthConnected ? "Merchant OAuth ready" : "Partner data only"}
                </Badge>
              </InlineStack>
              <Text as="p" tone="subdued">
                {customer.oauthConnected
                  ? "An offline merchant token exists locally. It is never exposed on this page."
                  : "Analytics are available from Partner synchronization. Merchant Admin API actions require OAuth and separate approval."}
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Subscription events synced: {formatDateTime(app.billingEventsSyncedAt)}
                <br />
                Sales synced: {formatDateTime(app.billingSalesSyncedAt)}
              </Text>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingMd">
                App review
              </Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                No review yet
              </Text>
              <CopyButton
                value={`https://apps.shopify.com/${app.handle}#modal-show=ReviewListingModal`}
              >
                Copy review link
              </CopyButton>
            </BlockStack>
          </Card>
        </BlockStack>

        <BlockStack gap="400">
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <InlineStack gap="300" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    {app.name}
                  </Text>
                  <Badge tone={metrics.churnRisk.tone}>
                    {`${metrics.churnRisk.label} churn risk`}
                  </Badge>
                </InlineStack>
                <InlineStack gap="200">
                  <Button
                    icon={NoteIcon}
                    onClick={() =>
                      navigate(
                        `/app/events?q=${encodeURIComponent(customer.shopDomain)}&appId=${app.id}`,
                      )
                    }
                  >
                    Activity
                  </Button>
                  <Button
                    icon={CodeIcon}
                    onClick={() =>
                      navigate(
                        `/app/api-logs?q=${encodeURIComponent(customer.shopDomain)}&appId=${app.id}`,
                      )
                    }
                  >
                    API logs
                  </Button>
                  <Button icon={DiscountIcon} onClick={() => navigate(`/app/discounts?appId=${app.id}`)}>
                    Discounts
                  </Button>
                </InlineStack>
              </InlineStack>

              <Divider />

              <InlineGrid columns={{ xs: 1, md: 3 }} gap="400">
                <BlockStack gap="100">
                  <Text as="p" tone="subdued">
                    Current plan
                  </Text>
                  <Text as="p" variant="headingMd">
                    {activeCharge?.chargeName ?? "No active plan"}
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {activeCharge
                      ? `${formatMoney(activeCharge.effectiveAmount ?? activeCharge.amount, activeCharge.currencyCode)} · ${cadenceLabel(activeCharge.billingInterval)}`
                      : "No current Shopify charge"}
                  </Text>
                </BlockStack>
                <BlockStack gap="100">
                  <Text as="p" tone="subdued">
                    Discounts
                  </Text>
                  <Text as="p" variant="headingMd">
                    {redemptions.length}
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Recorded intents and applications
                  </Text>
                </BlockStack>
                <BlockStack gap="100">
                  <Text as="p" tone="subdued">
                    Risk signal
                  </Text>
                  <Text as="p" variant="headingMd">
                    {metrics.churnRisk.label}
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {metrics.churnRisk.reason}
                  </Text>
                </BlockStack>
              </InlineGrid>

              {appCustomFields.rows.length > 0 ? (
                <>
                  <Divider />
                  <BlockStack gap="300">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="h3" variant="headingSm">
                        App custom fields
                      </Text>
                      {appCustomFields.updatedAt ? (
                        <Text as="p" variant="bodySm" tone="subdued">
                          {`Updated ${formatDateTime(appCustomFields.updatedAt)}`}
                        </Text>
                      ) : null}
                    </InlineStack>
                    <InlineGrid columns={{ xs: 1, sm: 2, lg: 4 }} gap="400">
                      {appCustomFields.rows.map((field) => (
                        <BlockStack gap="050" key={field.key}>
                          <Text as="p" variant="bodySm" tone="subdued">
                            {field.key}
                          </Text>
                          <Text as="p" variant="bodyMd" breakWord>
                            {field.value}
                          </Text>
                        </BlockStack>
                      ))}
                    </InlineGrid>
                  </BlockStack>
                </>
              ) : null}

              <Divider />
              <BlockStack gap="300">
                <Text as="h3" variant="headingSm">
                  Customer custom fields
                </Text>
                {customerCustomFields.rows.length > 0 ? (
                  <InlineGrid columns={{ xs: 1, sm: 2, lg: 4 }} gap="400">
                    {customerCustomFields.rows.map((field) => (
                      <BlockStack gap="050" key={field.key}>
                        <Text as="p" variant="bodySm" tone="subdued">
                          {field.key}
                        </Text>
                        <Text as="p" variant="bodyMd" breakWord>
                          {field.value}
                        </Text>
                      </BlockStack>
                    ))}
                  </InlineGrid>
                ) : (
                  <Text as="p" tone="subdued">
                    No custom fields yet
                  </Text>
                )}
              </BlockStack>

              <div className="customer-locked-actions">
                <BillingActionsCard
                  subscription={targetSubscription}
                  currency={currency}
                  oauthConnected={customer.oauthConnected}
                  appId={app.id}
                  eligiblePlans={eligiblePlans}
                />
              </div>
            </BlockStack>
          </Card>

          <Card padding="0">
            <div className="customer-card-header">
              <BlockStack gap="050">
                <Text as="h2" variant="headingMd">
                  Current Shopify subscriptions
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Latest synchronized state per Shopify charge
                </Text>
              </BlockStack>
            </div>
            <IndexTable
              resourceName={{ singular: "subscription", plural: "subscriptions" }}
              itemCount={currentCharges.length}
              selectable={false}
              headings={[
                { title: "Plan" },
                { title: "Status" },
                { title: "Cadence" },
                { title: "Price" },
                { title: "Last change" },
              ]}
            >
              {currentCharges.map((charge, index) => {
                const status = subscriptionStatus(charge.type);
                return (
                  <IndexTable.Row id={charge.id} key={charge.id} position={index}>
                    <IndexTable.Cell>{charge.chargeName}</IndexTable.Cell>
                    <IndexTable.Cell>
                      <Badge tone={status.tone}>{status.label}</Badge>
                    </IndexTable.Cell>
                    <IndexTable.Cell>{cadenceLabel(charge.billingInterval)}</IndexTable.Cell>
                    <IndexTable.Cell>
                      {formatMoney(charge.effectiveAmount ?? charge.amount, charge.currencyCode)}
                    </IndexTable.Cell>
                    <IndexTable.Cell>{formatDateTime(charge.occurredAt)}</IndexTable.Cell>
                  </IndexTable.Row>
                );
              })}
            </IndexTable>
            {currentCharges.length === 0 ? (
              <div className="customer-empty-section">
                <Text as="p" tone="subdued">
                  No synchronized Shopify subscription is available.
                </Text>
              </div>
            ) : null}
          </Card>
        </BlockStack>
      </div>

      <InlineGrid columns={{ xs: 1, lg: 2 }} gap="400">
        <Card padding="0">
          <div className="customer-card-header">
            <BlockStack gap="050">
              <Text as="h2" variant="headingMd">
                Shopify transaction history
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Synchronized Partner sales facts; no live API request
              </Text>
            </BlockStack>
          </div>
          <IndexTable
            resourceName={{ singular: "transaction", plural: "transactions" }}
            itemCount={transactions.length}
            selectable={false}
            headings={[{ title: "Date" }, { title: "Cadence" }, { title: "Amount" }]}
          >
            {transactions.map((transaction, index) => (
              <IndexTable.Row id={transaction.id} key={transaction.id} position={index}>
                <IndexTable.Cell>{formatDateTime(transaction.occurredAt)}</IndexTable.Cell>
                <IndexTable.Cell>{cadenceLabel(transaction.billingInterval)}</IndexTable.Cell>
                <IndexTable.Cell>
                  {transaction.grossAmount === null
                    ? "Unavailable"
                    : formatMoney(transaction.grossAmount, transaction.currencyCode ?? currency)}
                </IndexTable.Cell>
              </IndexTable.Row>
            ))}
          </IndexTable>
          {transactions.length === 0 ? (
            <div className="customer-empty-section">
              <Text as="p" tone="subdued">
                No synchronized Shopify sales yet.
              </Text>
            </div>
          ) : null}
        </Card>

        <Card padding="0">
          <div className="customer-card-header">
            <BlockStack gap="050">
              <Text as="h2" variant="headingMd">
                Discount history
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Internal discount intents consumed by native Shopify billing
              </Text>
            </BlockStack>
          </div>
          <IndexTable
            resourceName={{ singular: "discount", plural: "discounts" }}
            itemCount={redemptions.length}
            selectable={false}
            headings={[{ title: "Code" }, { title: "Status" }, { title: "Plan" }, { title: "Price" }]}
          >
            {redemptions.map((redemption, index) => (
              <IndexTable.Row id={redemption.id} key={redemption.id} position={index}>
                <IndexTable.Cell>{redemption.discount.code ?? "Automatic"}</IndexTable.Cell>
                <IndexTable.Cell>
                  <Badge
                    tone={
                      redemption.status === "APPLIED"
                        ? "success"
                        : redemption.status === "RESERVED"
                          ? "attention"
                          : undefined
                    }
                  >
                    {redemption.status.toLowerCase()}
                  </Badge>
                </IndexTable.Cell>
                <IndexTable.Cell>{redemption.externalPlanKey}</IndexTable.Cell>
                <IndexTable.Cell>
                  {formatMoney(redemption.priceAfterDiscount, redemption.currencyCode)}
                </IndexTable.Cell>
              </IndexTable.Row>
            ))}
          </IndexTable>
          {redemptions.length === 0 ? (
            <div className="customer-empty-section">
              <Text as="p" tone="subdued">
                No discount has been reserved or applied for this customer.
              </Text>
            </div>
          ) : null}
        </Card>
      </InlineGrid>

      <Card>
        <BlockStack gap="400">
          <InlineStack align="space-between">
            <Text as="h2" variant="headingMd">
              Recent API requests
            </Text>
            <Button
              variant="plain"
              url={`/app/api-logs?q=${encodeURIComponent(customer.shopDomain)}&appId=${app.id}`}
            >
              View all
            </Button>
          </InlineStack>
          <div className="customer-api-list">
            {apiLogs.map((log) => (
              <div className="customer-api-row" key={log.id}>
                <Badge
                  tone={log.status >= 500 ? "critical" : log.status >= 400 ? "warning" : "success"}
                >
                  {String(log.status)}
                </Badge>
                <div>
                  <Text as="p" variant="bodyMd">
                    {log.method} {log.path}
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {formatDateTime(log.createdAt)} · {log.durationMs} ms
                  </Text>
                </div>
              </div>
            ))}
            {apiLogs.length === 0 ? (
              <Text as="p" tone="subdued">
                No API requests identify this customer yet.
              </Text>
            ) : null}
          </div>
        </BlockStack>
      </Card>
    </BlockStack>
  );
}

function ActivityTab({
  loaderData,
}: {
  loaderData: Route.ComponentProps["loaderData"];
}) {
  const { timeline } = loaderData;
  const navigation = useNavigation();
  const [commentBody, setCommentBody] = useState("");
  const busy = navigation.state !== "idle";

  return (
    <Card>
      <BlockStack gap="400">
        <Text as="h2" variant="headingMd">
          Timeline
        </Text>
        <Form
          method="post"
          onSubmit={() => setCommentBody("")}
          className="customer-comment-form"
        >
          <input type="hidden" name="intent" value="add-comment" />
          <BlockStack gap="200">
            <TextField
              label="Add a comment"
              labelHidden
              placeholder="Add a comment"
              autoComplete="off"
              name="body"
              value={commentBody}
              onChange={setCommentBody}
              multiline={2}
            />
            <InlineStack align="end">
              <Button submit disabled={busy || commentBody.trim().length === 0}>
                Comment
              </Button>
            </InlineStack>
          </BlockStack>
        </Form>
        <Divider />
        <div className="customer-activity-list">
          {timeline.slice(0, 12).map((entry) => (
            <div className="customer-activity-row" key={entry.id}>
              <span className="customer-activity-dot" />
              <div>
                <Text as="p" variant="bodyMd">
                  {entry.title}
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  {formatDateTime(entry.occurredAt)}
                  {entry.detail ? ` · ${entry.detail}` : ""}
                </Text>
              </div>
            </div>
          ))}
          {timeline.length === 0 ? (
            <Text as="p" tone="subdued">
              No activity is available.
            </Text>
          ) : null}
        </div>
      </BlockStack>
    </Card>
  );
}

/**
 * Matches the Figma "Customer details" tab (node 40:71234) — three cards:
 * Customer details, Billing, Shopify. Fields with a real source (Website,
 * Name, Shop ID) are wired to loader data; everything else (Country,
 * State/Province, Pays on time, Email, Domain, Next billing date, Plan,
 * Industry) has no backing data source yet, so it renders empty exactly as
 * the design does — this pass is structure/copy parity, not persistence.
 * Tags/Notes/the test-customer checkbox are local-only (not yet saved).
 */
function CustomerDetailsTab({
  loaderData,
}: {
  loaderData: Route.ComponentProps["loaderData"];
}) {
  const { customer, shopifyPlan } = loaderData;
  const [testCustomer, setTestCustomer] = useState(false);
  const [industry, setIndustry] = useState("");
  const [shopIdRevealed, setShopIdRevealed] = useState(false);
  const [tags, setTags] = useState("");
  const [notes, setNotes] = useState("");

  return (
    <BlockStack gap="400">
      <Card>
        <BlockStack gap="400">
          <InlineStack gap="200" blockAlign="center">
            <span className="customer-card-icon">
              <Icon source={PersonIcon} />
            </span>
            <Text as="h2" variant="headingMd">
              Customer details
            </Text>
          </InlineStack>
          <InlineGrid columns={{ xs: 1, sm: 4 }} gap="400">
            <BlockStack gap="200">
              <Text as="p" variant="bodySm" fontWeight="semibold">
                Country
              </Text>
              <Text as="p" variant="bodySm">
                —
              </Text>
            </BlockStack>
            <BlockStack gap="200">
              <Text as="p" variant="bodySm" fontWeight="semibold">
                State/Province
              </Text>
              <Text as="p" variant="bodySm">
                —
              </Text>
            </BlockStack>
            <BlockStack gap="200">
              <Text as="p" variant="bodySm" fontWeight="semibold">
                Website
              </Text>
              <InlineStack gap="200" blockAlign="center">
                <a href={`https://${customer.shopDomain}`} target="_blank" rel="noreferrer">
                  {customer.shopDomain}
                </a>
                <CopyButton
                  variant="plain"
                  icon={ClipboardIcon}
                  accessibilityLabel="Copy website URL"
                  value={`https://${customer.shopDomain}`}
                  toastMessage="Website URL copied"
                />
              </InlineStack>
            </BlockStack>
            <BlockStack gap="200">
              <Text as="p" variant="bodySm" fontWeight="semibold">
                Pays on time
              </Text>
              <Text as="p" variant="bodySm">
                —
              </Text>
            </BlockStack>
          </InlineGrid>
          <InlineGrid columns={{ xs: 1, sm: 3 }} gap="400">
            <TextField
              label="Name"
              autoComplete="off"
              value={customer.displayName}
              onChange={() => {}}
              readOnly
            />
            <TextField label="Email" autoComplete="off" placeholder="—" value="" onChange={() => {}} readOnly />
            <TextField label="Domain" autoComplete="off" placeholder="—" value="" onChange={() => {}} readOnly />
          </InlineGrid>
          <InlineStack gap="200" blockAlign="end">
            <div style={{ flex: 1 }}>
              <TextField
                label="Tags"
                autoComplete="off"
                placeholder="e.g. VIP, Early customer, Churned, etc."
                value={tags}
                onChange={setTags}
              />
            </div>
            <Button variant="primary">Add</Button>
          </InlineStack>
          <TextField
            label="Notes"
            autoComplete="off"
            placeholder="Leave notes about this customer..."
            value={notes}
            onChange={setNotes}
            multiline={3}
          />
        </BlockStack>
      </Card>

      <Card>
        <BlockStack gap="400">
          <InlineStack gap="200" blockAlign="center">
            <span className="customer-card-icon">
              <Icon source={CreditCardIcon} />
            </span>
            <Text as="h2" variant="headingMd">
              Billing
            </Text>
          </InlineStack>
          <InlineStack gap="200" blockAlign="center">
            <Checkbox
              label=""
              labelHidden
              checked={testCustomer}
              onChange={setTestCustomer}
            />
            <Text as="span" variant="bodySm" fontWeight="medium">
              Mark as test customer and exclude from reporting
            </Text>
            <Tooltip content="Test customers are excluded from all revenue and analytics reporting.">
              <Icon source={InfoIcon} tone="subdued" />
            </Tooltip>
          </InlineStack>
        </BlockStack>
      </Card>

      <Card>
        <BlockStack gap="400">
          <InlineStack gap="200" blockAlign="center">
            <span className="customer-card-icon">
              <Icon source={CreditCardIcon} />
            </span>
            <Text as="h2" variant="headingMd">
              Shopify
            </Text>
          </InlineStack>
          <BlockStack gap="200">
            <Text as="p" variant="bodySm" fontWeight="semibold">
              Next billing date
            </Text>
            <Text as="p" variant="bodySm">
              —
            </Text>
          </BlockStack>
          <InlineGrid columns={{ xs: 1, sm: 4 }} gap="400">
            <Select
              label="Plan"
              options={[{ label: shopifyPlan ?? "—", value: shopifyPlan ?? "" }]}
              value={shopifyPlan ?? ""}
              onChange={() => {}}
              disabled
              helpText={shopifyPlan ? undefined : "Shopify plan not captured for this shop yet."}
            />
            <Select
              label="Industry"
              placeholder="Select industry"
              options={[]}
              value={industry}
              onChange={setIndustry}
            />
            <InlineStack gap="200" blockAlign="end">
              <div style={{ flex: 1 }}>
                <TextField
                  label="Shop ID"
                  autoComplete="off"
                  value={
                    shopIdRevealed
                      ? customer.shopPlatformId ?? "—"
                      : customer.shopPlatformId
                        ? "•".repeat(String(customer.shopPlatformId).length)
                        : "—"
                  }
                  onChange={() => {}}
                  readOnly
                />
              </div>
              <Button
                icon={ViewIcon}
                accessibilityLabel="Reveal shop ID"
                onClick={() => setShopIdRevealed((value) => !value)}
              />
            </InlineStack>
            <TextField
              label="Shop URL"
              autoComplete="off"
              value={customer.shopDomain}
              onChange={() => {}}
              readOnly
            />
          </InlineGrid>
        </BlockStack>
      </Card>
    </BlockStack>
  );
}

function ContactsTab() {
  return (
    <BlockStack gap="400">
      <Card>
        <BlockStack gap="200">
          <InlineStack align="space-between">
            <Text as="h2" variant="headingMd">
              Contacts
            </Text>
            <Button disabled>Add contact</Button>
          </InlineStack>
          <EmptyState image={EMPTY_STATE_IMAGE} heading="No contacts">
            <p>Add a contact to keep track of important points of contact</p>
          </EmptyState>
        </BlockStack>
      </Card>
      <Card>
        <BlockStack gap="200">
          <InlineStack align="space-between">
            <Text as="h2" variant="headingMd">
              Account owners
            </Text>
            <Button disabled>Add account owner</Button>
          </InlineStack>
          <EmptyState image={EMPTY_STATE_IMAGE} heading="No account owners">
            <p>Assign roles to your team members to keep track of who is responsible for this customer</p>
          </EmptyState>
        </BlockStack>
      </Card>
    </BlockStack>
  );
}

function PartnershipsTab() {
  return (
    <Card>
      <BlockStack gap="200">
        <Text as="h2" variant="headingMd">
          Partnerships
        </Text>
        <Text as="p" tone="subdued">
          This customer is not common to any of your partners.
        </Text>
      </BlockStack>
    </Card>
  );
}

export default function CustomerDetail({ loaderData }: Route.ComponentProps) {
  const backAction = useBackAction({ content: "Customers", url: "/app/customers" });
  const { app, apps, customer, metrics } = loaderData;
  const [, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState(0);
  const currency = metrics.currencyCode;

  return (
    <Page
      title={customer.displayName}
      subtitle={customer.shopDomain}
      backAction={backAction}
      secondaryActions={[
        { content: "View app", url: `/app/apps/${app.id}` },
        {
          content: "Customer API logs",
          url: `/app/api-logs?q=${encodeURIComponent(customer.shopDomain)}&appId=${app.id}`,
        },
      ]}
      fullWidth
    >
      <BlockStack gap="500">
        <Banner title="Most of this page is synchronized local data" tone="info">
          <Text as="p">
            Everything above the billing actions card is read-only and does
            not contact Shopify. The "Issue app credit", "Cancel
            subscription", and "Request plan change" actions do — each
            requires your explicit approval in a confirmation screen and
            never runs automatically.
          </Text>
        </Banner>

        {apps.length > 1 ? (
          <InlineStack gap="200">
            {apps.map((a) => (
              <Button
                key={a.id}
                pressed={a.selected}
                onClick={() => setSearchParams({ app: a.id })}
              >
                {a.name}
              </Button>
            ))}
          </InlineStack>
        ) : null}

        {/*
          Figma (node 21:55563) shows these six as ONE continuous stat-strip
          row with an icon per figure, not six separate cards — reuse the
          shared StatStrip component, in Figma's
          exact order (Last 30 days before MRR).
        */}
        <StatStrip
          stats={[
            {
              label: "Lifetime value",
              value: formatMoney(metrics.lifetimeValue, currency),
              detail: `${metrics.saleCount} synchronized Shopify sales`,
              icon: CashDollarIcon,
            },
            {
              label: "Average spend",
              value: formatMoney(metrics.averageSpend, currency),
              detail: "Per synchronized sale",
              icon: ReceiptDollarIcon,
            },
            {
              label: "Last 30 days",
              value: formatMoney(metrics.recentRevenue, currency),
              detail: `ARR run rate ${formatMoney(metrics.arr, currency)}`,
              icon: CalendarIcon,
            },
            {
              label: "MRR",
              value: formatMoney(metrics.mrr, currency),
              detail: `${metrics.activeSubscriptions} active charge${metrics.activeSubscriptions === 1 ? "" : "s"}`,
              icon: ChartVerticalIcon,
            },
            {
              label: "First seen",
              value: formatDate(customer.firstSeen),
              icon: ClockIcon,
            },
            {
              label: "Churn risk",
              value: metrics.churnRisk.label,
              detail: metrics.churnRisk.reason,
              icon: AlertTriangleIcon,
            },
          ]}
        />

        <Tabs
          tabs={[
            { id: "overview", content: "Overview" },
            { id: "activity", content: "Activity" },
            { id: "customer-details", content: "Customer details" },
            { id: "contacts", content: "Contacts" },
            { id: "partnerships", content: "Partnerships" },
          ]}
          selected={tab}
          onSelect={setTab}
        >
          <div className="customer-tab-panel">
            {tab === 0 ? (
              <OverviewTab loaderData={loaderData} />
            ) : tab === 1 ? (
              <ActivityTab loaderData={loaderData} />
            ) : tab === 2 ? (
              <CustomerDetailsTab loaderData={loaderData} />
            ) : tab === 3 ? (
              <ContactsTab />
            ) : (
              <PartnershipsTab />
            )}
          </div>
        </Tabs>
      </BlockStack>
    </Page>
  );
}
