import { after, test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"

import {
  captureStdout,
  exitError,
  parseVersion,
  runJsonlSubprocess,
  versionAtLeast,
  type JsonlRunOpts,
  type SpawnProcess,
} from "../src/worker/subprocess-jsonl.js"
import { AgentError, AgentInterrupted } from "../src/worker/index.js"

// Stall/kill tests await rejections driven by unref'd timers while the only "process" alive is a
// FakeProc with no real handles — keep the loop referenced (same rationale as codex-worker.test.ts).
const keepAlive = setInterval(() => {}, 60_000)
after(() => clearInterval(keepAlive))

// ---------------------------------------------------------------------------
// A scripted fake child satisfying the slice of ChildProcessWithoutNullStreams
// that runJsonlSubprocess touches.
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
  pushRaw(s: string): void {
    this.stdout.emit("data", s)
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

function harness(over: Partial<JsonlRunOpts> = {}): {
  proc: FakeProc
  values: unknown[]
  textLines: string[]
  run: Promise<{ code: number | null; signal: string | null; stderrTail: string }>
  spawned: Array<{ bin: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv }>
} {
  const proc = new FakeProc()
  const values: unknown[] = []
  const textLines: string[] = []
  const spawned: Array<{ bin: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv }> = []
  const spawnProcess: SpawnProcess = (bin, args, opts) => {
    spawned.push({ bin, args, cwd: opts.cwd, env: opts.env })
    return proc as any
  }
  const run = runJsonlSubprocess({
    provider: "pi",
    bin: "pi",
    args: ["--mode", "json"],
    signal: new AbortController().signal,
    onValue: (v) => values.push(v),
    onTextLine: (l) => textLines.push(l),
    stallTimeoutMs: 0,
    spawnProcess,
    ...over,
  })
  return { proc, values, textLines, run, spawned }
}

const tick = () => new Promise((r) => setImmediate(r))

test("parses LF-framed JSON lines, buffers partial lines across chunks", async () => {
  const h = harness()
  await tick()
  h.proc.pushRaw('{"a":1}\n{"b":')
  h.proc.pushRaw('2}\n')
  h.proc.end(0)
  const exit = await h.run
  assert.equal(exit.code, 0)
  assert.deepEqual(h.values, [{ a: 1 }, { b: 2 }])
})

test("delivers multiple lines arriving in one chunk, tolerates blank and \\r-terminated lines", async () => {
  const h = harness()
  await tick()
  h.proc.pushRaw('{"a":1}\r\n\n{"b":2}\n')
  h.proc.end(0)
  await h.run
  assert.deepEqual(h.values, [{ a: 1 }, { b: 2 }])
})

test("non-JSON stdout lines go to onTextLine, never crash the run", async () => {
  const h = harness()
  await tick()
  h.proc.pushRaw("warming up...\n")
  h.proc.pushLine({ ok: true })
  h.proc.end(0)
  await h.run
  assert.deepEqual(h.textLines, ["warming up..."])
  assert.deepEqual(h.values, [{ ok: true }])
})

test("a final un-terminated line is flushed at close", async () => {
  const h = harness()
  await tick()
  h.proc.pushRaw('{"last":true}') // no trailing newline
  h.proc.end(0)
  await h.run
  assert.deepEqual(h.values, [{ last: true }])
})

test("prompt is written to stdin and stdin is closed (also closed with no prompt)", async () => {
  const h = harness({ stdin: "do the thing" })
  await tick()
  assert.deepEqual(h.proc.stdin.chunks, ["do the thing"])
  assert.equal(h.proc.stdin.ended, true)
  h.proc.end(0)
  await h.run

  const h2 = harness()
  await tick()
  assert.deepEqual(h2.proc.stdin.chunks, [])
  assert.equal(h2.proc.stdin.ended, true)
  h2.proc.end(0)
  await h2.run
})

test("nonzero exit resolves (worker decides) and exitError carries the stderr tail", async () => {
  const h = harness()
  await tick()
  h.proc.pushStderr("fatal: model not found\n")
  h.proc.end(1)
  const exit = await h.run
  assert.equal(exit.code, 1)
  assert.match(exit.stderrTail, /model not found/)
  const err = exitError("pi", "pi", exit)
  assert.equal(err.code, "provider_exit")
  assert.equal(err.retryable, false)
  assert.match(err.message, /code 1/)
  assert.match(err.message, /model not found/)
})

test("stderr is a bounded ring buffer (keeps the tail)", async () => {
  const h = harness({ stderrLimit: 32 })
  await tick()
  h.proc.pushStderr("x".repeat(100) + "THE-END")
  h.proc.end(1)
  const exit = await h.run
  assert.ok(exit.stderrTail.length <= 32)
  assert.match(exit.stderrTail, /THE-END$/)
})

test("stall watchdog kills the child and rejects with retryable turn_stalled", async () => {
  const h = harness({ stallTimeoutMs: 30, killGraceMs: 10 })
  await assert.rejects(h.run, (err: unknown) => {
    assert.ok(err instanceof AgentError)
    assert.equal(err.code, "turn_stalled")
    assert.equal(err.retryable, true)
    return true
  })
  assert.deepEqual(h.proc.kills, ["SIGTERM"])
  // SIGKILL escalation fires after the grace window even though the run already settled.
  await new Promise((r) => setTimeout(r, 30))
  assert.deepEqual(h.proc.kills, ["SIGTERM", "SIGKILL"])
})

test("stdout activity re-arms the stall watchdog", async () => {
  const h = harness({ stallTimeoutMs: 60 })
  await tick()
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 30))
    h.proc.pushLine({ beat: i })
  }
  h.proc.end(0)
  const exit = await h.run
  assert.equal(exit.code, 0)
  assert.equal(h.values.length, 4)
})

