import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { prisma } from "../app/lib/db.server";
import { loader as discountsLoader } from "../app/routes/api/discounts";
import { loader as installsLoader } from "../app/routes/api/installs";
import { loader as subscriptionsLoader } from "../app/routes/api/subscriptions";

after(async () => {
  await prisma.$disconnect();
});

function loaderArgs(request: Request): Parameters<typeof installsLoader>[0] {
  return { request, params: {}, context: {} } as unknown as Parameters<
    typeof installsLoader
  >[0];
}

async function cleanupOrganization(organizationId: string): Promise<void> {
  const apps = await prisma.app.findMany({
    where: { organizationId },
    select: { id: true },
  });
  const appIds = apps.map((app) => app.id);
  const installs = appIds.length
    ? await prisma.appInstall.findMany({
        where: { appId: { in: appIds } },
        select: { id: true },
      })
    : [];
  const installIds = installs.map((install) => install.id);

  await prisma.flexBillingEvent.deleteMany({ where: { organizationId } });
  if (installIds.length) {
    await prisma.subscription.deleteMany({
      where: { appInstallId: { in: installIds } },
    });
  }
  if (appIds.length) {
    await prisma.discount.deleteMany({ where: { appId: { in: appIds } } });
    await prisma.appInstall.deleteMany({ where: { appId: { in: appIds } } });
    await prisma.plan.deleteMany({ where: { appId: { in: appIds } } });
    await prisma.app.deleteMany({ where: { id: { in: appIds } } });
  }
  await prisma.organization.deleteMany({ where: { id: organizationId } });
}

test("app listing APIs are scoped, paginated, and never expose credentials", async (t) => {
  const suffix = randomUUID().slice(0, 8);
  const organization = await prisma.organization.create({
    data: { name: `Listing API ${suffix}` },
  });
  t.after(() => cleanupOrganization(organization.id));
  const app = await prisma.app.create({
    data: {
      organizationId: organization.id,
      name: "Listing app",
      handle: `listing-${suffix}`,
      shopifyApiKey: `shopify-key-${suffix}`,
      shopifyApiSecret: `shopify-secret-${suffix}`,
      apiKey: `platform-key-${suffix}`,
    },
  });
  const plan = await prisma.plan.create({
    data: {
      appId: app.id,
      name: "Monthly",
      amount: "29",
      usageChargeCappedAmount: "200",
    },
  });
  const install = await prisma.appInstall.create({
    data: {
      appId: app.id,
      shopDomain: `${suffix}.myshopify.com`,
      accessToken: `offline-token-${suffix}`,
      scope: "read_products",
    },
  });
  const subscription = await prisma.subscription.create({
    data: {
      appInstallId: install.id,
      planId: plan.id,
      status: "ACTIVE",
      activatedAt: new Date(),
      shopifySubscriptionId: "gid://shopify/AppSubscription/1",
    },
  });
  await prisma.discount.create({
    data: {
      appId: app.id,
      organizationId: app.organizationId,
      apps: { create: { appId: app.id } },
      code: "SAVE20",
      normalizedCode: "SAVE20",
      orgCodeKey: "SAVE20",
      value: "20",
    },
  });

  const headers = { Authorization: `Bearer ${app.apiKey}` };
  const installsResponse = await installsLoader(
    loaderArgs(
      new Request("http://localhost/api/flex/installs?limit=1", {
        headers,
      }),
    ),
  );
  const subscriptionsResponse = await subscriptionsLoader(
    loaderArgs(
      new Request("http://localhost/api/flex/subscriptions?limit=1", {
        headers,
      }),
    ),
  );
  const discountsResponse = await discountsLoader(
    loaderArgs(
      new Request("http://localhost/api/flex/discounts?limit=1", {
        headers,
      }),
    ),
  );

  assert.equal(installsResponse.status, 200);
  assert.equal(subscriptionsResponse.status, 200);
  assert.equal(discountsResponse.status, 200);

  const installsBody = await installsResponse.json();
  const subscriptionsBody = await subscriptionsResponse.json();
  const discountsBody = await discountsResponse.json();
  assert.equal(installsBody.installs[0].id, install.id);
  assert.equal(installsBody.installs[0].hasAccessToken, true);
  assert.equal(subscriptionsBody.subscriptions[0].id, subscription.id);
  assert.equal(discountsBody.discounts[0].code, "SAVE20");
  assert.deepEqual(installsBody.pageInfo, {
    hasNextPage: false,
    endCursor: install.id,
  });

  const serialized = JSON.stringify({
    installsBody,
    subscriptionsBody,
    discountsBody,
  });
  assert.equal(serialized.includes(`offline-token-${suffix}`), false);
  assert.equal(serialized.includes(`shopify-secret-${suffix}`), false);
  assert.equal(serialized.includes(`platform-key-${suffix}`), false);

  const invalidLimit = await installsLoader(
    loaderArgs(
      new Request("http://localhost/api/flex/installs?limit=101", {
        headers,
      }),
    ),
  );
  assert.equal(invalidLimit.status, 400);
});
