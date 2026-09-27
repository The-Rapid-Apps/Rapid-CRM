/**
 * UTC-day date-range helpers + the preset list, shared by every date-range
 * picker in this app. One instance, not a copy per surface.
 */

export function utcDayStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function addUtcDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

export function startOfUtcMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

/** Compact, no-year label for chart axes/buttons — "Aug 3", not "Aug 3, 2026". */
export function shortDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Polaris's `DatePicker` has no timezone option — it reads/highlights days
 * using the browser's LOCAL calendar fields (`getDate`/`getMonth`/
 * `getFullYear`). Every date in this app is a UTC-midnight instant, so
 * passing one straight to `DatePicker` renders one calendar day early in any
 * timezone behind UTC. These convert at the two boundaries where Polaris's
 * DatePicker touches app state — never used for anything else.
 */
export function utcToLocalCalendarDate(date: Date): Date {
  return new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}
export function localCalendarDateToUtc(date: Date): Date {
  return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
}

/**
 * "Last 12/24 hours" are genuine sub-day instants (not rounded to whole
 * days). Every other preset is day-granularity, matching how the
 * table/charts bucket data.
 */
export const DATE_RANGE_PRESETS: Array<{
  key: string;
  label: string;
  range: (now: Date) => { start: Date; end: Date };
}> = [
  {
    key: "today",
    label: "Today",
    range: (now) => {
      const day = utcDayStart(now);
      return { start: day, end: day };
    },
  },
  {
    key: "yesterday",
    label: "Yesterday",
    range: (now) => {
      const day = addUtcDays(utcDayStart(now), -1);
      return { start: day, end: day };
    },
  },
  {
    key: "last_12_hours",
    label: "Last 12 hours",
    range: (now) => ({ start: new Date(now.getTime() - 12 * 3_600_000), end: now }),
  },
  {
    key: "last_24_hours",
    label: "Last 24 hours",
    range: (now) => ({ start: new Date(now.getTime() - 24 * 3_600_000), end: now }),
  },
  {
    key: "last_7_days",
    label: "Last 7 days",
    range: (now) => {
      const end = utcDayStart(now);
      return { start: addUtcDays(end, -6), end };
    },
  },
  {
    key: "last_14_days",
    label: "Last 14 days",
    range: (now) => {
      const end = utcDayStart(now);
      return { start: addUtcDays(end, -13), end };
    },
  },
  {
    key: "last_30_days",
    label: "Last 30 days",
    range: (now) => {
      const end = utcDayStart(now);
      return { start: addUtcDays(end, -29), end };
    },
  },
  {
    key: "last_90_days",
    label: "Last 90 days",
    range: (now) => {
      const end = utcDayStart(now);
      return { start: addUtcDays(end, -89), end };
    },
  },
  {
    key: "last_month",
    label: "Last month",
    range: (now) => {
      const end = addUtcDays(startOfUtcMonth(now), -1);
      return { start: startOfUtcMonth(end), end };
    },
  },
  {
    key: "last_12_months",
    label: "Last 12 months",
    range: (now) => {
      const end = utcDayStart(now);
      const start = startOfUtcMonth(now);
      start.setUTCMonth(start.getUTCMonth() - 11);
      return { start, end };
    },
  },
  {
    key: "last_24_months",
    label: "Last 24 months",
    range: (now) => {
      const end = utcDayStart(now);
      const start = startOfUtcMonth(now);
      start.setUTCMonth(start.getUTCMonth() - 23);
      return { start, end };
    },
  },
  {
    key: "month_to_date",
    label: "Month to date",
    range: (now) => ({ start: startOfUtcMonth(now), end: utcDayStart(now) }),
  },
  {
    key: "quarter_to_date",
    label: "Quarter to date",
    range: (now) => {
      const quarterMonth = Math.floor(now.getUTCMonth() / 3) * 3;
      const start = new Date(Date.UTC(now.getUTCFullYear(), quarterMonth, 1));
      return { start, end: utcDayStart(now) };
    },
  },
  {
    key: "year_to_date",
    label: "Year to date",
    range: (now) => ({
      start: new Date(Date.UTC(now.getUTCFullYear(), 0, 1)),
      end: utcDayStart(now),
    }),
  },
];

/** Downsample a series to at most `maximum` points — always keeps the last. */
export function sampleSeries<T>(items: T[], maximum = 60): T[] {
  if (items.length <= maximum) return items;
  const stride = Math.ceil(items.length / maximum);
  const sampled = items.filter((_, index) => index % stride === 0);
  const last = items.at(-1);
  if (last && sampled.at(-1) !== last) sampled.push(last);
  return sampled;
}
