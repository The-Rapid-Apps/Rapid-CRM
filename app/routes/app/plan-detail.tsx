import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  InlineStack,
  Link,
  Page,
  Text,
} from "@shopify/polaris";
import { Form, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/plan-detail";
import { PlanFormFields, type PlanFormValues } from "~/components/plan-form-fields";
import { prisma } from "~/lib/db.server";
import { requireCurrentOrganization } from "~/lib/current-org.server";
import { formatMoney } from "~/lib/format";
import { type PlanFeatureType } from "~/lib/plans/features";
import {
  isPlanFormError,
  liveCapCeiling,
  parsePlanForm,
} from "~/lib/plans/plan-form.server";
import { useBackAction } from "~/lib/use-back-action";

export async function loader({ request, params }: Route.LoaderArgs) {
  /* `/app/plans/observed` is a sibling STATIC route, and React Router ranks a
     static segment above `:planId` — so this should never see it. It is
     guarded anyway because the failure mode is opaque: the route matches, the
     id finds no plan, and the user gets "No result found for routeId
     routes/app/plan-detail" with nothing pointing at the real cause. A
     redirect that keeps the query string costs one comparison. */
  if (params.planId === "observed") {
    const { search } = new URL(request.url);
    throw redirect(`/app/plans/observed${search}`);
  }

  const org = await requireCurrentOrganization(request);
  const plan = await prisma.plan.findFirst({
    where: { id: params.planId, app: { organizationId: org.id } },
    include: {
      app: { select: { id: true, name: true } },
      entitlements: { select: { featureId: true, value: true } },
    },
  });
  if (!plan) throw new Response("Plan not found", { status: 404 });

  const [features, targets, counts, ceiling] = await Promise.all([
    prisma.planFeature.findMany({
      where: { appId: plan.appId, archivedAt: null },
      orderBy: [{ sortOrder: "asc" }, { key: "asc" }],
      select: { id: true, appId: true, name: true, type: true, defaultValue: true },
    }),
    /*
      Candidate auto-upgrade targets, narrowed the way the action re-checks
      them — active, public, flex, and never this plan itself.
    */
    prisma.plan.findMany({
      where: {
        appId: plan.appId,
        id: { not: plan.id },
        active: true,
        isPublic: true,
        flexBilling: true,
      },
      orderBy: { amount: "asc" },
      select: { id: true, appId: true, name: true, amount: true, currencyCode: true },
    }),
    prisma.subscription.groupBy({
      by: ["status"],
      where: { planId: plan.id, canceledAt: null },
      _count: { _all: true },
    }),
    liveCapCeiling(plan.id),
  ]);

  const entitlements = Object.fromEntries(
    plan.entitlements.map((e) => [e.featureId, e.value]),
  );

  return {
    plan: {
      id: plan.id,
      appId: plan.appId,
      appName: plan.app.name,
      name: plan.name,
      active: plan.active,
      flexBilling: plan.flexBilling,
      currency: plan.currencyCode,
      amount: Number(plan.amount),
    },
    values: {
      appId: plan.appId,
      name: plan.name,
      description: plan.description ?? "",
      amount: trimDecimal(plan.amount.toString()),
      cap: trimDecimal(plan.usageChargeCappedAmount.toString()),
      trialDays: String(plan.trialDays),
      interval: plan.interval,
      isPublic: plan.isPublic,
      flexBilling: plan.flexBilling,
      usageBilling: plan.usageBilling,
      limitMetric: plan.limitMetric ?? "",
      limitMax: plan.limitMax ? trimDecimal(plan.limitMax.toString()) : "",
      revenueCap: plan.revenueCapLimit
        ? trimDecimal(plan.revenueCapLimit.toString())
        : "",
      revenueCapPeriod: plan.revenueCapPeriod,
      autoUpgradeToPlanId: plan.autoUpgradeToPlanId ?? "",
      // Checked when the plan already says something about a feature, so the
      // table opens showing what it grants rather than hiding it behind a
      // checkbox the operator has to remember to tick.
      differentiates: plan.entitlements.length > 0,
      entitlements,
    } satisfies PlanFormValues,
    features: features.map((f) => ({ ...f, type: f.type as PlanFeatureType })),
    upgradeTargets: targets.map((t) => ({
      id: t.id,
      appId: t.appId,
      label: `${t.name} — ${t.currencyCode} ${Number(t.amount).toFixed(2)}`,
    })),
    activeSubscriptions:
      counts.find((c) => c.status === "ACTIVE")?._count._all ?? 0,
    ceiling,
  };
}

/** `15.000000` reads as noise in a text field the operator has to edit. */
function trimDecimal(value: string): string {
  return value.includes(".") ? value.replace(/\.?0+$/, "") : value;
}

export async function action({ request, params }: Route.ActionArgs) {
  const org = await requireCurrentOrganization(request);
  const plan = await prisma.plan.findFirst({
    where: { id: params.planId, app: { organizationId: org.id } },
    select: { id: true, appId: true, name: true, active: true, flexBilling: true },
  });
  if (!plan) return { error: "Plan not found" };

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "save-plan");

  if (intent === "archive-plan" || intent === "restore-plan") {
    const archiving = intent === "archive-plan";
    await prisma.plan.update({
      where: { id: plan.id },
      data: { active: !archiving },
    });
    return {
      ok: true,
      message: `${archiving ? "Archived" : "Restored"} ${plan.name}`,
    };
  }

  if (intent !== "save-plan") return { error: "Unknown action" };

  /*
    `existing` pins two things the create path cannot hit: the plan's own name
    is excluded from the duplicate check, and the stored rail wins over whatever
    the form posts, since `flexBilling` is fixed at creation.
  */
  const parsed = await parsePlanForm({
    form,
    appId: plan.appId,
    existing: { id: plan.id, flexBilling: plan.flexBilling },
  });
  if (isPlanFormError(parsed)) return { error: parsed.error };

  /*
    The one check that exists only on edit, and the reason editing a price is
    not a free action.

    A flex charge is a usage record against the line item's APPROVED cap, fixed
    when the merchant approved the subscription. Raising `plan.amount` above it
    does not raise that cap: the next charge comes back `soft_noop: cap_full`,
    the period never advances, and the merchant silently stops being billed.
    Nothing errors, nothing alerts, and it is found a quarter later.

    So a price that would not fit is refused, with the ceiling named. Charging
    more than an approved cap allows is what a tier change is for — it
    re-approves.
  */
  if (plan.flexBilling) {
    const { subscriptions, minCap } = await liveCapCeiling(plan.id);
    if (minCap !== null && parsed.data.amount >= minCap) {
      return {
        error:
          `${subscriptions} active subscription${subscriptions === 1 ? "" : "s"} ` +
          `approved a usage cap as low as ${minCap.toFixed(2)}. A price of ` +
          `${parsed.data.amount.toFixed(2)} would not fit inside it, and those ` +
          `merchants would stop being billed with no error. Price below ` +
          `${minCap.toFixed(2)}, or move them with a tier change, which re-approves.`,
      };
    }
  }

  const saved = await prisma.$transaction(async (tx) => {
    const updated = await tx.plan.update({
      where: { id: plan.id },
      data: parsed.data,
    });

    /*
      Entitlements, reconciled rather than replaced.

      A row is deleted when its value returns to the feature's default —
      absence IS the default, so keeping one would stop tracking a default
      somebody later changes. The exception is a row carrying a `trialValue`:
      that is set on the Features page, this form has no field for it, and
      deleting the row to express "back to the default" would throw away a trial
      override the operator cannot even see from here.
    */
    const wanted = new Map(parsed.entitlements.map((e) => [e.featureId, e.value]));
    const current = await tx.planFeatureEntitlement.findMany({
      where: { planId: plan.id },
      select: { featureId: true, trialValue: true },
    });

    const removable = current
      .filter((row) => !wanted.has(row.featureId) && row.trialValue === null)
      .map((row) => row.featureId);
    if (removable.length > 0) {
      await tx.planFeatureEntitlement.deleteMany({
        where: { planId: plan.id, featureId: { in: removable } },
      });
    }

    const defaults = new Map(
      (
        await tx.planFeature.findMany({
          where: { appId: plan.appId, archivedAt: null },
          select: { id: true, defaultValue: true },
        })
      ).map((f) => [f.id, f.defaultValue]),
    );
    for (const row of current) {
      // Kept only for its trial override: park the value back on the default.
      if (!wanted.has(row.featureId) && row.trialValue !== null) {
        const fallback = defaults.get(row.featureId);
        if (fallback !== undefined) wanted.set(row.featureId, fallback);
      }
    }

    for (const [featureId, value] of wanted) {
      await tx.planFeatureEntitlement.upsert({
        where: { planId_featureId: { planId: plan.id, featureId } },
        // `trialValue` is deliberately absent from the update: leaving it out
        // preserves what the Features page set.
        update: { value },
        create: { planId: plan.id, featureId, value },
      });
    }
    return updated;
  });

  return {
    ok: true,
    message: `Saved ${saved.name}`,
  };
}

