import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import type { AgentSpec } from "../src/dsl/types.js"
import { AgentError, AgentInterrupted, type WorkerProgress } from "../src/worker/index.js"
import { SubprocessJsonlWorker } from "../src/worker/subprocess-jsonl.js"

class FakeChild extends EventEmitter {
  readonly stdin = new EventEmitter() as EventEmitter & { end(value?: string): void }
  readonly stdout = new EventEmitter() as EventEmitter & { setEncoding(e: string): void }
  readonly stderr = new EventEmitter() as EventEmitter & { setEncoding(e: string): void }
  killed: Array<string | undefined> = []
  constructor() {
    super()
    ;(this.stdin as any).end = () => {}
    ;(this.stdout as any).setEncoding = () => {}
    ;(this.stderr as any).setEncoding = () => {}
  }
  out(value: unknown): void {
    this.stdout.emit("data", JSON.stringify(value) + "\n")
  }
  raw(value: string): void {
    this.stdout.emit("data", value)
  }
  err(value: string): void {
    this.stderr.emit("data", value)
  }
  exit(code = 0): void {
    this.emit("exit", code, null)
  }
  kill(signal?: string): boolean {
    this.killed.push(signal)
    return true
  }
}

function spec(over: Partial<AgentSpec> = {}): AgentSpec {
  return {
    prompt: "do it",
    provider: "opencode",
    cwd: "/work",
    sandbox: "read-only",
    approval: "never",
    ...over,
  }
}

function ctx(signal?: AbortSignal): { signal: AbortSignal; onProgress: (e: WorkerProgress) => void; events: WorkerProgress[] } {
  const events: WorkerProgress[] = []
  return { signal: signal ?? new AbortController().signal, onProgress: (e) => events.push(e), events }
}

test("SubprocessJsonlWorker buffers JSONL events split across stdout chunks", async () => {
  const child = new FakeChild()
  const worker = new SubprocessJsonlWorker({
    provider: "opencode",
    allowedSandboxes: ["read-only"],
    spawnChild: () => child as any,
    buildTurn: (s, prompt) => ({ command: "tool", args: [], cwd: s.cwd, stdin: prompt }),
  })
  const resultPromise = worker.runSubprocessAgent(spec(), ctx())
  child.raw('{"type":"text","text":"hel')
  child.raw('lo"}\n')
  child.exit()
  assert.equal((await resultPromise).text, "hello")
})

test("SubprocessJsonlWorker treats explicit error events as fatal provider errors", async () => {
  const child = new FakeChild()
  const worker = new SubprocessJsonlWorker({
    provider: "opencode",
    allowedSandboxes: ["read-only"],
    spawnChild: () => child as any,
    buildTurn: (s) => ({ command: "tool", args: [], cwd: s.cwd }),
  })
  const resultPromise = worker.runSubprocessAgent(spec(), ctx())
  child.out({ type: "error", message: "fatal" })
  await assert.rejects(resultPromise, (e) => e instanceof AgentError && e.code === "provider_error" && /fatal/.test(e.message))
  assert.deepEqual(child.killed, [undefined])
})

test("SubprocessJsonlWorker keeps recoverable tool_result error fields non-fatal", async () => {
  const child = new FakeChild()
  const c = ctx()
  const worker = new SubprocessJsonlWorker({
    provider: "opencode",
    allowedSandboxes: ["read-only"],
    spawnChild: () => child as any,
    buildTurn: (s) => ({ command: "tool", args: [], cwd: s.cwd }),
  })
  const resultPromise = worker.runSubprocessAgent(spec(), c)
  child.out({ type: "tool_result", id: "t1", error: "command failed", is_error: true })
  child.out({ type: "text", text: "recovered" })
  child.exit()
  assert.equal((await resultPromise).text, "recovered")
  assert.equal(c.events.some((event) => event.kind === "tool-result" && event.isError === true), true)
})

test("SubprocessJsonlWorker short-circuits an already-aborted signal before spawning", async () => {
  const ac = new AbortController()
  ac.abort()
  let spawned = 0
  const worker = new SubprocessJsonlWorker({
    provider: "opencode",
    allowedSandboxes: ["read-only"],
    spawnChild: () => (spawned++, new FakeChild() as any),
    buildTurn: (s) => ({ command: "tool", args: [], cwd: s.cwd }),
  })
  await assert.rejects(worker.runSubprocessAgent(spec(), ctx(ac.signal)), (e) => e instanceof AgentInterrupted)
  assert.equal(spawned, 0)
})

test("SubprocessJsonlWorker classifies EACCES spawn failures as non-retryable", async () => {
  const worker = new SubprocessJsonlWorker({
    provider: "opencode",
    allowedSandboxes: ["read-only"],
    spawnChild: () => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" })
    },
    buildTurn: (s) => ({ command: "tool", args: [], cwd: s.cwd }),
  })
  await assert.rejects(worker.runSubprocessAgent(spec(), ctx()), (e) => e instanceof AgentError && e.code === "binary_not_executable" && e.retryable === false)
})

test("SubprocessJsonlWorker reports invalid structured extraction JSON with both turns' usage", async () => {
  let turn = 0
  const worker = new SubprocessJsonlWorker({
    provider: "opencode",
    allowedSandboxes: ["read-only"],
    spawnChild: () => {
      turn++
      const child = new FakeChild()
      queueMicrotask(() => {
        if (turn === 1) {
          child.out({ type: "text", text: "count is seven" })
          child.out({ usage: { input_tokens: 1, output_tokens: 2 } })
        } else {
          child.raw("not json\n")
          child.out({ usage: { input_tokens: 3, output_tokens: 4 } })
        }
        child.exit()
      })
      return child as any
    },
    buildTurn: (s) => ({ command: "tool", args: [], cwd: s.cwd }),
  })
  await assert.rejects(
    worker.runSubprocessAgent(spec({ schema: { type: "object", properties: { count: { type: "number" } }, required: ["count"] } }), ctx()),
    (e) => e instanceof AgentError && e.code === "invalid_structured_output" && e.usage?.inputTokens === 4 && e.usage.outputTokens === 6,
  )
})

test("SubprocessJsonlWorker truncates stderr tails on nonzero exit", async () => {
  const child = new FakeChild()
  const worker = new SubprocessJsonlWorker({
    provider: "opencode",
    allowedSandboxes: ["read-only"],
    spawnChild: () => child as any,
    buildTurn: (s) => ({ command: "tool", args: [], cwd: s.cwd }),
  })
  const resultPromise = worker.runSubprocessAgent(spec(), ctx())
  child.err(`start-${"x".repeat(20_000)}-tail`)
  child.exit(2)
  await assert.rejects(resultPromise, (e) => e instanceof AgentError && /-tail/.test(e.message) && !/start-/.test(e.message))
})

test("SubprocessJsonlWorker runs per-turn cleanup after exit", async () => {
  const child = new FakeChild()
  let cleaned = 0
  const worker = new SubprocessJsonlWorker({
    provider: "opencode",
    allowedSandboxes: ["read-only"],
    spawnChild: () => child as any,
    buildTurn: (s) => ({ command: "tool", args: [], cwd: s.cwd, cleanup: () => cleaned++ }),
  })
  const resultPromise = worker.runSubprocessAgent(spec(), ctx())
  child.out({ type: "text", text: "ok" })
  child.exit()
  assert.equal((await resultPromise).text, "ok")
  assert.equal(cleaned, 1)
})
