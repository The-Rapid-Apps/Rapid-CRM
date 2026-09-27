import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";
import { apiError, handleApi, requireApiApp } from "~/lib/api-auth.server";
import { prisma } from "~/lib/db.server";
import { changeTier } from "~/lib/flex/tier-change.server";

const schema = z
  .object({
    subscriptionId: z.string().min(1),
    newPlanId: z.string().min(1),
    discountId: z.string().optional(),
  })
  .strict();

/**
 * POST /api/flex/change-tier
 * In-place upgrade/downgrade with proration. Returns either { status: "changed" }
 * or, if the upgrade can't fit the cap, { status: "confirmation_required",
 * confirmationUrl }.
 */
export function action({ request }: ActionFunctionArgs) {
  return handleApi(async () => {
    if (request.method !== "POST") return apiError(405, "Method not allowed");
    const app = await requireApiApp(request);
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success)
      return apiError(400, "Invalid body", { issues: parsed.error.issues });

    // Ownership check: the subscription must belong to this app.
    const sub = await prisma.subscription.findUnique({
      where: { id: parsed.data.subscriptionId },
      include: { appInstall: true },
    });
    if (!sub || sub.appInstall.appId !== app.id) {
      return apiError(404, "Subscription not found");
    }

    const result = await changeTier({
      subscriptionId: parsed.data.subscriptionId,
      newPlanId: parsed.data.newPlanId,
      discountId: parsed.data.discountId,
    });
    return Response.json(result);
  });
}
