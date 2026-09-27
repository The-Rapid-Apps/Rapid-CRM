/** Client-safe traffic pivot dimensions shared by the UI and the BigQuery query layer. */

function eventParam(key: string): string {
  return `(SELECT value.string_value FROM UNNEST(event_params) WHERE key = "${key}")`;
}

/**
 * Several Shopify App Store dimensions (surface type/detail/position,
 * campaign) aren't their own GA4 event param — they're query-string params on
 * the listing page URL (e.g. `?surface_type=search`),
 * confirmed against live page_location values (2026-07-26).
 */
function pageLocationParam(param: string): string {
  return `REGEXP_EXTRACT(${eventParam("page_location")}, r"${param}=([^&]+)")`;
}

/**
 * Percent-decodes a query-string value the way a browser would: `%E5%83%8F`
 * → 像. BigQuery has no URL-decode function, so the value is split into `%XX`
 * escapes and literal runs, each turned into bytes, and the bytes read back as
 * UTF-8. Escapes that don't form valid UTF-8 leave the raw text as it was
 * (`SAFE_CAST` gives NULL). Mirrored byte-for-byte by `urlDecode` in
 * traffic-dimensions.local.ts.
 */
function urlDecoded(expr: string): string {
  return `IF(${expr} IS NULL, NULL, COALESCE(SAFE_CAST(ARRAY_TO_STRING(ARRAY(
    SELECT IF(STARTS_WITH(part, "%") AND LENGTH(part) = 3, FROM_HEX(SUBSTR(part, 2)), CAST(part AS BYTES))
    FROM UNNEST(REGEXP_EXTRACT_ALL(${expr}, r"%[0-9A-Fa-f]{2}|[^%]+|%")) AS part WITH OFFSET AS pos
    ORDER BY pos), b"") AS STRING), ${expr}))`;
}

/** Surface types that are paid placements: Shopify App Store ads. */
export const AD_SURFACE_TYPES = ["search_ad", "category_ad"] as const;

/**
 * GA4 never sends a "term"/"search_term" event param on Shopify App Store
 * traffic — confirmed against live data (2026-08-07), all null.
 * The text a merchant searched lives in `surface_detail` on a search results
 * page; elsewhere it means something else (a category slug), hence the gate.
 *
 * Matches Mantle (compared 2026-09-24 on a production app):
 * - `search_ad` counts too: a click on an ad in search results still carries
 *   the term searched. Left out, "facebook pixel" showed 9 of its 49 views.
 * - Normalized, so one term is one row: `+` → space, percent-decoded
 *   (`%E5%83%8F%E7%B4%A0` → 像素), trimmed and lowercased ("Facebook+pixel+"
 *   and "FACEBOOK+PIXEL" are the same search). A term that is only
 *   whitespace is no term.
 */
function searchTermParam(): string {
  const detail = urlDecoded(`REPLACE(${pageLocationParam("surface_detail")}, "+", " ")`);
  return `IF(${pageLocationParam("surface_type")} IN ("search", "search_ad"), NULLIF(LOWER(TRIM(${detail})), ""), NULL)`;
}

/**
 * The listing page's own language, from its `locale` param — what Mantle
 * reports (`en`, `fr`, `zh-CN`), not the browser's `device.language`
 * (`en-us`, `fr-fr`). The App Store only adds `locale` for a non-English
 * page, so a listing URL without one was read in English. No URL at all is
 * unknown, not English.
 */
function languageParam(): string {
  const location = eventParam("page_location");
  return `IF(${location} IS NULL, NULL, COALESCE(REGEXP_EXTRACT(${location}, r"[?&]locale=([^&#]+)"), "en"))`;
}

/**
 * Mantle's medium, read from the listing URL rather than GA4's
 * `traffic_source.medium` — that is the USER's first-ever acquisition medium,
 * and is empty or "(none)" on ~85% of listing views. In order:
 * 1. the link's own `utm_medium` (e.g. links from inside your own app);
 * 2. "cpc" for an App Store ad;
 * 3. "organic" for any other App Store surface (search, category, partners);
 * 4. GA4's medium when it names one ("referral", "organic");
 * 5. otherwise "organic" — an unmarked visit to a free listing.
 * Verified against Mantle's own split for one app: organic 56% / cpc
 * 30% / utm 13% / referral 0.9% here, 57 / 26 / 15 / 1.4 in Mantle.
 */
