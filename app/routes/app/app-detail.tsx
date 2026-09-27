import { randomUUID } from "node:crypto";
import {
  Avatar,
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  Checkbox,
  DataTable,
  FormLayout,
  InlineGrid,
  InlineStack,
  Layout,
  Page,
  Pagination,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import {
  ClipboardCheckIcon,
  ClipboardIcon,
  ViewIcon,
} from "@shopify/polaris-icons";
import { useState, type ReactNode } from "react";
import { Form, redirect, useNavigation, useSubmit } from "react-router";
import type { Route } from "./+types/app-detail";
import { AppDetailTabs } from "~/components/app-detail-tabs";
import { ConfirmDialog } from "~/components/confirm-dialog";
import type { Prisma } from "../../../generated/prisma/client";
import { prisma } from "~/lib/db.server";
import { env } from "~/lib/env.server";
import { requireCurrentOrganization } from "~/lib/current-org.server";
import { appApiKeyFields, readAppApiKey } from "~/lib/app-api-key.server";
import { requireUser } from "~/lib/auth/session.server";
import {
  createIdentifyApiKey,
  listIdentifyApiKeys,
  revealIdentifyApiKey,
  revokeIdentifyApiKey,
} from "~/lib/identify/api-keys.server";
import { formatDate } from "~/lib/format";
import { checkShopifyConnectionByInstallId } from "~/lib/shopify/connection.server";
import {
  credentialsFromPartnerConnection,
  partnerConnectionErrorCode,
  partnerConnectionErrorMessage,
  verifyPartnerAppConnection,
} from "~/lib/shopify/partner-connection.server";
import { useBackAction } from "~/lib/use-back-action";

const INSTALLS_PAGE_SIZE = 15;

export async function loader({ params, request }: Route.LoaderArgs) {
  const org = await requireCurrentOrganization(request);
  const [app, connections] = await Promise.all([
    prisma.app.findFirst({
      where: { id: params.appId, organizationId: org.id },
      include: { partnerConnection: true },
    }),
    prisma.shopifyPartnerConnection.findMany({
      where: { organizationId: org.id },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        name: true,
        partnerOrganizationId: true,
        status: true,
      },
    }),
  ]);
  if (!app) throw new Response("App not found", { status: 404 });

  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  const afterId = url.searchParams.get("after") ?? undefined;
  // Breadcrumb of prior page-start cursors, so Previous can step back without
  // OFFSET (which gets slow at this scale — 80k+ installs on this app alone).
  // "" is the sentinel for "page 1" (no cursor).
  const history =
    url.searchParams.get("history")?.split(",").filter(Boolean) ?? [];

  const where = {
    appId: app.id,
    // The database uses utf8mb4_unicode_ci, so MySQL contains is already
    // case-insensitive without PostgreSQL's QueryMode option.
    ...(q ? { shopDomain: { contains: q } } : {}),
  };

  const [totalCount, installsPlusOne] = await Promise.all([
    prisma.appInstall.count({ where }),
    prisma.appInstall.findMany({
      where,
      orderBy: [{ installedAt: "desc" }, { id: "desc" }],
      take: INSTALLS_PAGE_SIZE + 1,
      ...(afterId ? { cursor: { id: afterId }, skip: 1 } : {}),
    }),
  ]);

  const hasNextPage = installsPlusOne.length > INSTALLS_PAGE_SIZE;
  const pageInstalls = installsPlusOne.slice(0, INSTALLS_PAGE_SIZE);
  const nextCursor = hasNextPage
    ? pageInstalls[pageInstalls.length - 1].id
    : null;
  const hasPreviousPage = Boolean(afterId);

  const baseParams = q ? `q=${encodeURIComponent(q)}&` : "";
  const nextUrl = hasNextPage
    ? `?${baseParams}after=${nextCursor}&history=${[...history, afterId ?? ""].join(",")}`
    : undefined;
  const prevHistory = [...history];
  const prevCursor = prevHistory.pop() ?? "";
  const previousUrl = hasPreviousPage
    ? `?${baseParams}${prevCursor ? `after=${prevCursor}&` : ""}history=${prevHistory.join(",")}`
    : undefined;

  return {
    appUrl: env.APP_URL,
    partnerCreditsEnabled: env.FLEX_PARTNER_CREDITS_ENABLED,
    // Identify credentials issued for this app. Only prefix/last4 — the secrets
    // are not stored and cannot be listed.
    identifyKeys: await listIdentifyApiKeys(app.id),
    app: {
      id: app.id,
      name: app.name,
      handle: app.handle,
      // Decrypted from the at-rest copy (falls back to the legacy column), so
      // the operator still sees the same key they always did.
      apiKey: readAppApiKey(app),
      shopifyApiKey: app.shopifyApiKey,
      hasShopifyApiSecret: Boolean(app.shopifyApiSecret),
      shopifyAppId: app.shopifyAppId ?? "",
      partnerConnection: app.partnerConnection
        ? {
            id: app.partnerConnection.id,
            name: app.partnerConnection.name,
            partnerOrganizationId: app.partnerConnection.partnerOrganizationId,
            status: app.partnerConnection.status,
          }
        : null,
      partnerAppVerifiedAt: app.partnerAppVerifiedAt?.toISOString() ?? null,
      partnerAppVerificationError: app.partnerAppVerificationError,
      lifecycleEventsSyncedAt:
        app.lifecycleEventsSyncedAt?.toISOString() ?? null,
      distribution: app.distribution,
      logoUrl: app.logoUrl ?? "",
      disableDowngradeCredits: app.disableDowngradeCredits,
      enabled: app.enabled,
      isProduction: app.isProduction,
      ga4PropertyId: app.ga4PropertyId ?? "",
      bigqueryDataset: app.bigqueryDataset ?? "",
      gcpProjectId: app.gcpProjectId ?? "",
      appStoreHandle: app.appStoreHandle ?? "",
      appStoreRating: app.appStoreRating ? Number(app.appStoreRating) : null,
      appStoreReviewCount: app.appStoreReviewCount,
      reviewsSyncedAt: app.reviewsSyncedAt?.toISOString() ?? null,
      reviewsBackfillCompletedAt:
        app.reviewsBackfillCompletedAt?.toISOString() ?? null,
      storedReviewCount: await prisma.appReview.count({ where: { appId: app.id } }),
    },
    installs: pageInstalls.map((i) => ({
      id: i.id,
      shopDomain: i.shopDomain,
      installedAt: i.installedAt.toISOString(),
      uninstalledAt: i.uninstalledAt?.toISOString() ?? null,
      hasToken: Boolean(i.accessToken),
    })),
    installsQuery: q,
    totalCount,
    pagination: { hasNextPage, hasPreviousPage, nextUrl, previousUrl },
    connections,
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const org = await requireCurrentOrganization(request);
  const app = await prisma.app.findFirst({
    where: { id: params.appId, organizationId: org.id },
  });
  if (!app) throw new Response("App not found", { status: 404 });

  const form = await request.formData();
  const intent = String(form.get("intent"));

  if (intent === "test-connection") {
    const installId = String(form.get("installId") ?? "");
    const connection = await checkShopifyConnectionByInstallId(
      org.id,
      installId,
    );
    if (!connection || connection.appId !== app.id) {
      return { error: "Install not found for this app." };
    }
    return { connection };
  }

  if (intent === "regenerate-key") {
    // Writes all three representations together so they can never drift.
    await prisma.app.update({
      where: { id: app.id },
      data: appApiKeyFields(`rapid_${randomUUID().replace(/-/g, "")}`),
    });
    return redirect(`/app/apps/${app.id}`);
  }

  if (intent === "create-identify-key") {
    // The card issues one secret at a time and labels it by the day it was
    // created, so no name is typed. The field is still honoured when a caller
    // supplies one.
    const name =
      String(form.get("keyName") ?? "").trim() ||
      `Generated ${new Date().toISOString().slice(0, 10)}`;
    if (name.length > 120) return { error: "Key name is too long (120 max)." };

    const user = await requireUser(request);
    const created = await createIdentifyApiKey({
      appId: app.id,
      name,
      createdById: user.id,
    });
    /*
      Returned, NOT redirected: this is the only moment the plaintext exists —
      it is never stored, so a redirect would discard the one copy the operator
      has. The UI renders it once, with a copy control and a warning.
    */
    return { createdKey: created };
  }

  if (intent === "reveal-identify-key") {
    const keyId = String(form.get("keyId") ?? "");
    const secret = await revealIdentifyApiKey({ id: keyId, appId: app.id });
    if (!secret) {
      return {
        error:
          "That secret cannot be shown — it was issued before secrets were stored. Rotate to get one you can view.",
      };
    }
    return { revealedKey: { id: keyId, secret } };
  }

  if (intent === "revoke-identify-key") {
    const keyId = String(form.get("keyId") ?? "");
    // Scoped to this app inside revokeIdentifyApiKey, so a forged keyId from
    // another app cannot be revoked here.
    const revoked = await revokeIdentifyApiKey({ id: keyId, appId: app.id });
    if (!revoked) return { error: "That key is already revoked, or not found." };
    return redirect(`/app/apps/${app.id}`);
  }

  if (intent === "attach-partner" || intent === "test-partner") {
    const connectionId =
      intent === "test-partner"
        ? (app.partnerConnectionId ?? "")
        : String(form.get("connectionId") ?? "");
    const shopifyAppId =
      intent === "test-partner"
        ? (app.shopifyAppId ?? "")
        : String(form.get("shopifyAppId") ?? "");
    const shopifyApiKey =
      intent === "test-partner"
        ? app.shopifyApiKey
        : String(form.get("shopifyApiKey") ?? "").trim();

    const connection = await prisma.shopifyPartnerConnection.findFirst({
      where: { id: connectionId, organizationId: org.id },
    });
    if (!connection) {
      return { error: "Choose a Shopify Partner connection." };
    }

    try {
      const verified = await verifyPartnerAppConnection({
        credentials: credentialsFromPartnerConnection(connection),
        appId: shopifyAppId,
        clientId: shopifyApiKey,
      });
      const duplicate = await prisma.app.findFirst({
        where: {
          organizationId: org.id,
          shopifyAppId: verified.appId,
          id: { not: app.id },
        },
      });
      if (duplicate) {
        return { error: `${duplicate.name} already uses this Shopify App ID.` };
      }
      if (
        intent === "attach-partner" &&
        app.shopifyAppId &&
        app.shopifyAppId !== verified.appId
      ) {
        const importedEvents = await prisma.rawPartnerEvent.count({
          where: { appId: app.id },
        });
        if (importedEvents > 0) {
          return {
            error:
              "This app already has imported lifecycle events, so its Shopify App ID cannot be changed.",
          };
        }
      }

      const now = new Date();
      await prisma.$transaction([
        prisma.app.update({
          where: { id: app.id },
          data: {
            partnerConnectionId: connection.id,
            shopifyAppId: verified.appId,
            shopifyApiKey: verified.clientId,
            partnerAppVerifiedAt: now,
            partnerAppVerificationError: null,
            ...(app.shopifyAppId !== verified.appId
              ? { lifecycleEventsSyncedAt: null }
              : {}),
          },
        }),
        prisma.shopifyPartnerConnection.update({
          where: { id: connection.id },
          data: {
            status: "CONNECTED",
            lastTestedAt: now,
            lastConnectedAt: now,
            lastErrorCode: null,
          },
        }),
      ]);
      if (intent === "attach-partner") {
        return redirect(`/app/apps/${app.id}`);
      }
      return { partnerSuccess: "Partner app connection is working." };
    } catch (error) {
      const message = partnerConnectionErrorMessage(error);
      await prisma.$transaction([
        prisma.app.update({
          where: { id: app.id },
          data: { partnerAppVerificationError: message },
        }),
        prisma.shopifyPartnerConnection.update({
          where: { id: connection.id },
          data: {
            status: "ERROR",
            lastTestedAt: new Date(),
            lastErrorCode: partnerConnectionErrorCode(error),
          },
        }),
      ]);
      return { error: message };
    }
  }

  if (intent === "update") {
    /*
      A PARTIAL update, keyed on which fields the submitted form actually
      carried.
      
      Two different cards post this same intent — app settings and the GA4 /
      BigQuery card — and each carries only its own fields. Reading every field
      unconditionally meant saving one card wrote `null` over the other's: a
      settings save silently cleared `ga4PropertyId`, `bigqueryDataset` and
      `gcpProjectId`, which is how the Traffic Source report would lose an app
      with nobody touching it. `form.has` distinguishes "submitted as empty",
      which means clear it, from "not on this form", which means leave it.
    */
    const data: Prisma.AppUpdateInput = {};

    const submittedSecret = String(form.get("shopifyApiSecret") ?? "").trim();
    if (submittedSecret) data.shopifyApiSecret = submittedSecret;

    if (form.has("distribution")) {
      const distribution = String(form.get("distribution") ?? "");
      if (!["PUBLIC", "PRIVATE"].includes(distribution)) {
        return { error: "Choose a valid app distribution." };
      }
      data.distribution = distribution as "PUBLIC" | "PRIVATE";
    }

    if (form.has("logoUrl")) {
      /*
        Validated, not merely stored: this ends up as an image `src` in every
        table that shows which app a row belongs to. Requiring absolute https
        keeps a `data:` or `javascript:` string out of the DOM, and keeps the
        dashboard free of mixed-content blocking — which would show a broken
        icon rather than the app's.
      */
      const submitted = String(form.get("logoUrl") ?? "").trim();
      if (!submitted) {
        data.logoUrl = null;
      } else {
        let parsed: URL | null = null;
        try {
          parsed = new URL(submitted);
        } catch {
          parsed = null;
        }
        if (!parsed || parsed.protocol !== "https:") {
          return {
            error:
              "The app icon must be an absolute https URL — paste the image address from the app's App Store listing.",
          };
        }
        data.logoUrl = parsed.toString();
      }
    }

    if (form.has("disableDowngradeCredits")) {
      data.disableDowngradeCredits =
        form.get("disableDowngradeCredits") === "on";
    }
    for (const field of [
      "ga4PropertyId",
      "bigqueryDataset",
      "gcpProjectId",
    ] as const) {
      if (form.has(field)) {
        data[field] = String(form.get(field) ?? "").trim() || null;
      }
    }

    if (form.has("appStoreHandle")) {
      /* A pasted listing URL is accepted too — apps.shopify.com/my-app/reviews
         and "my-app" both mean the listing handle "my-app". */
      const raw = String(form.get("appStoreHandle") ?? "").trim();
      const handle = (
        /apps\.shopify\.com\/([^/?#]+)/i.exec(raw)?.[1] ?? raw
      ).toLowerCase();
      if (handle && !/^[a-z0-9][a-z0-9-]*$/.test(handle)) {
        return {
          error:
            "The App Store handle is the part after apps.shopify.com/ — letters, numbers and dashes, e.g. rapid-tracking.",
        };
      }
      if ((handle || null) !== app.appStoreHandle) {
        data.appStoreHandle = handle || null;
        // A different listing starts its collection over. Reviews already
        // stored stay: they belong to this app either way.
        data.reviewsSyncedAt = null;
        data.reviewsBackfillNextPage = null;
        data.reviewsBackfillCompletedAt = null;
        data.appStoreRating = null;
        data.appStoreReviewCount = null;
      }
    }

    const nextEnabled = form.has("enabled")
      ? form.get("enabled") === "on"
      : app.enabled;
    if (form.has("enabled")) data.enabled = nextEnabled;

    /* Same `form.has` rule as every other field here: only the card that
       actually carries this input may change it, so saving a different card
       cannot silently flip an app out of the switcher. */
    if (form.has("isProduction")) {
      data.isProduction = form.get("isProduction") === "on";
    }

    await prisma.app.update({ where: { id: app.id }, data });

    // Enabling/disabling an app changes which shops belong in the org-wide
    // logo-churn fold (PartnerDailyLogoChurnSnapshot's ORG_WIDE_LOGO_SCOPE_ID
    // rows) — a retroactive change to every already-written org-wide row, not
    // just a fact landing. Resetting the backfill cursor forces a full
    // re-backfill rather than computing a precise partial dirty floor; this
    // is a rare admin action, so the one-time cost is the simplest fix.
    if (nextEnabled !== app.enabled) {
      await prisma.organization.update({
        where: { id: app.organizationId },
        data: {
          logoSnapshotBackfillCursor: null,
          logoSnapshotBackfillCompletedAt: null,
        },
      });
    }
    return redirect(`/app/apps/${app.id}`);
  }

  return null;
}

/**
 * Copy-to-clipboard with a beat of feedback.
 *
 * The clipboard API does not exist during SSR and is absent on insecure
 * origins, so a failure is swallowed: the value is on screen and selectable
 * either way, and an error toast for something the operator cannot fix is
 * noise.
 */
function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      icon={copied ? ClipboardCheckIcon : ClipboardIcon}
      accessibilityLabel={copied ? `${label} copied` : `Copy ${label}`}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(value)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => {});
      }}
    />
  );
}

