import type {
  Discount,
  DiscountMethod,
  DiscountType,
} from "../../../generated/prisma/client";
import { Prisma } from "../../../generated/prisma/client";
import { prisma } from "../db.server";
import { normalizeDiscountCode } from "./discounts.server";

const DISCOUNT_TYPES = ["PERCENTAGE", "AMOUNT", "FLAT_PRICE"] as const;
const DISCOUNT_METHODS = ["PRICE_REDUCTION", "APP_CREDITS"] as const;
const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{0,63}$/;
const PLAN_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/;
const DECIMAL_PATTERN = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/;
const MAX_DURATION_INTERVALS = 1_200;
const MAX_REDEMPTIONS = 1_000_000_000;

export interface DiscountMutationInput {
  /** The primary app — the one the discount is created for. */
  appId: string;
  /** Every app the discount is valid in; the primary is added if missing. */
  appIds?: string[];
  planId?: string | null;
  externalPlanKey?: string | null;
  code: string;
  type: string;
  value: string;
  discountMethod: string;
  durationIntervals?: string | number | null;
  currencyCode?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  maxRedemptions?: string | number | null;
  maxRedemptionsPerShop?: string | number | null;
  description?: string | null;
}

interface ValidatedDiscountInput {
  appId: string;
  /** Deduplicated, primary first. */
  appIds: string[];
  planId: string | null;
  externalPlanKey: string | null;
  code: string;
  normalizedCode: string;
  type: DiscountType;
  value: Prisma.Decimal;
  discountMethod: DiscountMethod;
  durationIntervals: number | null;
  currencyCode: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  maxRedemptions: number | null;
  maxRedemptionsPerShop: number | null;
  description: string | null;
}

export class DiscountManagementError extends Error {
  readonly status: number;
  readonly field?: string;

  constructor(
    message: string,
    options: { status?: number; field?: string } = {},
  ) {
    super(message);
    this.name = "DiscountManagementError";
    this.status = options.status ?? 400;
    this.field = options.field;
  }
}

function isOneOf<const T extends readonly string[]>(
  value: string,
  allowed: T,
): value is T[number] {
  return allowed.includes(value);
}

function optionalPositiveInteger(
  raw: string | number | null | undefined,
  field: string,
  label: string,
  max: number,
): number | null {
  const value = raw == null ? "" : String(raw).trim();
  if (!value) return null;
  if (!/^\d+$/.test(value)) {
    throw new DiscountManagementError(`${label} must be a positive integer.`, {
      field,
    });
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new DiscountManagementError(
      `${label} must be a whole number from 1 to ${max.toLocaleString()} — untick the option for no limit.`,
      { field },
    );
  }
  return parsed;
}

function optionalDate(value: string | null | undefined, field: string) {
  const raw = value?.trim();
  if (!raw) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new DiscountManagementError("Enter a valid date and time.", {
      field,
    });
  }
  return parsed;
}

