// test/run.test.ts: the orchestrator on a fake Vm, Pay and agent. The real fuse, settle table and rate card run.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentOptions, CheckResult, JobId, JobSpec, Pay, Run, RunAgent, RunEvent, SealProof, Vm } from "../src/contracts.js";
import { createRunner, type RunConfig, type RunDeps } from "../src/run.js";
import { canonicalJson, sha256Hex } from "../src/receipt.js";
import { createFuse } from "../src/fuse.js";
import { NOT_RUN, settle } from "../src/settle.js";
import { RATE_CARDS } from "../src/meter.js";
import { checkMetadata } from "../src/stripe.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function proof(id: string, reused: boolean): SealProof {
  return {
    sandboxId: id, name: "hx-test", createMs: 5, egressRequested: ["192.0.2.1/32"], egressReadback: ["192.0.2.1/32"],
    readbackOk: true, probes: [{ label: "https", exit: 6 }, { label: "raw_ip", exit: 28 }, { label: "dns", exit: 2 }],
    resealed: false, reused,
  };
}

function fakeVm(log: string[]): Vm {
  let n = 0;
  return {
    async createSealed(name) { log.push(`create ${name}`); const id = `sb-${++n}`; return { vm: { id, name, createdAt: 0 }, seal: proof(id, false) }; },
    async connect(id) { log.push(`connect ${id}`); return { vm: { id, name: "hd-dev1-test", createdAt: 0 }, seal: proof(id, true) }; },
    async reset(vm, lane) { log.push(`reset ${vm.id} ${lane}`); return proof(vm.id, vm.id.startsWith("dev")); },
    async exec() { return { exit: 0, stdout: "", stderr: "", ms: 1, timedOut: false }; },
    async upload() {},
    async download() { return new TextEncoder().encode("print('ok')\n"); },
    async spawn() { log.push("spawn"); return "proc-1"; },
    async waitProcess() { return { exited: false }; },
    async killProcess() {},
    async destroy(vm) { log.push(`destroy ${vm.id}`); },
    async waitDestroyed() { return { ok: true, ms: 12 }; },
    async state() { return "running"; },
    async running() { return 0; },
    async creates() { return { used24h: 3, cap: 10 }; },
  };
}

interface FakePi { status: string; amount: number; amountReceived: number; metadata: Record<string, string> }
function fakePay(log: string[], failHoldFor?: string): Pay & { pis: Map<string, FakePi> } {
  const pis = new Map<string, FakePi>();
  let n = 0;
  const get = (id: string) => { const p = pis.get(id); if (!p) throw new Error(`no ${id}`); return p; };
  return {
    pis,
    async hold(key, cents, _desc, md) {
      log.push(`hold ${key}`);
      if (failHoldFor && key.endsWith(failHoldFor)) throw new Error("card declined");
      const id = `pi_${++n}`;
      pis.set(id, { status: "requires_capture", amount: cents, amountReceived: 0, metadata: { ...md } });
      return { id, status: "requires_capture" };
    },
    async capture(_key, id, cents, md) {
      log.push(`capture ${id} ${cents}`);
      const p = get(id); p.status = "succeeded"; p.amountReceived = cents; Object.assign(p.metadata, md);
      return { status: p.status, amountReceived: cents };
    },
    async release(_key, id, md) {
      log.push(`release ${id}`);
      const p = get(id); Object.assign(p.metadata, md); p.status = "canceled";
      return { status: p.status };
    },
    async retrieve(id) { log.push(`retrieve ${id}`); const p = get(id); return { ...p, metadata: { ...p.metadata } }; },
  };
}

