import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { readFileSync } from "node:fs"

import { MuseWorker, MUSE_MIN_VERSION } from "../src/worker/muse.js"
import { AgentError, type WorkerProgress } from "../src/worker/index.js"
import type { SpawnProcess } from "../src/worker/subprocess-jsonl.js"
import type { AgentSpec, Effort } from "../src/dsl/types.js"

// ---------------------------------------------------------------------------
// Scripted spawn harness (same shape as the opencode/pi worker tests): each spawn
// pops the next script off a queue and drives the fake child after wiring.
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
  p.stdout.emit("data", "Muse Code 1.4.4 (1.4.4-R5419.1)\n")
  p.end(0)
}

const versionOld: Script = (p) => {
  p.stdout.emit("data", "Muse Code 1.4.0\n")
  p.end(0)
}

function harness(scripts: Script[]): { worker: MuseWorker; spawned: SpawnCall[] } {
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
  return { worker: new MuseWorker({ spawnProcess }), spawned }
}

function ctx(signal?: AbortSignal): { signal: AbortSignal; onProgress: (e: WorkerProgress) => void; events: WorkerProgress[] } {
  const events: WorkerProgress[] = []
  return { signal: signal ?? new AbortController().signal, onProgress: (e) => events.push(e), events }
}

function spec(over: Partial<AgentSpec> = {}): AgentSpec {
  return {
    prompt: "do the thing",
    provider: "muse",
    model: "muse-spark-1.3-contributor",
    cwd: "/work/repo",
    sandbox: "danger-full-access",
    approval: "never",
    ...over,
  }
}

/** Minimal MSP envelope around a payload. */
function msp(payload_type: string, payload: unknown): Record<string, unknown> {
  return {
    schema_version: 1,
    id: "evt-1",
    stream: { kind: "session", id: "ses_1" },
    sequence: 1,
    recorded_at: 1,
    record_type: "reconciliation",
    causation_id: "c",
    payload_type,
    payload_schema_version: 1,
    payload,
  }
}

const happyRun: Script = (p) => {
  p.pushLine(msp("run.output.delta", { kind: "run_output_delta", text: "Hello " }))
  p.pushLine(msp("run.output.delta", { kind: "run_output_delta", text: "world" }))
  p.pushLine(msp("run.terminal.completed", { kind: "run_terminal", terminal: "completed", reason: null, text: "Hello world" }))
  p.end(0)
}

function readArgFile(call: SpawnCall, flag: string): string {
  const i = call.args.indexOf(flag)
  assert.ok(i >= 0, `expected ${flag} in argv`)
  return readFileSync(call.args[i + 1]!, "utf8")
}

// ---------------------------------------------------------------------------

test("happy path: argv shape, terminal text wins, zero usage", async () => {
  const h = harness([versionOk, happyRun])
  const c = ctx()
  const result = await h.worker.runAgent(spec({ effort: "xhigh" }), c)

  assert.equal(h.spawned.length, 2)
  assert.deepEqual(h.spawned[0]!.args, ["--version"])
  const args = h.spawned[1]!.args
  assert.deepEqual(args.slice(0, 7), [
    "exec",
    "--json",
    "--user-input-auto-resolve",
    "--model",
    "muse-spark-1.3-contributor",
    "--reasoning-effort",
    "xhigh",
  ])
  assert.ok(args.includes("--yolo")) // danger-full-access
  assert.equal(h.spawned[1]!.cwd, "/work/repo")

  assert.equal(result.text, "Hello world")
  assert.equal(result.status, "completed")
  assert.deepEqual(result.usage, { inputTokens: 0, outputTokens: 0, costUsd: 0 }) // no telemetry
  assert.deepEqual(
    c.events.map((e) => e.kind),
    ["text", "text"],
  )
})

test("prompt travels via --prompt-file (stdin is reserved for --api-key-stdin)", async () => {
  let prompt = ""
  const h = harness([
    versionOk,
    (p, call) => {
      prompt = readArgFile(call, "--prompt-file")
      happyRun(p, call)
    },
  ])
  await h.worker.runAgent(spec(), ctx())
  assert.equal(prompt, "do the thing")
})

test("effort passes through verbatim across all eight levels (ultra included)", async () => {
  const levels: Effort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]
  for (const effort of levels) {
    const h = harness([versionOk, happyRun])
    await h.worker.runAgent(spec({ effort }), ctx())
    const args = h.spawned[1]!.args
    assert.deepEqual(
      [args[args.indexOf("--reasoning-effort")], args[args.indexOf("--reasoning-effort") + 1]],
      ["--reasoning-effort", effort],
      `effort=${effort}`,
    )
  }
})

test("sandbox maps to first-party confinement flags", async () => {
  const ro = harness([versionOk, happyRun])
  await ro.worker.runAgent(spec({ sandbox: "read-only" }), ctx())
  const roArgs = ro.spawned[1]!.args
  assert.ok(roArgs.includes("--disable-write"))
  assert.ok(roArgs.includes("--disable-shell"))
  assert.ok(!roArgs.includes("--yolo"))

  const ww = harness([versionOk, happyRun])
  await ww.worker.runAgent(spec({ sandbox: "workspace-write" }), ctx())
  const wwArgs = ww.spawned[1]!.args
  assert.deepEqual(
    [wwArgs[wwArgs.indexOf("--workspace")], wwArgs[wwArgs.indexOf("--workspace") + 1]],
    ["--workspace", "/work/repo"],
  )
  assert.ok(!wwArgs.includes("--yolo"))
})

