import { D, clamp, ZERO, type Money, type Numeric } from "../money.server";
import { wholeDaysBetween } from "./dates";

/**
 * Day-based proration over the current cycle (spec §5, step 2).
 *
 *   daysInCycle   = whole days between currentPeriodStart and currentPeriodEnd
 *   daysRemaining = clamp(whole days from today to currentPeriodEnd, 0, daysInCycle)
 *   netProRated   = (newAmount/daysInCycle − prevAmount/daysInCycle) × daysRemaining
 *
 *   netProRated > 0 → charge (upgrade)
 *   netProRated < 0 → credit -netProRated (downgrade), capped at collected
 *   netProRated == 0 → no money moves, still commit in place
 *
 * A degenerate cycle (daysInCycle <= 0, e.g. a tier change the same day as
 * signup before the first charge) prorates to 0 rather than dividing by zero.
 *
 * Amounts passed in should already be post-discount (spec §5 uses
 * priceAfterDiscount for both prev and new).
 */
export interface ProrationInput {
  periodStart: Date;
  periodEnd: Date;
  today: Date;
  prevAmount: Numeric;
  newAmount: Numeric;
}

export interface ProrationResult {
  netProRated: Money;
  daysInCycle: number;
  daysRemaining: number;
}

export function computeProration(input: ProrationInput): ProrationResult {
  const daysInCycle = wholeDaysBetween(input.periodStart, input.periodEnd);

  if (daysInCycle <= 0) {
    return { netProRated: ZERO, daysInCycle, daysRemaining: 0 };
  }

  const daysRemaining = clamp(
    wholeDaysBetween(input.today, input.periodEnd),
    0,
    daysInCycle,
  ).toNumber();

  const prevDaily = D(input.prevAmount).div(daysInCycle);
  const newDaily = D(input.newAmount).div(daysInCycle);
  const netProRated = newDaily.minus(prevDaily).times(daysRemaining);

  return { netProRated, daysInCycle, daysRemaining };
}
