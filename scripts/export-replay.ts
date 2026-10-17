// scripts/export-replay.ts: exports a finished live run as a labelled recorded run.
//   npx tsx scripts/export-replay.ts <runId> [--base <url>] [--n <N>] [--feature]
// Reads the run, every event and each lane's receipt over GET (no token needed), then writes
// replays/<runId>.json and upserts replays/index.json. Synthetic runs, replays, reused-VM lanes and
// unfinished runs are refused with exit 1.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Run, RunEvent } from "../src/contracts.js";

export interface ReplayFile { run: Run; events: RunEvent[]; receipts?: Record<string, string> }
export interface ReplayIndexRow { runId: string; label: string; mode: string; startedAt: number }
export interface ReplayIndex { featured?: string; runs: ReplayIndexRow[] }
export class ExportError extends Error {}

const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;
function isObj(v: unknown): v is Record<string, unknown> { return typeof v === "object" && v !== null && !Array.isArray(v); }

/** HH:MM on a 24 h clock in America/Los_Angeles. */
export function ptClock(ms: number): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("hour")}:${get("minute")}`;
}

export function replayLabel(n: number, startedAt: number): string {
  return `Recorded run ${n} · ${ptClock(startedAt)} PT · real sandboxes · real Stripe-sandbox PaymentIntents`;
}

/** The first reason this run must not be exported, or null. A Free-serial lane with sharedFrom exports normally. */
export function refuseReason(run: Run, done: boolean): string | null {
  if (run.source !== "live") {
    return `refused: the run's source is "${String(run.source)}", not "live" (synthetic runs and replays are never exported)`;
  }
  const reused = (run.lanes ?? []).filter((l) => l.seal?.reused === true).map((l) => l.laneId);
  if (reused.length > 0) return `refused: lane ${reused.join(", ")} ran in a reused dev VM (seal.reused is true); reuse-mode runs are never exported`;
  if (run.vmMode === "reuse") return "refused: the run used VM_MODE=reuse, a reused dev VM; reuse-mode runs are never exported";
  if (!done) return "refused: the run is not finished (wait for run.finished)";
  return null;
}

/** The replays/<runId>.json content. Sets source "replay" and the label on the run AND on the run.started snapshot. */
export function toReplay(run: Run, events: RunEvent[], receipts: Record<string, string> | undefined, n: number): ReplayFile {
  const label = replayLabel(n, run.startedAt);
  const outRun = structuredClone(run);
  outRun.source = "replay";
  outRun.label = label;
  const outEvents = structuredClone(events);
  for (const ev of outEvents) {
    if (ev.type === "run.started" && isObj(ev.data)) { ev.data.source = "replay"; ev.data.label = label; }
  }
  const file: ReplayFile = { run: outRun, events: outEvents };
  if (receipts && Object.keys(receipts).length > 0) file.receipts = { ...receipts };
  return file;
}

/** Adds or replaces the run's row; features it with --feature or when nothing is featured yet. */
export function upsertIndex(index: ReplayIndex | undefined, file: ReplayFile, feature: boolean): ReplayIndex & { featured: string } {
  const row: ReplayIndexRow = { runId: file.run.runId, label: file.run.label, mode: file.run.mode, startedAt: file.run.startedAt };
  const runs = [...(index?.runs ?? [])];
  const i = runs.findIndex((r) => r.runId === row.runId);
  if (i >= 0) runs[i] = row; else runs.push(row);
  const featured = feature || !index?.featured ? row.runId : index.featured;
  return { featured, runs };
}

export interface ExportOptions { runId: string; base: string; n?: number; feature: boolean; outDir: string }

async function get(url: string): Promise<{ status: number; text: string }> {
  let r: Response;
  try { r = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { accept: "application/json" } }); }
  catch (e) {
    const cause = e instanceof Error ? (e.cause as { code?: string; message?: string } | undefined) : undefined;
    throw new ExportError(`cannot reach ${url}: ${e instanceof Error ? e.message : String(e)}${cause ? ` (${cause.code ?? cause.message})` : ""}`);
  }
  return { status: r.status, text: await r.text() };
}
function parse(text: string, what: string): unknown {
  try { return JSON.parse(text); } catch { throw new ExportError(`${what} did not answer with JSON`); }
}

