import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Runtime } from "../src/runtime/primitives.ts"
import { ensureRunDir, Journal, type LoadedJournal } from "../src/runtime/journal.ts"
import { FileEventSink } from "../src/runtime/event-sink.ts"
import { runInSandbox } from "../src/runtime/sandbox.ts"
import type { EventSink, WorkflowEventInput } from "../src/runtime/events.ts"
import type { Worker, WorkerContext, WorkerFactory } from "../src/worker/index.ts"
import { AgentError, AgentInterrupted } from "../src/worker/index.ts"
import { DEFAULTS, emptyUsage, type AgentResult, type AgentSpec, type RunDefaults } from "../src/dsl/types.ts"

// ---- test harness ----------------------------------------------------------------------------

interface WorkerHooks {
  /** Per-call behavior keyed by the worker's view of the spec. Default: echo the prompt. */
  run?: (spec: AgentSpec, ctx: WorkerContext, callIndex: number) => Promise<AgentResult>
}

class TestWorker implements Worker {
  readonly id = "codex" as const
  calls: AgentSpec[] = []
  private n = 0
  constructor(private readonly hooks: WorkerHooks = {}) {}
  async runAgent(spec: AgentSpec, ctx: WorkerContext): Promise<AgentResult> {
    if (ctx.signal.aborted) throw new AgentInterrupted()
    this.calls.push(spec)
    const i = this.n++
    if (this.hooks.run) return this.hooks.run(spec, ctx, i)
    return { text: `echo:${spec.prompt}`, status: "completed", usage: { ...emptyUsage(), outputTokens: 1 } }
  }
  async shutdown(): Promise<void> {}
}

class SingleFactory implements WorkerFactory {
  constructor(private readonly worker: Worker) {}
  get(): Worker {
    return this.worker
  }
  async shutdownAll(): Promise<void> {}
}

class MemSink implements EventSink {
  events: WorkflowEventInput[] = []
  emit(e: WorkflowEventInput): void {
    this.events.push(e)
  }
  async close(): Promise<void> {}
}

function defaults(over: Partial<RunDefaults> = {}): RunDefaults {
  return {
    provider: "codex",
    sandbox: "read-only",
    approval: "never",
    cwd: process.cwd(),
    concurrency: DEFAULTS.concurrency,
    maxAgents: DEFAULTS.maxAgents,
    maxFanout: DEFAULTS.maxFanout,
    budget: null,
    ...over,
  }
}

interface Built {
  runtime: Runtime
  sink: MemSink
  journal: Journal
  worker: TestWorker
  home: string
  signal: AbortSignal
  cleanup: () => void
}

function build(opts: {
  runId?: string
  loaded?: LoadedJournal
  defaults?: Partial<RunDefaults>
  hooks?: WorkerHooks
  worker?: TestWorker
  ac?: AbortController
  declaredPhases?: Array<{ title: string; detail?: string }>
} = {}): Built {
  const home = mkdtempSync(join(tmpdir(), "omega-prim-"))
  const prev = process.env.OMEGACODE_HOME
  process.env.OMEGACODE_HOME = home
  const runId = opts.runId ?? "run_test"
  const worker = opts.worker ?? new TestWorker(opts.hooks)
  const sink = new MemSink()
  const journal = new Journal(runId)
  const ac = opts.ac ?? new AbortController()
  const runtime = new Runtime({
    runId,
    defaults: defaults(opts.defaults),
    factory: new SingleFactory(worker),
    journal,
    loaded: opts.loaded ?? { results: new Map(), indexByKey: new Map() },
    events: sink,
    args: undefined,
    seed: 12345,
    baseTimeMs: 1_000_000,
    signal: ac.signal,
    declaredPhases: opts.declaredPhases,
  })
  return {
    runtime,
    sink,
    journal,
    worker,
    home,
    signal: ac.signal,
    cleanup: () => {
      if (prev === undefined) delete process.env.OMEGACODE_HOME
      else process.env.OMEGACODE_HOME = prev
      rmSync(home, { recursive: true, force: true })
    },
  }
}

