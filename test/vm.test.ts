// test/vm.test.ts: src/vm.ts against a fake SDK. Zero network, temp ledger, no real clock waits.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CreateCapError, CreateosSandboxApiError, CreateosSandboxConnectionError, CreateosSandboxNotFoundError, CreateosSandboxPaymentRequiredError,
  CreateosSandboxServerError, CreateosSandboxTimeoutError, CreateosSandboxValidationError, PROBE, SealError,
  createVm, destroyExact, guard, normalizeRule, parseProbe, reapOrphans, readLedger, withDeadline,
  type CreateReq, type ProcInfo, type SandboxLike, type SdkLike, type SdkOpts, type VmDeps,
} from "../src/vm.js";

// ── Fake SDK ────────────────────────────────────────────────────────────
const CLOSED = "https_exit=28\nraw_ip_exit=7\ndns_exit=2\n";
const OPEN = "https_exit=0\nraw_ip_exit=7\ndns_exit=2\n";
const SEAL = "192.0.2.1/32";
const resp = (status: number) => new Response(null, { status });
const e502 = () => new CreateosSandboxServerError("bad gateway", resp(502));
const eTimeout = () => new CreateosSandboxTimeoutError("Request timed out");
const e402 = () => new CreateosSandboxPaymentRequiredError("payment required", resp(402));
const eNotFound = () => new CreateosSandboxNotFoundError("not found", resp(404));
const isProbe = (args: string[]) => args[0] === "-c" && args[1] === PROBE;

interface Clock { t: number }
type RunOut = { stdout?: string; stderr?: string; exit_code?: number; error?: string };

class FakeBox implements SandboxLike {
  status = "running";
  name?: string;
  data: { created_at?: string };
  egress: string[];
  calls: string[] = [];
  runs: Array<{ cmd: string; args: string[]; o?: { timeoutMs?: number; stdin?: string; signal?: AbortSignal } }> = [];
  probeOutputs: string[] = [];
  probeError?: Error;
  hang = false;                        // runCommand never settles: the SDK's HTTP/2 path ignores timeoutMs and AbortSignal
  uploadFailures: Error[] = [];
  egressReads: string[][] = [];       // queued readbacks; empty queue = the stored egress
  ignoreSetEgress = false;
  runHandler?: (cmd: string, args: string[], o?: { timeoutMs?: number; stdin?: string; signal?: AbortSignal }) => RunOut | Error;
  procs: ProcInfo[] = [];
  deleted: Array<{ id: string; graceMs?: number }> = [];
  waitScript: Array<{ tree_exited: boolean; exit_code?: number | null } | Error> = [];
  waitCalls: Array<{ scope?: string; waitTimeoutMs?: number; timeoutMs?: number }> = [];
  stored = new Map<string, Uint8Array>();
  uploads: string[] = [];
  destroyError?: Error;
  destroyMs = 700;
  constructor(public id: string, name: string | undefined, egress: string[], private clock: Clock, createdAt?: number) {
    this.name = name;
    this.egress = egress;
    this.data = { created_at: new Date(createdAt ?? clock.t).toISOString() };
  }
  async refresh() { return this; }
  async runCommand(cmd: string, args: string[] = [], o?: { timeoutMs?: number; stdin?: string; signal?: AbortSignal }) {
    this.runs.push({ cmd, args, o });
    if (this.hang) return new Promise<never>(() => undefined);
    this.calls.push(isProbe(args) ? "PROBE" : `run:${cmd} ${args.join(" ")}`);
    let out: RunOut = { stdout: "", stderr: "", exit_code: 0 };
    if (isProbe(args)) {
      if (this.probeError) throw this.probeError;
      out = { stdout: this.probeOutputs.length > 1 ? this.probeOutputs.shift()! : (this.probeOutputs[0] ?? CLOSED) };
    } else if (this.runHandler) {
      const r = this.runHandler(cmd, args, o);
      if (r instanceof Error) throw r;
      out = r;
    }
    return { result: { stdout: out.stdout ?? "", stderr: out.stderr ?? "", exit_code: out.exit_code ?? 0, ...(out.error ? { error: out.error } : {}) }, exec_ms: 5 };
  }
  async getEgress() {
    this.calls.push("getEgress");
    return { egress: this.egressReads.length ? this.egressReads.shift()! : [...this.egress] };
  }
  async setEgress(rules: string[] | null) {
    this.calls.push(`setEgress:${JSON.stringify(rules)}`);
    if (!this.ignoreSetEgress && rules) this.egress = [...rules];
    return { egress: [...this.egress] };
  }
  async destroy() {
    this.calls.push("destroy");
    if (this.destroyError) throw this.destroyError;
    this.status = "destroying";
    return { status: "destroying" };
  }
  async waitUntilRunning() { this.calls.push("waitUntilRunning"); this.status = "running"; return this; }
  async waitUntilDestroyed() { this.calls.push("waitUntilDestroyed"); this.clock.t += this.destroyMs; this.status = "destroyed"; return this; }
  files = {
    upload: async (path: string, data: string | Uint8Array) => {
      if (this.uploadFailures.length) throw this.uploadFailures.shift()!;
      this.uploads.push(path);
      this.stored.set(path, typeof data === "string" ? new TextEncoder().encode(data) : data);
    },
    download: async (path: string) => {
      const b = this.stored.get(path);
      if (!b) throw eNotFound();
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    },
  };
  processes = {
    create: async (r: { cmd: string; args?: string[]; cwd?: string }) => {
      this.calls.push(`proc.create:${r.cmd} ${(r.args ?? []).join(" ")} @${r.cwd ?? ""}`);
      return { process_id: "p-1" };
    },
    list: async () => ({ processes: this.procs }),
    wait: async (_id: string, o: { scope?: "leader" | "tree"; waitTimeoutMs?: number; timeoutMs?: number }) => {
      this.waitCalls.push(o);
      this.clock.t += 300;   // the control plane returns early (it caps waitTimeoutMs)
      const next = this.waitScript.shift();
      if (next instanceof Error) throw next;
      return next ?? { tree_exited: false };
    },
    delete: async (id: string, o?: { graceMs?: number }) => {
      this.deleted.push({ id, graceMs: o?.graceMs });
      if (id === "gone") throw eNotFound();
    },
  };
}

