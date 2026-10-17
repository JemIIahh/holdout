// scripts/smoke-stripe.ts: one-time Stripe smoke, test mode only, with the app's STRIPE_SECRET_KEY from .env.local.
// Three PaymentIntents: A hold then capture 103 (with metadata), B hold then update-and-cancel,
// C hold then settle() on a 30-cent meter (under_minimum) then release. Run from the project directory:
//   npx tsx scripts/smoke-stripe.ts
// Never prints a key: only the key class (sk_test or rk_test).
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import Stripe from "stripe";
import { cfg } from "../src/config.js";
import type { Pay } from "../src/contracts.js";
import { RATE_CARDS, computeMeter } from "../src/meter.js";
import { settle } from "../src/settle.js";
import { createPay, keyClass, pingStripe } from "../src/stripe.js";

export interface SmokeRow { lane: string; id: string; status: string; amount: number; amountReceived: number; note: string }
export interface SmokeResult { ok: boolean; rows: SmokeRow[]; failures: string[]; runId: string; idempotentReplay: boolean; captureCallsLaneC: number }

const rc1 = RATE_CARDS.rc1;

// The descriptions never say "Holdout": the demo's Stripe tab is filtered by that word.
export async function smoke(
  pay: Pay,
  o: { runId?: string; log?: (s: string) => void; holdForm?: () => string | null } = {},
): Promise<SmokeResult> {
  const log = o.log ?? ((s: string) => console.log(s));
  const runId = o.runId ?? `smk${randomBytes(3).toString("hex").slice(0, 5)}`;
  const failures: string[] = [];
  const rows: SmokeRow[] = [];
  let idempotentReplay = false;
  let captureCallsLaneC = 0;

  const check = (label: string, ok: boolean): void => {
    log(`  ${ok ? "ok  " : "FAIL"} ${label}`);
    if (!ok) failures.push(label);
  };
  const desc = (lane: string): string => `smoke-stripe test · run ${runId} · lane ${lane}`;
  const md = (lane: string): Record<string, string> => ({ app: "smoke-stripe", run_id: runId, lane_id: lane });
  const key = (lane: string): string => `hx:${runId}:${lane}`;

  // A lane that fails after its hold exists still gets its hold released, so no hold is left dangling.
  const lane = async (name: string, work: (note: (id: string) => void) => Promise<void>): Promise<void> => {
    let piId = "";
    log(`lane ${name}`);
    try {
      await work((id) => { piId = id; });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      check(`${name}: no error (${msg.slice(0, 160)})`, false);
      if (piId) {
        try { await pay.release(`${key(name)}-cleanup`, piId, {}); } catch { /* best effort */ }
      }
    }
    if (piId) {
      try {
        const r = await pay.retrieve(piId);
        rows.push({ lane: name, id: piId, status: r.status, amount: r.amount, amountReceived: r.amountReceived, note: "" });
      } catch {
        rows.push({ lane: name, id: piId, status: "unknown", amount: 0, amountReceived: 0, note: "retrieve failed" });
      }
    }
  };

  await lane("A", async (note) => {
    const a = await pay.hold(key("A"), 500, desc("A"), md("A"));
    note(a.id);
    check("A: hold is requires_capture", a.status === "requires_capture");
    const again = await pay.hold(key("A"), 500, desc("A"), md("A"));
    idempotentReplay = again.id === a.id;
    check("A: the same hold call again returns the same PaymentIntent id", idempotentReplay);
    const c = await pay.capture(key("A"), a.id, 103, { receipt_sha256: "smoke", metered_micros: "1035900" });
    check("A: capture status is succeeded", c.status === "succeeded");
    check("A: amount_received is 103", c.amountReceived === 103);
    const got = await pay.retrieve(a.id);
    check("A: receipt_sha256 is in the metadata", got.metadata.receipt_sha256 === "smoke");
    check("A: the hold metadata is kept (merged)", got.metadata.app === "smoke-stripe" && got.metadata.run_id === runId);
    check("A: the hold was 500 cents", got.amount === 500);
    if (o.holdForm) log(`  hold form used: ${o.holdForm() ?? "unknown"}`);
  });

  await lane("B", async (note) => {
    const b = await pay.hold(key("B"), 500, desc("B"), md("B"));
    note(b.id);
    check("B: hold is requires_capture", b.status === "requires_capture");
    const r = await pay.release(key("B"), b.id, { receipt_sha256: "smoke" });
    check("B: release is canceled", r.status === "canceled");
    const got = await pay.retrieve(b.id);
    check("B: metadata after cancel is present", got.metadata.receipt_sha256 === "smoke" && got.metadata.app === "smoke-stripe");
  });

  await lane("C", async (note) => {
    // The spy proves the under-minimum path never reaches capture.
    const spy: Pay = {
      hold: (...a) => pay.hold(...a),
      release: (...a) => pay.release(...a),
      retrieve: (...a) => pay.retrieve(...a),
      capture: (...a) => { captureCallsLaneC += 1; return pay.capture(...a); },
    };
    const c = await spy.hold(key("C"), 500, desc("C"), md("C"));
    note(c.id);
    check("C: hold is requires_capture", c.status === "requires_capture");
    // 15 sandbox-seconds at rc1 = 300,000 µ$ = 30 cents, under the 50 cent minimum.
    const meter = computeMeter({ workSec: 15, vmSeconds: 15, tokensIn: 0, tokensOut: 0, turns: 0, estimatedTokens: false }, rc1);
    const d = settle({ mode: "fuse", onTrip: "metered", meter, caps: { holdCents: 500, timeCapSec: 120 }, rate: rc1, outcome: "submitted", hasArtifact: true });
    check("C: settle on a 30-cent meter returns cancel under_minimum", d.action === "cancel" && d.reason === "under_minimum" && meter.costMicros === 300_000);
    if (d.action === "cancel") {
      const r = await spy.release(key("C"), c.id, { receipt_sha256: "smoke", metered_micros: String(meter.costMicros) });
      check("C: release is canceled", r.status === "canceled");
    }
    check("C: capture was never called", captureCallsLaneC === 0);
  });

  return { ok: failures.length === 0 && rows.length === 3, rows, failures, runId, idempotentReplay, captureCallsLaneC };
}

