import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildChurnEvidenceIndex,
  buildFirstPaidContributionIndex,
  contributionsAt,
  historiesFromFacts,
  mrrMovementForShop,
  type ChargeHistory,
  type EventFact,
  type MrrMovementDelta,
} from "../app/lib/shopify/partner-mrr.server";
import { subscriptionChurnTransitions } from "../app/lib/shopify/partner-mrr-snapshot.server";

/**
 * The MRR movement decomposition.
 *
 * The load-bearing assertion is the LAST suite's: the deltas must sum to the
 * MRR that `contributionsAt` reconstructs independently. See that suite for why
 * it is worth more than matching Mantle's category totals.
 *
 * The `churn + frozen == subscriptionChurnTransitions` identity below is kept
 * as a regression guard, but it is no longer a property of the fold in general.
 * Mantle books a cancel on a charge already superseded by its replacement as
 * moving nothing (partnerdex's `applies` guard), while the per-charge churn
 * stream still counts it lost — on real data that divergence is large. The
 * fixtures here are all single-current-charge streams, where the guard never
 * fires and the identity therefore still holds exactly. What actually protects
 * the published churn number is that `churnedRevenueLost` is computed by
 * `subscriptionChurnTransitions` and never by this walk.
 */

const ACT = "SUBSCRIPTION_CHARGE_ACTIVATED";
const CANCEL = "SUBSCRIPTION_CHARGE_CANCELED";
const EXPIRED = "SUBSCRIPTION_CHARGE_EXPIRED";
const FROZEN = "SUBSCRIPTION_CHARGE_FROZEN";
const UNFROZEN = "SUBSCRIPTION_CHARGE_UNFROZEN";

function event(
  type: string,
  occurredAt: string,
  amount: number,
  chargePlatformId = "charge-1",
): EventFact {
  return {
    appId: "app-1",
    chargePlatformId,
    chargeName: "Pro",
    amount: amount as unknown as EventFact["amount"],
    currencyCode: "USD",
    billingOn: null,
    test: false,
    shopDomain: "shop.myshopify.com",
    type,
    occurredAt: new Date(occurredAt),
  };
}

/** Every fixture here is one shop, so one group is the whole walk. */
function movements(events: EventFact[]): MrrMovementDelta[] {
  const histories: ChargeHistory[] = historiesFromFacts(events, []);
  const evidence = buildChurnEvidenceIndex(histories);
  const firstPaid = buildFirstPaidContributionIndex(histories);
  return mrrMovementForShop(histories, evidence, firstPaid).sort(
    (a, b) => a.at.getTime() - b.at.getTime(),
  );
}

function kinds(events: EventFact[]): string[] {
  return movements(events).map((d) => d.kind);
}

describe("entries", () => {
  it("a first paid subscription is new", () => {
    const d = movements([event(ACT, "2026-01-01T00:00:00.000Z", 50)]);
    assert.deepEqual(
      d.map((x) => [x.kind, x.amount]),
      [["new", 50]],
    );
  });

  it("subscribing again after a churn is reactivation, not new", () => {
    assert.deepEqual(
      kinds([
        event(ACT, "2026-01-01T00:00:00.000Z", 50),
        event(CANCEL, "2026-02-01T00:00:00.000Z", 50),
        event(ACT, "2026-06-01T00:00:00.000Z", 50),
      ]),
      ["new", "churn", "reactivation"],
    );
  });
});

describe("a freeze is its own category, not churn", () => {
  it("splits frozen out of what the churn stream calls lost", () => {
    const d = movements([
      event(ACT, "2026-01-01T00:00:00.000Z", 45),
      event(FROZEN, "2026-02-01T00:00:00.000Z", 45),
    ]);
    assert.deepEqual(
      d.map((x) => x.kind),
      ["new", "frozen"],
    );
    assert.equal(d.find((x) => x.kind === "frozen")?.amount, 45);
  });

  it("an unfreeze restores it as unfrozen, not as a new subscription", () => {
    assert.deepEqual(
      kinds([
        event(ACT, "2026-01-01T00:00:00.000Z", 45),
        event(FROZEN, "2026-02-01T00:00:00.000Z", 45),
        event(UNFROZEN, "2026-03-01T00:00:00.000Z", 45),
      ]),
      ["new", "frozen", "unfrozen"],
    );
  });
});

