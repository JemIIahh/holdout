// src/run.ts: the run orchestrator (DESIGN 9.1-9.7, Main). startRun registers the run synchronously and works
// asynchronously; tripRun is the manual fuse. No hold, no machine: every hold is authorized before any create.
// Free-serial (CONCURRENCY=1): one sealed VM per run; lane A works, settles, then hands the VM to lane B after a
// /work reset and a fresh probe. CONCURRENCY>=2 (fresh mode only): one sealed VM per lane, in parallel.
import { randomBytes, randomUUID } from "node:crypto";
import { cfg } from "./config.js";
import type {
  AgentOptions, Caps, CheckResult, ContractorKind, CreateFuse, Emit, Fuse, JobId, JobSpec, Lane, LaneId, LaneState,
  Meter, Mode, OnTrip, Pay, Provenance, RateCard, Run, RunAgent, SealProof, Settle, SettleDecision, TripReason,
  Vm, VmHandle, VmMode,
} from "./contracts.js";
import type { ContractorParams } from "./contractors/honest.js";
import { sealReceipt, sha256Hex } from "./receipt.js";

// ── What run.ts needs from the other packages (injected, so tests use fakes) ──
export interface RunBus {
  register(run: Run): Emit;
  finish(runId: string): void;
  setReceipt(runId: string, laneId: LaneId, canonical: string): void;
}
export interface RunRequest { mode: Mode; lanes: ContractorKind[]; holdCents?: number; timeCapSec?: number }
export interface RunConfig {
  vmMode: VmMode; devVmId: string; concurrency: number; onTrip: OnTrip; rateCard: string; model: string;
  notary: boolean;
}
export interface RunDeps {
  vmApi: Vm;
  pay: Pay;
  runAgent: RunAgent;
  createFuse: CreateFuse;
  settle: Settle;
  notRun: SettleDecision;
  rateCards: Record<string, RateCard>;
  loadJob(id: JobId): JobSpec;
  jobFiles(job: JobSpec): { path: string; data: string }[];
  hostCheck(vmApi: Vm, vm: VmHandle, job: JobSpec, seed: number): Promise<CheckResult>;
  honestOptions(p: ContractorParams): AgentOptions;
  runawayOptions(p: ContractorParams): AgentOptions;
  startBusyloop(vmApi: Vm, vm: VmHandle): Promise<string>;
  checkMetadata(md: Record<string, string>): void;
  cfg: RunConfig;
  now?: () => number;
  log?: (line: string) => void;
}

export const MAX_TOKENS = 4096;        // per model call; the fuse reserves it before each call
export const RESERVE_VM_SEC = 10;      // the reservation's sandbox-time allowance (DESIGN 9.4)
export const BUSYLOOP_CAP_SEC = 40;    // the busy-loop fixture trips on this time cap (DESIGN 11.4)
const TICK_MS = 500;
const AFTER_TRIP_GRACE_MS = 5_000;     // a tripped lane settles even if its loop has not returned yet
const LANE_IDS: LaneId[] = ["A", "B", "C", "D"];
const SLOT_NOTE = "waiting for the sandbox · Free plan runs 1 microVM at a time";

// ── Per-run and per-lane working state ──────────────────────────────────────
interface LaneCtx {
  lane: Lane;
  job: JobSpec;
  fuse?: Fuse;
  abort: AbortController;
  vm?: VmHandle;
  tick?: ReturnType<typeof setInterval>;
  busyPid?: string;
  onTripped?: () => void;   // resolves the busy-loop wait and the agent race
  torn: boolean;            // the VM was destroyed (or soft-destroyed) by this lane's trip
  shared: boolean;          // the VM is shared with a later lane (Free-serial)
  hasArtifact: boolean;
}
interface RunCtx {
  run: Run;
  emit: Emit;
  lanes: LaneCtx[];
  deps: RunDeps;
  bus: RunBus;
  now: () => number;
  log: (line: string) => void;
}

