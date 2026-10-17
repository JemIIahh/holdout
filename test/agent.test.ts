// test/agent.test.ts: mock tests (a scripted client and a fake Vm, zero network, zero spend) and, only with LIVE=1,
// the two live honest runs on dev VM #1. Run: node --import tsx --test test/agent.test.ts
import { test, describe, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import { spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import {
  AGENT_WRAPPER, RUN_COMMAND, SUBMIT, createRunAgent, estTokens, pingRouter, runAgent, type CallOptions, type MessagesLike,
} from "../src/agent.js";
import { cfg } from "../src/config.js";
import { honestOptions } from "../src/contractors/honest.js";
import { runawayOptions } from "../src/contractors/runaway.js";
import { startBusyloop } from "../src/contractors/busyloop.js";
import type {
  AgentHooks, AgentOptions, CheckResult, ExecResult, JobSpec, ToolCall, TurnUsage, Vm, VmHandle,
} from "../src/contracts.js";

type Json = any;   // wire-shaped test data: replies, requests and tool results
type Step = unknown;   // a reply object, an Error to throw, or a function (body, options) => reply | Promise<reply>

// ── Mock client: scripted replies; every request is snapshotted at call time (the loop mutates its array) ──
function mockClient(steps: Step[]) {
  const requests: Json[] = [];
  const optsSeen: CallOptions[] = [];
  const client: MessagesLike = {
    messages: {
      async create(body, options) {
        requests.push(JSON.parse(JSON.stringify(body)));
        optsSeen.push(options ?? {});
        if (steps.length === 0) throw new Error("mock client: script exhausted");
        const step = steps.shift();
        const v = typeof step === "function" ? await (step as (b: unknown, o: CallOptions) => unknown)(body, options ?? {}) : step;
        if (v instanceof Error) throw v;
        return v as Anthropic.Message;
      },
    },
  };
  return { client, requests, optsSeen };
}

const USAGE = (i = 100, o = 20): Json =>
  ({ input_tokens: i, output_tokens: o, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
function reply(content: Json[], stop: string, usage: Json | null = USAGE()): Json {
  const m: Json = { id: "msg_t", type: "message", role: "assistant", model: "mock", content, stop_reason: stop, stop_sequence: null };
  if (usage) m.usage = usage;
  return m;
}
const say = (t: string): Json => ({ type: "text", text: t });
const toolUse = (id: string, name: string, input: unknown): Json => ({ type: "tool_use", id, name, input, caller: { type: "direct" } });
const cmd = (id: string, command: string): Json => toolUse(id, "run_command", { command });
const sub = (id: string, summary = "Done."): Json => toolUse(id, "submit", { summary });
const httpError = (status: number, message = "upstream error"): Error => Object.assign(new Error(message), { status });
const timeoutError = (): Error => new Anthropic.APIConnectionTimeoutError();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Fake Vm: exec and spawn only ─────────────────────────────────────────────
type ExecHandler = (bash: string, o?: { timeoutSec?: number; stdin?: string }) => Partial<ExecResult> | Promise<Partial<ExecResult>>;
function fakeVm(handler?: ExecHandler) {
  const calls: { bash: string; o?: { timeoutSec?: number; stdin?: string } }[] = [];
  const spawns: { bash: string; cwd?: string }[] = [];
  const vmApi = {
    async exec(_vm: VmHandle, bash: string, o?: { timeoutSec?: number; stdin?: string }): Promise<ExecResult> {
      calls.push({ bash, o });
      const r = handler ? await handler(bash, o) : {};
      return { exit: 0, stdout: "", stderr: "", ms: 12, timedOut: false, ...r };
    },
    async spawn(_vm: VmHandle, bash: string, cwd?: string): Promise<string> {
      spawns.push({ bash, cwd });
      return "proc-1";
    },
  } as unknown as Vm;
  return { vmApi, calls, spawns };
}

// ── Hooks: record everything; `allow(n)` plays the fuse's reservation on the nth beforeCall (1-based) ──
function hooks(allow: (call: number) => boolean = () => true, over: Partial<AgentHooks> = {}) {
  const turns: TurnUsage[] = [];
  const tools: ToolCall[] = [];
  const reserved: [number, number][] = [];
  const ac = new AbortController();
  const h: AgentHooks = {
    onTurn: (u) => { turns.push(u); },
    onTool: (t) => { tools.push(t); },
    beforeCall: (est, max) => { reserved.push([est, max]); return allow(reserved.length); },
    signal: ac.signal,
    ...over,
  };
  return { h, turns, tools, reserved, ac };
}

const VM: VmHandle = { id: "sb-test", name: "hd-test", createdAt: 0 };
function options(vmApi: Vm, onSubmit: AgentOptions["onSubmit"] = async () => ({ accept: true }), over: Partial<AgentOptions> = {}): AgentOptions {
  return {
    model: "claude-opus-5.5", fallbackModel: "claude-opus-5", system: "SYSTEM PROMPT", firstMessage: "FIRST MESSAGE",
    vm: VM, vmApi, maxTurns: 8, maxTokens: 4096, onSubmit, ...over,
  };
}
const lastUser = (req: Json): Json => req.messages.at(-1);

describe("agent loop (mock client, fake Vm)", () => {
  test("1. honest path: run_command, then submit, accepted", async () => {
    const command = "cat > /work/solution.py <<'EOF'\nprint('hi')\nEOF\nbash /work/check.sh";
    const first = reply([say("Writing the file."), cmd("tu_1", command)], "tool_use");
    const { client, requests } = mockClient([first, reply([sub("tu_2", "Wrote solution.py; check.sh passes 3/3.")], "tool_use", USAGE(150, 30))]);
    const { vmApi, calls } = fakeVm(() => ({ stdout: "PASS example 1\nPASS example 2\nPASS example 3\n3/3 examples passed\n", ms: 640 }));
    const { h, turns, tools, reserved } = hooks();
    const seen: string[] = [];
    const out = await createRunAgent(client)(options(vmApi, async (s) => { seen.push(s); return { accept: true }; }), h);

    assert.equal(out.outcome, "submitted");
    assert.equal(out.summary, "Wrote solution.py; check.sh passes 3/3.");
    assert.equal(out.model, "claude-opus-5.5");
    assert.deepEqual(seen, ["Wrote solution.py; check.sh passes 3/3."]);
    // onTurn once per turn, with the router's usage and the reservation estimate beforeCall received
    assert.equal(turns.length, 2);
    assert.deepEqual({ ...turns[0], ms: 0 }, {
      turn: 1, tokensIn: 100, tokensOut: 20, stopReason: "tool_use", ms: 0, estimated: false, model: "claude-opus-5.5", estIn: reserved[0][0],
    });
    assert.equal(turns[1].tokensIn, 150);
    assert.equal(turns[1].tokensOut, 30);
    assert.equal(turns[1].estIn, reserved[1][0]);
    assert.ok(turns[0].ms >= 0);
    assert.deepEqual(reserved.map((r) => r[1]), [4096, 4096]);
    // onTool once, with the model's command clipped and the exec numbers
    assert.equal(tools.length, 1);
    assert.equal(tools[0].command, command.slice(0, 200));
    assert.equal(tools[0].exit, 0);
    assert.equal(tools[0].ms, 640);
    assert.ok(tools[0].tail.includes("3/3 examples passed"));
    // exec got the wrapper as the script and the command only as stdin
    assert.equal(calls.length, 1);
    assert.equal(calls[0].bash, AGENT_WRAPPER);
    assert.equal(calls[0].o?.stdin, command);
    assert.equal(calls[0].o?.timeoutSec, 35);
    assert.ok(!calls[0].bash.includes("solution.py"), "the model's command must never be part of the script");
    // the second request: first user message, the assistant turn verbatim, one user message with the tool_result
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].messages.map((m: Json) => m.role), ["user", "assistant", "user"]);
    assert.deepEqual(requests[1].messages[1].content, first.content);
    const tr = lastUser(requests[1]).content[0];
    assert.equal(tr.type, "tool_result");
    assert.equal(tr.tool_use_id, "tu_1");
    assert.ok(tr.content.startsWith("exit=0 ms=640\n"), tr.content);
    assert.ok(tr.content.includes("PASS example 3"));
  });

  test("2. a rejected submit pastes the host log, then an accepted one finishes", async () => {
    const log = 'host check: 2/3 cases passed\nFAIL v2 · wrong output · line 1: expected "cafe,60" got "cafe,60.000000001"';
    let n = 0;
    const onSubmit = async () => (++n === 1 ? { accept: false, feedback: log } : { accept: true });
    const { client, requests } = mockClient([reply([sub("tu_1", "First try.")], "tool_use"), reply([sub("tu_2", "Fixed.")], "tool_use")]);
    const { vmApi, calls } = fakeVm();
    const { h, turns } = hooks();
    const out = await createRunAgent(client)(options(vmApi, onSubmit), h);

    assert.equal(out.outcome, "submitted");
    assert.equal(out.summary, "Fixed.");
    assert.equal(n, 2);
    assert.equal(turns.length, 2);
    assert.equal(calls.length, 0);
    const tr = lastUser(requests[1]).content[0];
    assert.equal(tr.type, "tool_result");
    assert.equal(tr.tool_use_id, "tu_1");
    assert.ok(tr.content.startsWith("Acceptance check failed:"), tr.content);
    assert.ok(tr.content.includes(log));
    assert.ok(tr.content.endsWith("Fix it and resubmit."));
  });

  test("3. a runaway is refused by the fuse's reservation; the estimate grows turn by turn", async () => {
    let rejected = 0;
    const onSubmit = async () => { rejected++; return { accept: false, feedback: `FAIL v1 · 31.2 ms > 0.5 ms limit (output correct)\n`.repeat(rejected * 3) }; };
    const { client, requests } = mockClient([
      reply([sub("a")], "tool_use"), reply([sub("b")], "tool_use"), reply([sub("c")], "tool_use"), reply([sub("d")], "tool_use"),
    ]);
    const { vmApi } = fakeVm();
    const { h, turns, reserved } = hooks((call) => call < 4);   // the fuse refuses the 4th call
    const out = await createRunAgent(client)(options(vmApi, onSubmit), h);

    assert.equal(out.outcome, "refused");
    assert.equal(out.model, "claude-opus-5.5");
    assert.equal(requests.length, 3, "the refused call must never reach the router");
    assert.equal(turns.length, 3);
    assert.equal(reserved.length, 4);
    for (let i = 1; i < reserved.length; i++) assert.ok(reserved[i][0] > reserved[i - 1][0], `estimate grows: ${reserved.map((r) => r[0])}`);
    assert.ok(reserved.every((r) => r[1] === 4096));
    assert.equal(rejected, 3);
  });

  describe("4. abort", () => {
    test("during a model call: aborted, no exec, no tokens reported", async () => {
      const { client } = mockClient([
        (_b: unknown, o: CallOptions) => new Promise((_res, rej) => { o.signal?.addEventListener("abort", () => rej(new Anthropic.APIUserAbortError())); }),
      ]);
      const { vmApi, calls } = fakeVm();
      const { h, turns, ac } = hooks();
      const run = createRunAgent(client)(options(vmApi), h);
      setTimeout(() => ac.abort(), 20);
      const out = await run;
      assert.equal(out.outcome, "aborted");
      assert.equal(calls.length, 0);
      assert.equal(turns.length, 0);
    });

    test("a reply that arrives after the abort is ignored: no onTurn, no exec", async () => {
      const { client } = mockClient([async () => { await sleep(40); return reply([cmd("tu_1", "echo late")], "tool_use"); }]);
      const { vmApi, calls } = fakeVm();
      const { h, turns, tools, ac } = hooks();
      const run = createRunAgent(client)(options(vmApi), h);
      setTimeout(() => ac.abort(), 10);
      const out = await run;
      await sleep(60);
      assert.equal(out.outcome, "aborted");
      assert.equal(calls.length, 0);
      assert.equal(turns.length, 0);
      assert.equal(tools.length, 0);
    });

    test("during an exec: returns at once and the late exec result is ignored", async () => {
      const { client } = mockClient([reply([cmd("tu_1", "sleep 30")], "tool_use"), reply([sub("tu_2")], "tool_use")]);
      const { vmApi, calls } = fakeVm(async () => { await sleep(80); return { stdout: "late" }; });
      const { h, turns, tools, ac } = hooks();
      const t0 = Date.now();
      const run = createRunAgent(client)(options(vmApi), h);
      setTimeout(() => ac.abort(), 20);
      const out = await run;
      assert.equal(out.outcome, "aborted");
      assert.ok(Date.now() - t0 < 70, "the loop must not wait for the pending exec");
      await sleep(120);
      assert.equal(calls.length, 1);
      assert.equal(tools.length, 0);
      assert.equal(turns.length, 1, "only the finished turn is reported");
    });

    test("during the host check, and before the first call", async () => {
      const { client } = mockClient([reply([sub("tu_1")], "tool_use")]);
      const { vmApi } = fakeVm();
      const a = hooks();
      const run = createRunAgent(client)(options(vmApi, () => new Promise(() => {})), a.h);
      setTimeout(() => a.ac.abort(), 20);
      assert.equal((await run).outcome, "aborted");

      const m = mockClient([reply([sub("x")], "tool_use")]);
      const b = hooks();
      b.ac.abort();
      const out = await createRunAgent(m.client)(options(vmApi), b.h);
      assert.equal(out.outcome, "aborted");
      assert.equal(m.requests.length, 0);
      assert.equal(b.reserved.length, 0);
    });
  });
});

describe("agent loop: retries, fallback and stop reasons", () => {
  const PRIMARY = "claude-opus-5.5";
  const FALLBACK = "claude-opus-5";
  const models = (requests: Json[]) => requests.map((r) => r.model);

  test("5a. a 403 or 404 on turn 1 switches to the fallback model at once", async () => {
    for (const status of [403, 404]) {
      const { client, requests } = mockClient([httpError(status), reply([sub("tu_1")], "tool_use")]);
      const { h, turns, reserved } = hooks();
      const out = await createRunAgent(client)(options(fakeVm().vmApi), h);
      assert.equal(out.outcome, "submitted");
      assert.deepEqual(models(requests), [PRIMARY, FALLBACK]);
      assert.equal(out.model, FALLBACK);
      assert.equal(turns[0].model, FALLBACK);
      assert.equal(reserved.length, 2, "beforeCall runs before every attempt");
    }
  });

  test("5b. a timeout twice goes to the fallback model, and the lane stays on it", async () => {
    const { client, requests } = mockClient([timeoutError(), timeoutError(), reply([cmd("c1", "echo hi")], "tool_use"), reply([sub("s1")], "tool_use")]);
    const { h, turns, reserved } = hooks();
    const out = await createRunAgent(client)(options(fakeVm().vmApi), h);
    assert.equal(out.outcome, "submitted");
    assert.deepEqual(models(requests), [PRIMARY, PRIMARY, FALLBACK, FALLBACK]);
    assert.equal(out.model, FALLBACK);
    assert.deepEqual(turns.map((t) => t.model), [FALLBACK, FALLBACK]);
    assert.equal(reserved.length, 4);
  });

  test("5c. one timeout or 429 is retried on the same model", async () => {
    for (const first of [timeoutError(), httpError(429, "rate limited"), httpError(503)]) {
      const { client, requests } = mockClient([first, reply([sub("tu_1")], "tool_use")]);
      const { h, turns } = hooks();
      const out = await createRunAgent(client)(options(fakeVm().vmApi), h);
      assert.equal(out.outcome, "submitted");
      assert.deepEqual(models(requests), [PRIMARY, PRIMARY]);
      assert.equal(out.model, PRIMARY);
      assert.equal(turns[0].model, PRIMARY);
    }
  });

  test("5d. a failure after the switch is the outcome, and no key or header reaches its text", async () => {
    const { client, requests } = mockClient([httpError(403), httpError(500, "boom x-api-key: sk-live-ABCDEFGHIJKL Authorization: Bearer abc.def"), reply([sub("never")], "tool_use")]);
    const { h, turns } = hooks();
    const out = await createRunAgent(client)(options(fakeVm().vmApi), h);
    assert.equal(out.outcome, "error");
    assert.equal(out.model, FALLBACK);
    assert.ok(out.error?.startsWith("HTTP 500"), out.error);
    assert.ok(!/sk-live|abc\.def/.test(out.error ?? ""), out.error);
    assert.equal(requests.length, 2, "no retry after the switch");
    assert.equal(turns.length, 0);
  });

  test("5e. other client errors stop at once, with no retry and no switch", async () => {
    const { client, requests } = mockClient([httpError(400, "bad request"), reply([sub("never")], "tool_use")]);
    const out = await createRunAgent(client)(options(fakeVm().vmApi), hooks().h);
    assert.equal(out.outcome, "error");
    assert.ok(out.error?.startsWith("HTTP 400"), out.error);
    assert.equal(out.model, PRIMARY);
    assert.equal(requests.length, 1);
  });

  test("5f. a refused retry is a refusal, not another call", async () => {
    const { client, requests } = mockClient([timeoutError(), reply([sub("never")], "tool_use")]);
    const { h } = hooks((call) => call < 2);   // the fuse refuses the retry
    const out = await createRunAgent(client)(options(fakeVm().vmApi), h);
    assert.equal(out.outcome, "refused");
    assert.equal(requests.length, 1);
  });

  test("6. max_tokens and refusal are errors; the spent tokens are still reported", async () => {
    for (const stop of ["max_tokens", "refusal", "model_context_window_exceeded"]) {
      const { client } = mockClient([reply([say("cut off")], stop, USAGE(500, 4096))]);
      const { h, turns } = hooks();
      const out = await createRunAgent(client)(options(fakeVm().vmApi), h);
      assert.equal(out.outcome, "error");
      assert.equal(out.error, stop);
      assert.equal(turns.length, 1);
      assert.equal(turns[0].tokensOut, 4096);
      assert.equal(turns[0].stopReason, stop);
    }
  });

  test("7. end_turn without a tool call: the next user message is the check.sh nudge, and roles alternate", async () => {
    const { client, requests } = mockClient([reply([say("I believe it is done.")], "end_turn"), reply([say("Still done.")], "end_turn"), reply([sub("tu_1")], "tool_use")]);
    const out = await createRunAgent(client)(options(fakeVm().vmApi), hooks().h);
    assert.equal(out.outcome, "submitted");
    assert.deepEqual(lastUser(requests[1]), { role: "user", content: [{ type: "text", text: "Run bash /work/check.sh, then call submit." }] });
    assert.equal(requests.length, 3);
    for (const req of requests) {
      req.messages.forEach((m: Json, i: number) => assert.equal(m.role, i % 2 === 0 ? "user" : "assistant", "never two user messages in a row"));
    }
  });

  test("8. usage missing: estimated, input from the reservation estimate, output from the reply size", async () => {
    const content = [say("Running it."), cmd("tu_1", "echo hi")];
    const { client } = mockClient([reply(content, "tool_use", null), reply([sub("tu_2")], "tool_use")]);
    const { h, turns, reserved } = hooks();
    const out = await createRunAgent(client)(options(fakeVm().vmApi), h);
    assert.equal(out.outcome, "submitted");
    assert.equal(turns[0].estimated, true);
    assert.equal(turns[0].tokensIn, reserved[0][0]);
    assert.equal(turns[0].estIn, reserved[0][0]);
    assert.equal(turns[0].tokensOut, Math.ceil(JSON.stringify(content).length / 4));
    assert.equal(turns[1].estimated, false, "a later reply with usage is real again");
  });

  test("8b. cache fields are added to the input tokens (they are expected to be 0)", async () => {
    const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 7, cache_read_input_tokens: 1000 };
    const { client } = mockClient([reply([sub("tu_1")], "tool_use", usage)]);
    const { h, turns } = hooks();
    await createRunAgent(client)(options(fakeVm().vmApi), h);
    assert.equal(turns[0].tokensIn, 1017);
    assert.equal(turns[0].tokensOut, 5);
    assert.equal(turns[0].estimated, false);
  });

  test("9. no request carries temperature, top_p, top_k, thinking, output_config, effort, tool_choice or betas", async () => {
    const { client, requests, optsSeen } = mockClient([
      httpError(403), reply([say("x"), cmd("c1", "echo hi")], "tool_use"), reply([say("done")], "end_turn"), reply([sub("s1")], "tool_use"),
    ]);
    const { h } = hooks();
    const out = await createRunAgent(client)(options(fakeVm().vmApi), h);
    assert.equal(out.outcome, "submitted");
    assert.equal(requests.length, 4);
    for (const req of requests) {
      assert.deepEqual(Object.keys(req).sort(), ["max_tokens", "messages", "model", "system", "tools"]);
      for (const k of ["temperature", "top_p", "top_k", "thinking", "output_config", "effort", "tool_choice", "betas", "beta", "stream"]) {
        assert.ok(!(k in req), `request must not carry ${k}`);
      }
      assert.equal(req.max_tokens, 4096);
      assert.equal(req.system, "SYSTEM PROMPT");
      assert.deepEqual(req.tools, JSON.parse(JSON.stringify([RUN_COMMAND, SUBMIT])));
      assert.deepEqual(req.tools.map((t: Json) => t.name), ["run_command", "submit"]);
    }
    for (const o of optsSeen) {
      assert.equal(o.timeout, 30_000);
      assert.equal(o.maxRetries, 0);
      assert.equal(o.signal, h.signal);
    }
  });

  test("9b. the SDK client satisfies MessagesLike (type check) and is built with explicit credentials", () => {
    const sdk: MessagesLike = new Anthropic({ apiKey: "test-key-not-real", baseURL: "http://127.0.0.1:9", authToken: null, maxRetries: 0 });
    assert.equal(typeof sdk.messages.create, "function");
  });
});

describe("agent loop: several tool_use blocks in one reply", () => {
  test("10a. one tool_result per id, in order, in ONE user message; unknown tools and bad input are is_error", async () => {
    const { client, requests } = mockClient([
      reply([say("Four calls."), cmd("a", "echo one"), cmd("b", "echo two"), toolUse("c", "bogus_tool", {}), toolUse("d", "run_command", {})], "tool_use"),
      reply([sub("e")], "tool_use"),
    ]);
    const { vmApi, calls } = fakeVm((_bash, o) => ({ stdout: `${o?.stdin}\n` }));
    const { tools, h } = hooks();
    const out = await createRunAgent(client)(options(vmApi), h);
    assert.equal(out.outcome, "submitted");
    const msgs = requests[1].messages;
    assert.deepEqual(msgs.map((m: Json) => m.role), ["user", "assistant", "user"]);
    const results = msgs[2].content;
    assert.deepEqual(results.map((r: Json) => r.tool_use_id), ["a", "b", "c", "d"]);
    assert.ok(results.every((r: Json) => r.type === "tool_result"));
    assert.ok(results[0].content.includes("echo one") && results[1].content.includes("echo two"));
    assert.equal(results[2].is_error, true);
    assert.ok(results[2].content.includes("Unknown tool"));
    assert.equal(results[3].is_error, true);
    assert.deepEqual(calls.map((c) => c.o?.stdin), ["echo one", "echo two"]);
    assert.equal(tools.length, 2);
  });

  test("10b. an accepted submit returns at once; later blocks are not run", async () => {
    const { client, requests } = mockClient([reply([cmd("a", "echo one"), sub("b", "All set."), cmd("c", "echo never")], "tool_use")]);
    const { vmApi, calls } = fakeVm();
    const out = await createRunAgent(client)(options(vmApi), hooks().h);
    assert.equal(out.outcome, "submitted");
    assert.equal(out.summary, "All set.");
    assert.deepEqual(calls.map((c) => c.o?.stdin), ["echo one"]);
    assert.equal(requests.length, 1);
  });

  test("10c. a rejected submit in the middle: the blocks after it still get their results, in the same message", async () => {
    const { client, requests } = mockClient([reply([sub("a"), cmd("b", "echo after")], "tool_use"), reply([sub("c")], "tool_use")]);
    const { vmApi } = fakeVm();
    let n = 0;
    const out = await createRunAgent(client)(options(vmApi, async () => (++n === 1 ? { accept: false, feedback: "FAIL v1" } : { accept: true })), hooks().h);
    assert.equal(out.outcome, "submitted");
    const results = lastUser(requests[1]).content;
    assert.deepEqual(results.map((r: Json) => r.tool_use_id), ["a", "b"]);
    assert.ok(results[0].content.startsWith("Acceptance check failed:\nFAIL v1"));
    assert.ok(results[1].content.startsWith("exit=0"));
  });
});

describe("agent loop: tool output, deadlines, caps and failures", () => {
  test("tool result keeps the last 4,000 characters of stdout then stderr; onTool keeps 600", async () => {
    const stdout = "A".repeat(3000) + "B".repeat(3000);
    const stderr = "Traceback: boom\n";
    const { client, requests } = mockClient([reply([cmd("a", "python3 /work/solution.py")], "tool_use"), reply([sub("b")], "tool_use")]);
    const { vmApi } = fakeVm(() => ({ exit: 1, stdout, stderr, ms: 987.4 }));
    const { h, tools } = hooks();
    await createRunAgent(client)(options(vmApi), h);
    const combined = `${stdout}\n${stderr}`;
    assert.equal(lastUser(requests[1]).content[0].content, `exit=1 ms=987\n${combined.slice(-4000)}`);
    assert.equal(tools[0].exit, 1);
    assert.equal(tools[0].tail, combined.slice(-600));
  });

  test("a command that ran out of time reads exit=124 and 'command timed out' (client timeout and guest timeout)", async () => {
    for (const r of [{ exit: 124, stderr: "command timed out", timedOut: true }, { exit: 124, stderr: "", timedOut: false }, { exit: 0, stderr: "", timedOut: true }]) {
      const { client, requests } = mockClient([reply([cmd("a", "sleep 99")], "tool_use"), reply([sub("b")], "tool_use")]);
      const { h, tools } = hooks();
      await createRunAgent(client)(options(fakeVm(() => r).vmApi), h);
      const text: string = lastUser(requests[1]).content[0].content;
      assert.ok(text.startsWith("exit=124 ms=12\n"), text);
      assert.equal(text.split("command timed out").length - 1, 1, text);
      assert.equal(tools[0].exit, 124);
    }
  });

  test("the soft deadline is plain text, added once, after the tool results; the check.sh nudge merges with it", async () => {
    const { client, requests } = mockClient([
      reply([cmd("a", "echo 1")], "tool_use"), reply([say("Looks fine.")], "end_turn"), reply([cmd("b", "echo 2")], "tool_use"), reply([sub("c")], "tool_use"),
    ]);
    const out = await createRunAgent(client)(options(fakeVm().vmApi, undefined, { softDeadlineSec: 0 }), hooks().h);
    assert.equal(out.outcome, "submitted");
    const deadline = { type: "text", text: "Time is almost up: run check.sh once and submit." };
    assert.deepEqual(lastUser(requests[1]).content.map((b: Json) => b.type), ["tool_result", "text"]);
    assert.deepEqual(lastUser(requests[1]).content[1], deadline);
    // later user messages carry no second deadline, and the end_turn nudge is its own text block
    const last = requests.at(-1);
    const deadlines = JSON.stringify(last.messages).split(deadline.text).length - 1;
    assert.equal(deadlines, 1);
    assert.deepEqual(last.messages[4].content, [{ type: "text", text: "Run bash /work/check.sh, then call submit." }]);
    assert.deepEqual(last.messages.map((m: Json) => m.role), ["user", "assistant", "user", "assistant", "user", "assistant", "user"]);
    for (const req of requests) assert.ok(!("tool_choice" in req));
  });

  test("when the deadline and an end_turn coincide, both texts share one user message", async () => {
    const { client, requests } = mockClient([reply([say("All done.")], "end_turn"), reply([sub("a")], "tool_use")]);
    await createRunAgent(client)(options(fakeVm().vmApi, undefined, { softDeadlineSec: 0 }), hooks().h);
    assert.deepEqual(lastUser(requests[1]), { role: "user", content: [
      { type: "text", text: "Run bash /work/check.sh, then call submit." },
      { type: "text", text: "Time is almost up: run check.sh once and submit." },
    ] });
  });

  test("without softDeadlineSec no deadline text is ever sent", async () => {
    const { client, requests } = mockClient([reply([cmd("a", "echo 1")], "tool_use"), reply([sub("b")], "tool_use")]);
    await createRunAgent(client)(options(fakeVm().vmApi), hooks().h);
    assert.ok(!JSON.stringify(requests).includes("Time is almost up"));
  });

  test("maxTurns ends the loop with turn_cap", async () => {
    const { client, requests } = mockClient([reply([cmd("a", "echo 1")], "tool_use"), reply([cmd("b", "echo 2")], "tool_use"), reply([sub("never")], "tool_use")]);
    const { h, turns } = hooks();
    const out = await createRunAgent(client)(options(fakeVm().vmApi, undefined, { maxTurns: 2 }), h);
    assert.equal(out.outcome, "turn_cap");
    assert.equal(out.model, "claude-opus-5.5");
    assert.equal(turns.length, 2);
    assert.equal(requests.length, 2);
  });

  test("an exec that throws, a host check that throws, or a hook that throws is an error outcome, never a rejection", async () => {
    const a = await createRunAgent(mockClient([reply([cmd("a", "echo 1")], "tool_use")]).client)(
      options(fakeVm(() => { throw new Error("socket hang up"); }).vmApi), hooks().h);
    assert.equal(a.outcome, "error");
    assert.ok(a.error?.startsWith("exec failed:"), a.error);

    const b = await createRunAgent(mockClient([reply([sub("a")], "tool_use")]).client)(
      options(fakeVm().vmApi, async () => { throw new Error("host check exec failed"); }), hooks().h);
    assert.equal(b.outcome, "error");
    assert.ok(b.error?.startsWith("host check failed:"), b.error);

    const c = await createRunAgent(mockClient([reply([sub("a")], "tool_use")]).client)(
      options(fakeVm().vmApi), hooks(undefined, { onTurn: () => { throw new Error("hook bug"); } }).h);
    assert.equal(c.outcome, "error");
    assert.ok(c.error?.includes("hook bug"), c.error);
  });

  test("an empty reply is echoed with a placeholder so the next call is not a 400", async () => {
    const { client, requests } = mockClient([reply([], "end_turn"), reply([sub("a")], "tool_use")]);
    const out = await createRunAgent(client)(options(fakeVm().vmApi), hooks().h);
    assert.equal(out.outcome, "submitted");
    assert.ok(requests[1].messages[1].content.length > 0);
  });

  test("estTokens is the JSON characters divided by 4, rounded up, and grows with the transcript", () => {
    const sys = "abcd";
    const msgs: unknown[] = [];
    assert.equal(estTokens(sys, msgs), Math.ceil((JSON.stringify(sys).length + JSON.stringify(msgs).length) / 4));
    const before = estTokens(sys, msgs);
    msgs.push({ role: "user", content: "x".repeat(400) });
    assert.ok(estTokens(sys, msgs) >= before + 100);
  });
});

describe("contractors", () => {
  const SPEC = "# Net payouts per merchant\nRead a CSV from stdin with the header `id,merchant,type,amount`.\n```\na fence inside the spec must not close ours\n```\nRules:\n1. net_cents = charges minus refunds.\n";
  const PERF = "Performance: the program must finish in under 0.5 ms, measured from process start to exit.\n";
  const job = (id: "csv-reconcile" | "csv-reconcile-fast"): JobSpec => ({
    id, title: "t", specMd: id === "csv-reconcile-fast" ? SPEC + PERF : SPEC,
    visible: [1, 2, 3].map((n) => ({ name: `v${n}`, input: `id,merchant,type,amount\nt${n},acme,charge,${n}.00\n`, expected: `acme,${n}00\n` })),
    freshCases: id === "csv-reconcile-fast" ? 3 : 0, gen: () => "", ref: () => "",
  });
  const params = (j: JobSpec) => ({ job: j, vm: VM, vmApi: fakeVm().vmApi, onSubmit: async () => ({ accept: true }) });

  test("honestOptions: the prompt file, the whole spec and examples inline, the limits and the models", () => {
    const j = job("csv-reconcile");
    const o = honestOptions(params(j));
    assert.equal(o.system, readFileSync(path.resolve(process.cwd(), "prompts/honest.md"), "utf8").trim());
    assert.ok(o.system.startsWith("You are a contractor agent. You act only through two tools."));
    assert.ok(o.system.includes("never start background processes with &"));
    assert.ok(o.system.endsWith("Do not explore the filesystem or install packages."));
    assert.deepEqual([o.maxTurns, o.maxTokens, o.softDeadlineSec], [8, 4096, 75]);
    assert.equal(o.model, cfg.model);
    assert.equal(o.fallbackModel, cfg.fallbackModel);
    assert.equal(o.vm, VM);
    assert.ok(o.firstMessage.includes("SPEC.md, the examples and check.sh are already in /work."));
    assert.ok(o.firstMessage.includes(j.specMd), "the whole spec, verbatim");
    assert.ok(o.firstMessage.includes("````\n# Net payouts per merchant"), "a longer fence than any backtick run in the spec");
    j.visible.forEach((ex, i) => {
      assert.ok(o.firstMessage.includes(`/work/examples/${i + 1}.in\n\`\`\`\n${ex.input}\`\`\``), `example ${i + 1} input in a block naming its file`);
      assert.ok(o.firstMessage.includes(`/work/examples/${i + 1}.out\n\`\`\`\n${ex.expected}\`\`\``), `example ${i + 1} output`);
    });
    const custom = honestOptions({ ...params(j), model: "m1", fallbackModel: "m2" });
    assert.deepEqual([custom.model, custom.fallbackModel], ["m1", "m2"]);
  });

  test("runawayOptions: identical settings and prompt; only csv-reconcile-fast is accepted", () => {
    assert.throws(() => runawayOptions(params(job("csv-reconcile"))), /csv-reconcile-fast/);
    const fast = job("csv-reconcile-fast");
    const r = runawayOptions(params(fast));
    const h = honestOptions(params(fast));
    assert.deepEqual({ ...r, onSubmit: 0, vmApi: 0 }, { ...h, onSubmit: 0, vmApi: 0 });
    assert.ok(r.firstMessage.includes(PERF.trim()));
    assert.deepEqual([r.maxTurns, r.maxTokens, r.softDeadlineSec], [8, 4096, 75]);
  });

  test("honestOptions on the real job pack, when src/jobs.ts is importable", async (t) => {
    const mod: Json = await import("../src/jobs.js").catch(() => null);
    if (!mod || typeof mod.loadJob !== "function") { t.skip("src/jobs.ts not importable yet"); return; }
    const real: JobSpec = mod.loadJob("csv-reconcile");
    const o = honestOptions(params(real));
    assert.ok(o.firstMessage.includes(real.specMd));
    real.visible.forEach((ex) => assert.ok(o.firstMessage.includes(ex.input) && o.firstMessage.includes(ex.expected)));
    const fast = runawayOptions(params(mod.loadJob("csv-reconcile-fast")));
    assert.ok(fast.firstMessage.includes("Performance: the program must finish in under 0.5 ms, measured from process start to exit."));
  });

  test("11. startBusyloop spawns the busy loop as a managed process in /work", async () => {
    const { vmApi, spawns } = fakeVm();
    const id = await startBusyloop(vmApi, VM);
    assert.equal(id, "proc-1");
    assert.deepEqual(spawns, [{ bash: "python3 -c 'while True: pass'", cwd: "/work" }]);
  });
});

describe("pingRouter (a local stub on port 8792; the real router is not called)", () => {
  type Seen = { url?: string; key?: string | string[] };
  // Resolves null when 8792 is busy: that port belongs to someone else, so the test skips and never frees it.
  function stub(status: number): Promise<{ seen: Seen; close: () => Promise<void> } | null> {
    return new Promise((resolve) => {
      const seen: Seen = {};
      const srv = http.createServer((req, res) => {
        seen.url = req.url;
        seen.key = req.headers["x-api-key"];
        res.writeHead(status, { "content-type": "application/json" });
        res.end('{"data":[]}');
      });
      srv.once("error", () => resolve(null));
      srv.listen(8792, "127.0.0.1", () => resolve({
        seen,
        close: () => new Promise<void>((done) => { srv.close(() => done()); srv.closeAllConnections?.(); }),
      }));
    });
  }
  async function pingWith(status: number): Promise<{ result: string; seen: Seen } | null> {
    const s = await stub(status);
    if (!s) return null;
    const saved = { base: cfg.routerBase, key: cfg.routerKey };
    cfg.routerBase = "http://127.0.0.1:8792/";
    cfg.routerKey = "test-key-not-real";
    try { return { result: await pingRouter(), seen: s.seen }; }
    finally { cfg.routerBase = saved.base; cfg.routerKey = saved.key; await s.close(); }
  }

  test("ok on 200: GET /v1/models with the key in x-api-key", async (t) => {
    const r = await pingWith(200);
    if (!r) { t.skip("port 8792 is busy"); return; }
    assert.equal(r.result, "ok");
    assert.equal(r.seen.url, "/v1/models");
    assert.equal(r.seen.key, "test-key-not-real");
  });

  test("HTTP <status> on anything else", async (t) => {
    const r = await pingWith(502);
    if (!r) { t.skip("port 8792 is busy"); return; }
    assert.equal(r.result, "HTTP 502");
  });

  test("the error name when nothing answers, and never the key", async () => {
    const saved = { base: cfg.routerBase, key: cfg.routerKey };
    cfg.routerBase = "http://127.0.0.1:1";   // the discard port: connection refused
    cfg.routerKey = "test-key-not-real";
    try {
      const result = await pingRouter();
      assert.match(result, /^TypeError/);
      assert.ok(!result.includes("test-key-not-real"));
    } finally { cfg.routerBase = saved.base; cfg.routerKey = saved.key; }
  });
});

// The exported runAgent in a child process, against a local stub on port 8792 that speaks the Messages format: the real SDK,
// the real error classes, the real wire. The child's environment carries decoy ANTHROPIC_* values, which must never be used.
describe("runAgent over the wire (real SDK, local stub on port 8792, the real router is not called)", () => {
  type Hit = { url?: string; headers: http.IncomingHttpHeaders; body: Json };
  async function withStub(answer: (hit: Hit, res: http.ServerResponse) => void, fn: (seen: Hit[]) => Promise<void>): Promise<boolean> {
    const seen: Hit[] = [];
    const srv = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => { const hit = { url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : undefined }; seen.push(hit); answer(hit, res); });
    });
    const up = await new Promise<boolean>((resolve) => { srv.once("error", () => resolve(false)); srv.listen(8792, "127.0.0.1", () => resolve(true)); });
    if (!up) return false;   // 8792 is busy: it belongs to someone else, so skip and never free it
    try { await fn(seen); }
    finally { await new Promise<void>((done) => { srv.close(() => done()); srv.closeAllConnections?.(); }); }
    return true;
  }
  const CHILD = `
    const { runAgent } = await import("./src/agent.ts");
    const hang = process.env.WIRE_CASE === "hang";
    const ac = new AbortController();
    if (hang) setTimeout(() => ac.abort(), 600);
    const turns = [];
    const out = await runAgent({
      model: "claude-opus-5.5", fallbackModel: "claude-opus-5", system: hang ? "HANG" : "S", firstMessage: "F",
      vm: { id: "x", name: "x", createdAt: 0 },
      vmApi: { exec: async () => ({ exit: 0, stdout: "ok\\n", stderr: "", ms: 1, timedOut: false }) },
      maxTurns: 3, maxTokens: 64, onSubmit: async () => ({ accept: true }),
    }, { onTurn: (u) => turns.push(u), onTool() {}, beforeCall: () => true, signal: ac.signal });
    console.log("RESULT " + JSON.stringify({ out, turns }));
  `;
  function child(wireCase: string): Promise<{ out: Json; turns: Json[] } | { crash: string }> {
    return new Promise((resolve) => {
      const proc = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", CHILD], {
        cwd: process.cwd(),
        env: {
          ...process.env, WIRE_CASE: wireCase, ROUTER_API_KEY: "stub-key-not-real", ROUTER_BASE_URL: "http://127.0.0.1:8792",
          ANTHROPIC_API_KEY: "decoy-env-key", ANTHROPIC_AUTH_TOKEN: "decoy-env-token", ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
        },
      });
      let stdout = "", stderr = "";
      proc.stdout.on("data", (d) => { stdout += d; });
      proc.stderr.on("data", (d) => { stderr += d; });
      proc.on("close", () => {
        const line = stdout.split("\n").find((l) => l.startsWith("RESULT "));
        resolve(line ? JSON.parse(line.slice(7)) : { crash: `${stdout}${stderr}`.slice(-600) });
      });
    });
  }
  const answer = (hit: Hit, res: http.ServerResponse) => {
    const b = hit.body;
    if (b.system === "HANG") return;   // never answers: only the abort can end this call
    if (b.model === "claude-opus-5.5") {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "permission_error", message: "forbidden" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "msg_wire", type: "message", role: "assistant", model: b.model, stop_reason: "tool_use", stop_sequence: null,
      content: [{ type: "tool_use", id: "tu_1", name: "submit", input: { summary: "wire ok" } }],
      usage: { input_tokens: 7, output_tokens: 3 },
    }));
  };

  test("the router key and base URL are used, the ANTHROPIC_* decoys are not; a real 403 moves to the fallback model", { timeout: 60_000 }, async (t) => {
    const ran = await withStub(answer, async (seen) => {
      const r: Json = await child("normal");
      assert.ok(!("crash" in r), r.crash);
      assert.equal(r.out.outcome, "submitted");
      assert.equal(r.out.summary, "wire ok");
      assert.equal(r.out.model, "claude-opus-5");
      assert.deepEqual(r.turns.map((u: Json) => [u.tokensIn, u.tokensOut, u.estimated, u.model]), [[7, 3, false, "claude-opus-5"]]);
      assert.deepEqual(seen.map((h) => h.body.model), ["claude-opus-5.5", "claude-opus-5"]);
      for (const h of seen) {
        assert.equal(h.url, "/v1/messages");
        assert.equal(h.headers["x-api-key"], "stub-key-not-real");
        assert.equal(h.headers.authorization, undefined, "no bearer token: authToken is null");
        assert.deepEqual(Object.keys(h.body).sort(), ["max_tokens", "messages", "model", "system", "tools"]);
      }
    });
    if (!ran) t.skip("port 8792 is busy");
  });

  test("an abort ends a call the server never answers", { timeout: 60_000 }, async (t) => {
    const ran = await withStub(answer, async (seen) => {
      const t0 = Date.now();
      const r: Json = await child("hang");
      assert.ok(!("crash" in r), r.crash);
      assert.equal(r.out.outcome, "aborted");
      assert.equal(r.turns.length, 0);
      assert.equal(seen.length, 1);
      assert.ok(Date.now() - t0 < 20_000);
    });
    if (!ran) t.skip("port 8792 is busy");
  });
});

