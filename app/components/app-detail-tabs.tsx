import { Link } from "react-router";

/**
 * The app dashboard's sub-navigation. `app-detail.tsx` (overview) and
 * `app-events.tsx` are sibling routes rather than a nested Outlet layout, so
 * this small strip is rendered at the top of each to tie them together without
 * refactoring the large detail page.
 */
export function AppDetailTabs({
  appId,
  active,
}: {
  appId: string;
  active: "overview" | "events";
}) {
  const tabs: Array<{ id: "overview" | "events"; label: string; url: string }> =
    [
      { id: "overview", label: "App overview", url: `/app/apps/${appId}` },
      {
        id: "events",
        label: "App events",
        url: `/app/apps/${appId}/events`,
      },
    ];
  return (
    <nav className="app-detail-tabs" aria-label="App sections">
      {tabs.map((tab) => (
        <Link
          key={tab.id}
          to={tab.url}
          className={
            tab.id === active
              ? "app-detail-tab app-detail-tab--active"
              : "app-detail-tab"
          }
          aria-current={tab.id === active ? "page" : undefined}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
