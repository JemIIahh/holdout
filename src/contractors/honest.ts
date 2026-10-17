// src/contractors/honest.ts: the honest contractor's options (DESIGN 11.2). The runaway reuses them unchanged.
import { readFileSync } from "node:fs";
import path from "node:path";
import { cfg } from "../config.js";
import type { AgentOptions, JobSpec, Vm, VmHandle } from "../contracts.js";

export interface ContractorParams {
  job: JobSpec;
  vm: VmHandle;
  vmApi: Vm;
  onSubmit: AgentOptions["onSubmit"];
  model?: string;
  fallbackModel?: string;
}

// The system prompt lives in prompts/honest.md. It resolves from the project root (cwd), never import.meta.url,
// which moves under the esbuild fallback (the code runs from dist/ there).
function systemPrompt(): string {
  return readFileSync(path.resolve(process.cwd(), "prompts/honest.md"), "utf8").trim();
}

// A fenced block that cannot be closed early by backticks inside the text.
function fenced(label: string, text: string): string {
  const body = text.endsWith("\n") ? text : `${text}\n`;
  const longest = (body.match(/`+/g) ?? []).reduce((n, run) => Math.max(n, run.length), 0);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${label}\n${fence}\n${body}${fence}`;
}

// The whole spec and all visible examples inline, so that turn 1 can already write the file.
function firstMessage(job: JobSpec): string {
  const parts = ["SPEC.md, the examples and check.sh are already in /work.", "", fenced("/work/SPEC.md", job.specMd)];
  job.visible.forEach((ex, i) => {
    parts.push("", fenced(`/work/examples/${i + 1}.in`, ex.input));
    parts.push("", fenced(`/work/examples/${i + 1}.out`, ex.expected));
  });
  return `${parts.join("\n")}\n`;
}

export function honestOptions(p: ContractorParams): AgentOptions {
  return {
    model: p.model ?? cfg.model,                           // the primary model, through the 0G router
    fallbackModel: p.fallbackModel ?? cfg.fallbackModel,   // the fallback model
    system: systemPrompt(),
    firstMessage: firstMessage(p.job),
    vm: p.vm,
    vmApi: p.vmApi,
    maxTurns: 8,
    maxTokens: 4096,
    softDeadlineSec: 75,
    onSubmit: p.onSubmit,
  };
}
