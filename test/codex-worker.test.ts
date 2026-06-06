import { after, test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { existsSync } from "node:fs"

import { CodexWorker, DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_TURN_STALL_TIMEOUT_MS } from "../src/worker/codex.js"
import { JsonRpcStdioClient, StdioTransportError, JsonRpcResponseError } from "../src/worker/jsonrpc-stdio.js"
import { AgentError, AgentInterrupted, type WorkerProgress } from "../src/worker/index.js"
import type { AgentSpec } from "../src/dsl/types.js"

// Several tests await rejections driven by UNREF'D timers (the request timeout, the stall
// watchdog) while the only "process" alive is a FakeChild with no real handles — so nothing
// keeps the event loop referenced. node:test on Node 20/22 then drains the loop mid-await and
// cancels the rest of the file ("Promise resolution is still pending but the event loop has
// already resolved"); Node 24+ pins the loop itself. A ref'd keep-alive makes the file behave
// identically on every supported Node line. (In production the spawned codex child's stdio
// keeps the loop alive, which is exactly why those timers unref.)
const keepAlive = setInterval(() => {}, 60_000)
after(() => clearInterval(keepAlive))

// ---------------------------------------------------------------------------
// A scripted fake child process satisfying the slice of ChildProcessWithoutNullStreams
// that JsonRpcStdioClient touches. Tests drive it: observe the client's writes
// via `onWrite`, and reply by pushing stdout lines or emitting error/exit.
// ---------------------------------------------------------------------------

interface FakeStdin {
  writable: boolean
  write(chunk: string, cb?: (err?: Error | null) => void): boolean
}

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter() as EventEmitter & { setEncoding(e: string): void }
  readonly stderr = new EventEmitter() as EventEmitter & { setEncoding(e: string): void }
  readonly stdin: FakeStdin
  writes: string[] = []
  killed = false
  /** Reply callback: called with each parsed JSON object the client writes. */
  onWrite?: (obj: any) => void
  /** Make the next write report this error to its callback. */
  failNextWrite: Error | null = null

  constructor() {
    super()
    ;(this.stdout as any).setEncoding = () => {}
    ;(this.stderr as any).setEncoding = () => {}
    const self = this
    this.stdin = {
      writable: true,
      write(chunk: string, cb?: (err?: Error | null) => void): boolean {
        self.writes.push(chunk)
        const err = self.failNextWrite
        self.failNextWrite = null
        if (cb) queueMicrotask(() => cb(err))
        if (!err) {
          for (const line of chunk.split("\n")) {
            const t = line.trim()
            if (!t) continue
            try {
              self.onWrite?.(JSON.parse(t))
            } catch {
              // ignore non-JSON
            }
          }
        }
        return true
      },
    }
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
  emitExit(code: number | null, signal: string | null = null): void {
    this.emit("exit", code, signal)
  }
  emitError(err: Error): void {
    this.emit("error", err)
  }
  kill(): boolean {
    this.killed = true
    return true
  }
}

/** What the live codex-cli 0.137.0 initialize result looks like (abridged). */
const TEST_UA = "codex/0.0.0-test (fake)"
const INIT_OK = { userAgent: TEST_UA }

function ctx(signal?: AbortSignal): { signal: AbortSignal; onProgress: (e: WorkerProgress) => void; events: WorkerProgress[] } {
  const events: WorkerProgress[] = []
  return {
    signal: signal ?? new AbortController().signal,
    onProgress: (e) => events.push(e),
    events,
  }
}

function spec(over: Partial<AgentSpec> = {}): AgentSpec {
  return {
    prompt: "do the thing",
    provider: "codex",
    cwd: "/tmp/work",
    sandbox: "read-only",
    approval: "never",
    ...over,
  }
}

// ===========================================================================
// JsonRpcStdioClient — transport invariants (H1, M1, M2)
// ===========================================================================

test("JsonRpcStdioClient: request resolves on matching response", async () => {
  const child = new FakeChild()
  const client = new JsonRpcStdioClient({ spawnChild: () => child as any })
  client.start()
  child.onWrite = (req) => child.pushLine({ jsonrpc: "2.0", id: req.id, result: { ok: 1 } })
  const r = await client.request("ping")
  assert.deepEqual(r, { ok: 1 })
})

test("JsonRpcStdioClient: response error → JsonRpcResponseError", async () => {
  const child = new FakeChild()
  const client = new JsonRpcStdioClient({ spawnChild: () => child as any })
  client.start()
  child.onWrite = (req) => child.pushLine({ jsonrpc: "2.0", id: req.id, error: { code: -1, message: "nope" } })
  await assert.rejects(client.request("ping"), (e) => e instanceof JsonRpcResponseError && e.message === "nope")
})

test("H1/M1: process exit rejects all pending requests and resets buffer", async () => {
  const child = new FakeChild()
  let gone: StdioTransportError | undefined
  const client = new JsonRpcStdioClient({ spawnChild: () => child as any, onProcessGone: (e) => (gone = e) })
  client.start()
  // Feed a partial frame so stdoutBuf is non-empty, then kill the process.
  child.pushRaw('{"partial": ')
  const p1 = client.request("a")
  const p2 = client.request("b")
  child.emitExit(1, null)
  await assert.rejects(p1, (e) => e instanceof StdioTransportError && e.code === "process_exited")
  await assert.rejects(p2, (e) => e instanceof StdioTransportError)
  assert.ok(gone)
  // After death the client is not alive and send() fails fast (no silent drop).
  assert.equal(client.alive, false)
  assert.throws(() => client.send("x"), (e) => e instanceof StdioTransportError && e.code === "not_writable")
  // request() after death rejects immediately rather than hanging.
  await assert.rejects(client.request("c"), (e) => e instanceof StdioTransportError)
})

test("H1: send() throws when stdin is not writable (no silent drop)", () => {
  const child = new FakeChild()
  const client = new JsonRpcStdioClient({ spawnChild: () => child as any })
  client.start()
  child.stdin.writable = false
  assert.throws(() => client.send("x"), (e) => e instanceof StdioTransportError && e.code === "not_writable")
})

test("H1: a failed write surfaces as process-gone, not a silent drop", async () => {
  const child = new FakeChild()
  let gone = false
  const client = new JsonRpcStdioClient({ spawnChild: () => child as any, onProcessGone: () => (gone = true) })
  client.start()
  child.failNextWrite = new Error("EPIPE")
  const p = client.request("x")
  await assert.rejects(p, (e) => e instanceof StdioTransportError)
  assert.equal(gone, true)
})

test("M2: stderr is drained into a bounded ring buffer", () => {
  const child = new FakeChild()
  const client = new JsonRpcStdioClient({ spawnChild: () => child as any, stderrLimit: 10 })
  client.start()
  child.pushStderr("0123456789ABCDEF")
  // only the last 10 bytes retained
  assert.equal(client.stderr(), "6789ABCDEF")
})

test("M2: exit error message includes recent stderr tail", async () => {
  const child = new FakeChild()
  const client = new JsonRpcStdioClient({ spawnChild: () => child as any })
  client.start()
  child.pushStderr("panic: boom\n")
  const p = client.request("x")
  child.emitExit(101)
  const err = await p.catch((e) => e)
  assert.ok(err instanceof StdioTransportError)
  assert.match(err.message, /panic: boom/)
})

test("M30: request timeout rejects a wedged request", async () => {
  const child = new FakeChild()
  const client = new JsonRpcStdioClient({ spawnChild: () => child as any, requestTimeoutMs: 30 })
  client.start()
  child.onWrite = () => {} // never reply
  await assert.rejects(client.request("hang"), (e) => e instanceof StdioTransportError && e.code === "request_timeout")
})

test("JsonRpcStdioClient: shutdown rejects pending and kills child (idempotent)", async () => {
  const child = new FakeChild()
  const client = new JsonRpcStdioClient({ spawnChild: () => child as any })
  client.start()
  const p = client.request("x")
  client.shutdown()
  await assert.rejects(p, (e) => e instanceof StdioTransportError && e.code === "shutdown")
  assert.equal(child.killed, true)
  client.shutdown() // no throw
})

test("stdout flushed AFTER process death is not dispatched (no crash, no stale frames)", () => {
  const child = new FakeChild()
  const notes: string[] = []
  const reqs: string[] = []
  const client = new JsonRpcStdioClient({
    spawnChild: () => child as any,
    onNotification: (m) => notes.push(m),
    onServerRequest: (_id, m) => reqs.push(m),
  })
  client.start()
  child.emitExit(1, null)
  // A dying child can flush buffered stdout after 'exit'; replying to this
  // request would throw inside the stream handler on the old code.
  child.pushLine({ jsonrpc: "2.0", id: 1, method: "item/commandExecution/requestApproval", params: { threadId: "t" } })
  child.pushLine({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "t" } })
  assert.deepEqual(reqs, [])
  assert.deepEqual(notes, [])
})