class FakeSdk implements SdkLike {
  boxes: FakeBox[] = [];
  createCalls: CreateReq[] = [];
  plan: Array<(req: CreateReq) => FakeBox> = [];   // one entry per create call; an entry may throw
  running = 0;
  private n = 0;
  constructor(public clock: Clock) {}
  newBox(req: CreateReq, status = "running") {
    const b = new FakeBox(`sb-${++this.n}`, req.name, [...req.egress], this.clock);
    b.status = status;
    this.boxes.push(b);
    return b;
  }
  addBox(name: string, status: string, ageSec: number, id?: string) {
    const b = new FakeBox(id ?? `sb-x${++this.n}`, name, [SEAL], this.clock, this.clock.t - ageSec * 1000);
    b.status = status;
    this.boxes.push(b);
    return b;
  }
  Sandbox = {
    create: async (req: CreateReq, _o: SdkOpts) => {
      this.createCalls.push(req);
      return (this.plan.shift() ?? ((r: CreateReq) => this.newBox(r)))(req);
    },
    connect: async (id: string, _o: SdkOpts) => {
      const b = this.boxes.find((x) => x.id === id);
      if (!b) throw eNotFound();
      return b;
    },
  };
  createClient = (_o: SdkOpts) => ({
    listSandboxes: async () => [...this.boxes] as SandboxLike[],
    whoami: async () => ({ stats: { running: this.running } }),
  });
}

function setup(over: { cap?: number; force?: boolean; devVmId?: string; seal?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "vmtest-"));
  const clock: Clock = { t: Date.parse("2026-10-17T22:00:00Z") };
  const sdk = new FakeSdk(clock);
  const deps: VmDeps = {
    sdk: sdk as SdkLike, ledgerPath: join(dir, "creates.json"), devVmPath: join(dir, "devvm.json"),
    now: () => clock.t, sleep: async (ms) => { clock.t += ms; }, log: () => {},
    cfg: {
      createosKey: "test-key", createosBase: "http://fake.invalid", sealRule: over.seal ?? SEAL, vmMode: "fresh",
      devVmId: over.devVmId ?? "", createCap: over.cap ?? 10, forceCreate: over.force ?? false,
    },
  };
  return { dir, clock, sdk, deps, vm: createVm(deps), ledger: () => readLedger(deps.ledgerPath!) };
}

// ── Pure helpers ────────────────────────────────────────────────────────
describe("normalizeRule, parseProbe, PROBE", () => {
  it("normalizes case, whitespace and a bare IPv4 address to /32", () => {
    assert.equal(normalizeRule(" 192.0.2.1/32 "), "192.0.2.1/32");
    assert.equal(normalizeRule("192.0.2.1"), "192.0.2.1/32");
    assert.equal(normalizeRule("192.0.2.1"), normalizeRule("192.0.2.1/32"));
    assert.equal(normalizeRule("240.0.0.0/4"), "240.0.0.0/4");
    assert.equal(normalizeRule("EXAMPLE.com:443"), "example.com:443");
    assert.notEqual(normalizeRule("192.0.2.10"), normalizeRule("192.0.2.1/32"));
    assert.notEqual(normalizeRule("192.0.2.1/32 "), "192.0.2.1/33");
  });
  it("parses the three exits in order", () => {
    assert.deepEqual(parseProbe(CLOSED), [
      { label: "https", exit: 28 }, { label: "raw_ip", exit: 7 }, { label: "dns", exit: 2 },
    ]);
  });
  it("counts a missing, empty or garbled *_exit line as exit 0 (fail closed)", () => {
    assert.deepEqual(parseProbe("https_exit=28\nraw_ip_exit=7\n").map((p) => p.exit), [28, 7, 0]);
    assert.deepEqual(parseProbe("").map((p) => p.exit), [0, 0, 0]);
    assert.deepEqual(parseProbe("https_exit=\nraw_ip_exit=abc\ndns_exit=3\n").map((p) => p.exit), [0, 0, 3]);
  });
  it("keeps DESIGN 8.2's probe string verbatim", () => {
    assert.equal(PROBE,
      "curl -sS -m 5 -o /dev/null https://example.com; echo https_exit=$?; " +
      "curl -sS -m 3 -o /dev/null http://1.1.1.1; echo raw_ip_exit=$?; " +
      "getent hosts example.com >/dev/null; echo dns_exit=$?");
  });
});

