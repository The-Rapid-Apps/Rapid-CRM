import assert from "node:assert/strict";
import test from "node:test";
import {
  authenticateApp,
  buildRegistry,
  constantTimeEqual,
} from "../app/lib/identify/app-registry.server";
import { collectAppCredentials } from "../app/lib/env.server";
import {
  CustomerConflictError,
  type CustomerCreateData,
  type CustomerIdentity,
  type CustomerStore,
  type CustomerUpdateData,
  type StoredCustomer,
  generateCustomerToken,
  hashCustomerToken,
  identifyCustomer,
  parseIdentifyBody,
} from "../app/lib/identify/core.server";

// ---------------------------------------------------------------------------
// In-memory store — models the DB's atomic unique(appId, platform, platformId)
// constraint: create() checks-and-sets synchronously, so two concurrent
// creates for the same identity cannot both win. Used to test the upsert logic
// without a database, exactly as the production Prisma store would behave.
// ---------------------------------------------------------------------------

interface Row extends StoredCustomer {
  accessTokenEncrypted: string | null;
  apiTokenHash: string;
}

class InMemoryStore implements CustomerStore {
  readonly rows = new Map<string, Row>();
  readonly creates: CustomerCreateData[] = [];

  private key(i: CustomerIdentity) {
    return `${i.appId}|${i.platform}|${i.platformId}`;
  }

  async findByIdentity(identity: CustomerIdentity): Promise<StoredCustomer | null> {
    const row = this.rows.get(this.key(identity));
    return row ? { ...row } : null;
  }

  async create(data: CustomerCreateData): Promise<StoredCustomer> {
    const key = this.key(data);
    if (this.rows.has(key)) throw new CustomerConflictError();
    const row: Row = {
      id: `c_${this.rows.size + 1}`,
      appId: data.appId,
      platform: data.platform,
      platformId: data.platformId,
      name: data.name,
      email: data.email,
      myshopifyDomain: data.myshopifyDomain,
      customFields: data.customFields,
      apiToken: data.apiToken,
      accessTokenEncrypted: data.accessTokenEncrypted,
      apiTokenHash: data.apiTokenHash,
    };
    this.rows.set(key, row);
    this.creates.push(data);
    return { ...row };
  }

  async update(
    identity: CustomerIdentity,
    data: CustomerUpdateData,
  ): Promise<StoredCustomer> {
    const row = this.rows.get(this.key(identity));
    if (!row) throw new Error("no such row");
    if (data.name !== undefined) row.name = data.name;
    if (data.email !== undefined) row.email = data.email;
    if (data.myshopifyDomain !== undefined)
      row.myshopifyDomain = data.myshopifyDomain;
    if (data.accessTokenEncrypted !== undefined)
      row.accessTokenEncrypted = data.accessTokenEncrypted;
    if (data.customFields !== undefined) row.customFields = data.customFields;
    return { ...row };
  }
}

const IDENTITY: CustomerIdentity = {
  appId: "app-a",
  platform: "shopify",
  platformId: "99211346267",
};

