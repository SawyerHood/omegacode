// ClaudeWorker turn-loop tests. The SDK's query() is injected (ClaudeWorkerOpts.queryFn — the
// claude analogue of CodexWorker's spawnChild seam): tests script the message stream and observe
// the Options the worker built. This is what asserts the canUseTool gate is actually WIRED into
// the SDK call — checkTool's own classification semantics are covered in factory.test.ts.

import { test } from "node:test"
import assert from "node:assert/strict"
import { ClaudeWorker, type QueryFn } from "../src/worker/claude.ts"
import { AgentError, AgentInterrupted, type WorkerContext, type WorkerProgress } from "../src/worker/index.ts"
import type { AgentSpec } from "../src/dsl/types.ts"
import type { Options, PermissionResult, SDKMessage } from "@anthropic-ai/claude-agent-sdk"

interface QueryCall {
  prompt: string
  options: Options
}

/** A QueryFn that records its call and replays a scripted message sequence. */
function scripted(messages: unknown[], calls: QueryCall[] = []): QueryFn {
  return (params) => {
    calls.push(params as QueryCall)
    return (async function* () {
      yield* messages as SDKMessage[]
    })()
  }
}

function assistantMsg(blocks: unknown): unknown {
  return { type: "assistant", message: { content: blocks } }
}
function userMsg(blocks: unknown): unknown {
  return { type: "user", message: { content: blocks } }
}
/** A success result message (override `subtype`/`usage`/… for the error shapes). */
function resultMsg(over: Record<string, unknown> = {}): unknown {
  return {
    type: "result",
    subtype: "success",
    result: "all done",
    usage: { input_tokens: 10, output_tokens: 4 },
    total_cost_usd: 0.01,
    ...over,
  }
}

function ctx(signal?: AbortSignal): WorkerContext & { events: WorkerProgress[] } {
  const events: WorkerProgress[] = []
  return { signal: signal ?? new AbortController().signal, onProgress: (e) => events.push(e), events }
}

function spec(over: Partial<AgentSpec> = {}): AgentSpec {
  return { prompt: "do the thing", provider: "claude-code", cwd: "/work/repo", sandbox: "workspace-write", approval: "never", ...over }
}

const SCHEMA = { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] }

/** The shape the worker installs (the SDK type carries an extra options param we don't use). */
type Gate = (toolName: string, input: Record<string, unknown>) => Promise<PermissionResult>

function tick(): Promise<void> {
  return new Promise((r) => setImmediate(r))
}

// ===========================================================================
// canUseTool wiring — deleting the canUseTool option must fail these tests
// ===========================================================================

test("canUseTool is wired into the SDK options and enforces the spec's sandbox + cwd", async () => {
  const calls: QueryCall[] = []
  const worker = new ClaudeWorker({ queryFn: scripted([resultMsg()], calls) })
  await worker.runAgent(spec({ sandbox: "workspace-write", cwd: "/work/repo" }), ctx())
  const gate = calls[0]!.options.canUseTool as Gate | undefined
  assert.ok(gate, "options.canUseTool must be installed — without it workspace-write is unenforced")
  const denied = await gate("Write", { file_path: "/etc/passwd" })
  assert.equal(denied.behavior, "deny")
  assert.match((denied as { message: string }).message, /outside the workspace/)
  const input = { file_path: "/work/repo/ok.txt", content: "x" }
  const allowed = await gate("Write", input)
  assert.equal(allowed.behavior, "allow")
  assert.equal((allowed as { updatedInput: unknown }).updatedInput, input) // input passed through untouched
})

test("canUseTool carries the spec's SANDBOX through (read-only denies writes, allows read Bash)", async () => {
  const calls: QueryCall[] = []
  const worker = new ClaudeWorker({ queryFn: scripted([resultMsg()], calls) })
  await worker.runAgent(spec({ sandbox: "read-only" }), ctx())
  const gate = calls[0]!.options.canUseTool as Gate
  assert.equal((await gate("Bash", { command: "rm -rf x" })).behavior, "deny")
  assert.equal((await gate("Bash", { command: "git log --oneline" })).behavior, "allow")
  assert.equal((await gate("Write", { file_path: "/work/repo/x" })).behavior, "deny")
})

// ===========================================================================
// runAgent — happy path, options mapping, structured output
// ===========================================================================