describe("plan changes recover the delta the churn stream discards", () => {
  /* The cancel is suppressed by `isReplacementCancellation`, so booking the
     replacing activation at full value would invent revenue. Only the
     difference is movement. Dated well past the first-period window. */
  function swap(from: number, to: number): MrrMovementDelta[] {
    return movements([
      event(ACT, "2025-01-01T00:00:00.000Z", from, "old"),
      event(CANCEL, "2026-02-01T00:00:00.000Z", from, "old"),
      event(ACT, "2026-02-01T00:00:30.000Z", to, "new"),
    ]);
  }

  it("an upgrade is expansion, valued at the difference", () => {
    const d = swap(20, 50);
    assert.deepEqual(
      d.map((x) => [x.kind, x.amount]),
      [["new", 20], ["expansion", 30]],
    );
  });

  it("a downgrade is contraction, stored positive", () => {
    const d = swap(50, 20);
    assert.deepEqual(d[1], {
      at: new Date("2026-02-01T00:00:30.000Z"),
      kind: "contraction",
      currency: "USD",
      amount: 30,
      // Every delta now names the plan it moved, so the per-plan breakdown can
      // be counted off this fold instead of a second walk over the events.
      plan: "Pro",
    });
  });

  it("an equal-price swap emits nothing at all", () => {
    // `>=` is expansion (spec §3.2), so a zero delta is an expansion of zero
    // rather than a contraction. 809 of these exist on production; the boundary
    // rounded the other way would book every one of them as a loss.
    assert.deepEqual(
      swap(30, 30).map((x) => x.kind),
      ["new"],
    );
  });

  it("a swap outside the 60s window is a real churn and a real reactivation", () => {
    /* Shop-level: the shop has been paid before, so the returning charge is a
       reactivation even though that CHARGE never contributed. The per-charge
       walk called this `new`, which is why reactivation measured $0.00. */
    assert.deepEqual(
      kinds([
        event(ACT, "2025-01-01T00:00:00.000Z", 20, "old"),
        event(CANCEL, "2026-02-01T00:00:00.000Z", 20, "old"),
        event(ACT, "2026-02-01T00:01:01.000Z", 50, "new"),
      ]),
      ["new", "churn", "reactivation"],
    );
  });

  it("a second charge while already paying moves only the delta", () => {
    /* Spec §3.2 has no entry branch for the already-paying state, and
       `currentAmount` is a scalar the activation REPLACES rather than a sum
       over concurrent charges. $30 then $20 is therefore a $10 contraction, not
       a $20 gain — the same reading as partnerdex, which books
       `downgraded` with `net_change: 20 - 30`. Booking the full $20 instead put
       expansion at 470% of Mantle's figure. */
    const deltas = kinds([
      event(ACT, "2026-01-01T00:00:00.000Z", 30, "a"),
      event(ACT, "2026-06-01T00:00:00.000Z", 20, "b"),
    ]);
    assert.deepEqual(deltas, ["new", "contraction"]);
  });

  it("a second charge dearer than the first is expansion of the delta", () => {
    assert.deepEqual(
      kinds([
        event(ACT, "2026-01-01T00:00:00.000Z", 20, "a"),
        event(ACT, "2026-06-01T00:00:00.000Z", 30, "b"),
      ]),
      ["new", "expansion"],
    );
  });

  it("a plan change inside the first 30 days is booked as new and flagged", () => {
    const d = movements([
      event(ACT, "2026-01-01T00:00:00.000Z", 20, "old"),
      event(CANCEL, "2026-01-10T00:00:00.000Z", 20, "old"),
      event(ACT, "2026-01-10T00:00:05.000Z", 50, "new"),
    ]);
    assert.deepEqual(d.map((x) => x.kind), ["new", "new"]);
    assert.equal(d[1].earlyPlanChange, true);
    assert.equal(
      d.filter((x) => x.kind === "expansion").length,
      0,
      "early plan-shopping is not expansion",
    );
  });
});

