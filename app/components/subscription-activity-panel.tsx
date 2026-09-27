import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  DataTable,
  EmptyState,
  InlineStack,
  Text,
} from "@shopify/polaris";
import { useEffect, useState, type ReactNode } from "react";
import { formatDate, formatDateTime, formatMoney } from "~/lib/format";
import { EMPTY_STATE_IMAGE } from "~/lib/ui";
import type { PartnerSubscriptionActivityResult } from "~/lib/shopify/partner-subscriptions.server";

type TableCell = string | number | ReactNode;

function eventLabel(type: string): string {
  return type
    .replace(/^SUBSCRIPTION_CHARGE_/, "")
    .toLowerCase()
    .replace(
      /(^|_)([a-z])/g,
      (_, prefix: string, letter: string) =>
        `${prefix ? " " : ""}${letter.toUpperCase()}`,
    );
}

function eventTone(
  type: string,
): "success" | "critical" | "warning" | "info" | undefined {
  if (type.endsWith("_ACTIVATED") || type.endsWith("_UNFROZEN")) {
    return "success";
  }
  if (
    type.endsWith("_CANCELED") ||
    type.endsWith("_DECLINED") ||
    type.endsWith("_EXPIRED")
  ) {
    return "critical";
  }
  if (type.endsWith("_FROZEN")) return "warning";
  if (type.endsWith("_ACCEPTED")) return "info";
  return undefined;
}

export function SubscriptionActivityPanel({
  data,
}: {
  data: PartnerSubscriptionActivityResult;
}) {
  const chunkSize = 20;
  const [visibleRows, setVisibleRows] = useState(chunkSize);
  useEffect(() => setVisibleRows(chunkSize), [data.events.length]);

  const rows: TableCell[][] = data.events.map((event) => [
    formatDateTime(event.occurredAt),
    event.appName,
    event.shopDomain,
    <Badge
      key={`${event.appId}-${event.chargeId}-${event.occurredAt}`}
      tone={eventTone(event.type)}
    >
      {eventLabel(event.type)}
    </Badge>,
    event.chargeName,
    formatMoney(Number(event.amount), event.currencyCode),
    event.billingOn ? formatDate(event.billingOn) : "—",
    event.test ? (
      <Badge
        key={`${event.chargeId}-${event.occurredAt}-test`}
        tone="attention"
      >
        Test
      </Badge>
    ) : (
      "Live"
    ),
  ]);
  const shown = Math.min(visibleRows, rows.length);

  return (
    <Card padding="0">
      <BlockStack gap="0">
        <div style={{ padding: "var(--p-space-400)" }}>
          <BlockStack gap="150">
            <Text as="h2" variant="headingMd">
              Latest Shopify subscription activity
            </Text>
            <Text as="p" tone="subdued" variant="bodySm">
              Loaded directly from the Partner API after the local subscription
              list renders. Amounts are Shopify values, not calculated MRR.
            </Text>
          </BlockStack>
        </div>
        {data.errors.length > 0 ? (
          <div
            style={{
              padding:
                "0 var(--p-space-400) var(--p-space-400) var(--p-space-400)",
            }}
          >
            <Banner tone="warning" title="Some apps could not be loaded">
              {data.errors
                .map((error) => `${error.appName}: ${error.message}`)
                .join(" ")}
            </Banner>
          </div>
        ) : null}
        {rows.length === 0 ? (
          <div style={{ padding: "var(--p-space-400)" }}>
            <EmptyState
              heading="No subscription events returned by Shopify"
              image={EMPTY_STATE_IMAGE}
            >
              <p>
                Check the selected app and ensure its Partner API client has
                Manage apps permission.
              </p>
            </EmptyState>
          </div>
        ) : (
          <DataTable
            columnContentTypes={[
              "text",
              "text",
              "text",
              "text",
              "text",
              "numeric",
              "text",
              "text",
            ]}
            headings={[
              "Occurred",
              "App",
              "Shop",
              "Event",
              "Shopify charge",
              "Amount",
              "Next billing",
              "Mode",
            ]}
            rows={rows.slice(0, shown)}
            increasedTableDensity
            stickyHeader
            pagination={
              rows.length > chunkSize
                ? {
                    hasPrevious: shown > chunkSize,
                    hasNext: shown < rows.length,
                    onPrevious: () =>
                      setVisibleRows((current) =>
                        Math.max(chunkSize, current - chunkSize),
                      ),
                    onNext: () =>
                      setVisibleRows((current) =>
                        Math.min(rows.length, current + chunkSize),
                      ),
                    label: `Showing 1–${shown} of ${rows.length}`,
                  }
                : undefined
            }
          />
        )}
        {rows.length > 0 && visibleRows > chunkSize ? (
          <div style={{ padding: "0 var(--p-space-400) var(--p-space-400)" }}>
            <InlineStack>
              <Button onClick={() => setVisibleRows(chunkSize)}>
                Collapse table
              </Button>
            </InlineStack>
          </div>
        ) : null}
      </BlockStack>
    </Card>
  );
}