// The fake model: "honest" writes, submits and is accepted; "runaway" spends, then asks for a call the fuse refuses.
const fakeAgent: RunAgent = async (o, h) => {
  const turn = (tokensIn: number, tokensOut: number) =>
    h.onTurn({ turn: 1, tokensIn, tokensOut, stopReason: "tool_use", ms: 5, estimated: false, model: "fake-model", estIn: 100 });
  if (o.system === "honest") {
    if (!h.beforeCall(100, 4096)) return { outcome: "refused" };
    turn(30_000, 3_000);   // 450,000 + 225,000 µ$ = 67 cents
    const v = await o.onSubmit("done");
    return v.accept ? { outcome: "submitted", summary: "done" } : { outcome: "turn_cap" };
  }
  turn(40_000, 4_000);     // 600,000 + 300,000 µ$ = 90 cents
  await sleep(20);
  if (!h.beforeCall(1_000_000, 4096)) return { outcome: "refused" };
  return { outcome: "turn_cap" };
};

function fakeJob(id: JobId): JobSpec {
  return { id, title: id, specMd: "spec", visible: [], freshCases: 0, gen: () => "", ref: () => "" };
}
const check = (pass: boolean): CheckResult => ({
  pass, log: pass ? "3/3" : "too slow", cases: [1, 2, 3].map((i) => ({ name: `c${i}`, pass, rc: 0, ms: 20 })),
});

function deps(log: string[], pay: Pay, cfg: Partial<RunConfig> = {}): RunDeps {
  const opts = (system: string) => (p: { vm: AgentOptions["vm"]; vmApi: Vm; onSubmit: AgentOptions["onSubmit"] }): AgentOptions => ({
    model: "fake-model", fallbackModel: "fake-fallback", system, firstMessage: "go", vm: p.vm, vmApi: p.vmApi,
    maxTurns: 8, maxTokens: 4096, onSubmit: p.onSubmit,
  });
  return {
    vmApi: fakeVm(log), pay, runAgent: fakeAgent, createFuse, settle, notRun: NOT_RUN, rateCards: RATE_CARDS,
    loadJob: fakeJob, jobFiles: () => [{ path: "/work/SPEC.md", data: "spec" }],
    hostCheck: async (_v, _vm, job) => check(job.id === "csv-reconcile"),
    honestOptions: opts("honest"), runawayOptions: opts("runaway"),
    startBusyloop: async (vmApi, vm) => vmApi.spawn(vm, "python3 -c 'while True: pass'", "/work"),
    checkMetadata,
    cfg: { vmMode: "fresh", devVmId: "", concurrency: 1, onTrip: "metered", rateCard: "rc1", model: "fake-model", notary: false, ...cfg },
    log: () => {},
  };
}

function fakeBus() {
  const events: RunEvent[] = [];
  const receipts = new Map<string, string>();
  const state = { done: false };
  return {
    events, receipts, state,
    register(run: Run) {
      const emit = (type: RunEvent["type"], laneId: RunEvent["laneId"], data: unknown) => {
        events.push({ seq: events.length + 1, t: 0, runId: run.runId, ...(laneId ? { laneId } : {}), type, data: structuredClone(data) });
      };
      emit("run.started", undefined, run);
      return emit;
    },
    finish() { state.done = true; },
    setReceipt(_runId: string, laneId: string, canonical: string) { receipts.set(laneId, canonical); },
  };
}

async function untilDone(bus: ReturnType<typeof fakeBus>, ms = 8_000) {
  const t0 = Date.now();
  while (!bus.state.done) {
    if (Date.now() - t0 > ms) throw new Error("run did not finish");
    await sleep(10);
  }
}
const of = (bus: ReturnType<typeof fakeBus>, type: string, lane?: string) =>
  bus.events.filter((e) => e.type === type && (lane === undefined || e.laneId === lane));

