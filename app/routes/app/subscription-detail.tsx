import { useMemo, useState } from "react";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  DataTable,
  DescriptionList,
  InlineStack,
  Layout,
  Modal,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { Form, redirect, useNavigation, useSubmit } from "react-router";
import type { Route } from "./+types/subscription-detail";
import { prisma } from "~/lib/db.server";
import { requireCurrentOrganization } from "~/lib/current-org.server";
import { changeTier } from "~/lib/flex/tier-change.server";
import { loadSubscriptionContext } from "~/lib/flex/context.server";
import {
  cancelSubscription,
  pauseSubscription,
  resumeSubscription,
  SubscriptionManagementError,
} from "~/lib/flex/subscription-management.server";
import {
  formatDate,
  formatDateTime,
  formatMoney,
  statusTone,
} from "~/lib/format";
import { useBackAction } from "~/lib/use-back-action";

export async function loader({ request, params }: Route.LoaderArgs) {
  const org = await requireCurrentOrganization(request);
  const ctx = await loadSubscriptionContext(params.id);
  if (!ctx || ctx.appInstall.app.organizationId !== org.id) {
    throw new Response("Not found", { status: 404 });
  }

  const [charges, events, plans, latestReplacement] = await Promise.all([
    prisma.charge.findMany({
      where: { subscriptionId: ctx.id },
      orderBy: { occurredAt: "desc" },
      take: 50,
    }),
    prisma.flexBillingEvent.findMany({
      where: { subscriptionId: ctx.id },
      orderBy: { date: "desc" },
      take: 20,
    }),
    prisma.plan.findMany({
      where: { appId: ctx.appInstall.appId, active: true, flexBilling: true },
      orderBy: [{ sortOrder: "asc" }, { amount: "asc" }],
    }),
    prisma.subscription.findFirst({
      where: { replacesSubscriptionId: ctx.id },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        status: true,
        confirmationUrl: true,
        approvalExpiresAt: true,
        plan: { select: { name: true } },
      },
    }),
  ]);

  return {
    sub: {
      id: ctx.id,
      shop: ctx.appInstall.shopDomain,
      status: ctx.status,
      test: ctx.test,
      planId: ctx.plan.id,
      planName: ctx.plan.name,
      amount: Number(ctx.plan.amount),
      currency: ctx.plan.currencyCode,
      interval: ctx.plan.interval,
      currentPeriodStart: ctx.currentPeriodStart?.toISOString() ?? null,
      currentPeriodEnd: ctx.currentPeriodEnd?.toISOString() ?? null,
      nextBillingDate: ctx.nextBillingDate?.toISOString() ?? null,
      trialEndsAt: ctx.trialEndsAt?.toISOString() ?? null,
      pausedUntil: ctx.pausedUntil?.toISOString() ?? null,
      shopifySubscriptionId: ctx.shopifySubscriptionId,
      confirmationUrl: ctx.status === "PENDING" ? ctx.confirmationUrl : null,
      approvalExpiresAt: ctx.approvalExpiresAt?.toISOString() ?? null,
      replacesSubscriptionId: ctx.replacesSubscriptionId,
    },
    latestReplacement: latestReplacement
      ? {
          ...latestReplacement,
          approvalExpiresAt:
            latestReplacement.approvalExpiresAt?.toISOString() ?? null,
        }
      : null,
    plans: plans.map((p) => ({
      id: p.id,
      name: p.name,
      amount: Number(p.amount),
      currency: p.currencyCode,
    })),
    charges: charges.map((c) => ({
      id: c.id,
      date: c.occurredAt.toISOString(),
      description: c.description ?? "",
      amount: Number(c.amount),
      currency: c.chargedCurrencyCode,
      isCredit: c.isCredit,
      status: c.status,
    })),
    events: events.map((e) => ({
      id: e.id,
      type: e.type,
      date: e.date.toISOString(),
      proration: e.proration,
      prorationAmount: e.prorationAmount ? Number(e.prorationAmount) : null,
    })),
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const org = await requireCurrentOrganization(request);
  const ctx = await loadSubscriptionContext(params.id);
  if (!ctx || ctx.appInstall.app.organizationId !== org.id) {
    throw new Response("Not found", { status: 404 });
  }

  const form = await request.formData();
  const intent = String(form.get("intent"));

  try {
    if (intent === "change-tier") {
      const newPlanId = String(form.get("newPlanId"));
      const result = await changeTier({
        subscriptionId: params.id,
        newPlanId,
      });
      if (result.status === "confirmation_required") {
        return redirect(result.confirmationUrl);
      }
      return redirect(`/app/subscriptions/${result.subscriptionId}`);
    }

    if (intent === "pause") {
      const pauseDate = String(form.get("pausedUntil") ?? "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(pauseDate)) {
        return { error: "Choose a valid pause-until date." };
      }
      await pauseSubscription({
        subscriptionId: params.id,
        appId: ctx.appInstall.appId,
        pausedUntil: new Date(`${pauseDate}T23:59:59.999Z`),
      });
      return redirect(`/app/subscriptions/${params.id}`);
    }

    if (intent === "resume") {
      await resumeSubscription({
        subscriptionId: params.id,
        appId: ctx.appInstall.appId,
      });
      return redirect(`/app/subscriptions/${params.id}`);
    }

    if (intent === "cancel") {
      await cancelSubscription({
        subscriptionId: params.id,
        appId: ctx.appInstall.appId,
      });
      return redirect(`/app/subscriptions/${params.id}`);
    }

    return { error: "Unsupported subscription action." };
  } catch (error) {
    return {
      error:
        error instanceof SubscriptionManagementError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Subscription action failed.",
    };
  }
}

