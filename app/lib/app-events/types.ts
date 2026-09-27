/**
 * App Events — shared, client-safe vocabulary for the per-app event feed
 * (/app/apps/:appId/events).
 *
 * No server or Polaris imports here: this module is pulled into both the
 * route component (browser) and the `.server` query layer, so it must stay a
 * plain-data module. Icons/badges are resolved in the route from `EVENT_META`.
 *
 * The feed is a *read model* over four existing source tables — it does not
 * have its own table. Each source's native type is normalized to one of the
 * ids below (see the maps), so the UI and filters speak a single vocabulary.
 */

export type AppEventCategory = "activity" | "subscription";

/** Rows per page in the feed. Client-safe (used in the route component too). */
export const PAGE_SIZE = 50;

/** A normalized event, projected from whichever source table it came from. */
export type AppEvent = {
  /** Source-prefixed id (`life_…` | `auto_…` | `pse_…` | `flex_…`). */
  id: string;
  category: AppEventCategory;
  /** A normalized type id — a key of EVENT_META. */
  type: string;
  /** Custom events carry their app-defined name here (else null). */
  customName: string | null;
  occurredAt: string; // ISO
  shopDomain: string | null; // customer natural key, e.g. "acme.myshopify.com"
  planName: string | null;
  amount: number | null;
  currency: string | null;
  reason: string | null; // uninstall reason
  metadata: Record<string, unknown> | null; // custom props + type-specific extras
};

type BadgeTone = "success" | "info" | "attention" | "warning" | "critical";

export const EVENT_META: Record<
  string,
  { label: string; tone: BadgeTone; category: AppEventCategory }
> = {
  // --- Activity ---
  installed: { label: "Installed", tone: "success", category: "activity" },
  reinstalled: { label: "Reinstalled", tone: "info", category: "activity" },
  reactivated: { label: "Reactivated", tone: "success", category: "activity" },
  deactivated: { label: "Deactivated", tone: "warning", category: "activity" },
  uninstalled: { label: "Uninstalled", tone: "critical", category: "activity" },
  // --- Subscription ---
  subscription_started: {
    label: "Subscription started",
    tone: "success",
    category: "subscription",
  },
  upgraded: { label: "Upgraded", tone: "success", category: "subscription" },
  downgraded: {
    label: "Downgraded",
    tone: "attention",
    category: "subscription",
  },
  subscription_activated: {
    label: "Activated",
    tone: "success",
    category: "subscription",
  },
  subscription_unfrozen: {
    label: "Unfrozen",
    tone: "info",
    category: "subscription",
  },
  subscription_frozen: {
    label: "Frozen",
    tone: "warning",
    category: "subscription",
  },
  subscription_canceled: {
    label: "Canceled",
    tone: "critical",
    category: "subscription",
  },
  subscription_expired: {
    label: "Expired",
    tone: "attention",
    category: "subscription",
  },
  charge_succeeded: {
    label: "Charge succeeded",
    tone: "success",
    category: "subscription",
  },
  charge_failed: {
    label: "Charge failed",
    tone: "critical",
    category: "subscription",
  },
};

export const ACTIVITY_TYPES = Object.keys(EVENT_META).filter(
  (t) => EVENT_META[t].category === "activity",
);
export const SUBSCRIPTION_TYPES = Object.keys(EVENT_META).filter(
  (t) => EVENT_META[t].category === "subscription",
);

/** Options for the two "event type" filter popovers (spec's category chips). */
export const ACTIVITY_TYPE_OPTIONS = ACTIVITY_TYPES.map((value) => ({
  value,
  label: EVENT_META[value].label,
}));
export const SUBSCRIPTION_TYPE_OPTIONS = SUBSCRIPTION_TYPES.map((value) => ({
  value,
  label: EVENT_META[value].label,
}));

/** PlanInterval enum → human label (subscription events only). */
export const PLAN_INTERVAL_OPTIONS = [
  { value: "EVERY_30_DAYS", label: "Monthly" },
  { value: "ANNUAL", label: "Annual" },
  { value: "QUARTERLY", label: "Quarterly" },
];

/**
 * Billing type maps to how a subscription event is charged, not a stored
 * column: usage = flex per-usage charges; recurring = everything else.
 */
export const BILLING_TYPE_OPTIONS = [
  { value: "recurring", label: "Recurring" },
  { value: "usage", label: "Usage" },
];

/** The normalized subscription type that is usage-billed; all others recurring. */
export const USAGE_BILLED_TYPES = new Set(["charge_succeeded"]);

// --- Source → normalized-type maps (also used server-side, reverse-looked-up) ---

export const LIFECYCLE_TYPE_MAP: Record<string, string> = {
  INSTALLED: "installed",
  REINSTALLED: "reinstalled",
  UNINSTALLED: "uninstalled",
  REACTIVATED: "reactivated",
  DEACTIVATED: "deactivated",
};

