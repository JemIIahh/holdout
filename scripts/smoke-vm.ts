// scripts/smoke-vm.ts: dev VM #1 (WP-VM). Modes:
//   --create   the ONE create of the night (refuses if a dev VM exists or was created in the last 24 h)
//   --check    zero creates: readback, PROBE and the step-5 checks again, in /tmp only (never /work, never another process)
//   --destroy  Main only (end of P5): destroyExact by the id in data/devvm.json, records destroy-to-destroyed ms
// Run data lands in data/devvm.json (gitignored). Never prints a secret: only ids, names, rules and command output.
import { randomBytes, createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExecResult, VmHandle } from "../src/contracts.js";
import {
  DAY_MS, allClosed, countCreates, createBoxCtx, createVm, destroyExact, devVmName, makeCtx, proveSealCtx, readLedger,
  type VmExt,
} from "../src/vm.js";

type Rec = Record<string, unknown>;
const DEVVM = resolve(process.cwd(), "data/devvm.json");
const say = (m: string): void => console.log(m);
const clip = (s: string, n = 2000): string => (s.length > n ? `${s.slice(0, n)}...[clipped ${s.length - n}]` : s);

function readDev(): Rec | null {
  try { return JSON.parse(readFileSync(DEVVM, "utf8")) as Rec; } catch { return null; }
}
function writeDev(rec: Rec): void {
  mkdirSync(dirname(DEVVM), { recursive: true });
  const tmp = `${DEVVM}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(rec, null, 2) + "\n");
  renameSync(tmp, DEVVM);
}
const rec = (r: ExecResult): Rec => ({ exit: r.exit, stdout: clip(r.stdout), stderr: clip(r.stderr), ms: r.ms, timedOut: r.timedOut });
const lastLine = (s: string): string => s.trim().split(/\r?\n/).pop() ?? "";

/** Step 5: every check runs through the Vm API (the same code paths the product uses), in /tmp only. */
export async function runChecks(vmApi: VmExt, vm: VmHandle): Promise<Rec> {
  const out: Rec = {};
  const step = async (key: string, fn: () => Promise<Rec>): Promise<void> => {
    try { out[key] = await fn(); } catch (e) { out[key] = { ok: false, error: String(e instanceof Error ? e.message : e).slice(0, 300) }; }
  };
  const nobody = "setpriv --reuid=65534 --regid=65534 --clear-groups";

  await step("runSelf", async () => {
    // Read-only: never write to /run/self and never call 127.0.0.1:1029 (a retire there deletes the VM). test -w only tests.
    const ls = await vmApi.exec(vm, "ls -l /run/self; stat -c '%A %U:%G %F' /run/self", { timeoutSec: 20 });
    const nb = await vmApi.exec(vm, `${nobody} sh -c 'test -w /run/self && echo writable || echo blocked'`, { timeoutSec: 20 });
    return { ls: rec(ls), asNobody: rec(nb), asNobodyResult: nb.stdout.trim(), ok: nb.stdout.trim() === "blocked" };
  });
  await step("uidDrop", async () => {
    const r = await vmApi.exec(vm, `${nobody} id -u`, { timeoutSec: 20 });
    return { ...rec(r), ok: r.stdout.trim() === "65534" };
  });
  await step("netns", async () => {
    const r = await vmApi.exec(vm, "unshare -n cat /proc/net/dev", { timeoutSec: 20 });
    const interfaces = r.stdout.split(/\r?\n/).slice(2).map((l) => l.split(":")[0]!.trim()).filter(Boolean);
    return { ...rec(r), interfaces, ok: interfaces.length === 1 && interfaces[0] === "lo" };
  });
  await step("metadata", async () => {
    const inNs = await vmApi.exec(vm, "unshare -n curl -sS -m 3 -o /dev/null http://169.254.169.254/; echo $?", { timeoutSec: 20 });
    const direct = await vmApi.exec(vm, "curl -sS -m 3 -o /dev/null -w '%{http_code}' http://169.254.169.254/; echo \" exit=$?\"", { timeoutSec: 20 });
    const code = Number(lastLine(inNs.stdout));
    return { inNetns: { ...rec(inNs), ok: Number.isFinite(code) && code !== 0 }, direct: rec(direct), directResult: direct.stdout.trim() };
  });
  await step("agentWrapper", async () => {
    const r = await vmApi.exec(vm, 'exec timeout -k 2 25 unshare -n bash -c "$(cat)"', {
      stdin: "echo hi; curl -sS -m 3 -o /dev/null http://1.1.1.1; echo net=$?", timeoutSec: 35,
    });
    const net = /net=(\d+)/.exec(r.stdout);
    return { ...rec(r), ok: /(^|\n)hi\r?\n/.test(r.stdout) && !!net && Number(net[1]) !== 0 };
  });
  await step("timeout", async () => {
    const t0 = Date.now();
    const r = await vmApi.exec(vm, "sleep 5", { timeoutSec: 2 });
    return { ...rec(r), wallMs: Date.now() - t0, ok: r.exit === 124 && r.timedOut === true };
  });
  await step("roundTrip", async () => {
    const bytes = randomBytes(1 << 20);
    const t0 = Date.now();
    await vmApi.upload(vm, "/tmp/rt.bin", bytes);
    const upMs = Date.now() - t0;
    const t1 = Date.now();
    const back = await vmApi.download(vm, "/tmp/rt.bin");
    const downMs = Date.now() - t1;
    const identical = !!back && Buffer.compare(Buffer.from(back), bytes) === 0;
    const sha = await vmApi.exec(vm, "sha256sum /tmp/rt.bin", { timeoutSec: 20 });
    const localSha = createHash("sha256").update(bytes).digest("hex");
    const echo = await vmApi.exec(vm, "cat", { stdin: "abc", timeoutSec: 20 });
    await vmApi.upload(vm, "/tmp/up/nested/dir/x.txt", "nested");   // mkdir -p of a fresh directory
    const nested = await vmApi.exec(vm, "cat /tmp/up/nested/dir/x.txt", { timeoutSec: 20 });
    const missing = await vmApi.download(vm, "/tmp/definitely-missing-file");
    return {
      bytes: bytes.length, identical, upMs, downMs, vmSha256Matches: sha.stdout.startsWith(localSha), stdinEcho: echo.stdout,
      nestedUpload: nested.stdout, missingIsNull: missing === null,
      ok: identical && sha.stdout.startsWith(localSha) && echo.stdout === "abc" && nested.stdout === "nested" && missing === null,
    };
  });
  await step("treeKill", async () => {
    const id = await vmApi.spawn(vm, "trap '' TERM; sleep 300 & wait", "/tmp");
    const t0 = Date.now();
    const alive = await vmApi.waitProcess(vm, id, 1000);
    const aliveWaitMs = Date.now() - t0;
    const t1 = Date.now();
    await vmApi.killProcess(vm, id);
    const killMs = Date.now() - t1;
    const t2 = Date.now();
    const killed = await vmApi.waitProcess(vm, id, 5000);
    return {
      processId: id, aliveAfter1s: alive, aliveWaitMs, killMs, killed, killedWaitMs: Date.now() - t2,
      tree_exited: killed.exited, ok: !alive.exited && killed.exited,
    };
  });
  await step("stateRunning", async () => {
    const state = await vmApi.state(vm);
    const running = await vmApi.running();
    return { state, running, ok: state === "running" && running >= 1 };
  });
  out.state = (out.stateRunning as Rec).state;     // the brief's keys `state` and `running`, as plain values
  out.running = (out.stateRunning as Rec).running;
  return out;
}

const okOf = (v: unknown): boolean => !!v && typeof v === "object" && (v as Rec).ok === true;
/** True when every step-5 check met its expectation (metadata.direct and runSelf.ls are record-only). */
export function checksOk(c: Rec): boolean {
  const meta = c.metadata as Rec | undefined;
  return okOf(c.runSelf) && okOf(c.uidDrop) && okOf(c.netns) && okOf(meta?.inNetns) && okOf(c.agentWrapper)
    && okOf(c.timeout) && okOf(c.roundTrip) && okOf(c.treeKill) && okOf(c.stateRunning);
}

const flag = (v: unknown): string => (v === true ? "ok" : v === false ? "FAIL" : "n/a");
function printSummary(r: Rec): void {
  const g = (k: string): Rec => (r[k] ?? {}) as Rec;
  const meta = g("metadata");
  const probes = (r.probes as Array<{ label: string; exit: number }> | undefined) ?? [];
  say("---- dev VM #1 ----");
  say(`id ${r.id} · name ${r.name} · createMs ${r.createMs} · adopted ${r.adopted ?? false}`);
  say(`egress readback verbatim ${JSON.stringify(r.egressReadback)} · readbackOk ${r.readbackOk} · sealRule ${r.sealRule}`);
  say(`first command sealed ${r.firstCommandSealed} · probes ${probes.map((p) => `${p.label}=${p.exit}`).join(" ")} · resealed ${r.resealed}`);
  say(`/run/self: ${String(((g("runSelf").ls ?? {}) as Rec).stdout ?? "").trim().replace(/\n/g, " | ")}`);
  say(`/run/self as uid 65534: ${g("runSelf").asNobodyResult} · uid drop: ${String(g("uidDrop").stdout ?? "").trim()}`);
  say(`metadata direct: ${g("metadata").directResult} · in empty netns: exit=${lastLine(String(((meta.inNetns ?? {}) as Rec).stdout ?? ""))}`);
  say(`/proc/net/dev in netns: ${JSON.stringify(g("netns").interfaces)}`);
  say(`checks · wrapper ${flag(g("agentWrapper").ok)} · timeout->124 ${flag(g("timeout").ok)} · roundTrip ${flag(g("roundTrip").ok)} · treeKill ${flag(g("treeKill").ok)} (tree_exited ${g("treeKill").tree_exited}) · state ${g("stateRunning").state} running ${g("stateRunning").running}`);
  say(`seal state ${r.sealState} · all checks ok ${checksOk(r)}`);
  if (g("runSelf").asNobodyResult !== "blocked") {
    say(`EXPECTATION NOT MET: uid 65534 can write /run/self (${g("runSelf").asNobodyResult}); DESIGN 10.2 expected blocked. Recorded verbatim in runSelf. Not tested further: a write there is forbidden.`);
  }
}

async function cmdCheck(): Promise<number> {
  const prev = readDev();
  if (!prev || typeof prev.id !== "string" || !prev.id) { say("no id in data/devvm.json: nothing to check"); return 1; }
  const vmApi = createVm();
  let vm: VmHandle;
  try { vm = await vmApi.attach(prev.id); } catch (e) { say(`cannot attach ${prev.id}: ${String(e instanceof Error ? e.message : e).slice(0, 200)}`); return 1; }
  const st = await vmApi.state(vm);
  if (st !== "running") { say(`dev VM ${prev.id} is ${st}: not running`); return 2; }
  const chk = await vmApi.reprobe(vm);   // readback + PROBE; touches neither /work nor any process
  const checks = await runChecks(vmApi, vm);
  const merged: Rec = {
    ...prev, egressReadback: chk.readback, readbackOk: chk.readbackOk, probes: chk.probes, resealed: chk.resealed,
    ...checks, sealState: chk.sealed ? "sealed" : "NOT-SEALED", checkedAt: new Date().toISOString(),
  };
  writeDev(merged);
  printSummary(merged);
  return chk.sealed && checksOk(checks) ? 0 : 3;
}

async function cmdCreate(): Promise<number> {
  const x = makeCtx();
  const vmApi = createVm();
  const existing = readDev();
  if (existing && typeof existing.id === "string" && existing.id) {
    say(`REFUSED: data/devvm.json already holds ${existing.id} (${existing.name}). Use --check.`);
    return 1;
  }
  const live = (await x.list()).filter((b) => /^hd-dev1-/.test(b.name ?? "") && b.status !== "destroyed");
  if (live.length > 0) {
    const b = live[0]!;
    say(`ADOPTING the existing dev box ${b.id} ${b.name} (${b.status}); no create`);
    writeDev({
      id: b.id, name: b.name, createdAt: Date.parse(b.data.created_at ?? "") || null, createMs: null, adopted: true,
      sealRule: x.c.sealRule, firstCommandSealed: null, first: null, destroy: null,
    });
    return cmdCheck();
  }
  const prior = readLedger(x.ledgerPath).filter((e) => /^hd-dev1-/.test(e.name) && e.t >= x.now() - DAY_MS);
  if (prior.length > 0) {
    say(`REFUSED: the ledger already has a dev VM attempt in the last 24 h (${prior.map((p) => p.name).join(", ")}). A second create is Main's decision.`);
    return 1;
  }
  const n = await countCreates(x);
  const running = await vmApi.running();
  say(`creates ${n.used24h}/${n.cap} (list ${n.listCount}, ledger ${n.ledgerCount}) · running ${running} · seal rule ${x.c.sealRule}`);
  if (!["192.0.2.1/32", "240.0.0.0/4"].includes(x.c.sealRule)) { say("REFUSED: SEAL_RULE is not 192.0.2.1/32 or 240.0.0.0/4"); return 1; }
  if (running > 0) { say(`REFUSED: ${running} box(es) running (Free runs 1)`); return 1; }
  if (n.used24h >= n.cap) { say(`REFUSED: create ledger at ${n.used24h}/${n.cap}`); return 1; }

  const name = devVmName();
  say(`creating ${name} · s-1vcpu-1gb · devbox:1 · egress [${x.c.sealRule}] at create · no envs`);
  const box = await createBoxCtx(x, name);   // the one create; 502/timeout adoption and the ledger are inside
  const createdAt = Date.now();
  say(`created ${box.sb.id} ${box.name} createMs=${box.createMs} adopted=${box.adopted} attempts=${box.attempts}`);
  try {
    return await finishCreate(x, vmApi, box, createdAt);
  } catch (e) {
    // The box exists: never lose its id. A re-run of --create adopts it through the list; --check works on this record.
    if (!readDev()) {
      writeDev({ id: box.sb.id, name: box.name, createdAt, createMs: box.createMs, sealRule: x.c.sealRule, sealState: "unknown-after-error", destroy: null });
    }
    say(`ERROR after the create: box ${box.sb.id} ${box.name} exists and is recorded in data/devvm.json. Run --check, or tell Main.`);
    throw e;
  }
}

