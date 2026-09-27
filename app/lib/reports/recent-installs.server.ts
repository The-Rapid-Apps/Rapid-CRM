import { prisma } from "~/lib/db.server";
import { resolveCustomerNames } from "~/lib/customer-name.server";

/** A row of the Overview's "Recent installs" card. */
export interface RecentInstall {
  shopDomain: string;
  name: string;
  appName: string;
  appLogoUrl: string | null;
  /** The plan they're on, or null when they hold no Shopify charge — which is
   * most installs, since a fresh install is free until it subscribes. */
  plan: string | null;
  installedAt: string;
}

export async function getRecentInstalls(params: {
  appIds: string[];
  limit?: number;
}): Promise<RecentInstall[]> {
  const limit = params.limit ?? 8;
  if (params.appIds.length === 0) return [];

  const installs = await prisma.appInstall.findMany({
    where: { appId: { in: params.appIds }, uninstalledAt: null },
    orderBy: { installedAt: "desc" },
    take: limit,
    select: {
      appId: true,
      shopDomain: true,
      installedAt: true,
      app: { select: { name: true, logoUrl: true } },
    },
  });
  if (installs.length === 0) return [];

  /* Scoped to just these shops rather than a per-row query: the charge feed's
     (appId, shopDomain) index makes one OR-ed lookup cheap (7ms for eight
     shops), and the newest activation wins because the list is sorted. */
  const charges = await prisma.partnerSubscriptionEvent.findMany({
    where: {
      OR: installs.map((install) => ({
        appId: install.appId,
        shopDomain: install.shopDomain,
      })),
      type: "SUBSCRIPTION_CHARGE_ACTIVATED",
    },
    orderBy: { occurredAt: "desc" },
    select: { appId: true, shopDomain: true, chargeName: true },
  });
  const planByInstall = new Map<string, string>();
  for (const charge of charges) {
    const key = `${charge.appId}␟${charge.shopDomain}`;
    if (!planByInstall.has(key)) planByInstall.set(key, charge.chargeName);
  }

  const names = await resolveCustomerNames(
    installs.map((install) => install.shopDomain),
  );

  return installs.map((install) => ({
    shopDomain: install.shopDomain,
    name:
      names.get(install.shopDomain) ??
      install.shopDomain.replace(/\.myshopify\.com$/, ""),
    appName: install.app.name,
    appLogoUrl: install.app.logoUrl,
    plan:
      planByInstall.get(`${install.appId}␟${install.shopDomain}`) ?? null,
    installedAt: install.installedAt.toISOString(),
  }));
}
