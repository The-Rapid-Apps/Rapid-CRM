import { z } from "zod";
import type { Route } from "./+types/native-discount-redemption";
import {
  ApiRateLimitError,
  enforceAppRateLimit,
} from "~/lib/api-rate-limit.server";
import { apiError, requireApiApp } from "~/lib/api-auth.server";
import {
  confirmNativeDiscountRedemption,
  NativeDiscountMutationError,
  releaseNativeDiscountRedemption,
} from "~/lib/native-discounts.server";

const confirmSchema = z
  .object({
    shopifySubscriptionId: z.string().trim().min(1).max(191),
  })
  .strict();
const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" };

/**
 * POST confirms after the app verifies Shopify status ACTIVE. DELETE releases
 * an abandoned or declined approval.
 */
export async function action({ request, params }: Route.ActionArgs) {
  try {
    const app = await requireApiApp(request);
    await enforceAppRateLimit({
      appId: app.id,
      routeKey: "native-discount-redemption",
      limit: 180,
    });
    const redemptionId = params.redemptionId;
    if (!redemptionId) return apiError(400, "Missing redemption id");

    if (request.method === "DELETE") {
      const redemption = await releaseNativeDiscountRedemption({
        appId: app.id,
        redemptionId,
      });
      return Response.json(
        {
          id: redemption.id,
          status: redemption.status,
          releasedAt: redemption.releasedAt?.toISOString() ?? null,
        },
        { headers: NO_STORE_HEADERS },
      );
    }
    if (request.method !== "POST") return apiError(405, "Method not allowed");

    const parsed = confirmSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success) {
      return Response.json(
        { error: "Invalid body", issues: parsed.error.issues },
        { status: 400, headers: NO_STORE_HEADERS },
      );
    }
    const redemption = await confirmNativeDiscountRedemption({
      appId: app.id,
      redemptionId,
      shopifySubscriptionId: parsed.data.shopifySubscriptionId,
    });
    return Response.json(
      {
        id: redemption.id,
        status: redemption.status,
        shopifySubscriptionId: redemption.shopifySubscriptionId,
        appliedAt: redemption.appliedAt?.toISOString() ?? null,
      },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof ApiRateLimitError) {
      return Response.json(
        { error: error.message },
        {
          status: 429,
          headers: {
            ...NO_STORE_HEADERS,
            "Retry-After": String(error.retryAfterSeconds),
          },
        },
      );
    }
    if (error instanceof NativeDiscountMutationError) {
      return Response.json(
        { error: error.message, reason: error.reason },
        { status: error.status, headers: NO_STORE_HEADERS },
      );
    }
    return Response.json(
      { error: error instanceof Error ? error.message : "Request failed" },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }
}