test("abort SIGTERMs the child and rejects AgentInterrupted; SIGKILL follows after grace", async () => {
  const ac = new AbortController()
  const h = harness({ signal: ac.signal, killGraceMs: 10 })
  await tick()
  ac.abort()
  await assert.rejects(h.run, AgentInterrupted)
  assert.deepEqual(h.proc.kills, ["SIGTERM"])
  await new Promise((r) => setTimeout(r, 30))
  assert.deepEqual(h.proc.kills, ["SIGTERM", "SIGKILL"])
})

test("a pre-aborted signal short-circuits before spawn", async () => {
  const ac = new AbortController()
  ac.abort()
  const h = harness({ signal: ac.signal })
  await assert.rejects(h.run, AgentInterrupted)
  assert.equal(h.spawned.length, 0)
})

test("sync spawn throw with ENOENT classifies as non-retryable binary_not_found", async () => {
  const run = runJsonlSubprocess({
    provider: "opencode",
    bin: "opencode",
    args: [],
    signal: new AbortController().signal,
    onValue: () => {},
    spawnProcess: () => {
      throw Object.assign(new Error("spawn opencode ENOENT"), { code: "ENOENT" })
    },
  })
  await assert.rejects(run, (err: unknown) => {
    assert.ok(err instanceof AgentError)
    assert.equal(err.code, "binary_not_found")
    assert.equal(err.retryable, false)
    assert.match(err.message, /installed and on PATH/)
    return true
  })
})

test("async ENOENT 'error' event classifies the same way", async () => {
  const h = harness()
  await tick()
  h.proc.emit("error", new Error("spawn pi ENOENT"))
  await assert.rejects(h.run, (err: unknown) => {
    assert.ok(err instanceof AgentError)
    assert.equal(err.code, "binary_not_found")
    return true
  })
})

test("non-ENOENT spawn errors are retryable spawn_failed", async () => {
  const h = harness()
  await tick()
  h.proc.emit("error", new Error("EAGAIN: resource temporarily unavailable"))
  await assert.rejects(h.run, (err: unknown) => {
    assert.ok(err instanceof AgentError)
    assert.equal(err.code, "spawn_failed")
    assert.equal(err.retryable, true)
    return true
  })
})

test("a throwing onValue fails the run with that error instead of crashing the process", async () => {
  const h = harness({
    onValue: () => {
      throw new Error("worker bug")
    },
  })
  await tick()
  h.proc.pushLine({ a: 1 })
  await assert.rejects(h.run, /worker bug/)
  assert.deepEqual(h.proc.kills, ["SIGTERM"])
})

test("captureStdout returns trimmed stdout on exit 0 and throws on nonzero exit", async () => {
  const mk = (script: (p: FakeProc) => void): SpawnProcess => {
    return () => {
      const proc = new FakeProc()
      queueMicrotask(() => script(proc))
      return proc as any
    }
  }
  const out = await captureStdout({
    provider: "pi",
    bin: "pi",
    args: ["--version"],
    spawnProcess: mk((p) => {
      p.pushRaw("0.79.1\n")
      p.end(0)
    }),
  })
  assert.equal(out, "0.79.1")

  await assert.rejects(
    captureStdout({
      provider: "pi",
      bin: "pi",
      args: ["--version"],
      spawnProcess: mk((p) => p.end(2)),
    }),
    (err: unknown) => err instanceof AgentError && err.code === "provider_exit",
  )
})

test("parseVersion / versionAtLeast handle real version strings", () => {
  assert.deepEqual(parseVersion("0.79.1"), [0, 79, 1])
  assert.deepEqual(parseVersion("opencode 1.16.2 (build abc)"), [1, 16, 2])
  assert.deepEqual(parseVersion("v2.0"), [2, 0, 0])
  assert.equal(parseVersion("nope"), undefined)

  assert.equal(versionAtLeast("0.79.1", "0.79.1"), true)
  assert.equal(versionAtLeast("0.80.0", "0.79.1"), true)
  assert.equal(versionAtLeast("1.0.0", "0.79.1"), true)
  assert.equal(versionAtLeast("0.54.0", "0.79.1"), false)
  assert.equal(versionAtLeast("0.79.0", "0.79.1"), false)
  assert.equal(versionAtLeast("garbage", "0.79.1"), false)
})
