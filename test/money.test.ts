// test/money.test.ts: meter, settlement table, fuse (fake clock) and Stripe (fake client). Zero network.
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import type { Caps, Meter, RateCard, SettleDecision, SettleInput, TripReason } from "../src/contracts.js";
import { RATE_CARDS, computeMeter, scaleRateCard } from "../src/meter.js";
import { NOT_RUN, settle } from "../src/settle.js";
import { createFuse } from "../src/fuse.js";
import {
  MIN_CAPTURE_CENTS, SettlementPendingError, checkMetadata, createPay, keyClass, pingStripe,
  type PiLike, type StripeLike,
} from "../src/stripe.js";
import { formatTable, smoke } from "../scripts/smoke-stripe.js";

const rc1: RateCard = RATE_CARDS.rc1;
const holdCaps: Caps = { holdCents: 500, timeCapSec: 120 };

const meterOf = (costMicros: number, extra: Partial<Meter> = {}): Meter => ({
  workSec: 0, vmSeconds: 0, tokensIn: 0, tokensOut: 0, turns: 0,
  costMicros, infraMicros: 0, listTokenMicros: 0, estimatedTokens: false, ...extra,
});

// ── Meter ───────────────────────────────────────────────────────────────
describe("meter", () => {
  it("rc1 is the posted demo rate card", () => {
    assert.deepEqual(rc1, {
      version: "rc1", vmMicrosPerSec: 20_000, inMicrosPerTok: 15, outMicrosPerTok: 75,
      infraMicrosPerSec: 13.3, listInMicrosPerTok: 4, listOutMicrosPerTok: 20, minChargeCents: 50,
    });
  });

  it("worked example: 31.2 s, 14,210 in, 2,650 out = 1,035,900 µ$ = $1.03, captured as 103 cents", () => {
    const m = computeMeter({ workSec: 31.2, vmSeconds: 31.2, tokensIn: 14_210, tokensOut: 2_650, turns: 3, estimatedTokens: false }, rc1);
    assert.equal(m.costMicros, 1_035_900);
    assert.equal(m.infraMicros, 415);                  // round(31.2 × 13.3), display only
    assert.equal(m.listTokenMicros, 109_840);          // 14,210 × 4 + 2,650 × 20, display only
    assert.equal(m.turns, 3);
    const d = settle({ mode: "fuse", onTrip: "metered", meter: m, caps: holdCaps, rate: rc1, outcome: "submitted", hasArtifact: true });
    assert.deepEqual(d, { action: "capture", cents: 103, reason: "metered" });
  });

  it("busy-loop: 40 s with zero tokens is 800,000 µ$", () => {
    const m = computeMeter({ workSec: 40, vmSeconds: 40, tokensIn: 0, tokensOut: 0, turns: 0, estimatedTokens: false }, rc1);
    assert.equal(m.costMicros, 800_000);
  });

  it("cost is floored to a whole µ$ and survives float noise", () => {
    const base = { workSec: 0, turns: 0, tokensIn: 0, tokensOut: 0, estimatedTokens: false };
    assert.equal(computeMeter({ ...base, vmSeconds: 1.00004 }, rc1).costMicros, 20_000);    // 20,000.8 floors
    assert.equal(computeMeter({ ...base, vmSeconds: 0.3 }, rc1).costMicros, 6_000);
    assert.equal(computeMeter({ ...base, vmSeconds: 0.1 + 0.2 }, rc1).costMicros, 6_000);   // 0.30000000000000004 s
    assert.equal(computeMeter({ ...base, vmSeconds: 1.1 * 3 }, rc1).costMicros, 66_000);    // 3.3000000000000003 s
    // 0.043 × 20,000 is 859.9999999999999 in floating point; the meter must still say 860.
    assert.equal(0.043 * 20_000 < 860, true, "the float product really is just under");
    assert.equal(computeMeter({ ...base, vmSeconds: 0.043 }, rc1).costMicros, 860);
    assert.equal(computeMeter({ ...base, vmSeconds: 0.051 }, rc1).costMicros, 1_020);
    for (let ms = 1; ms <= 5_000; ms++) {      // every whole millisecond is a whole number of µ$ at 20 µ$ per ms
      assert.equal(computeMeter({ ...base, vmSeconds: ms / 1000 }, rc1).costMicros, ms * 20, `${ms} ms`);
    }
  });

  it("negative or non-finite inputs count as zero; estimatedTokens is passed through", () => {
    const m = computeMeter({ workSec: -1, vmSeconds: Number.NaN, tokensIn: -5, tokensOut: Infinity, turns: -1, estimatedTokens: true }, rc1);
    assert.equal(m.costMicros, 0);
    assert.equal(m.workSec, 0);
    assert.equal(m.estimatedTokens, true);
  });

  it("scaleRateCard scales the three posted prices and keeps the display prices", () => {
    const rc2 = scaleRateCard(rc1, 2, "rc2");
    assert.equal(rc2.version, "rc2");
    assert.equal(rc2.vmMicrosPerSec, 40_000);
    assert.equal(rc2.inMicrosPerTok, 30);
    assert.equal(rc2.outMicrosPerTok, 150);
    assert.equal(rc2.infraMicrosPerSec, 13.3);
    assert.equal(rc2.listInMicrosPerTok, 4);
    assert.equal(rc2.listOutMicrosPerTok, 20);
    assert.equal(rc2.minChargeCents, 50);
    assert.equal(rc1.vmMicrosPerSec, 20_000, "the base card is not mutated");
  });

  it("scaleRateCard with vmK raises only the sandbox rate", () => {
    const rc2 = scaleRateCard(rc1, 1, "rc2", 3);
    assert.equal(rc2.vmMicrosPerSec, 60_000);
    assert.equal(rc2.inMicrosPerTok, 15);
    assert.equal(rc2.outMicrosPerTok, 75);
  });
});

