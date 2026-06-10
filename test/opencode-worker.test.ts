import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"

import { OpencodeWorker, OPENCODE_MIN_VERSION } from "../src/worker/opencode.js"
import { AgentError, AgentInterrupted, type WorkerProgress } from "../src/worker/index.js"
import type { SpawnProcess } from "../src/worker/subprocess-jsonl.js"
import type { AgentSpec } from "../src/dsl/types.js"

// ---------------------------------------------------------------------------
// Scripted spawn harness: each spawn pops the next script off a queue and
// drives the fake child after the worker has wired its listeners.
// ---------------------------------------------------------------------------

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
  p.stdout.emit("data", "1.16.2\n")
  p.end(0)
}

function harness(scripts: Script[]): { worker: OpencodeWorker; spawned: SpawnCall[] } {
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
  return { worker: new OpencodeWorker({ spawnProcess }), spawned }
}

function ctx(signal?: AbortSignal): { signal: AbortSignal; onProgress: (e: WorkerProgress) => void; events: WorkerProgress[] } {
  const events: WorkerProgress[] = []
  return { signal: signal ?? new AbortController().signal, onProgress: (e) => events.push(e), events }
}

function spec(over: Partial<AgentSpec> = {}): AgentSpec {
  return {
    prompt: "do the thing",
    provider: "opencode",
    cwd: "/tmp/project",
    sandbox: "danger-full-access",
    approval: "never",
    ...over,
  }
}

const happyRun: Script = (p) => {
  p.pushLine({ type: "step_start", timestamp: 1, sessionID: "ses_1", part: {} })
  p.pushLine({ type: "reasoning", timestamp: 2, sessionID: "ses_1", part: { text: "thinking…" } })
  p.pushLine({
    type: "tool_use",
    timestamp: 3,
    sessionID: "ses_1",
    part: { callID: "c1", tool: "bash", state: { status: "completed", input: { command: "ls" }, output: "files" } },
  })
  p.pushLine({ type: "text", timestamp: 4, sessionID: "ses_1", part: { text: "Hello world" } })
  p.pushLine({
    type: "step_finish",
    timestamp: 5,
    sessionID: "ses_1",
    part: { cost: 0.01, tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 10, write: 2 } } },
  })
  p.end(0)
}

// ---------------------------------------------------------------------------

test("happy path: argv shape, stdin prompt, event mapping, usage normalization", async () => {
  const h = harness([versionOk, happyRun])
  const c = ctx()
  const result = await h.worker.runAgent(spec({ model: "openrouter/anthropic/claude-sonnet-4.5" }), c)

  assert.equal(h.spawned.length, 2)
  assert.deepEqual(h.spawned[0]!.args, ["--version"])
  assert.deepEqual(h.spawned[1]!.args, [
    "run",
    "--format",
    "json",
    "--thinking",
    "--model",
    "openrouter/anthropic/claude-sonnet-4.5", // nested slashes pass through verbatim
    "--dangerously-skip-permissions",
  ])
  assert.equal(h.spawned[1]!.cwd, "/tmp/project")
  assert.equal(h.spawned[1]!.env?.OPENCODE_DISABLE_AUTOUPDATE, "1")
  assert.deepEqual(h.spawned[1]!.proc.stdin.chunks, ["do the thing"])
  assert.equal(h.spawned[1]!.proc.stdin.ended, true)

  assert.equal(result.text, "Hello world")
  assert.equal(result.status, "completed")
  // input + cache.read + cache.write; output + reasoning
  assert.deepEqual(result.usage, { inputTokens: 112, outputTokens: 25, costUsd: 0.01 })

  const kinds = c.events.map((e) => e.kind)
  assert.deepEqual(kinds, ["reasoning", "tool", "tool-result", "text", "usage"])
  const tool = c.events.find((e) => e.kind === "tool") as Extract<WorkerProgress, { kind: "tool" }>
  assert.equal(tool.name, "bash")
  assert.equal(tool.id, "c1")
  assert.deepEqual(tool.input, { command: "ls" })
})

test("model flag is omitted when spec.model is unset (opencode default resolution)", async () => {
  const h = harness([versionOk, happyRun])
  await h.worker.runAgent(spec(), ctx())
  assert.ok(!h.spawned[1]!.args.includes("--model"))
})

