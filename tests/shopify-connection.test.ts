import assert from "node:assert/strict";
import test, { after } from "node:test";
import { prisma } from "../app/lib/db.server";
import {
  checkShopifyInstallConnection,
  SHOPIFY_CONNECTION_CHECK_QUERY,
  type ShopifyConnectionApp,
  type ShopifyConnectionInstall,
} from "../app/lib/shopify/connection.server";

const app: ShopifyConnectionApp = {
  id: "app-1",
  name: "Example app",
  shopifyApiKey: "api-key",
  shopifyApiSecret: "api-secret",
};

const install: ShopifyConnectionInstall = {
  id: "install-1",
  appId: app.id,
  shopDomain: "example.myshopify.com",
  accessToken: "offline-token",
  scope: "read_products",
  uninstalledAt: null,
};

after(async () => {
  await prisma.$disconnect();
});

test("connection probe validates the expected shop without exposing credentials", async () => {
  let calls = 0;
  const result = await checkShopifyInstallConnection(app, install, {
    callGraphql: async (_app, _install, query) => {
      calls += 1;
      assert.equal(query, SHOPIFY_CONNECTION_CHECK_QUERY);
      return {
        shop: {
          id: "gid://shopify/Shop/1",
          name: "Example",
          myshopifyDomain: "EXAMPLE.myshopify.com",
        },
      };
    },
  });

  assert.equal(calls, 1);
  assert.equal(result.status, "connected");
  assert.equal(JSON.stringify(result).includes("offline-token"), false);
  assert.equal(JSON.stringify(result).includes("api-secret"), false);
});

test("missing and uninstalled tokens are not sent to Shopify", async () => {
  let calls = 0;
  const callGraphql = async () => {
    calls += 1;
    throw new Error("must not run");
  };

  const missing = await checkShopifyInstallConnection(
    app,
    { ...install, accessToken: null },
    { callGraphql },
  );
  const uninstalled = await checkShopifyInstallConnection(
    app,
    { ...install, uninstalledAt: new Date() },
    { callGraphql },
  );

  assert.equal(missing.status, "missing_token");
  assert.equal(uninstalled.status, "uninstalled");
  assert.equal(calls, 0);
});

test("connection probe reports domain mismatch and sanitizes upstream failures", async () => {
  const mismatch = await checkShopifyInstallConnection(app, install, {
    callGraphql: async () => ({
      shop: {
        id: "gid://shopify/Shop/2",
        name: "Other",
        myshopifyDomain: "other.myshopify.com",
      },
    }),
  });
  assert.equal(mismatch.status, "domain_mismatch");

  const failure = await checkShopifyInstallConnection(app, install, {
    callGraphql: async () => {
      throw new Error("401 token offline-token was rejected");
    },
  });
  assert.deepEqual(failure, {
    appId: app.id,
    appName: app.name,
    installId: install.id,
    shopDomain: install.shopDomain,
    status: "error",
    message: "Shopify Admin API connection check failed.",
  });
});