// ── Settlement table (DESIGN 9.6) ───────────────────────────────────────
const input = (over: Partial<SettleInput> = {}): SettleInput => ({
  mode: "fuse", onTrip: "metered", meter: meterOf(1_035_900), caps: holdCaps, rate: rc1,
  outcome: "submitted", hasArtifact: true, ...over,
});
const cap = (cents: number, reason: SettleDecision["reason"]): SettleDecision => ({ action: "capture", cents, reason });
const cxl = (reason: SettleDecision["reason"]): SettleDecision => ({ action: "cancel", cents: 0, reason });
const left: SettleDecision = { action: "leave", cents: 0, reason: "inconclusive" };

describe("settle: fuse mode (the floor)", () => {
  it("not_run: the skipped lane uses the exported constant", () => {
    assert.deepEqual(NOT_RUN, { action: "cancel", cents: 0, reason: "not_run" });
  });
  it("infra error cancels whatever the meter says [judgment]", () => {
    assert.deepEqual(settle(input({ outcome: "infra_error", meter: meterOf(0) })), cxl("infra_error"));
    assert.deepEqual(settle(input({ outcome: "infra_error", meter: meterOf(4_370_000) })), cxl("infra_error"));
    assert.deepEqual(settle(input({ outcome: "infra_error", onTrip: "nothing" })), cxl("infra_error"));
  });
  it("tripped with ON_TRIP=nothing cancels as no_delivery", () => {
    assert.deepEqual(settle(input({ outcome: "tripped", tripReason: "cost_cap", onTrip: "nothing", meter: meterOf(4_370_000) })), cxl("no_delivery"));
  });
  it("no_delivery outranks under_minimum: a tripped lane with a tiny meter and ON_TRIP=nothing", () => {
    assert.deepEqual(settle(input({ outcome: "tripped", tripReason: "time_cap", onTrip: "nothing", meter: meterOf(100_000) })), cxl("no_delivery"));
  });
  it("cents under the minimum cancel as under_minimum, and capture is not asked for", () => {
    assert.deepEqual(settle(input({ meter: meterOf(300_000) })), cxl("under_minimum"));
    assert.deepEqual(settle(input({ meter: meterOf(0) })), cxl("under_minimum"));
  });
  it("49 cents cancels, 50 cents captures", () => {
    assert.deepEqual(settle(input({ meter: meterOf(499_999) })), cxl("under_minimum"));    // 49.9999 → 49
    assert.deepEqual(settle(input({ meter: meterOf(500_000) })), cap(50, "metered"));
    assert.deepEqual(settle(input({ meter: meterOf(509_999) })), cap(50, "metered"));
    assert.deepEqual(settle(input({ meter: meterOf(510_000) })), cap(51, "metered"));
    assert.equal(MIN_CAPTURE_CENTS, rc1.minChargeCents);
  });
  it("submitted and accepted captures the metered cents", () => {
    assert.deepEqual(settle(input()), cap(103, "metered"));
    assert.deepEqual(settle(input({ onTrip: "nothing" })), cap(103, "metered"), "ON_TRIP only matters after a trip");
  });
  it("tripped with ON_TRIP=metered captures: capped for cost_cap and reservation, time_capped for time_cap", () => {
    const m = meterOf(4_370_000);
    assert.deepEqual(settle(input({ outcome: "tripped", tripReason: "cost_cap", meter: m })), cap(437, "capped"));
    assert.deepEqual(settle(input({ outcome: "tripped", tripReason: "reservation", meter: m })), cap(437, "capped"));
    assert.deepEqual(settle(input({ outcome: "tripped", tripReason: "time_cap", meter: m })), cap(437, "time_capped"));
  });
  it("a manual trip settles as capped [judgment]", () => {
    assert.deepEqual(settle(input({ outcome: "tripped", tripReason: "manual", meter: meterOf(900_000) })), cap(90, "capped"));
  });
  it("tripped with ON_TRIP=metered still cancels under the minimum", () => {
    assert.deepEqual(settle(input({ outcome: "tripped", tripReason: "manual", meter: meterOf(400_000) })), cxl("under_minimum"));
  });
  it("turn_cap is treated like a trip [judgment]: nothing cancels, metered checks the minimum then captures", () => {
    assert.deepEqual(settle(input({ outcome: "turn_cap", onTrip: "nothing", meter: meterOf(2_000_000) })), cxl("no_delivery"));
    assert.deepEqual(settle(input({ outcome: "turn_cap", onTrip: "metered", meter: meterOf(2_000_000) })), cap(200, "metered"));
    assert.deepEqual(settle(input({ outcome: "turn_cap", onTrip: "metered", meter: meterOf(300_000) })), cxl("under_minimum"));
  });
  it("billable is capped at the hold", () => {
    assert.deepEqual(settle(input({ outcome: "tripped", tripReason: "cost_cap", meter: meterOf(6_000_000) })), cap(500, "capped"));
    assert.deepEqual(settle(input({ meter: meterOf(5_000_000) })), cap(500, "metered"));
    assert.deepEqual(settle(input({ meter: meterOf(9_999_999), caps: { holdCents: 300, timeCapSec: 120 } })), cap(300, "metered"));
  });
  it("the minimum comes from the rate card", () => {
    const strict: RateCard = { ...rc1, minChargeCents: 60 };
    assert.deepEqual(settle(input({ rate: strict, meter: meterOf(550_000) })), cxl("under_minimum"));
    assert.deepEqual(settle(input({ rate: strict, meter: meterOf(600_000) })), cap(60, "metered"));
  });
  it("a meter that is not a number never becomes money", () => {
    assert.deepEqual(settle(input({ meter: meterOf(Number.NaN) })), cxl("under_minimum"));
    assert.deepEqual(settle(input({ meter: meterOf(-5) })), cxl("under_minimum"));
  });
  it("a fuse-mode decision never reads the verdict or the artifact", () => {
    assert.deepEqual(settle(input({ hasArtifact: false, verdict: "inconclusive" })), cap(103, "metered"));
  });
});

