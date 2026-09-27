import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActionList,
  Card,
  Frame,
  Navigation,
  Text,
  TopBar,
} from "@shopify/polaris";
import {
  AppsIcon,
  CashDollarIcon,
  ToggleOnIcon,
  ChartLineIcon,
  ClockIcon,
  StarIcon,
  CodeIcon,
  ConnectIcon,
  CreditCardIcon,
  DesktopIcon,
  DiscountIcon,
  HomeIcon,
  MoonIcon,
  PersonExitIcon,
  PersonIcon,
  ProfileIcon,
  SettingsIcon,
  SunIcon,
} from "@shopify/polaris-icons";
import {
  Link,
  Outlet,
  useFetcher,
  useLocation,
  useNavigate,
  useNavigation,
  useRevalidator,
} from "react-router";
import type { Route } from "./+types/layout";
import type { SearchGroup } from "~/lib/search/global-search.server";
import { requireUser } from "~/lib/auth/session.server";
import { prisma } from "~/lib/db.server";
import { appMonogramDataUri } from "~/components/app-identity";
import { PAGE_CONTENT_ANCHOR_ID } from "~/lib/page-content-anchor";
import { useTheme, type ThemePreference } from "~/lib/theme";

/** Dashboard is gated behind email+password login — see app/lib/auth/. */
export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  // Every page in the shell offers the app switcher, so the list is loaded
  // once here rather than in each route's own loader.
  /* Every app is loaded, but only the published ones are OFFERED.
     A dev or staging copy is a real row with real installs — it is just not
     what anyone means when they switch app, and listing it turns the switcher
     into a place to misclick. It still has to be RECOGNISED though: following
     a `?appId=` link to a staging app must keep its context open, rather than
     filtering the page while the sidebar claims no app is selected. */
  /* Detail pages own no app in their URL — `/app/plans/<planId>` says nothing
     about which app it belongs to — so opening one from inside an app used to
     fold that app's navigation away mid-task.
     Resolved here rather than by appending `?appId=` to every link that
     reaches a detail page: those links are spread across list pages, cells and
     back-actions, and one missed call site is an invisible regression. This
     cannot be forgotten, and a new detail route costs one entry below.
     Only runs when the URL carries no app already, and each lookup is a single
     keyed read. */
  const detailAppId = await resolveDetailAppId(new URL(request.url).pathname);

  const allApps = await prisma.app.findMany({
    where: { organizationId: user.organizationId, removed: false },
    orderBy: { name: "asc" },
    select: { id: true, name: true, logoUrl: true, isProduction: true },
  });
  return {
    user: { name: user.name, email: user.email, role: user.role },
    apps: allApps,
    detailAppId,
  };
}

/**
 * The app a detail page belongs to, or "" when the path is not one.
 *
 * Deliberately does NOT cover `/app/customers/:shopDomain`: a shop can have
 * several of our apps installed, so its detail page is genuinely ambiguous —
 * which is why that route already carries its own `?app=` parameter, read
 * below as a fallback.
 */
async function resolveDetailAppId(pathname: string): Promise<string> {
  const plan = pathname.match(/^\/app\/plans\/([^/]+)$/)?.[1];
  if (plan && plan !== "new") {
    const row = await prisma.plan.findUnique({
      where: { id: plan },
      select: { appId: true },
    });
    return row?.appId ?? "";
  }

  const subscription = pathname.match(/^\/app\/subscriptions\/([^/]+)$/)?.[1];
  if (subscription) {
    // Subscription carries no appId of its own; it reaches one through its plan.
    const row = await prisma.subscription.findUnique({
      where: { id: subscription },
      select: { plan: { select: { appId: true } } },
    });
    return row?.plan.appId ?? "";
  }

  return "";
}

/**
 * Applies to every route nested under this layout (Reports, Customers, Apps,
 * Connections, Subscriptions, Plans, Discounts, ...) — same
 * header `billing.tsx` already sets for the same reason.
 *
 * Every sidebar item and every Reports tab renders as a real `<a href>`
 * (Polaris Navigation/Tabs -> UnstyledLink -> the app's own PolarisLink ->
 * React Router's Link — see root.tsx). React Router's own Link prefetching
 * is off by default and never enabled anywhere in this app, but Chrome's
 * built-in "Preload pages for faster browsing" (on by default for most
 * users) walks exactly this shape of link and silently prerenders each one
 * in the background — found in production, 2026-08-19: opening one Reports
 * tab was firing the SAME /api/metrics/:metric fetch 3-4 times (once for the
 * visible tab, once per background-preloaded sibling tab sharing the same
 * metric), each landing on whichever of the 2 web workers picked it up and
 * competing with the others instead of sharing one cache write — a
 * self-inflicted stampede, not a caching bug. `Cache-Control: no-store` is
 * the standard signal browsers respect to exclude a page from prefetch/
 * prerender candidacy; it does not disable normal navigation or this app's
 * own client-side fetches, only unsolicited speculative ones.
 */
