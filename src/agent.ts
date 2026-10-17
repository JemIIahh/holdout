// src/agent.ts: the tool loop every live lane uses (DESIGN 11.1). The model runs on our server through the
// 0G router; the sealed VM is only its hands. ROUTER_* are read through src/config.ts only, never ANTHROPIC_*.
import Anthropic from "@anthropic-ai/sdk";
import { cfg } from "./config.js";
import type { AgentHooks, AgentOptions, AgentOutcome, ExecResult, RunAgent } from "./contracts.js";

type Tool = Anthropic.Tool;
type Message = Anthropic.Message;
type MessageParam = Anthropic.MessageParam;
type ContentBlockParam = Anthropic.ContentBlockParam;
type ToolResultBlockParam = Anthropic.ToolResultBlockParam;

// The model's command goes over stdin and becomes ONE argv element of the inner bash (DESIGN 8.4, brief C10):
// it is never spliced into a shell string. The guest `timeout` kills the process group at 25 s.
export const AGENT_WRAPPER = 'exec timeout -k 2 25 unshare -n bash -c "$(cat)"';

export const RUN_COMMAND: Tool = {
  name: "run_command",
  description:
    "Run a bash command in your private Linux sandbox (Python 3.13, no internet). 25 s limit per command. " +
    "Returns the exit code, the elapsed milliseconds and the last 4,000 characters of output. " +
    "Never start background processes with &.",
  input_schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The bash command line to run, for example a heredoc that writes a file, or: bash /work/check.sh",
      },
    },
    required: ["command"],
  },
};

export const SUBMIT: Tool = {
  name: "submit",
  description:
    "Call once, when you are done. The host then runs its own acceptance check and tells you the result. " +
    "Give one sentence saying what you built.",
  input_schema: {
    type: "object",
    properties: { summary: { type: "string", description: "One sentence." } },
    required: ["summary"],
  },
};

const CALL_TIMEOUT_MS = 30_000;   // one router turn took 96 s once (SMOKE-TESTS): cut it at 30 s, retry once, then fall back
const EXEC_TIMEOUT_SEC = 35;      // client side; the guest `timeout` fires first, at 25 s
const TAIL_CHARS = 4000;          // tool result: last 4,000 characters of stdout then stderr
const LOG_CHARS = 4096;           // a rejected submit pastes at most 4 KB of the host check log
const SUMMARY_CHARS = 1000;
const CHECK_NUDGE = "Run bash /work/check.sh, then call submit.";
const DEADLINE_NUDGE = "Time is almost up: run check.sh once and submit.";
const FINAL_REASONS = new Set(["max_tokens", "refusal", "model_context_window_exceeded"]);

/** Characters of the JSON-encoded system prompt and messages divided by 4, rounded up (the fuse's reservation input). */
export function estTokens(system: string, messages: unknown[]): number {
  return Math.ceil((JSON.stringify(system).length + JSON.stringify(messages).length) / 4);
}

// What the loop needs from a client. The real SDK client satisfies it; tests inject a mock.
export interface CallOptions { signal?: AbortSignal; timeout?: number; maxRetries?: number }
export interface MessagesLike {
  messages: {
    create(body: Anthropic.MessageCreateParamsNonStreaming, options?: CallOptions): PromiseLike<Message>;
  };
}

// ── Errors: classify, scrub, race against the fuse's abort ───────────────────
const ABORTED = Symbol("aborted");

function statusOf(e: unknown): number | undefined {
  const s = (e as { status?: unknown } | null | undefined)?.status;
  return typeof s === "number" ? s : undefined;
}

