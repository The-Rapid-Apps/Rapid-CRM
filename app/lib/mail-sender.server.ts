import { env } from "./env.server";

/**
 * A Postmark message stream of its own for auth mail (password reset).
 *
 * Deliverability reputation is tracked PER STREAM: a sign-in or reset link in
 * spam locks someone out, so auth mail gets its own reputation to spoil or keep.
 */
export const AUTH_MESSAGE_STREAM = "auth";

/**
 * Who transactional mail comes from: "Display Name" <address>.
 *
 * Must be a verified Postmark Sender Signature or on a verified domain, or
 * every send fails. Configurable because that verification is a DNS fact about
 * the deployment, not something this code can know.
 */
export function mailSender(displayName: string = env.MAIL_FROM_NAME): string {
  const address = env.MAIL_FROM_ADDRESS.trim();
  // Already "Name <address>" in the environment: that wins, as configured.
  if (address.includes("<") || !displayName.trim()) return address;
  // Quoted, and any quote in the name escaped, so a name with punctuation stays one token.
  const name = displayName.trim().replace(/(["\\])/g, "\\$1");
  return `"${name}" <${address}>`;
}
