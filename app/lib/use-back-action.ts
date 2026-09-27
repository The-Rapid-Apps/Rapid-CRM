import type { CallbackAction, LinkAction } from "@shopify/polaris";
import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router";

/**
 * A Back button that returns where you actually came from.
 *
 * Every detail page here used to hardcode its parent — App settings sent you
 * to Manage apps, a plan sent you to Plans — which is wrong whenever the page
 * was opened from somewhere else. Opening App settings from an app's own
 * dashboard and pressing Back dropped you on Manage apps, a page you had not
 * been on.
 *
 * `navigate(-1)` alone is not the fix either, and that is why this is a hook
 * rather than a one-line replacement. On a page opened directly — a pasted
 * URL, a new tab, a link from Slack — there is no in-app entry to pop, so
 * Back would either do nothing or throw the user out of the app entirely.
 *
 * So: pop history when there IS history, and otherwise fall back to the
 * declared parent, which is exactly today's behaviour. React Router stamps the
 * first entry of a browser session with the key `"default"`; any other key
 * means we arrived here by navigating from another page in the app.
 *
 * The label follows the destination — "Back" when it pops, the parent's name
 * when it falls back — because a button labelled "Plans" that lands on the
 * customer you came from is a worse lie than an unhelpfully generic one.
 */
export function useBackAction(fallback: {
  content: string;
  url: string;
}): CallbackAction | LinkAction {
  const navigate = useNavigate();
  const { key } = useLocation();
  const goBack = useCallback(() => navigate(-1), [navigate]);

  return key !== "default"
    ? { content: "Back", onAction: goBack }
    : { content: fallback.content, url: fallback.url };
}
