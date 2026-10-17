// src/server.ts: the one Node process CreateOS Deploy runs. node:http, a JSON API, the static page.
// Every request answers within about 2 s: runs are asynchronous (202, then the page polls the events).
import { timingSafeEqual } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ContractorKind, LaneId, Mode, Pay, Vm } from "./contracts.js";
import { createBus, type Bus } from "./bus.js";

export interface StartRunRequest { mode: Mode; lanes: ContractorKind[]; holdCents: number; timeCapSec: number }
export interface AppDeps {
  bus: Bus; vm: Pick<Vm, "creates" | "running">; pay: Pick<Pay, "retrieve">;
  startRun?: (req: StartRunRequest, bus: Bus) => { runId: string };   // src/run.ts (Main); missing → 503
  tripRun?: (runId: string) => boolean;
  ping: { createos(): Promise<string>; stripe(): Promise<string>; router(): Promise<string> };
  cfg: { adminToken?: string; version: string; notary: boolean; concurrency: number; vmMode: string;
         onTrip: string; rateCard: string; forceCreate: boolean };
  publicDir: string;
}

const UPSTREAM_MS = 1500;     // health and the 409 checks
const SELFCHECK_MS = 4000;    // per ping, admin only
const STRIPE_MS = 4000;       // /api/stripe
const BODY_MS = 5000;         // time allowed to receive a POST body
const CACHE_MS = 5000;        // health reuses an upstream answer for this long
const BODY_MAX = 16 * 1024;
const KINDS: readonly ContractorKind[] = ["honest", "runaway", "runaway-busyloop", "cheater", "sloppy"];
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const PI_ID = /^[A-Za-z0-9_]{1,80}$/;

class TimeoutError extends Error {}
function isObj(v: unknown): v is Record<string, unknown> { return typeof v === "object" && v !== null && !Array.isArray(v); }

/** Strips anything that looks like a key or a token from a message before it is logged or returned. */
export function redact(s: string): string {
  return s
    .replace(/\b(?:sk|pk|rk)_(?:test|live)_[A-Za-z0-9*_]+/g, "[key]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [token]")
    .replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]")
    .slice(0, 300);
}
function errText(e: unknown): string { return redact(e instanceof Error ? e.message : String(e)); }

/** Runs fn and gives up after ms. The underlying call keeps going; its late answer is ignored. */
function bounded<T>(fn: () => Promise<T> | T, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(`${what}: no answer in ${ms} ms`)), ms);
    let p: Promise<T>;
    try { p = Promise.resolve(fn()); } catch (e) { clearTimeout(timer); reject(e); return; }
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

/** An upstream read bounded to 1.5 s, answered from a 5 s cache unless fresh. A failure caches as null. */
function cachedField<T>(fn: () => Promise<T>, what: string): (fresh: boolean) => Promise<T | null> {
  let at = 0;
  let val: T | null = null;
  let inflight: Promise<T | null> | null = null;
  return (fresh) => {
    if (!fresh && at > 0 && Date.now() - at < CACHE_MS) return Promise.resolve(val);
    if (!fresh && inflight) return inflight;
    const p: Promise<T | null> = bounded(fn, UPSTREAM_MS, what)
      .then((v): T | null => v, (): T | null => null)
      .then((v) => { at = Date.now(); val = v; if (inflight === p) inflight = null; return v; });
    if (!fresh) inflight = p;
    return p;
  };
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-length": Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

function adminOk(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) return false;   // no ADMIN_TOKEN configured: every admin route answers 401
  const h = req.headers.authorization;
  const m = typeof h === "string" ? /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(h) : null;
  if (!m) return false;
  const given = Buffer.from(m[1] ?? "", "utf8");
  const want = Buffer.from(token, "utf8");
  return given.length === want.length && timingSafeEqual(given, want);
}

type Body = { ok: true; text: string } | { ok: false; error: string };
function readBody(req: IncomingMessage): Promise<Body> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    const timer = setTimeout(() => resolve({ ok: false, error: "request body not received in time" }), BODY_MS);
    req.on("data", (c: Buffer) => { size += c.length; if (size > BODY_MAX) over = true; else chunks.push(c); });
    req.on("end", () => {
      clearTimeout(timer);
      resolve(over ? { ok: false, error: `body is larger than ${BODY_MAX} bytes` } : { ok: true, text: Buffer.concat(chunks).toString("utf8") });
    });
    req.on("error", () => { clearTimeout(timer); resolve({ ok: false, error: "request body could not be read" }); });
  });
}

