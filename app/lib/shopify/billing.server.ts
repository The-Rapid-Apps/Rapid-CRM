import type { App, AppInstall } from "../../../generated/prisma/client";
import { logger } from "../logger.server";
import { toShopifyPrice, D, type Money } from "../money.server";
import { adminGraphql } from "./admin.server";
import {
  effectivePartnerCredentials,
  partnerGraphqlWithCredentials,
  type PartnerApp,
} from "./partner.server";

const log = logger.scope("shopify-billing");

type AppCreds = Pick<App, "id" | "shopifyApiKey" | "shopifyApiSecret">;
type Install = Pick<AppInstall, "shopDomain" | "accessToken" | "scope">;

interface UserError {
  field?: string[] | null;
  message: string;
}

/**
 * Thrown when Shopify rejects a Billing API call because the app is not
 * publicly distributed. Per spec §7 the daily cron MUST swallow this
 * per-subscription rather than aborting the whole batch — callers catch it.
 */
export class PrivateAppBillingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivateAppBillingError";
  }
}

const PRIVATE_APP_RE = /public distribution cannot use the billing api/i;

function throwIfPrivateApp(errors: UserError[]) {
  const hit = errors.find((e) => PRIVATE_APP_RE.test(e.message));
  if (hit) throw new PrivateAppBillingError(hit.message);
}

function joinErrors(errors: UserError[]): string {
  return errors.map((e) => e.message).join("; ");
}

// ---------------------------------------------------------------------------
// §2.1 appSubscriptionCreate — one subscription, two line items
// ---------------------------------------------------------------------------

const APP_SUBSCRIPTION_CREATE = /* GraphQL */ `
  mutation AppSubscriptionCreate(
    $name: String!
    $test: Boolean
    $lineItems: [AppSubscriptionLineItemInput!]!
    $returnUrl: URL!
    $trialDays: Int
  ) {
    appSubscriptionCreate(
      name: $name
      test: $test
      lineItems: $lineItems
      returnUrl: $returnUrl
      trialDays: $trialDays
    ) {
      appSubscription {
        id
        test
        trialDays
        currentPeriodEnd
        lineItems {
          id
          plan {
            pricingDetails {
              __typename
            }
          }
        }
      }
      confirmationUrl
      userErrors {
        field
        message
      }
    }
  }
`;

interface AppSubscriptionCreateResponse {
  appSubscriptionCreate: {
    appSubscription: {
      id: string;
      test: boolean;
      trialDays: number | null;
      currentPeriodEnd: string | null;
      lineItems: Array<{
        id: string;
        plan: { pricingDetails: { __typename: string } };
      }>;
    } | null;
    confirmationUrl: string | null;
    userErrors: UserError[];
  };
}

export interface CreateSubscriptionParams {
  name: string;
  test: boolean;
  currencyCode: string;
  /** Usage line spend ceiling (plan.usageChargeCappedAmount). */
  cappedAmount: Money | string | number;
  /** Customer-facing text on the usage line (plan.flexBillingTerms). */
  terms: string;
  returnUrl: string;
}

export interface CreateSubscriptionResult {
  shopifySubscriptionId: string;
  usageLineItemId: string;
  confirmationUrl: string;
  test: boolean;
}

/**
 * Creates the single Shopify subscription with a $0 recurring line + a capped
 * usage line. `trialDays` is ALWAYS 0 to Shopify — trials are local (spec §5.3).
 * Returns the usage line item GID (the single most important id to persist).
 */
