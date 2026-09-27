import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { encryptCredential } from "../credential-encryption.server";

/**
 * Framework-agnostic core of the identify endpoint: request validation, secure
 * token generation, and the upsert/merge/token-stability algorithm.
 *
 * The persistence layer is abstracted behind {@link CustomerStore} so this
 * logic can be unit-tested without a database. The production store lives in
 * store.server.ts. This module intentionally imports no database code.
 */

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// platformId is the identity's stable key and is always stored/compared as a
// string. Callers on numeric-id platforms (e.g. Shopify shop/app ids like
// 51944489112) naturally send it as a JSON number, so accept a finite number
// and normalize it to a string rather than rejecting the request.
const platformIdSchema = z
  .union([z.string(), z.number().finite()])
  .transform((v) => (typeof v === "number" ? String(v) : v.trim()))
  .pipe(z.string().min(1));

const bodySchema = z.object({
  platform: z.string().trim().min(1),
  platformId: platformIdSchema,
  myshopifyDomain: z.string().trim().min(1).optional(),
  accessToken: z.string().min(1).optional(),
  name: z.string().optional(),
  email: z.string().optional(),
  // Validated separately below so we can accept an arbitrary flat bag while
  // still rejecting a present-but-non-object value. Unknown top-level fields
  // are stripped (z.object default), i.e. ignored gracefully.
  customFields: z.unknown().optional(),
});

/** The identity key: a customer is unique per (appId, platform, platformId). */
export interface CustomerIdentity {
  appId: string;
  platform: string;
  platformId: string;
}

/** Scalar attributes a caller may set on identify. */
export interface CustomerAttributes {
  name?: string;
  email?: string;
  myshopifyDomain?: string;
  /** Plaintext merchant access token; encrypted before it reaches the store. */
  accessToken?: string;
  customFields?: Record<string, unknown>;
}

export type ParseResult =
  | { ok: true; platform: string; platformId: string; attributes: CustomerAttributes }
  | { ok: false; fields: string[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validate a parsed JSON request body. Returns the normalized platform key +
 * attributes, or the list of offending field names for a 422 response.
 */
export function parseIdentifyBody(raw: unknown): ParseResult {
  const parsed = bodySchema.safeParse(raw);
  const fields = new Set<string>();
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (typeof key === "string") fields.add(key);
    }
  }

  // customFields: accept any flat object, reject only a present non-object.
  const customFieldsRaw = isPlainObject(raw) ? raw.customFields : undefined;
  let customFields: Record<string, unknown> | undefined;
  if (customFieldsRaw !== undefined) {
    if (isPlainObject(customFieldsRaw)) {
      customFields = customFieldsRaw;
    } else {
      fields.add("customFields");
    }
  }

  if (!parsed.success || fields.size > 0) {
    // A non-object body (e.g. invalid JSON) has no per-field zod issues; still
    // report the two required fields so the caller knows what's missing.
    if (!isPlainObject(raw)) {
      fields.add("platform");
      fields.add("platformId");
    }
    return { ok: false, fields: [...fields] };
  }

  const { platform, platformId, myshopifyDomain, accessToken, name, email } =
    parsed.data;
  return {
    ok: true,
    platform,
    platformId,
    attributes: { name, email, myshopifyDomain, accessToken, customFields },
  };
}

// ---------------------------------------------------------------------------
// Token generation
// ---------------------------------------------------------------------------

/** 32 random bytes, URL-safe base64 — a secret, opaque, unguessable token. */
export function generateCustomerToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Deterministic, indexable fingerprint of a token (SHA-256, hex). */
export function hashCustomerToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Store abstraction
// ---------------------------------------------------------------------------

export interface StoredCustomer {
  id: string;
  appId: string;
  platform: string;
  platformId: string;
  name: string | null;
  email: string | null;
  myshopifyDomain: string | null;
  customFields: Record<string, unknown> | null;
  apiToken: string;
}

/** Fields written on create — accessToken is already encrypted here. */
export interface CustomerCreateData extends CustomerIdentity {
  name: string | null;
  email: string | null;
  myshopifyDomain: string | null;
  accessTokenEncrypted: string | null;
  customFields: Record<string, unknown> | null;
  apiToken: string;
  apiTokenHash: string;
}

