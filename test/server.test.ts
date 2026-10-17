// test/server.test.ts: fakes only, createApp on port 8795, zero network, zero sandbox creates.
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { Lane, Run, RunEvent } from "../src/contracts.js";
import { createBus, type Bus } from "../src/bus.js";
import { bootReap, createApp, describeReaped, readVersion, redact, resolveStatic, type AppDeps, type StartRunRequest } from "../src/server.js";
import { ExportError, exportReplay, ptClock, refuseReason, replayLabel, toReplay, upsertIndex } from "../scripts/export-replay.js";

const PORT = 8795;
const TOKEN = "test-admin-token-" + "x".repeat(24);   // a made-up test value, not a secret
const tmp = mkdtempSync(path.join(os.tmpdir(), "holdout-web-"));
const pubDir = path.join(tmp, "public");
let slowest = { ms: 0, what: "" };

before(() => {
  mkdirSync(path.join(pubDir, "sub"), { recursive: true });
  writeFileSync(path.join(pubDir, "index.html"), "<!doctype html><title>Holdout</title><p>hello</p>");
  writeFileSync(path.join(pubDir, "app.js"), "export {};");
  writeFileSync(path.join(pubDir, "style.css"), "body{}");
  writeFileSync(path.join(pubDir, "sub", "x.svg"), "<svg/>");
  writeFileSync(path.join(pubDir, ".hidden"), "DOT_MARKER");
  writeFileSync(path.join(pubDir, "sub", ".hidden"), "DOT_MARKER");
  writeFileSync(path.join(tmp, "package.json"), '{"secret":"PKG_MARKER"}');
  writeFileSync(path.join(tmp, "outside.txt"), "OUTSIDE_MARKER");
  symlinkSync(path.join(tmp, "outside.txt"), path.join(pubDir, "link.txt"));
});
after(() => {
  rmSync(tmp, { recursive: true, force: true });
  console.log(`slowest test request: ${Math.round(slowest.ms)} ms (${slowest.what})`);
});

// ── fixtures ────────────────────────────────────────────────────────────
let seed = 0;
function makeRun(over: Partial<Run> = {}): Run {
  return {
    runId: `r${(++seed).toString(16).padStart(7, "0")}`, mode: "fuse", source: "live", label: "LIVE", jobId: "csv-reconcile",
    rateCard: { version: "rc1", vmMicrosPerSec: 20000, inMicrosPerTok: 15, outMicrosPerTok: 75, infraMicrosPerSec: 13.3,
      listInMicrosPerTok: 4, listOutMicrosPerTok: 20, minChargeCents: 50 },
    concurrency: 1, vmMode: "fresh", onTrip: "metered", startedAt: Date.UTC(2026, 9, 17, 22, 42), lanes: [], ...over,
  };
}
function makeLane(over: Partial<Lane> = {}): Lane {
  return {
    laneId: "A", contractor: "honest", provenance: "live-model", jobId: "csv-reconcile", state: "queued",
    caps: { holdCents: 500, timeCapSec: 120 },
    meter: { workSec: 0, vmSeconds: 0, tokensIn: 0, tokensOut: 0, turns: 0, costMicros: 0, infraMicros: 0, listTokenMicros: 0, estimatedTokens: false },
    ...over,
  };
}
type Over = Partial<Omit<AppDeps, "cfg">> & { cfg?: Partial<AppDeps["cfg"]> };
function makeDeps(over: Over = {}) {
  const calls = { startRun: [] as StartRunRequest[], creates: 0, running: 0, trips: [] as string[], retrieve: [] as string[] };
  const bus = over.bus ?? createBus();
  const base: AppDeps = {
    bus,
    vm: { creates: async () => { calls.creates++; return { used24h: 3, cap: 10 }; }, running: async () => { calls.running++; return 0; } },
    pay: { retrieve: async (id) => { calls.retrieve.push(id); return { status: "requires_capture", amount: 500, amountReceived: 0, metadata: { pi: id } }; } },
    startRun: (req, b) => { calls.startRun.push(req); const run = makeRun({ mode: req.mode }); b.register(run); return { runId: run.runId }; },
    tripRun: (id) => { calls.trips.push(id); return true; },
    ping: { createos: async () => "ok", stripe: async () => "ok", router: async () => "ok" },
    cfg: { adminToken: TOKEN, version: "test", notary: false, concurrency: 1, vmMode: "fresh", onTrip: "metered", rateCard: "rc1", forceCreate: false },
    publicDir: pubDir,
  };
  const deps: AppDeps = { ...base, ...over, bus, cfg: { ...base.cfg, ...over.cfg } };
  return { deps, calls, bus };
}

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string; json: any; ms: number }
function call(method: string, p: string, o: { token?: string; body?: string | object; headers?: Record<string, string> } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const headers: Record<string, string> = { ...o.headers };
    let payload: string | undefined;
    if (o.body !== undefined) {
      payload = typeof o.body === "string" ? o.body : JSON.stringify(o.body);
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(payload));
    }
    if (o.token !== undefined) headers.authorization = `Bearer ${o.token}`;
    const req = http.request({ host: "127.0.0.1", port: PORT, method, path: p, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const ms = performance.now() - t0;
        if (ms > slowest.ms) slowest = { ms, what: `${method} ${p.slice(0, 40)}` };
        const body = Buffer.concat(chunks).toString("utf8");
        let json: any;
        try { json = JSON.parse(body); } catch { /* not JSON */ }
        if (ms >= 2000) reject(new Error(`${method} ${p} took ${Math.round(ms)} ms`));
        else resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json, ms });
      });
    });
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error(`timeout: ${method} ${p}`)));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
async function withApp<T>(deps: AppDeps, fn: () => Promise<T>): Promise<T> {
  const server = createApp(deps);
  await new Promise<void>((ok, bad) => { server.once("error", bad); server.listen(PORT, "127.0.0.1", ok); });
  try { return await fn(); }
  finally {
    server.closeAllConnections();
    await new Promise<void>((ok) => server.close(() => ok()));
    await new Promise((ok) => setTimeout(ok, 30));   // lets the fetch pool see its sockets close before the next app listens
  }
}
const START = { mode: "fuse", lanes: ["honest"] };
const post = (body: string | object = START, token: string | null = TOKEN) => call("POST", "/api/runs", { token: token ?? undefined, body });