const active = new Map<string, RunCtx>();

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);
const zeroMeter = (): Meter => ({
  workSec: 0, vmSeconds: 0, tokensIn: 0, tokensOut: 0, turns: 0, costMicros: 0, infraMicros: 0, listTokenMicros: 0,
  estimatedTokens: false,
});
const rand4 = (): string => randomBytes(2).toString("hex");
const seed = (): number => randomBytes(4).readUInt32LE(0);

function jobFor(kind: ContractorKind): JobId {
  return kind === "runaway" ? "csv-reconcile-fast" : "csv-reconcile";
}
function provenanceFor(kind: ContractorKind): Provenance {
  if (kind === "runaway") return "live-model+retry-loop";
  return kind === "honest" || kind === "sloppy" ? "live-model" : "scripted-fixture";
}

// ── Public API (the server imports these two) ───────────────────────────────
export interface Runner {
  startRun(req: RunRequest, bus: RunBus): { runId: string };
  tripRun(runId: string): boolean;
}

export function createRunner(deps: RunDeps): Runner {
  return {
    startRun(req, bus) {
      const ctx = buildRun(req, bus, deps);
      active.set(ctx.run.runId, ctx);
      void work(ctx)
        .catch((e) => {
          ctx.log(`run ${ctx.run.runId}: unexpected failure: ${msg(e)}`);
          ctx.emit("error", undefined, { where: "run", message: msg(e) });
        })
        .finally(() => {
          for (const l of ctx.lanes) stopTick(l);
          active.delete(ctx.run.runId);
          bus.finish(ctx.run.runId);
        });
      return { runId: ctx.run.runId };
    },
    tripRun: tripActive,
  };
}

// The manual fuse: trips every working lane of a live run. False if the run is unknown, finished or has no working lane.
function tripActive(runId: string): boolean {
  const ctx = active.get(runId);
  if (!ctx) return false;
  let any = false;
  for (const l of ctx.lanes) {
    if (l.lane.state === "working" && l.fuse && l.fuse.tripped() === null) {
      l.fuse.tripNow("manual");
      any = true;
    }
  }
  return any;
}

function buildRun(req: RunRequest, bus: RunBus, deps: RunDeps): RunCtx {
  const c = deps.cfg;
  if (req.mode !== "fuse") throw new Error(`mode ${req.mode} is not available on the floor (NOTARY is off)`);
  if (!Array.isArray(req.lanes) || req.lanes.length < 1 || req.lanes.length > LANE_IDS.length) {
    throw new Error(`lanes must list 1 to ${LANE_IDS.length} contractors`);
  }
  const rate = deps.rateCards[c.rateCard];
  if (!rate) throw new Error(`unknown RATE_CARD ${c.rateCard}`);
  if (c.vmMode === "reuse" && !c.devVmId) throw new Error("VM_MODE=reuse needs DEV_VM_ID");
  const holdCents = Math.round(req.holdCents ?? 500);
  if (!Number.isInteger(holdCents) || holdCents < 50) throw new Error("holdCents must be at least 50");
  const now = deps.now ?? Date.now;

  const lanes: LaneCtx[] = req.lanes.map((kind, i) => {
    const jobId = jobFor(kind);
    const caps: Caps = {
      holdCents,
      timeCapSec: kind === "runaway-busyloop" ? BUSYLOOP_CAP_SEC : Math.round(req.timeCapSec ?? 120),
    };
    const lane: Lane = {
      laneId: LANE_IDS[i], contractor: kind, provenance: provenanceFor(kind),
      ...(kind === "runaway-busyloop" ? {} : { model: c.model }),
      jobId, state: "queued", caps, meter: zeroMeter(),
    };
    return { lane, job: deps.loadJob(jobId), abort: new AbortController(), torn: false, shared: false, hasArtifact: false };
  });

  const run: Run = {
    runId: randomUUID().slice(0, 8),
    mode: "fuse", source: "live", label: "LIVE",
    jobId: lanes[0].lane.jobId, rateCard: rate, concurrency: c.concurrency, vmMode: c.vmMode, onTrip: c.onTrip,
    startedAt: now(), lanes: lanes.map((l) => l.lane),
    maxTokens: MAX_TOKENS, reserveVmSec: RESERVE_VM_SEC,
  };
  const emit = bus.register(run);
  const log = deps.log ?? ((line: string) => console.log(line));
  return { run, emit, lanes, deps, bus, now, log };
}