export function headers() {
  return {
    "Cache-Control": "private, no-store",
  };
}

/**
 * The organization-wide sidebar, unchanged from before app scoping existed.
 *
 * These are the CROSS-APP views: /app/customers with no `appId` is every app's
 * customers. Selecting an app does not replace them — it adds that app's own
 * pages underneath (see `APP_SCOPED_ITEMS`), which is how "All apps" survives
 * alongside Mantle's per-app navigation.
 */
const NAVIGATION_GROUPS = [
  {
    title: "Workspace",
    items: [
      {
        url: "/app",
        label: "Overview",
        icon: HomeIcon,
        keywords: "home portfolio health",
        matches: (path: string) => path === "/app",
      },
      {
        url: "/app/customers",
        label: "Customers",
        icon: PersonIcon,
        keywords: "merchants shops profiles ltv mrr billing history",
        matches: (path: string) => path.startsWith("/app/customers"),
      },
      {
        url: "/app/apps",
        label: "Manage apps",
        icon: AppsIcon,
        /* Named for the job, not the noun. The section further down is also
           headed "Apps" — that one switches which app you are working in,
           this one is where apps are added and configured. Two identical
           labels doing different things is a coin toss for the reader. */
        keywords: "shopify products integrations add configure settings keys",
        matches: (path: string) => path.startsWith("/app/apps"),
      },
      {
        url: "/app/connections",
        label: "Connections",
        icon: ConnectIcon,
        keywords: "partner oauth credentials",
        matches: (path: string) => path.startsWith("/app/connections"),
      },
      {
        url: "/app/team",
        label: "Team",
        icon: PersonIcon,
        keywords: "users invite access admin permissions people",
        matches: (path: string) => path.startsWith("/app/team"),
        /* Hidden from MEMBERs here and in the command palette. This is
           presentation only — `requireAdmin` in the route's own loader and
           action is what actually enforces it. */
        adminOnly: true,
      },
    ],
  },
  {
    title: "Billing operations",
    items: [
      {
        url: "/app/subscriptions",
        label: "Subscriptions",
        icon: CreditCardIcon,
        keywords: "customers merchants charges billing",
        matches: (path: string) => path.startsWith("/app/subscriptions"),
      },
      {
        url: "/app/plans",
        label: "Plans",
        icon: CashDollarIcon,
        keywords: "pricing tiers products",
        matches: (path: string) => path.startsWith("/app/plans"),
      },
      {
        url: "/app/plan-features",
        label: "Features",
        icon: ToggleOnIcon,
        keywords: "entitlements limits gating revenue cap feature flags",
        matches: (path: string) => path.startsWith("/app/plan-features"),
      },
      {
        url: "/app/discounts",
        label: "Discounts",
        icon: DiscountIcon,
        keywords: "codes promotions offers",
        matches: (path: string) => path.startsWith("/app/discounts"),
      },
    ],
  },
  {
    title: "Intelligence",
    items: [
      {
        url: "/app/reports",
        label: "Reports",
        icon: ChartLineIcon,
        keywords: "mrr arr ltv churn retention revenue analytics",
        matches: (path: string) => path.startsWith("/app/reports"),
      },
      {
        url: "/app/events",
        label: "Activity",
        icon: ClockIcon,
        keywords: "events audit trail history lifecycle",
        matches: (path: string) => path.startsWith("/app/events"),
      },
      {
        url: "/app/reviews",
        label: "Reviews",
        icon: StarIcon,
        keywords: "reviews ratings app store stars feedback",
        matches: (path: string) => path.startsWith("/app/reviews"),
      },
      {
        url: "/app/api-logs",
        label: "API logs",
        icon: CodeIcon,
        keywords: "developer requests http status payload response live stream",
        matches: (path: string) => path.startsWith("/app/api-logs"),
      },
    ],
  },
] as const;