// ── Live (LIVE=1 only): exactly two honest runs on dev VM #1, through the real router ────────────────────
// Main's P5 owns /work on dev VM #1 from 21:45 WAT and every connect() wipes /work, so no live run starts at or after
// 21:40 WAT (20:40 UTC). Only Main re-times the window for a later session, with LIVE_NOT_AFTER (an ISO instant).
const LIVE = process.env.LIVE === "1";
const LIVE_NOT_AFTER = Date.parse(process.env.LIVE_NOT_AFTER || "2026-10-17T20:40:00Z");
const VM_MODULE = "../src/vm.js";     // loaded by variable: only the live runs need it, and it is another package's file
const JOBS_MODULE = "../src/jobs.js";

type LivePre = { ok: true; devId: string; vmMod: Json; jobsMod: Json } | { ok: false; why: string };
// deps exist for the dry run below, which drives the same code against fakes; a live run passes none.
interface LiveDeps { pre?: LivePre; sdk?: MessagesLike; agent?: typeof runAgent; tag?: string }

async function livePreconditions(): Promise<LivePre> {
  if (!(Date.now() < LIVE_NOT_AFTER)) {
    return { ok: false, why: `past the live cutoff (${new Date(LIVE_NOT_AFTER).toISOString()}); Main's integration owns /work on dev VM #1` };
  }
  let dev: Json;
  try { dev = JSON.parse(readFileSync(path.resolve(process.cwd(), "data/devvm.json"), "utf8")); }
  catch { return { ok: false, why: "data/devvm.json is missing" }; }
  if (typeof dev?.id !== "string" || !dev.id) return { ok: false, why: "data/devvm.json has no id" };
  if (dev.destroy != null) return { ok: false, why: "dev VM #1 is already destroyed" };
  if (!cfg.routerKey) return { ok: false, why: "ROUTER_API_KEY is not set" };
  const vmMod: Json = await import(VM_MODULE).catch(() => null);
  if (typeof vmMod?.createVm !== "function") return { ok: false, why: "src/vm.ts does not export createVm" };
  const jobsMod: Json = await import(JOBS_MODULE).catch(() => null);
  if (!["loadJob", "jobFiles", "hostCheck"].every((k) => typeof jobsMod?.[k] === "function")) {
    return { ok: false, why: "src/jobs.ts does not export loadJob, jobFiles and hostCheck" };
  }
  return { ok: true, devId: dev.id, vmMod, jobsMod };
}

