import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizePartnerAppId,
  normalizePartnerOrganizationId,
  PartnerConnectionError,
  partnerConnectionErrorCode,
  partnerConnectionErrorMessage,
  VERIFY_PARTNER_APP_QUERY,
  verifyPartnerAppConnection,
  type PartnerConnectionErrorCode,
} from "../app/lib/shopify/partner-connection.server";

const SENTINEL_TOKEN = "shpat_secret-sentinel-must-not-leak";
const SENTINEL_ORGANIZATION_ID = "987654321";
const CREDENTIALS = {
  partnerApiToken: SENTINEL_TOKEN,
  partnerOrganizationId: SENTINEL_ORGANIZATION_ID,
};

function assertPartnerConnectionError(
  error: unknown,
  code: PartnerConnectionErrorCode,
  message: string,
): boolean {
  assert.ok(error instanceof PartnerConnectionError);
  assert.equal(error.code, code);
  assert.equal(error.message, message);
  assert.equal(partnerConnectionErrorCode(error), code);
  assert.equal(partnerConnectionErrorMessage(error), message);
  assert.equal(String(error).includes(SENTINEL_TOKEN), false);
  assert.equal(String(error).includes(SENTINEL_ORGANIZATION_ID), false);
  return true;
}

test("normalizes numeric and canonical Partner IDs", () => {
  assert.equal(
    normalizePartnerAppId(" 123456789 "),
    "gid://partners/App/123456789",
  );
  assert.equal(
    normalizePartnerAppId(" gid://partners/App/123456789 "),
    "gid://partners/App/123456789",
  );
  assert.equal(
    normalizePartnerOrganizationId(` ${SENTINEL_ORGANIZATION_ID} `),
    SENTINEL_ORGANIZATION_ID,
  );
});

test("rejects malformed app and organization IDs with safe typed errors", () => {
  const invalidAppIds = [
    "",
    "-1",
    "1.5",
    "gid://partners/App/",
    "gid://partners/App/not-numeric",
    "gid://partners/Shop/123",
    "GID://partners/App/123",
  ];

  for (const appId of invalidAppIds) {
    assert.throws(
      () => normalizePartnerAppId(appId),
      (error) =>
        assertPartnerConnectionError(
          error,
          "INVALID_APP_ID",
          "App ID must be numeric or look like gid://partners/App/123.",
        ),
      appId,
    );
  }

  for (const organizationId of ["", "-1", "12.5", "org-123"]) {
    assert.throws(
      () => normalizePartnerOrganizationId(organizationId),
      (error) =>
        assertPartnerConnectionError(
          error,
          "INVALID_ORGANIZATION_ID",
          "Partner organization ID must be numeric.",
        ),
      organizationId,
    );
  }
});

test("verifies the exact remote app ID and Shopify Client ID", async () => {
  let calls = 0;
  const result = await verifyPartnerAppConnection(
    {
      credentials: CREDENTIALS,
      appId: " 123456789 ",
      clientId: " client-id-123 ",
    },
    async (credentials, query, variables) => {
      calls += 1;
      assert.deepEqual(credentials, CREDENTIALS);
      assert.equal(query, VERIFY_PARTNER_APP_QUERY);
      assert.deepEqual(variables, {
        appId: "gid://partners/App/123456789",
      });
      return {
        app: {
          id: "gid://partners/App/123456789",
          apiKey: "client-id-123",
        },
      };
    },
  );

  assert.equal(calls, 1);
  assert.deepEqual(result, {
    appId: "gid://partners/App/123456789",
    clientId: "client-id-123",
  });
  assert.equal(JSON.stringify(result).includes(SENTINEL_TOKEN), false);
});

test("rejects an inaccessible or unknown Partner app", async () => {
  await assert.rejects(
    verifyPartnerAppConnection(
      {
        credentials: CREDENTIALS,
        appId: "123456789",
        clientId: "client-id-123",
      },
      async () => ({ app: null }),
    ),
    (error) =>
      assertPartnerConnectionError(
        error,
        "APP_NOT_FOUND",
        "That Partner connection cannot access this app. Check the App ID and the Manage apps permission.",
      ),
  );
});

test("rejects a different app returned by the Partner API", async () => {
  await assert.rejects(
    verifyPartnerAppConnection(
      {
        credentials: CREDENTIALS,
        appId: "123456789",
        clientId: "client-id-123",
      },
      async () => ({
        app: {
          id: "gid://partners/App/999999999",
          apiKey: "client-id-123",
        },
      }),
    ),
    (error) =>
      assertPartnerConnectionError(
        error,
        "APP_ID_MISMATCH",
        "Shopify returned a different app for this App ID.",
      ),
  );
});

test("rejects a Shopify Client ID mismatch", async () => {
  await assert.rejects(
    verifyPartnerAppConnection(
      {
        credentials: CREDENTIALS,
        appId: "123456789",
        clientId: "expected-client-id",
      },
      async () => ({
        app: {
          id: "gid://partners/App/123456789",
          apiKey: "different-client-id",
        },
      }),
    ),
    (error) =>
      assertPartnerConnectionError(
        error,
        "CLIENT_ID_MISMATCH",
        "Client ID does not match the app returned by Shopify Partner API.",
      ),
  );
});

test("sanitizes thrown Partner API errors without leaking credentials", async () => {
  await assert.rejects(
    verifyPartnerAppConnection(
      {
        credentials: CREDENTIALS,
        appId: "123456789",
        clientId: "client-id-123",
      },
      async () => {
        throw new Error(
          `401 rejected ${SENTINEL_TOKEN} for ${SENTINEL_ORGANIZATION_ID}`,
        );
      },
    ),
    (error) =>
      assertPartnerConnectionError(
        error,
        "CONNECTION_FAILED",
        "Shopify Partner API connection failed. Check the Partner ID, token, and Manage apps permission.",
      ),
  );
});
