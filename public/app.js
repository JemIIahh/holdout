// Holdout dashboard, direction M2 (Margin, visual-first). Plain ES module: no framework, no build step.
// One pure reducer reduce(ctx, t) folds RunEvents; every animation below is a function of t.
import { whatIf } from "./whatif.js";

export const STRIPE_BADGE = "STRIPE SANDBOX";   // one constant: the dashboard's own banner says Sandbox (SMOKE-TESTS 17:32 WAT)
const PI_LINK = (id) => `https://dashboard.stripe.com/test/payments/${id}`;   // PI_URL from decisions.env (D14)
const SEAL_CAPTION = "Outbound connections to public addresses, and DNS lookups, failed under the host firewall in our probe (rule read back on screen). The link-local metadata address 169.254.169.254 still answered, so no key ever enters the VM, the model runs on our server, and every agent command runs inside an empty network namespace.";
const REASONS = { reservation: "next step would exceed your limit", cost_cap: "cost cap", time_cap: "time cap", manual: "manual fuse" };
const CANCELS = { under_minimum: "under the $0.50 card minimum", not_run: "lane not run", no_delivery: "no delivery", infra_error: "infrastructure error", no_artifact: "no artifact", verdict_fail: "verdict failed" };
const TAIL_MS = 3500;          // the stage keeps playing this long after the last event
const FALLBACK_MS = 45000;     // a live start with no working lane after this long falls back to the recorded run
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const P = new URLSearchParams(location.search);
const NS = "http://www.w3.org/2000/svg";
const pad2 = (n) => String(n).padStart(2, "0");
const mmss = (s) => { s = Math.max(0, Math.floor(s)); return `${Math.floor(s / 60)}:${pad2(s % 60)}`; };
const cents = (micros) => Math.floor(Math.max(0, micros) / 10000);
const usd = (c) => `$${(c / 100).toFixed(2)}`;
const usdM = (micros) => usd(cents(micros));
const usd4 = (micros) => `$${(micros / 1e6).toFixed(4)}`;
const sget = (k) => { try { return sessionStorage.getItem(k); } catch (e) { return null; } };
const sset = (k, v) => { try { sessionStorage.setItem(k, v); } catch (e) { /* storage may throw */ } };
const lget = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lset = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* storage may throw */ } };
const cleanLabel = (s) => String(s || "").replace(/test[- ]mode/gi, "Stripe-sandbox");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ── Loading ────────────────────────────────────────────────────────────────
async function getJSON(url) { const r = await fetch(url, { cache: "no-store" }); if (!r.ok) throw new Error(`${url} ${r.status}`); return r.json(); }
function validFile(f) { return /^(\.\.?\/)*[A-Za-z0-9_\-]+(\/[A-Za-z0-9_\-]+)*(\.[A-Za-z0-9_\-]+)*\.json$/.test(f) && !f.includes("//") && !f.includes(":"); }
async function loadFile(f) {
  if (!validFile(f)) throw new Error("bad file parameter");
  const j = await getJSON(f);
  return { run: j.run, events: sortEvents(j.events || []), receipts: j.receipts || {} };
}
async function fetchAllEvents(id) {
  let after = 0, out = [], done = false;
  for (let i = 0; i < 40 && !done; i++) {
    const r = await getJSON(`/api/runs/${id}/events?after=${after}`);
    out = out.concat(r.events); if (r.events.length) after = r.events[r.events.length - 1].seq;
    done = r.done || r.events.length === 0;
  }
  return out;
}
async function loadFromApi(id) {
  const runs = await getJSON("/api/runs");
  const items = Array.isArray(runs) ? runs : runs.runs || [];
  let pick = id ? items.find((r) => r.runId === id) || { runId: id } : items.find((r) => r.featured) || items.slice().sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))[0];
  if (!pick) return null;
  const run = await getJSON(`/api/runs/${pick.runId}`);
  return { run, events: sortEvents(await fetchAllEvents(pick.runId)), receipts: {} };
}
function sortEvents(ev) { return ev.slice().sort((a, b) => a.t - b.t || a.seq - b.seq); }

// ── The reducer: reduce(ctx, t) → state. Pure; seeks are exact. ─────────────
const newLane = (l) => ({ id: l.laneId, kind: l.contractor, prov: l.provenance, model: l.model, jobId: l.jobId, caps: l.caps, state: "queued", note: "",
  pi: null, piHist: [], holdAt: null, vm: { phase: "none" }, tick: null, turns: [], tools: [], checks: [], trip: null, submit: null, settle: null, workAt: null, stateAt: {}, beyond: false });
