import type { RecurringInterval } from "../../../generated/prisma/client";

/**
 * Date helpers for the flex billing clock. Everything is computed in UTC so the
 * billing period is deterministic regardless of server timezone.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** UTC midnight of the given date. */
export function startOfDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

/** UTC first-of-month midnight (for the month_to_date usage window). */
export function startOfMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

/**
 * Whole days between two dates, measured at day granularity (both floored to
 * UTC midnight first). Matches the spec's `days(a) - days(b)` semantics used in
 * proration and the day-level collect-outstanding gate.
 */
export function wholeDaysBetween(from: Date, to: Date): number {
  const a = startOfDay(from).getTime();
  const b = startOfDay(to).getTime();
  return Math.round((b - a) / MS_PER_DAY);
}

/**
 * Advance a date by `count` units of `interval`. Month/year arithmetic clamps
 * to the last valid day (e.g. Jan 31 + 1 month → Feb 28/29).
 */
export function addInterval(
  date: Date,
  interval: RecurringInterval,
  count: number,
): Date {
  const d = new Date(date.getTime());
  switch (interval) {
    case "DAY":
      d.setUTCDate(d.getUTCDate() + count);
      return d;
    case "WEEK":
      d.setUTCDate(d.getUTCDate() + count * 7);
      return d;
    case "MONTH":
      return addMonths(d, count);
    case "YEAR":
      return addMonths(d, count * 12);
    default:
      return d;
  }
}

function addMonths(date: Date, months: number): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const target = new Date(
    Date.UTC(
      year,
      month + months,
      1,
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
  // Clamp the day to the number of days in the target month.
  const daysInTargetMonth = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, daysInTargetMonth));
  return target;
}