test("Free-serial fresh: holds first, A captured, reset hands the VM to B, B trips and the VM is destroyed", async () => {
  const log: string[] = [];
  const pay = fakePay(log);
  const bus = fakeBus();
  const r = createRunner(deps(log, pay));
  const { runId } = r.startRun({ mode: "fuse", lanes: ["honest", "runaway"] }, bus);
  assert.equal(bus.events[0].type, "run.started");   // registered synchronously
  await untilDone(bus);
  const run = bus.events[0].data as Run;
  assert.equal(run.runId, runId);
  assert.equal(run.maxTokens, 4096);
  assert.equal(run.reserveVmSec, 10);

  const creates = log.filter((x) => x.startsWith("create "));
  assert.equal(creates.length, 1, "one sealed VM per run");
  assert.match(creates[0], new RegExp(`^create hx-${runId.slice(0, 4)}-A-[0-9a-f]{4}$`));
  assert.ok(log.indexOf("create " + creates[0].slice(7)) > log.lastIndexOf(`hold hx:${runId}:B`), "both holds before the create");

  const a = of(bus, "settle.captured", "A")[0].data as { capturedCents: number; status: string; receiptSha256: string };
  assert.equal(a.status, "succeeded");
  assert.ok(a.capturedCents >= 67 && a.capturedCents <= 68, `A captured ${a.capturedCents}`);
  const reset = of(bus, "vm.reset", "B")[0].data as { fromLane: string; toLane: string; seal: SealProof };
  assert.equal(reset.fromLane, "A");
  assert.equal(reset.seal.sharedFrom, "A");
  assert.ok(log.indexOf("reset sb-1 B") > log.indexOf(log.find((x) => x.startsWith("capture "))!), "A settles before the reset");

  const trip = of(bus, "fuse.tripped", "B")[0].data as { reason: string; estIn?: number; maxOut?: number };
  assert.equal(trip.reason, "reservation");
  assert.equal(trip.estIn, 1_000_000);
  assert.equal(trip.maxOut, 4096);
  assert.deepEqual(log.filter((x) => x.startsWith("destroy ")), ["destroy sb-1"]);
  assert.equal((of(bus, "vm.destroyed", "B")[0].data as { ms: number }).ms, 12);
  const b = of(bus, "settle.captured", "B")[0].data as { capturedCents: number; releasedCents: number };
  assert.ok(b.capturedCents >= 90 && b.capturedCents < 500, `B captured ${b.capturedCents}`);
  assert.equal(b.capturedCents + b.releasedCents, 500);

  // Every Stripe mutation is followed by a retrieve of the same PaymentIntent.
  for (const [i, line] of log.entries()) {
    const m = /^(capture|release) (pi_\d+)/.exec(line);
    if (m) assert.ok(log.slice(i + 1).includes(`retrieve ${m[2]}`), `retrieve after ${line}`);
  }
  // The receipt bytes hash to the digest in the event and in Stripe's metadata.
  for (const laneId of ["A", "B"]) {
    const canonical = bus.receipts.get(laneId)!;
    const sha = sha256Hex(canonical);
    assert.equal((of(bus, "settle.captured", laneId)[0].data as { receiptSha256: string }).receiptSha256, sha);
    const pi = [...pay.pis.values()].find((p) => p.metadata.lane_id === laneId)!;
    assert.equal(pi.metadata.receipt_sha256, sha);
    assert.equal(JSON.parse(canonical).lane_id, laneId);
  }
  assert.equal(JSON.parse(bus.receipts.get("A")!).settlement.reason, "metered");
  assert.equal(JSON.parse(bus.receipts.get("B")!).settlement.reason, "capped");
});

test("Free-serial: lane A trips, lane B is not run and its hold is cancelled", async () => {
  const log: string[] = [];
  const bus = fakeBus();
  createRunner(deps(log, fakePay(log))).startRun({ mode: "fuse", lanes: ["runaway", "honest"] }, bus);
  await untilDone(bus);
  assert.equal(log.filter((x) => x.startsWith("create ")).length, 1);
  assert.equal(log.filter((x) => x.startsWith("reset ")).length, 0, "no handoff after a trip");
  assert.equal((of(bus, "settle.canceled", "B")[0].data as { reason: string }).reason, "not_run");
  assert.ok(of(bus, "settle.captured", "A").length === 1);
  assert.deepEqual(log.filter((x) => x.startsWith("destroy ")), ["destroy sb-1"]);
});

