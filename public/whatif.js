// whatif.js: pure, no DOM. whatIf(events, params, run?) recomputes a recorded run under other settings and returns a NEW event list
// for the same reducer to play. It evaluates the DESIGN 9.4 checks (cost, reservation, time) at recorded decision points and settles per 9.6.
// Free-serial: if an earlier lane trips, the later lane is not run. Past a recorded trip that no longer happens: "beyond the recording".
const num = (x, d) => (typeof x === "number" && Number.isFinite(x) ? x : d);
const DROP = new Set(["fuse.tripped", "vm.destroying", "vm.destroyed", "agent.submitted"]);

export function recordedParams(events, run) {
  const s = events.find((e) => e.type === "run.started");
  const lanes = ((s && s.data && s.data.lanes) || (run && run.lanes) || []);
  const c = (lanes[0] && lanes[0].caps) || { holdCents: 500, timeCapSec: 120 };
  return { holdCents: c.holdCents, timeCapSec: c.timeCapSec, rateX: 1 };
}

function extract(events, id) {
  const ev = events.filter((e) => e.laneId === id), at = (ty) => ev.find((e) => e.type === ty);
  const w = ev.find((e) => e.type === "lane.state" && e.data.state === "working");
  return { id, W: w ? w.t : null, ticks: ev.filter((e) => e.type === "meter.tick"), turns: ev.filter((e) => e.type === "agent.turn"), submit: at("agent.submitted"),
    trip: at("fuse.tripped"), settle: ev.find((e) => e.type.startsWith("settle.")), destroying: at("vm.destroying"), destroyed: at("vm.destroyed") };
}
function costAt(L, rc, tau) {
  let tk = null; for (const e of L.ticks) { if (e.t <= tau) tk = e; else break; }
  let c = tk ? tk.data.costMicros + (rc.vmMicrosPerSec * (tau - tk.t)) / 1000 : (rc.vmMicrosPerSec * Math.max(0, tau - (L.W || 0))) / 1000;
  const from = tk ? tk.t : -1;
  for (const tu of L.turns) if (tu.t > from && tu.t <= tau) c += tu.data.tokensIn * rc.inMicrosPerTok + tu.data.tokensOut * rc.outMicrosPerTok;
  return c;
}
function meterAt(L, rc, tau) {
  let tk = null; for (const e of L.ticks) { if (e.t <= tau) tk = e; else break; }
  if (tk && tk.t === tau) return { ...tk.data };
  const done = L.turns.filter((x) => x.t <= tau), tIn = done.reduce((s, x) => s + x.data.tokensIn, 0), tOut = done.reduce((s, x) => s + x.data.tokensOut, 0);
  const workSec = (tk ? tk.data.workSec : 0) + (tau - (tk ? tk.t : L.W || 0)) / 1000;
  return { workSec, vmSeconds: workSec, tokensIn: tIn, tokensOut: tOut, turns: done.length, costMicros: Math.round(costAt(L, rc, tau)),
    infraMicros: Math.round(workSec * (rc.infraMicrosPerSec || 0)), listTokenMicros: tIn * (rc.listInMicrosPerTok || 0) + tOut * (rc.listOutMicrosPerTok || 0), estimatedTokens: false };
}
const scaleM = (m, k) => ({ ...m, costMicros: Math.round(m.costMicros * k) });

