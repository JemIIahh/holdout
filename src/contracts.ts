// src/contracts.ts: transcribed from DESIGN.md §7 at T+0:05, frozen at T+0:15.
// Only Main edits it afterwards, and only additively.

// ── Kinds ───────────────────────────────────────────────────────────────
export type Mode = "fuse" | "fuse+notary";
export type LaneId = "A" | "B" | "C" | "D";
export type ContractorKind = "honest" | "runaway" | "runaway-busyloop" | "cheater" | "sloppy";
export type Provenance = "live-model" | "live-model+retry-loop" | "scripted-fixture";
export type VmMode = "fresh" | "reuse";      // reuse = dev and calibration only; never exported as a replay
export type OnTrip = "metered" | "nothing";  // fuse mode only (default "metered"); notary mode always cancels a tripped lane
export type JobId = "csv-reconcile" | "csv-reconcile-fast";

// ── Money and metering (integer micro-dollars, µ$) ──────────────────────
export interface RateCard {
  version: string;           // "rc1"; "rc2" after calibration, frozen before the first recording
  vmMicrosPerSec: number;    // 20_000 → $0.02 per sandbox-second (posted demo rate)
  inMicrosPerTok: number;    // 15 → $15 per million input tokens (posted client price, NOT a list price)
  outMicrosPerTok: number;   // 75 → $75 per million output tokens (posted client price, NOT a list price)
  infraMicrosPerSec: number; // 13.3 → CreateOS list price for s-1vcpu-1gb (display only, never billed)
  listInMicrosPerTok: number;  // 4 → Anthropic first-party list price, Opus 5.5 input (display only)
  listOutMicrosPerTok: number; // 20 → Anthropic first-party list price, Opus 5.5 output (display only)
  minChargeCents: number;    // 50 → below this the hold is cancelled, never captured
}
export interface Caps { holdCents: number; timeCapSec: number }   // the cost cap IS the hold

export interface Meter {
  workSec: number;           // since this lane's VM passed its seal proof: the time-cap clock
  vmSeconds: number;         // billed: seal proof → min(submit, trip)
  tokensIn: number; tokensOut: number; turns: number;
  costMicros: number;        // posted rate card × the numbers above
  infraMicros: number;       // CreateOS list price × vmSeconds (display only)
  listTokenMicros: number;   // tokens at Anthropic list price (display only; router price unverified)
  estimatedTokens: boolean;  // true only if the router omitted usage (chars ÷ 4, shown as "est.")
}
export type TripReason = "cost_cap" | "reservation" | "time_cap" | "manual";

export type LaneState =
  | "queued" | "holding" | "held" | "waiting_slot" | "provisioning" | "working"
  | "submitted" | "tripped" | "verifying" | "settling" | "settled" | "failed";

// ── Sandboxes ───────────────────────────────────────────────────────────
export interface Probe { label: "https" | "raw_ip" | "dns"; exit: number }  // every exit must be non-zero
export interface SealProof {
  sandboxId: string; name: string; createMs: number;
  egressRequested: string[];   // always [SEAL_RULE]; never [] or null (both mean allow-all)
  egressReadback: string[];    // recorded verbatim
  readbackOk: boolean;         // exactly one rule that normalizes to SEAL_RULE
  probes: Probe[];             // run as the FIRST command after create (and after every reset)
  resealed: boolean;           // true if the first probe found the box open and setEgress + re-probe fixed it
  reused: boolean;             // true only in VM_MODE=reuse (dev); export-replay refuses these
  sharedFrom?: LaneId;         // Free-serial: this lane runs in that lane's VM after a /work reset and a fresh probe
}
export interface VmHandle { id: string; name: string; createdAt: number }
export interface ExecResult { exit: number; stdout: string; stderr: string; ms: number; timedOut: boolean }

// ── Work, checks, verdicts, settlement ──────────────────────────────────
export interface Submission { selfReport: string; artifactSha256?: string; bytes?: number }
export interface CheckCase { name: string; pass: boolean; rc: number; ms: number }
export interface CheckResult { pass: boolean; cases: CheckCase[]; log: string }  // log ≤ 4 KB; pasted to the model on failure
export interface NsCheck { interfaces: string[]; uid: number; runSelfWritable: boolean; metadataBlocked: boolean }
export interface Verdict {
  visible: { passed: number; total: number };
  passed: number; total: number;          // hidden set
  cells: boolean[];                       // per hidden index; inputs are never shown
  flags: string[];
  notarySandboxId: string; egressReadback: string[]; nsCheck: NsCheck;
  artifactSha256: string; hiddenSetSha256: string; stderrTail?: string;
}
export type SettleReason =
  | "metered" | "capped" | "time_capped" | "pro_rata" | "verdict_fail"
  | "no_artifact" | "no_delivery" | "not_run" | "under_minimum" | "infra_error" | "inconclusive";
