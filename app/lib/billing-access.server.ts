import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "./env.server";

export const BILLING_ACCESS_QUERY_PARAM = "token";
export const DEFAULT_BILLING_ACCESS_TTL_SECONDS = 15 * 60;

const TOKEN_VERSION = 1;
const SIGNING_CONTEXT = "rapi:merchant-billing:v1";

interface BillingAccessPayload {
  v: typeof TOKEN_VERSION;
  installId: string;
  exp: number;
}

export interface BillingAccessGrant {
  token: string;
  installId: string;
  expiresAt: Date;
}

export interface SignedBillingUrl extends BillingAccessGrant {
  url: string;
}

interface IssueOptions {
  ttlSeconds?: number;
  now?: Date;
}

function signatureFor(encodedPayload: string): Buffer {
  return createHmac("sha256", env.SESSION_SECRET)
    .update(SIGNING_CONTEXT)
    .update("\0")
    .update(encodedPayload)
    .digest();
}

function parsePayload(encodedPayload: string): BillingAccessPayload | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as Partial<BillingAccessPayload>;
    if (
      parsed.v !== TOKEN_VERSION ||
      typeof parsed.installId !== "string" ||
      parsed.installId.length === 0 ||
      !Number.isSafeInteger(parsed.exp)
    ) {
      return null;
    }
    return parsed as BillingAccessPayload;
  } catch {
    return null;
  }
}

/** Issue a short-lived bearer token bound to exactly one app install. */
export function createBillingAccessToken(
  installId: string,
  options: IssueOptions = {},
): BillingAccessGrant {
  if (!installId) throw new Error("installId is required");

  const now = options.now ?? new Date();
  const ttlSeconds = Math.floor(
    options.ttlSeconds ?? DEFAULT_BILLING_ACCESS_TTL_SECONDS,
  );
  if (
    !Number.isFinite(now.getTime()) ||
    !Number.isSafeInteger(ttlSeconds) ||
    ttlSeconds < 1
  ) {
    throw new Error("Billing access token TTL must be positive");
  }

  const expiresAtEpochSeconds = Math.floor(now.getTime() / 1000) + ttlSeconds;
  const expiresAt = new Date(expiresAtEpochSeconds * 1000);
  const payload: BillingAccessPayload = {
    v: TOKEN_VERSION,
    installId,
    exp: expiresAtEpochSeconds,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
    "base64url",
  );
  const signature = signatureFor(encodedPayload).toString("base64url");

  return {
    token: `${encodedPayload}.${signature}`,
    installId,
    expiresAt,
  };
}

/**
 * Validate signature, expiry, and install binding. Returns null for every
 * invalid-token shape so callers do not disclose which check failed.
 */
export function verifyBillingAccessToken(
  token: string,
  expectedInstallId: string,
  now = new Date(),
): BillingAccessGrant | null {
  if (!token || token.length > 2_048) return null;

  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [encodedPayload, encodedSignature] = parts;
  if (!encodedPayload || !encodedSignature) return null;

  let suppliedSignature: Buffer;
  try {
    suppliedSignature = Buffer.from(encodedSignature, "base64url");
  } catch {
    return null;
  }
  const expectedSignature = signatureFor(encodedPayload);
  if (
    suppliedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(suppliedSignature, expectedSignature)
  ) {
    return null;
  }

  const payload = parsePayload(encodedPayload);
  if (
    !payload ||
    payload.installId !== expectedInstallId ||
    payload.exp <= Math.floor(now.getTime() / 1000)
  ) {
    return null;
  }

  return {
    token,
    installId: payload.installId,
    expiresAt: new Date(payload.exp * 1000),
  };
}

function tokenFromRequest(request: Request): string | null {
  const urlToken = new URL(request.url).searchParams.get(
    BILLING_ACCESS_QUERY_PARAM,
  );
  if (urlToken) return urlToken;

  const authorization = request.headers.get("authorization");
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim() || null;
  }
  return request.headers.get("x-billing-access-token");
}

/** Guard a merchant-facing billing loader/action with a signed install token. */
export function requireBillingAccess(
  request: Request,
  expectedInstallId: string,
): BillingAccessGrant {
  const token = tokenFromRequest(request);
  const grant = token
    ? verifyBillingAccessToken(token, expectedInstallId)
    : null;
  if (!grant) {
    throw new Response("This billing link is invalid or has expired.", {
      status: 401,
      headers: { "Cache-Control": "no-store" },
    });
  }
  return grant;
}

/** Build the merchant plan-picker URL returned to the app's authenticated API. */
export function createSignedBillingUrl(
  installId: string,
  options: IssueOptions & { baseUrl?: string } = {},
): SignedBillingUrl {
  const grant = createBillingAccessToken(installId, options);
  const url = new URL(
    `/billing/${encodeURIComponent(installId)}`,
    options.baseUrl ?? env.APP_URL,
  );
  url.searchParams.set(BILLING_ACCESS_QUERY_PARAM, grant.token);
  return { ...grant, url: url.toString() };
}