// ── Seal decision table (DESIGN 8.2) ────────────────────────────────────
describe("createSealed: seal decision table", () => {
  it("sealed: probe is the first command, request carries only shape, rootfs, name, egress", async () => {
    const t = setup();
    const { vm, seal } = await t.vm.createSealed("hx-ab12-A-cd34");
    assert.equal(t.sdk.createCalls.length, 1);
    assert.deepEqual(t.sdk.createCalls[0], { shape: "s-1vcpu-1gb", rootfs: "devbox:1", name: "hx-ab12-A-cd34", egress: [SEAL] });
    const box = t.sdk.boxes[0]!;
    const firstRun = box.calls.find((c) => c === "PROBE" || c.startsWith("run:"));
    assert.equal(firstRun, "PROBE");
    assert.equal(box.runs[0]!.o?.timeoutMs, 20_000);
    assert.deepEqual(box.runs[0]!.args, ["-c", PROBE]);
    assert.equal(vm.id, box.id);
    assert.equal(vm.name, "hx-ab12-A-cd34");
    assert.equal(seal.sandboxId, box.id);
    assert.deepEqual(seal.egressRequested, [SEAL]);
    assert.deepEqual(seal.egressReadback, [SEAL]);
    assert.equal(seal.readbackOk, true);
    assert.equal(seal.resealed, false);
    assert.equal(seal.reused, false);
    assert.ok(seal.probes.length === 3 && seal.probes.every((p) => p.exit !== 0));
    assert.ok(!box.calls.includes("destroy") && !box.calls.some((c) => c.startsWith("setEgress")));
    assert.deepEqual(t.ledger().map((e) => [e.name, e.ok, e.sandboxId, e.adopted]), [["hx-ab12-A-cd34", true, box.id, undefined]]);
  });

  it("accepts the readback with /32 left off (normalized)", async () => {
    const t = setup();
    t.sdk.plan.push((r) => { const b = t.sdk.newBox(r); b.egress = ["192.0.2.1"]; return b; });
    const { seal } = await t.vm.createSealed("hx-ab12-A-cd34");
    assert.equal(seal.readbackOk, true);
    assert.deepEqual(seal.egressReadback, ["192.0.2.1"]);   // recorded verbatim
  });

  it("works with the other accepted rule, 240.0.0.0/4", async () => {
    const t = setup({ seal: "240.0.0.0/4" });
    const { seal } = await t.vm.createSealed("hx-ab12-A-cd34");
    assert.deepEqual(t.sdk.createCalls[0]!.egress, ["240.0.0.0/4"]);
    assert.equal(seal.readbackOk, true);
  });

  it("readback wrong, then fixed: setEgress([SEAL]), read back again, probe again, no destroy", async () => {
    const t = setup();
    t.sdk.plan.push((r) => { const b = t.sdk.newBox(r); b.egressReads = [[]]; return b; });
    const { seal } = await t.vm.createSealed("hx-ab12-A-cd34");
    const box = t.sdk.boxes[0]!;
    assert.deepEqual(box.calls.filter((c) => c.startsWith("setEgress")), [`setEgress:${JSON.stringify([SEAL])}`]);
    assert.equal(box.calls.filter((c) => c === "PROBE").length, 2);
    assert.ok(!box.calls.includes("destroy"));
    assert.equal(seal.readbackOk, true);
    assert.equal(seal.resealed, true);
    assert.deepEqual(seal.egressReadback, [SEAL]);
  });

  it("readback wrong twice: destroy and throw SealError carrying the readback and probes", async () => {
    const t = setup();
    t.sdk.plan.push((r) => { const b = t.sdk.newBox(r); b.egress = ["10.0.0.0/8", "192.0.2.1/32"]; b.ignoreSetEgress = true; return b; });
    await assert.rejects(t.vm.createSealed("hx-ab12-A-cd34"), (e: unknown) => {
      assert.ok(e instanceof SealError);
      assert.deepEqual(e.proof.egressReadback, ["10.0.0.0/8", "192.0.2.1/32"]);
      assert.equal(e.proof.readbackOk, false);
      assert.equal(e.proof.probes?.length, 3);
      assert.equal(e.proof.sandboxId, "sb-1");
      return true;
    });
    const box = t.sdk.boxes[0]!;
    assert.equal(box.calls.filter((c) => c.startsWith("setEgress")).length, 1);
    assert.ok(box.calls.includes("destroy"));
  });

  it("open at the first command: setEgress, wait 1 s, probe again, resealed true, no destroy", async () => {
    const t = setup();
    t.sdk.plan.push((r) => { const b = t.sdk.newBox(r); b.probeOutputs = [OPEN, CLOSED]; return b; });
    const before = t.clock.t;
    const { seal } = await t.vm.createSealed("hx-ab12-A-cd34");
    const box = t.sdk.boxes[0]!;
    assert.equal(box.calls.filter((c) => c === "PROBE").length, 2);
    assert.ok(box.calls.some((c) => c.startsWith("setEgress")));
    assert.ok(!box.calls.includes("destroy"));
    assert.ok(t.clock.t - before >= 1000);
    assert.equal(seal.resealed, true);
    assert.ok(seal.probes.every((p) => p.exit !== 0));
    assert.equal(t.sdk.createCalls.length, 1);   // never a second create
  });

  it("still open after setEgress: destroy and throw SealError", async () => {
    const t = setup();
    t.sdk.plan.push((r) => { const b = t.sdk.newBox(r); b.probeOutputs = [OPEN, OPEN]; return b; });
    await assert.rejects(t.vm.createSealed("hx-ab12-A-cd34"), (e: unknown) => {
      assert.ok(e instanceof SealError);
      assert.equal(e.proof.probes?.[0]?.exit, 0);
      return true;
    });
    assert.ok(t.sdk.boxes[0]!.calls.includes("destroy"));
  });

  it("a probe that cannot run counts as open (fail closed)", async () => {
    const t = setup();
    t.sdk.plan.push((r) => { const b = t.sdk.newBox(r); b.probeError = new Error("exec unreachable"); return b; });
    await assert.rejects(t.vm.createSealed("hx-ab12-A-cd34"), SealError);
    assert.ok(t.sdk.boxes[0]!.calls.includes("destroy"));
  });

  it("refuses an empty seal rule before any create", async () => {
    const t = setup({ seal: "" });
    await assert.rejects(t.vm.createSealed("hx-ab12-A-cd34"), /SEAL_RULE/);
    assert.equal(t.sdk.createCalls.length, 0);
  });
});

