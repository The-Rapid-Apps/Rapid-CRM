import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "../generated/prisma/client";
import {
  chargeKey,
  contributionAt,
  historiesFromFacts,
  resolveLiveCheck,
} from "../app/lib/shopify/partner-mrr.server";

/**
 * Covers the bug found 2026-09-09: the two halves of the live-discount-check
 * feature disagreed about which charges they cared about.
 *
 * `loadLiveDiscountChecks` applied every persisted row forever, with no age
 * filter. `syncLiveDiscountChecksForApp` only refreshed a row while its
 * charge was still a candidate (ambiguous discount, or gone quiet), so the
 * moment a charge stopped being uncertain its row froze — and kept
 * overriding the MRR amount indefinitely. In production all 359 rows were
 * being applied off a single manual run a week earlier, with the first
 * scheduled run reporting `checked: 0` because nothing was a candidate any
 * more.
 *
 * Two guarantees here: an override the refresher has stopped renewing stops
 * being trusted, and a confirmed-dead subscription stays dead regardless of
 * age.
 */

const DAY_MS = 86_400_000;
const NOW = new Date("2026-09-09T00:00:00.000Z");

function event(params: {
  charge: string;
  type: string;
  at: string;
  amount: string;
  billingOn?: string;
}) {
  return {
    appId: "app-1",
    type: params.type,
    occurredAt: new Date(params.at),
    shopDomain: `${params.charge}.myshopify.com`,
    chargePlatformId: params.charge,
    chargeName: params.charge,
    amount: new Prisma.Decimal(params.amount),
    currencyCode: "USD",
    billingOn: params.billingOn ? new Date(params.billingOn) : null,
    test: false,
  };
}

function sale(params: { charge: string; at: string; grossAmount: string }) {
  return {
    appId: "app-1",
    chargePlatformId: params.charge,
    occurredAt: new Date(params.at),
    billingInterval: "EVERY_30_DAYS" as const,
    grossAmount: new Prisma.Decimal(params.grossAmount),
    currencyCode: "USD",
  };
}

/** One ambiguous charge: a lone sale below the listed price. */
function ambiguousCharge() {
  return {
    events: [
      event({
        charge: "pro",
        type: "SUBSCRIPTION_CHARGE_ACTIVATED",
        at: "2026-07-01T00:00:00.000Z",
        amount: "49",
        billingOn: "2026-08-01T00:00:00.000Z",
      }),
    ],
    sales: [sale({ charge: "pro", at: "2026-08-01T00:00:00.000Z", grossAmount: "24.50" })],
  };
}

test("a recently refreshed check supplies the amount", () => {
  const row = {
    effectiveAmount: new Prisma.Decimal("19"),
    subscriptionActive: true,
    trialEndsAt: null,
    checkedAt: new Date(NOW.getTime() - 2 * DAY_MS),
  };
  assert.deepEqual(resolveLiveCheck(row, NOW), {
    effectiveAmount: 19,
    inactiveSince: null,
    trialEndsAt: null,
    // Fresh enough to supply an amount, but written two days before
    // `trialEndsAt` was added to the query — so its null trial end is an
    // absence, not an answer.
    trialEndKnown: false,
  });
});

test("a check the refresher has stopped renewing stops being trusted", () => {
  const row = {
    effectiveAmount: new Prisma.Decimal("19"),
    subscriptionActive: true,
    trialEndsAt: null,
    checkedAt: new Date(NOW.getTime() - 30 * DAY_MS),
  };
  assert.equal(
    resolveLiveCheck(row, NOW).effectiveAmount,
    null,
    "a month-old reading of a live subscription is not evidence about today",
  );
});

test("a confirmed-inactive subscription stays inactive at any age", () => {
  const checkedAt = new Date("2026-01-01T00:00:00.000Z");
  const row = {
    effectiveAmount: null,
    subscriptionActive: false,
    trialEndsAt: null,
    checkedAt,
  };
  assert.deepEqual(
    resolveLiveCheck(row, NOW),
    {
      effectiveAmount: null,
      inactiveSince: checkedAt,
      trialEndsAt: null,
      trialEndKnown: false,
    },
    "a charge that has ended does not come back to life because the row aged",
  );
});