// ── Small helpers ───────────────────────────────────────────────────────────
type LaneResult = { outcome: "submitted" | "turn_cap" | "tripped" | "infra_error"; tripReason?: TripReason };

function setState(ctx: RunCtx, l: LaneCtx, state: LaneState, note?: string): void {
  l.lane.state = state;
  ctx.emit("lane.state", l.lane.laneId, note ? { state, note } : { state });
}
function keyOf(ctx: RunCtx, l: LaneCtx): string {
  return `hx:${ctx.run.runId}:${l.lane.laneId}`;   // stripe.ts appends :hold, :cap, :md, :cxl
}
function laneError(ctx: RunCtx, l: LaneCtx, where: string, e: unknown): void {
  l.lane.error = `${where}: ${msg(e)}`;
  ctx.emit("error", l.lane.laneId, { where, message: msg(e) });
}
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
const delay = <T>(ms: number, v: T): Promise<T> => new Promise((r) => setTimeout(() => r(v), ms));

async function emitCount(ctx: RunCtx): Promise<void> {
  try {
    ctx.emit("vm.count", undefined, { running: await withTimeout(ctx.deps.vmApi.running(), 3_000) });
  } catch (e) {
    ctx.log(`run ${ctx.run.runId}: vm.count skipped (${msg(e)})`);
  }
}
function startTick(ctx: RunCtx, l: LaneCtx): void {
  l.tick = setInterval(() => {
    if (!l.fuse) return;
    l.lane.meter = l.fuse.meter();
    ctx.emit("meter.tick", l.lane.laneId, l.lane.meter);
  }, TICK_MS);
  l.tick.unref?.();
}
function stopTick(l: LaneCtx): void {
  if (l.tick) clearInterval(l.tick);
  l.tick = undefined;
}

// ── The run ─────────────────────────────────────────────────────────────────
async function work(ctx: RunCtx): Promise<void> {
  // 1. Every hold first. No hold, no machine: a Stripe failure never spends a create.
  const ok = await Promise.all(ctx.lanes.map((l) => holdLane(ctx, l)));
  if (!ok.every(Boolean)) {
    await Promise.all(ctx.lanes.map((l) => settleLane(ctx, l, { action: "cancel", cents: 0, reason: "infra_error" })));
    return;
  }
  const c = ctx.deps.cfg;
  if (c.concurrency >= 2 && c.vmMode === "fresh") await Promise.all(ctx.lanes.map((l) => runSolo(ctx, l)));
  else await runSerial(ctx);
}

async function holdLane(ctx: RunCtx, l: LaneCtx): Promise<boolean> {
  const { run, deps } = ctx;
  const lane = l.lane;
  setState(ctx, l, "holding");
  try {
    const md = {
      app: "holdout", run_id: run.runId, lane_id: lane.laneId, job_id: lane.jobId, mode: run.mode,
      rate_card: run.rateCard.version, on_trip: run.onTrip,
    };
    const desc = `Holdout · run ${run.runId} · lane ${lane.laneId} (${lane.contractor}) · cost cap = this hold`;
    const h = await deps.pay.hold(keyOf(ctx, l), lane.caps.holdCents, desc, md);
    const got = await deps.pay.retrieve(h.id);   // Stripe's own status, never ours
    lane.pi = { id: h.id, amountCents: got.amount, status: got.status };
    ctx.emit("hold.authorized", lane.laneId, { piId: h.id, amountCents: got.amount, status: got.status });
    if (got.status !== "requires_capture") throw new Error(`hold ${h.id} is ${got.status}, not requires_capture`);
    setState(ctx, l, "held");
    return true;
  } catch (e) {
    laneError(ctx, l, "hold", e);
    return false;
  }
}

