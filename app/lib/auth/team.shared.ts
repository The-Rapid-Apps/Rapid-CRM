/**
 * Team-management values the BROWSER needs as well as the server.
 *
 * Split out because importing `team.server.ts` from a component body pulls the
 * whole server module — Prisma included — into the client bundle. `npm run
 * typecheck` does not catch that; only `npm run build` does, and it did.
 */

/** Long beats clever: a 12-character passphrase resists guessing far better
 * than 8 characters of punctuation, and people actually remember it. Enforced
 * server-side in `acceptUserInvite`; the browser only uses it to say so before
 * the round trip. */
export const MIN_PASSWORD_LENGTH = 12;

/** A dashboard invite creates an account with full access, so the link is a
 * credential and is short-lived. */
export const INVITE_TTL_MS = 24 * 60 * 60 * 1000;

/** Addresses are compared case-insensitively: `users.email` is UNIQUE, and
 * letting `Prosper@` and `prosper@` both exist would mean two logins for one
 * person. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Deliberately permissive — enough to catch a fumbled paste, not a spec.
 * There is no domain restriction: contractors and agency staff are expected. */
export function looksLikeEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}
