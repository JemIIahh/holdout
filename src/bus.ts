// src/bus.ts: the in-memory event log for every run, a JSONL copy on disk when the disk allows,
// the receipt store, and the recorded-run loader. The page polls events() or fetches a replay once.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Emit, EventType, LaneId, Mode, Run, RunEvent } from "./contracts.js";

export interface RunSummary { runId: string; label: string; source: Run["source"]; mode: Mode; startedAt: number; featured?: boolean }

export interface Bus {
  register(run: Run): Emit;              // keeps the live Run object; emits "run.started" (seq 1) with a deep copy
  finish(runId: string): void;           // emits "run.finished"; the run is done
  get(runId: string): Run | undefined;   // the live object (run.ts mutates it)
  events(runId: string, after: number): { events: RunEvent[]; done: boolean } | undefined;   // seq > after, at most 500
  list(): RunSummary[];                  // featured first, then newest; never source "synthetic"
  liveRunId(): string | null;            // a registered live run that has not finished
  setReceipt(runId: string, laneId: LaneId, canonical: string): void;   // run.ts stores the hashed bytes
  receipt(runId: string, laneId: LaneId): string | undefined;
  knownPi(piId: string): boolean;        // some loaded run has a lane with pi.id === piId
  loadReplays(dir: string): number;      // replays/index.json + the files it lists; returns the count
}

export const PAGE_SIZE = 500;
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const PI_EVENTS: ReadonlySet<string> = new Set(["hold.authorized", "settle.captured", "settle.canceled", "settle.left"]);

interface Entry {
  run: Run;
  events: RunEvent[];
  done: boolean;
  receipts: Map<string, string>;
  base: number;             // epoch ms that t counts from (the run's startedAt)
  order: number;            // registration order, the tie-break for "newest"
  lateWarned: boolean;
}

function clone<T>(v: T): T {
  try { return structuredClone(v); }
  catch { return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T); }
}
function isObj(v: unknown): v is Record<string, unknown> { return typeof v === "object" && v !== null && !Array.isArray(v); }
function msg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