describe("settle: fuse+notary mode (pay-on-proof)", () => {
  const n = (over: Partial<SettleInput> = {}): SettleInput =>
    input({ mode: "fuse+notary", verdict: { passed: 10, total: 10 }, ...over });
  it("an inconclusive notary leaves the hold", () => {
    assert.deepEqual(settle(n({ verdict: "inconclusive" })), left);
  });
  it("an infra error leaves the hold (the table's first row)", () => {
    assert.deepEqual(settle(n({ outcome: "infra_error" })), left);
  });
  it("tripped cancels as no_artifact whatever ON_TRIP says", () => {
    assert.deepEqual(settle(n({ outcome: "tripped", tripReason: "cost_cap", onTrip: "metered", meter: meterOf(4_370_000) })), cxl("no_artifact"));
    assert.deepEqual(settle(n({ outcome: "tripped", tripReason: "time_cap", onTrip: "nothing" })), cxl("no_artifact"));
  });
  it("no artifact cancels as no_artifact", () => {
    assert.deepEqual(settle(n({ hasArtifact: false })), cxl("no_artifact"));
    assert.deepEqual(settle(n({ hasArtifact: false, verdict: undefined })), cxl("no_artifact"));
  });
  it("an artifact but no verdict yet leaves the hold [judgment]", () => {
    assert.deepEqual(settle(n({ verdict: undefined })), left);
  });
  it("zero hidden cases passed cancels as verdict_fail", () => {
    assert.deepEqual(settle(n({ verdict: { passed: 0, total: 10 } })), cxl("verdict_fail"));
  });
  it("all passed captures the metered cents", () => {
    assert.deepEqual(settle(n()), cap(103, "metered"));
  });
  it("partial passes capture pro rata, floored: floor(cents × passed / total)", () => {
    assert.deepEqual(settle(n({ verdict: { passed: 7, total: 10 } })), cap(72, "pro_rata"));    // 103 × 7 / 10 = 72.1
    assert.deepEqual(settle(n({ verdict: { passed: 9, total: 10 } })), cap(92, "pro_rata"));    // 92.7 floors
    assert.deepEqual(settle(n({ verdict: { passed: 1, total: 3 }, meter: meterOf(1_500_000) })), cap(50, "pro_rata"));
  });
  it("a pro-rata amount under the minimum cancels as under_minimum", () => {
    assert.deepEqual(settle(n({ verdict: { passed: 4, total: 10 } })), cxl("under_minimum"));    // 41
    assert.deepEqual(settle(n({ verdict: { passed: 1, total: 2 }, meter: meterOf(990_000) })), cxl("under_minimum"));   // 49
    assert.deepEqual(settle(n({ verdict: { passed: 1, total: 2 }, meter: meterOf(1_000_000) })), cap(50, "pro_rata"));  // 50
  });
  it("a full pass with metered cents under the minimum cancels as under_minimum", () => {
    assert.deepEqual(settle(n({ meter: meterOf(400_000) })), cxl("under_minimum"));
  });
  it("pro rata is computed on the capped amount", () => {
    assert.deepEqual(settle(n({ meter: meterOf(9_000_000), verdict: { passed: 5, total: 10 } })), cap(250, "pro_rata"));
  });
  it("a verdict that makes no sense leaves the hold [judgment]", () => {
    assert.deepEqual(settle(n({ verdict: { passed: 3, total: 0 } })), left);
    assert.deepEqual(settle(n({ verdict: { passed: 11, total: 10 } })), left);
    assert.deepEqual(settle(n({ verdict: { passed: -1, total: 10 } })), left);
    assert.deepEqual(settle(n({ verdict: { passed: Number.NaN, total: 10 } })), left);
  });
});

// ── Fuse, on a fake clock ───────────────────────────────────────────────
type TripCall = { reason: TripReason; meter: Meter; next?: number; estIn?: number; maxOut?: number };

function mkFuse(caps: Caps = holdCaps, rate: RateCard = rc1) {
  const trips: TripCall[] = [];
  const fuse = createFuse({
    caps, rate, reserveVmSec: 10, now: () => Date.now(),
    onTrip: (reason, meter, next, estIn, maxOut) => { trips.push({ reason, meter, next, estIn, maxOut }); },
  });
  return { fuse, trips };
}

