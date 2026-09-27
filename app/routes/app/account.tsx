import { Banner, BlockStack, Button, Card, FormLayout, Page, TextField } from "@shopify/polaris";
import { useState } from "react";
import { data, Form, useNavigation } from "react-router";
import type { Route } from "./+types/account";
import { prisma } from "~/lib/db.server";
import { commitUserSession, requireUser } from "~/lib/auth/session.server";
import { notifyPasswordChanged } from "~/lib/auth/password-reset.server";
import { passwordProblem } from "~/lib/auth/password-reset.shared";
import { hashPassword, verifyPassword } from "~/lib/auth/password.server";

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  return { email: user.email };
}

export async function action({ request }: Route.ActionArgs) {
  const user = await requireUser(request);
  const form = await request.formData();
  const currentPassword = String(form.get("currentPassword") ?? "");
  const newPassword = String(form.get("newPassword") ?? "");
  const confirmPassword = String(form.get("confirmPassword") ?? "");

  if (!currentPassword || !newPassword || !confirmPassword) {
    return { error: "Fill in all three fields." };
  }
  const problem = passwordProblem(newPassword, confirmPassword, user.email);
  if (problem) return { error: problem };

  const valid = await verifyPassword(currentPassword, user.passwordHash);
  if (!valid) {
    return { error: "Current password is incorrect." };
  }

  /* A password change ends every other session — the same guarantee a
     reset gives — and re-issues this one so the person who made the change
     stays signed in. */
  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await hashPassword(newPassword),
      sessionsValidFrom: new Date(Date.now() - 1),
    },
  });
  await notifyPasswordChanged(user.email, user.name);

  return data(
    { success: true as const },
    { headers: { "Set-Cookie": await commitUserSession(user.id) } },
  );
}

export function meta() {
  return [{ title: "Account · Rapid Apps" }];
}

export default function Account({ loaderData, actionData }: Route.ComponentProps) {
  const { email } = loaderData;
  const navigation = useNavigation();
  const submitting = navigation.state === "submitting";

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  return (
    <Page title="Account" subtitle={email}>
      <Card>
        <Form method="post">
          <FormLayout>
            {actionData && "error" in actionData ? (
              <Banner tone="critical">{actionData.error}</Banner>
            ) : null}
            {actionData && "success" in actionData ? (
              <Banner tone="success">Password updated. Every other session has been signed out.</Banner>
            ) : null}

            <TextField
              label="Current password"
              type="password"
              name="currentPassword"
              autoComplete="current-password"
              value={currentPassword}
              onChange={setCurrentPassword}
              disabled={submitting}
            />
            <TextField
              label="New password"
              type="password"
              name="newPassword"
              autoComplete="new-password"
              helpText="At least 8 characters."
              value={newPassword}
              onChange={setNewPassword}
              disabled={submitting}
            />
            <TextField
              label="Confirm new password"
              type="password"
              name="confirmPassword"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={setConfirmPassword}
              disabled={submitting}
            />

            <BlockStack>
              <Button submit variant="primary" loading={submitting}>
                Update password
              </Button>
            </BlockStack>
          </FormLayout>
        </Form>
      </Card>
    </Page>
  );
}