// Fresh mode: createSealed. Reuse mode (development only): connect to the dev VM, which wipes /work and re-probes.
async function provision(ctx: RunCtx, l: LaneCtx): Promise<{ vm: VmHandle; seal: SealProof }> {
  const { deps, run } = ctx;
  const laneId = l.lane.laneId;
  setState(ctx, l, "provisioning");
  try {
    let res: { vm: VmHandle; seal: SealProof };
    if (deps.cfg.vmMode === "reuse") {
      res = await deps.vmApi.connect(deps.cfg.devVmId);
    } else {
      const name = `hx-${run.runId.slice(0, 4)}-${laneId.toLowerCase()}-${rand4()}`;   // CreateOS: lowercase only
      ctx.emit("vm.creating", laneId, { name, attempt: 1 });
      res = await deps.vmApi.createSealed(name);
      ctx.emit("vm.created", laneId, { sandboxId: res.vm.id, createMs: res.seal.createMs });
    }
    l.lane.seal = res.seal;
    ctx.emit("vm.sealed", laneId, res.seal);
    void emitCount(ctx);
    return res;
  } catch (e) {
    const proof = (e as { proof?: Partial<SealProof> }).proof;
    if (proof) ctx.emit("vm.seal_failed", laneId, { egressReadback: proof.egressReadback ?? [], probes: proof.probes ?? [] });
    laneError(ctx, l, "vm", e);
    throw e;
  }
}

// Free-serial: one VM, lanes in order. A accepted → A settles → reset → B. A tripped → the VM is gone; later lanes
// are not run and their holds are cancelled (NOT_RUN).
async function runSerial(ctx: RunCtx): Promise<void> {
  const { deps } = ctx;
  for (const l of ctx.lanes.slice(1)) setState(ctx, l, "waiting_slot", SLOT_NOTE);
  let vm: VmHandle;
  let seal: SealProof;
  try {
    ({ vm, seal } = await provision(ctx, ctx.lanes[0]));
  } catch {
    await Promise.all(ctx.lanes.map((l) => settleLane(ctx, l, { action: "cancel", cents: 0, reason: "infra_error" })));
    return;
  }
  for (let i = 0; i < ctx.lanes.length; i++) {
    const l = ctx.lanes[i];
    const next = ctx.lanes[i + 1];
    l.shared = next !== undefined;
    const r = await execLane(ctx, l, vm, seal);
    const d = decide(ctx, l, r);
    if (r.outcome === "tripped") {
      // The fuse already destroyed the VM; settle in parallel with the measured teardown.
      const rest = ctx.lanes.slice(i + 1);
      await Promise.all([
        settleLane(ctx, l, d),
        awaitTeardown(ctx, l),
        ...rest.map((x) => settleLane(ctx, x, deps.notRun)),
      ]);
      return;
    }
    if (!next) {
      await Promise.all([settleLane(ctx, l, d), finalTeardown(ctx, l, vm)]);
      return;
    }
    await settleLane(ctx, l, d);
    setState(ctx, next, "provisioning");
    try {
      seal = await deps.vmApi.reset(vm, next.lane.laneId);
      seal = { ...seal, sharedFrom: l.lane.laneId };
      next.lane.seal = seal;
      ctx.emit("vm.reset", next.lane.laneId, { sandboxId: vm.id, fromLane: l.lane.laneId, toLane: next.lane.laneId, seal });
    } catch (e) {
      const proof = (e as { proof?: Partial<SealProof> }).proof;
      if (proof) ctx.emit("vm.seal_failed", next.lane.laneId, { egressReadback: proof.egressReadback ?? [], probes: proof.probes ?? [] });
      laneError(ctx, next, "vm.reset", e);
      const rest = ctx.lanes.slice(i + 1);
      await Promise.all([
        ...rest.map((x) => settleLane(ctx, x, { action: "cancel", cents: 0, reason: "infra_error" })),
        finalTeardown(ctx, next, vm),
      ]);
      return;
    }
  }
}