test("instructions are injected as a delimited stdin preamble (no system-prompt flag exists)", async () => {
  const h = harness([versionOk, happyRun])
  await h.worker.runAgent(spec({ instructions: "be terse" }), ctx())
  assert.equal(h.spawned[1]!.proc.stdin.chunks[0], "<instructions>\nbe terse\n</instructions>\n\ndo the thing")
})

test("errored tool parts map to an isError tool-result pair", async () => {
  const h = harness([
    versionOk,
    (p) => {
      p.pushLine({
        type: "tool_use",
        sessionID: "s",
        part: { callID: "c2", tool: "webfetch", state: { status: "error", input: { url: "x" }, error: "boom" } },
      })
      p.pushLine({ type: "text", sessionID: "s", part: { text: "ok" } })
      p.end(0)
    },
  ])
  const c = ctx()
  await h.worker.runAgent(spec(), c)
  const result = c.events.find((e) => e.kind === "tool-result") as Extract<WorkerProgress, { kind: "tool-result" }>
  assert.equal(result.isError, true)
  assert.equal(result.output, "boom")
})

test("an in-stream error event is fatal even when the process exits 0", async () => {
  const h = harness([
    versionOk,
    (p) => {
      p.pushLine({ type: "text", sessionID: "s", part: { text: "partial" } })
      p.pushLine({ type: "error", sessionID: "s", error: { name: "UnknownError", data: { message: "model exploded" } } })
      p.end(0)
    },
  ])
  await assert.rejects(h.worker.runAgent(spec(), ctx()), (err: unknown) => {
    assert.ok(err instanceof AgentError)
    assert.equal(err.code, "provider_error")
    assert.match(err.message, /model exploded/)
    return true
  })
})

test("ProviderAuthError classifies as provider_auth", async () => {
  const h = harness([
    versionOk,
    (p) => {
      p.pushLine({ type: "error", sessionID: "s", error: { name: "ProviderAuthError", data: { message: "no credentials" } } })
      p.end(0)
    },
  ])
  await assert.rejects(h.worker.runAgent(spec(), ctx()), (err: unknown) => {
    assert.ok(err instanceof AgentError)
    assert.equal(err.code, "provider_auth")
    return true
  })
})

test("'database is locked' exit is a RETRYABLE provider_busy (concurrent one-shot contention)", async () => {
  const h = harness([
    versionOk,
    (p) => {
      p.pushStderr("Error: Unexpected error, check log file\ndatabase is locked\n")
      p.end(1)
    },
  ])
  await assert.rejects(h.worker.runAgent(spec(), ctx()), (err: unknown) => {
    assert.ok(err instanceof AgentError)
    assert.equal(err.code, "provider_busy")
    assert.equal(err.retryable, true)
    return true
  })
})

test("exit 0 with no assistant text is no_result; nonzero exit is provider_exit with stderr tail", async () => {
  const h = harness([versionOk, (p) => p.end(0)])
  await assert.rejects(h.worker.runAgent(spec(), ctx()), (err: unknown) => err instanceof AgentError && err.code === "no_result")

  const h2 = harness([
    versionOk,
    (p) => {
      p.pushStderr("fatal: bad model\n")
      p.end(2)
    },
  ])
  await assert.rejects(h2.worker.runAgent(spec(), ctx()), (err: unknown) => {
    assert.ok(err instanceof AgentError)
    assert.equal(err.code, "provider_exit")
    assert.match(err.message, /bad model/)
    return true
  })
})

