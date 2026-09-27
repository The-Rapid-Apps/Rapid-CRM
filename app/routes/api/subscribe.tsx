import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";
import { apiError, handleApi, requireApiApp } from "~/lib/api-auth.server";
import { prisma } from "~/lib/db.server";
import { findEligibleDiscountByCode } from "~/lib/flex/discounts.server";
import { subscribe } from "~/lib/flex/subscribe.server";
import {
  StandardBillingError,
  subscribeStandard,
} from "~/lib/standard/subscribe.server";
import { standardDiscountFor } from "~/lib/standard/discounts";

const schema = z
  .object({
    shopDomain: z.string().trim().min(1).max(255),
    planId: z.string().min(1),
    test: z.boolean().optional(),
    discountCode: z.string().trim().min(1).max(191).optional(),
    idempotencyKey: z.string().min(8).max(191).optional(),
  })
  .strict();

/**
 * POST /api/flex/subscribe
 *
 * Creates a subscription for a merchant and returns the Shopify
 * `confirmationUrl` the app must redirect them to.
 *
 * Serves BOTH rails, chosen by the PLAN rather than by a parameter. The caller
 * knows which plan it is selling and should not also have to know how that plan
 * is billed — and a caller that had to choose could choose wrong, pricing a flex
 * plan's real amount on a recurring line (which re-approves on every tier change)
 * or a standard plan at $0 (which never bills at all).
 *
 * A free standard plan returns `confirmationUrl: null` and is already ACTIVE:
 * there is nothing for Shopify to collect, so there is no approval screen
 * (spec §5.6).
 */
export function action({ request }: ActionFunctionArgs) {
  return handleApi(async () => {
    if (request.method !== "POST") return apiError(405, "Method not allowed");
    const app = await requireApiApp(request);
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success)
      return apiError(400, "Invalid body", { issues: parsed.error.issues });

    const install = await prisma.appInstall.findUnique({
      where: {
        appId_shopDomain: { appId: app.id, shopDomain: parsed.data.shopDomain },
      },
    });
    if (!install) return apiError(404, "Install not found for shop");

    let discountId: string | undefined;
    if (parsed.data.discountCode) {
      const resolution = await findEligibleDiscountByCode({
        appId: app.id,
        code: parsed.data.discountCode,
        planId: parsed.data.planId,
      });
      if (!resolution.valid) {
        const status = resolution.reason === "NOT_FOUND" ? 404 : 422;
        return apiError(status, "Discount code is not eligible", {
          reason: resolution.reason,
        });
      }
      discountId = resolution.discount.id;
    }

    const idempotencyKey =
      request.headers.get("idempotency-key") ?? parsed.data.idempotencyKey;
    if (
      idempotencyKey &&
      (idempotencyKey.trim().length < 8 || idempotencyKey.trim().length > 191)
    ) {
      return apiError(
        400,
        "Idempotency-Key must be between 8 and 191 characters",
      );
    }

    const plan = await prisma.plan.findUnique({
      where: { id: parsed.data.planId },
      select: { id: true, appId: true, flexBilling: true },
    });
    if (!plan || plan.appId !== app.id) {
      return apiError(404, "Plan not found for this app");
    }

    if (plan.flexBilling) {
      const result = await subscribe({
        appInstallId: install.id,
        planId: parsed.data.planId,
        test: parsed.data.test,
        discountId,
        idempotencyKey,
      });
      return Response.json(result);
    }

    /*
      Standard rail. The discount has to be translated rather than passed by id:
      Shopify prices the recurring line itself, so it needs the discount as a
      value on that line, whereas flex applies discounts to the usage records it
      posts and can keep them as a local reference.
    */
    try {
      const result = await subscribeStandard({
        appInstallId: install.id,
        planId: parsed.data.planId,
        test: parsed.data.test,
        discount: discountId ? await standardDiscountFor(discountId) : null,
        idempotencyKey,
      });
      return Response.json(result);
    } catch (error) {
      if (error instanceof StandardBillingError) {
        return apiError(error.status, error.message);
      }
      throw error;
    }
  });
}
