import type { LoaderFunctionArgs } from "react-router";
import { z } from "zod";
import { apiError, handleApi, requireApiApp } from "~/lib/api-auth.server";
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
 * GET /api/flex/subscriptions
 * Lists subscriptions owned by the authenticated app. Shopify access tokens,
 * confirmation URLs, idempotency keys, and usage-line identifiers are omitted.
 */
export function loader({ request }: LoaderFunctionArgs) {
  return handleApi(async () => {
    const app = await requireApiApp(request);
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
      const cursor = await prisma.subscription.findFirst({
        where: { id: after, appInstall: { appId: app.id } },
        select: { id: true },
      });
      if (!cursor) return apiError(400, "Invalid cursor");
    }

    const subscriptionsPlusOne = await prisma.subscription.findMany({
      where: { appInstall: { appId: app.id } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(after ? { cursor: { id: after }, skip: 1 } : {}),
      select: {
        id: true,
        billingProvider: true,
        status: true,
        test: true,
        activatedAt: true,
        canceledAt: true,
        frozenAt: true,
        pausedUntil: true,
        currentPeriodStart: true,
        currentPeriodEnd: true,
        nextBillingDate: true,
        billingCycleAnchor: true,
        shopifySubscriptionId: true,
        trialStartedAt: true,
        trialEndsAt: true,
        createdAt: true,
        updatedAt: true,
        appInstall: {
          select: {
            id: true,
            shopDomain: true,
          },
        },
        plan: {
          select: {
            id: true,
            name: true,
            amount: true,
            currencyCode: true,
            interval: true,
          },
        },
      },
    });

    const hasNextPage = subscriptionsPlusOne.length > limit;
    const page = subscriptionsPlusOne.slice(0, limit);
    const endCursor = page.length > 0 ? page[page.length - 1].id : null;

    return Response.json(
      {
        subscriptions: page.map((subscription) => ({
          ...subscription,
          plan: {
            ...subscription.plan,
            amount: subscription.plan.amount.toString(),
          },
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