export const PARTNER_TYPE_MAP: Record<string, string> = {
  SUBSCRIPTION_CHARGE_ACTIVATED: "subscription_activated",
  SUBSCRIPTION_CHARGE_UNFROZEN: "subscription_unfrozen",
  SUBSCRIPTION_CHARGE_FROZEN: "subscription_frozen",
  SUBSCRIPTION_CHARGE_CANCELED: "subscription_canceled",
  SUBSCRIPTION_CHARGE_DECLINED: "charge_failed",
  SUBSCRIPTION_CHARGE_EXPIRED: "subscription_expired",
};

export const FLEX_TYPE_MAP: Record<string, string> = {
  SUBSCRIBED: "subscription_started",
  UPGRADED: "upgraded",
  DOWNGRADED: "downgraded",
  SUBSCRIPTION_CHARGED: "charge_succeeded",
};

// --- Filters ---------------------------------------------------------------

export type AppEventFilters = {
  /** Selected normalized type ids across both categories; empty = all. */
  types: string[];
  /** Plan/charge names (subscription only). */
  plans: string[];
  /** PlanInterval enum values (subscription only, flex-billed). */
  intervals: string[];
  /** "recurring" | "usage" (subscription only). */
  billing: string[];
  /** Inclusive UTC-day bounds as YYYY-MM-DD, or null when unset. */
  from: string | null;
  to: string | null;
  q: string;
};

export const EMPTY_FILTERS: AppEventFilters = {
  types: [],
  plans: [],
  intervals: [],
  billing: [],
  from: null,
  to: null,
  q: "",
};

const KNOWN_TYPES = new Set(Object.keys(EVENT_META));
const KNOWN_INTERVALS = new Set(PLAN_INTERVAL_OPTIONS.map((o) => o.value));
const KNOWN_BILLING = new Set(BILLING_TYPE_OPTIONS.map((o) => o.value));
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function csv(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

/** Parse + validate filters from a URLSearchParams (round-trips buildSearch). */
export function parseAppEventFilters(params: URLSearchParams): AppEventFilters {
  const from = params.get("from");
  const to = params.get("to");
  return {
    types: csv(params.get("types")).filter((t) => KNOWN_TYPES.has(t)),
    plans: csv(params.get("plans")).map((p) => p.slice(0, 255)),
    intervals: csv(params.get("intervals")).filter((i) =>
      KNOWN_INTERVALS.has(i),
    ),
    billing: csv(params.get("billing")).filter((b) => KNOWN_BILLING.has(b)),
    from: from && DATE_RE.test(from) ? from : null,
    to: to && DATE_RE.test(to) ? to : null,
    q: (params.get("q") ?? "").trim().slice(0, 255),
  };
}

/** Serialize filters (+ optional page) to a URLSearchParams. */
export function buildAppEventsSearch(
  filters: AppEventFilters,
  page = 1,
): URLSearchParams {
  const p = new URLSearchParams();
  if (filters.types.length) p.set("types", filters.types.join(","));
  if (filters.plans.length) p.set("plans", filters.plans.join(","));
  if (filters.intervals.length) p.set("intervals", filters.intervals.join(","));
  if (filters.billing.length) p.set("billing", filters.billing.join(","));
  if (filters.from) p.set("from", filters.from);
  if (filters.to) p.set("to", filters.to);
  if (filters.q) p.set("q", filters.q);
  if (page > 1) p.set("page", String(page));
  return p;
}

export function appEventsUrl(
  appId: string,
  filters: AppEventFilters,
  page = 1,
): string {
  const query = buildAppEventsSearch(filters, page).toString();
  const base = `/app/apps/${encodeURIComponent(appId)}/events`;
  return query ? `${base}?${query}` : base;
}

export function appEventsExportUrl(
  appId: string,
  filters: AppEventFilters,
): string {
  const query = buildAppEventsSearch(filters).toString();
  const base = `/app/apps/${encodeURIComponent(appId)}/events/export`;
  return query ? `${base}?${query}` : base;
}

/** Customer profile link — mirrors customerUrl() in customers.tsx. */
export function customerUrl(appId: string, shopDomain: string): string {
  return `/app/customers/${encodeURIComponent(shopDomain)}?app=${encodeURIComponent(appId)}`;
}

/** Which categories/sources the current type selection puts in scope. */
export function scopeFromTypes(types: string[]): {
  includeActivity: boolean;
  includeSubscription: boolean;
  activityTypes: string[];
  subscriptionTypes: string[];
} {
  const activityTypes = types.filter(
    (t) => EVENT_META[t]?.category === "activity",
  );
  const subscriptionTypes = types.filter(
    (t) => EVENT_META[t]?.category === "subscription",
  );
  const noFilter = types.length === 0;
  return {
    includeActivity: noFilter || activityTypes.length > 0,
    includeSubscription: noFilter || subscriptionTypes.length > 0,
    activityTypes,
    subscriptionTypes,
  };
}
