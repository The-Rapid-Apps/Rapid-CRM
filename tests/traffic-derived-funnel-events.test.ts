import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildChurnEvidenceIndex,
  buildFirstPaidContributionIndex,
  derivedFunnelEventsForShop,
  historiesFromFacts,
  mrrMovementForShop,
  type ChargeHistory,
  type EventFact,
} from "../app/lib/shopify/partner-mrr.server";

/**
 * The five funnel events Shopify never sends: Trial Started, Trial Converted,
 * Upgraded, Downgraded, Resubscribed.
 *
 * All five are derived from how a charge's value changes over time, which is
 * why they are tested against the SAME fold that produces MRR movement rather
 * than in isolation — the whole point of deriving them there is that a trial
 * conversion counted here and a trial conversion booked as MRR are the same
 * event, and they must not be able to disagree.
 */

const ACT = "SUBSCRIPTION_CHARGE_ACTIVATED";
const CANCEL = "SUBSCRIPTION_CHARGE_CANCELED";
const DAY = 86_400_000;

function event(
  type: string,
  occurredAt: string,
  amount: number,
  options: { chargePlatformId?: string; billingOn?: string | null } = {},
): EventFact {
  return {
    appId: "app-1",
    chargePlatformId: options.chargePlatformId ?? "charge-1",
    chargeName: "Pro",
    amount: amount as unknown as EventFact["amount"],
    currencyCode: "USD",
    billingOn: options.billingOn ? new Date(options.billingOn) : null,
    test: false,
    shopDomain: "shop.myshopify.com",
    type,
    occurredAt: new Date(occurredAt),
  };
}

function derived(events: EventFact[]) {
  const histories: ChargeHistory[] = historiesFromFacts(events, []);
  const evidence = buildChurnEvidenceIndex(histories);
  const firstPaid = buildFirstPaidContributionIndex(histories);
  return derivedFunnelEventsForShop(histories, evidence, firstPaid).sort(
    (a, b) => a.at.getTime() - b.at.getTime(),
  );
}

function kindsOf(events: EventFact[]): string[] {
  return derived(events).map((e) => e.kind);
}

/** A 7-day trial: `billingOn` a week out, and no sale ever for this shop, so
 * `contributionAt` reads the gap as a trial rather than a renewal date. */
const TRIAL = {
  activation: event(ACT, "2026-03-01T00:00:00.000Z", 40, {
    billingOn: "2026-03-08T00:00:00.000Z",
  }),
  endsAt: new Date("2026-03-08T00:00:00.000Z"),
};

describe("trial started", () => {
  it("an activation that begins a trial is a trial start, at the activation", () => {
    const events = derived([TRIAL.activation]);
    const starts = events.filter((e) => e.kind === "trial_started");
    assert.equal(starts.length, 1);
    assert.deepEqual(starts[0].at, new Date("2026-03-01T00:00:00.000Z"));
    assert.equal(starts[0].shopDomain, "shop.myshopify.com");
  });

  it("an activation that bills immediately is not a trial", () => {
    assert.deepEqual(
      kindsOf([event(ACT, "2026-03-01T00:00:00.000Z", 40)]),
      [],
      "no billingOn gap means no trial to report",
    );
  });

  it("a trial is counted once per charge, not once per activation during it", () => {
    // A price change mid-trial fires another ACTIVATED on the same charge,
    // whose contribution is still trialling.
    const kinds = kindsOf([
      TRIAL.activation,
      event(ACT, "2026-03-03T00:00:00.000Z", 60, {
        billingOn: "2026-03-08T00:00:00.000Z",
      }),
    ]);
    assert.equal(
      kinds.filter((k) => k === "trial_started").length,
      1,
      "two activations inside one trial are still one trial",
    );
  });
});