/** Run a workflow body string through the sandbox against a built runtime. */
async function runBody(b: Built, body: string): Promise<unknown> {
  const out = await runInSandbox({ body, filename: "test.js", globals: b.runtime.globals() })
  await b.runtime.settle()
  return out
}

// ---- tests -----------------------------------------------------------------------------------

test("happy path: a single agent returns its text and journals a completed result", async () => {
  const b = build()
  try {
    const out = await runBody(b, `return await agent("hi")`)
    assert.equal(out, "echo:hi")
    const loaded = Journal.load("run_test")
    assert.equal(loaded.results.size, 1)
    const [entry] = [...loaded.results.values()]
    assert.equal(entry.status, "completed")
    assert.equal(entry.result, "echo:hi")
  } finally {
    b.cleanup()
  }
})

test("declared phases announce pending up front; phase() re-announces the same index on entry", async () => {
  // Malformed/duplicate declared entries are skipped (meta.phases is display-only, not validated).
  const b = build({ declaredPhases: [{ title: "Scan" }, { title: "Fix" }, { title: "" }, { title: "Scan" }] })
  try {
    assert.deepEqual(
      b.sink.events.filter((e) => e.type === "phase"),
      [
        { type: "phase", index: 1, title: "Scan", pending: true },
        { type: "phase", index: 2, title: "Fix", pending: true },
      ],
    )

    // Entering a declared phase keeps its declared index and emits the non-pending event;
    // an undeclared title gets the next index after the declared block.
    await runBody(b, `phase("Fix"); phase("Extra"); phase("Fix")`)
    const announced = b.sink.events.filter((e) => e.type === "phase").slice(2)
    assert.deepEqual(announced, [
      { type: "phase", index: 2, title: "Fix" },
      { type: "phase", index: 3, title: "Extra" },
    ])

    // An agent under a declared-but-unentered phase announces it too (opts.phase path).
    await runBody(b, `await agent("hi", { phase: "Scan" })`)
    const scan = b.sink.events.filter((e) => e.type === "phase" && !("pending" in e) && e.title === "Scan")
    assert.deepEqual(scan, [{ type: "phase", index: 1, title: "Scan" }])
  } finally {
    b.cleanup()
  }
})

test("now()/random() are per-branch deterministic across two runs", async () => {
  const make = () => {
    const b = build()
    return b
  }
  const b1 = make()
  let r1: unknown
  try {
    r1 = await runBody(b1, `return [now(), now(), random(), random()]`)
  } finally {
    b1.cleanup()
  }
  const b2 = make()
  let r2: unknown
  try {
    r2 = await runBody(b2, `return [now(), now(), random(), random()]`)
  } finally {
    b2.cleanup()
  }
  // values cross the vm boundary, so compare structurally via JSON (not reference-equal arrays)
  assert.equal(JSON.stringify(r1), JSON.stringify(r2))
  const arr = r1 as number[]
  assert.equal(arr[0], 1_000_000)
  assert.equal(arr[1], 1_000_001)
})

test("parallel() runs each thunk in its own branch and fans out", async () => {
  const b = build({ hooks: { run: async (s) => ({ text: s.prompt.toUpperCase(), status: "completed", usage: emptyUsage() }) } })
  try {
    const out = await runBody(b, `return await parallel([() => agent("a"), () => agent("b"), () => agent("c")])`)
    assert.deepEqual(out, ["A", "B", "C"])
  } finally {
    b.cleanup()
  }
})

test("parallel branches get distinct journal keys (no collision)", async () => {
  const b = build()
  try {
    await runBody(b, `return await parallel([() => agent("same"), () => agent("same")])`)
    const loaded = Journal.load("run_test")
    // two identical prompts in different branches → two distinct keys
    assert.equal(loaded.results.size, 2)
  } finally {
    b.cleanup()
  }
})

