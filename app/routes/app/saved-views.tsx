import { data } from "react-router";
import type { Route } from "./+types/saved-views";
import { requireCurrentOrganization } from "~/lib/current-org.server";
import {
  isSavedViewReport,
  SAVED_VIEW_NAME_MAX,
} from "~/lib/saved-views/saved-view-schemas";
import {
  createSavedView,
  deleteSavedView,
  renameSavedView,
} from "~/lib/saved-views/saved-views.server";

/** Create / rename / delete for every report's saved views. Posted to by the
 * shared `SavedViewsPicker` and `SaveViewButton` components. */
export async function action({ request }: Route.ActionArgs) {
  const org = await requireCurrentOrganization(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const fail = (error: string) => data({ error }, { status: 400 });

  const readName = (): { name: string } | { error: string } => {
    const name = String(form.get("name") ?? "").trim();
    if (!name) return { error: "Enter a short label." };
    if (name.length > SAVED_VIEW_NAME_MAX) {
      return { error: `Keep the label under ${SAVED_VIEW_NAME_MAX} characters.` };
    }
    return { name };
  };

  if (intent === "create") {
    const report = String(form.get("report") ?? "");
    if (!isSavedViewReport(report)) return fail("Unknown report.");
    const name = readName();
    if ("error" in name) return fail(name.error);
    let state: unknown;
    try {
      state = JSON.parse(String(form.get("state") ?? ""));
    } catch {
      return fail("These filters can't be saved.");
    }
    const result = await createSavedView(org.id, report, name.name, state);
    return result.ok ? { saved: result.view } : fail(result.error);
  }

  if (intent === "rename") {
    const id = String(form.get("id") ?? "");
    if (!id) return fail("Missing saved filter id.");
    const name = readName();
    if ("error" in name) return fail(name.error);
    return (await renameSavedView(org.id, id, name.name))
      ? { renamed: id }
      : fail("That saved filter no longer exists.");
  }

  if (intent === "delete") {
    const id = String(form.get("id") ?? "");
    if (!id) return fail("Missing saved filter id.");
    return (await deleteSavedView(org.id, id))
      ? { deleted: id }
      : fail("That saved filter no longer exists.");
  }

  return fail("Unknown intent.");
}
