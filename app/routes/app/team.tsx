/**
 * Team management: who can sign in to this dashboard, and who may change that.
 *
 * ADMIN-only, enforced in BOTH the loader and the action — the nav link is
 * hidden from MEMBERs, but a hidden link is presentation, and a POST never
 * goes through the nav.
 *
 * Invites are delivered as a copy-link rather than emailed. That is a
 * deliberate first step, not an oversight: the only Postmark helper in this
 * codebase is `sendWithTemplate`, so an emailed invite needs a template and a
 * verified sender signature set up first. Emailing is the follow-up.
 */
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  DataTable,
  EmptyState,
  InlineStack,
  Modal,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { useEffect, useState } from "react";
import { Form, useNavigation } from "react-router";
import type { Route } from "./+types/team";
import { prisma } from "~/lib/db.server";
import { requireAdmin } from "~/lib/auth/session.server";
import { env } from "~/lib/env.server";
import { EMPTY_STATE_IMAGE } from "~/lib/ui";
import { CopyButton } from "~/components/copy-button";
import { formatDateTime } from "~/lib/format";
import {
  createUserInvite,
  listPendingInvites,
  revokeUserInvite,
  setUserActive,
  setUserRole,
} from "~/lib/auth/team.server";

export async function loader({ request }: Route.LoaderArgs) {
  const admin = await requireAdmin(request);
  // `requireAdmin` already carries the organization, so there is no second
  // lookup to do — and no nullable org to handle.
  const organizationId = admin.organizationId;

  const [users, invites] = await Promise.all([
    prisma.user.findMany({
      where: { organizationId },
      orderBy: [{ deactivatedAt: "asc" }, { email: "asc" }],
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        lastLoginAt: true,
        deactivatedAt: true,
      },
    }),
    listPendingInvites(organizationId),
  ]);

  return { currentUserId: admin.id, users, invites };
}

export async function action({ request }: Route.ActionArgs) {
  const admin = await requireAdmin(request);
  const organizationId = admin.organizationId;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "invite") {
    const result = await createUserInvite({
      organizationId,
      email: String(form.get("email") ?? ""),
      role: String(form.get("role")) === "ADMIN" ? "ADMIN" : "MEMBER",
      invitedById: admin.id,
      baseUrl: env.APP_URL,
    });
    if (!result.ok) {
      /* `scope` decides where this renders. An invite failure belongs beside
         the field that caused it, inside the still-open modal — a banner
         behind the modal is invisible until you dismiss the thing you were
         trying to fix. */
      return {
        scope: "invite" as const,
        error:
          result.reason === "invalid-email"
            ? "That doesn't look like an email address."
            : result.reason === "reactivate-instead"
              ? "That address already has a deactivated account — reactivate it in the People list instead of inviting again."
              : "That address already has an account.",
      };
    }
    /* The only time this link is ever readable. It is not stored, and the
       table keeps a hash, so it cannot be shown again — a second invite
       replaces it. */
    return {
      inviteUrl: result.link.url,
      inviteExpiresAt: result.link.expiresAt.toISOString(),
    };
  }

  if (intent === "revoke-invite") {
    const revoked = await revokeUserInvite({
      organizationId,
      inviteId: String(form.get("inviteId") ?? ""),
    });
    return revoked
      ? { success: "Invite revoked." }
      : { scope: "page" as const, error: "That invite is no longer open." };
  }

  if (intent === "set-active" || intent === "set-role") {
    const userId = String(form.get("userId") ?? "");
    const result =
      intent === "set-active"
        ? await setUserActive({
            organizationId,
            userId,
            actingUserId: admin.id,
            active: String(form.get("active")) === "true",
          })
        : await setUserRole({
            organizationId,
            userId,
            actingUserId: admin.id,
            role: String(form.get("role")) === "ADMIN" ? "ADMIN" : "MEMBER",
          });

    if (result.ok) return { success: "Access updated." };
    return {
      scope: "page" as const,
      error:
        result.reason === "self"
          ? "You can't deactivate your own account."
          : result.reason === "last-admin"
            ? "This is the only active admin — promote someone else first, or the team could never be managed again."
            : "That user no longer exists.",
    };
  }

  return { scope: "page" as const, error: "Unknown action." };
}

