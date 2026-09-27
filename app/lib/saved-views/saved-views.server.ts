import { prisma } from "~/lib/db.server";
import { logger } from "~/lib/logger.server";
import {
  SAVED_VIEW_SCHEMAS,
  type SavedView,
  type SavedViewReport,
  type SavedViewState,
} from "./saved-view-schemas";

/**
 * Saved report views ("Saved filters"), shared by every report that offers
 * them. Org-wide, not per user — the whole team sees and edits the same list,
 * as Mantle does. Each report's settings are validated by its schema in
 * saved-view-schemas.ts, on the way in and on the way out.
 */

const log = logger.scope("saved-views");

/** A report's saved views, oldest first (the order the list has always had).
 * A row whose state no longer parses is left out and logged, rather than
 * breaking the page that lists it. */
export async function listSavedViews<R extends SavedViewReport>(
  organizationId: string,
  report: R,
): Promise<Array<SavedView<SavedViewState<R>>>> {
  const rows = await prisma.savedReportView.findMany({
    where: { organizationId, report },
    orderBy: { createdAt: "asc" },
  });
  const schema = SAVED_VIEW_SCHEMAS[report];
  return rows.flatMap((row) => {
    const parsed = schema.safeParse(row.state);
    if (!parsed.success) {
      log.warn("skipping saved view with unreadable state", {
        id: row.id,
        report,
      });
      return [];
    }
    return [
      { id: row.id, name: row.name, state: parsed.data as SavedViewState<R> },
    ];
  });
}

export type SavedViewWriteResult<R extends SavedViewReport> =
  | { ok: true; view: SavedView<SavedViewState<R>> }
  | { ok: false; error: string };

export async function createSavedView<R extends SavedViewReport>(
  organizationId: string,
  report: R,
  name: string,
  state: unknown,
): Promise<SavedViewWriteResult<R>> {
  const parsed = SAVED_VIEW_SCHEMAS[report].safeParse(state);
  if (!parsed.success) {
    return { ok: false, error: "These filters can't be saved." };
  }
  const row = await prisma.savedReportView.create({
    data: { organizationId, report, name, state: parsed.data },
  });
  return {
    ok: true,
    view: { id: row.id, name: row.name, state: parsed.data as SavedViewState<R> },
  };
}

/** Renames only: a saved view keeps the settings it was saved with, even when
 * renamed from a page showing different ones. Returns false when no view
 * with that id belongs to the organization. */
export async function renameSavedView(
  organizationId: string,
  id: string,
  name: string,
): Promise<boolean> {
  const { count } = await prisma.savedReportView.updateMany({
    where: { id, organizationId },
    data: { name },
  });
  return count === 1;
}

export async function deleteSavedView(
  organizationId: string,
  id: string,
): Promise<boolean> {
  const { count } = await prisma.savedReportView.deleteMany({
    where: { id, organizationId },
  });
  return count === 1;
}
