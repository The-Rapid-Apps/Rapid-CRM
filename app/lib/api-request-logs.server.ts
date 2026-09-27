import type { Prisma } from "../../generated/prisma/client";
import type { MiddlewareFunction } from "react-router";
import { prisma } from "./db.server";
import { hashAppApiKey } from "./app-api-key.server";
import { authenticateApp } from "./identify/app-registry.server";

const MAX_PAYLOAD_BYTES = 32_000;
const MAX_DEPTH = 8;
const MAX_COLLECTION_ITEMS = 100;
const SENSITIVE_KEY =
  /(^|[-_])(authorization|cookie|set-cookie|password|passwd|secret|token|access-token|api-key|api-secret|apikey|signature|hmac|session|credential|confirmation-url)s?($|[-_])/i;

type JsonRecord = Record<string, unknown>;

function isSensitiveKey(key: string) {
  return SENSITIVE_KEY.test(
    key.replace(/([a-z\d])([A-Z])/g, "$1-$2").replaceAll("_", "-"),
  );
}

/** The identify surface: /v1 and everything under it. */
function isV1(url: URL) {
  return url.pathname === "/v1" || url.pathname.startsWith("/v1/");
}

export function shouldCaptureApiRequest(url: URL) {
  return (
    url.pathname.startsWith("/api/flex/") ||
    url.pathname === "/api/discounts" ||
    url.pathname.startsWith("/api/discounts/") ||
    isV1(url)
  );
}

export function redactApiLogValue(value: unknown, depth = 0): unknown {
  if (depth >= MAX_DEPTH) return "[MAX_DEPTH]";
  if (value === null || typeof value !== "object") return value;

  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_COLLECTION_ITEMS)
      .map((item) => redactApiLogValue(item, depth + 1));
    if (value.length > MAX_COLLECTION_ITEMS) {
      items.push(`[${value.length - MAX_COLLECTION_ITEMS} MORE ITEMS]`);
    }
    return items;
  }

  const entries = Object.entries(value as JsonRecord).slice(
    0,
    MAX_COLLECTION_ITEMS,
  );
  const result: JsonRecord = {};
  for (const [key, nested] of entries) {
    result[key] = isSensitiveKey(key)
      ? "[FILTERED]"
      : redactApiLogValue(nested, depth + 1);
  }
  if (Object.keys(value as JsonRecord).length > MAX_COLLECTION_ITEMS) {
    result._truncatedKeys = true;
  }
  return result;
}

function boundedJson(value: unknown): Prisma.InputJsonValue {
  const redacted = redactApiLogValue(value);
  if (redacted === null) return { value: null };
  const serialized = JSON.stringify(redacted);
  if (Buffer.byteLength(serialized, "utf8") <= MAX_PAYLOAD_BYTES) {
    return redacted as Prisma.InputJsonValue;
  }
  return {
    _truncated: true,
    preview: serialized.slice(0, MAX_PAYLOAD_BYTES),
  };
}

function headersToJson(headers: Headers) {
  return boundedJson(Object.fromEntries(headers.entries()));
}

async function readJsonPayload(
  message: Request | Response,
): Promise<Prisma.InputJsonValue | undefined> {
  const contentType = message.headers.get("content-type")?.toLowerCase() ?? "";
  if (
    !contentType.includes("application/json") &&
    !contentType.includes("application/x-www-form-urlencoded") &&
    !contentType.startsWith("text/")
  ) {
    return undefined;
  }

  const declaredLength = Number(message.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_PAYLOAD_BYTES * 4) {
    return { _truncated: true, reason: "Payload exceeds capture limit" };
  }

  try {
    const text = await message.clone().text();
    if (!text) return undefined;
    if (contentType.includes("application/json")) {
      return boundedJson(JSON.parse(text));
    }
    if (contentType.includes("application/x-www-form-urlencoded")) {
      return boundedJson(Object.fromEntries(new URLSearchParams(text)));
    }
    return boundedJson({ text });
  } catch {
    return { _captureError: "Payload could not be decoded" };
  }
}

function apiKeyFrom(request: Request) {
  const authorization = request.headers.get("authorization");
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }
  return request.headers.get("x-api-key");
}

function stringField(value: unknown) {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 255)
    : null;
}