function readIndex(file: string): ReplayIndex | undefined {
  try {
    const j: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (isObj(j) && Array.isArray(j.runs)) return { featured: typeof j.featured === "string" ? j.featured : undefined, runs: j.runs as ReplayIndexRow[] };
  } catch { /* no index yet */ }
  return undefined;
}
function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

export async function exportReplay(o: ExportOptions): Promise<{ file: string; label: string }> {
  if (!RUN_ID.test(o.runId)) throw new ExportError(`"${o.runId}" is not a run id`);
  const base = o.base.replace(/\/+$/, "");
  const api = `${base}/api/runs/${o.runId}`;

  const r = await get(api);
  if (r.status === 404) throw new ExportError(`run ${o.runId} is unknown at ${base}`);
  if (r.status !== 200) throw new ExportError(`GET ${api} answered ${r.status}`);
  const run = parse(r.text, api) as Run;
  const early = refuseReason(run, true);   // everything but "finished" is known from the snapshot alone
  if (early) throw new ExportError(early);

  const events: RunEvent[] = [];
  let done = false;
  for (let page = 0; page < 400 && !done; page++) {
    const e = await get(`${api}/events?after=${events.length}`);
    if (e.status !== 200) throw new ExportError(`GET ${api}/events answered ${e.status}`);
    const body = parse(e.text, `${api}/events`);
    if (!isObj(body) || !Array.isArray(body.events)) throw new ExportError(`${api}/events has no events array`);
    events.push(...(body.events as RunEvent[]));
    done = body.done === true;
    if (body.events.length === 0) break;
  }
  const refusal = refuseReason(run, done);
  if (refusal) throw new ExportError(refusal);
  events.forEach((ev, i) => { if (ev.seq !== i + 1) throw new ExportError(`events are not gapless: expected seq ${i + 1}, got ${ev.seq}`); });

  const receipts: Record<string, string> = {};
  for (const lane of run.lanes ?? []) {
    const rc = await get(`${api}/receipts/${lane.laneId}`);
    if (rc.status === 200) receipts[lane.laneId] = rc.text;
    else if (rc.status !== 404) throw new ExportError(`GET ${api}/receipts/${lane.laneId} answered ${rc.status}`);
  }

  const indexFile = path.join(o.outDir, "index.json");
  const index = readIndex(indexFile);
  const n = o.n ?? (index?.runs.length ?? 0) + 1;
  const replay = toReplay(run, events, receipts, n);

  mkdirSync(o.outDir, { recursive: true });
  const file = path.join(o.outDir, `${o.runId}.json`);
  writeAtomic(file, JSON.stringify(replay, null, 2) + "\n");
  writeAtomic(indexFile, JSON.stringify(upsertIndex(index, replay, o.feature), null, 2) + "\n");
  return { file, label: replay.run.label };
}

function parseArgs(argv: string[]): ExportOptions {
  let runId = "";
  let base = "http://localhost:8787";
  let n: number | undefined;
  let feature = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--base") base = argv[++i] ?? "";
    else if (a === "--n") n = Number(argv[++i]);
    else if (a === "--feature") feature = true;
    else if (a.startsWith("--")) throw new ExportError(`unknown option ${a}`);
    else if (!runId) runId = a;
    else throw new ExportError(`unexpected argument ${a}`);
  }
  if (!runId) throw new ExportError("usage: npx tsx scripts/export-replay.ts <runId> [--base <url>] [--n <N>] [--feature]");
  if (!base) throw new ExportError("--base needs a URL");
  if (n !== undefined && (!Number.isInteger(n) || n < 1)) throw new ExportError("--n needs a positive integer");
  return { runId, base, n, feature, outDir: path.resolve(process.cwd(), "replays") };
}

function isEntry(): boolean {
  const arg = process.argv[1];
  return !!arg && import.meta.url === pathToFileURL(path.resolve(arg)).href;
}

if (isEntry()) {
  try {
    const out = await exportReplay(parseArgs(process.argv.slice(2)));
    console.log(`wrote ${path.relative(process.cwd(), out.file)}`);
    console.log(out.label);
  } catch (e) {
    console.error(e instanceof ExportError ? e.message : `export failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