// ── static files ────────────────────────────────────────────────────────
describe("static files", () => {
  it("serves public/index.html at / and /index.html, and the assets with their types", async () => {
    await withApp(makeDeps().deps, async () => {
      for (const p of ["/", "/index.html", "/?run=abc&speed=2"]) {
        const r = await call("GET", p);
        assert.equal(r.status, 200, p);
        assert.match(String(r.headers["content-type"]), /^text\/html/);
        assert.match(r.body, /<title>Holdout<\/title>/);
      }
      const head = await call("HEAD", "/");
      assert.equal(head.status, 200);
      assert.equal(head.body, "");
      assert.match(String((await call("GET", "/app.js")).headers["content-type"]), /^text\/javascript/);
      assert.match(String((await call("GET", "/style.css")).headers["content-type"]), /^text\/css/);
      assert.equal((await call("GET", "/sub/x.svg")).headers["content-type"], "image/svg+xml");
    });
  });

  it("answers 404 to traversal, encoded traversal, dotfiles, symlinks out and files outside public/", async () => {
    await withApp(makeDeps().deps, async () => {
      const paths = [
        "/../package.json", "/%2e%2e/package.json", "/%2E%2E/package.json", "/%2e%2e%2fpackage.json", "/..%2fpackage.json",
        "/sub/../../package.json", "/..%5cpackage.json", "/.env.local", "/.env", "/.hidden", "/sub/.hidden", "/%2ehidden",
        "/link.txt", "/package.json", "/replays/index.json", "/src/server.ts", "/data/runs.md", "/%00", "/%", "/sub/", "//package.json",
      ];
      for (const p of paths) {
        const r = await call("GET", p);
        assert.equal(r.status, 404, p);
        assert.doesNotMatch(r.body, /PKG_MARKER|OUTSIDE_MARKER|DOT_MARKER/, p);
      }
    });
  });

  it("resolveStatic maps only into the root", () => {
    const root = path.resolve(pubDir);
    assert.equal(resolveStatic(root, "/"), path.join(root, "index.html"));
    assert.equal(resolveStatic(root, "/sub/x.svg"), path.join(root, "sub", "x.svg"));
    for (const p of ["/..", "/../x", "/%2e%2e/x", "/a/.b", "/a%00b", "/a\\b", "/%zz"]) assert.equal(resolveStatic(root, p), null, p);
  });

  it("non-GET on a page path is 405, unknown API paths are JSON 404, and the catcher routes are 404", async () => {
    await withApp(makeDeps().deps, async () => {
      assert.equal((await call("POST", "/")).status, 405);
      const nope = await call("GET", "/api/nope");
      assert.equal(nope.status, 404);
      assert.deepEqual(nope.json, { error: "not found" });
      assert.equal((await call("GET", "/api/catcher")).status, 404);
      assert.equal((await call("POST", "/api/catcher/abc123")).status, 404);
      assert.equal((await call("GET", "/api/runs/..%2f..")).status, 404);
      assert.equal((await call("DELETE", "/api/runs")).status, 405);
    });
  });
});

// ── health ──────────────────────────────────────────────────────────────
describe("GET /api/health", () => {
  it("has the documented shape and no-store caching", async () => {
    await withApp(makeDeps().deps, async () => {
      const r = await call("GET", "/api/health");
      assert.equal(r.status, 200);
      assert.match(String(r.headers["content-type"]), /^application\/json/);
      assert.equal(r.headers["cache-control"], "no-store");
      assert.deepEqual(r.json, {
        ok: true, version: "test", notary: false, concurrency: 1, vmMode: "fresh", onTrip: "metered", rateCard: "rc1",
        creates: { used24h: 3, cap: 10 }, running: 0,
      });
    });
  });

  it("reports running and creates as null when upstream does not answer in 1.5 s, then answers from its 5 s cache", async () => {
    const { deps } = makeDeps({ vm: { creates: () => new Promise(() => {}), running: async () => { throw new Error("whoami down"); } } });
    await withApp(deps, async () => {
      const r = await call("GET", "/api/health");
      assert.equal(r.status, 200);
      assert.equal(r.json.running, null);
      assert.equal(r.json.creates, null);
      assert.ok(r.ms >= 1300 && r.ms < 2000, `${r.ms}`);
      const again = await call("GET", "/api/health");
      assert.ok(again.ms < 300, `cached answer took ${again.ms}`);
      assert.equal(again.json.running, null);
    });
  });

  it("asks upstream once per 5 s however many polls arrive", async () => {
    const { deps, calls } = makeDeps();
    await withApp(deps, async () => {
      await Promise.all([call("GET", "/api/health"), call("GET", "/api/health"), call("GET", "/api/health")]);
      await call("GET", "/api/health");
      assert.equal(calls.creates, 1);
      assert.equal(calls.running, 1);
    });
  });
});

// ── admin and POST /api/runs ────────────────────────────────────────────
describe("POST /api/runs: admin", () => {
  it("401 without a token, with a wrong token, with a wrong scheme; 202 {runId} with the right one", async () => {
    const { deps, calls } = makeDeps();
    await withApp(deps, async () => {
      assert.equal((await post(START, null)).status, 401);
      assert.equal((await post(START, "wrong")).status, 401);
      assert.equal((await post(START, "x".repeat(TOKEN.length))).status, 401);   // same length, wrong bytes
      assert.equal((await call("POST", "/api/runs", { body: START, headers: { authorization: `Basic ${TOKEN}` } })).status, 401);
      assert.equal(calls.startRun.length, 0);
      const ok = await post();
      assert.equal(ok.status, 202);
      assert.equal(typeof ok.json.runId, "string");
      assert.equal(ok.json.runId, deps.bus.liveRunId());
      assert.deepEqual(calls.startRun, [{ mode: "fuse", lanes: ["honest"], holdCents: 500, timeCapSec: 120 }]);
    });
  });

  it("with no ADMIN_TOKEN configured every admin route answers 401", async () => {
    const { deps, bus } = makeDeps({ cfg: { adminToken: undefined } });
    const run = makeRun();
    bus.register(run);
    await withApp(deps, async () => {
      for (const token of [undefined, "", " ", "undefined", TOKEN]) {
        assert.equal((await post(START, token ?? null)).status, 401, String(token));
        assert.equal((await call("POST", `/api/runs/${run.runId}/trip`, { token })).status, 401);
        assert.equal((await call("GET", "/api/selfcheck", { token })).status, 401);
      }
    });
  });
});

