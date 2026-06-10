import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { tmpdir } from "node:os"

import { PiWorker, PI_MIN_VERSION } from "../src/worker/pi.js"
import { AgentError, AgentInterrupted, type WorkerProgress } from "../src/worker/index.js"
import type { SpawnProcess } from "../src/worker/subprocess-jsonl.js"
import type { AgentSpec, Effort } from "../src/dsl/types.js"

// Scripted spawn harness (same shape as opencode-worker.test.ts).

class FakeStdin extends EventEmitter {
  writable = true
  chunks: string[] = []
  ended = false
  write(chunk: string, cb?: (err?: Error | null) => void): boolean {
    this.chunks.push(chunk)
    if (cb) queueMicrotask(() => cb(null))
    return true
  }
  end(): void {
    this.ended = true
  }
}

class FakeProc extends EventEmitter {
  readonly stdout = new EventEmitter() as EventEmitter & { setEncoding(e: string): void }
  readonly stderr = new EventEmitter() as EventEmitter & { setEncoding(e: string): void }
  readonly stdin = new FakeStdin()
  kills: string[] = []
  constructor() {
    super()
    ;(this.stdout as any).setEncoding = () => {}
    ;(this.stderr as any).setEncoding = () => {}
  }
  pushLine(obj: unknown): void {
    this.stdout.emit("data", JSON.stringify(obj) + "\n")
  }
  pushStderr(s: string): void {
    this.stderr.emit("data", s)
  }
  end(code: number | null, signal: string | null = null): void {
    this.emit("exit", code, signal)
    this.emit("close", code, signal)
  }
  kill(signal?: string): boolean {
    this.kills.push(signal ?? "SIGTERM")
    return true
  }
}

interface SpawnCall {
  bin: string
  args: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  proc: FakeProc
}

type Script = (p: FakeProc, call: SpawnCall) => void

const versionOk: Script = (p) => {
  p.stdout.emit("data", "0.79.1\n")
  p.end(0)
}

function harness(scripts: Script[]): { worker: PiWorker; spawned: SpawnCall[] } {
  const spawned: SpawnCall[] = []
  const queue = [...scripts]
  const spawnProcess: SpawnProcess = (bin, args, opts) => {
    const proc = new FakeProc()
    const call: SpawnCall = { bin, args, cwd: opts.cwd, env: opts.env, proc }
    spawned.push(call)
    const script = queue.shift()
    assert.ok(script, `unexpected spawn #${spawned.length}: ${bin} ${args.join(" ")}`)
    queueMicrotask(() => script(proc, call))
    return proc as any
  }
  return { worker: new PiWorker({ spawnProcess }), spawned }
}

function ctx(signal?: AbortSignal): { signal: AbortSignal; onProgress: (e: WorkerProgress) => void; events: WorkerProgress[] } {
  const events: WorkerProgress[] = []
  return { signal: signal ?? new AbortController().signal, onProgress: (e) => events.push(e), events }
}

function spec(over: Partial<AgentSpec> = {}): AgentSpec {
  return {
    prompt: "do the thing",
    provider: "pi",
    cwd: "/tmp/project",
    sandbox: "danger-full-access",
    approval: "never",
    ...over,
  }
}

function assistantMessage(text: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    usage: {
      input: 50,
      output: 10,
      cacheRead: 5,
      cacheWrite: 1,
      totalTokens: 66,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.02 },
    },
    stopReason: "stop",
    ...over,
  }
}

const happyRun: Script = (p) => {
  p.pushLine({ type: "session", version: 3, id: "ses_pi", timestamp: 1, cwd: "/tmp/project" })
  p.pushLine({ type: "agent_start" })
  p.pushLine({ type: "turn_start" })
  p.pushLine({ type: "message_update", message: {}, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "hmm " } })
  p.pushLine({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Hello " } })
  p.pushLine({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "world" } })
  p.pushLine({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } })
  p.pushLine({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: { content: [{ type: "text", text: "files" }] }, isError: false })
  p.pushLine({ type: "message_end", message: assistantMessage("Hello world") })
  p.pushLine({ type: "turn_end", message: {}, toolResults: [] })
  p.pushLine({ type: "agent_end", messages: [] })
  p.end(0)
}

// ---------------------------------------------------------------------------

