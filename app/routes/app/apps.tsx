import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  FormLayout,
  IndexTable,
  InlineGrid,
  InlineStack,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { useState } from "react";
import { Form, Link, redirect, useNavigation } from "react-router";
import { AppsIcon } from "@shopify/polaris-icons";
import type { Route } from "./+types/apps";
import { ProductEmptyState } from "~/components/product-empty-state";
import { randomUUID } from "node:crypto";
import { requireCurrentOrganization } from "~/lib/current-org.server";
import { AppLogo } from "~/components/app-identity";
import { appApiKeyFields } from "~/lib/app-api-key.server";
import { prisma } from "~/lib/db.server";
import {
  credentialsFromPartnerConnection,
  partnerConnectionErrorCode,
  partnerConnectionErrorMessage,
  verifyPartnerAppConnection,
} from "~/lib/shopify/partner-connection.server";

export async function loader({ request }: Route.LoaderArgs) {
  const org = await requireCurrentOrganization(request);
  const url = new URL(request.url);
  const requestedConnectionId = url.searchParams.get("connectionId");

  const [apps, connections] = await Promise.all([
    prisma.app.findMany({
      where: { organizationId: org.id },
      orderBy: { createdAt: "desc" },
      include: {
        partnerConnection: {
          select: { id: true, name: true, status: true },
        },
        _count: { select: { installs: true, plans: true } },
        installs: {
          where: { uninstalledAt: null },
          select: { accessToken: true },
        },
      },
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

  const selectedConnectionId =
    requestedConnectionId &&
    connections.some((connection) => connection.id === requestedConnectionId)
      ? requestedConnectionId
      : (connections[0]?.id ?? "");

  return {
    selectedConnectionId,
    connections,
    apps: apps.map((app) => ({
      id: app.id,
      name: app.name,
      logoUrl: app.logoUrl,
      handle: app.handle,
      distribution: app.distribution,
      partnerConnectionName: app.partnerConnection?.name ?? null,
      partnerVerified: Boolean(
        app.partnerConnection &&
        app.shopifyAppId &&
        app.partnerAppVerifiedAt &&
        !app.partnerAppVerificationError,
      ),
      installs: app._count.installs,
      activeInstalls: app.installs.length,
      installsWithToken: app.installs.filter((install) =>
        Boolean(install.accessToken),
      ).length,
      plans: app._count.plans,
    })),
  };
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function action({ request }: Route.ActionArgs) {
  const org = await requireCurrentOrganization(request);
  const form = await request.formData();

  const name = String(form.get("name") ?? "").trim();
  const handle = slugify(String(form.get("handle") ?? "") || name);
  const connectionId = String(form.get("connectionId") ?? "");
  const shopifyAppIdInput = String(form.get("shopifyAppId") ?? "");
  const shopifyApiKey = String(form.get("shopifyApiKey") ?? "").trim();
  const shopifyApiSecret = String(form.get("shopifyApiSecret") ?? "").trim();
  const distribution = String(form.get("distribution") ?? "PUBLIC");
  const ga4PropertyId = String(form.get("ga4PropertyId") ?? "").trim();
  const bigqueryDataset = String(form.get("bigqueryDataset") ?? "").trim();
  const gcpProjectId = String(form.get("gcpProjectId") ?? "").trim();

  if (!name || !handle)
    return { error: "Display name and handle are required." };
  if (name.length > 100 || handle.length > 100) {
    return {
      error: "Display name and handle must be 100 characters or fewer.",
    };
  }
  if (!shopifyApiKey) return { error: "Shopify Client ID is required." };
  if (!["PUBLIC", "PRIVATE"].includes(distribution)) {
    return { error: "Choose a valid app distribution." };
  }

  const [existingHandle, connection] = await Promise.all([
    prisma.app.findUnique({ where: { handle } }),
    prisma.shopifyPartnerConnection.findFirst({
      where: { id: connectionId, organizationId: org.id },
    }),
  ]);
  if (existingHandle) return { error: `Handle "${handle}" is already taken.` };
  if (!connection) {
    return {
      error: "Add or select a Shopify Partner connection before adding an app.",
    };
  }

  try {
    const verified = await verifyPartnerAppConnection({
      credentials: credentialsFromPartnerConnection(connection),
      appId: shopifyAppIdInput,
      clientId: shopifyApiKey,
    });
    const existingApp = await prisma.app.findFirst({
      where: {
        organizationId: org.id,
        shopifyAppId: verified.appId,
      },
    });
    if (existingApp) {
      return { error: `${existingApp.name} already uses this Shopify App ID.` };
    }

    const now = new Date();
    const [app] = await prisma.$transaction([
      prisma.app.create({
        data: {
          organizationId: org.id,
          name,
          handle,
          // Generated here rather than left to the column default, so the hash
          // and encrypted copy exist from the first moment and the row is never
          // plaintext-only.
          ...appApiKeyFields(`rapid_${randomUUID().replace(/-/g, "")}`),
          partnerConnectionId: connection.id,
          shopifyApiKey: verified.clientId,
          shopifyApiSecret,
          shopifyAppId: verified.appId,
          partnerAppVerifiedAt: now,
          partnerAppVerificationError: null,
          distribution: distribution as "PUBLIC" | "PRIVATE",
          ga4PropertyId: ga4PropertyId || null,
          bigqueryDataset: bigqueryDataset || null,
          gcpProjectId: gcpProjectId || null,
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
    return redirect(`/app/apps/${app.id}`);
  } catch (error) {
    await prisma.shopifyPartnerConnection.update({
      where: { id: connection.id },
      data: {
        status: "ERROR",
        lastTestedAt: new Date(),
        lastErrorCode: partnerConnectionErrorCode(error),
      },
    });
    return { error: partnerConnectionErrorMessage(error) };
  }
}

export default function Apps({ loaderData, actionData }: Route.ComponentProps) {
  const { apps, connections } = loaderData;
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  const [fields, setFields] = useState({
    name: "",
    handle: "",
    shopifyApiKey: "",
    shopifyApiSecret: "",
    shopifyAppId: "",
    ga4PropertyId: "",
    bigqueryDataset: "",
    gcpProjectId: "",
  });
  const set = (key: keyof typeof fields) => (value: string) =>
    setFields((previous) => ({ ...previous, [key]: value }));
  const [connectionId, setConnectionId] = useState(
    loaderData.selectedConnectionId,
  );
  const [distribution, setDistribution] = useState("PUBLIC");

  return (
    <Page
      title="Apps"
      subtitle="Attach Shopify apps through a verified Partner connection."
      secondaryActions={[
        { content: "Manage connections", url: "/app/connections" },
      ]}
    >
      <BlockStack gap="400">
        <Banner tone="info" title="Two connections, two purposes">
          Partner connection verifies the app and imports lifecycle events.
          Merchant OAuth supplies each shop&apos;s offline token for Admin API
          billing.
        </Banner>

        <InlineGrid columns={{ xs: 1, md: "2fr 1fr" }} gap="400">
          <Card padding="0">
            {apps.length === 0 ? (
              <ProductEmptyState
                title="Connect your first Shopify app"
                description="Verify an app against your Partner organization to unlock installs, subscriptions, and revenue intelligence."
                icon={AppsIcon}
                action={{ content: "Add app", url: "#add-app" }}
              />
            ) : (
              <IndexTable
                resourceName={{ singular: "app", plural: "apps" }}
                itemCount={apps.length}
                selectable={false}
                headings={[
                  { title: "App" },
                  { title: "Partner connection" },
                  { title: "Analytics" },
                  { title: "Merchant OAuth" },
                  { title: "Plans" },
                ]}
              >
                {apps.map((app, index) => (
                  <IndexTable.Row id={app.id} key={app.id} position={index}>
                    <IndexTable.Cell>
                      <BlockStack gap="050">
                        <InlineStack gap="200" blockAlign="center" wrap={false}>
                          <AppLogo appName={app.name} logoUrl={app.logoUrl} />
                          <Link to={`/app/apps/${app.id}`}>{app.name}</Link>
                        </InlineStack>
                        <Text as="span" tone="subdued" variant="bodySm">
                          {app.handle}
                        </Text>
                      </BlockStack>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {app.partnerConnectionName ?? "Not selected"}
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {app.partnerVerified ? (
                        <Badge tone="success">Partner app connected</Badge>
                      ) : (
                        <Badge tone="critical">Needs connection</Badge>
                      )}
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {app.activeInstalls === 0 ? (
                        <Badge tone="attention">No shop installs</Badge>
                      ) : app.installsWithToken === app.activeInstalls ? (
                        <Badge tone="success">
                          {`${app.installsWithToken}/${app.activeInstalls} ready`}
                        </Badge>
                      ) : (
                        <Badge tone="critical">
                          {`${app.installsWithToken}/${app.activeInstalls} ready`}
                        </Badge>
                      )}
                    </IndexTable.Cell>
                    <IndexTable.Cell>{app.plans}</IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            )}
          </Card>

          <div id="add-app">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Add app
                </Text>
                {actionData && "error" in actionData && actionData.error ? (
                  <Banner tone="critical">{actionData.error}</Banner>
                ) : null}

                {connections.length === 0 ? (
                  <Banner tone="warning" title="Add a Partner connection first">
                    <BlockStack gap="200">
                      <Text as="p">
                        You need a Partner organization ID and API client token
                        with Manage apps permission.
                      </Text>
                      <InlineStack>
                        <Button url="/app/connections" variant="primary">
                          Add Shopify connection
                        </Button>
                      </InlineStack>
                    </BlockStack>
                  </Banner>
                ) : (
                  <Form method="post">
                    <FormLayout>
                      <Select
                        label="Platform connection"
                        name="connectionId"
                        options={connections.map((connection) => ({
                          label: `${connection.name} · Partner ${connection.partnerOrganizationId}`,
                          value: connection.id,
                        }))}
                        value={connectionId}
                        onChange={setConnectionId}
                        helpText={
                          <Link to="/app/connections">
                            Add another connection
                          </Link>
                        }
                      />
                      <TextField
                        label="Display name"
                        name="name"
                        value={fields.name}
                        onChange={set("name")}
                        autoComplete="off"
                        placeholder="e.g. My App"
                        requiredIndicator
                      />
                      <TextField
                        label="Handle"
                        name="handle"
                        value={fields.handle}
                        onChange={set("handle")}
                        autoComplete="off"
                        helpText="URL-safe internal id. Blank uses the display name."
                      />
                      <TextField
                        label="App ID"
                        name="shopifyAppId"
                        value={fields.shopifyAppId}
                        onChange={set("shopifyAppId")}
                        autoComplete="off"
                        placeholder="gid://partners/App/123456"
                        helpText="Paste the numeric ID or full Partner App GID from the Shopify Dev Dashboard URL."
                        requiredIndicator
                      />
                      <TextField
                        label="Client ID"
                        name="shopifyApiKey"
                        value={fields.shopifyApiKey}
                        onChange={set("shopifyApiKey")}
                        autoComplete="off"
                        helpText="Shopify calls this the Client ID (formerly API key). It is verified against the App ID."
                        requiredIndicator
                      />
                      <TextField
                        label="Client secret (optional now)"
                        name="shopifyApiSecret"
                        type="password"
                        value={fields.shopifyApiSecret}
                        onChange={set("shopifyApiSecret")}
                        autoComplete="new-password"
                        helpText="Needed for merchant OAuth/webhook verification and billing, but not Partner analytics."
                      />
                      <Text as="h3" variant="headingSm">
                        GA4/BigQuery access (optional)
                      </Text>
                      <TextField
                        label="GA4 property ID"
                        name="ga4PropertyId"
                        value={fields.ga4PropertyId}
                        onChange={set("ga4PropertyId")}
                        autoComplete="off"
                        placeholder="372125278"
                        helpText="Needed for the Traffic Source report. Leave blank to skip for now."
                      />
                      <TextField
                        label="BigQuery dataset"
                        name="bigqueryDataset"
                        value={fields.bigqueryDataset}
                        onChange={set("bigqueryDataset")}
                        autoComplete="off"
                        placeholder="analytics_123456789"
                        helpText="Usually analytics_<GA4 property ID>."
                      />
                      <TextField
                        label="GCP project ID (optional)"
                        name="gcpProjectId"
                        value={fields.gcpProjectId}
                        onChange={set("gcpProjectId")}
                        autoComplete="off"
                        placeholder="my-gcp-project"
                        helpText="Only needed if this app's GA4 export lives in a different GCP project than the default — the BigQuery service account must already have cross-project access. Leave blank to use the shared project."
                      />
                      <Select
                        label="Distribution"
                        name="distribution"
                        options={[
                          {
                            label: "Public (required for Billing API)",
                            value: "PUBLIC",
                          },
                          { label: "Private / custom", value: "PRIVATE" },
                        ]}
                        value={distribution}
                        onChange={setDistribution}
                      />
                      <Button submit variant="primary" loading={busy}>
                        Verify and add app
                      </Button>
                    </FormLayout>
                  </Form>
                )}
              </BlockStack>
            </Card>
          </div>
        </InlineGrid>
      </BlockStack>
    </Page>
  );
}
