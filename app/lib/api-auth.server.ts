import type { App } from "../../generated/prisma/client";
import { ApiRateLimitError } from "./api-rate-limit.server";
import { findAppByApiKey } from "./app-api-key.server";
import { appIdForIdentifySecret } from "./identify/api-keys.server";
import { prisma } from "./db.server";

/** JSON error Response helper for the public API. */
export function apiError(
  status: number,
  message: string,
  extra?: Record<string, unknown>,
) {
  return Response.json(
    { error: message, ...extra },
    { status, headers: { "Cache-Control": "private, no-store" } },
  );
}

/**
 * Wrap a resource-route handler so thrown Responses (e.g. 401 from
 * requireApiApp) pass through and thrown Errors become a clean 400 JSON body
 * instead of a 500 HTML page.
 */
export async function handleApi(
  fn: () => Promise<Response>,
): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Response) return e;
    if (e instanceof ApiRateLimitError) {
      return Response.json(
        { error: e.message },
        {
          status: 429,
          headers: {
            "Cache-Control": "private, no-store",
            "Retry-After": String(e.retryAfterSeconds),
          },
        },
      );
    }
    return apiError(400, e instanceof Error ? e.message : "Request failed");
  }
}

/**
 * Authenticate an app -> platform public API call. Accepts
 * `Authorization: Bearer <apiKey>` or `X-Api-Key: <apiKey>`. Throws a 401
 * Response (caught by the route) when missing/invalid.
 *
 * `X-App-Id` is VERIFIED when present rather than ignored — an app pointed at
 * the wrong tenant's key would otherwise authenticate silently as whoever owns
 * that key. It must equal `App.id`. It is not accepted as a credential on its
 * own; only the key authenticates.
 */
export async function requireApiApp(request: Request): Promise<App> {
  const authHeader = request.headers.get("authorization");
  const bearer =
    authHeader && authHeader.toLowerCase().startsWith("bearer ")
      ? authHeader.slice(7).trim()
      : null;
  const key = bearer ?? request.headers.get("x-api-key");

  if (!key) {
    throw apiError(
      401,
      "Missing API key (Authorization: Bearer <key> or X-Api-Key)",
    );
  }
  /*
    Two credentials authenticate here, so an app needs ONE secret for the whole
    platform API rather than a different one per endpoint:

      1. `App.apiKey` — looked up by SHA-256 so the hot path never loads the
         plaintext, falling back to the legacy column for rows the backfill has
         not reached (see app-api-key.server).
      2. A key generated on the app's page — the same credential `/v1/identify`
         takes. This is the one apps should be issued going forward; `apiKey` is
         the legacy half.
  */
  let app = await findAppByApiKey(key);
  if (!app) {
    const generatedKeyAppId = await appIdForIdentifySecret(key);
    app = generatedKeyAppId
      ? await prisma.app.findUnique({ where: { id: generatedKeyAppId } })
      : null;
  }
  if (!app) {
    throw apiError(401, "Invalid API key");
  }
  const declaredAppId = request.headers.get("x-app-id")?.trim();
  if (declaredAppId && declaredAppId !== app.id) {
    throw apiError(401, "X-App-Id does not match the authenticated app");
  }
  if (!app.enabled || app.removed || app.scheduledForDeletionAt) {
    throw apiError(403, "App is disabled");
  }
  return app;
}