test("happy path: result text + usage (cache tokens fold into inputTokens)", async () => {
  const calls: QueryCall[] = []
  const worker = new ClaudeWorker({
    queryFn: scripted(
      [resultMsg({ usage: { input_tokens: 10, cache_read_input_tokens: 200, cache_creation_input_tokens: 30, output_tokens: 4 }, total_cost_usd: 0.05 })],
      calls,
    ),
  })
  const res = await worker.runAgent(spec(), ctx())
  assert.equal(res.text, "all done")
  assert.equal(res.status, "completed")
  assert.equal(res.structured, undefined) // no schema on the spec → structured stays absent
  assert.equal(res.usage.inputTokens, 240)
  assert.equal(res.usage.outputTokens, 4)
  assert.equal(res.usage.costUsd, 0.05)
  assert.equal(calls[0]!.prompt, "do the thing")
})

test("spec → SDK options: cwd/model/maxTurns/effort floor/instructions preset append", async () => {
  const calls: QueryCall[] = []
  const worker = new ClaudeWorker({ queryFn: scripted([resultMsg()], calls), model: "default-model" })
  await worker.runAgent(spec({ model: "claude-x", maxTurns: 7, effort: "none", instructions: "be terse" }), ctx())
  const o = calls[0]!.options
  assert.equal(o.cwd, "/work/repo")
  assert.equal(o.model, "claude-x") // spec.model wins over the worker default
  assert.equal(o.maxTurns, 7)
  assert.equal(o.effort, "low") // codex-only "none" maps to the SDK floor
  assert.deepEqual(o.systemPrompt, { type: "preset", preset: "claude_code", append: "be terse" })
  assert.equal(o.permissionMode, "default")
  assert.deepEqual(o.settingSources, [])

  await worker.runAgent(spec(), ctx()) // no spec.model/effort/instructions
  const o2 = calls[1]!.options
  assert.equal(o2.model, "default-model")
  assert.equal(o2.effort, undefined)
  assert.equal(o2.systemPrompt, undefined)
})

test("schema spec: outputFormat is sent and structured_output comes back on the result", async () => {
  const calls: QueryCall[] = []
  const worker = new ClaudeWorker({ queryFn: scripted([resultMsg({ structured_output: { answer: 42 } })], calls) })
  const res = await worker.runAgent(spec({ schema: SCHEMA }), ctx())
  assert.deepEqual(calls[0]!.options.outputFormat, { type: "json_schema", schema: SCHEMA })
  assert.deepEqual(res.structured, { answer: 42 })
  // without a schema the same SDK field is ignored and no outputFormat is sent
  const calls2: QueryCall[] = []
  const w2 = new ClaudeWorker({ queryFn: scripted([resultMsg({ structured_output: { answer: 42 } })], calls2) })
  const r2 = await w2.runAgent(spec(), ctx())
  assert.equal(r2.structured, undefined)
  assert.equal(calls2[0]!.options.outputFormat, undefined)
})

// ===========================================================================
// progress mapping
// ===========================================================================

test("progress mapping: text/thinking/tool_use/tool_result → WorkerProgress events in order", async () => {
  const c = ctx()
  const worker = new ClaudeWorker({
    queryFn: scripted([
      assistantMsg([
        { type: "text", text: "hello" },
        { type: "thinking", thinking: "hmm" },
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
      ]),
      userMsg([{ type: "tool_result", tool_use_id: "t1", content: "file.txt", is_error: false }]),
      // non-string tool_result content is JSON-stringified; is_error maps through
      userMsg([{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "x" }], is_error: true }]),
      resultMsg(),
    ]),
  })
  await worker.runAgent(spec(), c)
  assert.deepEqual(c.events, [
    { kind: "text", text: "hello" },
    { kind: "reasoning", text: "hmm" },
    { kind: "tool", id: "t1", name: "Bash", input: { command: "ls" } },
    { kind: "tool-result", id: "t1", output: "file.txt", isError: false },
    { kind: "tool-result", id: "t2", output: '[{"type":"text","text":"x"}]', isError: true },
  ])
})

test("malformed/unknown blocks and message types are skipped without crashing", async () => {
  const c = ctx()
  const worker = new ClaudeWorker({
    queryFn: scripted([
      { type: "system", subtype: "init" }, // unrelated message type
      assistantMsg(["raw string", null, { type: "text" }, { type: "thinking", thinking: 42 }, { type: "tool_use", name: 7 }]),
      assistantMsg("not-an-array"),
      userMsg("not-an-array"),
      resultMsg(),
    ]),
  })
  const res = await worker.runAgent(spec(), c)
  assert.equal(res.text, "all done")
  assert.deepEqual(c.events, [])
})

// ===========================================================================
// result-loop failure paths
// ===========================================================================