test("no hold, no machine: a declined hold creates nothing and releases the other hold", async () => {
  const log: string[] = [];
  const bus = fakeBus();
  createRunner(deps(log, fakePay(log, ":B"))).startRun({ mode: "fuse", lanes: ["honest", "runaway"] }, bus);
  await untilDone(bus);
  assert.equal(log.filter((x) => x.startsWith("create ")).length, 0);
  assert.equal((of(bus, "settle.canceled", "A")[0].data as { reason: string }).reason, "infra_error");
  const states = of(bus, "lane.state", "B").map((e) => (e.data as { state: string }).state);
  assert.equal(states.at(-1), "failed");
});

test("manual trip on the busy-loop fixture: under the minimum, the hold is released", async () => {
  const log: string[] = [];
  const bus = fakeBus();
  const r = createRunner(deps(log, fakePay(log)));
  const { runId } = r.startRun({ mode: "fuse", lanes: ["runaway-busyloop"] }, bus);
  const t0 = Date.now();
  while (!of(bus, "lane.state", "A").some((e) => (e.data as { state: string }).state === "working")) {
    if (Date.now() - t0 > 3_000) throw new Error("lane never started working");
    await sleep(10);
  }
  assert.equal(r.tripRun(runId), true);
  await untilDone(bus);
  assert.equal(r.tripRun(runId), false, "a finished run cannot be tripped");
  assert.equal((of(bus, "fuse.tripped", "A")[0].data as { reason: string }).reason, "manual");
  assert.equal((of(bus, "settle.canceled", "A")[0].data as { reason: string }).reason, "under_minimum");
  assert.ok(log.includes("spawn"));
  assert.deepEqual(log.filter((x) => x.startsWith("destroy ")), ["destroy sb-1"]);
  assert.equal((bus.events[0].data as Run).lanes[0].caps.timeCapSec, 40);
});

test("reuse mode: connects to the dev VM, never destroys it, and a trip resets /work instead", async () => {
  const log: string[] = [];
  const bus = fakeBus();
  createRunner(deps(log, fakePay(log), { vmMode: "reuse", devVmId: "dev-1" })).startRun({ mode: "fuse", lanes: ["runaway"] }, bus);
  await untilDone(bus);
  assert.ok(log.includes("connect dev-1"));
  assert.equal(log.filter((x) => x.startsWith("create ") || x.startsWith("destroy ")).length, 0);
  assert.ok(log.includes("reset dev-1 A"), "soft destroy kills the /work processes");
  assert.equal((of(bus, "vm.destroyed", "A")[0].data as { soft?: boolean }).soft, true);
  assert.equal((of(bus, "vm.sealed", "A")[0].data as SealProof).reused, true);
});

test("CONCURRENCY=2 in fresh mode: one sealed VM per lane, each destroyed", async () => {
  const log: string[] = [];
  const bus = fakeBus();
  createRunner(deps(log, fakePay(log), { concurrency: 2 })).startRun({ mode: "fuse", lanes: ["honest", "runaway"] }, bus);
  await untilDone(bus);
  assert.equal(log.filter((x) => x.startsWith("create ")).length, 2);
  assert.deepEqual(log.filter((x) => x.startsWith("destroy ")).sort(), ["destroy sb-1", "destroy sb-2"]);
  assert.equal(of(bus, "vm.reset").length, 0);
});

test("startRun refuses notary mode on the floor and unknown input synchronously", () => {
  const log: string[] = [];
  const r = createRunner(deps(log, fakePay(log)));
  assert.throws(() => r.startRun({ mode: "fuse+notary", lanes: ["honest"] }, fakeBus()), /NOTARY is off/);
  assert.throws(() => r.startRun({ mode: "fuse", lanes: [] }, fakeBus()), /lanes/);
  assert.throws(() => r.startRun({ mode: "fuse", lanes: ["honest"], holdCents: 10 }, fakeBus()), /at least 50/);
  assert.equal(log.length, 0);
});

test("canonical JSON sorts keys recursively and drops whitespace", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[1,{"y":2,"z":1}]},"b":1}');
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
