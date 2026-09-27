import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { z } from "zod";
import { apiError, handleApi, requireApiApp } from "~/lib/api-auth.server";
import { createSignedBillingUrl } from "~/lib/billing-access.server";
import { prisma } from "~/lib/db.server";
import { markInstallSnapshotDirty } from "~/lib/reports/install-snapshot.server";
import { syncCustomerStateForInstall } from "~/lib/shopify/partner-state-sync.server";

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

const shopDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/,
    "shopDomain must be a valid *.myshopify.com domain",
  );

const schema = z
  .object({
    shopDomain: shopDomainSchema,
    /** The merchant's Shopify OFFLINE access token — required to bill on their behalf. */
    accessToken: z.string().trim().min(1).max(512).optional(),
    /** Numeric Shopify shop id or gid://partners/Shop/... for Partner credits. */
    shopPlatformId: z
      .string()
      .regex(/^(?:\d+|gid:\/\/partners\/Shop\/\d+)$/)
      .optional(),
    scope: z.string().max(2_000).optional(),
  })
  .strict();

/**
 * GET /api/flex/installs
 * Lists merchant installs owned by the authenticated app. Access-token values
 * are never returned; callers only receive a safe token-presence indicator.
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
      const cursor = await prisma.appInstall.findFirst({
        where: { id: after, appId: app.id },
        select: { id: true },
      });
      if (!cursor) return apiError(400, "Invalid cursor");
    }

    const installsPlusOne = await prisma.appInstall.findMany({
      where: { appId: app.id },
      orderBy: [{ installedAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(after ? { cursor: { id: after }, skip: 1 } : {}),
      select: {
        id: true,
        shopDomain: true,
        shopPlatformId: true,
        scope: true,
        installedAt: true,
        uninstalledAt: true,
        trialConsumedAt: true,
        accessToken: true,
      },
    });

    const hasNextPage = installsPlusOne.length > limit;
    const page = installsPlusOne.slice(0, limit);
    const endCursor = page.length > 0 ? page[page.length - 1].id : null;

    return Response.json(
      {
        installs: page.map(({ accessToken, ...install }) => ({
          ...install,
          status: install.uninstalledAt ? "UNINSTALLED" : "ACTIVE",
          hasAccessToken: Boolean(accessToken),
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

/**
 * POST /api/flex/installs   — register or refresh a merchant install
 * DELETE /api/flex/installs — mark an install uninstalled
 *
 * Your app keeps its own Shopify OAuth. After a merchant authorizes it, the app calls
 * this endpoint to hand the platform the shop domain + offline access token, so
 * the platform can post usage records on that shop's behalf. Authenticated with
 * the app's platform API key.
 */
export function action({ request }: ActionFunctionArgs) {
  return handleApi(async () => {
    const app = await requireApiApp(request);
    const body = await request.json().catch(() => null);

    if (request.method === "DELETE") {
      const parsedDelete = z
        .object({ shopDomain: shopDomainSchema })
        .strict()
        .safeParse(body);
      if (!parsedDelete.success) {
        return apiError(400, "Invalid body", {
          issues: parsedDelete.error.issues,
        });
      }
      const existing = await prisma.appInstall.findUnique({
        where: {
          appId_shopDomain: {
            appId: app.id,
            shopDomain: parsedDelete.data.shopDomain,
          },
        },
        select: { id: true },
      });
      if (!existing) return Response.json({ ok: true, uninstalled: false });

      const now = new Date();
      await prisma.$transaction([
        prisma.appInstall.update({
          where: { id: existing.id },
          data: {
            uninstalledAt: now,
            relationshipStateSyncedAt: now,
            accessToken: null,
          },
        }),
        prisma.subscription.updateMany({
          where: {
            appInstallId: existing.id,
            status: { not: "CANCELLED" },
          },
          data: {
            status: "CANCELLED",
            canceledAt: now,
            pausedUntil: null,
          },
        }),
      ]);
      await markInstallSnapshotDirty(app.id, now);
      await syncCustomerStateForInstall(app.id, parsedDelete.data.shopDomain);
      return Response.json({ ok: true, uninstalled: true });
    }

    if (request.method !== "POST") return apiError(405, "Method not allowed");

    const parsed = schema.safeParse(body);
    if (!parsed.success)
      return apiError(400, "Invalid body", { issues: parsed.error.issues });
    const { shopDomain, accessToken, shopPlatformId, scope } = parsed.data;
    const installedNow = new Date();
    const existing = await prisma.appInstall.findUnique({
      where: { appId_shopDomain: { appId: app.id, shopDomain } },
      select: { accessToken: true },
    });
    if (!accessToken && !existing?.accessToken) {
      return apiError(
        400,
        "An offline accessToken is required when registering an install",
      );
    }

    const install = await prisma.appInstall.upsert({
      where: { appId_shopDomain: { appId: app.id, shopDomain } },
      update: {
        accessToken: accessToken ?? undefined,
        shopPlatformId: shopPlatformId ?? undefined,
        scope: scope ?? undefined,
        // Re-installing clears a prior uninstall.
        uninstalledAt: null,
        relationshipStateSyncedAt: installedNow,
      },
      create: {
        appId: app.id,
        shopDomain,
        accessToken,
        shopPlatformId,
        scope,
        installedAt: installedNow,
        relationshipStateSyncedAt: installedNow,
      },
    });
    await markInstallSnapshotDirty(app.id, installedNow);
    await syncCustomerStateForInstall(app.id, shopDomain);

    const billingAccess = createSignedBillingUrl(install.id);
    return Response.json(
      {
        installId: install.id,
        shopDomain: install.shopDomain,
        billingUrl: billingAccess.url,
        billingAccessExpiresAt: billingAccess.expiresAt.toISOString(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  });
}
