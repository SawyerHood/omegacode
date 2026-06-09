import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import type { SpawnOptions } from "node:child_process"
import type { AgentSpec } from "../src/dsl/types.js"
import { PiWorker } from "../src/worker/pi.js"
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
    provider: "pi",
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

test("PiWorker spawns pi json print command with provider, model, thinking and instructions, and sends prompt on stdin", async () => {
  const calls: Array<{ command: string; args: string[]; options: SpawnOptions }> = []
  const children: FakeChild[] = []
  const worker = new PiWorker({
    bin: "/bin/pi",
    provider: "anthropic",
    model: "default-model",
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
  const result = await worker.runAgent(spec({ model: "override-model", effort: "max", instructions: "be terse" }), ctx())
  assert.equal(result.text, "done")
  assert.equal(calls[0]!.command, "/bin/pi")
  assert.deepEqual(calls[0]!.args.slice(0, 9), [
    "--mode", "json",
    "--print",
    "--no-session",
    "--no-approve",
    "--session-dir", calls[0]!.args[6]!,
    "--tools", "read,grep,find,ls",
  ])
  assert.equal(calls[0]!.args.includes("--no-tools"), false)
  assert.deepEqual(calls[0]!.args.slice(9, 15), ["--provider", "anthropic", "--model", "override-model", "--thinking", "xhigh"])
  assert.equal(calls[0]!.args[15], "--append-system-prompt")
  assert.match(calls[0]!.args[16]!, /Target workspace root: \/work/)
  assert.match(calls[0]!.args[16]!, /be terse/)
  assert.notEqual(calls[0]!.options.cwd, "/work")
  assert.match(String(calls[0]!.options.cwd), /omegacode-pi-/)
  assert.match(String(calls[0]!.options.env?.PI_CODING_AGENT_DIR), /omegacode-pi-/)
  assert.match(String(calls[0]!.options.env?.PI_CODING_AGENT_SESSION_DIR), /omegacode-pi-/)
  assert.deepEqual(calls[0]!.options.stdio, ["pipe", "pipe", "pipe"])
  assert.equal(children[0]!.stdinData, "do it")
})

test("PiWorker maps JSONL assistant text, thinking and usage progress", async () => {
  const child = new FakeChild()
  const c = ctx()
  const worker = new PiWorker({ spawnChild: () => child as any })
  const p = worker.runAgent(spec(), c)
  child.out({ type: "message_delta", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "hello" }] })
  child.out({ type: "agent_end", usage: { input: 5, output: 6, cacheRead: 2, cacheWrite: 3, cost: { total: 0.12 } } })
  child.exit()
  const result = await p
  assert.equal(result.text, "hello")
  assert.equal(result.usage.inputTokens, 10)
  assert.equal(result.usage.outputTokens, 6)
  assert.equal(result.usage.costUsd, 0.12)
  assert.deepEqual(c.events.map((e) => e.kind), ["reasoning", "text", "usage"])
})

test("PiWorker falls back to stdout text and maps none effort to off", async () => {
  const calls: string[][] = []
  const worker = new PiWorker({
    spawnChild: (_command, args) => {
      calls.push(args)
      const child = new FakeChild()
      queueMicrotask(() => {
        child.raw("plain\n")
        child.exit()
      })
      return child as any
    },
  })
  const result = await worker.runAgent(spec({ effort: "none" }), ctx())
  assert.equal(result.text, "plain\n")
  assert.ok(calls[0]!.includes("--thinking"))
  assert.ok(calls[0]!.includes("off"))
})

test("PiWorker structured output runs a silent extraction turn and validates JSON", async () => {
  let turn = 0
  const worker = new PiWorker({
    spawnChild: () => {
      const child = new FakeChild()
      turn++
      queueMicrotask(() => {
        if (turn === 1) {
          child.out({ type: "text", text: "name: Ada" })
          child.out({ usage: { input_tokens: 2, output_tokens: 3 } })
        } else {
          child.raw('{"name":"Ada"}\n')
          child.out({ usage: { input_tokens: 4, output_tokens: 5 } })
        }
        child.exit()
      })
      return child as any
    },
  })
  const result = await worker.runAgent(spec({ schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } }), ctx())
  assert.deepEqual(result.structured, { name: "Ada" })
  assert.equal(result.usage.inputTokens, 6)
  assert.equal(result.usage.outputTokens, 8)
})

test("PiWorker accepts read-only subprocess mode with read/search tools and rejects unsupported options before spawning", async () => {
  const readOnly = new FakeChild()
  const workerOk = new PiWorker({ spawnChild: () => readOnly as any })
  const p = workerOk.runAgent(spec({ sandbox: "read-only" }), ctx())
  readOnly.out({ type: "text", text: "safe" })
  readOnly.exit()
  assert.equal((await p).text, "safe")

  let spawned = 0
  const worker = new PiWorker({ spawnChild: () => (spawned++, new FakeChild() as any) })
  await assert.rejects(worker.runAgent(spec({ sandbox: "workspace-write" }), ctx()), (e) => e instanceof AgentError && e.code === "unsupported_option" && /cannot enforce sandbox/.test(e.message))
  await assert.rejects(worker.runAgent(spec({ sandbox: "danger-full-access" }), ctx()), (e) => e instanceof AgentError && e.code === "unsupported_option" && /cannot enforce sandbox/.test(e.message))
  await assert.rejects(worker.runAgent(spec({ approval: "on-request" }), ctx()), (e) => e instanceof AgentError && e.code === "unsupported_option" && /approval/.test(e.message))
  await assert.rejects(worker.runAgent(spec({ maxTurns: 2 }), ctx()), (e) => e instanceof AgentError && e.code === "unsupported_option" && /maxTurns/.test(e.message))
  assert.equal(spawned, 0)
})

test("PiWorker treats a missing binary as non-retryable", async () => {
  const worker = new PiWorker({
    spawnChild: () => {
      throw Object.assign(new Error("not found"), { code: "ENOENT" })
    },
  })
  await assert.rejects(worker.runAgent(spec(), ctx()), (e) => e instanceof AgentError && e.code === "binary_not_found" && e.retryable === false)
})

test("PiWorker nonzero exit and abort paths settle correctly", async () => {
  const failed = new FakeChild()
  const worker1 = new PiWorker({ spawnChild: () => failed as any })
  const p1 = worker1.runAgent(spec(), ctx())
  failed.err("bad\n")
  failed.exit(1)
  await assert.rejects(p1, (e) => e instanceof AgentError && e.code === "process_exited" && /bad/.test(e.message))

  const ac = new AbortController()
  const aborted = new FakeChild()
  const worker2 = new PiWorker({ spawnChild: () => aborted as any })
  const p2 = worker2.runAgent(spec(), ctx(ac.signal))
  ac.abort()
  await assert.rejects(p2, (e) => e instanceof AgentInterrupted)
  assert.equal(aborted.killed, true)
})
