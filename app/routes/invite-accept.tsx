/**
 * Accept a dashboard invite: set a password, and the account exists.
 *
 * Public by design — the invitee has no session yet, and the token IS the
 * authorization. It is therefore treated as a credential throughout: the token
 * lives in the path, is checked by hash, and is burnt in the same transaction
 * that creates the user, so a forwarded link cannot be replayed.
 *
 * An expired, revoked, already-used or invented token all render the same
 * "no longer valid" screen. Distinguishing them would let someone probing
 * tokens learn which addresses have been invited.
 */
import {
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  FormLayout,
  InlineStack,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import { useState } from "react";
import { Form, Link, useNavigation } from "react-router";
import type { Route } from "./+types/invite-accept";
import { createUserSession, getUser } from "~/lib/auth/session.server";
import { acceptUserInvite, readUserInvite } from "~/lib/auth/team.server";
import { MIN_PASSWORD_LENGTH } from "~/lib/auth/team.shared";

export async function loader({ request, params }: Route.LoaderArgs) {
  /* Someone already signed in who opens an invite would otherwise set a
     password for a DIFFERENT account and be silently switched to it. Send them
     to the dashboard instead; the invite stays open for its real recipient. */
  const existing = await getUser(request);
  if (existing) return { alreadySignedIn: true, holder: null };

  const holder = await readUserInvite(params.token ?? "");
  return {
    alreadySignedIn: false,
    holder: holder ? { email: holder.email, role: holder.role } : null,
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const form = await request.formData();
  const password = String(form.get("password") ?? "");
  const confirm = String(form.get("confirmPassword") ?? "");
  const name = String(form.get("name") ?? "");

  if (password !== confirm) {
    return { error: "The two passwords don't match." };
  }

  const result = await acceptUserInvite({
    token: params.token ?? "",
    password,
    name,
  });

  if (!result.ok) {
    return {
      error:
        result.reason === "too-short"
          ? `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`
          : result.reason === "already-a-user"
            ? "An account already exists for this address. Try signing in instead."
            : "This invite link is no longer valid. Ask whoever invited you for a new one.",
    };
  }

  // Straight in — asking someone to type the password they just chose, on the
  // next screen, achieves nothing.
  return createUserSession(result.userId, "/app");
}

export function meta() {
  return [{ title: "Accept invite · Rapid Apps" }];
}

export default function InviteAcceptPage({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { alreadySignedIn, holder } = loaderData;
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [name, setName] = useState("");

  if (alreadySignedIn) {
    return (
      <Page narrowWidth>
        <Card>
          <BlockStack gap="300">
            <Text as="h1" variant="headingMd">
              You&rsquo;re already signed in
            </Text>
            <Text as="p" tone="subdued">
              Sign out first if you meant to accept this invite on a different
              account.
            </Text>
            <InlineStack gap="200">
              <Link to="/app">
                <Button variant="primary">Go to dashboard</Button>
              </Link>
              <Link to="/logout">
                <Button>Sign out</Button>
              </Link>
            </InlineStack>
          </BlockStack>
        </Card>
      </Page>
    );
  }

  if (!holder) {
    return (
      <Page narrowWidth>
        <Card>
          <BlockStack gap="300">
            <Text as="h1" variant="headingMd">
              This invite link is no longer valid
            </Text>
            <Text as="p" tone="subdued">
              Invite links last 24 hours and can only be used once. Ask whoever
              invited you to send a new one.
            </Text>
            <Box>
              <Link to="/login">
                <Button>Go to sign in</Button>
              </Link>
            </Box>
          </BlockStack>
        </Card>
      </Page>
    );
  }

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;
  const mismatch = confirmPassword.length > 0 && password !== confirmPassword;

  return (
    <Page narrowWidth title="Set up your account">
      <Card>
        <Form method="post">
          <BlockStack gap="400">
            <Text as="p" tone="subdued">
              You&rsquo;ve been invited to the Rapid Apps dashboard as{" "}
              <Text as="span" fontWeight="semibold">
                {holder.email}
              </Text>
              {holder.role === "ADMIN"
                ? ", with permission to manage the team."
                : "."}
            </Text>

            {actionData?.error ? (
              <Banner tone="critical">
                <p>{actionData.error}</p>
              </Banner>
            ) : null}

            <FormLayout>
              <TextField
                label="Your name"
                name="name"
                value={name}
                onChange={setName}
                autoComplete="name"
                helpText="Optional — shown next to anything you comment on."
              />
              <TextField
                label="Password"
                name="password"
                type="password"
                value={password}
                onChange={setPassword}
                autoComplete="new-password"
                requiredIndicator
                error={tooShort ? `At least ${MIN_PASSWORD_LENGTH} characters.` : undefined}
                helpText={`At least ${MIN_PASSWORD_LENGTH} characters. A long passphrase beats a short complicated one.`}
              />
              <TextField
                label="Confirm password"
                name="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={setConfirmPassword}
                autoComplete="new-password"
                requiredIndicator
                error={mismatch ? "These don't match." : undefined}
              />
            </FormLayout>

            <Button
              variant="primary"
              submit
              loading={busy}
              disabled={busy || tooShort || mismatch || !password || !confirmPassword}
            >
              Create account
            </Button>
          </BlockStack>
        </Form>
      </Card>
    </Page>
  );
}