describe("POST /api/runs: 409 and 503 rules", () => {
  it("a second POST while a run is live is 409; after run.finished it starts again", async () => {
    const { deps, bus } = makeDeps();
    await withApp(deps, async () => {
      const first = await post();
      assert.equal(first.status, 202);
      const second = await post();
      assert.equal(second.status, 409);
      assert.equal(second.json.reason, "live");
      bus.finish(first.json.runId);
      assert.equal((await post()).status, 202);
    });
  });

  it("two POSTs at the same moment start exactly one run", async () => {
    const slow = { creates: async () => { await new Promise((ok) => setTimeout(ok, 150)); return { used24h: 1, cap: 10 }; }, running: async () => 0 };
    const { deps, calls } = makeDeps({ vm: slow });
    await withApp(deps, async () => {
      const [a, b] = await Promise.all([post(), post()]);
      assert.deepEqual([a.status, b.status].sort(), [202, 409]);
      assert.equal(calls.startRun.length, 1);
      const [c, d] = await Promise.all([post(), post()]);   // the first run is still live: both are refused
      assert.deepEqual([c.status, d.status], [409, 409]);
    });
  });

  it("a refused start (409 or 503) frees the guard, so the next POST can start", async () => {
    let used = 10;
    const { deps } = makeDeps({ vm: { creates: async () => ({ used24h: used, cap: 10 }), running: async () => 0 } });
    await withApp(deps, async () => {
      assert.equal((await post()).status, 409);
      used = 0;
      assert.equal((await post()).status, 202);
    });
  });

  it("fresh mode: ledger at its stop is 409, below it 202, FORCE_CREATE skips the check without calling it", async () => {
    let used = 10;
    const a = makeDeps({ vm: { creates: async () => ({ used24h: used, cap: 10 }), running: async () => 0 } });
    await withApp(a.deps, async () => {
      const r = await post();
      assert.equal(r.status, 409);
      assert.equal(r.json.reason, "ledger");
      assert.match(r.json.error, /create ledger at its stop/);
      used = 11;
      assert.equal((await post()).status, 409);
      used = 9;
      assert.equal((await post()).status, 202);
    });
    const b = makeDeps({ cfg: { forceCreate: true }, vm: { creates: async () => { throw new Error("must not be called"); }, running: async () => 0 } });
    await withApp(b.deps, async () => assert.equal((await post()).status, 202));
  });

  it("fresh mode with concurrency 1: running() > 0 is 409; with concurrency 2 it is 202", async () => {
    const vm = { creates: async () => ({ used24h: 1, cap: 10 }), running: async () => 1 };
    await withApp(makeDeps({ vm }).deps, async () => {
      const r = await post();
      assert.equal(r.status, 409);
      assert.equal(r.json.reason, "slot");
      assert.match(r.json.error, /1 microVM at a time/);
    });
    await withApp(makeDeps({ vm, cfg: { concurrency: 2 } }).deps, async () => assert.equal((await post()).status, 202));
  });

  it("reuse mode skips both checks: running() > 0 and a full ledger still give 202, and neither is called", async () => {
    const calls = { n: 0 };
    const vm = { creates: async () => { calls.n++; return { used24h: 10, cap: 10 }; }, running: async () => { calls.n++; return 1; } };
    await withApp(makeDeps({ vm, cfg: { vmMode: "reuse" } }).deps, async () => {
      assert.equal((await post()).status, 202);
      assert.equal(calls.n, 0);
    });
  });

  it("a check that does not answer within 1.5 s is 503 and no run starts", async () => {
    const hang = () => new Promise<never>(() => {});
    const a = makeDeps({ vm: { creates: hang, running: async () => 0 } });
    await withApp(a.deps, async () => {
      const r = await post();
      assert.equal(r.status, 503);
      assert.equal(r.json.reason, "upstream");
      assert.ok(r.ms >= 1300 && r.ms < 2000, `${r.ms}`);
      assert.equal(a.calls.startRun.length, 0);
    });
    const b = makeDeps({ vm: { creates: async () => ({ used24h: 0, cap: 10 }), running: hang } });
    await withApp(b.deps, async () => assert.equal((await post()).status, 503));
    const c = makeDeps({ vm: { creates: async () => { throw new Error("listSandboxes failed"); }, running: async () => 0 } });
    await withApp(c.deps, async () => assert.equal((await post()).status, 503));
  });

  it("no startRun (run.ts not loaded) is 503 after the admin check", async () => {
    await withApp(makeDeps({ startRun: undefined }).deps, async () => {
      const r = await post();
      assert.equal(r.status, 503);
      assert.equal(r.json.reason, "orchestrator");
      assert.equal((await post({}, null)).status, 401);
    });
  });
});

describe("POST /api/runs: body validation", () => {
  it("400 for anything but a JSON object with a valid mode, 1 to 4 known lanes and in-range numbers", async () => {
    const { deps, calls } = makeDeps();
    await withApp(deps, async () => {
      const bad: Array<[string, string | object]> = [
        ["not JSON", "{nope"], ["empty body", ""], ["null", "null"], ["array", "[]"], ["empty object", {}],
        ["no lanes", { mode: "fuse" }], ["no mode", { lanes: ["honest"] }], ["bad mode", { mode: "notary", lanes: ["honest"] }],
        ["no lane kinds", { mode: "fuse", lanes: [] }], ["5 lanes", { mode: "fuse", lanes: ["honest", "honest", "honest", "honest", "honest"] }],
        ["unknown kind", { mode: "fuse", lanes: ["pirate"] }], ["lanes not an array", { mode: "fuse", lanes: "honest" }],
        ["hold 49", { ...START, holdCents: 49 }], ["hold 10001", { ...START, holdCents: 10001 }], ["hold 1.5", { ...START, holdCents: 50.5 }],
        ["hold string", { ...START, holdCents: "500" }], ["hold null", { ...START, holdCents: null }],
        ["cap 9", { ...START, timeCapSec: 9 }], ["cap 301", { ...START, timeCapSec: 301 }], ["cap string", { ...START, timeCapSec: "120" }],
        ["16 KB+ body", { ...START, pad: "x".repeat(17 * 1024) }],
      ];
      for (const [what, body] of bad) {
        const r = await post(body);
        assert.equal(r.status, 400, what);
        assert.equal(typeof r.json.error, "string", what);
      }
      assert.equal(calls.startRun.length, 0);
    });
  });

  it("accepts the edges and passes the validated request to startRun", async () => {
    const { deps, calls, bus } = makeDeps();
    await withApp(deps, async () => {
      const edges: StartRunRequest[] = [
        { mode: "fuse", lanes: ["honest"], holdCents: 50, timeCapSec: 10 },
        { mode: "fuse+notary", lanes: ["honest", "runaway", "runaway-busyloop", "cheater"], holdCents: 10000, timeCapSec: 300 },
        { mode: "fuse", lanes: ["sloppy"], holdCents: 500, timeCapSec: 120 },
      ];
      for (const body of edges) {
        const r = await post(body);
        assert.equal(r.status, 202, JSON.stringify(body));
        bus.finish(r.json.runId);
      }
      assert.deepEqual(calls.startRun, edges);
    });
  });

  it("a throwing startRun is a 500 {error: internal} that carries no key", async () => {
    const { deps } = makeDeps({ startRun: () => { throw new Error("boom sk_test_" + "a".repeat(30)); } });
    await withApp(deps, async () => {
      const r = await post();
      assert.equal(r.status, 500);
      assert.deepEqual(r.json, { error: "internal" });
      assert.doesNotMatch(r.body, /sk_test_/);
    });
  });
});