test("pipeline() threads stages and keys by (item, stage) position", async () => {
  const b = build({ hooks: { run: async (s) => ({ text: `[${s.prompt}]`, status: "completed", usage: emptyUsage() }) } })
  try {
    const out = await runBody(
      b,
      `return await pipeline([1, 2], async (prev) => await agent("s1:" + prev), async (prev) => await agent("s2:" + prev))`,
    )
    assert.deepEqual(out, ["[s2:[s1:1]]", "[s2:[s1:2]]"])
    const loaded = Journal.load("run_test")
    assert.equal(loaded.results.size, 4) // 2 items x 2 stages
  } finally {
    b.cleanup()
  }
})

test("parallel() swallows ordinary agent failures as null but keeps siblings", async () => {
  const b = build({
    hooks: {
      run: async (s) => {
        if (s.prompt === "bad") throw new AgentError({ provider: "codex", code: "x", message: "nope" })
        return { text: s.prompt, status: "completed", usage: emptyUsage() }
      },
    },
  })
  try {
    const out = (await runBody(b, `return await parallel([() => agent("ok"), () => agent("bad"), () => agent("ok2")])`)) as unknown[]
    assert.equal(out[0], "ok")
    assert.equal(out[1], null)
    assert.equal(out[2], "ok2")
  } finally {
    b.cleanup()
  }
})

test("pipeline() nulls a failed item (skipping its later stages) but keeps siblings", async () => {
  const b = build({
    hooks: {
      run: async (s) => {
        if (s.prompt.includes("bad")) throw new AgentError({ provider: "codex", code: "x", message: "nope" })
        return { text: `[${s.prompt}]`, status: "completed", usage: emptyUsage() }
      },
    },
  })
  try {
    const out = (await runBody(
      b,
      `return await pipeline(["ok", "bad"], async (p) => await agent("s1:" + p), async (p) => await agent("s2:" + p))`,
    )) as unknown[]
    assert.equal(out[0], "[s2:[s1:ok]]")
    assert.equal(out[1], null)
    // the failed item's second stage never ran
    assert.ok(!b.worker.calls.some((s) => s.prompt.startsWith("s2:") && s.prompt.includes("bad")))
  } finally {
    b.cleanup()
  }
})

test("H6: pipeline() RETHROWS AgentInterrupted instead of nulling it", async () => {
  const ac = new AbortController()
  const b = build({
    ac,
    hooks: {
      run: async () => {
        ac.abort()
        throw new AgentInterrupted()
      },
    },
  })
  try {
    await assert.rejects(
      runBody(b, `return await pipeline([1, 2], async (p) => await agent("s:" + p))`),
      (e: unknown) => e instanceof AgentInterrupted || (e as Error).message.includes("interrupt"),
    )
  } finally {
    b.cleanup()
  }
})

test("H6: parallel() RETHROWS AgentInterrupted instead of nulling it", async () => {
  const ac = new AbortController()
  const b = build({
    ac,
    hooks: {
      run: async (s, ctx) => {
        // abort mid-flight, then surface interruption
        ac.abort()
        throw new AgentInterrupted()
      },
    },
  })
  try {
    await assert.rejects(
      runBody(b, `return await parallel([() => agent("x"), () => agent("y")])`),
      (e: unknown) => e instanceof AgentInterrupted || (e as Error).message.includes("interrupt"),
    )
  } finally {
    b.cleanup()
  }
})

test("H6: parallel() RETHROWS WorkflowError (budget/cap) instead of nulling it", async () => {
  // concurrency 1 so the second thunk is queued while the first spends the whole budget; when it
  // gets the slot the in-slot budget check throws a WorkflowError that must propagate (not null).
  const b = build({
    defaults: { budget: 1, concurrency: 1 },
    hooks: { run: async (s) => ({ text: s.prompt, status: "completed", usage: { ...emptyUsage(), outputTokens: 100 } }) },
  })
  try {
    await assert.rejects(
      runBody(b, `return await parallel([() => agent("a"), () => agent("b")])`),
      (e: unknown) => e instanceof Error && (e as Error).message.includes("budget"),
    )
  } finally {
    b.cleanup()
  }
})