// ── 502 and timeout handling (DESIGN 8.3) ───────────────────────────────
describe("createSealed: 502 adoption", () => {
  it("running box found by name: adopt it, one create call, ledger marks adopted", async () => {
    const t = setup();
    t.sdk.plan.push((r) => { t.sdk.newBox(r); throw e502(); });
    const { vm, seal } = await t.vm.createSealed("hx-ab12-A-cd34");
    assert.equal(t.sdk.createCalls.length, 1);
    assert.equal(vm.id, "sb-1");
    assert.equal(seal.readbackOk, true);
    assert.deepEqual(t.ledger().map((e) => [e.name, e.ok, e.adopted]), [["hx-ab12-A-cd34", true, true]]);
  });

  it("box still creating: wait until running, then adopt (timeout variant)", async () => {
    const t = setup();
    t.sdk.plan.push((r) => { t.sdk.newBox(r, "creating"); throw eTimeout(); });
    const { vm } = await t.vm.createSealed("hx-ab12-A-cd34");
    assert.equal(vm.id, "sb-1");
    assert.ok(t.sdk.boxes[0]!.calls.includes("waitUntilRunning"));
    assert.equal(t.sdk.createCalls.length, 1);
    assert.equal(t.ledger()[0]!.adopted, true);
  });

  it("dead socket is treated like a timeout", async () => {
    const t = setup();
    t.sdk.plan.push((r) => { t.sdk.newBox(r); throw new CreateosSandboxConnectionError("socket reset"); });
    const { vm } = await t.vm.createSealed("hx-ab12-A-cd34");
    assert.equal(vm.id, "sb-1");
  });

  it("box absent: retry once with a new name (same prefix), every attempt in the ledger", async () => {
    const t = setup();
    t.sdk.plan.push(() => { throw e502(); });
    const { vm } = await t.vm.createSealed("hx-ab12-A-cd34");
    assert.equal(t.sdk.createCalls.length, 2);
    const [n1, n2] = t.sdk.createCalls.map((c) => c.name);
    assert.notEqual(n1, n2);
    assert.equal(n1!.slice(0, -4), n2!.slice(0, -4));
    assert.match(n2!, /^hx-ab12-A-[a-z0-9]{4}$/);
    assert.equal(vm.name, n2);
    assert.deepEqual(t.ledger().map((e) => [e.name, e.ok]), [[n1, false], [n2, true]]);
  });

  it("absent twice: throws after the one retry, never a third create", async () => {
    const t = setup();
    t.sdk.plan.push(() => { throw e502(); }, () => { throw eTimeout(); });
    await assert.rejects(t.vm.createSealed("hx-ab12-A-cd34"), CreateosSandboxTimeoutError);
    assert.equal(t.sdk.createCalls.length, 2);
    assert.deepEqual(t.ledger().map((e) => e.ok), [false, false]);
  });

  it("409 name conflict (the SDK silently re-sent our create): adopt the box that exists, no retry", async () => {
    const t = setup();
    t.sdk.plan.push((r) => { t.sdk.newBox(r); throw new CreateosSandboxValidationError("conflict", resp(409)); });
    const { vm } = await t.vm.createSealed("hx-ab12-A-cd34");
    assert.equal(vm.id, "sb-1");
    assert.equal(t.sdk.createCalls.length, 1);
    assert.equal(t.ledger()[0]!.adopted, true);
  });

  it("409 with no such box: throws, no retry", async () => {
    const t = setup();
    t.sdk.plan.push(() => { throw new CreateosSandboxValidationError("conflict", resp(409)); });
    await assert.rejects(t.vm.createSealed("hx-ab12-A-cd34"), CreateosSandboxValidationError);
    assert.equal(t.sdk.createCalls.length, 1);
  });

  it("402 (and any non-ambiguous error): ledger it, throw, never retry", async () => {
    const t = setup();
    t.sdk.plan.push(() => { throw e402(); });
    await assert.rejects(t.vm.createSealed("hx-ab12-A-cd34"), CreateosSandboxPaymentRequiredError);
    assert.equal(t.sdk.createCalls.length, 1);
    assert.deepEqual(t.ledger().map((e) => [e.name, e.ok]), [["hx-ab12-A-cd34", false]]);
  });
});

// ── Ledger and counter ──────────────────────────────────────────────────
describe("creates and the cap", () => {
  it("counts every status created in the last 24 h and ignores older boxes", async () => {
    const t = setup();
    t.sdk.addBox("a", "destroyed", 3600);
    t.sdk.addBox("b", "running", 100);
    t.sdk.addBox("c", "failed", 7 * 3600);
    t.sdk.addBox("d", "destroyed", 25 * 3600);   // older than 24 h: not counted
    assert.deepEqual(await t.vm.creates(), { used24h: 3, cap: 10 });
  });

  it("takes the larger of the list count and the ledger count", async () => {
    const t = setup({ cap: 7 });
    t.sdk.addBox("a", "destroyed", 3600);
    const entries = [1, 2, 3, 4, 5].map((i) => ({ t: t.clock.t - i * 1000, name: `n${i}`, ok: true }))
      .concat([{ t: t.clock.t - 30 * 3600 * 1000, name: "old", ok: true }]);
    writeFileSync(t.deps.ledgerPath!, JSON.stringify(entries));
    assert.deepEqual(await t.vm.creates(), { used24h: 5, cap: 7 });
  });

  it("throws CreateCapError at the cap and creates nothing", async () => {
    const t = setup({ cap: 3 });
    for (let i = 0; i < 3; i++) t.sdk.addBox(`old${i}`, "destroyed", 100 + i);
    await assert.rejects(t.vm.createSealed("hx-ab12-A-cd34"), CreateCapError);
    assert.equal(t.sdk.createCalls.length, 0);
    assert.deepEqual(t.ledger(), []);
  });

  it("FORCE_CREATE lets a create through at the cap", async () => {
    const t = setup({ cap: 3, force: true });
    for (let i = 0; i < 3; i++) t.sdk.addBox(`old${i}`, "destroyed", 100 + i);
    await t.vm.createSealed("hx-ab12-A-cd34");
    assert.equal(t.sdk.createCalls.length, 1);
  });

  it("writes the ledger as a JSON array through a temp file", async () => {
    const t = setup();
    await t.vm.createSealed("hx-ab12-A-cd34");
    const raw = JSON.parse(readFileSync(t.deps.ledgerPath!, "utf8"));
    assert.ok(Array.isArray(raw) && raw.length === 1);
    assert.equal(typeof raw[0].t, "number");
  });
});

