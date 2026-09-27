/**
 * Reset an existing dashboard login's password.
 *
 * The new password is read from stdin, never from an argument, so it stays out
 * of shell history and the process list (`ps` is world-readable on the shared
 * host). Reset-only: it refuses to create a user, so a mistyped address fails
 * loudly instead of quietly minting a second account.
 *
 * Run: read -rs -p "New password: " PW && printf %s "$PW" | npm run user:reset -- someone@example.com; unset PW
 *
 * The minimum length matches the policy the self-serve page enforces
 * (app/routes/app/account.tsx), so a password set here cannot be one the UI
 * would have rejected.
 */
import "dotenv/config";
import { prisma } from "../app/lib/db.server";
import { hashPassword, verifyPassword } from "../app/lib/auth/password.server";

const MIN_LENGTH = 8;

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new Error(
      'Pipe the password in, e.g.: read -rs -p "New password: " PW && printf %s "$PW" | npm run user:reset -- <email>',
    );
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  // Strip one trailing newline (shells add it) but preserve any other
  // whitespace, which is legitimate inside a passphrase.
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

async function main(): Promise<void> {
  const rawEmail = process.argv[2];
  if (!rawEmail) {
    throw new Error("Usage: ... | npm run user:reset -- <email>");
  }
  const email = rawEmail.trim().toLowerCase();

  const password = await readStdin();
  if (password.length < MIN_LENGTH) {
    throw new Error(
      `Refusing to set a password shorter than ${MIN_LENGTH} characters (got ${password.length}) — /app/account would reject it too.`,
    );
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    const known = await prisma.user.count();
    throw new Error(
      `No user with email ${email} (${known} user(s) exist). This script only resets; use "npm run user:create -- ${email}" to add one.`,
    );
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(password) },
  });

  // Verify against the row as actually stored, not the value just computed.
  const saved = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  const verified = await verifyPassword(password, saved.passwordHash);

  console.log(`Updated      : ${saved.email} (id=${saved.id})`);
  console.log(`Verification : ${verified ? "PASS" : "FAIL"}`);
  if (!verified) {
    throw new Error(
      "Stored hash did not verify against the new password — the account may now be unusable; investigate immediately.",
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
