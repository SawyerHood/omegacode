import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import type { SpawnOptions } from "node:child_process"
import type { AgentSpec } from "../src/dsl/types.js"
import { OpenCodeWorker } from "../src/worker/opencode.js"
import { AgentError, AgentInterrupted, type WorkerProgress } from "../src/worker/index.js"

class FakeChild extends EventEmitter {
  readonly stdin = new EventEmitter() as EventEmitter & { end(value?: string): void }
  readonly stdout = new EventEmitter() as EventEmitter & { setEncoding(e: string): void }
  readonly stderr = new EventEmitter() as EventEmitter & { setEncoding(e: string): void }
  stdinData = ""
  killed = false
  constructor() {
    super()
    ;(this.stdin as any).end = (value?: string) => {
      this.stdinData += value ?? ""
    }
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
  kill(): boolean {
    this.killed = true
    return true
  }
}

function spec(over: Partial<AgentSpec> = {}): AgentSpec {
  return {
    prompt: "do it",
    provider: "opencode",
    cwd: "/work",
    sandbox: "danger-full-access",
    approval: "never",
    ...over,
  }
}

function ctx(signal?: AbortSignal): { signal: AbortSignal; onProgress: (e: WorkerProgress) => void; events: WorkerProgress[] } {
  const events: WorkerProgress[] = []
  return { signal: signal ?? new AbortController().signal, onProgress: (e) => events.push(e), events }
}

test("OpenCodeWorker spawns opencode run with json, dir, model and variant, and sends prompt on stdin", async () => {
  const calls: Array<{ command: string; args: string[]; options: SpawnOptions }> = []
  const children: FakeChild[] = []
  const worker = new OpenCodeWorker({
    bin: "/bin/opencode",
    spawnChild: (command, args, options) => {
      calls.push({ command, args, options })
      const child = new FakeChild()
      children.push(child)
      queueMicrotask(() => {
        child.out({ type: "text", text: "done" })
        child.exit()
      })
      return child as any
    },
  })
  const result = await worker.runAgent(spec({ model: "anthropic/claude", effort: "high" }), ctx())
  assert.equal(result.text, "done")
  assert.equal(calls[0]!.command, "/bin/opencode")
  assert.deepEqual(calls[0]!.args, ["run", "--format", "json", "--dir", "/work", "--model", "anthropic/claude", "--dangerously-skip-permissions", "--variant", "high"])
  assert.equal(calls[0]!.options.cwd, "/work")
  assert.deepEqual(calls[0]!.options.stdio, ["pipe", "pipe", "pipe"])
  assert.equal(children[0]!.stdinData, "do it")
})

test("OpenCodeWorker maps JSONL text, reasoning, tools and usage progress", async () => {
  const child = new FakeChild()
  const c = ctx()
  const worker = new OpenCodeWorker({ spawnChild: () => child as any })
  const p = worker.runAgent(spec(), c)
  child.out({ type: "reasoning", text: "thinking" })
  child.out({ type: "tool_use", id: "t1", name: "Read", input: { path: "README.md" } })
  child.out({ type: "tool_result", tool_use_id: "t1", content: "ok" })
  child.out({ type: "text", text: "hello" })
  child.out({ usage: { input_tokens: 3, output_tokens: 4 } })
  child.exit()
  const result = await p
  assert.equal(result.text, "hello")
  assert.equal(result.usage.inputTokens, 3)
  assert.equal(result.usage.outputTokens, 4)
  assert.deepEqual(c.events.map((e) => e.kind), ["reasoning", "tool", "tool-result", "text", "usage"])
})

test("OpenCodeWorker falls back to plain stdout text", async () => {
  const child = new FakeChild()
  const worker = new OpenCodeWorker({ spawnChild: () => child as any })
  const p = worker.runAgent(spec(), ctx())
  child.raw("plain answer\n")
  child.exit()
  const result = await p
  assert.equal(result.text, "plain answer\n")
})

test("OpenCodeWorker structured output runs a silent extraction turn and validates JSON", async () => {
  const children: FakeChild[] = []
  const worker = new OpenCodeWorker({
    spawnChild: () => {
      const child = new FakeChild()
      children.push(child)
      queueMicrotask(() => {
        if (children.length === 1) {
          child.out({ type: "text", text: "The count is 7." })
          child.out({ usage: { input_tokens: 1, output_tokens: 2 } })
        } else {
          child.raw('{"count":7}\n')
          child.out({ usage: { input_tokens: 3, output_tokens: 4 } })
        }
        child.exit()
      })
      return child as any
    },
  })
  const c = ctx()
  const result = await worker.runAgent(spec({ schema: { type: "object", properties: { count: { type: "number" } }, required: ["count"] } }), c)
  assert.deepEqual(result.structured, { count: 7 })
  assert.equal(result.usage.inputTokens, 4)
  assert.equal(result.usage.outputTokens, 6)
  assert.match(children[1]!.stdinData, /JSON Schema/)
  assert.doesNotMatch(children[1]!.stdinData, /```/)
  assert.deepEqual(c.events.map((e) => e.kind), ["text", "usage"])
})

test("OpenCodeWorker rejects unsupported options and malformed model before spawning", async () => {
  let spawned = 0
  const worker = new OpenCodeWorker({ spawnChild: () => (spawned++, new FakeChild() as any) })
  await assert.rejects(worker.runAgent(spec({ sandbox: "read-only" }), ctx()), (e) => e instanceof AgentError && e.code === "unsupported_option" && /supported sandbox values/.test(e.message))
  await assert.rejects(worker.runAgent(spec({ sandbox: "workspace-write" }), ctx()), (e) => e instanceof AgentError && e.code === "unsupported_option" && /cannot enforce sandbox/.test(e.message))
  await assert.rejects(worker.runAgent(spec({ approval: "on-request" }), ctx()), (e) => e instanceof AgentError && e.code === "unsupported_option" && /approval/.test(e.message))
  await assert.rejects(worker.runAgent(spec({ maxTurns: 2 }), ctx()), (e) => e instanceof AgentError && e.code === "unsupported_option" && /maxTurns/.test(e.message))
  await assert.rejects(worker.runAgent(spec({ model: "claude" }), ctx()), (e) => e instanceof AgentError && e.code === "invalid_model")
  assert.equal(spawned, 0)
})

test("OpenCodeWorker nonzero exit includes stderr tail", async () => {
  const child = new FakeChild()
  const worker = new OpenCodeWorker({ spawnChild: () => child as any })
  const p = worker.runAgent(spec(), ctx())
  child.err("boom\n")
  child.exit(2)
  await assert.rejects(p, (e) => e instanceof AgentError && e.code === "process_exited" && /boom/.test(e.message))
})

test("OpenCodeWorker treats a missing binary as non-retryable", async () => {
  const worker = new OpenCodeWorker({
    spawnChild: () => {
      throw Object.assign(new Error("not found"), { code: "ENOENT" })
    },
  })
  await assert.rejects(worker.runAgent(spec(), ctx()), (e) => e instanceof AgentError && e.code === "binary_not_found" && e.retryable === false)
})

test("OpenCodeWorker abort kills the child and throws AgentInterrupted", async () => {
  const ac = new AbortController()
  const child = new FakeChild()
  const worker = new OpenCodeWorker({ spawnChild: () => child as any })
  const p = worker.runAgent(spec(), ctx(ac.signal))
  ac.abort()
  await assert.rejects(p, (e) => e instanceof AgentInterrupted)
  assert.equal(child.killed, true)
})
