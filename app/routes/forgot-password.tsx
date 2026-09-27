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
import { Form, Link, useNavigation } from "react-router";
import type { Route } from "./+types/forgot-password";
import { clientKeyFromRequest } from "~/lib/auth/throttle.server";
import { requestPasswordReset } from "~/lib/auth/password-reset.server";
import { RESET_TTL_MINUTES } from "~/lib/auth/password-reset.shared";

/**
 * "Forgot password" — step one: ask for a link.
 *
 * The response is the same sentence whether or not the address has an
 * account, and it is sent before the lookup or the email happens (the work is
 * not awaited), so neither the wording nor the timing tells a visitor whether
 * someone works here. See password-reset.server.ts for the rest.
 */
export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const email = String(form.get("email") ?? "").trim();
  if (!email) return { error: "Enter your email address." };

  // Deliberately not awaited: see above. It never throws.
  void requestPasswordReset({ email, clientKey: clientKeyFromRequest(request) });
  return { sent: true as const };
}

export function meta() {
  return [{ title: "Reset password · Rapid Apps" }];
}

export default function ForgotPassword({ actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const submitting = navigation.state === "submitting";
  const [email, setEmail] = useState("");
  const sent = actionData && "sent" in actionData;

  return (
    <Page narrowWidth>
      <div style={{ marginTop: "15vh" }}>
        <BlockStack gap="500">
          <BlockStack gap="200" align="center" inlineAlign="center">
            <Text as="h1" variant="heading2xl">
              Reset your password
            </Text>
            <Text as="p" tone="subdued" alignment="center">
              Enter the email you sign in with and we'll send you a link to choose a
              new password.
            </Text>
          </BlockStack>

          <Card>
            {sent ? (
              <BlockStack gap="300">
                <Banner tone="success" title="Check your email">
                  <p>
                    If an account exists for that address, a reset link is on its way.
                    It works once and expires in {RESET_TTL_MINUTES} minutes.
                  </p>
                </Banner>
                <Text as="p" tone="subdued" variant="bodySm">
                  Nothing after a few minutes? Check your spam folder, or ask a team
                  admin to confirm the address on your account.
                </Text>
              </BlockStack>
            ) : (
              <Form method="post">
                <FormLayout>
                  {actionData && "error" in actionData ? (
                    <Banner tone="critical">{actionData.error}</Banner>
                  ) : null}
                  <TextField
                    label="Email"
                    type="email"
                    name="email"
                    autoComplete="email"
                    value={email}
                    onChange={setEmail}
                    disabled={submitting}
                  />
                  <Button submit variant="primary" fullWidth loading={submitting}>
                    Email me a reset link
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
