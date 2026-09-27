import type { ActionFunctionArgs } from "react-router";
import { env } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { authenticateApp } from "~/lib/identify/app-registry.server";
import { identifyCustomer, parseIdentifyBody } from "~/lib/identify/core.server";
import { prismaCustomerStore } from "~/lib/identify/store.server";
import {
  IdentifyRateLimitError,
  enforceIdentifyRateLimit,
} from "~/lib/identify/rate-limit.server";

const log = logger.scope("identify");
const ROUTE_KEY = "identify";

/**
 * POST /v1/identify (alias: /identify) — "identify customer" upsert.
 *
 * Upserts a customer scoped to the authenticated app and returns that
 * customer's stable, per-customer API token. See app/lib/identify/* for the
 * auth, upsert, and rate-limit building blocks. Request and response are JSON.
 */

function jsonHeaders(requestId: string): HeadersInit {
  return { "X-Request-Id": requestId, "Cache-Control": "no-store" };
}

function identifyError(
  status: number,
  code: string,
  requestId: string,
  extra?: Record<string, unknown>,
) {
  return Response.json(
    { error: code, ...extra },
    { status, headers: jsonHeaders(requestId) },
  );
}

export async function action({ request }: ActionFunctionArgs) {
  const requestId = crypto.randomUUID();

  try {
    if (request.method !== "POST") {
      return identifyError(405, "method_not_allowed", requestId);
    }

    // 1) App-level authentication (constant-time; never reveals which part
    //    failed). Do this before reading the body or touching the database.
    const appId = await authenticateApp(request.headers);
    if (!appId) {
      log.warn("unauthorized", { requestId });
      return identifyError(401, "unauthorized", requestId);
    }

    // 2) Per-app rate limit.
    try {
      await enforceIdentifyRateLimit({
        appId,
        routeKey: ROUTE_KEY,
        limit: env.IDENTIFY_RATE_LIMIT,
      });
    } catch (error) {
      if (error instanceof IdentifyRateLimitError) {
        log.warn("rate_limited", { requestId, appId });
        return Response.json(
          { error: "rate_limited" },
          {
            status: 429,
            headers: {
              ...jsonHeaders(requestId),
              "Retry-After": String(error.retryAfterSeconds),
            },
          },
        );
      }
      throw error;
    }

    // 3) Parse + validate the body. Unknown top-level fields are ignored.
    const raw: unknown = await request.json().catch(() => null);
    const parsed = parseIdentifyBody(raw);
    if (!parsed.ok) {
      return identifyError(422, "validation", requestId, {
        fields: parsed.fields,
      });
    }

    // 4) Upsert and return the stable token.
    const result = await identifyCustomer(
      prismaCustomerStore,
      { appId, platform: parsed.platform, platformId: parsed.platformId },
      parsed.attributes,
    );

    log.info("identified", {
      requestId,
      appId,
      platform: parsed.platform,
      created: result.created,
    });
    return Response.json(
      { apiToken: result.apiToken },
      { headers: jsonHeaders(requestId) },
    );
  } catch (error) {
    log.error("internal_error", {
      requestId,
      message: error instanceof Error ? error.message : String(error),
    });
    return identifyError(500, "internal", requestId);
  }
}

/** Only POST is supported; a GET (or any loader hit) returns 405 in-shape. */
export async function loader() {
  const requestId = crypto.randomUUID();
  return identifyError(405, "method_not_allowed", requestId);
}
