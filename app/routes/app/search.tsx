import type { Route } from "./+types/search";
import { prisma } from "~/lib/db.server";
import { requireCurrentOrganization } from "~/lib/current-org.server";
import { requireUser } from "~/lib/auth/session.server";
import { cachedWithRedis } from "~/lib/cache/redis-cache.server";
import { globalSearch } from "~/lib/search/global-search.server";

/**
 * Resource route behind the top bar's search box — no component, loader only.
 *
 * Sits under /app so `app/layout.tsx`'s guard applies, and calls
 * `requireUser` itself because a resource route renders outside that layout
 * and would otherwise be reachable unauthenticated.
 */

/** Long enough that a burst of keystrokes shares one result, short enough
 * that a merchant's data never looks stale in a search box. */
const SEARCH_CACHE_TTL_MS = 30_000;

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const org = await requireCurrentOrganization(request);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 255);
  if (!q) return { q, groups: [] };

  const apps = await prisma.app.findMany({
    where: {
      organizationId: org.id,
      removed: false,
      scheduledForDeletionAt: null,
    },
    select: { id: true },
  });

  const groups = await cachedWithRedis(
    `global-search:${org.id}␟${q}`,
    SEARCH_CACHE_TTL_MS,
    () =>
      globalSearch({
        q,
        organizationId: org.id,
        appIds: apps.map((app) => app.id),
      }),
  );

  return { q, groups };
}