test("M11: budget is re-checked inside the semaphore slot", async () => {
  // concurrency 1 so the second agent is queued while the first spends the whole budget.
  const b = build({
    defaults: { budget: 50, concurrency: 1 },
    hooks: { run: async (s) => ({ text: s.prompt, status: "completed", usage: { ...emptyUsage(), outputTokens: 60 } }) },
  })
  try {
    await assert.rejects(runBody(b, `await agent("a"); return await agent("b")`), /budget/)
    // the first agent ran, the second was rejected by the in-slot check (worker never saw it)
    assert.equal(b.worker.calls.length, 1)
  } finally {
    b.cleanup()
  }
})

test("M10: corrective-retry usage accumulates across both attempts", async () => {
  let call = 0
  const b = build({
    hooks: {
      run: async (s) => {
        call++
        if (call === 1) {
          // first attempt: wrong shape (number instead of string) → fails validation
          return { text: "1", structured: 123, status: "completed", usage: { ...emptyUsage(), outputTokens: 10 } }
        }
        return { text: '"ok"', structured: "ok", status: "completed", usage: { ...emptyUsage(), outputTokens: 5 } }
      },
    },
  })
  try {
    const out = await runBody(b, `return await agent("p", { schema: { type: "string" } })`)
    assert.equal(out, "ok")
    assert.equal(call, 2)
    const loaded = Journal.load("run_test")
    const [entry] = [...loaded.results.values()]
    // 10 (first attempt) + 5 (retry) = 15 output tokens journaled
    assert.equal(entry.usage.outputTokens, 15)
    assert.equal(b.runtime.totalUsage.outputTokens, 15)
  } finally {
    b.cleanup()
  }
})

test("M4: a retryable AgentError is retried via withRetry, then succeeds", async () => {
  let call = 0
  const b = build({
    hooks: {
      run: async (s) => {
        call++
        if (call === 1) throw new AgentError({ provider: "codex", code: "overload", message: "429", retryable: true })
        return { text: "recovered", status: "completed", usage: emptyUsage() }
      },
    },
  })
  try {
    const out = await runBody(b, `return await agent("p")`)
    assert.equal(out, "recovered")
    assert.equal(call, 2)
  } finally {
    b.cleanup()
  }
})

test("M4: a non-retryable AgentError is NOT retried", async () => {
  let call = 0
  const b = build({
    hooks: {
      run: async () => {
        call++
        throw new AgentError({ provider: "codex", code: "fatal", message: "boom", retryable: false })
      },
    },
  })
  try {
    await assert.rejects(runBody(b, `return await agent("p")`))
    assert.equal(call, 1)
  } finally {
    b.cleanup()
  }
})

test("H7: duplicate explicit opts.key fails fast", async () => {
  const b = build()
  try {
    await assert.rejects(
      runBody(b, `await agent("a", { key: "K" }); return await agent("b", { key: "K" })`),
      /duplicate explicit agent key/,
    )
  } finally {
    b.cleanup()
  }
})

test("L12: transcripts live at agents/<index>.jsonl for the index the agent's events advertise", async () => {
  // The server/viewer resolve a drilldown via the event's index (GET /api/runs/<id>/agents/<index>),
  // so the transcript MUST be written to exactly that address.
  const b = build()
  try {
    await runBody(b, `await agent("first"); return await agent("second")`)
    const done = b.sink.events.filter((e) => e.type === "agent" && e.state === "done") as Array<{ index: number; label: string }>
    assert.equal(done.length, 2)
    const { readFileSync } = await import("node:fs")
    for (const e of done) {
      const file = join(b.home, "runs", "run_test", "agents", `${e.index}.jsonl`)
      const meta = JSON.parse(readFileSync(file, "utf8").split("\n")[0]!) as { kind: string; prompt: string }
      assert.equal(meta.kind, "meta")
      assert.equal(meta.prompt, e.label, `agents/${e.index}.jsonl holds a different agent's transcript`)
    }
  } finally {
    b.cleanup()
  }
})

