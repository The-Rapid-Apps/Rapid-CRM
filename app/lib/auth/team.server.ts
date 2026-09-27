/**
 * Dashboard team management: inviting people, and taking access away again.
 *
 * SCOPE, deliberately narrow. `UserRole` gates THIS screen and nothing else.
 * Every signed-in user of either role still reaches every app's Shopify
 * credentials and all merchant billing data, exactly as before the role column
 * existed. So inviting someone is not a small act — it hands over everything —
 * and that is why the ability to do it is restricted, not because MEMBERs see
 * less.
 *
 * The token discipline: a long random token, only
 * its SHA-256 stored, short-lived, single-use, and re-inviting invalidates the
 * outstanding link rather than leaving two live credentials for one address.
 */
import { createHash, randomBytes } from "node:crypto";
import { prisma } from "../db.server";
import { hashPassword } from "./password.server";
import {
  INVITE_TTL_MS,
  MIN_PASSWORD_LENGTH,
  looksLikeEmail,
  normalizeEmail,
} from "./team.shared";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface InviteLink {
  /** Shown to the inviter ONCE and never stored. */
  url: string;
  expiresAt: Date;
}

export type InviteOutcome =
  | { ok: true; link: InviteLink }
  | {
      ok: false;
      reason: "invalid-email" | "already-a-user" | "reactivate-instead";
    };

/**
 * Mint an invite link for an email address.
 *
 * Returns the token exactly once; only its hash is persisted, so a database
 * read cannot be turned into an account.
 *
 * A deactivated user is NOT re-invitable: their row still exists, `email` is
 * UNIQUE, and accepting would collide. Reactivating is both the correct action
 * and a different decision — it restores the same identity, with whatever
 * history and comments are attached to it — so it is surfaced as its own
 * outcome rather than silently done here.
 */
export async function createUserInvite(params: {
  organizationId: string;
  email: string;
  role: "ADMIN" | "MEMBER";
  invitedById: string;
  baseUrl: string;
}): Promise<InviteOutcome> {
  const email = normalizeEmail(params.email);
  if (!looksLikeEmail(email)) return { ok: false, reason: "invalid-email" };

  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true, deactivatedAt: true },
  });
  if (existing) {
    return {
      ok: false,
      reason: existing.deactivatedAt ? "reactivate-instead" : "already-a-user",
    };
  }

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

  /* Supersede any outstanding invite for this address in the same breath as
     issuing the new one. "Send it again" should replace the old link, not add
     a second working one — otherwise revoking the visible invite leaves an
     invisible one alive. */
  await prisma.$transaction([
    prisma.userInvite.updateMany({
      where: {
        organizationId: params.organizationId,
        email,
        acceptedAt: null,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    }),
    prisma.userInvite.create({
      data: {
        organizationId: params.organizationId,
        email,
        role: params.role,
        tokenHash: sha256(token),
        expiresAt,
        invitedById: params.invitedById,
      },
    }),
  ]);

  return {
    ok: true,
    link: {
      url: `${params.baseUrl.replace(/\/+$/, "")}/invite/${token}`,
      expiresAt,
    },
  };
}

export interface PendingInvite {
  id: string;
  email: string;
  role: "ADMIN" | "MEMBER";
  expiresAt: Date;
  createdAt: Date;
  invitedByEmail: string | null;
}

/** Open invites — neither accepted, revoked, nor expired. Expired ones are
 * left in the table (they are the audit trail) but are not pending. */
export async function listPendingInvites(
  organizationId: string,
): Promise<PendingInvite[]> {
  const rows = await prisma.userInvite.findMany({
    where: {
      organizationId,
      acceptedAt: null,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      email: true,
      role: true,
      expiresAt: true,
      createdAt: true,
      invitedBy: { select: { email: true } },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    role: row.role,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    invitedByEmail: row.invitedBy?.email ?? null,
  }));
}

/** Revoke one outstanding invite. Scoped by organization so an id from
 * elsewhere cannot reach it. Idempotent: revoking twice is not an error. */
