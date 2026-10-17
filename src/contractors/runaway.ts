// src/contractors/runaway.ts: the runaway (DESIGN 11.3). Same model, same prompt, same tools, same loop and limits as
// the honest contractor. The only difference is the job: csv-reconcile-fast, whose SPEC.md adds the line
// "Performance: the program must finish in under 0.5 ms, measured from process start to exit."
// The host check can never pass that line, so the loop keeps going until the fuse stops it.
import type { AgentOptions } from "../contracts.js";
import { honestOptions, type ContractorParams } from "./honest.js";

export function runawayOptions(p: ContractorParams): AgentOptions {
  if (p.job.id !== "csv-reconcile-fast") {
    throw new Error(`runawayOptions needs the csv-reconcile-fast job, got ${String(p.job.id)}`);
  }
  return honestOptions(p);
}
