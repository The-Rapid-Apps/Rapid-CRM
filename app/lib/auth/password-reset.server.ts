import { createHash, randomBytes } from "node:crypto";
import { prisma } from "../db.server";
import { env, isProd } from "../env.server";
import { sendWithTemplate } from "../postmark.server";
import { logger } from "../logger.server";
import { AUTH_MESSAGE_STREAM, mailSender } from "../mail-sender.server";
import { hashPassword } from "./password.server";
import {
  isWellFormedToken,
  passwordProblem,
  resetLinkOrigin,
  RESET_DONE_TEMPLATE_ALIAS,
  RESET_TEMPLATE_ALIAS,
  RESET_TTL_MINUTES,
} from "./password-reset.shared";
import { bumpAttempts } from "./throttle.server";

/**
 * "Forgot password" for the dashboard.
 *
 * The properties that make it safe, and where each one lives:
 *   - No account enumeration. `requestPasswordReset` returns nothing and the
 *     route answers identically — and immediately — whether or not the address
 *     exists; the lookup and the email happen after the response is decided.
 *   - Tokens are 32 random bytes, and only their SHA-256 is stored, so reading
 *     the table does not yield a working link.
 *   - Single use, 30 minutes, and a new request expires every older link.
 *   - Redemption is one conditional UPDATE, so two tabs racing the same link
 *     cannot both set a password.
 *   - Links are built from the configured origin, never the request's Host
 *     header (see `resetLinkOrigin`).
 *   - Link and open tracking are off on these emails, so the token never
 *     passes through a click redirector.
 *   - A reset ends every existing session (`sessionsValidFrom`) and emails a
 *     "your password was changed" notice, so a reset the owner did not make
 *     is visible to them.
 *   - Rate-limited per address and per client.
 */

const log = logger.scope("password-reset");

export { RESET_DONE_TEMPLATE_ALIAS, RESET_TEMPLATE_ALIAS } from "./password-reset.shared";

/* Auth mail rides the auth stream, which exists to keep its reputation clean. */
const AUTH_STREAM = AUTH_MESSAGE_STREAM;

const EMAIL_LIMIT = 3;
const EMAIL_WINDOW_MS = 60 * 60 * 1000;
const CLIENT_LIMIT = 10;
const CLIENT_WINDOW_MS = 60 * 60 * 1000;
/** A double-click, or "send again" before the first arrived, is not a second email. */
const RESEND_COOLDOWN_MS = 60 * 1000;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function brand() {
  const year = String(new Date().getUTCFullYear());
  return {
    product_name: "Rapid Apps",
    productName: "Rapid Apps",
    company_name: "Rapid Apps",
    companyName: "Rapid Apps",
    current_year: year,
    currentYear: year,
  };
}

/**
 * Issue and email a reset link, if the address belongs to an active user.
 *
 * Never throws and returns nothing: the caller must not be able to tell a real
 * account from a stranger's, and a failed send is logged rather than surfaced.
 */
export async function requestPasswordReset(params: {
  email: string;
  clientKey: string;
}): Promise<void> {
  const email = params.email.trim().toLowerCase();
  if (!email || email.length > 320) return;

  try {
    /* Both limits count every request, found or not, so the limiter itself
       cannot be used to probe which addresses exist. */
    const byEmail = await bumpAttempts(`dash-reset:email:${email}`, EMAIL_WINDOW_MS);
    const byClient = await bumpAttempts(`dash-reset:client:${params.clientKey}`, CLIENT_WINDOW_MS);
    if (byEmail > EMAIL_LIMIT || byClient > CLIENT_LIMIT) {
      log.warn("password reset throttled", { byEmail: byEmail > EMAIL_LIMIT });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, name: true, deactivatedAt: true },
    });
    if (!user || user.deactivatedAt) return;

    const now = new Date();
    const recent = await prisma.userPasswordReset.findFirst({
      where: {
        userId: user.id,
        usedAt: null,
        expiresAt: { gt: now },
        createdAt: { gt: new Date(now.getTime() - RESEND_COOLDOWN_MS) },
      },
      select: { id: true },
    });
    if (recent) return;

    const token = randomBytes(32).toString("base64url");
    await prisma.$transaction([
      // One live link at a time: asking again kills the previous one.
      prisma.userPasswordReset.updateMany({
        where: { userId: user.id, usedAt: null, expiresAt: { gt: now } },
        data: { expiresAt: now },
      }),
      prisma.userPasswordReset.create({
        data: {
          userId: user.id,
          tokenHash: sha256(token),
          expiresAt: new Date(now.getTime() + RESET_TTL_MINUTES * 60 * 1000),
        },
      }),
    ]);

    if (!env.POSTMARK_SERVER_TOKEN) {
      // Local development only; no token means no production mail either.
      log.warn("POSTMARK_SERVER_TOKEN unset; reset link not emailed", {
        resetUrl: `${resetLinkOrigin(env.APP_URL, isProd)}/reset-password?token=${token}`,
      });
      return;
    }

    await sendWithTemplate({
      from: mailSender(),
      to: user.email,
      templateAlias: RESET_TEMPLATE_ALIAS,
      templateModel: {
        name: user.name?.trim().split(/\s+/)[0] || "there",
        action_url: `${resetLinkOrigin(env.APP_URL, isProd)}/reset-password?token=${token}`,
        expires_in: `${RESET_TTL_MINUTES} minutes`,
        ...brand(),
      },
      messageStream: AUTH_STREAM,
      trackLinks: "None",
      trackOpens: false,
    });
  } catch (err) {
    // No address in the log: these logs are read more widely than the team list.
    log.error("password reset request failed", { err: String(err) });
  }
}