test("maxAgents cap throws a WorkflowError", async () => {
  const b = build({ defaults: { maxAgents: 2 } })
  try {
    await assert.rejects(runBody(b, `await agent("1"); await agent("2"); return await agent("3")`), /call cap reached/)
  } finally {
    b.cleanup()
  }
})

test("maxFanout cap throws for parallel()", async () => {
  const b = build({ defaults: { maxFanout: 1 } })
  try {
    await assert.rejects(runBody(b, `return await parallel([() => agent("a"), () => agent("b")])`), /fan-out cap/)
  } finally {
    b.cleanup()
  }
})

test("parallel() rejects a non-function entry", async () => {
  const b = build()
  try {
    await assert.rejects(runBody(b, `return await parallel([agent("a")])`), /array of functions/)
  } finally {
    b.cleanup()
  }
})

test("a journaled FAILED result does NOT replay as success (rec #4)", async () => {
  // pre-seed a failed result under the key the agent will compute.
  const b0 = build()
  let key: string
  try {
    // run once to discover the deterministic key, capture it, then tear down.
    await runBody(b0, `return await agent("task")`)
    key = [...Journal.load("run_test").results.keys()][0]!
  } finally {
    b0.cleanup()
  }
  const loaded: LoadedJournal = {
    results: new Map([
      [key, { type: "result", key, index: 1, status: "failed", result: null, usage: emptyUsage(), provider: "codex", durationMs: 1 }],
    ]),
    indexByKey: new Map([[key, 1]]),
  }
  const b = build({ loaded })
  try {
    const out = await runBody(b, `return await agent("task")`)
    // it must re-run the worker (which now succeeds), not replay the failure
    assert.equal(out, "echo:task")
    assert.equal(b.worker.calls.length, 1)
  } finally {
    b.cleanup()
  }
})

test("a journaled COMPLETED result DOES replay (cache hit, worker not called)", async () => {
  const b0 = build()
  let key: string
  try {
    await runBody(b0, `return await agent("task")`)
    key = [...Journal.load("run_test").results.keys()][0]!
  } finally {
    b0.cleanup()
  }
  const loaded: LoadedJournal = {
    results: new Map([
      [key, { type: "result", key, index: 1, status: "completed", result: "cached!", usage: emptyUsage(), provider: "codex", durationMs: 1 }],
    ]),
    indexByKey: new Map([[key, 1]]),
  }
  const b = build({ loaded })
  try {
    const out = await runBody(b, `return await agent("task")`)
    assert.equal(out, "cached!")
    assert.equal(b.worker.calls.length, 0) // replayed, worker never invoked
  } finally {
    b.cleanup()
  }
})

test("H8: changing the DEFAULT provider invalidates the resume cache (resolved-spec keying)", async () => {
  // First run with default provider codex; journal a result under the codex-resolved key.
  const b0 = build({ defaults: { provider: "codex" } })
  let codexKey: string
  try {
    await runBody(b0, `return await agent("task")`)
    codexKey = [...Journal.load("run_test").results.keys()][0]!
  } finally {
    b0.cleanup()
  }
  // Resume with a DIFFERENT default provider — the resolved spec differs, so the key differs and the
  // cached codex result must NOT be replayed (it would mis-attribute results to the wrong provider).
  const loaded: LoadedJournal = {
    results: new Map([
      [codexKey, { type: "result", key: codexKey, index: 1, status: "completed", result: "STALE", usage: emptyUsage(), provider: "codex", durationMs: 1 }],
    ]),
    indexByKey: new Map([[codexKey, 1]]),
  }
  const b = build({ loaded, defaults: { provider: "claude-code" } })
  try {
    const out = await runBody(b, `return await agent("task")`)
    assert.equal(out, "echo:task") // re-ran, did not replay STALE
    assert.equal(b.worker.calls.length, 1)
  } finally {
    b.cleanup()
  }
})