// ── exec, files, processes ──────────────────────────────────────────────
async function ready(over: Parameters<typeof setup>[0] = {}) {
  const t = setup(over);
  const { vm, seal } = await t.vm.createSealed("hx-ab12-A-cd34");
  const box = t.sdk.boxes[0]!;
  box.calls.length = 0;
  box.runs.length = 0;
  return { ...t, h: vm, seal, box };
}

describe("exec", () => {
  it("runs bash -c with the command as one untouched argv element, stdin and the timeout", async () => {
    const t = await ready();
    const cmd = `exec timeout -k 2 25 unshare -n bash -c "$(cat)"`;
    t.box.runHandler = () => ({ stdout: "out", stderr: "err", exit_code: 3 });
    const r = await t.vm.exec(t.h, cmd, { stdin: "echo 'hi there'; ls", timeoutSec: 35 });
    assert.deepEqual(r, { exit: 3, stdout: "out", stderr: "err", ms: 5, timedOut: false });
    assert.equal(t.box.runs[0]!.cmd, "bash");
    assert.deepEqual(t.box.runs[0]!.args, ["-c", cmd]);
    assert.equal(t.box.runs[0]!.o?.stdin, "echo 'hi there'; ls");
    assert.equal(t.box.runs[0]!.o?.timeoutMs, 35_000);
  });
  it("defaults to a 60 s timeout and an empty stdin (/dev/null)", async () => {
    const t = await ready();
    await t.vm.exec(t.h, "true");
    assert.equal(t.box.runs[0]!.o?.timeoutMs, 60_000);
    assert.equal(t.box.runs[0]!.o?.stdin, "");
  });
  it("a command that outlives its timeout returns exit 124, timedOut true, even though the SDK transport ignores timeouts", async () => {
    const t = await ready();
    t.box.hang = true;
    const t0 = Date.now();
    const r = await t.vm.exec(t.h, "sleep 5", { timeoutSec: 0.05 });
    assert.equal(r.exit, 124);
    assert.equal(r.timedOut, true);
    assert.equal(r.stderr, "command timed out");
    assert.ok(Date.now() - t0 < 2000);
  });
  it("an SDK-level timeout error is also exit 124", async () => {
    const t = await ready();
    t.box.runHandler = () => eTimeout();
    const r = await t.vm.exec(t.h, "x", { timeoutSec: 1 });
    assert.equal(r.exit, 124);
    assert.equal(r.timedOut, true);
  });
  it("an agent-level error becomes exit 127 with that text", async () => {
    const t = await ready();
    t.box.runHandler = () => ({ error: "exec: no such file", exit_code: 0 });
    const r = await t.vm.exec(t.h, "nope");
    assert.equal(r.exit, 127);
    assert.equal(r.stderr, "exec: no such file");
    assert.equal(r.timedOut, false);
  });
  it("other errors propagate", async () => {
    const t = await ready();
    t.box.runHandler = () => new CreateosSandboxConnectionError("socket reset");
    await assert.rejects(t.vm.exec(t.h, "x"), CreateosSandboxConnectionError);
  });
});

describe("upload and download", () => {
  it("download of a missing file is null; an uploaded file comes back byte for byte", async () => {
    const t = await ready();
    assert.equal(await t.vm.download(t.h, "/work/none.txt"), null);
    const bytes = new Uint8Array([0, 1, 2, 255, 254]);
    await t.vm.upload(t.h, "/work/out/a.bin", bytes);
    assert.deepEqual(await t.vm.download(t.h, "/work/out/a.bin"), bytes);
  });
  it("makes the directory once per directory (cached), strings are uploaded as given", async () => {
    const t = await ready();
    await t.vm.upload(t.h, "/work/examples/1.in", "a");
    await t.vm.upload(t.h, "/work/examples/1.out", "b");
    await t.vm.upload(t.h, "/work/SPEC.md", "c");
    const mk = t.box.runs.filter((r) => r.cmd === "mkdir");
    assert.deepEqual(mk.map((r) => r.args), [["-p", "/work/examples"], ["-p", "/work"]]);
    assert.deepEqual(t.box.uploads, ["/work/examples/1.in", "/work/examples/1.out", "/work/SPEC.md"]);
  });
  it("recreates the directory and tries once more when a cached directory has vanished", async () => {
    const t = await ready();
    await t.vm.upload(t.h, "/work/a/x", "1");
    t.box.uploadFailures.push(new Error("no such directory"));
    await t.vm.upload(t.h, "/work/a/y", "2");
    assert.equal(t.box.runs.filter((r) => r.cmd === "mkdir").length, 2);
    assert.deepEqual(t.box.uploads, ["/work/a/x", "/work/a/y"]);
  });
  it("refuses a relative path", async () => {
    const t = await ready();
    await assert.rejects(t.vm.upload(t.h, "work/x", "1"), /absolute/);
  });
});