describe("fuse (fake clock)", () => {
  beforeEach(() => mock.timers.enable({ apis: ["setInterval", "Date"] }));
  afterEach(() => mock.timers.reset());

  it("cost trip: cost plus one sandbox-second reaching the hold trips cost_cap on the 250 ms watchdog", () => {
    const { fuse, trips } = mkFuse({ holdCents: 100, timeCapSec: 120 });   // hold = 1,000,000 µ$
    fuse.vmStarted();
    fuse.arm();
    fuse.addTokens(0, 12_800);                  // 12,800 × 75 = 960,000 µ$
    mock.timers.tick(750);                      // 960,000 + 15,000 + 20,000 = 995,000: no trip yet
    assert.equal(trips.length, 0);
    assert.equal(fuse.tripped(), null);
    mock.timers.tick(250);                      // t = 1.0 s: 980,000 + 20,000 = 1,000,000 ≥ hold
    assert.equal(trips.length, 1);
    assert.equal(trips[0].reason, "cost_cap");
    assert.equal(trips[0].meter.costMicros, 980_000);
    assert.equal(trips[0].meter.vmSeconds, 1);
    assert.equal(trips[0].next, undefined);
    assert.equal(fuse.tripped(), "cost_cap");
  });

  it("reservation trip: false, and onTrip gets nextStepMicros, estIn and maxOut", () => {
    const { fuse, trips } = mkFuse();           // hold = 5,000,000 µ$
    fuse.vmStarted();
    fuse.arm();
    fuse.addTokens(0, 58_000);                  // 4,350,000 µ$
    assert.equal(fuse.reserve(1_000, 100), true, "222,500 µ$ fits");
    assert.equal(trips.length, 0);
    assert.equal(fuse.reserve(10_000, 4_096), false);   // 150,000 + 307,200 + 200,000 = 657,200 → 5,007,200 > hold
    assert.equal(trips.length, 1);
    assert.equal(trips[0].reason, "reservation");
    assert.equal(trips[0].next, 657_200);
    assert.equal(trips[0].estIn, 10_000);
    assert.equal(trips[0].maxOut, 4_096);
    assert.equal(trips[0].meter.costMicros, 4_350_000);
    assert.equal(fuse.tripped(), "reservation");
    assert.equal(fuse.reserve(1, 1), false, "false once tripped");
    assert.equal(trips.length, 1);
  });

  it("reservation: landing exactly on the hold is allowed, one µ$ over is not", () => {
    const { fuse, trips } = mkFuse();
    fuse.addTokens(0, 58_000);                  // 4,350,000 µ$
    assert.equal(fuse.reserve(0, 6_000), true); // 450,000 + 200,000 = 650,000 → exactly 5,000,000
    assert.equal(fuse.reserve(0, 6_001), false);// 5,000,075
    assert.equal(trips[0].next, 650_075);
  });

  it("reservation fails closed on an estimate that is not a number", () => {
    const { fuse, trips } = mkFuse();
    assert.equal(fuse.reserve(Number.NaN, 100), false);
    assert.equal(trips[0].reason, "reservation");
    assert.equal(trips[0].next, undefined);
  });

  it("time trip: a busy loop at rc1 with a 40 s cap trips time_cap at 40 s with 800,000 µ$", () => {
    const { fuse, trips } = mkFuse({ holdCents: 500, timeCapSec: 40 });
    fuse.vmStarted();
    fuse.arm();
    mock.timers.tick(39_750);
    assert.equal(trips.length, 0);
    mock.timers.tick(250);
    assert.equal(trips.length, 1);
    assert.equal(trips[0].reason, "time_cap");
    assert.equal(trips[0].meter.workSec, 40);
    assert.equal(trips[0].meter.vmSeconds, 40);
    assert.equal(trips[0].meter.costMicros, 800_000);
    assert.deepEqual(
      settle({ mode: "fuse", onTrip: "metered", meter: trips[0].meter, caps: { holdCents: 500, timeCapSec: 40 }, rate: rc1, outcome: "tripped", tripReason: "time_cap", hasArtifact: false }),
      cap(80, "time_capped"),
    );
  });

  it("onTrip fires exactly once and the first reason wins", () => {
    const { fuse, trips } = mkFuse({ holdCents: 100, timeCapSec: 120 });
    fuse.vmStarted();
    fuse.arm();
    fuse.addTokens(0, 13_000);                  // 975,000 µ$: the first tick sees 980,000 + 20,000 ≥ hold
    mock.timers.tick(250);
    assert.equal(trips.length, 1);
    mock.timers.tick(5_000);
    fuse.tripNow("manual");
    fuse.tripNow("time_cap");
    assert.equal(fuse.reserve(1, 1), false);
    assert.equal(trips.length, 1);
    assert.equal(fuse.tripped(), "cost_cap");
  });

  it("the meter is frozen at the trip: later time and tokens change nothing", () => {
    const { fuse, trips } = mkFuse({ holdCents: 500, timeCapSec: 40 });
    fuse.vmStarted();
    fuse.arm();
    fuse.addTokens(100, 50);
    fuse.addTurn();
    mock.timers.tick(40_000);
    assert.equal(trips.length, 1);
    const frozen = fuse.meter();
    assert.equal(frozen.vmSeconds, 40);
    mock.timers.tick(10_000);
    fuse.addTokens(5_000, 5_000, true);         // the tokens of an aborted call are never billed
    fuse.addTurn();
    assert.deepEqual(fuse.meter(), frozen);
    assert.equal(fuse.meter().tokensIn, 100);
    assert.equal(fuse.meter().turns, 1);
    assert.equal(fuse.meter().estimatedTokens, false);
    fuse.meter().costMicros = 1;                // the returned meter is a copy
    assert.deepEqual(fuse.meter(), frozen);
    assert.equal(trips[0].meter.vmSeconds, 40);
  });

  it("tripNow(manual) trips at once and freezes the meter", () => {
    const { fuse, trips } = mkFuse();
    fuse.vmStarted();
    fuse.arm();
    mock.timers.tick(1_000);
    fuse.tripNow("manual");
    assert.equal(trips.length, 1);
    assert.equal(trips[0].reason, "manual");
    assert.equal(trips[0].meter.vmSeconds, 1);
    assert.equal(fuse.tripped(), "manual");
    mock.timers.tick(60_000);
    assert.equal(fuse.meter().vmSeconds, 1);
    assert.equal(trips.length, 1);
  });

  it("disarm stops the watchdog only: no time trip, the meter keeps running, tripNow still works", () => {
    const { fuse, trips } = mkFuse({ holdCents: 500, timeCapSec: 40 });
    fuse.vmStarted();
    fuse.arm();
    mock.timers.tick(10_000);
    fuse.disarm();
    mock.timers.tick(100_000);
    assert.equal(trips.length, 0);
    assert.equal(fuse.tripped(), null);
    assert.equal(fuse.meter().vmSeconds, 110);
    fuse.tripNow("manual");                     // [judgment] disarm is not a lock
    assert.equal(trips.length, 1);
  });

  it("vmStopped freezes vmSeconds (the worked example), keeps counting tokens, and ends the watchdog", () => {
    const { fuse, trips } = mkFuse({ holdCents: 500, timeCapSec: 40 });
    fuse.vmStarted();
    fuse.arm();
    mock.timers.tick(31_200);
    fuse.vmStopped();
    fuse.addTokens(14_210, 2_650);              // [judgment] usage that arrives after the stop is still billed
    for (let i = 0; i < 3; i++) fuse.addTurn();
    mock.timers.tick(100_000);                  // far past the 40 s cap
    assert.equal(trips.length, 0);
    assert.equal(fuse.tripped(), null);
    const m = fuse.meter();
    assert.equal(m.vmSeconds, 31.2);
    assert.equal(m.workSec, 31.2);
    assert.equal(m.costMicros, 1_035_900);
    assert.equal(m.turns, 3);
    fuse.tripNow("manual");                     // [judgment] a lane whose VM has stopped has nothing left to cut
    assert.equal(trips.length, 0);
  });

  it("arm without vmStarted starts the clock at arm; a second vmStarted does not move it", () => {
    const { fuse } = mkFuse();
    mock.timers.tick(5_000);
    fuse.arm();
    mock.timers.tick(2_000);
    assert.equal(fuse.meter().vmSeconds, 2);
    fuse.vmStarted();                           // too late to move the clock
    mock.timers.tick(1_000);
    assert.equal(fuse.meter().vmSeconds, 3);
  });

  it("the clock starts at vmStarted, not at creation", () => {
    const { fuse } = mkFuse();
    mock.timers.tick(3_000);
    assert.equal(fuse.meter().vmSeconds, 0);
    fuse.vmStarted();
    mock.timers.tick(1_000);
    fuse.vmStarted();
    mock.timers.tick(1_000);
    assert.equal(fuse.meter().vmSeconds, 2);
  });

  it("tokens and turns add up; estimated is sticky", () => {
    const { fuse } = mkFuse();
    fuse.addTokens(100, 50);
    fuse.addTokens(20, 10);
    fuse.addTurn();
    fuse.addTurn();
    assert.deepEqual([fuse.meter().tokensIn, fuse.meter().tokensOut, fuse.meter().turns], [120, 60, 2]);
    assert.equal(fuse.meter().estimatedTokens, false);
    fuse.addTokens(1, 1, true);
    fuse.addTokens(1, 1, false);
    assert.equal(fuse.meter().estimatedTokens, true);
    assert.equal(fuse.meter().costMicros, 122 * 15 + 62 * 75);
  });

  it("a throwing onTrip handler does not break the fuse", () => {
    const quiet = mock.method(console, "error", () => {});
    try {
      const fuse = createFuse({ caps: holdCaps, rate: rc1, reserveVmSec: 10, now: () => Date.now(), onTrip: () => { throw new Error("boom"); } });
      fuse.tripNow("manual");
      assert.equal(fuse.tripped(), "manual");
    } finally {
      quiet.mock.restore();
    }
  });
});