describe("trip, runs list, run snapshot", () => {
  it("trip: 401, 404, 503, then 200 {tripped}", async () => {
    const { deps, bus, calls } = makeDeps();
    const run = makeRun();
    bus.register(run);
    await withApp(deps, async () => {
      assert.equal((await call("POST", `/api/runs/${run.runId}/trip`)).status, 401);
      assert.equal((await call("POST", "/api/runs/nosuchrun/trip", { token: TOKEN })).status, 404);
      const ok = await call("POST", `/api/runs/${run.runId}/trip`, { token: TOKEN });
      assert.equal(ok.status, 200);
      assert.deepEqual(ok.json, { tripped: true });
      assert.deepEqual(calls.trips, [run.runId]);
      assert.equal((await call("GET", `/api/runs/${run.runId}/trip`)).status, 405);
    });
    const none = makeDeps({ tripRun: undefined, bus });
    await withApp(none.deps, async () => assert.equal((await call("POST", `/api/runs/${run.runId}/trip`, { token: TOKEN })).status, 503));
    const refuses = makeDeps({ tripRun: () => false, bus });
    await withApp(refuses.deps, async () => {
      assert.deepEqual((await call("POST", `/api/runs/${run.runId}/trip`, { token: TOKEN })).json, { tripped: false });
    });
  });

  it("the run snapshot is the live object; unknown or malformed ids are 404", async () => {
    const { deps, bus } = makeDeps();
    const run = makeRun();
    bus.register(run);
    await withApp(deps, async () => {
      assert.equal((await call("GET", `/api/runs/${run.runId}`)).json.lanes.length, 0);
      run.lanes.push(makeLane({ state: "working" }));
      const snap = await call("GET", `/api/runs/${run.runId}`);
      assert.equal(snap.json.lanes[0].state, "working");
      assert.equal(snap.json.runId, run.runId);
      assert.equal((await call("GET", "/api/runs/zzzz")).status, 404);
      assert.equal((await call("GET", "/api/runs/bad%20id")).status, 404);
      const list = await call("GET", "/api/runs");
      assert.deepEqual(list.json.map((r: { runId: string }) => r.runId), [run.runId]);
      assert.deepEqual(Object.keys(list.json[0]).sort(), ["label", "mode", "runId", "source", "startedAt"]);
    });
  });
});