export async function appSubscriptionCreate(
  app: AppCreds,
  install: Install,
  params: CreateSubscriptionParams,
): Promise<CreateSubscriptionResult> {
  const variables = {
    name: params.name,
    test: params.test,
    returnUrl: params.returnUrl,
    // MUST be 0 — trials are managed locally, never by Shopify.
    trialDays: 0,
    lineItems: [
      {
        plan: {
          appRecurringPricingDetails: {
            // The line that would require re-approval if it changed — so it
            // never changes. Fixed at $0.
            price: { amount: 0, currencyCode: params.currencyCode },
            interval: "EVERY_30_DAYS",
          },
        },
      },
      {
        plan: {
          appUsagePricingDetails: {
            terms: params.terms,
            cappedAmount: {
              amount: toShopifyPrice(params.cappedAmount),
              currencyCode: params.currencyCode,
            },
          },
        },
      },
    ],
  };

  const data = await adminGraphql<AppSubscriptionCreateResponse>(
    app,
    install,
    APP_SUBSCRIPTION_CREATE,
    variables,
  );
  const result = data.appSubscriptionCreate;

  if (result.userErrors.length) {
    throwIfPrivateApp(result.userErrors);
    throw new Error(
      `appSubscriptionCreate failed: ${joinErrors(result.userErrors)}`,
    );
  }
  const sub = result.appSubscription;
  if (!sub || !result.confirmationUrl) {
    throw new Error(
      "appSubscriptionCreate returned no subscription/confirmationUrl",
    );
  }

  const usageLine = sub.lineItems.find(
    (li) => li.plan.pricingDetails.__typename === "AppUsagePricing",
  );
  if (!usageLine) {
    throw new Error(
      "appSubscriptionCreate returned no AppUsagePricing line item",
    );
  }

  return {
    shopifySubscriptionId: sub.id,
    usageLineItemId: usageLine.id,
    confirmationUrl: result.confirmationUrl,
    test: sub.test,
  };
}

// ---------------------------------------------------------------------------
// Standard billing: the same mutation, without flex's two constraints
// ---------------------------------------------------------------------------

export interface CreateStandardSubscriptionParams {
  name: string;
  test: boolean;
  returnUrl: string;
  /**
   * Built by `buildStandardLineItems`. Passed in rather than derived here so the
   * per-model rules stay pure and testable without a Shopify account.
   */
  lineItems: unknown[];
  /**
   * Days of trial SHOPIFY runs.
   *
   * The opposite of `appSubscriptionCreate` above, which hard-codes 0 because
   * flex owns its own trial clock. On the standard rail Shopify owns the billing
   * clock, so it must own the trial too — a locally-tracked trial would let
   * Shopify bill on day one while this platform still believed the merchant was
   * trialling.
   */
  trialDays: number;
}

export interface CreateStandardSubscriptionResult {
  shopifySubscriptionId: string;
  confirmationUrl: string;
  test: boolean;
  currentPeriodEnd: string | null;
  /** Present when the plan has a recurring price. */
  recurringLineItemId: string | null;
  /**
   * Present only for a plan with a usage line. MUST be persisted when it is —
   * `appUsageRecordCreate` and every cap resize address the line by this GID.
   */
  usageLineItemId: string | null;
}

/**
 * Create a standard (Shopify-collected) subscription.
 *
 * Deliberately a sibling of `appSubscriptionCreate` rather than a flag on it.
 * That function's two hard-coded choices — `trialDays: 0` and a mandatory
 * `AppUsagePricing` line — are not incidental, they are what makes flex's
 * re-approval-free tier changes work, and loosening them in place would put the
 * proven path one boolean away from breaking. Standard billing needs the exact
 * opposite of both.
 *
 * Returns the confirmation URL and nothing else happens: the caller sends the
 * merchant there and the subscription becomes active only after the return
 * handler re-queries Shopify (spec §0.3 — the redirect is a trigger, not proof).
 */
export async function appSubscriptionCreateStandard(
  app: AppCreds,
  install: Install,
  params: CreateStandardSubscriptionParams,
): Promise<CreateStandardSubscriptionResult> {
  if (params.lineItems.length === 0) {
    throw new Error(
      "appSubscriptionCreateStandard needs at least one line item; a free plan " +
        "with no usage line must be activated locally instead.",
    );
  }

  const data = await adminGraphql<AppSubscriptionCreateResponse>(
    app,
    install,
    APP_SUBSCRIPTION_CREATE,
    {
      name: params.name,
      test: params.test,
      returnUrl: params.returnUrl,
      trialDays: params.trialDays,
      lineItems: params.lineItems,
    },
  );
  const result = data.appSubscriptionCreate;

  if (result.userErrors.length) {
    throwIfPrivateApp(result.userErrors);
    throw new Error(
      `appSubscriptionCreate failed: ${joinErrors(result.userErrors)}`,
    );
  }
  const sub = result.appSubscription;
  if (!sub || !result.confirmationUrl) {
    throw new Error(
      "appSubscriptionCreate returned no subscription/confirmationUrl",
    );
  }

  const lineOfType = (typename: string) =>
    sub.lineItems.find((li) => li.plan.pricingDetails.__typename === typename)
      ?.id ?? null;

  return {
    shopifySubscriptionId: sub.id,
    confirmationUrl: result.confirmationUrl,
    test: sub.test,
    currentPeriodEnd: sub.currentPeriodEnd,
    recurringLineItemId: lineOfType("AppRecurringPricing"),
    // Null is a legitimate answer here, unlike in the flex path where its
    // absence is a hard error.
    usageLineItemId: lineOfType("AppUsagePricing"),
  };
}