/**
 * One app's own pages, in the order Mantle lists them — but under OUR names.
 *
 * These briefly used Mantle's labels (Transactions, App events, Usage metrics,
 * API) and it was wrong twice over. Every one of these pages titles itself
 * with the name below, so the sidebar contradicted the page header one click
 * later. And the mapping itself was off: Mantle's app dashboard reports
 * "Subscriptions" as its own figure, so its "Transactions" is a payments view,
 * not the subscription list this route shows.
 *
 * Adopting Mantle's vocabulary is still open, but it is a rename of the PAGES
 * and the navigation together — not of the menu alone.
 *
 * These exist ONLY nested under a selected app — never at the top level, and
 * never when no app is chosen. That is the distinction the sidebar is drawing:
 * the groups above are cross-app views, these are one app's.
 *
 * Polaris renders sub-navigation as text without icons (`SubNavigationItem`
 * has no `icon` field), so unlike Mantle's these are label-only.
 *
 * NOT every page here filters by app yet — Plans and Discounts
 * currently ignore `appId` and will show org-wide data under an app heading
 * until that is fixed. Listed now so the structure is right and the gap is
 * visible rather than hidden.
 */
const APP_SCOPED_ITEMS = [
  { url: "/app/customers", label: "Customers" },
  { url: "/app/plans", label: "Plans" },
  { url: "/app/plan-features", label: "Features" },
  { url: "/app/subscriptions", label: "Subscriptions" },
  { url: "/app/reports", label: "Reports" },
  { url: "/app/events", label: "Activity" },
  { url: "/app/reviews", label: "Reviews" },
  { url: "/app/discounts", label: "Discounts" },
  { url: "/app/api-logs", label: "API logs" },
  /* The only one addressed by path rather than `?appId=` — `/app/apps/:appId`
     already exists as the app's own settings page. `byPath` keeps that
     difference in the data instead of hard-coding a label check at the call
     site. */
  { url: "/app/apps", label: "App settings", byPath: true },
] as const;

/**
 * An app's sidebar icon.
 *
 * Polaris's `IconSource` also accepts a string, but NOT a URL: it wraps
 * whatever you give it in `data:image/svg+xml;utf8,`, so a logo URL came out
 * as `src="data:image/svg+xml;utf8,https://cdn.shopify.com/..."` and rendered
 * nothing. A component source is handed straight to React, so it can return an
 * `<img>` and show the real artwork — which an SVG-in-`img` could never do,
 * since that context cannot load external references.
 *
 * Memoized per app by the caller: an inline component identity would change
 * every render and remount the image, flickering the whole sidebar.
 */
function appIconComponent(app: { name: string; logoUrl: string | null }) {
  const src = app.logoUrl ?? appMonogramDataUri(app.name);
  function AppNavIcon() {
    return <img src={src} alt="" />;
  }
  return AppNavIcon;
}

/** Routes that appear twice in the sidebar: once at the top as the cross-app
 * view, and again nested under whichever app is selected. Used to decide which
 * of the two should light up — see `selected` in the render. */
const APP_SCOPED_URLS = new Set<string>(APP_SCOPED_ITEMS.map((item) => item.url));

/** Adds the selected app to an app-scoped link. */
function withApp(url: string, appId: string): string {
  return `${url}?appId=${encodeURIComponent(appId)}`;
}

/** Nav entries a MEMBER must not see. Derived from the groups themselves, so
 * marking a page `adminOnly` hides it from the sidebar AND the command palette
 * without having to remember the second list. */
const ADMIN_ONLY_URLS = new Set<string>(
  NAVIGATION_GROUPS.flatMap((group) =>
    group.items
      .filter((item) => "adminOnly" in item && item.adminOnly)
      .map((item) => item.url),
  ),
);

function canSee(url: string, role: string): boolean {
  return role === "ADMIN" || !ADMIN_ONLY_URLS.has(url);
}

const COMMANDS = [
  ...NAVIGATION_GROUPS.flatMap((group) =>
    group.items.map((item) => ({ ...item, group: group.title })),
  ),
  {
    url: "/app/account",
    label: "Account settings",
    icon: SettingsIcon,
    keywords: "profile password security",
    group: "Account",
    matches: (path: string) => path.startsWith("/app/account"),
  },
];