export default function PlanDetail({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const backAction = useBackAction({ content: "Plans", url: "/app/plans" });
  const {
    plan,
    values,
    features,
    upgradeTargets,
    activeSubscriptions,
    ceiling,
  } = loaderData;
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  /*
    Built as one string rather than interleaved JSX text: a conditional between
    text nodes leaves the stray spaces JSX cannot see (" , and ... approved ."),
    and the count decides a verb as well as a plural.
  */
  const subjects =
    activeSubscriptions === 1
      ? "1 active subscription"
      : `${activeSubscriptions} active subscriptions`;
  const priceNotice =
    activeSubscriptions === 0 ? null : (
      <Banner tone={plan.flexBilling ? "warning" : "info"}>
        <p>
          {plan.flexBilling
            ? `${subjects} ${activeSubscriptions === 1 ? "bills" : "bill"} from this price. ` +
              `Flex reads it at every renewal, so a change here re-prices ` +
              `${activeSubscriptions === 1 ? "it" : "all of them"} on the next billing date` +
              (ceiling.minCap !== null
                ? `, and must stay under the ${formatMoney(ceiling.minCap, plan.currency)} cap ${activeSubscriptions === 1 ? "it" : "they"} approved.`
                : ".")
            : `${subjects} ${activeSubscriptions === 1 ? "is" : "are"} on this plan. ` +
              `Shopify holds the price each merchant approved, so a change here ` +
              `applies to new subscriptions only — the existing ${activeSubscriptions === 1 ? "one keeps" : "ones keep"} ` +
              `paying what ${activeSubscriptions === 1 ? "it" : "they"} agreed to until ${activeSubscriptions === 1 ? "it re-approves" : "they re-approve"}.`}
        </p>
      </Banner>
    );

  return (
    <Page
      title={plan.name}
      subtitle={`${plan.appName} · ${formatMoney(plan.amount, plan.currency)}`}
      backAction={backAction}
      titleMetadata={
        plan.active ? (
          <Badge tone="success">Active</Badge>
        ) : (
          <Badge tone="warning">Archived</Badge>
        )
      }
      narrowWidth
    >
      <BlockStack gap="400">
        {actionData && "error" in actionData && actionData.error ? (
          <Banner tone="critical">
            <p>{actionData.error}</p>
          </Banner>
        ) : null}
        {actionData && "ok" in actionData ? (
          <Card>
            <BlockStack gap="100">
              <Text as="p" tone="success">
                {actionData.message}
              </Text>
              <Link url="/app/plans">Back to plans</Link>
            </BlockStack>
          </Card>
        ) : null}

        <Form method="post">
          <input type="hidden" name="intent" value="save-plan" />
          <PlanFormFields
            key={plan.id}
            apps={[{ id: plan.appId, name: plan.appName }]}
            features={features}
            upgradeTargets={upgradeTargets}
            initial={values}
            railLocked
            priceNotice={priceNotice}
            submitLabel="Save plan"
            busy={busy}
          />
        </Form>

        {/*
          Archive is its own form rather than a footer slot inside the one
          above: nesting forms is invalid HTML, and the browser would submit
          every plan field along with the archive intent.
        */}
        <Card>
          <InlineStack align="space-between" blockAlign="center" gap="400">
            <BlockStack gap="100">
              <Text as="h2" variant="headingSm">
                {plan.active ? "Archive this plan" : "Restore this plan"}
              </Text>
              <Text as="p" tone="subdued" variant="bodySm">
                {plan.active
                  ? "It stops being offered. Every merchant already on it keeps billing."
                  : "It is offered again to new merchants."}
              </Text>
            </BlockStack>
            <Form method="post">
              <input
                type="hidden"
                name="intent"
                value={plan.active ? "archive-plan" : "restore-plan"}
              />
              <Button submit disabled={busy} tone={plan.active ? "critical" : undefined}>
                {plan.active ? "Archive" : "Restore"}
              </Button>
            </Form>
          </InlineStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
