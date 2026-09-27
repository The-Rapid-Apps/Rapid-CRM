import {
  Badge,
  BlockStack,
  Box,
  Card,
  IndexTable,
  InlineGrid,
  InlineStack,
  Link,
  Page,
  Text,
} from "@shopify/polaris";
import type { Route } from "./+types/discount-detail";
import { requireUser } from "~/lib/auth/session.server";
import { resolveCustomerNames, customerLabel } from "~/lib/customer-name.server";
import { prisma } from "~/lib/db.server";
import { flexDiscountState, nativeRedemptionState } from "~/lib/flex/discount-merchants";
import { formatDate, formatMoney } from "~/lib/format";
import { useBackAction } from "~/lib/use-back-action";

/**
 * One discount and the merchants it reached: who is still getting it, and
 * who was — with why it ended (canceled, discount period over).
 *
 * Organization-scoped in the lookup itself; an id from another tenant is a 404.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const discount = await prisma.discount.findFirst({
    where: { id: params.id, organizationId: user.organizationId },
    include: {
      app: { select: { id: true, name: true } },
      apps: { select: { app: { select: { id: true, name: true } } } },
      redemptions: {
        where: { status: "APPLIED" },
        orderBy: { appliedAt: "desc" },
        take: 500,
        include: { app: { select: { name: true } } },
      },
      subscriptionDiscounts: {
        orderBy: { startsAt: "desc" },
        take: 500,
        include: {
          subscription: {
            select: {
              status: true,
              canceledAt: true,
              appInstall: { select: { shopDomain: true, appId: true, app: { select: { name: true } } } },
              plan: { select: { name: true, amount: true, currencyCode: true, interval: true } },
            },
          },
        },
      },
    },
  });
  if (!discount) throw new Response("Discount not found", { status: 404 });

  /* The Shopify subscription's live state, one query for all redemptions.
     Same gid format on both sides (checked against production). */
  const chargeIds = discount.redemptions
    .map((r) => r.shopifySubscriptionId)
    .filter((id): id is string => Boolean(id));
  const partnerStates = chargeIds.length
    ? await prisma.partnerSubscriptionState.findMany({
        where: { chargePlatformId: { in: chargeIds } },
        select: { appId: true, chargePlatformId: true, status: true },
      })
    : [];
  const statusByCharge = new Map(
    partnerStates.map((row) => [`${row.appId}|${row.chargePlatformId}`, row.status]),
  );

  const now = new Date();
  const names = await resolveCustomerNames([
    ...discount.redemptions.map((r) => r.shopDomain),
    ...discount.subscriptionDiscounts.map((sd) => sd.subscription.appInstall.shopDomain),
  ]);

  type Row = {
    key: string;
    shopDomain: string;
    name: string;
    appId: string;
    app: string;
    plan: string;
    listPrice: number;
    price: number;
    currency: string;
    yearly: boolean;
    since: string | null;
    state: ReturnType<typeof nativeRedemptionState>;
  };

  const rows: Row[] = [
    ...discount.redemptions.map((r) => ({
      key: `r-${r.id}`,
      shopDomain: r.shopDomain,
      name: customerLabel(r.shopDomain, names),
      appId: r.appId,
      app: r.app.name,
      plan: r.externalPlanKey,
      listPrice: Number(r.listPrice),
      price: Number(r.priceAfterDiscount),
      currency: r.currencyCode,
      yearly: /(year|annual)/i.test(r.externalPlanKey),
      since: (r.appliedAt ?? r.reservedAt).toISOString(),
      state: nativeRedemptionState({
        appliedAt: r.appliedAt,
        durationIntervals: r.durationIntervals,
        externalPlanKey: r.externalPlanKey,
        subscriptionStatus: r.shopifySubscriptionId
          ? (statusByCharge.get(`${r.appId}|${r.shopifySubscriptionId}`) ?? null)
          : null,
        now,
      }),
    })),
    ...discount.subscriptionDiscounts.map((sd) => {
      const sub = sd.subscription;
      const list = Number(sub.plan.amount);
      return {
        key: `s-${sd.id}`,
        shopDomain: sub.appInstall.shopDomain,
        name: customerLabel(sub.appInstall.shopDomain, names),
        appId: sub.appInstall.appId,
        app: sub.appInstall.app.name,
        plan: sub.plan.name,
        listPrice: list,
        // The flex engine applies the discount at charge time; show the terms.
        price:
          discount.type === "PERCENTAGE"
            ? Math.max(0, list * (1 - Number(discount.value) / 100))
            : discount.type === "AMOUNT"
              ? Math.max(0, list - Number(discount.value))
              : Math.min(list, Number(discount.value)),
        currency: sub.plan.currencyCode,
        yearly: sub.plan.interval === "ANNUAL",
        since: sd.startsAt.toISOString(),
        state: flexDiscountState({
          endsAt: sd.endsAt,
          subscriptionStatus: sub.status,
          canceledAt: sub.canceledAt,
          now,
        }),
      };
    }),
  ];

  const appNames = [
    ...new Set([discount.app.name, ...discount.apps.map((row) => row.app.name)]),
  ];
  return {
    discount: {
      id: discount.id,
      code: discount.code ?? "",
      description: discount.description,
      active: discount.active,
      value:
        discount.type === "PERCENTAGE"
          ? `${discount.value.toString()}% off`
          : discount.type === "AMOUNT"
            ? `${formatMoney(discount.value.toString(), discount.currencyCode ?? "USD")} off`
            : `${formatMoney(discount.value.toString(), discount.currencyCode ?? "USD")} final price`,
      duration: discount.durationIntervals
        ? `${discount.durationIntervals} billing period${discount.durationIntervals === 1 ? "" : "s"}`
        : "Forever",
      limit: discount.maxRedemptions ? `${discount.maxRedemptions} total` : "No limit",
      appNames,
    },
    active: rows.filter((row) => row.state.active),
    expired: rows.filter((row) => !row.state.active),
  };
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `${loaderData?.discount.code ?? "Discount"} · Discounts · Rapid` }];
}