test("JsonRpcStdioClient: dispatches notifications and server requests", () => {
  const child = new FakeChild()
  const notes: Array<[string, unknown]> = []
  const reqs: Array<[unknown, string]> = []
  const client = new JsonRpcStdioClient({
    spawnChild: () => child as any,
    onNotification: (m, p) => notes.push([m, p]),
    onServerRequest: (id, m) => reqs.push([id, m]),
  })
  client.start()
  child.pushLine({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "t" } })
  child.pushLine({ jsonrpc: "2.0", id: 9, method: "item/fileChange/requestApproval", params: {} })
  assert.deepEqual(notes, [["turn/completed", { threadId: "t" }]])
  assert.deepEqual(reqs, [[9, "item/fileChange/requestApproval"]])
})

// ===========================================================================
// CodexWorker — happy path
// ===========================================================================

// Helper that attaches the scripted server BEFORE the worker spawns, by
// intercepting spawnChild. Avoids the attach-after-spawn race.
function makeServedWorker(
  turnScript: (req: any, reply: (obj: unknown) => void, turnIndex: number) => void,
  opts: { requestTimeoutMs?: number; turnStallTimeoutMs?: number; threadId?: string; initResult?: unknown; onServerReq?: (child: FakeChild, req: any) => void } = {},
): { worker: CodexWorker; getChild: () => FakeChild } {
  let child!: FakeChild
  let turnIndex = 0
  const worker = new CodexWorker({
    requestTimeoutMs: opts.requestTimeoutMs,
    turnStallTimeoutMs: opts.turnStallTimeoutMs,
    spawnChild: () => {
      child = new FakeChild()
      const threadId = opts.threadId ?? "thread-1"
      child.onWrite = (req: any) => {
        if (req.method === "initialize") return child.pushLine({ jsonrpc: "2.0", id: req.id, result: opts.initResult ?? INIT_OK })
        if (req.method === "initialized") return
        if (req.method === "thread/start") return child.pushLine({ jsonrpc: "2.0", id: req.id, result: { thread: { id: threadId } } })
        if (req.method === "turn/interrupt") return child.pushLine({ jsonrpc: "2.0", id: req.id, result: {} })
        if (req.method === "turn/start") {
          child.pushLine({ jsonrpc: "2.0", id: req.id, result: {} })
          const idx = turnIndex++
          turnScript(req, (obj) => child.pushLine(obj), idx)
          return
        }
      }
      return child as unknown as import("node:child_process").ChildProcessWithoutNullStreams
    },
  })
  return { worker, getChild: () => child }
}