test("happy path: argv shape, stdin prompt, delta + tool mapping, usage folding", async () => {
  const h = harness([versionOk, happyRun])
  const c = ctx()
  const result = await h.worker.runAgent(
    spec({ model: "openrouter/moonshotai/kimi-k2.6", effort: "high", instructions: "be terse" }),
    c,
  )

  assert.equal(h.spawned.length, 2)
  assert.deepEqual(h.spawned[0]!.args, ["--version"])
  assert.deepEqual(h.spawned[1]!.args, [
    "--mode",
    "json",
    "--no-session",
    "--model",
    "openrouter/moonshotai/kimi-k2.6",
    "--thinking",
    "high",
    "--append-system-prompt",
    "be terse",
  ])
  assert.equal(h.spawned[1]!.cwd, "/tmp/project")
  assert.deepEqual(h.spawned[1]!.proc.stdin.chunks, ["do the thing"])
  assert.equal(h.spawned[1]!.proc.stdin.ended, true)

  assert.equal(result.text, "Hello world")
  assert.equal(result.status, "completed")
  // input + cacheRead + cacheWrite = 56; output = 10; cost.total = 0.02
  assert.deepEqual(result.usage, { inputTokens: 56, outputTokens: 10, costUsd: 0.02 })

  assert.deepEqual(
    c.events.map((e) => e.kind),
    ["reasoning", "text", "text", "tool", "tool-result", "usage"],
  )
  const toolResult = c.events.find((e) => e.kind === "tool-result") as Extract<WorkerProgress, { kind: "tool-result" }>
  assert.equal(toolResult.output, "files")
  assert.equal(toolResult.isError, false)
})

test("flag omission: no --model/--thinking/--append-system-prompt when unset", async () => {
  const h = harness([versionOk, happyRun])
  await h.worker.runAgent(spec(), ctx())
  assert.deepEqual(h.spawned[1]!.args, ["--mode", "json", "--no-session"])
})

test("model strings pass through verbatim, including colon thinking suffixes", async () => {
  const h = harness([versionOk, happyRun])
  await h.worker.runAgent(spec({ model: "sonnet:high" }), ctx())
  const args = h.spawned[1]!.args
  assert.equal(args[args.indexOf("--model") + 1], "sonnet:high")
})

test("effort → --thinking mapping covers every tier (none→off, max→xhigh)", async () => {
  const cases: Array<[Effort, string]> = [
    ["none", "off"],
    ["minimal", "minimal"],
    ["low", "low"],
    ["medium", "medium"],
    ["high", "high"],
    ["xhigh", "xhigh"],
    ["max", "xhigh"],
  ]
  for (const [effort, thinking] of cases) {
    const h = harness([versionOk, happyRun])
    await h.worker.runAgent(spec({ effort }), ctx())
    const args = h.spawned[1]!.args
    assert.equal(args[args.indexOf("--thinking") + 1], thinking, `effort=${effort}`)
  }
})

test("stopReason 'error' is fatal despite exit 0 (json mode hides it from the exit code)", async () => {
  const h = harness([
    versionOk,
    (p) => {
      p.pushLine({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "partial" } })
      p.pushLine({ type: "message_end", message: assistantMessage("partial", { stopReason: "error", errorMessage: "rate limited" }) })
      p.end(0)
    },
  ])
  await assert.rejects(h.worker.runAgent(spec(), ctx()), (err: unknown) => {
    assert.ok(err instanceof AgentError)
    assert.equal(err.code, "provider_error")
    assert.match(err.message, /rate limited/)
    return true
  })
})

test("the error assistantMessageEvent alone is terminal too", async () => {
  const h = harness([
    versionOk,
    (p) => {
      p.pushLine({
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "error", reason: "error", error: assistantMessage("", { stopReason: "error", errorMessage: "boom" }) },
      })
      p.end(0)
    },
  ])
  await assert.rejects(h.worker.runAgent(spec(), ctx()), (err: unknown) => {
    assert.ok(err instanceof AgentError)
    assert.match(err.message, /boom/)
    return true
  })
})

test("stopReason 'aborted' without an omegacode abort is a provider failure, not success", async () => {
  const h = harness([
    versionOk,
    (p) => {
      p.pushLine({ type: "message_end", message: assistantMessage("partial", { stopReason: "aborted" }) })
      p.end(0)
    },
  ])
  await assert.rejects(h.worker.runAgent(spec(), ctx()), (err: unknown) => {
    assert.ok(err instanceof AgentError)
    assert.equal(err.code, "aborted")
    return true
  })
})

test("preflight failures (exit 1, nothing streamed) classify as provider_exit with stderr", async () => {
  const h = harness([
    versionOk,
    (p) => {
      p.pushStderr("No model matching pattern: gpt-99\n")
      p.end(1)
    },
  ])
  await assert.rejects(h.worker.runAgent(spec({ model: "gpt-99" }), ctx()), (err: unknown) => {
    assert.ok(err instanceof AgentError)
    assert.equal(err.code, "provider_exit")
    assert.match(err.message, /No model matching/)
    return true
  })
})

test("exit 0 with no assistant text is no_result", async () => {
  const h = harness([
    versionOk,
    (p) => {
      p.pushLine({ type: "agent_start" })
      p.pushLine({ type: "agent_end", messages: [] })
      p.end(0)
    },
  ])
  await assert.rejects(h.worker.runAgent(spec(), ctx()), (err: unknown) => err instanceof AgentError && err.code === "no_result")
})

