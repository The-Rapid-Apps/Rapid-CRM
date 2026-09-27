import { createHash, timingSafeEqual } from "node:crypto";
import { env } from "../env.server";
import type { AppCredential } from "../env.server";
import { resolveIdentifyApiKey } from "./api-keys.server";
import { findAppByApiKey } from "../app-api-key.server";

/**
 * App-level authentication for the identify API.
 *
 * Every request carries a public app identifier and a secret app API key:
 *
 *   X-App-Id:      <app UUID>
 *   X-App-Api-Key: <app secret>
 *
 * The valid `(appId, apiKey)` pairs come from configuration — one pair per app
 * via plain env vars (IDENTIFY_APP_ID/IDENTIFY_APP_API_KEY, plus numbered
 * IDENTIFY_APP_2_ID/IDENTIFY_APP_2_API_KEY, … for more apps); see env.server's
 * collectAppCredentials. This surface is deliberately separate from the
 * platform's own App/apiKey auth (see api-auth.server.ts): an identify app id
 * is an opaque external identifier, not a row in the `apps` table.
 */

export const APP_ID_HEADER = "x-app-id";
export const APP_API_KEY_HEADER = "x-app-api-key";

/** The first of these headers that carries a non-blank value. */
function firstHeader(headers: Headers, ...names: string[]): string {
  for (const name of names) {
    const value = headers.get(name);
    if (value !== null && value.trim() !== "") return value;
  }
  return "";
}

/** Build an appId → apiKey lookup from the configured credential list. */
export function buildRegistry(
  credentials: readonly AppCredential[] = env.IDENTIFY_APP_CREDENTIALS,
): Map<string, string> {
  const registry = new Map<string, string>();
  for (const { appId, apiKey } of credentials) registry.set(appId, apiKey);
  return registry;
}

let cachedRegistry: Map<string, string> | undefined;

/** Lazily-built, process-cached registry from the environment. */
export function appRegistry(): Map<string, string> {
  if (!cachedRegistry) cachedRegistry = buildRegistry();
  return cachedRegistry;
}

/**
 * Constant-time string equality. Both sides are hashed to a fixed-length digest
 * first so the comparison neither throws on nor leaks the length difference
 * between the candidate and the expected secret.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Resolve a request's app credentials, against the env registry first and then
 * the keys developers generate on the app's page.
 *
 * Returns the authenticated `appId` on success, or `null` when a header is
 * missing or the pair doesn't match a known app. The env comparison is always
 * constant time — including against a dummy value when the appId is unknown —
 * so neither the outcome nor the timing reveals which part failed.
 *
 * Two sources, deliberately, and in this order:
 *
 *   1. `IDENTIFY_APP_CREDENTIALS` from the environment. Unchanged, and checked
 *      first so an app configured before keys were issuable keeps working
 *      exactly as it did — no deploy turns an existing integration off.
 *   2. `identify_api_keys`, looked up by the SHA-256 of the presented secret
 *      (see api-keys.server). This is the path the UI issues into, and the one
 *      new apps should use.
 *
 * Env credentials are legacy: once an app's key is issued here and its callers
 * moved over, drop its `IDENTIFY_APP_*` pair.
 */
export async function authenticateApp(
  headers: Headers,
  registry: Map<string, string> = appRegistry(),
): Promise<string | null> {
  const appId = firstHeader(headers, APP_ID_HEADER).trim();
  const apiKey = firstHeader(headers, APP_API_KEY_HEADER);

  const expected = appId ? registry.get(appId) : undefined;
  // Compare even when the app is unknown, against a fixed dummy, so the code
  // path and its timing are identical whether or not the appId exists.
  const matches = constantTimeEqual(apiKey, expected ?? "\0unknown-app\0");
  if (expected !== undefined && matches) return appId;

  // Not in the env registry — try the generated keys. `resolveIdentifyApiKey`
  // finds the row BY the hash of the secret, so locating it is the comparison,
  // and it re-checks that the key belongs to the app id presented.
  const generated = await resolveIdentifyApiKey(appId, apiKey);
  if (generated) return generated;

  /*
    Finally the app's own platform key, so one credential works across the whole
    API instead of identify needing its own.

    The app id is verified rather than trusted, exactly as requireApiApp does:
    the key alone decides which app, and a mismatched X-App-Id is a
    rejection, not something to ignore.
  */
  if (!appId || !apiKey) return null;
  const app = await findAppByApiKey(apiKey);
  if (!app || app.id !== appId) return null;
  if (!app.enabled || app.removed || app.scheduledForDeletionAt) return null;
  return app.id;
}