test("L11: a fire-and-forget agent() rejection does not escape after the body returns", async () => {
  const b = build({
    hooks: {
      run: async () => {
        throw new AgentError({ provider: "codex", code: "x", message: "late failure", retryable: false })
      },
    },
  })
  // Any unhandledRejection here would normally crash the test process — trap it to fail the test
  // with a useful message instead.
  let unhandled: unknown
  const trap = (reason: unknown) => {
    unhandled = reason
  }
  process.on("unhandledRejection", trap)
  try {
    // body launches an agent WITHOUT awaiting or catching, then returns immediately
    const out = await runBody(b, `agent("fire"); return "done"`)
    assert.equal(out, "done")
    // give the rejection a macrotask to surface if it was going to
    await new Promise((r) => setTimeout(r, 0))
    assert.equal(unhandled, undefined, `fire-and-forget agent() rejection escaped: ${unhandled}`)
  } finally {
    process.removeListener("unhandledRejection", trap)
    b.cleanup()
  }
})

test("random() varies with the run seed but is stable for the same seed", async () => {
  const run = async (seed: number) => {
    const home = mkdtempSync(join(tmpdir(), "omega-seed-"))
    const prev = process.env.OMEGACODE_HOME
    process.env.OMEGACODE_HOME = home
    try {
      const runtime = new Runtime({
        runId: "run_seed",
        defaults: defaults(),
        factory: new SingleFactory(new TestWorker()),
        journal: new Journal("run_seed"),
        loaded: { results: new Map(), indexByKey: new Map() },
        events: new MemSink(),
        args: undefined,
        seed,
        baseTimeMs: 1,
        signal: new AbortController().signal,
      })
      const out = await runInSandbox({ body: `return [random(), random()]`, filename: "t.js", globals: runtime.globals() })
      return JSON.stringify(out)
    } finally {
      if (prev === undefined) delete process.env.OMEGACODE_HOME
      else process.env.OMEGACODE_HOME = prev
      rmSync(home, { recursive: true, force: true })
    }
  }
  assert.equal(await run(7), await run(7)) // resume-stable
  assert.notEqual(await run(7), await run(8)) // run-distinct
})

test("H14: agent() rejects invalid provider/sandbox/effort/approval values at spec resolution", async () => {
  // Workflow bodies are untyped JS: an unvalidated `sandbox: "readonly"` (typo for "read-only")
  // falls off the worker policy switches and is treated as writable — read-only silently bypassed.
  // Provider must be validated here too: an unknown provider would otherwise only fail at the
  // factory, and not at all under --fake (it silently routes to the FakeWorker).
  const b = build()
  try {
    await assert.rejects(runBody(b, `return await agent("x", { provider: "open-code" })`), /invalid provider "open-code"/)
    await assert.rejects(runBody(b, `return await agent("x", { sandbox: "readonly" })`), /invalid sandbox "readonly"/)
    await assert.rejects(runBody(b, `return await agent("x", { effort: "ultra" })`), /invalid effort "ultra"/)
    await assert.rejects(runBody(b, `return await agent("x", { approval: "always" })`), /invalid approval "always"/)
    // the worker never saw an unvalidated policy
    assert.equal(b.worker.calls.length, 0)
    // valid values still resolve and run — including the new provider ids
    const ok = await runBody(b, `return await agent("y", { sandbox: "read-only", effort: "high", approval: "never" })`)
    assert.equal(ok, "echo:y")
    const pi = await runBody(b, `return await agent("z", { provider: "pi", sandbox: "danger-full-access" })`)
    assert.equal(pi, "echo:z")
    assert.equal(b.worker.calls.at(-1)?.provider, "pi")
  } finally {
    b.cleanup()
  }
})

