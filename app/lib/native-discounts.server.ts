import {
  Prisma,
  type Discount,
  type DiscountRedemption,
} from "../../generated/prisma/client";
import { prisma } from "./db.server";
import { D, max, min, ZERO } from "./money.server";
import { findDiscountByCodeForApp, normalizeDiscountCode } from "./flex/discounts.server";

const RESERVATION_TTL_MS = 15 * 60 * 1000;
const PLAN_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/;
const SHOPIFY_SUBSCRIPTION_GID =
  /^gid:\/\/shopify\/AppSubscription\/[A-Za-z0-9_-]+$/;

export type NativeDiscountReason =
  | "NOT_FOUND"
  | "INACTIVE"
  | "NOT_STARTED"
  | "EXPIRED"
  | "PLAN_MISMATCH"
  | "CURRENCY_MISMATCH"
  | "UNSUPPORTED_METHOD"
  | "EXHAUSTED"
  | "SHOP_LIMIT_REACHED"
  | "NO_PRICE_REDUCTION"
  | "IDEMPOTENCY_CONFLICT"
  | "RESERVATION_EXPIRED";

export interface NativeDiscountRequest {
  appId: string;
  code: string;
  shopDomain: string;
  externalPlanKey: string;
  listPrice: string;
  currencyCode: string;
  idempotencyKey: string;
  now?: Date;
}

export interface ShopifyDiscountInput {
  value: { percentage: number } | { amount: string };
  durationLimitInIntervals?: number;
}

type NativeResolution =
  | { valid: false; reason: NativeDiscountReason }
  | {
      valid: true;
      redemption: DiscountRedemption;
      discount: Discount;
      shopifyDiscount: ShopifyDiscountInput;
    };

function sameDecimal(left: Prisma.Decimal, right: Prisma.Decimal) {
  return left.equals(right);
}

function activeRedemptionWhere(now: Date) {
  return {
    OR: [
      { status: "APPLIED" as const },
      {
        status: "RESERVED" as const,
        expiresAt: { gt: now },
      },
    ],
  };
}

function shopifyInputFromRedemption(
  redemption: DiscountRedemption,
): ShopifyDiscountInput {
  const value = redemption.shopifyPercentage
    ? { percentage: Number(redemption.shopifyPercentage) }
    : { amount: redemption.shopifyAmount!.toFixed(2) };
  return {
    value,
    ...(redemption.durationIntervals
      ? { durationLimitInIntervals: redemption.durationIntervals }
      : {}),
  };
}

function validateRequest(params: NativeDiscountRequest) {
  const shopDomain = params.shopDomain.trim().toLowerCase();
  if (
    !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shopDomain) ||
    shopDomain.length > 255
  ) {
    throw new Error("shopDomain must be a valid .myshopify.com domain");
  }
  const externalPlanKey = params.externalPlanKey.trim();
  if (!PLAN_KEY_PATTERN.test(externalPlanKey)) {
    throw new Error(
      "externalPlanKey must be 1-191 URL-safe plan handle characters",
    );
  }
  const currencyCode = params.currencyCode.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currencyCode)) {
    throw new Error("currencyCode must be a three-letter ISO code");
  }
  const listPrice = D(params.listPrice);
  if (!listPrice.isFinite() || !listPrice.greaterThan(0)) {
    throw new Error("listPrice must be greater than zero");
  }
  const idempotencyKey = params.idempotencyKey.trim();
  if (idempotencyKey.length < 8 || idempotencyKey.length > 191) {
    throw new Error("idempotencyKey must be between 8 and 191 characters");
  }
  return {
    shopDomain,
    externalPlanKey,
    currencyCode,
    listPrice,
    idempotencyKey,
    normalizedCode: normalizeDiscountCode(params.code),
    now: params.now ?? new Date(),
  };
}