export function reduce(ctx, t) {
  const S = { t, lanes: {}, order: [], running: 0, runningAt: 0, finished: false, finishedAt: null, errors: [], notary: false, vmOwner: null, run: ctx.run };
  for (const l of ctx.run.lanes || []) { S.lanes[l.laneId] = newLane(l); S.order.push(l.laneId); }
  for (const e of ctx.events) {
    if (e.t > t) break;
    const L = (e.laneId && S.lanes[e.laneId]) || null, d = e.data || {};
    switch (e.type) {
      case "lane.state": if (L) { L.state = d.state; L.note = d.note || ""; if (L.stateAt[d.state] == null) L.stateAt[d.state] = e.t; if (d.state === "working") L.workAt = e.t; } break;
      case "hold.authorized": if (L) { L.pi = { id: d.piId, amountCents: d.amountCents, status: d.status }; L.piHist.push({ status: d.status, t: e.t }); L.holdAt = e.t; } break;
      case "vm.creating": if (L) { L.vm = { phase: "creating", name: d.name, at: e.t }; S.vmOwner = L.id; } break;
      case "vm.created": if (L) { L.vm = { ...L.vm, phase: "created", sandboxId: d.sandboxId, createMs: d.createMs, createdAt: e.t }; } break;
      case "vm.sealed": if (L) { L.vm = { ...L.vm, phase: "sealed", seal: d, name: d.name || L.vm.name, sandboxId: d.sandboxId, sealedAt: e.t }; } break;
      case "vm.seal_failed": if (L) L.vm = { ...L.vm, phase: "seal_failed", failed: d }; break;
      case "vm.reset": {
        const from = S.lanes[d.fromLane];
        if (from) from.vm = { ...from.vm, phase: "handed", handedAt: e.t };
        const to = S.lanes[d.toLane] || L;
        if (to) { to.vm = { phase: "sealed", name: d.seal && d.seal.name, sandboxId: d.sandboxId, seal: d.seal, sealedAt: e.t, sharedFrom: d.fromLane, createMs: d.seal && d.seal.createMs }; S.vmOwner = to.id; }
        break;
      }
      case "vm.destroying": { const o = L || S.lanes[S.vmOwner]; if (o) o.vm = { ...o.vm, phase: "destroying", destroyingAt: e.t }; break; }
      case "vm.destroyed": { const o = L || S.lanes[S.vmOwner]; if (o) o.vm = { ...o.vm, phase: "destroyed", destroyMs: d.ms, destroyOk: d.ok, destroyedAt: e.t }; break; }
      case "vm.count": S.running = d.running; S.runningAt = e.t; break;
      case "agent.turn": if (L) L.turns.push({ ...d, at: e.t }); break;
      case "agent.tool": if (L) L.tools.push({ ...d, at: e.t }); break;
      case "agent.submitted": if (L) L.submit = { ...d, at: e.t }; break;
      case "check.result": if (L) L.checks.push({ ...d, cases: d.cases || [], at: e.t }); break;
      case "meter.tick": if (L) L.tick = { ...d, t: e.t }; break;
      case "fuse.tripped": if (L) L.trip = { ...d, meter: d.meter || L.tick || { costMicros: 0, workSec: 0, vmSeconds: 0, tokensIn: 0, tokensOut: 0, turns: 0 }, at: e.t }; break;
      case "settle.captured": if (L) { L.settle = { kind: "captured", ...d, at: e.t }; if (L.pi) L.pi = { ...L.pi, status: d.status }; L.piHist.push({ status: d.status, t: e.t }); } break;
      case "settle.canceled": if (L) { L.settle = { kind: "canceled", capturedCents: 0, releasedCents: (L.pi && L.pi.amountCents) || L.caps.holdCents, ...d, at: e.t }; if (L.pi) L.pi = { ...L.pi, status: d.status }; L.piHist.push({ status: d.status, t: e.t }); } break;
      case "settle.left": if (L) L.settle = { kind: "left", ...d, at: e.t }; break;
      case "whatif.beyond": if (L) { L.beyond = true; L.beyondAt = e.t; } break;
      case "error": S.errors.push({ ...d, at: e.t, laneId: e.laneId }); break;
      case "run.finished": S.finished = true; S.finishedAt = e.t; break;
      default: if (e.type.startsWith("notary.")) S.notary = true;
    }
  }
  return S;
}
// Metered money at time t: the server's tick plus the sandbox-time segment since it. Snaps on trip and on the final meter.
export function laneMeter(S, ln, t, ctx) {
  const rc = S.run.rateCard || {};
  if (ln.trip && ln.trip.meter) return { micros: ln.trip.meter.costMicros, workSec: ln.trip.meter.workSec, m: ln.trip.meter };
  const fin = ctx && ctx.finalMeters && ctx.finalMeters[ln.id];
  if ((ln.submit || (ln.settle && ln.state !== "working")) && fin) return { micros: fin.costMicros, workSec: fin.workSec, m: fin };
  if (ln.tick) {
    const live = ln.state === "working";
    const dt = live ? clamp(t - ln.tick.t, 0, 600) : 0;
    const micros = ln.tick.costMicros + (dt / 1000) * (rc.vmMicrosPerSec || 0);
    return { micros: Math.min(micros, ln.caps.holdCents * 10000 - 1), workSec: ln.tick.workSec + dt / 1000, m: ln.tick };
  }
  return { micros: 0, workSec: 0, m: null };
}
// ── DOM: one skeleton per lane, built once, updated by render() ─────────────
const ICON = {
  person: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="12" cy="8.4" r="3.6" fill="currentColor"/><path d="M4.8 20c.6-4 3.6-6 7.2-6s6.6 2 7.2 6z" fill="currentColor"/></svg>',
  split: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="12" r="1.7"/><circle cx="18" cy="6.2" r="1.7"/><circle cx="18" cy="17.8" r="1.7"/><path d="M7.6 11.2 16.4 6.9M7.6 12.8l8.8 4.3"/></svg>',
  lockC: '<svg class="lk-c" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="5" y="10.5" width="14" height="10" rx="2.4" fill="currentColor"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" fill="none" stroke="currentColor" stroke-width="2.2"/></svg>',
  lockO: '<svg class="lk-o" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="5" y="10.5" width="14" height="10" rx="2.4" fill="currentColor"/><path d="M8 10.5V8a4 4 0 0 1 7.4-2" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  chev: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
const PROBE_ANG = [-90, -148, -32];
const VM_SVG = `<svg class="vm s-idle" viewBox="0 0 100 100" aria-hidden="true">
<circle class="ring" cx="50" cy="50" r="46"/>
<path class="hexd" d="M50 34 64 42 64 58 50 66 36 58 36 42Z" fill="none" stroke="var(--ink4)" stroke-width="1" stroke-dasharray="1.5 3"/>
<g class="hg"><path d="M43.5 39.5h13M43.5 60.5h13M44.8 39.5c0 6.5 5.2 7 5.2 10.5s-5.2 4-5.2 10.5M55.2 39.5c0 6.5-5.2 7-5.2 10.5s5.2 4 5.2 10.5"/></g>
<g class="cube"><path class="f1" d="M50 34 64 42 50 50 36 42Z"/><path class="f2" d="M36 42 50 50 50 66 36 58Z"/><path class="f3" d="M50 50 64 42 64 58 50 66Z"/></g>
<g class="probes">${PROBE_ANG.map(() => '<g class="probe"><line class="ln"/><line class="blk"/></g>').join("")}</g>
<g class="lockb"><circle cx="50" cy="96" r="7.4"/><rect x="46.6" y="95.2" width="6.8" height="5" rx="1.2"/><path d="M47.8 95.2v-1.5a2.2 2.2 0 0 1 4.4 0v1.5"/></g>
<g class="down"><path d="M50 74v11M45.6 81l4.4 4.4 4.4-4.4" fill="none" stroke="var(--ink2)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></g>
<g class="shards">${[0, 1, 2, 3, 4, 5, 6].map(() => '<polygon points="0,-7 6,-2 3,6 -5,4"/>').join("")}</g>
<text class="vmtxt" x="50" y="51"></text><text class="vmtxt2" x="50" y="61"></text></svg>`;
const SNAP_SVG = `<svg class="snap" viewBox="0 0 44 52" aria-hidden="true"><defs><radialGradient id="burnGrad"><stop offset="0" stop-color="var(--bad)" stop-opacity=".45"/><stop offset="1" stop-color="var(--bad)" stop-opacity="0"/></radialGradient></defs>
<circle class="burn" cx="22" cy="26" r="20"/><path class="stub" d="M2 26h13.5l3-4.5M42 26h-12l-3 5"/><circle class="bead" cx="19" cy="21.4" r="2.2"/><circle class="bead" cx="27" cy="31.4" r="2.2"/><g class="sparks">${Array(9).fill('<line x1="22" y1="26" x2="22" y2="26"/>').join("")}</g></svg>`;
const NAMES = { honest: "Honest", runaway: "Runaway", "runaway-busyloop": "Busy loop", cheater: "Cheater", sloppy: "Sloppy" };
function laneHTML(l) {
  const fixture = l.provenance === "scripted-fixture";
  const diff = l.contractor === "runaway" || l.jobId === "csv-reconcile-fast";
  return `<header class="lhead"><span class="lnum" data-pop="lane">${esc(l.laneId)}</span><h2 class="lname" data-pop="lane" tabindex="0">${esc(NAMES[l.contractor] || l.contractor)}</h2>
  ${fixture ? `<span class="diffchip" data-pop="lane">${l.contractor === "runaway-busyloop" ? "SCRIPTED FIXTURE · trips on time cap" : l.contractor === "cheater" ? "SCRIPTED RED-TEAM FIXTURE" : "SCRIPTED FIXTURE"}</span>` : ""}${diff ? '<span class="diffchip" data-pop="job" tabindex="0"><b>+</b> &lt;0.5 ms</span>' : ""}
  <span class="lspacer"></span><span class="lreason dim" data-ref="reason"></span><span class="tag" data-ref="tag" data-pop="tag"><i></i><span data-ref="tagT">QUEUED</span></span>
  <span class="lclock" data-ref="clock"><b data-ref="clockN">0:00</b><span class="dim"> / <span data-ref="clockCap">2:00</span></span></span>
  <button type="button" class="chev" data-ref="chev" aria-expanded="false" aria-label="Lane details">${ICON.chev}</button></header>
<div class="lbody"><div class="track" data-ref="track">
  <svg class="arc" data-ref="arc" aria-hidden="true"><path class="arc-p" data-ref="arcP"/><line class="paylink" data-ref="payL" stroke="var(--wire)" stroke-width="1"/><g data-ref="dotsOk"></g><g data-ref="dotsRel"></g></svg>
  <span class="arc-chip" data-ref="arcChip"></span>
  <div class="n-card" data-pop="card" tabindex="0" data-ref="card"><i class="cardimg"></i><span class="tank-l" data-ref="tankL">$5.00</span><div class="tank" data-ref="tank"><i class="tank-fill" data-ref="tankF"></i>${ICON.lockC}${ICON.lockO}</div></div>
  <i class="link" data-ref="link1"></i>
  <div class="n-vm" data-pop="vm" tabindex="0" data-ref="vmBox" role="img" aria-label="Sealed microVM">${VM_SVG}<div class="fails" data-pop="check" data-ref="fails"></div></div>
  <i class="link" data-ref="link2"></i>
  <div class="n-fuse fz" data-pop="fuse" tabindex="0" data-ref="fuse" role="img" aria-label="Fuse and meter">
    <div class="fz-res" data-ref="res"><span class="res-lab" data-ref="resLab"></span><i class="res-band" data-ref="resBand"></i><i class="res-over" data-ref="resOver"></i><i class="res-limit" data-ref="resLim"></i></div>
    <div class="fz-bar" data-ref="bar"><i class="cap capl"></i><div class="glass" data-ref="glass"><i class="wire"></i><i class="heat" data-ref="heat"></i><i class="capt"></i><i class="relseg"></i><i class="beyond"></i><i class="wirecut" data-ref="wcut"></i>${SNAP_SVG}</div><i class="cap capr" data-ref="capr"></i><i class="ghostcap" data-ref="ghost"></i>${ADMIN ? '<button type="button" class="pull" data-ref="pull" aria-label="Pull the fuse" title="Pull the fuse"></button>' : ""}</div>
    <div class="fz-marks" data-ref="marks"></div><div class="fz-scale" data-ref="scale"></div></div>
  <div class="n-pay"><div class="n-stripe idle" data-pop="stripe" tabindex="0" data-ref="stripe"><div class="sbox">${ICON.split}</div><span class="nlabel">Stripe</span></div>
    <div class="n-ctr" data-pop="ctr" tabindex="0" data-ref="ctr"><div class="cbox">${ICON.person}</div><span class="camt" data-ref="camt"></span></div></div>
</div><div class="readout" data-ref="readout">
  <div class="big is-hold" data-ref="big" data-pop="readout"><sup>$</sup><span data-ref="bigv">0.00</span></div>
  <div class="rlabel" data-ref="rlabel"><i class="sq"></i><span data-ref="rltxt">Hold</span></div><div class="rwhy dim" data-ref="rwhy"></div>
  <div class="rrel" data-ref="rrel"><i class="dashsq"></i><span data-ref="rrt">released</span> <b data-ref="relv"></b></div>
  <div class="deltas" data-ref="deltas"></div>
  <div class="rcpt" data-ref="rcpt" data-pop="receipt" tabindex="0"><span class="stamp" data-ref="stamp">Settled</span><div class="paper"><div class="r"><span>metered</span><b data-ref="rm"></b></div><div class="r r2"><span>captured</span><b data-ref="rc"></b></div><div class="sha" data-ref="rsha"></div></div></div>
</div></div>
<div class="drawer" data-ref="drawer" hidden></div>`;
}
const R = {};          // lane refs by id
let CTX = null;        // { run, events, finalMeters, source, ... }
function buildLanes(run) {
  const host = $("#lanes"); host.textContent = "";
  for (const k of Object.keys(R)) delete R[k];
  for (const l of run.lanes) {
    const el = document.createElement("article");
    el.className = "lane"; el.dataset.lane = l.laneId; el.id = `lane-${l.laneId}`; el.dataset.state = "queued";
    el.innerHTML = laneHTML(l); host.appendChild(el);
    const r = { root: el, id: l.laneId, c: {} };
    $$("[data-ref]", el).forEach((n) => { r[n.dataset.ref] = n; });
    r.vm = $(".vm", el); r.probes = $$(".probe", el); r.shards = $$(".shards polygon", el); r.sparks = $$(".sparks line", el);
    r.vmTxt = $(".vmtxt", el); r.vmTxt2 = $(".vmtxt2", el); r.snap = $(".snap", el); r.dots = { ok: [], rel: [] };
    for (let i = 0; i < 4; i++) { const c = document.createElementNS(NS, "circle"); c.setAttribute("r", "3"); c.setAttribute("class", "pdot"); r.dotsOk.appendChild(c); r.dots.ok.push(c); }
    for (let i = 0; i < 6; i++) { const c = document.createElementNS(NS, "circle"); c.setAttribute("r", "2.6"); c.setAttribute("class", "pdot g"); r.dotsRel.appendChild(c); r.dots.rel.push(c); }
    r.chips = new Map(); r.markMap = new Map(); r.geo = null; r.axisKey = "";
    R[l.laneId] = r;
  }
}
// geometry in track coordinates, measured once per layout pass
function layout(r) {
  const tb = r.track.getBoundingClientRect(); if (!tb.width) return;
  const rel = (el) => { const b = el.getBoundingClientRect(); return { x: b.left - tb.left, y: b.top - tb.top, w: b.width, h: b.height, cx: b.left - tb.left + b.width / 2, cy: b.top - tb.top + b.height / 2, r: b.right - tb.left, b: b.bottom - tb.top }; };
  const vertical = getComputedStyle(r.track).flexDirection === "column" || matchMedia("(max-width: 640px)").matches;
  const g = { vertical, w: tb.width, h: tb.height, tank: rel(r.tank), stripe: rel($(".sbox", r.stripe)), ctr: rel($(".cbox", r.ctr)), vm: rel(r.vmBox), bar: rel(r.glass), glass: rel(r.glass) };
  r.geo = g;
  const t = g.tank, s = g.stripe;
  let d;
  if (vertical) { const x0 = t.r + 4, y0 = t.cy, x1 = s.r + 2, y1 = s.cy, bx = Math.max(x0, x1) + 54; d = `M${x0},${y0} C${bx},${y0} ${bx},${y1} ${x1},${y1}`; }
  else { const x0 = t.cx, y0 = t.y - 3, x1 = s.cx, y1 = s.y - 3, top = Math.min(y0, y1) - 38; d = `M${x0},${y0} C${x0 + (x1 - x0) * 0.22},${top} ${x1 - (x1 - x0) * 0.22},${top} ${x1},${y1}`; }
  r.arcP.setAttribute("d", d); r.arcLen = r.arcP.getTotalLength();
  const a = g.stripe, b = g.ctr, dx = b.cx - a.cx, dy = b.cy - a.cy, dl = Math.hypot(dx, dy) || 1;
  r.payL.setAttribute("x1", a.cx + (dx / dl) * 24); r.payL.setAttribute("y1", a.cy + (dy / dl) * 24); r.payL.setAttribute("x2", b.cx - (dx / dl) * 22); r.payL.setAttribute("y2", b.cy - (dy / dl) * 22);
  r.pay = { x1: a.cx + (dx / dl) * 24, y1: a.cy + (dy / dl) * 24, x2: b.cx - (dx / dl) * 22, y2: b.cy - (dy / dl) * 22 };
  const mid = r.arcP.getPointAtLength(r.arcLen / 2); r.arcChip.style.left = `${mid.x}px`; r.arcChip.style.top = `${mid.y}px`;
}
function layoutAll() { Object.values(R).forEach(layout); }
// ── Rendering: render(state, t) only writes what changed ────────────────────
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)");
const ease = (x) => 1 - Math.pow(1 - clamp(x, 0, 1), 3);
const sT = (el, v) => { if (el._t !== v) { el._t = v; el.textContent = v; } };
const sH = (el, v) => { if (el._h !== v) { el._h = v; el.innerHTML = v; } };
const sA = (el, k, v) => { const key = "_a" + k; if (el[key] !== v) { el[key] = v; el.setAttribute(k, v); } };
const sV = (el, k, v) => { const key = "_v" + k; if (el[key] !== v) { el[key] = v; el.style.setProperty(k, v); } };
const sC = (el, k, on) => { const key = "_c" + k; on = !!on; if (el[key] !== on) { el[key] = on; el.classList.toggle(k, on); } };
const pct = (x) => `${(x * 100).toFixed(3)}%`;
const TAG = { queued: ["QUEUED", ""], holding: ["HOLDING", ""], held: ["HELD", "t-held"], waiting_slot: ["WAITING", ""], provisioning: ["SEALING", ""], working: ["WORKING", "t-working"],
  submitted: ["DONE", ""], verifying: ["VERIFYING", ""], tripped: ["TRIPPED", "t-tripped"], settling: ["SETTLING", ""], settled: ["SETTLED", "t-settled"], failed: ["FAILED", "t-failed"] };