function tick(): Promise<void> {
  return new Promise((r) => setImmediate(r))
}

test("runAgent happy path (served before spawn): resolves with usage", async () => {
  const { worker } = makeServedWorker((_req, reply) => {
    reply({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-1", item: { type: "agentMessage", text: "done" } } })
    reply({
      jsonrpc: "2.0",
      method: "thread/tokenUsage/updated",
      params: { threadId: "thread-1", tokenUsage: { total: { inputTokens: 50, outputTokens: 10 }, last: { inputTokens: 50, outputTokens: 10 } } },
    })
    reply({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } })
  })
  const res = await worker.runAgent(spec(), ctx())
  assert.equal(res.text, "done")
  assert.equal(res.usage.inputTokens, 50)
  assert.equal(res.usage.outputTokens, 10)
  await worker.shutdown()
})

// ===========================================================================
// H5 — schema two-turn usage. Verified semantics (codex-rs TokenUsageInfo):
// `last` = the last model REQUEST (one of many per tool-using turn);
// `total` = THREAD-cumulative (total += last on every request).
// The agent's true usage is therefore the extraction turn's final `total`.
// ===========================================================================

test("H5: schema agent reports the extraction turn's cumulative total exactly once", async () => {
  // Working turn makes TWO model requests (tool round + final message):
  //   request 1: last={in:60,out:10}  total={in:60,out:10}
  //   request 2: last={in:40,out:10}  total={in:100,out:20}
  // Extraction turn (same thread), one request:
  //   request 3: last={in:30,out:5}   total={in:130,out:25}
  // Correct usage = 130 in / 25 out.
  //   summing per-turn `total` (original bug)  → 230 in / 45 out (double-count)
  //   summing per-turn final `last`            →  70 in / 15 out (undercount)
  const { worker } = makeServedWorker((_req, reply, idx) => {
    if (idx === 0) {
      reply({
        jsonrpc: "2.0",
        method: "thread/tokenUsage/updated",
        params: { threadId: "thread-1", tokenUsage: { total: { inputTokens: 60, outputTokens: 10 }, last: { inputTokens: 60, outputTokens: 10 } } },
      })
      reply({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-1", item: { type: "agentMessage", text: "working" } } })
      reply({
        jsonrpc: "2.0",
        method: "thread/tokenUsage/updated",
        params: { threadId: "thread-1", tokenUsage: { total: { inputTokens: 100, outputTokens: 20 }, last: { inputTokens: 40, outputTokens: 10 } } },
      })
      reply({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } })
    } else {
      reply({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-1", item: { type: "agentMessage", text: '{"answer": 42}' } } })
      reply({
        jsonrpc: "2.0",
        method: "thread/tokenUsage/updated",
        params: { threadId: "thread-1", tokenUsage: { total: { inputTokens: 130, outputTokens: 25 }, last: { inputTokens: 30, outputTokens: 5 } } },
      })
      reply({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } })
    }
  })
  const res = await worker.runAgent(spec({ schema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] } }), ctx())
  assert.deepEqual(res.structured, { answer: 42 })
  assert.equal(res.usage.inputTokens, 130, "input must not double-count the working turn nor drop earlier requests")
  assert.equal(res.usage.outputTokens, 25)
  await worker.shutdown()
})

test("H5: working-turn usage survives an extraction turn that emits no tokenUsage update", async () => {
  const { worker } = makeServedWorker((_req, reply, idx) => {
    if (idx === 0) {
      reply({
        jsonrpc: "2.0",
        method: "thread/tokenUsage/updated",
        params: { threadId: "thread-1", tokenUsage: { total: { inputTokens: 100, outputTokens: 20 }, last: { inputTokens: 100, outputTokens: 20 } } },
      })
      reply({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-1", item: { type: "agentMessage", text: "working" } } })
      reply({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } })
    } else {
      reply({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-1", item: { type: "agentMessage", text: '{"answer": 1}' } } })
      // no tokenUsage update at all
      reply({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } })
    }
  })
  const res = await worker.runAgent(spec({ schema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] } }), ctx())
  assert.equal(res.usage.inputTokens, 100, "seeded working-turn usage must not be dropped")
  assert.equal(res.usage.outputTokens, 20)
  await worker.shutdown()
})

test("H5: non-schema single turn reports its final cumulative total (multi-request turn)", async () => {
  const { worker } = makeServedWorker((_req, reply) => {
    reply({
      jsonrpc: "2.0",
      method: "thread/tokenUsage/updated",
      params: { threadId: "thread-1", tokenUsage: { total: { inputTokens: 10, outputTokens: 2 }, last: { inputTokens: 10, outputTokens: 2 } } },
    })
    reply({
      jsonrpc: "2.0",
      method: "thread/tokenUsage/updated",
      params: { threadId: "thread-1", tokenUsage: { total: { inputTokens: 35, outputTokens: 9 }, last: { inputTokens: 25, outputTokens: 7 } } },
    })
    reply({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-1", item: { type: "agentMessage", text: "ok" } } })
    reply({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } })
  })
  const res = await worker.runAgent(spec(), ctx())
  assert.equal(res.usage.inputTokens, 35)
  assert.equal(res.usage.outputTokens, 9)
  await worker.shutdown()
})

// ===========================================================================
// H2 — error notification settles the turn
// ===========================================================================

test("H2: an `error` notification (no turn/completed) rejects the turn", async () => {
  const { worker } = makeServedWorker((_req, reply) => {
    reply({ jsonrpc: "2.0", method: "error", params: { threadId: "thread-1", message: "model exploded" } })
    // deliberately NO turn/completed
  })
  await assert.rejects(worker.runAgent(spec(), ctx()), (e) => e instanceof AgentError && /model exploded/.test(e.message) && e.retryable === true)
  await worker.shutdown()
})

test("H2: error notification without threadId settles all live turns", async () => {
  const { worker } = makeServedWorker((_req, reply) => {
    reply({ jsonrpc: "2.0", method: "error", params: { message: "global failure" } })
  })
  await assert.rejects(worker.runAgent(spec(), ctx()), (e) => e instanceof AgentError && /global failure/.test(e.message))
  await worker.shutdown()
})

// ===========================================================================
// H1 (worker level) — process death mid-turn rejects, does not hang
// ===========================================================================

test("H1: child crash mid-turn rejects runAgent (no hang)", async () => {
  let theChild!: FakeChild
  const worker = new CodexWorker({
    spawnChild: () => {
      theChild = new FakeChild()
      theChild.onWrite = (req: any) => {
        if (req.method === "initialize") return theChild.pushLine({ jsonrpc: "2.0", id: req.id, result: INIT_OK })
        if (req.method === "thread/start") return theChild.pushLine({ jsonrpc: "2.0", id: req.id, result: { thread: { id: "t" } } })
        if (req.method === "turn/start") {
          theChild.pushLine({ jsonrpc: "2.0", id: req.id, result: {} })
          // crash instead of completing the turn
          queueMicrotask(() => theChild.emitExit(139, "SIGSEGV"))
        }
      }
      return theChild as any
    },
  })
  await assert.rejects(worker.runAgent(spec(), ctx()), (e) => e instanceof AgentError && e.code === "process_exited")
  await worker.shutdown()
})

test("M1: after a crash with a stale partial frame, the worker recovers on the next runAgent", async () => {
  // Old bug: stdoutBuf was a worker field surviving process death, so the
  // restarted handshake parsed a corrupted first frame and initialize never
  // resolved. Now framing state dies with its transport.
  let spawnCount = 0
  const worker = new CodexWorker({
    spawnChild: () => {
      const child = new FakeChild()
      const isFirst = spawnCount++ === 0
      child.onWrite = (req: any) => {
        if (req.method === "initialize") return child.pushLine({ jsonrpc: "2.0", id: req.id, result: INIT_OK })
        if (req.method === "thread/start") return child.pushLine({ jsonrpc: "2.0", id: req.id, result: { thread: { id: `t${spawnCount}` } } })
        if (req.method === "turn/start") {
          child.pushLine({ jsonrpc: "2.0", id: req.id, result: {} })
          if (isFirst) {
            // leave a partial frame in the buffer, then die
            child.pushRaw('{"jsonrpc":"2.0","method":"item/agentMess')
            queueMicrotask(() => child.emitExit(1, null))
          } else {
            child.pushLine({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "t2", item: { type: "agentMessage", text: "recovered" } } })
            child.pushLine({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "t2", turn: { status: "completed" } } })
          }
        }
      }
      return child as any
    },
  })
  await assert.rejects(worker.runAgent(spec(), ctx()), (e) => e instanceof AgentError && e.retryable === true)
  const res = await worker.runAgent(spec(), ctx())
  assert.equal(res.text, "recovered")
  assert.equal(spawnCount, 2, "a fresh child must be spawned after the crash")
  await worker.shutdown()
})