function calculateNativeValue(params: {
  discount: Discount;
  listPrice: Prisma.Decimal;
  currencyCode: string;
}):
  | {
      valid: true;
      priceAfterDiscount: Prisma.Decimal;
      shopifyPercentage: Prisma.Decimal | null;
      shopifyAmount: Prisma.Decimal | null;
    }
  | { valid: false; reason: NativeDiscountReason } {
  const { discount, listPrice, currencyCode } = params;
  if (discount.discountMethod !== "PRICE_REDUCTION") {
    return { valid: false, reason: "UNSUPPORTED_METHOD" };
  }
  if (
    discount.type !== "PERCENTAGE" &&
    discount.currencyCode !== currencyCode
  ) {
    return { valid: false, reason: "CURRENCY_MISMATCH" };
  }

  if (discount.type === "PERCENTAGE") {
    const percentage = D(discount.value).div(100);
    const priceAfterDiscount = max(
      listPrice.times(D(1).minus(percentage)),
      ZERO,
    );
    return {
      valid: true,
      priceAfterDiscount,
      shopifyPercentage: percentage,
      shopifyAmount: null,
    };
  }

  const amount =
    discount.type === "AMOUNT"
      ? min(discount.value, listPrice)
      : max(listPrice.minus(min(discount.value, listPrice)), ZERO);
  if (!amount.greaterThan(0)) {
    return { valid: false, reason: "NO_PRICE_REDUCTION" };
  }
  return {
    valid: true,
    priceAfterDiscount: max(listPrice.minus(amount), ZERO),
    shopifyPercentage: null,
    shopifyAmount: amount,
  };
}

/**
 * Validate and reserve a discount for a native Shopify appSubscriptionCreate.
 * Serializable isolation makes campaign and per-shop limits race-safe.
 */
export async function reserveNativeDiscount(
  rawParams: NativeDiscountRequest,
): Promise<NativeResolution> {
  const params = validateRequest(rawParams);
  if (!params.normalizedCode) return { valid: false, reason: "NOT_FOUND" };

  const execute = (): Promise<NativeResolution> =>
    prisma.$transaction(
      async (tx): Promise<NativeResolution> => {
        await tx.discountRedemption.updateMany({
          where: {
            appId: rawParams.appId,
            status: "RESERVED",
            expiresAt: { lte: params.now },
          },
          data: { status: "RELEASED", releasedAt: params.now },
        });
        const existing = await tx.discountRedemption.findUnique({
          where: {
            appId_idempotencyKey: {
              appId: rawParams.appId,
              idempotencyKey: params.idempotencyKey,
            },
          },
          include: { discount: true },
        });
        if (existing) {
          if (
            existing.shopDomain !== params.shopDomain ||
            existing.externalPlanKey !== params.externalPlanKey ||
            existing.currencyCode !== params.currencyCode ||
            !sameDecimal(existing.listPrice, params.listPrice)
          ) {
            return { valid: false, reason: "IDEMPOTENCY_CONFLICT" };
          }
          if (
            existing.status === "RELEASED" ||
            (existing.status === "RESERVED" && existing.expiresAt <= params.now)
          ) {
            return { valid: false, reason: "RESERVATION_EXPIRED" };
          }
          return {
            valid: true,
            redemption: existing,
            discount: existing.discount,
            shopifyDiscount: shopifyInputFromRedemption(existing),
          };
        }

        // Organization-wide code, valid only if it covers this app (multi-app).
        const discount = await findDiscountByCodeForApp(tx, rawParams.appId, params.normalizedCode);
        if (!discount) return { valid: false, reason: "NOT_FOUND" };
        if (!discount.active) return { valid: false, reason: "INACTIVE" };
        if (discount.startsAt && discount.startsAt > params.now) {
          return { valid: false, reason: "NOT_STARTED" };
        }
        if (discount.endsAt && discount.endsAt < params.now) {
          return { valid: false, reason: "EXPIRED" };
        }
        if (
          discount.externalPlanKey &&
          discount.externalPlanKey !== params.externalPlanKey
        ) {
          return { valid: false, reason: "PLAN_MISMATCH" };
        }

        const calculated = calculateNativeValue({
          discount,
          listPrice: params.listPrice,
          currencyCode: params.currencyCode,
        });
        if (!calculated.valid) return calculated;

        const commonWhere = {
          discountId: discount.id,
          ...activeRedemptionWhere(params.now),
        };
        const [totalUses, shopUses] = await Promise.all([
          discount.maxRedemptions
            ? tx.discountRedemption.count({ where: commonWhere })
            : Promise.resolve(0),
          discount.maxRedemptionsPerShop
            ? tx.discountRedemption.count({
                where: { ...commonWhere, shopDomain: params.shopDomain },
              })
            : Promise.resolve(0),
        ]);
        if (discount.maxRedemptions && totalUses >= discount.maxRedemptions) {
          return { valid: false, reason: "EXHAUSTED" };
        }
        if (
          discount.maxRedemptionsPerShop &&
          shopUses >= discount.maxRedemptionsPerShop
        ) {
          return { valid: false, reason: "SHOP_LIMIT_REACHED" };
        }

        const redemption = await tx.discountRedemption.create({
          data: {
            appId: rawParams.appId,
            discountId: discount.id,
            shopDomain: params.shopDomain,
            externalPlanKey: params.externalPlanKey,
            idempotencyKey: params.idempotencyKey,
            listPrice: params.listPrice,
            priceAfterDiscount: calculated.priceAfterDiscount,
            currencyCode: params.currencyCode,
            discountType: discount.type,
            discountValue: discount.value,
            durationIntervals: discount.durationIntervals,
            shopifyPercentage: calculated.shopifyPercentage,
            shopifyAmount: calculated.shopifyAmount,
            expiresAt: new Date(params.now.getTime() + RESERVATION_TTL_MS),
          },
        });
        return {
          valid: true,
          redemption,
          discount,
          shopifyDiscount: shopifyInputFromRedemption(redemption),
        };
      },
      { isolationLevel: "Serializable" },
    );

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await execute();
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? error.code
          : null;
      if ((code === "P2002" || code === "P2034") && attempt < 2) continue;
      throw error;
    }
  }
  throw new Error("Native discount reservation retry exhausted");
}