// ── Stripe, against a stateful fake client ──────────────────────────────
type Params = Record<string, unknown>;
type Call = { op: string; id?: string; params?: Params; idem?: string };

class FakeStripe implements StripeLike {
  calls: Call[] = [];
  pis = new Map<string, PiLike>();
  retrieveMod?: (pi: PiLike) => PiLike;
  private seen = new Map<string, PiLike>();
  private fails = new Map<string, unknown[]>();
  private n = 0;

  failNext(op: string, err: unknown, times = 1): void {
    this.fails.set(op, [...(this.fails.get(op) ?? []), ...Array<unknown>(times).fill(err)]);
  }
  ops(): string[] { return this.calls.map((c) => c.op); }
  private maybeFail(op: string): void {
    const q = this.fails.get(op);
    if (q && q.length) throw q.shift();
  }
  private once(op: string, idem: string, run: () => PiLike): PiLike {
    const hit = this.seen.get(idem);
    if (hit) return { ...hit };
    const pi = run();
    this.seen.set(idem, { ...pi });
    return { ...pi };
  }
  private need(id: string): PiLike {
    const pi = this.pis.get(id);
    if (!pi) throw Object.assign(new Error(`No such payment_intent: '${id}'`), { code: "resource_missing" });
    return pi;
  }

