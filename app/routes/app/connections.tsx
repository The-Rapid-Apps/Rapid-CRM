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
  Modal,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import { useEffect, useState } from "react";
import { Form, Link, redirect, useFetcher, useNavigation } from "react-router";
import { ConnectIcon } from "@shopify/polaris-icons";
import type { Route } from "./+types/connections";
import { ProductEmptyState } from "~/components/product-empty-state";
import { encryptCredential } from "~/lib/credential-encryption.server";
import { requireCurrentOrganization } from "~/lib/current-org.server";
import { prisma } from "~/lib/db.server";
import { connectDiscoveredPartnerApps } from "~/lib/shopify/partner-app-discovery.server";
import {
  credentialsFromPartnerConnection,
  normalizePartnerOrganizationId,
  partnerConnectionErrorCode,
  partnerConnectionErrorMessage,
  partnerTokenLastFour,
  validatePartnerAccessToken,
  verifyPartnerAppConnection,
  verifyPartnerCredentials,
} from "~/lib/shopify/partner-connection.server";

export async function loader({ request }: Route.LoaderArgs) {
  const org = await requireCurrentOrganization(request);
  const connections = await prisma.shopifyPartnerConnection.findMany({
    where: { organizationId: org.id },
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { apps: true } },
      apps: {
        orderBy: { createdAt: "asc" },
        take: 1,
        select: {
          id: true,
          name: true,
          shopifyAppId: true,
          shopifyApiKey: true,
        },
      },
    },
  });

  return {
    connections: connections.map((connection) => ({
      id: connection.id,
      name: connection.name,
      partnerOrganizationId: connection.partnerOrganizationId,
      tokenLastFour: connection.tokenLastFour,
      status: connection.status,
      lastTestedAt: connection.lastTestedAt?.toISOString() ?? null,
      appCount: connection._count.apps,
      testAppName: connection.apps[0]?.name ?? null,
    })),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const org = await requireCurrentOrganization(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "create") {
    const name = String(form.get("name") ?? "").trim();
    if (!name || name.length > 100) {
      return { error: "Connection name is required (100 characters maximum)." };
    }

    try {
      const partnerOrganizationId = normalizePartnerOrganizationId(
        String(form.get("partnerOrganizationId") ?? ""),
      );
      const token = validatePartnerAccessToken(
        String(form.get("accessToken") ?? ""),
      );
      const existing = await prisma.shopifyPartnerConnection.findUnique({
        where: {
          organizationId_partnerOrganizationId: {
            organizationId: org.id,
            partnerOrganizationId,
          },
        },
      });
      if (existing) {
        return {
          error: `Partner organization ${partnerOrganizationId} already has a connection.`,
        };
      }

      await verifyPartnerCredentials({
        partnerOrganizationId,
        partnerApiToken: token,
      });
      const now = new Date();
      const connection = await prisma.shopifyPartnerConnection.create({
        data: {
          organizationId: org.id,
          name,
          partnerOrganizationId,
          encryptedAccessToken: encryptCredential(token),
          tokenLastFour: partnerTokenLastFour(token),
          status: "CONNECTED",
          lastTestedAt: now,
          lastConnectedAt: now,
        },
      });
      return redirect(`/app/apps?connectionId=${connection.id}`);
    } catch (error) {
      return { error: partnerConnectionErrorMessage(error) };
    }
  }

  if (intent === "update-token") {
    const connectionId = String(form.get("connectionId") ?? "");
    const connection = await prisma.shopifyPartnerConnection.findFirst({
      where: { id: connectionId, organizationId: org.id },
      include: {
        apps: {
          where: { shopifyAppId: { not: null } },
          orderBy: { createdAt: "asc" },
          take: 1,
        },
      },
    });
    if (!connection) {
      return { error: "Connection not found." };
    }
    try {
      const token = validatePartnerAccessToken(
        String(form.get("accessToken") ?? ""),
      );
      const app = connection.apps[0];
      if (app?.shopifyAppId) {
        await verifyPartnerAppConnection({
          credentials: {
            partnerOrganizationId: connection.partnerOrganizationId,
            partnerApiToken: token,
          },
          appId: app.shopifyAppId,
          clientId: app.shopifyApiKey,
        });
      } else {
        await verifyPartnerCredentials({
          partnerOrganizationId: connection.partnerOrganizationId,
          partnerApiToken: token,
        });
      }
      const now = new Date();
      await prisma.shopifyPartnerConnection.update({
        where: { id: connection.id },
        data: {
          encryptedAccessToken: encryptCredential(token),
          tokenLastFour: partnerTokenLastFour(token),
          status: "CONNECTED",
          lastTestedAt: now,
          lastConnectedAt: now,
          lastErrorCode: null,
        },
      });
      return { success: "Token updated and verified." };
    } catch (error) {
      return { error: partnerConnectionErrorMessage(error) };
    }
  }

  if (intent === "test") {
    const connectionId = String(form.get("connectionId") ?? "");
    const connection = await prisma.shopifyPartnerConnection.findFirst({
      where: { id: connectionId, organizationId: org.id },
      include: {
        apps: {
          where: { shopifyAppId: { not: null } },
          orderBy: { createdAt: "asc" },
          take: 1,
        },
      },
    });
    if (!connection) {
      return { error: "Connection not found." };
    }
    const app = connection.apps[0];
    try {
      const credentials = credentialsFromPartnerConnection(connection);
      if (app?.shopifyAppId) {
        await verifyPartnerAppConnection({
          credentials,
          appId: app.shopifyAppId,
          clientId: app.shopifyApiKey,
        });
      } else {
        await verifyPartnerCredentials(credentials);
      }
      const now = new Date();
      await prisma.shopifyPartnerConnection.update({
        where: { id: connection.id },
        data: {
          status: "CONNECTED",
          lastTestedAt: now,
          lastConnectedAt: now,
          lastErrorCode: null,
        },
      });
      return {
        success: app
          ? `Connected through ${app.name}.`
          : "Partner organization and token are connected. Add an app to verify Manage apps access.",
      };
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

  if (intent === "discover") {
    const connectionId = String(form.get("connectionId") ?? "");
    const connection = await prisma.shopifyPartnerConnection.findFirst({
      where: { id: connectionId, organizationId: org.id },
    });
    if (!connection) return { error: "Connection not found." };

    try {
      const result = await connectDiscoveredPartnerApps(org.id, connection.id);
      if (result.connected === 0) {
        return {
          error:
            "No added apps matched recent Shopify Partner event subjects. Enter an App ID manually from the Dev Dashboard.",
        };
      }
      return {
        success: `${result.connected} added app${result.connected === 1 ? "" : "s"} discovered, verified, and connected.${
          result.correctedClientIds
            ? ` Corrected ${result.correctedClientIds} mismatched Client ID${result.correctedClientIds === 1 ? "" : "s"} from Shopify.`
            : ""
        }`,
      };
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

  return { error: "Unknown connection action." };
}

function UpdateTokenControl({ connectionId }: { connectionId: string }) {
  const fetcher = useFetcher<{ success?: string; error?: string }>();
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const submitting = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data?.success) {
      setOpen(false);
      setToken("");
    }
  }, [fetcher.data]);

  const submit = () => {
    const formData = new FormData();
    formData.set("intent", "update-token");
    formData.set("connectionId", connectionId);
    formData.set("accessToken", token);
    fetcher.submit(formData, { method: "post" });
  };

  return (
    <>
      <Button
        variant="plain"
        onClick={() => {
          setToken("");
          setOpen(true);
        }}
      >
        Update token
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Update Partner API token"
        primaryAction={{
          content: "Save and verify",
          loading: submitting,
          disabled: !token,
          onAction: submit,
        }}
        secondaryActions={[
          { content: "Cancel", onAction: () => setOpen(false) },
        ]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            {fetcher.data?.error ? (
              <Banner tone="critical">{fetcher.data.error}</Banner>
            ) : null}
            <Text as="p" tone="subdued">
              Replaces this connection&apos;s stored token. It&apos;s
              verified against Shopify before saving — the old token stays
              in place if verification fails.
            </Text>
            <TextField
              label="New Partner API client access token"
              placeholder="prtapi_..."
              name="accessToken"
              type="password"
              value={token}
              onChange={setToken}
              autoComplete="new-password"
            />
          </BlockStack>
        </Modal.Section>
      </Modal>
    </>
  );
}

function statusBadge(status: "UNTESTED" | "CONNECTED" | "ERROR") {
  if (status === "CONNECTED") return <Badge tone="success">Connected</Badge>;
  if (status === "ERROR") return <Badge tone="critical">Check failed</Badge>;
  return <Badge tone="attention">Not tested</Badge>;
}

export default function Connections({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const [name, setName] = useState("Shopify Partner");
  const [partnerOrganizationId, setPartnerOrganizationId] = useState("");
  const [accessToken, setAccessToken] = useState("");

  return (
    <Page
      title="Shopify connections"
      subtitle="Connect a Partner organization once, then reuse it across your apps."
      primaryAction={{
        content: "Add app",
        url: "/app/apps",
      }}
    >
      <BlockStack gap="400">
        {actionData && "error" in actionData && actionData.error ? (
          <Banner tone="critical">{actionData.error}</Banner>
        ) : null}
        {actionData && "success" in actionData && actionData.success ? (
          <Banner tone="success">{actionData.success}</Banner>
        ) : null}

        <Banner
          tone="info"
          title="Partner access and merchant OAuth are separate"
        >
          This connection imports app lifecycle events and supports Partner
          credits. Billing a merchant still requires that shop&apos;s offline
          OAuth token.
        </Banner>

        <InlineGrid columns={{ xs: 1, md: "2fr 1fr" }} gap="400">
          <Card padding="0">
            {loaderData.connections.length === 0 ? (
              <ProductEmptyState
                title="Connect your Partner organization"
                description="Add one secure Partner connection, then reuse it across every Shopify app in this workspace."
                icon={ConnectIcon}
                action={{ content: "Add connection", url: "#add-connection" }}
              />
            ) : (
              <IndexTable
                resourceName={{
                  singular: "connection",
                  plural: "connections",
                }}
                itemCount={loaderData.connections.length}
                selectable={false}
                headings={[
                  { title: "Connection" },
                  { title: "Partner ID" },
                  { title: "Token" },
                  { title: "Apps" },
                  { title: "Status" },
                  { title: "Action" },
                ]}
              >
                {loaderData.connections.map((connection, index) => (
                  <IndexTable.Row
                    id={connection.id}
                    key={connection.id}
                    position={index}
                  >
                    <IndexTable.Cell>
                      <BlockStack gap="050">
                        <Text as="span" fontWeight="semibold">
                          {connection.name}
                        </Text>
                        {connection.testAppName ? (
                          <Text as="span" tone="subdued" variant="bodySm">
                            Tested with {connection.testAppName}
                          </Text>
                        ) : null}
                      </BlockStack>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {connection.partnerOrganizationId}
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      •••• {connection.tokenLastFour}
                    </IndexTable.Cell>
                    <IndexTable.Cell>{connection.appCount}</IndexTable.Cell>
                    <IndexTable.Cell>
                      {statusBadge(connection.status)}
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <InlineStack gap="200">
                        <Form method="post">
                          <input type="hidden" name="intent" value="test" />
                          <input
                            type="hidden"
                            name="connectionId"
                            value={connection.id}
                          />
                          <Button
                            submit
                            variant="plain"
                            loading={
                              navigation.state === "submitting" &&
                              navigation.formData?.get("intent") === "test" &&
                              navigation.formData?.get("connectionId") ===
                                connection.id
                            }
                          >
                            Test
                          </Button>
                        </Form>
                        <Form method="post">
                          <input type="hidden" name="intent" value="discover" />
                          <input
                            type="hidden"
                            name="connectionId"
                            value={connection.id}
                          />
                          <Button
                            submit
                            variant="plain"
                            loading={
                              navigation.state === "submitting" &&
                              navigation.formData?.get("intent") ===
                                "discover" &&
                              navigation.formData?.get("connectionId") ===
                                connection.id
                            }
                          >
                            Discover apps
                          </Button>
                        </Form>
                        <Link to={`/app/apps?connectionId=${connection.id}`}>
                          Add app
                        </Link>
                        <UpdateTokenControl connectionId={connection.id} />
                      </InlineStack>
                    </IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            )}
          </Card>

          <div id="add-connection">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Add Shopify connection
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  In Shopify Dev Dashboard, create a Partner API client with
                  <strong> Manage apps</strong>. Add
                  <strong> View financials</strong> only if you use app credits.
                </Text>
                <Form method="post">
                  <input type="hidden" name="intent" value="create" />
                  <FormLayout>
                    <TextField
                      label="Connection name"
                      name="name"
                      value={name}
                      onChange={setName}
                      autoComplete="off"
                      requiredIndicator
                    />
                    <TextField
                      label="Shopify Partner organization ID"
                      name="partnerOrganizationId"
                      value={partnerOrganizationId}
                      onChange={setPartnerOrganizationId}
                      autoComplete="off"
                      helpText="The numeric ID in your Shopify Dev Dashboard URL."
                      requiredIndicator
                    />
                    <TextField
                      label="Partner API client access token"
                      name="accessToken"
                      type="password"
                      value={accessToken}
                      onChange={setAccessToken}
                      autoComplete="new-password"
                      helpText="Encrypted before storage and never returned to the browser."
                      requiredIndicator
                    />
                    <Button submit variant="primary" loading={busy}>
                      Save connection and add app
                    </Button>
                  </FormLayout>
                </Form>
              </BlockStack>
            </Card>
          </div>
        </InlineGrid>
      </BlockStack>
    </Page>
  );
}
