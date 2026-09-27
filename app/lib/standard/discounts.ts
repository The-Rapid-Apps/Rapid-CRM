/**
 * Translating a local `Discount` into the discount Shopify puts on a recurring
 * line.
 *
 * Needed only on the standard rail, and that asymmetry is the point: flex
 * discounts the USAGE RECORDS it posts itself, so it can keep a discount as a
 * local reference and apply it at charge time. Standard hands pricing to
 * Shopify, so the discount has to travel as a value on the line at create time —
 * and Shopify then applies it on every collection without asking again.
 */
import { prisma } from "../db.server";
import type { StandardDiscount } from "./line-items";

export class UnsupportedDiscountError extends Error {}

/**
 * Shopify accepts a percentage or a fixed amount OFF. It has no notion of "the
 * price is now X", so `FLAT_PRICE` has to be converted to an amount-off against
 * the plan's list price — which is why the plan is read here rather than trusted
 * from the caller.
 */
export async function standardDiscountFor(
  discountId: string,
): Promise<StandardDiscount> {
  const discount = await prisma.discount.findUniqueOrThrow({
    where: { id: discountId },
    select: {
      type: true,
      value: true,
      durationIntervals: true,
      plan: { select: { amount: true } },
    },
  });

  const duration = discount.durationIntervals ?? undefined;

  if (discount.type === "PERCENTAGE") {
    return {
      kind: "percentage",
      // Shopify wants a fraction, not 0-100.
      percentage: Number(discount.value) / 100,
      ...(duration !== undefined ? { durationLimitInIntervals: duration } : {}),
    };
  }

  if (discount.type === "AMOUNT") {
    return {
      kind: "amount",
      amount: discount.value.toString(),
      ...(duration !== undefined ? { durationLimitInIntervals: duration } : {}),
    };
  }

  // FLAT_PRICE: "the price is now X". Convert to X off the list price.
  if (!discount.plan) {
    throw new UnsupportedDiscountError(
      "A flat-price discount must be attached to a plan, so the amount off can " +
        "be derived from that plan's list price.",
    );
  }
  const off = Number(discount.plan.amount) - Number(discount.value);
  if (!(off > 0)) {
    throw new UnsupportedDiscountError(
      "This flat-price discount is not below the plan's list price, so there is " +
        "nothing to discount.",
    );
  }
  return {
    kind: "amount",
    amount: off.toFixed(2),
    ...(duration !== undefined ? { durationLimitInIntervals: duration } : {}),
  };
}