async function finishCreate(x: ReturnType<typeof makeCtx>, vmApi: VmExt, box: Awaited<ReturnType<typeof createBoxCtx>>, createdAt: number): Promise<number> {
  const chk = await proveSealCtx(x, box.sb);   // readback verbatim, then PROBE as the very first command
  const f = chk.first;
  const firstCommandSealed = allClosed(f.probes);
  say(`first readback ${JSON.stringify(f.readback)} readbackOk=${f.readbackOk} · first probes ${f.probes.map((p) => `${p.label}=${p.exit}`).join(" ")} · first command sealed ${firstCommandSealed}`);
  const base: Rec = {
    id: box.sb.id, name: box.name, createdAt, createMs: box.createMs, adopted: box.adopted, sealRule: x.c.sealRule,
    egressReadback: chk.readback, readbackOk: chk.readbackOk, firstCommandSealed, resealed: chk.resealed, probes: chk.probes,
    first: {
      egressReadback: f.readback, readbackOk: f.readbackOk, probes: f.probes, probeStdout: f.probeStdout, probeMs: f.probeMs,
      firstCommandSealed, resealed: chk.resealed,
    },
    notes: chk.notes,
  };
  // Dev exception: every probe exit is non-zero but the readback spelling does not normalize. Keep the box, record the string.
  const devException = !chk.sealed && allClosed(chk.probes) && !chk.readbackOk;
  if (!chk.sealed && !devException) {
    const d = await destroyExact(box.sb.id);   // a probe still exits 0 after setEgress: destroy, stop, RED
    mkdirSync(dirname(DEVVM), { recursive: true });
    writeFileSync(resolve(dirname(DEVVM), "devvm-failed.json"), JSON.stringify({ ...base, destroy: d }, null, 2) + "\n");
    say(`RED: seal not proven (probe still open after setEgress). Destroyed ${box.sb.id}: ${JSON.stringify(d)}. A second create is Main's decision.`);
    return 2;
  }
  if (devException) {
    say(`NOTE: probes closed but readback ${JSON.stringify(chk.readback)} does not normalize to ${x.c.sealRule}. Box kept. Extend normalizeRule with exactly this spelling (and a unit test), then run --check.`);
  }
  const sealState = chk.sealed ? "sealed" : "probes-closed-readback-unnormalized";
  writeDev({ ...base, sealState, phase: "checking", destroy: null });   // the id is on disk before the longer checks run
  const vm = await vmApi.attach(box.sb.id);
  const checks = await runChecks(vmApi, vm);
  const record: Rec = { ...base, ...checks, sealState, phase: "ready", checkedAt: new Date().toISOString(), destroy: null };
  writeDev(record);
  printSummary(record);
  return chk.sealed && checksOk(checks) ? 0 : 3;
}

