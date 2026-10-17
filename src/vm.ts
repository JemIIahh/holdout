// src/vm.ts: the ONLY importer of the CreateOS sandbox SDK in Holdout (DESIGN section 8; contract in src/contracts.ts).
// Settings come from src/config.ts through `cfg`; tests inject a fake SDK, a temp ledger and config overrides via VmDeps.
// Run data (gitignored): data/creates.json (create ledger), data/devvm.json (dev VM #1).
import { randomInt } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import {
  Sandbox,
  createClient,
  CreateosSandboxApiError,
  CreateosSandboxConnectionError,
  CreateosSandboxNotFoundError,
  CreateosSandboxPaymentRequiredError,
  CreateosSandboxServerError,
  CreateosSandboxTimeoutError,
  CreateosSandboxValidationError,
} from "@nodeops-createos/sandbox";
import { cfg } from "./config.js";
import type { ExecResult, LaneId, Probe, SealProof, Vm, VmHandle } from "./contracts.js";

// ── What this module needs from the SDK (a structural subset; the real classes satisfy it) ──────────
export interface ExecOut { result: { stdout: string; stderr: string; exit_code: number; error?: string }; exec_ms: number }
export interface ProcInfo { process_id: string; cwd?: string; state?: string; tree_exited?: boolean; exit_code?: number | null }
export interface SandboxLike {
  readonly id: string;
  readonly name?: string;
  readonly status: string;
  readonly data: { created_at?: string };
  refresh(): Promise<unknown>;
  runCommand(cmd: string, args?: string[], o?: { timeoutMs?: number; stdin?: string; signal?: AbortSignal }): Promise<ExecOut>;
  getEgress(): Promise<{ egress: string[] }>;
  setEgress(rules: string[] | null): Promise<{ egress: string[] }>;
  destroy(): Promise<{ status: string }>;
  waitUntilRunning(o?: { timeoutMs?: number }): Promise<unknown>;
  waitUntilDestroyed(o?: { timeoutMs?: number }): Promise<unknown>;
  files: { upload(path: string, data: string | Uint8Array): Promise<void>; download(path: string): Promise<ArrayBuffer> };
  processes: {
    create(r: { cmd: string; args?: string[]; cwd?: string }): Promise<{ process_id: string }>;
    list(): Promise<{ processes: ProcInfo[] }>;
    wait(id: string, o: { scope?: "leader" | "tree"; waitTimeoutMs?: number; timeoutMs?: number; retry?: false }): Promise<{ tree_exited: boolean; exit_code?: number | null }>;
    delete(id: string, o?: { graceMs?: number }): Promise<unknown>;
  };
}
export interface ClientLike {
  listSandboxes(): Promise<SandboxLike[]>;
  whoami(): Promise<{ stats: { running: number } }>;
}
export interface SdkOpts { apiKey: string; baseUrl: string; timeoutMs?: number }
export interface CreateReq { shape: string; rootfs: string; name: string; egress: string[] }
export interface SdkLike {
  Sandbox: {
    create(req: CreateReq, o: SdkOpts): Promise<SandboxLike>;
    connect(id: string, o: SdkOpts): Promise<SandboxLike>;
  };
  createClient(o: SdkOpts): ClientLike;
}
const realSdk = { Sandbox, createClient } as unknown as SdkLike;

// The SDK's error classes, re-exported so that no other file imports the SDK package (tests build fakes with them).
export {
  CreateosSandboxApiError, CreateosSandboxConnectionError, CreateosSandboxNotFoundError,
  CreateosSandboxPaymentRequiredError, CreateosSandboxServerError, CreateosSandboxTimeoutError, CreateosSandboxValidationError,
};

// ── Config and dependency injection ─────────────────────────────────────
export interface VmConfig {
  createosKey: string; createosBase: string; sealRule: string; vmMode: "fresh" | "reuse";
  devVmId: string; createCap: number; forceCreate: boolean;
}
export interface VmDeps {
  sdk?: SdkLike;                       // tests inject a fake
  ledgerPath?: string;                 // default data/creates.json under the working directory
  now?: () => number;                  // epoch ms
  cfg?: Partial<VmConfig>;             // additive (tests): overrides the values read from src/config.ts
  devVmPath?: string;                  // additive (tests): default data/devvm.json under the working directory
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

export const SHAPE = "s-1vcpu-1gb";
export const ROOTFS = "devbox:1";
export const DAY_MS = 24 * 3600 * 1000;

// DESIGN 8.2, verbatim. Every *_exit must be non-zero; never predict which non-zero code.
export const PROBE =
  "curl -sS -m 5 -o /dev/null https://example.com; echo https_exit=$?; " +
  "curl -sS -m 3 -o /dev/null http://1.1.1.1; echo raw_ip_exit=$?; " +
  "getent hosts example.com >/dev/null; echo dns_exit=$?";

export class SealError extends Error {
  readonly proof: Partial<SealProof>;
  constructor(message: string, proof: Partial<SealProof> = {}) {
    super(message);
    this.name = "SealError";
    this.proof = proof;
  }
}
export class CreateCapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreateCapError";
  }
}