type MerchantRow = Route.ComponentProps["loaderData"]["active"][number];

function MerchantTable({ rows, empty, expired }: { rows: MerchantRow[]; empty: string; expired: boolean }) {
  return (
    <IndexTable
      resourceName={{ singular: "merchant", plural: "merchants" }}
      itemCount={rows.length}
      selectable={false}
      emptyState={
        <Box padding="600">
          <Text as="p" tone="subdued" alignment="center">
            {empty}
          </Text>
        </Box>
      }
      headings={[
        { title: "Merchant" },
        { title: "Plan" },
        { title: "Price", alignment: "end" },
        { title: "Started" },
      ]}
    >
      {rows.map((row, index) => (
        <IndexTable.Row id={row.key} key={row.key} position={index}>
          <IndexTable.Cell>
            <BlockStack gap="050">
              <Link
                url={`/app/customers/${encodeURIComponent(row.shopDomain)}?app=${row.appId}`}
                removeUnderline
              >
                <Text as="span" fontWeight="medium">
                  {row.name}
                </Text>
              </Link>
              <Text as="span" tone="subdued" variant="bodySm">
                {row.app}
              </Text>
            </BlockStack>
          </IndexTable.Cell>
          <IndexTable.Cell>
            <InlineStack gap="150" blockAlign="center">
              <Text as="span" textDecorationLine={expired ? "line-through" : undefined}>
                {row.plan}
              </Text>
              {"reason" in row.state ? <Badge tone="critical">{row.state.reason}</Badge> : null}
              {"note" in row.state && row.state.note ? (
                <Badge tone="attention">{row.state.note}</Badge>
              ) : null}
            </InlineStack>
          </IndexTable.Cell>
          <IndexTable.Cell>
            <BlockStack gap="050" inlineAlign="end">
              <Text as="span" tone="subdued" textDecorationLine="line-through" numeric>
                {`${formatMoney(String(row.listPrice), row.currency)}${row.yearly ? "/yr" : "/mo"}`}
              </Text>
              <Text as="span" fontWeight="medium" numeric>
                {`${formatMoney(String(row.price), row.currency)}${row.yearly ? "/yr" : "/mo"}`}
              </Text>
            </BlockStack>
          </IndexTable.Cell>
          <IndexTable.Cell>{row.since ? formatDate(row.since) : "—"}</IndexTable.Cell>
        </IndexTable.Row>
      ))}
    </IndexTable>
  );
}

export default function DiscountDetail({ loaderData }: Route.ComponentProps) {
  const { discount, active, expired } = loaderData;
  const backAction = useBackAction({ content: "Discounts", url: "/app/discounts" });

  return (
    <Page
      title={discount.code}
      subtitle={discount.description ?? undefined}
      backAction={backAction}
      titleMetadata={
        <Badge tone={discount.active ? "success" : undefined}>
          {discount.active ? "Active" : "Inactive"}
        </Badge>
      }
    >
      <BlockStack gap="400">
        <Card>
          <InlineGrid columns={{ xs: 2, md: 4 }} gap="400">
            {[
              ["Benefit", discount.value],
              ["Duration", discount.duration],
              ["Redemption limit", discount.limit],
              ["Available in", discount.appNames.join(", ")],
            ].map(([label, value]) => (
              <BlockStack gap="050" key={label}>
                <Text as="span" tone="subdued" variant="bodySm">
                  {label}
                </Text>
                <Text as="span" fontWeight="medium">
                  {value}
                </Text>
              </BlockStack>
            ))}
          </InlineGrid>
        </Card>

        <Card padding="0">
          <Box padding="400" paddingBlockEnd="200">
            <Text as="h2" variant="headingMd">
              {`Active merchants (${active.length})`}
            </Text>
          </Box>
          <MerchantTable
            rows={active}
            expired={false}
            empty="No merchant is getting this discount right now."
          />
        </Card>

        <Card padding="0">
          <Box padding="400" paddingBlockEnd="200">
            <Text as="h2" variant="headingMd">
              {`Expired merchants (${expired.length})`}
            </Text>
          </Box>
          <MerchantTable
            rows={expired}
            expired
            empty="No merchant has stopped getting this discount yet."
          />
        </Card>
      </BlockStack>
    </Page>
  );
}
