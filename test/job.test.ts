import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult, Vm, VmHandle } from "../src/contracts.js";
import { HOST_CHECK_SCRIPT, gen, hostCheck, jobFiles, loadJob, mulberry32, ref } from "../src/jobs.js";

const REF_PY = "jobs/csv-reconcile/ref_solution.py";
const job = loadJob("csv-reconcile");
const fastJob = loadJob("csv-reconcile-fast");
const vm: VmHandle = { id: "mock", name: "mock", createdAt: 0 };

function py(input: string): string {
  const r = spawnSync("python3", ["-I", REF_PY], { input, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

interface MockOpts {
  mutate?: (name: string, out: string) => string;
  rc?: (name: string) => number;
  drop?: (name: string) => boolean;
  throwOnExec?: boolean;
  timedOut?: boolean;
}

// A Vm whose exec decodes the stdin lines, runs the local reference per case and prints the script's lines.
function mockVm(o: MockOpts = {}): Vm {
  return {
    async exec(_vm: VmHandle, bash: string, opts?: { timeoutSec?: number; stdin?: string }): Promise<ExecResult> {
      assert.equal(bash, HOST_CHECK_SCRIPT);
      assert.equal(opts?.timeoutSec, 35);
      if (o.throwOnExec) throw new Error("exec boom");
      const out: string[] = [];
      for (const line of (opts?.stdin ?? "").split("\n")) {
        const [name, b64] = line.split(" ");
        if (!name) continue;
        if (o.drop?.(name)) continue;
        const input = Buffer.from(b64, "base64").toString("utf8");
        const t0 = process.hrtime.bigint();
        const r = spawnSync("python3", ["-I", REF_PY], { input, encoding: "utf8" });
        const ns = process.hrtime.bigint() - t0;
        const rc = o.rc ? o.rc(name) : (r.status ?? 1);
        const text = o.mutate ? o.mutate(name, r.stdout) : r.stdout;
        out.push(`${name}.in rc=${rc} ns=${ns} out=${Buffer.from(text).toString("base64")}`);
      }
      return { exit: 0, stdout: out.join("\n") + "\n", stderr: "", ms: 1, timedOut: o.timedOut ?? false };
    },
  } as unknown as Vm;
}

test("ref matches the three example outputs", () => {
  assert.equal(job.visible.length, 3);
  for (const ex of job.visible) assert.equal(ref(ex.input), ex.expected, ex.name);
  assert.equal(ref("id,merchant,type,amount\n"), "");
  assert.equal(ref("id,merchant,type,amount\nr1,m,refund,1.50\nr1,m,charge,9.00\nr2,n,charge,1.50\nr3,n,refund,1.50\n"), "m,-150\nn,0\n");
  assert.equal(ref("id,merchant,type,amount\r\na,x,charge,0.07\r\n"), "x,7\n");
});

test("ref and ref_solution.py agree on the examples and gen(1..200)", () => {
  for (const ex of job.visible) assert.equal(py(ex.input), ref(ex.input), ex.name);
  for (let s = 1; s <= 200; s++) {
    const input = gen(s);
    assert.equal(py(input), ref(input), `seed ${s}`);
  }
  assert.equal(py("id,merchant,type,amount\n"), "");
});

test("gen is deterministic, varies by seed, never header-only, amounts have two decimals", () => {
  assert.equal(gen(7), gen(7));
  assert.notEqual(gen(7), gen(8));
  const a = mulberry32(42), b = mulberry32(42);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
  let sawRefund = false, sawDup = false;
  for (let s = 1; s <= 200; s++) {
    const input = gen(s);
    const lines = input.split("\n");
    assert.equal(lines[0], "id,merchant,type,amount");
    assert.equal(lines[lines.length - 1], "");
    const rows = lines.slice(1, -1);
    assert.ok(rows.length >= 3 && rows.length <= 40, `rows ${rows.length}`);
    const ids = new Set<string>();
    const merchants = new Set<string>();
    for (const r of rows) {
      const [id, m, type, amount] = r.split(",");
      assert.match(amount, /^\d{1,3}\.\d{2}$/);
      const v = Number(amount);
      assert.ok(v >= 0.01 && v <= 999.99, amount);
      assert.match(m, /^[a-z]+$/);
      assert.ok(type === "charge" || type === "refund");
      if (type === "refund") sawRefund = true;
      if (ids.has(id)) sawDup = true;
      ids.add(id);
      merchants.add(m);
    }
    assert.ok(merchants.size <= 12);
    assert.notEqual(ref(input), "", `seed ${s}`);
  }
  assert.ok(sawRefund && sawDup);
});

test("check.sh passes the reference and fails a broken solution", () => {
  const d = mkdtempSync(join(tmpdir(), "chk-"));
  mkdirSync(join(d, "examples"));
  for (const f of ["1.in", "1.out", "2.in", "2.out", "3.in", "3.out"]) copyFileSync(`jobs/csv-reconcile/examples/${f}`, join(d, "examples", f));
  copyFileSync(REF_PY, join(d, "solution.py"));
  const ok = spawnSync("bash", ["jobs/csv-reconcile/check.sh"], { env: { ...process.env, WORK: d, TMPDIR: d }, encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /3\/3/);
  writeFileSync(join(d, "solution.py"), "print('acme,1')\n");
  const bad = spawnSync("bash", ["jobs/csv-reconcile/check.sh"], { env: { ...process.env, WORK: d, TMPDIR: d }, encoding: "utf8" });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stdout, /FAIL example 1/);
  assert.match(bad.stdout, /0\/3/);
});

test("hostCheck: reference passes csv-reconcile 3/3", async () => {
  const r = await hostCheck(mockVm(), vm, job, 123);
  assert.equal(r.pass, true, r.log);
  assert.deepEqual(r.cases.map((c) => c.name), ["v1", "v2", "v3"]);
  assert.ok(r.cases.every((c) => c.pass && c.rc === 0));
  assert.match(r.log, /^host check: 3\/3 cases passed · csv-reconcile\n/);
  assert.match(r.log, /PASS v1 · \d+(\.\d)? ms/);
  assert.ok(Buffer.byteLength(r.log) <= 4096);
});

test("hostCheck: -fast never passes (real python startup is far above 0.5 ms)", async () => {
  const r = await hostCheck(mockVm(), vm, fastJob, 123);
  assert.equal(r.pass, false);
  assert.deepEqual(r.cases.map((c) => c.name), ["v1", "v2", "v3", "f1", "f2", "f3"]);
  assert.ok(r.cases.every((c) => !c.pass && c.rc === 0 && c.ms > 0.5), r.log);
  assert.match(r.log, /^host check: 0\/6 cases passed · csv-reconcile-fast · limit 0\.5 ms per run\n/);
  assert.match(r.log, /FAIL v1 · [\d.]+ ms > 0\.5 ms limit \(output correct\)/);
  assert.ok(Buffer.byteLength(r.log) <= 4096);
});

test("hostCheck: wrong output, nonzero exit, missing line, exec failure and timeout all fail", async () => {
  const wrong = await hostCheck(mockVm({ mutate: (n, o) => (n === "v1" ? o.replace("beta,250", "beta,25") : o) }), vm, job, 5);
  assert.equal(wrong.pass, false);
  assert.deepEqual(wrong.cases.map((c) => c.pass), [false, true, true]);
  assert.match(wrong.log, /FAIL v1 · wrong output · line 2: expected "beta,250" got "beta,25"/);
  assert.match(wrong.log, /^host check: 2\/3/);

  const rc1 = await hostCheck(mockVm({ rc: (n) => (n === "v2" ? 1 : 0) }), vm, job, 5);
  assert.equal(rc1.pass, false);
  assert.equal(rc1.cases[1].rc, 1);
  assert.match(rc1.log, /FAIL v2 · exit 1/);

  const missing = await hostCheck(mockVm({ drop: (n) => n === "v3" }), vm, job, 5);
  assert.equal(missing.pass, false);
  assert.equal(missing.cases[2].pass, false);
  assert.match(missing.log, /FAIL v3 · no result/);

  for (const o of [{ throwOnExec: true }, { timedOut: true }]) {
    const r = await hostCheck(mockVm(o), vm, job, 5);
    assert.equal(r.pass, false);
    assert.ok(r.cases.every((c) => !c.pass));
  }
});

test("hostCheck: log stays within 4096 bytes even when every case fails with long output", async () => {
  const long = "x".repeat(5000) + ",1\n";
  const r = await hostCheck(mockVm({ mutate: () => long }), vm, fastJob, 9);
  assert.equal(r.pass, false);
  assert.ok(Buffer.byteLength(r.log) <= 4096);
});

test("hostCheck sends one line per case over stdin and no expected output", async () => {
  let seen = "";
  const base = mockVm();
  const spy = { exec: (v: VmHandle, b: string, o?: { timeoutSec?: number; stdin?: string }) => { seen = o?.stdin ?? ""; return base.exec(v, b, o); } } as unknown as Vm;
  await hostCheck(spy, vm, fastJob, 1000);
  const lines = seen.trim().split("\n");
  assert.equal(lines.length, 6);
  assert.deepEqual(lines.map((l) => l.split(" ")[0]), ["v1", "v2", "v3", "f1", "f2", "f3"]);
  assert.equal(Buffer.from(lines[3].split(" ")[1], "base64").toString("utf8"), gen(1001));
});

test("jobFiles: 8 uploads with the right paths; -fast SPEC differs by the last line only", () => {
  const files = jobFiles(job);
  assert.equal(files.length, 8);
  assert.deepEqual(
    files.map((f) => f.path).sort(),
    ["/work/SPEC.md", "/work/check.sh", ...[1, 2, 3].flatMap((n) => [`/work/examples/${n}.in`, `/work/examples/${n}.out`])].sort(),
  );
  assert.equal(files.find((f) => f.path === "/work/SPEC.md")!.data, readFileSync("jobs/csv-reconcile/SPEC.md", "utf8"));
  assert.equal(jobFiles(fastJob).length, 8);
  assert.equal(job.title, "Net payouts per merchant");
  assert.equal(fastJob.title, "Net payouts per merchant (under 0.5 ms)");
  assert.equal(job.freshCases, 0);
  assert.equal(job.maxRuntimeMs, undefined);
  assert.equal(fastJob.freshCases, 3);
  assert.equal(fastJob.maxRuntimeMs, 0.5);
  assert.deepEqual(fastJob.visible, job.visible);
  const plain = job.specMd, fast = fastJob.specMd;
  assert.ok(plain.endsWith("\n") && fast.startsWith(plain));
  assert.equal(fast.slice(plain.length), "Performance: the program must finish in under 0.5 ms, measured from process start to exit.\n");
});
