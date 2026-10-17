// src/meter.ts: pure meter arithmetic and the posted rate cards (DESIGN 9.2, 9.3).
// Integer micro-dollars (µ$) throughout. No I/O, no clock, no config.
import type { Meter, RateCard } from "./contracts.js";

// rc1: posted demo rates. The sandbox and token prices are a posted client price list, not list prices.
// infra and list prices are display only and never billed. "rc2" is added by Main after calibration.
export const RATE_CARDS: Record<string, RateCard> = {
  rc1: {
    version: "rc1",
    vmMicrosPerSec: 20_000,   // $0.02 per sandbox-second
    inMicrosPerTok: 15,       // $15 per million input tokens
    outMicrosPerTok: 75,      // $75 per million output tokens
    infraMicrosPerSec: 13.3,  // CreateOS list price, s-1vcpu-1gb (display only)
    listInMicrosPerTok: 4,    // first-party list price, Opus 5.5 input (display only)
    listOutMicrosPerTok: 20,  // first-party list price, Opus 5.5 output (display only)
    minChargeCents: 50,       // below this the hold is cancelled, never captured
  },
  // rc2 = rc1 × 2.4 (one factor for all three posted prices), calibrated on dev VM #1 at 23:30 WAT:
  // honest 3/3 accepted at 32.1, 17.0 and 22.4 s metered (median $1.37 at rc2); the live runaway's reservation
  // check refuses its next call at about 64 s of work. Frozen before recorded run 1.
  rc2: {
    version: "rc2",
    vmMicrosPerSec: 48_000,   // $0.048 per sandbox-second
    inMicrosPerTok: 36,       // $36 per million input tokens
    outMicrosPerTok: 180,     // $180 per million output tokens
    infraMicrosPerSec: 13.3,
    listInMicrosPerTok: 4,
    listOutMicrosPerTok: 20,
    minChargeCents: 50,
  },
};

// Scales the three posted prices by k; the sandbox rate by vmK when given (DESIGN 9.3 step 3: "raise only
// the sandbox rate"). Infra, list prices and the minimum charge are kept.
export function scaleRateCard(base: RateCard, k: number, version: string, vmK?: number): RateCard {
  return {
    ...base,
    version,
    vmMicrosPerSec: base.vmMicrosPerSec * (vmK ?? k),
    inMicrosPerTok: base.inMicrosPerTok * k,
    outMicrosPerTok: base.outMicrosPerTok * k,
  };
}

// Float products such as 0.3 × 20_000 can land one ulp under the integer they stand for, so the cost is nudged
// by far less than a µ$ before it is floored. The nudge is 1e-6 µ$ at most and never moves a real value across
// a whole µ$.
const FLOOR_EPS = 1e-6;

function nonNeg(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function computeMeter(
  x: { workSec: number; vmSeconds: number; tokensIn: number; tokensOut: number; turns: number; estimatedTokens: boolean },
  rate: RateCard,
): Meter {
  const vmSeconds = nonNeg(x.vmSeconds);
  const tokensIn = nonNeg(x.tokensIn);
  const tokensOut = nonNeg(x.tokensOut);
  return {
    workSec: nonNeg(x.workSec),
    vmSeconds,
    tokensIn,
    tokensOut,
    turns: nonNeg(x.turns),
    costMicros: Math.floor(vmSeconds * rate.vmMicrosPerSec + tokensIn * rate.inMicrosPerTok + tokensOut * rate.outMicrosPerTok + FLOOR_EPS),
    infraMicros: Math.round(vmSeconds * rate.infraMicrosPerSec),
    listTokenMicros: tokensIn * rate.listInMicrosPerTok + tokensOut * rate.listOutMicrosPerTok,
    estimatedTokens: x.estimatedTokens,
  };
}