test("fail-closed pre-spawn rejections: read-only (with remedy), workspace-write, maxTurns", async () => {
  const h = harness([])
  for (const [over, pattern] of [
    [{ sandbox: "read-only" }, /set sandbox: "danger-full-access" to use provider "pi"/],
    [{ sandbox: "workspace-write" }, /cannot enforce a "workspace-write" sandbox/],
    [{ maxTurns: 3 }, /no native turn cap/],
  ] as Array<[Partial<AgentSpec>, RegExp]>) {
    await assert.rejects(h.worker.runAgent(spec(over), ctx()), (err: unknown) => {
      assert.ok(err instanceof AgentError)
      assert.equal(err.code, "unsupported_option")
      assert.match(err.message, pattern)
      return true
    })
  }
  assert.equal(h.spawned.length, 0)
})

test("version preflight: isolated probe env, once per worker, outdated refused with upgrade hint", async () => {
  const h = harness([
    (p) => {
      p.stdout.emit("data", "0.54.0\n")
      p.end(0)
    },
  ])
  await assert.rejects(h.worker.runAgent(spec(), ctx()), (err: unknown) => {
    assert.ok(err instanceof AgentError)
    assert.equal(err.code, "provider_outdated")
    assert.match(err.message, /@earendil-works\/pi-coding-agent/)
    assert.match(err.message, new RegExp(PI_MIN_VERSION.replace(/\./g, "\\.")))
    return true
  })
  // The probe runs with a scratch agent dir and a neutral cwd — never the user's project.
  const probe = h.spawned[0]!
  assert.ok(probe.env?.PI_CODING_AGENT_DIR?.includes("omegacode-pi-version-"))
  assert.equal(probe.cwd, tmpdir())

  const h2 = harness([versionOk, happyRun, happyRun])
  await h2.worker.runAgent(spec(), ctx())
  await h2.worker.runAgent(spec(), ctx())
  assert.equal(h2.spawned.filter((s) => s.args[0] === "--version").length, 1)
})

test("schema: silent tool-less extraction replays the working answer; usage sums", async () => {
  const h = harness([
    versionOk,
    happyRun, // working turn: text "Hello world", usage 56/10/0.02
    (p) => {
      p.pushLine({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: '{"answer": 42}' } })
      p.pushLine({ type: "message_end", message: assistantMessage('{"answer": 42}') })
      p.end(0)
    },
  ])
  const c = ctx()
  const schema = { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] }
  const result = await h.worker.runAgent(spec({ schema, instructions: "be terse" }), c)

  const extraction = h.spawned[2]!
  assert.ok(extraction.args.includes("--no-tools"), "extraction must disable tools")
  const ti = extraction.args.indexOf("--thinking")
  assert.equal(extraction.args[ti + 1], "off")
  // Instructions ride --append-system-prompt into the extraction turn (corrective retry path).
  assert.equal(extraction.args[extraction.args.indexOf("--append-system-prompt") + 1], "be terse")
  // --no-session has no continuity: the working answer is replayed in the extraction prompt.
  assert.match(extraction.proc.stdin.chunks[0]!, /Hello world/)
  assert.match(extraction.proc.stdin.chunks[0]!, /JSON Schema/)

  assert.deepEqual(result.structured, { answer: 42 })
  assert.deepEqual(result.usage, { inputTokens: 112, outputTokens: 20, costUsd: 0.04 })
  // Extraction is silent — the working turn's two text deltas are the only text progress.
  assert.equal(c.events.filter((e) => e.kind === "text").length, 2)
})

test("schema: unparseable extraction leaves structured undefined (runtime retries)", async () => {
  const h = harness([
    versionOk,
    happyRun,
    (p) => {
      p.pushLine({ type: "message_end", message: assistantMessage("no json, sorry") })
      p.end(0)
    },
  ])
  const result = await h.worker.runAgent(spec({ schema: { type: "object" } }), ctx())
  assert.equal(result.structured, undefined)
})

test("a pre-aborted signal short-circuits; mid-run abort interrupts and SIGTERMs", async () => {
  const pre = new AbortController()
  pre.abort()
  const h = harness([])
  await assert.rejects(h.worker.runAgent(spec(), ctx(pre.signal)), AgentInterrupted)
  assert.equal(h.spawned.length, 0)

  const ac = new AbortController()
  const h2 = harness([
    versionOk,
    (p) => {
      p.pushLine({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "working…" } })
      queueMicrotask(() => ac.abort())
    },
  ])
  await assert.rejects(h2.worker.runAgent(spec(), ctx(ac.signal)), AgentInterrupted)
  assert.deepEqual(h2.spawned[1]!.proc.kills, ["SIGTERM"])
})

test("unknown event types are ignored (forward compatibility)", async () => {
  const h = harness([
    versionOk,
    (p) => {
      p.pushLine({ type: "extension_event", whatever: true })
      p.pushLine({ type: "message_end", message: assistantMessage("ok") })
      p.end(0)
    },
  ])
  const result = await h.worker.runAgent(spec(), ctx())
  assert.equal(result.text, "ok")
})
