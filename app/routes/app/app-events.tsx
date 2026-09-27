import { useEffect, useState } from "react";
import {
  Badge,
  BlockStack,
  Button,
  Card,
  Checkbox,
  EmptyState,
  Icon,
  InlineStack,
  Page,
  Pagination,
  Popover,
  Text,
  TextField,
} from "@shopify/polaris";
import {
  AlertCircleIcon,
  AlertTriangleIcon,
  AppsIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  CalendarIcon,
  CashDollarIcon,
  CheckCircleIcon,
  ClockIcon,
  CreditCardIcon,
  MagicIcon,
  PersonExitIcon,
  SearchIcon,
  XCircleIcon,
} from "@shopify/polaris-icons";
import { Form, Link, useNavigate, useNavigation } from "react-router";
import type { Route } from "./+types/app-events";
import { AppDetailTabs } from "~/components/app-detail-tabs";
import { requireCurrentOrganization } from "~/lib/current-org.server";
import { prisma } from "~/lib/db.server";
import { DATE_RANGE_PRESETS } from "~/lib/date-range";
import { formatDate, formatDateTime, formatMoney, formatRelativeTime } from "~/lib/format";
import { EMPTY_STATE_IMAGE } from "~/lib/ui";
import {
  loadAppEvents,
  loadPlanFilterOptions,
} from "~/lib/app-events/query.server";
import {
  ACTIVITY_TYPE_OPTIONS,
  BILLING_TYPE_OPTIONS,
  EVENT_META,
  PAGE_SIZE,
  PLAN_INTERVAL_OPTIONS,
  SUBSCRIPTION_TYPE_OPTIONS,
  type AppEvent,
  type AppEventFilters,
  appEventsExportUrl,
  appEventsUrl,
  customerUrl,
  parseAppEventFilters,
  scopeFromTypes,
} from "~/lib/app-events/types";
import { useBackAction } from "~/lib/use-back-action";

/** Date → YYYY-MM-DD in UTC. */
function toYmd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

const ALL_TIME_FROM = "1970-01-01";

export async function loader({ request, params }: Route.LoaderArgs) {
  const org = await requireCurrentOrganization(request);
  const app = await prisma.app.findFirst({
    where: { id: params.appId, organizationId: org.id },
    select: { id: true, name: true },
  });
  if (!app) throw new Response("App not found", { status: 404 });

  const url = new URL(request.url);
  const filters = parseAppEventFilters(url.searchParams);
  // Default to the last 30 days when the range is untouched.
  if (!filters.from && !filters.to) {
    const preset = DATE_RANGE_PRESETS.find((p) => p.key === "last_30_days")!;
    const { start, end } = preset.range(new Date());
    filters.from = toYmd(start);
    filters.to = toYmd(end);
  }
  const requestedPage = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
  const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;

  const [result, planOptions] = await Promise.all([
    loadAppEvents({ appId: app.id, orgId: org.id, filters, page }),
    loadPlanFilterOptions(app.id),
  ]);

  return { app, filters, planOptions, ...result };
}

const TYPE_ICON: Record<string, typeof AppsIcon> = {
  installed: AppsIcon,
  reinstalled: AppsIcon,
  reactivated: CheckCircleIcon,
  deactivated: AlertTriangleIcon,
  uninstalled: PersonExitIcon,
  custom: MagicIcon,
  subscription_started: CreditCardIcon,
  upgraded: ArrowUpIcon,
  downgraded: ArrowDownIcon,
  subscription_activated: CheckCircleIcon,
  subscription_unfrozen: CreditCardIcon,
  subscription_frozen: AlertTriangleIcon,
  subscription_canceled: XCircleIcon,
  subscription_expired: ClockIcon,
  charge_succeeded: CashDollarIcon,
  charge_failed: AlertCircleIcon,
};

function eventTitle(event: AppEvent): string {
  if (event.type === "custom") return event.customName || "Custom event";
  return EVENT_META[event.type]?.label ?? event.type;
}

type ContextField = { label: string; value: string; href?: string };

