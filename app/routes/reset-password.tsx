import {
  Banner,
  BlockStack,
  Button,
  Card,
  FormLayout,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import { useState } from "react";
import { createCookie, Form, Link, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/reset-password";
import { commitUserSession } from "~/lib/auth/session.server";
import {
  completePasswordReset,
  readPasswordReset,
} from "~/lib/auth/password-reset.server";
import {
  isWellFormedToken,
  MIN_PASSWORD_LENGTH,
  RESET_COOKIE_PATH,
  RESET_TTL_MINUTES,
} from "~/lib/auth/password-reset.shared";
import { env, isProd } from "~/lib/env.server";

/**
 * "Forgot password" — step two: choose a new one.
 *
 * The emailed link carries the token in its query string. The first request
 * moves it into a short-lived, httpOnly cookie (see RESET_COOKIE_PATH) and
 * redirects to the bare URL, so the token does not stay in the address bar,
 * the browser history, a `Referer` header or the web server's access log.
 */
const resetCookie = createCookie("__rapi_pw_reset", {
  httpOnly: true,
  secure: isProd,
  // Lax, not Strict: the user arrives by a top-level link from their mail
  // client, and a Strict cookie set there would not come back on the redirect.
  sameSite: "lax",
  path: RESET_COOKIE_PATH,
  maxAge: RESET_TTL_MINUTES * 60,
  secrets: [env.SESSION_SECRET],
});

export function headers() {
  return {
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  };
}

async function tokenFrom(request: Request): Promise<string | null> {
  const value = await resetCookie.parse(request.headers.get("Cookie"));
  return typeof value === "string" ? value : null;
}

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const fromLink = url.searchParams.get("token");
  if (fromLink !== null) {
    const headers = new Headers();
    headers.append(
      "Set-Cookie",
      isWellFormedToken(fromLink)
        ? await resetCookie.serialize(fromLink)
        : await resetCookie.serialize("", { maxAge: 0 }),
    );
    /* Retire the cookie the first release scoped to /reset-password. A browser
       still holding one sends it FIRST (more specific path), so the page would
       read that stale token instead of this link's. */
    headers.append("Set-Cookie", await resetCookie.serialize("", { maxAge: 0, path: "/reset-password" }));
    throw redirect("/reset-password", { headers });
  }

  const reset = await readPasswordReset(await tokenFrom(request));
  return reset ? { state: "ready" as const, email: reset.email } : { state: "invalid" as const };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const outcome = await completePasswordReset({
    token: await tokenFrom(request),
    password: String(form.get("password") ?? ""),
    confirm: String(form.get("confirm") ?? ""),
  });
  if (!outcome.ok) return { error: outcome.message, reason: outcome.reason };

  // Signed in on the new password, with the link's cookie cleared.
  const responseHeaders = new Headers();
  responseHeaders.append("Set-Cookie", await resetCookie.serialize("", { maxAge: 0 }));
  responseHeaders.append(
    "Set-Cookie",
    await resetCookie.serialize("", { maxAge: 0, path: "/reset-password" }),
  );
  responseHeaders.append("Set-Cookie", await commitUserSession(outcome.userId));
  return redirect("/app", { headers: responseHeaders });
}

export function meta() {
  return [{ title: "Choose a new password · Rapid Apps" }];
}

export default function ResetPassword({ loaderData, actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const submitting = navigation.state === "submitting";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const invalid =
    loaderData.state === "invalid" || (actionData && actionData.reason === "invalid");

  return (
    <Page narrowWidth>
      <div style={{ marginTop: "15vh" }}>
        <BlockStack gap="500">
          <BlockStack gap="200" align="center" inlineAlign="center">
            <Text as="h1" variant="heading2xl">
              Choose a new password
            </Text>
            {loaderData.state === "ready" && !invalid ? (
              <Text as="p" tone="subdued">
                For {loaderData.email}
              </Text>
            ) : null}
          </BlockStack>

          <Card>
            {invalid ? (
              <BlockStack gap="300">
                <Banner tone="warning" title="This link can't be used">
                  <p>
                    Reset links work once and expire after {RESET_TTL_MINUTES} minutes,
                    and asking for a new one cancels the old. Request a fresh link to
                    continue.
                  </p>
                </Banner>
                <Button url="/forgot-password" variant="primary" fullWidth>
                  Request a new link
                </Button>
              </BlockStack>
            ) : (
              <Form method="post">
                <FormLayout>
                  {actionData?.error ? <Banner tone="critical">{actionData.error}</Banner> : null}
                  <TextField
                    label="New password"
                    type="password"
                    name="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={setPassword}
                    helpText={`At least ${MIN_PASSWORD_LENGTH} characters. A long passphrase beats a short complicated one.`}
                    disabled={submitting}
                  />
                  <TextField
                    label="Confirm new password"
                    type="password"
                    name="confirm"
                    autoComplete="new-password"
                    value={confirm}
                    onChange={setConfirm}
                    disabled={submitting}
                  />
                  <Text as="p" tone="subdued" variant="bodySm">
                    Saving signs you out everywhere else and signs you in here.
                  </Text>
                  <Button submit variant="primary" fullWidth loading={submitting}>
                    Save new password
                  </Button>
                </FormLayout>
              </Form>
            )}
          </Card>

          <Text as="p" alignment="center" variant="bodySm">
            <Link to="/login">Back to sign in</Link>
          </Text>
        </BlockStack>
      </div>
    </Page>
  );
}