// the recorded end of a lane: a trip, a submit, or nothing
function recEnd(L) { return L.trip ? { kind: "trip", t: L.trip.t } : L.submit ? { kind: "submit", t: L.submit.t } : { kind: "none", t: null }; }
function decisionPoints(L, rc, snap, lenient) {
  const pts = [], maxTok = num(snap.maxTokens, 4096), resv = num(snap.reserveVmSec, 10), end = recEnd(L), tr = L.trip && L.trip.data;
  if (!lenient) {
    for (const e of L.ticks) pts.push({ t: e.t, kind: "tick", meter: e.data });
    for (const tu of L.turns) { const estIn = num(tu.data.estIn, tu.data.tokensIn); pts.push({ t: tu.t - tu.data.ms, kind: "call", estIn, maxOut: maxTok, next: estIn * rc.inMicrosPerTok + maxTok * rc.outMicrosPerTok + resv * rc.vmMicrosPerSec }); }
  }
  if (tr && (tr.reason === "cost_cap" || tr.reason === "time_cap")) pts.push({ t: L.trip.t, kind: "tick", meter: tr.meter, isEnd: true });
  if (tr && tr.reason === "reservation") pts.push({ t: L.trip.t, kind: "call", estIn: tr.estIn, maxOut: tr.maxOut, next: num(tr.nextStepMicros, 0), isEnd: true });
  if (tr && tr.reason === "manual") pts.push({ t: L.trip.t, kind: "manual", meter: tr.meter, isEnd: true });
  return pts.filter((p) => end.t == null || p.t <= end.t).sort((a, b) => a.t - b.t || (a.kind === "tick" ? -1 : 1));
}
function findTrip(L, rc, snap, P, holdM, lenient) {
  const k = P.rateX;
  for (const p of decisionPoints(L, rc, snap, lenient)) {
    if (p.kind === "manual") return { reason: "manual", t: p.t, meter: scaleM(p.meter, k) };
    if (p.kind === "tick") {
      if (k * p.meter.costMicros + k * rc.vmMicrosPerSec >= holdM) return { reason: "cost_cap", t: p.t, meter: scaleM(p.meter, k) };
      if (p.meter.workSec >= P.timeCapSec) return { reason: "time_cap", t: p.t, meter: scaleM(p.meter, k) };
    } else {
      const cost = k * (p.isEnd && L.trip ? L.trip.data.meter.costMicros : costAt(L, rc, p.t)), next = k * p.next;
      if (cost + next > holdM) return { reason: "reservation", t: p.t, meter: scaleM(p.isEnd && L.trip ? L.trip.data.meter : meterAt(L, rc, p.t), k), nextStepMicros: Math.round(next), estIn: p.estIn, maxOut: p.maxOut };
    }
  }
  return null;
}
function settleCalc(cost, holdC, minC, onTrip, tripped) {
  if (tripped && onTrip === "nothing") return { action: "cancel", cents: 0, reason: "no_delivery" };
  const cents = Math.floor(Math.min(cost, holdC * 10000) / 10000);
  return cents < minC ? { action: "cancel", cents: 0, reason: "under_minimum" } : { action: "capture", cents };
}

