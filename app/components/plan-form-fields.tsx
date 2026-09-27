import {
  Badge,
  BlockStack,
  Button,
  Card,
  Checkbox,
  Divider,
  FormLayout,
  InlineStack,
  Link,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { useRef, useState, type ReactNode } from "react";
import { UNLIMITED, type PlanFeatureType } from "~/lib/plans/features";

/**
 * The plan form's fields — the cards Mantle shows when you add or edit a plan.
 *
 * Shared by **Add plan** and **Edit plan** because the two submit the same body
 * to the same validator (`~/lib/plans/plan-form.server`). Keeping one copy of
 * the server rules while the two pages kept their own inputs would have put the
 * drift back where it is hardest to see: a field the edit page forgot simply
 * posts nothing, and the validator reads that as "the operator cleared it".
 *
 * Every input is state-backed. Polaris inputs are controlled-only — a
 * `defaultValue` renders them frozen — so there is no uncontrolled shortcut
 * here, and the caller seeds them through `initial`.
 *
 * The caller owns the surrounding `<Form method="post">`, the page chrome and
 * any banners; this owns the fields and the submit button.
 */

export interface PlanFormFeature {
  id: string;
  appId: string;
  name: string;
  type: PlanFeatureType;
  defaultValue: string;
}

export interface PlanFormTarget {
  id: string;
  appId: string;
  label: string;
}

export interface PlanFormValues {
  appId: string;
  name: string;
  description: string;
  amount: string;
  cap: string;
  trialDays: string;
  interval: string;
  isPublic: boolean;
  flexBilling: boolean;
  usageBilling: boolean;
  limitMetric: string;
  limitMax: string;
  autoUpgradeToPlanId: string;
  /** Revenue ceiling in USD; blank = no cap. App-enforced. */
  revenueCap: string;
  revenueCapPeriod: string;
  differentiates: boolean;
  /** Keyed by feature id. Blank on a non-boolean means "keep the default". */
  entitlements: Record<string, string>;
}

export function emptyPlanFormValues(appId: string): PlanFormValues {
  return {
    appId,
    name: "",
    description: "",
    amount: "",
    cap: "",
    trialDays: "0",
    interval: "EVERY_30_DAYS",
    isPublic: true,
    flexBilling: true,
    usageBilling: false,
    limitMetric: "",
    limitMax: "",
    autoUpgradeToPlanId: "",
    revenueCap: "",
    revenueCapPeriod: "BILLING_PERIOD",
    differentiates: false,
    entitlements: {},
  };
}

export function PlanFormFields({
  apps,
  features,
  upgradeTargets,
  initial,
  railLocked = false,
  priceNotice = null,
  submitLabel,
  busy,
  footerStart = null,
}: {
  apps: Array<{ id: string; name: string }>;
  features: PlanFormFeature[];
  upgradeTargets: PlanFormTarget[];
  initial: PlanFormValues;
  /**
   * Editing. `Plan.flexBilling` is immutable after creation — the rail decides
   * how the Shopify object was built, so flipping it on a plan with live
   * subscriptions would have the charge path treat an existing subscription as
   * the other kind. Shown as a read-only badge instead of a checkbox.
   */
  railLocked?: boolean;
  /** Rendered under the price row — edit uses it to say who gets re-priced. */
  priceNotice?: ReactNode;
  submitLabel: string;
  busy: boolean;
  /** Left-aligned footer slot, e.g. the Archive action on the edit page. */
  footerStart?: ReactNode;
}) {
  const [appId, setAppId] = useState(initial.appId);
  const [interval, setInterval] = useState(initial.interval);
  const [flexBilling, setFlexBilling] = useState(initial.flexBilling);
  const [usageBilling, setUsageBilling] = useState(initial.usageBilling);
  const [isPublic, setIsPublic] = useState(initial.isPublic);
  const [autoUpgradeToPlanId, setAutoUpgradeToPlanId] = useState(
    initial.autoUpgradeToPlanId,
  );
  const [differentiates, setDifferentiates] = useState(initial.differentiates);
  const [fields, setFields] = useState({
    name: initial.name,
    description: initial.description,
    amount: initial.amount,
    cap: initial.cap,
    trialDays: initial.trialDays,
    limitMetric: initial.limitMetric,
    limitMax: initial.limitMax,
    revenueCap: initial.revenueCap,
    revenueCapPeriod: initial.revenueCapPeriod,
  });
  const set = (key: keyof typeof fields) => (value: string) =>
    setFields((prev) => ({ ...prev, [key]: value }));

  const appFeatures = features.filter((f) => f.appId === appId);
  const targets = upgradeTargets.filter((t) => t.appId === appId);

  const [entitlements, setEntitlements] = useState<Record<string, string>>(
    initial.entitlements,
  );
  /*
    Seeded from `initial` and re-seeded only when the app CHANGES, since the
    feature set changes with it — without that, switching app would submit the
    previous app's values against the new app's features.

    The ref starts at the initial app rather than null so an edit page's saved
    entitlements survive the first render; starting at null would re-seed them
    all to blank before the operator saw them.
  */
  const seededFor = useRef(initial.appId);
  if (seededFor.current !== appId) {
    seededFor.current = appId;
    const seed: Record<string, string> = {};
    for (const feature of features.filter((f) => f.appId === appId)) {
      seed[feature.id] = feature.type === "BOOLEAN" ? feature.defaultValue : "";
    }
    // Safe during render: it runs only when appId actually changed, and it sets
    // state derived from props rather than reacting to an effect a tick later.
    setEntitlements(seed);
  }
  const setEntitlement = (id: string, value: string) =>
    setEntitlements((prev) => ({ ...prev, [id]: value }));

  const capRequired = flexBilling || usageBilling;
  const canChangeApp = !railLocked && apps.length > 1;

  return (
    <BlockStack gap="400">
      {/* -------------------------------------------------- plan details */}
      <Card>
        <BlockStack gap="400">
          <Text as="h2" variant="headingMd">
            Plan details
          </Text>
          <FormLayout>
            {canChangeApp ? (
              <Select
                label="App"
                name="appId"
                options={apps.map((a) => ({ label: a.name, value: a.id }))}
                value={appId}
                onChange={(value) => {
                  setAppId(value);
                  setAutoUpgradeToPlanId("");
                }}
              />
            ) : (
              <input type="hidden" name="appId" value={appId} />
            )}
            <FormLayout.Group>
              <TextField
                label="Name"
                name="name"
                value={fields.name}
                onChange={set("name")}
                autoComplete="off"
                placeholder="Basic"
                requiredIndicator
              />
              <TextField
                label="Trial period"
                name="trialDays"
                type="number"
                value={fields.trialDays}
                onChange={set("trialDays")}
                autoComplete="off"
                suffix="days"
                helpText={
                  railLocked
                    ? "Applies to new subscriptions. A trial already running keeps its own end date."
                    : undefined
                }
              />
            </FormLayout.Group>
            <TextField
              label="Description"
              name="description"
              value={fields.description}
              onChange={set("description")}
              autoComplete="off"
              placeholder="e.g. The plan for those who are just getting started"
              helpText="The line under the plan name on a pricing page. Synced to consuming apps."
            />
            <FormLayout.Group>
              <TextField
                label="Amount"
                name="amount"
                value={fields.amount}
                onChange={set("amount")}
                autoComplete="off"
                prefix="$"
                requiredIndicator
              />
              <Select
                label="Interval"
                name="interval"
                options={[
                  { label: "Every 30 days", value: "EVERY_30_DAYS" },
                  { label: "Quarterly", value: "QUARTERLY" },
                  { label: "Per year", value: "ANNUAL" },
                ]}
                value={interval}
                onChange={setInterval}
              />
            </FormLayout.Group>
            {priceNotice}
            {railLocked ? (
              <InlineStack gap="200" blockAlign="center">
                <Text as="span" variant="bodySm" tone="subdued">
                  Billing rail
                </Text>
                <Badge tone={flexBilling ? "success" : undefined}>
                  {flexBilling ? "Flex Billing" : "Standard Shopify billing"}
                </Badge>
                <Text as="span" variant="bodySm" tone="subdued">
                  Fixed when the plan was created — it decides how each Shopify
                  subscription was built, so changing it would misread the ones
                  already collecting.
                </Text>
              </InlineStack>
            ) : (
              <Checkbox
                label="Enable Flex Billing for this plan"
                name="flexBilling"
                checked={flexBilling}
                onChange={(checked) => {
                  setFlexBilling(checked);
                  if (checked) setUsageBilling(false);
                }}
                helpText="Flex bills the fee as a usage record against a capped line, so a tier change never re-approves. Unchecked, Shopify collects the price on its own cycle and a tier change sends the merchant back through approval."
              />
            )}
            {!flexBilling ? (
              <Checkbox
                label="This plan sells metered usage"
                name="usageBilling"
                checked={usageBilling}
                onChange={setUsageBilling}
                helpText="Adds a metered line alongside the recurring price, capped below."
              />
            ) : null}
            {capRequired ? (
              <TextField
                label="Usage cap"
                name="cap"
                value={fields.cap}
                onChange={set("cap")}
                autoComplete="off"
                prefix="$"
                requiredIndicator
                helpText={
                  flexBilling
                    ? railLocked
                      ? "Must exceed the price plus the largest proration ever posted. Applies to new subscriptions — Shopify holds the cap each existing merchant approved."
                      : "Must exceed the price plus the largest proration ever posted."
                    : "The ceiling Shopify refuses to bill past."
                }
              />
            ) : null}
          </FormLayout>
        </BlockStack>
      </Card>

      {/* --------------------------------------------------- availability */}
      <Card>
        <BlockStack gap="300">
          <Text as="h2" variant="headingMd">
            Availability
          </Text>
          <Checkbox
            label="Available — offer this plan publicly"
            name="isPublic"
            checked={isPublic}
            onChange={setIsPublic}
            helpText="Unchecked, the plan is hidden: it still exists and can be subscribed to by id, but it is not offered."
          />
        </BlockStack>
      </Card>

      {/* --------------------------------------------------- revenue cap */}
      <Card>
        <BlockStack gap="300">
          <Text as="h2" variant="headingMd">
            Revenue cap
          </Text>
          <Text as="p" tone="subdued" variant="bodySm">
            Optional business ceiling, always in USD. Your app reads it from the
            catalogue and enforces it — the platform stores it but never converts
            currencies or tracks usage against it, so worldwide merchants stay
            correct (the app converts their revenue to USD before comparing).
          </Text>
          <FormLayout>
            <FormLayout.Group>
              <TextField
                label="Revenue cap (USD)"
                name="revenueCap"
                value={fields.revenueCap}
                onChange={set("revenueCap")}
                autoComplete="off"
                prefix="$"
                placeholder="No cap"
                helpText="Leave blank for no cap (unlimited)."
              />
              <Select
                label="Cap period"
                name="revenueCapPeriod"
                value={fields.revenueCapPeriod}
                onChange={set("revenueCapPeriod")}
                options={[
                  { label: "Per billing period", value: "BILLING_PERIOD" },
                  { label: "Lifetime", value: "LIFETIME" },
                ]}
                helpText="How your app measures revenue against the cap."
              />
            </FormLayout.Group>
          </FormLayout>
        </BlockStack>
      </Card>

      {/* ------------------------------------------------- usage tiering */}
      <Card>
        <BlockStack gap="300">
          <Text as="h2" variant="headingMd">
            Automatic tiering
          </Text>
          <Text as="p" tone="subdued" variant="bodySm">
            Optional. When usage of the metric exceeds the limit, the merchant is
            moved to the target plan.
          </Text>
          <FormLayout>
            <FormLayout.Group>
              <TextField
                label="Limit metric"
                name="limitMetric"
                value={fields.limitMetric}
                onChange={set("limitMetric")}
                autoComplete="off"
                placeholder="revenue_cap_limit"
                helpText="A usage-event name. Matching a LIMIT feature's key makes that entitlement the ceiling."
              />
              <TextField
                label="Limit max"
                name="limitMax"
                value={fields.limitMax}
                onChange={set("limitMax")}
                autoComplete="off"
                helpText="Fallback ceiling when no feature states one."
              />
            </FormLayout.Group>
            <Select
              label="Upgrade to plan"
              name="autoUpgradeToPlanId"
              options={[
                { label: "No automatic upgrade", value: "" },
                ...targets.map((t) => ({ label: t.label, value: t.id })),
              ]}
              value={autoUpgradeToPlanId}
              onChange={setAutoUpgradeToPlanId}
            />
          </FormLayout>
        </BlockStack>
      </Card>

      {/* ------------------------------------------------------- features */}
      <Card>
        <BlockStack gap="300">
          <Text as="h2" variant="headingMd">
            Features
          </Text>
          {appFeatures.length === 0 ? (
            <Text as="p" tone="subdued" variant="bodySm">
              This app defines no features yet. Add them on the{" "}
              <Link url="/app/plan-features">Features</Link> page, then every
              plan can differentiate on them.
            </Text>
          ) : (
            <BlockStack gap="300">
              <Checkbox
                label="This plan differentiates on features"
                name="differentiates"
                checked={differentiates}
                onChange={setDifferentiates}
                helpText="Leave off and the plan grants every feature's default."
              />
              {differentiates ? (
                <BlockStack gap="0">
                  <Divider />
                  <div style={{ padding: "8px 0" }}>
                    <InlineStack align="space-between">
                      <Text as="span" variant="bodySm" tone="subdued">
                        Feature name
                      </Text>
                      <Text as="span" variant="bodySm" tone="subdued">
                        Entitlement
                      </Text>
                    </InlineStack>
                  </div>
                  {appFeatures.map((feature) => (
                    <div key={feature.id}>
                      <Divider />
                      <div style={{ padding: "10px 0" }}>
                        {feature.type === "BOOLEAN" ? (
                          <InlineStack align="space-between" blockAlign="center">
                            <Text as="span">{feature.name}</Text>
                            <Checkbox
                              label="Enabled"
                              name={`feat:${feature.id}`}
                              checked={entitlements[feature.id] === "true"}
                              onChange={(checked) =>
                                setEntitlement(
                                  feature.id,
                                  checked ? "true" : "false",
                                )
                              }
                            />
                          </InlineStack>
                        ) : (
                          <TextField
                            label={feature.name}
                            name={`feat:${feature.id}`}
                            autoComplete="off"
                            value={entitlements[feature.id] ?? ""}
                            onChange={(value) => setEntitlement(feature.id, value)}
                            placeholder={`default: ${feature.defaultValue}`}
                            helpText={
                              feature.type === "STRING"
                                ? undefined
                                : `A number, or "${UNLIMITED}". Blank keeps the default.`
                            }
                          />
                        )}
                      </div>
                    </div>
                  ))}
                </BlockStack>
              ) : null}
            </BlockStack>
          )}
        </BlockStack>
      </Card>

      <InlineStack align={footerStart ? "space-between" : "end"}>
        {footerStart}
        <Button submit variant="primary" loading={busy}>
          {submitLabel}
        </Button>
      </InlineStack>
    </BlockStack>
  );
}