test("worker shutdown settles in-flight turns with a retryable AgentError", async () => {
  const { worker } = makeServedWorker(() => {
    // never complete the turn
  })
  const run = worker.runAgent(spec(), ctx())
  await tick()
  await worker.shutdown()
  await assert.rejects(run, (e) => e instanceof AgentError && e.code === "shutdown" && e.retryable === true)
})

// ===========================================================================
// H3 — fail-closed approvals
// ===========================================================================

/** Wire-level reply the worker sends for an approval request targeting a LIVE
 *  turn running under `sandbox`. */
async function approvalDecision(sandbox: AgentSpec["sandbox"], method: string): Promise<unknown> {
  let child!: FakeChild
  const decisions: unknown[] = []
  const worker = new CodexWorker({
    spawnChild: () => {
      child = new FakeChild()
      child.onWrite = (req: any) => {
        if (req.result && (req.result.decision !== undefined || req.result.permissions !== undefined)) {
          decisions.push(req.result)
        }
        if (req.method === "initialize") return child.pushLine({ jsonrpc: "2.0", id: req.id, result: INIT_OK })
        if (req.method === "thread/start") return child.pushLine({ jsonrpc: "2.0", id: req.id, result: { thread: { id: "t" } } })
        if (req.method === "turn/start") {
          child.pushLine({ jsonrpc: "2.0", id: req.id, result: {} })
          child.pushLine({ jsonrpc: "2.0", id: 77, method, params: { threadId: "t" } })
          child.pushLine({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "t", item: { type: "agentMessage", text: "x" } } })
          child.pushLine({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "t", turn: { status: "completed" } } })
        }
      }
      return child as any
    },
  })
  await worker.runAgent(spec({ sandbox }), ctx())
  await worker.shutdown()
  return decisions[0]
}