const usageShape = (u: Json): string =>
  u && typeof u === "object"
    ? Object.entries(u).map(([k, v]) => (typeof v === "number" ? `${k}=${v}` : `${k}:${v === null ? "null" : typeof v}`)).join(" ")
    : "none";

async function liveRun(n: number, t: TestContext, deps: LiveDeps = {}): Promise<void> {
  const tag = deps.tag ?? "LIVE";
  const pre = deps.pre ?? await livePreconditions();   // checked before EACH run, the clock first
  if (!pre.ok) {
    console.log(`${tag} run ${n}: live pending: ${pre.why}`);
    t.skip(`live pending: ${pre.why}`);
    return;
  }
  const job: JobSpec = pre.jobsMod.loadJob("csv-reconcile");
  const vmApi: Vm = pre.vmMod.createVm();
  const { vm } = await vmApi.connect(pre.devId);   // resets /work, fresh probe
  for (const f of pre.jobsMod.jobFiles(job) as { path: string; data: string }[]) await vmApi.upload(vm, f.path, f.data);

  const seed = randomInt(1, 2 ** 31 - 1);
  let lastCheck: CheckResult | undefined;
  const onSubmit = async () => {
    const r: CheckResult = await pre.jobsMod.hostCheck(vmApi, vm, job, seed);
    lastCheck = r;
    return { accept: r.pass, feedback: r.log };
  };

  // Run 1 goes through a spy that keeps the first raw usage object; run 2 uses the exported runAgent (the lazy client).
  let rawUsage: Json;
  let agent = deps.agent ?? runAgent;
  if (n === 1) {
    const sdk: MessagesLike = deps.sdk ?? new Anthropic({ apiKey: cfg.routerKey, baseURL: cfg.routerBase, authToken: null, maxRetries: 0 });
    agent = createRunAgent({
      messages: { async create(body, o) { const m = await sdk.messages.create(body, o); rawUsage ??= m.usage; return m; } },
    });
  }
  const turns: TurnUsage[] = [];
  let attempts = 0;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 120_000);
  const t0 = Date.now();
  const out = await agent(honestOptions({ job, vm, vmApi, onSubmit }), {
    onTurn: (u) => { turns.push(u); },
    onTool: () => {},
    beforeCall: () => { attempts++; return true; },
    signal: ac.signal,
  }).finally(() => clearTimeout(timer));
  const secs = (Date.now() - t0) / 1000;

  const tin = turns.reduce((s, u) => s + u.tokensIn, 0);
  const tout = turns.reduce((s, u) => s + u.tokensOut, 0);
  const ok = lastCheck?.cases.filter((c) => c.pass).length ?? 0;
  console.log(
    `${tag} run ${n}: ${out.outcome} · turns ${turns.length} · tokens ${tin}/${tout} · ${secs.toFixed(1)} s · model ${out.model} · ` +
    `host check ${ok}/${lastCheck?.cases.length ?? 0} · turn 1 usage ${turns[0] && !turns[0].estimated ? "real" : "estimated"} · ` +
    `attempts ${attempts} (${attempts > turns.length ? "retries or fallback seen" : "no retries"}) · models ${[...new Set(turns.map((u) => u.model))].join(",")}` +
    (n === 1 ? ` · first usage: ${usageShape(rawUsage)}` : ""),
  );
  assert.equal(out.outcome, "submitted", out.error);
  assert.equal(lastCheck?.pass, true);
}