describe("the identity that keeps churn from moving", () => {
  const streams: Array<[string, EventFact[]]> = [
    ["entry only", [event(ACT, "2026-01-01T00:00:00.000Z", 50)]],
    [
      "entry then churn",
      [
        event(ACT, "2026-01-01T00:00:00.000Z", 50),
        event(CANCEL, "2026-03-01T00:00:00.000Z", 50),
      ],
    ],
    [
      "entry then expiry",
      [
        event(ACT, "2026-01-01T00:00:00.000Z", 50),
        event(EXPIRED, "2026-03-01T00:00:00.000Z", 50),
      ],
    ],
    [
      "freeze then unfreeze then churn",
      [
        event(ACT, "2026-01-01T00:00:00.000Z", 45),
        event(FROZEN, "2026-02-01T00:00:00.000Z", 45),
        event(UNFROZEN, "2026-03-01T00:00:00.000Z", 45),
        event(EXPIRED, "2026-04-01T00:00:00.000Z", 45),
      ],
    ],
    [
      "an upgrade well after the first period",
      [
        event(ACT, "2025-01-01T00:00:00.000Z", 20, "old"),
        event(CANCEL, "2026-02-01T00:00:00.000Z", 20, "old"),
        event(ACT, "2026-02-01T00:00:30.000Z", 70, "new"),
      ],
    ],
    [
      "churn then reactivate at a different price",
      [
        event(ACT, "2026-01-01T00:00:00.000Z", 30),
        event(CANCEL, "2026-02-01T00:00:00.000Z", 30),
        event(ACT, "2026-08-01T00:00:00.000Z", 80),
      ],
    ],
  ];

  for (const [label, events] of streams) {
    it(`churn + frozen equals the churn stream's lost — ${label}`, () => {
      const histories: ChargeHistory[] = historiesFromFacts(events, []);
      const evidence = buildChurnEvidenceIndex(histories);

      let lostFromChurnStream = 0;
      let lostAmountFromChurnStream = 0;
      let recoveredFromChurnStream = 0;
      for (const history of histories) {
        for (const d of subscriptionChurnTransitions(history, evidence)) {
          if (d.delta === 1) {
            lostFromChurnStream += 1;
            lostAmountFromChurnStream += d.amount;
          } else recoveredFromChurnStream += 1;
        }
      }

      const moves = movements(events);
      const losses = moves.filter(
        (m) => m.kind === "churn" || m.kind === "frozen",
      );
      const gainsAfterFirst = moves.filter(
        (m) => m.kind === "reactivation" || m.kind === "unfrozen",
      );

      assert.equal(
        losses.length,
        lostFromChurnStream,
        "every lost transition is either a churn or a freeze, and nothing else",
      );
      assert.equal(
        Number(
          losses.reduce((sum, m) => sum + m.amount, 0).toFixed(6),
        ),
        Number(lostAmountFromChurnStream.toFixed(6)),
        "and the MRR they carry is unchanged — churnedRevenueLost cannot move",
      );
      assert.equal(
        gainsAfterFirst.length,
        recoveredFromChurnStream,
        "recoveries map to reactivation or unfrozen",
      );
    });
  }
});

/**
 * The load-bearing invariant, ported from partnerdex's
 * "the ledger reconciles with the MRR reconstruction".
 *
 * The movement deltas accumulate FORWARD from the event stream, while
 * `contributionsAt` rebuilds MRR BACKWARDS from each charge's own state. They
 * are two independent paths through the same facts, so a misclassification in
 * the fold makes them disagree — which is exactly what makes the check worth
 * running, and why it is worth more than matching Mantle's category totals.
 *
 * A labelling difference cannot break this: money moved from one category to
 * another of the opposite sign leaves the sum alone. Only a rule that invents,
 * loses, or misvalues money shows up here. Measured against a full production
 * history this closes to within a fraction of a percent; partnerdex
 * itself documents its own ledger drifting from its MRR level, and Mantle's
 * all-time net sits ~2.3% off its own MRR.
 */
