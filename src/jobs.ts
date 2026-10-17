// src/jobs.ts: the job pack ("Net payouts per merchant"), its reference answer, the seeded generator
// and the host check that is the authority behind submit. Data files resolve from process.cwd().
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckCase, CheckResult, Example, JobId, JobSpec, Vm, VmHandle } from "./contracts.js";

const TITLES: Record<JobId, string> = {
  "csv-reconcile": "Net payouts per merchant",
  "csv-reconcile-fast": "Net payouts per merchant (under 0.5 ms)",
};

const HEADER = "id,merchant,type,amount";

// ── Reference answer (server only; never shipped to a VM) ────────────────
export function ref(input: string): string {
  const seen = new Set<string>();
  const net = new Map<string, number>();
  for (const raw of input.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line === "" || line === HEADER) continue;
    const parts = line.split(",");
    if (parts.length !== 4) continue;
    const [id, merchant, type, amount] = parts;
    if (seen.has(id)) continue;
    seen.add(id);
    const dot = amount.indexOf(".");
    const whole = parseInt(dot < 0 ? amount : amount.slice(0, dot), 10);
    const frac = dot < 0 ? 0 : parseInt(amount.slice(dot + 1, dot + 3).padEnd(2, "0"), 10);
    const cents = whole * 100 + frac;
    net.set(merchant, (net.get(merchant) ?? 0) + (type === "refund" ? -cents : cents));
  }
  const names = [...net.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return names.length ? names.map((m) => `${m},${net.get(m)}`).join("\n") + "\n" : "";
}

// ── Seeded generator ─────────────────────────────────────────────────────
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const POOL = [
  "acme", "beta", "cafe", "delta", "echo", "fable", "gamma", "harbor",
  "iris", "juno", "kilo", "lumen", "mosaic", "nova", "orbit",
];

