import { Prisma } from "../db.server";
import { prisma } from "../db.server";

/**
 * Almost every flex operation needs the same graph around a subscription: its
 * plan, its line items (the usage cap), its install, the app (credentials +
 * flags), and the owning organization. This centralises that shape so the
 * services share one typed loader.
 */
export const subscriptionContextInclude = {
  plan: true,
  lineItems: true,
  discounts: { include: { discount: true } },
  appInstall: {
    include: {
      app: { include: { organization: true, partnerConnection: true } },
    },
  },
} satisfies Prisma.SubscriptionInclude;

export type SubscriptionContext = Prisma.SubscriptionGetPayload<{
  include: typeof subscriptionContextInclude;
}>;

export async function loadSubscriptionContext(
  subscriptionId: string,
): Promise<SubscriptionContext | null> {
  return prisma.subscription.findUnique({
    where: { id: subscriptionId },
    include: subscriptionContextInclude,
  });
}

/** The app credential shape the Shopify Admin client needs. */
export function appCreds(ctx: SubscriptionContext) {
  return ctx.appInstall.app;
}

/** The install shape the Shopify Admin client needs. */
export function install(ctx: SubscriptionContext) {
  return ctx.appInstall;
}

export function organizationId(ctx: SubscriptionContext): string {
  return ctx.appInstall.app.organizationId;
}

/** The USAGE line item that every usage record posts against. */
export function usageLine(ctx: SubscriptionContext) {
  return ctx.lineItems.find((li) => li.type === "USAGE") ?? null;
}