// ---------------------------------------------------------------------------
// One-time purchases — a different Shopify object, not a subscription
// ---------------------------------------------------------------------------

const APP_PURCHASE_ONE_TIME_CREATE = /* GraphQL */ `
  mutation AppPurchaseOneTimeCreate(
    $name: String!
    $price: MoneyInput!
    $returnUrl: URL!
    $test: Boolean
  ) {
    appPurchaseOneTimeCreate(
      name: $name
      price: $price
      returnUrl: $returnUrl
      test: $test
    ) {
      appPurchaseOneTime {
        id
        name
        status
        test
      }
      confirmationUrl
      userErrors {
        field
        message
      }
    }
  }
`;

interface AppPurchaseOneTimeCreateResponse {
  appPurchaseOneTimeCreate: {
    appPurchaseOneTime: {
      id: string;
      name: string;
      status: string;
      test: boolean;
    } | null;
    confirmationUrl: string | null;
    userErrors: UserError[];
  };
}

export interface CreateOneTimePurchaseParams {
  name: string;
  amount: Money | string | number;
  currencyCode: string;
  returnUrl: string;
  test: boolean;
}

export interface CreateOneTimePurchaseResult {
  platformId: string;
  confirmationUrl: string;
  status: string;
  test: boolean;
}

/**
 * Create a one-time purchase (spec §5.5).
 *
 * NOT `appSubscriptionCreate` and not a line item on one: this returns an
 * `AppPurchaseOneTime`, which has no interval, no trial, no discount and no
 * cycle to renew. It therefore also gets no entry in the subscription mirror —
 * putting it there would make every single-active-subscription query and every
 * period sweep special-case a thing that has no period.
 */
export async function appPurchaseOneTimeCreate(
  app: AppCreds,
  install: Install,
  params: CreateOneTimePurchaseParams,
): Promise<CreateOneTimePurchaseResult> {
  const data = await adminGraphql<AppPurchaseOneTimeCreateResponse>(
    app,
    install,
    APP_PURCHASE_ONE_TIME_CREATE,
    {
      name: params.name,
      price: {
        amount: toShopifyPrice(params.amount),
        currencyCode: params.currencyCode,
      },
      returnUrl: params.returnUrl,
      test: params.test,
    },
  );
  const result = data.appPurchaseOneTimeCreate;
  if (result.userErrors.length) {
    throwIfPrivateApp(result.userErrors);
    throw new Error(
      `appPurchaseOneTimeCreate failed: ${joinErrors(result.userErrors)}`,
    );
  }
  const purchase = result.appPurchaseOneTime;
  if (!purchase || !result.confirmationUrl) {
    throw new Error(
      "appPurchaseOneTimeCreate returned no purchase/confirmationUrl",
    );
  }
  return {
    platformId: purchase.id,
    confirmationUrl: result.confirmationUrl,
    status: purchase.status,
    test: purchase.test,
  };
}

const APP_PURCHASE_ONE_TIME_STATUS = /* GraphQL */ `
  query AppPurchaseOneTimeStatus($id: ID!) {
    node(id: $id) {
      ... on AppPurchaseOneTime {
        id
        status
      }
    }
  }
`;

interface AppPurchaseOneTimeStatusResponse {
  node: { id: string; status: string } | null;
}

/**
 * Re-read a one-time purchase's status. Same rule as a subscription: the return
 * redirect is a trigger, not proof of payment (spec §0.3).
 */
export async function getAppPurchaseOneTimeStatus(
  app: AppCreds,
  install: Install,
  platformId: string,
): Promise<string | null> {
  const data = await adminGraphql<AppPurchaseOneTimeStatusResponse>(
    app,
    install,
    APP_PURCHASE_ONE_TIME_STATUS,
    { id: platformId },
  );
  return data.node?.status ?? null;
}

// ---------------------------------------------------------------------------
// §2.2 appUsageRecordCreate — the workhorse (recurring fee AND upgrade proration)
// ---------------------------------------------------------------------------