function contextFields(event: AppEvent, appId: string): ContextField[] {
  const fields: ContextField[] = [];
  if (event.shopDomain) {
    fields.push({
      label: "Customer",
      value: event.shopDomain,
      href: customerUrl(appId, event.shopDomain),
    });
  }
  if (event.type === "custom" && event.customName) {
    fields.push({ label: "Event name", value: event.customName });
  }
  if (event.planName) fields.push({ label: "Plan", value: event.planName });
  if (event.amount != null) {
    fields.push({
      label: "Amount",
      value: formatMoney(event.amount, event.currency ?? "USD"),
    });
  }
  if (event.reason) fields.push({ label: "Reason", value: event.reason });

  // Custom-event metadata: first few keys inline.
  if (event.type === "custom" && event.metadata) {
    const entries = Object.entries(event.metadata);
    for (const [key, raw] of entries.slice(0, 5)) {
      const value = typeof raw === "object" ? JSON.stringify(raw) : String(raw);
      fields.push({ label: key, value });
    }
    if (entries.length > 5) {
      fields.push({ label: "", value: `+${entries.length - 5} more fields` });
    }
  }
  return fields;
}

/** A popover of checkboxes that navigates on toggle (optimistic while loading). */
function MultiSelectPopover({
  label,
  options,
  selected,
  onChange,
  disabled = false,
  searchable = false,
}: {
  label: string;
  options: Array<{ value: string; label: string }>;
  selected: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  searchable?: boolean;
}) {
  const navigation = useNavigation();
  const [active, setActive] = useState(false);
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState<string[] | null>(null);

  useEffect(() => {
    if (navigation.state === "idle") setPending(null);
  }, [navigation.state]);

  const current = pending ?? selected;
  const visible = search
    ? options.filter((o) => o.label.toLowerCase().includes(search.toLowerCase()))
    : options;

  const toggle = (value: string) => {
    const next = current.includes(value)
      ? current.filter((v) => v !== value)
      : [...current, value];
    setPending(next);
    onChange(next);
  };

  return (
    <Popover
      active={active}
      onClose={() => setActive(false)}
      activator={
        <Button
          disclosure
          disabled={disabled}
          onClick={() => setActive((v) => !v)}
        >
          {current.length > 0 ? `${label} (${current.length})` : `+ ${label}`}
        </Button>
      }
    >
      <Popover.Pane fixed>
        <div style={{ padding: "var(--p-space-300)", minWidth: "240px" }}>
          <BlockStack gap="200">
            {searchable ? (
              <TextField
                label={label}
                labelHidden
                placeholder={`Search ${label.toLowerCase()}`}
                value={search}
                onChange={setSearch}
                autoComplete="off"
                clearButton
                onClearButtonClick={() => setSearch("")}
              />
            ) : null}
            <div
              className="thin-scrollbar"
              style={{ maxHeight: "280px", overflowY: "auto" }}
            >
              <BlockStack gap="150">
                {visible.map((o) => (
                  <Checkbox
                    key={o.value}
                    label={o.label}
                    checked={current.includes(o.value)}
                    onChange={() => toggle(o.value)}
                  />
                ))}
                {visible.length === 0 ? (
                  <Text as="span" variant="bodySm" tone="subdued">
                    No matches
                  </Text>
                ) : null}
              </BlockStack>
            </div>
          </BlockStack>
        </div>
      </Popover.Pane>
    </Popover>
  );
}

const DATE_PRESETS = [
  { key: "today", label: "Today" },
  { key: "last_7_days", label: "Last 7 days" },
  { key: "last_30_days", label: "Last 30 days" },
  { key: "last_90_days", label: "Last 90 days" },
];

