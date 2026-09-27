import { z } from "zod";
import type { Route } from "./+types/native-discount-resolve";
import {
  ApiRateLimitError,
  enforceAppRateLimit,
} from "~/lib/api-rate-limit.server";
import { apiError, requireApiApp } from "~/lib/api-auth.server";
import { reserveNativeDiscount } from "~/lib/native-discounts.server";

const money = z
  .union([z.string(), z.number()])
  .transform(String)
  .pipe(z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/));

const schema = z
  .object({
    code: z.string().trim().min(1).max(64),
    shopDomain: z.string().trim().min(1).max(255),
    externalPlanKey: z.string().trim().min(1).max(191),
    listPrice: money,
    currencyCode: z.string().trim().length(3),
    idempotencyKey: z.string().trim().min(8).max(191).optional(),
  })
  .strict();

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" };

/**
 * Reserves a centrally-managed discount and returns the exact input the app
 * places under appRecurringPricingDetails.discount.
 */
export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") return apiError(405, "Method not allowed");
  try {
    const app = await requireApiApp(request);
    await enforceAppRateLimit({
      appId: app.id,
      routeKey: "native-discount-resolve",
      limit: 120,
    });
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return Response.json(
        { error: "Invalid body", issues: parsed.error.issues },
        { status: 400, headers: NO_STORE_HEADERS },
      );
    }
    const idempotencyKey =
      request.headers.get("idempotency-key")?.trim() ??
      parsed.data.idempotencyKey;
    if (!idempotencyKey) {
      return Response.json(
        {
          error: "Missing Idempotency-Key header or idempotencyKey body field",
        },
        { status: 400, headers: NO_STORE_HEADERS },
      );
    }

    const result = await reserveNativeDiscount({
      appId: app.id,
      code: parsed.data.code,
      shopDomain: parsed.data.shopDomain,
      externalPlanKey: parsed.data.externalPlanKey,
      listPrice: parsed.data.listPrice,
      currencyCode: parsed.data.currencyCode,
      idempotencyKey,
    });
    if (!result.valid) {
      return Response.json(result, { headers: NO_STORE_HEADERS });
    }
    return Response.json(
      {
        valid: true,
        discount: {
          id: result.discount.id,
          code: result.discount.code,
          type: result.discount.type,
          value: result.discount.value.toString(),
          durationIntervals: result.discount.durationIntervals,
          externalPlanKey: result.discount.externalPlanKey,
          description: result.discount.description,
        },
        reservation: {
          id: result.redemption.id,
          status: result.redemption.status,
          expiresAt: result.redemption.expiresAt.toISOString(),
        },
        pricing: {
          listPrice: result.redemption.listPrice.toFixed(2),
          priceAfterDiscount: result.redemption.priceAfterDiscount.toFixed(2),
          currencyCode: result.redemption.currencyCode,
        },
        shopifyDiscount: result.shopifyDiscount,
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
    return Response.json(
      { error: error instanceof Error ? error.message : "Request failed" },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }
}