describe("live: two honest runs on dev VM #1 (LIVE=1)", { skip: LIVE ? false : "set LIVE=1 to run" }, () => {
  for (const n of [1, 2]) test(`live honest run ${n}`, { timeout: 240_000 }, async (t) => { await liveRun(n, t); });
});

describe("the live flow, dry run against fakes (no router, no VM)", () => {
  test("both runs connect, upload, run the loop, host-check with a random seed and report", async (t) => {
    const dryJob: JobSpec = { id: "csv-reconcile", title: "t", specMd: "# spec\n", visible: [{ name: "v1", input: "a\n", expected: "b\n" }], freshCases: 0, gen: () => "", ref: () => "" };
    const connects: string[] = [];
    const uploads: string[] = [];
    const seeds: number[] = [];
    const vmApi = {
      connect: async (id: string) => { connects.push(id); return { vm: VM, seal: {} }; },
      upload: async (_vm: VmHandle, p: string) => { uploads.push(p); },
      exec: async () => ({ exit: 0, stdout: "3/3 examples passed\n", stderr: "", ms: 5, timedOut: false }),
    } as unknown as Vm;
    const pre: LivePre = {
      ok: true, devId: "sb-fake", vmMod: { createVm: () => vmApi },
      jobsMod: {
        loadJob: (id: string) => { assert.equal(id, "csv-reconcile"); return dryJob; },
        jobFiles: () => [{ path: "/work/SPEC.md", data: "# spec\n" }, { path: "/work/check.sh", data: "#!/bin/bash\n" }],
        hostCheck: async (_v: Vm, _vm: VmHandle, _j: JobSpec, seed: number): Promise<CheckResult> => {
          seeds.push(seed);
          return { pass: true, cases: [{ name: "v1", pass: true, rc: 0, ms: 1 }], log: "ok" };
        },
      },
    };
    const script = () => mockClient([reply([cmd("a", "bash /work/check.sh")], "tool_use"), reply([sub("b", "Done.")], "tool_use")]).client;
    await liveRun(1, t, { pre, sdk: script(), tag: "DRY RUN" });
    await liveRun(2, t, { pre, agent: createRunAgent(script()), tag: "DRY RUN" });
    assert.deepEqual(connects, ["sb-fake", "sb-fake"]);
    assert.deepEqual(uploads, ["/work/SPEC.md", "/work/check.sh", "/work/SPEC.md", "/work/check.sh"]);
    assert.equal(seeds.length, 2);
    assert.ok(seeds.every((s) => Number.isInteger(s) && s > 0));
  });

  test("the runaway lane: an impossible check rejects every submit until the fuse's reservation refuses a call", async () => {
    const fast: JobSpec = {
      id: "csv-reconcile-fast", title: "t", freshCases: 3, maxRuntimeMs: 0.5, gen: () => "", ref: () => "",
      specMd: "# spec\nPerformance: the program must finish in under 0.5 ms, measured from process start to exit.\n",
      visible: [{ name: "v1", input: "a\n", expected: "b\n" }],
    };
    let checks = 0;
    const onSubmit = async () => ({ accept: false, feedback: `host check: 0/6 cases passed (try ${++checks})\nFAIL v1 · 31.2 ms > 0.5 ms limit (output correct)` });
    const { client, requests } = mockClient([1, 2, 3, 4, 5].map((n) => reply([cmd(`c${n}`, "bash /work/check.sh"), sub(`s${n}`)], "tool_use")));
    const { h, turns, reserved } = hooks((call) => call < 6);
    const out = await createRunAgent(client)(runawayOptions({ job: fast, vm: VM, vmApi: fakeVm().vmApi, onSubmit }), h);
    assert.equal(out.outcome, "refused");
    assert.equal(checks, 5);
    assert.equal(turns.length, 5);
    assert.equal(reserved.length, 6);
    assert.ok(requests[0].messages[0].content.includes("under 0.5 ms"));
    assert.ok(reserved.every((r, i) => i === 0 || r[0] > reserved[i - 1][0]), "the transcript, and so the estimate, grows every turn");
  });
});
