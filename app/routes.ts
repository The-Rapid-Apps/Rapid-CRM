import {
  type RouteConfig,
  index,
  route,
  layout,
  prefix,
} from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),

  // --- Dashboard login (email + password; SSO planned later) ---
  route("login", "routes/login.tsx"),
  route("forgot-password", "routes/forgot-password.tsx"),
  route("reset-password", "routes/reset-password.tsx"),
  route("invite/:token", "routes/invite-accept.tsx"),
  route("logout", "routes/logout.tsx"),

  // --- Management dashboard (Polaris) ---
  layout("routes/app/layout.tsx", [
    ...prefix("app", [
      index("routes/app/overview.tsx"),
      route("customers", "routes/app/customers.tsx"),
      route("customers/:customerKey", "routes/app/customer-detail.tsx"),
      route("connections", "routes/app/connections.tsx"),
      route("team", "routes/app/team.tsx"),
      route("dashboard", "routes/app/app-dashboard.tsx"),
      route("uninstalls", "routes/app/uninstalls.tsx"),
      route("plans/observed", "routes/app/plan-observed.tsx"),
      route("apps", "routes/app/apps.tsx"),
      route("apps/:appId", "routes/app/app-detail.tsx"),
      route("apps/:appId/events", "routes/app/app-events.tsx"),
      route(
        "apps/:appId/events/export",
        "routes/app/app-events.export.tsx",
      ),
      route("subscriptions", "routes/app/subscriptions.tsx"),
      route("subscriptions/:id", "routes/app/subscription-detail.tsx"),
      route("plans", "routes/app/plans.tsx"),
      route("plans/new", "routes/app/plan-new.tsx"),
      route("plans/:planId", "routes/app/plan-detail.tsx"),
      route("plan-features", "routes/app/plan-features.tsx"),
      route("discounts", "routes/app/discounts.tsx"),
      route("discounts/:id", "routes/app/discount-detail.tsx"),
      route("reports", "routes/app/reports.tsx"),
      route("saved-views", "routes/app/saved-views.tsx"),
      route("reports/never-billed", "routes/app/reports.never-billed.tsx"),
      route("reviews", "routes/app/reviews.tsx"),
      route("reviews/export", "routes/app/reviews.export.tsx"),
      route("events", "routes/app/events.tsx"),
      route("api-logs", "routes/app/api-logs.tsx"),
      route("account", "routes/app/account.tsx"),
      route("search", "routes/app/search.tsx"),
      route(
        "overview/top-customers",
        "routes/app/overview.top-customers.tsx",
      ),
    ]),
  ]),

  // --- Merchant-facing pricing / plan-picker page ---
  route("billing/:installId", "routes/billing.tsx"),

  // --- Public API (your apps consume) ---
  ...prefix("api/flex", [
    route("installs", "routes/api/installs.tsx"),
    route("apps", "routes/api/installed-apps.tsx"),
    route("subscribe", "routes/api/subscribe.tsx"),
    route("change-tier", "routes/api/change-tier.tsx"),
    route("usage", "routes/api/usage.tsx"),
    route("discount/resolve", "routes/api/discount-resolve.tsx"),
    route("discounts", "routes/api/discounts.tsx"),
    route("subscriptions", "routes/api/subscriptions.tsx"),
    route("subscription/:id", "routes/api/subscription.tsx"),
    route("plans", "routes/api/plans.tsx"),
    route("return", "routes/api/return.tsx"),
    route("cron/charge", "routes/api/cron-charge.tsx"),
    // The standard rail's mirror-healer. It charges nothing — Shopify collects.
    route(
      "cron/standard-reconcile",
      "routes/api/cron-standard-reconcile.tsx",
    ),
    route("cron/customer-events", "routes/api/cron-customer-events.tsx"),
    route(
      "cron/subscription-events",
      "routes/api/cron-subscription-events.tsx",
    ),
    route("cron/traffic-events", "routes/api/cron-traffic-events.tsx"),
    route("cron/app-reviews", "routes/api/cron-app-reviews.tsx"),
    route(
      "cron/live-discount-check",
      "routes/api/cron-live-discount-check.tsx",
    ),
  ]),
  route("api/discounts", "routes/api/native-discounts-list.tsx"),
  route("api/discounts/resolve", "routes/api/native-discount-resolve.tsx"),
  route(
    "api/discounts/redemptions/:redemptionId",
    "routes/api/native-discount-redemption.tsx",
  ),
  route("api/metrics/:metric", "routes/api/metrics.tsx"),
  route("api/metrics-sync", "routes/api/metrics-sync.tsx"),

  // --- Identify API (apps onboard via IDENTIFY_APP_CREDENTIALS) ---
  route("v1/identify", "routes/api/identify.tsx"),
  route("identify", "routes/api/identify.tsx", { id: "identify-alias" }),

  // --- Shopify webhook (app-specific, per-app handle) ---
  route("webhooks/:appHandle/uninstalled", "routes/webhooks/uninstalled.tsx"),
] satisfies RouteConfig;
