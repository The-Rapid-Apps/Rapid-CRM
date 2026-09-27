/**
 * Seed the minimum a fresh install needs: one Organization (the dashboard
 * tenant) and one admin User to log in with (email+password — see
 * app/lib/auth/). Everything else — apps, plans, discounts, installs — is
 * created for real through the dashboard UI / API, so no demo/static data is
 * injected.
 *
 * Run (needs a live DATABASE_URL): npx tsx prisma/seed.ts
 */
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "../generated/prisma/client";
import { hashPassword } from "../app/lib/auth/password.server";
import "dotenv/config";

const prisma = new PrismaClient({
  adapter: new PrismaMariaDb(process.env.DATABASE_URL!),
});

async function main() {
  // Create an Organization only if none exists — never duplicate the tenant.
  const existing = await prisma.organization.findFirst({
    orderBy: { createdAt: "asc" },
  });
  const org =
    existing ??
    (await prisma.organization.create({
      data: { name: process.env.SEED_ORG_NAME ?? "Rapid" },
    }));
  console.log(`Organization ready: ${org.name} (${org.id}).`);

  const adminEmail = (process.env.SEED_ADMIN_EMAIL ?? "").trim().toLowerCase();
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? "";
  if (!adminEmail || !adminPassword) {
    console.log(
      "SEED_ADMIN_EMAIL/SEED_ADMIN_PASSWORD not set — skipping admin user creation.",
    );
  } else {
    const admin = await prisma.user.upsert({
      where: { email: adminEmail },
      create: {
        organizationId: org.id,
        email: adminEmail,
        passwordHash: await hashPassword(adminPassword),
        /* The FIRST account has to be an ADMIN or a fresh install has nobody
           who can invite anyone — `role` defaults to MEMBER, which is right
           for every subsequent user but leaves the team screen unreachable
           here, with no way in short of editing the database. */
        role: "ADMIN",
      },
      // Re-running the seed never resets an existing user's password — nor
      // their role, so a deliberate demotion is not undone by a re-seed.
      update: {},
    });
    console.log(`Admin user ready: ${admin.email}.`);
  }

  console.log("Register your apps at /app/apps.");
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