// A short error text for the outcome and the page: never a key, never a header.
function describe(e: unknown): string {
  const status = statusOf(e);
  let text = e instanceof Error ? e.message : String(e);
  if (cfg.routerKey.length >= 8) text = text.split(cfg.routerKey).join("[redacted]");
  if (status !== undefined && text.startsWith(`${status} `)) text = text.slice(String(status).length + 1);   // the SDK prefixes it
  text = text
    .replace(/(x-api-key|authorization|api[-_ ]?key)(["']?\s*[:=]\s*)(Bearer\s+)?[^\s,;"']+/gi, "$1$2[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  if (status !== undefined) return text ? `HTTP ${status}: ${text}` : `HTTP ${status}`;
  const name = e instanceof Error && e.name ? e.name : "Error";
  return text ? `${name}: ${text}` : name;
}

type Failure =
  | { kind: "abort" }
  | { kind: "switch"; why: string }      // 403 or 404: this model is not served on this route; go to the fallback now
  | { kind: "transient"; why: string }   // timeout, connection error, 408, 429, 5xx: retry once, then the fallback
  | { kind: "fatal"; why: string };      // any other HTTP status (400, 401, 402, 422 ...): stop

function classify(e: unknown, signal: AbortSignal): Failure {
  if (e === ABORTED || signal.aborted || e instanceof Anthropic.APIUserAbortError) return { kind: "abort" };
  const why = describe(e);
  const status = statusOf(e);
  if (status === 403 || status === 404) return { kind: "switch", why };
  if (status === undefined || status === 408 || status === 429 || status >= 500) return { kind: "transient", why };
  return { kind: "fatal", why };
}

// Resolves with p, or rejects with ABORTED the moment the signal fires, even if p never settles
// (a client or a VM exec that ignores the abort must not hold the lane open). The loser is ignored.
function raceAbort<T>(p: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      Promise.resolve(p).then(undefined, () => {});
      reject(ABORTED);
      return;
    }
    const onAbort = () => reject(ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(p).then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e) => { signal.removeEventListener("abort", onAbort); reject(e); },
    );
  });
}

// ── Usage: the router reports it; if a response ever lacks it, estimate and say so ───────────────
function readUsage(msg: Message, estIn: number): { tokensIn: number; tokensOut: number; estimated: boolean } {
  const u = msg.usage as Partial<Message["usage"]> | undefined | null;
  const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  const hasIn = !!u && num(u.input_tokens);
  const hasOut = !!u && num(u.output_tokens);
  // input_tokens excludes cached tokens; we never send cache_control, so the cache_* fields should be 0 or null.
  // They are added so a router that caches on its own can never make the meter read low.
  const tokensIn = hasIn
    ? u!.input_tokens! + (num(u!.cache_creation_input_tokens) ? u!.cache_creation_input_tokens : 0) +
      (num(u!.cache_read_input_tokens) ? u!.cache_read_input_tokens : 0)
    : estIn;
  const tokensOut = hasOut ? u!.output_tokens! : Math.ceil(JSON.stringify(msg.content ?? []).length / 4);
  return { tokensIn, tokensOut, estimated: !(hasIn && hasOut) };
}

// ── Tool results ─────────────────────────────────────────────────────────────
const toolError = (id: string, text: string): ToolResultBlockParam =>
  ({ type: "tool_result", tool_use_id: id, is_error: true, content: text });

// What the model sees for one command: `exit=<n> ms=<ms>`, then the last 4,000 characters of stdout then stderr.
function renderExec(r: ExecResult): { exit: number; ms: number; tail: string; text: string } {
  const exit = r.timedOut ? 124 : typeof r.exit === "number" ? r.exit : -1;
  const ms = Math.round(typeof r.ms === "number" ? r.ms : 0);
  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? "";
  let out = stdout + (stdout && stderr && !stdout.endsWith("\n") ? "\n" : "") + stderr;
  if ((r.timedOut || exit === 124) && !out.includes("command timed out")) {
    out += (out && !out.endsWith("\n") ? "\n" : "") + "command timed out";
  }
  const tail = out.slice(-TAIL_CHARS);
  return { exit, ms, tail, text: `exit=${exit} ms=${ms}\n${tail}` };
}

