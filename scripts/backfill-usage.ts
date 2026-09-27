/**
 * Seed usage history so a cutover does not reset every merchant's meter to zero.
 *
 * Usage drives two things: what an app shows a merchant against their ceiling,
 * and whether the platform auto-upgrades them. Both read `usage_events`, and on
 * a fresh platform there are none — so on day one every merchant looks like they
 * have consumed nothing, and anyone already past their cap sails on until they
 * cross it a second time.
 *
 * Two input shapes, chosen by whether the CSV has a date column:
 *
 *   shopDomain,metric,quantity,occurredAt[,eventId]   -> EVENT REPLAY
 *   shopDomain,metric,quantity                        -> OPENING BALANCE
 *
 * **Event replay** writes one usage event per row at its own timestamp. Faithful,
 * and the only shape that survives a change of billing period boundary later.
 *
 * **An opening balance** writes ONE synthetic event per (shop, metric), dated at
 * the cutover, carrying the whole stated total. It is the honest fallback when
 * per-event history cannot be exported — and its cost is stated plainly: a
 * merchant asking "which orders made up this total?" has no answer here, and the figure is trusted
 * rather than verified.
 *
 * ## Two safety defaults, both deliberate
 *
 * **Dry run unless `--apply`.** Prints what it would write and, more usefully,
 * who would breach their ceiling.
 *
 * **Auto-upgrade OFF unless `--upgrade`.** Replaying history through the live
 * path would move every merchant already over their cap onto a pricier plan in
 * one unattended pass — each one a Shopify re-approval or a proration — before
 * anyone had checked the imported numbers. So the backfill records usage and
 * REPORTS the breaches; acting on them is a separate decision.
 *
 * Idempotent: re-running writes nothing new. An `eventId` column is used as the
 * idempotency key; without one, a deterministic key is derived per row, so a
 * repeated import cannot double a merchant's meter.
 *
 * Run:
 *   npm run backfill:usage -- --file ./usage.csv --app <appId>
 *   npm run backfill:usage -- --file ./usage.csv --app <appId> --apply
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { prisma } from "../app/lib/db.server";
import { parseCsvRows } from "../app/lib/csv";
import { ingestUsage } from "../app/lib/flex/auto-upgrade.server";
import { resolveUsageLimitForPlan } from "../app/lib/plans/features.server";
import { startOfMonth } from "../app/lib/flex/dates";
import { logJson, logJsonError } from "./lib/script-log";

const SCOPE = "backfill-usage";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const APPLY = process.argv.includes("--apply");
const UPGRADE = process.argv.includes("--upgrade");

interface Row {
  shopDomain: string;
  metric: string;
  quantity: number;
  occurredAt: Date | null;
  eventId: string | null;
  line: number;
}

/** Header names accepted for each field, so an export need not be renamed. */
const ALIASES: Record<string, string[]> = {
  shopDomain: ["shopdomain", "shop", "domain", "myshopifydomain", "customerid", "customer_id"],
  metric: ["metric", "eventname", "event_name", "event", "featurekey", "feature_key", "key"],
  quantity: ["quantity", "value", "amount", "total", "revenue"],
  occurredAt: ["occurredat", "occurred_at", "date", "createdat", "created_at", "timestamp"],
  eventId: ["eventid", "event_id", "id", "idempotencykey", "idempotency_key"],
};

function indexHeaders(headers: string[]): Record<string, number> {
  const normalized = headers.map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, ""));
  const found: Record<string, number> = {};
  for (const [field, names] of Object.entries(ALIASES)) {
    const at = normalized.findIndex((h) => names.includes(h));
    if (at >= 0) found[field] = at;
  }
  return found;
}

function parseRows(text: string): { rows: Row[]; replay: boolean; skipped: number } {
  const table = parseCsvRows(text);
  const headers = table[0];
  if (!headers) throw new Error("The file has no header row.");
  const at = indexHeaders(headers);
  for (const required of ["shopDomain", "metric", "quantity"]) {
    if (at[required] === undefined) {
      throw new Error(
        `No column found for ${required}. Accepted names: ${ALIASES[required]!.join(", ")}.`,
      );
    }
  }
  const replay = at.occurredAt !== undefined;

  const rows: Row[] = [];
  let skipped = 0;
  for (let i = 1; i < table.length; i++) {
    const cells = table[i]!;
    if (cells.every((c) => c.trim() === "")) continue;
    const shopDomain = (cells[at.shopDomain!] ?? "").trim().toLowerCase();
    const metric = (cells[at.metric!] ?? "").trim();
    const quantity = Number((cells[at.quantity!] ?? "").replace(/[^0-9.\-]/g, ""));
    if (!shopDomain || !metric || !Number.isFinite(quantity) || quantity <= 0) {
      // A zero or unparseable quantity is not usage. Counted, not guessed at.
      skipped += 1;
      continue;
    }
    const rawDate = replay ? (cells[at.occurredAt!] ?? "").trim() : "";
    const occurredAt = rawDate ? new Date(rawDate) : null;
    if (replay && (!occurredAt || Number.isNaN(occurredAt.getTime()))) {
      skipped += 1;
      continue;
    }
    rows.push({
      shopDomain,
      metric,
      quantity,
      occurredAt,
      eventId: at.eventId !== undefined ? (cells[at.eventId] ?? "").trim() || null : null,
      line: i + 1,
    });
  }
  return { rows, replay, skipped };
}

