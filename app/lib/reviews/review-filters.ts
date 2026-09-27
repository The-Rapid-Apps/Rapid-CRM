/**
 * The Reviews page's filters: parsed from the URL, applied to rows, and the
 * few conversions they need (time-using-the-app to days, Shopify plan codes to
 * the names Shopify shows). Client-safe and pure, so the page, the CSV export
 * and the tests all filter the same way.
 */

export interface ReviewRow {
  id: string;
  appId: string;
  rating: number;
  body: string;
  reviewerName: string;
  timeUsingApp: string | null;
  replyBody: string | null;
  reviewedAt: string;
  edited: boolean;
  /** When the review left the listing (Shopify's "archived"); null if live. */
  archivedAt: string | null;
  /** The customer this review is from: known (Mantle's link) or matched by
   * store name and install date. */
  shopDomain: string | null;
  /** That customer's Shopify plan label, when known. */
  shopifyPlan: string | null;
}

export const TIME_USING_BUCKETS = {
  under_day: { label: "Under a day", min: 0, max: 1 },
  week: { label: "1–7 days", min: 1, max: 8 },
  month: { label: "1–4 weeks", min: 8, max: 31 },
  over_month: { label: "Over a month", min: 31, max: Infinity },
} as const;
export type TimeUsingBucket = keyof typeof TIME_USING_BUCKETS;

export const REPLY_FILTERS = {
  replied: "Replied",
  unreplied: "Not replied",
} as const;
export type ReplyFilter = keyof typeof REPLY_FILTERS;

export const ARCHIVE_FILTERS = {
  active: "Active",
  archived: "Archived",
} as const;
export type ArchiveFilter = keyof typeof ARCHIVE_FILTERS;

export interface ReviewFilters {
  appId: string;
  q: string;
  ratings: number[];
  timeUsing: TimeUsingBucket[];
  /** Inclusive calendar days, YYYY-MM-DD. */
  after: string;
  before: string;
  plans: string[];
  reply: ReplyFilter | "";
  archive: ArchiveFilter | "";
  page: number;
}

const UNIT_DAYS: Record<string, number> = {
  minute: 1 / 1440,
  hour: 1 / 24,
  day: 1,
  week: 7,
  month: 30,
  year: 365,
};

/** "About 22 hours using the app" → 0.92. The listing's own wording, turned
 * into days; null when it doesn't say. */
export function timeUsingDays(text: string | null): number | null {
  const match = /(\d+)\s+(minute|hour|day|week|month|year)s?\b/i.exec(text ?? "");
  if (match) return Number(match[1]) * UNIT_DAYS[match[2].toLowerCase()];
  // "About a month", "an hour" — singular without a number.
  const single = /\b(?:a|an)\s+(minute|hour|day|week|month|year)\b/i.exec(text ?? "");
  return single ? UNIT_DAYS[single[1].toLowerCase()] : null;
}

export function timeUsingBucket(text: string | null): TimeUsingBucket | null {
  const days = timeUsingDays(text);
  if (days === null) return null;
  return (Object.keys(TIME_USING_BUCKETS) as TimeUsingBucket[]).find(
    (key) => days >= TIME_USING_BUCKETS[key].min && days < TIME_USING_BUCKETS[key].max,
  )!;
}

/** Shopify's API plan codes as Shopify names them to merchants. */
const PLAN_LABELS: Record<string, string> = {
  basic: "Basic",
  professional: "Shopify",
  shopify: "Shopify",
  unlimited: "Advanced",
  shopify_plus: "Plus",
  plus_partner_sandbox: "Plus sandbox",
  partner_test: "Development",
  affiliate: "Development",
  developer_preview: "Developer preview",
  dormant: "Pause and Build",
  frozen: "Frozen",
  cancelled: "Cancelled",
  trial: "Trial",
  starter_2022: "Starter",
  // Mantle's export uses display names; this aligns "Shopify Starter" with
  // the code above ("Shopify Plus" already maps via shopify_plus).
  shopify_starter: "Starter",
  staff: "Staff",
  staff_business: "Staff",
  shopify_alumni: "Alumni",
};