test("H3: read-only declines command approval; non-read-only accepts (capture writes)", async () => {
  assert.deepEqual(await approvalDecision("read-only", "item/commandExecution/requestApproval"), { decision: "decline" })
  assert.deepEqual(await approvalDecision("read-only", "item/fileChange/requestApproval"), { decision: "decline" })
  assert.deepEqual(await approvalDecision("workspace-write", "item/commandExecution/requestApproval"), { decision: "accept" })
  assert.deepEqual(await approvalDecision("workspace-write", "item/fileChange/requestApproval"), { decision: "accept" })
})

test("H3: permissions approval grants nothing for ANY sandbox (wire-level reply shape)", async () => {
  // Permission grants take a grant-shaped reply, not a decision — fail closed
  // means an EMPTY grant even for writable sandboxes: the worker never widens
  // permissions beyond what the sandbox policy already granted.
  assert.deepEqual(await approvalDecision("read-only", "item/permissions/requestApproval"), { permissions: {}, scope: "turn" })
  assert.deepEqual(await approvalDecision("workspace-write", "item/permissions/requestApproval"), { permissions: {}, scope: "turn" })
  assert.deepEqual(await approvalDecision("danger-full-access", "item/permissions/requestApproval"), { permissions: {}, scope: "turn" })
})

/** Wire-level reply the worker sends for an approval request referencing a
 *  thread it has NO TurnState for (e.g. the approval raced the turn settling).
 *  The agent itself runs writable, so a decline can only come from the
 *  missing-TurnState branch — never the read-only one. */
async function orphanApprovalReply(method: string): Promise<unknown> {
  let child!: FakeChild
  const replies: unknown[] = []
  const worker = new CodexWorker({
    spawnChild: () => {
      child = new FakeChild()
      child.onWrite = (req: any) => {
        if (req.id === 88 && req.result !== undefined) replies.push(req.result)
        if (req.method === "initialize") return child.pushLine({ jsonrpc: "2.0", id: req.id, result: INIT_OK })
        if (req.method === "thread/start") return child.pushLine({ jsonrpc: "2.0", id: req.id, result: { thread: { id: "t" } } })
        if (req.method === "turn/start") {
          child.pushLine({ jsonrpc: "2.0", id: req.id, result: {} })
          // approval references a thread the worker has no state for
          child.pushLine({ jsonrpc: "2.0", id: 88, method, params: { threadId: "UNKNOWN" } })
          child.pushLine({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "t", item: { type: "agentMessage", text: "x" } } })
          child.pushLine({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "t", turn: { status: "completed" } } })
        }
      }
      return child as any
    },
  })
  await worker.runAgent(spec({ sandbox: "workspace-write" }), ctx())
  await worker.shutdown()
  return replies[0]
}

test("H3: approvals with NO matching TurnState fail closed for EVERY approval method", async () => {
  assert.deepEqual(await orphanApprovalReply("item/commandExecution/requestApproval"), { decision: "decline" })
  assert.deepEqual(await orphanApprovalReply("item/fileChange/requestApproval"), { decision: "decline" })
  // permissions takes the grant-shaped reply; fail closed = grant nothing.
  assert.deepEqual(await orphanApprovalReply("item/permissions/requestApproval"), { permissions: {}, scope: "turn" })
})

// ===========================================================================
// M32 — maxTurns rejected (not silently ignored)
// ===========================================================================

test("M32: codex rejects maxTurns explicitly", async () => {
  const { worker } = makeServedWorker(() => {})
  await assert.rejects(
    worker.runAgent(spec({ maxTurns: 5 }), ctx()),
    (e) => e instanceof AgentError && e.code === "unsupported_option",
  )
  await worker.shutdown()
})

// ===========================================================================
// M3 — image generation: read-only skip, basename sanitization, awaited write
// ===========================================================================