// deps that make tokens deterministic + encryption observable, so tests assert
// exact behavior without depending on randomness or the real cipher.
function fakeDeps(token: string) {
  return {
    generateToken: () => token,
    encryptAccessToken: (plaintext: string) => `enc(${plaintext})`,
  };
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

test("authenticateApp: unauthorized when header missing or key wrong", async () => {
  const registry = new Map([["app-a", "secret-a"]]);

  // Missing both headers.
  assert.equal(await authenticateApp(new Headers(), registry), null);

  // Known app, wrong key.
  assert.equal(
    await authenticateApp(
      new Headers({ "x-app-id": "app-a", "x-app-api-key": "wrong" }),
      registry,
    ),
    null,
  );

  // Unknown app, even with a key that matches another app.
  assert.equal(
    await authenticateApp(
      new Headers({ "x-app-id": "app-z", "x-app-api-key": "secret-a" }),
      registry,
    ),
    null,
  );

  // Missing key header only.
  assert.equal(
    await authenticateApp(new Headers({ "x-app-id": "app-a" }), registry),
    null,
  );
});

test("authenticateApp: resolves the appId on a valid pair", async () => {
  const registry = new Map([
    ["app-a", "secret-a"],
    ["app-b", "secret-b"],
  ]);
  assert.equal(
    await authenticateApp(
      new Headers({ "x-app-id": "app-b", "x-app-api-key": "secret-b" }),
      registry,
    ),
    "app-b",
  );
});

test("collectAppCredentials: reads primary + numbered env pairs", () => {
  const creds = collectAppCredentials({
    IDENTIFY_APP_ID: "app-a",
    IDENTIFY_APP_API_KEY: "secret-a",
    IDENTIFY_APP_2_ID: "app-b",
    IDENTIFY_APP_2_API_KEY: "secret-b",
    UNRELATED: "ignored",
  });
  assert.deepEqual(creds, [
    { appId: "app-a", apiKey: "secret-a" },
    { appId: "app-b", apiKey: "secret-b" },
  ]);
  // No credentials configured -> empty registry (endpoint disabled).
  assert.deepEqual(collectAppCredentials({}), []);
});

test("collectAppCredentials: rejects a half-configured or duplicate slot", () => {
  assert.throws(() => collectAppCredentials({ IDENTIFY_APP_ID: "app-a" }));
  assert.throws(() =>
    collectAppCredentials({ IDENTIFY_APP_2_API_KEY: "secret-only" }),
  );
  assert.throws(() =>
    collectAppCredentials({
      IDENTIFY_APP_ID: "dup",
      IDENTIFY_APP_API_KEY: "k1",
      IDENTIFY_APP_2_ID: "dup",
      IDENTIFY_APP_2_API_KEY: "k2",
    }),
  );
});

test("buildRegistry: turns the credential list into an appId->key map", () => {
  const registry = buildRegistry([
    { appId: "a", apiKey: "k1" },
    { appId: "b", apiKey: "k2" },
  ]);
  assert.equal(registry.get("a"), "k1");
  assert.equal(registry.get("b"), "k2");
  assert.equal(buildRegistry([]).size, 0);
});

test("constantTimeEqual matches only identical strings", () => {
  assert.equal(constantTimeEqual("abc", "abc"), true);
  assert.equal(constantTimeEqual("abc", "abd"), false);
  assert.equal(constantTimeEqual("abc", "abcd"), false); // different length
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test("parseIdentifyBody: platform and platformId are required", () => {
  const result = parseIdentifyBody({ name: "Fovello" });
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.fields.includes("platform"));
  assert.ok(!result.ok && result.fields.includes("platformId"));
});

test("parseIdentifyBody: rejects a present non-object customFields", () => {
  for (const bad of ["nope", 5, true, ["a"]]) {
    const result = parseIdentifyBody({
      platform: "shopify",
      platformId: "1",
      customFields: bad,
    });
    assert.equal(result.ok, false, JSON.stringify(bad));
    assert.ok(!result.ok && result.fields.includes("customFields"));
  }
});

test("parseIdentifyBody: coerces a numeric platformId to a string", () => {
  const result = parseIdentifyBody({ platform: "shopify", platformId: 51944489112 });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.platformId, "51944489112");
    assert.equal(typeof result.platformId, "string");
  }

  // Non-finite / non-scalar platformId is still rejected.
  for (const bad of [true, null, {}, ["1"]]) {
    const r = parseIdentifyBody({ platform: "shopify", platformId: bad });
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.ok(!r.ok && r.fields.includes("platformId"));
  }
});

test("parseIdentifyBody: accepts a valid body and ignores unknown fields", () => {
  const result = parseIdentifyBody({
    platform: "shopify",
    platformId: "99211346267",
    myshopifyDomain: "a1b2c3-d4.myshopify.com",
    accessToken: "shpat_secret",
    name: "Fovello",
    email: "user@example.com",
    customFields: { plan: "Starter", seats: 3 },
    somethingNew: "ignored", // forward-compatible
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.platform, "shopify");
    assert.equal(result.platformId, "99211346267");
    assert.deepEqual(result.attributes.customFields, {
      plan: "Starter",
      seats: 3,
    });
    assert.equal("somethingNew" in result.attributes, false);
  }
});