/** Validates the POST /api/runs body and fills the defaults (holdCents 500, timeCapSec 120). */
export function parseStartRequest(body: unknown): { ok: true; req: StartRunRequest } | { ok: false; error: string } {
  const bad = (error: string) => ({ ok: false as const, error });
  if (!isObj(body)) return bad("body must be a JSON object");
  const { mode, lanes } = body;
  if (mode !== "fuse" && mode !== "fuse+notary") return bad('mode must be "fuse" or "fuse+notary"');
  if (!Array.isArray(lanes) || lanes.length < 1 || lanes.length > 4 || !lanes.every((k) => typeof k === "string" && (KINDS as readonly string[]).includes(k))) {
    return bad(`lanes must be 1 to 4 of: ${KINDS.join(", ")}`);
  }
  const hold = body.holdCents === undefined ? 500 : body.holdCents;
  if (typeof hold !== "number" || !Number.isInteger(hold) || hold < 50 || hold > 10_000) return bad("holdCents must be an integer from 50 to 10000");
  const cap = body.timeCapSec === undefined ? 120 : body.timeCapSec;
  if (typeof cap !== "number" || !Number.isInteger(cap) || cap < 10 || cap > 300) return bad("timeCapSec must be an integer from 10 to 300");
  return { ok: true, req: { mode, lanes: lanes as ContractorKind[], holdCents: hold, timeCapSec: cap } };
}

// ── Static files: public/ only ──────────────────────────────────────────
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
};

/** Maps a URL path to a file under root, or null. Rejects dotfiles, "..", NUL, backslashes and bad escapes. */
export function resolveStatic(root: string, urlPath: string): string | null {
  let decoded: string;
  try { decoded = decodeURIComponent(urlPath === "/" ? "/index.html" : urlPath); } catch { return null; }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const parts = decoded.split("/").filter((s) => s !== "");
  if (parts.length === 0 || parts.some((s) => s.startsWith("."))) return null;
  const full = path.resolve(root, parts.join("/"));
  return full.startsWith(root + path.sep) ? full : null;
}