test("M3: imageGeneration writes to cwd, sanitizes id, and is awaited before settle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-img-"))
  const b64 = Buffer.from("PNGDATA").toString("base64")
  const { worker } = makeServedWorker((_req, reply) => {
    reply({
      jsonrpc: "2.0",
      method: "item/completed",
      params: { threadId: "thread-1", item: { type: "imageGeneration", id: "../../escape", result: b64 } },
    })
    reply({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-1", item: { type: "agentMessage", text: "made an image" } } })
    reply({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } })
  })
  await worker.runAgent(spec({ sandbox: "workspace-write", cwd: dir }), ctx())
  // id "../../escape" must be basename'd to "escape.png" inside cwd — no escape.
  const written = join(dir, "escape.png")
  assert.equal(existsSync(written), true, "image written under cwd with sanitized name")
  assert.equal(existsSync(join(dir, "..", "..", "escape.png")), false)
  const contents = await readFile(written)
  assert.equal(contents.toString(), "PNGDATA")
  await worker.shutdown()
})

test("M3: imageGeneration is SKIPPED for read-only sandboxes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-img-ro-"))
  const b64 = Buffer.from("DATA").toString("base64")
  const { worker } = makeServedWorker((_req, reply) => {
    reply({
      jsonrpc: "2.0",
      method: "item/completed",
      params: { threadId: "thread-1", item: { type: "imageGeneration", id: "pic", result: b64 } },
    })
    reply({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } })
  })
  await worker.runAgent(spec({ sandbox: "read-only", cwd: dir }), ctx())
  assert.equal(existsSync(join(dir, "pic.png")), false, "read-only must not write artifacts")
  await worker.shutdown()
})

test("M3: copyFile path used when savedPath present, awaited before settle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-img-copy-"))
  const srcPath = join(dir, "src.png")
  await writeFile(srcPath, "FROM-SAVED-PATH")
  const { worker } = makeServedWorker((_req, reply) => {
    reply({
      jsonrpc: "2.0",
      method: "item/completed",
      params: { threadId: "thread-1", item: { type: "imageGeneration", id: "out", savedPath: srcPath } },
    })
    reply({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } })
  })
  await worker.runAgent(spec({ sandbox: "workspace-write", cwd: dir }), ctx())
  const dest = join(dir, "out.png")
  assert.equal(existsSync(dest), true)
  assert.equal((await readFile(dest)).toString(), "FROM-SAVED-PATH")
  await worker.shutdown()
})

// ===========================================================================
// M30 — initialize version check + malformed-notification resilience
// ===========================================================================

test("M30: non-object initialize result fails the handshake (no silent hang)", async () => {
  let child!: FakeChild
  const worker = new CodexWorker({
    spawnChild: () => {
      child = new FakeChild()
      child.onWrite = (req: any) => {
        if (req.method === "initialize") child.pushLine({ jsonrpc: "2.0", id: req.id, result: "not-an-object" })
      }
      return child as any
    },
  })
  await assert.rejects(worker.runAgent(spec(), ctx()), (e) => e instanceof AgentError && e.code === "initialize_failed")
  await worker.shutdown()
})

test("M30: malformed notifications are ignored, turn still completes", async () => {
  const { worker } = makeServedWorker((_req, reply) => {
    // garbage shapes the guards must reject without throwing
    reply({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: 123, delta: "x" } })
    reply({ jsonrpc: "2.0", method: "thread/tokenUsage/updated", params: { threadId: "thread-1", tokenUsage: 5 } })
    reply({ jsonrpc: "2.0", method: "item/started", params: { threadId: "thread-1", item: "nope" } })
    reply({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-1", item: { type: "agentMessage", text: "survived" } } })
    reply({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } })
  })
  const res = await worker.runAgent(spec(), ctx())
  assert.equal(res.text, "survived")
  await worker.shutdown()
})

test("M30: production construction (factory passes no timeout opts) arms BOTH watchdogs", () => {
  // factory.ts constructs `new CodexWorker({ bin })` — production safety must
  // come from the defaults, not from opts nobody passes.
  assert.ok(DEFAULT_REQUEST_TIMEOUT_MS > 0, "request watchdog must default ON")
  assert.ok(DEFAULT_TURN_STALL_TIMEOUT_MS > 0, "turn stall watchdog must default ON")
  const worker = new CodexWorker({ bin: "codex" })
  assert.equal((worker as any).requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS)
  assert.equal((worker as any).turnStallTimeoutMs, DEFAULT_TURN_STALL_TIMEOUT_MS)
  // 0 stays an explicit opt-out, not a fall-through to the default.
  const off = new CodexWorker({ requestTimeoutMs: 0, turnStallTimeoutMs: 0 })
  assert.equal((off as any).requestTimeoutMs, 0)
  assert.equal((off as any).turnStallTimeoutMs, 0)
})