// CONCURRENCY>=2 in fresh mode: one sealed VM per lane, destroyed when the lane ends.
async function runSolo(ctx: RunCtx, l: LaneCtx): Promise<void> {
  let vm: VmHandle;
  let seal: SealProof;
  try {
    ({ vm, seal } = await provision(ctx, l));
  } catch {
    await settleLane(ctx, l, { action: "cancel", cents: 0, reason: "infra_error" });
    return;
  }
  const r = await execLane(ctx, l, vm, seal);
  const d = decide(ctx, l, r);
  if (r.outcome === "tripped") await Promise.all([settleLane(ctx, l, d), awaitTeardown(ctx, l)]);
  else await Promise.all([settleLane(ctx, l, d), finalTeardown(ctx, l, vm)]);
}

// ── One lane's work: uploads, arm, the agent loop (or the busy-loop), host checks, the fuse ─
async function execLane(ctx: RunCtx, l: LaneCtx, vm: VmHandle, seal: SealProof): Promise<LaneResult> {
  const { deps, run } = ctx;
  const lane = l.lane;
  l.vm = vm;
  lane.seal = seal;
  const fuse = deps.createFuse({
    caps: lane.caps, rate: run.rateCard, reserveVmSec: RESERVE_VM_SEC, ...(deps.now ? { now: deps.now } : {}),
    onTrip: (r, m, nextStepMicros, estIn, maxOut) => onTrip(ctx, l, r, m, nextStepMicros, estIn, maxOut),
  });
  l.fuse = fuse;
  fuse.vmStarted();   // the meter's clock starts at the seal proof
  try {
    for (const f of deps.jobFiles(l.job)) await deps.vmApi.upload(vm, f.path, f.data);
  } catch (e) {
    laneError(ctx, l, "upload", e);
    fuse.vmStopped();
    lane.meter = fuse.meter();
    return { outcome: "infra_error" };
  }
  const tripped = new Promise<"tripped">((resolve) => { l.onTripped = () => resolve("tripped"); });
  fuse.arm();
  setState(ctx, l, "working");
  startTick(ctx, l);

  let outcome: string;
  let error: string | undefined;
  if (lane.contractor === "runaway-busyloop") {
    try {
      l.busyPid = await deps.startBusyloop(deps.vmApi, vm);
      outcome = await tripped;   // zero tokens; the time cap ends it
    } catch (e) {
      outcome = "error";
      error = `busyloop: ${msg(e)}`;
    }
  } else {
    const params: ContractorParams = { job: l.job, vm, vmApi: deps.vmApi, onSubmit: (s) => onSubmit(ctx, l, s) };
    const opts = lane.contractor === "runaway" ? deps.runawayOptions(params) : deps.honestOptions(params);
    const loop = deps.runAgent(opts, {
      onTurn: (u) => {
        fuse.addTokens(u.tokensIn, u.tokensOut, u.estimated);
        fuse.addTurn();
        lane.model = u.model;
        lane.meter = fuse.meter();
        ctx.emit("agent.turn", lane.laneId, u);
      },
      onTool: (t) => ctx.emit("agent.tool", lane.laneId, t),
      beforeCall: (estIn, maxOut) => fuse.reserve(estIn, maxOut),
      signal: l.abort.signal,
    }).catch((e) => ({ outcome: "error" as const, error: msg(e) }));
    const out = await Promise.race([loop, tripped.then(() => delay(AFTER_TRIP_GRACE_MS, { outcome: "aborted" as const, error: undefined }))]);
    outcome = out.outcome;
    error = out.error;
  }

  stopTick(l);
  fuse.disarm();
  const reason = fuse.tripped();
  if (reason === null) fuse.vmStopped();   // teardown time is never billed
  lane.meter = fuse.meter();
  ctx.emit("meter.tick", lane.laneId, lane.meter);
  if (reason !== null) return { outcome: "tripped", tripReason: reason };
  if (outcome === "submitted") return { outcome: "submitted" };
  if (outcome === "turn_cap") return { outcome: "turn_cap" };
  laneError(ctx, l, "agent", error ?? outcome);
  return { outcome: "infra_error" };
}