describe("spawn, waitProcess, killProcess", () => {
  it("spawn starts bash -c in the given cwd and returns the process id", async () => {
    const t = await ready();
    const id = await t.vm.spawn(t.h, "trap '' TERM; sleep 300 & wait", "/tmp");
    assert.equal(id, "p-1");
    assert.deepEqual(t.box.calls, ["proc.create:bash -c trap '' TERM; sleep 300 & wait @/tmp"]);
  });
  it("waitProcess loops past early returns until the tree exits (scope tree)", async () => {
    const t = await ready();
    t.box.waitScript = [{ tree_exited: false }, { tree_exited: false }, { tree_exited: true, exit_code: 3 }];
    const r = await t.vm.waitProcess(t.h, "p-1", 5000);
    assert.deepEqual(r, { exited: true, exit: 3 });
    assert.equal(t.box.waitCalls.length, 3);
    assert.ok(t.box.waitCalls.every((c) => c.scope === "tree"));
    const first = t.box.waitCalls[0]!;
    assert.equal(first.waitTimeoutMs, 5000);
    assert.equal(first.timeoutMs, 15_000);
    assert.ok(t.box.waitCalls[1]!.waitTimeoutMs! < 5000);   // the remaining time shrinks
  });
  it("returns exited false once waitMs is spent", async () => {
    const t = await ready();
    const r = await t.vm.waitProcess(t.h, "p-1", 700);
    assert.deepEqual(r, { exited: false });
    assert.ok(t.box.waitCalls.length >= 2 && t.box.waitCalls.length <= 3);
  });
  it("HTTP 408 wait_timeout means still alive (verified live), not an error", async () => {
    const t = await ready();
    t.box.waitScript = [new CreateosSandboxApiError("createos-sandbox request failed (408): error: wait_timeout", resp(408))];
    const r = await t.vm.waitProcess(t.h, "p-1", 200);
    assert.deepEqual(r, { exited: false });
  });
  it("other wait errors propagate", async () => {
    const t = await ready();
    t.box.waitScript = [new CreateosSandboxServerError("boom", resp(500))];
    await assert.rejects(t.vm.waitProcess(t.h, "p-1", 200), CreateosSandboxServerError);
  });
  it("killProcess deletes with graceMs 200 and ignores a process that is already gone", async () => {
    const t = await ready();
    await t.vm.killProcess(t.h, "p-1");
    await t.vm.killProcess(t.h, "gone");
    assert.deepEqual(t.box.deleted, [{ id: "p-1", graceMs: 200 }, { id: "gone", graceMs: 200 }]);
  });
});

// ── destroy ─────────────────────────────────────────────────────────────
describe("destroy and waitDestroyed", () => {
  it("destroy resolves at once, sends the DELETE, and waitDestroyed measures from the destroy call", async () => {
    const t = await ready();
    t.box.destroyMs = 700;
    await t.vm.destroy(t.h);
    t.clock.t += 50;   // time passes between destroy and the wait
    const w = await t.vm.waitDestroyed(t.h);
    assert.ok(t.box.calls.includes("destroy"));
    assert.equal(w.ok, true);
    assert.equal(w.ms, 750);
    assert.equal(await t.vm.state(t.h), "destroyed");
  });
  it("destroy never throws, even when the DELETE fails; waitDestroyed then says ok false", async () => {
    const t = await ready();
    t.box.destroyError = new CreateosSandboxServerError("boom", resp(500));
    await t.vm.destroy(t.h);
    const w = await t.vm.waitDestroyed(t.h, 1000);
    assert.equal(w.ok, false);
  });
  it("destroy of a handle the SDK cannot find does not throw", async () => {
    const t = setup();
    await t.vm.destroy({ id: "sb-nope", name: "x", createdAt: 0 });
    assert.deepEqual(await t.vm.waitDestroyed({ id: "sb-nope", name: "x", createdAt: 0 }), { ok: false, ms: 0 });
  });
  it("a second destroy call does not send a second DELETE", async () => {
    const t = await ready();
    await t.vm.destroy(t.h);
    await t.vm.destroy(t.h);
    assert.equal(t.box.calls.filter((c) => c === "destroy").length, 1);
  });
  it("state is 'missing' when the SDK says not found; running() reads whoami", async () => {
    const t = setup();
    assert.equal(await t.vm.state({ id: "sb-nope", name: "x", createdAt: 0 }), "missing");
    t.sdk.running = 1;
    assert.equal(await t.vm.running(), 1);
  });
});

// ── dev VM #1: connect, reset, and never destroyed by destroy/reset/connect ──────────────────────────
const WIPE = "run:bash -c rm -rf /work && mkdir -p /work";

