// src/receipt.ts: the per-lane receipt (DESIGN 7.5). Canonical JSON (keys sorted recursively, no whitespace, UTF-8),
// then SHA-256 hex. The digest goes into the PaymentIntent metadata as receipt_sha256; the exact bytes go to the bus.
import { createHash } from "node:crypto";
import type { Lane, Run, SettleDecision } from "./contracts.js";

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") {
    if (typeof v === "number" && !Number.isFinite(v)) return "null";
    return JSON.stringify(v ?? null);
  }
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : canonicalJson(x))).join(",")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

// Probe exits as recorded (never predicted): {"https": 6, "raw_ip": 28, "dns": 2}.
function probeExits(lane: Lane): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of lane.seal?.probes ?? []) out[p.label] = p.exit;
  return out;
}

export interface ReceiptParts { run: Run; lane: Lane; decision: SettleDecision; ts: string }

export function buildReceipt({ run, lane, decision, ts }: ReceiptParts): Record<string, unknown> {
  const m = lane.meter;
  const captured = decision.action === "capture" ? decision.cents : 0;
  const released = decision.action === "leave" ? 0 : lane.caps.holdCents - captured;
  return {
    v: 1,
    run_id: run.runId,
    lane_id: lane.laneId,
    contractor: lane.contractor,
    provenance: lane.provenance,
    job_id: lane.jobId,
    mode: run.mode,
    on_trip: run.onTrip,
    rate_card: run.rateCard.version,
    caps: { hold_cents: lane.caps.holdCents, time_cap_s: lane.caps.timeCapSec },
    meter: {
      cost_micros: m.costMicros, tokens_in: m.tokensIn, tokens_out: m.tokensOut, turns: m.turns,
      vm_seconds: Math.round(m.vmSeconds * 10) / 10, estimated_tokens: m.estimatedTokens,
    },
    sandboxes: lane.seal
      ? [{
          id: lane.seal.sandboxId, egress: lane.seal.egressReadback, probe_exits: probeExits(lane),
          resealed: lane.seal.resealed, reused: lane.seal.reused, shared_from: lane.seal.sharedFrom ?? null,
        }]
      : [],
    check: lane.check ? { pass: lane.check.pass, cases: lane.check.cases.length } : null,
    artifact_sha256: lane.submission?.artifactSha256 ?? null,
    trip: lane.trip ? { reason: lane.trip.reason, at_s: Math.round(lane.trip.atSec * 10) / 10, at_micros: lane.trip.atMicros } : null,
    settlement: { action: decision.action, reason: decision.reason, captured_cents: captured, released_cents: released },
    verdict: null,
    ts,
  };
}

export function sealReceipt(parts: ReceiptParts): { canonical: string; sha256: string } {
  const canonical = canonicalJson(buildReceipt(parts));
  return { canonical, sha256: sha256Hex(canonical) };
}