test("a stream that ends without a result message → no_result (and is NOT re-wrapped as sdk_error)", async () => {
  const empty = new ClaudeWorker({ queryFn: scripted([]) })
  await assert.rejects(empty.runAgent(spec(), ctx()), (e) => e instanceof AgentError && e.code === "no_result" && e.retryable === false)
  // a stream with progress but no terminal result is equally incomplete
  const partial = new ClaudeWorker({ queryFn: scripted([assistantMsg([{ type: "text", text: "thinking…" }])]) })
  await assert.rejects(partial.runAgent(spec(), ctx()), (e) => e instanceof AgentError && e.code === "no_result")
})

test("non-success result → AgentError with the subtype as code; retryable only for rate/overload shapes", async () => {
  async function failWith(subtype: string): Promise<AgentError> {
    const worker = new ClaudeWorker({ queryFn: scripted([resultMsg({ subtype })]) })
    const err = await worker.runAgent(spec(), ctx()).catch((e) => e)
    assert.ok(err instanceof AgentError, `subtype ${subtype} must surface as AgentError`)
    return err
  }
  const maxTurns = await failWith("error_max_turns") // terminal cap: never retry
  assert.equal(maxTurns.code, "error_max_turns")
  assert.equal(maxTurns.retryable, false)
  assert.match(maxTurns.message, /claude result: error_max_turns/)
  assert.equal((await failWith("error_overloaded_529")).retryable, true)
  assert.equal((await failWith("error_rate_limited")).retryable, true)
  assert.equal((await failWith("error_during_execution")).retryable, false)
})

test("a failed turn's AgentError carries cache-inclusive usage (failed turns still bill)", async () => {
  const worker = new ClaudeWorker({
    queryFn: scripted([
      resultMsg({
        subtype: "error_during_execution",
        usage: { input_tokens: 100, cache_read_input_tokens: 4000, cache_creation_input_tokens: 500, output_tokens: 42 },
        total_cost_usd: 0.07,
      }),
    ]),
  })
  const err = await worker.runAgent(spec(), ctx()).catch((e) => e)
  assert.ok(err instanceof AgentError)
  assert.equal(err.usage?.inputTokens, 4600)
  assert.equal(err.usage?.outputTokens, 42)
  assert.equal(err.usage?.costUsd, 0.07)
})

test("an SDK throw is wrapped as retryable sdk_error (message preserved)", async () => {
  const midStream = new ClaudeWorker({
    queryFn: () =>
      (async function* (): AsyncGenerator<SDKMessage> {
        yield assistantMsg([{ type: "text", text: "partial" }]) as SDKMessage
        throw new Error("socket hung up")
      })(),
  })
  await assert.rejects(
    midStream.runAgent(spec(), ctx()),
    (e) => e instanceof AgentError && e.code === "sdk_error" && e.retryable === true && /socket hung up/.test(e.message),
  )
  const syncThrow = new ClaudeWorker({
    queryFn: () => {
      throw new Error("spawn failed")
    },
  })
  await assert.rejects(syncThrow.runAgent(spec(), ctx()), (e) => e instanceof AgentError && e.code === "sdk_error" && /spawn failed/.test(e.message))
})

// ===========================================================================
// background-task stream shapes — StructuredOutput recovery
// (Claude Code's background tasks can end the stream without a result message,
// or append a post-answer task-notification turn whose result lacks
// structured_output and whose text is watcher chatter.)
// ===========================================================================

/** assistant StructuredOutput call + its accepted tool_result. */
function structuredOutputTurn(payload: unknown, over: { id?: string; is_error?: boolean } = {}): unknown[] {
  const id = over.id ?? "so1"
  return [
    assistantMsg([{ type: "tool_use", id, name: "StructuredOutput", input: payload }]),
    userMsg([{ type: "tool_result", tool_use_id: id, content: "Structured output provided successfully", is_error: over.is_error ?? false }]),
  ]
}

test("stream ends with NO result after an accepted StructuredOutput → recovered, not no_result", async () => {
  const worker = new ClaudeWorker({
    queryFn: scripted([
      ...structuredOutputTurn({ answer: 42 }),
      assistantMsg([{ type: "text", text: "gate is green" }]), // final answer, then the stream just closes
    ]),
  })
  const res = await worker.runAgent(spec({ schema: SCHEMA }), ctx())
  assert.equal(res.status, "completed")
  assert.deepEqual(res.structured, { answer: 42 })
  assert.equal(res.text, "gate is green")
})

