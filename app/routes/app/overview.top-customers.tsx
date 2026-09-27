import type { Route } from "./+types/overview.top-customers";
import { prisma } from "~/lib/db.server";
import { requireCurrentOrganization } from "~/lib/current-org.server";
import { requireUser } from "~/lib/auth/session.server";
import {
  getTopCustomers,
  type TopCustomerStatus,
} from "~/lib/reports/top-customers.server";
import { getRecentInstalls } from "~/lib/reports/recent-installs.server";

/**
 * Filter endpoint for the Overview's per-card pickers — loader only.
 *
 * Serves both Top customers and Recent installs: they take the same app
 * filter and are read together, so one round trip beats two.
 *
 * A resource route rather than URL search params, because the Overview's
 * period and app pickers are client state driving client-side metric fetches:
 * a loader navigation would re-render the page and throw all of that away to
 * change one dropdown.
 */
export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const org = await requireCurrentOrganization(request);
  const url = new URL(request.url);

  const requestedStatus = url.searchParams.get("status");
  const status: TopCustomerStatus =
    requestedStatus === "churned" || requestedStatus === "all"
      ? requestedStatus
      : "active";
  const requestedAppId = (url.searchParams.get("appId") ?? "").trim();

  const apps = await prisma.app.findMany({
    where: {
      organizationId: org.id,
      removed: false,
      scheduledForDeletionAt: null,
      ...(requestedAppId ? { id: requestedAppId } : {}),
    },
    select: { id: true },
  });

  /* Each card asks for its own slice: the two have independent app pickers,
     so computing both on every call would do double the work to answer half
     the question. */
  const cards = url.searchParams.get("cards");
  const wantCustomers = cards !== "installs";
  const wantInstalls = cards !== "customers";

  const appIds = apps.map((app) => app.id);
  const [customers, installs] = await Promise.all([
    wantCustomers ? getTopCustomers({ appIds, status }) : null,
    wantInstalls ? getRecentInstalls({ appIds }) : null,
  ]);

  return { status, appId: requestedAppId, customers, installs };
}
