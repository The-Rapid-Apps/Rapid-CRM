import { useEffect, useState } from "react";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Box,
  Card,
  Checkbox,
  ChoiceList,
  DataTable,
  FormLayout,
  InlineGrid,
  InlineStack,
  Link,
  Modal,
  Page,
  Pagination,
  RadioButton,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { data, Form, useNavigate, useNavigation, useSubmit } from "react-router";
import { DiscountIcon } from "@shopify/polaris-icons";
import type { Route } from "./+types/discounts";
import { ProductEmptyState } from "~/components/product-empty-state";
import { requireUser } from "~/lib/auth/session.server";
import { AppPicker } from "~/components/app-picker";
import { ConfirmDialog } from "~/components/confirm-dialog";
import { prisma } from "~/lib/db.server";
import type { Prisma } from "../../../generated/prisma/client";
import { discountInApp } from "~/lib/flex/discounts.server";
import {
  createDiscountForOrganization,
  setDiscountActiveForOrganization,
  deleteDiscountForOrganization,
  updateDiscountForOrganization,
  type DiscountMutationInput,
} from "~/lib/flex/discount-management.server";
import { formatDateTime, formatMoney } from "~/lib/format";

/** Discount definitions per page of the list. */
const DISCOUNT_PAGE_SIZE = 20;

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);

  const apps = await prisma.app.findMany({
    where: {
      organizationId: user.organizationId,
      removed: false,
      scheduledForDeletionAt: null,
    },
    orderBy: { name: "asc" },
    select: { id: true, name: true, logoUrl: true },
  });

  /* Honours the sidebar's per-app link, validated against this organization's
     own apps so an id from elsewhere reads as "All apps" rather than selecting
     something. Absent or unknown is the cross-app view this page always had. */
  const url = new URL(request.url);
  const requestedAppId = url.searchParams.get("appId")?.trim() ?? "";
  // Code or description, case-insensitive (the column collation is _ci).
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
  const page = Math.max(1, Math.floor(Number(url.searchParams.get("page")) || 1));
  const appId = apps.some((app) => app.id === requestedAppId)
    ? requestedAppId
    : "";
  /* Applied to redemptions as well as discounts: a scoped page showing one
     app's codes beside another app's recent redemptions would be worse than
     not filtering at all. */
  const appScope = appId
    ? { appId }
    : { app: { organizationId: user.organizationId } };

  /* Each condition its own AND entry: the app scope and the search are both
     ORs, and spreading them into one object let the search's OR silently
     replace the app's — a scoped search would have listed every app. */
  const discountWhere = {
    organizationId: user.organizationId,
    AND: [
      // A scoped view includes discounts SHARED with that app, not just its own.
      ...(appId ? [discountInApp(appId)] : []),
      ...(q ? [{ OR: [{ code: { contains: q } }, { description: { contains: q } }] }] : []),
    ],
  } satisfies Prisma.DiscountWhereInput;
  const total = await prisma.discount.count({ where: discountWhere });
  const pageCount = Math.max(1, Math.ceil(total / DISCOUNT_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);

  const [discounts, recentRedemptions] = await Promise.all([
    prisma.discount.findMany({
      where: discountWhere,
      include: {
        app: { select: { name: true } },
        apps: { select: { app: { select: { id: true, name: true } } } },
        plan: { select: { name: true } },
        _count: {
          select: {
            redemptions: true,
            subscriptionDiscounts: true,
          },
        },
      },
      // `id` breaks createdAt ties so rows never swap between pages.
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (currentPage - 1) * DISCOUNT_PAGE_SIZE,
      take: DISCOUNT_PAGE_SIZE,
    }),
    prisma.discountRedemption.findMany({
      where: appScope,
      orderBy: { createdAt: "desc" },
      take: 20,
      include: {
        app: { select: { name: true } },
        discount: { select: { code: true } },
      },
    }),
  ]);

  /* The plan handles each app has actually sent when resolving a code, with
     the price it sent for them — the only trustworthy source: handles are
     app-owned, matched by exact text, and a guessed one would make a
     discount silently never apply. */
  const handleRows = await prisma.discountRedemption.groupBy({
    by: ["appId", "externalPlanKey", "currencyCode"],
    where: { app: { organizationId: user.organizationId } },
    _max: { listPrice: true },
    _count: { _all: true },
  });
  const planHandles = handleRows
    .map((row) => ({
      appId: row.appId,
      key: row.externalPlanKey,
      price: Number(row._max.listPrice ?? 0),
      currency: row.currencyCode,
      yearly: /(year|annual)/i.test(row.externalPlanKey),
      uses: row._count._all,
    }))
    .sort((a, b) => a.price - b.price || a.key.localeCompare(b.key));

  const now = new Date();
  return {
    apps,
    appId,
    planHandles,
    q,
    page: currentPage,
    pageCount,
    total,
    discounts: discounts.map((discount) => ({
      id: discount.id,
      appId: discount.appId,
      app: discount.app.name,
      /* Every app it is valid in, primary first; `apps` always includes the
         primary, but it is merged in case a row predates the join table. */
      appIds: [...new Set([discount.appId, ...discount.apps.map((row) => row.app.id)])],
      appNames: [
        ...new Set([discount.app.name, ...discount.apps.map((row) => row.app.name)]),
      ],
      legacyPlan: discount.plan?.name ?? null,
      externalPlanKey: discount.externalPlanKey ?? "",
      code: discount.code ?? "",
      type: discount.type,
      value: discount.value.toString(),
      method: discount.discountMethod,
      durationIntervals: discount.durationIntervals,
      currencyCode: discount.currencyCode ?? "",
      startsAt: discount.startsAt?.toISOString() ?? null,
      endsAt: discount.endsAt?.toISOString() ?? null,
      maxRedemptions: discount.maxRedemptions,
      maxRedemptionsPerShop: discount.maxRedemptionsPerShop,
      description: discount.description ?? "",
      active: discount.active,
      redemptionCount: discount._count.redemptions,
      /* Any use blocks deleting: that history is what merchants were charged. */
      usedCount: discount._count.redemptions + discount._count.subscriptionDiscounts,
      state: !discount.active
        ? ("inactive" as const)
        : discount.startsAt && discount.startsAt > now
          ? ("scheduled" as const)
          : discount.endsAt && discount.endsAt < now
            ? ("ended" as const)
            : discount.discountMethod !== "PRICE_REDUCTION"
              ? ("legacy" as const)
              : ("active" as const),
    })),
    redemptions: recentRedemptions.map((redemption) => ({
      id: redemption.id,
      app: redemption.app.name,
      code: redemption.discount.code ?? "—",
      shopDomain: redemption.shopDomain,
      planKey: redemption.externalPlanKey,
      status: redemption.status,
      listPrice: Number(redemption.listPrice),
      priceAfterDiscount: Number(redemption.priceAfterDiscount),
      currencyCode: redemption.currencyCode,
      date: (redemption.appliedAt ?? redemption.reservedAt).toISOString(),
    })),
  };
}