export default function SubscriptionDetail({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const backAction = useBackAction({ content: "Subscriptions", url: "/app/subscriptions" });
  const { sub, plans, charges, events, latestReplacement } = loaderData;
  const navigation = useNavigation();
  const submit = useSubmit();
  const busy = navigation.state !== "idle";
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);

  const otherPlans = plans.filter((p) => p.id !== sub.planId);
  const [targetPlanId, setTargetPlanId] = useState(otherPlans[0]?.id ?? "");
  const defaultPauseDate = useMemo(() => {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() + 30);
    return date.toISOString().slice(0, 10);
  }, []);
  const [pauseDate, setPauseDate] = useState(defaultPauseDate);

  // Client-side day-based proration preview (mirrors spec §5 math).
  const prorationPreview = useMemo(() => {
    const target = plans.find((p) => p.id === targetPlanId);
    if (!target || !sub.currentPeriodStart || !sub.currentPeriodEnd)
      return null;
    const MS = 86_400_000;
    const start = new Date(sub.currentPeriodStart).getTime();
    const end = new Date(sub.currentPeriodEnd).getTime();
    const today = Date.now();
    const daysInCycle = Math.round((end - start) / MS);
    if (daysInCycle <= 0) return { net: 0, direction: "none" as const };
    const daysRemaining = Math.max(
      0,
      Math.min(daysInCycle, Math.round((end - today) / MS)),
    );
    const net = ((target.amount - sub.amount) / daysInCycle) * daysRemaining;
    return {
      net,
      currency: target.currency,
      direction:
        net > 0
          ? ("charge" as const)
          : net < 0
            ? ("credit" as const)
            : ("none" as const),
    };
  }, [targetPlanId, plans, sub]);

  return (
    <Page
      title={sub.shop}
      subtitle={`${sub.planName} · ${formatMoney(sub.amount, sub.currency)}`}
      backAction={backAction}
      titleMetadata={<Badge tone={statusTone(sub.status)}>{sub.status}</Badge>}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {actionData && "error" in actionData && actionData.error ? (
              <Banner tone="critical" title="Subscription action failed">
                <p>{actionData.error}</p>
              </Banner>
            ) : null}
            {sub.pausedUntil ? (
              <Banner tone="warning" title="Subscription paused">
                <p>
                  Paused until {formatDate(sub.pausedUntil)}. The charge cron
                  skips it until then.
                </p>
              </Banner>
            ) : null}
            {sub.status === "PENDING" && sub.confirmationUrl ? (
              <Banner tone="warning" title="Awaiting merchant approval">
                <p>
                  Approval expires {formatDateTime(sub.approvalExpiresAt)}.{" "}
                  <a
                    href={sub.confirmationUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open Shopify confirmation
                  </a>
                </p>
              </Banner>
            ) : null}
            {latestReplacement?.status === "PENDING" ? (
              <Banner tone="warning" title="Replacement awaiting approval">
                <p>
                  {latestReplacement.plan.name} will replace this subscription
                  after merchant approval. Expires{" "}
                  {formatDateTime(latestReplacement.approvalExpiresAt)}.
                </p>
              </Banner>
            ) : null}

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Billing details
                </Text>
                <DescriptionList
                  items={[
                    { term: "Plan", description: sub.planName },
                    {
                      term: "Amount",
                      description: formatMoney(sub.amount, sub.currency),
                    },
                    { term: "Interval", description: sub.interval },
                    {
                      term: "Current period",
                      description: `${formatDate(sub.currentPeriodStart)} → ${formatDate(sub.currentPeriodEnd)}`,
                    },
                    {
                      term: "Next billing",
                      description: formatDate(sub.nextBillingDate),
                    },
                    {
                      term: "Trial ends",
                      description: sub.trialEndsAt
                        ? formatDate(sub.trialEndsAt)
                        : "No trial",
                    },
                    {
                      term: "Shopify subscription",
                      description: sub.shopifySubscriptionId ?? "—",
                    },
                    ...(sub.replacesSubscriptionId
                      ? [
                          {
                            term: "Replaces subscription",
                            description: sub.replacesSubscriptionId,
                          },
                        ]
                      : []),
                  ]}
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Charges
                </Text>
                {charges.length === 0 ? (
                  <Text as="p" tone="subdued">
                    No charges yet.
                  </Text>
                ) : (
                  <DataTable
                    columnContentTypes={["text", "text", "text", "numeric"]}
                    headings={["Date", "Description", "Status", "Amount"]}
                    rows={charges.map((c) => [
                      formatDateTime(c.date),
                      c.description || (c.isCredit ? "Credit" : "Charge"),
                      c.status,
                      `${c.isCredit ? "−" : ""}${formatMoney(c.amount, c.currency)}`,
                    ])}
                  />
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Activity
                </Text>
                {events.length === 0 ? (
                  <Text as="p" tone="subdued">
                    No events yet.
                  </Text>
                ) : (
                  <DataTable
                    columnContentTypes={["text", "text", "numeric"]}
                    headings={["Event", "Date", "Proration"]}
                    rows={events.map((e) => [
                      e.type,
                      formatDateTime(e.date),
                      e.proration && e.prorationAmount != null
                        ? formatMoney(e.prorationAmount, sub.currency)
                        : "—",
                    ])}
                  />
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Change tier
                </Text>
                {otherPlans.length === 0 ? (
                  <Text as="p" tone="subdued">
                    No other plans to switch to.
                  </Text>
                ) : (
                  <Form method="post">
                    <input type="hidden" name="intent" value="change-tier" />
                    <input
                      type="hidden"
                      name="newPlanId"
                      value={targetPlanId}
                    />
                    <BlockStack gap="300">
                      <Select
                        label="Move to"
                        options={otherPlans.map((p) => ({
                          label: `${p.name} — ${formatMoney(p.amount, p.currency)}`,
                          value: p.id,
                        }))}
                        value={targetPlanId}
                        onChange={setTargetPlanId}
                      />
                      {prorationPreview &&
                      prorationPreview.direction !== "none" ? (
                        <Text as="p" variant="bodySm" tone="subdued">
                          {prorationPreview.direction === "charge"
                            ? `Pro-rated charge now: ${formatMoney(prorationPreview.net, prorationPreview.currency)}`
                            : `Pro-rated credit: ${formatMoney(Math.abs(prorationPreview.net), prorationPreview.currency)}`}
                        </Text>
                      ) : (
                        <Text as="p" variant="bodySm" tone="subdued">
                          No proration — commits in place.
                        </Text>
                      )}
                      <Button
                        submit
                        variant="primary"
                        loading={busy}
                        disabled={sub.status !== "ACTIVE"}
                      >
                        Change plan
                      </Button>
                      <Text as="p" variant="bodySm" tone="subdued">
                        In-place — no Shopify re-approval unless the cap can't
                        fit an upgrade.
                      </Text>
                    </BlockStack>
                  </Form>
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Manage
                </Text>
                <InlineStack gap="200">
                  {sub.pausedUntil ? (
                    <Form method="post">
                      <input type="hidden" name="intent" value="resume" />
                      <Button submit loading={busy}>
                        Resume
                      </Button>
                    </Form>
                  ) : (
                    <Form method="post">
                      <input type="hidden" name="intent" value="pause" />
                      <BlockStack gap="200">
                        <TextField
                          label="Pause until (UTC)"
                          name="pausedUntil"
                          type="date"
                          value={pauseDate}
                          onChange={setPauseDate}
                          autoComplete="off"
                          min={new Date().toISOString().slice(0, 10)}
                        />
                        <Button
                          submit
                          loading={busy}
                          disabled={sub.status !== "ACTIVE"}
                        >
                          Pause
                        </Button>
                      </BlockStack>
                    </Form>
                  )}
                  <Button
                    tone="critical"
                    loading={busy}
                    disabled={sub.status === "CANCELLED"}
                    onClick={() => setCancelDialogOpen(true)}
                  >
                    Cancel
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
      <Modal
        open={cancelDialogOpen}
        onClose={() => setCancelDialogOpen(false)}
        title="Cancel Shopify subscription?"
        primaryAction={{
          content: "Cancel subscription",
          destructive: true,
          loading: busy,
          onAction: () => {
            setCancelDialogOpen(false);
            void submit({ intent: "cancel" }, { method: "post" });
          },
        }}
        secondaryActions={[
          {
            content: "Keep subscription",
            onAction: () => setCancelDialogOpen(false),
          },
        ]}
      >
        <Modal.Section>
          <BlockStack gap="200">
            <Text as="p">
              This ends billing for <strong>{sub.shop}</strong> on the{" "}
              <strong>{sub.planName}</strong> plan.
            </Text>
            <Text as="p" tone="subdued">
              This action cannot be undone. You can create a new subscription
              later, but the merchant may need to approve it again in Shopify.
            </Text>
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
