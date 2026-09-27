/**
 * Re-derive `reasonCode`/`reasonCodes`/`isStoreClosure` on stored uninstalls.
 *
 * These three columns are computed once, at ingest, and saved — so correcting
 * `normalizeUninstallReason` only changes how FUTURE uninstalls are
 * classified. Rows already in the table keep whatever the old rules decided,
 * which for the large majority of uninstalls was `unknown_other`.
 *
 * Nothing here invents data. The merchant's answer is stored verbatim in
 * `reason`/`description` and is never touched; this only re-runs the current
 * rules over it, so the script is idempotent and safe to re-run.
 *
 *   npm run backfill:uninstall-reasons              # dry run, writes nothing
 *   APPLY=1 npm run backfill:uninstall-reasons      # write the changes
 *   APP="My App" APPLY=1 npm run backfill:uninstall-reasons
 */
import { prisma } from "../app/lib/db.server";
import { normalizeUninstallReason } from "../app/lib/customer-events/uninstall-reason";

const apply = process.env.APPLY === "1";
const appName = process.env.APP?.trim();
const BATCH = 1000;

const where = appName
  ? { event: { appInstall: { app: { name: appName } } } }
  : {};

const total = await prisma.uninstallEventDetail.count({ where });
console.log(
  `${apply ? "APPLYING" : "DRY RUN"} over ${total.toLocaleString()} rows` +
    `${appName ? ` for ${appName}` : ""}\n`,
);

let seen = 0;
let changed = 0;
let cursor: string | null = null;

interface DetailRow {
  id: string;
  reason: string | null;
  description: string | null;
  reasonCode: string;
  isStoreClosure: boolean;
}
const movedFrom = new Map<string, number>();
const movedTo = new Map<string, number>();

for (;;) {
  const rows: DetailRow[] = await prisma.uninstallEventDetail.findMany({
    where,
    take: BATCH,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    orderBy: { id: "asc" },
    select: {
      id: true,
      reason: true,
      description: true,
      reasonCode: true,
      isStoreClosure: true,
    },
  });
  if (rows.length === 0) break;
  cursor = rows[rows.length - 1]!.id;
  seen += rows.length;

  const updates: Array<{ id: string; next: ReturnType<typeof normalizeUninstallReason> }> = [];
  for (const row of rows) {
    const next = normalizeUninstallReason(row.reason, row.description);
    if (next.reasonCode === row.reasonCode && next.isStoreClosure === row.isStoreClosure) {
      continue;
    }
    changed++;
    movedFrom.set(row.reasonCode, (movedFrom.get(row.reasonCode) ?? 0) + 1);
    movedTo.set(next.reasonCode, (movedTo.get(next.reasonCode) ?? 0) + 1);
    updates.push({ id: row.id, next });
  }

  if (apply && updates.length > 0) {
    /* One transaction per batch rather than per row: 54k round trips is the
       difference between a minute and an hour, and a batch that fails should
       not leave half of itself applied. */
    await prisma.$transaction(
      updates.map(({ id, next }) =>
        prisma.uninstallEventDetail.update({
          where: { id },
          data: {
            reasonCode: next.reasonCode,
            reasonCodes: next.reasonCodes,
            isStoreClosure: next.isStoreClosure,
          },
        }),
      ),
    );
  }
  if (seen % 10000 === 0) console.log(`  ...${seen.toLocaleString()} / ${total.toLocaleString()}`);
}

console.log(
  `\n${changed.toLocaleString()} of ${seen.toLocaleString()} rows ` +
    `${apply ? "updated" : "would change"} (${((changed / Math.max(1, seen)) * 100).toFixed(1)}%)\n`,
);
console.log("out of:");
for (const [code, n] of [...movedFrom.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  ${code.padEnd(34)} ${n.toLocaleString()}`);
}
console.log("\ninto:");
for (const [code, n] of [...movedTo.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log(`  ${code.padEnd(34)} ${n.toLocaleString()}`);
}
if (!apply) console.log("\nNothing was written. Re-run with APPLY=1 to write.");
await prisma.$disconnect();