// ---------------------------------------------------------------------------
// Token generation
// ---------------------------------------------------------------------------

test("generateCustomerToken is unique and URL-safe; hash is stable", () => {
  const a = generateCustomerToken();
  const b = generateCustomerToken();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
  assert.equal(hashCustomerToken(a), hashCustomerToken(a));
  assert.notEqual(hashCustomerToken(a), hashCustomerToken(b));
});

// ---------------------------------------------------------------------------
// Upsert behavior
// ---------------------------------------------------------------------------

test("first identify creates the customer and returns a token", async () => {
  const store = new InMemoryStore();
  const result = await identifyCustomer(
    store,
    IDENTITY,
    {
      name: "Fovello",
      email: "user@example.com",
      accessToken: "shpat_secret",
      customFields: { plan: "Starter" },
    },
    fakeDeps("tok_1"),
  );

  assert.equal(result.created, true);
  assert.equal(result.apiToken, "tok_1");
  assert.equal(store.rows.size, 1);

  const [created] = store.creates;
  // Access token is stored encrypted, never in plaintext.
  assert.equal(created.accessTokenEncrypted, "enc(shpat_secret)");
  assert.notEqual(created.accessTokenEncrypted, "shpat_secret");
  assert.equal(created.apiTokenHash, hashCustomerToken("tok_1"));
});

test("repeat identify returns the same token and merges customFields", async () => {
  const store = new InMemoryStore();
  const first = await identifyCustomer(
    store,
    IDENTITY,
    { name: "Fovello", customFields: { plan: "Starter", region: "us" } },
    fakeDeps("tok_stable"),
  );

  // Second call: new token would be generated, but must be ignored (idempotent).
  const second = await identifyCustomer(
    store,
    IDENTITY,
    { name: "Fovello Renamed", customFields: { plan: "Pro" } },
    fakeDeps("tok_DIFFERENT"),
  );

  assert.equal(first.apiToken, "tok_stable");
  assert.equal(second.apiToken, "tok_stable"); // never rotated
  assert.equal(second.created, false);
  assert.equal(store.rows.size, 1);

  const row = await store.findByIdentity(IDENTITY);
  assert.equal(row?.name, "Fovello Renamed"); // scalar updated
  // Merge: incoming "plan" overrides its previous value, untouched "region" is
  // preserved, and a brand-new key can be added on a later call.
  assert.deepEqual(row?.customFields, { plan: "Pro", region: "us" });

  // A third call updates one existing field again and adds a new one.
  const third = await identifyCustomer(
    store,
    IDENTITY,
    { customFields: { plan: "Enterprise", seats: 10 } },
    fakeDeps("tok_IGNORED"),
  );
  assert.equal(third.apiToken, "tok_stable");
  const after = await store.findByIdentity(IDENTITY);
  assert.deepEqual(after?.customFields, {
    plan: "Enterprise", // updated value for an existing field
    region: "us", // still preserved
    seats: 10, // newly added
  });
});

test("concurrent first-create yields a single row and a single token", async () => {
  const store = new InMemoryStore();

  const [a, b] = await Promise.all([
    identifyCustomer(store, IDENTITY, { name: "A" }, fakeDeps("tok_A")),
    identifyCustomer(store, IDENTITY, { name: "B" }, fakeDeps("tok_B")),
  ]);

  assert.equal(store.rows.size, 1, "exactly one customer row");
  // Both callers receive the winner's token; exactly one created it.
  assert.equal(a.apiToken, b.apiToken);
  assert.equal([a.created, b.created].filter(Boolean).length, 1);
  assert.equal(store.creates.length, 1, "only one row was inserted");
});
