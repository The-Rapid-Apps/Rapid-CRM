import { prisma } from "../app/lib/db.server";
import { connectDiscoveredPartnerApps } from "../app/lib/shopify/partner-app-discovery.server";

async function main() {
  const connections = await prisma.shopifyPartnerConnection.findMany({
    orderBy: { createdAt: "asc" },
  });
  const results = [];
  for (const connection of connections) {
    const result = await connectDiscoveredPartnerApps(
      connection.organizationId,
      connection.id,
    );
    results.push({
      partnerOrganizationId: connection.partnerOrganizationId,
      ...result,
    });
  }
  console.log(JSON.stringify(results, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