function DateRangePopover({
  filters,
  onApply,
}: {
  filters: AppEventFilters;
  onApply: (from: string | null, to: string | null) => void;
}) {
  const [active, setActive] = useState(false);
  const [customFrom, setCustomFrom] = useState(filters.from ?? "");
  const [customTo, setCustomTo] = useState(filters.to ?? "");

  const isAllTime = filters.from === ALL_TIME_FROM;
  let label = "Date range";
  if (isAllTime) {
    label = "All time";
  } else if (filters.from && filters.to) {
    const matchedPreset = DATE_PRESETS.find((p) => {
      const preset = DATE_RANGE_PRESETS.find((x) => x.key === p.key)!;
      const { start, end } = preset.range(new Date());
      return toYmd(start) === filters.from && toYmd(end) === filters.to;
    });
    label = matchedPreset
      ? matchedPreset.label
      : `${formatDate(filters.from)} – ${formatDate(filters.to)}`;
  }

  const applyPreset = (key: string) => {
    const preset = DATE_RANGE_PRESETS.find((p) => p.key === key)!;
    const { start, end } = preset.range(new Date());
    setActive(false);
    onApply(toYmd(start), toYmd(end));
  };

  return (
    <Popover
      active={active}
      onClose={() => setActive(false)}
      activator={
        <Button
          disclosure
          icon={CalendarIcon}
          onClick={() => setActive((v) => !v)}
        >
          {label}
        </Button>
      }
    >
      <Popover.Pane fixed>
        <div style={{ padding: "var(--p-space-300)", minWidth: "260px" }}>
          <BlockStack gap="200">
            {DATE_PRESETS.map((p) => (
              <Button
                key={p.key}
                variant="tertiary"
                textAlign="left"
                fullWidth
                onClick={() => applyPreset(p.key)}
              >
                {p.label}
              </Button>
            ))}
            <Button
              variant="tertiary"
              textAlign="left"
              fullWidth
              onClick={() => {
                setActive(false);
                onApply(ALL_TIME_FROM, toYmd(new Date()));
              }}
            >
              All time
            </Button>
            <div style={{ borderTop: "1px solid var(--p-color-border)", paddingTop: "var(--p-space-200)" }}>
              <BlockStack gap="200">
                <Text as="span" variant="bodySm" tone="subdued">
                  Custom range
                </Text>
                <TextField
                  label="From"
                  type="date"
                  value={customFrom}
                  onChange={setCustomFrom}
                  autoComplete="off"
                />
                <TextField
                  label="To"
                  type="date"
                  value={customTo}
                  onChange={setCustomTo}
                  autoComplete="off"
                />
                <Button
                  onClick={() => {
                    if (customFrom && customTo) {
                      setActive(false);
                      onApply(customFrom, customTo);
                    }
                  }}
                  disabled={!customFrom || !customTo}
                >
                  Apply custom range
                </Button>
              </BlockStack>
            </div>
          </BlockStack>
        </div>
      </Popover.Pane>
    </Popover>
  );
}