test("cwd inside TMPDIR fails closed with an actionable message (host refuses to start)", async () => {
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const h = harness([versionOk])
  await assert.rejects(h.worker.runAgent(spec({ cwd: join(tmpdir(), "ws") }), ctx()), /cannot run with cwd inside TMPDIR/)
  assert.equal(h.spawned.length, 0)
})

test("approval on-request and missing model fail closed before spawn", async () => {
  const h1 = harness([versionOk])
  await assert.rejects(h1.worker.runAgent(spec({ approval: "on-request" }), ctx()), /approval: "never"/)
  assert.equal(h1.spawned.length, 0)

  const h2 = harness([versionOk])
  await assert.rejects(
    h2.worker.runAgent(spec({ model: undefined }), ctx()),
    /requires an explicit model/,
  )
  assert.equal(h2.spawned.length, 0)
})

test("schema: --output-schema flag, file content, structured parse of terminal JSON", async () => {
  const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false }
  const h = harness([
    versionOk,
    (p) => {
      p.pushLine(msp("run.terminal.completed", { kind: "run_terminal", terminal: "completed", reason: null, text: '{"ok": true}' }))
      p.end(0)
    },
  ])
  const result = await h.worker.runAgent(spec({ schema }), ctx())
  const args = h.spawned[1]!.args
  const i = args.indexOf("--output-schema")
  assert.ok(i >= 0)
  assert.deepEqual(result.structured, { ok: true })
})

test("--output-schema file carries the exact schema", async () => {
  const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false }
  let body = ""
  const h = harness([
    versionOk,
    (p, call) => {
      body = readArgFile(call, "--output-schema")
      p.pushLine(msp("run.terminal.completed", { kind: "run_terminal", terminal: "completed", reason: null, text: '{"ok": true}' }))
      p.end(0)
    },
  ])
  await h.worker.runAgent(spec({ schema }), ctx())
  assert.deepEqual(JSON.parse(body), schema)
})

test("maxTurns maps to --max-model-steps (native cap)", async () => {
  const h = harness([versionOk, happyRun])
  await h.worker.runAgent(spec({ maxTurns: 5 }), ctx())
  const args = h.spawned[1]!.args
  assert.deepEqual(
    [args[args.indexOf("--max-model-steps")], args[args.indexOf("--max-model-steps") + 1]],
    ["--max-model-steps", "5"],
  )
})

test("instructions travel as a delimited prompt-file preamble", async () => {
  let prompt = ""
  const h = harness([
    versionOk,
    (p, call) => {
      prompt = readArgFile(call, "--prompt-file")
      happyRun(p, call)
    },
  ])
  await h.worker.runAgent(spec({ instructions: "be terse" }), ctx())
  assert.equal(prompt, "<instructions>\nbe terse\n</instructions>\n\ndo the thing")
})

test("run.terminal.failed rejects with the run reason", async () => {
  const h = harness([
    versionOk,
    (p) => {
      p.pushLine(msp("run.terminal.failed", { kind: "run_terminal", terminal: "failed", reason: "boom", text: "" }))
      p.end(1)
    },
  ])
  await assert.rejects(h.worker.runAgent(spec(), ctx()), /boom/)
})

test("exit 0 with no terminal event is no_result (exit codes are untrusted)", async () => {
  const h = harness([
    versionOk,
    (p) => {
      p.pushLine(msp("run.output.delta", { kind: "run_output_delta", text: "orphan" }))
      p.end(0)
    },
  ])
  await assert.rejects(h.worker.runAgent(spec(), ctx()), (err: unknown) => {
    assert.ok(err instanceof AgentError)
    assert.equal(err.code, "no_result")
    return true
  })
})

test("empty terminal text falls back to accumulated deltas", async () => {
  const h = harness([
    versionOk,
    (p) => {
      p.pushLine(msp("run.output.delta", { kind: "run_output_delta", text: "via-deltas" }))
      p.pushLine(msp("run.terminal.completed", { kind: "run_terminal", terminal: "completed", reason: null, text: "" }))
      p.end(0)
    },
  ])
  const result = await h.worker.runAgent(spec(), ctx())
  assert.equal(result.text, "via-deltas")
})

test("outdated binary refused with upgrade hint; full --version string parses", async () => {
  const h = harness([
    (p) => {
      p.stdout.emit("data", "Muse Code 1.4.4 (1.4.4-R5419.1)\n")
      p.end(0)
    },
    happyRun,
  ])
  const result = await h.worker.runAgent(spec(), ctx())
  assert.equal(result.text, "Hello world")

  const old = harness([versionOld, happyRun])
  await assert.rejects(old.worker.runAgent(spec(), ctx()), /below the minimum supported 1\.4\.1/)
  assert.ok(old.spawned.length === 1 && old.spawned[0]!.args[0] === "--version")
  assert.equal(MUSE_MIN_VERSION, "1.4.1")
})
