// scripts/run-cli.ts: start one live run on a Holdout server, follow its events to the end, print the settlement.
// Usage: npx tsx scripts/run-cli.ts [--url http://localhost:8787 | --deployed] [--lanes honest,runaway]
//        [--hold 500] [--cap 120] [--ticks]
// The admin token is read from .env.local through src/config.ts and is never printed.
import { readFileSync } from "node:fs";
import { cfg } from "../src/config.js";
import type { ContractorKind, Run, RunEvent } from "../src/contracts.js";

const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(`--${name}`);
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const base = (flag("deployed")
  ? (JSON.parse(readFileSync("data/deploy.json", "utf8")) as { url: string }).url
  : opt("url") ?? `http://localhost:${cfg.port}`).replace(/\/+$/, "");
const lanes = (opt("lanes") ?? "honest,runaway").split(",").map((s) => s.trim()).filter(Boolean) as ContractorKind[];
const holdCents = Number(opt("hold") ?? 500);
const timeCapSec = Number(opt("cap") ?? 120);
const showTicks = flag("ticks");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (!cfg.adminToken) {
  console.error("run-cli: ADMIN_TOKEN is not set in .env.local");
  process.exit(2);
}
const auth = { authorization: `Bearer ${cfg.adminToken}` };

function short(ev: RunEvent): string | null {
  const d = (ev.data ?? {}) as Record<string, unknown>;
  const pick = (...keys: string[]) => keys.filter((k) => d[k] !== undefined).map((k) => `${k}=${JSON.stringify(d[k])}`).join(" ");
  switch (ev.type) {
    case "run.started": return `run ${(d as unknown as Run).runId} · ${(d as unknown as Run).lanes.map((l) => `${l.laneId}:${l.contractor}`).join(" ")}`;
    case "meter.tick": return showTicks ? pick("workSec", "costMicros", "tokensIn", "tokensOut") : null;
    case "agent.tool": return `${String(d.command ?? "").slice(0, 70).replace(/\s+/g, " ")} → exit ${String(d.exit)} (${String(d.ms)} ms)`;
    case "agent.turn": return pick("turn", "tokensIn", "tokensOut", "stopReason", "ms", "model");
    case "check.result": return `pass=${String(d.pass)} cases=${Array.isArray(d.cases) ? d.cases.length : "?"}`;
    case "vm.sealed": return `${String(d.sandboxId)} readback=${JSON.stringify(d.egressReadback)} probes=${JSON.stringify(d.probes)} reused=${String(d.reused)}`;
    case "vm.reset": return `${String(d.sandboxId)} ${String(d.fromLane)} → ${String(d.toLane)}`;
    case "fuse.tripped": return `${String(d.reason)} at ${JSON.stringify((d.meter as Record<string, unknown> | undefined)?.costMicros)} µ$ ${pick("nextStepMicros")}`;
    default: return pick("state", "note", "piId", "amountCents", "status", "name", "sandboxId", "createMs", "ms", "ok",
      "running", "capturedCents", "releasedCents", "reason", "receiptSha256", "where", "message");
  }
}

async function main(): Promise<void> {
  console.log(`run-cli: POST ${base}/api/runs lanes=${lanes.join(",")} hold=${holdCents} cap=${timeCapSec}s`);
  const res = await fetch(`${base}/api/runs`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ mode: "fuse", lanes, holdCents, timeCapSec }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (res.status !== 202) {
    console.error(`run-cli: refused with HTTP ${res.status}: ${text.slice(0, 300)}`);
    process.exit(1);
  }
  const { runId } = JSON.parse(text) as { runId: string };
  console.log(`run-cli: run ${runId} started`);

  let after = 0;
  let failures = 0;
  const t0 = Date.now();
  for (;;) {
    if (Date.now() - t0 > 10 * 60_000) throw new Error("gave up after 10 minutes");
    try {
      const r = await fetch(`${base}/api/runs/${runId}/events?after=${after}`, { signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error(`events HTTP ${r.status}`);
      const page = (await r.json()) as { events: RunEvent[]; done: boolean };
      failures = 0;
      for (const ev of page.events) {
        after = Math.max(after, ev.seq);
        const line = short(ev);
        if (line !== null) console.log(`${(ev.t / 1000).toFixed(1).padStart(6)}s ${ev.laneId ?? "-"} ${ev.type.padEnd(16)} ${line}`);
      }
      if (page.done) break;
    } catch (e) {
      // Network trouble: stop after three misses in a row rather than retrying forever (CLAUDE.md, Network).
      if (++failures >= 3) throw new Error(`events polling failed 3 times: ${e instanceof Error ? e.message : String(e)}`);
    }
    await sleep(1_000);
  }

  const snap = (await (await fetch(`${base}/api/runs/${runId}`, { signal: AbortSignal.timeout(10_000) })).json()) as Run;
  console.log(`run-cli: run ${runId} done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  for (const l of snap.lanes) {
    const s = l.settlement;
    console.log(`  lane ${l.laneId} ${l.contractor}: ${l.state} · ${s ? `${s.action} ${s.capturedCents}¢ (${s.reason}) · Stripe ${s.piStatus} · receipt ${s.receiptSha256.slice(0, 12)}` : "no settlement"}` +
      ` · pi ${l.pi?.id ?? "none"} · ${l.meter.vmSeconds.toFixed(1)} s, ${l.meter.tokensIn}/${l.meter.tokensOut} tokens${l.trip ? ` · tripped ${l.trip.reason}` : ""}${l.error ? ` · error: ${l.error}` : ""}`);
  }
}

main().catch((e) => {
  console.error(`run-cli: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
