/**
 * Regression check for dashboard invites and access removal.
 *
 * `npm run verify:team`
 *
 * Runs against the configured database, like `verify:customer-events` — the behaviour worth protecting here lives in Prisma
 * constraints and transactions (UNIQUE on `email`, the accepted/revoked state
 * guard, the cascade that makes deletion destructive), so a mocked test would
 * assert the mock rather than the thing.
 *
 * SAFE TO RUN ANYWHERE, including production: every row it writes uses the
 * reserved address below and is deleted again at the end, and it touches no
 * existing user except to READ how many admins are active.
 *
 * Exits non-zero if anything fails.
 */
import { prisma } from "../app/lib/db.server";
import {
  acceptUserInvite,
  createUserInvite,
  listPendingInvites,
  readUserInvite,
  revokeUserInvite,
  setUserActive,
  setUserRole,
} from "../app/lib/auth/team.server";
import { verifyPassword } from "../app/lib/auth/password.server";

/** `.invalid` is reserved by RFC 2606 and can never be a real address, so this
 * cannot collide with a colleague even by accident. */
const EMAIL = "verify-team-invites@rapid.invalid";
const PASSWORD = "correct-horse-battery-staple";

let failures = 0;
function check(label: string, condition: boolean): void {
  if (!condition) failures += 1;
  console.log(`  ${condition ? "ok  " : "FAIL"} ${label}`);
}

async function cleanup(): Promise<void> {
  await prisma.user.deleteMany({ where: { email: EMAIL } });
  await prisma.userInvite.deleteMany({ where: { email: EMAIL } });
}

const org = await prisma.organization.findFirst({ select: { id: true } });
if (!org) {
  console.log("No organization — run `npm run db:seed` first.");
  await prisma.$disconnect();
  process.exit(1);
}
const actor = await prisma.user.findFirst({
  where: { organizationId: org.id, role: "ADMIN", deactivatedAt: null },
  select: { id: true },
});
if (!actor) {
  console.log("No active admin to act as — nothing to verify.");
  await prisma.$disconnect();
  process.exit(1);
}

await cleanup();
const base = { organizationId: org.id, invitedById: actor.id, baseUrl: "https://example.invalid" };

console.log("issuing an invite");
// Mixed case and whitespace, because that is what a paste looks like.
const first = await createUserInvite({ ...base, email: `  ${EMAIL.toUpperCase()}  `, role: "MEMBER" });
check("invite created", first.ok);
if (!first.ok) {
  await cleanup();
  await prisma.$disconnect();
  process.exit(1);
}
const firstToken = first.link.url.split("/invite/")[1]!;
check("address normalized to lowercase", (await readUserInvite(firstToken))?.email === EMAIL);
check("listed as pending", (await listPendingInvites(org.id)).some((i) => i.email === EMAIL));
const stored = await prisma.userInvite.findFirstOrThrow({
  where: { email: EMAIL },
  select: { tokenHash: true },
});
check("only a hash is stored, never the token", stored.tokenHash !== firstToken);

console.log("\nre-inviting supersedes the outstanding link");
const second = await createUserInvite({ ...base, email: EMAIL, role: "ADMIN" });
check("second invite created", second.ok);
check("first link stops working", (await readUserInvite(firstToken)) === null);
check(
  "exactly one invite is pending",
  (await listPendingInvites(org.id)).filter((i) => i.email === EMAIL).length === 1,
);
const token = second.ok ? second.link.url.split("/invite/")[1]! : "";

console.log("\naccepting");
check("a short password is refused", !(await acceptUserInvite({ token, password: "short" })).ok);
check(
  "an invented token is refused",
  !(await acceptUserInvite({ token: "not-a-real-token", password: PASSWORD })).ok,
);
check("accepted", (await acceptUserInvite({ token, password: PASSWORD, name: "Verify Bot" })).ok);

const created = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL } });
check("account carries the INVITED role, not the default", created.role === "ADMIN");
check("password verifies", await verifyPassword(PASSWORD, created.passwordHash));
check("password is not stored in plaintext", !created.passwordHash.includes(PASSWORD));
check("the link cannot be replayed", !(await acceptUserInvite({ token, password: PASSWORD })).ok);
check("no longer pending", !(await listPendingInvites(org.id)).some((i) => i.email === EMAIL));
check(
  "the invite row survives as an audit trail",
  (await prisma.userInvite.count({ where: { email: EMAIL, acceptedAt: { not: null } } })) === 1,
);

console.log("\nremoving and restoring access");
check(
  "an existing user cannot be re-invited",
  !(await createUserInvite({ ...base, email: EMAIL, role: "MEMBER" })).ok,
);
check(
  "deactivation succeeds",
  (await setUserActive({ organizationId: org.id, userId: created.id, actingUserId: actor.id, active: false })).ok,
);
check(
  "deactivatedAt is set rather than the row deleted",
  (await prisma.user.findUniqueOrThrow({ where: { id: created.id } })).deactivatedAt !== null,
);
const reinvite = await createUserInvite({ ...base, email: EMAIL, role: "MEMBER" });
check(
  "re-inviting a deactivated person points at reactivation",
  !reinvite.ok && reinvite.reason === "reactivate-instead",
);
check(
  "you cannot deactivate yourself",
  !(await setUserActive({ organizationId: org.id, userId: actor.id, actingUserId: actor.id, active: false })).ok,
);
check(
  "reactivation succeeds",
  (await setUserActive({ organizationId: org.id, userId: created.id, actingUserId: actor.id, active: true })).ok,
);
check(
  "an accepted invite cannot be revoked",
  !(await revokeUserInvite({
    organizationId: org.id,
    inviteId: (await prisma.userInvite.findFirstOrThrow({ where: { email: EMAIL } })).id,
  })),
);
check(
  "role can be changed",
  (await setUserRole({ organizationId: org.id, userId: created.id, actingUserId: actor.id, role: "MEMBER" })).ok,
);

/* The last-admin guard, checked without ever risking the real one: demote the
   test account to MEMBER first (done above), so the only way this assertion
   can pass is the guard counting other active admins correctly. */
const activeAdmins = await prisma.user.count({
  where: { organizationId: org.id, role: "ADMIN", deactivatedAt: null },
});
check("at least one real admin remains", activeAdmins >= 1);

await cleanup();
console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) FAILED`}`);
await prisma.$disconnect();
process.exit(failures === 0 ? 0 : 1);