  paymentIntents: StripeLike["paymentIntents"] = {
    create: async (params, o) => {
      this.calls.push({ op: "create", params, idem: o.idempotencyKey });
      this.maybeFail("create");
      return this.once("create", o.idempotencyKey, () => {
        const pi: PiLike = {
          id: `pi_fake_${++this.n}`, status: "requires_capture", amount: params.amount as number,
          amount_received: 0, metadata: { ...(params.metadata as Record<string, string>) },
        };
        this.pis.set(pi.id, pi);
        return pi;
      });
    },
    capture: async (id, params, o) => {
      this.calls.push({ op: "capture", id, params, idem: o.idempotencyKey });
      this.maybeFail("capture");
      return this.once("capture", o.idempotencyKey, () => {
        const pi = this.need(id);
        const amt = params.amount_to_capture as number;
        if (pi.status !== "requires_capture") throw Object.assign(new Error("not capturable"), { code: "payment_intent_unexpected_state" });
        if (amt > pi.amount) throw Object.assign(new Error("Amount must be no more than the authorization"), { code: "amount_too_large" });
        pi.status = "succeeded";
        pi.amount_received = amt;
        pi.metadata = { ...pi.metadata, ...(params.metadata as Record<string, string>) };
        return pi;
      });
    },
    update: async (id, params, o) => {
      this.calls.push({ op: "update", id, params, idem: o.idempotencyKey });
      this.maybeFail("update");
      return this.once("update", o.idempotencyKey, () => {
        const pi = this.need(id);
        pi.metadata = { ...pi.metadata, ...(params.metadata as Record<string, string>) };
        return pi;
      });
    },
    cancel: async (id, params, o) => {
      this.calls.push({ op: "cancel", id, params, idem: o.idempotencyKey });
      this.maybeFail("cancel");
      return this.once("cancel", o.idempotencyKey, () => {
        const pi = this.need(id);
        if (pi.status !== "requires_capture") throw Object.assign(new Error("not cancelable"), { code: "payment_intent_unexpected_state" });
        pi.status = "canceled";
        return pi;
      });
    },
    retrieve: async (id) => {
      this.calls.push({ op: "retrieve", id });
      this.maybeFail("retrieve");
      const pi = { ...this.need(id) };
      return this.retrieveMod ? this.retrieveMod(pi) : pi;
    },
    list: async () => {
      this.calls.push({ op: "list" });
      this.maybeFail("list");
      return { data: [] };
    },
  };
}

const KEY = "hx:abcd1234:A";
const MD = { app: "holdout", run_id: "abcd1234", lane_id: "A" };

describe("stripe: hold", () => {
  it("creates a manual-capture hold with allowed_payment_method_types under the :hold key, then retrieves", async () => {
    const fake = new FakeStripe();
    const pay = createPay({ stripe: fake });
    const r = await pay.hold(KEY, 500, "test hold", MD);
    assert.deepEqual(r, { id: "pi_fake_1", status: "requires_capture" });
    assert.deepEqual(fake.ops(), ["create", "retrieve"]);
    const c = fake.calls[0];
    assert.equal(c.idem, `${KEY}:hold`);
    assert.deepEqual(c.params, {
      amount: 500, currency: "usd", capture_method: "manual", confirm: true, payment_method: "pm_card_visa",
      description: "test hold", metadata: MD, allowed_payment_method_types: ["card"],
    });
    assert.ok(!("payment_method_types" in c.params!), "payment_method_types no longer exists");
    assert.ok(!("automatic_payment_methods" in c.params!));
    assert.equal(pay.holdForm(), "allowed_payment_method_types");
  });

  it("the same key returns the same PaymentIntent (idempotent)", async () => {
    const fake = new FakeStripe();
    const pay = createPay({ stripe: fake });
    const a = await pay.hold(KEY, 500, "d", MD);
    const b = await pay.hold(KEY, 500, "d", MD);
    assert.equal(a.id, b.id);
    assert.equal(fake.pis.size, 1);
  });

  it("falls back once to automatic_payment_methods under :hold-apm when confirm asks for a return_url, never both", async () => {
    const fake = new FakeStripe();
    fake.failNext("create", new Error("This PaymentIntent requires a `return_url` or set automatic_payment_methods[allow_redirects] to never"));
    const pay = createPay({ stripe: fake });
    const r = await pay.hold(KEY, 500, "d", MD);
    assert.equal(r.status, "requires_capture");
    assert.deepEqual(fake.ops(), ["create", "create", "retrieve"]);
    assert.equal(fake.calls[1].idem, `${KEY}:hold-apm`);
    assert.deepEqual(fake.calls[1].params!.automatic_payment_methods, { enabled: true, allow_redirects: "never" });
    assert.ok(!("allowed_payment_method_types" in fake.calls[1].params!));
    assert.equal(pay.holdForm(), "automatic_payment_methods");
  });

  it("any other create error is a SettlementPendingError and does not try the fallback", async () => {
    const fake = new FakeStripe();
    fake.failNext("create", Object.assign(new Error("Your card was declined."), { code: "card_declined", statusCode: 402 }));
    const pay = createPay({ stripe: fake });
    await assert.rejects(pay.hold(KEY, 500, "d", MD), (e: unknown) => {
      assert.ok(e instanceof SettlementPendingError);
      assert.equal(e.code, "card_declined");
      assert.equal(e.statusCode, 402);
      return true;
    });
    assert.deepEqual(fake.ops(), ["create"]);
  });

  it("rejects a bad amount or bad metadata before calling Stripe", async () => {
    const fake = new FakeStripe();
    const pay = createPay({ stripe: fake });
    await assert.rejects(pay.hold(KEY, 0, "d", MD), RangeError);
    await assert.rejects(pay.hold(KEY, 5.5, "d", MD), RangeError);
    await assert.rejects(pay.hold(KEY, 500, "d", { k: "x".repeat(501) }), RangeError);
    assert.deepEqual(fake.ops(), []);
  });
});