/** One `label | value | actions` line of the credentials box. */
function CredentialRow({
  label,
  children,
  actions,
  divided = false,
}: {
  label: string;
  children: ReactNode;
  actions?: ReactNode;
  divided?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--p-space-400)",
        padding: "var(--p-space-400)",
        flexWrap: "wrap",
        borderTop: divided ? "1px solid var(--p-color-border)" : undefined,
      }}
    >
      <div style={{ width: 96, flexShrink: 0 }}>
        <Text as="span" tone="subdued">
          {label}
        </Text>
      </div>
      <div style={{ flex: 1, minWidth: 220, wordBreak: "break-all" }}>
        {children}
      </div>
      {actions ? (
        <InlineStack gap="200" blockAlign="center">
          {actions}
        </InlineStack>
      ) : null}
    </div>
  );
}

function CodeRow({ label, value }: { label: string; value: string }) {
  return (
    <BlockStack gap="100">
      <Text as="span" variant="bodySm" tone="subdued">
        {label}
      </Text>
      <div
        style={{
          background: "var(--p-color-bg-surface-secondary)",
          border: "1px solid var(--p-color-border)",
          borderRadius: "var(--p-border-radius-200)",
          padding: "var(--p-space-200) var(--p-space-300)",
          fontFamily: "var(--p-font-family-mono)",
          fontSize: "13px",
          wordBreak: "break-all",
        }}
      >
        {value}
      </div>
    </BlockStack>
  );
}

