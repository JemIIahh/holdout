// src/fuse.ts: one fuse per lane (DESIGN 9.4, 9.5). The cost cap IS the authorization hold.
// A 250 ms watchdog recomputes the meter; the model-call reservation is checked through reserve().
// The first trip wins, freezes the meter at that instant (the client's bill stops there) and calls onTrip once.
import type { CreateFuse, Fuse, FuseOptions, Meter, TripReason } from "./contracts.js";
import { computeMeter } from "./meter.js";

export const WATCHDOG_MS = 250;

function nonNeg(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export const createFuse: CreateFuse = (o: FuseOptions): Fuse => {
  const now = o.now ?? (() => Date.now());
  const holdMicros = o.caps.holdCents * 10_000;

  let startMs: number | null = null;   // the seal proof: workSec and vmSeconds count from here
  let stopMs: number | null = null;    // vmStopped(): submit; teardown is never billed
  let tokensIn = 0;
  let tokensOut = 0;
  let turns = 0;
  let estimated = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let reason: TripReason | null = null;
  let frozen: Meter | null = null;

  const elapsedSec = (): number => {
    if (startMs === null) return 0;
    return Math.max(0, (stopMs ?? now()) - startMs) / 1000;
  };

  // workSec (the time-cap clock) and vmSeconds (billed) both run from the seal proof.
  const live = (): Meter => {
    const sec = elapsedSec();
    return computeMeter(
      { workSec: sec, vmSeconds: sec, tokensIn, tokensOut, turns, estimatedTokens: estimated },
      o.rate,
    );
  };

  const stopWatchdog = (): void => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };

  const report = (e: unknown): void => {
    console.error(`fuse: onTrip handler failed: ${e instanceof Error ? e.message : String(e)}`);
  };

  // Returns true only for the one call that tripped. A lane whose VM has stopped (submitted) has nothing left to cut.
  const trip = (r: TripReason, nextStepMicros?: number, estIn?: number, maxOut?: number): boolean => {
    if (reason !== null || stopMs !== null) return false;
    frozen = live();
    reason = r;
    stopWatchdog();
    try {
      const out: unknown = r === "reservation"
        ? o.onTrip(r, { ...frozen }, nextStepMicros, estIn, maxOut)
        : o.onTrip(r, { ...frozen });
      if (out && typeof (out as Promise<unknown>).catch === "function") (out as Promise<unknown>).catch(report);
    } catch (e) {
      report(e);
    }
    return true;
  };

  const check = (): void => {
    if (reason !== null || stopMs !== null) return;
    const m = live();
    if (m.costMicros + o.rate.vmMicrosPerSec >= holdMicros) trip("cost_cap");
    else if (m.workSec >= o.caps.timeCapSec) trip("time_cap");
  };

  return {
    arm() {
      if (reason !== null || stopMs !== null || timer !== null) return;
      if (startMs === null) startMs = now();   // vmStarted() was never called: the clock starts now
      timer = setInterval(check, WATCHDOG_MS);
      timer.unref?.();
    },
    disarm() {
      stopWatchdog();
    },
    vmStarted() {
      if (startMs === null) startMs = now();
    },
    vmStopped() {
      if (stopMs !== null || reason !== null) return;
      stopMs = now();
      stopWatchdog();
    },
    addTokens(inTok: number, outTok: number, est?: boolean) {
      if (reason !== null) return;   // the tokens of an aborted call are never billed
      tokensIn += nonNeg(inTok);
      tokensOut += nonNeg(outTok);
      if (est === true) estimated = true;
    },
    addTurn() {
      if (reason === null) turns += 1;
    },
    reserve(estInTok: number, maxOutTok: number): boolean {
      if (reason !== null) return false;
      // Fail closed: an estimate that is not a number is never allowed through.
      const next = Number.isFinite(estInTok) && Number.isFinite(maxOutTok)
        ? nonNeg(estInTok) * o.rate.inMicrosPerTok + nonNeg(maxOutTok) * o.rate.outMicrosPerTok + o.reserveVmSec * o.rate.vmMicrosPerSec
        : Number.NaN;
      if (!Number.isFinite(next) || live().costMicros + next > holdMicros) {
        trip("reservation", Number.isFinite(next) ? next : undefined, estInTok, maxOutTok);
        return false;
      }
      return true;
    },
    meter(): Meter {
      return frozen ? { ...frozen } : live();
    },
    tripped(): TripReason | null {
      return reason;
    },
    tripNow(r: TripReason) {
      trip(r);
    },
  };
};
