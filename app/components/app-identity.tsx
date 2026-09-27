import { Avatar, InlineStack, Text } from "@shopify/polaris";

/**
 * How an app identifies itself across the dashboard: its icon, then its name.
 *
 * One implementation because the icon shows up in half a dozen unrelated places
 * — Customers, Subscriptions, reports and the app pickers — and an app that appears with a logo on
 * one screen and a bare monogram on the next reads as two different apps.
 */

/** Up to two initials, so a monogram avatar stays legible at `sm`. */
export function appInitials(appName: string): string {
  return appName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
}

/**
 * The icon alone.
 *
 * `Avatar` falls back to `initials` by itself when an image fails to load, so a
 * logo URL that 404s degrades to the monogram rather than to a broken image —
 * and an app with no logo set has always looked like that.
 */
export function AppLogo({
  appName,
  logoUrl,
  size = "sm",
}: {
  appName: string;
  logoUrl?: string | null;
  size?: "xs" | "sm" | "md";
}) {
  return (
    <Avatar
      size={size}
      name={appName}
      initials={appInitials(appName)}
      source={logoUrl ?? undefined}
    />
  );
}

/** The icon beside the name, for a table cell or a list row. */
export function AppName({
  appName,
  logoUrl,
  fontWeight = "regular",
}: {
  appName: string;
  logoUrl?: string | null;
  fontWeight?: "regular" | "medium";
}) {
  return (
    <InlineStack gap="200" blockAlign="center" wrap={false}>
      <AppLogo appName={appName} logoUrl={logoUrl} />
      <Text as="span" fontWeight={fontWeight}>
        {appName}
      </Text>
    </InlineStack>
  );
}

/**
 * A monogram as a data URI, for the one place that cannot take a component.
 *
 * `ActionList`'s `image` is a URL rendered as a CSS background, so an app with
 * no logo would get no image — and Polaris does not reserve the space, leaving
 * that row's label shifted left of its neighbours'. Handing it a generated
 * monogram keeps every row aligned and still says which app it is.
 *
 * Fixed neutral colours rather than theme tokens: a background-image cannot
 * read CSS variables or `currentColor`, so this pair is chosen to stay legible
 * on both the light and dark surfaces.
 */
export function appMonogramDataUri(appName: string): string {
  // Escaped, because this string is interpolated into markup. App names are
  // operator-entered, and `&`, `<` or `"` in one would otherwise break the SVG.
  const initials = appInitials(appName).replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[character] ?? character,
  );
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">`,
    `<rect width="32" height="32" rx="8" fill="#8c9196"/>`,
    `<text x="16" y="21" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="13" font-weight="600" fill="#ffffff">${initials}</text>`,
    `</svg>`,
  ].join("");
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