async function cmdDestroy(): Promise<number> {
  const prev = readDev();
  if (!prev || typeof prev.id !== "string" || !prev.id) { say("no id in data/devvm.json"); return 1; }
  if (prev.destroy) { say(`already recorded: ${JSON.stringify(prev.destroy)}`); return 1; }
  const vmApi = createVm();
  const d = await destroyExact(prev.id);   // the only code path that destroys dev VM #1
  const runningAfter = await vmApi.running().catch(() => null);
  writeDev({ ...prev, destroy: { ms: d.ms, ok: d.ok, status: d.status, runningAfter, at: new Date().toISOString() } });
  say(`destroy ${prev.id}: ok=${d.ok} status=${d.status} destroy-to-destroyed ms=${d.ms} runningAfter=${runningAfter}`);
  return d.ok ? 0 : 1;
}

async function main(): Promise<number> {
  const mode = process.argv[2];
  if (mode === "--create") return cmdCreate();
  if (mode === "--check") return cmdCheck();
  if (mode === "--destroy") return cmdDestroy();
  say("usage: npx tsx scripts/smoke-vm.ts --create | --check | --destroy   (--destroy is Main's, at the end of P5)");
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then(
    (code) => { process.exitCode = code; setTimeout(() => process.exit(code), 1500).unref(); },
    (e: unknown) => {
      const m = String(e instanceof Error ? `${e.name}: ${e.message}` : e).slice(0, 400);
      say(`ERROR ${m}`);
      if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|fetch failed|ConnectionError/i.test(m)) {
        say("NETWORK ERROR: stop and tell Main. Do not retry, do not touch network settings.");
      }
      process.exitCode = 1;
      setTimeout(() => process.exit(1), 1500).unref();
    },
  );
}
