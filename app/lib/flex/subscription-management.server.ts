import type { SubscriptionStatus } from "../../../generated/prisma/client";
import { prisma } from "../db.server";
import { appSubscriptionCancel } from "../shopify/billing.server";
import { loadSubscriptionContext } from "./context.server";
import { lockKey, withLock } from "./lock.server";

export class SubscriptionManagementError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SubscriptionManagementError";
  }
}

interface OwnedSubscriptionInput {
  subscriptionId: string;
  appId: string;
}

interface PauseSubscriptionInput extends OwnedSubscriptionInput {
  pausedUntil: Date;
}

interface ManagedSubscriptionResult {
  id: string;
  status: SubscriptionStatus;
  pausedUntil: Date | null;
  canceledAt: Date | null;
}

export interface SubscriptionManagementDependencies {
  cancelShopifySubscription: typeof appSubscriptionCancel;
}

const defaultDependencies: SubscriptionManagementDependencies = {
  cancelShopifySubscription: appSubscriptionCancel,
};

async function requireOwnedSubscription({
  subscriptionId,
  appId,
}: OwnedSubscriptionInput) {
  const ctx = await loadSubscriptionContext(subscriptionId);
  if (!ctx || ctx.appInstall.appId !== appId) {
    throw new SubscriptionManagementError("Subscription not found", 404);
  }
  return ctx;
}

function assertActive(status: SubscriptionStatus, canceledAt: Date | null) {
  if (status !== "ACTIVE" || canceledAt) {
    throw new SubscriptionManagementError(
      "Only an active subscription can be paused or resumed",
      409,
    );
  }
}

function assertFuturePause(pausedUntil: Date) {
  if (!Number.isFinite(pausedUntil.getTime())) {
    throw new SubscriptionManagementError(
      "pausedUntil must be a valid date",
      400,
    );
  }
  if (pausedUntil.getTime() <= Date.now()) {
    throw new SubscriptionManagementError(
      "pausedUntil must be in the future",
      400,
    );
  }
}

function resultOf(
  subscription: ManagedSubscriptionResult,
): ManagedSubscriptionResult {
  return {
    id: subscription.id,
    status: subscription.status,
    pausedUntil: subscription.pausedUntil,
    canceledAt: subscription.canceledAt,
  };
}

/**
 * Pause an active subscription until an explicit future instant.
 *
 * The billing lock prevents the daily charge path from racing the pause. State
 * and ownership are re-checked after the lock is acquired.
 */
export async function pauseSubscription(
  input: PauseSubscriptionInput,
): Promise<ManagedSubscriptionResult> {
  assertFuturePause(input.pausedUntil);

  const initial = await requireOwnedSubscription(input);
  return withLock(
    lockKey(initial.appInstall.app.organizationId, initial.id),
    async () => {
      const current = await requireOwnedSubscription(input);
      assertActive(current.status, current.canceledAt);
      // Lock acquisition may have waited; never persist an until-date that has
      // become stale while this request was queued.
      assertFuturePause(input.pausedUntil);

      const updated = await prisma.subscription.update({
        where: { id: current.id },
        data: { pausedUntil: input.pausedUntil },
        select: {
          id: true,
          status: true,
          pausedUntil: true,
          canceledAt: true,
        },
      });
      return resultOf(updated);
    },
  );
}

/**
 * Resume an active subscription. This operation is idempotent when it is
 * already unpaused.
 */
export async function resumeSubscription(
  input: OwnedSubscriptionInput,
): Promise<ManagedSubscriptionResult> {
  const initial = await requireOwnedSubscription(input);
  return withLock(
    lockKey(initial.appInstall.app.organizationId, initial.id),
    async () => {
      const current = await requireOwnedSubscription(input);
      assertActive(current.status, current.canceledAt);

      if (!current.pausedUntil) {
        return resultOf(current);
      }

      const updated = await prisma.subscription.update({
        where: { id: current.id },
        data: { pausedUntil: null },
        select: {
          id: true,
          status: true,
          pausedUntil: true,
          canceledAt: true,
        },
      });
      return resultOf(updated);
    },
  );
}

/**
 * Cancel the Shopify subscription for real, then mirror cancellation locally.
 *
 * Shopify failures intentionally propagate and leave the local row untouched.
 * A row without a Shopify subscription id can be cancelled locally because
 * there is no remote billing object to leave active.
 */
export async function cancelSubscription(
  input: OwnedSubscriptionInput,
  dependencies: Partial<SubscriptionManagementDependencies> = {},
): Promise<ManagedSubscriptionResult> {
  const deps = { ...defaultDependencies, ...dependencies };
  const initial = await requireOwnedSubscription(input);
  return withLock(
    lockKey(initial.appInstall.app.organizationId, initial.id),
    async () => {
      const current = await requireOwnedSubscription(input);

      if (current.status === "CANCELLED" || current.canceledAt) {
        return resultOf(current);
      }

      if (current.shopifySubscriptionId) {
        try {
          await deps.cancelShopifySubscription(
            current.appInstall.app,
            current.appInstall,
            {
              shopifySubscriptionId: current.shopifySubscriptionId,
            },
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unknown Shopify error";
          throw new SubscriptionManagementError(
            `Shopify cancellation failed: ${message}`,
            502,
          );
        }
      }

      const canceledAt = new Date();
      const updated = await prisma.subscription.update({
        where: { id: current.id },
        data: {
          status: "CANCELLED",
          canceledAt,
          pausedUntil: null,
        },
        select: {
          id: true,
          status: true,
          pausedUntil: true,
          canceledAt: true,
        },
      });
      return resultOf(updated);
    },
  );
}