/** Lower-case, trim; a bare IPv4 address is the same rule as that address with /32. */
export function normalizeRule(rule: string): string {
  const r = String(rule ?? "").trim().toLowerCase();
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(r) ? `${r}/32` : r;
}

/** A missing or unreadable *_exit line counts as exit 0, so the box looks open (fail closed). */
export function parseProbe(stdout: string): Probe[] {
  const labels = ["https", "raw_ip", "dns"] as const;
  return labels.map((label) => {
    const m = new RegExp(`^${label}_exit=(\\d+)\\s*$`, "m").exec(String(stdout ?? ""));
    return { label, exit: m ? Number(m[1]) : 0 };
  });
}
export const allClosed = (p: Probe[]): boolean => p.length === 3 && p.every((q) => q.exit !== 0);

// ── Names and the create ledger (data/creates.json: a JSON array, temp file then rename) ───────────
export function rand4(): string {
  let s = "";
  for (let i = 0; i < 4; i++) s += randomInt(36).toString(36);
  return s;
}
export const devVmName = (): string => `hd-dev1-${rand4()}`;
const retryName = (name: string): string => `${name.replace(/-[a-z0-9]{4}$/, "")}-${rand4()}`;
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);

export interface LedgerEntry { t: number; name: string; ok: boolean; sandboxId?: string; adopted?: boolean }
const isEntry = (e: unknown): e is LedgerEntry =>
  !!e && typeof e === "object" && typeof (e as LedgerEntry).t === "number" && typeof (e as LedgerEntry).name === "string";

export function readLedger(path: string): LedgerEntry[] {
  try {
    const j: unknown = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(j) ? j.filter(isEntry) : [];
  } catch {
    return [];
  }
}
export function appendLedger(path: string, entry: LedgerEntry): void {
  let all: LedgerEntry[] = [];
  try {
    const j: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (Array.isArray(j)) all = j.filter(isEntry);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      try { renameSync(path, `${path}.bad-${Date.now()}`); } catch { /* keep going with a fresh file */ }
    }
  }
  all.push(entry);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n");
  renameSync(tmp, path);
}

// ── Context shared by every function below ──────────────────────────────
export interface Ctx {
  sdk: SdkLike; c: VmConfig; now: () => number; sleep: (ms: number) => Promise<void>; log: (m: string) => void;
  ledgerPath: string; devVmPath: string; opts(timeoutMs?: number): SdkOpts;
  // Every SDK entry point goes through these four: each returns guarded handles and cannot hang (see withDeadline).
  create(req: CreateReq): Promise<SandboxLike>;
  connect(id: string): Promise<SandboxLike>;
  list(): Promise<SandboxLike[]>;
  whoami(): Promise<{ stats: { running: number } }>;
}
export function makeCtx(deps: VmDeps = {}): Ctx {
  const c: VmConfig = {
    createosKey: cfg.createosKey, createosBase: cfg.createosBase, sealRule: cfg.sealRule, vmMode: cfg.vmMode,
    devVmId: cfg.devVmId, createCap: cfg.createCap, forceCreate: cfg.forceCreate, ...deps.cfg,
  };
  const sdk = deps.sdk ?? realSdk;
  const opts = (timeoutMs?: number): SdkOpts => {
    if (!deps.sdk && !c.createosKey) throw new Error("CREATEOS_SANDBOX_API_KEY is not set");
    return { apiKey: c.createosKey, baseUrl: c.createosBase, ...(timeoutMs ? { timeoutMs } : {}) };
  };
  let client: ClientLike | undefined;
  const cl = (): ClientLike => (client ??= sdk.createClient(opts(60_000)));
  return {
    sdk, c, opts,
    now: deps.now ?? Date.now,
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    log: deps.log ?? ((m) => console.warn(`[vm] ${m}`)),
    ledgerPath: deps.ledgerPath ?? resolve(process.cwd(), "data/creates.json"),
    devVmPath: deps.devVmPath ?? resolve(process.cwd(), "data/devvm.json"),
    create: async (req) => guard(await withDeadline(sdk.Sandbox.create(req, opts(60_000)), 60_000, "create")),
    connect: async (id) => guard(await withDeadline(sdk.Sandbox.connect(id, opts(30_000)), 30_000, "connect")),
    list: async () => (await withDeadline(cl().listSandboxes(), 30_000, "listSandboxes")).map((b) => guard(b)),
    whoami: () => withDeadline(cl().whoami(), 30_000, "whoami"),
  };
}

