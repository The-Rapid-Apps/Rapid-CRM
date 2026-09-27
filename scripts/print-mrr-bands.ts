/**
 * The MRR bands as the reports compute them, right now, on one line each.
 *
 * A measuring stick, not a feature. Any change to `contributionAt` moves revenue,
 * and the bands are COUPLED: reclassifying a charge out of `trial` makes it
 * `monthly` rather than making it disappear, so a change that improves one band by
 * moving money into another is not an improvement. This prints all of them together
 * so that is visible in one glance instead of inferred from two screenshots.
 *
 * Reads through `loadPartnerFacts`, the same loader the reports use, so offer
 * cadence pins and persisted live-discount checks are applied exactly as they are
 * in the UI — replicating those two queries here instead would let the diagnostic
 * and the thing being diagnosed drift apart.
 *
 * Writes nothing. Run before and after, and diff.
 *
 *   npm run report:mrr-bands
 */
import "dotenv/config";
import {
  contributionMapAt,
  loadPartnerFacts,
  round,
} from "../app/lib/shopify/partner-mrr.server";
import { prisma } from "../app/lib/db.server";
import { logJson } from "./lib/script-log";

async function main(): Promise<void> {
  const at = new Date();
  const apps = await prisma.app.findMany({
    where: { enabled: true },
    select: { id: true, name: true },
  });
  const { histories } = await loadPartnerFacts(
    apps.map((app) => app.id),
    at,
  );
  const contributions = [...contributionMapAt(histories, at).values()];

  const byCurrency = new Map<string, typeof contributions>();
  for (const contribution of contributions) {
    byCurrency.set(contribution.currency, [
      ...(byCurrency.get(contribution.currency) ?? []),
      contribution,
    ]);
  }

  for (const [currency, rows] of byCurrency) {
    const band = (kind: "monthly" | "annual" | "trial") =>
      round(
        rows
          .filter((row) => row.kind === kind)
          .reduce((sum, row) => sum + row.amount, 0),
      );
    const monthly = band("monthly");
    const annual = band("annual");
    const trial = band("trial");
    const count = (kind: "monthly" | "annual" | "trial") =>
      rows.filter((row) => row.kind === kind).length;
    logJson("mrr-bands", currency, {
      at: at.toISOString(),
      apps: apps.length,
      monthly,
      annual,
      trial,
      // What the UI shows with trials off and on. The pair that has to be read
      // together: a change that lowers `mrrWithTrials` by raising `mrr` is not a fix.
      mrr: round(monthly + annual),
      mrrWithTrials: round(monthly + annual + trial),
      charges: {
        monthly: count("monthly"),
        annual: count("annual"),
        trial: count("trial"),
      },
    });
  }

  await prisma.$disconnect();
  /*
    The reconstruction reaches Redis through `cachedWithRedis`, and that client
    keeps the event loop alive after the work is done — the run finishes in about
    seven seconds and then sits there. `npm test` solves this with
    `tests/redis-teardown.ts`; a one-off script has no such hook, so it leaves
    deliberately. Nothing is queued at this point: the only write was to stdout.
  */
  process.exit(0);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