// ── events and the bus ──────────────────────────────────────────────────
describe("events", () => {
  it("seq runs 1..n with no gaps; after=n is empty; done only after finish", async () => {
    const { deps, bus } = makeDeps();
    const run = makeRun();
    const emit = bus.register(run);
    emit("lane.state", "A", { state: "held" });
    emit("meter.tick", "A", { workSec: 1 });
    await withApp(deps, async () => {
      const all = await call("GET", `/api/runs/${run.runId}/events?after=0`);
      assert.deepEqual(all.json.events.map((e: RunEvent) => e.seq), [1, 2, 3]);
      assert.deepEqual(all.json.events.map((e: RunEvent) => e.type), ["run.started", "lane.state", "meter.tick"]);
      assert.equal(all.json.events[1].laneId, "A");
      assert.equal(all.json.events[0].laneId, undefined);
      assert.equal(all.json.done, false);
      const none = await call("GET", `/api/runs/${run.runId}/events?after=3`);
      assert.deepEqual(none.json, { events: [], done: false });
      assert.deepEqual((await call("GET", `/api/runs/${run.runId}/events`)).json.events.length, 3);
      bus.finish(run.runId);
      bus.finish(run.runId);   // a second finish adds nothing
      const tail = await call("GET", `/api/runs/${run.runId}/events?after=3`);
      assert.deepEqual(tail.json.events.map((e: RunEvent) => e.type), ["run.finished"]);
      assert.equal(tail.json.done, true);
      assert.deepEqual((await call("GET", `/api/runs/${run.runId}/events?after=4`)).json, { events: [], done: true });
      const early = await call("GET", `/api/runs/${run.runId}/events?after=1`);
      assert.equal(early.json.done, true);   // the batch reaches the last event
    });
  });

  it("returns at most 500 per call; done is true only when the batch reaches the last event", async () => {
    const { deps, bus } = makeDeps();
    const run = makeRun();
    const emit = bus.register(run);
    for (let i = 0; i < 1199; i++) emit("meter.tick", "A", { i });
    bus.finish(run.runId);   // 1 + 1199 + 1 = 1201 events
    await withApp(deps, async () => {
      const p1 = await call("GET", `/api/runs/${run.runId}/events?after=0`);
      assert.equal(p1.json.events.length, 500);
      assert.equal(p1.json.done, false);
      const p2 = await call("GET", `/api/runs/${run.runId}/events?after=500`);
      assert.equal(p2.json.events.length, 500);
      assert.equal(p2.json.events[0].seq, 501);
      assert.equal(p2.json.done, false);
      const p3 = await call("GET", `/api/runs/${run.runId}/events?after=1000`);
      assert.equal(p3.json.events.length, 201);
      assert.equal(p3.json.events.at(-1).seq, 1201);
      assert.equal(p3.json.done, true);
    });
  });

  it("400 for an after that is not a non-negative integer; 404 for an unknown run", async () => {
    const { deps, bus } = makeDeps();
    const run = makeRun();
    bus.register(run);
    await withApp(deps, async () => {
      for (const after of ["-1", "abc", "1.5", "", "1e3", "0x10", "%20"]) {
        assert.equal((await call("GET", `/api/runs/${run.runId}/events?after=${after}`)).status, 400, after);
      }
      assert.equal((await call("GET", "/api/runs/nosuchrun/events?after=0")).status, 404);
    });
  });

  it("the run.started payload does not change when run.ts mutates the live run, and payloads are deep copies", () => {
    const bus = createBus();
    const run = makeRun({ lanes: [makeLane()] });
    const emit = bus.register(run);
    const data = { nested: { n: 1 } };
    emit("agent.turn", "A", data);
    run.label = "changed";
    run.lanes[0]!.state = "working";
    run.lanes.push(makeLane({ laneId: "B" }));
    data.nested.n = 99;
    const evs = bus.events(run.runId, 0)!.events;
    const snap = evs[0]!.data as Run;
    assert.equal(snap.label, "LIVE");
    assert.equal(snap.lanes.length, 1);
    assert.equal(snap.lanes[0]!.state, "queued");
    assert.deepEqual(evs[1]!.data, { nested: { n: 1 } });
    assert.equal(bus.get(run.runId), run);   // get() hands back the live object
  });

  it("t counts ms from startedAt; a finished run drops late events; a duplicate runId is refused", () => {
    let clock = 1_000_000;
    const bus = createBus({ now: () => clock });
    const run = makeRun({ startedAt: clock });
    const emit = bus.register(run);
    clock += 250;
    emit("meter.tick", "A", {});
    clock += 250;
    bus.finish(run.runId);
    emit("meter.tick", "A", {});   // dropped, logged once
    emit("meter.tick", "A", {});
    const evs = bus.events(run.runId, 0)!;
    assert.deepEqual(evs.events.map((e) => [e.seq, e.t, e.type]), [[1, 0, "run.started"], [2, 250, "meter.tick"], [3, 500, "run.finished"]]);
    assert.throws(() => bus.register(run), /already registered/);
    assert.equal(bus.events("nope", 0), undefined);
  });

  it("liveRunId is the unfinished live run; list is featured-free for live runs and never shows synthetic", () => {
    const bus = createBus();
    assert.equal(bus.liveRunId(), null);
    const live = makeRun();
    bus.register(live);
    bus.register(makeRun({ source: "synthetic", label: "SYNTHETIC" }));
    bus.register(makeRun({ source: "replay", label: "Recorded run 1" }));
    assert.equal(bus.liveRunId(), live.runId);
    assert.equal(bus.list().length, 2);
    assert.ok(bus.list().every((r) => r.source !== "synthetic" && r.featured === undefined));
    bus.finish(live.runId);
    assert.equal(bus.liveRunId(), null);
  });

  it("JSONL: one line per event under data/runs; an unwritable dir logs once and the events stay in memory", () => {
    const dataDir = path.join(tmp, "data-ok");
    const bus = createBus({ dataDir });
    const run = makeRun();
    const emit = bus.register(run);
    emit("lane.state", "A", { state: "held" });
    bus.finish(run.runId);
    const lines = readFileSync(path.join(dataDir, "runs", `${run.runId}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l) as RunEvent);
    assert.deepEqual(lines, bus.events(run.runId, 0)!.events);

    const blocker = path.join(tmp, "a-file");
    writeFileSync(blocker, "x");
    const warns: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => { warns.push(a.join(" ")); };
    try {
      const mem = createBus({ dataDir: path.join(blocker, "sub") });
      const r2 = makeRun();
      const e2 = mem.register(r2);
      e2("lane.state", "A", {});
      e2("lane.state", "A", {});
    mem.finish(r2.runId);
      assert.equal(mem.events(r2.runId, 0)!.events.length, 4);
    } finally { console.warn = warn; }
    assert.equal(warns.filter((w) => /JSONL off/.test(w)).length, 1);
  });
});

// ── replays ─────────────────────────────────────────────────────────────
const seal = (over: Record<string, unknown> = {}) => ({
  sandboxId: "sb-test", name: "hx-test", createMs: 1000, egressRequested: ["192.0.2.1/32"], egressReadback: ["192.0.2.1/32"],
  readbackOk: true, probes: [], resealed: false, reused: false, ...over,
});
function replayFile(runId: string, over: Partial<Run> = {}, o: { events?: RunEvent[]; receipts?: Record<string, string> } = {}) {
  const run = makeRun({
    runId, source: "replay", label: `Recorded run ${runId} · 15:42 PT · real sandboxes · real Stripe-sandbox PaymentIntents`,
    lanes: [makeLane({ pi: { id: `pi_${runId}`, amountCents: 500, status: "succeeded", amountReceived: 103 } })], ...over,
  });
  const events: RunEvent[] = o.events ?? [
    { seq: 1, t: 0, runId, type: "run.started", data: structuredClone(run) },
    { seq: 2, t: 400, runId, laneId: "A", type: "lane.state", data: { state: "held" } },
    { seq: 3, t: 900, runId, type: "run.finished", data: {} },
  ];
  return { run, events, ...(o.receipts ? { receipts: o.receipts } : {}) };
}
const CANON = '{"a":[1, 2],"z":"é"}\n';
function makeReplayDir(): string {
  const dir = mkdtempSync(path.join(tmp, "replays-"));
  const put = (id: string, f: unknown) => writeFileSync(path.join(dir, `${id}.json`), typeof f === "string" ? f : JSON.stringify(f));
  put("good1", replayFile("good1", { startedAt: 1000 }, { receipts: { A: CANON } }));
  put("good2", replayFile("good2", { startedAt: 2000 }));
  put("synth", replayFile("synth", { source: "synthetic" }));
  put("reused", replayFile("reused", { lanes: [makeLane({ seal: seal({ reused: true }) as Lane["seal"] })] }));
  put("live", replayFile("live", { source: "live" }));
  put("unlisted", replayFile("unlisted"));
  put("synthetic", replayFile("synthetic"));
  put("broken", "{ not json");
  put("gap", replayFile("gap", {}, { events: [{ seq: 1, t: 0, runId: "gap", type: "run.started", data: {} }, { seq: 3, t: 5, runId: "gap", type: "run.finished", data: {} }] }));
  put("snaplive", replayFile("snaplive", {}, { events: [{ seq: 1, t: 0, runId: "snaplive", type: "run.started", data: { source: "live", label: "LIVE" } }] }));
  const ids = ["good1", "good2", "synth", "reused", "live", "synthetic", "broken", "gap", "snaplive", "ghost"];
  writeFileSync(path.join(dir, "index.json"), JSON.stringify({ featured: "good1", runs: ids.map((runId) => ({ runId, label: "x", mode: "fuse", startedAt: 1 })) }));
  return dir;
}

describe("replays", () => {
  it("loads listed replay files and skips synthetic, reused, live, broken, gappy, live-snapshot, unlisted and missing ones", async () => {
    const { deps, bus } = makeDeps();
    const logs: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => { logs.push(a.join(" ")); };
    let loaded: number;
    try { loaded = bus.loadReplays(makeReplayDir()); } finally { console.warn = warn; }
    assert.equal(loaded, 2);
    for (const id of ["synth", "reused", "live", "synthetic", "broken", "gap", "snaplive", "ghost"]) {
      assert.ok(logs.some((l) => l.includes(id)), `a log line names ${id}`);
    }
    assert.deepEqual(bus.list().map((r) => r.runId), ["good1", "good2"]);   // featured first, then newest
    assert.equal(bus.list()[0]!.featured, true);
    assert.equal(bus.list()[1]!.featured, undefined);
    assert.equal(bus.liveRunId(), null);
    await withApp(deps, async () => {
      const list = await call("GET", "/api/runs");
      assert.deepEqual(list.json.map((r: { runId: string }) => r.runId), ["good1", "good2"]);
      assert.deepEqual(list.json[0], { runId: "good1", label: bus.get("good1")!.label, source: "replay", mode: "fuse", startedAt: 1000, featured: true });
      assert.equal(list.json[1].featured, undefined);
      const ev = await call("GET", "/api/runs/good1/events?after=0");
      assert.deepEqual(ev.json.events.map((e: RunEvent) => e.seq), [1, 2, 3]);
      assert.equal(ev.json.done, true);
      assert.equal((await call("GET", "/api/runs/good1")).json.source, "replay");
      for (const id of ["unlisted", "synth", "reused", "live", "synthetic", "broken", "gap", "snaplive", "ghost"]) {
        assert.equal((await call("GET", `/api/runs/${id}`)).status, 404, id);
      }
    });
  });

  it("a minimal replay file (no lanes, no events) loads, and knownPi copes with a run that has no lanes", () => {
    const dir = mkdtempSync(path.join(tmp, "replays-min-"));
    writeFileSync(path.join(dir, "min1.json"), JSON.stringify({ run: { runId: "min1", source: "replay", mode: "fuse", startedAt: 5, label: "Recorded run 1" }, events: [] }));
    writeFileSync(path.join(dir, "index.json"), JSON.stringify({ featured: "min1", runs: [{ runId: "min1" }] }));
    const bus = createBus();
    assert.equal(bus.loadReplays(dir), 1);
    assert.deepEqual(bus.events("min1", 0), { events: [], done: true });
    assert.equal(bus.knownPi("pi_none"), false);
    bus.register({ runId: "nolanes", source: "live" } as unknown as Run);
    assert.equal(bus.knownPi("pi_none"), false);
  });

  it("a missing index loads nothing; a featured id that did not load falls back to the first loaded replay", () => {
    assert.equal(createBus().loadReplays(path.join(tmp, "no-such-dir")), 0);
    const dir = makeReplayDir();
    const idx = JSON.parse(readFileSync(path.join(dir, "index.json"), "utf8"));
    writeFileSync(path.join(dir, "index.json"), JSON.stringify({ ...idx, featured: "ghost" }));
    const bus = createBus();
    assert.equal(bus.loadReplays(dir), 2);
    assert.equal(bus.list()[0]!.runId, "good1");
    assert.equal(bus.list()[0]!.featured, true);
  });
});

describe("receipts and stripe", () => {
  it("the receipt route returns the exact stored bytes; none is 404", async () => {
    const { deps, bus } = makeDeps();
    const run = makeRun();
    bus.register(run);
    const canonical = '{"artifact_sha256":"ab","meter":{"cost_micros":1035900},"note":"é ✓  two  spaces"}';
    bus.setReceipt(run.runId, "A", canonical);
    bus.loadReplays(makeReplayDir());
    await withApp(deps, async () => {
      const r = await call("GET", `/api/runs/${run.runId}/receipts/A`);
      assert.equal(r.status, 200);
      assert.equal(r.headers["content-type"], "application/json; charset=utf-8");
      assert.equal(r.body, canonical);
      assert.equal(Number(r.headers["content-length"]), Buffer.byteLength(canonical));
      assert.equal((await call("GET", "/api/runs/good1/receipts/A")).body, CANON);   // from a replay file
      assert.equal((await call("GET", `/api/runs/${run.runId}/receipts/B`)).status, 404);
      assert.equal((await call("GET", `/api/runs/${run.runId}/receipts/Z`)).status, 404);
      assert.equal((await call("GET", "/api/runs/nosuchrun/receipts/A")).status, 404);
    });
  });

  it("/api/stripe/:piId is 404 for an unknown PI and retrieves a known one (lane pi or hold event)", async () => {
    const { deps, bus, calls } = makeDeps();
    const run = makeRun({ lanes: [makeLane({ pi: { id: "pi_lane_1", amountCents: 500, status: "requires_capture" } })] });
    const emit = bus.register(run);
    emit("hold.authorized", "B", { piId: "pi_event_2", amountCents: 500, status: "requires_capture" });
    await withApp(deps, async () => {
      assert.equal((await call("GET", "/api/stripe/pi_unknown")).status, 404);
      assert.equal((await call("GET", "/api/stripe/pi_lane_1%2f..")).status, 404);
      assert.equal(calls.retrieve.length, 0);
      const r = await call("GET", "/api/stripe/pi_lane_1");
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, { status: "requires_capture", amount: 500, amountReceived: 0, metadata: { pi: "pi_lane_1" } });
      assert.equal((await call("GET", "/api/stripe/pi_event_2")).status, 200);
      assert.deepEqual(calls.retrieve, ["pi_lane_1", "pi_event_2"]);
    });
  });

  it("a failing Stripe lookup is a 502 with no key in the body", async () => {
    const { deps, bus } = makeDeps({ pay: { retrieve: async () => { throw new Error("Invalid API Key provided: sk_test_" + "b".repeat(24)); } } });
    bus.register(makeRun({ lanes: [makeLane({ pi: { id: "pi_x1", amountCents: 500, status: "requires_capture" } })] }));
    await withApp(deps, async () => {
      const r = await call("GET", "/api/stripe/pi_x1");
      assert.equal(r.status, 502);
      assert.doesNotMatch(r.body, /sk_test_/);
    });
  });
});

describe("selfcheck", () => {
  it("needs the admin token and returns {createos, stripe, router}", async () => {
    await withApp(makeDeps().deps, async () => {
      assert.equal((await call("GET", "/api/selfcheck")).status, 401);
      assert.equal((await call("GET", "/api/selfcheck", { token: "nope" })).status, 401);
      const r = await call("GET", "/api/selfcheck", { token: TOKEN });
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, { createos: "ok", stripe: "ok", router: "ok" });
    });
  });

  it("reports a failing ping as its message without any key, and passes an error string through", async () => {
    const { deps } = makeDeps({ ping: {
      createos: async () => "HTTP 401",
      stripe: async () => { throw new Error("bad key sk_test_" + "c".repeat(24)); },
      router: async () => "ok",
    } });
    await withApp(deps, async () => {
      const r = await call("GET", "/api/selfcheck", { token: TOKEN });
      assert.equal(r.status, 200);
      assert.equal(r.json.createos, "HTTP 401");
      assert.equal(r.json.router, "ok");
      assert.match(r.json.stripe, /bad key/);
      assert.doesNotMatch(r.body, /sk_test_/);
    });
  });
});

describe("small helpers", () => {
  it("readVersion is the trimmed VERSION file, else dev", () => {
    const dir = mkdtempSync(path.join(tmp, "ver-"));
    assert.equal(readVersion(dir), "dev");
    writeFileSync(path.join(dir, "VERSION"), "  a1b2c3d\n");
    assert.equal(readVersion(dir), "a1b2c3d");
    writeFileSync(path.join(dir, "VERSION"), "\n");
    assert.equal(readVersion(dir), "dev");
  });

  it("redact strips keys, bearer tokens and long token-like strings", () => {
    const out = redact(`x sk_test_${"a".repeat(20)} Bearer abc123 ${"f".repeat(64)} ok`);
    assert.doesNotMatch(out, /sk_test_a|abc123|ffff/);
    assert.match(out, /ok$/);
  });

  it("bootReap calls reapOrphans with 300 s and the dev VM id, and logs ids only", async () => {
    const seen: unknown[] = [];
    const lines: string[] = [];
    await bootReap(async (o) => { seen.push(o); return { destroyed: ["sb-1", "sb-2"], kept: ["sb-dev"] }; }, "sb-dev", (l) => lines.push(l));
    assert.deepEqual(seen, [{ minAgeSec: 300, keepIds: ["sb-dev"] }]);
    assert.match(lines.join("\n"), /destroyed 2: sb-1, sb-2/);
    assert.doesNotMatch(lines.join("\n"), /sb-dev/);
    assert.equal(
      describeReaped({ destroyed: ["sb-1"], kept: [], rows: [{ id: "sb-1", name: "hx-ab12-A-cd34", action: "destroyed" }, { id: "sb-9", name: "hn-zz", action: "failed" }] }),
      "destroyed 1: sb-1 (hx-ab12-A-cd34); failed 1: sb-9 (hn-zz)",
    );
    assert.equal(describeReaped({ destroyed: [], kept: ["sb-dev"], rows: [] }), "nothing to reap");
    assert.equal(describeReaped(undefined), "nothing to reap");
    const noDev: unknown[] = [];
    await bootReap(async (o) => { noDev.push(o); return { destroyed: [], kept: [] }; }, "", (l) => lines.push(l));
    assert.deepEqual(noDev, [{ minAgeSec: 300, keepIds: [] }]);
    await bootReap(async () => { throw new Error("nope sk_test_" + "d".repeat(24)); }, "x", (l) => lines.push(l));
    await bootReap(undefined, "x", (l) => lines.push(l));
    assert.ok(lines.some((l) => /failed: nope/.test(l)) && lines.some((l) => /skipped/.test(l)));
    assert.ok(lines.every((l) => !/sk_test_/.test(l)));
  });
});

// ── scripts/export-replay.ts ────────────────────────────────────────────
const LABEL_RE = /^Recorded run \d+ · \d\d:\d\d PT · real sandboxes · real Stripe-sandbox PaymentIntents$/;

describe("export-replay: pure helpers", () => {
  it("label is `Recorded run <N> · <HH:MM> PT · real sandboxes · real Stripe-sandbox PaymentIntents` in America/Los_Angeles, 24 h", () => {
    assert.equal(replayLabel(3, Date.UTC(2026, 9, 17, 22, 42)), "Recorded run 3 · 15:42 PT · real sandboxes · real Stripe-sandbox PaymentIntents");
    assert.equal(ptClock(Date.UTC(2026, 9, 17, 7, 5)), "00:05");     // PDT is UTC-7 until 2026-11-01
    assert.equal(ptClock(Date.UTC(2026, 10, 2, 8, 5)), "00:05");     // PST is UTC-8 afterwards
    assert.equal(ptClock(Date.UTC(2026, 9, 18, 6, 59)), "23:59");
  });

  it("refuseReason: synthetic, replay, reused lane, reuse mode and unfinished runs are refused; a finished live run and a sharedFrom lane pass", () => {
    const live = makeRun({ lanes: [makeLane(), makeLane({ laneId: "B", seal: seal({ sharedFrom: "A" }) as Lane["seal"] })] });
    assert.equal(refuseReason(live, true), null);
    assert.match(refuseReason(makeRun({ source: "synthetic" }), true)!, /source is "synthetic", not "live"/);
    assert.match(refuseReason(makeRun({ source: "replay" }), true)!, /source is "replay", not "live"/);
    assert.match(refuseReason(makeRun({ lanes: [makeLane(), makeLane({ laneId: "B", seal: seal({ reused: true }) as Lane["seal"] })] }), true)!, /lane B .*reused/);
    assert.match(refuseReason(makeRun({ vmMode: "reuse" }), true)!, /reused/);
    assert.match(refuseReason(live, false)!, /not finished/);
    assert.match(refuseReason(makeRun({ source: "synthetic" }), false)!, /synthetic/);   // the source is named first
  });

  it("toReplay sets source and label on the run AND the run.started snapshot, copies deeply, adds receipts only when present", () => {
    const run = makeRun({ lanes: [makeLane()], startedAt: Date.UTC(2026, 9, 17, 22, 42) });
    const events: RunEvent[] = [
      { seq: 1, t: 0, runId: run.runId, type: "run.started", data: structuredClone(run) },
      { seq: 2, t: 10, runId: run.runId, laneId: "A", type: "lane.state", data: { state: "held" } },
    ];
    const out = toReplay(run, events, { A: CANON }, 3);
    assert.equal(out.run.source, "replay");
    assert.equal(out.run.label, "Recorded run 3 · 15:42 PT · real sandboxes · real Stripe-sandbox PaymentIntents");
    const snap = out.events[0]!.data as Run;
    assert.equal(snap.source, "replay");
    assert.equal(snap.label, out.run.label);
    assert.deepEqual(out.events[1], events[1]);
    assert.equal(run.source, "live");
    assert.equal(run.label, "LIVE");
    assert.equal((events[0]!.data as Run).label, "LIVE");
    assert.doesNotMatch(JSON.stringify(out), /"label":"LIVE"|"source":"live"/);
    assert.deepEqual(out.receipts, { A: CANON });
    assert.equal(toReplay(run, events, {}, 1).receipts, undefined);
    assert.equal(toReplay(run, events, undefined, 1).receipts, undefined);
  });

  it("upsertIndex features the first run, keeps the featured one unless asked, and replaces a re-exported row", () => {
    const f = (id: string) => toReplay(makeRun({ runId: id }), [], undefined, 1);
    const one = upsertIndex(undefined, f("a1"), false);
    assert.deepEqual(Object.keys(one), ["featured", "runs"]);
    assert.equal(one.featured, "a1");
    const two = upsertIndex(one, f("b2"), false);
    assert.equal(two.featured, "a1");
    assert.deepEqual(two.runs.map((r) => r.runId), ["a1", "b2"]);
    assert.equal(upsertIndex(two, f("b2"), true).featured, "b2");
    assert.equal(upsertIndex(two, f("a1"), false).runs.length, 2);
    assert.deepEqual(Object.keys(two.runs[0]!), ["runId", "label", "mode", "startedAt"]);
  });
});

describe("export-replay: a live run exported through the API and loaded back", () => {
  const events = (bus: Bus, run: Run) => {
    const emit = bus.register(run);
    emit("lane.state", "A", { state: "working" });
    emit("hold.authorized", "A", { piId: "pi_exp1", amountCents: 500, status: "requires_capture" });
    for (let i = 0; i < 520; i++) emit("meter.tick", "A", { i });   // more than one page of 500
    bus.setReceipt(run.runId, "A", CANON);
  };

  it("writes replays/<runId>.json and index.json, relabels, features the first, and the loader takes the result", async () => {
    const { deps, bus } = makeDeps();
    const run = makeRun({ lanes: [makeLane({ pi: { id: "pi_exp1", amountCents: 500, status: "succeeded" } }), makeLane({ laneId: "B", seal: seal({ sharedFrom: "A" }) as Lane["seal"] })] });
    events(bus, run);
    bus.finish(run.runId);
    const second = makeRun({ startedAt: Date.UTC(2026, 9, 17, 23, 10) });
    events(bus, second);
    bus.finish(second.runId);
    const outDir = path.join(tmp, "export-out");
    await withApp(deps, async () => {
      const base = `http://127.0.0.1:${PORT}`;
      const a = await exportReplay({ runId: run.runId, base, feature: false, outDir });
      assert.equal(a.label, "Recorded run 1 · 15:42 PT · real sandboxes · real Stripe-sandbox PaymentIntents");
      assert.equal(a.file, path.join(outDir, `${run.runId}.json`));
      const file = JSON.parse(readFileSync(a.file, "utf8"));
      assert.equal(file.run.source, "replay");
      assert.equal(file.run.label, a.label);
      assert.equal(file.events.length, 524);
      assert.equal(file.events[0].data.source, "replay");
      assert.equal(file.events[0].data.label, a.label);
      assert.deepEqual(file.receipts, { A: CANON });
      assert.doesNotMatch(readFileSync(a.file, "utf8"), /"label": "LIVE"/);
      const b = await exportReplay({ runId: second.runId, base: `${base}/`, feature: false, outDir });
      assert.match(b.label, /^Recorded run 2 · 16:10 PT/);
      let index = JSON.parse(readFileSync(path.join(outDir, "index.json"), "utf8"));
      assert.equal(index.featured, run.runId);
      assert.deepEqual(index.runs.map((r: { runId: string }) => r.runId), [run.runId, second.runId]);
      await exportReplay({ runId: second.runId, base, n: 7, feature: true, outDir });
      index = JSON.parse(readFileSync(path.join(outDir, "index.json"), "utf8"));
      assert.equal(index.featured, second.runId);
      assert.equal(index.runs.length, 2);
      assert.match(index.runs[1].label, /^Recorded run 7 /);
    });
    const fresh = createBus();
    assert.equal(fresh.loadReplays(outDir), 2);
    assert.equal(fresh.list()[0]!.runId, second.runId);
    assert.equal(fresh.list()[0]!.featured, true);
    assert.ok(fresh.list().every((r) => r.source === "replay" && LABEL_RE.test(r.label)));
    assert.equal(fresh.receipt(run.runId, "A"), CANON);
    assert.equal(fresh.events(run.runId, 500)!.events.length, 24);
    assert.equal(fresh.events(run.runId, 500)!.done, true);
    assert.equal(fresh.knownPi("pi_exp1"), true);
  });

  it("refuses an unfinished run, a synthetic run, a replay, a reused-VM lane and an unknown run, and writes nothing", async () => {
    const { deps, bus } = makeDeps();
    const unfinished = makeRun();
    events(bus, unfinished);
    const synthetic = makeRun({ source: "synthetic", label: "SYNTHETIC" });
    bus.register(synthetic);
    bus.finish(synthetic.runId);
    const replay = makeRun({ source: "replay", label: "Recorded run 1" });
    bus.register(replay);
    bus.finish(replay.runId);
    const reused = makeRun({ vmMode: "fresh", lanes: [makeLane({ seal: seal({ reused: true }) as Lane["seal"] })] });
    bus.register(reused);
    bus.finish(reused.runId);
    const outDir = path.join(tmp, "export-refused");
    await withApp(deps, async () => {
      const base = `http://127.0.0.1:${PORT}`;
      const refuse = (runId: string, re: RegExp) =>
        assert.rejects(exportReplay({ runId, base, feature: false, outDir }), (e: unknown) => e instanceof ExportError && re.test(e.message));
      await refuse(unfinished.runId, /not finished/);
      await refuse(synthetic.runId, /synthetic/);
      await refuse(replay.runId, /source is "replay"/);
      await refuse(reused.runId, /reused/);
      await refuse("nosuchrun", /unknown/);
      await refuse("bad id!", /not a run id/);
    });
    assert.throws(() => readFileSync(path.join(outDir, "index.json")), /ENOENT/);
  });
});