/**
 * Management dashboard shell. Polaris Frame + Navigation; the nav links do
 * client-side navigation via the linkComponent wired in root.tsx.
 */
export default function AppLayout({ loaderData }: Route.ComponentProps) {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const { revalidate } = useRevalidator();
  const { user, apps, detailAppId } = loaderData;
  /* The URL owns the selection: paste a link and the sidebar reflects it, and
     the browser's Back button moves between apps like any other navigation. An
     id that no longer matches a live app reads as "All apps" rather than
     rendering a context that does not exist. */
  /* Two ways an app can be current, because two URL shapes address one:
     `?appId=` for the filtered pages, and `/app/apps/:appId` for that app's
     own settings page. Reading only the query parameter meant opening App
     settings collapsed the very app you were inside — the sidebar decided no
     app was selected and folded its pages away. */
  const pathAppId = pathname.match(/^\/app\/apps\/([^/]+)/)?.[1] ?? "";
  const params = new URLSearchParams(search);
  const requestedAppId =
    params.get("appId")?.trim() ||
    /* Customer detail predates this navigation and uses `app`. Honoured rather
       than renamed, so existing links and bookmarks keep their context. */
    params.get("app")?.trim() ||
    pathAppId ||
    detailAppId;
  const appId = apps.some((app) => app.id === requestedAppId)
    ? requestedAppId
    : "";
  /* Published apps, plus the one you are in even if it is not published — so
     arriving at a staging app by link shows it selected rather than dropping
     it out of the list it is supposed to be highlighted in. */
  const switcherApps = useMemo(
    () => apps.filter((app) => app.isProduction || app.id === appId),
    [apps, appId],
  );

  const appIcons = useMemo(
    () => new Map(apps.map((app) => [app.id, appIconComponent(app)])),
    [apps],
  );
  const [userMenuActive, setUserMenuActive] = useState(false);
  const [themeMenuActive, setThemeMenuActive] = useState(false);
  const [mobileNavigationActive, setMobileNavigationActive] = useState(false);
  const [searchActive, setSearchActive] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  /* Which result group the chips have isolated; null shows every group.
     Local state, not the URL — it changes nothing that is fetched. */
  const [searchGroupKey, setSearchGroupKey] = useState<string | null>(null);
  const skipToContentRef = useRef<HTMLAnchorElement>(null!);
  const previousPathname = useRef(pathname);
  const previousLocationKey = useRef(`${pathname}${search}`);
  const { preference, resolvedTheme, setPreference } = useTheme();
  const routePending = navigation.state !== "idle";

  const currentPage =
    COMMANDS.find((command) => command.matches(pathname))?.label ?? "Workspace";

  useEffect(() => {
    setMobileNavigationActive(false);
    setSearchActive(false);
    setSearchQuery("");

    if (previousPathname.current !== pathname) {
      skipToContentRef.current?.focus({ preventScroll: true });
      previousPathname.current = pathname;
    }
  }, [pathname]);

  // Land on each page's actual content instead of resetting to the window's
  // absolute top — which, for pages with their own title/tab-bar chrome
  // (Reports' sub-tabs, Overview's hero), meant re-scrolling past the same
  // chrome after every navigation just to see the data again. Keyed on
  // pathname+search (not just pathname) so switching Reports tabs — a
  // search-param-only change on the same route — triggers this too. Skips
  // on first mount so a fresh load / deep link isn't forced to move.
  useEffect(() => {
    const key = `${pathname}${search}`;
    if (previousLocationKey.current === key) return;
    previousLocationKey.current = key;
    const anchor = document.getElementById(PAGE_CONTENT_ANCHOR_ID);
    if (anchor) {
      anchor.scrollIntoView({ block: "start" });
    } else {
      window.scrollTo(0, 0);
    }
  }, [pathname, search]);

  useEffect(() => {
    let cancelled = false;
    let running = false;
    let lastAttemptAt = 0;

    // Render every route from local immutable facts first, then verify the
    // newest Shopify window in the background. Partial windows resume for a
    // few bounded rounds instead of making navigation wait on a full history.
    const synchronize = async () => {
      if (cancelled || running) return;
      running = true;
      lastAttemptAt = Date.now();
      let latestBody: {
        fresh?: boolean;
        inProgress?: boolean;
        dataChanged?: boolean;
      } | null = null;
      // A round that writes nothing must not erase a write an earlier round in
      // this same pass already made, so accumulate rather than take the last.
      let dataChanged = false;
      try {
        for (let round = 0; round < 3 && !cancelled; round += 1) {
          const response = await fetch("/api/metrics-sync", {
            method: "POST",
            cache: "no-store",
            headers: { Accept: "application/json" },
          });
          const body = (await response.json()) as {
            fresh?: boolean;
            inProgress?: boolean;
            dataChanged?: boolean;
            error?: string;
          };
          latestBody = body;
          dataChanged ||= body.dataChanged === true;
          if (!response.ok && response.status !== 202) break;
          // A non-202 response is terminal for this bounded pass. In
          // particular, a server-reported fresh result must never fall through
          // into another Shopify round.
          if (body.fresh === true || response.status !== 202) break;
          if (round < 2) {
            const retryAfterSeconds = Number(
              response.headers.get("Retry-After") ??
                (body.inProgress ? "5" : "2"),
            );
            const retryAfterMs = Number.isFinite(retryAfterSeconds)
              ? Math.max(1, retryAfterSeconds) * 1_000
              : 2_000;
            await new Promise((resolve) =>
              window.setTimeout(resolve, retryAfterMs),
            );
          }
        }
      } catch {
        // Existing local facts stay visible when Shopify is temporarily
        // unavailable; the next visibility/interval refresh will retry.
      } finally {
        running = false;
      }
      if (!cancelled && latestBody) {
        const detail = { ...latestBody, dataChanged };
        window.dispatchEvent(
          new CustomEvent("shopify-sync-updated", { detail }),
        );
        if (latestBody.fresh) {
          window.dispatchEvent(
            new CustomEvent("shopify-sync-complete", { detail }),
          );
        }
        // Re-running the route loader is only worth it when the sync actually
        // wrote something. This fires on mount, every five minutes, and on tab
        // refocus, so an unconditional revalidate re-ran every loader on the
        // page for a poll that usually finds nothing new.
        if (dataChanged) void revalidate();
      }
    };

    void synchronize();
    const interval = window.setInterval(() => {
      void synchronize();
    }, 5 * 60_000);
    const handleVisibility = () => {
      if (
        document.visibilityState === "visible" &&
        Date.now() - lastAttemptAt >= 5 * 60_000
      ) {
        void synchronize();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [revalidate]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing =
        target?.matches("input, textarea, select") ||
        target?.isContentEditable === true;
      const commandShortcut =
        (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
      const slashShortcut = event.key === "/" && !editing;

      if (!commandShortcut && !slashShortcut) return;
      event.preventDefault();
      setSearchActive(true);
      window.setTimeout(() => {
        document
          .querySelector<HTMLInputElement>(".Polaris-TopBar-SearchField__Input")
          ?.focus();
      }, 0);
    };

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  const themeAction = (
    label: string,
    value: ThemePreference,
    icon: typeof SunIcon,
  ) => ({
    content: preference === value ? `${label} (current)` : label,
    icon,
    onAction: () => setPreference(value),
  });

  const brandMarkup = (
    <Link className="app-brand" to="/app" aria-label="Rapid home">
      <span className="app-brand-mark" aria-hidden="true">
        <img src="/rapid-logo.svg" alt="" />
      </span>
      <span className="app-brand-copy">
        <strong>Rapid</strong>
      </span>
    </Link>
  );

  const navigationMarkup = (
    <Navigation
      location={pathname}
      contextControl={brandMarkup}
      onDismiss={() => setMobileNavigationActive(false)}
    >
      {NAVIGATION_GROUPS.map((group) => (
        <Navigation.Section
          key={group.title}
          title={group.title}
          items={group.items
            .filter((item) => canSee(item.url, user.role))
            .map((item) => ({
              url: item.url,
              label: item.label,
              icon: item.icon,
              /* `matches` only reads the path, so `/app/customers?appId=…`
                 satisfies the cross-app Customers entry AND the one nested
                 under the app — both highlighted at once, which says the two
                 are the same place when the whole point is that they differ.
                 While an app is selected, the nested copy owns the highlight. */
              selected:
                item.matches(pathname) &&
                !(appId && APP_SCOPED_URLS.has(item.url)),
            }))}
        />
      ))}

      {/* Mantle's app navigation: each app is a row, and the one you are in
          expands to show its own pages. Nothing app-scoped appears while no
          app is selected — the groups above already are the all-apps view, so
          showing both would be the same page listed twice. */}
      {switcherApps.length > 0 ? (
        <Navigation.Section
          separator
          title="Apps"
          items={switcherApps.map((app) => ({
            /* The app's own dashboard, matching Mantle: picking an app
               answers "how is it doing" before "who is on it". */
            url: withApp("/app/dashboard", app.id),
            label: app.name,
            icon: appIcons.get(app.id),
            selected: app.id === appId,
            // Polaris only renders sub-items for an expanded row, and only
            // expands the selected one, so this list costs nothing for the
            // apps you are not in.
            subNavigationItems:
              app.id === appId
                ? APP_SCOPED_ITEMS.map((item) => {
                    const byPath = "byPath" in item && item.byPath;
                    const url = byPath
                      ? `${item.url}/${app.id}`
                      : withApp(item.url, app.id);
                    return {
                      url,
                      label: item.label,
                      /* A path-addressed item matches only ITS own app —
                         `startsWith("/app/apps")` would light up every app's
                         settings row at once. */
                      matches: byPath
                        ? pathname === `${item.url}/${app.id}`
                        : pathname === item.url ||
                          pathname.startsWith(`${item.url}/`),
                    };
                  })
                : undefined,
          }))}
        />
      ) : null}

    </Navigation>
  );

  const searchResults = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return COMMANDS.filter(
      (command) =>
        canSee(command.url, user.role) &&
        `${command.label} ${command.keywords} ${command.group}`
          .toLowerCase()
          .includes(query),
    ).slice(0, 8);
  }, [searchQuery, user.role]);

  /**
   * Workspace search (customers, contacts, plans, reports), debounced so typing a
   * word costs one round trip rather than one per keystroke — the customer
   * query scans six figures of rows and there is no index that makes a
   * substring match cheap.
   */
  const searchFetcher = useFetcher<{ q: string; groups: SearchGroup[] }>();
  const loadSearch = searchFetcher.load;
  useEffect(() => {
    const query = searchQuery.trim();
    if (!query) return;
    const timer = setTimeout(() => {
      loadSearch(`/app/search?q=${encodeURIComponent(query)}`);
    }, 250);
    return () => clearTimeout(timer);
  }, [searchQuery, loadSearch]);

  /* Results for an older query are worse than none: they name real rows that
     do not match what is now in the box. */
  const searchData =
    searchFetcher.data?.q === searchQuery.trim() ? searchFetcher.data : null;
  const searchGroups = searchData?.groups ?? [];
  const searchPending =
    searchQuery.trim().length > 0 &&
    (searchData === null || searchFetcher.state === "loading");
  const visibleGroups = searchGroupKey
    ? searchGroups.filter((group) => group.key === searchGroupKey)
    : searchGroups;
  const totalHits = searchGroups.reduce((sum, group) => sum + group.count, 0);

  const closeSearch = () => {
    setSearchActive(false);
    setSearchQuery("");
    setSearchGroupKey(null);
  };

  const runCommand = (url: string) => {
    closeSearch();
    void navigate(url);
  };

  const searchResultsMarkup = (
    <Card>
      {/* Destinations first and always: jumping to a page is the thing this
          box did before it searched data, and it stays instant (no round
          trip) where the groups below do not. */}
      {searchResults.length ? (
        <ActionList
          actionRole="menuitem"
          items={searchResults.map((command) => ({
            content: command.label,
            helpText: command.group,
            icon: command.icon,
            active: command.matches(pathname),
            onAction: () => runCommand(command.url),
          }))}
        />
      ) : null}

      {searchGroups.length > 0 && totalHits > 0 ? (
        <div className="workspace-search">
          {/* Chips carry their own counts and sort by them, mirroring Mantle;
              clicking one isolates that group, clicking it again clears. */}
          <div className="workspace-search__chips" role="tablist">
            {searchGroups.map((group) => (
              <button
                key={group.key}
                type="button"
                role="tab"
                aria-selected={searchGroupKey === group.key}
                className={`workspace-search__chip${
                  searchGroupKey === group.key
                    ? " workspace-search__chip--active"
                    : ""
                }`}
                onClick={() =>
                  setSearchGroupKey((current) =>
                    current === group.key ? null : group.key,
                  )
                }
              >
                {group.label} {group.count}
              </button>
            ))}
          </div>

          {visibleGroups
            .filter((group) => group.hits.length > 0)
            .map((group) => (
              <div key={group.key} className="workspace-search__group">
                <div className="workspace-search__group-head">
                  <Text as="h3" variant="headingXs" tone="subdued">
                    {group.label}
                  </Text>
                  <span className="workspace-search__group-count">
                    {group.count}
                  </span>
                </div>
                {group.hits.map((hit) => (
                  <button
                    key={`${group.key}-${hit.id}`}
                    type="button"
                    className="workspace-search__hit"
                    onClick={() => runCommand(hit.url)}
                  >
                    {/* Title and metric share a row so each hit is two lines,
                        not three — the panel shows twice as many results in
                        the same height. */}
                    <span className="workspace-search__hit-row">
                      <span className="workspace-search__hit-title">
                        {hit.title}
                      </span>
                      {hit.meta ? (
                        <span className="workspace-search__hit-meta">
                          {hit.meta}
                        </span>
                      ) : null}
                    </span>
                    {hit.subtitle ? (
                      <span className="workspace-search__hit-sub">
                        {hit.subtitle}
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            ))}
        </div>
      ) : null}

      {searchResults.length === 0 && totalHits === 0 ? (
        <div className="command-search-empty">
          <Text as="p" tone="subdued">
            {searchPending
              ? "Searching…"
              : `Nothing matches “${searchQuery}”.`}
          </Text>
        </div>
      ) : null}
    </Card>
  );

  const displayName = user.name ?? user.email;
  const topBarMarkup = (
    <TopBar
      contextControl={brandMarkup}
      showNavigationToggle
      onNavigationToggle={() => setMobileNavigationActive((active) => !active)}
      searchField={
        <TopBar.SearchField
          value={searchQuery}
          placeholder="Search workspace or jump to a report"
          focused={searchActive}
          active={searchActive}
          onChange={(value) => {
            setSearchQuery(value);
            setSearchActive(true);
          }}
          onFocus={() => setSearchActive(true)}
          onCancel={closeSearch}
          showFocusBorder
        />
      }
      searchResults={searchResultsMarkup}
      searchResultsVisible={searchActive}
      searchResultsOverlayVisible={searchActive}
      onSearchResultsDismiss={closeSearch}
      secondaryMenu={
        <TopBar.Menu
          accessibilityLabel={`Theme: ${resolvedTheme}`}
          activatorContent={
            <span className="theme-menu-activator" aria-hidden="true">
              {resolvedTheme === "dark" ? <MoonIcon /> : <SunIcon />}
            </span>
          }
          open={themeMenuActive}
          onOpen={() => setThemeMenuActive(true)}
          onClose={() => setThemeMenuActive(false)}
          actions={[
            {
              title: "Appearance",
              items: [
                themeAction("Light theme", "light", SunIcon),
                themeAction("Dark theme", "dark", MoonIcon),
                themeAction("Use system setting", "system", DesktopIcon),
              ],
            },
          ]}
        />
      }
      userMenu={
        <TopBar.UserMenu
          name={displayName}
          // Only show a second line when it adds information (a real name);
          // otherwise the email would just repeat under itself.
          detail={user.name ? user.email : undefined}
          initials={displayName.charAt(0).toUpperCase()}
          open={userMenuActive}
          onToggle={() => setUserMenuActive((v) => !v)}
          actions={[
            {
              items: [{ content: "Account", icon: ProfileIcon, url: "/app/account" }],
            },
            {
              items: [{ content: "Log out", icon: PersonExitIcon, url: "/logout" }],
            },
          ]}
        />
      }
    />
  );

  return (
    <Frame
      topBar={topBarMarkup}
      navigation={navigationMarkup}
      showMobileNavigation={mobileNavigationActive}
      onNavigationDismiss={() => setMobileNavigationActive(false)}
      skipToContentTarget={skipToContentRef}
    >
      <div
        className={`route-progress${routePending ? " route-progress--active" : ""}`}
        aria-hidden="true"
      >
        <span />
      </div>
      <a
        ref={skipToContentRef}
        className="route-focus-anchor"
        tabIndex={-1}
        aria-label={`${currentPage} page content`}
      />
      <div className="route-announcer" role="status" aria-live="polite">
        {routePending ? `Loading ${currentPage}` : `${currentPage} loaded`}
      </div>
      <main className="app-shell-content">
        <Outlet />
      </main>
    </Frame>
  );
}