export default function AppDetail({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const backAction = useBackAction({ content: "Apps", url: "/app/apps" });
  const {
    app,
    installs,
    appUrl,
    partnerCreditsEnabled,
    installsQuery,
    totalCount,
    pagination,
    connections,
    identifyKeys,
  } = loaderData;
  // Present only on the response to a just-created key — the single moment the
  // plaintext secret exists anywhere.
  const createdKey =
    actionData && "createdKey" in actionData ? actionData.createdKey : null;
  /*
    One secret is presented at a time — the newest live key. Any older live
    keys are the tail of a rotation still in progress: they keep working (that
    is the point of rotating) and are listed underneath so they can be revoked
    once callers have moved.
  */
  const liveKeys = identifyKeys.filter((key) => !key.revoked);
  const currentKey = liveKeys[0] ?? null;
  const previousKeys = liveKeys.slice(1);
  const revealedKey =
    actionData && "revealedKey" in actionData ? actionData.revealedKey : null;
  /*
    Shown in the clear when it was just issued, or when it was explicitly
    revealed and is still the current key. Lives in actionData only, so it is
    gone again on the next navigation or reload.
  */
  const visibleSecret =
    createdKey?.secret ??
    (revealedKey && revealedKey.id === currentKey?.id
      ? revealedKey.secret
      : null);
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const submit = useSubmit();
  const [regenerateKeyConfirmOpen, setRegenerateKeyConfirmOpen] =
    useState(false);

  const [partnerFields, setPartnerFields] = useState({
    connectionId: app.partnerConnection?.id ?? connections[0]?.id ?? "",
    shopifyApiKey: app.shopifyApiKey,
    shopifyAppId: app.shopifyAppId,
  });
  const setPartnerField =
    (key: keyof typeof partnerFields) => (value: string) =>
      setPartnerFields((previous) => ({ ...previous, [key]: value }));
  const [shopifyApiSecret, setShopifyApiSecret] = useState("");
  const [distribution, setDistribution] = useState(app.distribution);
  const [logoUrl, setLogoUrl] = useState(app.logoUrl);
  const [disableCredits, setDisableCredits] = useState(
    app.disableDowngradeCredits,
  );
  const [enabled, setEnabled] = useState(app.enabled);
  const [isProduction, setIsProduction] = useState(app.isProduction);
  const [ga4PropertyId, setGa4PropertyId] = useState(app.ga4PropertyId);
  const [bigqueryDataset, setBigqueryDataset] = useState(app.bigqueryDataset);
  const [gcpProjectId, setGcpProjectId] = useState(app.gcpProjectId);
  const [appStoreHandle, setAppStoreHandle] = useState(app.appStoreHandle);
  const [q, setQ] = useState(installsQuery);

  const webhookUrl = `${appUrl}/webhooks/${app.handle}/uninstalled`;
  const installsUrl = `${appUrl}/api/flex/installs`;
  const installedAppsUrl = `${appUrl}/api/flex/apps?shopDomain={shop}.myshopify.com`;
  const subscriptionsUrl = `${appUrl}/api/flex/subscriptions`;
  const discountsUrl = `${appUrl}/api/discounts`;
  const discountResolveUrl = `${appUrl}/api/discounts/resolve`;
  const discountRedemptionUrl = `${appUrl}/api/discounts/redemptions/{redemptionId}`;
  const connection =
    actionData && "connection" in actionData ? actionData.connection : null;
  const partnerConnected = Boolean(
    app.partnerConnection &&
    app.shopifyAppId &&
    app.partnerAppVerifiedAt &&
    !app.partnerAppVerificationError,
  );

  const connectionBanner = connection ? (
    connection.status === "connected" ? (
      <Banner tone="success" title="Shopify connection is working">
        {connection.remoteShop.name} ({connection.remoteShop.myshopifyDomain})
        responded through the stored offline token.
      </Banner>
    ) : connection.status === "domain_mismatch" ? (
      <Banner tone="critical" title="Token belongs to a different shop">
        Expected {connection.shopDomain}, but Shopify returned{" "}
        {connection.remoteShop.myshopifyDomain}. Refresh this install through
        OAuth before billing it.
      </Banner>
    ) : connection.status === "missing_token" ? (
      <Banner tone="warning" title="No offline access token">
        Complete Shopify OAuth for {connection.shopDomain}, then send the
        offline token to the install-sync endpoint.
      </Banner>
    ) : connection.status === "uninstalled" ? (
      <Banner tone="warning" title="This install is uninstalled">
        Reinstall the app and sync its new offline token before testing.
      </Banner>
    ) : (
      <Banner tone="critical" title="Shopify connection failed">
        Shopify did not accept this install&apos;s stored credentials. Refresh
        its OAuth install and try again.
      </Banner>
    )
  ) : null;

  return (
    <Page
      /* Matches the App events tab, which is already full width — without it,
         moving between the two tabs of the same page changed how wide the
         page was. */
      fullWidth
      title={app.name}
      subtitle={app.handle}
      backAction={backAction}
      titleMetadata={
        <Badge tone={app.enabled ? "success" : "critical"}>
          {app.enabled ? "Enabled" : "Disabled"}
        </Badge>
      }
    >
      <AppDetailTabs appId={app.id} active="overview" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
              <Card>
                <BlockStack gap="200">
                  <InlineStack align="space-between">
                    <Text as="h2" variant="headingMd">
                      Partner analytics
                    </Text>
                    <Badge tone={partnerConnected ? "success" : "critical"}>
                      {partnerConnected ? "Connected" : "Setup required"}
                    </Badge>
                  </InlineStack>
                  <Text as="p" tone="subdued" variant="bodySm">
                    {partnerConnected
                      ? `${app.partnerConnection?.name} can access ${app.shopifyAppId}.`
                      : "Select a Partner connection and verify the App ID + Client ID."}
                  </Text>
                  <Text as="p" tone="subdued" variant="bodySm">
                    Last lifecycle sync:{" "}
                    {app.lifecycleEventsSyncedAt
                      ? formatDate(app.lifecycleEventsSyncedAt)
                      : "Not synced yet"}
                  </Text>
                </BlockStack>
              </Card>
              <Card>
                <BlockStack gap="200">
                  <InlineStack align="space-between">
                    <Text as="h2" variant="headingMd">
                      Merchant billing
                    </Text>
                    <Badge
                      tone={
                        app.hasShopifyApiSecret && totalCount > 0
                          ? "success"
                          : "attention"
                      }
                    >
                      {app.hasShopifyApiSecret && totalCount > 0
                        ? "Configured"
                        : "Needs OAuth"}
                    </Badge>
                  </InlineStack>
                  <Text as="p" tone="subdued" variant="bodySm">
                    Client secret:{" "}
                    {app.hasShopifyApiSecret ? "Saved" : "Missing"}
                  </Text>
                  <Text as="p" tone="subdued" variant="bodySm">
                    Merchant installs: {totalCount.toLocaleString()}
                  </Text>
                </BlockStack>
              </Card>
            </InlineGrid>

            {actionData &&
            "partnerSuccess" in actionData &&
            actionData.partnerSuccess ? (
              <Banner tone="success">{actionData.partnerSuccess}</Banner>
            ) : null}

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Connect your app to this platform
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  Your app keeps its own Shopify OAuth. Use these values to
                  authenticate to the platform API and to sync installs.
                </Text>
                <CodeRow
                  label="Platform API key (Authorization: Bearer …)"
                  value={app.apiKey}
                />
                <CodeRow
                  label="Install-sync endpoint (POST after each OAuth)"
                  value={installsUrl}
                />
                <CodeRow
                  label="List installs (GET, cursor-paginated)"
                  value={installsUrl}
                />
                <CodeRow
                  label="Installed apps for a shop (GET)"
                  value={installedAppsUrl}
                />
                <CodeRow
                  label="List subscriptions (GET, cursor-paginated)"
                  value={subscriptionsUrl}
                />
                <CodeRow
                  label="List discounts (GET, cursor-paginated)"
                  value={discountsUrl}
                />
                <CodeRow
                  label="Reserve native discount (POST)"
                  value={discountResolveUrl}
                />
                <CodeRow
                  label="Confirm/release redemption (POST/DELETE)"
                  value={discountRedemptionUrl}
                />
                <CodeRow
                  label="Uninstall webhook URL (set in your app config)"
                  value={webhookUrl}
                />
                <Button
                  tone="critical"
                  variant="secondary"
                  loading={busy}
                  onClick={() => setRegenerateKeyConfirmOpen(true)}
                >
                  Regenerate API key
                </Button>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Credentials
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  One pair for the whole platform API — <code>/v1/identify</code>,{" "}
                  <code>/api/flex/*</code> and <code>/api/discounts/*</code> —
                  sent as X-App-Id and X-App-Api-Key (or{" "}
                  <code>Authorization: Bearer</code>). No IDENTIFY_APP_*
                  environment pair or redeploy needed. Rotating issues a new
                  secret and leaves the current one working, so callers can be
                  moved over before it is revoked.
                </Text>

                {createdKey ? (
                  <Banner tone="success" title="New secret issued">
                    <Text as="p" variant="bodySm">
                      It is shown below, and the previous secret keeps working
                      until you revoke it.
                    </Text>
                  </Banner>
                ) : null}

                <div
                  style={{
                    border: "1px solid var(--p-color-border)",
                    borderRadius: "var(--p-border-radius-300)",
                    overflow: "hidden",
                  }}
                >
                  <CredentialRow
                    label="Client ID"
                    actions={<CopyButton value={app.id} label="Client ID" />}
                  >
                    <div
                      style={{
                        fontFamily: "var(--p-font-family-mono)",
                        fontSize: "13px",
                      }}
                    >
                      {app.id}
                    </div>
                  </CredentialRow>

                  <CredentialRow
                    label="Secret"
                    divided
                    actions={
                      <>
                        {/* Reveal is a request, not a toggle: the secret is
                            fetched only when asked for, rather than riding along
                            in every render of this page. */}
                        {currentKey && !visibleSecret ? (
                          <Form method="post">
                            <input
                              type="hidden"
                              name="intent"
                              value="reveal-identify-key"
                            />
                            <input
                              type="hidden"
                              name="keyId"
                              value={currentKey.id}
                            />
                            <Button
                              submit
                              icon={ViewIcon}
                              disabled={busy || !currentKey.canReveal}
                              accessibilityLabel="Show secret"
                            />
                          </Form>
                        ) : null}
                        {visibleSecret ? (
                          <CopyButton value={visibleSecret} label="secret" />
                        ) : null}
                        <Form method="post">
                          <input
                            type="hidden"
                            name="intent"
                            value="create-identify-key"
                          />
                          <Button
                            submit
                            variant="primary"
                            tone={currentKey ? "critical" : undefined}
                            loading={busy}
                          >
                            {currentKey ? "Rotate" : "Generate"}
                          </Button>
                        </Form>
                      </>
                    }
                  >
                    {currentKey ? (
                      <BlockStack gap="100">
                        <div
                          style={{
                            fontFamily: "var(--p-font-family-mono)",
                            fontSize: "13px",
                            letterSpacing: visibleSecret ? undefined : "2px",
                            wordBreak: "break-all",
                          }}
                        >
                          {visibleSecret ?? "•".repeat(32)}
                        </div>
                        <Text as="span" tone="subdued" variant="bodySm">
                          {`Created ${formatDate(currentKey.createdAt)}`}
                          {currentKey.createdByLabel
                            ? ` by ${currentKey.createdByLabel}`
                            : ""}
                          {currentKey.canReveal
                            ? ""
                            : " · issued before secrets were stored, so it can only be rotated"}
                        </Text>
                      </BlockStack>
                    ) : (
                      <Text as="span" tone="subdued" variant="bodySm">
                        None yet — this app still authenticates with its
                        IDENTIFY_APP_* environment pair.
                      </Text>
                    )}
                  </CredentialRow>
                </div>

                {previousKeys.length ? (
                  <BlockStack gap="200">
                    <Text as="h3" variant="headingSm">
                      Previous secrets
                    </Text>
                    <Text as="p" tone="subdued" variant="bodySm">
                      Still accepted, so rotating locks nothing out. Revoke each
                      once its callers are on the new secret.
                    </Text>
                    <div
                      style={{
                        border: "1px solid var(--p-color-border)",
                        borderRadius: "var(--p-border-radius-300)",
                        overflow: "hidden",
                      }}
                    >
                      {previousKeys.map((key, index) => (
                        <CredentialRow
                          key={key.id}
                          label=""
                          divided={index > 0}
                          actions={
                            <Form method="post">
                              <input
                                type="hidden"
                                name="intent"
                                value="revoke-identify-key"
                              />
                              <input
                                type="hidden"
                                name="keyId"
                                value={key.id}
                              />
                              <Button
                                submit
                                variant="tertiary"
                                tone="critical"
                                disabled={busy}
                              >
                                Revoke
                              </Button>
                            </Form>
                          }
                        >
                          <Text as="span" tone="subdued" variant="bodySm">
                            {`${key.prefix}…${key.last4} · Created ${formatDate(
                              key.createdAt,
                            )} · Last used ${
                              key.lastUsedAt ? formatDate(key.lastUsedAt) : "never"
                            }`}
                          </Text>
                        </CredentialRow>
                      ))}
                    </div>
                  </BlockStack>
                ) : null}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <InlineGrid columns="1fr auto" gap="200">
                  <Text as="h2" variant="headingMd">
                    Installs
                  </Text>
                  <Text as="span" tone="subdued" variant="bodySm">
                    {totalCount.toLocaleString()} total
                  </Text>
                </InlineGrid>

                <Form method="get">
                  <TextField
                    label="Search installs by shop domain"
                    labelHidden
                    name="q"
                    placeholder="Search by shop domain…"
                    value={q}
                    onChange={setQ}
                    autoComplete="off"
                    connectedRight={<Button submit>Search</Button>}
                  />
                </Form>

                {connectionBanner}

                {installs.length === 0 ? (
                  installsQuery ? (
                    <Text as="p" tone="subdued">
                      No installs match &quot;{installsQuery}&quot;.
                    </Text>
                  ) : (
                    <Banner tone="warning" title="No merchant is connected yet">
                      A Partner app connection does not create merchant OAuth
                      sessions. After each shop installs the app, send its
                      offline token through POST {installsUrl}.
                    </Banner>
                  )
                ) : (
                  <>
                    <DataTable
                      columnContentTypes={[
                        "text",
                        "text",
                        "text",
                        "text",
                        "text",
                      ]}
                      headings={[
                        "Shop",
                        "Installed",
                        "Token",
                        "Status",
                        "Connection",
                      ]}
                      rows={installs.map((i) => [
                        i.shopDomain,
                        formatDate(i.installedAt),
                        i.hasToken ? "✓" : "—",
                        i.uninstalledAt ? "Uninstalled" : "Active",
                        <Form method="post" key={`${i.id}-connection`}>
                          <input
                            type="hidden"
                            name="intent"
                            value="test-connection"
                          />
                          <input type="hidden" name="installId" value={i.id} />
                          <Button
                            submit
                            variant="plain"
                            disabled={Boolean(i.uninstalledAt) || !i.hasToken}
                            loading={
                              navigation.state === "submitting" &&
                              navigation.formData?.get("intent") ===
                                "test-connection" &&
                              navigation.formData?.get("installId") === i.id
                            }
                          >
                            Test
                          </Button>
                        </Form>,
                      ])}
                    />
                    <InlineStack align="center">
                      <Pagination
                        hasNext={pagination.hasNextPage}
                        hasPrevious={pagination.hasPreviousPage}
                        nextURL={pagination.nextUrl}
                        previousURL={pagination.previousUrl}
                      />
                    </InlineStack>
                  </>
                )}
              </BlockStack>
            </Card>

          </BlockStack>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between">
                  <Text as="h2" variant="headingMd">
                    Partner app connection
                  </Text>
                  <Badge tone={partnerConnected ? "success" : "attention"}>
                    {partnerConnected ? "Verified" : "Not verified"}
                  </Badge>
                </InlineStack>
                {actionData && "error" in actionData && actionData.error ? (
                  <Banner tone="critical">{actionData.error}</Banner>
                ) : null}
                {connections.length === 0 ? (
                  <Banner tone="warning" title="No Partner connection">
                    <BlockStack gap="200">
                      <Text as="p">
                        Add a reusable Shopify Partner connection first.
                      </Text>
                      <InlineStack>
                        <Button url="/app/connections" variant="primary">
                          Add connection
                        </Button>
                      </InlineStack>
                    </BlockStack>
                  </Banner>
                ) : (
                  <Form method="post">
                    <input type="hidden" name="intent" value="attach-partner" />
                    <FormLayout>
                      <Select
                        label="Platform connection"
                        name="connectionId"
                        options={connections.map((item) => ({
                          label: `${item.name} · Partner ${item.partnerOrganizationId}`,
                          value: item.id,
                        }))}
                        value={partnerFields.connectionId}
                        onChange={setPartnerField("connectionId")}
                        helpText="Manage apps permission is required."
                      />
                      <TextField
                        label="App ID"
                        name="shopifyAppId"
                        value={partnerFields.shopifyAppId}
                        onChange={setPartnerField("shopifyAppId")}
                        autoComplete="off"
                        placeholder="gid://partners/App/123456"
                        helpText="Numeric App ID or full Partner App GID."
                        requiredIndicator
                      />
                      <TextField
                        label="Client ID"
                        name="shopifyApiKey"
                        value={partnerFields.shopifyApiKey}
                        onChange={setPartnerField("shopifyApiKey")}
                        autoComplete="off"
                        helpText="Verified against this app through Partner API."
                        requiredIndicator
                      />
                      <Button submit variant="primary" loading={busy}>
                        Verify and use connection
                      </Button>
                    </FormLayout>
                  </Form>
                )}
                {partnerConnected ? (
                  <Form method="post">
                    <input type="hidden" name="intent" value="test-partner" />
                    <Button submit variant="plain" loading={busy}>
                      Test Partner connection again
                    </Button>
                  </Form>
                ) : null}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Billing setup
                </Text>
                {!partnerCreditsEnabled ? (
                  <Banner tone="warning">
                    Partner credits are disabled globally. Analytics still
                    works; set <code>FLEX_PARTNER_CREDITS_ENABLED=true</code>{" "}
                    only before using downgrade or APP_CREDITS rules.
                  </Banner>
                ) : null}
                <Form method="post">
                  <input type="hidden" name="intent" value="update" />
                  <input
                    type="hidden"
                    name="disableDowngradeCredits"
                    value={disableCredits ? "on" : ""}
                  />
                  <input
                    type="hidden"
                    name="enabled"
                    value={enabled ? "on" : ""}
                  />
                  <input
                    type="hidden"
                    name="isProduction"
                    value={isProduction ? "on" : ""}
                  />
                  <FormLayout>
                    <TextField
                      label="Client secret"
                      name="shopifyApiSecret"
                      type="password"
                      value={shopifyApiSecret}
                      onChange={setShopifyApiSecret}
                      autoComplete="new-password"
                      placeholder={
                        app.hasShopifyApiSecret
                          ? "Saved — leave blank to keep"
                          : "Required for OAuth and webhooks"
                      }
                      helpText="Never returned to the browser after saving."
                    />
                    <TextField
                      label="App icon URL"
                      name="logoUrl"
                      type="url"
                      value={logoUrl}
                      onChange={setLogoUrl}
                      autoComplete="off"
                      placeholder="https://cdn.shopify.com/app-store/…/icon.png"
                      helpText="Shown beside this app across the dashboard. Copy the image address from the app's App Store listing — the Partner API does not expose it. Leave blank to show a monogram of the app's name instead."
                      prefix={
                        logoUrl ? (
                          <Avatar size="sm" name={app.name} source={logoUrl} />
                        ) : undefined
                      }
                    />
                    <Select
                      label="Distribution"
                      name="distribution"
                      options={[
                        { label: "Public", value: "PUBLIC" },
                        { label: "Private", value: "PRIVATE" },
                      ]}
                      value={distribution}
                      onChange={(value) =>
                        setDistribution(value as "PUBLIC" | "PRIVATE")
                      }
                    />
                    <Checkbox
                      label="Disable pro-rated downgrade credits"
                      checked={disableCredits}
                      onChange={setDisableCredits}
                    />
                    <Checkbox
                      label="Enabled (charge cron processes this app)"
                      checked={enabled}
                      onChange={setEnabled}
                    />
                    <Checkbox
                      label="Published app (show in the sidebar's app switcher)"
                      helpText="Turn off for development or staging copies. They keep all their data and stay reachable from this page — they just stop cluttering the switcher."
                      checked={isProduction}
                      onChange={setIsProduction}
                    />
                    <Button submit variant="primary" loading={busy}>
                      Save billing setup
                    </Button>
                  </FormLayout>
                </Form>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Traffic Source analytics (GA4/BigQuery)
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  Lets the Traffic Source report switch to this app. Leave
                  blank to keep it hidden from the Traffic app switcher.
                </Text>
                <Form method="post">
                  <input type="hidden" name="intent" value="update" />
                  <input
                    type="hidden"
                    name="disableDowngradeCredits"
                    value={disableCredits ? "on" : ""}
                  />
                  <input
                    type="hidden"
                    name="enabled"
                    value={enabled ? "on" : ""}
                  />
                  <input type="hidden" name="distribution" value={distribution} />
                  <FormLayout>
                    <TextField
                      label="GA4 property ID"
                      name="ga4PropertyId"
                      value={ga4PropertyId}
                      onChange={setGa4PropertyId}
                      autoComplete="off"
                      placeholder="372125278"
                    />
                    <TextField
                      label="BigQuery dataset"
                      name="bigqueryDataset"
                      value={bigqueryDataset}
                      onChange={setBigqueryDataset}
                      autoComplete="off"
                      placeholder="analytics_123456789"
                      helpText="Usually analytics_<GA4 property ID>."
                    />
                    <TextField
                      label="GCP project ID (optional)"
                      name="gcpProjectId"
                      value={gcpProjectId}
                      onChange={setGcpProjectId}
                      autoComplete="off"
                      placeholder="my-gcp-project"
                      helpText="Only needed if this app's GA4 export lives in a different GCP project than the default — the BigQuery service account must already have cross-project access. Leave blank to use the shared project."
                    />
                    <Button submit variant="primary" loading={busy}>
                      Save analytics settings
                    </Button>
                  </FormLayout>
                </Form>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  App Store reviews
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  Reviews are read from this app&apos;s public App Store
                  listing — Shopify offers no API for them. Leave blank to
                  stop collecting.
                </Text>
                {app.appStoreHandle ? (
                  <Text as="p" variant="bodySm">
                    {[
                      app.appStoreRating !== null && app.appStoreReviewCount !== null
                        ? `${app.appStoreRating.toFixed(1)}★ from ${app.appStoreReviewCount.toLocaleString()} reviews on the listing`
                        : null,
                      `${app.storedReviewCount.toLocaleString()} collected`,
                      app.reviewsBackfillCompletedAt
                        ? null
                        : "first full read in progress",
                      app.reviewsSyncedAt
                        ? `last checked ${new Date(app.reviewsSyncedAt).toLocaleString()}`
                        : "not checked yet",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </Text>
                ) : null}
                <Form method="post">
                  <input type="hidden" name="intent" value="update" />
                  <input
                    type="hidden"
                    name="disableDowngradeCredits"
                    value={disableCredits ? "on" : ""}
                  />
                  <input
                    type="hidden"
                    name="enabled"
                    value={enabled ? "on" : ""}
                  />
                  <input type="hidden" name="distribution" value={distribution} />
                  <FormLayout>
                    <TextField
                      label="App Store handle"
                      name="appStoreHandle"
                      value={appStoreHandle}
                      onChange={setAppStoreHandle}
                      autoComplete="off"
                      placeholder="rapid-tracking"
                      helpText="The part after apps.shopify.com/ in the listing's address. You can paste the whole listing URL."
                    />
                    <Button submit variant="primary" loading={busy}>
                      Save review settings
                    </Button>
                  </FormLayout>
                </Form>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>

      <ConfirmDialog
        open={regenerateKeyConfirmOpen}
        onClose={() => setRegenerateKeyConfirmOpen(false)}
        title="Regenerate this app's API key?"
        confirmLabel="Regenerate key"
        loading={busy}
        onConfirm={() => {
          setRegenerateKeyConfirmOpen(false);
          void submit({ intent: "regenerate-key" }, { method: "post" });
        }}
      >
        <Text as="p">
          The previous key stops working immediately — anything still using
          it (the app&apos;s own backend, webhooks, etc.) will need updating.
          This can&apos;t be undone.
        </Text>
      </ConfirmDialog>
    </Page>
  );
}