// ── The loop ─────────────────────────────────────────────────────────────────
export function createRunAgent(client: MessagesLike): RunAgent {
  return async function run(o: AgentOptions, h: AgentHooks): Promise<AgentOutcome> {
    const started = Date.now();
    const messages: MessageParam[] = [{ role: "user", content: o.firstMessage }];
    let model = o.model;     // the model that runs; it switches at most once per lane, to o.fallbackModel, and stays there
    let switched = false;
    let deadlineSent = false;
    const end = (outcome: AgentOutcome["outcome"], extra: Partial<AgentOutcome> = {}): AgentOutcome =>
      ({ outcome, ...extra, model });

    try {
      for (let turn = 1; turn <= o.maxTurns; turn++) {
        if (h.signal.aborted) return end("aborted");

        // One model call. beforeCall runs before EVERY attempt, retries included (the fuse reserves each one).
        // A timeout, 429 or 5xx is retried once on the same model, then the lane moves to the fallback model;
        // a 403 or 404 moves there at once; any failure after the move is the outcome.
        let msg: Message;
        let estIn = 0;
        let retriesLeft = switched ? 0 : 1;
        const t0 = Date.now();
        for (;;) {
          estIn = estTokens(o.system, messages);
          if (!h.beforeCall(estIn, o.maxTokens)) return end("refused");
          try {
            msg = await raceAbort(
              client.messages.create(
                { model, max_tokens: o.maxTokens, system: o.system, tools: [RUN_COMMAND, SUBMIT], messages },
                { signal: h.signal, timeout: CALL_TIMEOUT_MS, maxRetries: 0 },
              ),
              h.signal,
            );
            break;
          } catch (e) {
            const f = classify(e, h.signal);
            if (f.kind === "abort") return end("aborted");
            if (f.kind === "fatal" || switched) return end("error", { error: f.why });
            if (f.kind === "transient" && retriesLeft > 0) { retriesLeft--; continue; }
            if (!o.fallbackModel || o.fallbackModel === model) return end("error", { error: f.why });
            switched = true;
            model = o.fallbackModel;
            retriesLeft = 0;
          }
        }
        if (h.signal.aborted) return end("aborted");   // tokens of an aborted call are never reported

        const usage = readUsage(msg, estIn);
        h.onTurn({
          turn, tokensIn: usage.tokensIn, tokensOut: usage.tokensOut, stopReason: String(msg.stop_reason ?? "unknown"),
          ms: Date.now() - t0, estimated: usage.estimated, model, estIn,
        });
        const blocks = Array.isArray(msg.content) ? msg.content : [];
        // Verbatim, thinking blocks included, never trimmed. (An empty reply would be a 400 on the next call.)
        const echoed = blocks.length > 0 ? blocks : [{ type: "text", text: "(no output)" }];
        messages.push({ role: "assistant", content: echoed as unknown as ContentBlockParam[] });
        if (msg.stop_reason && FINAL_REASONS.has(msg.stop_reason)) return end("error", { error: msg.stop_reason });

        // Every tool_use id gets one tool_result, in order, all in ONE user message.
        const uses = blocks.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
        const results: ToolResultBlockParam[] = [];
        for (const use of uses) {
          if (h.signal.aborted) return end("aborted");
          if (use.name === RUN_COMMAND.name) {
            const command = (use.input as { command?: unknown } | null)?.command;
            if (typeof command !== "string" || command.trim() === "") {
              results.push(toolError(use.id, "run_command needs a non-empty string argument: command."));
              continue;
            }
            let r: ExecResult;
            try {
              r = await raceAbort(o.vmApi.exec(o.vm, AGENT_WRAPPER, { stdin: command, timeoutSec: EXEC_TIMEOUT_SEC }), h.signal);
            } catch (e) {
              if (e === ABORTED || h.signal.aborted) return end("aborted");
              return end("error", { error: `exec failed: ${describe(e)}` });
            }
            if (h.signal.aborted) return end("aborted");   // a pending exec result after an abort is ignored
            const x = renderExec(r);
            results.push({ type: "tool_result", tool_use_id: use.id, content: x.text });
            h.onTool({ command: command.slice(0, 200), exit: x.exit, tail: x.tail.slice(-600), ms: x.ms });
          } else if (use.name === SUBMIT.name) {
            const raw = (use.input as { summary?: unknown } | null)?.summary;
            const summary = typeof raw === "string" ? raw.trim().slice(0, SUMMARY_CHARS) : "";
            let verdict: { accept: boolean; feedback?: string };
            try {
              verdict = await raceAbort(o.onSubmit(summary), h.signal);   // the host check (DESIGN 12.3)
            } catch (e) {
              if (e === ABORTED || h.signal.aborted) return end("aborted");
              return end("error", { error: `host check failed: ${describe(e)}` });
            }
            if (h.signal.aborted) return end("aborted");
            if (verdict.accept) return end("submitted", { summary });   // an accepted submit returns at once
            results.push({
              type: "tool_result", tool_use_id: use.id,
              content: `Acceptance check failed:\n${(verdict.feedback ?? "").slice(0, LOG_CHARS)}\nFix it and resubmit.`,
            });
          } else {
            results.push(toolError(use.id, `Unknown tool ${JSON.stringify(String(use.name))}. Use run_command or submit.`));
          }
        }

        // Deadlines are plain text, never a forced tool choice. Text blocks follow the tool results in the same message.
        const next: ContentBlockParam[] = [...results];
        if (uses.length === 0) next.push({ type: "text", text: CHECK_NUDGE });   // end_turn without a tool call
        if (!deadlineSent && o.softDeadlineSec !== undefined && Date.now() - started >= o.softDeadlineSec * 1000) {
          next.push({ type: "text", text: DEADLINE_NUDGE });
          deadlineSent = true;
        }
        messages.push({ role: "user", content: next });
      }
      return end("turn_cap");
    } catch (e) {
      // The loop never rejects: an abort is an outcome, and so is anything unexpected (a hook that threw, a bad reply).
      if (e === ABORTED || h.signal.aborted) return end("aborted");
      return end("error", { error: describe(e) });
    }
  };
}