export async function revokeUserInvite(params: {
  organizationId: string;
  inviteId: string;
}): Promise<boolean> {
  const result = await prisma.userInvite.updateMany({
    where: {
      id: params.inviteId,
      organizationId: params.organizationId,
      acceptedAt: null,
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  });
  return result.count > 0;
}

export interface InviteHolder {
  email: string;
  role: "ADMIN" | "MEMBER";
}

/**
 * Who an invite token is for, or null.
 *
 * An expired, revoked, accepted or non-existent token all return null. Someone
 * probing tokens learns nothing from the difference.
 */
export async function readUserInvite(
  token: string,
): Promise<InviteHolder | null> {
  const trimmed = token.trim();
  if (!trimmed) return null;

  const invite = await prisma.userInvite.findUnique({
    where: { tokenHash: sha256(trimmed) },
    select: {
      email: true,
      role: true,
      expiresAt: true,
      acceptedAt: true,
      revokedAt: true,
    },
  });
  if (!invite) return null;
  if (invite.acceptedAt || invite.revokedAt) return null;
  if (invite.expiresAt.getTime() < Date.now()) return null;

  return { email: invite.email, role: invite.role };
}

export type AcceptOutcome =
  | { ok: true; userId: string }
  | { ok: false; reason: "invalid-token" | "too-short" | "already-a-user" };

/**
 * Create the account an invite promises, and burn the invite.
 *
 * Both writes are one transaction: a created user with a still-live invite
 * would leave a working second link to an account that already exists, and a
 * burnt invite with no user would strand the person with nothing.
 */
export async function acceptUserInvite(params: {
  token: string;
  password: string;
  name?: string;
}): Promise<AcceptOutcome> {
  const trimmed = params.token.trim();
  const holder = await readUserInvite(trimmed);
  if (!holder) return { ok: false, reason: "invalid-token" };
  if (params.password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, reason: "too-short" };
  }

  /* Re-read inside the write to get the organization, and to re-check the
     token state — the gap between `readUserInvite` and here is small but a
     double submit lands in it. */
  const invite = await prisma.userInvite.findUnique({
    where: { tokenHash: sha256(trimmed) },
    select: { id: true, organizationId: true, email: true, role: true },
  });
  if (!invite) return { ok: false, reason: "invalid-token" };

  const clash = await prisma.user.findUnique({
    where: { email: invite.email },
    select: { id: true },
  });
  if (clash) return { ok: false, reason: "already-a-user" };

  const passwordHash = await hashPassword(params.password);
  const name = params.name?.trim();

  try {
    const [, user] = await prisma.$transaction([
      prisma.userInvite.updateMany({
        // The state guard is what makes a double submit safe: the second
        // transaction matches zero rows and its create never runs.
        where: { id: invite.id, acceptedAt: null, revokedAt: null },
        data: { acceptedAt: new Date() },
      }),
      prisma.user.create({
        data: {
          organizationId: invite.organizationId,
          email: invite.email,
          passwordHash,
          role: invite.role,
          ...(name ? { name } : {}),
        },
        select: { id: true },
      }),
    ]);
    return { ok: true, userId: user.id };
  } catch {
    // Unique violation on `email` — someone else accepted between the check
    // and the write.
    return { ok: false, reason: "already-a-user" };
  }
}

export type AccessChangeOutcome =
  | { ok: true }
  | { ok: false; reason: "not-found" | "self" | "last-admin" };

/**
 * Deactivate a user, or bring one back.
 *
 * Never deletes. `CustomerComment.author` is ON DELETE CASCADE, so removing a
 * user would silently take their comment history with them — and a comment's
 * value is largely in knowing who wrote it. Deactivating also takes effect
 * immediately: `getUser` re-reads this row on every request, so live sessions
 * die on their next navigation rather than at cookie expiry.
 *
 * Two things are refused. You cannot deactivate yourself — an accident there
 * ends your own session mid-action. And you cannot remove the last active
 * ADMIN, which would leave an organization nobody can ever manage again,
 * recoverable only by someone with database access.
 */
export async function setUserActive(params: {
  organizationId: string;
  userId: string;
  actingUserId: string;
  active: boolean;
}): Promise<AccessChangeOutcome> {
  if (params.userId === params.actingUserId && !params.active) {
    return { ok: false, reason: "self" };
  }

  const target = await prisma.user.findFirst({
    where: { id: params.userId, organizationId: params.organizationId },
    select: { id: true, role: true, deactivatedAt: true },
  });
  if (!target) return { ok: false, reason: "not-found" };

  if (!params.active && target.role === "ADMIN" && !target.deactivatedAt) {
    const otherAdmins = await prisma.user.count({
      where: {
        organizationId: params.organizationId,
        role: "ADMIN",
        deactivatedAt: null,
        id: { not: target.id },
      },
    });
    if (otherAdmins === 0) return { ok: false, reason: "last-admin" };
  }

  await prisma.user.update({
    where: { id: target.id },
    data: { deactivatedAt: params.active ? null : new Date() },
  });
  return { ok: true };
}

/** Same last-admin guard as deactivation, for the same reason: demoting the
 * only ADMIN is just a slower way of locking everyone out. */
export async function setUserRole(params: {
  organizationId: string;
  userId: string;
  actingUserId: string;
  role: "ADMIN" | "MEMBER";
}): Promise<AccessChangeOutcome> {
  const target = await prisma.user.findFirst({
    where: { id: params.userId, organizationId: params.organizationId },
    select: { id: true, role: true, deactivatedAt: true },
  });
  if (!target) return { ok: false, reason: "not-found" };

  if (params.role === "MEMBER" && target.role === "ADMIN" && !target.deactivatedAt) {
    const otherAdmins = await prisma.user.count({
      where: {
        organizationId: params.organizationId,
        role: "ADMIN",
        deactivatedAt: null,
        id: { not: target.id },
      },
    });
    if (otherAdmins === 0) return { ok: false, reason: "last-admin" };
  }

  await prisma.user.update({
    where: { id: target.id },
    data: { role: params.role },
  });
  return { ok: true };
}