test("M30: a turn that goes silent after the turn/start ack is failed as stalled (no permanent hang)", async () => {
  // The request timeout cannot catch this: turn/start IS acked; the server
  // then simply never sends another frame.
  const { worker, getChild } = makeServedWorker(
    () => {
      // total silence: no items, no usage, no turn/completed
    },
    { turnStallTimeoutMs: 50 },
  )
  await assert.rejects(
    worker.runAgent(spec(), ctx()),
    (e) => e instanceof AgentError && e.code === "turn_stalled" && e.retryable === true,
  )
  // best-effort turn/interrupt was sent so a half-alive server stops burning tokens
  assert.ok(getChild().writes.some((w) => w.includes("turn/interrupt")))
  await worker.shutdown()
})

test("M30: notification activity re-arms the stall watchdog (a slow turn with steady progress completes)", async () => {
  // Total turn time (~400ms) far exceeds the stall window (250ms), but no
  // inter-frame gap does — only a watchdog that re-arms on activity survives.
  const { worker } = makeServedWorker(
    (_req, reply) => {
      const delta = (text: string) =>
        reply({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: "thread-1", delta: text } })
      setTimeout(() => delta("a"), 100)
      setTimeout(() => delta("b"), 200)
      setTimeout(() => delta("c"), 300)
      setTimeout(() => reply({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } }), 400)
    },
    { turnStallTimeoutMs: 250 },
  )
  const res = await worker.runAgent(spec(), ctx())
  assert.equal(res.text, "abc")
  await worker.shutdown()
})

test("M30/H3: inbound approval REQUESTS re-arm the stall watchdog (approval-only traffic keeps a turn alive)", async () => {
  // An approval-gated stretch can emit no notifications at all — the only
  // inbound frames are server-initiated approval requests. Each must count as
  // turn progress (touchTurn on the approval path) or the watchdog would kill
  // a healthy turn mid-approval. Total turn time (~400ms) exceeds the stall
  // window (250ms); no inter-frame gap does.
  const { worker, getChild } = makeServedWorker(
    (_req, reply) => {
      const approval = (id: number) =>
        reply({ jsonrpc: "2.0", id, method: "item/commandExecution/requestApproval", params: { threadId: "thread-1" } })
      setTimeout(() => approval(101), 100)
      setTimeout(() => approval(102), 200)
      setTimeout(() => approval(103), 300)
      setTimeout(() => reply({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } }), 400)
    },
    { turnStallTimeoutMs: 250 },
  )
  const res = await worker.runAgent(spec(), ctx())
  assert.equal(res.status, "completed")
  // The approvals were really answered on the wire (read-only → decline) —
  // liveness came from the approval handler, not from dropped frames.
  assert.equal(getChild().writes.filter((w) => w.includes('"decline"')).length, 3)
  await worker.shutdown()
})

test("M30: drifted streaming payloads still count as liveness — no false stall, no hang", async () => {
  // The delta payload shape drifted (no `delta` field) but the threadId is
  // intact: the shape guard must drop the payload while the watchdog still
  // treats the frames as proof of progress.
  const { worker } = makeServedWorker(
    (_req, reply) => {
      const junk = () => reply({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: "thread-1", textDelta: "drifted" } })
      setTimeout(junk, 100)
      setTimeout(junk, 200)
      setTimeout(junk, 300)
      setTimeout(() => reply({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } }), 400)
    },
    { turnStallTimeoutMs: 250 },
  )
  const res = await worker.runAgent(spec(), ctx())
  assert.equal(res.status, "completed")
  await worker.shutdown()
})

test("M30: drifted turn/completed (no `turn` member) settles the turn with protocol_drift — not a hang", async () => {
  const { worker } = makeServedWorker((_req, reply) => {
    // hypothetical v3 shape: status hoisted out of the `turn` object
    reply({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", status: "completed" } })
  })
  await assert.rejects(
    worker.runAgent(spec(), ctx()),
    (e) => e instanceof AgentError && e.code === "protocol_drift" && e.retryable === false && /0\.0\.0-test/.test(e.message),
  )
  await worker.shutdown()
})

test("M30: turn/completed with an unreadable threadId settles ALL live turns with protocol_drift", async () => {
  const { worker } = makeServedWorker((_req, reply) => {
    // even the threadId drifted — there is no way to match a specific turn
    reply({ jsonrpc: "2.0", method: "turn/completed", params: { thread: "thread-1", turn: { status: "completed" } } })
  })
  await assert.rejects(worker.runAgent(spec(), ctx()), (e) => e instanceof AgentError && e.code === "protocol_drift")
  await worker.shutdown()
})

test("M30: initialize result WITHOUT a userAgent fails the handshake (not an app-server)", async () => {
  let child!: FakeChild
  const worker = new CodexWorker({
    spawnChild: () => {
      child = new FakeChild()
      child.onWrite = (req: any) => {
        if (req.method === "initialize") child.pushLine({ jsonrpc: "2.0", id: req.id, result: { somethingElse: true } })
      }
      return child as any
    },
  })
  await assert.rejects(
    worker.runAgent(spec(), ctx()),
    (e) => e instanceof AgentError && e.code === "initialize_failed" && e.retryable === false,
  )
  await worker.shutdown()
})

test("M30: a pre-v2 app-server (initialize ok, thread/start unknown) fails loudly — behavioral version negotiation", async () => {
  // Old servers DO answer initialize (with a userAgent), so the version
  // mismatch surfaces at the first v2 method: a method-not-found rpc_error,
  // never a hang.
  let child!: FakeChild
  const worker = new CodexWorker({
    spawnChild: () => {
      child = new FakeChild()
      child.onWrite = (req: any) => {
        if (req.method === "initialize") return child.pushLine({ jsonrpc: "2.0", id: req.id, result: { userAgent: "codex/0.20.0 (old)" } })
        if (req.method === "thread/start")
          return child.pushLine({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "Method not found: thread/start" } })
      }
      return child as any
    },
  })
  await assert.rejects(
    worker.runAgent(spec(), ctx()),
    (e) => e instanceof AgentError && e.code === "rpc_error" && /Method not found/.test(e.message),
  )
  await worker.shutdown()
})

// ===========================================================================
// Turn failure / interrupt semantics
// ===========================================================================

test("turn/completed with status=failed → AgentError with codex code + retryable", async () => {
  const { worker } = makeServedWorker((_req, reply) => {
    reply({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { status: "failed", error: { message: "overloaded", codexErrorInfo: { serverOverloaded: {} } } } },
    })
  })
  await assert.rejects(
    worker.runAgent(spec(), ctx()),
    (e) => e instanceof AgentError && e.code === "serverOverloaded" && e.retryable === true,
  )
  await worker.shutdown()
})