async function serveStatic(root: string, urlPath: string, res: ServerResponse): Promise<boolean> {
  const full = resolveStatic(root, urlPath);
  if (!full) return false;
  try {
    const real = await realpath(full);                 // follows symlinks, so a link out of public/ is refused
    const realRoot = await realpath(root);
    if (!real.startsWith(realRoot + path.sep) || !(await stat(real)).isFile()) return false;
    const body = await readFile(real);
    res.writeHead(200, {
      "content-type": TYPES[path.extname(full).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
      "content-length": body.length,
    });
    res.end(body);
    return true;
  } catch { return false; }
}

// ── The app ─────────────────────────────────────────────────────────────
export function createApp(deps: AppDeps): Server {
  const { bus, cfg } = deps;
  const root = path.resolve(deps.publicDir);
  const getCreates = cachedField(() => deps.vm.creates(), "creates");
  const getRunning = cachedField(() => deps.vm.running(), "running");
  let starting = false;   // true from the checks of one POST /api/runs until startRun has registered its run

  const unauthorized = (res: ServerResponse) => send(res, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
  const notFound = (res: ServerResponse) => send(res, 404, { error: "not found" });
  const wrongMethod = (res: ServerResponse, allow: string) => send(res, 405, { error: "method not allowed" }, { allow });

  async function health(res: ServerResponse): Promise<void> {
    const [creates, running] = await Promise.all([getCreates(false), getRunning(false)]);
    send(res, 200, {
      ok: true, version: cfg.version, notary: cfg.notary, concurrency: cfg.concurrency, vmMode: cfg.vmMode,
      onTrip: cfg.onTrip, rateCard: cfg.rateCard,
      creates: creates && typeof creates.used24h === "number" ? { used24h: creates.used24h, cap: creates.cap } : null,
      running: typeof running === "number" ? running : null,
    });
  }

  async function selfcheck(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!adminOk(req, cfg.adminToken)) return unauthorized(res);
    const one = (fn: () => Promise<string>, what: string) =>
      bounded(fn, SELFCHECK_MS, what).then((s) => (typeof s === "string" && s !== "" ? redact(s) : "ok"), (e) => errText(e));
    const [createos, stripe, router] = await Promise.all([
      one(() => deps.ping.createos(), "createos"), one(() => deps.ping.stripe(), "stripe"), one(() => deps.ping.router(), "router"),
    ]);
    send(res, 200, { createos, stripe, router });
  }

  async function startRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!adminOk(req, cfg.adminToken)) return unauthorized(res);
    if (!deps.startRun) return send(res, 503, { error: "the run orchestrator is not available", reason: "orchestrator" });
    const body = await readBody(req);
    if (!body.ok) return send(res, 400, { error: body.error }, { connection: "close" });
    let json: unknown;
    try { json = JSON.parse(body.text); } catch { return send(res, 400, { error: "body is not valid JSON" }); }
    const parsed = parseStartRequest(json);
    if (!parsed.ok) return send(res, 400, { error: parsed.error });
    const live = bus.liveRunId();
    if (live || starting) return send(res, 409, { error: "a run is already live", reason: "live", runId: live ?? undefined });
    starting = true;   // set with no await since the check above: a second POST during the upstream checks gets the 409
    try {
      if (cfg.vmMode === "fresh") {   // reuse mode creates nothing and its dev VM is always running: skip both checks
        const needLedger = !cfg.forceCreate;
        const needSlot = cfg.concurrency === 1;
        const [creates, running] = await Promise.all([needLedger ? getCreates(true) : null, needSlot ? getRunning(true) : null]);
        if ((needLedger && creates === null) || (needSlot && running === null)) {
          return send(res, 503, { error: "the create ledger or the running count did not answer; no run was started", reason: "upstream" });
        }
        if (needLedger && creates && creates.used24h >= creates.cap) {
          return send(res, 409, { error: "create ledger at its stop", reason: "ledger" });
        }
        if (needSlot && running !== null && running > 0) {
          return send(res, 409, { error: "Free plan runs 1 microVM at a time", reason: "slot" });
        }
      }
      const started = await deps.startRun(parsed.req, bus);
      send(res, 202, { runId: started.runId });
    } finally { starting = false; }
  }

  function getEvents(runId: string, query: URLSearchParams, res: ServerResponse): void {
    const raw = query.get("after");
    if (raw !== null && !/^\d{1,15}$/.test(raw)) return send(res, 400, { error: "after must be a non-negative integer" });
    const out = bus.events(runId, raw === null ? 0 : Number(raw));
    if (!out) return notFound(res);
    send(res, 200, out);
  }

  function getReceipt(runId: string, laneId: string, res: ServerResponse): void {
    const text = bus.receipt(runId, laneId as LaneId);
    if (text === undefined) return notFound(res);
    const bytes = Buffer.from(text, "utf8");   // the exact stored bytes, never re-serialised
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
      "x-content-type-options": "nosniff", "content-length": bytes.length,
    });
    res.end(bytes);
  }

  async function trip(req: IncomingMessage, runId: string, res: ServerResponse): Promise<void> {
    if (!adminOk(req, cfg.adminToken)) return unauthorized(res);
    if (!bus.get(runId)) return notFound(res);
    if (!deps.tripRun) return send(res, 503, { error: "the run orchestrator is not available", reason: "orchestrator" });
    send(res, 200, { tripped: Boolean(deps.tripRun(runId)) });
  }

  async function stripe(piId: string, res: ServerResponse): Promise<void> {
    if (!PI_ID.test(piId) || !bus.knownPi(piId)) return notFound(res);
    try {
      const r = await bounded(() => deps.pay.retrieve(piId), STRIPE_MS, "stripe");
      send(res, 200, { status: r.status, amount: r.amount, amountReceived: r.amountReceived, metadata: r.metadata });
    } catch (e) {
      console.warn(`server: stripe lookup failed: ${errText(e)}`);
      if (e instanceof TimeoutError) send(res, 504, { error: "stripe did not answer in time" });
      else send(res, 502, { error: "stripe lookup failed" });
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method === "HEAD" ? "GET" : (req.method ?? "GET");
    const target = req.url ?? "/";
    if (!target.startsWith("/")) return send(res, 400, { error: "bad request" });
    const qi = target.indexOf("?");
    const rawPath = qi < 0 ? target : target.slice(0, qi);
    const query = new URLSearchParams(qi < 0 ? "" : target.slice(qi + 1));

    if (rawPath !== "/api" && !rawPath.startsWith("/api/")) {
      if (method !== "GET") return wrongMethod(res, "GET, HEAD");
      if (!(await serveStatic(root, rawPath, res))) notFound(res);
      return;
    }
    let segs: string[];
    try { segs = rawPath.split("/").slice(2).map(decodeURIComponent); } catch { return notFound(res); }
    const [a, b, c, d] = segs;
    const only = (allow: string, ok: boolean, run: () => Promise<void> | void) => (ok ? run() : wrongMethod(res, allow));

    if (a === "health" && segs.length === 1) return only("GET, HEAD", method === "GET", () => health(res));
    if (a === "selfcheck" && segs.length === 1) return only("GET, HEAD", method === "GET", () => selfcheck(req, res));
    if (a === "runs" && segs.length === 1) {
      if (method === "GET") return send(res, 200, bus.list());
      return only("GET, HEAD, POST", method === "POST", () => startRun(req, res));
    }
    if (a === "runs" && SAFE_ID.test(b ?? "")) {
      const runId = b as string;
      if (segs.length === 2) {
        return only("GET, HEAD", method === "GET", () => {
          const run = bus.get(runId);
          return run ? send(res, 200, run) : notFound(res);
        });
      }
      if (segs.length === 3 && c === "events") return only("GET, HEAD", method === "GET", () => getEvents(runId, query, res));
      if (segs.length === 3 && c === "trip") return only("POST", method === "POST", () => trip(req, runId, res));
      if (segs.length === 4 && c === "receipts") return only("GET, HEAD", method === "GET", () => getReceipt(runId, d ?? "", res));
    }
    if (a === "stripe" && segs.length === 2) return only("GET, HEAD", method === "GET", () => stripe(b ?? "", res));
    return notFound(res);   // includes POST /api/catcher/:token and GET /api/catcher: a flagged extra, not built
  }

  const server = createServer((req, res) => {
    const t0 = Date.now();
    handle(req, res)
      .catch((e: unknown) => {
        console.error(`server: handler error on ${req.method} ${(req.url ?? "").split("?")[0]}: ${errText(e)}`);
        send(res, 500, { error: "internal" });
      })
      .finally(() => {
        if (req.method === "POST" || res.statusCode >= 500) {
          console.log(`${req.method} ${(req.url ?? "").split("?")[0]} -> ${res.statusCode} in ${Date.now() - t0} ms`);
        }
      })
      .catch(() => undefined);
  });
  // Behind the Deploy proxy an idle keep-alive socket closed early by Node can surface as a 502.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  return server;
}