describe("the ledger reconciles with the MRR reconstruction", () => {
  /** new + reactivation + expansion + unfrozen - churn - contraction - frozen. */
  function ledgerTotal(deltas: MrrMovementDelta[]): number {
    return deltas.reduce(
      (sum, delta) =>
        delta.kind === "churn" ||
        delta.kind === "contraction" ||
        delta.kind === "frozen"
          ? sum - delta.amount
          : sum + delta.amount,
      0,
    );
  }

  /** What the reports show: non-trial contributions, summed at one instant. */
  function mrrAt(events: EventFact[], at: Date): number {
    const histories: ChargeHistory[] = historiesFromFacts(events, []);
    return contributionsAt(histories, at)
      .filter((contribution) => contribution.kind !== "trial")
      .reduce((sum, contribution) => sum + contribution.amount, 0);
  }

  const after = new Date("2027-01-01T00:00:00.000Z");

  const streams: Array<[string, EventFact[]]> = [
    ["paid from day one", [event(ACT, "2026-01-01T00:00:00.000Z", 50)]],
    [
      "churned for real",
      [
        event(ACT, "2026-01-01T00:00:00.000Z", 45),
        event(CANCEL, "2026-05-01T00:00:00.000Z", 45),
      ],
    ],
    [
      "still frozen",
      [
        event(ACT, "2026-01-01T00:00:00.000Z", 60),
        event(FROZEN, "2026-03-01T00:00:00.000Z", 60),
      ],
    ],
    [
      "frozen then thawed",
      [
        event(ACT, "2026-01-01T00:00:00.000Z", 60),
        event(FROZEN, "2026-03-01T00:00:00.000Z", 60),
        event(UNFROZEN, "2026-04-01T00:00:00.000Z", 60),
      ],
    ],
    [
      "upgraded mid-life",
      [
        event(ACT, "2026-01-05T00:00:00.000Z", 20, "old"),
        event(CANCEL, "2026-04-01T00:00:00.000Z", 20, "old"),
        event(ACT, "2026-04-01T00:00:00.000Z", 90, "new"),
      ],
    ],
    [
      "downgraded mid-life",
      [
        event(ACT, "2026-01-05T00:00:00.000Z", 90, "old"),
        event(CANCEL, "2026-04-01T00:00:00.000Z", 90, "old"),
        event(ACT, "2026-04-01T00:00:00.000Z", 20, "new"),
      ],
    ],
    [
      "an equal-price swap",
      [
        event(ACT, "2026-01-05T00:00:00.000Z", 30, "old"),
        event(CANCEL, "2026-04-01T00:00:00.000Z", 30, "old"),
        event(ACT, "2026-04-01T00:00:00.000Z", 30, "new"),
      ],
    ],
    [
      "churned then won back",
      [
        event(ACT, "2026-01-01T00:00:00.000Z", 30),
        event(CANCEL, "2026-02-01T00:00:00.000Z", 30),
        event(ACT, "2026-08-01T00:00:00.000Z", 80),
      ],
    ],
    /* Concurrency reconverges once the charges end, and that is the whole
       reason the production figure closes to 0.16%: while two charges are live
       at once the summing LEVEL and the replacing LEDGER genuinely disagree, but
       the ledger books the shortfall back as each one terminates. See the
       divergence test below for the open state these fixtures close. */
    [
      "a second charge alongside the first, both ended",
      [
        event(ACT, "2026-01-01T00:00:00.000Z", 30, "a"),
        event(ACT, "2026-06-01T00:00:00.000Z", 20, "b"),
        event(CANCEL, "2026-07-01T00:00:00.000Z", 30, "a"),
        event(CANCEL, "2026-08-01T00:00:00.000Z", 20, "b"),
      ],
    ],
    [
      "a freeze on a charge that was already superseded, then ended",
      [
        event(ACT, "2026-01-01T00:00:00.000Z", 40, "a"),
        event(ACT, "2026-03-01T00:00:00.000Z", 70, "b"),
        event(FROZEN, "2026-05-01T00:00:00.000Z", 40, "a"),
        event(CANCEL, "2026-06-01T00:00:00.000Z", 70, "b"),
      ],
    ],
    [
      "expiry after a thaw",
      [
        event(ACT, "2026-01-01T00:00:00.000Z", 45),
        event(FROZEN, "2026-02-01T00:00:00.000Z", 45),
        event(UNFROZEN, "2026-03-01T00:00:00.000Z", 45),
        event(EXPIRED, "2026-04-01T00:00:00.000Z", 45),
      ],
    ],
  ];

  for (const [label, events] of streams) {
    it(`sums every delta to the MRR the reports show — ${label}`, () => {
      assert.equal(
        Number(ledgerTotal(movements(events)).toFixed(6)),
        Number(mrrAt(events, after).toFixed(6)),
      );
    });
  }

  it("diverges only while two charges are concurrently live", () => {
    /* Pinned rather than hidden. Our MRR level SUMS concurrent charges while
       this ledger REPLACES (spec §3.2's single `currentAmount`), so an open
       second subscription is worth the superseded charge's value more to the
       level than to the ledger. partnerdex cannot express the state at all —
       one subscription per install — and its README allows the gap outright:
       "a movement view and a level are two different readings of the same
       facts". It is transient, which is why a full production history lands
       within a fraction of a percent rather than at the total value of
       concurrent activations. */
    const open = [
      event(ACT, "2026-01-01T00:00:00.000Z", 30, "a"),
      event(ACT, "2026-06-01T00:00:00.000Z", 20, "b"),
    ];
    assert.equal(ledgerTotal(movements(open)), 20, "ledger replaces: 30 - 10");
    assert.equal(mrrAt(open, after), 50, "level sums: 30 + 20");
  });

  it("holds across every fixture at once, not just one at a time", () => {
    /* Summed rather than asserted per stream, so a pair of streams that are
       each wrong by opposite amounts cannot pass the loop above while leaving
       the aggregate — which is what the snapshot columns actually hold —
       broken. */
    let ledger = 0;
    let mrr = 0;
    for (const [, events] of streams) {
      ledger += ledgerTotal(movements(events));
      mrr += mrrAt(events, after);
    }
    assert.equal(Number(ledger.toFixed(6)), Number(mrr.toFixed(6)));
  });
});