/** The seal rule, refusing anything that would mean allow-all. */
export function sealOf(x: Ctx): string {
  const s = String(x.c.sealRule ?? "").trim();
  if (!s || s === "*") throw new Error("SEAL_RULE is empty: refusing to use a rule that allows all egress");
  return s;
}

/** Dev VM #1 is never destroyed by destroy/reset/connect: DEV_VM_ID, or the id in data/devvm.json while its destroy is null. */
export function isDevVm(x: Ctx, id: string): boolean {
  if (x.c.devVmId && id === x.c.devVmId) return true;
  try {
    const j = JSON.parse(readFileSync(x.devVmPath, "utf8")) as { id?: string; destroy?: unknown };
    return j.id === id && (j.destroy === null || j.destroy === undefined);
  } catch {
    return false;
  }
}

// ── Deadlines. SDK 0.8.2 sends non-streaming requests through its own node:http2 helper (h2Fetch), which ignores both
// timeoutMs and AbortSignal (verified live: `sleep 5` with timeoutMs 2000 returned after 5 s, exit 0, and so did an
// AbortSignal.timeout). A silent control plane would hang a caller forever, so every SDK promise is raced against a deadline
// here. The loser keeps running (a command keeps running in the VM) and its rejection is swallowed.
export function withDeadline<T>(p: Promise<T>, ms: number, what: string, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new CreateosSandboxTimeoutError(`${what} exceeded ${ms}ms`));
    }, ms);
  });
  p.catch(() => undefined);
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

/** A handle whose every call is bounded. runCommand takes its deadline from timeoutMs (default 60 s). */
export function guard(sb: SandboxLike, defaultMs = 30_000): SandboxLike {
  if ((sb as { guarded?: boolean }).guarded) return sb;
  const g = <T>(fn: () => Promise<T>, what: string, ms = defaultMs): Promise<T> => withDeadline(fn(), ms, what);
  const w = {
    guarded: true,
    get id() { return sb.id; },
    get name() { return sb.name; },
    get status() { return sb.status; },
    get data() { return sb.data; },
    refresh: () => g(() => sb.refresh(), "refresh"),
    runCommand: async (cmd: string, args?: string[], o?: { timeoutMs?: number; stdin?: string }): Promise<ExecOut> => {
      const ms = o?.timeoutMs ?? 60_000;
      const ac = new AbortController();
      try {
        return await withDeadline(sb.runCommand(cmd, args, { ...o, timeoutMs: ms, signal: ac.signal }), ms, "command", () => ac.abort());
      } catch (e) {
        if (ac.signal.aborted && !(e instanceof CreateosSandboxTimeoutError)) {
          throw new CreateosSandboxTimeoutError(`command exceeded ${ms}ms`, { cause: e });
        }
        throw e;
      }
    },
    getEgress: () => g(() => sb.getEgress(), "getEgress"),
    setEgress: (rules: string[] | null) => g(() => sb.setEgress(rules), "setEgress"),
    destroy: () => g(() => sb.destroy(), "destroy"),
    waitUntilRunning: (o?: { timeoutMs?: number }) => g(() => sb.waitUntilRunning(o), "waitUntilRunning", (o?.timeoutMs ?? 120_000) + 10_000),
    waitUntilDestroyed: (o?: { timeoutMs?: number }) => g(() => sb.waitUntilDestroyed(o), "waitUntilDestroyed", (o?.timeoutMs ?? 120_000) + 10_000),
    files: {
      upload: (path: string, data: string | Uint8Array) => g(() => sb.files.upload(path, data), "upload", 120_000),
      download: (path: string) => g(() => sb.files.download(path), "download", 120_000),
    },
    processes: {
      create: (r: { cmd: string; args?: string[]; cwd?: string }) => g(() => sb.processes.create(r), "processes.create"),
      list: () => g(() => sb.processes.list(), "processes.list"),
      wait: (id: string, o: { scope?: "leader" | "tree"; waitTimeoutMs?: number; timeoutMs?: number; retry?: false }) =>
        g(() => sb.processes.wait(id, o), "processes.wait", (o.timeoutMs ?? 60_000) + 5_000),
      delete: (id: string, o?: { graceMs?: number }) => g(() => sb.processes.delete(id, o), "processes.delete"),
    },
  };
  return w as unknown as SandboxLike;
}
/** processes.wait answers HTTP 408 wait_timeout when the tree is still alive at the end of the long-poll. */
const isWaitTimeout = (e: unknown): boolean =>
  e instanceof CreateosSandboxApiError && (e.statusCode === 408 || /wait_timeout/.test(e.message));

