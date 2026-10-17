// src/settle.ts: capture math, pure and table-tested (DESIGN 9.6, evaluated top to bottom).
// The client never pays more than the authorization hold, and never pays for our failure.
import type { SettleDecision, SettleInput, SettleReason, TripReason } from "./contracts.js";

// A lane that was skipped (Free-serial, lane A tripped) cannot be expressed by SettleInput.
// run.ts settles that lane with this constant, so the table row still lives in one place.
export const NOT_RUN: SettleDecision = { action: "cancel", cents: 0, reason: "not_run" };

const cancel = (reason: SettleReason): SettleDecision => ({ action: "cancel", cents: 0, reason });
const capture = (cents: number, reason: SettleReason): SettleDecision => ({ action: "capture", cents, reason });
const leave = (): SettleDecision => ({ action: "leave", cents: 0, reason: "inconclusive" });

function trippedReason(r: TripReason | undefined): SettleReason {
  // cost_cap, reservation and manual all read "capped"; only the time cap has its own word.
  return r === "time_cap" ? "time_capped" : "capped";
}

export function settle(i: SettleInput): SettleDecision {
  // billable never exceeds the hold; cents round down, in the client's favour.
  const holdMicros = Math.max(0, i.caps.holdCents) * 10_000;
  const spent = Number.isFinite(i.meter.costMicros) && i.meter.costMicros > 0 ? i.meter.costMicros : 0;
  const billable = Math.min(spent, holdMicros);
  const cents = Math.floor(billable / 10_000);
  const min = i.rate.minChargeCents;

  if (i.mode === "fuse") {
    // [judgment] infra_error cancels whatever the meter says: the client never pays for our failure.
    if (i.outcome === "infra_error") return cancel("infra_error");
    // A trip, or a turn cap (treated like a trip, [judgment]), under ON_TRIP=nothing delivers nothing.
    // The receipt still shows the metered amount at the cut.
    if ((i.outcome === "tripped" || i.outcome === "turn_cap") && i.onTrip === "nothing") return cancel("no_delivery");
    if (cents < min) return cancel("under_minimum");
    if (i.outcome === "submitted" || i.outcome === "turn_cap") return capture(cents, "metered");
    return capture(cents, trippedReason(i.tripReason));
  }

  // fuse+notary (pay-on-proof): only proven work is captured, whatever ON_TRIP says.
  // The notary could not decide, or our infrastructure failed: leave the hold ("manual review").
  if (i.verdict === "inconclusive" || i.outcome === "infra_error") return leave();
  if (i.outcome === "tripped" || !i.hasArtifact) return cancel("no_artifact");
  // [judgment] an artifact but no verdict yet: leave the hold until the notary reports.
  if (i.verdict === undefined) return leave();
  const { passed, total } = i.verdict;
  // [judgment] a verdict that makes no arithmetic sense is never turned into money.
  if (!Number.isFinite(passed) || !Number.isFinite(total) || total <= 0 || passed < 0 || passed > total) return leave();
  if (passed === 0) return cancel("verdict_fail");
  const c = Math.floor((cents * passed) / total);
  if (c < min) return cancel("under_minimum");
  return capture(c, passed < total ? "pro_rata" : "metered");
}
