import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";
import { apiError, handleApi, requireApiApp } from "~/lib/api-auth.server";
import { prisma } from "~/lib/db.server";
import { ingestUsage } from "~/lib/flex/auto-upgrade.server";

const schema = z
  .object({
    shopDomain: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/),
    metric: z.string().trim().min(1).max(100),
    quantity: z.union([
      z.number().finite().positive(),
      z
        .string()
        .trim()
        .regex(/^(?:0|[1-9]\d{0,17})(?:\.\d{1,6})?$/)
        .refine((value) => Number(value) > 0, "quantity must be positive"),
    ]),
    idempotencyKey: z.string().trim().min(8).max(191).optional(),
  })
  .strict();

/**
 * POST /api/flex/usage
 * Report a metered usage event. May trigger an automatic tier upgrade when the
 * metric crosses the plan's limitMax (spec §6).
 */
export function action({ request }: ActionFunctionArgs) {
  return handleApi(async () => {
    if (request.method !== "POST") return apiError(405, "Method not allowed");
    const app = await requireApiApp(request);
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success)
      return apiError(400, "Invalid body", { issues: parsed.error.issues });

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

    const install = await prisma.appInstall.findUnique({
      where: {
        appId_shopDomain: { appId: app.id, shopDomain: parsed.data.shopDomain },
      },
    });
    if (!install) return apiError(404, "Install not found for shop");
    if (install.uninstalledAt) {
      return apiError(410, "App is no longer installed for this shop");
    }

    const result = await ingestUsage({
      appInstallId: install.id,
      metric: parsed.data.metric,
      quantity: parsed.data.quantity,
      idempotencyKey,
    });
    return Response.json(result);
  });
}
