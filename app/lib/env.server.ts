import "dotenv/config";

/**
 * Centralised, validated environment access. Import this instead of touching
 * `process.env` directly so a missing required var fails loudly at boot.
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/** A single identify-API app credential (see collectAppCredentials). */
export interface AppCredential {
  appId: string;
  apiKey: string;
}

/**
 * Assemble the identify-API app-credential registry from plain env vars:
 *
 *   IDENTIFY_APP_ID       / IDENTIFY_APP_API_KEY        (the primary app)
 *   IDENTIFY_APP_2_ID     / IDENTIFY_APP_2_API_KEY      (additional apps, 2..N)
 *
 * A slot with neither var set is skipped; a slot with only one of the pair set
 * is a misconfiguration and throws. Duplicate app ids throw. Absent entirely,
 * the registry is empty and every identify request is unauthorized. Exported so
 * the parsing rules can be unit-tested against a plain record.
 */
export function collectAppCredentials(
  source: Record<string, string | undefined> = process.env,
): AppCredential[] {
  const credentials: AppCredential[] = [];
  const seen = new Set<string>();

  const add = (rawId: string | undefined, apiKey: string | undefined, label: string) => {
    const appId = rawId?.trim() ?? "";
    if (!appId && !apiKey) return; // slot absent
    if (!appId || !apiKey) {
      throw new Error(`${label}: both the app id and api key must be set`);
    }
    if (seen.has(appId)) {
      throw new Error(`Duplicate identify app id: ${appId}`);
    }
    seen.add(appId);
    credentials.push({ appId, apiKey });
  };

  add(source.IDENTIFY_APP_ID, source.IDENTIFY_APP_API_KEY, "IDENTIFY_APP_ID");

  // Numbered slots, in ascending order and tolerant of gaps.
  const indices = new Set<number>();
  for (const name of Object.keys(source)) {
    const match = /^IDENTIFY_APP_(\d+)_(?:ID|API_KEY)$/.exec(name);
    if (match) indices.add(Number(match[1]));
  }
  for (const n of [...indices].sort((a, b) => a - b)) {
    add(
      source[`IDENTIFY_APP_${n}_ID`],
      source[`IDENTIFY_APP_${n}_API_KEY`],
      `IDENTIFY_APP_${n}_ID`,
    );
  }

  return credentials;
}

const nodeEnv = process.env.NODE_ENV ?? "development";
const isProduction = nodeEnv === "production";

/**
 * Values that are public — this file's own dev fallback and the placeholders
 * in `.env.example` — and so must never protect a production deployment. A
 * copied example file would otherwise pass the length check below.
 */
function isPublicPlaceholder(value: string): boolean {
  const lowered = value.trim().toLowerCase();
  return (
    lowered === "dev-only-change-me" ||
    lowered.startsWith("replace-with") ||
    lowered.startsWith("change-me") ||
    lowered.includes("change-me")
  );
}

/** In production: present, at least 32 characters, and not a public placeholder. */
function assertStrongSecret(name: string, value: string): void {
  if (!isProduction) return;
  if (value.length < 32) {
    throw new Error(`${name} must be at least 32 characters in production`);
  }
  if (isPublicPlaceholder(value)) {
    throw new Error(`${name} is still a placeholder value; generate a random secret`);
  }
}

const sessionSecret =
  process.env.SESSION_SECRET ??
  (isProduction ? required("SESSION_SECRET") : "dev-only-change-me");
assertStrongSecret("SESSION_SECRET", sessionSecret);
const credentialEncryptionKey =
  process.env.CREDENTIAL_ENCRYPTION_KEY ?? sessionSecret;
assertStrongSecret("CREDENTIAL_ENCRYPTION_KEY", credentialEncryptionKey);
const cronSecret =
  process.env.CRON_SECRET ??
  (isProduction ? required("CRON_SECRET") : sessionSecret);
assertStrongSecret("CRON_SECRET", cronSecret);
const identifyCredentials = collectAppCredentials(process.env);
for (const { appId, apiKey } of identifyCredentials) {
  if (isProduction && isPublicPlaceholder(apiKey)) {
    throw new Error(`Identify API key for ${appId} is still a placeholder value`);
  }
}