test("H6: a persistent schema miss nulls only ITS parallel item — siblings and the fan-out survive", async () => {
  // The AgentFailedError wrap must NOT count as control flow: failing schema validation on both
  // attempts is a per-agent failure (null that item, baseline semantics), not a run-level abort.
  const b = build({
    hooks: {
      run: async (s) =>
        s.prompt === "bad"
          ? { text: "1", structured: 123, status: "completed", usage: emptyUsage() } // never a string
          : { text: JSON.stringify(s.prompt), structured: s.prompt, status: "completed", usage: emptyUsage() },
    },
  })
  try {
    const out = (await runBody(
      b,
      `return await parallel([
        () => agent("a", { schema: { type: "string" } }),
        () => agent("bad", { schema: { type: "string" } }),
        () => agent("c", { schema: { type: "string" } }),
      ])`,
    )) as unknown[]
    assert.deepEqual(JSON.parse(JSON.stringify(out)), ["a", null, "c"])
    // the bad item burned its original attempt AND the corrective retry before nulling
    assert.equal(b.worker.calls.filter((s) => s.prompt === "bad").length, 2)
  } finally {
    b.cleanup()
  }
})

test("L6: a failed turn's provider-reported usage reaches totalUsage and the journal", async () => {
  const b = build({
    hooks: {
      run: async () => {
        throw new AgentError({
          provider: "codex",
          code: "boom",
          message: "failed turn",
          usage: { inputTokens: 3, outputTokens: 7, costUsd: 0.01 },
        })
      },
    },
  })
  try {
    await assert.rejects(runBody(b, `return await agent("p")`), /failed turn/)
    // failed turns still bill: the usage must reach the budget-bearing run total …
    assert.equal(b.runtime.totalUsage.inputTokens, 3)
    assert.equal(b.runtime.totalUsage.outputTokens, 7)
    // … and the journal, so a resumed run's accounting doesn't silently forget the spend
    const [entry] = [...Journal.load("run_test").results.values()]
    assert.equal(entry.status, "failed")
    assert.equal(entry.usage.outputTokens, 7)
  } finally {
    b.cleanup()
  }
})

test("L6: failed-turn usage counts against the budget ceiling end-to-end", async () => {
  const b = build({
    defaults: { budget: 5 },
    hooks: {
      run: async (s) => {
        if (s.prompt === "a")
          throw new AgentError({ provider: "codex", code: "boom", message: "nope", usage: { ...emptyUsage(), outputTokens: 10 } })
        return { text: s.prompt, status: "completed", usage: emptyUsage() }
      },
    },
  })
  try {
    // the body tolerates the first failure; the second agent must hit the ceiling the failure spent
    await assert.rejects(
      runBody(b, `try { await agent("a") } catch (e) {} return await agent("b")`),
      /budget/,
    )
    assert.equal(b.worker.calls.length, 1, "the budget check never saw the failed turn's usage (L6)")
  } finally {
    b.cleanup()
  }
})

// ---- worktree teardown integration (H10 base threading + L14 preservation events) --------------

/** A throwaway git repo with one commit, for worktree integration tests. */
function makeGitRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "omega-wt-repo-"))
  const g = (...args: string[]) => execFileSync("git", args, { cwd: repo })
  g("init", "-q")
  g("config", "user.email", "omega@test")
  g("config", "user.name", "omega")
  writeFileSync(join(repo, "f.txt"), "hello\n")
  g("add", "-A")
  g("commit", "-q", "-m", "init")
  return repo
}