// ── Create with 502 and timeout handling (DESIGN 8.3) ───────────────────
export interface BoxResult { sb: SandboxLike; name: string; createMs: number; adopted: boolean; attempts: number }

/** 502, 500, 504, a client timeout or a dead socket: the box may exist, so look it up by name before anything else. */
function isAmbiguous(e: unknown): boolean {
  if (e instanceof CreateosSandboxTimeoutError || e instanceof CreateosSandboxConnectionError) return true;
  return e instanceof CreateosSandboxServerError && [500, 502, 504].includes(e.statusCode);
}
/** 409 on create: every name is fresh, so a name conflict means an earlier (silently re-sent) attempt of ours already created the box. */
const isNameConflict = (e: unknown): boolean => e instanceof CreateosSandboxValidationError && e.statusCode === 409;
async function findByName(x: Ctx, name: string): Promise<SandboxLike | undefined> {
  const all = await x.list();
  return all.filter((b) => b.name === name && (b.status === "running" || b.status === "creating")).at(-1);
}

/** SDK create (sealed at create, nothing else set), 502 adoption and the ledger. No cap check and no seal proof here. */
export async function createBox(name: string, deps: VmDeps = {}): Promise<BoxResult> {
  return createBoxCtx(makeCtx(deps), name);
}
export async function createBoxCtx(x: Ctx, firstName: string): Promise<BoxResult> {
  const seal = sealOf(x);
  const t0 = x.now();
  let name = firstName;
  for (let attempt = 1; ; attempt++) {
    let sb: SandboxLike;
    try {
      sb = await x.create({ shape: SHAPE, rootfs: ROOTFS, name, egress: [seal] });
    } catch (e) {
      const conflict = isNameConflict(e);
      if (!isAmbiguous(e) && !conflict) {   // 4xx, 402, 429 after the SDK's own retries: ledger it and stop, never retry
        appendLedger(x.ledgerPath, { t: x.now(), name, ok: false });
        throw e;
      }
      let found: SandboxLike | undefined;
      try {
        found = await findByName(x, name);
        if (found && found.status === "creating") await found.waitUntilRunning({ timeoutMs: 60_000 });
      } catch (le) {
        appendLedger(x.ledgerPath, { t: x.now(), name, ok: false, ...(found ? { sandboxId: found.id } : {}) });
        throw new Error(`create ${name} failed (${errMsg(e)}) and the lookup by name failed (${errMsg(le)})`, { cause: le });
      }
      if (found && found.status === "running") {
        x.log(`adopted ${found.id} (${name}) after: ${errMsg(e)}`);
        appendLedger(x.ledgerPath, { t: x.now(), name, ok: true, sandboxId: found.id, adopted: true });
        return { sb: found, name, createMs: x.now() - t0, adopted: true, attempts: attempt };
      }
      appendLedger(x.ledgerPath, { t: x.now(), name, ok: false, ...(found ? { sandboxId: found.id } : {}) });
      if (conflict || attempt >= 2) throw e;   // one retry with a new name, never more (and none after a conflict)
      name = retryName(name);
      continue;
    }
    appendLedger(x.ledgerPath, { t: x.now(), name, ok: true, sandboxId: sb.id });
    return { sb, name, createMs: x.now() - t0, adopted: false, attempts: attempt };
  }
}

// ── Seal proof: readback, then PROBE as the first command in the VM (DESIGN 8.2 decision table) ────
export interface Obs { readback: string[]; readbackOk: boolean; probes: Probe[]; probeStdout: string; probeMs: number; note?: string }
export interface SealCheck {
  sealed: boolean; readback: string[]; readbackOk: boolean; probes: Probe[]; resealed: boolean;
  first: Obs;            // what the very first readback and probe saw, before any setEgress
  attempts: number;      // 1 = sealed as found; 2 = the seal was re-applied
  notes: string[];
}