const APP_USAGE_RECORD_CREATE = /* GraphQL */ `
  mutation AppUsageRecordCreate(
    $description: String!
    $price: MoneyInput!
    $subscriptionLineItemId: ID!
    $idempotencyKey: String
  ) {
    appUsageRecordCreate(
      description: $description
      price: $price
      subscriptionLineItemId: $subscriptionLineItemId
      idempotencyKey: $idempotencyKey
    ) {
      appUsageRecord {
        id
        subscriptionLineItem {
          plan {
            pricingDetails {
              ... on AppUsagePricing {
                balanceUsed {
                  amount
                  currencyCode
                }
                cappedAmount {
                  amount
                  currencyCode
                }
              }
            }
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

interface AppUsageRecordCreateResponse {
  appUsageRecordCreate: {
    appUsageRecord: {
      id: string;
      subscriptionLineItem: {
        plan: {
          pricingDetails: {
            balanceUsed?: { amount: string; currencyCode: string };
            cappedAmount?: { amount: string; currencyCode: string };
          };
        };
      };
    } | null;
    userErrors: UserError[];
  };
}

/** Discriminated result — a full cap or inactive sub is a SOFT no-op, not an error. */
export type UsageRecordResult =
  | {
      status: "created";
      id: string;
      balanceUsed: Money | null;
      cappedAmount: Money | null;
    }
  | { status: "soft_noop"; reason: "cap_full" | "not_active" };

const CAP_FULL_RE = /total price exceeds balance remaining/i;
const NOT_ACTIVE_RE = /subscription is not active/i;

/**
 * Posts a usage record (the monthly fee, or an upgrade proration charge).
 *
 * Per spec §2.2 two userErrors are treated as SOFT no-ops (return, don't throw):
 *   - "Total price exceeds balance remaining"  → the cap is full
 *   - "Subscription is not active"
 * Any other userError throws. The private-app error throws PrivateAppBillingError.
 *
 * NEVER call this with a $0 price — Shopify rejects $0 usage records; advance
 * the period instead (spec §7). The amount is rounded to 2dp here.
 */
export async function appUsageRecordCreate(
  app: AppCreds,
  install: Install,
  params: {
    description: string;
    amount: Money | string | number;
    currencyCode: string;
    subscriptionLineItemId: string;
    /** Stable per-money-movement key. Shopify deduplicates retries with it. */
    idempotencyKey: string;
  },
): Promise<UsageRecordResult> {
  const price = toShopifyPrice(params.amount);
  if (D(price).lessThanOrEqualTo(0)) {
    // Guard: this should never be reached — callers must advance the clock for
    // $0 instead of posting. Treated as a soft no-op to be safe.
    log.warn("appUsageRecordCreate called with non-positive amount; skipping", {
      shop: install.shopDomain,
      amount: price,
    });
    return { status: "soft_noop", reason: "not_active" };
  }

  const data = await adminGraphql<AppUsageRecordCreateResponse>(
    app,
    install,
    APP_USAGE_RECORD_CREATE,
    {
      description: params.description,
      price: { amount: price, currencyCode: params.currencyCode },
      subscriptionLineItemId: params.subscriptionLineItemId,
      idempotencyKey: params.idempotencyKey,
    },
  );
  const result = data.appUsageRecordCreate;

  if (result.userErrors.length) {
    throwIfPrivateApp(result.userErrors);
    const msg = joinErrors(result.userErrors);
    if (result.userErrors.some((e) => CAP_FULL_RE.test(e.message))) {
      log.warn("Usage record soft no-op: cap full", {
        shop: install.shopDomain,
      });
      return { status: "soft_noop", reason: "cap_full" };
    }
    if (result.userErrors.some((e) => NOT_ACTIVE_RE.test(e.message))) {
      log.warn("Usage record soft no-op: subscription not active", {
        shop: install.shopDomain,
      });
      return { status: "soft_noop", reason: "not_active" };
    }
    throw new Error(`appUsageRecordCreate failed: ${msg}`);
  }

  const record = result.appUsageRecord;
  if (!record) throw new Error("appUsageRecordCreate returned no record");
  const pricing = record.subscriptionLineItem.plan.pricingDetails;

  return {
    status: "created",
    id: record.id,
    balanceUsed: pricing.balanceUsed ? D(pricing.balanceUsed.amount) : null,
    cappedAmount: pricing.cappedAmount ? D(pricing.cappedAmount.amount) : null,
  };
}

// ---------------------------------------------------------------------------
// §2.3 appSubscriptionLineItemUpdate — resize the cap
// ---------------------------------------------------------------------------

const APP_SUBSCRIPTION_LINE_ITEM_UPDATE = /* GraphQL */ `
  mutation AppSubscriptionLineItemUpdate($id: ID!, $cappedAmount: MoneyInput!) {
    appSubscriptionLineItemUpdate(id: $id, cappedAmount: $cappedAmount) {
      confirmationUrl
      appSubscription {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

interface LineItemUpdateResponse {
  appSubscriptionLineItemUpdate: {
    confirmationUrl: string | null;
    appSubscription: { id: string } | null;
    userErrors: UserError[];
  };
}

/**
 * Resize the usage cap. NOTE: raising the cap returns a confirmationUrl that
 * requires merchant re-approval (spec §2.3) — size the cap generously at create
 * time to avoid ever needing this on the hot path.
 */
export async function appSubscriptionLineItemUpdate(
  app: AppCreds,
  install: Install,
  params: {
    lineItemId: string;
    cappedAmount: Money | string | number;
    currencyCode: string;
  },
): Promise<{ confirmationUrl: string | null }> {
  const data = await adminGraphql<LineItemUpdateResponse>(
    app,
    install,
    APP_SUBSCRIPTION_LINE_ITEM_UPDATE,
    {
      id: params.lineItemId,
      cappedAmount: {
        amount: toShopifyPrice(params.cappedAmount),
        currencyCode: params.currencyCode,
      },
    },
  );
  const result = data.appSubscriptionLineItemUpdate;
  if (result.userErrors.length) {
    throwIfPrivateApp(result.userErrors);
    throw new Error(
      `appSubscriptionLineItemUpdate failed: ${joinErrors(result.userErrors)}`,
    );
  }
  return { confirmationUrl: result.confirmationUrl };
}

// ---------------------------------------------------------------------------
// §2.4 appCreditCreate — downgrade credits (PARTNER API)
// ---------------------------------------------------------------------------

const APP_CREDIT_CREATE = /* GraphQL */ `
  mutation AppCreditCreate(
    $amount: MoneyInput!
    $appId: ID!
    $shopId: ID!
    $description: String!
    $test: Boolean
  ) {
    appCreditCreate(
      amount: $amount
      appId: $appId
      shopId: $shopId
      description: $description
      test: $test
    ) {
      appCredit {
        id
        amount {
          amount
          currencyCode
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

interface AppCreditCreateResponse {
  appCreditCreate: {
    appCredit: { id: string } | null;
    userErrors: UserError[];
  };
}

/**
 * Issues a credit via the PARTNER API (not the shop Admin API). Shopify
 * credits are IRREVERSIBLE once issued.
 *
 * Gated only on generic Partner API credential presence, NOT the Flex-only
 * `FLEX_PARTNER_CREDITS_ENABLED` flag — Flex's own downgrade-credit callers
 * (app-credit.server.ts, tier-change.server.ts) already check
 * `isPartnerApiConfigured`/`isPartnerApiEnabled` themselves before calling
 * this, so that protection isn't lost. The admin-initiated "Issue app
 * credit" action (customer-detail.tsx) intentionally must NOT depend on the
 * Flex flag — see CLAUDE.md's warning against conflating the two gates.
 */
export async function appCreditCreate(
  app: PartnerApp,
  params: {
    amount: Money | string | number;
    currencyCode: string;
    /** Partner Shop id, e.g. gid://partners/Shop/<shopPlatformId>. */
    shopId: string;
    description: string;
    test: boolean;
  },
): Promise<{ id: string }> {
  if (!app.shopifyAppId) {
    throw new Error(
      "appCreditCreate requires app.shopifyAppId (Partner App gid)",
    );
  }
  const credentials = effectivePartnerCredentials(app);
  if (!credentials) {
    throw new Error(
      "appCreditCreate requires a working Shopify Partner connection",
    );
  }
  const data = await partnerGraphqlWithCredentials<AppCreditCreateResponse>(
    credentials,
    APP_CREDIT_CREATE,
    {
      amount: {
        amount: toShopifyPrice(params.amount),
        currencyCode: params.currencyCode,
      },
      appId: app.shopifyAppId,
      shopId: params.shopId,
      description: params.description,
      test: params.test,
    },
  );
  const result = data.appCreditCreate;
  if (result.userErrors.length) {
    throw new Error(`appCreditCreate failed: ${joinErrors(result.userErrors)}`);
  }
  if (!result.appCredit) throw new Error("appCreditCreate returned no credit");
  return { id: result.appCredit.id };
}

// ---------------------------------------------------------------------------
// Query: current status of an AppSubscription (used by the charge-return
// callback to confirm the merchant actually approved).
// ---------------------------------------------------------------------------

const APP_SUBSCRIPTION_STATUS = /* GraphQL */ `
  query AppSubscriptionStatus($id: ID!) {
    node(id: $id) {
      ... on AppSubscription {
        id
        status
        currentPeriodEnd
      }
    }
  }
`;

interface AppSubscriptionStatusResponse {
  node: { id: string; status: string; currentPeriodEnd: string | null } | null;
}

export async function getAppSubscriptionStatus(
  app: AppCreds,
  install: Install,
  shopifySubscriptionId: string,
): Promise<{ status: string; currentPeriodEnd: string | null } | null> {
  const data = await adminGraphql<AppSubscriptionStatusResponse>(
    app,
    install,
    APP_SUBSCRIPTION_STATUS,
    { id: shopifySubscriptionId },
  );
  if (!data.node) return null;
  return {
    status: data.node.status,
    currentPeriodEnd: data.node.currentPeriodEnd,
  };
}

// ---------------------------------------------------------------------------
// Query: live usage-line balance (spec §5.a — refetch before an upgrade charge)
// ---------------------------------------------------------------------------

const USAGE_LINE_BALANCE = /* GraphQL */ `
  query UsageLineBalance($id: ID!) {
    node(id: $id) {
      ... on AppSubscription {
        lineItems {
          id
          plan {
            pricingDetails {
              ... on AppUsagePricing {
                balanceUsed {
                  amount
                }
                cappedAmount {
                  amount
                }
              }
            }
          }
        }
      }
    }
  }
`;

interface UsageLineBalanceResponse {
  node: {
    lineItems: Array<{
      id: string;
      plan: {
        pricingDetails: {
          balanceUsed?: { amount: string };
          cappedAmount?: { amount: string };
        };
      };
    }>;
  } | null;
}

/** Live balanceUsed / cappedAmount for the usage line of a subscription. */
export async function getUsageLineBalance(
  app: AppCreds,
  install: Install,
  shopifySubscriptionId: string,
  usageLinePlatformId: string,
): Promise<{ balanceUsed: Money; cappedAmount: Money } | null> {
  const data = await adminGraphql<UsageLineBalanceResponse>(
    app,
    install,
    USAGE_LINE_BALANCE,
    { id: shopifySubscriptionId },
  );
  if (!data.node) return null;
  const line =
    data.node.lineItems.find((li) => li.id === usageLinePlatformId) ??
    data.node.lineItems.find((li) => li.plan.pricingDetails.cappedAmount);
  if (!line?.plan.pricingDetails.cappedAmount) return null;
  return {
    balanceUsed: D(line.plan.pricingDetails.balanceUsed?.amount ?? 0),
    cappedAmount: D(line.plan.pricingDetails.cappedAmount.amount),
  };
}

// ---------------------------------------------------------------------------
// §2.5 appSubscriptionCancel — real cancellation only
// ---------------------------------------------------------------------------

const APP_SUBSCRIPTION_CANCEL = /* GraphQL */ `
  mutation AppSubscriptionCancel($id: ID!, $prorate: Boolean) {
    appSubscriptionCancel(id: $id, prorate: $prorate) {
      appSubscription {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

interface AppSubscriptionCancelResponse {
  appSubscriptionCancel: {
    appSubscription: { id: string; status: string } | null;
    userErrors: UserError[];
  };
}

/**
 * Cancel the Shopify subscription for REAL. In-place tier changes must NOT call
 * this — they cancel the prior subscription locally only and reuse the single
 * Shopify subscription (spec §2.5 / §5.c).
 */
export async function appSubscriptionCancel(
  app: AppCreds,
  install: Install,
  params: { shopifySubscriptionId: string; prorate?: boolean },
): Promise<{ status: string }> {
  const data = await adminGraphql<AppSubscriptionCancelResponse>(
    app,
    install,
    APP_SUBSCRIPTION_CANCEL,
    { id: params.shopifySubscriptionId, prorate: params.prorate ?? false },
  );
  const result = data.appSubscriptionCancel;
  if (result.userErrors.length) {
    throwIfPrivateApp(result.userErrors);
    throw new Error(
      `appSubscriptionCancel failed: ${joinErrors(result.userErrors)}`,
    );
  }
  return { status: result.appSubscription?.status ?? "CANCELLED" };
}