/** Fields written on update — only keys present here are changed. */
export interface CustomerUpdateData {
  name?: string;
  email?: string;
  myshopifyDomain?: string;
  accessTokenEncrypted?: string;
  customFields?: Record<string, unknown> | null;
}

/**
 * Raised by {@link CustomerStore.create} when the identity key already exists.
 * Signals the race fallback in {@link identifyCustomer}.
 */
export class CustomerConflictError extends Error {
  constructor() {
    super("Customer already exists");
    this.name = "CustomerConflictError";
  }
}

export interface CustomerStore {
  findByIdentity(identity: CustomerIdentity): Promise<StoredCustomer | null>;
  /** Inserts a new customer; throws {@link CustomerConflictError} on conflict. */
  create(data: CustomerCreateData): Promise<StoredCustomer>;
  update(
    identity: CustomerIdentity,
    data: CustomerUpdateData,
  ): Promise<StoredCustomer>;
}

export interface IdentifyDeps {
  /** Cryptographically-secure, unique customer token. Defaults to 32 bytes. */
  generateToken?: () => string;
  /** Encrypts an access token at rest. Defaults to the credential envelope. */
  encryptAccessToken?: (plaintext: string) => string;
}

function mergeCustomFields(
  stored: Record<string, unknown> | null,
  incoming: Record<string, unknown> | undefined,
): Record<string, unknown> | null | undefined {
  if (incoming === undefined) return undefined; // untouched
  // Incoming keys are merged over the stored object; keys the caller did not
  // send are preserved.
  return { ...(stored ?? {}), ...incoming };
}

/**
 * Idempotent identify upsert.
 *
 * - New customer: create it with a freshly-generated, stable token.
 * - Existing customer: update the provided scalars, merge customFields over the
 *   stored object, and return the existing token unchanged (never rotated).
 *
 * Concurrency: two simultaneous first-time identifies for the same identity
 * race on {@link CustomerStore.create}; exactly one wins (the unique
 * constraint), the loser catches {@link CustomerConflictError} and falls back
 * to the update path — so a single row and a single token survive.
 */
export async function identifyCustomer(
  store: CustomerStore,
  identity: CustomerIdentity,
  attributes: CustomerAttributes,
  deps: IdentifyDeps = {},
): Promise<{ apiToken: string; created: boolean }> {
  const generateToken = deps.generateToken ?? generateCustomerToken;
  const encryptAccessToken = deps.encryptAccessToken ?? encryptCredential;

  const encryptedAccessToken =
    attributes.accessToken !== undefined
      ? encryptAccessToken(attributes.accessToken)
      : undefined;

  const applyUpdate = (existing: StoredCustomer) => {
    const update: CustomerUpdateData = {};
    if (attributes.name !== undefined) update.name = attributes.name;
    if (attributes.email !== undefined) update.email = attributes.email;
    if (attributes.myshopifyDomain !== undefined)
      update.myshopifyDomain = attributes.myshopifyDomain;
    if (encryptedAccessToken !== undefined)
      update.accessTokenEncrypted = encryptedAccessToken;
    const merged = mergeCustomFields(
      existing.customFields,
      attributes.customFields,
    );
    if (merged !== undefined) update.customFields = merged;
    return store.update(identity, update);
  };

  const existing = await store.findByIdentity(identity);
  if (existing) {
    const updated = await applyUpdate(existing);
    return { apiToken: updated.apiToken, created: false };
  }

  const token = generateToken();
  try {
    const created = await store.create({
      ...identity,
      name: attributes.name ?? null,
      email: attributes.email ?? null,
      myshopifyDomain: attributes.myshopifyDomain ?? null,
      accessTokenEncrypted: encryptedAccessToken ?? null,
      customFields: attributes.customFields ?? null,
      apiToken: token,
      apiTokenHash: hashCustomerToken(token),
    });
    return { apiToken: created.apiToken, created: true };
  } catch (error) {
    if (!(error instanceof CustomerConflictError)) throw error;
    // Lost the create race: the winner's row now exists. Re-read and update it
    // so the caller still gets the (single, stable) surviving token.
    const winner = await store.findByIdentity(identity);
    if (!winner) throw error;
    const updated = await applyUpdate(winner);
    return { apiToken: updated.apiToken, created: false };
  }
}
