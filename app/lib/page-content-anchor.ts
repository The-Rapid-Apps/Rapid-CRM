/**
 * Shared marker id: pages with a title/tab-bar chrome the user doesn't need
 * to re-see on every navigation place a `<div id={PAGE_CONTENT_ANCHOR_ID} />`
 * right after that chrome, before their actual content. `app/routes/app/
 * layout.tsx` scrolls this into view on every navigation instead of
 * resetting to the window's absolute top — see its own doc comment for why
 * (found 2026-08-18: switching Reports tabs, or nav sections in general,
 * jumped to the very top of the page instead of landing on the data).
 * Pages that don't render this anchor keep the previous top-of-page
 * behavior, since the scroll effect falls back to it when the anchor isn't
 * found.
 */
export const PAGE_CONTENT_ANCHOR_ID = "page-content-start";
