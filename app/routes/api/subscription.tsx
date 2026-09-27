import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { z } from "zod";
import { apiError, handleApi, requireApiApp } from "~/lib/api-auth.server";
import { prisma } from "~/lib/db.server";
import { loadSubscriptionContext } from "~/lib/flex/context.server";
import {
  resolveFeaturesForSubscription,
  serializeFeatures,
} from "~/lib/plans/features.server";
import { priceAfterDiscount } from "~/lib/flex/discounts.server";
import {
  cancelSubscription,
  pauseSubscription,
  resumeSubscription,
  SubscriptionManagementError,
} from "~/lib/flex/subscription-management.server";

const actionSchema = z.discriminatedUnion("intent", [
  z
    .object({
      intent: z.literal("pause"),
      pausedUntil: z.iso.datetime({ offset: true }),
    })
    .strict(),
  z.object({ intent: z.literal("resume") }).strict(),
  z.object({ intent: z.literal("cancel") }).strict(),
]);

function managementError(error: unknown): Response | never {
  if (error instanceof SubscriptionManagementError) {
    return apiError(error.status, error.message);
  }
  throw error;
}

/**
 * GET /api/flex/subscription/:id
 * Returns the current billing state of a subscription for the app to render.
 */
export function loader({ request, params }: LoaderFunctionArgs) {
  return handleApi(async () => {
    const app = await requireApiApp(request);
    const ctx = await loadSubscriptionContext(params.id ?? "");
    if (!ctx || ctx.appInstall.appId !== app.id) {
      return apiError(404, "Subscription not found");
    }

    const now = new Date();
    const activeApplication =
      ctx.discounts
        .filter(
          ({ discount, startsAt, endsAt }) =>
            discount.active &&
            (!discount.planId || discount.planId === ctx.plan.id) &&
            startsAt <= now &&
            (!endsAt || endsAt >= now),
        )
        .sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime())[0] ?? null;

    const [charges, replacesSubscription, latestReplacement, features] =
      await Promise.all([
        prisma.charge.findMany({
          where: { subscriptionId: ctx.id },
          orderBy: { occurredAt: "desc" },
          take: 20,
        }),
        ctx.replacesSubscriptionId
          ? prisma.subscription.findUnique({
              where: { id: ctx.replacesSubscriptionId },
              select: {
                id: true,
                status: true,
                plan: { select: { id: true, name: true } },
                activatedAt: true,
                canceledAt: true,
              },
            })
          : Promise.resolve(null),
        prisma.subscription.findFirst({
          where: { replacesSubscriptionId: ctx.id },
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            status: true,
            plan: { select: { id: true, name: true } },
            confirmationUrl: true,
            approvalExpiresAt: true,
            replacementEventId: true,
            activatedAt: true,
            canceledAt: true,
            createdAt: true,
          },
        }),
        /*
          Resolved against THIS subscription, so a trial override applies while
          the merchant is inside the trial window and stops the moment it ends.
          It reads the window off the subscription rather than trusting a caller,
          because "what may this merchant do" must not depend on the app's clock.
        */
        resolveFeaturesForSubscription(ctx.id, now),
      ]);

    const discountedPrice = activeApplication
      ? priceAfterDiscount(ctx.plan.amount, activeApplication.discount)
      : null;

    return Response.json({
      id: ctx.id,
      status: ctx.status,
      test: ctx.test,
      plan: {
        id: ctx.plan.id,
        name: ctx.plan.name,
        amount: ctx.plan.amount.toString(),
      },
      currencyCode: ctx.plan.currencyCode,
      currentPeriodStart: ctx.currentPeriodStart,
      currentPeriodEnd: ctx.currentPeriodEnd,
      nextBillingDate: ctx.nextBillingDate,
      trialEndsAt: ctx.trialEndsAt,
      activatedAt: ctx.activatedAt,
      /* Empty for a subscription that is not ACTIVE: a cancelled plan grants
         nothing, and returning its former entitlements would let an app keep
         honouring them. */
      features: serializeFeatures(features ?? []),
      canceledAt: ctx.canceledAt,
      pausedUntil: ctx.pausedUntil,
      activeDiscount: activeApplication
        ? {
            applicationId: activeApplication.id,
            id: activeApplication.discount.id,
            code: activeApplication.discount.code,
            description: activeApplication.discount.description,
            type: activeApplication.discount.type,
            value: activeApplication.discount.value.toString(),
            discountMethod: activeApplication.discount.discountMethod,
            durationIntervals: activeApplication.discount.durationIntervals,
            startsAt: activeApplication.startsAt,
            endsAt: activeApplication.endsAt,
            discountedPrice: discountedPrice?.toString() ?? null,
            chargePrice:
              activeApplication.discount.discountMethod === "PRICE_REDUCTION"
                ? (discountedPrice?.toString() ?? ctx.plan.amount.toString())
                : ctx.plan.amount.toString(),
          }
        : null,
      recentCharges: charges.map((charge) => ({
        id: charge.id,
        amount: charge.amount.toString(),
        chargedAmount: charge.chargedAmount.toString(),
        chargedCurrencyCode: charge.chargedCurrencyCode,
        isCredit: charge.isCredit,
        flexBilling: charge.flexBilling,
        status: charge.status,
        description: charge.description,
        billingPeriodStart: charge.billingPeriodStart,
        occurredAt: charge.occurredAt,
      })),
      replacement:
        ctx.replacesSubscriptionId ||
        ctx.replacementEventId ||
        latestReplacement
          ? {
              // Set when this subscription is itself a cap-full fallback.
              replacesSubscription: replacesSubscription
                ? {
                    id: replacesSubscription.id,
                    status: replacesSubscription.status,
                    plan: replacesSubscription.plan,
                    activatedAt: replacesSubscription.activatedAt,
                    canceledAt: replacesSubscription.canceledAt,
                  }
                : null,
              replacementEventId: ctx.replacementEventId,
              approvalExpiresAt: ctx.approvalExpiresAt,
              approvalExpired: Boolean(
                ctx.status === "PENDING" &&
                ctx.approvalExpiresAt &&
                ctx.approvalExpiresAt <= now,
              ),
              confirmationUrl:
                ctx.status === "PENDING" ? ctx.confirmationUrl : null,
              // Set when another subscription is waiting to replace this one.
              latestReplacement: latestReplacement
                ? {
                    id: latestReplacement.id,
                    status: latestReplacement.status,
                    plan: latestReplacement.plan,
                    replacementEventId: latestReplacement.replacementEventId,
                    approvalExpiresAt: latestReplacement.approvalExpiresAt,
                    approvalExpired: Boolean(
                      latestReplacement.status === "PENDING" &&
                      latestReplacement.approvalExpiresAt &&
                      latestReplacement.approvalExpiresAt <= now,
                    ),
                    confirmationUrl:
                      latestReplacement.status === "PENDING"
                        ? latestReplacement.confirmationUrl
                        : null,
                    activatedAt: latestReplacement.activatedAt,
                    canceledAt: latestReplacement.canceledAt,
                    createdAt: latestReplacement.createdAt,
                  }
                : null,
            }
          : null,
    });
  });
}

/**
 * POST /api/flex/subscription/:id
 *
 * Authenticated lifecycle management for the owning app:
 *   { "intent": "pause", "pausedUntil": "<ISO-8601 timestamp>" }
 *   { "intent": "resume" }
 *   { "intent": "cancel" }
 */
export function action({ request, params }: ActionFunctionArgs) {
  return handleApi(async () => {
    if (request.method !== "POST") return apiError(405, "Method not allowed");

    const app = await requireApiApp(request);
    const parsed = actionSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success) {
      return apiError(400, "Invalid body", { issues: parsed.error.issues });
    }

    const subscriptionId = params.id ?? "";
    try {
      const result =
        parsed.data.intent === "pause"
          ? await pauseSubscription({
              subscriptionId,
              appId: app.id,
              pausedUntil: new Date(parsed.data.pausedUntil),
            })
          : parsed.data.intent === "resume"
            ? await resumeSubscription({ subscriptionId, appId: app.id })
            : await cancelSubscription({ subscriptionId, appId: app.id });

      return Response.json({
        id: result.id,
        status: result.status,
        pausedUntil: result.pausedUntil,
        canceledAt: result.canceledAt,
      });
    } catch (error) {
      return managementError(error);
    }
  });
}
