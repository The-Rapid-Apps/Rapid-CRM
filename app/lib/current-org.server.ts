import { prisma } from "./db.server";
import { getUser, requireUser } from "./auth/session.server";

/** Resolve the signed-in dashboard user's organization. */
export async function getCurrentOrganization(request: Request) {
  const user = await getUser(request);
  if (!user) return null;
  return prisma.organization.findUnique({
    where: { id: user.organizationId },
  });
}

export async function requireCurrentOrganization(request: Request) {
  const user = await requireUser(request);
  const org = await prisma.organization.findUnique({
    where: { id: user.organizationId },
  });
  if (org) return org;
  throw new Response("Your account organization no longer exists.", {
    status: 403,
  });
}
