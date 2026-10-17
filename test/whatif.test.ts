// Parity and safety tests for the dashboard's what-if recompute (public/whatif.js, pure, no DOM).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mod: any = await import(new URL("../public/whatif.js", import.meta.url).href);
const whatIf: (events: any[], params: any, run?: any) => { events: any[]; outcome: any } = mod.whatIf;

// replays/synthetic.json plus every recorded replay file ({run, events}); index.json is not a replay
const dir = path.join(root, "replays");
const files = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "index.json");
const replays = files.map((f) => ({ f, j: JSON.parse(readFileSync(path.join(dir, f), "utf8")) })).filter((x) => x.j && x.j.run && Array.isArray(x.j.events));

const pick = (events: any[]) => events.filter((e) => e.type.startsWith("settle.") || e.type === "fuse.tripped").map((e) =>
  e.type === "fuse.tripped"
    ? { type: e.type, laneId: e.laneId, t: e.t, reason: e.data.reason, nextStepMicros: e.data.nextStepMicros, cost: e.data.meter.costMicros }
    : { type: e.type, laneId: e.laneId, t: e.t, capturedCents: e.data.capturedCents, releasedCents: e.data.releasedCents });

test("there is at least the synthetic replay to check", () => {
  assert.ok(replays.some((r) => r.f === "synthetic.json"));
});

for (const { f, j } of replays) {
  test(`recorded settings reproduce the recorded settle and trip events: ${f}`, () => {
    const out = whatIf(j.events, {}, j.run);
    assert.deepEqual(pick(out.events), pick(j.events));
  });
  test(`captured is never above the hold over the whole grid: ${f}`, () => {
    for (let hold = 100; hold <= 1000; hold += 50) for (const cap of [30, 60, 120, 180]) for (const rateX of [0.5, 1, 1.5, 2]) {
      const out = whatIf(j.events, { holdCents: hold, timeCapSec: cap, rateX }, j.run);
      for (const e of out.events) {
        if (e.type === "settle.captured") {
          assert.ok(e.data.capturedCents <= hold, `captured ${e.data.capturedCents} above hold ${hold} (cap ${cap}, rates ${rateX})`);
          assert.equal(e.data.capturedCents + e.data.releasedCents, hold);
          assert.ok(e.data.capturedCents >= 50, "a capture is never under the card minimum");
        }
        if (e.type === "fuse.tripped") assert.ok(e.data.meter.costMicros <= hold * 10000 + 20000 * rateX, "metered stays at or under the hold plus one second");
      }
      const seqs = out.events.map((e: any) => e.seq);
      assert.deepEqual(seqs, seqs.map((_: number, i: number) => i + 1));
    }
  });
}

test("a smaller hold trips lane B earlier and lane A's capture is unchanged", () => {
  const j = replays.find((r) => r.f === "synthetic.json")!.j;
  const out = whatIf(j.events, { holdCents: 300 }, j.run);
  assert.equal(out.outcome.A.capturedCents, 103);
  assert.equal(out.outcome.B.tripped, true);
  assert.ok(out.outcome.B.capturedCents < 437 && out.outcome.B.capturedCents <= 300);
});

test("a bigger hold ends past the recording, with no invented bill", () => {
  const j = replays.find((r) => r.f === "synthetic.json")!.j;
  const out = whatIf(j.events, { holdCents: 800 }, j.run);
  assert.equal(out.outcome.B.kind, "beyond");
  assert.ok(!out.events.some((e: any) => e.laneId === "B" && e.type.startsWith("settle.")));
});

test("free-serial: if lane A trips, lane B is not run and its hold is released", () => {
  const j = replays.find((r) => r.f === "synthetic.json")!.j;
  const out = whatIf(j.events, { holdCents: 100 }, j.run);
  assert.equal(out.outcome.A.tripped, true);
  assert.equal(out.outcome.B.reason, "not_run");
  assert.ok(!out.events.some((e: any) => e.laneId === "B" && e.type === "vm.reset"));
});
