import type { Route } from "./+types/app-events.export";
import { requireCurrentOrganization } from "~/lib/current-org.server";
import { prisma } from "~/lib/db.server";
import { DATE_RANGE_PRESETS } from "~/lib/date-range";
import { loadAppEventsForExport } from "~/lib/app-events/query.server";
import { EVENT_META, parseAppEventFilters } from "~/lib/app-events/types";

/** RFC 4180: quote a field only when it contains a comma, quote, or newline. */
function csvField(value: unknown): string {
  if (value == null) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

function csvRow(cells: unknown[]): string {
  return cells.map(csvField).join(",");
}

const COLUMNS = [
  "timestamp",
  "event_type",
  "category",
  "shop_domain",
  "plan_name",
  "amount",
  "currency",
  "reason",
  "metadata_json",
];

export async function loader({ request, params }: Route.LoaderArgs) {
  const org = await requireCurrentOrganization(request);
  const app = await prisma.app.findFirst({
    where: { id: params.appId, organizationId: org.id },
    select: { id: true, name: true },
  });
  if (!app) throw new Response("App not found", { status: 404 });

  const url = new URL(request.url);
  const filters = parseAppEventFilters(url.searchParams);
  if (!filters.from && !filters.to) {
    const preset = DATE_RANGE_PRESETS.find((p) => p.key === "last_30_days")!;
    const { start, end } = preset.range(new Date());
    filters.from = start.toISOString().slice(0, 10);
    filters.to = end.toISOString().slice(0, 10);
  }

  const events = await loadAppEventsForExport({
    appId: app.id,
    orgId: org.id,
    filters,
  });

  const lines = [csvRow(COLUMNS)];
  for (const event of events) {
    const typeLabel =
      event.type === "custom"
        ? event.customName || "custom"
        : (EVENT_META[event.type]?.label ?? event.type);
    lines.push(
      csvRow([
        event.occurredAt,
        typeLabel,
        event.category,
        event.shopDomain ?? "",
        event.planName ?? "",
        event.amount ?? "",
        event.currency ?? "",
        event.reason ?? "",
        event.metadata ? JSON.stringify(event.metadata) : "",
      ]),
    );
  }
  // Prepend a BOM so Excel opens UTF-8 correctly.
  const body = `﻿${lines.join("\r\n")}\r\n`;
  const stamp = filters.to ?? new Date().toISOString().slice(0, 10);
  const filename = `app-events-${app.id}-${stamp}.csv`;

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
