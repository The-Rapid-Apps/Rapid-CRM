import { Prisma } from "../../generated/prisma/client";

/**
 * Money helpers built on Prisma's Decimal (decimal.js under the hood). All flex
 * billing math — proration, discount application, credit caps — runs through
 * Decimal to avoid float drift, then rounds to 2dp only when posting to Shopify.
 */
export type Money = Prisma.Decimal;
export const Decimal = Prisma.Decimal;

export type Numeric = Prisma.Decimal | number | string;

/** Coerce anything numeric-ish into a Decimal. */
export function D(value: Numeric): Money {
  return new Prisma.Decimal(value);
}

export const ZERO = new Prisma.Decimal(0);

/** Shopify prices are decimal strings with 2dp — never post more precision. */
export function toShopifyPrice(value: Numeric): string {
  return D(value).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toFixed(2);
}

/** Round to cents for storage/reporting. */
export function toCents(value: Numeric): Money {
  return D(value).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

export function isPositive(value: Numeric): boolean {
  return D(value).greaterThan(0);
}

export function max(a: Numeric, b: Numeric): Money {
  const da = D(a);
  const db = D(b);
  return da.greaterThan(db) ? da : db;
}

export function min(a: Numeric, b: Numeric): Money {
  const da = D(a);
  const db = D(b);
  return da.lessThan(db) ? da : db;
}

/** Clamp v into [lo, hi]. */
export function clamp(v: Numeric, lo: Numeric, hi: Numeric): Money {
  return min(max(v, lo), hi);
}