function mutationInput(form: FormData): DiscountMutationInput {
  return {
    appId: String(form.get("appId") ?? ""),
    appIds: form.getAll("appIds").map(String),
    planId: null,
    externalPlanKey: String(form.get("externalPlanKey") ?? "") || null,
    code: String(form.get("code") ?? ""),
    type: String(form.get("type") ?? ""),
    value: String(form.get("value") ?? ""),
    discountMethod: "PRICE_REDUCTION",
    durationIntervals: String(form.get("durationIntervals") ?? "") || null,
    currencyCode: String(form.get("currencyCode") ?? "") || null,
    startsAt: String(form.get("startsAt") ?? "") || null,
    endsAt: String(form.get("endsAt") ?? "") || null,
    maxRedemptions: String(form.get("maxRedemptions") ?? "") || null,
    maxRedemptionsPerShop:
      String(form.get("maxRedemptionsPerShop") ?? "") || null,
    description: String(form.get("description") ?? "") || null,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const user = await requireUser(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  try {
    if (intent === "create") {
      await createDiscountForOrganization(
        user.organizationId,
        mutationInput(form),
      );
      return { ok: true as const, message: "Native discount created." };
    }
    if (intent === "update") {
      await updateDiscountForOrganization(
        user.organizationId,
        String(form.get("discountId") ?? ""),
        mutationInput(form),
      );
      return { ok: true as const, message: "Native discount updated." };
    }
    if (intent === "delete") {
      const removed = await deleteDiscountForOrganization(
        user.organizationId,
        String(form.get("discountId") ?? ""),
      );
      return {
        ok: true as const,
        message: `${removed.code ?? "Discount"} deleted.`,
      };
    }
    if (intent === "activate" || intent === "deactivate") {
      await setDiscountActiveForOrganization(
        user.organizationId,
        String(form.get("discountId") ?? ""),
        intent === "activate",
      );
      return {
        ok: true as const,
        message:
          intent === "activate"
            ? "Discount activated."
            : "Discount deactivated.",
      };
    }
    return data(
      { ok: false as const, error: "Unsupported discount action." },
      { status: 400 },
    );
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "DiscountManagementError" &&
      "message" in error &&
      typeof error.message === "string" &&
      "status" in error &&
      typeof error.status === "number"
    ) {
      const managementError: {
        message: string;
        status: number;
        field?: string;
      } = {
        message: error.message,
        status: error.status,
        ...("field" in error && typeof error.field === "string"
          ? { field: error.field }
          : {}),
      };
      return data(
        {
          ok: false as const,
          error: managementError.message,
          field: managementError.field,
        },
        { status: managementError.status },
      );
    }
    throw error;
  }
}

type EditableDiscount = Route.ComponentProps["loaderData"]["discounts"][number];

function inputDate(value: string | null) {
  return value ? value.slice(0, 16) : "";
}

function valueLabel(discount: EditableDiscount) {
  if (discount.type === "PERCENTAGE") return `${discount.value}% off`;
  if (discount.type === "AMOUNT") {
    return `${discount.value} ${discount.currencyCode} off`;
  }
  return `${discount.value} ${discount.currencyCode} final price`;
}

const STATE_BADGE = {
  active: { label: "Active", tone: "success" as const },
  scheduled: { label: "Scheduled", tone: "info" as const },
  ended: { label: "Ended", tone: "attention" as const },
  inactive: { label: "Inactive", tone: undefined },
  legacy: { label: "Legacy credit", tone: "warning" as const },
};

export default function Discounts({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { apps, appId: scopedAppId, q, page, pageCount, total, discounts, redemptions } =
    loaderData;
  /* The row the delete dialog is about, named in it so the operator reads
     what is about to go rather than trusting which row they clicked. */
  const [deleteTarget, setDeleteTarget] = useState<EditableDiscount | null>(null);
  const submit = useSubmit();
  const goToPage = (next: number) => {
    const params = new URLSearchParams();
    if (scopedAppId) params.set("appId", scopedAppId);
    if (q) params.set("q", q);
    if (next > 1) params.set("page", String(next));
    const query = params.toString();
    navigate(query ? `/app/discounts?${query}` : "/app/discounts");
  };
  const [search, setSearch] = useState(q);
  const navigate = useNavigate();

  /* The loader filters, not the browser: the sidebar links here with the same
     parameter, and a shared URL has to reproduce the same view. */
  const selectApp = (next: string) =>
    navigate(
      next ? `/app/discounts?appId=${encodeURIComponent(next)}` : "/app/discounts",
    );
  const selectedAppName =
    apps.find((app) => app.id === scopedAppId)?.name ?? null;
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const [editingId, setEditingId] = useState<string | null>(null);
  /* The NEW-discount form's own app, distinct from the page filter above.
     Defaults to whichever app is being viewed, so creating a code from inside
     Rapi Cart does not quietly attach it to whichever app sorts first. */
  const [appId, setAppId] = useState(scopedAppId || apps[0]?.id || "");
  /* The other apps the discount is also valid in. One code, one discount,
     usable in any of them — codes are unique across the organization. */
  const [extraAppIds, setExtraAppIds] = useState<string[]>([]);
  const [type, setType] = useState("PERCENTAGE");
  const [fields, setFields] = useState({
    code: "",
    externalPlanKey: "",
    value: "",
    currencyCode: "USD",
    durationIntervals: "",
    startsAt: "",
    endsAt: "",
    maxRedemptions: "",
    maxRedemptionsPerShop: "",
    description: "",
  });
  const activeCount = discounts.filter(
    (discount) => discount.state === "active",
  ).length;
  const appliedCount = redemptions.filter(
    (redemption) => redemption.status === "APPLIED",
  ).length;

  /* Close the Edit popup when its save lands. Keyed on the action result, so
     a failed save keeps the popup open with the error above the form. */
  useEffect(() => {
    if (actionData?.ok && editingId) resetEditor();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionData]);

  /* Which opt-in limits are ticked. All off by default — a new code has no
     limits unless someone chooses one (the per-store limit used to default
     to 1, which quietly made every code single-use per store). */
  const NO_LIMITS = { duration: false, plan: false, total: false, perStore: false, dates: false };
  const [limits, setLimits] = useState(NO_LIMITS);
  const setLimit = (key: keyof typeof NO_LIMITS, on: boolean) => {
    setLimits((current) => ({ ...current, [key]: on }));
    if (key === "plan") {
      setOtherPlan(false);
      /* Make the shown choice the saved one: the dropdown displays the first
         plan when none is set, so set it rather than save an empty handle. */
      if (on && !fields.externalPlanKey && planOptions[0]) {
        setFields((previous) => ({ ...previous, externalPlanKey: planOptions[0]!.value }));
      }
    }
    // Ticking "per store" starts at the usual answer, once per store.
    if (key === "perStore" && on && !fields.maxRedemptionsPerShop) {
      setFields((previous) => ({ ...previous, maxRedemptionsPerShop: "1" }));
    }
  };

  /* Plan dropdown: handles from the apps this discount is available in,
     one option per handle, priced per app when the apps differ
     ("starter-monthly — $15.00/mo in Rapid Bundle · $29.00/mo in Rappi Dev"). */
  const OTHER_PLAN = "__other__";
  const [otherPlan, setOtherPlan] = useState(false);
  const discountAppIds = [appId, ...extraAppIds];
  const multiAppDiscount = discountAppIds.length > 1;
  const planOptions = [...new Set(
    loaderData.planHandles
      .filter((h) => discountAppIds.includes(h.appId))
      .map((h) => h.key),
  )].map((key) => {
    const perApp = loaderData.planHandles.filter(
      (h) => h.key === key && discountAppIds.includes(h.appId),
    );
    const price = (h: (typeof perApp)[number]) =>
      `${formatMoney(String(h.price), h.currency)}${h.yearly ? "/yr" : "/mo"}`;
    const prices = [...new Set(perApp.map(price))];
    const appName = (id: string) => apps.find((a) => a.id === id)?.name ?? "";
    return {
      label:
        prices.length === 1 && !(multiAppDiscount && perApp.length < discountAppIds.length)
          ? `${key} — ${prices[0]}`
          : `${key} — ${perApp.map((h) => `${price(h)} in ${appName(h.appId)}`).join(" · ")}`,
      value: key,
    };
  });
  const knownPlan = planOptions.some((o) => o.value === fields.externalPlanKey);
  const planSelectValue =
    otherPlan || !fields.externalPlanKey || !knownPlan ? OTHER_PLAN : fields.externalPlanKey;

  const setField = (key: keyof typeof fields) => (value: string) =>
    setFields((previous) => ({ ...previous, [key]: value }));

  const resetEditor = () => {
    setEditingId(null);
    setLimits(NO_LIMITS);
    setAppId(apps[0]?.id ?? "");
    setExtraAppIds([]);
    setType("PERCENTAGE");
    setFields({
      code: "",
      externalPlanKey: "",
      value: "",
      currencyCode: "USD",
      durationIntervals: "",
      startsAt: "",
      endsAt: "",
      maxRedemptions: "",
      maxRedemptionsPerShop: "",
      description: "",
    });
  };

  const edit = (discount: EditableDiscount) => {
    setEditingId(discount.id);
    // Tick exactly the limits this discount already has.
    setLimits({
      duration: discount.durationIntervals !== null,
      plan: Boolean(discount.externalPlanKey),
      total: discount.maxRedemptions !== null,
      perStore: discount.maxRedemptionsPerShop !== null,
      dates: Boolean(discount.startsAt || discount.endsAt),
    });
    setAppId(discount.appId);
    setExtraAppIds(discount.appIds.filter((id) => id !== discount.appId));
    setType(discount.type);
    setFields({
      code: discount.code,
      externalPlanKey: discount.externalPlanKey,
      value: discount.value,
      currencyCode: discount.currencyCode || "USD",
      durationIntervals: discount.durationIntervals?.toString() ?? "",
      startsAt: inputDate(discount.startsAt),
      endsAt: inputDate(discount.endsAt),
      maxRedemptions: discount.maxRedemptions?.toString() ?? "",
      maxRedemptionsPerShop: discount.maxRedemptionsPerShop?.toString() ?? "",
      description: discount.description,
    });
  };

  /* One form, two homes: inline in the "New discount" card, and inside the
     Edit popup — so the fields, validation and hidden inputs cannot drift
     between creating and editing. */
  const discountForm = (
    <Form method="post">
      <input
        type="hidden"
        name="intent"
        value={editingId ? "update" : "create"}
      />
      {editingId ? (
        <>
          <input
            type="hidden"
            name="discountId"
            value={editingId}
          />
          <input type="hidden" name="appId" value={appId} />
        </>
      ) : null}
      <FormLayout>
        <Select
          label={editingId ? "Created for" : "App"}
          name={editingId ? undefined : "appId"}
          options={apps.map((app) => ({
            label: app.name,
            value: app.id,
          }))}
          value={appId}
          disabled={Boolean(editingId)}
          onChange={(next) => {
            setAppId(next);
            setExtraAppIds((ids) => ids.filter((id) => id !== next));
          }}
        />
        {apps.length > 1 ? (
          <>
            <ChoiceList
              allowMultiple
              title="Also available in"
              choices={apps
                .filter((app) => app.id !== appId)
                .map((app) => ({ label: app.name, value: app.id }))}
              selected={extraAppIds}
              onChange={setExtraAppIds}
            />
            {extraAppIds.map((id) => (
              <input key={id} type="hidden" name="appIds" value={id} />
            ))}
          </>
        ) : null}
        <TextField
          label="Code"
          name="code"
          value={fields.code}
          onChange={setField("code")}
          maxLength={64}
          autoComplete="off"
          helpText="Saved uppercase; unique across all your apps."
          requiredIndicator
        />
        <Select
          label="Discount type"
          name="type"
          options={[
            {
              label: "Percentage off",
              value: "PERCENTAGE",
            },
            { label: "Amount off", value: "AMOUNT" },
            {
              label: "Final subscription price",
              value: "FLAT_PRICE",
            },
          ]}
          value={type}
          onChange={setType}
        />
        <InlineGrid
          columns={type === "PERCENTAGE" ? 1 : 2}
          gap="300"
        >
          <TextField
            label="Value"
            name="value"
            type="number"
            min="0.000001"
            max={
              type === "PERCENTAGE"
                ? "100"
                : "999999999999.999999"
            }
            step={0.000001}
            suffix={type === "PERCENTAGE" ? "%" : undefined}
            value={fields.value}
            onChange={setField("value")}
            autoComplete="off"
            requiredIndicator
          />
          {type !== "PERCENTAGE" ? (
            <TextField
              label="Currency"
              name="currencyCode"
              value={fields.currencyCode}
              onChange={setField("currencyCode")}
              maxLength={3}
              autoComplete="off"
              requiredIndicator
            />
          ) : null}
        </InlineGrid>
        {/* Laid out like Mantle's discount form: a duration choice, then
            opt-in limits. Every limit is OFF unless its box is ticked, and an
            unticked limit sends no field at all — so the default is
            "no limit" and nothing can be saved half-set. */}
        <BlockStack gap="200">
          <Text as="p" fontWeight="medium">
            Duration
          </Text>
          <RadioButton
            label="Forever"
            helpText="The discount applies to every billing cycle."
            checked={!limits.duration}
            id="duration-forever"
            onChange={() => setLimit("duration", false)}
          />
          <RadioButton
            label="Limited time"
            checked={limits.duration}
            id="duration-limited"
            onChange={() => setLimit("duration", true)}
          />
          {limits.duration ? (
            <Box paddingInlineStart="600">
              <TextField
                label="Billing cycles"
                labelHidden
                name="durationIntervals"
                type="integer"
                min={1}
                max={1200}
                suffix="billing cycles"
                value={fields.durationIntervals}
                onChange={setField("durationIntervals")}
                autoComplete="off"
                helpText="How many billing cycles the merchant gets the discount for, then full price."
                requiredIndicator
              />
            </Box>
          ) : null}
        </BlockStack>

        <BlockStack gap="200">
          <Checkbox
            label="This discount only applies to a specific plan"
            checked={limits.plan}
            onChange={(on) => setLimit("plan", on)}
          />
          {limits.plan ? (
            <Box paddingInlineStart="600">
              <BlockStack gap="200">
                <Select
                  label="Plan"
                  options={[
                    ...(planOptions.length === 0
                      ? [{ label: "No plans seen yet for these apps", value: "", disabled: true }]
                      : planOptions),
                    { label: "Other handle…", value: OTHER_PLAN },
                  ]}
                  value={planSelectValue}
                  onChange={(next) => {
                    if (next === OTHER_PLAN) {
                      setOtherPlan(true);
                      setFields((f) => ({ ...f, externalPlanKey: "" }));
                    } else {
                      setOtherPlan(false);
                      setFields((f) => ({ ...f, externalPlanKey: next }));
                    }
                  }}
                  helpText="Plans your apps have sent when applying a code, with the price they sent."
                />
                {planSelectValue === OTHER_PLAN ? (
                  <TextField
                    label="Plan handle"
                    value={fields.externalPlanKey}
                    onChange={setField("externalPlanKey")}
                    autoComplete="off"
                    placeholder="e.g. pro-annual"
                    helpText="Exactly as your app sends it — the code only applies when the handle matches."
                    requiredIndicator
                  />
                ) : null}
                <input type="hidden" name="externalPlanKey" value={fields.externalPlanKey} />
              </BlockStack>
            </Box>
          ) : null}

          <Checkbox
            label="This discount can only be redeemed a specific number of times"
            helpText="Across all stores combined."
            checked={limits.total}
            onChange={(on) => setLimit("total", on)}
          />
          {limits.total ? (
            <Box paddingInlineStart="600">
              <TextField
                label="Total redemptions"
                labelHidden
                name="maxRedemptions"
                type="integer"
                min={1}
                suffix="redemptions in total"
                value={fields.maxRedemptions}
                onChange={setField("maxRedemptions")}
                autoComplete="off"
                requiredIndicator
              />
            </Box>
          ) : null}

          <Checkbox
            label="Limit how many times one store can redeem it"
            helpText="For example 1, so each store can use the code only once."
            checked={limits.perStore}
            onChange={(on) => setLimit("perStore", on)}
          />
          {limits.perStore ? (
            <Box paddingInlineStart="600">
              <TextField
                label="Redemptions per store"
                labelHidden
                name="maxRedemptionsPerShop"
                type="integer"
                min={1}
                suffix="per store"
                value={fields.maxRedemptionsPerShop}
                onChange={setField("maxRedemptionsPerShop")}
                autoComplete="off"
                requiredIndicator
              />
            </Box>
          ) : null}

          <Checkbox
            label="Only available between specific dates"
            helpText="Outside this window the code can't be redeemed."
            checked={limits.dates}
            onChange={(on) => setLimit("dates", on)}
          />
          {limits.dates ? (
            <Box paddingInlineStart="600">
              <InlineGrid columns={2} gap="300">
                <TextField
                  label="Starts"
                  name="startsAt"
                  type="datetime-local"
                  value={fields.startsAt}
                  onChange={setField("startsAt")}
                  autoComplete="off"
                />
                <TextField
                  label="Ends"
                  name="endsAt"
                  type="datetime-local"
                  value={fields.endsAt}
                  onChange={setField("endsAt")}
                  autoComplete="off"
                />
              </InlineGrid>
            </Box>
          ) : null}
        </BlockStack>
        <TextField
          label="Internal description"
          name="description"
          value={fields.description}
          onChange={setField("description")}
          maxLength={191}
          showCharacterCount
          autoComplete="off"
        />
        <Button submit variant="primary" loading={busy}>
          {editingId ? "Save discount" : "Create discount"}
        </Button>
      </FormLayout>
    </Form>
  );

  return (
    <Page
      title="Discounts"
      subtitle={
        selectedAppName
          ? `Discount codes for ${selectedAppName}`
          : "Central discount service for native Shopify app subscriptions"
      }
      fullWidth
      titleMetadata={
        apps.length > 1 ? (
          <AppPicker
            labelHidden
            value={scopedAppId}
            onChange={selectApp}
            apps={apps}
          />
        ) : undefined
      }
    >
      <div className="discounts-workspace">
        <BlockStack gap="500">
          {actionData?.ok ? (
            <Banner tone="success">{actionData.message}</Banner>
          ) : actionData && !actionData.ok ? (
            <Banner tone="critical">{actionData.error}</Banner>
          ) : null}

          <Banner title="Native Shopify billing workflow" tone="info">
            Apps reserve a code through the API, place the returned value under
            appRecurringPricingDetails.discount, then confirm the reservation
            only after Shopify reports the subscription active.
          </Banner>

          <InlineGrid columns={{ xs: 2, md: 4 }} gap="300">
            <div className="discounts-summary-card">
              <span>Discounts</span>
              <strong>{discounts.length.toLocaleString()}</strong>
              <small>
                {selectedAppName
                  ? selectedAppName
                  : `Across ${apps.length} apps`}
              </small>
            </div>
            <div className="discounts-summary-card">
              <span>Currently active</span>
              <strong>{activeCount.toLocaleString()}</strong>
              <small>Available to resolve now</small>
            </div>
            <div className="discounts-summary-card">
              <span>Recent reservations</span>
              <strong>{redemptions.length.toLocaleString()}</strong>
              <small>Latest activity shown below</small>
            </div>
            <div className="discounts-summary-card">
              <span>Recently applied</span>
              <strong>{appliedCount.toLocaleString()}</strong>
              <small>Verified Shopify subscriptions</small>
            </div>
          </InlineGrid>

          <InlineGrid columns={{ xs: 1, lg: "2fr 1fr" }} gap="400">
            <Card padding="0">
              <div className="discounts-section-header">
                <div>
                  <Text as="h2" variant="headingMd">
                    Discount definitions
                  </Text>
                  <Text as="p" tone="subdued">
                    App-owned plan handles; no internal plan catalog required.
                  </Text>
                </div>
                <Badge tone="success">Native billing ready</Badge>
              </div>
              <div style={{ padding: "0 var(--p-space-400) var(--p-space-300)" }}>
                <Form method="get">
                  {scopedAppId ? <input type="hidden" name="appId" value={scopedAppId} /> : null}
                  <TextField
                    label="Search discounts"
                    labelHidden
                    name="q"
                    value={search}
                    onChange={setSearch}
                    placeholder="Search by code or description"
                    autoComplete="off"
                    clearButton
                    onClearButtonClick={() => {
                      setSearch("");
                      navigate(scopedAppId ? `/app/discounts?appId=${encodeURIComponent(scopedAppId)}` : "/app/discounts");
                    }}
                  />
                </Form>
              </div>
              {discounts.length === 0 ? (
                <ProductEmptyState
                  title="Launch your first discount"
                  description="Create a controlled offer for native Shopify billing, with eligibility, redemption limits, and audit history."
                  icon={DiscountIcon}
                  action={{
                    content: "Create discount",
                    url: "#create-discount",
                  }}
                />
              ) : (
                <DataTable
                  columnContentTypes={[
                    "text",
                    "text",
                    "text",
                    "text",
                    "numeric",
                    "text",
                    "text",
                  ]}
                  headings={[
                    "App / code",
                    "Plan scope",
                    "Value",
                    "Campaign",
                    "Uses",
                    "Status",
                    "Actions",
                  ]}
                  rows={discounts.map((discount) => {
                    const state = STATE_BADGE[discount.state];
                    const window =
                      discount.startsAt || discount.endsAt
                        ? `${discount.startsAt ? formatDateTime(discount.startsAt) : "Now"} → ${
                            discount.endsAt
                              ? formatDateTime(discount.endsAt)
                              : "No end"
                          }`
                        : "Always available";
                    return [
                      <div
                        className="discounts-primary-cell"
                        key={`${discount.id}-identity`}
                      >
                        <Link url={`/app/discounts/${discount.id}`} removeUnderline>
                          <strong>{discount.code}</strong>
                        </Link>
                        {scopedAppId && discount.appNames.length === 1 ? null : (
                          <span>{discount.appNames.join(" · ")}</span>
                        )}
                      </div>,
                      discount.externalPlanKey ||
                        discount.legacyPlan ||
                        "All app plans",
                      valueLabel(discount),
                      window,
                      discount.redemptionCount,
                      <Badge key={`${discount.id}-status`} tone={state.tone}>
                        {state.label}
                      </Badge>,
                      <InlineStack
                        key={`${discount.id}-actions`}
                        gap="200"
                        wrap={false}
                      >
                        <Button
                          variant="plain"
                          onClick={() => edit(discount)}
                          disabled={busy}
                        >
                          Edit
                        </Button>
                        <Button
                          variant="plain"
                          tone="critical"
                          onClick={() => setDeleteTarget(discount)}
                          disabled={busy}
                        >
                          Delete
                        </Button>
                        <Form method="post">
                          <input
                            type="hidden"
                            name="discountId"
                            value={discount.id}
                          />
                          <input
                            type="hidden"
                            name="intent"
                            value={discount.active ? "deactivate" : "activate"}
                          />
                          <Button
                            submit
                            variant="plain"
                            tone={discount.active ? "critical" : "success"}
                          >
                            {discount.active ? "Disable" : "Enable"}
                          </Button>
                        </Form>
                      </InlineStack>,
                    ];
                  })}
                />
              )}
              {pageCount > 1 ? (
                <div className="discounts-section-header">
                  <Text as="span" tone="subdued" variant="bodySm">
                    {`Page ${page} of ${pageCount} · ${total.toLocaleString()} discounts`}
                  </Text>
                  <Pagination
                    hasPrevious={page > 1}
                    onPrevious={() => goToPage(page - 1)}
                    hasNext={page < pageCount}
                    onNext={() => goToPage(page + 1)}
                  />
                </div>
              ) : null}
            </Card>

            <div id="create-discount">
              <Card>
                <BlockStack gap="400">
                  <InlineStack align="space-between" blockAlign="center">
                    <div>
                      <Text as="h2" variant="headingMd">
                        New discount
                      </Text>
                      <Text as="p" tone="subdued">
                        Shopify recurring pricing only
                      </Text>
                    </div>
                  </InlineStack>

                  {apps.length === 0 ? (
                    <Text as="p" tone="subdued">
                      Connect an app before creating discounts.
                    </Text>
                  ) : editingId ? (
                    // The form is in the Edit popup; one copy at a time.
                    <Text as="p" tone="subdued">
                      Editing a discount — finish in the popup.
                    </Text>
                  ) : (
                    discountForm
                  )}
                </BlockStack>
              </Card>
            </div>
          </InlineGrid>

          <Card padding="0">
            <div className="discounts-section-header">
              <div>
                <Text as="h2" variant="headingMd">
                  Recent native redemptions
                </Text>
                <Text as="p" tone="subdued">
                  Immutable snapshots reserved before Shopify approval.
                </Text>
              </div>
            </div>
            {redemptions.length === 0 ? (
              <div className="discounts-empty">
                <Text as="p" tone="subdued">
                  Redemptions appear after an app calls POST
                  /api/discounts/resolve.
                </Text>
              </div>
            ) : (
              <DataTable
                columnContentTypes={[
                  "text",
                  "text",
                  "text",
                  "text",
                  "text",
                  "text",
                ]}
                headings={[
                  "App / code",
                  "Shop",
                  "External plan",
                  "Pricing",
                  "Status",
                  "Updated",
                ]}
                rows={redemptions.map((redemption) => [
                  `${redemption.app} · ${redemption.code}`,
                  redemption.shopDomain,
                  redemption.planKey,
                  `${formatMoney(redemption.listPrice, redemption.currencyCode)} → ${formatMoney(redemption.priceAfterDiscount, redemption.currencyCode)}`,
                  <Badge
                    key={`${redemption.id}-status`}
                    tone={
                      redemption.status === "APPLIED"
                        ? "success"
                        : redemption.status === "RESERVED"
                          ? "info"
                          : undefined
                    }
                  >
                    {redemption.status.toLowerCase()}
                  </Badge>,
                  formatDateTime(redemption.date),
                ])}
              />
            )}
          </Card>
        </BlockStack>
      </div>
      <Modal
        open={editingId !== null}
        onClose={resetEditor}
        title={`Edit ${fields.code || "discount"}`}
      >
        <Modal.Section>
          <BlockStack gap="300">
            {/* The page banner sits behind the popup, so repeat a failed save here. */}
            {actionData && !actionData.ok ? (
              <Banner tone="critical">{actionData.error}</Banner>
            ) : null}
            {discountForm}
          </BlockStack>
        </Modal.Section>
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title={
          deleteTarget?.usedCount
            ? `${deleteTarget.code} can't be deleted`
            : `Delete ${deleteTarget?.code ?? "discount"}?`
        }
        confirmLabel={deleteTarget?.usedCount ? (deleteTarget.active ? "Disable instead" : "Close") : "Delete discount"}
        destructive={!deleteTarget?.usedCount}
        loading={busy}
        onConfirm={() => {
          if (!deleteTarget) return;
          if (deleteTarget.usedCount && !deleteTarget.active) {
            setDeleteTarget(null);
            return;
          }
          void submit(
            {
              intent: deleteTarget.usedCount ? "deactivate" : "delete",
              discountId: deleteTarget.id,
            },
            { method: "post" },
          );
          setDeleteTarget(null);
        }}
      >
        {deleteTarget?.usedCount ? (
          <BlockStack gap="200">
            <Text as="p">
              {`It has been used ${deleteTarget.usedCount} time${deleteTarget.usedCount === 1 ? "" : "s"}. That history is the record of what merchants were charged, so it stays.`}
            </Text>
            <Text as="p" tone="subdued">
              {deleteTarget.active
                ? "Disabling stops anyone new from using the code; merchants already on it are unaffected."
                : "It is already disabled, so nobody new can use it."}
            </Text>
          </BlockStack>
        ) : (
          <Text as="p">
            {`This permanently removes ${deleteTarget?.code ?? "the discount"}. Nobody has used it yet, so no merchant loses a discount.`}
          </Text>
        )}
      </ConfirmDialog>
    </Page>
  );
}