/** The account a token would reset, if it is still good. Does not consume it. */
export async function readPasswordReset(
  token: string | null | undefined,
): Promise<{ email: string } | null> {
  if (!isWellFormedToken(token)) return null;
  const row = await prisma.userPasswordReset.findUnique({
    where: { tokenHash: sha256(token) },
    select: {
      usedAt: true,
      expiresAt: true,
      user: { select: { email: true, deactivatedAt: true } },
    },
  });
  if (!row || row.usedAt || row.expiresAt <= new Date() || row.user.deactivatedAt) return null;
  return { email: row.user.email };
}

export type ResetOutcome =
  | { ok: true; userId: string }
  | { ok: false; reason: "invalid" | "weak"; message: string };

/**
 * Redeem a token and set the new password.
 *
 * The token is consumed by a single conditional UPDATE — unused, unexpired,
 * matching hash — so of two simultaneous submissions exactly one wins, and a
 * validation failure (weak password) consumes nothing and can be retried.
 */
export async function completePasswordReset(params: {
  token: string | null | undefined;
  password: string;
  confirm: string;
}): Promise<ResetOutcome> {
  const invalid = {
    ok: false as const,
    reason: "invalid" as const,
    message: "This reset link has expired or was already used. Request a new one.",
  };
  if (!isWellFormedToken(params.token)) return invalid;
  const tokenHash = sha256(params.token);

  const pending = await prisma.userPasswordReset.findUnique({
    where: { tokenHash },
    select: {
      userId: true,
      usedAt: true,
      expiresAt: true,
      user: { select: { email: true, name: true, deactivatedAt: true } },
    },
  });
  // Checked up front so a dead link says so rather than critiquing the password;
  // the UPDATE below re-checks, which is what actually decides.
  if (!pending || pending.usedAt || pending.expiresAt <= new Date() || pending.user.deactivatedAt) {
    return invalid;
  }

  const problem = passwordProblem(params.password, params.confirm, pending.user.email);
  if (problem) return { ok: false, reason: "weak", message: problem };

  // Hashed before the transaction: scrypt is slow and must not hold row locks.
  const passwordHash = await hashPassword(params.password);
  const now = new Date();
  const redeemed = await prisma.$transaction(async (tx) => {
    const claimed = await tx.userPasswordReset.updateMany({
      where: { tokenHash, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (claimed.count !== 1) return false;
    await tx.user.update({
      where: { id: pending.userId },
      // Every session from before this instant is dead — see session.server.ts.
      data: { passwordHash, sessionsValidFrom: new Date(now.getTime() - 1) },
    });
    // Any other link still in an inbox dies with it.
    await tx.userPasswordReset.updateMany({
      where: { userId: pending.userId, usedAt: null },
      data: { expiresAt: now },
    });
    return true;
  });
  if (!redeemed) return invalid;

  log.info("password reset completed", { userId: pending.userId });
  await notifyPasswordChanged(pending.user.email, pending.user.name);
  return { ok: true, userId: pending.userId };
}

/**
 * "Your password was changed" — the owner's only signal that a reset they did
 * not make happened. Never throws: the password is already changed.
 */
export async function notifyPasswordChanged(email: string, name: string | null): Promise<void> {
  if (!env.POSTMARK_SERVER_TOKEN) return;
  try {
    await sendWithTemplate({
      from: mailSender(),
      to: email,
      templateAlias: RESET_DONE_TEMPLATE_ALIAS,
      templateModel: {
        name: name?.trim().split(/\s+/)[0] || "there",
        changed_at: `${new Date().toUTCString().replace(" GMT", "")} UTC`,
        action_url: `${resetLinkOrigin(env.APP_URL, isProd)}/forgot-password`,
        ...brand(),
      },
      messageStream: AUTH_STREAM,
      trackLinks: "None",
      trackOpens: false,
    });
  } catch (err) {
    log.error("password-changed notice failed", { err: String(err) });
  }
}
