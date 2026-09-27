import "dotenv/config";
import { prisma } from "../app/lib/db.server";
import { checkActiveShopifyConnections } from "../app/lib/shopify/connection.server";

async function main(): Promise<void> {
  const apps = await prisma.app.findMany({
    where: { enabled: true, removed: false, scheduledForDeletionAt: null },
    orderBy: [{ organizationId: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      handle: true,
      organizationId: true,
      _count: { select: { installs: true } },
      installs: {
        where: { uninstalledAt: null },
        select: { id: true, accessToken: true },
      },
    },
  });

  if (apps.length === 0) {
    console.log("No enabled apps are registered.");
    return;
  }

  let failedConnections = 0;
  let connectedShops = 0;
  let appsAwaitingOAuth = 0;

  for (const app of apps) {
    const activeWithToken = app.installs.filter((install) =>
      Boolean(install.accessToken),
    ).length;
    console.log(
      `\n${app.name} (${app.handle}): ${app._count.installs} total install(s), ${app.installs.length} active, ${activeWithToken} with offline token`,
    );

    if (activeWithToken === 0) {
      appsAwaitingOAuth += 1;
      console.log(
        "  NO ADMIN TOKENS — Partner analytics can be connected, but merchant billing waits for app OAuth and POST /api/flex/installs.",
      );
      continue;
    }

    const results = await checkActiveShopifyConnections({
      organizationId: app.organizationId,
      appId: app.id,
      onlyWithToken: true,
    });
    for (const result of results) {
      if (result.status === "connected") {
        connectedShops += 1;
        console.log(
          `  CONNECTED ${result.shopDomain} — ${result.remoteShop.name}`,
        );
      } else {
        failedConnections += 1;
        console.log(
          `  FAILED ${result.shopDomain} — ${result.status.replaceAll("_", " ")}`,
        );
      }
    }
  }

  console.log(
    `\nAdmin API summary: ${connectedShops} connected, ${failedConnections} failed, ${appsAwaitingOAuth} app(s) awaiting merchant OAuth.`,
  );
  if (failedConnections > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(
      "Connection check could not run:",
      error instanceof Error ? error.message : "unknown error",
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
