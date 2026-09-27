import type { Discount } from "../../../generated/prisma/client";
import { prisma } from "../db.server";
import { D, isPositive, max, ZERO, type Money } from "../money.server";
import { appCreditCreate } from "../shopify/billing.server";
import {
  isPartnerApiConfigured,
  partnerApiConfigurationIssue,
  partnerShopGid,
} from "../shopify/partner.server";
import type { SubscriptionContext } from "./context.server";
import { priceAfterDiscount } from "./discounts.server";

export interface DiscountCreditResult {
  created: boolean;
  amount: Money;
  chargeId?: string;
}

export function discountAppCreditAmount(
  listAmount: Money | string | number,
  discount: Discount,
): Money {
  if (discount.discountMethod !== "APP_CREDITS") return ZERO;
  return max(
    D(listAmount).minus(priceAfterDiscount(listAmount, discount)),
    ZERO,
  );
}

/** Fail before collecting the full fee if its matching credit cannot be issued. */
export function assertDiscountAppCreditReady(
  ctx: SubscriptionContext,
  discount: Discount | null,
): void {
  if (!discount || discount.discountMethod !== "APP_CREDITS") return;
  const creditAmount = discountAppCreditAmount(ctx.plan.amount, discount);
  if (!isPositive(creditAmount)) return;
  if (!isPartnerApiConfigured(ctx.appInstall.app)) {
    throw new Error(
      `APP_CREDITS discount requires Partner API access: ${
        partnerApiConfigurationIssue(ctx.appInstall.app) ?? "unavailable"
      }`,
    );
  }
  if (!ctx.appInstall.shopPlatformId) {
    throw new Error("APP_CREDITS discount requires appInstall.shopPlatformId");
  }
  partnerShopGid(ctx.appInstall.shopPlatformId);
}

/**
 * Issue the separate Partner app credit for one fully charged billing period.
 *
 * Partner appCreditCreate has no idempotency argument. We reserve a unique
 * PENDING charge before the call; an ambiguous failure is intentionally held
 * for reconciliation instead of risking a duplicate irreversible credit.
 */
export async function createDiscountAppCredit(
  ctx: SubscriptionContext,
  discount: Discount,
  billingPeriodStart: Date,
): Promise<DiscountCreditResult> {
  const amount = discountAppCreditAmount(ctx.plan.amount, discount);
  if (!isPositive(amount)) return { created: false, amount };
  assertDiscountAppCreditReady(ctx, discount);

  const key = `discount-credit:${ctx.id}:${discount.id}:${billingPeriodStart.toISOString()}`;
  const existing = await prisma.charge.findUnique({
    where: { idempotencyKey: key },
  });
  if (existing?.status === "ACTIVE" && existing.platformId) {
    return {
      created: false,
      amount: D(existing.amount),
      chargeId: existing.id,
    };
  }
  if (existing) {
    throw new Error(
      `App credit ${key} is pending reconciliation; refusing a duplicate Partner credit`,
    );
  }

  const pending = await prisma.charge.create({
    data: {
      subscriptionId: ctx.id,
      amount,
      chargedAmount: amount,
      chargedCurrencyCode: ctx.plan.currencyCode,
      idempotencyKey: key,
      isCredit: true,
      flexBilling: true,
      status: "PENDING",
      description: `Discount app credit (${discount.code ?? discount.id})`,
      billingPeriodStart,
      occurredAt: new Date(),
    },
  });

  const result = await appCreditCreate(ctx.appInstall.app, {
    amount,
    currencyCode: ctx.plan.currencyCode,
    shopId: partnerShopGid(ctx.appInstall.shopPlatformId as string),
    description: `Subscription discount credit [${key}]`,
    test: ctx.test,
  });

  await prisma.charge.update({
    where: { id: pending.id },
    data: { platformId: result.id, status: "ACTIVE" },
  });

  return { created: true, amount, chargeId: pending.id };
}
