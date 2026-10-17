// scripts/reap.ts: destroys leftover agent/notary VMs (hx-*, hn-*) by exact id.
//   npx tsx scripts/reap.ts [--dry-run] [--min-age <sec>] [--include-dev]
// Skips DEV_VM_ID and hd-* boxes unless --include-dev. Run it before every rehearsal, at 17:45 PT and after the demo.
import { reapOrphans, type ReapRow } from "../src/vm.js";

const argv = process.argv.slice(2);
const usage = (): number => {
  console.log("usage: npx tsx scripts/reap.ts [--dry-run] [--min-age <sec>] [--include-dev]");
  return 1;
};

async function main(): Promise<number> {
  let dryRun = false;
  let includeDev = false;
  let minAgeSec = 0;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--include-dev") includeDev = true;
    else if (a === "--min-age") {
      minAgeSec = Number(argv[++i]);
      if (!Number.isFinite(minAgeSec) || minAgeSec < 0) return usage();
    } else return usage();
  }
  const r = await reapOrphans({ minAgeSec, includeDev, dryRun });
  const line = (row: ReapRow): string => `${row.id}  ${row.name}  ${row.status}  ${row.ageSec}s  ${row.action}${row.why ? ` (${row.why})` : ""}`;
  const candidates = r.rows.filter((row) => row.action !== "kept");
  console.log("id  name  status  age  action");
  for (const row of candidates) console.log(line(row));
  const verb = dryRun ? "would destroy" : "destroyed";
  const n = candidates.filter((row) => row.action === (dryRun ? "would-destroy" : "destroyed")).length;
  console.log(`${verb} ${n} · kept ${r.rows.length - candidates.length} live box(es) outside the rules${includeDev ? " (--include-dev on)" : ""}${dryRun ? " · dry run" : ""}`);
  return candidates.some((row) => row.action === "failed") ? 1 : 0;
}

main().then(
  (code) => { process.exitCode = code; setTimeout(() => process.exit(code), 1500).unref(); },
  (e: unknown) => {
    const m = String(e instanceof Error ? `${e.name}: ${e.message}` : e).slice(0, 400);
    console.log(`ERROR ${m}`);
    if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|fetch failed|ConnectionError/i.test(m)) {
      console.log("NETWORK ERROR: stop and tell Main. Do not retry, do not touch network settings.");
    }
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 1500).unref();
  },
);