test("fail-closed pre-spawn rejections: read-only (with remedy), workspace-write, maxTurns, effort, approval", async () => {
  const h = harness([]) // nothing may spawn
  for (const [over, pattern] of [
    [{ sandbox: "read-only" }, /set sandbox: "danger-full-access" to use provider "opencode"/],
    [{ sandbox: "workspace-write" }, /cannot enforce a "workspace-write" sandbox/],
    [{ maxTurns: 5 }, /no enforceable turn cap/],
    [{ effort: "high" }, /does not support effort/],
    [{ approval: "on-request" }, /cannot surface approval requests/],
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

test("version preflight: below-minimum binary is refused with provider_outdated", async () => {
  const h = harness([
    (p) => {
      p.stdout.emit("data", "1.15.0\n")
      p.end(0)
    },
  ])
  await assert.rejects(h.worker.runAgent(spec(), ctx()), (err: unknown) => {
    assert.ok(err instanceof AgentError)
    assert.equal(err.code, "provider_outdated")
    assert.match(err.message, new RegExp(OPENCODE_MIN_VERSION.replace(/\./g, "\\.")))
    return true
  })
  assert.equal(h.spawned.length, 1)
})

test("version preflight runs once per worker instance", async () => {
  const h = harness([versionOk, happyRun, happyRun])
  await h.worker.runAgent(spec(), ctx())
  await h.worker.runAgent(spec(), ctx())
  const versionCalls = h.spawned.filter((s) => s.args[0] === "--version")
  assert.equal(versionCalls.length, 1)
})

test("schema: silent extraction turn reuses the working session; usage sums; structured parses", async () => {
  const h = harness([
    versionOk,
    happyRun, // working turn (sessionID ses_1, usage 112/25/0.01)
    (p) => {
      p.pushLine({ type: "text", sessionID: "ses_1", part: { text: '{"answer": 42}' } })
      p.pushLine({
        type: "step_finish",
        sessionID: "ses_1",
        part: { cost: 0.002, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } },
      })
      p.end(0)
    },
  ])
  const c = ctx()
  const schema = { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] }
  const result = await h.worker.runAgent(spec({ schema, instructions: "be terse" }), c)

  const extraction = h.spawned[2]!
  const si = extraction.args.indexOf("--session")
  assert.ok(si >= 0, "extraction must reuse the working session")
  assert.equal(extraction.args[si + 1], "ses_1")
  // Instructions preamble reaches the extraction turn (the corrective retry path).
  assert.match(extraction.proc.stdin.chunks[0]!, /^<instructions>\nbe terse\n<\/instructions>/)
  assert.match(extraction.proc.stdin.chunks[0]!, /JSON Schema/)

  assert.deepEqual(result.structured, { answer: 42 })
  assert.deepEqual(result.usage, { inputTokens: 122, outputTokens: 30, costUsd: 0.012 })
  // The extraction turn is silent: no text/tool progress after the working turn's events.
  assert.equal(c.events.filter((e) => e.kind === "text").length, 1)
})

test("schema: an unparseable extraction leaves structured undefined (runtime retries)", async () => {
  const h = harness([
    versionOk,
    happyRun,
    (p) => {
      p.pushLine({ type: "text", sessionID: "ses_1", part: { text: "sorry, no JSON here" } })
      p.end(0)
    },
  ])
  const result = await h.worker.runAgent(spec({ schema: { type: "object" } }), ctx())
  assert.equal(result.structured, undefined)
})

test("a pre-aborted signal short-circuits; mid-run abort interrupts", async () => {
  const pre = new AbortController()
  pre.abort()
  const h = harness([])
  await assert.rejects(h.worker.runAgent(spec(), ctx(pre.signal)), AgentInterrupted)
  assert.equal(h.spawned.length, 0)

  const ac = new AbortController()
  const h2 = harness([
    versionOk,
    (p) => {
      p.pushLine({ type: "text", sessionID: "s", part: { text: "working…" } })
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
      p.pushLine({ type: "summary", sessionID: "s", whatever: true })
      p.pushLine({ type: "text", sessionID: "s", part: { text: "ok" } })
      p.end(0)
    },
  ])
  const result = await h.worker.runAgent(spec(), ctx())
  assert.equal(result.text, "ok")
})

test("multiple terminal text parts are separated, not run together", async () => {
  const h = harness([
    versionOk,
    (p) => {
      p.pushLine({ type: "text", sessionID: "s", part: { text: "First block." } })
      p.pushLine({ type: "text", sessionID: "s", part: { text: "Second block." } })
      p.end(0)
    },
  ])
  const result = await h.worker.runAgent(spec(), ctx())
  assert.equal(result.text, "First block.\n\nSecond block.")
})