test("an aged-out override no longer holds the reported amount down", () => {
  const { events, sales } = ambiguousCharge();
  const key = chargeKey("app-1", "pro");
  const checkedAt = new Date(NOW.getTime() - 30 * DAY_MS);

  const frozen = historiesFromFacts(
    events,
    sales,
    undefined,
    new Map([
      [
        key,
        {
          effectiveAmount: 5,
          inactiveSince: null,
          trialEndsAt: null,
          trialEndKnown: false,
        },
      ],
    ]),
  );
  assert.equal(
    contributionAt(frozen[0], NOW)?.amount,
    5,
    "an applied override wins over the ambiguous sale (unchanged behaviour)",
  );

  // Same row, now read through the trust rule at an age the refresher should
  // never have allowed.
  const expired = historiesFromFacts(
    events,
    sales,
    undefined,
    new Map([
      [
        key,
        resolveLiveCheck(
          {
            effectiveAmount: new Prisma.Decimal("5"),
            subscriptionActive: true,
            trialEndsAt: null,
            checkedAt,
          },
          NOW,
        ),
      ],
    ]),
  );
  assert.equal(
    contributionAt(expired[0], NOW)?.amount,
    49,
    "falls back through the existing chain to the listed price",
  );
});

test("a still-inactive check keeps the charge out of MRR even when the amount has expired", () => {
  const { events, sales } = ambiguousCharge();
  const key = chargeKey("app-1", "pro");
  const checkedAt = new Date(NOW.getTime() - 60 * DAY_MS);
  const histories = historiesFromFacts(
    events,
    sales,
    undefined,
    new Map([
      [
        key,
        resolveLiveCheck(
          {
            effectiveAmount: new Prisma.Decimal("5"),
            subscriptionActive: false,
            trialEndsAt: null,
            checkedAt,
          },
          NOW,
        ),
      ],
    ]),
  );
  assert.equal(
    contributionAt(histories[0], NOW),
    null,
    "expiring the amount must not resurrect a subscription confirmed gone",
  );
});

/* ------------------------------------------------------------------------- *
 * Shopify's own trial end, and the charge whose trial ended without paying.
 *
 * Added 2026-09-10. `contributionAt` used to infer every trial from the gap
 * between activation and `billingOn`; on 247 production trials that was right
 * about 211 and wrong about 36. The correction cannot just reclassify, because a
 * charge that stops being a `trial` becomes `monthly` at listed price and the
 * money moves between two bands instead of leaving.
 * ------------------------------------------------------------------------- */

/** A shop that has never paid anything, still inside a 7-day inferred trial. */
function freshTrial(billingOn = "2026-09-12T00:00:00.000Z") {
  return {
    events: [
      event({
        charge: "starter",
        type: "SUBSCRIPTION_CHARGE_ACTIVATED",
        at: "2026-09-05T00:00:00.000Z",
        amount: "29",
        billingOn,
      }),
    ],
    sales: [],
  };
}

const liveCheck = (trialEndsAt: Date | null, checkedAt: Date) =>
  resolveLiveCheck(
    {
      effectiveAmount: null,
      subscriptionActive: true,
      trialEndsAt,
      checkedAt,
    },
    NOW,
  );

test("with no live check the inferred trial still stands", () => {
  const { events, sales } = freshTrial();
  const histories = historiesFromFacts(events, sales, undefined, new Map());
  const contribution = contributionAt(histories[0], NOW);
  assert.equal(contribution?.kind, "trial");
  assert.equal(contribution?.amount, 29, "priced at the approved amount");
});

test("a recorded trial end in the future keeps it a trial", () => {
  const { events, sales } = freshTrial();
  const histories = historiesFromFacts(
    events,
    sales,
    undefined,
    new Map([
      [
        chargeKey("app-1", "starter"),
        liveCheck(new Date("2026-09-12T00:00:00.000Z"), NOW),
      ],
    ]),
  );
  assert.equal(contributionAt(histories[0], NOW)?.kind, "trial");
});

test("an ended unpaid trial without a verified live price contributes nothing", () => {
  const { events, sales } = freshTrial();
  const histories = historiesFromFacts(
    events,
    sales,
    undefined,
    new Map([
      [
        chargeKey("app-1", "starter"),
        // Ended yesterday; `billingOn` is still in the future because Shopify
        // rolled it to the next cycle, which is why the past-due grace never
        // fires on this population.
        liveCheck(new Date(NOW.getTime() - DAY_MS), NOW),
      ],
    ]),
  );
  const contribution = contributionAt(histories[0], NOW);
  assert.notEqual(contribution, null, "the charge is still live, not terminal");
  assert.notEqual(contribution?.kind, "trial", "no longer a trial");
  assert.equal(
    contribution?.amount,
    0,
    "and NOT 29 — reclassifying alone would move the money into Monthly",
  );
});