export function createBus(o: { dataDir?: string; now?: () => number } = {}): Bus {
  const now = o.now ?? Date.now;
  const runsDir = o.dataDir ? path.resolve(process.cwd(), o.dataDir, "runs") : undefined;
  let diskOk = runsDir !== undefined;   // flips to false at the first file error, logged once
  let dirReady = false;
  let counter = 0;
  let featuredId: string | undefined;
  const entries = new Map<string, Entry>();
  const piIds = new Set<string>();

  function persist(ev: RunEvent): void {
    if (!diskOk || !runsDir) return;
    try {
      if (!dirReady) { mkdirSync(runsDir, { recursive: true }); dirReady = true; }
      appendFileSync(path.join(runsDir, `${ev.runId.replace(/[^A-Za-z0-9_-]/g, "_")}.jsonl`), JSON.stringify(ev) + "\n");
    } catch (e) {
      diskOk = false;
      console.warn(`bus: JSONL off after a file error (${msg(e)}); events stay in memory only`);
    }
  }

  function push(e: Entry, type: EventType, laneId: LaneId | undefined, data: unknown): void {
    const ev: RunEvent = {
      seq: e.events.length + 1,
      t: Math.max(0, now() - e.base),
      runId: e.run.runId,
      ...(laneId !== undefined ? { laneId } : {}),
      type,
      data: clone(data),
    };
    e.events.push(ev);
    if (PI_EVENTS.has(type) && isObj(ev.data) && typeof ev.data.piId === "string") piIds.add(ev.data.piId);
    persist(ev);
  }

  function replayProblem(f: unknown, id: string): string | null {
    if (!isObj(f) || !isObj(f.run) || !Array.isArray(f.events)) return "not a { run, events } file";
    const run = f.run;
    if (run.source !== "replay") return `source is ${JSON.stringify(run.source)}, not "replay"`;
    if (run.runId !== id) return "run.runId does not match the listed id";
    for (const lane of Array.isArray(run.lanes) ? run.lanes : []) {
      if (isObj(lane) && isObj(lane.seal) && lane.seal.reused === true) return `lane ${String(lane.laneId)} ran in a reused VM (seal.reused)`;
    }
    for (let i = 0; i < f.events.length; i++) {   // events(after) slices by index, which needs seq = index + 1
      const ev = f.events[i];
      if (!isObj(ev) || ev.seq !== i + 1) return `events are not gapless from seq 1 (at index ${i})`;
    }
    const first = f.events[0];
    if (isObj(first) && first.type === "run.started" && isObj(first.data) && typeof first.data.source === "string" && first.data.source !== "replay") {
      return "the run.started snapshot does not say replay";
    }
    return null;
  }

  const bus: Bus = {
    register(run) {
      if (entries.has(run.runId)) throw new Error(`bus: run ${run.runId} is already registered`);
      const e: Entry = {
        run, events: [], done: false, receipts: new Map(), order: ++counter, lateWarned: false,
        base: Number.isFinite(run.startedAt) ? run.startedAt : now(),
      };
      entries.set(run.runId, e);
      const emit: Emit = (type, laneId, data) => {
        if (e.done) {
          if (!e.lateWarned) { e.lateWarned = true; console.warn(`bus: run ${run.runId} is finished; late event dropped (${type})`); }
          return;
        }
        push(e, type, laneId, data);
      };
      emit("run.started", undefined, run);
      return emit;
    },

    finish(runId) {
      const e = entries.get(runId);
      if (!e || e.done) return;
      push(e, "run.finished", undefined, {});
      e.done = true;
    },

    get(runId) { return entries.get(runId)?.run; },

    events(runId, after) {
      const e = entries.get(runId);
      if (!e) return undefined;
      const from = Number.isFinite(after) && after > 0 ? Math.floor(after) : 0;
      const batch = e.events.slice(from, from + PAGE_SIZE);
      return { events: batch, done: e.done && from + batch.length >= e.events.length };
    },

    list() {
      const rows = [...entries.values()].filter((e) => e.run.source !== "synthetic");
      rows.sort((a, b) => {
        const fa = a.run.runId === featuredId ? 1 : 0;
        const fb = b.run.runId === featuredId ? 1 : 0;
        return fb - fa || b.run.startedAt - a.run.startedAt || b.order - a.order;
      });
      return rows.map((e) => ({
        runId: e.run.runId, label: e.run.label, source: e.run.source, mode: e.run.mode, startedAt: e.run.startedAt,
        ...(e.run.runId === featuredId ? { featured: true } : {}),
      }));
    },

    liveRunId() {
      let id: string | null = null;
      for (const e of entries.values()) if (e.run.source === "live" && !e.done) id = e.run.runId;   // the newest wins
      return id;
    },

    setReceipt(runId, laneId, canonical) {
      const e = entries.get(runId);
      if (!e) { console.warn(`bus: setReceipt for unknown run ${runId}`); return; }
      e.receipts.set(laneId, canonical);
    },

    receipt(runId, laneId) { return entries.get(runId)?.receipts.get(laneId); },

    knownPi(piId) {
      if (piIds.has(piId)) return true;
      for (const e of entries.values()) for (const l of e.run.lanes ?? []) if (l.pi?.id === piId) return true;
      return false;
    },

    loadReplays(dir) {
      let index: unknown;
      try { index = JSON.parse(readFileSync(path.join(dir, "index.json"), "utf8")); }
      catch (e) { console.log(`bus: no replays loaded (${msg(e)})`); return 0; }
      const listed = isObj(index) && Array.isArray(index.runs) ? index.runs : [];
      const loaded: string[] = [];
      for (const item of listed) {
        const id = isObj(item) ? item.runId : undefined;
        if (typeof id !== "string" || !SAFE_ID.test(id)) { console.warn("bus: skipped an index entry without a safe runId"); continue; }
        if (id === "synthetic") { console.warn("bus: skipped synthetic (test data is never loaded)"); continue; }
        if (entries.has(id)) { console.warn(`bus: replay ${id} is already loaded`); continue; }
        try {
          const f: unknown = JSON.parse(readFileSync(path.join(dir, `${id}.json`), "utf8"));
          const why = replayProblem(f, id);
          if (why) { console.warn(`bus: skipped replay ${id}: ${why}`); continue; }
          const file = f as { run: Run; events: RunEvent[]; receipts?: Record<string, unknown> };
          const receipts = new Map<string, string>();
          if (isObj(file.receipts)) for (const [lane, text] of Object.entries(file.receipts)) if (typeof text === "string") receipts.set(lane, text);
          const base = Number.isFinite(file.run.startedAt) ? file.run.startedAt : 0;
          entries.set(id, { run: file.run, events: file.events, done: true, receipts, base, order: ++counter, lateWarned: false });
          for (const ev of file.events) {
            if (PI_EVENTS.has(ev.type) && isObj(ev.data) && typeof ev.data.piId === "string") piIds.add(ev.data.piId);
          }
          loaded.push(id);
        } catch (e) {
          console.warn(`bus: skipped replay ${id}: ${msg(e)}`);
        }
      }
      const want = isObj(index) && typeof index.featured === "string" ? index.featured : undefined;
      if (want !== undefined && loaded.includes(want)) featuredId = want;
      else if (loaded.length > 0) {
        featuredId = loaded[0];
        if (want !== undefined) console.warn(`bus: featured replay ${want} was not loaded; featuring ${featuredId}`);
      }
      console.log(`bus: ${loaded.length} replay(s) loaded${featuredId ? `, featured ${featuredId}` : ""}`);
      return loaded.length;
    },
  };
  return bus;
}