export async function confirmNativeDiscountRedemption(params: {
  appId: string;
  redemptionId: string;
  shopifySubscriptionId: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const shopifySubscriptionId = params.shopifySubscriptionId.trim();
  if (!SHOPIFY_SUBSCRIPTION_GID.test(shopifySubscriptionId)) {
    throw new Error("shopifySubscriptionId must be an AppSubscription GID");
  }
  return prisma.$transaction(async (tx) => {
    const redemption = await tx.discountRedemption.findFirst({
      where: { id: params.redemptionId, appId: params.appId },
    });
    if (!redemption) throw new NativeDiscountMutationError("NOT_FOUND", 404);
    if (redemption.status === "RELEASED") {
      throw new NativeDiscountMutationError("RELEASED", 409);
    }
    if (
      redemption.status === "APPLIED" &&
      redemption.shopifySubscriptionId !== shopifySubscriptionId
    ) {
      throw new NativeDiscountMutationError("ALREADY_APPLIED", 409);
    }
    if (redemption.status === "RESERVED" && redemption.expiresAt <= now) {
      throw new NativeDiscountMutationError("RESERVATION_EXPIRED", 410);
    }
    if (redemption.status === "APPLIED") return redemption;
    return tx.discountRedemption.update({
      where: { id: redemption.id },
      data: {
        status: "APPLIED",
        appliedAt: now,
        shopifySubscriptionId,
      },
    });
  });
}

export async function releaseNativeDiscountRedemption(params: {
  appId: string;
  redemptionId: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const redemption = await prisma.discountRedemption.findFirst({
    where: { id: params.redemptionId, appId: params.appId },
  });
  if (!redemption) throw new NativeDiscountMutationError("NOT_FOUND", 404);
  if (redemption.status === "APPLIED") {
    throw new NativeDiscountMutationError("ALREADY_APPLIED", 409);
  }
  if (redemption.status === "RELEASED") return redemption;
  return prisma.discountRedemption.update({
    where: { id: redemption.id },
    data: { status: "RELEASED", releasedAt: now },
  });
}

export class NativeDiscountMutationError extends Error {
  readonly status: number;
  readonly reason: string;

  constructor(reason: string, status: number) {
    super(reason.replaceAll("_", " ").toLowerCase());
    this.name = "NativeDiscountMutationError";
    this.reason = reason;
    this.status = status;
  }
}