export function gen(seed: number): string {
  const rnd = mulberry32(seed);
  const pick = (n: number) => Math.floor(rnd() * n);
  const merchantCount = 8 + pick(5); // 8-12
  const start = pick(POOL.length);
  const merchants: string[] = [];
  for (let i = 0; i < merchantCount; i++) merchants.push(POOL[(start + i) % POOL.length]);
  const rowCount = 3 + pick(38); // 3-40
  const rows: string[] = [];
  const ids: string[] = [];
  for (let i = 0; i < rowCount; i++) {
    const type = rnd() < 0.25 ? "refund" : "charge";
    const cents = 1 + pick(99999); // 0.01 to 999.99
    const amount = `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
    let id = `t${i + 1}`;
    if (ids.length > 0 && rnd() < 0.1) id = ids[pick(ids.length)]; // duplicate id, different values
    else ids.push(id);
    rows.push(`${id},${merchants[pick(merchants.length)]},${type},${amount}`);
  }
  return `${HEADER}\n${rows.join("\n")}\n`;
}

// ── Job loading (cwd-relative, so it also works from dist/) ──────────────
const JOBS_DIR = "jobs";
const SHARED = "csv-reconcile"; // the -fast job reuses its examples and check.sh

function read(...parts: string[]): string {
  return readFileSync(join(process.cwd(), JOBS_DIR, ...parts), "utf8");
}

export function loadJob(id: JobId): JobSpec {
  if (!(id in TITLES)) throw new Error(`unknown job: ${String(id)}`);
  const visible: Example[] = [1, 2, 3].map((n) => ({
    name: `v${n}`,
    input: read(SHARED, "examples", `${n}.in`),
    expected: read(SHARED, "examples", `${n}.out`),
  }));
  const fast = id === "csv-reconcile-fast";
  const job: JobSpec = {
    id,
    title: TITLES[id],
    specMd: read(id, "SPEC.md"),
    visible,
    freshCases: fast ? 3 : 0,
    gen,
    ref,
  };
  if (fast) job.maxRuntimeMs = 0.5;
  return job;
}

// The 8 uploads that make the work directory: SPEC.md, the visible examples, check.sh.
export function jobFiles(job: JobSpec): { path: string; data: string }[] {
  const files: { path: string; data: string }[] = [{ path: "/work/SPEC.md", data: job.specMd }];
  job.visible.forEach((ex, i) => {
    files.push({ path: `/work/examples/${i + 1}.in`, data: ex.input });
    files.push({ path: `/work/examples/${i + 1}.out`, data: ex.expected });
  });
  files.push({ path: "/work/check.sh", data: read(SHARED, "check.sh") });
  return files;
}

// ── Host check: the authority behind submit ──────────────────────────────
// One exec. Inputs arrive on stdin, one line per case: "<name> <base64 of the input>".
// Each case runs under a 4 s hard kill and without network (unshare -n), so agent-written code
// cannot hang the check or reach the VM's loopback services. The server compares; the VM never sees expected output.
export const HOST_CHECK_SCRIPT = [
  "set -u; rm -rf /tmp/hc && mkdir -p /tmp/hc",
  'while read -r n b; do [ -n "$n" ] && printf \'%s\' "$b" | base64 -d > "/tmp/hc/$n.in"; done',
  'for f in /tmp/hc/*.in; do s=$(date +%s%N); timeout -s KILL 4 unshare -n python3 /work/solution.py < "$f" > /tmp/hc/o 2>/dev/null; rc=$?',
  '  e=$(date +%s%N); echo "$(basename "$f") rc=$rc ns=$((e-s)) out=$(head -c 65536 /tmp/hc/o | base64 -w0)"; done',
  "",
].join("\n");

const LOG_MAX = 4096;
const LINE_RE = /^(\S+)\.in rc=(-?\d+) ns=(\d+) out=(\S*)$/;

function clip(s: string, n = 60): string {
  const one = s.replace(/[\r\n]+/g, "\\n");
  return one.length > n ? one.slice(0, n) + "…" : one;
}

function firstDiff(want: string, got: string): string {
  const w = want.split("\n");
  const g = got.split("\n");
  for (let i = 0; i < Math.max(w.length, g.length); i++) {
    if (w[i] !== g[i]) return `line ${i + 1}: expected "${clip(w[i] ?? "<none>")}" got "${clip(g[i] ?? "<none>")}"`;
  }
  return "outputs differ";
}

function capLog(log: string): string {
  if (Buffer.byteLength(log) <= LOG_MAX) return log;
  let s = log;
  while (Buffer.byteLength(s) > LOG_MAX - 3) s = s.slice(0, -Math.max(1, Math.ceil((Buffer.byteLength(s) - (LOG_MAX - 3)) / 3)));
  return s + "…";
}

export async function hostCheck(vmApi: Vm, vm: VmHandle, job: JobSpec, seed: number): Promise<CheckResult> {
  const inputs: { name: string; input: string; expected: string }[] = job.visible.map((ex, i) => ({
    name: `v${i + 1}`,
    input: ex.input,
    expected: job.ref(ex.input),
  }));
  for (let i = 1; i <= job.freshCases; i++) {
    const input = job.gen(seed + i);
    inputs.push({ name: `f${i}`, input, expected: job.ref(input) });
  }
  const stdin = inputs.map((c) => `${c.name} ${Buffer.from(c.input, "utf8").toString("base64")}`).join("\n") + "\n";

  const results = new Map<string, { rc: number; ns: number; out: string }>();
  let failure = "";
  try {
    const r = await vmApi.exec(vm, HOST_CHECK_SCRIPT, { stdin, timeoutSec: 35 });
    if (r.timedOut) failure = "host check timed out";
    else if (r.exit !== 0) failure = `host check exec exit ${r.exit}`;
    for (const line of r.stdout.split("\n")) {
      const m = LINE_RE.exec(line.trim());
      if (m) results.set(m[1], { rc: Number(m[2]), ns: Number(m[3]), out: Buffer.from(m[4], "base64").toString("utf8") });
    }
  } catch (e) {
    failure = `host check exec failed: ${clip(e instanceof Error ? e.message : String(e), 120)}`;
  }
  if (failure) results.clear(); // fail closed: a timed-out or failed exec proves nothing

  const limit = job.maxRuntimeMs;
  const cases: CheckCase[] = [];
  const lines: string[] = [];
  for (const c of inputs) {
    const r = results.get(c.name);
    if (!r) {
      cases.push({ name: c.name, pass: false, rc: -1, ms: 0 });
      lines.push(`FAIL ${c.name} · no result${failure ? ` (${failure})` : ""}`);
      continue;
    }
    const msExact = r.ns / 1e6;
    const ms = Math.round(msExact * 10) / 10;
    const outOk = r.out.trimEnd() === c.expected.trimEnd();
    const fast = limit === undefined || msExact < limit;
    const pass = r.rc === 0 && outOk && fast;
    cases.push({ name: c.name, pass, rc: r.rc, ms });
    if (r.rc !== 0) lines.push(`FAIL ${c.name} · exit ${r.rc}`);
    else if (!outOk) lines.push(`FAIL ${c.name} · wrong output · ${firstDiff(c.expected.trimEnd(), r.out.trimEnd())}`);
    else if (!fast) lines.push(`FAIL ${c.name} · ${ms} ms > ${limit} ms limit (output correct)`);
    else lines.push(`PASS ${c.name} · ${ms} ms`);
  }
  const passed = cases.filter((c) => c.pass).length;
  const head = `host check: ${passed}/${cases.length} cases passed · ${job.id}${limit !== undefined ? ` · limit ${limit} ms per run` : ""}`;
  return { pass: cases.length > 0 && passed === cases.length, cases, log: capLog([head, ...lines].join("\n")) };
}
