import type { LoaderFunctionArgs } from "react-router";
import { z } from "zod";
import { apiError, handleApi, requireApiApp } from "~/lib/api-auth.server";
import { prisma } from "~/lib/db.server";

const shopDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/,
    "shopDomain must be a valid *.myshopify.com domain",
  );

const querySchema = z
  .object({
    shopDomain: shopDomainSchema,
    /**
     * By default only apps the shop currently has installed are returned. Pass
     * `includeUninstalled=true` to also list apps it installed and later removed.
     */
    includeUninstalled: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
  })
  .strict();

/**
 * GET /api/flex/apps?shopDomain=<shop>.myshopify.com
 *
 * Given a merchant's shop domain, lists every app in the caller's organization
 * ("our store") that this shop has installed. Scoped to the API key's
 * organization: a caller authenticated with one app's key sees the whole
 * portfolio's installs for that shop (useful for cross-app / cross-sell
 * lookups), but never another organization's apps. No secrets, tokens, or
 * platform API keys are ever returned — only a safe token-presence indicator.
 */
export function loader({ request }: LoaderFunctionArgs) {
  return handleApi(async () => {
    const app = await requireApiApp(request);
    const url = new URL(request.url);
    const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) {
      return apiError(400, "Invalid query", { issues: parsed.error.issues });
    }
    const { shopDomain, includeUninstalled } = parsed.data;

    const installs = await prisma.appInstall.findMany({
      where: {
        shopDomain,
        ...(includeUninstalled ? {} : { uninstalledAt: null }),
        app: {
          organizationId: app.organizationId,
          enabled: true,
          removed: false,
          scheduledForDeletionAt: null,
        },
      },
      orderBy: [{ installedAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        installedAt: true,
        uninstalledAt: true,
        accessToken: true,
        app: {
          select: { id: true, name: true, handle: true, distribution: true },
        },
      },
    });

    return Response.json(
      {
        shopDomain,
        apps: installs.map(({ id, installedAt, uninstalledAt, accessToken, app: installedApp }) => ({
          id: installedApp.id,
          name: installedApp.name,
          handle: installedApp.handle,
          distribution: installedApp.distribution,
          installId: id,
          installedAt,
          uninstalledAt,
          status: uninstalledAt ? "UNINSTALLED" : "ACTIVE",
          hasAccessToken: Boolean(accessToken),
        })),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  });
}
