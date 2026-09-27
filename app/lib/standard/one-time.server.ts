/**
 * One-time purchases: add-ons, lifetime deals, setup fees (spec §5.5).
 *
 * Kept apart from subscriptions on purpose, and not out of tidiness. An
 * `AppPurchaseOneTime` has no interval, no trial, no discount and no cycle to
 * renew, so:
 *
 *   - it takes **no part in the single-active-subscription invariant** — buying
 *     an add-on must not cancel the plan the merchant is on, which is exactly
 *     what would happen if it lived in `subscriptions`;
 *   - the **period-clock reconciliation never touches it**, because there is no
 *     clock to mirror;
 *   - it is **never cancelled**. Shopify has no mutation for it, and refunds are
 *     a Partner-dashboard action. A purchase that happened stays happened.
 *
 * What it shares with a subscription is the one rule that matters: **verify
 * against Shopify before recording it as paid.** The return redirect is a
 * trigger, not proof.
 */
import { randomUUID } from "node:crypto";
import {
  BILLING_ACCESS_QUERY_PARAM,
  createBillingAccessToken,
} from "../billing-access.server";
import { prisma } from "../db.server";
import { env } from "../env.server";
import { logger } from "../logger.server";
import {
  appPurchaseOneTimeCreate,
  getAppPurchaseOneTimeStatus,
} from "../shopify/billing.server";
import { StandardBillingError } from "./subscribe.server";

const log = logger.scope("standard-one-time");

const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export interface OneTimePurchaseParams {
  appInstallId: string;
  /** What the merchant sees on the confirmation screen. */
  name: string;
  amount: string | number;
  currencyCode?: string;
  /** The catalogue plan/add-on this buys, when there is one. */
  planId?: string;
  test?: boolean;
  idempotencyKey?: string;
}

export interface OneTimePurchaseResult {
  purchaseId: string;
  confirmationUrl: string;
  status: "PENDING";
}

/**
 * Start a one-time purchase and return the URL the merchant must approve.
 *
 * There is no `$0` shortcut here, unlike a subscription: a free add-on is not a
 * purchase at all, and asking Shopify to collect nothing would send the merchant
 * to an approval screen for the privilege. Grant it in the app instead.
 */
export async function createOneTimePurchase(
  params: OneTimePurchaseParams,
): Promise<OneTimePurchaseResult> {
  const amount = Number(params.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new StandardBillingError(
      "A one-time purchase needs a positive amount; grant a free add-on directly.",
    );
  }

  const install = await prisma.appInstall.findUnique({
    where: { id: params.appInstallId },
    include: { app: true },
  });
  if (!install) throw new StandardBillingError("Install not found", 404);
  if (install.uninstalledAt) {
    throw new StandardBillingError("App is uninstalled for this shop");
  }

  if (params.idempotencyKey) {
    const existing = await prisma.appOneTimePurchase.findUnique({
      where: { idempotencyKey: params.idempotencyKey },
      select: { id: true, confirmationUrl: true },
    });
    if (existing?.confirmationUrl) {
      // Re-answer rather than charge twice. This is the whole reason the key
      // exists: a retried POST must not create a second purchase.
      return {
        purchaseId: existing.id,
        confirmationUrl: existing.confirmationUrl,
        status: "PENDING",
      };
    }
  }

  const now = new Date();
  const purchase = await prisma.appOneTimePurchase.create({
    data: {
      appInstallId: install.id,
      planId: params.planId ?? null,
      name: params.name,
      amount: amount.toFixed(2),
      currencyCode: params.currencyCode ?? "USD",
      test: params.test ?? false,
      idempotencyKey: params.idempotencyKey || randomUUID(),
      approvalExpiresAt: new Date(now.getTime() + APPROVAL_TTL_MS),
    },
  });

  const access = createBillingAccessToken(install.id, {
    ttlSeconds: APPROVAL_TTL_MS / 1_000,
  });
  const callbackUrl = new URL("/api/flex/return", env.APP_URL);
  // A distinct parameter from `sid`, so the return handler cannot mistake a
  // purchase for a subscription and run the wrong activation.
  callbackUrl.searchParams.set("pid", purchase.id);
  callbackUrl.searchParams.set(BILLING_ACCESS_QUERY_PARAM, access.token);

  try {
    const created = await appPurchaseOneTimeCreate(install.app, install, {
      name: params.name,
      amount: amount.toFixed(2),
      currencyCode: params.currencyCode ?? "USD",
      returnUrl: callbackUrl.toString(),
      test: params.test ?? false,
    });
    await prisma.appOneTimePurchase.update({
      where: { id: purchase.id },
      data: {
        platformId: created.platformId,
        confirmationUrl: created.confirmationUrl,
        test: created.test,
      },
    });
    return {
      purchaseId: purchase.id,
      confirmationUrl: created.confirmationUrl,
      status: "PENDING",
    };
  } catch (error) {
    await prisma.appOneTimePurchase
      .update({
        where: { id: purchase.id },
        data: { status: "DECLINED" },
      })
      .catch(() => {});
    throw error;
  }
}

/**
 * Confirm a one-time purchase after the merchant returns.
 *
 * Verifies against Shopify before recording it as paid, and is idempotent — a
 * refreshed return page must not double-record.
 */
export async function confirmOneTimePurchase(
  purchaseId: string,
): Promise<{ confirmed: boolean; reason?: string }> {
  const purchase = await prisma.appOneTimePurchase.findUnique({
    where: { id: purchaseId },
    include: { appInstall: { include: { app: true } } },
  });
  if (!purchase) return { confirmed: false, reason: "not_found" };
  if (purchase.status === "ACTIVE" && purchase.activatedAt) {
    return { confirmed: true };
  }
  if (!purchase.platformId) {
    return { confirmed: false, reason: "never_reached_shopify" };
  }

  const status = await getAppPurchaseOneTimeStatus(
    purchase.appInstall.app,
    purchase.appInstall,
    purchase.platformId,
  );
  if (!status) return { confirmed: false, reason: "shopify_unknown" };

  const upper = status.toUpperCase();
  if (upper === "ACTIVE") {
    await prisma.appOneTimePurchase.update({
      where: { id: purchase.id },
      data: { status: "ACTIVE", activatedAt: new Date() },
    });
    return { confirmed: true };
  }

  if (upper === "DECLINED" || upper === "EXPIRED") {
    await prisma.appOneTimePurchase.update({
      where: { id: purchase.id },
      data: { status: upper === "DECLINED" ? "DECLINED" : "EXPIRED" },
    });
    return { confirmed: false, reason: `shopify_${upper.toLowerCase()}` };
  }

  // PENDING: the merchant has not finished. Left as-is so a later return or the
  // sweep can pick it up.
  log.info("one-time purchase still pending on Shopify", {
    purchaseId,
    shopifyStatus: status,
  });
  return { confirmed: false, reason: "shopify_pending" };
}

/**
 * Expire abandoned purchases. Shopify never expires a confirmation URL, so an
 * approval screen the merchant closed would otherwise stay PENDING forever.
 */
export async function expirePendingOneTimePurchases(
  now = new Date(),
): Promise<{ expired: number }> {
  const result = await prisma.appOneTimePurchase.updateMany({
    where: {
      status: "PENDING",
      OR: [
        { approvalExpiresAt: { lte: now } },
        {
          approvalExpiresAt: null,
          createdAt: { lte: new Date(now.getTime() - APPROVAL_TTL_MS) },
        },
      ],
    },
    data: { status: "EXPIRED" },
  });
  if (result.count) {
    log.info("expired pending one-time purchases", { expired: result.count });
  }
  return { expired: result.count };
}
