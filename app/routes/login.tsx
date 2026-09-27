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
import { Form, Link, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/login";
import { prisma } from "~/lib/db.server";
import { getUser, createUserSession } from "~/lib/auth/session.server";
import { verifyPassword } from "~/lib/auth/password.server";

function safeRedirectTarget(value: string | null): string {
  if (
    value &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("\\")
  ) {
    return value;
  }
  return "/app";
}

export async function loader({ request }: Route.LoaderArgs) {
  const user = await getUser(request);
  if (user) throw redirect("/app");

  const url = new URL(request.url);
  return {
    redirectTo: safeRedirectTarget(url.searchParams.get("redirectTo")),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const email = String(form.get("email") ?? "")
    .trim()
    .toLowerCase();
  const password = String(form.get("password") ?? "");
  const redirectTo = safeRedirectTarget(
    String(form.get("redirectTo") || "/app"),
  );

  if (!email || !password) {
    return { error: "Enter your email and password." };
  }

  const user = await prisma.user.findUnique({ where: { email } });
  const valid = user
    ? await verifyPassword(password, user.passwordHash)
    : false;
  /* A deactivated account fails with the SAME message as a wrong password.
     Saying "this account is deactivated" would confirm the address belongs to
     a real colleague, which is exactly what someone probing the login wants to
     learn. The password is still verified first so the response takes the same
     work either way. */
  if (!user || !valid || user.deactivatedAt) {
    return { error: "Invalid email or password." };
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  return createUserSession(user.id, redirectTo);
}

export function meta() {
  return [{ title: "Sign in · Rapid Apps" }];
}

export default function Login({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { redirectTo } = loaderData;
  const navigation = useNavigation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const submitting = navigation.state === "submitting";

  return (
    <Page narrowWidth>
      <div style={{ marginTop: "15vh" }}>
        <BlockStack gap="500">
          <BlockStack gap="200" align="center" inlineAlign="center">
            <Text as="h1" variant="heading2xl">
              Rapid Apps
            </Text>
            <Text as="p" tone="subdued">
              Internal Shopify billing & analytics platform
            </Text>
          </BlockStack>

          <Card>
            <Form method="post">
              <input type="hidden" name="redirectTo" value={redirectTo} />
              <FormLayout>
                {actionData?.error ? (
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
                <TextField
                  label="Password"
                  type="password"
                  name="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={setPassword}
                  disabled={submitting}
                />
                <Button submit variant="primary" fullWidth loading={submitting}>
                  Sign in
                </Button>
                <Text as="p" alignment="center" variant="bodySm">
                  <Link to="/forgot-password">Forgot your password?</Link>
                </Text>
              </FormLayout>
            </Form>
          </Card>
        </BlockStack>
      </div>
    </Page>
  );
}
