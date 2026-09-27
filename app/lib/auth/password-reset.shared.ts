/**
 * The parts of "forgot password" that need no database, kept apart so they
 * can be tested directly and imported by the route component.
 */

/**
 * Postmark template aliases. Here rather than in password-reset.server.ts so
 * scripts can name them without importing that module — it pulls in the Redis
 * client, which connects on import and keeps a one-shot script from exiting.
 */
export const RESET_TEMPLATE_ALIAS = "dashboard-password-reset";
export const RESET_DONE_TEMPLATE_ALIAS = "dashboard-password-changed";

/** Same floor the Account page and `npm run user:reset` enforce. */
export const MIN_PASSWORD_LENGTH = 8;
/**
 * A ceiling, because scrypt's cost grows with input: without one, a
 * multi-megabyte "password" is a cheap way to tie up the thread pool.
 */
export const MAX_PASSWORD_LENGTH = 256;

/**
 * Scope of the cookie that carries the token from the emailed link to the
 * form. Site-wide, NOT `/reset-password`: React Router submits the form to
 * `/reset-password.data`, and a cookie path only matches its exact path or
 * paths under it followed by "/" — so `/reset-password` silently left the
 * token off every save and the page could only ever say "link can't be
 * used". The cookie stays httpOnly, Secure, Lax,
 * short-lived, and is cleared the moment the reset succeeds.
 */
export const RESET_COOKIE_PATH = "/";

/** How long an emailed link works. Short: it is a password in an inbox. */
export const RESET_TTL_MINUTES = 30;

/** 32 random bytes, base64url — what `randomBytes(32).toString("base64url")` makes. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** Cheap shape check before any hashing or lookup, so junk never reaches the DB. */
export function isWellFormedToken(token: string | null | undefined): token is string {
  return typeof token === "string" && TOKEN_SHAPE.test(token);
}

/** The first thing wrong with a proposed password, or null. */
export function passwordProblem(
  password: string,
  confirm: string,
  email: string,
): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Use at most ${MAX_PASSWORD_LENGTH} characters.`;
  }
  if (password !== confirm) return "The two passwords don't match.";
  const lowered = password.toLowerCase();
  const local = email.toLowerCase().split("@")[0] ?? "";
  if (lowered === email.toLowerCase() || (local.length >= 4 && lowered.includes(local))) {
    return "Don't build your password from your email address.";
  }
  return null;
}

/**
 * Where reset links point: the CONFIGURED dashboard origin, never the Host
 * header of the request that asked for one. Taking it from the request is the
 * classic reset-poisoning hole — an attacker submits a victim's address with
 * `Host: attacker.example`, and the victim's genuine email carries a link that
 * hands the token to the attacker's server.
 *
 * Upgraded to https outside localhost in production: the configured value on
 * the server is `http://…`, and a token must not cross the network in clear.
 */
export function resetLinkOrigin(appUrl: string, production: boolean): string {
  const url = new URL(appUrl);
  const local = url.hostname === "localhost" || url.hostname.startsWith("127.");
  if (production && !local) url.protocol = "https:";
  return url.origin;
}