// submit → the host check (the authority). A pass stops the billed clock and records the artifact hash.
async function onSubmit(ctx: RunCtx, l: LaneCtx, summary: string): Promise<{ accept: boolean; feedback?: string }> {
  const { deps } = ctx;
  const lane = l.lane;
  const fuse = l.fuse;
  const vm = l.vm;
  if (!fuse || !vm || fuse.tripped() !== null) return { accept: false };
  lane.submission = { selfReport: summary };
  ctx.emit("agent.submitted", lane.laneId, lane.submission);
  const check = await deps.hostCheck(deps.vmApi, vm, l.job, seed());
  lane.check = check;
  ctx.emit("check.result", lane.laneId, check);
  if (!check.pass) return { accept: false, feedback: check.log };
  if (fuse.tripped() !== null) return { accept: false };
  fuse.vmStopped();   // billed: seal proof → accepted submit
  try {
    const bytes = await deps.vmApi.download(vm, "/work/solution.py");
    if (bytes) {
      lane.submission = { ...lane.submission, artifactSha256: sha256Hex(bytes), bytes: bytes.length };
      l.hasArtifact = true;
    }
  } catch (e) {
    ctx.log(`run ${ctx.run.runId} lane ${lane.laneId}: artifact download failed (${msg(e)})`);
  }
  setState(ctx, l, "submitted");
  return { accept: true };
}

// The trip path (DESIGN 9.5): freeze, abort, destroy at once. Settlement and the measured teardown follow in parallel.
function onTrip(ctx: RunCtx, l: LaneCtx, r: TripReason, m: Meter, nextStepMicros?: number, estIn?: number, maxOut?: number): void {
  const lane = l.lane;
  lane.meter = { ...m };
  lane.trip = {
    reason: r, atSec: m.workSec, atMicros: m.costMicros,
    ...(nextStepMicros !== undefined ? { nextStepMicros } : {}),
    ...(estIn !== undefined ? { estIn } : {}),
    ...(maxOut !== undefined ? { maxOut } : {}),
  };
  l.abort.abort();
  stopTick(l);
  if (l.vm && !l.torn) startTeardown(ctx, l, l.vm);
  setState(ctx, l, "tripped");
  ctx.emit("fuse.tripped", lane.laneId, {
    reason: r, meter: m,
    ...(nextStepMicros !== undefined ? { nextStepMicros } : {}),
    ...(estIn !== undefined ? { estIn } : {}),
    ...(maxOut !== undefined ? { maxOut } : {}),
  });
  l.onTripped?.();
}