async function observe(x: Ctx, sb: SandboxLike): Promise<Obs> {
  const seal = sealOf(x);
  const notes: string[] = [];
  let readback: string[] = [];
  try {
    const v = await sb.getEgress();
    readback = Array.isArray(v?.egress) ? v.egress.map(String) : [];
  } catch (e) {
    notes.push(`getEgress failed: ${errMsg(e)}`);
  }
  const readbackOk = readback.length === 1 && normalizeRule(readback[0]!) === normalizeRule(seal);
  const t = x.now();
  let probeStdout = "";
  try {
    const { result } = await sb.runCommand("bash", ["-c", PROBE], { timeoutMs: 20_000 });
    probeStdout = result.stdout ?? "";
  } catch (e) {
    notes.push(`probe failed: ${errMsg(e)}`);
  }
  return {
    readback, readbackOk, probes: parseProbe(probeStdout), probeStdout, probeMs: x.now() - t,
    ...(notes.length ? { note: notes.join("; ") } : {}),
  };
}

export async function proveSeal(sb: SandboxLike, deps: VmDeps = {}): Promise<SealCheck> {
  return proveSealCtx(makeCtx(deps), guard(sb));
}
export async function proveSealCtx(x: Ctx, sb: SandboxLike): Promise<SealCheck> {
  const seal = sealOf(x);
  const first = await observe(x, sb);
  const notes: string[] = first.note ? [first.note] : [];
  if (first.readbackOk && allClosed(first.probes)) {
    return { sealed: true, readback: first.readback, readbackOk: true, probes: first.probes, resealed: false, first, attempts: 1, notes };
  }
  // Readback wrong, or a probe exited 0 (open at the first command): re-apply the seal, give it 1 s, observe again.
  // Never destroy here: that would waste a create. The caller destroys only if this second look still fails.
  try {
    await sb.setEgress([seal]);
  } catch (e) {
    notes.push(`setEgress failed: ${errMsg(e)}`);
  }
  await x.sleep(1000);
  const second = await observe(x, sb);
  if (second.note) notes.push(second.note);
  const sealed = second.readbackOk && allClosed(second.probes);
  return { sealed, readback: second.readback, readbackOk: second.readbackOk, probes: second.probes, resealed: sealed, first, attempts: 2, notes };
}

// ── Create counter (DESIGN 8.7): max(list, ledger), never whoami().stats.total ───────────────────────
export interface CreateCount { used24h: number; cap: number; listCount: number; ledgerCount: number }
export async function countCreates(x: Ctx): Promise<CreateCount> {
  const cutoff = x.now() - DAY_MS;
  const boxes = await x.list();   // no status filter: destroyed boxes still count
  const listCount = boxes.filter((b) => {
    const t = Date.parse(b.data?.created_at ?? "");
    return !Number.isFinite(t) || t >= cutoff;       // an unreadable date counts (cannot prove it is old)
  }).length;
  const ledgerCount = readLedger(x.ledgerPath).filter((e) => e.t >= cutoff).length;
  return { used24h: Math.max(listCount, ledgerCount), cap: x.c.createCap, listCount, ledgerCount };
}

// ── /work reset: managed processes whose cwd is /work or below, then the directory (never /ndev) ───────
const underWork = (cwd?: string): boolean => {
  if (!cwd) return false;
  const c = posix.normalize(cwd);
  return c === "/work" || c.startsWith("/work/");
};
export async function clearWork(sb: SandboxLike): Promise<{ killed: string[] }> {
  const killed: string[] = [];
  const { processes } = await sb.processes.list();
  for (const p of processes ?? []) {
    if (!underWork(p.cwd) || p.tree_exited === true) continue;
    try {
      await sb.processes.delete(p.process_id, { graceMs: 200 });
      killed.push(p.process_id);
    } catch (e) {
      if (!(e instanceof CreateosSandboxNotFoundError)) throw e;
    }
  }
  const { result } = await sb.runCommand("bash", ["-c", "rm -rf /work && mkdir -p /work"], { timeoutMs: 30_000 });
  if (result.exit_code !== 0 || result.error) {
    throw new Error(`/work reset failed: exit ${result.exit_code} ${result.error ?? result.stderr}`.slice(0, 300));
  }
  return { killed };
}