export interface Settlement {
  action: "capture" | "cancel" | "leave";
  capturedCents: number; releasedCents: number; reason: SettleReason;
  piStatus: string; receiptSha256: string;
}

// ── Lanes and runs ──────────────────────────────────────────────────────
export interface Lane {
  laneId: LaneId; contractor: ContractorKind; provenance: Provenance; model?: string;
  jobId: JobId; state: LaneState; caps: Caps; meter: Meter;
  pi?: { id: string; amountCents: number; status: string; amountReceived?: number };
  seal?: SealProof;
  trip?: { reason: TripReason; atSec: number; atMicros: number; nextStepMicros?: number; estIn?: number; maxOut?: number };
  check?: CheckResult;                    // last host check
  submission?: Submission; verdict?: Verdict; settlement?: Settlement; error?: string;
}
export interface Run {
  runId: string;  // random (crypto.randomUUID().slice(0, 8)); never a counter; idempotency keys derive from it
  mode: Mode; source: "live" | "replay" | "synthetic";
  label: string;  // "LIVE" | "Recorded run 3 · 15:42 PT · real sandboxes · real test-mode PaymentIntents"
  jobId: JobId; rateCard: RateCard; concurrency: number; vmMode: VmMode; onTrip: OnTrip;
  startedAt: number; lanes: Lane[];
  maxTokens?: number; reserveVmSec?: number;   // 4096 and 10, from config (the dashboard's what-if)
}

// ── Events ──────────────────────────────────────────────────────────────
export type EventType =
  | "run.started" | "run.finished" | "lane.state" | "hold.authorized"
  | "vm.creating" | "vm.created" | "vm.sealed" | "vm.seal_failed" | "vm.reset"
  | "vm.destroying" | "vm.destroyed" | "vm.count"
  | "agent.turn" | "agent.tool" | "agent.submitted" | "check.result"
  | "meter.tick" | "fuse.tripped"
  | "notary.vm" | "notary.case" | "notary.verdict"
  | "settle.captured" | "settle.canceled" | "settle.left" | "error";
export interface FuseTrippedData { reason: TripReason; meter: Meter; nextStepMicros?: number; estIn?: number; maxOut?: number }  // fuse.tripped payload (DESIGN 7.4)
export interface RunEvent<T = unknown> {
  seq: number;     // per run, from 1, no gaps
  t: number;       // ms since run start (server clock); replays schedule by t
  runId: string; laneId?: LaneId; type: EventType; data: T;
}

// ── Jobs ────────────────────────────────────────────────────────────────
export interface Example { name: string; input: string; expected: string }   // visible examples only
export interface JobSpec {
  id: JobId;
  title: string;
  specMd: string;                // uploaded verbatim as /work/SPEC.md
  visible: Example[];            // 3; uploaded as /work/examples/<n>.in and <n>.out
  freshCases: number;            // extra random inputs per host check: 0 (csv-reconcile), 3 (csv-reconcile-fast)
  maxRuntimeMs?: number;         // csv-reconcile-fast only: 0.5 → the host check can never pass
  gen(seed: number): string;     // a random valid input (mulberry32)
  ref(input: string): string;    // reference answer; server only, never shipped to a VM
}
// hostCheck(vmApi: Vm, vm: VmHandle, job: JobSpec, seed: number): Promise<CheckResult>   (src/jobs.ts)