/**
 * A stable key for a row that carries no `eventId`.
 *
 * Derived from the fields that identify the usage, so a re-run produces the same
 * key and the unique index refuses the duplicate. Namespaced `backfill:` so it
 * can never collide with a live event's client-supplied id.
 */
function derivedKey(row: Row, cutover: Date): string {
  const stamp = (row.occurredAt ?? cutover).toISOString();
  const digest = createHash("sha256")
    .update(`${row.shopDomain}|${row.metric}|${stamp}|${row.quantity}`)
    .digest("hex")
    .slice(0, 32);
  return `backfill:${digest}`;
}

async function main(): Promise<void> {
  const file = arg("file");
  const appId = arg("app");
  if (!file) throw new Error("--file <path to the usage CSV> is required.");
  if (!appId) throw new Error("--app <appId> is required.");

  const app = await prisma.app.findUnique({
    where: { id: appId },
    select: { id: true, name: true },
  });
  if (!app) throw new Error(`No app ${appId}.`);

  const cutover = arg("cutover") ? new Date(arg("cutover")!) : new Date();
  if (Number.isNaN(cutover.getTime())) throw new Error("--cutover is not a date.");

  const { rows, replay, skipped } = parseRows(readFileSync(file, "utf8"));
  logJson(SCOPE, "input", {
    file,
    app: app.name,
    mode: replay ? "event replay" : "opening balance",
    rows: rows.length,
    skippedRows: skipped,
    ...(replay ? {} : { cutover: cutover.toISOString() }),
    note: replay
      ? "One usage event per row, at its own timestamp."
      : "ONE synthetic event per (shop, metric) at the cutover, carrying the stated total. Trusted, not verified — no per-order detail exists behind it.",
  });

  /* ------------------------------------------------- resolve shops to installs */
  const domains = [...new Set(rows.map((r) => r.shopDomain))];
  const installs = await prisma.appInstall.findMany({
    where: { appId: app.id, shopDomain: { in: domains } },
    select: { id: true, shopDomain: true },
  });
  const installByDomain = new Map(installs.map((i) => [i.shopDomain, i.id]));
  const unknown = domains.filter((d) => !installByDomain.has(d));
  if (unknown.length > 0) {
    logJsonError(SCOPE, "shops with no install on this app — their rows are skipped", {
      count: unknown.length,
      note: "Sync the installs first, or these merchants start at zero anyway.",
      sample: unknown.slice(0, 20),
    });
  }

  /* --------------------------------------------------------- collapse & totals */
  // For an opening balance the whole point is ONE event per (shop, metric), so
  // rows are summed here rather than written individually.
  const planned = new Map<string, { installId: string; domain: string; metric: string; quantity: number; occurredAt: Date; key: string }>();
  for (const row of rows) {
    const installId = installByDomain.get(row.shopDomain);
    if (!installId) continue;
    if (replay) {
      const key = row.eventId || derivedKey(row, cutover);
      planned.set(key, {
        installId,
        domain: row.shopDomain,
        metric: row.metric,
        quantity: row.quantity,
        occurredAt: row.occurredAt!,
        key,
      });
    } else {
      const groupKey = `${installId}|${row.metric}`;
      const existing = planned.get(groupKey);
      planned.set(groupKey, {
        installId,
        domain: row.shopDomain,
        metric: row.metric,
        quantity: (existing?.quantity ?? 0) + row.quantity,
        occurredAt: cutover,
        key: "",
      });
    }
  }
  if (!replay) {
    /*
      Keys derived AFTER summing, so a re-run with the rows in a different order
      produces the same key for the same total.

      Keyed on the cutover's DATE, not its instant — and that is the whole
      difference between idempotent and not. `--cutover` defaults to `new
      Date()`, so an instant-precision key changed on every run and a second
      `--apply` doubled every merchant's meter. Found exactly that way: a shop
      backfilled with 6,000.50 read 12,001.00 after the second run.

      Day precision means: a same-day re-run with the same numbers is a no-op; a
      same-day re-run with DIFFERENT numbers raises "idempotency key was already
      used for another usage event", which is the loud answer an operator wants
      rather than a silently ignored correction; and a genuine second balance on
      another day is a new event.
    */
    const cutoverDay = cutover.toISOString().slice(0, 10);
    for (const [groupKey, entry] of planned) {
      const digest = createHash("sha256")
        .update(`${entry.domain}|${entry.metric}|${cutoverDay}`)
        .digest("hex")
        .slice(0, 32);
      planned.set(groupKey, { ...entry, key: `backfill:opening:${digest}` });
    }
  }

  const events = [...planned.values()];
  logJson(SCOPE, APPLY ? "writing" : "would write", {
    events: events.length,
    shops: new Set(events.map((e) => e.domain)).size,
    byMetric: Object.fromEntries(
      [...events.reduce((m, e) => m.set(e.metric, (m.get(e.metric) ?? 0) + e.quantity), new Map<string, number>())],
    ),
  });

  let recorded = 0;
  let deduplicated = 0;
  if (APPLY) {
    for (const event of events) {
      try {
        const result = await ingestUsage({
          appInstallId: event.installId,
          metric: event.metric,
          quantity: event.quantity,
          occurredAt: event.occurredAt,
          idempotencyKey: event.key,
          // The safety default. See the note at the top of this file.
          triggerAutoUpgrade: UPGRADE,
        });
        if (result.recorded) recorded += 1;
        if (result.deduplicated) deduplicated += 1;
      } catch (error) {
        logJsonError(SCOPE, "row failed", {
          shopDomain: event.domain,
          metric: event.metric,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    logJson(SCOPE, "written", { recorded, deduplicated, autoUpgrade: UPGRADE });
  }

  /* ------------------------------------------------------ who breaches a cap? */
  /*
    The most useful thing this script prints. After a backfill a merchant may
    already be over the ceiling their plan states, and with `--upgrade` off
    nothing will move them — so say exactly who, and let a human decide.
  */
  const breaches: Array<Record<string, unknown>> = [];
  for (const domain of new Set(events.map((e) => e.domain))) {
    const installId = installByDomain.get(domain)!;
    const subscription = await prisma.subscription.findFirst({
      where: { appInstallId: installId, status: "ACTIVE" },
      orderBy: { activatedAt: "desc" },
      select: { currentPeriodStart: true, plan: true },
    });
    if (!subscription?.plan.limitMetric) continue;

    const ceiling = await resolveUsageLimitForPlan(subscription.plan);
    if (ceiling.limit === null) continue; // unlimited, or nothing stated

    const windowStart = subscription.currentPeriodStart ?? startOfMonth(new Date());
    const stored = await prisma.usageEvent.aggregate({
      where: {
        appInstallId: installId,
        metric: subscription.plan.limitMetric,
        occurredAt: { gte: windowStart },
      },
      _sum: { quantity: true },
    });
    const alreadyCounted = Number(stored._sum.quantity ?? 0);
    // In a dry run nothing is stored yet, so add what this run would add.
    const pending = APPLY
      ? 0
      : events
          .filter(
            (e) =>
              e.installId === installId &&
              e.metric === subscription.plan.limitMetric &&
              e.occurredAt >= windowStart,
          )
          .reduce((sum, e) => sum + e.quantity, 0);
    const total = alreadyCounted + pending;
    if (total > ceiling.limit) {
      breaches.push({
        shopDomain: domain,
        plan: subscription.plan.name,
        metric: subscription.plan.limitMetric,
        usage: total.toFixed(2),
        ceiling: ceiling.limit,
        ceilingFrom: ceiling.source,
        upgradesTo: subscription.plan.autoUpgradeToPlanId ? "configured" : "NOT CONFIGURED",
      });
    }
  }

  if (breaches.length > 0) {
    logJsonError(SCOPE, "merchants already over their ceiling after this backfill", {
      count: breaches.length,
      note: UPGRADE
        ? "--upgrade was passed, so these were moved as the usage landed."
        : "Nothing moved them: auto-upgrade is OFF for a backfill by design. Re-run with --upgrade to act, or move them by hand.",
      rows: breaches.slice(0, 50),
    });
  } else {
    logJson(SCOPE, "no merchant is over their ceiling after this backfill");
  }

  if (!APPLY) {
    logJson(SCOPE, "dry run — nothing written", {
      note: "Re-run with --apply to write, and add --upgrade only if you want plan changes to happen as the usage lands.",
    });
  }

  await prisma.$disconnect();
  process.exit(0);
}

main().catch(async (error) => {
  logJsonError(SCOPE, "backfill failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  await prisma.$disconnect();
  process.exit(1);
});
