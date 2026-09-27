import crypto from "node:crypto";
import type { ActionFunctionArgs } from "react-router";
import { prisma } from "~/lib/db.server";
import { logger } from "~/lib/logger.server";
import { markInstallSnapshotDirty } from "~/lib/reports/install-snapshot.server";
import { syncCustomerStateForInstall } from "~/lib/shopify/partner-state-sync.server";

const log = logger.scope("webhook-uninstalled");

/**
 * POST /webhooks/:appHandle/uninstalled
 *
 * The ONLY Shopify webhook flex billing registers (spec §2.6). Verifies the
 * HMAC with the app's own secret (multi-tenant: the app is identified by the
 * :appHandle path segment), then marks the install uninstalled so the cron
 * selector stops charging it.
 */
export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const app = await prisma.app.findUnique({
    where: { handle: params.appHandle ?? "" },
  });
  if (!app) return new Response("Unknown app", { status: 404 });
  if (!app.shopifyApiSecret) {
    log.error("webhook secret is not configured", { app: app.handle });
    return new Response("Webhook is not configured", { status: 503 });
  }

  // Verify HMAC over the raw body with this app's secret.
  const raw = await request.text();
  const hmacHeader = request.headers.get("x-shopify-hmac-sha256") ?? "";
  const digest = crypto
    .createHmac("sha256", app.shopifyApiSecret)
    .update(raw, "utf8")
    .digest("base64");

  const valid =
    hmacHeader.length === digest.length &&
    crypto.timingSafeEqual(Buffer.from(hmacHeader), Buffer.from(digest));
  if (!valid) {
    log.warn("invalid webhook HMAC", { app: app.handle });
    return new Response("Invalid HMAC", { status: 401 });
  }

  const shopDomain = request.headers.get("x-shopify-shop-domain");
  if (shopDomain) {
    const install = await prisma.appInstall.findUnique({
      where: { appId_shopDomain: { appId: app.id, shopDomain } },
      select: { id: true },
    });
    if (install) {
      const now = new Date();
      await prisma.$transaction([
        prisma.appInstall.update({
          where: { id: install.id },
          data: {
            uninstalledAt: now,
            relationshipStateSyncedAt: now,
            accessToken: null,
          },
        }),
        prisma.subscription.updateMany({
          where: {
            appInstallId: install.id,
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
      await syncCustomerStateForInstall(app.id, shopDomain);
    }
    log.info("app uninstalled", { app: app.handle, shop: shopDomain });
  }

  return new Response(null, { status: 200 });
}
