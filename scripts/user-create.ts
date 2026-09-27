/**
 * Create a dashboard login.
 *
 * A break-glass alternative to the invite flow on /app/team, for when nobody
 * can reach that screen — a fresh install, or the last admin locked out.
 *
 * Creates a MEMBER (the column default). A MEMBER cannot manage the team, but
 * DOES get complete access to every app's Shopify credentials and all merchant
 * billing data: `UserRole` gates the team screen only, not what anyone can
 * see. Treat it accordingly. Promote to admin from /app/team.
 *
 * Create-only: it refuses to touch an existing email, so a typo can never
 * silently overwrite a colleague's password. Use `npm run user:reset` for that.
 *
 * The password is generated in-process and printed once. Nothing is written to
 * disk, shell history, or the process argument list.
 *
 * Run: npm run user:create -- someone@example.com
 *      npm run user:create -- someone@example.com "Their Name"
 */
import "dotenv/config";
import { randomInt } from "node:crypto";
import { prisma } from "../app/lib/db.server";
import { hashPassword, verifyPassword } from "../app/lib/auth/password.server";

/**
 * Ambiguous glyphs (I l 1 O 0) and shell-hostile characters (quotes, backslash,
 * backtick, $) are excluded so the password survives copy-paste, terminals, and
 * being read aloud.
 */
const ALPHABET =
  "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%^*-_=+?";
const LENGTH = 28;

function generatePassword(): string {
  for (;;) {
    let password = "";
    // randomInt is rejection-sampled by Node, so there is no modulo bias.
    for (let i = 0; i < LENGTH; i += 1) {
      password += ALPHABET[randomInt(ALPHABET.length)];
    }
    // Regenerate rather than patch in a missing class, which would leak
    // structure into a known position.
    if (
      /[A-Z]/.test(password) &&
      /[a-z]/.test(password) &&
      /[0-9]/.test(password) &&
      /[^A-Za-z0-9]/.test(password)
    ) {
      return password;
    }
  }
}

async function main(): Promise<void> {
  const rawEmail = process.argv[2];
  const name = process.argv[3]?.trim() || null;
  if (!rawEmail) {
    throw new Error("Usage: npm run user:create -- <email> [name]");
  }
  // login.tsx lowercases and trims before lookup, so store it that way or the
  // row would exist but never match a sign-in.
  const email = rawEmail.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error(`Not a valid email address: ${email}`);
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new Error(
      `${email} already exists (id=${existing.id}). Use "npm run user:reset -- ${email}" to change its password.`,
    );
  }

  const organizations = await prisma.organization.findMany({
    orderBy: { createdAt: "asc" },
  });
  if (organizations.length === 0) {
    throw new Error("No organization exists — run npm run db:seed first.");
  }
  if (organizations.length > 1) {
    throw new Error(
      `Multiple organizations (${organizations.length}) exist; refusing to guess which one owns this user.`,
    );
  }
  const organization = organizations[0];

  const password = generatePassword();
  const created = await prisma.user.create({
    data: {
      email,
      name,
      organizationId: organization.id,
      passwordHash: await hashPassword(password),
    },
  });

  // Read back and verify rather than trusting the write: a hash that cannot
  // authenticate is worse than a failed create, because it looks like success.
  const saved = await prisma.user.findUniqueOrThrow({
    where: { id: created.id },
  });
  const verified = await verifyPassword(password, saved.passwordHash);

  console.log(`Created      : ${saved.email}`);
  console.log(`Name         : ${saved.name ?? "(none)"}`);
  console.log(`User id      : ${saved.id}`);
  console.log(`Organization : ${organization.name} (${organization.id})`);
  console.log(`Verification : ${verified ? "PASS" : "FAIL"}`);
  console.log("");
  console.log(`PASSWORD     : ${password}`);
  console.log("");
  console.log("Send this over a password manager or Signal — not email or chat.");
  console.log("They can change it at /app/account after signing in.");

  if (!verified) {
    throw new Error(
      "Stored hash did not verify against the generated password — investigate before handing this out.",
    );
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(
      `ERROR: ${error instanceof Error ? error.message : String(error)}`,
    );
    await prisma.$disconnect();
    process.exit(1);
  });