test("no-result recovery sums assistant usage deduped by API message id (cost unknowable → 0)", async () => {
  const usage = { input_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10, output_tokens: 7 }
  const worker = new ClaudeWorker({
    queryFn: scripted([
      { type: "assistant", message: { id: "m1", usage, content: [{ type: "tool_use", id: "so1", name: "StructuredOutput", input: { answer: 1 } }] } },
      { type: "assistant", message: { id: "m1", usage, content: [{ type: "text", text: "same API message, second block" }] } }, // repeat id: counted once
      userMsg([{ type: "tool_result", tool_use_id: "so1", content: "ok", is_error: false }]),
      { type: "assistant", message: { id: "m2", usage: { input_tokens: 50, output_tokens: 3 }, content: [{ type: "text", text: "done" }] } },
    ]),
  })
  const res = await worker.runAgent(spec({ schema: SCHEMA }), ctx())
  assert.equal(res.usage.inputTokens, 1160)
  assert.equal(res.usage.outputTokens, 10)
  assert.equal(res.usage.costUsd, 0)
})

test("a post-answer NOTIFICATION turn's result lacking structured_output → recovered from the tool payload", async () => {
  const worker = new ClaudeWorker({
    queryFn: scripted([
      ...structuredOutputTurn({ answer: 42 }),
      assistantMsg([{ type: "text", text: "that's just the watcher exiting — nothing new" }]),
      resultMsg({ origin: { kind: "task-notification" }, total_cost_usd: 1.68 }), // no structured_output field
    ]),
  })
  const res = await worker.runAgent(spec({ schema: SCHEMA }), ctx())
  assert.deepEqual(res.structured, { answer: 42 })
  assert.equal(res.usage.costUsd, 1.68) // cost still taken from the notification result — it's all we have
})

test("a non-success NOTIFICATION result after an accepted StructuredOutput does not fail the finished agent", async () => {
  const worker = new ClaudeWorker({
    queryFn: scripted([
      ...structuredOutputTurn({ answer: 42 }),
      resultMsg({ subtype: "error_during_execution", origin: { kind: "task-notification" } }),
    ]),
  })
  const res = await worker.runAgent(spec({ schema: SCHEMA }), ctx())
  assert.equal(res.status, "completed")
  assert.deepEqual(res.structured, { answer: 42 })
})

test("the PRIMARY turn's result is preferred over a later notification turn's (text and structured)", async () => {
  // free-form: the real answer must not be replaced by watcher chatter
  const freeForm = new ClaudeWorker({
    queryFn: scripted([
      resultMsg({ result: "the real analysis" }),
      resultMsg({ result: "background task completed — nothing new", origin: { kind: "task-notification" } }),
    ]),
  })
  const r1 = await freeForm.runAgent(spec(), ctx())
  assert.equal(r1.text, "the real analysis")
  // schema: the primary result's structured_output survives a notification result that lacks it
  const schemaed = new ClaudeWorker({
    queryFn: scripted([
      resultMsg({ structured_output: { answer: 7 } }),
      resultMsg({ origin: { kind: "task-notification" } }),
    ]),
  })
  const r2 = await schemaed.runAgent(spec({ schema: SCHEMA }), ctx())
  assert.deepEqual(r2.structured, { answer: 7 })
})

test("when the result carries structured_output (even alongside a tool payload), the result's wins; null falls back", async () => {
  const carried = new ClaudeWorker({
    queryFn: scripted([...structuredOutputTurn({ answer: 1 }), resultMsg({ structured_output: { answer: 2 } })]),
  })
  assert.deepEqual((await carried.runAgent(spec({ schema: SCHEMA }), ctx())).structured, { answer: 2 })
  // an explicit null structured_output must not shadow the accepted tool payload
  const nulled = new ClaudeWorker({
    queryFn: scripted([...structuredOutputTurn({ answer: 3 }), resultMsg({ structured_output: null })]),
  })
  assert.deepEqual((await nulled.runAgent(spec({ schema: SCHEMA }), ctx())).structured, { answer: 3 })
})

test("a result followed by trailing assistant messages still resolves (last RESULT, not last message)", async () => {
  const worker = new ClaudeWorker({
    queryFn: scripted([resultMsg(), assistantMsg([{ type: "text", text: "trailing notification chatter" }])]),
  })
  const res = await worker.runAgent(spec(), ctx())
  assert.equal(res.status, "completed")
  assert.equal(res.text, "all done")
})

test("abort that truncates the stream after an accepted StructuredOutput → AgentInterrupted, not completed", async () => {
  const ac = new AbortController()
  const worker = new ClaudeWorker({
    queryFn: () =>
      (async function* (): AsyncGenerator<SDKMessage> {
        for (const m of structuredOutputTurn({ answer: 42 })) yield m as SDKMessage
        ac.abort() // the SDK can end the iterator cleanly on abort — no throw, no result message
      })(),
  })
  await assert.rejects(worker.runAgent(spec({ schema: SCHEMA }), ctx(ac.signal)), (e) => e instanceof AgentInterrupted)
})

