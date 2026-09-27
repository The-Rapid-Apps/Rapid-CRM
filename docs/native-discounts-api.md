# Native Shopify billing discounts

This guide is for engineers integrating a Shopify app with the centrally
managed discounts in Rapid.

Rapid owns discount definitions, eligibility, redemption limits, and
the redemption audit trail. Each consuming Shopify app continues to own its
plan catalog, merchant OAuth installation, and Shopify
`appSubscriptionCreate` mutation. Rapid never creates, approves,
activates, or charges a native Shopify subscription.

This API is for apps using normal Shopify-managed app billing. Apps using the
separate flex-billing engine should use `/api/flex/discount/resolve` instead.

Shopify references:

- [`appSubscriptionCreate`](https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/appSubscriptionCreate)
- [`AppSubscriptionDiscountInput`](https://shopify.dev/docs/api/admin-graphql/2026-07/input-objects/AppSubscriptionDiscountInput)
- [`currentAppInstallation`](https://shopify.dev/docs/api/admin-graphql/2026-07/queries/currentAppInstallation)

## Architecture and ownership

| Responsibility | Rapid | Consuming Shopify app |
| --- | --- | --- |
| Define, activate, and expire discount campaigns | Yes | No |
| Enforce app, plan, currency, date, and redemption rules | Yes | No |
| Keep the app's plan catalog and prices | No | Yes |
| Authenticate the merchant and retain the offline Admin API token | No | Yes |
| Call Shopify `appSubscriptionCreate` | No | Yes |
| Redirect the merchant to Shopify's confirmation URL | No | Yes |
| Verify the approved subscription with Shopify | No | Yes |
| Record the applied discount redemption | Yes | Calls the confirmation API |
| Charge and collect subscription money | No | Shopify |

The consuming app must not copy the discount table into its own database. It
may store the returned reservation ID and the Shopify subscription GID needed
to complete or release the checkout intent.

## End-to-end sequence

```text
Merchant enters a code
        |
        v
Consuming app backend
        |
        |  POST /api/discounts/resolve
        v
Rapid validates and reserves capacity for 15 minutes
        |
        |  returns shopifyDiscount + redemption ID
        v
Consuming app calls Shopify appSubscriptionCreate
        |
        +---------------- merchant declines / abandons -----------------+
        |                                                              |
        v                                                              v
Merchant approves on Shopify                              DELETE redemption
        |
        v
App return route queries Shopify and matches the active subscription GID
        |
        v
POST redemption confirmation
        |
        v
Rapid records an immutable APPLIED redemption
```

Do not confirm a redemption merely because Shopify redirected the browser to
the app. The consuming app must query Shopify using its offline Admin API token
and verify that the exact returned `AppSubscription` is active.

## App setup

1. Register the consuming app in **Rapid → Apps**.
2. Open the app detail page and copy its platform API key and native-discount
   endpoint URLs.
3. Store the platform API key as a server-side secret in the consuming app.
   Never expose it in browser JavaScript, an app extension, logs, or source
   control.
4. Choose a stable `externalPlanKey` for every app-owned plan, such as
   `starter-monthly` or `pro-annual`. The same key must be used when the
   discount is configured and when the app resolves it.

The base URL is the deployed Rapid origin. For example:

```text
https://management.example.com/api/discounts/resolve
```

All requests use:

```http
Authorization: Bearer <platform-api-key>
Content-Type: application/json
```

`X-Api-Key: <platform-api-key>` is also accepted, but Bearer authentication is
preferred. Responses use `Cache-Control: private, no-store`.

## 1. Reserve and resolve

Resolve the code from the consuming app's backend before creating the Shopify
subscription:

```http
POST /api/discounts/resolve
Authorization: Bearer <platform-api-key>
Content-Type: application/json
Idempotency-Key: checkout-or-subscription-intent-id
```

```json
{
  "code": "SAVE20",
  "shopDomain": "example.myshopify.com",
  "externalPlanKey": "pro-monthly",
  "listPrice": "49.00",
  "currencyCode": "USD"
}
```

Field requirements:

| Field | Requirement |
| --- | --- |
| `code` | 1–64 characters; matching is trimmed and case-insensitive |
| `shopDomain` | Canonical `*.myshopify.com` domain, not a custom storefront domain |
| `externalPlanKey` | Stable app-owned plan key, 1–191 URL-safe characters |
| `listPrice` | Positive decimal string representing the undiscounted recurring price |
| `currencyCode` | Uppercase three-letter ISO currency code |
| `Idempotency-Key` | Stable key for one checkout intent, 8–191 characters |

Successful response:

```json
{
  "valid": true,
  "discount": {
    "id": "discount-id",
    "code": "SAVE20",
    "type": "PERCENTAGE",
    "value": "20",
    "durationIntervals": 3,
    "externalPlanKey": "pro-monthly",
    "description": "20% off the first three billing intervals"
  },
  "reservation": {
    "id": "redemption-id",
    "status": "RESERVED",
    "expiresAt": "2026-07-29T13:00:00.000Z"
  },
  "pricing": {
    "listPrice": "49.00",
    "priceAfterDiscount": "39.20",
    "currencyCode": "USD"
  },
  "shopifyDiscount": {
    "value": { "percentage": 0.2 },
    "durationLimitInIntervals": 3
  }
}
```

The reservation counts against campaign and per-shop limits for 15 minutes.
Retrying the same intent with the same idempotency key returns the same active
reservation. Reusing that key with a different shop, plan, currency, or price
returns `IDEMPOTENCY_CONFLICT`.

### Discount type mapping

| Rapid type | Stored value example | Shopify value returned |
| --- | --- | --- |
| Percentage | `20` | `{ "percentage": 0.2 }` |
| Amount off | `5.00 USD` | `{ "amount": "5.00" }` |
| Flat price | `39.00 USD` on a `49.00` plan | `{ "amount": "10.00" }` |

Shopify expects percentages as fractions: 20% is `0.2`. Amount and flat-price
discounts must use the same currency as the plan. A missing
`durationLimitInIntervals` means that Shopify applies the discount
indefinitely.

`APP_CREDITS` and usage-line discounts are not supported by this native
discount API. The returned discount applies only to the recurring pricing line.

## 2. Create the native Shopify subscription

Put the returned `shopifyDiscount` directly under
`appRecurringPricingDetails.discount`. Keep the original list price in the
Shopify input; Shopify applies the returned discount.

```graphql
mutation AppSubscriptionCreate(
  $name: String!
  $returnUrl: URL!
  $lineItems: [AppSubscriptionLineItemInput!]!
) {
  appSubscriptionCreate(
    name: $name
    returnUrl: $returnUrl
    lineItems: $lineItems
  ) {
    appSubscription {
      id
    }
    confirmationUrl
    userErrors {
      field
      message
    }
  }
}
```

Example variables:

```json
{
  "name": "Pro monthly",
  "returnUrl": "https://app.example.com/billing/return?redemptionId=redemption-id",
  "lineItems": [
    {
      "plan": {
        "appRecurringPricingDetails": {
          "price": {
            "amount": "49.00",
            "currencyCode": "USD"
          },
          "interval": "EVERY_30_DAYS",
          "discount": {
            "value": {
              "percentage": 0.2
            },
            "durationLimitInIntervals": 3
          }
        }
      }
    }
  ]
}
```

Treat any Shopify `userErrors` or missing `confirmationUrl` as a failed
checkout attempt and release the reservation. Redirect the merchant only to
the `confirmationUrl` returned by Shopify.

## 3. Verify Shopify approval

After the merchant returns, query Shopify from the consuming app's backend:

```graphql
query CurrentAppSubscriptions {
  currentAppInstallation {
    activeSubscriptions {
      id
      status
    }
  }
}
```

The expected Shopify subscription GID must appear in `activeSubscriptions`.
Match the full GID rather than accepting any active subscription. This prevents
an old subscription or a forged return request from consuming the reservation.

## 4. Confirm the redemption

Only after Shopify verification:

```http
POST /api/discounts/redemptions/{redemptionId}
Authorization: Bearer <platform-api-key>
Content-Type: application/json
```

```json
{
  "shopifySubscriptionId": "gid://shopify/AppSubscription/123456"
}
```

Successful response:

```json
{
  "id": "redemption-id",
  "status": "APPLIED",
  "shopifySubscriptionId": "gid://shopify/AppSubscription/123456",
  "appliedAt": "2026-07-29T12:50:00.000Z"
}
```

Confirmation is idempotent for the same Shopify subscription GID. It records
the immutable applied-redemption snapshot; it does not activate anything in
Shopify.

## 5. Release declined or abandoned approval

Release a reservation when `appSubscriptionCreate` fails, the merchant
declines, or the app determines that the expected subscription is not active:

```http
DELETE /api/discounts/redemptions/{redemptionId}
Authorization: Bearer <platform-api-key>
```

Successful response:

```json
{
  "id": "redemption-id",
  "status": "RELEASED",
  "releasedAt": "2026-07-29T12:52:00.000Z"
}
```

Release returns campaign capacity immediately. Expired reservations stop
counting automatically after 15 minutes. An already applied redemption cannot
be released.

## Business-rule responses

Business-rule rejections from the resolve endpoint return HTTP 200 with
`valid: false` so the consuming app can show a normal checkout message.

| Reason | Meaning |
| --- | --- |
| `NOT_FOUND` | No matching code exists for the authenticated app |
| `INACTIVE` | The discount was disabled |
| `NOT_STARTED` | The discount start date is in the future |
| `EXPIRED` | The discount end date has passed |
| `PLAN_MISMATCH` | The code is not valid for `externalPlanKey` |
| `CURRENCY_MISMATCH` | An amount/flat-price discount uses another currency |
| `UNSUPPORTED_METHOD` | The campaign is not a native price reduction |
| `EXHAUSTED` | The total campaign redemption limit was reached |
| `SHOP_LIMIT_REACHED` | The shop-specific redemption limit was reached |
| `NO_PRICE_REDUCTION` | The configured value would not reduce this plan price |
| `IDEMPOTENCY_CONFLICT` | The idempotency key was reused for another intent |
| `RESERVATION_EXPIRED` | The existing reservation can no longer be reused |

Authentication and validation failures use HTTP errors:

| Status | Meaning and expected handling |
| --- | --- |
| `400` | Invalid body, price, plan key, domain, currency, or subscription GID |
| `401` | Missing or invalid platform API key; do not retry without configuration changes |
| `403` | The registered app is disabled or scheduled for deletion |
| `404` | Redemption does not exist for the authenticated app |
| `409` | Redemption was released, already applied differently, or cannot change state |
| `410` | Reservation expired before confirmation; begin a new checkout intent |
| `429` | Rate limited; wait for the `Retry-After` duration before retrying |

## Retry and idempotency rules

- Generate one stable idempotency key when the checkout intent begins.
- Reuse it for network retries of the resolve call.
- Do not reuse it for a different shop, plan, currency, or list price.
- Confirmation and release calls are safe to retry when their previous
  response was lost.
- Never silently create a second Shopify subscription after an ambiguous
  `appSubscriptionCreate` response. Reconcile Shopify state first.
- Use bounded retries with jitter for `429` and transient server/network
  failures. Do not retry stable business-rule rejections.

## Security requirements

- Call the management API only from the consuming app's backend.
- Keep the platform API key in a secret manager or encrypted environment
  configuration.
- Validate the Shopify return request using the consuming app's normal Shopify
  OAuth/session protections.
- Query Shopify before confirmation and match the exact subscription GID.
- Do not log platform keys, offline Admin API tokens, confirmation URLs, or
  complete sensitive request bodies.
- Use the API Logs page in Rapid for redacted request diagnostics.

Rapid scopes every request and redemption to the app associated with
the platform API key. One app cannot resolve or confirm another app's
discounts.

## Production checklist

- [ ] The app is registered and enabled in Rapid.
- [ ] The platform API key is installed only in the app's backend environment.
- [ ] Production base URLs use HTTPS.
- [ ] Every app plan has a stable `externalPlanKey`.
- [ ] The app sends the undiscounted recurring list price and correct currency.
- [ ] Resolve calls use a stable `Idempotency-Key`.
- [ ] Shopify receives the returned `shopifyDiscount` without recalculating it.
- [ ] Shopify `userErrors` are handled and the reservation is released.
- [ ] The return route verifies the exact active Shopify subscription GID.
- [ ] Confirm and release requests are retried safely.
- [ ] API logs and alerts are monitored for `401`, `409`, `410`, and `429`.
- [ ] A development-store test covers approval, decline, expiry, and retry.

## Implementation locations

- API routes:
  `app/routes/api/native-discount-resolve.tsx` and
  `app/routes/api/native-discount-redemption.tsx`
- Eligibility and reservation logic: `app/lib/native-discounts.server.ts`
- Authentication: `app/lib/api-auth.server.ts`
- Data model: `Discount` and `DiscountRedemption` in
  `prisma/schema.prisma`
- Focused tests: `tests/native-discounts.test.ts`