export function shopifyPlanLabel(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  const code = value.toLowerCase().replace(/\s+/g, "_");
  return PLAN_LABELS[code] ?? value;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function parseReviewFilters(params: URLSearchParams): ReviewFilters {
  const list = (key: string) =>
    (params.get(key) ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  const page = Number(params.get("page") ?? "1");
  const reply = params.get("reply") ?? "";
  const archive = params.get("archive") ?? "";
  return {
    appId: (params.get("appId") ?? "").trim(),
    q: (params.get("q") ?? "").trim().slice(0, 200),
    ratings: [...new Set(list("rating").map(Number).filter((n) => n >= 1 && n <= 5))],
    timeUsing: list("time").filter((key): key is TimeUsingBucket => key in TIME_USING_BUCKETS),
    after: DAY.test(params.get("after") ?? "") ? params.get("after")! : "",
    before: DAY.test(params.get("before") ?? "") ? params.get("before")! : "",
    plans: list("plan"),
    reply: reply in REPLY_FILTERS ? (reply as ReplyFilter) : "",
    archive: archive in ARCHIVE_FILTERS ? (archive as ArchiveFilter) : "",
    page: Number.isInteger(page) && page > 0 ? page : 1,
  };
}

/** The URL for a set of filters. Empty filters are left out, so a shared link
 * says only what was chosen. */
export function reviewFiltersQuery(filters: Partial<ReviewFilters>): string {
  const params = new URLSearchParams();
  if (filters.appId) params.set("appId", filters.appId);
  if (filters.q) params.set("q", filters.q);
  if (filters.ratings?.length) params.set("rating", filters.ratings.join(","));
  if (filters.timeUsing?.length) params.set("time", filters.timeUsing.join(","));
  if (filters.after) params.set("after", filters.after);
  if (filters.before) params.set("before", filters.before);
  if (filters.plans?.length) params.set("plan", filters.plans.join(","));
  if (filters.reply) params.set("reply", filters.reply);
  if (filters.archive) params.set("archive", filters.archive);
  if (filters.page && filters.page > 1) params.set("page", String(filters.page));
  return params.toString();
}

export function applyReviewFilters<T extends ReviewRow>(
  rows: readonly T[],
  filters: ReviewFilters,
): T[] {
  const q = filters.q.toLowerCase();
  const afterMs = filters.after ? Date.parse(`${filters.after}T00:00:00Z`) : null;
  const beforeMs = filters.before ? Date.parse(`${filters.before}T00:00:00Z`) : null;
  return rows.filter((row) => {
    if (filters.appId && row.appId !== filters.appId) return false;
    if (filters.ratings.length && !filters.ratings.includes(row.rating)) return false;
    const day = Date.parse(row.reviewedAt);
    if (afterMs !== null && day < afterMs) return false;
    if (beforeMs !== null && day > beforeMs) return false;
    if (filters.timeUsing.length) {
      const bucket = timeUsingBucket(row.timeUsingApp);
      if (!bucket || !filters.timeUsing.includes(bucket)) return false;
    }
    if (filters.plans.length && !(row.shopifyPlan && filters.plans.includes(row.shopifyPlan))) {
      return false;
    }
    if (filters.reply === "replied" && !row.replyBody) return false;
    if (filters.reply === "unreplied" && row.replyBody) return false;
    if (filters.archive === "active" && row.archivedAt) return false;
    if (filters.archive === "archived" && !row.archivedAt) return false;
    if (
      q &&
      !row.reviewerName.toLowerCase().includes(q) &&
      !row.body.toLowerCase().includes(q) &&
      !(row.shopDomain ?? "").toLowerCase().includes(q)
    ) {
      return false;
    }
    return true;
  });
}