test("subagent-relayed messages (parent_tool_use_id set) do not feed recovery state or usage", async () => {
  const worker = new ClaudeWorker({
    queryFn: scripted([
      {
        type: "assistant",
        parent_tool_use_id: "task1", // a Task subagent's stream relayed through the parent query
        message: { id: "sub1", usage: { input_tokens: 999, output_tokens: 99 }, content: [{ type: "tool_use", id: "so1", name: "StructuredOutput", input: { answer: 13 } }] },
      },
      userMsg([{ type: "tool_result", tool_use_id: "so1", content: "ok", is_error: false }]),
    ]),
  })
  await assert.rejects(worker.runAgent(spec({ schema: SCHEMA }), ctx()), (e) => e instanceof AgentError && e.code === "no_result")
})

test("a REJECTED StructuredOutput call is not recovery evidence; a later accepted one is", async () => {
  // rejected only → still no_result
  const rejectedOnly = new ClaudeWorker({
    queryFn: scripted([...structuredOutputTurn({ answer: "bad" }, { is_error: true }), assistantMsg([{ type: "text", text: "hm" }])]),
  })
  await assert.rejects(rejectedOnly.runAgent(spec({ schema: SCHEMA }), ctx()), (e) => e instanceof AgentError && e.code === "no_result")
  // rejected then accepted retry → the retry's payload is recovered
  const retried = new ClaudeWorker({
    queryFn: scripted([
      ...structuredOutputTurn({ answer: "bad" }, { id: "so1", is_error: true }),
      ...structuredOutputTurn({ answer: 7 }, { id: "so2" }),
    ]),
  })
  const res = await retried.runAgent(spec({ schema: SCHEMA }), ctx())
  assert.deepEqual(res.structured, { answer: 7 })
})

test("an IN-FLIGHT StructuredOutput call at truncation disables recovery (the accepted payload was being superseded)", async () => {
  const worker = new ClaudeWorker({
    queryFn: scripted([
      ...structuredOutputTurn({ answer: 1 }), // accepted
      assistantMsg([{ type: "tool_use", id: "so2", name: "StructuredOutput", input: { answer: 2 } }]), // stream cuts before so2's tool_result
    ]),
  })
  await assert.rejects(worker.runAgent(spec({ schema: SCHEMA }), ctx()), (e) => e instanceof AgentError && e.code === "no_result")
})

test("no-result recovery is schema-gated: free-form agents keep the hard no_result error", async () => {
  // Same truncated-stream shape, but no spec.schema → partial text must not pass as an answer.
  const worker = new ClaudeWorker({
    queryFn: scripted([...structuredOutputTurn({ answer: 42 }), assistantMsg([{ type: "text", text: "partial" }])]),
  })
  await assert.rejects(worker.runAgent(spec(), ctx()), (e) => e instanceof AgentError && e.code === "no_result")
})

// ===========================================================================
// abort semantics
// ===========================================================================

test("abort mid-query → AgentInterrupted, and the abort is PROPAGATED to the SDK's abortController", async () => {
  const ac = new AbortController()
  const calls: QueryCall[] = []
  const queryFn: QueryFn = (params) => {
    calls.push(params as QueryCall)
    return (async function* (): AsyncGenerator<SDKMessage> {
      // Hang until the worker-side controller fires (proves the ctx.signal → abortController
      // wiring), then throw the way the SDK does on abort. The ctx-signal backstop keeps a
      // broken wiring from hanging the test — the post-reject assert catches it instead.
      await new Promise<void>((resolve) => {
        params.options.abortController?.signal.addEventListener("abort", () => resolve(), { once: true })
        ac.signal.addEventListener("abort", () => setTimeout(resolve, 50), { once: true })
      })
      throw new Error("aborted")
    })()
  }
  const worker = new ClaudeWorker({ queryFn })
  const run = worker.runAgent(spec(), ctx(ac.signal))
  await tick()
  ac.abort()
  await assert.rejects(run, (e) => e instanceof AgentInterrupted)
  assert.equal(calls[0]!.options.abortController?.signal.aborted, true, "ctx.signal abort must propagate to the SDK controller")
})

test("the abort listener is removed once the turn settles (no leak onto a later ctx abort)", async () => {
  const ac = new AbortController()
  const calls: QueryCall[] = []
  const worker = new ClaudeWorker({ queryFn: scripted([resultMsg()], calls) })
  await worker.runAgent(spec(), ctx(ac.signal))
  ac.abort()
  assert.equal(calls[0]!.options.abortController?.signal.aborted, false, "a leaked listener aborted the finished turn's controller")
})