// ── Module interfaces ───────────────────────────────────────────────────
export interface Vm {                     // src/vm.ts: the ONLY importer of the CreateOS SDK or REST API
  createSealed(name: string): Promise<{ vm: VmHandle; seal: SealProof }>;   // throws SealError after destroying
  connect(id: string): Promise<{ vm: VmHandle; seal: SealProof }>;          // VM_MODE=reuse (dev): reset /work, fresh probe
  reset(vm: VmHandle, nextLane: LaneId): Promise<SealProof>;                // Free-serial handoff: rm -rf /work; mkdir; fresh probe
  exec(vm: VmHandle, bash: string, o?: { timeoutSec?: number; stdin?: string }): Promise<ExecResult>;
  upload(vm: VmHandle, absPath: string, data: string | Uint8Array): Promise<void>;  // mkdir -p first
  download(vm: VmHandle, absPath: string): Promise<Uint8Array | null>;             // null if missing
  spawn(vm: VmHandle, bash: string, cwd?: string): Promise<string>;                 // managed process; never exec with &
  waitProcess(vm: VmHandle, processId: string, waitMs: number): Promise<{ exited: boolean; exit?: number }>; // scope "tree"
  killProcess(vm: VmHandle, processId: string): Promise<void>;                      // processes.delete(id, { graceMs: 200 })
  destroy(vm: VmHandle): Promise<void>;                                             // fire and forget; never throws
  waitDestroyed(vm: VmHandle, timeoutMs?: number): Promise<{ ok: boolean; ms: number }>;
  state(vm: VmHandle): Promise<string>;
  running(): Promise<number>;                       // whoami().stats.running (display only)
  creates(): Promise<{ used24h: number; cap: number }>;  // listSandboxes(), all statuses, created_at in the last 24 h
}
export interface Pay {                    // src/stripe.ts
  hold(key: string, cents: number, description: string, md: Record<string, string>): Promise<{ id: string; status: string }>;
  capture(key: string, piId: string, cents: number, md: Record<string, string>): Promise<{ status: string; amountReceived: number }>;
  release(key: string, piId: string, md: Record<string, string>): Promise<{ status: string }>;  // update metadata, then cancel
  retrieve(piId: string): Promise<{ status: string; amount: number; amountReceived: number; metadata: Record<string, string> }>;
}
export interface TurnUsage {
  turn: number; tokensIn: number; tokensOut: number; stopReason: string;
  ms: number; estimated: boolean; model: string;
  estIn?: number;   // estimated input tokens beforeCall reserved for this call (characters / 4)
}
export interface ToolCall { command: string; exit: number; tail: string; ms: number }
export interface AgentHooks {             // src/agent.ts
  onTurn(u: TurnUsage): void;
  onTool(t: ToolCall): void;
  beforeCall(estInputTokens: number, maxOutputTokens: number): boolean;  // false → the fuse refused this call
  signal: AbortSignal;                                                   // aborted by the fuse
}
export interface AgentOptions {
  model: string; fallbackModel: string; system: string; firstMessage: string;
  vm: VmHandle; vmApi: Vm; maxTurns: number; maxTokens: number; softDeadlineSec?: number;
  onSubmit: (summary: string) => Promise<{ accept: boolean; feedback?: string }>;  // host check; a reject pastes its log
}
export interface AgentOutcome {
  outcome: "submitted" | "turn_cap" | "aborted" | "refused" | "error";
  summary?: string; error?: string; model?: string;
}
export type RunAgent = (o: AgentOptions, h: AgentHooks) => Promise<AgentOutcome>;

export interface Fuse {                   // src/fuse.ts (pure meter arithmetic lives in src/meter.ts)
  arm(): void; disarm(): void;
  vmStarted(): void; vmStopped(): void;
  addTokens(inTok: number, outTok: number, estimated?: boolean): void; addTurn(): void;
  reserve(estInTok: number, maxOutTok: number): boolean;  // false → trips with "reservation"
  meter(): Meter; tripped(): TripReason | null; tripNow(r: TripReason): void;
}
export interface FuseOptions {
  caps: Caps; rate: RateCard; reserveVmSec: number; now?: () => number;
  onTrip: (r: TripReason, m: Meter, nextStepMicros?: number, estIn?: number, maxOut?: number) => void;
}
export type CreateFuse = (o: FuseOptions) => Fuse;

export interface SettleInput {
  mode: Mode; onTrip: OnTrip; meter: Meter; caps: Caps; rate: RateCard;
  outcome: "submitted" | "turn_cap" | "tripped" | "infra_error";
  tripReason?: TripReason; hasArtifact: boolean;
  verdict?: { passed: number; total: number } | "inconclusive";
}
export interface SettleDecision { action: "capture" | "cancel" | "leave"; cents: number; reason: SettleReason }
export type Settle = (i: SettleInput) => SettleDecision;   // pure; table-tested

// ── Stage 3 (dynamically imported only when NOTARY=1) ───────────────────
export interface NotaryCase { id: string; input: string }           // inputs only; expected outputs never leave the server
export interface NotaryRaw { [caseId: string]: { out: string; rc: number; errTail: string } }
export interface NotarySubmission { laneId: LaneId; artifact: Uint8Array; selfReport: string }
export interface NotaryResult {
  raw: NotaryRaw; notarySandboxId: string; egressReadback: string[]; nsCheck: NsCheck;
  vanished: boolean; survivors: number;
}
export type Emit = (type: EventType, laneId: LaneId | undefined, data: unknown) => void;
export type Verify = (o: {
  vmApi: Vm; subs: NotarySubmission[]; visible: NotaryCase[]; hidden: NotaryCase[]; emit: Emit;
}) => Promise<Map<LaneId, NotaryResult | "inconclusive">>;   // one fresh sealed notary VM per submission
export type Judge = (raw: NotaryRaw, expected: Map<string, string>, visibleIds: string[], selfReport: string)
  => Pick<Verdict, "visible" | "passed" | "total" | "cells" | "flags" | "stderrTail">;
