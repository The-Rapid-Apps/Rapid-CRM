import { createCookieSessionStorage, redirect } from "react-router";
import { prisma } from "../db.server";
import { env, isProd } from "../env.server";

/**
 * Signed, httpOnly cookie session for the dashboard. Stores only the user id
 * and when the session was issued — the full row is loaded from the DB per
 * request, so a revoked/disabled user loses access immediately rather than at
 * cookie expiry.
 *
 * `issuedAt` is what makes a password reset a real remedy: the cookie is
 * stateless, so without it a stolen session would outlive any number of
 * password changes. Sessions older than `User.sessionsValidFrom` are rejected.
 */
const sessionStorage = createCookieSessionStorage<{ userId: string; issuedAt: number }>({
  cookie: {
    name: "__rapi_dashboard_session",
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secrets: [env.SESSION_SECRET],
    secure: isProd,
    maxAge: 60 * 60 * 24 * 30, // 30 days
  },
});

function getSession(request: Request) {
  return sessionStorage.getSession(request.headers.get("Cookie"));
}

/** The Set-Cookie value for a fresh session — for responses that set more
 * than one cookie. `createUserSession` is the usual entry point. */
export async function commitUserSession(userId: string): Promise<string> {
  const session = await sessionStorage.getSession();
  session.set("userId", userId);
  session.set("issuedAt", Date.now());
  return sessionStorage.commitSession(session);
}

export async function createUserSession(userId: string, redirectTo: string) {
  return redirect(redirectTo, {
    headers: { "Set-Cookie": await commitUserSession(userId) },
  });
}

/**
 * Ends every session this user has, everywhere. Call it wherever the password
 * changes, then issue the caller a new session if they should stay signed in.
 *
 * A millisecond before now, so a session issued in the same request (after
 * this call) is on the right side of the cut-off even on a coarse clock.
 */
export async function revokeUserSessions(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { sessionsValidFrom: new Date(Date.now() - 1) },
  });
}

export async function destroyUserSession(request: Request) {
  const session = await getSession(request);
  return redirect("/login", {
    headers: { "Set-Cookie": await sessionStorage.destroySession(session) },
  });
}

/**
 * Returns the signed-in user, or null. Use where a route renders either way.
 *
 * A deactivated user reads as signed out. Because this row is re-read on every
 * request, deactivating someone ends their live sessions on the next
 * navigation — which is what makes "remove access" a real remedy rather than a
 * note that takes effect whenever their cookie happens to expire.
 */
export async function getUser(request: Request) {
  const session = await getSession(request);
  const userId = session.get("userId");
  if (!userId) return null;
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || user.deactivatedAt) return null;
  /* A cookie from before the last password change is dead. Cookies issued
     before `issuedAt` existed carry none: they survive until that user's
     first change, rather than everyone being signed out by the deploy. */
  if (user.sessionsValidFrom) {
    const issuedAt = session.get("issuedAt");
    if (typeof issuedAt !== "number" || issuedAt < user.sessionsValidFrom.getTime()) {
      return null;
    }
  }
  return user;
}

/**
 * Guards a dashboard route: redirects to `/login?redirectTo=...` when signed
 * out, otherwise returns the user row.
 */
export async function requireUser(request: Request) {
  const user = await getUser(request);
  if (!user) {
    const url = new URL(request.url);
    const params = new URLSearchParams({
      redirectTo: url.pathname + url.search,
    });
    throw redirect(`/login?${params}`);
  }
  return user;
}

/**
 * Guards a route that administers the dashboard itself. Redirects a signed-out
 * visitor to login, and sends a signed-in MEMBER back to the overview.
 *
 * Must be called in the LOADER and in the ACTION of every such route. Hiding a
 * nav link is presentation, not an access check — a POST never goes through
 * the nav.
 */
export async function requireAdmin(request: Request) {
  const user = await requireUser(request);
  if (user.role !== "ADMIN") throw redirect("/app");
  return user;
}
