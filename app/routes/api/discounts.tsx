import type { LoaderFunctionArgs } from "react-router";
import { z } from "zod";
import { apiError, handleApi, requireApiApp } from "~/lib/api-auth.server";
import { enforceAppRateLimit } from "~/lib/api-rate-limit.server";
import { discountInApp } from "~/lib/flex/discounts.server";
import { prisma } from "~/lib/db.server";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

const paginationSchema = z
  .object({
    after: z.string().trim().min(1).max(191).optional(),
    limit: z
      .string()
      .regex(/^[1-9]\d*$/, "limit must be a positive integer")
      .transform(Number)
      .refine((value) => value <= MAX_PAGE_SIZE, {
        message: `limit must be at most ${MAX_PAGE_SIZE}`,
      })
      .optional(),
  })
  .strict();

/**
 * GET /api/flex/discounts
 * Lists safe discount configuration fields owned by the authenticated app.
 */
export function loader({ request }: LoaderFunctionArgs) {
  return handleApi(async () => {
    const app = await requireApiApp(request);
    await enforceAppRateLimit({
      appId: app.id,
      routeKey: "discount-list",
      limit: 120,
    });
    const url = new URL(request.url);
    const parsed = paginationSchema.safeParse(
      Object.fromEntries(url.searchParams),
    );
    if (!parsed.success) {
      return apiError(400, "Invalid pagination", {
        issues: parsed.error.issues,
      });
    }

    const { after } = parsed.data;
    const limit = parsed.data.limit ?? DEFAULT_PAGE_SIZE;

    if (after) {
      const cursor = await prisma.discount.findFirst({
        where: { id: after, ...discountInApp(app.id) },
        select: { id: true },
      });
      if (!cursor) return apiError(400, "Invalid cursor");
    }

    const discountsPlusOne = await prisma.discount.findMany({
      // Includes discounts shared with other apps, not just this app's own.
      where: discountInApp(app.id),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(after ? { cursor: { id: after }, skip: 1 } : {}),
      select: {
        id: true,
        code: true,
        type: true,
        value: true,
        discountMethod: true,
        durationIntervals: true,
        externalPlanKey: true,
        currencyCode: true,
        startsAt: true,
        endsAt: true,
        maxRedemptions: true,
        maxRedemptionsPerShop: true,
        description: true,
        active: true,
        createdAt: true,
        updatedAt: true,
        plan: {
          select: {
            id: true,
            name: true,
          },
        },
        _count: {
          select: {
            subscriptionDiscounts: true,
            redemptions: true,
          },
        },
      },
    });

    const hasNextPage = discountsPlusOne.length > limit;
    const page = discountsPlusOne.slice(0, limit);
    const endCursor = page.length > 0 ? page[page.length - 1].id : null;

    return Response.json(
      {
        discounts: page.map(({ _count, ...discount }) => ({
          ...discount,
          value: discount.value.toString(),
          appliedSubscriptionCount: _count.subscriptionDiscounts,
          nativeRedemptionCount: _count.redemptions,
        })),
        pageInfo: {
          hasNextPage,
          endCursor,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  });
}
