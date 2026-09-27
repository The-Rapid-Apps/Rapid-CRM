import { BlockStack, Card, Link, Page, Text } from "@shopify/polaris";
import { Form, useNavigation } from "react-router";
import type { Route } from "./+types/plan-new";
import { prisma } from "~/lib/db.server";
import { requireCurrentOrganization } from "~/lib/current-org.server";
import { type PlanFeatureType } from "~/lib/plans/features";
import {
  emptyPlanFormValues,
  PlanFormFields,
} from "~/components/plan-form-fields";
import {
  isPlanFormError,
  parsePlanForm,
} from "~/lib/plans/plan-form.server";
import { useBackAction } from "~/lib/use-back-action";

export async function loader({ request }: Route.LoaderArgs) {
  const org = await requireCurrentOrganization(request);
  /* Carried from the Plans list so "Add plan" inside an app starts on that
     app, instead of silently defaulting to whichever sorts first. */
  const fromAppId =
    new URL(request.url).searchParams.get("appId")?.trim() ?? "";
  const [apps, plans, features] = await Promise.all([
    prisma.app.findMany({
      where: { organizationId: org.id },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    /*
      Candidate auto-upgrade targets. Narrowed the same way the action
      re-checks them — active, public and flex — because auto-tiering moves a
      merchant in place, and only the flex rail can change tier without sending
      them back through Shopify approval.
    */
    prisma.plan.findMany({
      where: {
        app: { organizationId: org.id },
        active: true,
        isPublic: true,
        flexBilling: true,
      },
      orderBy: [{ appId: "asc" }, { amount: "asc" }],
      select: {
        id: true,
        appId: true,
        name: true,
        amount: true,
        currencyCode: true,
      },
    }),
    prisma.planFeature.findMany({
      where: { app: { organizationId: org.id }, archivedAt: null },
      orderBy: [{ sortOrder: "asc" }, { key: "asc" }],
    }),
  ]);
  return {
    apps,
    defaultAppId: fromAppId,
    upgradeTargets: plans.map((p) => ({
      id: p.id,
      appId: p.appId,
      label: `${p.name} — ${p.currencyCode} ${Number(p.amount).toFixed(2)}`,
    })),
    features: features.map((f) => ({
      id: f.id,
      appId: f.appId,
      name: f.name,
      type: f.type as PlanFeatureType,
      defaultValue: f.defaultValue,
    })),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const org = await requireCurrentOrganization(request);
  const form = await request.formData();
  const app = await prisma.app.findFirst({
    where: { id: String(form.get("appId") ?? ""), organizationId: org.id },
    select: { id: true },
  });
  if (!app) return { error: "Choose a valid app" };

  /*
    Parsed and validated in full — entitlements included — BEFORE the plan row
    is written, and the entitlements are written only after it succeeds.

    Found by testing the other order: a mistyped limit returned an error while
    the plan had already been created, so the operator's retry collided on the
    plan name and a half-made plan sat there with no entitlements. One
    submission has to be all-or-nothing from the operator's point of view.
  */
  const parsed = await parsePlanForm({ form, appId: app.id });
  if (isPlanFormError(parsed)) return { error: parsed.error };

  const created = await prisma.plan.create({
    data: { appId: app.id, currencyCode: "USD", ...parsed.data },
  });

  if (parsed.entitlements.length > 0) {
    await prisma.planFeatureEntitlement.createMany({
      data: parsed.entitlements.map((row) => ({
        planId: created.id,
        featureId: row.featureId,
        value: row.value,
      })),
    });
  }

  return {
    ok: true,
    message: `Created ${created.name}`,
  };
}

export default function PlanNew({ loaderData, actionData }: Route.ComponentProps) {
  const backAction = useBackAction({ content: "Plans", url: "/app/plans" });
  const { apps, upgradeTargets, features, defaultAppId } = loaderData;
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  return (
    <Page
      title="Add plan"
      backAction={backAction}
      narrowWidth
    >
      {apps.length === 0 ? (
        <Card>
          <Text as="p" tone="subdued">
            Create an app first — a plan belongs to one.
          </Text>
        </Card>
      ) : (
        <Form method="post">
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
                  <Link url="/app/plans">Back to plans</Link>
                </BlockStack>
              </Card>
            ) : null}

            <PlanFormFields
              apps={apps}
              features={features}
              upgradeTargets={upgradeTargets}
              initial={emptyPlanFormValues(
                apps.some((app) => app.id === defaultAppId)
                  ? defaultAppId
                  : apps[0]!.id,
              )}
              submitLabel="Add plan"
              busy={busy}
            />
          </BlockStack>
        </Form>
      )}
    </Page>
  );
}
