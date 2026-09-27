import { timingSafeEqual } from "node:crypto";
import { env } from "./env.server";

/**
 * Whether a request carries the scheduler's `X-Cron-Secret`. Constant-time, so
 * response timing says nothing about how much of a guess was right.
 */
export function hasValidCronSecret(request: Request): boolean {
  const given = Buffer.from(request.headers.get("x-cron-secret") ?? "");
  const expected = Buffer.from(env.CRON_SECRET);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