// ── Main entry: only when this file is the process entry, so tests can import createApp ──
interface VmMod { createVm?: () => Vm; reapOrphans?: (o: { minAgeSec: number; keepIds?: string[] }) => Promise<unknown> }
interface StripeMod { createPay?: () => Pay; pingStripe?: () => Promise<string> }
interface AgentMod { pingRouter?: () => Promise<string> }
interface RunMod { startRun?: AppDeps["startRun"]; tripRun?: AppDeps["tripRun"] }

/** Ids and names only. reapOrphans answers { destroyed: string[]; kept: string[]; rows?: [{ id, name, action }] }. */
export function describeReaped(r: unknown): string {
  if (!isObj(r)) return "nothing to reap";
  const rows = Array.isArray(r.rows) ? r.rows.filter(isObj) : [];
  const nameOf = (id: string) => { const n = rows.find((x) => x.id === id)?.name; return typeof n === "string" && n ? ` (${n})` : ""; };
  const destroyed = Array.isArray(r.destroyed) ? r.destroyed.filter((x): x is string => typeof x === "string") : [];
  const failed = rows.filter((x) => x.action === "failed" && typeof x.id === "string").map((x) => `${String(x.id)}${nameOf(String(x.id))}`);
  const parts: string[] = [];
  if (destroyed.length > 0) parts.push(`destroyed ${destroyed.length}: ${destroyed.map((id) => id + nameOf(id)).join(", ")}`);
  if (failed.length > 0) parts.push(`failed ${failed.length}: ${failed.join(", ")}`);
  return parts.length > 0 ? parts.join("; ") : "nothing to reap";
}

/** Boot reaper, fire and forget: hx-/hn- boxes older than 300 s, never the dev VM. Logs ids only. */
export async function bootReap(
  reap: VmMod["reapOrphans"], devVmId: string, log: (line: string) => void = console.log,
): Promise<void> {
  if (!reap) { log("server: boot reaper skipped (vm module not loaded)"); return; }
  try { log(`server: boot reaper: ${describeReaped(await reap({ minAgeSec: 300, keepIds: devVmId ? [devVmId] : [] }))}`); }
  catch (e) { log(`server: boot reaper failed: ${errText(e)}`); }
}