export function whatIf(events, params, runIn) {
  const startEv = events.find((e) => e.type === "run.started"), snap = (startEv && startEv.data) || runIn || {}, run = runIn || snap;
  const rec = recordedParams(events, run), rc0 = snap.rateCard || run.rateCard;
  const P = { holdCents: num(params && params.holdCents, rec.holdCents), timeCapSec: num(params && params.timeCapSec, rec.timeCapSec), rateX: num(params && params.rateX, 1) };
  const k = P.rateX, holdM = P.holdCents * 10000, lenient = P.holdCents >= rec.holdCents && k <= 1 && P.timeCapSec >= rec.timeCapSec;
  const rc = rc0, ids = ((snap.lanes || run.lanes || []).map((l) => l.laneId)), serial = num(snap.concurrency, 1) === 1;
  const minC = num(rc.minChargeCents, 50), onTrip = snap.onTrip || "metered", finals = {};
  for (const l of run.lanes || []) if (l.meter && l.settlement) finals[l.laneId] = l.meter;
  const Ls = {}, out = {}, plan = {};
  let tail = 1500, rd = null; // recorded destroy timing, reused ("measured on the recorded trip")
  for (const id of ids) Ls[id] = extract(events, id);
  for (const id of ids) { const L = Ls[id]; if (L.trip && L.destroyed && !rd) rd = { d1: L.destroying ? L.destroying.t - L.trip.t : 50, d2: L.destroyed.t - L.trip.t, ms: L.destroyed.data.ms, sb: L.destroyed.data.sandboxId, ok: L.destroyed.data.ok }; }
  let stopT = null;   // Free-serial: an earlier lane tripped, so later lanes are not run after this time
  for (const id of ids) {
    const L = Ls[id], end = recEnd(L), pl = { id, kind: "keep" };
    plan[id] = pl;
    if (stopT != null && serial && L.W != null && L.W > stopT) { pl.kind = "not_run"; pl.t = stopT; continue; }
    const z0 = L.W != null ? findTrip(L, rc, snap, P, holdM, lenient) : null;
    const mn = params && params.manual, zm = mn && mn.laneId === id && L.W != null && mn.t > L.W && (end.t == null || mn.t < end.t) ? { reason: "manual", t: mn.t, meter: scaleM(meterAt(L, rc, mn.t), k) } : null;
    const z = zm && (!z0 || zm.t < z0.t) ? zm : z0;
    if (z) { pl.kind = "trip"; pl.z = z; if (!(L.trip && L.trip.t === z.t && z.reason === L.trip.data.reason)) { if (serial) stopT = stopT == null ? z.t : Math.min(stopT, z.t); } else if (serial) stopT = stopT == null ? z.t : stopT; }
    else if (end.kind === "trip") { pl.kind = "beyond"; pl.t = end.t; }
  }
  const settleDelay = (L, from) => (L.settle ? L.settle.t - from : 500);
  const res = [];
  const keep = (e, id) => {
    const pl = plan[id]; if (!pl) return true;
    if (pl.kind === "keep") return true;
    if (pl.kind === "not_run") return e.t <= pl.t && !/^(vm\.|agent\.|meter\.|check\.|settle\.|fuse\.)/.test(e.type) && !(e.type === "lane.state" && !["holding", "held", "waiting_slot", "queued"].includes(e.data.state));
    const lim = pl.kind === "trip" ? pl.z.t : pl.t;
    if (e.t > lim) return false;
    if (DROP.has(e.type) || e.type.startsWith("settle.")) return false;
    if (e.type === "lane.state" && ["submitted", "settling", "settled", "tripped"].includes(e.data.state)) return false;
    if (e.type === "meter.tick" && e.t === lim && pl.kind === "trip") return true;
    return true;
  };
  const scaleRC = (r) => ({ ...r, vmMicrosPerSec: r.vmMicrosPerSec * k, inMicrosPerTok: r.inMicrosPerTok * k, outMicrosPerTok: r.outMicrosPerTok * k });
  const lanesOf = (lanes) => (lanes || []).map((l) => ({ ...l, caps: { holdCents: P.holdCents, timeCapSec: P.timeCapSec }, meter: l.meter && scaleM(l.meter, k) }));
  for (const e of events) {
    if (e.type === "run.started") { res.push({ ...e, data: { ...e.data, rateCard: scaleRC(e.data.rateCard), lanes: lanesOf(e.data.lanes) } }); continue; }
    if (e.type === "hold.authorized") { res.push({ ...e, data: { ...e.data, amountCents: P.holdCents } }); continue; }
    if (e.type === "vm.count") { if (Object.values(plan).some((p) => p.kind === "trip" || p.kind === "beyond" || p.kind === "not_run") && e.t > Math.min(...Object.values(plan).filter((p) => p.kind !== "keep").map((p) => (p.kind === "trip" ? p.z.t : p.t)))) continue; res.push(e); continue; }
    if (e.type === "run.finished") continue;
    if (!e.laneId) { res.push(e); continue; }
    if (!keep(e, e.laneId)) continue;
    if (e.type === "meter.tick") { res.push({ ...e, data: scaleM(e.data, k) }); continue; }
    if (e.type.startsWith("settle.")) continue;
    res.push(e);
  }
  let maxT = res.reduce((m, e) => Math.max(m, e.t), 0), nseq = 1e6;
  const add = (t, type, laneId, data) => { res.push({ seq: nseq++, t: Math.round(t), runId: snap.runId, ...(laneId ? { laneId } : {}), type, data }); maxT = Math.max(maxT, Math.round(t)); };
  for (const id of ids) {
    const L = Ls[id], pl = plan[id], piId = ((events.find((e) => e.type === "hold.authorized" && e.laneId === id) || {}).data || {}).piId, recS = L.settle && L.settle.data;
    const same = (c) => recS && recS.capturedCents === c && P.holdCents === rec.holdCents && k === 1;
    const emitSettle = (t, d, lid) => {
      if (d.action === "capture") add(t, "settle.captured", lid, { piId, capturedCents: d.cents, releasedCents: P.holdCents - d.cents, status: "succeeded", receiptSha256: same(d.cents) ? recS.receiptSha256 : "" });
      else add(t, "settle.canceled", lid, { piId, reason: d.reason, status: "canceled", receiptSha256: "" });
      add(t + 20, "lane.state", lid, { state: "settled" });
    };
    if (pl.kind === "trip") {
      const z = pl.z, d = settleCalc(z.meter.costMicros, P.holdCents, minC, onTrip, true), sd = L.trip ? settleDelay(L, L.trip.t) : 520;
      add(z.t, "fuse.tripped", id, { reason: z.reason, meter: z.meter, ...(z.nextStepMicros != null ? { nextStepMicros: z.nextStepMicros, estIn: z.estIn, maxOut: z.maxOut } : {}) });
      add(z.t, "lane.state", id, { state: "tripped" });
      const sb = (L.destroyed && L.destroyed.data.sandboxId) || (rd && rd.sb) || "sandbox";
      add(z.t + (rd ? rd.d1 : 50), "vm.destroying", id, { sandboxId: sb });
      add(z.t + Math.max(80, sd - 70), "lane.state", id, { state: "settling" });
      emitSettle(z.t + sd, d, id); out[id] = { kind: d.action, tripped: true, reason: z.reason, t: z.t, capturedCents: d.cents, releasedCents: d.action === "capture" ? P.holdCents - d.cents : P.holdCents };
      if (rd) { add(z.t + rd.d2, "vm.destroyed", id, { sandboxId: sb, ms: rd.ms, ok: rd.ok }); add(z.t + rd.d2 + 50, "vm.count", undefined, { running: 0 }); }
    } else if (pl.kind === "keep" && L.settle) {
      const fin = finals[id] ? finals[id].costMicros : costAt(L, rc, L.submit ? L.submit.t : L.settle.t), cost = Math.round(fin * k);
      const d = settleCalc(cost, P.holdCents, minC, onTrip, false);
      emitSettle(L.settle.t, d, id); out[id] = { kind: d.action, tripped: false, capturedCents: d.cents, releasedCents: d.action === "capture" ? P.holdCents - d.cents : P.holdCents };
    } else if (pl.kind === "not_run") {
      add(pl.t + 600, "settle.canceled", id, { piId, reason: "not_run", status: "canceled", receiptSha256: "" }); add(pl.t + 620, "lane.state", id, { state: "settled" });
      out[id] = { kind: "cancel", tripped: false, reason: "not_run", capturedCents: 0, releasedCents: P.holdCents };
    } else if (pl.kind === "beyond") { add(pl.t, "whatif.beyond", id, {}); out[id] = { kind: "beyond", tripped: false, t: pl.t, capturedCents: null, releasedCents: null }; }
    const rs = recS ? { capturedCents: recS.capturedCents == null ? 0 : recS.capturedCents, releasedCents: recS.releasedCents == null ? rec.holdCents : recS.releasedCents } : null;
    if (out[id]) { out[id].rec = rs; out[id].deltaCents = out[id].capturedCents != null && rs ? out[id].capturedCents - rs.capturedCents : null; }
  }
  res.push({ seq: nseq++, t: maxT + tail, runId: snap.runId, type: "run.finished", data: {} });
  res.sort((a, b) => a.t - b.t || a.seq - b.seq);
  res.forEach((e, i) => { e.seq = i + 1; });
  return { events: res, outcome: out, params: P, recorded: rec, changed: !(P.holdCents === rec.holdCents && P.timeCapSec === rec.timeCapSec && k === 1 && !(params && params.manual)) };
}