describe("dev VM #1", () => {
  it("connect wipes /work, then re-probes; reused true; createMs 0; never destroys", async () => {
    const t = setup({ devVmId: "sb-dev" });
    const box = t.sdk.addBox("hd-dev1-abcd", "running", 600, "sb-dev");
    const { vm, seal } = await t.vm.connect("sb-dev");
    assert.equal(vm.id, "sb-dev");
    assert.equal(seal.reused, true);
    assert.equal(seal.createMs, 0);
    assert.equal(seal.readbackOk, true);
    assert.ok(seal.probes.every((p) => p.exit !== 0));
    const order = box.calls.filter((c) => c === WIPE || c === "PROBE");
    assert.deepEqual(order, [WIPE, "PROBE"]);   // the wipe comes first, then the fresh probe
    assert.ok(!box.calls.includes("destroy"));
    assert.equal(t.sdk.createCalls.length, 0);
  });

  it("connect on a failed seal throws SealError and leaves the box for Main", async () => {
    const t = setup({ devVmId: "sb-dev" });
    const box = t.sdk.addBox("hd-dev1-abcd", "running", 600, "sb-dev");
    box.probeOutputs = [OPEN, OPEN];
    await assert.rejects(t.vm.connect("sb-dev"), SealError);
    assert.ok(!box.calls.includes("destroy"));
  });

  it("connect refuses a box that is not running", async () => {
    const t = setup();
    t.sdk.addBox("hd-dev1-abcd", "paused", 600, "sb-dev");
    await assert.rejects(t.vm.connect("sb-dev"), /paused/);
  });

  it("reset on the dev VM wipes /work, re-probes, keeps reused true; a failed seal throws without destroying", async () => {
    const t = setup({ devVmId: "sb-dev" });
    const box = t.sdk.addBox("hd-dev1-abcd", "running", 600, "sb-dev");
    const h = { id: "sb-dev", name: "hd-dev1-abcd", createdAt: 0 };
    const seal = await t.vm.reset(h, "B");
    assert.equal(seal.reused, true);
    assert.deepEqual(box.calls.filter((c) => c === WIPE || c === "PROBE"), [WIPE, "PROBE"]);
    box.probeOutputs = [OPEN, OPEN];
    await assert.rejects(t.vm.reset(h, "B"), SealError);
    assert.ok(!box.calls.includes("destroy"));
  });

  it("the dev VM id recorded in data/devvm.json is protected too, until its destroy is recorded", async () => {
    const t = setup();   // no DEV_VM_ID in config
    const box = t.sdk.addBox("hd-dev1-abcd", "running", 600, "sb-dev");
    const h = { id: "sb-dev", name: "hd-dev1-abcd", createdAt: 0 };
    writeFileSync(t.deps.devVmPath!, JSON.stringify({ id: "sb-dev", destroy: null }));
    await t.vm.destroy(h);
    assert.ok(!box.calls.includes("destroy"));
    assert.deepEqual(await t.vm.waitDestroyed(h), { ok: false, ms: 0 });   // nothing to wait for
    assert.equal((await t.vm.reset(h, "A")).reused, true);
    assert.ok(!box.calls.includes("destroy"));
    writeFileSync(t.deps.devVmPath!, JSON.stringify({ id: "sb-dev", destroy: { ms: 900, ok: true } }));
    await t.vm.destroy(h);   // once Main has destroyed and recorded it, the guard is off
    assert.ok(box.calls.includes("destroy"));
  });

  it("a box this instance only connect()ed to is treated as the reused dev VM: destroy refuses it", async () => {
    const t = setup();   // neither DEV_VM_ID nor data/devvm.json names it
    const box = t.sdk.addBox("hd-dev1-abcd", "running", 600, "sb-conn");
    const { vm } = await t.vm.connect("sb-conn");
    await t.vm.destroy(vm);
    assert.ok(!box.calls.includes("destroy"));
  });

  it("DEV_VM_ID is never destroyed by destroy", async () => {
    const t = setup({ devVmId: "sb-dev" });
    const box = t.sdk.addBox("anything", "running", 10, "sb-dev");
    await t.vm.destroy({ id: "sb-dev", name: "anything", createdAt: 0 });
    assert.ok(!box.calls.includes("destroy"));
  });

  it("destroyExact is the one path that destroys it, by exact id, and reports the measured ms", async () => {
    const t = setup({ devVmId: "sb-dev" });
    const box = t.sdk.addBox("hd-dev1-abcd", "running", 600, "sb-dev");
    box.destroyMs = 1234;
    const r = await destroyExact("sb-dev", t.deps);
    assert.deepEqual(r, { ok: true, ms: 1234, status: "destroyed" });
    assert.ok(box.calls.includes("destroy"));
  });
  it("destroyExact on an id that does not exist answers missing and does not throw", async () => {
    const t = setup();
    assert.deepEqual((await destroyExact("sb-nope", t.deps)).status, "missing");
    assert.equal((await destroyExact("sb-nope", t.deps)).ok, false);
  });
});

describe("reset on an ordinary VM, and which processes connect/reset stop", () => {
  it("reset sets reused false and wipes /work, then re-probes", async () => {
    const t = await ready();
    const seal = await t.vm.reset(t.h, "B");
    assert.equal(seal.reused, false);
    assert.deepEqual(t.box.calls.filter((c) => c === WIPE || c === "PROBE"), [WIPE, "PROBE"]);
    assert.ok(!t.box.calls.includes("destroy"));
  });
  it("reset on a failed seal destroys an ordinary VM (fail closed) and throws SealError", async () => {
    const t = await ready();
    t.box.probeOutputs = [OPEN, OPEN];
    await assert.rejects(t.vm.reset(t.h, "B"), SealError);
    assert.ok(t.box.calls.includes("destroy"));
  });
  it("reset re-creates the upload directory cache (a wiped /work needs a fresh mkdir)", async () => {
    const t = await ready();
    await t.vm.upload(t.h, "/work/a/x", "1");
    await t.vm.reset(t.h, "B");
    t.box.runs.length = 0;
    await t.vm.upload(t.h, "/work/a/y", "2");
    assert.equal(t.box.runs.filter((r) => r.cmd === "mkdir").length, 1);
  });
  it("stops only managed processes whose cwd is /work or below, never /ndev (connect and reset)", async () => {
    const procs: ProcInfo[] = [
      { process_id: "w1", cwd: "/work" },
      { process_id: "w2", cwd: "/work/sub/dir" },
      { process_id: "w3", cwd: "/work/", state: "running" },
      { process_id: "n1", cwd: "/ndev" },
      { process_id: "n2", cwd: "/ndev/work" },
      { process_id: "x1", cwd: "/workshop" },
      { process_id: "x2", cwd: "/tmp" },
      { process_id: "x3", cwd: "/work/../ndev" },
      { process_id: "x4" },
      { process_id: "w-done", cwd: "/work", tree_exited: true },
    ];
    const t = await ready();
    t.box.procs = procs;
    await t.vm.reset(t.h, "B");
    assert.deepEqual(t.box.deleted.map((d) => d.id), ["w1", "w2", "w3"]);
    assert.ok(t.box.deleted.every((d) => d.graceMs === 200));

    const u = setup({ devVmId: "sb-dev" });
    const dev = u.sdk.addBox("hd-dev1-abcd", "running", 600, "sb-dev");
    dev.procs = procs;
    await u.vm.connect("sb-dev");
    assert.deepEqual(dev.deleted.map((d) => d.id), ["w1", "w2", "w3"]);
  });
});