export default function AppEvents({ loaderData }: Route.ComponentProps) {
  const { app, filters, planOptions, events, page, total, totalPages, scopeTotal } =
    loaderData;
  const navigate = useNavigate();
  const backAction = useBackAction({ content: app.name, url: `/app/apps/${app.id}` });
  const [q, setQ] = useState(filters.q);

  const { includeSubscription, activityTypes, subscriptionTypes } =
    scopeFromTypes(filters.types);

  const apply = (next: AppEventFilters) => navigate(appEventsUrl(app.id, next, 1));

  const setActivityTypes = (vals: string[]) =>
    apply({ ...filters, types: [...subscriptionTypes, ...vals] });
  const setSubscriptionTypes = (vals: string[]) =>
    apply({ ...filters, types: [...activityTypes, ...vals] });

  const hasFilters =
    filters.types.length > 0 ||
    filters.plans.length > 0 ||
    filters.intervals.length > 0 ||
    filters.billing.length > 0 ||
    filters.q.length > 0 ||
    filters.from === ALL_TIME_FROM;

  const planFilterOptions = planOptions.map((name) => ({
    value: name,
    label: name,
  }));

  // Removable applied-filter chips.
  const chips: Array<{ key: string; label: string; onRemove: () => void }> = [];
  for (const t of filters.types) {
    chips.push({
      key: `type:${t}`,
      label: t === "custom" ? "Custom event" : EVENT_META[t]?.label ?? t,
      onRemove: () =>
        apply({ ...filters, types: filters.types.filter((x) => x !== t) }),
    });
  }
  for (const p of filters.plans) {
    chips.push({
      key: `plan:${p}`,
      label: p,
      onRemove: () =>
        apply({ ...filters, plans: filters.plans.filter((x) => x !== p) }),
    });
  }
  for (const i of filters.intervals) {
    const opt = PLAN_INTERVAL_OPTIONS.find((o) => o.value === i);
    chips.push({
      key: `interval:${i}`,
      label: opt?.label ?? i,
      onRemove: () =>
        apply({ ...filters, intervals: filters.intervals.filter((x) => x !== i) }),
    });
  }
  for (const b of filters.billing) {
    const opt = BILLING_TYPE_OPTIONS.find((o) => o.value === b);
    chips.push({
      key: `billing:${b}`,
      label: opt?.label ?? b,
      onRemove: () =>
        apply({ ...filters, billing: filters.billing.filter((x) => x !== b) }),
    });
  }

  // Group events by local calendar day for the divider layout.
  const groups: Array<{ day: string; items: AppEvent[] }> = [];
  for (const event of events) {
    const day = formatDate(event.occurredAt);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push(event);
    else groups.push({ day, items: [event] });
  }

  return (
    <Page
      title="App events"
      subtitle={app.name}
      fullWidth
      backAction={backAction}
      primaryAction={{
        content: "Export app events",
        url: appEventsExportUrl(app.id, filters),
      }}
      secondaryActions={[
        {
          content: "Need help?",
          url: "https://help.shopify.com/en/partners/dashboard/managing-apps",
          external: true,
        },
      ]}
    >
      <BlockStack gap="400">
        <AppDetailTabs appId={app.id} active="events" />

        <Card>
          <BlockStack gap="300">
            <InlineStack gap="200" wrap>
              <MultiSelectPopover
                label="Activity events"
                options={ACTIVITY_TYPE_OPTIONS}
                selected={activityTypes}
                onChange={setActivityTypes}
              />
              <MultiSelectPopover
                label="Subscription events"
                options={SUBSCRIPTION_TYPE_OPTIONS}
                selected={subscriptionTypes}
                onChange={setSubscriptionTypes}
              />
              <DateRangePopover
                filters={filters}
                onApply={(from, to) => apply({ ...filters, from, to })}
              />
              <MultiSelectPopover
                label="Plan"
                options={planFilterOptions}
                selected={filters.plans}
                onChange={(vals) => apply({ ...filters, plans: vals })}
                disabled={!includeSubscription}
                searchable
              />
              <MultiSelectPopover
                label="Plan interval"
                options={PLAN_INTERVAL_OPTIONS}
                selected={filters.intervals}
                onChange={(vals) => apply({ ...filters, intervals: vals })}
                disabled={!includeSubscription}
              />
              <MultiSelectPopover
                label="Billing type"
                options={BILLING_TYPE_OPTIONS}
                selected={filters.billing}
                onChange={(vals) => apply({ ...filters, billing: vals })}
                disabled={!includeSubscription}
              />
              {hasFilters ? (
                <Button
                  variant="tertiary"
                  onClick={() => navigate(`/app/apps/${app.id}/events`)}
                >
                  Clear filters
                </Button>
              ) : null}
            </InlineStack>

            {chips.length > 0 ? (
              <InlineStack gap="100" wrap>
                {chips.map((chip) => (
                  <span key={chip.key} className="reports-filter-tag">
                    <span className="reports-filter-tag__label">{chip.label}</span>
                    <button
                      type="button"
                      className="reports-filter-tag__remove"
                      onClick={chip.onRemove}
                      aria-label={`Remove ${chip.label}`}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </InlineStack>
            ) : null}

            <Form method="get">
              {/* Preserve non-q filters when submitting the search box. */}
              <input type="hidden" name="types" value={filters.types.join(",")} />
              <input type="hidden" name="plans" value={filters.plans.join(",")} />
              <input
                type="hidden"
                name="intervals"
                value={filters.intervals.join(",")}
              />
              <input type="hidden" name="billing" value={filters.billing.join(",")} />
              <input type="hidden" name="from" value={filters.from ?? ""} />
              <input type="hidden" name="to" value={filters.to ?? ""} />
              <InlineStack gap="200" wrap={false} blockAlign="center">
                <div style={{ flex: 1 }}>
                  <TextField
                    label="Search events"
                    labelHidden
                    name="q"
                    value={q}
                    onChange={setQ}
                    prefix={<Icon source={SearchIcon} />}
                    placeholder={`Search ${scopeTotal.toLocaleString()} events`}
                    autoComplete="off"
                    clearButton
                    onClearButtonClick={() => setQ("")}
                  />
                </div>
                <Button submit>Search</Button>
              </InlineStack>
            </Form>
          </BlockStack>
        </Card>

        <Card padding="0">
          <div className="activity-table-header">
            <div>
              <Text as="h2" variant="headingMd">
                Events
              </Text>
              <Text as="p" tone="subdued">
                {total.toLocaleString()} matching {total === 1 ? "event" : "events"}
              </Text>
            </div>
          </div>

          {events.length === 0 ? (
            <EmptyState
              heading={hasFilters ? "No events match these filters" : "No events yet"}
              image={EMPTY_STATE_IMAGE}
              action={
                hasFilters
                  ? {
                      content: "Clear filters",
                      url: `/app/apps/${app.id}/events`,
                    }
                  : undefined
              }
            >
              <p>
                {hasFilters
                  ? "Try broadening the event type, plan, or date range filters."
                  : "Events appear here after this app syncs Shopify Partner data or fires custom events."}
              </p>
            </EmptyState>
          ) : (
            <div className="app-events-feed">
              {groups.map((group) => (
                <div key={group.day}>
                  <div className="app-events-day-divider">{group.day}</div>
                  {group.items.map((event) => {
                    const meta = EVENT_META[event.type];
                    const IconSource = TYPE_ICON[event.type] ?? MagicIcon;
                    return (
                      <div key={event.id} className="app-events-card">
                        <div className="app-events-card__icon">
                          <Icon source={IconSource} />
                        </div>
                        <div className="app-events-card__body">
                          <InlineStack
                            gap="200"
                            align="space-between"
                            blockAlign="center"
                            wrap={false}
                          >
                            <InlineStack gap="200" blockAlign="center">
                              <Text as="span" variant="headingSm">
                                {eventTitle(event)}
                              </Text>
                              {meta ? (
                                <Badge tone={meta.tone}>
                                  {meta.category === "activity"
                                    ? "Activity"
                                    : "Subscription"}
                                </Badge>
                              ) : null}
                            </InlineStack>
                            <span
                              className="app-events-card__time"
                              title={formatDateTime(event.occurredAt)}
                            >
                              {formatRelativeTime(event.occurredAt)}
                            </span>
                          </InlineStack>
                          <div className="app-events-card__fields">
                            {contextFields(event, app.id).map((field, idx) => (
                              <div
                                key={`${field.label}-${idx}`}
                                className="app-events-field"
                              >
                                {field.label ? (
                                  <span className="app-events-field__label">
                                    {field.label}
                                  </span>
                                ) : null}
                                {field.href ? (
                                  <Link
                                    to={field.href}
                                    className="app-events-field__link"
                                  >
                                    {field.value}
                                  </Link>
                                ) : (
                                  <span className="app-events-field__value">
                                    {field.value}
                                  </span>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}

              <div className="activity-pagination">
                <Text as="p" tone="subdued">
                  Page {page.toLocaleString()} of {totalPages.toLocaleString()} ·{" "}
                  {PAGE_SIZE} per page
                </Text>
                <Pagination
                  hasPrevious={page > 1}
                  onPrevious={() => navigate(appEventsUrl(app.id, filters, page - 1))}
                  hasNext={page < totalPages}
                  onNext={() => navigate(appEventsUrl(app.id, filters, page + 1))}
                  label={`Page ${page} of ${totalPages}`}
                />
              </div>
            </div>
          )}
        </Card>
      </BlockStack>
    </Page>
  );
}
