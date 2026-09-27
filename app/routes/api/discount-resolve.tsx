import type { Route } from "./+types/discount-resolve";
import { apiError, handleApi, requireApiApp } from "~/lib/api-auth.server";
import { prisma } from "~/lib/db.server";
import {
  findEligibleDiscountByCode,
  resolveChargeAmount,
} from "~/lib/flex/discounts.server";
import { toCents } from "~/lib/money.server";

/**
 * GET /api/flex/discount/resolve?code=SAVE20&planId=...
 *
 * This is the endpoint an app calls to check a code: it passes a discount
 * code (and optionally a plan) and we return whether it's valid and the
 * resulting discounted price — no Shopify discount codes involved. The price is
 * what the flex charge cron will actually post as a usage record (spec §4.2).
 */
export function loader({ request }: Route.LoaderArgs) {
  return handleApi(async () => {
    const app = await requireApiApp(request);
    const url = new URL(request.url);
    const code = url.searchParams.get("code")?.trim();
    const planId = url.searchParams.get("planId")?.trim() || null;
    if (!code) return apiError(400, "Missing ?code");

    let plan = null;
    if (planId) {
      plan = await prisma.plan.findFirst({
        where: { id: planId, appId: app.id },
      });
      if (!plan) {
        return apiError(404, "Plan not found for this app");
      }
    }

    const resolution = await findEligibleDiscountByCode({
      appId: app.id,
      code,
      planId,
    });
    if (!resolution.valid) {
      return Response.json({ valid: false, reason: resolution.reason });
    }

    const discount = resolution.discount;
    const priced = plan
      ? {
          planId: plan.id,
          listPrice: toCents(plan.amount).toFixed(2),
          // APP_CREDITS intentionally stays at list price here; its benefit is
          // a separate Partner API money movement, not a reduced usage record.
          discountedPrice: toCents(
            resolveChargeAmount(plan.amount, discount).amount,
          ).toFixed(2),
        }
      : null;

    return Response.json({
      valid: true,
      discount: {
        id: discount.id,
        code: discount.code,
        type: discount.type,
        value: discount.value.toString(),
        discountMethod: discount.discountMethod,
        durationIntervals: discount.durationIntervals,
        planId: discount.planId,
        description: discount.description,
      },
      priced,
    });
  });
}