describe("stripe: capture", () => {
  it("captures under :cap with the metadata on the capture, then retrieves Stripe's own status", async () => {
    const fake = new FakeStripe();
    const pay = createPay({ stripe: fake });
    const { id } = await pay.hold(KEY, 500, "d", MD);
    fake.calls.length = 0;
    const r = await pay.capture(KEY, id, 103, { receipt_sha256: "smoke", metered_micros: "1035900" });
    assert.deepEqual(r, { status: "succeeded", amountReceived: 103 });
    assert.deepEqual(fake.ops(), ["capture", "retrieve"]);
    assert.equal(fake.calls[0].idem, `${KEY}:cap`);
    assert.deepEqual(fake.calls[0].params, { amount_to_capture: 103, metadata: { receipt_sha256: "smoke", metered_micros: "1035900" } });
    const got = await pay.retrieve(id);
    assert.equal(got.amount, 500);
    assert.deepEqual(got.metadata, { ...MD, receipt_sha256: "smoke", metered_micros: "1035900" }, "metadata is merged");
  });

  it("refuses under 50 cents before calling Stripe", async () => {
    const fake = new FakeStripe();
    const pay = createPay({ stripe: fake });
    const { id } = await pay.hold(KEY, 500, "d", MD);
    fake.calls.length = 0;
    await assert.rejects(pay.capture(KEY, id, MIN_CAPTURE_CENTS - 1, {}), RangeError);
    await assert.rejects(pay.capture(KEY, id, 0, {}), RangeError);
    await assert.rejects(pay.capture(KEY, id, 50.5, {}), RangeError);
    assert.deepEqual(fake.ops(), []);
    assert.equal((await pay.capture(KEY, id, MIN_CAPTURE_CENTS, {})).amountReceived, 50);
  });

  it("an over-capture is refused by Stripe and becomes a SettlementPendingError that leaves the hold", async () => {
    const fake = new FakeStripe();
    const pay = createPay({ stripe: fake });
    const { id } = await pay.hold(KEY, 500, "d", MD);
    await assert.rejects(pay.capture(KEY, id, 501, {}), (e: unknown) => {
      assert.ok(e instanceof SettlementPendingError);
      assert.equal(e.code, "amount_too_large");
      assert.match(e.message, /^settlement pending: capture failed/);
      return true;
    });
    assert.equal((await pay.retrieve(id)).status, "requires_capture");
  });

  it("returns Stripe's retrieved status and amount_received, never an echo", async () => {
    const fake = new FakeStripe();
    const pay = createPay({ stripe: fake });
    const { id } = await pay.hold(KEY, 500, "d", MD);
    fake.retrieveMod = (pi) => ({ ...pi, status: "processing", amount_received: 7 });
    assert.deepEqual(await pay.capture(KEY, id, 103, {}), { status: "processing", amountReceived: 7 });
  });
});

describe("stripe: release", () => {
  it("updates the metadata (:md) before it cancels (:cxl), with a retrieve after each", async () => {
    const fake = new FakeStripe();
    const pay = createPay({ stripe: fake });
    const { id } = await pay.hold(KEY, 500, "d", MD);
    fake.calls.length = 0;
    const r = await pay.release(KEY, id, { receipt_sha256: "smoke" });
    assert.deepEqual(r, { status: "canceled" });
    assert.deepEqual(fake.ops(), ["update", "retrieve", "cancel", "retrieve"]);
    assert.equal(fake.calls[0].idem, `${KEY}:md`);
    assert.deepEqual(fake.calls[0].params, { metadata: { receipt_sha256: "smoke" } });
    assert.equal(fake.calls[2].idem, `${KEY}:cxl`);
    assert.deepEqual(fake.calls[2].params, { cancellation_reason: "abandoned" });
    assert.equal((await pay.retrieve(id)).metadata.receipt_sha256, "smoke");
  });

  it("a replay after the cancel already happened does not cancel twice", async () => {
    const fake = new FakeStripe();
    const pay = createPay({ stripe: fake });
    const { id } = await pay.hold(KEY, 500, "d", MD);
    await pay.release(KEY, id, { receipt_sha256: "smoke" });
    fake.calls.length = 0;
    assert.deepEqual(await pay.release(`${KEY}2`, id, { receipt_sha256: "smoke" }), { status: "canceled" });
    assert.deepEqual(fake.ops(), ["update", "retrieve"]);
  });

  it("a cancel failure leaves the hold and is a SettlementPendingError", async () => {
    const fake = new FakeStripe();
    const pay = createPay({ stripe: fake });
    const { id } = await pay.hold(KEY, 500, "d", MD);
    fake.failNext("cancel", Object.assign(new Error("socket hang up"), { type: "StripeConnectionError" }));
    await assert.rejects(pay.release(KEY, id, {}), SettlementPendingError);
    assert.equal((await pay.retrieve(id)).status, "requires_capture");
  });
});

describe("stripe: retrieve, errors, ping", () => {
  it("retrieve returns status, amount, amountReceived and metadata", async () => {
    const fake = new FakeStripe();
    const pay = createPay({ stripe: fake });
    const { id } = await pay.hold(KEY, 500, "d", MD);
    assert.deepEqual(await pay.retrieve(id), { status: "requires_capture", amount: 500, amountReceived: 0, metadata: MD });
  });

  it("a final Stripe error becomes a SettlementPendingError with no key in the text", async () => {
    const leaky = Object.assign(new Error("Invalid API Key provided: sk_test_ABCDEF123456abcdef"), {
      type: "StripeAuthenticationError", code: "api_key_invalid", statusCode: 401, requestId: "req_9",
    });
    for (const op of ["hold", "capture", "release", "retrieve"] as const) {
      const fake = new FakeStripe();
      const pay = createPay({ stripe: fake });
      const { id } = await pay.hold(KEY, 500, "d", MD);
      const bad = op === "hold" ? "create" : op === "capture" ? "capture" : op === "release" ? "update" : "retrieve";
      fake.failNext(bad, leaky);
      const run = op === "hold" ? pay.hold(`${KEY}x`, 500, "d", MD)
        : op === "capture" ? pay.capture(KEY, id, 103, {})
        : op === "release" ? pay.release(KEY, id, {})
        : pay.retrieve(id);
      await assert.rejects(run, (e: unknown) => {
        assert.ok(e instanceof SettlementPendingError, `${op}: SettlementPendingError`);
        assert.equal(e.name, "SettlementPendingError");
        assert.match(e.message, /^settlement pending: /);
        assert.ok(!e.message.includes("ABCDEF123456"), `${op}: key fragment in the message`);
        assert.ok(!/sk_test_/.test(e.message), `${op}: key prefix in the message`);
        assert.equal(e.code, "api_key_invalid");
        assert.equal(e.requestId, "req_9");
        assert.ok(e.message.length < 300);
        return true;
      });
    }
  });

  it("pingStripe returns ok, or a short error without the key; it never throws", async () => {
    const fake = new FakeStripe();
    assert.equal(await pingStripe({ stripe: fake }), "ok");
    assert.deepEqual(fake.ops(), ["list"]);
    fake.failNext("list", new Error("Invalid API Key provided: sk_test_ABCDEF123456abcdef " + "x".repeat(300)));
    const bad = await pingStripe({ stripe: fake });
    assert.ok(bad.length > 0 && bad.length <= 120);
    assert.ok(!bad.includes("ABCDEF123456"));
    fake.failNext("list", "plain string failure");
    assert.equal(await pingStripe({ stripe: fake }), "plain string failure");
  });
});