function mediumParam(): string {
  const surface = pageLocationParam("surface_type");
  return `IF(${eventParam("page_location")} IS NULL, NULL, COALESCE(
    ${pageLocationParam("utm_medium")},
    IF(${surface} IN ("${AD_SURFACE_TYPES.join('", "')}"), "cpc", NULL),
    IF(${surface} IS NOT NULL, "organic", NULL),
    IF(traffic_source.medium IN ("(none)", "(not set)"), NULL, traffic_source.medium),
    "organic"))`;
}

/**
 * GA4's own `traffic_source.source` applies "self-referral exclusion": a
 * visitor arriving via a link from the same site (e.g. browsing from another
 * app's Shopify listing page to this one, both on apps.shopify.com) gets
 * classified as "(direct)" rather than attributed to that referrer — GA4
 * doesn't consider same-domain navigation an external "source." Mantle's
 * dashboard doesn't apply that exclusion — it shows the real referrer
 * hostname (e.g. "apps.shopify.com") as its own row, which is a more useful
 * breakdown for understanding in-App-Store discovery. This only overrides
 * the "(direct)" bucket specifically when a real page_referrer exists;
 * already-classified sources (e.g. "google", "shopify") are left as-is.
 */
function sourceParam(): string {
  const referrerHost = `NET.HOST(${eventParam("page_referrer")})`;
  return `IF(traffic_source.source = "(direct)" AND ${referrerHost} IS NOT NULL, ${referrerHost}, traffic_source.source)`;
}

/**
 * `installEventNative: false` marks dimensions that are only ever populated
 * on the listing-page view event (`view_item`) — they're derived from
 * `page_location`/query-string params that simply don't exist on the
 * `shopify_app_install` event itself (confirmed against live data 2026-08-07: `page_location` is null on 100% of install events).
 * `traffic_source_name`/`country` are GA4's own session-level fields and DO
 * carry through onto the install event, so they stay native. `medium` and
 * `language` were native too until 2026-09-24, when they moved to the
 * listing URL (see `mediumParam`/`languageParam`). Non-native dimensions need the install event re-attributed
 * back to that visitor's own listing-page view (see
 * `resolvePageViewOnlyDimensions` in traffic-sources.server.ts) rather than
 * reading straight off the install event's own (empty) params. `source` is
 * also non-native despite being a "session-level" field, specifically
 * because of the `page_referrer`-based override above — `page_referrer` is
 * just as page-view-only as `page_location`, so a "(direct)"-with-real-
 * referrer install event needs the same visitor-lookback join, or its
 * Installed count would silently undercount the referrer-derived row (the
 * same class of bug already fixed for `search_term`).
 */
export const PIVOT_DIMENSIONS = [
  {
    key: "source",
    label: "Source",
    column: sourceParam(),
    installEventNative: false,
  },
  {
    key: "medium",
    label: "Source medium",
    column: mediumParam(),
    installEventNative: false,
  },
  {
    key: "search_term",
    label: "Search term",
    column: searchTermParam(),
    installEventNative: false,
  },
  {
    key: "referrer_site",
    /**
     * The referrer's HOST, not the raw URL. Reading `page_referrer` whole
     * split one site across every distinct path and query string it was
     * linked from — thousands of rows for a hundred-odd actual sites, with
     * apps.shopify.com occupying most of the top rows. `source` already
     * applies NET.HOST to this same field.
     */
    label: "Referrer site",
    column: `NET.HOST(${eventParam("page_referrer")})`,
    installEventNative: false,
  },
  {
    key: "traffic_source_name",
    label: "Traffic source name",
    column: "traffic_source.name",
    installEventNative: true,
  },
  {
    key: "campaign",
    /**
     * `utm_campaign` off the listing URL, NOT the `campaign` event param —
     * that param is null on ~99% of events (July 2026, one app: 3 of 107
     * bundle-campaign page views carried it), so reading it reported 3 where
     * Mantle reported 99. Deliberately not `traffic_source.name` either, even
     * though GA4 calls that the campaign: it's already exposed as its own
     * `traffic_source_name` pivot, and it carries non-campaign defaults
     * ((direct)/(organic)/installed), which Mantle likewise keeps separate.
     */
    label: "Campaign",
    column: pageLocationParam("utm_campaign"),
    installEventNative: false,
  },
  {
    key: "surface_type",
    label: "Page/Surface type",
    column: pageLocationParam("surface_type"),
    installEventNative: false,
  },
  {
    key: "surface_detail",
    label: "Surface detail",
    column: pageLocationParam("surface_detail"),
    installEventNative: false,
  },
  {
    key: "surface_inter_position",
    label: "Surface inter position",
    column: pageLocationParam("surface_inter_position"),
    installEventNative: false,
  },
  {
    key: "surface_intra_position",
    label: "Surface intra position",
    column: pageLocationParam("surface_intra_position"),
    installEventNative: false,
  },
  {
    key: "language",
    /**
     * Page-view-only now that it comes from the listing URL's `locale`. Cheap:
     * measured in July 2026, installs with no language were the same ones
     * with no `view_item` to look back to, so the lookback join loses nothing
     * the old `device.language` read had.
     */
    label: "Language",
    column: languageParam(),
    installEventNative: false,
  },
  {
    key: "country",
    label: "Country",
    column: "geo.country",
    installEventNative: true,
  },
] as const;