test("turn/completed status=interrupted → AgentInterrupted", async () => {
  const { worker } = makeServedWorker((_req, reply) => {
    reply({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { status: "interrupted" } } })
  })
  await assert.rejects(worker.runAgent(spec(), ctx()), (e) => e instanceof AgentInterrupted)
  await worker.shutdown()
})

test("pre-aborted signal throws AgentInterrupted before spawning", async () => {
  const ac = new AbortController()
  ac.abort()
  const worker = new CodexWorker({ spawnChild: () => new FakeChild() as any })
  await assert.rejects(worker.runAgent(spec(), ctx(ac.signal)), (e) => e instanceof AgentInterrupted)
  await worker.shutdown()
})

test("abort mid-turn interrupts and settles", async () => {
  const ac = new AbortController()
  const { worker } = makeServedWorker((_req, _reply) => {
    // never complete; rely on abort to settle
  })
  const run = worker.runAgent(spec(), ctx(ac.signal))
  await tick()
  ac.abort()
  await assert.rejects(run, (e) => e instanceof AgentInterrupted)
  await worker.shutdown()
})

test("L2: async ENOENT spawn error → non-retryable binary_not_found", async () => {
  let child!: FakeChild
  const worker = new CodexWorker({
    spawnChild: () => {
      child = new FakeChild()
      // emit the ENOENT the way Node does for a missing binary (async 'error')
      queueMicrotask(() => child.emitError(new Error("spawn codex ENOENT")))
      return child as any
    },
  })
  await assert.rejects(
    worker.runAgent(spec(), ctx()),
    (e) => e instanceof AgentError && e.code === "binary_not_found" && e.retryable === false,
  )
  await worker.shutdown()
})

test("L2: sync spawn throw → non-retryable binary_not_found", async () => {
  const worker = new CodexWorker({
    spawnChild: () => {
      throw new Error("spawn codex ENOENT")
    },
  })
  await assert.rejects(
    worker.runAgent(spec(), ctx()),
    (e) => e instanceof AgentError && e.code === "binary_not_found" && e.retryable === false,
  )
  await worker.shutdown()
})

test("unknown server-initiated request gets an empty result (server not left blocking)", async () => {
  let child!: FakeChild
  const replies: any[] = []
  const worker = new CodexWorker({
    spawnChild: () => {
      child = new FakeChild()
      child.onWrite = (req: any) => {
        if (req.id === 99 && req.result !== undefined) replies.push(req)
        if (req.method === "initialize") return child.pushLine({ jsonrpc: "2.0", id: req.id, result: INIT_OK })
        if (req.method === "thread/start") return child.pushLine({ jsonrpc: "2.0", id: req.id, result: { thread: { id: "t" } } })
        if (req.method === "turn/start") {
          child.pushLine({ jsonrpc: "2.0", id: req.id, result: {} })
          child.pushLine({ jsonrpc: "2.0", id: 99, method: "some/future/method", params: {} })
          child.pushLine({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "t", item: { type: "agentMessage", text: "x" } } })
          child.pushLine({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "t", turn: { status: "completed" } } })
        }
      }
      return child as any
    },
  })
  await worker.runAgent(spec(), ctx())
  await worker.shutdown()
  assert.equal(replies.length, 1)
  assert.deepEqual(replies[0].result, {})
})

test("thread/start with no thread id → AgentError", async () => {
  let child!: FakeChild
  const worker = new CodexWorker({
    spawnChild: () => {
      child = new FakeChild()
      child.onWrite = (req: any) => {
        if (req.method === "initialize") return child.pushLine({ jsonrpc: "2.0", id: req.id, result: INIT_OK })
        if (req.method === "thread/start") return child.pushLine({ jsonrpc: "2.0", id: req.id, result: {} })
      }
      return child as any
    },
  })
  await assert.rejects(worker.runAgent(spec(), ctx()), (e) => e instanceof AgentError && e.code === "no_thread_id")
  await worker.shutdown()
})