describe("trial converted", () => {
  it("a trial reaching its billing date converts, at that instant", () => {
    const events = derived([TRIAL.activation]);
    const conversions = events.filter((e) => e.kind === "trial_converted");
    assert.equal(conversions.length, 1);
    assert.deepEqual(conversions[0].at, TRIAL.endsAt);
  });

  it("a trial cancelled before its billing date starts but never converts", () => {
    const kinds = kindsOf([
      TRIAL.activation,
      event(CANCEL, "2026-03-04T00:00:00.000Z", 40),
    ]);
    assert.ok(kinds.includes("trial_started"));
    assert.ok(
      !kinds.includes("trial_converted"),
      "a trial that ends in a cancel converted nothing",
    );
  });

  it("counts exactly the conversions the MRR fold books, never a second set", () => {
    // The invariant that makes deriving these here worthwhile: the funnel and
    // the money ledger are reading one event, so they cannot drift.
    const events = [TRIAL.activation];
    const histories = historiesFromFacts(events, []);
    const evidence = buildChurnEvidenceIndex(histories);
    const firstPaid = buildFirstPaidContributionIndex(histories);

    const tagged = mrrMovementForShop(histories, evidence, firstPaid).filter(
      (delta) => delta.fromTrialConversion,
    );
    const converted = derivedFunnelEventsForShop(
      histories,
      evidence,
      firstPaid,
    ).filter((e) => e.kind === "trial_converted");

    assert.equal(converted.length, tagged.length);
    assert.deepEqual(
      converted.map((e) => e.at.getTime()),
      tagged.map((d) => d.at.getTime()),
    );
  });

  it("a conversion is reported as converted, not as the money kind it booked", () => {
    // A converting trial books `new` for a first-time shop. Reporting by the
    // delta's kind would file the conversion under Subscribed instead — and
    // for a returning shop, under Resubscribed. One occurrence, one funnel.
    const events = [TRIAL.activation];
    const histories = historiesFromFacts(events, []);
    const evidence = buildChurnEvidenceIndex(histories);
    const firstPaid = buildFirstPaidContributionIndex(histories);
    const conversionDelta = mrrMovementForShop(histories, evidence, firstPaid).find(
      (d) => d.fromTrialConversion,
    );

    assert.equal(conversionDelta?.kind, "new", "fixture premise");
    const kinds = derivedFunnelEventsForShop(histories, evidence, firstPaid).map(
      (e) => e.kind,
    );
    assert.ok(kinds.includes("trial_converted"));
    assert.ok(
      !kinds.includes("resubscribed"),
      "a tagged conversion must not also count as a resubscribe",
    );
  });
});

describe("upgraded and downgraded", () => {
  it("a plan change to a dearer plan is an upgrade", () => {
    const kinds = kindsOf([
      event(ACT, "2026-01-01T00:00:00.000Z", 20),
      // Well past the first-period window, so it books as a real plan change
      // rather than being folded into `new`.
      event(ACT, "2026-06-01T00:00:00.000Z", 50, { chargePlatformId: "charge-2" }),
    ]);
    assert.deepEqual(kinds, ["upgraded"]);
  });

  it("a plan change to a cheaper plan is a downgrade", () => {
    const kinds = kindsOf([
      event(ACT, "2026-01-01T00:00:00.000Z", 50),
      event(ACT, "2026-06-01T00:00:00.000Z", 20, { chargePlatformId: "charge-2" }),
    ]);
    assert.deepEqual(kinds, ["downgraded"]);
  });

  it("a same-price plan swap is neither", () => {
    assert.deepEqual(
      kindsOf([
        event(ACT, "2026-01-01T00:00:00.000Z", 50),
        event(ACT, "2026-06-01T00:00:00.000Z", 50, { chargePlatformId: "charge-2" }),
      ]),
      [],
    );
  });

  it("a first subscription is neither an upgrade nor a downgrade", () => {
    assert.deepEqual(kindsOf([event(ACT, "2026-01-01T00:00:00.000Z", 50)]), []);
  });
});

describe("resubscribed", () => {
  it("subscribing again after cancelling is a resubscribe", () => {
    const kinds = kindsOf([
      event(ACT, "2026-01-01T00:00:00.000Z", 50),
      event(CANCEL, "2026-02-01T00:00:00.000Z", 50),
      event(ACT, "2026-06-01T00:00:00.000Z", 50, { chargePlatformId: "charge-2" }),
    ]);
    assert.deepEqual(kinds, ["resubscribed"]);
  });

  it("a first-ever subscription is not a resubscribe", () => {
    assert.deepEqual(kindsOf([event(ACT, "2026-01-01T00:00:00.000Z", 50)]), []);
  });
});

describe("scope", () => {
  it("churn and new are NOT reported here — they come off the Partner feed", () => {
    // Unsubscribed/Subscribed are real Shopify events, counted directly from
    // PARTNER_EVENT_TYPES_BY_FUNNEL. Deriving them here as well would double
    // every one of them.
    const kinds = kindsOf([
      event(ACT, "2026-01-01T00:00:00.000Z", 50),
      event(CANCEL, "2026-02-01T00:00:00.000Z", 50),
    ]);
    assert.deepEqual(kinds, []);
  });

  it("a shop with no events at all yields nothing", () => {
    assert.deepEqual(derivedFunnelEventsForShop([], new Map() as never), []);
  });

  it("every event carries the shop it belongs to", () => {
    for (const e of derived([
      TRIAL.activation,
      event(ACT, "2026-09-01T00:00:00.000Z", 99, { chargePlatformId: "charge-9" }),
    ])) {
      assert.equal(e.shopDomain, "shop.myshopify.com");
    }
  });
});