function validateInput(input: DiscountMutationInput): ValidatedDiscountInput {
  const appId = input.appId.trim();
  if (!appId) {
    throw new DiscountManagementError("Choose an app.", { field: "appId" });
  }

  const normalizedCode = normalizeDiscountCode(input.code);
  if (!normalizedCode) {
    throw new DiscountManagementError("Enter a discount code.", {
      field: "code",
    });
  }
  if (!CODE_PATTERN.test(normalizedCode)) {
    throw new DiscountManagementError(
      "Code must be 1–64 characters using letters, numbers, underscores, or hyphens.",
      { field: "code" },
    );
  }

  if (!isOneOf(input.type, DISCOUNT_TYPES)) {
    throw new DiscountManagementError("Choose a valid discount type.", {
      field: "type",
    });
  }
  if (!isOneOf(input.discountMethod, DISCOUNT_METHODS)) {
    throw new DiscountManagementError("Choose a valid discount method.", {
      field: "discountMethod",
    });
  }

  const rawValue = input.value.trim();
  if (!DECIMAL_PATTERN.test(rawValue)) {
    throw new DiscountManagementError(
      "Value must be a positive number with no more than 12 whole and 6 decimal digits.",
      { field: "value" },
    );
  }
  const value = new Prisma.Decimal(rawValue);
  if (!value.greaterThan(0)) {
    throw new DiscountManagementError("Value must be greater than zero.", {
      field: "value",
    });
  }
  if (input.type === "PERCENTAGE" && value.greaterThan(100)) {
    throw new DiscountManagementError(
      "Percentage must be greater than 0 and at most 100.",
      {
        field: "value",
      },
    );
  }

  const externalPlanKey = input.externalPlanKey?.trim() || null;
  if (externalPlanKey && !PLAN_KEY_PATTERN.test(externalPlanKey)) {
    throw new DiscountManagementError(
      "Plan key must be 1–191 characters using letters, numbers, dots, colons, underscores, or hyphens.",
      { field: "externalPlanKey" },
    );
  }
  const currencyCode = input.currencyCode?.trim().toUpperCase() || null;
  if (input.type !== "PERCENTAGE" && !/^[A-Z]{3}$/.test(currencyCode ?? "")) {
    throw new DiscountManagementError(
      "Choose a three-letter currency for amount and flat-price discounts.",
      { field: "currencyCode" },
    );
  }
  const durationIntervals = optionalPositiveInteger(
    input.durationIntervals,
    "durationIntervals",
    "Billing cycles",
    MAX_DURATION_INTERVALS,
  );
  const maxRedemptions = optionalPositiveInteger(
    input.maxRedemptions,
    "maxRedemptions",
    "Total redemptions",
    MAX_REDEMPTIONS,
  );
  const maxRedemptionsPerShop = optionalPositiveInteger(
    input.maxRedemptionsPerShop,
    "maxRedemptionsPerShop",
    "Redemptions per store",
    MAX_REDEMPTIONS,
  );
  if (
    maxRedemptions &&
    maxRedemptionsPerShop &&
    maxRedemptionsPerShop > maxRedemptions
  ) {
    throw new DiscountManagementError(
      "Redemptions per store can't be more than the total redemptions.",
      { field: "maxRedemptionsPerShop" },
    );
  }
  const startsAt = optionalDate(input.startsAt, "startsAt");
  const endsAt = optionalDate(input.endsAt, "endsAt");
  if (startsAt && endsAt && endsAt <= startsAt) {
    throw new DiscountManagementError("Campaign end must be after its start.", {
      field: "endsAt",
    });
  }

  const description = input.description?.trim() || null;
  if (description && description.length > 191) {
    throw new DiscountManagementError(
      "Description must be 191 characters or fewer.",
      {
        field: "description",
      },
    );
  }

  const appIds = [...new Set([appId, ...(input.appIds ?? []).map((id) => id.trim()).filter(Boolean)])];
  const planId = input.planId?.trim() || null;
  /* A plan belongs to one app, so a plan-scoped discount can only be valid in
     that app — anywhere else it could never match and would only confuse. */
  if (planId && appIds.length > 1) {
    throw new DiscountManagementError(
      "A discount limited to one plan can only be available in that plan's app. Remove the plan limit, or the other apps.",
      { field: "appIds" },
    );
  }

  return {
    appId,
    appIds,
    planId,
    externalPlanKey,
    // Display and lookup use the same canonical value, avoiding visually
    // different aliases for one normalized code.
    code: normalizedCode,
    normalizedCode,
    type: input.type,
    value,
    discountMethod: input.discountMethod,
    durationIntervals,
    currencyCode: input.type === "PERCENTAGE" ? null : currencyCode,
    startsAt,
    endsAt,
    maxRedemptions,
    maxRedemptionsPerShop,
    description,
  };
}

async function assertAppAndPlan(
  organizationId: string,
  input: ValidatedDiscountInput,
): Promise<void> {
  // Every app, not just the primary: each must be this organization's own.
  const apps = await prisma.app.findMany({
    where: { id: { in: input.appIds }, organizationId },
    select: { id: true },
  });
  if (apps.length !== input.appIds.length) {
    throw new DiscountManagementError("Choose valid apps.", {
      status: 404,
      field: "appIds",
    });
  }
  const app = { id: input.appId };

  if (input.planId) {
    const plan = await prisma.plan.findFirst({
      where: { id: input.planId, appId: app.id },
      select: { id: true },
    });
    if (!plan) {
      throw new DiscountManagementError(
        "Choose a plan belonging to the selected app.",
        {
          status: 404,
          field: "planId",
        },
      );
    }
  }
}

