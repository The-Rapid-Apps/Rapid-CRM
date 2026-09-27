import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  Divider,
  InlineGrid,
  InlineStack,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import { useState } from "react";
import { Form, redirect, useNavigation, useSearchParams } from "react-router";
import type { Route } from "./+types/billing";
import {
  BILLING_ACCESS_QUERY_PARAM,
  requireBillingAccess,
} from "~/lib/billing-access.server";
import { prisma } from "~/lib/db.server";
import { findEligibleDiscountByCode } from "~/lib/flex/discounts.server";
import { subscribe } from "~/lib/flex/subscribe.server";
import { changeTier } from "~/lib/flex/tier-change.server";
import { formatMoney } from "~/lib/format";

const INTERVAL_LABEL: Record<string, string> = {
  EVERY_30_DAYS: "/mo",
  QUARTERLY: "/qtr",
  ANNUAL: "/yr",
};

export function headers() {
  return {
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
  };
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const access = requireBillingAccess(request, params.installId);
  const install = await prisma.appInstall.findUnique({
    where: { id: params.installId },
    include: { app: true },
  });
  if (!install) throw new Response("Install not found", { status: 404 });
  if (install.uninstalledAt) {
    throw new Response("This app is no longer installed.", { status: 410 });
  }

  const [plans, current] = await Promise.all([
    prisma.plan.findMany({
      where: {
        appId: install.appId,
        active: true,
        isPublic: true,
        flexBilling: true,
      },
      orderBy: [{ sortOrder: "asc" }, { amount: "asc" }],
    }),
    prisma.subscription.findFirst({
      where: { appInstallId: install.id, status: "ACTIVE", canceledAt: null },
      include: { plan: true },
    }),
  ]);

  return {
    actionUrl: `/billing/${encodeURIComponent(install.id)}?${new URLSearchParams(
      {
        [BILLING_ACCESS_QUERY_PARAM]: access.token,
      },
    )}`,
    appName: install.app.name,
    shop: install.shopDomain,
    currentPlanId: current?.planId ?? null,
    currentSubscriptionId: current?.id ?? null,
    plans: plans.map((p) => ({
      id: p.id,
      name: p.name,
      amount: Number(p.amount),
      currency: p.currencyCode,
      interval: p.interval,
      trialDays: p.trialDays,
      cap: Number(p.usageChargeCappedAmount),
      autoUpgrade: p.onUsageLimitReached === "UPGRADE",
      limitMetric: p.limitMetric,
      limitMax: p.limitMax ? Number(p.limitMax) : null,
    })),
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const access = requireBillingAccess(request, params.installId);
  const install = await prisma.appInstall.findUnique({
    where: { id: params.installId },
    select: {
      id: true,
      appId: true,
      uninstalledAt: true,
    },
  });
  if (!install) throw new Response("Install not found", { status: 404 });
  if (install.uninstalledAt) {
    throw new Response("This app is no longer installed.", { status: 410 });
  }

  const form = await request.formData();
  const intent = String(form.get("intent"));
  const planId = String(form.get("planId"));
  const discountCode = String(form.get("discountCode") ?? "").trim();
  const plan = await prisma.plan.findFirst({
    where: {
      id: planId,
      appId: install.appId,
      active: true,
      isPublic: true,
      flexBilling: true,
    },
    select: { id: true },
  });
  if (!plan) throw new Response("Plan not found", { status: 404 });

  let discountId: string | undefined;
  if (discountCode) {
    const resolution = await findEligibleDiscountByCode({
      appId: install.appId,
      planId: plan.id,
      code: discountCode,
    });
    if (!resolution.valid) {
      return {
        error: "That discount code is not valid for this plan.",
        discountReason: resolution.reason,
      };
    }
    discountId = resolution.discount.id;
  }

  try {
    if (intent === "subscribe") {
      const result = await subscribe({
        appInstallId: install.id,
        planId: plan.id,
        discountId,
      });
      return redirect(result.confirmationUrl);
    }

    if (intent === "change") {
      const subscriptionId = String(form.get("subscriptionId"));
      const subscription = await prisma.subscription.findFirst({
        where: {
          id: subscriptionId,
          appInstallId: install.id,
          status: "ACTIVE",
          canceledAt: null,
        },
        select: { id: true },
      });
      if (!subscription) {
        throw new Response("Subscription not found", { status: 404 });
      }

      const result = await changeTier({
        subscriptionId: subscription.id,
        newPlanId: plan.id,
        discountId,
      });
      if (result.status === "confirmation_required") {
        return redirect(result.confirmationUrl);
      }
      const destination = new URL(
        `/billing/${encodeURIComponent(install.id)}`,
        request.url,
      );
      destination.searchParams.set(BILLING_ACCESS_QUERY_PARAM, access.token);
      destination.searchParams.set("changed", "1");
      return redirect(`${destination.pathname}${destination.search}`);
    }
  } catch (error) {
    if (error instanceof Response) throw error;
    return {
      error:
        error instanceof Error
          ? error.message
          : "The billing request could not be completed.",
    };
  }

  throw new Response("Unsupported billing action", { status: 400 });
}

export default function Billing({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const {
    actionUrl,
    appName,
    shop,
    plans,
    currentPlanId,
    currentSubscriptionId,
  } = loaderData;
  const [searchParams] = useSearchParams();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const [discountCode, setDiscountCode] = useState("");

  const activated = searchParams.get("activated");
  const changed = searchParams.get("changed");

  return (
    <Page
      title="Choose your plan"
      subtitle={`${appName} · ${shop}`}
      narrowWidth={plans.length <= 2}
    >
      <BlockStack gap="400">
        {activated === "1" ? (
          <Banner tone="success" title="Subscription active">
            <p>Your plan is active. Thanks!</p>
          </Banner>
        ) : null}
        {activated === "0" ? (
          <Banner tone="warning" title="Not confirmed">
            <p>The subscription wasn't approved. You can try again below.</p>
          </Banner>
        ) : null}
        {changed === "1" ? (
          <Banner tone="success" title="Plan updated">
            <p>Your plan was changed with no re-approval needed.</p>
          </Banner>
        ) : null}
        {actionData && "error" in actionData ? (
          <Banner tone="critical" title="Discount could not be applied">
            <p>{actionData.error}</p>
          </Banner>
        ) : null}

        <Card>
          <TextField
            label="Discount code (optional)"
            value={discountCode}
            onChange={setDiscountCode}
            autoComplete="off"
            maxLength={191}
            helpText="The code is checked against the plan you choose."
          />
        </Card>

        <InlineGrid
          columns={{ xs: 1, sm: 2, md: Math.min(plans.length, 4) || 1 }}
          gap="400"
        >
          {plans.map((plan) => {
            const isCurrent = plan.id === currentPlanId;
            return (
              <Card key={plan.id}>
                <BlockStack gap="400">
                  <BlockStack gap="100">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="h2" variant="headingMd">
                        {plan.name}
                      </Text>
                      {isCurrent ? <Badge tone="success">Current</Badge> : null}
                    </InlineStack>
                    <InlineStack gap="100" blockAlign="baseline">
                      <Text as="span" variant="heading2xl">
                        {formatMoney(plan.amount, plan.currency)}
                      </Text>
                      <Text as="span" tone="subdued" variant="bodySm">
                        {INTERVAL_LABEL[plan.interval] ?? ""}
                      </Text>
                    </InlineStack>
                  </BlockStack>

                  <Divider />

                  <BlockStack gap="150">
                    {plan.trialDays > 0 ? (
                      <Text as="p" variant="bodySm">
                        ✓ {plan.trialDays}-day free trial
                      </Text>
                    ) : null}
                    <Text as="p" variant="bodySm">
                      ✓ Flexible usage-based billing
                    </Text>
                    {plan.autoUpgrade && plan.limitMetric && plan.limitMax ? (
                      <Text as="p" variant="bodySm" tone="subdued">
                        Auto-upgrades above {plan.limitMax} {plan.limitMetric}
                      </Text>
                    ) : null}
                  </BlockStack>

                  {isCurrent ? (
                    <Button disabled fullWidth>
                      Current plan
                    </Button>
                  ) : currentSubscriptionId ? (
                    <Form method="post" action={actionUrl}>
                      <input type="hidden" name="intent" value="change" />
                      <input type="hidden" name="planId" value={plan.id} />
                      <input
                        type="hidden"
                        name="subscriptionId"
                        value={currentSubscriptionId}
                      />
                      <input
                        type="hidden"
                        name="discountCode"
                        value={discountCode}
                      />
                      <Button submit variant="primary" fullWidth loading={busy}>
                        Switch to {plan.name}
                      </Button>
                    </Form>
                  ) : (
                    <Form method="post" action={actionUrl}>
                      <input type="hidden" name="intent" value="subscribe" />
                      <input type="hidden" name="planId" value={plan.id} />
                      <input
                        type="hidden"
                        name="discountCode"
                        value={discountCode}
                      />
                      <Button submit variant="primary" fullWidth loading={busy}>
                        {plan.trialDays > 0 ? "Start free trial" : "Subscribe"}
                      </Button>
                    </Form>
                  )}
                </BlockStack>
              </Card>
            );
          })}
        </InlineGrid>

        <Text as="p" variant="bodySm" tone="subdued" alignment="center">
          Plan changes are pro-rated and apply instantly — no Shopify
          re-approval.
        </Text>
      </BlockStack>
    </Page>
  );
}