// ── The Vm implementation ───────────────────────────────────────────────
export interface VmExt extends Vm {
  /** SDK handle for an existing box: no reset, no probe, zero creates (smoke-vm --check). */
  attach(id: string): Promise<VmHandle>;
  /** Readback plus PROBE with the decision table. Never destroys, never touches /work. */
  reprobe(vm: VmHandle): Promise<SealCheck>;
}
interface St {
  sb: SandboxLike; name: string; dirs: Set<string>; createMs: number; reused: boolean;
  destroyStartedAt?: number; destroyP?: Promise<string>;
}
const createdAtOf = (sb: SandboxLike, fallback: number): number => {
  const t = Date.parse(sb.data?.created_at ?? "");
  return Number.isFinite(t) ? t : fallback;
};

export function createVm(deps: VmDeps = {}): VmExt {
  const x = makeCtx(deps);
  const states = new Map<string, St>();

  const register = (sb: SandboxLike, name: string, createMs: number, reused: boolean, createdAt: number): VmHandle => {
    states.set(sb.id, { sb, name, dirs: new Set(), createMs, reused });
    return { id: sb.id, name, createdAt };
  };
  const stOf = async (vm: VmHandle): Promise<St> => {
    let s = states.get(vm.id);
    if (!s) {
      s = { sb: await x.connect(vm.id), name: vm.name, dirs: new Set(), createMs: 0, reused: false };
      states.set(vm.id, s);
    }
    return s;
  };
  /** Sends the DELETE now and remembers the start time; never throws. */
  const startDestroy = (s: St): Promise<string> => {
    if (!s.destroyP) {
      s.destroyStartedAt = x.now();
      s.destroyP = (async () => (await s.sb.destroy()).status)().catch((e) => `error: ${errMsg(e)}`);
    }
    return s.destroyP;
  };
  const proofOf = (s: St, chk: SealCheck, reused: boolean): SealProof => ({
    sandboxId: s.sb.id, name: s.name, createMs: s.createMs, egressRequested: [sealOf(x)],
    egressReadback: chk.readback, readbackOk: chk.readbackOk, probes: chk.probes, resealed: chk.resealed, reused,
  });
  const brief = (chk: SealCheck): string =>
    `readbackOk=${chk.readbackOk} readback=${JSON.stringify(chk.readback)} probes=${chk.probes.map((p) => `${p.label}:${p.exit}`).join(",")}`;

  /** connect and reset: stop managed processes under /work, wipe /work, then a fresh seal proof (same decision table). */
  const wipeAndProve = async (vm: VmHandle, s: St, reused: boolean, mayDestroy: boolean): Promise<SealProof> => {
    await clearWork(s.sb);
    s.dirs.clear();
    const chk = await proveSealCtx(x, s.sb);
    const proof = proofOf(s, chk, reused);
    if (!chk.sealed) {
      if (mayDestroy) await startDestroy(s);   // fail closed; the dev VM is left for Main
      throw new SealError(`seal not proven after /work reset of ${vm.id}: ${brief(chk)}`, proof);
    }
    return proof;
  };

  return {
    async createSealed(name) {
      const n = await countCreates(x);
      if (n.used24h >= n.cap && !x.c.forceCreate) throw new CreateCapError(`create ledger at ${n.used24h}/${n.cap}; nothing created`);
      const box = await createBoxCtx(x, name);
      const vm = register(box.sb, box.name, box.createMs, false, createdAtOf(box.sb, x.now()));
      const s = states.get(vm.id)!;
      let chk: SealCheck;
      try {
        chk = await proveSealCtx(x, box.sb);
      } catch (e) {
        await startDestroy(s);
        throw new SealError(`seal proof crashed for ${vm.id}: ${errMsg(e)}`, {
          sandboxId: vm.id, name: box.name, createMs: box.createMs, egressRequested: [sealOf(x)],
        });
      }
      const proof = proofOf(s, chk, false);
      if (!chk.sealed) {
        await startDestroy(s);   // fail closed: no agent byte ever reaches an unproven box
        throw new SealError(`seal not proven for ${vm.id}: ${brief(chk)}`, proof);
      }
      return { vm, seal: proof };
    },

    async connect(id) {
      const sb = await x.connect(id);
      if (sb.status !== "running") throw new Error(`cannot connect: ${id} is ${sb.status}`);
      const vm = register(sb, sb.name ?? "", 0, true, createdAtOf(sb, x.now()));
      return { vm, seal: await wipeAndProve(vm, states.get(id)!, true, false) };
    },

    async reset(vm, _nextLane: LaneId) {
      const s = await stOf(vm);
      const dev = isDevVm(x, vm.id);
      return wipeAndProve(vm, s, s.reused || dev, !dev);
    },

    async exec(vm, bash, o): Promise<ExecResult> {
      const s = await stOf(vm);
      const t = x.now();
      try {
        const { result, exec_ms } = await s.sb.runCommand("bash", ["-c", bash], {
          timeoutMs: (o?.timeoutSec ?? 60) * 1000,
          stdin: o?.stdin ?? "",
        });
        const ms = typeof exec_ms === "number" ? exec_ms : x.now() - t;
        if (result.error) return { exit: 127, stdout: result.stdout ?? "", stderr: result.error, ms, timedOut: false };
        return { exit: result.exit_code, stdout: result.stdout ?? "", stderr: result.stderr ?? "", ms, timedOut: false };
      } catch (e) {
        if (e instanceof CreateosSandboxTimeoutError) {
          return { exit: 124, stdout: "", stderr: "command timed out", ms: x.now() - t, timedOut: true };
        }
        throw e;
      }
    },

    async upload(vm, absPath, data) {
      if (!absPath.startsWith("/")) throw new Error(`upload: ${absPath} is not an absolute path`);
      const s = await stOf(vm);
      const dir = posix.dirname(absPath);
      const mk = async (): Promise<void> => {
        await s.sb.runCommand("mkdir", ["-p", dir], { timeoutMs: 20_000 });
        s.dirs.add(dir);
      };
      if (!s.dirs.has(dir)) await mk();
      try {
        await s.sb.files.upload(absPath, data);
      } catch (e) {
        if (e instanceof CreateosSandboxTimeoutError || e instanceof CreateosSandboxConnectionError) throw e;
        await mk();   // the directory may have been removed since it was cached: recreate it and try once more
        await s.sb.files.upload(absPath, data);
      }
    },

    async download(vm, absPath) {
      const s = await stOf(vm);
      try {
        return new Uint8Array(await s.sb.files.download(absPath));
      } catch (e) {
        if (e instanceof CreateosSandboxNotFoundError) return null;
        throw e;
      }
    },

    async spawn(vm, bash, cwd) {
      const s = await stOf(vm);
      const p = await s.sb.processes.create({ cmd: "bash", args: ["-c", bash], ...(cwd ? { cwd } : {}) });
      return p.process_id;
    },

    async waitProcess(vm, processId, waitMs) {
      const s = await stOf(vm);
      const deadline = x.now() + waitMs;
      for (;;) {
        const t = x.now();
        const remaining = Math.max(1, deadline - t);
        // The control plane caps waitTimeoutMs, so one call may return early; when the tree is still alive at the end of a
        // long-poll it answers HTTP 408 wait_timeout (verified live). retry:false keeps the SDK from re-sending that GET.
        let p: { tree_exited: boolean; exit_code?: number | null } | undefined;
        try {
          p = await s.sb.processes.wait(processId, { scope: "tree", waitTimeoutMs: remaining, timeoutMs: remaining + 10_000, retry: false });
        } catch (e) {
          if (!isWaitTimeout(e)) throw e;
        }
        if (p?.tree_exited) return { exited: true, ...(p.exit_code != null ? { exit: p.exit_code } : {}) };
        if (x.now() >= deadline) return { exited: false };
        if (x.now() - t < 100) await x.sleep(100);   // an instant answer must not become a hot loop
      }
    },

    async killProcess(vm, processId) {
      const s = await stOf(vm);
      try {
        await s.sb.processes.delete(processId, { graceMs: 200 });
      } catch (e) {
        if (!(e instanceof CreateosSandboxNotFoundError)) throw e;   // already gone is fine
      }
    },

    async destroy(vm) {
      try {
        if (isDevVm(x, vm.id) || states.get(vm.id)?.reused) {   // a box we only connect()ed to is the reused dev VM
          x.log(`refusing to destroy dev VM ${vm.id}: reuse mode kills processes, only destroyExact destroys it`);
          return;
        }
        void startDestroy(await stOf(vm));   // fire and forget
      } catch (e) {
        x.log(`destroy ${vm.id} failed to start: ${errMsg(e)}`);
      }
    },

    async waitDestroyed(vm, timeoutMs = 120_000) {
      const s = states.get(vm.id);
      if (!s || s.destroyStartedAt === undefined || !s.destroyP) return { ok: false, ms: 0 };   // no destroy was issued here
      const started = s.destroyStartedAt;
      try {
        const status = await s.destroyP;
        if (status.startsWith("error:")) return { ok: false, ms: x.now() - started };
        await s.sb.waitUntilDestroyed({ timeoutMs });
        return { ok: true, ms: x.now() - started };
      } catch {
        return { ok: false, ms: x.now() - started };
      }
    },

    async state(vm) {
      try {
        const s = await stOf(vm);
        await s.sb.refresh();
        return s.sb.status;
      } catch (e) {
        if (e instanceof CreateosSandboxNotFoundError) return "missing";
        throw e;
      }
    },

    async running() {
      return (await x.whoami()).stats.running;
    },

    async creates() {
      const n = await countCreates(x);
      return { used24h: n.used24h, cap: n.cap };
    },

    async attach(id) {
      const sb = await x.connect(id);
      return register(sb, sb.name ?? "", 0, false, createdAtOf(sb, x.now()));
    },

    async reprobe(vm) {
      return proveSealCtx(x, (await stOf(vm)).sb);
    },
  };
}