function translateUniqueError(error: unknown): never {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  ) {
    throw new DiscountManagementError(
      // Codes are unique across the whole organization, whichever apps.
      "That discount code is already used by another discount.",
      { field: "code" },
    );
  }
  throw error;
}

export async function createDiscountForOrganization(
  organizationId: string,
  rawInput: DiscountMutationInput,
): Promise<Discount> {
  const input = validateInput(rawInput);
  await assertAppAndPlan(organizationId, input);

  const { appIds, ...fields } = input;
  try {
    return await prisma.discount.create({
      data: {
        ...fields,
        organizationId,
        orgCodeKey: input.normalizedCode,
        apps: { create: appIds.map((appId) => ({ appId })) },
      },
    });
  } catch (error) {
    return translateUniqueError(error);
  }
}

export async function updateDiscountForOrganization(
  organizationId: string,
  discountId: string,
  rawInput: DiscountMutationInput,
): Promise<Discount> {
  if (!discountId.trim()) {
    throw new DiscountManagementError("Missing discount id.");
  }
  const existing = await prisma.discount.findFirst({
    where: { id: discountId, app: { organizationId } },
  });
  if (!existing) {
    throw new DiscountManagementError("Discount not found.", { status: 404 });
  }

  const input = validateInput(rawInput);
  /* The primary app stays: redemptions and relations hang off it. Other apps
     can be added or removed freely. */
  if (input.appId !== existing.appId) {
    throw new DiscountManagementError(
      "A discount's original app can't be removed. Add or remove the other apps instead.",
      { field: "appIds" },
    );
  }
  await assertAppAndPlan(organizationId, input);
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.discountApp.deleteMany({
        where: { discountId: existing.id, appId: { notIn: input.appIds } },
      });
      await tx.discountApp.createMany({
        data: input.appIds.map((appId) => ({ discountId: existing.id, appId })),
        skipDuplicates: true,
      });
      return tx.discount.update({
      where: { id: existing.id },
      data: {
        orgCodeKey: input.normalizedCode,
        planId: input.planId,
        externalPlanKey: input.externalPlanKey,
        code: input.code,
        normalizedCode: input.normalizedCode,
        type: input.type,
        value: input.value,
        discountMethod: input.discountMethod,
        durationIntervals: input.durationIntervals,
        currencyCode: input.currencyCode,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        maxRedemptions: input.maxRedemptions,
        maxRedemptionsPerShop: input.maxRedemptionsPerShop,
        description: input.description,
      },
      });
    });
  } catch (error) {
    return translateUniqueError(error);
  }
}

export async function setDiscountActiveForOrganization(
  organizationId: string,
  discountId: string,
  active: boolean,
): Promise<Discount> {
  const existing = await prisma.discount.findFirst({
    where: { id: discountId, app: { organizationId } },
    select: { id: true },
  });
  if (!existing) {
    throw new DiscountManagementError("Discount not found.", { status: 404 });
  }
  return prisma.discount.update({
    where: { id: existing.id },
    data: { active },
  });
}

/**
 * Permanently remove a discount — only one nobody has used.
 *
 * A redeemed code is the record of what merchants were charged: the
 * redemption rows are `onDelete: Restrict` for exactly that reason, and
 * SubscriptionDiscount windows would cascade away a flex merchant's discount
 * history. So a used discount is refused with a pointer to Disable, which
 * stops new use and keeps the history. An unused one is deleted outright.
 */
export async function deleteDiscountForOrganization(
  organizationId: string,
  discountId: string,
): Promise<{ code: string | null }> {
  const existing = await prisma.discount.findFirst({
    where: { id: discountId, organizationId },
    select: {
      id: true,
      code: true,
      _count: {
        select: {
          redemptions: true,
          subscriptionDiscounts: true,
        },
      },
    },
  });
  if (!existing) {
    throw new DiscountManagementError("Discount not found.", { status: 404 });
  }
  const used = existing._count.redemptions + existing._count.subscriptionDiscounts;
  if (used > 0) {
    throw new DiscountManagementError(
      `${existing.code ?? "This discount"} has been used ${used} time${used === 1 ? "" : "s"}, so it can't be deleted — that history is what merchants were charged. Disable it instead to stop new use.`,
      { status: 409 },
    );
  }
  await prisma.discount.delete({ where: { id: existing.id } });
  return { code: existing.code };
}