describe("stripe: key guard", () => {
  it("keyClass names the class and nothing else", () => {
    assert.equal(keyClass("sk_test_abc"), "sk_test");
    assert.equal(keyClass("rk_test_abc"), "rk_test");
    for (const k of ["sk_live_abc", "rk_live_abc", "pk_test_abc", "", "sk_test", "Bearer sk_test_abc", "acct_123"]) {
      assert.equal(keyClass(k), null, k);
    }
  });

  it("createPay refuses any key that is not a test secret key, without echoing it", () => {
    for (const key of ["sk_live_SECRETVALUE123", "rk_live_SECRETVALUE123", "pk_test_SECRETVALUE123", "SECRETVALUE123", ""]) {
      assert.throws(() => createPay({ key }), (e: unknown) => {
        assert.ok(e instanceof Error);
        assert.match(e.message, /test-mode secret key/);
        assert.ok(!e.message.includes("SECRETVALUE123"));
        return true;
      }, key);
    }
  });

  it("createPay accepts sk_test_ and rk_test_ keys and makes no network call to do so", () => {
    for (const key of ["sk_test_dummy000", "rk_test_dummy000"]) {
      const pay = createPay({ key });
      assert.deepEqual(Object.keys(pay).sort(), ["capture", "holdForm", "hold", "release", "retrieve"].sort());
    }
  });
});

describe("stripe: checkMetadata", () => {
  const names = ["app", "run_id", "lane_id", "job_id", "mode", "rate_card", "on_trip", "metered_micros", "vm_seconds", "tokens_in",
    "tokens_out", "turns", "trip_reason", "sandbox_id", "egress", "probe_exits", "check", "receipt_sha256"];
  it("accepts the documented keys", () => {
    checkMetadata(Object.fromEntries(names.map((k) => [k, "v"])));
    checkMetadata({});
  });
  it("accepts exactly 50 keys and rejects 51", () => {
    const md = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, "v"]));
    checkMetadata(md(50));
    assert.throws(() => checkMetadata(md(51)), /50/);
  });
  it("accepts a 40-character key and rejects 41", () => {
    checkMetadata({ ["k".repeat(40)]: "v" });
    assert.throws(() => checkMetadata({ ["k".repeat(41)]: "v" }), /40/);
  });
  it("accepts a 500-character value and rejects 501", () => {
    checkMetadata({ k: "v".repeat(500) });
    assert.throws(() => checkMetadata({ k: "v".repeat(501) }), /500/);
  });
  it("rejects an empty key and a value that is not a string", () => {
    assert.throws(() => checkMetadata({ "": "v" }), /empty key/);
    assert.throws(() => checkMetadata({ k: 5 as unknown as string }), /not a string/);
  });
});

// ── The smoke script's own logic, against the fake (the real run is scripts/smoke-stripe.ts) ──
describe("smoke-stripe logic", () => {
  it("passes against a faithful fake: A captured 103, B and C canceled, capture called once in total", async () => {
    const fake = new FakeStripe();
    const pay = createPay({ stripe: fake });
    const r = await smoke(pay, { runId: "smkabc12", log: () => {}, holdForm: () => pay.holdForm() });
    assert.deepEqual(r.failures, []);
    assert.equal(r.ok, true);
    assert.equal(r.idempotentReplay, true);
    assert.equal(r.captureCallsLaneC, 0);
    assert.deepEqual(r.rows.map((x) => [x.lane, x.status, x.amount, x.amountReceived]), [
      ["A", "succeeded", 500, 103], ["B", "canceled", 500, 0], ["C", "canceled", 500, 0],
    ]);
    const captures = fake.calls.filter((c) => c.op === "capture");
    assert.equal(captures.length, 1);
    assert.equal(captures[0].id, r.rows[0].id);
    assert.equal(fake.pis.size, 3, "exactly three PaymentIntents");
    for (const c of fake.calls.filter((x) => x.op === "create")) {
      assert.ok(!/holdout/i.test(String(c.params!.description)), "the description never says Holdout");
      assert.equal((c.params!.metadata as Record<string, string>).app, "smoke-stripe");
      assert.match(String(c.params!.description), /^smoke-stripe test · run smkabc12 · lane [ABC]$/);
    }
    const table = formatTable(r.rows);
    assert.match(table, /payment intent/);
    assert.match(table, /pi_fake_1/);
  });

  it("reports a failure and releases the hold when a lane breaks after its hold", async () => {
    const fake = new FakeStripe();
    fake.failNext("capture", new Error("socket hang up"));
    const pay = createPay({ stripe: fake });
    const r = await smoke(pay, { runId: "smkabc12", log: () => {} });
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => f.startsWith("A: no error")));
    assert.equal(r.rows.find((x) => x.lane === "A")!.status, "canceled", "the dangling hold was released");
    assert.equal(r.rows.find((x) => x.lane === "B")!.status, "canceled");
  });
});