export type PivotDimensionKey = (typeof PIVOT_DIMENSIONS)[number]["key"];
export const DEFAULT_PIVOT_DIMENSIONS: PivotDimensionKey[] = ["source"];

/**
 * Funnel stages for the "funnel events" picker, mirroring Mantle's dropdown.
 *
 * Every stage here has a real data source and is selectable — there is no
 * availability flag any more, because there are no unimplemented stages left
 * to disable. (Mantle also lists "One-time charge"; it is deliberately absent
 * here. None of the apps this was built for sells a one-time purchase — `AppPurchaseOneTime` is never
 * used — so the stage could only ever report zero. Add it back alongside the
 * data if that changes.)
 *
 * Every stage attributes back to a traffic source, but they reach us four
 * different ways:
 *
 *   - GA4 export: listing_view, add_app_click, installed.
 *   - Our AccountLifecycleEvent table, joined by shop domain: uninstalled,
 *     reinstalled.
 *   - The Partner subscription feed: subscribed, unsubscribed,
 *     charge_abandoned.
 *   - DERIVED by the MRR fold from how a charge's value changes over time,
 *     because Shopify sends no event for any of them: trial_started,
 *     trial_converted, upgraded, downgraded, resubscribed. See
 *     `derivedFunnelEventsForShop`.
 */
export const FUNNEL_EVENTS = [
  {
    key: "listing_view",
    label: "App Listing Page View",
    description: "A summary of App Listing Page View events, unique per user, over the selected time period.",
  },
  {
    key: "add_app_click",
    label: "Add App Button Clicked",
    description: "A summary of Add App Button Clicked events, unique per user, over the selected time period.",
  },
  {
    key: "installed",
    label: "Installed",
    description: "A summary of Installed events, unique per user, over the selected time period.",
  },
  {
    key: "uninstalled",
    label: "Uninstalled",
    description: "A summary of Uninstalled events, unique per user, over the selected time period.",
  },
  {
    key: "reinstalled",
    label: "Reinstalled",
    description: "A summary of Reinstalled events, unique per user, over the selected time period.",
  },
  {
    key: "trial_started",
    label: "Trial Started",
    description: "A summary of Trial Started events, unique per user, over the selected time period.",
  },
  {
    key: "trial_converted",
    label: "Trial Converted",
    description: "A summary of Trial Converted events, unique per user, over the selected time period.",
  },
  {
    key: "subscribed",
    label: "Subscribed",
    description: "A summary of Subscribed events, unique per user, over the selected time period.",
  },
  {
    key: "unsubscribed",
    label: "Unsubscribed",
    description: "A summary of Unsubscribed events, unique per user, over the selected time period.",
  },
  {
    key: "upgraded",
    label: "Upgraded",
    description: "A summary of Upgraded events, unique per user, over the selected time period.",
  },
  {
    key: "downgraded",
    label: "Downgraded",
    description: "A summary of Downgraded events, unique per user, over the selected time period.",
  },
  {
    key: "resubscribed",
    label: "Resubscribed",
    description: "A summary of Resubscribed events, unique per user, over the selected time period.",
  },
  {
    key: "charge_abandoned",
    label: "Charge abandoned",
    description: "A summary of Charge abandoned events, unique per user, over the selected time period.",
  },
] as const;

export type FunnelEventKey = (typeof FUNNEL_EVENTS)[number]["key"];
export const DEFAULT_FUNNEL_EVENTS: FunnelEventKey[] = [
  "listing_view",
  "installed",
];

/* ------------------------------------------------------ traffic insights */