/** The trimmed contents of ./VERSION (scripts/deploy.sh writes the short commit id), else "dev". */
export function readVersion(cwd: string = process.cwd()): string {
  try { return readFileSync(path.resolve(cwd, "VERSION"), "utf8").trim() || "dev"; } catch { return "dev"; }
}

async function load<T>(name: string, fn: () => Promise<unknown>): Promise<T | undefined> {
  try { return (await fn()) as T; }
  catch (e) { console.warn(`server: ${name} module not loaded (${errText(e)})`); return undefined; }
}

async function main(): Promise<void> {
  const { cfg } = await import("./config.js");   // throws on a bad SEAL_RULE: the server refuses to boot
  process.on("unhandledRejection", (e) => console.error(`server: unhandled rejection: ${errText(e)}`));
  const bus = createBus({ dataDir: "data" });
  bus.loadReplays(path.resolve(process.cwd(), "replays"));

  // The sibling packages are built in parallel: a missing module only degrades what needs it.
  // @ts-ignore (the module may not exist yet)
  const vmMod = await load<VmMod>("vm", () => import("./vm.js"));
  // @ts-ignore (the module may not exist yet)
  const stripeMod = await load<StripeMod>("stripe", () => import("./stripe.js"));
  // @ts-ignore (the module may not exist yet)
  const agentMod = await load<AgentMod>("agent", () => import("./agent.js"));
  // @ts-ignore (the module may not exist yet)
  const runMod = await load<RunMod>("run", () => import("./run.js"));

  if (runMod && (!runMod.startRun || !runMod.tripRun)) console.warn("server: the run module loaded but does not export startRun and tripRun (yet)");
  const missing = (what: string) => (): Promise<never> => Promise.reject(new Error(`${what} module is not loaded`));
  let vm: Pick<Vm, "creates" | "running"> = { creates: missing("vm"), running: missing("vm") };
  let pay: Pick<Pay, "retrieve"> = { retrieve: missing("stripe") };
  try { if (vmMod?.createVm) vm = vmMod.createVm(); } catch (e) { console.warn(`server: createVm failed: ${errText(e)}`); }
  try { if (stripeMod?.createPay) pay = stripeMod.createPay(); } catch (e) { console.warn(`server: createPay failed: ${errText(e)}`); }

  const version = readVersion();

  const app = createApp({
    bus, vm, pay, startRun: runMod?.startRun, tripRun: runMod?.tripRun,
    ping: {
      createos: async () => { await vm.running(); return "ok"; },
      stripe: () => (stripeMod?.pingStripe ? stripeMod.pingStripe() : Promise.reject(new Error("stripe module is not loaded"))),
      router: () => (agentMod?.pingRouter ? agentMod.pingRouter() : Promise.reject(new Error("agent module is not loaded"))),
    },
    cfg: {
      adminToken: cfg.adminToken || undefined, version, notary: cfg.notary, concurrency: cfg.concurrency,
      vmMode: cfg.vmMode, onTrip: cfg.onTrip, rateCard: cfg.rateCard, forceCreate: cfg.forceCreate,
    },
    publicDir: path.resolve(process.cwd(), "public"),
  });
  app.on("error", (e) => { console.error(`server: ${errText(e)}`); process.exit(1); });
  app.listen(cfg.port, () => {
    console.log(
      `holdout listening on ${cfg.port} (version ${version}; vmMode ${cfg.vmMode}; concurrency ${cfg.concurrency}; ` +
      `notary ${cfg.notary ? "on" : "off"}; admin token ${cfg.adminToken ? "set" : "NOT set"}; ` +
      `run.ts ${runMod?.startRun ? "loaded" : "missing, POST /api/runs answers 503"})`,
    );
    void bootReap(vmMod?.reapOrphans, cfg.devVmId);
  });
}

function isEntry(): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    if (import.meta.url === pathToFileURL(path.resolve(arg)).href) return true;
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(path.resolve(arg));
  } catch { return false; }
}

if (isEntry()) {
  main().catch((e: unknown) => { console.error(`server: failed to start: ${errText(e)}`); process.exit(1); });
}