// Fresh mode destroys (fire and forget). Reuse mode never destroys the dev VM: reset() kills the managed processes
// whose cwd is under /work and wipes /work (never /ndev), then re-probes.
const softKills = new WeakMap<LaneCtx, Promise<{ ok: boolean; ms: number }>>();
function startTeardown(ctx: RunCtx, l: LaneCtx, vm: VmHandle): void {
  l.torn = true;
  ctx.emit("vm.destroying", l.lane.laneId, { sandboxId: vm.id });
  if (ctx.deps.cfg.vmMode === "reuse") {
    const t0 = ctx.now();
    softKills.set(l, ctx.deps.vmApi.reset(vm, l.lane.laneId).then(
      () => ({ ok: true, ms: ctx.now() - t0 }),
      (e) => { ctx.log(`run ${ctx.run.runId}: dev VM process kill failed (${msg(e)})`); return { ok: false, ms: ctx.now() - t0 }; },
    ));
  } else {
    void ctx.deps.vmApi.destroy(vm);
  }
}
async function awaitTeardown(ctx: RunCtx, l: LaneCtx): Promise<void> {
  const vm = l.vm;
  if (!vm) return;
  const reuse = ctx.deps.cfg.vmMode === "reuse";
  const r = reuse
    ? await (softKills.get(l) ?? Promise.resolve({ ok: false, ms: 0 }))
    : await ctx.deps.vmApi.waitDestroyed(vm, 120_000);
  ctx.emit("vm.destroyed", l.lane.laneId, { sandboxId: vm.id, ms: r.ms, ok: r.ok, ...(reuse ? { soft: true } : {}) });
  if (!reuse) await emitCount(ctx);
}
// The last lane ended without a trip: destroy the run's VM (fresh) and measure it. Reuse mode leaves the dev VM up.
async function finalTeardown(ctx: RunCtx, l: LaneCtx, vm: VmHandle): Promise<void> {
  if (ctx.deps.cfg.vmMode === "reuse") return;
  if (!l.torn) startTeardown(ctx, l, vm);
  l.vm = vm;
  await awaitTeardown(ctx, l);
}

// ── Settlement (DESIGN 9.6, 9.7): decide, receipt, metadata, then Stripe; retrieve after every mutation ─────
function decide(ctx: RunCtx, l: LaneCtx, r: LaneResult): SettleDecision {
  const { run, deps } = ctx;
  return deps.settle({
    mode: run.mode, onTrip: run.onTrip, meter: l.lane.meter, caps: l.lane.caps, rate: run.rateCard,
    outcome: r.outcome, ...(r.tripReason ? { tripReason: r.tripReason } : {}), hasArtifact: l.hasArtifact,
  });
}

function metadataFor(run: Run, lane: Lane, receiptSha256: string): Record<string, string> {
  const m = lane.meter;
  const cases = lane.check?.cases ?? [];
  return {
    app: "holdout", run_id: run.runId, lane_id: lane.laneId, job_id: lane.jobId, mode: run.mode,
    rate_card: run.rateCard.version, on_trip: run.onTrip, contractor: lane.contractor,
    metered_micros: String(Math.round(m.costMicros)), vm_seconds: m.vmSeconds.toFixed(1),
    tokens_in: String(m.tokensIn), tokens_out: String(m.tokensOut), turns: String(m.turns),
    trip_reason: lane.trip?.reason ?? "none",
    sandbox_id: lane.seal?.sandboxId ?? "none",
    egress: (lane.seal?.egressReadback ?? []).join(" ") || "none",
    probe_exits: (lane.seal?.probes ?? []).map((p) => `${p.label}:${p.exit}`).join(" ") || "none",
    check: lane.check ? `${cases.filter((c) => c.pass).length}/${cases.length} ${lane.check.pass ? "pass" : "fail"}` : "none",
    receipt_sha256: receiptSha256,
  };
}