for (const annual of [false, true]) {
  for (const monthlyPrice of [0, 24]) {
    test(`a verified ${annual ? "annual" : "monthly"} price of ${monthlyPrice} survives an unpaid trial end`, () => {
      const { events, sales } = freshTrial();
      events[0].chargeName = annual ? "Starter annual" : "Starter";
      events[0].amount = new Prisma.Decimal(annual ? 348 : 29);
      const check = resolveLiveCheck({
        effectiveAmount: monthlyPrice,
        subscriptionActive: true,
        trialEndsAt: new Date(NOW.getTime() - DAY_MS),
        checkedAt: NOW,
      }, NOW);
      const [history] = historiesFromFacts(events, sales, undefined,
        new Map([[chargeKey("app-1", "starter"), check]]));
      const contribution = contributionAt(history, NOW);
      assert.equal(contribution?.kind, annual ? "annual" : "monthly");
      assert.equal(contribution?.amount, monthlyPrice);
    });
  }
}

test("a verified live price survives the never-billed grace period", () => {
  const { events, sales } = freshTrial("2026-06-08T00:00:00.000Z");
  events[0].occurredAt = new Date("2026-06-01T00:00:00.000Z");
  const [history] = historiesFromFacts(events, sales, undefined, new Map([
    [chargeKey("app-1", "starter"), resolveLiveCheck({
      effectiveAmount: 19,
      subscriptionActive: true,
      trialEndsAt: null,
      checkedAt: NOW,
    }, NOW)],
  ]));
  assert.equal(contributionAt(history, NOW)?.amount, 19);
  assert.equal(contributionAt({ ...history, liveDiscountEffectiveAmount: null }, NOW)?.amount, 0,
    "the fallback still applies when no live price is available");
});

test("an annual live discount is normalized once, including during a trial", () => {
  const { events } = freshTrial();
  events[0].chargeName = "Starter annual";
  events[0].amount = new Prisma.Decimal(348);
  const check = resolveLiveCheck({
    effectiveAmount: 24,
    subscriptionActive: true,
    trialEndsAt: new Date("2026-09-12T00:00:00.000Z"),
    checkedAt: NOW,
  }, NOW);
  const checks = new Map([[chargeKey("app-1", "starter"), check]]);
  const [trial] = historiesFromFacts(events, [], undefined, checks);
  assert.equal(contributionAt(trial, NOW)?.kind, "trial");
  assert.equal(contributionAt(trial, NOW)?.amount, 24);
  const annualSale = {
    ...sale({ charge: "starter", at: "2026-09-06T00:00:00.000Z", grossAmount: "288" }),
    billingInterval: "ANNUAL" as const,
  };
  const [discounted] = historiesFromFacts(events, [annualSale], undefined, checks);
  assert.equal(contributionAt(discounted, NOW)?.amount, 24,
    "an ambiguous annual sale uses the monthly-normalized live price");
  const [fullPrice] = historiesFromFacts(events, [
    { ...annualSale, grossAmount: new Prisma.Decimal(348) },
  ], undefined, checks);
  assert.equal(contributionAt(fullPrice, NOW)?.amount, 29,
    "a trusted sale still uses its own per-cycle amount, divided once");
});

test("Shopify reporting no trial at all is an answer, not an absence", () => {
  const { events, sales } = freshTrial();
  const histories = historiesFromFacts(
    events,
    sales,
    undefined,
    new Map([[chargeKey("app-1", "starter"), liveCheck(null, NOW)]]),
  );
  assert.notEqual(
    contributionAt(histories[0], NOW)?.kind,
    "trial",
    "a null from a row checked after the field shipped means no trial",
  );
});

test("a null from a row written BEFORE the field shipped proves nothing", () => {
  const { events, sales } = freshTrial();
  const histories = historiesFromFacts(
    events,
    sales,
    undefined,
    new Map([
      [
        chargeKey("app-1", "starter"),
        // 2026-09-02: the date every pre-fix row in production carries.
        liveCheck(null, new Date("2026-09-02T00:00:00.000Z")),
      ],
    ]),
  );
  assert.equal(
    contributionAt(histories[0], NOW)?.kind,
    "trial",
    "falls back to the heuristic rather than deleting a real trial",
  );
});

test("an ended trial that HAS been paid is ordinary revenue", () => {
  const { events } = freshTrial();
  const sales = [
    sale({ charge: "starter", at: "2026-09-08T00:00:00.000Z", grossAmount: "29" }),
  ];
  const histories = historiesFromFacts(
    events,
    sales,
    undefined,
    new Map([
      [
        chargeKey("app-1", "starter"),
        liveCheck(new Date(NOW.getTime() - DAY_MS), NOW),
      ],
    ]),
  );
  const contribution = contributionAt(histories[0], NOW);
  assert.equal(contribution?.kind, "monthly");
  assert.equal(contribution?.amount, 29, "a payment appeared, so it counts");
});