// ── reaper ──────────────────────────────────────────────────────────────
describe("reapOrphans", () => {
  function fleet() {
    const t = setup({ devVmId: "sb-dev" });
    t.sdk.addBox("hx-aaaa-A-1111", "running", 600, "sb-hx-old");
    t.sdk.addBox("hx-bbbb-A-2222", "running", 10, "sb-hx-young");
    t.sdk.addBox("hn-cccc-A-3333", "running", 400, "sb-hn-old");
    t.sdk.addBox("hx-dddd-A-4444", "running", 900, "sb-hx-keep");
    t.sdk.addBox("hd-dev1-eeee", "running", 9999, "sb-dev");
    t.sdk.addBox("smoke-9", "running", 9999, "sb-other");
    t.sdk.addBox("hx-ffff-A-5555", "destroyed", 9999, "sb-hx-gone");
    return t;
  }
  const destroyedIds = (t: ReturnType<typeof setup>) => t.sdk.boxes.filter((b) => b.calls.includes("destroy")).map((b) => b.id).sort();

  it("destroys hx-/hn- boxes at least minAgeSec old, by exact id; keeps the rest", async () => {
    const t = fleet();
    const r = await reapOrphans({ minAgeSec: 300, keepIds: ["sb-hx-keep"] }, t.deps);
    assert.deepEqual(r.destroyed.sort(), ["sb-hn-old", "sb-hx-old"]);
    assert.deepEqual(destroyedIds(t), ["sb-hn-old", "sb-hx-old"]);
    assert.ok(r.kept.includes("sb-dev") && r.kept.includes("sb-hx-young") && r.kept.includes("sb-hx-keep") && r.kept.includes("sb-other"));
    assert.ok(!r.kept.includes("sb-hx-gone"));   // already destroyed: not considered
  });
  it("a dry run destroys nothing and marks what it would destroy", async () => {
    const t = fleet();
    const r = await reapOrphans({ minAgeSec: 0, dryRun: true }, t.deps);
    assert.deepEqual(r.destroyed, []);
    assert.deepEqual(destroyedIds(t), []);
    assert.deepEqual(r.rows.filter((x) => x.action === "would-destroy").map((x) => x.id).sort(), ["sb-hn-old", "sb-hx-keep", "sb-hx-old", "sb-hx-young"]);
  });
  it("hd-* and DEV_VM_ID are reaped only with includeDev", async () => {
    const t = fleet();
    const r = await reapOrphans({ minAgeSec: 300, includeDev: true, keepIds: ["sb-hx-keep"] }, t.deps);
    assert.deepEqual(r.destroyed.sort(), ["sb-dev", "sb-hn-old", "sb-hx-old"]);
  });
  it("never lists or touches a box named hd-dev1-* without includeDev, even at minAgeSec 0", async () => {
    const t = fleet();
    await reapOrphans({ minAgeSec: 0 }, t.deps);
    assert.ok(!t.sdk.boxes.find((b) => b.id === "sb-dev")!.calls.includes("destroy"));
  });
});

// ── deadlines ───────────────────────────────────────────────────────────
describe("withDeadline and guard: a silent control plane cannot hang a call", () => {
  it("resolves with the value when the call is fast, and clears its timer", async () => {
    assert.equal(await withDeadline(Promise.resolve(7), 1000, "x"), 7);
  });
  it("rejects with a timeout error at the deadline, runs onTimeout, and swallows the loser's later rejection", async () => {
    let aborted = false;
    let rejectLate: (e: Error) => void = () => undefined;
    const slow = new Promise<number>((_, rej) => { rejectLate = rej; });
    await assert.rejects(withDeadline(slow, 20, "slow call", () => { aborted = true; }), CreateosSandboxTimeoutError);
    assert.equal(aborted, true);
    rejectLate(new Error("late failure"));   // would be an unhandled rejection if the loser were not handled
    await new Promise((r) => setTimeout(r, 10));
  });
  it("passes the winner's rejection through unchanged", async () => {
    await assert.rejects(withDeadline(Promise.reject(eNotFound()), 1000, "x"), CreateosSandboxNotFoundError);
  });
  it("guard bounds runCommand by its timeoutMs and passes an AbortSignal down", async () => {
    const t = setup();
    const raw = t.sdk.addBox("hd-x", "running", 1, "sb-g");
    raw.hang = true;
    const g = guard(raw);
    await assert.rejects(g.runCommand("bash", ["-c", "sleep 9"], { timeoutMs: 30 }), CreateosSandboxTimeoutError);
    assert.ok(raw.runs[0]!.o?.signal instanceof AbortSignal);
    assert.equal(raw.runs[0]!.o?.signal?.aborted, true);
  });
  it("guard is idempotent and keeps live getters", async () => {
    const t = setup();
    const raw = t.sdk.addBox("hd-x", "running", 1, "sb-g");
    const g = guard(raw);
    assert.equal(guard(g), g);
    raw.status = "destroyed";
    assert.equal(g.status, "destroyed");
    assert.equal(g.id, "sb-g");
  });
});
