/** Client-safe report presets shared by URL filters and the server query layer. */
export const ANALYTICS_PERIODS = [
  "last_30_days",
  "last_90_days",
  "last_12_months",
  "year_to_date",
  "all_time",
] as const;

export type AnalyticsPeriod = (typeof ANALYTICS_PERIODS)[number];
export const ANALYTICS_INTERVALS = ["day", "week", "month"] as const;
export type AnalyticsInterval = (typeof ANALYTICS_INTERVALS)[number];

/**
 * Mantle paginates its trial history; 25 keeps the card a readable height.
 *
 * Shared because the SERVER now cuts the page (the table's search runs over
 * the whole period, not the rows shipped), so both sides must agree on size
 * or the pager and the rows disagree.
 */
export const TRIAL_HISTORY_PAGE_SIZE = 25;