// ── Destroy by exact id, and the orphan reaper ──────────────────────────
/** Destroys one box by exact id and waits for `destroyed`; ms runs from the destroy call. Never throws. The only path that destroys dev VM #1. */
export async function destroyExact(id: string, deps: VmDeps = {}): Promise<{ ok: boolean; ms: number; status: string }> {
  const x = makeCtx(deps);
  let t0 = x.now();
  try {
    const sb = await x.connect(id);
    t0 = x.now();
    if (sb.status !== "destroyed") await sb.destroy();
    await sb.waitUntilDestroyed({ timeoutMs: 120_000 });
    return { ok: true, ms: x.now() - t0, status: "destroyed" };
  } catch (e) {
    return { ok: false, ms: x.now() - t0, status: e instanceof CreateosSandboxNotFoundError ? "missing" : `error: ${errMsg(e)}` };
  }
}

export interface ReapRow { id: string; name: string; status: string; ageSec: number; action: "destroyed" | "would-destroy" | "kept" | "failed"; why?: string }

/**
 * Destroys non-destroyed boxes named hx-* or hn-* that are at least minAgeSec old, each by exact id.
 * DEV_VM_ID and hd-* boxes are skipped unless includeDev; keepIds are always skipped. `rows` (additive) lists every live box considered.
 */