// ── The real client, created on the first call ───────────────────────────────
let real: RunAgent | undefined;
export const runAgent: RunAgent = async (o, h) => {
  if (!real) {
    if (!cfg.routerKey) return { outcome: "error", error: "ROUTER_API_KEY is not set", model: o.model };
    try {
      // All three credentials are explicit. Otherwise the SDK reads ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN and
      // ANTHROPIC_BASE_URL from the environment, and a developer shell often has those set for other tools.
      const client: MessagesLike = new Anthropic({
        apiKey: cfg.routerKey, baseURL: cfg.routerBase, authToken: null, maxRetries: 0, timeout: CALL_TIMEOUT_MS,
      });
      real = createRunAgent(client);
    } catch (e) {
      return { outcome: "error", error: `router client: ${describe(e)}`, model: o.model };
    }
  }
  return real(o, h);
};

// GET /v1/models answers 200 without a key (SMOKE-TESTS), so "ok" means the router is reachable, NOT that the key is
// valid. The key is proven by every live run. Never echoes the key.
export async function pingRouter(): Promise<string> {
  try {
    const res = await fetch(`${cfg.routerBase.replace(/\/+$/, "")}/v1/models`, {
      headers: cfg.routerKey ? { "x-api-key": cfg.routerKey } : {},
      signal: AbortSignal.timeout(5000),
    });
    await res.body?.cancel().catch(() => {});   // the model list is not needed
    return res.status === 200 ? "ok" : `HTTP ${res.status}`;
  } catch (e) {
    const err = e as { name?: string; cause?: { code?: unknown } };
    const code = typeof err?.cause?.code === "string" ? ` ${err.cause.code}` : "";
    return `${err?.name || "Error"}${code}`;
  }
}
