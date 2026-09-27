/**
 * Adopt what Shopify calls each app, straight from the Partner API.
 *
 * The dashboard's app names are our own `App.name` rows, so they can silently
 * drift from the real listing — during a rebrand that drift is the whole
 * question.
 *
 * WHY THIS AND NOT A FIND-REPLACE. The first version of this rename rewrote
 * "Rapi" to "Rapid" with a regex, which is what the rebrand looked like from
 * the outside. Against the live listings it would have been wrong for three of
 * seven apps: `Rapi bundle dev` is actually `Rappi Dev` (two Ps, not "Rapid"),
 * and `Rapi Staging` and `Rapi Tracking` have not been renamed at all — the
 * regex would have invented "Rapid Staging" and "Rapid Tracking" and put our
 * dashboard at odds with Shopify. A rebrand is not a string transformation;
 * the listing is the source of truth, so this copies it rather than guessing.
 *
 * Re-runnable, and useful outside a rebrand: it catches any drift between our
 * label and the real app name.
 *
 *   npm run check:app-names            # report drift, write nothing
 *   APPLY=1 npm run check:app-names    # adopt Shopify's names
 */
import { prisma } from "../app/lib/db.server";
import { credentialsFromPartnerConnection } from "../app/lib/shopify/partner-connection.server";
import { partnerGraphqlWithCredentials } from "../app/lib/shopify/partner.server";

const apply = process.env.APPLY === "1";
console.log(`${apply ? "APPLYING" : "DRY RUN"}\n`);

const apps = await prisma.app.findMany({
  where: { removed: false },
  orderBy: { name: "asc" },
  select: {
    id: true, name: true, shopifyAppId: true,
    partnerConnection: {
      select: { partnerOrganizationId: true, encryptedAccessToken: true },
    },
  },
});

let renamed = 0;
console.log(`${"ours (App.name)".padEnd(26)} ${"Shopify says".padEnd(26)} status`);
for (const app of apps) {
  if (!app.partnerConnection || !app.shopifyAppId) {
    console.log(`${app.name.padEnd(26)} ${"—".padEnd(26)} no Partner connection`);
    continue;
  }
  try {
    const data = await partnerGraphqlWithCredentials<{
      app: { id: string; name: string } | null;
    }>(
      credentialsFromPartnerConnection(app.partnerConnection),
      /* GraphQL */ `query ($id: ID!) { app(id: $id) { id name } }`,
      { id: app.shopifyAppId },
    );
    const live = data.app?.name?.trim() || null;
    const status = live === null ? "not found" : live === app.name ? "match" : "DIFFERENT";
    console.log(`${app.name.padEnd(26)} ${(live ?? "—").padEnd(26)} ${status}`);
    if (apply && live && live !== app.name) {
      await prisma.app.update({ where: { id: app.id }, data: { name: live } });
      renamed++;
    }
  } catch (err) {
    console.log(`${app.name.padEnd(26)} ${"—".padEnd(26)} error: ${String(err).slice(0, 80)}`);
  }
}
console.log(
  `\n${renamed} app(s) renamed.` +
    (apply ? "" : " Re-run with APPLY=1 to adopt Shopify's names."),
);
/* `Organization.name` is deliberately NOT touched here: the Partner API
   describes apps, not our own brand, so there is nothing authoritative to copy
   and inventing a value is what this script exists to avoid. */
await prisma.$disconnect();