function inferCustomer(url: URL, requestBody: unknown) {
  const body =
    requestBody && typeof requestBody === "object"
      ? (requestBody as JsonRecord)
      : {};
  return (
    stringField(url.searchParams.get("shopDomain")) ??
    stringField(url.searchParams.get("customer")) ??
    stringField(body.shopDomain) ??
    stringField(body.myshopifyDomain) ??
    stringField(body.customer) ??
    null
  );
}

function requestIp(request: Request) {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-real-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    null
  );
}

export function redactApiLogQuery(url: URL) {
  const params = new URLSearchParams();
  for (const [key, value] of url.searchParams) {
    params.append(key, isSensitiveKey(key) ? "[FILTERED]" : value);
  }
  return params.size ? params.toString() : null;
}

interface RequestScope {
  /** apps.id, or null when the traffic can't be tied to an App row. */
  id: string | null;
  organizationId: string;
}

async function resolveAppScope(request: Request): Promise<RequestScope | null> {
  const apiKey = apiKeyFrom(request);
  if (!apiKey) return null;
  // By hash, like the auth path, so logging never loads the plaintext key.
  // Falls back to the legacy column for rows the backfill has not reached.
  const app =
    (await prisma.app.findUnique({
      where: { apiKeyHash: hashAppApiKey(apiKey) },
      select: { id: true, organizationId: true },
    })) ??
    (await prisma.app.findUnique({
      where: { apiKey },
      select: { id: true, organizationId: true },
    }));
  return app;
}

/**
 * Scope for a /v1 (identify) request.
 *
 * Unlike the flex/discounts surface, /v1 authenticates through the identify
 * registry (X-App-Id / X-App-Api-Key), not an apps.apiKey, so we
 * authenticate the same way the /v1 routes do and only log a request whose
 * credentials check out — mirroring resolveAppScope, which logs nothing when
 * the apiKey doesn't resolve. The identify app id is an opaque external
 * identifier: when it is also a real apps.id we attribute the log to that app;
 * otherwise we fall back to the sole organization (with no app link) so the
 * traffic is still visible, and skip only when the org is ambiguous.
 */
async function resolveV1Scope(request: Request): Promise<RequestScope | null> {
  const appId = await authenticateApp(request.headers);
  if (!appId) return null;

  const app = await prisma.app.findUnique({
    where: { id: appId },
    select: { id: true, organizationId: true },
  });
  if (app) return app;

  const orgs = await prisma.organization.findMany({
    select: { id: true },
    take: 2,
  });
  return orgs.length === 1 ? { id: null, organizationId: orgs[0]!.id } : null;
}

/**
 * Captures developer-facing API traffic after route execution. The body is
 * read from a clone, all credential-shaped fields are filtered, and logging
 * failures never change the API response.
 */
export const apiRequestLogMiddleware: MiddlewareFunction<Response> = async (
  { request },
  next,
) => {
  const url = new URL(request.url);
  if (!shouldCaptureApiRequest(url)) return next();

  const startedAt = performance.now();
  const requestId =
    request.headers.get("x-request-id")?.slice(0, 64) ?? crypto.randomUUID();
  const requestBodyPromise =
    request.method === "GET" || request.method === "HEAD"
      ? Promise.resolve(undefined)
      : readJsonPayload(request);

  const response = await next();
  const durationMs = performance.now() - startedAt;

  try {
    response.headers.set("X-Request-Id", requestId);
  } catch {
    // Some framework-owned response headers are immutable. The log still has
    // a request id even when it cannot be echoed to the caller.
  }

  try {
    const scope = isV1(url)
      ? await resolveV1Scope(request)
      : await resolveAppScope(request);
    if (!scope) return response;

    const [requestBody, responseBody] = await Promise.all([
      requestBodyPromise,
      readJsonPayload(response),
    ]);

    await prisma.apiRequestLog.create({
      data: {
        organizationId: scope.organizationId,
        appId: scope.id,
        requestId,
        method: request.method.slice(0, 10).toUpperCase(),
        path: url.pathname.slice(0, 500),
        query: redactApiLogQuery(url),
        status: response.status,
        durationMs,
        ipAddress: requestIp(request)?.slice(0, 64) ?? null,
        userAgent: request.headers.get("user-agent"),
        customer: inferCustomer(url, requestBody),
        requestHeaders: headersToJson(request.headers),
        requestBody,
        responseHeaders: headersToJson(response.headers),
        responseBody,
      },
    });
  } catch (error) {
    console.warn("[api-request-log] Capture failed", {
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return response;
};