const turnMicros = (rc, tu) => (tu.tokensIn || 0) * rc.inMicrosPerTok + (tu.tokensOut || 0) * rc.outMicrosPerTok;
const chipClass = (m) => (m < 200000 ? "" : m < 350000 ? "c2" : "c3");
function vmPhase(ln) {
  const v = ln.vm.phase;
  if (v === "none") return ln.state === "waiting_slot" ? "wait" : "idle";
  if (v === "sealed") return ln.state === "working" ? "working" : "sealed";
  if (v === "destroying" || v === "destroyed") return "destroyed";
  if (v === "seal_failed") return "failed";
  return v;   // creating, created, handed
}
function renderLane(r, ln, S, t, ctx) {
  const rc = S.run.rateCard, holdC = ln.caps.holdCents, holdM = holdC * 10000, recM = (ctx.recHoldCents || holdC) * 10000, axisM = Math.max(holdM, recM);
  const M = laneMeter(S, ln, t, ctx), settle = ln.settle, trip = ln.trip, hasHold = ln.holdAt != null;
  const tag = ln.beyond ? ["BEYOND", "t-held"] : trip ? TAG.tripped : settle && settle.kind === "canceled" ? ["RELEASED", "t-settled"] : TAG[ln.state] || ["", ""];
  sT(r.tagT, tag[0]); r.tag.className = `tag ${tag[1]}`;
  sT(r.reason, trip ? REASONS[trip.reason] || trip.reason : settle && settle.kind === "canceled" ? "hold released · " + (CANCELS[settle.reason] || settle.reason) : "");
  sT(r.rwhy, trip ? REASONS[trip.reason] || trip.reason : "");
  sT(r.clockN, mmss(M.workSec)); sT(r.clockCap, mmss(ln.caps.timeCapSec));
  r.root.dataset.state = ln.state; sC(r.root, "x", false); r.root.dataset.trip = trip ? "1" : "0";
  // hold tank
  sT(r.tankL, usd(holdC));
  const relShare = settle ? clamp(settle.releasedCents / holdC, 0, 1) : hasHold ? 1 : 0;
  sV(r.tankF, "--h", pct(relShare)); sC(r.tank, "rel", !!settle);
  sC(r.link1, "on", ln.state === "working");
  // sealed microVM
  const ph = vmPhase(ln), vm = r.vm, v = ln.vm;
  vm.setAttribute("class", `vm s-${ph}`);
  const cube = $(".cube", vm), hexd = $(".hexd", vm), hg = $(".hg", vm), lockb = $(".lockb", vm), down = $(".down", vm), shards = $(".shards", vm);
  const created = v.createdAt != null ? v.createdAt : v.at, cprog = ph === "creating" ? clamp((t - v.at) / Math.max(1500, (v.createMs || 6200)), 0, 1) : 1;
  const dAge = v.destroyingAt != null ? t - v.destroyingAt : -1;
  sA(cube, "opacity", ph === "idle" || ph === "wait" || ph === "failed" ? 0 : ph === "creating" ? (0.1 + 0.55 * cprog).toFixed(2) : ph === "created" ? 0.65 : ph === "handed" ? 0.2 : ph === "destroyed" ? (dAge < 160 && !REDUCED.matches ? 1 : 0) : 1);
  sA(hexd, "opacity", ph === "idle" || ph === "wait" || ph === "failed" ? 0.9 : 0);
  sA(hg, "opacity", ph === "wait" ? 1 : 0); sA(down, "opacity", ph === "handed" ? 1 : 0);
  sA(lockb, "opacity", ph === "sealed" || ph === "working" || ph === "handed" ? 1 : 0);
  const sealAge = v.sealedAt != null ? t - v.sealedAt : -1, showP = (ph === "sealed" || ph === "working" || ph === "handed");
  r.probes.forEach((g, i) => {
    const p = showP ? ease((sealAge - i * 140) / 480) : 0, a = (PROBE_ANG[i] * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    const r1 = 22 + 20 * p, ln_ = $(".ln", g), blk = $(".blk", g);
    sA(g, "opacity", showP && p > 0 ? (ph === "handed" ? 0.3 : 1) : 0);
    sA(ln_, "x1", (50 + c * 22).toFixed(1)); sA(ln_, "y1", (50 + s * 22).toFixed(1)); sA(ln_, "x2", (50 + c * r1).toFixed(1)); sA(ln_, "y2", (50 + s * r1).toFixed(1));
    const bx = 50 + c * 44, by = 50 + s * 44, px = -s * 4.6, py = c * 4.6;
    sA(blk, "x1", (bx + px).toFixed(1)); sA(blk, "y1", (by + py).toFixed(1)); sA(blk, "x2", (bx - px).toFixed(1)); sA(blk, "y2", (by - py).toFixed(1));
    sA(blk, "opacity", p >= 1 ? 1 : 0);
  });
  r.shards.forEach((s, i) => {
    if (ph !== "destroyed" || dAge < 0 || REDUCED.matches) { sA(s, "opacity", 0); return; }
    const k = ease(dAge / 750), a = (i / 7) * Math.PI * 2 + 0.5, rad = 10 + 15 * ((i * 37) % 7) / 7 * k + 8 * k, rot = (i * 53) % 90 + k * (60 + i * 25);
    sA(s, "opacity", 1); sA(s, "transform", `translate(${(50 + Math.cos(a) * rad * 1.1).toFixed(1)} ${(50 + Math.sin(a) * rad).toFixed(1)}) rotate(${rot.toFixed(0)}) scale(${(0.8 + 0.3 * ((i * 17) % 5) / 5).toFixed(2)})`);
  });
  const ms = v.destroyMs;
  sT(r.vmTxt, ph === "destroyed" && ms != null ? `${(ms / 1000).toFixed(1)} s` : ph === "destroyed" && dAge > 10000 ? "pending" : "");
  sT(r.vmTxt2, ph === "destroyed" && ms != null ? "MEASURED" : "");
  const failed = ln.checks.filter((c) => !c.pass), lastF = failed[failed.length - 1];
  sH(r.fails, failed.length ? `<span class="x">${"×".repeat(Math.min(failed.length, 12))}</span> ${lastF && lastF.cases.length ? Math.max(...lastF.cases.map((c) => c.ms)).toFixed(1) : ""} ms` : "");
  // stripe + contractor nodes
  sC(r.stripe, "idle", !hasHold); sC(r.stripe, "ok", !!settle && settle.kind === "captured");
  sC(r.ctr, "ok", !!settle && settle.kind === "captured"); sT(r.camt, settle && settle.kind === "captured" ? usd(settle.capturedCents) : "");
  renderFuse(r, ln, S, t, ctx, M, { holdM, axisM, recM, rc });
  // readout
  let big, cls = "is-hold", label = "Hold";
  if (!hasHold) big = usd(0);
  else if (settle && settle.kind === "captured") { big = usd(settle.capturedCents); cls = "is-ok"; label = "Captured"; }
  else if (settle && settle.kind === "canceled") { big = usd(0); cls = "is-ok"; label = "Released"; }
  else if (M.micros > 0 || trip || ln.state === "working" || ln.state === "submitted" || ln.state === "settling") { big = usdM(M.micros); cls = "is-warn"; label = "Metered"; }
  else big = usd(holdC);
  sT(r.bigv, big.slice(1)); r.big.className = `big ${cls}`; sT(r.rltxt, label); r.rlabel.className = `rlabel ${cls}`;
  const rel = settle && settle.kind === "captured" ? settle.releasedCents : settle && settle.kind === "canceled" ? settle.releasedCents : null;
  sT(r.relv, rel != null ? usd(rel) : ""); sC(r.rrel, "on", rel != null && !ctx.whatifOn);
  sT(r.arcChip, rel != null ? usd(rel) : ""); sC(r.arcChip, "on", rel != null && rel > 0);
  sC(r.rcpt, "in", !!settle && settle.kind === "captured" && !ctx.whatifOn);
  if (settle && settle.kind === "captured") {
    sT(r.stamp, trip ? "Tripped" : "Settled"); sC(r.stamp, "trip", !!trip); sT(r.rm, usdM(M.micros)); sT(r.rc, usd(settle.capturedCents));
    const h = settle.receiptSha256 || ""; sT(r.rsha, h ? `sha ${h.slice(0, 6)}…${h.slice(-4)}` : "");
  }
  const oc = ctx.whatifOn && ctx.outcome && ctx.outcome[ln.id];
  if (oc) {
    let h = "";
    if (oc.kind === "beyond") h = '<span class="dchip badc">beyond the recording</span>';
    else {
      if (oc.deltaCents != null) h += oc.deltaCents === 0 ? '<span class="dchip">= recorded</span>' : `<span class="dchip ${oc.deltaCents < 0 ? "good" : ""}">${oc.deltaCents < 0 ? "−" : "+"}${usd(Math.abs(oc.deltaCents))} vs recorded</span>`;
      if (oc.tripped && trip) h += `<span class="dchip badc">trips ${mmss(trip.meter.workSec)}</span>`;
    }
    sH(r.deltas, h);
  } else sH(r.deltas, "");
  // dots after settlement (a function of t)
  const age = settle ? t - settle.at : -1, live = age >= 0 && age < 4200 && !REDUCED.matches && r.geo;
  r.dots.ok.forEach((c, i) => {
    if (!live || !(settle.capturedCents > 0) || !r.pay) { sA(c, "opacity", 0); return; }
    const q = ((age / 1000) * 0.55 + i * 0.25) % 1, f = Math.min(1, age / 300) * Math.min(1, (4200 - age) / 400);
    sA(c, "cx", (r.pay.x1 + (r.pay.x2 - r.pay.x1) * q).toFixed(1)); sA(c, "cy", (r.pay.y1 + (r.pay.y2 - r.pay.y1) * q).toFixed(1)); sA(c, "opacity", (Math.sin(q * Math.PI) * f).toFixed(2));
  });
  r.dots.rel.forEach((c, i) => {
    if (!live || !(settle.releasedCents > 0)) { sA(c, "opacity", 0); return; }
    const q = ((age / 1000) * 0.3 + i / 6) % 1, f = Math.min(1, age / 300) * Math.min(1, (4200 - age) / 400), pt = r.arcP.getPointAtLength((1 - q) * r.arcLen);
    sA(c, "cx", pt.x.toFixed(1)); sA(c, "cy", pt.y.toFixed(1)); sA(c, "opacity", (Math.sin(q * Math.PI) * f).toFixed(2));
  });
}
const tipPoint = (g, p) => (g.vertical ? { x: g.glass.cx + 26, y: g.glass.y + 4 + (g.glass.h - 8) * p } : { x: g.glass.x + 4 + (g.glass.w - 8) * p, y: g.glass.cy - 30 });
function buildScale(r, holdM, axisM, recM) {
  const step = axisM / 250000 > 44 ? 500000 : 250000; let h = "";
  for (let m = 0; m <= axisM + 1; m += step) h += `<i class="tk ax ${m % 1000000 === 0 ? "m1" : m % 500000 === 0 ? "m5" : ""}" style="--s:${pct(m / axisM)}"></i>`;
  h += `<span class="sl ax" style="--s:0%">$0</span><span class="sl ax hold" style="--s:${pct(holdM / axisM)}">${usd(holdM / 10000)}</span>`;
  if (recM !== holdM && recM <= axisM) h += `<span class="sl ax" style="--s:${pct(recM / axisM)};opacity:.55">${usd(recM / 10000)}</span>`;
  r.scale.innerHTML = h;
}
function renderFuse(r, ln, S, t, ctx, M, k) {
  const { holdM, axisM, recM, rc } = k, fz = r.fuse, trip = ln.trip, settle = ln.settle, working = ln.state === "working" && !trip, hasHold = ln.holdAt != null;
  sC(fz, "held", hasHold && !working && !settle && !trip); sC(fz, "live", working && !ln.beyond); sC(fz, "tripped", !!trip); sC(fz, "settled", !!settle && settle.kind !== "left");
  sC(fz, "bey", !!ln.beyond); sC(fz, "ghost", recM !== holdM);
  const key = `${holdM}|${axisM}|${recM}`;
  if (r.axisKey !== key) { r.axisKey = key; buildScale(r, holdM, axisM, recM); sV(r.bar, "--hp", (holdM / axisM).toFixed(4)); sV(r.ghost, "--n", (recM / axisM).toFixed(4)); requestAnimationFrame(() => layout(r)); }
  const p = clamp(M.micros / holdM, 0, 1); sV(r.glass, "--p", p.toFixed(4)); sC(r.heat, "off", p <= 0.0005);
  sV(r.glass, "--c", (settle && settle.kind === "captured" ? clamp((settle.capturedCents * 10000) / holdM, 0, 1) : 0).toFixed(4));
  // turn marks: one pill per model turn, as long as the money that turn's tokens added
  let before = 0;
  ln.turns.forEach((tu) => {
    const cost = turnMicros(rc, tu), start = rc.vmMicrosPerSec * (ln.workAt != null ? (tu.at - ln.workAt) / 1000 : 0) + before; before += cost;
    let el = r.markMap.get(tu.turn); if (!el) { el = document.createElement("i"); r.marks.appendChild(el); r.markMap.set(tu.turn, el); }
    el.className = `mk ax ${chipClass(cost)}`; sV(el, "--s", pct(start / axisM)); sV(el, "--w", pct(cost / axisM));
  });
  for (const [n, el] of r.markMap) if (!ln.turns.some((tu) => tu.turn === n)) { el.remove(); r.markMap.delete(n); }
  // cost chips pop out of the VM and hop into the fuse tip
  const g = r.geo, alive = new Set();
  if (g && !REDUCED.matches) ln.turns.forEach((tu) => {
    const age = t - tu.at; if (age < 0 || age > 1000) return; alive.add(tu.turn);
    const cost = turnMicros(rc, tu); let el = r.chips.get(tu.turn);
    if (!el) { el = document.createElement("span"); el.className = `fz-chip ${chipClass(cost)}`; el.textContent = `$${(cost / 1e6).toFixed(2)}`; r.track.appendChild(el); r.chips.set(tu.turn, el); }
    const q = age / 1000, e = ease(q), a0 = { x: g.vm.cx + 20, y: g.vm.cy - 34 }, a1 = tipPoint(g, p);
    el.style.transform = `translate(${(a0.x + (a1.x - a0.x) * e).toFixed(1)}px,${(a0.y + (a1.y - a0.y) * e - Math.sin(Math.PI * q) * 24).toFixed(1)}px) translate(-50%,-50%) scale(${(1 + Math.min(cost / 500000, 1) * 0.28).toFixed(2)})`;
    el.style.opacity = q < 0.72 ? 1 : (1 - (q - 0.72) / 0.28).toFixed(2);
  });
  for (const [n, el] of r.chips) if (!alive.has(n)) { el.remove(); r.chips.delete(n); }
  // the trip: snap, sparks, shake, and the reservation band
  const age = trip ? t - trip.at : -1;
  r.sparks.forEach((l, i) => {
    const a = (i / 9) * Math.PI * 2 + 0.35, q = clamp(age / 650, 0, 1), on = age >= 0 && age < 650 && !REDUCED.matches, rr = 6 + 22 * ease(q);
    sA(l, "x1", (22 + Math.cos(a) * rr * 0.45).toFixed(1)); sA(l, "y1", (26 + Math.sin(a) * rr * 0.45).toFixed(1)); sA(l, "x2", (22 + Math.cos(a) * rr).toFixed(1)); sA(l, "y2", (26 + Math.sin(a) * rr).toFixed(1)); sA(l, "opacity", on ? (1 - q).toFixed(2) : 0);
  });
  sC(r.fuse, "fx-shake", age >= 0 && age < 340 && !REDUCED.matches);
  if (trip && trip.nextStepMicros) {
    const m = trip.meter.costMicros, nx = trip.nextStepMicros, over = Math.max(0, m + nx - holdM);
    sV(r.resBand, "--s", pct(m / axisM)); sV(r.resBand, "--w", pct(Math.max(0, Math.min(m + nx, holdM) - m) / axisM));
    sV(r.resOver, "--s", pct(holdM / axisM)); sV(r.resOver, "--w", pct(over / axisM)); sV(r.resLim, "--s", pct(holdM / axisM)); sV(r.resLab, "--s", pct(m / axisM));
    sT(r.resLab, `+${usd(Math.round(nx / 10000))}`); r.res.style.opacity = REDUCED.matches ? 1 : clamp(age / 220, 0, 1).toFixed(2);
  } else r.res.style.opacity = 0;
}
function renderAll(S, t, ctx) {
  for (const id of S.order) if (R[id]) renderLane(R[id], S.lanes[id], S, t, ctx);
  sT($("#vmCountN"), String(S.running));
  const dur = ctx.dur, st = ctx.stages;
  $$("#stages button[data-stage]").forEach((b) => {
    const i = Number(b.dataset.stage); if (Number.isNaN(i) || !st[i]) return;
    const [a, z] = st[i], f = clamp((t - a) / Math.max(1, z - a), 0, 1), cur = t >= a && (t < z || i === 3);
    sV(b, "--f", (cur ? f : 0).toFixed(3)); sA(b, "aria-current", cur ? "true" : "false"); sC(b, "trip", i === 2 && ctx.hasTrip);
  });
  const pr = clamp(t / dur, 0, 1);
  $("#scrubFill").style.width = pct(pr); $("#scrubKnob").style.left = pct(pr); sA($("#scrub"), "aria-valuenow", String(Math.round(pr * 100)));
  sT($("#clockNow"), mmss(t / 1000)); sT($("#clockEnd"), mmss(dur / 1000));
}
// ── Popovers: real values, hover / focus / tap, Esc closes ──────────────────
const pop = $("#pop"); let popKey = null, popTarget = null;
const dl = (rows) => `<dl>${rows.filter(Boolean).map(([a, b]) => `<dt>${esc(a)}</dt><dd>${b}</dd>`).join("")}</dl>`;
const piLink = (id, S) => (S.run.source === "synthetic" || !id ? esc(id || "none") : `<a href="${PI_LINK(id)}" target="_blank" rel="noopener">${esc(id)} ↗</a>`);
function laneLabel(ln, S) {
  const fx = ln.prov === "scripted-fixture", rep = S.run.source !== "live";
  if (ln.kind === "runaway-busyloop") return "SCRIPTED FIXTURE · trips on time cap"; if (ln.kind === "cheater") return "SCRIPTED RED-TEAM FIXTURE";
  if (fx) return "SCRIPTED FIXTURE";
  if (ln.kind === "runaway") return `${rep ? "" : "LIVE · "}same agent + 1 impossible line`;
  return `${rep ? "" : "LIVE · "}${ln.model || "model"} via 0G router`;
}
function popHTML(kind, id, S, t) {
  const ctx = CTX, rc = S.run.rateCard || {}, ln = id ? S.lanes[id] : null, M = ln ? laneMeter(S, ln, t, ctx) : null;
  const H = (title, body) => `<h4>${esc(title)}</h4>${body}`;
  switch (kind) {
    case "lane": return H(`Lane ${id}`, dl([["label", esc(laneLabel(ln, S))], ["model", esc(ln.model || "none")], ["job", esc(ln.jobId)], ["time cap", mmss(ln.caps.timeCapSec)]]));
    case "job": return H("Job card diff", `<p><b>+ must finish in under 0.5 ms</b> (SPEC.md). The host check can never pass, so the agent keeps trying until the fuse trips.</p>`);
    case "tag": return H("Lane state", dl([["state", esc(ln.trip ? "tripped" : ln.state)], ["note", esc(ln.note || (ln.state === "waiting_slot" ? "waiting for the sandbox · Free plan runs 1 microVM at a time" : "none"))]]));
    case "card": return H("Authorization hold", dl([["hold", usd(ln.caps.holdCents)], ["PaymentIntent", piLink(ln.pi && ln.pi.id, S)], ["status", esc(ln.pi ? ln.pi.status : "none")], ["history", esc(ln.piHist.map((h) => h.status).join(" → ") || "none")]]));
    case "vm": { const v = ln.vm, s = v.seal;
      return H("Sealed microVM", dl([["name", esc(v.name || "not created yet")], ["sandbox", esc(v.sandboxId || "none")], ["created", v.createMs != null ? `${(v.createMs / 1000).toFixed(1)} s (measured)` : "none"],
        ["egress read back", s ? esc(JSON.stringify(s.egressReadback)) : "none"], ...(s ? s.probes.map((p) => [`${p.label} exit`, String(p.exit)]) : []), s && s.sharedFrom ? ["handed from", `lane ${esc(s.sharedFrom)} (/work wiped, re-probed)`] : null,
        v.destroyMs != null ? ["destroyed in", `${(v.destroyMs / 1000).toFixed(1)} s (measured)`] : null]) + `<p>${SEAL_CAPTION}</p>`); }
    case "check": { const f = ln.checks.filter((c) => !c.pass), l = f[f.length - 1];
      return H("Host check", dl([["failed", String(f.length)], ["latest", l && l.cases.length ? `${Math.max(...l.cases.map((c) => c.ms)).toFixed(1)} ms` : "none"], ["limit", "0.5 ms"]]) + `<p>Each rejection adds a ×. The spec line: must finish in under 0.5 ms.</p>`); }
    case "fuse": return H("Fuse · meter", dl([["metered", `${usd4(M.micros)}`], ["hold", usd(ln.caps.holdCents)], ["time", `${mmss(M.workSec)} / ${mmss(ln.caps.timeCapSec)}`],
      M.m ? ["sandbox", `${Number(M.m.vmSeconds).toFixed(1)} s`] : null, M.m ? ["tokens in / out", `${M.m.tokensIn.toLocaleString()} / ${M.m.tokensOut.toLocaleString()}`] : null,
      ln.trip ? ["tripped", `${esc(REASONS[ln.trip.reason] || ln.trip.reason)} at ${mmss(ln.trip.meter.workSec)}`] : null, ln.trip && ln.trip.nextStepMicros ? ["refused next step", `+${usd4(ln.trip.nextStepMicros)}`] : null]) +
      `<p>The fuse trips when metered + 1 s of sandbox reaches the hold, when the next model call could cross it, or at the time cap.</p>`);
    case "stripe": return H("Stripe", dl([["PaymentIntent", piLink(ln.pi && ln.pi.id, S)], ["status", esc(ln.pi ? ln.pi.status : "none")], ["captured", ln.settle ? usd(ln.settle.capturedCents) : "none"], ["released", ln.settle ? usd(ln.settle.releasedCents) : "none"]]) + (S.run.source === "synthetic" ? "<p>Synthetic data: no Stripe object exists.</p>" : "<p>Read from Stripe.</p>"));
    case "ctr": return H("Contractor", dl([["captured", ln.settle ? usd(ln.settle.capturedCents) : "none"]]) + "<p>Stripe pays out only what was captured.</p>");
    case "readout": return H("Meter", dl([["metered", usd4(M.micros)], ["posted rates", `${rc.version || ""}`], ["sandbox", `$${((rc.vmMicrosPerSec || 0) / 1e6).toFixed(2)} per s`], ["in / out", `$${rc.inMicrosPerTok} / $${rc.outMicrosPerTok} per M`]]) + (ln.submit ? `<p>DONE · self-reported. ${esc(ln.submit.selfReport || "")}</p>` : ""));
    case "receipt": return H("Client receipt", dl([["metered", usd4(M.micros)], ["captured", ln.settle ? usd(ln.settle.capturedCents) : "none"], ["sha256", esc((ln.settle && ln.settle.receiptSha256) || "none")]]));
    case "run": return H("Run", dl([["label", esc(cleanLabel(S.run.label))], ["source", esc(S.run.source)], ["mode", esc(S.run.mode)], ["run id", esc(S.run.runId)]]));
    case "rates": return H("Posted demo rates", dl([["sandbox", `$${((rc.vmMicrosPerSec || 0) / 1e6).toFixed(3)} per s`], ["input", `$${rc.inMicrosPerTok} per M tokens`], ["output", `$${rc.outMicrosPerTok} per M tokens`], ["list input", `$${rc.listInMicrosPerTok} per M`], ["list output", `$${rc.listOutMicrosPerTok} per M`], ["card minimum", usd(rc.minChargeCents || 50)]]) + "<p>Posted client prices, not list prices. List prices are shown for comparison.</p>");
    case "count": return H("microVMs", dl([["running", String(S.running)]]) + "<p>Free plan runs one microVM at a time.</p>");
    default: return "";
  }
}
function showPop(el, key) {
  const [kind] = key.split(":"); popKey = key; popTarget = el; refreshPop(); pop.hidden = false;
  const b = el.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
  let x = clamp(b.left + b.width / 2 - w / 2, 8, innerWidth - w - 8), y = b.top - h - 10; if (y < 8) y = Math.min(b.bottom + 10, innerHeight - h - 8);
  pop.style.left = `${x}px`; pop.style.top = `${y}px`; el.setAttribute("aria-describedby", "pop"); void kind;
}
function refreshPop() { if (!popKey || !CTX) return; const [kind, id] = popKey.split(":"); const html = popHTML(kind, id, STATE.S, STATE.t); if (pop._h !== html) { pop._h = html; pop.innerHTML = html; } }
function hidePop() { popKey = null; if (popTarget) popTarget.removeAttribute("aria-describedby"); popTarget = null; pop.hidden = true; }
function popKeyFor(el) { const n = el.closest("[data-pop]"); if (!n) return null; const lane = n.closest(".lane"); return [`${n.dataset.pop}:${lane ? lane.dataset.lane : ""}`, n]; }
// ── Drawer ──────────────────────────────────────────────────────────────────
function renderDrawer(r, ln, S, t) {
  const rc = S.run.rateCard || {}, M = laneMeter(S, ln, t, CTX), m = M.m, v = ln.vm, s = v.seal, vmUs = m ? m.vmSeconds * rc.vmMicrosPerSec : 0;
  const html = `<div><h3>microVM</h3>${dl([["name", esc(v.name || "none")], ["sandbox", esc(v.sandboxId || "none")], ["egress read back", s ? esc(JSON.stringify(s.egressReadback)) : "none"],
    ...(s ? s.probes.map((p) => [`${p.label} exit`, String(p.exit)]) : []), v.destroyMs != null ? ["destroyed in", `${(v.destroyMs / 1000).toFixed(1)} s (measured)`] : null])}</div>
  <div><h3>Stripe</h3>${dl([["PaymentIntent", piLink(ln.pi && ln.pi.id, S)], ["status", esc(ln.piHist.map((h) => h.status).join(" → ") || "none")], ["hold", usd(ln.caps.holdCents)],
    ["captured", ln.settle ? usd(ln.settle.capturedCents) : "none"], ["released", ln.settle ? usd(ln.settle.releasedCents) : "none"]])}</div>
  <div><h3>Meter</h3>${dl([["sandbox", m ? `${Number(m.vmSeconds).toFixed(1)} s · ${usd4(vmUs)}` : "none"], ["input", m ? `${m.tokensIn.toLocaleString()} tok · ${usd4(m.tokensIn * rc.inMicrosPerTok)}` : "none"],
    ["output", m ? `${m.tokensOut.toLocaleString()} tok · ${usd4(m.tokensOut * rc.outMicrosPerTok)}` : "none"], ["metered", usd4(M.micros)], ["at list", m ? `sandbox ${usd4(m.infraMicros)} · tokens ${usd4(m.listTokenMicros)}` : "none"]])}</div>
  <p class="cap-txt">${SEAL_CAPTION}</p>`;
  if (r.drawer._h !== html) { r.drawer._h = html; r.drawer.innerHTML = html; }
}
// ── Player ──────────────────────────────────────────────────────────────────
const STATE = { S: null, t: 0 };
const player = { t: 0, playing: false, speed: 1, last: 0, ended: false, live: false, di: 0 };
function computeStages(ev, dur) {
  const fw = ev.find((e) => e.type === "lane.state" && e.data.state === "working"), tr = ev.find((e) => e.type === "fuse.tripped");
  const subs = ev.filter((e) => e.type === "agent.submitted"), a = fw ? fw.t : 0, fz = tr ? tr.t : subs.length ? subs[subs.length - 1].t : dur;
  const sz = Math.min(dur, fz + 1800); return { stages: [[0, a], [a, fz], [fz, sz], [sz, dur]], hasTrip: !!tr };
}
function prepare(src) {
  const run = src.run, events = src.events, last = events.length ? events[events.length - 1].t : 0, dur = last + TAIL_MS, finalMeters = {};
  for (const l of run.lanes || []) if (l.meter && l.settlement) finalMeters[l.laneId] = l.meter;
  const sg = computeStages(events, dur);
  return { run, events, baseEvents: events, baseRun: run, finalMeters, baseFinal: finalMeters, dur, stages: sg.stages, hasTrip: sg.hasTrip, outcome: null, recTimeCap: ((run.lanes || [])[0] || { caps: { timeCapSec: 120 } }).caps.timeCapSec, recHoldCents: ((run.lanes || [])[0] || { caps: { holdCents: 500 } }).caps.holdCents, whatifOn: false, receipts: src.receipts || {}, source: run.source };
}
function applyBadges(run, failed) {
  const mode = failed ? "failed" : run.source === "live" ? "live" : run.source === "synthetic" ? "syn" : "";
  const b = $("#srcBadge"); b.className = `pill src ${mode}`;
  sT($("#srcText"), failed ? "RECORDED" : run.source === "live" ? "LIVE" : run.source === "synthetic" ? "SYNTHETIC" : "RECORDED");
  const lab = $("#runLabel"); const text = run.source === "synthetic" ? "SYNTHETIC · test data · not a recorded run" : run.source === "replay" ? cleanLabel(run.label) : "";
  lab.hidden = !text; lab.textContent = text; lab.title = text; sT($("#stripeBadge"), STRIPE_BADGE); sT($("#footStripe"), "Stripe sandbox");
  const fl = $("#footL");
  if (run.source !== "synthetic" && (run.lanes || []).some((l) => l.pi)) fl.innerHTML = "PaymentIntents: " + run.lanes.filter((l) => l.pi).map((l) => `${esc(l.laneId)} <a href="${PI_LINK(l.pi.id)}" target="_blank" rel="noopener">${esc(l.pi.id)} ↗</a>`).join(" · ");
  else fl.textContent = "Never pay more than the hold.";
}
function scrubMarks(ctx) {
  const ev = ctx.events.filter((e) => e.type.startsWith("settle.") || e.type === "fuse.tripped");
  $("#scrubMarks").innerHTML = ev.map((e) => `<i class="${e.type === "fuse.tripped" ? "trip" : ""}" style="left:${pct(e.t / ctx.dur)}"></i>`).join("");
}
function setSource(src, opts = {}) {
  CTX = prepare(src); buildLanes(CTX.run); applyBadges(CTX.run, opts.failed);
  $("#empty").hidden = true; $("#lanes").hidden = false; scrubMarks(CTX); resetDials(); $("#whatifBadge").hidden = true; if (!opts.failed) $("#banner").hidden = true;
  $("#stages [data-stage='verify']").hidden = !CTX.events.some((e) => e.type.startsWith("notary."));
  player.t = 0; player.di = 0; player.ended = false; setPlaying(false);
  requestAnimationFrame(() => { layoutAll(); draw(); });
}
function setPlaying(on) {
  player.playing = on && !player.live; if (on) player.ended = false;
  const b = $("#play"); b.classList.toggle("playing", player.playing); b.setAttribute("aria-label", player.playing ? "Pause" : "Play");
}
function seek(ms) { if (!CTX) return; player.t = clamp(ms, 0, CTX.dur); player.ended = false; draw(); }
function dispatchNew(t) {
  const ev = CTX.baseEvents; if (CTX.whatifOn) return;
  if (player.di > 0 && ev[player.di - 1] && ev[player.di - 1].t > t) { player.di = ev.filter((e) => e.t <= t).length; return; }
  while (player.di < ev.length && ev[player.di].t <= t) { window.dispatchEvent(new CustomEvent("holdout:event", { detail: ev[player.di] })); player.di++; }
}
function draw() {
  if (!CTX) return;
  const t = player.t; let S;
  try { S = reduce(CTX, t); STATE.S = S; STATE.t = t; renderAll(S, t, CTX); dispatchNew(t); } catch (err) { if (!draw.warned) { draw.warned = true; console.error("render failed", err); } return; }
  for (const id of S.order) { const r = R[id]; if (r && !r.drawer.hidden && (!r.dAt || performance.now() - r.dAt > 250)) { r.dAt = performance.now(); renderDrawer(r, S.lanes[id], S, t); } }
  if (popKey) refreshPop();
  $("#veil").hidden = !(player.t >= CTX.dur - 1 && !player.playing && !player.live && CTX.dur > TAIL_MS && !CTX.whatifOn && $("#whatif").hidden);
  const bt = $("#btnTrip"); if (bt) bt.hidden = !(LIVE_OK && player.live);
}
function frame(now) {
  requestAnimationFrame(frame); const dt = Math.min(100, now - player.last); player.last = now;
  if (!CTX) return;
  if (player.live) { const last = CTX.events.length ? CTX.events[CTX.events.length - 1].t : 0; player.t = Math.min(adm.base.server + (performance.now() - adm.base.local), last + 800); player.dirty = true; }
  if (player.playing) { player.t += dt * player.speed; if (player.t >= CTX.dur) { player.t = CTX.dur; setPlaying(false); player.ended = true; player.dirty = true; } }
  if (player.playing || player.dirty) { player.dirty = false; draw(); }
}
function setSpeed(x) { player.speed = clamp(x, 0.25, 8); $$("#speed button").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.speed) === player.speed))); sT($("#speed1 b"), `${player.speed}×`); }
function jumpStage(i) { if (CTX && CTX.stages[i]) { seek(CTX.stages[i][0] + (i === 2 ? 0 : 10)); player.dirty = true; } }
// ── Theme, wiring ───────────────────────────────────────────────────────────
function setTheme(th, persist) {
  document.documentElement.setAttribute("data-theme", th); $("#thBlack").setAttribute("aria-pressed", String(th === "black")); $("#thWhite").setAttribute("aria-pressed", String(th === "white"));
  if (persist) lset("holdout-theme", th);
}
function wire() {
  setTheme(document.documentElement.getAttribute("data-theme") === "white" ? "white" : "black", false);
  $("#thBlack").onclick = () => setTheme("black", true); $("#thWhite").onclick = () => setTheme("white", true);
  $("#play").onclick = () => { if (!CTX) return; if (player.t >= CTX.dur) player.t = 0; setPlaying(!player.playing); player.dirty = true; };
  $("#again").onclick = () => { player.t = 0; player.di = 0; setPlaying(true); player.dirty = true; };
  $$("#speed button").forEach((b) => { b.onclick = () => setSpeed(Number(b.dataset.speed)); });
  $("#speed1").onclick = () => { const o = [1, 2, 4, 0.5]; setSpeed(o[(o.indexOf(player.speed) + 1) % o.length]); };
  $$("#stages button[data-stage]").forEach((b) => { b.onclick = () => jumpStage(Number(b.dataset.stage)); });
  const sc = $("#scrub"); let drag = false;
  const at = (e) => { const b = sc.getBoundingClientRect(); seek(clamp((e.clientX - b.left) / b.width, 0, 1) * CTX.dur); };
  sc.addEventListener("pointerdown", (e) => { if (!CTX) return; drag = true; sc.setPointerCapture(e.pointerId); at(e); });
  sc.addEventListener("pointermove", (e) => { if (drag) at(e); }); sc.addEventListener("pointerup", () => { drag = false; }); sc.addEventListener("pointercancel", () => { drag = false; });
  $("#lanes").addEventListener("click", (e) => {
    const c = e.target.closest(".chev"); if (!c) return; const r = R[c.closest(".lane").dataset.lane], open = c.getAttribute("aria-expanded") !== "true";
    c.setAttribute("aria-expanded", String(open)); r.drawer.hidden = !open; r.dAt = 0; player.dirty = true; requestAnimationFrame(layoutAll);
  });
  // popovers: hover, focus, tap
  document.addEventListener("pointerover", (e) => { if (e.pointerType === "touch") return; const k = popKeyFor(e.target); if (k && k[0] !== popKey) showPop(k[1], k[0]); else if (!k && popKey && !pop.contains(e.target)) hidePop(); });
  document.addEventListener("focusin", (e) => { const k = popKeyFor(e.target); if (k) showPop(k[1], k[0]); });
  document.addEventListener("focusout", (e) => { if (!pop.contains(e.relatedTarget)) hidePop(); });
  document.addEventListener("click", (e) => { const k = popKeyFor(e.target); if (k && e.pointerType !== "mouse" && matchMedia("(hover: none)").matches) { if (popKey === k[0]) hidePop(); else showPop(k[1], k[0]); } else if (!k && !pop.contains(e.target)) hidePop(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { hidePop(); return; }
    const tg = e.target; if (tg && /^(INPUT|TEXTAREA|SELECT)$/.test(tg.tagName) && tg.type !== "range") return;
    if (e.metaKey || e.ctrlKey || e.altKey || !CTX) return;
    if (e.key === " " || e.code === "Space") { e.preventDefault(); onSpace(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); seek(player.t + 2000); } else if (e.key === "ArrowLeft") { e.preventDefault(); seek(player.t - 2000); }
    else if (/^[1-4]$/.test(e.key)) jumpStage(Number(e.key) - 1);
  });
  document.addEventListener("keyup", (e) => { if (e.key === " " || e.code === "Space") e.preventDefault(); });
  window.addEventListener("resize", () => { layoutAll(); player.dirty = true; });
  if (window.ResizeObserver) new ResizeObserver(() => { layoutAll(); player.dirty = true; }).observe($("#lanes"));
}
// ── Tier 2: what-if, pull the fuse, presenter safety ────────────────────────
const ADMIN = P.get("admin") === "1", FILE_MODE = !!P.get("file"), LIVE_OK = ADMIN && !FILE_MODE;
const FB_MS = ADMIN && P.get("fallback") ? clamp(Number(P.get("fallback")) * 1000 || FALLBACK_MS, 1000, 120000) : FALLBACK_MS;
const adm = { token: ADMIN ? sget("holdout-admin") || "" : "", health: null, started: false, label: "", flash: "", runId: null, t0: 0, base: { server: 0, local: 0 } };
const wf = { hold: 5, cap: 120, rate: 1 };
function recompute(events) { const last = events.length ? events[events.length - 1].t : 0; CTX.dur = last + TAIL_MS; const sg = computeStages(events, CTX.dur); CTX.stages = sg.stages; CTX.hasTrip = sg.hasTrip; scrubMarks(CTX); }
function restoreRecorded() {
  const oldDur = CTX.dur;
  Object.assign(CTX, { run: CTX.baseRun, events: CTX.baseEvents, finalMeters: CTX.baseFinal, whatifOn: false, outcome: null });
  const atEnd = player.t >= oldDur - 1; recompute(CTX.events); $("#whatifBadge").hidden = true; player.t = atEnd ? CTX.dur : Math.min(player.t, CTX.dur); player.dirty = true;
}
function applyWhatIf(manual) {
  if (!CTX || CTX.run.source === "live") return;
  const params = { holdCents: Math.round(wf.hold * 100), timeCapSec: wf.cap, rateX: wf.rate }; if (manual) params.manual = manual;
  const w = whatIf(CTX.baseEvents, params, CTX.baseRun);
  if (!w.changed) { restoreRecorded(); return; }
  const s = w.events.find((e) => e.type === "run.started").data, k = params.rateX, fm = {};
  for (const [id, m] of Object.entries(CTX.baseFinal)) fm[id] = { ...m, costMicros: Math.round(m.costMicros * k) };
  const run = { ...CTX.baseRun, rateCard: s.rateCard, lanes: CTX.baseRun.lanes.map((l) => ({ ...l, caps: { holdCents: params.holdCents, timeCapSec: params.timeCapSec } })) };
  const oldDur = CTX.dur, atEnd = player.t >= oldDur - 1;
  Object.assign(CTX, { run, events: w.events, finalMeters: fm, whatifOn: true, outcome: w.outcome }); recompute(w.events);
  $("#whatifBadge").hidden = false; player.t = atEnd ? CTX.dur : Math.min(player.t, CTX.dur); player.dirty = true;
}
function syncDials() {
  const h = $("#wfHold"), c = $("#wfCap"), r = $("#wfRate"), rh = (CTX.recHoldCents || 500) / 100;
  wf.hold = Number(h.value); wf.cap = Number(c.value); wf.rate = Number(r.value);
  sT($("#wfHoldV"), `$${wf.hold.toFixed(2)}`); sT($("#wfCapV"), mmss(wf.cap)); sT($("#wfRateV"), `${wf.rate.toFixed(2)}×`);
  $("#wfHoldV").classList.toggle("rec", wf.hold === rh); $("#wfCapV").classList.toggle("rec", wf.cap === CTX.recTimeCap); $("#wfRateV").classList.toggle("rec", wf.rate === 1);
}
function resetDials() { $("#wfHold").value = (CTX.recHoldCents || 500) / 100; $("#wfCap").value = CTX.recTimeCap || 120; $("#wfRate").value = 1; syncDials(); }
function wireWhatIf() {
  const tg = $("#btnWhatif"), panel = $("#whatif");
  tg.onclick = () => { const open = panel.hidden; panel.hidden = !open; tg.setAttribute("aria-expanded", String(open)); if (open && CTX) resetDialsIfFresh(); };
  const onIn = () => { syncDials(); applyWhatIf(); };
  ["#wfHold", "#wfCap", "#wfRate"].forEach((q) => $(q).addEventListener("input", onIn));
  $("#wfBack").onclick = () => { resetDials(); restoreRecorded(); };
}
function resetDialsIfFresh() { if (!CTX.whatifOn) resetDials(); }
function pullFuse(id) {
  if (!CTX) return; const S = STATE.S, ln = S && S.lanes[id]; if (!ln || ln.state !== "working" || ln.trip) return;
  if (CTX.run.source === "live") { if (adm.token) fetch(`/api/runs/${CTX.run.runId}/trip`, { method: "POST", headers: { Authorization: `Bearer ${adm.token}` } }).then((r) => { if (r.status === 401) { adm.token = ""; sset("holdout-admin", ""); updateArmed(); } }).catch(() => {}); return; }
  applyWhatIf({ laneId: id, t: Math.round(player.t) }); if (!player.playing) setPlaying(true);
}
function wirePull() {
  if (!ADMIN) return;
  $("#lanes").addEventListener("pointerdown", (e) => {
    const b = e.target.closest(".pull"); if (!b) return; const id = b.closest(".lane").dataset.lane, y0 = e.clientY; b.setPointerCapture(e.pointerId); let done = false;
    const mv = (ev) => { if (!done && ev.clientY - y0 > 14) { done = true; pullFuse(id); } };
    b.addEventListener("pointermove", mv); b.addEventListener("pointerup", () => { b.removeEventListener("pointermove", mv); if (!done && Math.abs(0) === 0) pullFuse(id); }, { once: true });
  });
}
function armedInfo() {
  if (!adm.token) return { ok: false, label: "not admin", cls: "bad" };
  if (adm.started) return { ok: false, label: adm.label || "running", cls: adm.label === "already ran" || adm.label === "live failed" ? "bad" : "run" };
  if (adm.flash) return { ok: false, label: adm.flash, cls: "bad" };
  const h = adm.health; if (!h) return { ok: false, label: "run live", cls: "" };
  if (h.running !== 0) return { ok: false, label: "run live", cls: "" };
  const left = ((h.creates && h.creates.cap) || 0) - ((h.creates && h.creates.used24h) || 0);
  if (left < 2) return { ok: false, label: "ledger low", cls: "bad" };
  return { ok: true, label: "armed", cls: "on" };
}
function updateArmed() {
  if (!LIVE_OK) return; const a = armedInfo(), el = $("#armed");
  el.hidden = false; $("#btnRun").hidden = false; el.className = `armed ${a.cls}`; sT($("#armedText"), a.label.toUpperCase()); $("#btnRun").disabled = !a.ok;
}
async function pollHealth() { if (!LIVE_OK || !adm.token || adm.started) return; try { adm.health = await getJSON("/api/health"); } catch (e) { adm.health = null; } updateArmed(); }
async function startLive() {
  if (!LIVE_OK) return; const a = armedInfo(); if (!a.ok || adm.started) return;
  adm.started = true; adm.label = "running"; updateArmed();
  try {
    const r = await fetch("/api/runs", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${adm.token}` }, body: JSON.stringify({ mode: "fuse", lanes: ["honest", "runaway"] }) });
    if (r.status === 401) { adm.token = ""; sset("holdout-admin", ""); adm.started = false; updateArmed(); return; }
    if (r.status === 409) { adm.started = false; adm.flash = "already running"; updateArmed(); setTimeout(() => { adm.flash = ""; pollHealth(); }, 6000); return; }
    if (!r.ok) throw new Error("start failed");
    const j = await r.json(); await goLive(j.runId);
  } catch (e) { fallbackToRecorded(); }
}
async function goLive(runId) {
  const run = await getJSON(`/api/runs/${runId}`);
  adm.runId = runId; adm.t0 = performance.now(); adm.base = { server: 0, local: performance.now() };
  setSource({ run: { ...run, source: "live" }, events: [] }); player.live = true; setPlaying(false);
  $("#dock").classList.add("is-live"); let after = 0;
  while (adm.runId === runId) {
    try {
      const r = await getJSON(`/api/runs/${runId}/events?after=${after}`);
      if (r.events.length) {
        after = r.events[r.events.length - 1].seq; CTX.baseEvents = CTX.events = CTX.events.concat(r.events); recompute(CTX.events);
        adm.base = { server: r.events[r.events.length - 1].t, local: performance.now() };
        if (r.events.some((e) => e.type === "error")) { await fallbackToRecorded(); return; }
      }
      if (r.done) { player.live = false; adm.runId = null; adm.label = "already ran"; updateArmed(); try { const fin = await getJSON(`/api/runs/${runId}`); CTX.run = CTX.baseRun = { ...fin, source: "live" }; for (const l of fin.lanes || []) if (l.meter) CTX.finalMeters[l.laneId] = l.meter; } catch (e) { /* the last tick stands */ } sT($("#srcText"), "FINISHED"); $("#srcBadge").className = "pill src"; player.t = CTX.dur; player.dirty = true; return; }
      const working = CTX.events.some((e) => e.type === "lane.state" && e.data.state === "working");
      if (!working && performance.now() - adm.t0 > FB_MS) { await fallbackToRecorded(); return; }
    } catch (e) { await fallbackToRecorded(); return; }
    await new Promise((res) => setTimeout(res, 500));
  }
}
async function fallbackToRecorded() {
  adm.runId = null; player.live = false; adm.started = true; adm.label = "live failed"; $("#dock").classList.remove("is-live");
  let src = null; try { src = await loadFromApi(null); } catch (e) { src = null; }
  if (src && src.run) {
    const m = /Recorded run (\d+)/i.exec(src.run.label || ""); setSource(src, { failed: true }); setPlaying(true);
    $("#bannerText").textContent = `Live run failed: showing recorded run ${m ? m[1] : src.run.runId}`; $("#banner").hidden = false;
  } else { $("#bannerText").textContent = "Live run failed: no recorded run yet"; $("#banner").hidden = false; }
  updateArmed();
}
function onSpace() { if (ADMIN) { startLive(); return; } $("#play").click(); }
async function main() {
  wire(); wireWhatIf(); wirePull();
  if (LIVE_OK) {
    if (!adm.token) { let tk = null; try { tk = window.prompt("Admin token"); } catch (e) { tk = null; } if (tk && tk.trim()) { adm.token = tk.trim(); sset("holdout-admin", adm.token); } }
    $("#btnRun").onclick = startLive; $("#btnTrip").onclick = () => { for (const id of STATE.S.order) pullFuse(id); }; updateArmed(); pollHealth(); setInterval(pollHealth, 4000);
  }
  let src = null;
  try { src = P.get("file") ? await loadFile(P.get("file")) : await loadFromApi(P.get("run")); } catch (e) { src = null; }
  if (!src || !src.run) { $("#lanes").hidden = true; $("#empty").hidden = false; $("#dock").hidden = true; applyBadges({ source: "replay", lanes: [] }); sT($("#srcText"), "NO RUN"); return; }
  setSpeed(clamp(Number(P.get("speed")) || 1, 0.25, 8));
  setSource(src);
  const t0 = Number(P.get("t")); if (t0 > 0) seek(t0 * 1000);
  if (P.get("paused") !== "1") setPlaying(true);
  requestAnimationFrame(frame);
}
main();