/**
 * The pies on the Traffic source insights report, in Mantle's order.
 *
 * A subset of `PIVOT_DIMENSIONS` rather than all of them: a pie needs a
 * dimension with a handful of dominant values to say anything. The position
 * dimensions (surface inter/intra position) are near-uniform integers and
 * would render as confetti.
 */
export const INSIGHT_DIMENSIONS = [
  "surface_type",
  "search_term",
  "surface_detail",
  "medium",
  "language",
  "country",
] as const satisfies readonly PivotDimensionKey[];

export type InsightDimensionKey = (typeof INSIGHT_DIMENSIONS)[number];

/** Mantle's titles for these cards, which differ from the pivot table's. */
export const INSIGHT_LABELS: Record<InsightDimensionKey, string> = {
  surface_type: "Page type",
  search_term: "Search term",
  surface_detail: "Surface detail",
  medium: "Medium",
  language: "Language",
  country: "Country",
};

/** Mantle's Event dropdown, in its order — the funnel events a pie can show. */
export const INSIGHT_EVENTS = [
  "listing_view",
  "add_app_click",
  "installed",
  "subscribed",
  "trial_started",
  "trial_converted",
  "upgraded",
  "downgraded",
  "unsubscribed",
  "uninstalled",
  "reinstalled",
  "resubscribed",
] as const satisfies readonly FunnelEventKey[];

export type InsightEventKey = (typeof INSIGHT_EVENTS)[number];

/** Mantle's wording for the Event dropdown ("Page views", not "App Listing
 * Page View") — the pivot table keeps its own, longer labels. */
export const INSIGHT_EVENT_LABELS: Record<InsightEventKey, string> = {
  listing_view: "Page views",
  add_app_click: "Add app clicked",
  installed: "Installed",
  subscribed: "Subscribed",
  trial_started: "Trial started",
  trial_converted: "Trial converted",
  upgraded: "Upgraded",
  downgraded: "Downgraded",
  unsubscribed: "Unsubscribed",
  uninstalled: "Uninstalled",
  reinstalled: "Reinstalled",
  resubscribed: "Resubscribed",
};

/**
 * The value the engine gives a shop-identity event (subscribed, uninstalled…)
 * whose shop it could not trace back to any visit. A label for "unknown", not
 * a place or a source — left out of the insights pies like `(not set)`. Before
 * it was listed there it showed up as the top "country" for every
 * subscription event: 1,104 of 5,697 Unsubscribed events over 90 days.
 */
export const UNKNOWN_SHOP_DIMENSION_VALUE = "(unattributed shop)";

/**
 * Values that mean "nothing recorded", left out of every insights pie.
 *
 * Mantle's pies leave them out too, and for good reason: on one app's
 * last 30 days, "(not set)" is 200 of 301 page views for Search term. Drawn
 * in, two-thirds of that pie would say "no search term" — true, and useless.
 * Each pie's percentages are therefore over the events that HAVE a value.
 * `(none)` is GA4's own medium for direct traffic; the engine writes
 * `(not set)` for everything else it could not resolve.
 */
export const INSIGHT_UNSET_VALUES: ReadonlySet<string> = new Set([
  "(not set)",
  "(none)",
  "",
  UNKNOWN_SHOP_DIMENSION_VALUE,
]);

/** Mantle's Metric dropdown: what each slice measures. */
export const INSIGHT_METRICS = [
  "volume",
  "total_clv",
  "average_clv",
  "median_clv",
  "average_spend",
  "median_spend",
] as const;

export type InsightMetricKey = (typeof INSIGHT_METRICS)[number];

export const INSIGHT_METRIC_LABELS: Record<InsightMetricKey, string> = {
  volume: "Volume",
  total_clv: "Total CLV",
  average_clv: "Average CLV",
  median_clv: "Median CLV",
  average_spend: "Average spend",
  median_spend: "Median spend",
};

/**
 * Metrics whose slices can be summed. A pie of averages or medians still has
 * slices, but their "share" is of a sum that means nothing — so the pie hides
 * the value of "Other" (a sum of averages) rather than presenting it.
 */
export const ADDITIVE_INSIGHT_METRICS: ReadonlySet<InsightMetricKey> = new Set([
  "volume",
  "total_clv",
]);

/**
 * Page views and Add app clicks carry no shop — GA4 records them before the
 * visitor has a store — so there is no customer to read revenue from. Only
 * Volume applies to them.
 */
export const SHOPLESS_INSIGHT_EVENTS: ReadonlySet<InsightEventKey> = new Set([
  "listing_view",
  "add_app_click",
]);
