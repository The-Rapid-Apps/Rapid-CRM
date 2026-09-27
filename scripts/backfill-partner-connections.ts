import { encryptCredential } from "../app/lib/credential-encryption.server";
import { prisma } from "../app/lib/db.server";
import {
  credentialsFromPartnerConnection,
  partnerTokenLastFour,
} from "../app/lib/shopify/partner-connection.server";

async function main() {
  const legacyApps = await prisma.app.findMany({
    where: {
      partnerConnectionId: null,
      partnerApiToken: { not: null },
      partnerOrganizationId: { not: null },
    },
    orderBy: { createdAt: "asc" },
  });

  let connectionsCreated = 0;
  let appsAttached = 0;

  for (const app of legacyApps) {
    if (!app.partnerApiToken || !app.partnerOrganizationId) continue;

    const existing = await prisma.shopifyPartnerConnection.findUnique({
      where: {
        organizationId_partnerOrganizationId: {
          organizationId: app.organizationId,
          partnerOrganizationId: app.partnerOrganizationId,
        },
      },
    });
    if (
      existing &&
      credentialsFromPartnerConnection(existing).partnerApiToken !==
        app.partnerApiToken
    ) {
      throw new Error(
        `Conflicting legacy Partner tokens for organization ${app.organizationId} and Partner organization ${app.partnerOrganizationId}`,
      );
    }
    const connection =
      existing ??
      (await prisma.shopifyPartnerConnection.create({
        data: {
          organizationId: app.organizationId,
          name: `Shopify Partner ${app.partnerOrganizationId}`,
          partnerOrganizationId: app.partnerOrganizationId,
          encryptedAccessToken: encryptCredential(app.partnerApiToken),
          tokenLastFour: partnerTokenLastFour(app.partnerApiToken),
        },
      }));
    if (!existing) connectionsCreated += 1;

    await prisma.app.update({
      where: { id: app.id },
      data: {
        partnerConnectionId: connection.id,
        // Remove the old plaintext copy after the encrypted relation exists.
        partnerApiToken: null,
        partnerOrganizationId: null,
      },
    });
    appsAttached += 1;
  }

  console.log(JSON.stringify({ connectionsCreated, appsAttached }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