async function settleLane(ctx: RunCtx, l: LaneCtx, d: SettleDecision): Promise<void> {
  const { run, deps } = ctx;
  const lane = l.lane;
  const pi = lane.pi;
  if (!pi) {
    setState(ctx, l, "failed");   // no hold was ever authorized: nothing to settle
    return;
  }
  setState(ctx, l, "settling");
  if (l.fuse) lane.meter = l.fuse.meter();
  const { canonical, sha256 } = sealReceipt({ run, lane, decision: d, ts: new Date(ctx.now()).toISOString() });
  ctx.bus.setReceipt(run.runId, lane.laneId, canonical);
  const md = metadataFor(run, lane, sha256);
  const hold = lane.caps.holdCents;
  try {
    deps.checkMetadata(md);
    if (d.action === "capture") {
      await deps.pay.capture(keyOf(ctx, l), pi.id, d.cents, md);
      const got = await deps.pay.retrieve(pi.id);
      lane.pi = { ...pi, status: got.status, amountReceived: got.amountReceived };
      lane.settlement = {
        action: "capture", capturedCents: got.amountReceived, releasedCents: hold - got.amountReceived,
        reason: d.reason, piStatus: got.status, receiptSha256: sha256,
      };
      ctx.emit("settle.captured", lane.laneId, {
        piId: pi.id, capturedCents: got.amountReceived, releasedCents: hold - got.amountReceived, status: got.status,
        receiptSha256: sha256,
      });
    } else if (d.action === "cancel") {
      await deps.pay.release(keyOf(ctx, l), pi.id, md);
      const got = await deps.pay.retrieve(pi.id);
      lane.pi = { ...pi, status: got.status, amountReceived: got.amountReceived };
      lane.settlement = { action: "cancel", capturedCents: 0, releasedCents: hold, reason: d.reason, piStatus: got.status, receiptSha256: sha256 };
      ctx.emit("settle.canceled", lane.laneId, { piId: pi.id, reason: d.reason, status: got.status, receiptSha256: sha256 });
    } else {
      const got = await deps.pay.retrieve(pi.id);
      lane.pi = { ...pi, status: got.status };
      lane.settlement = { action: "leave", capturedCents: 0, releasedCents: 0, reason: d.reason, piStatus: got.status, receiptSha256: sha256 };
      ctx.emit("settle.left", lane.laneId, { piId: pi.id, reason: d.reason });
    }
    setState(ctx, l, "settled");
  } catch (e) {
    // stripe.ts already retried with the same idempotency key: show "settlement pending" and leave the hold.
    laneError(ctx, l, "settle", e);
    lane.settlement = { action: "leave", capturedCents: 0, releasedCents: 0, reason: d.reason, piStatus: pi.status, receiptSha256: sha256 };
    ctx.emit("settle.left", lane.laneId, { piId: pi.id, reason: "settlement pending" });
    setState(ctx, l, "failed");
  }
}

// ── The real wiring (server.ts imports startRun and tripRun) ────────────────────
let real: Runner | undefined;
async function realRunner(): Promise<Runner> {
  if (real) return real;
  const [vm, stripe, agent, meter, fuse, settle, jobs, honest, runaway, busy] = await Promise.all([
    import("./vm.js"), import("./stripe.js"), import("./agent.js"), import("./meter.js"), import("./fuse.js"),
    import("./settle.js"), import("./jobs.js"), import("./contractors/honest.js"), import("./contractors/runaway.js"),
    import("./contractors/busyloop.js"),
  ]);
  real = createRunner({
    vmApi: vm.createVm(), pay: stripe.createPay(), runAgent: agent.runAgent,
    createFuse: fuse.createFuse, settle: settle.settle, notRun: settle.NOT_RUN, rateCards: meter.RATE_CARDS,
    loadJob: jobs.loadJob, jobFiles: jobs.jobFiles, hostCheck: jobs.hostCheck,
    honestOptions: honest.honestOptions, runawayOptions: runaway.runawayOptions, startBusyloop: busy.startBusyloop,
    checkMetadata: stripe.checkMetadata,
    cfg: {
      vmMode: cfg.vmMode, devVmId: cfg.devVmId, concurrency: cfg.concurrency, onTrip: cfg.onTrip,
      rateCard: cfg.rateCard, model: cfg.model, notary: cfg.notary,
    },
  });
  return real;
}
// Wired at import time, so startRun stays synchronous (the server imports this module dynamically).
// createPay() throws without a test key: that error is kept and returned by every startRun, never swallowed.
let wiringError: string | undefined;
realRunner().catch((e) => {
  wiringError = msg(e);
  console.error(`run.ts: wiring failed: ${wiringError}`);
});

export function startRun(req: RunRequest, bus: RunBus): { runId: string } {
  if (wiringError) throw new Error(`run.ts could not wire its modules: ${wiringError}`);
  if (!real) throw new Error("run.ts is still loading its modules; retry in a second");
  return real.startRun(req, bus);
}
export function tripRun(runId: string): boolean {
  return tripActive(runId);
}