export async function reapOrphans(
  o: { minAgeSec: number; keepIds?: string[]; includeDev?: boolean; dryRun?: boolean },
  deps: VmDeps = {},
): Promise<{ destroyed: string[]; kept: string[]; rows: ReapRow[] }> {
  const x = makeCtx(deps);
  const keep = new Set(o.keepIds ?? []);
  const rows: ReapRow[] = [];
  const todo: ReapRow[] = [];
  for (const b of await x.list()) {
    if (b.status === "destroyed") continue;
    const name = b.name ?? "";
    const created = Date.parse(b.data?.created_at ?? "");
    const ageSec = Number.isFinite(created) ? Math.max(0, Math.round((x.now() - created) / 1000)) : 0;
    const row: ReapRow = { id: b.id, name, status: b.status, ageSec, action: "kept" };
    rows.push(row);
    const isDev = /^hd-/.test(name) || (x.c.devVmId !== "" && b.id === x.c.devVmId);
    if (keep.has(b.id)) row.why = "in keepIds";
    else if (isDev && !o.includeDev) row.why = "dev VM (use includeDev)";
    else if (!isDev && !/^h[xn]-/.test(name)) row.why = "not an hx-/hn- box";
    else if (ageSec < o.minAgeSec) row.why = `younger than ${o.minAgeSec}s`;
    else todo.push(row);
  }
  if (o.dryRun) {
    for (const r of todo) r.action = "would-destroy";
  } else {
    await Promise.all(todo.map(async (r) => {
      const d = await destroyExact(r.id, deps);
      r.action = d.ok ? "destroyed" : "failed";
      if (!d.ok) r.why = d.status;
    }));
  }
  return {
    destroyed: rows.filter((r) => r.action === "destroyed").map((r) => r.id),
    kept: rows.filter((r) => r.action !== "destroyed").map((r) => r.id),
    rows,
  };
}