export function meta() {
  return [{ title: "Team · Rapid Apps" }];
}

export default function TeamPage({ loaderData, actionData }: Route.ComponentProps) {
  const { currentUserId, users, invites } = loaderData;
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";
  const [inviteOpen, setInviteOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("MEMBER");

  const inviteUrl = actionData && "inviteUrl" in actionData ? actionData.inviteUrl : null;
  const rawError = actionData && "error" in actionData ? actionData.error : null;
  const errorScope = actionData && "scope" in actionData ? actionData.scope : null;
  const success = actionData && "success" in actionData ? actionData.success : null;
  // Dismissed when the modal closes, so reopening it never shows the error
  // from a previous attempt.
  const [inviteError, setInviteError] = useState<string | null>(null);
  const pageError = errorScope === "page" ? rawError : null;

  // Close the form once an invite is minted, so the link banner is what's on
  // screen rather than a form that would mint a second one and void this link.
  useEffect(() => {
    if (inviteUrl) {
      setInviteOpen(false);
      setEmail("");
      setRole("MEMBER");
    }
  }, [inviteUrl]);

  useEffect(() => {
    if (errorScope === "invite" && rawError) setInviteError(rawError);
  }, [errorScope, rawError]);

  const closeInvite = () => {
    setInviteOpen(false);
    setInviteError(null);
  };

  const userRows = users.map((user) => {
    const isSelf = user.id === currentUserId;
    const active = !user.deactivatedAt;
    return [
      <BlockStack gap="050" key={`who-${user.id}`}>
        <Text as="span" fontWeight="semibold">
          {user.name ?? user.email}
        </Text>
        {user.name ? (
          <Text as="span" tone="subdued" variant="bodySm">
            {user.email}
          </Text>
        ) : null}
      </BlockStack>,
      <InlineStack gap="150" blockAlign="center" key={`role-${user.id}`}>
        <Badge tone={user.role === "ADMIN" ? "success" : undefined}>
          {user.role === "ADMIN" ? "Admin" : "Member"}
        </Badge>
        {isSelf ? <Badge>You</Badge> : null}
      </InlineStack>,
      active ? <Badge tone="success">Active</Badge> : <Badge tone="critical">Deactivated</Badge>,
      user.lastLoginAt ? formatDateTime(user.lastLoginAt) : "Never",
      <InlineStack gap="200" key={`actions-${user.id}`}>
        <Form method="post">
          <input type="hidden" name="intent" value="set-role" />
          <input type="hidden" name="userId" value={user.id} />
          <input
            type="hidden"
            name="role"
            value={user.role === "ADMIN" ? "MEMBER" : "ADMIN"}
          />
          <Button size="slim" submit disabled={busy}>
            {user.role === "ADMIN" ? "Make member" : "Make admin"}
          </Button>
        </Form>
        <Form method="post">
          <input type="hidden" name="intent" value="set-active" />
          <input type="hidden" name="userId" value={user.id} />
          <input type="hidden" name="active" value={active ? "false" : "true"} />
          <Button
            size="slim"
            tone={active ? "critical" : undefined}
            submit
            disabled={busy || (isSelf && active)}
          >
            {active ? "Deactivate" : "Reactivate"}
          </Button>
        </Form>
      </InlineStack>,
    ];
  });

  const inviteRows = invites.map((invite) => [
    invite.email,
    <Badge key={`ir-${invite.id}`} tone={invite.role === "ADMIN" ? "success" : undefined}>
      {invite.role === "ADMIN" ? "Admin" : "Member"}
    </Badge>,
    invite.invitedByEmail ?? "—",
    formatDateTime(invite.expiresAt),
    <Form method="post" key={`rev-${invite.id}`}>
      <input type="hidden" name="intent" value="revoke-invite" />
      <input type="hidden" name="inviteId" value={invite.id} />
      <Button size="slim" tone="critical" submit disabled={busy}>
        Revoke
      </Button>
    </Form>,
  ]);

  return (
    <Page
      fullWidth
      title="Team"
      subtitle="Everyone who can sign in to this dashboard."
      primaryAction={{
        content: "Invite person",
        // Clears here too, not only on close: reopening after a failure
        // should present an empty form, not the last complaint.
        onAction: () => {
          setInviteError(null);
          setInviteOpen(true);
        },
      }}
    >
      <BlockStack gap="400">
        {pageError ? (
          <Banner tone="critical" title="That didn't work">
            <p>{pageError}</p>
          </Banner>
        ) : null}
        {success ? <Banner tone="success">{success}</Banner> : null}

        {inviteUrl ? (
          <Banner tone="info" title="Invite link ready — copy it now">
            <BlockStack gap="300">
              <p>
                This link is shown once and cannot be retrieved again. Send it
                to them yourself; it expires in 24 hours and works a single
                time.
              </p>
              <TextField
                label="Invite link"
                labelHidden
                value={inviteUrl}
                onChange={() => undefined}
                autoComplete="off"
                readOnly
                selectTextOnFocus
                connectedRight={
                  <CopyButton value={inviteUrl} toastMessage="Invite link copied">
                    Copy
                  </CopyButton>
                }
              />
              <Text as="p" tone="subdued" variant="bodySm">
                Anyone who opens this link gets full access to every app&rsquo;s
                Shopify credentials and all merchant billing data.
              </Text>
            </BlockStack>
          </Banner>
        ) : null}

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              People
            </Text>
            <DataTable
              columnContentTypes={["text", "text", "text", "text", "text"]}
              headings={["Person", "Role", "Status", "Last sign-in", "Actions"]}
              rows={userRows}
            />
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Pending invites
            </Text>
            {inviteRows.length > 0 ? (
              <DataTable
                columnContentTypes={["text", "text", "text", "text", "text"]}
                headings={["Email", "Role", "Invited by", "Expires", "Actions"]}
                rows={inviteRows}
              />
            ) : (
              <EmptyState heading="No pending invites" image={EMPTY_STATE_IMAGE}>
                <p>Invite someone and their link will be listed here until it is used or expires.</p>
              </EmptyState>
            )}
          </BlockStack>
        </Card>
      </BlockStack>

      <Modal
        open={inviteOpen}
        onClose={closeInvite}
        title="Invite someone to the dashboard"
      >
        <Modal.Section>
          <Form method="post" id="invite-form">
            <input type="hidden" name="intent" value="invite" />
            <BlockStack gap="400">
              {inviteError ? (
                <Banner tone="critical" title="That didn't work">
                  <p>{inviteError}</p>
                </Banner>
              ) : null}
              <Banner tone="warning">
                <p>
                  Everyone who signs in — admin or member — can see every
                  app&rsquo;s Shopify credentials and all merchant billing data.
                  Only the ability to manage this page differs.
                </p>
              </Banner>
              <TextField
                label="Email address"
                name="email"
                type="email"
                value={email}
                onChange={setEmail}
                autoComplete="off"
                requiredIndicator
              />
              <Select
                label="Role"
                name="role"
                value={role}
                onChange={setRole}
                options={[
                  { label: "Member — can use the dashboard", value: "MEMBER" },
                  {
                    label: "Admin — can also invite and remove people",
                    value: "ADMIN",
                  },
                ]}
              />
              <InlineStack align="end" gap="200">
                <Button onClick={closeInvite}>Cancel</Button>
                <Button variant="primary" submit disabled={busy || !email.trim()}>
                  Create invite link
                </Button>
              </InlineStack>
            </BlockStack>
          </Form>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