export const env = {
  DATABASE_URL: required("DATABASE_URL"),
  /** Public base URL of this platform; used to build Shopify returnUrl. */
  APP_URL: process.env.APP_URL ?? "http://localhost:3000",
  SESSION_SECRET: sessionSecret,
  /**
   * Master key for Partner API tokens stored in the database. Keep it stable
   * across deploys. It falls back to SESSION_SECRET for local compatibility.
   */
  CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey,
  /** Dedicated scheduler credential; mandatory in production. */
  CRON_SECRET: cronSecret,
  /**
   * Master switch for the Partner-API downgrade-credit path. Keep false until
   * per-app Partner credentials are populated (appCreditCreate is Partner API).
   */
  FLEX_PARTNER_CREDITS_ENABLED:
    process.env.FLEX_PARTNER_CREDITS_ENABLED === "true",
  /**
   * Kill switch for the daily-snapshot read path (PartnerDailyMrrSnapshot).
   * Off by default so it only serves traffic once explicitly turned on after
   * the production-data parity check passes and backfill has run — flip to
   * "false" instantly (no redeploy) if real traffic exposes something the
   * parity check missed.
   */
  SNAPSHOT_READ_PATH_ENABLED: process.env.SNAPSHOT_READ_PATH_ENABLED === "true",
  /**
   * Kill switch for the daily install/churn snapshot read path
   * (PartnerDailyInstallSnapshot) — independent of SNAPSHOT_READ_PATH_ENABLED
   * above (different table, different writer, different failure modes). Off
   * by default for the same reason: flip on only after the backfill
   * completes and the production-data parity check passes.
   */
  INSTALL_SNAPSHOT_READ_PATH_ENABLED:
    process.env.INSTALL_SNAPSHOT_READ_PATH_ENABLED === "true",
  /**
   * Kill switch for the local GA4 traffic-event mirror read path
   * (TrafficEventFact) — independent of the two flags above (different
   * table, different upstream (BigQuery, not Partner API), different failure
   * modes). Off by default: flip on only after an app's backfill completes
   * and the production-data parity check (comparing local vs. live BigQuery
   * output field-for-field) passes for that app.
   */
  TRAFFIC_LOCAL_READ_PATH_ENABLED:
    process.env.TRAFFIC_LOCAL_READ_PATH_ENABLED === "true",
  /**
   * Kill switch for the persisted PartnerSubscriptionState/PartnerCustomerState
   * read path (Subscriptions/Customers pages) — independent of the flags
   * above (different tables, incremental per-charge/per-shop writer, no
   * BigQuery/GA4 involvement). Off by default: flip on per the usual rule —
   * only after an app's one-time backfill completes and the production
   * parity check (new read path vs. the existing live-reconstruction query,
   * field-for-field) passes for that app.
   */
  PARTNER_STATE_READ_PATH_ENABLED:
    process.env.PARTNER_STATE_READ_PATH_ENABLED === "true",
  /**
   * Shared cache/coordination store for cluster mode (multiple worker
   * processes). Optional, not required() — this app degrades per call site
   * (stale-but-correct in-process caching, existing in-memory throttles) when
   * Redis is unreachable rather than failing to boot, matching how GA4/BigQuery
   * below are treated. Defaults to a local Redis instance.
   */
  REDIS_URL: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
  /**
   * GA4/BigQuery access for the Traffic Source Report. All optional: the
   * report degrades to "unavailable" rather than failing boot when unset.
   */
  GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  GCP_PROJECT_ID: process.env.GCP_PROJECT_ID,
  GA4_PROPERTY_ID: process.env.GA4_PROPERTY_ID,
  BIGQUERY_DATASET: process.env.BIGQUERY_DATASET,
  /**
   * App-credential registry for the POST /v1/identify endpoint, assembled from
   * the IDENTIFY_APP_ID/IDENTIFY_APP_API_KEY env-var pairs (see
   * collectAppCredentials). Validated against the X-App-Id / X-App-Api-Key
   * request headers. Empty by default — every identify is then unauthorized.
   */
  IDENTIFY_APP_CREDENTIALS: identifyCredentials,
  /** Per-app fixed-window request cap (per minute) for POST /v1/identify. */
  IDENTIFY_RATE_LIMIT: Number(process.env.IDENTIFY_RATE_LIMIT ?? "120"),

  /**
   * Postmark, for transactional mail (password reset). Optional at boot — a
   * send without a token is skipped and logged rather than crashing.
   */
  POSTMARK_SERVER_TOKEN: process.env.POSTMARK_SERVER_TOKEN,
  /** Per-environment Postmark message stream; Postmark's default is "outbound". */
  POSTMARK_MESSAGE_STREAM: process.env.POSTMARK_MESSAGE_STREAM ?? "outbound",
  /**
   * Postmark Account API token (X-Postmark-Account-Token). Account-level —
   * used by `npm run check:postmark` to list Sender Signatures and domains.
   * Optional.
   */
  POSTMARK_ACCOUNT_TOKEN: process.env.POSTMARK_ACCOUNT_TOKEN,
  /**
   * The From address on transactional mail. Must be a confirmed Postmark
   * Sender Signature or on a verified domain.
   */
  MAIL_FROM_ADDRESS: process.env.MAIL_FROM_ADDRESS ?? "no-reply@example.com",
  /** The display name beside MAIL_FROM_ADDRESS — what the inbox shows as sender. */
  MAIL_FROM_NAME: process.env.MAIL_FROM_NAME ?? "Rapi Management",

  NODE_ENV: nodeEnv,
} as const;

export const isProd = env.NODE_ENV === "production";
