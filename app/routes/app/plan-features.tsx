import {
  Badge,
  Banner,
  BlockStack,
  Button,
  ButtonGroup,
  Card,
  ChoiceList,
  Checkbox,
  DataTable,
  Divider,
  FormLayout,
  Icon,
  InlineStack,
  Modal,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ToggleOnIcon,
  XIcon,
} from "@shopify/polaris-icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { Form, useNavigation, useSearchParams } from "react-router";
import type { Route } from "./+types/plan-features";
import { AppPicker } from "~/components/app-picker";
import { ProductEmptyState } from "~/components/product-empty-state";
import { prisma } from "~/lib/db.server";
import { requireCurrentOrganization } from "~/lib/current-org.server";
import {
  normalizeFeatureKey,
  resolveFeatures,
  UNLIMITED,
  validateFeatureValue,
  type PlanFeatureType,
} from "~/lib/plans/features";

const TYPES: Array<{
  label: string;
  value: PlanFeatureType;
  helpText: string;
}> = [
  { label: "Boolean", value: "BOOLEAN", helpText: "On or off." },
  {
    label: "Limit",
    value: "LIMIT",
    helpText: "A ceiling your app enforces, e.g. 500 orders a month.",
  },
  {
    label: "Limit with overage",
    value: "LIMIT_WITH_OVERAGE",
    helpText: "A ceiling that may be exceeded, billed as usage.",
  },
  {
    label: "String",
    value: "STRING",
    helpText: "One of several named variants your app understands.",
  },
];

const isLimit = (type: PlanFeatureType) =>
  type === "LIMIT" || type === "LIMIT_WITH_OVERAGE";

export async function loader({ request }: Route.LoaderArgs) {
  const org = await requireCurrentOrganization(request);
  const url = new URL(request.url);

  const apps = await prisma.app.findMany({
    where: { organizationId: org.id },
    orderBy: { name: "asc" },
    // logoUrl: the picker shows each app's mark beside its name.
    select: { id: true, name: true, logoUrl: true },
  });
  const appId = url.searchParams.get("appId") || apps[0]?.id || "";
  if (!appId) return { apps, appId: "", planId: "", features: [], plans: [], entitlements: {} };

  const [features, plans] = await Promise.all([
    prisma.planFeature.findMany({
      // Archived included deliberately: an operator has to be able to see and
      // restore one, and the list marks them rather than hiding them.
      where: { appId },
      orderBy: [{ sortOrder: "asc" }, { key: "asc" }],
    }),
    prisma.plan.findMany({
      where: { appId },
      orderBy: [{ sortOrder: "asc" }, { amount: "asc" }],
      select: { id: true, name: true, amount: true, currencyCode: true, interval: true },
    }),
  ]);

  const planId = url.searchParams.get("planId") || plans[0]?.id || "";
  const rows = planId
    ? await prisma.planFeatureEntitlement.findMany({
        where: { planId },
        select: { featureId: true, value: true, trialValue: true },
      })
    : [];

  return {
    apps,
    appId,
    planId,
    plans: plans.map((p) => ({
      id: p.id,
      name: p.name,
      label: `${p.name} — ${p.currencyCode} ${Number(p.amount).toFixed(2)}`,
    })),
    features: features.map((f) => ({
      id: f.id,
      key: f.key,
      name: f.name,
      description: f.description,
      type: f.type as PlanFeatureType,
      defaultValue: f.defaultValue,
      visibleToCustomers: f.visibleToCustomers,
      sortOrder: f.sortOrder,
      archived: f.archivedAt !== null,
    })),
    entitlements: Object.fromEntries(
      rows.map((r) => [r.featureId, { value: r.value, trialValue: r.trialValue }]),
    ),
  };
}