export function formatTable(rows: SmokeRow[]): string {
  const head = ["lane", "payment intent", "status", "amount", "amount_received"];
  const body = rows.map((r) => [r.lane, r.id, r.status, String(r.amount), String(r.amountReceived)]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (c: string[]): string => c.map((x, i) => x.padEnd(w[i])).join("  ");
  return [line(head), line(w.map((n) => "-".repeat(n))), ...body.map(line)].join("\n");
}

async function main(): Promise<void> {
  const cls = keyClass(cfg.stripeKey);
  if (cls === null) {
    console.error("smoke-stripe: refused: STRIPE_SECRET_KEY must be a test-mode secret key (sk_test_ or rk_test_)");
    process.exitCode = 1;
    return;
  }
  console.log(`key class: ${cls} (value never shown) · SDK API version ${Stripe.API_VERSION}`);
  const ping = await pingStripe();
  console.log(`pingStripe: ${ping}`);
  if (ping !== "ok") {
    process.exitCode = 1;
    return;
  }
  const pay = createPay();
  const r = await smoke(pay, { holdForm: () => pay.holdForm() });
  console.log(`\nrun ${r.runId}\n${formatTable(r.rows)}`);
  console.log(`\nidempotent replay same id: ${r.idempotentReplay ? "yes" : "no"} · capture called in lane C: ${r.captureCallsLaneC === 0 ? "no" : "yes"}`);
  console.log(r.ok ? "smoke-stripe: ALL ASSERTIONS HELD" : `smoke-stripe: FAILED (${r.failures.length}): ${r.failures.join(" | ")}`);
  process.exitCode = r.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`smoke-stripe: ${e instanceof Error ? e.message.replace(/\b(?:sk|rk|pk)_(?:test|live)_[A-Za-z0-9_*]+/g, "[key]") : "error"}`);
    process.exitCode = 1;
  });
}