test("L14: a preserved worktree emits worktreeBranch/worktreePath into events.jsonl", async () => {
  // Full integration: teardown → trailing agent event → events.jsonl, the file the terminal
  // renderer and viewer read. Without it, users never learn where their preserved edits live.
  const repo = makeGitRepo()
  const home = mkdtempSync(join(tmpdir(), "omega-prim-"))
  const prev = process.env.OMEGACODE_HOME
  process.env.OMEGACODE_HOME = home
  const runId = "run_wt"
  try {
    ensureRunDir(runId)
    const events = new FileEventSink(runId)
    const worker = new TestWorker({
      run: async (spec) => {
        writeFileSync(join(spec.cwd, "dirty.txt"), "x\n") // dirty the worktree → teardown preserves
        return { text: "ok", status: "completed", usage: emptyUsage() }
      },
    })
    const runtime = new Runtime({
      runId,
      defaults: defaults({ cwd: repo }),
      factory: new SingleFactory(worker),
      journal: new Journal(runId),
      loaded: { results: new Map(), indexByKey: new Map() },
      events,
      args: undefined,
      seed: 1,
      baseTimeMs: 1,
      signal: new AbortController().signal,
    })
    const out = await runInSandbox({ body: `return await agent("edit", { worktree: true })`, filename: "t.js", globals: runtime.globals() })
    await runtime.settle()
    await events.close()
    assert.equal(out, "ok")
    const lines = readFileSync(join(home, "runs", runId, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    const wt = lines.find((e) => e.type === "agent" && e.worktreeBranch)
    assert.ok(wt, "no agent event carried the preserved-worktree fields (L14)")
    assert.equal(wt.state, "done") // the trailing event re-states the terminal state
    assert.equal(wt.worktreeBranch, `aw/${runId}-1`)
    assert.ok(
      typeof wt.worktreePath === "string" && wt.worktreePath.endsWith(join(".omegacode", "worktrees", `${runId}-1`)),
      `worktreePath should point at the preserved checkout, got: ${wt.worktreePath}`,
    )
  } finally {
    if (prev === undefined) delete process.env.OMEGACODE_HOME
    else process.env.OMEGACODE_HOME = prev
    rmSync(home, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  }
})

test("H10: teardown trusts the THREADED creation base when the shared-config fallback is gone", async () => {
  // The git-config fallback lives in the SHARED .git/config — last-writer-wins across parallel
  // worktrees. Simulate the clobber by deleting the key: only a base threaded through the teardown
  // call site can still prove this clean worktree clean (else it is wrongly preserved).
  const repo = makeGitRepo()
  const b = build({
    defaults: { cwd: repo },
    hooks: {
      run: async (spec) => {
        execFileSync("git", ["config", "--unset", "omegacode.base"], { cwd: spec.cwd })
        return { text: "clean", status: "completed", usage: emptyUsage() }
      },
    },
  })
  try {
    const out = await runBody(b, `return await agent("noop", { worktree: true })`)
    assert.equal(out, "clean")
    // no preservation event — the threaded base proved the worktree clean …
    const wt = b.sink.events.find((e) => e.type === "agent" && (e as { worktreeBranch?: string }).worktreeBranch)
    assert.equal(wt, undefined, "clean worktree was preserved — teardown lost the creation base (H10)")
    // … and the worktree checkout was actually removed
    const wtDir = join(repo, ".omegacode", "worktrees")
    assert.deepEqual(existsSync(wtDir) ? readdirSync(wtDir) : [], [])
  } finally {
    b.cleanup()
    rmSync(repo, { recursive: true, force: true })
  }
})

test("parallel branches draw from distinct random() substreams deterministically", async () => {
  const body = `return await parallel([() => [random(), random()], () => [random(), random()]])`
  const b1 = build()
  let r1: unknown
  try {
    r1 = JSON.parse(JSON.stringify(await runBody(b1, body)))
  } finally {
    b1.cleanup()
  }
  const b2 = build()
  try {
    const r2 = JSON.parse(JSON.stringify(await runBody(b2, body)))
    assert.deepEqual(r1, r2) // deterministic across runs with the same seed
    const [a, c] = r1 as [number[], number[]]
    assert.notDeepEqual(a, c) // but branch substreams differ from each other
  } finally {
    b2.cleanup()
  }
})