/** Every write goes through one action, keyed by `intent`. */
export async function action({ request }: Route.ActionArgs) {
  const org = await requireCurrentOrganization(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const appId = String(form.get("appId") ?? "");

  // Scope EVERY write to the caller's organization by re-reading the app. The
  // appId arrives from a form field, so trusting it would let one tenant write
  // another's feature catalogue.
  const app = await prisma.app.findFirst({
    where: { id: appId, organizationId: org.id },
    select: { id: true },
  });
  if (!app) return { error: "Choose a valid app" };

  if (intent === "create-feature") {
    const name = String(form.get("name") ?? "").trim();
    const rawKey = String(form.get("key") ?? "").trim();
    const type = String(form.get("type") ?? "BOOLEAN") as PlanFeatureType;
    const defaultValue = String(form.get("defaultValue") ?? "").trim();
    const description = String(form.get("description") ?? "").trim();
    const visible = form.get("visibleToCustomers") === "on";

    if (!name) return { error: "A feature needs a name" };
    if (!TYPES.some((t) => t.value === type)) return { error: "Choose a valid type" };

    // Derive the key from the name when the operator leaves it blank — the
    // common case, and it keeps `Revenue cap limit` from becoming a key nobody
    // can type in app code.
    const key = normalizeFeatureKey(rawKey || name);
    if (!key) {
      return { error: "That name produces no usable key — set one explicitly" };
    }

    const invalid = validateFeatureValue(type, defaultValue);
    if (invalid) return { error: invalid };

    const clash = await prisma.planFeature.findUnique({
      where: { appId_key: { appId: app.id, key } },
      select: { id: true },
    });
    if (clash) return { error: `A feature with the key "${key}" already exists` };

    const last = await prisma.planFeature.findFirst({
      where: { appId: app.id },
      orderBy: { sortOrder: "desc" },
      select: { sortOrder: true },
    });
    await prisma.planFeature.create({
      data: {
        appId: app.id,
        key,
        name,
        description: description || null,
        type,
        defaultValue,
        visibleToCustomers: visible,
        sortOrder: (last?.sortOrder ?? -1) + 1,
      },
    });
    return { ok: `Added "${name}" as ${key}` };
  }

  if (intent === "edit-feature") {
    const featureId = String(form.get("featureId") ?? "");
    const name = String(form.get("name") ?? "").trim();
    const type = String(form.get("type") ?? "BOOLEAN") as PlanFeatureType;
    const defaultValue = String(form.get("defaultValue") ?? "").trim();
    const description = String(form.get("description") ?? "").trim();
    const visible = form.get("visibleToCustomers") === "on";

    const feature = await prisma.planFeature.findFirst({
      where: { id: featureId, appId: app.id },
      select: { id: true },
    });
    if (!feature) return { error: "Feature not found" };
    if (!name) return { error: "A feature needs a name" };
    if (!TYPES.some((t) => t.value === type)) return { error: "Choose a valid type" };

    const invalid = validateFeatureValue(type, defaultValue);
    if (invalid) return { error: invalid };

    // `key` is deliberately NOT editable — the app gates on it, and changing it
    // would silently strip the entitlement from every plan (the reader looks it
    // up by key). Only the name, description, type, default and visibility move.
    // Changing the type can leave existing entitlement values malformed for the
    // new type; the resolver reports that rather than guessing, and the operator
    // fixes them on the plan.
    await prisma.planFeature.update({
      where: { id: feature.id },
      data: {
        name,
        description: description || null,
        type,
        defaultValue,
        visibleToCustomers: visible,
      },
    });
    return { ok: `Updated "${name}"` };
  }

  if (intent === "archive-feature" || intent === "restore-feature") {
    const featureId = String(form.get("featureId") ?? "");
    const feature = await prisma.planFeature.findFirst({
      where: { id: featureId, appId: app.id },
      select: { id: true, name: true },
    });
    if (!feature) return { error: "Feature not found" };
    // Soft both ways. A hard delete would cascade every plan's entitlement and
    // silently change what those plans grant.
    await prisma.planFeature.update({
      where: { id: feature.id },
      data: {
        archivedAt: intent === "archive-feature" ? new Date() : null,
      },
    });
    return {
      ok:
        intent === "archive-feature"
          ? `Archived "${feature.name}" — plans keep resolving it`
          : `Restored "${feature.name}"`,
    };
  }

  if (intent === "delete-feature") {
    const featureId = String(form.get("featureId") ?? "");
    const feature = await prisma.planFeature.findFirst({
      where: { id: featureId, appId: app.id },
      select: { id: true, name: true, _count: { select: { entitlements: true } } },
    });
    if (!feature) return { error: "Feature not found" };
    // Hard delete. Entitlements cascade (onDelete: Cascade), so every plan that
    // set a value for this feature loses it. Irreversible — the UI confirms
    // first, and Archive is the non-destructive alternative for "stop offering
    // it but keep resolving it".
    const entitlements = feature._count.entitlements;
    await prisma.planFeature.delete({ where: { id: feature.id } });
    return {
      ok:
        entitlements > 0
          ? `Removed "${feature.name}" and its value on ${entitlements} ${
              entitlements === 1 ? "plan" : "plans"
            }`
          : `Removed "${feature.name}"`,
    };
  }

  if (intent === "move-feature") {
    const featureId = String(form.get("featureId") ?? "");
    const direction = String(form.get("direction") ?? "");
    const ordered = await prisma.planFeature.findMany({
      where: { appId: app.id },
      orderBy: [{ sortOrder: "asc" }, { key: "asc" }],
      select: { id: true },
    });
    const index = ordered.findIndex((f) => f.id === featureId);
    const target = direction === "up" ? index - 1 : index + 1;
    if (index < 0 || target < 0 || target >= ordered.length) {
      return { error: "Cannot move that feature any further" };
    }
    [ordered[index], ordered[target]] = [ordered[target]!, ordered[index]!];
    /*
      Rewrite every row's sortOrder rather than swapping two.

      The list is ordered by `(sortOrder, key)`, so ties are broken by key —
      which means swapping two values leaves any pre-existing tie in place and
      the row appears not to move. Renumbering from zero makes the displayed
      order and the stored order the same thing.
    */
    await prisma.$transaction(
      ordered.map((f, order) =>
        prisma.planFeature.update({ where: { id: f.id }, data: { sortOrder: order } }),
      ),
    );
    return { ok: "Reordered" };
  }

  if (intent === "save-entitlements") {
    const planId = String(form.get("planId") ?? "");
    const plan = await prisma.plan.findFirst({
      where: { id: planId, appId: app.id },
      select: { id: true, name: true },
    });
    if (!plan) return { error: "Choose a valid plan" };

    const features = await prisma.planFeature.findMany({
      where: { appId: app.id, archivedAt: null },
      select: { id: true, key: true, name: true, type: true },
    });

    const writes: Array<{ featureId: string; value: string; trialValue: string | null }> =
      [];
    const clears: string[] = [];

    for (const feature of features) {
      const type = feature.type as PlanFeatureType;
      const useDefault = form.get(`default:${feature.id}`) === "on";
      if (useDefault) {
        // No row means "the default" — deleting is how an operator says that.
        clears.push(feature.id);
        continue;
      }

      const raw =
        type === "BOOLEAN"
          ? form.get(`value:${feature.id}`) === "on"
            ? "true"
            : "false"
          : String(form.get(`value:${feature.id}`) ?? "").trim();

      const invalid = validateFeatureValue(type, raw);
      if (invalid) return { error: `${feature.name}: ${invalid}` };

      const trialRaw =
        type === "BOOLEAN"
          ? form.get(`trialSet:${feature.id}`) === "on"
            ? form.get(`trial:${feature.id}`) === "on"
              ? "true"
              : "false"
            : ""
          : String(form.get(`trial:${feature.id}`) ?? "").trim();

      if (trialRaw) {
        const badTrial = validateFeatureValue(type, trialRaw);
        if (badTrial) return { error: `${feature.name} (trial): ${badTrial}` };
      }

      writes.push({
        featureId: feature.id,
        value: raw,
        trialValue: trialRaw || null,
      });
    }

    await prisma.$transaction([
      prisma.planFeatureEntitlement.deleteMany({
        where: { planId: plan.id, featureId: { in: clears } },
      }),
      ...writes.map((w) =>
        prisma.planFeatureEntitlement.upsert({
          where: { planId_featureId: { planId: plan.id, featureId: w.featureId } },
          update: { value: w.value, trialValue: w.trialValue },
          create: {
            planId: plan.id,
            featureId: w.featureId,
            value: w.value,
            trialValue: w.trialValue,
          },
        }),
      ),
    ]);
    /*
      Entitlements are part of what a plan IS, so changing them is a plan
      update as far as a consuming catalogue is concerned. Emitted even though
      an app that hardcodes its own feature table will ignore the features in
      the payload — it re-reads the plan either way, which is harmless, and it
      starts mattering the moment that app adopts these entitlements.
    */
    return { ok: `Saved entitlements for ${plan.name}` };
  }

  return { error: "Unknown action" };
}

const TYPE_LABEL: Record<PlanFeatureType, string> = {
  BOOLEAN: "Boolean",
  LIMIT: "Limit",
  LIMIT_WITH_OVERAGE: "Limit with overage",
  STRING: "String",
};

/** The list's Default column: a tick or a cross for a toggle, the literal
 *  value for anything with a magnitude. */
function defaultCell(feature: { type: PlanFeatureType; defaultValue: string }) {
  if (feature.type === "BOOLEAN") {
    const on = feature.defaultValue === "true";
    return (
      <Icon
        source={on ? CheckIcon : XIcon}
        tone={on ? "success" : "subdued"}
        accessibilityLabel={on ? "On by default" : "Off by default"}
      />
    );
  }
  return (
    <Text as="span" variant="bodySm">
      <code>{feature.defaultValue || "—"}</code>
    </Text>
  );
}

export default function PlanFeatures({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { apps, appId, planId, plans, features, entitlements } = loaderData;
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const [, setSearchParams] = useSearchParams();

  const [adding, setAdding] = useState(false);
  // The feature being edited / being removed. Null when the respective modal is
  // closed. Typed off the loader's feature row so the edit form can prefill.
  const [editing, setEditing] = useState<(typeof features)[number] | null>(null);
  const [deleting, setDeleting] = useState<(typeof features)[number] | null>(
    null,
  );
  /*
    The modal closes on SUCCESS, not on submit.

    Closing in `onSubmit` would throw
    away everything typed the moment the action rejects — and rejection is the
    normal case here, since a duplicate key and a default that does not match
    the type are both one keystroke away. Keyed on the identity of `actionData`
    rather than its text, because two saves can return the same message.
  */
  const seen = useRef(actionData);
  useEffect(() => {
    if (actionData === seen.current) return;
    seen.current = actionData;
    if (actionData && "ok" in actionData && actionData.ok) {
      setAdding(false);
      setEditing(null);
      setDeleting(null);
    }
  }, [actionData]);

  const live = features.filter((f) => !f.archived);
  const selectedPlan = plans.find((p) => p.id === planId);

  /* A preview of what the selected plan actually grants, using the same
     resolver the API uses — so an operator sees the resolved answer, defaults
     included, rather than only the overrides they typed. */
  const resolved = resolveFeatures(
    live.map((f) => ({ ...f, archivedAt: null })),
    live
      .filter((f) => entitlements[f.id])
      .map((f) => ({
        key: f.key,
        value: entitlements[f.id]!.value,
        trialValue: entitlements[f.id]!.trialValue,
      })),
  );

  return (
    <Page
      fullWidth
      title="Features"
      subtitle="What each plan entitles. Your app reads these by key and enforces them."
      primaryAction={
        apps.length
          ? { content: "Add feature", onAction: () => setAdding(true) }
          : { content: "Add an app first", url: "/app/apps" }
      }
    >
      <BlockStack gap="400">
        {apps.length > 1 ? (
          <Card>
            <AppPicker
              /* `AppPicker`, not `Select`: a native <select> renders text-only
                 options in every browser, so this was the one app chooser in
                 the product with no logos. */
              value={appId}
              apps={apps}
              allowAll={false}
              onChange={(value) =>
                setSearchParams((prev) => {
                  prev.set("appId", value);
                  prev.delete("planId");
                  return prev;
                })
              }
            />
          </Card>
        ) : null}

        {/* While the modal is open it carries the error itself — a banner behind
            a modal is a message the operator cannot read. */}
        {!adding && actionData && "error" in actionData && actionData.error ? (
          <Card>
            <Text as="p" tone="critical">
              {actionData.error}
            </Text>
          </Card>
        ) : null}
        {actionData && "ok" in actionData && actionData.ok ? (
          <Card>
            <Text as="p" tone="success">
              {actionData.ok}
            </Text>
          </Card>
        ) : null}

        <Card padding="0">
          {features.length === 0 ? (
            <ProductEmptyState
              title="Define your first feature"
              description="A feature is one thing a plan can entitle — a toggle, a ceiling like revenue_cap_limit, or a named variant. Your app gates on the key."
              icon={ToggleOnIcon}
              action={{
                content: "Add feature",
                onAction: () => setAdding(true),
              }}
            />
          ) : (
            <DataTable
              columnContentTypes={["text", "text", "text", "text"]}
              headings={["Name", "Type", "Default", ""]}
              rows={features.map((feature, index) => [
                <BlockStack gap="050" key={`name-${feature.id}`}>
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="span" fontWeight="medium">
                      {feature.name}
                    </Text>
                    {feature.archived ? (
                      <Badge tone="warning">Archived</Badge>
                    ) : null}
                    {!feature.visibleToCustomers ? (
                      <Badge tone="info">Internal</Badge>
                    ) : null}
                  </InlineStack>
                  <Text as="span" tone="subdued" variant="bodySm">
                    <code>{feature.key}</code>
                    {feature.description ? ` · ${feature.description}` : ""}
                  </Text>
                </BlockStack>,
                <Text as="span" key={`type-${feature.id}`}>
                  {TYPE_LABEL[feature.type]}
                </Text>,
                <span key={`default-${feature.id}`}>{defaultCell(feature)}</span>,
                <ButtonGroup key={`actions-${feature.id}`}>
                  <Form method="post">
                    <input type="hidden" name="appId" value={appId} />
                    <input type="hidden" name="intent" value="move-feature" />
                    <input type="hidden" name="featureId" value={feature.id} />
                    <input type="hidden" name="direction" value="up" />
                    <Button
                      submit
                      icon={ArrowUpIcon}
                      variant="tertiary"
                      accessibilityLabel={`Move ${feature.name} up`}
                      disabled={busy || index === 0}
                    />
                  </Form>
                  <Form method="post">
                    <input type="hidden" name="appId" value={appId} />
                    <input type="hidden" name="intent" value="move-feature" />
                    <input type="hidden" name="featureId" value={feature.id} />
                    <input type="hidden" name="direction" value="down" />
                    <Button
                      submit
                      icon={ArrowDownIcon}
                      variant="tertiary"
                      accessibilityLabel={`Move ${feature.name} down`}
                      disabled={busy || index === features.length - 1}
                    />
                  </Form>
                  <Form method="post">
                    <input type="hidden" name="appId" value={appId} />
                    <input
                      type="hidden"
                      name="intent"
                      value={
                        feature.archived ? "restore-feature" : "archive-feature"
                      }
                    />
                    <input type="hidden" name="featureId" value={feature.id} />
                    <Button submit disabled={busy} variant="tertiary">
                      {feature.archived ? "Restore" : "Archive"}
                    </Button>
                  </Form>
                  <Button
                    variant="tertiary"
                    disabled={busy}
                    onClick={() => setEditing(feature)}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="tertiary"
                    tone="critical"
                    disabled={busy}
                    onClick={() => setDeleting(feature)}
                  >
                    Remove
                  </Button>
                </ButtonGroup>,
              ])}
            />
          )}
        </Card>

        <Modal
          open={adding}
          onClose={() => setAdding(false)}
          title="Add feature"
        >
          <Modal.Section>
            <FeatureForm
              appId={appId}
              busy={busy}
              error={
                actionData && "error" in actionData ? actionData.error : null
              }
              onCancel={() => setAdding(false)}
            />
          </Modal.Section>
        </Modal>

        <Modal
          open={editing !== null}
          onClose={() => setEditing(null)}
          title="Edit feature"
        >
          <Modal.Section>
            {editing ? (
              /* Keyed on the feature id so switching which row is edited
                 re-seeds every field from the new feature. */
              <FeatureForm
                key={editing.id}
                appId={appId}
                busy={busy}
                error={
                  actionData && "error" in actionData ? actionData.error : null
                }
                feature={editing}
                onCancel={() => setEditing(null)}
              />
            ) : null}
          </Modal.Section>
        </Modal>

        <Modal
          open={deleting !== null}
          onClose={() => setDeleting(null)}
          title="Remove feature"
        >
          <Modal.Section>
            <BlockStack gap="400">
              <Text as="p">
                Remove <strong>{deleting?.name}</strong> (
                <code>{deleting?.key}</code>)? This permanently deletes the
                feature and its value on every plan, and cannot be undone. To
                stop offering it while keeping history, use{" "}
                <strong>Archive</strong> instead.
              </Text>
              {actionData && "error" in actionData && actionData.error ? (
                <Banner tone="critical">
                  <p>{actionData.error}</p>
                </Banner>
              ) : null}
              <Form method="post">
                <input type="hidden" name="appId" value={appId} />
                <input type="hidden" name="intent" value="delete-feature" />
                <input
                  type="hidden"
                  name="featureId"
                  value={deleting?.id ?? ""}
                />
                <InlineStack align="end" gap="200">
                  <Button onClick={() => setDeleting(null)} disabled={busy}>
                    Cancel
                  </Button>
                  <Button submit variant="primary" tone="critical" loading={busy}>
                    Remove feature
                  </Button>
                </InlineStack>
              </Form>
            </BlockStack>
          </Modal.Section>
        </Modal>

        {/* ------------------------------------------------ entitlements */}
        {live.length > 0 && plans.length > 0 ? (
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  Entitlements
                </Text>
                <div style={{ minWidth: 260 }}>
                  <Select
                    label="Plan"
                    labelHidden
                    options={plans.map((p) => ({ label: p.label, value: p.id }))}
                    value={planId}
                    onChange={(value) =>
                      setSearchParams((prev) => {
                        prev.set("planId", value);
                        return prev;
                      })
                    }
                  />
                </div>
              </InlineStack>
              <Text as="p" tone="subdued" variant="bodySm">
                Leave a feature on its default and no row is stored — absence
                means the default, never a denial. A trial value applies only
                while the subscription is inside its trial.
              </Text>

              <EntitlementsForm
                key={planId}
                appId={appId}
                planId={planId}
                planName={selectedPlan?.name ?? null}
                features={live}
                entitlements={entitlements}
                resolved={resolved}
                busy={busy}
              />
            </BlockStack>
          </Card>
        ) : null}
      </BlockStack>
    </Page>
  );
}

/**
 * The feature form, as Mantle has it: a modal rather than a column permanently
 * occupying a third of the page. Serves both create and edit — pass `feature`
 * to edit an existing one.
 *
 * Its own component so the parent can drop it from the tree on close and every
 * `useState` initializer re-runs on the next open — a half-typed feature does
 * not reappear in the next one. On edit the parent keys it on the feature id so
 * switching rows re-seeds the fields. Polaris inputs are controlled-only, so
 * each field is state-backed; `defaultValue` renders them frozen.
 */
function FeatureForm({
  appId,
  busy,
  error,
  onCancel,
  feature,
}: {
  appId: string;
  busy: boolean;
  error: string | null | undefined;
  onCancel: () => void;
  feature?: {
    id: string;
    key: string;
    name: string;
    description: string | null;
    type: PlanFeatureType;
    defaultValue: string;
    visibleToCustomers: boolean;
  };
}) {
  const editing = Boolean(feature);
  const [type, setType] = useState<PlanFeatureType>(feature?.type ?? "BOOLEAN");
  const [visible, setVisible] = useState(feature?.visibleToCustomers ?? true);
  const [fields, setFields] = useState({
    name: feature?.name ?? "",
    key: feature?.key ?? "",
    description: feature?.description ?? "",
    defaultValue: feature?.defaultValue ?? "false",
  });
  const set = (k: keyof typeof fields) => (v: string) =>
    setFields((prev) => ({ ...prev, [k]: v }));

  return (
    <Form method="post">
      <input type="hidden" name="appId" value={appId} />
      <input
        type="hidden"
        name="intent"
        value={editing ? "edit-feature" : "create-feature"}
      />
      {editing ? (
        <input type="hidden" name="featureId" value={feature!.id} />
      ) : null}
      <FormLayout>
        {error ? (
          <Banner tone="critical">
            <p>{error}</p>
          </Banner>
        ) : null}
        <FormLayout.Group>
          <TextField
            label="Name"
            name="name"
            autoComplete="off"
            value={fields.name}
            onChange={set("name")}
            placeholder="Revenue cap limit"
            helpText="What a merchant sees."
          />
          <TextField
            label="Key"
            name="key"
            autoComplete="off"
            value={fields.key}
            onChange={set("key")}
            disabled={editing}
            placeholder={
              fields.name ? normalizeFeatureKey(fields.name) : "revenue_cap_limit"
            }
            helpText={
              editing
                ? "The key is permanent — apps gate on it, so it can't be changed here."
                : "What your app gates on. Derived from the name if blank — and permanent once a released app version reads it."
            }
          />
        </FormLayout.Group>

        <TextField
          label="Description"
          name="description"
          autoComplete="off"
          multiline={3}
          value={fields.description}
          onChange={set("description")}
        />

        <ChoiceList
          title="Type"
          name="type"
          choices={TYPES.map((t) => ({
            label: t.label,
            value: t.value,
            helpText: t.helpText,
          }))}
          selected={[type]}
          onChange={(selected) => {
            const next = selected[0] as PlanFeatureType;
            setType(next);
            // Move the default to something valid for the new type, so the
            // form cannot submit a mismatch.
            setFields((prev) => ({
              ...prev,
              defaultValue:
                next === "BOOLEAN" ? "false" : isLimit(next) ? "0" : "",
            }));
          }}
        />

        {type === "BOOLEAN" ? (
          <Select
            label="Default value"
            name="defaultValue"
            options={[
              { label: "False", value: "false" },
              { label: "True", value: "true" },
            ]}
            value={fields.defaultValue}
            onChange={set("defaultValue")}
            helpText="What a plan that says nothing about this feature grants."
          />
        ) : (
          <TextField
            label="Default value"
            name="defaultValue"
            autoComplete="off"
            value={fields.defaultValue}
            onChange={set("defaultValue")}
            helpText={
              isLimit(type)
                ? `A number, or "${UNLIMITED}" for no ceiling. It is what a plan that says nothing about this feature grants.`
                : "A variant name your app understands."
            }
          />
        )}

        <Checkbox
          label="Visible to customers"
          name="visibleToCustomers"
          checked={visible}
          onChange={setVisible}
          helpText="Shows on a pricing page. Does not gate the API — your app still enforces a hidden feature."
        />

        <InlineStack align="end" gap="200">
          <Button onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button submit variant="primary" loading={busy}>
            {editing ? "Save changes" : "Save"}
          </Button>
        </InlineStack>
      </FormLayout>
    </Form>
  );
}

interface EntitlementRow {
  useDefault: boolean;
  value: string;
  trialSet: boolean;
  trialValue: string;
}

/**
 * The per-plan entitlement editor.
 *
 * A child component keyed on `planId` so switching plans REMOUNTS it and its
 * state re-initialises from the new plan's rows. Polaris inputs are
 * controlled-only — `defaultValue` renders them frozen (the same trap
 * `plans.tsx` documents) — so every field is state-backed, and state seeded in
 * `useState` would otherwise keep showing the first plan's values forever.
 */
function EntitlementsForm({
  appId,
  planId,
  planName,
  features,
  entitlements,
  resolved,
  busy,
}: {
  appId: string;
  planId: string;
  planName: string | null;
  features: Array<{
    id: string;
    key: string;
    name: string;
    type: PlanFeatureType;
    defaultValue: string;
  }>;
  entitlements: Record<string, { value: string; trialValue: string | null }>;
  resolved: ReturnType<typeof resolveFeatures>;
  busy: boolean;
}) {
  /*
    The row every feature starts from: the plan's saved entitlement, or the
    feature's default when the plan overrides nothing. Recomputed from the
    current feature list, so a feature ADDED while this form is open still has a
    complete row. The form is keyed on planId upstream, so it does NOT remount
    when the catalogue grows — reading `rows[feature.id]` directly would be
    `undefined` for the new feature and throw on the next line.
  */
  const seed = useMemo<Record<string, EntitlementRow>>(
    () =>
      Object.fromEntries(
        features.map((feature) => {
          const current = entitlements[feature.id];
          return [
            feature.id,
            {
              useDefault: !current,
              value: current?.value ?? feature.defaultValue,
              trialSet: current?.trialValue != null,
              trialValue: current?.trialValue ?? "",
            },
          ];
        }),
      ),
    [features, entitlements],
  );

  // Only operator edits live here; anything untouched (a just-added feature
  // included) falls back to `seed`.
  const [rows, setRows] = useState<Record<string, EntitlementRow>>({});

  const patch = (id: string, change: Partial<EntitlementRow>) =>
    setRows((prev) => ({ ...prev, [id]: { ...(prev[id] ?? seed[id]!), ...change } }));

  return (
    <Form method="post">
      <input type="hidden" name="appId" value={appId} />
      <input type="hidden" name="planId" value={planId} />
      <input type="hidden" name="intent" value="save-entitlements" />
      <BlockStack gap="300">
        {features.map((feature) => {
          const row = rows[feature.id] ?? seed[feature.id]!;
          const resolvedRow = resolved.find((r) => r.key === feature.key);
          const boolean = feature.type === "BOOLEAN";
          return (
            <div key={feature.id}>
              <Divider />
              <div style={{ paddingTop: 12 }}>
                <BlockStack gap="150">
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="span" fontWeight="semibold">
                      {feature.name}
                    </Text>
                    <Text as="span" tone="subdued" variant="bodySm">
                      <code>{feature.key}</code>
                    </Text>
                    {resolvedRow ? (
                      <Badge
                        tone={resolvedRow.source === "default" ? undefined : "success"}
                      >
                        {`saved: ${
                          resolvedRow.unlimited ? UNLIMITED : resolvedRow.value
                        } (${resolvedRow.source})`}
                      </Badge>
                    ) : null}
                  </InlineStack>

                  <Checkbox
                    label={`Use the default (${feature.defaultValue})`}
                    name={`default:${feature.id}`}
                    checked={row.useDefault}
                    onChange={(checked) => patch(feature.id, { useDefault: checked })}
                  />

                  {row.useDefault ? null : boolean ? (
                    <InlineStack gap="400" blockAlign="center">
                      <Checkbox
                        label="Enabled"
                        name={`value:${feature.id}`}
                        checked={row.value === "true"}
                        onChange={(checked) =>
                          patch(feature.id, { value: checked ? "true" : "false" })
                        }
                      />
                      <Checkbox
                        label="Different during trial"
                        name={`trialSet:${feature.id}`}
                        checked={row.trialSet}
                        onChange={(checked) => patch(feature.id, { trialSet: checked })}
                      />
                      {row.trialSet ? (
                        <Checkbox
                          label="Enabled in trial"
                          name={`trial:${feature.id}`}
                          checked={row.trialValue === "true"}
                          onChange={(checked) =>
                            patch(feature.id, { trialValue: checked ? "true" : "false" })
                          }
                        />
                      ) : null}
                    </InlineStack>
                  ) : (
                    <FormLayout>
                      <FormLayout.Group>
                        <TextField
                          label="Value"
                          name={`value:${feature.id}`}
                          autoComplete="off"
                          value={row.value}
                          onChange={(value) => patch(feature.id, { value })}
                          helpText={
                            isLimit(feature.type)
                              ? `A number, or "${UNLIMITED}" for no ceiling.`
                              : undefined
                          }
                        />
                        <TextField
                          label="Trial value (optional)"
                          name={`trial:${feature.id}`}
                          autoComplete="off"
                          value={row.trialValue}
                          onChange={(trialValue) => patch(feature.id, { trialValue })}
                          helpText="Blank means the trial gets the value on the left."
                        />
                      </FormLayout.Group>
                    </FormLayout>
                  )}
                </BlockStack>
              </div>
            </div>
          );
        })}
        <div>
          <Button submit variant="primary" disabled={busy || !planId}>
            {planName ? `Save entitlements for ${planName}` : "Save entitlements"}
          </Button>
        </div>
      </BlockStack>
    </Form>
  );
}
