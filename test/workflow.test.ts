// End-to-end tests for workflow() composition: a conductor body runs leaf workflows inline
// sharing one journal, budget, semaphore and event feed, with namespaced resume keys.

import { test } from "node:test"
import assert from "node:assert/strict"
import { deepEqual as looseDeepEqual } from "node:assert"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Runtime } from "../src/runtime/primitives.ts"
import { Journal, type LoadedJournal } from "../src/runtime/journal.ts"
import { runInSandbox } from "../src/runtime/sandbox.ts"
import type { EventSink, WorkflowEventInput } from "../src/runtime/events.ts"
import type { Worker, WorkerContext, WorkerFactory } from "../src/worker/index.ts"
import { AgentInterrupted } from "../src/worker/index.ts"
import { DEFAULTS, emptyUsage, type AgentResult, type AgentSpec, type RunDefaults } from "../src/dsl/types.ts"

class TestWorker implements Worker {
  readonly id = "codex" as const
  calls: AgentSpec[] = []
  async runAgent(spec: AgentSpec, ctx: WorkerContext): Promise<AgentResult> {
    if (ctx.signal.aborted) throw new AgentInterrupted()
    this.calls.push(spec)
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

function fullDefaults(over: Partial<RunDefaults> = {}): RunDefaults {
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
  worker: TestWorker
  home: string
  dir: string
  cleanup: () => void
}

function build(opts: { runId?: string; loaded?: LoadedJournal; defaults?: Partial<RunDefaults>; home?: string; dir?: string } = {}): Built {
  const home = opts.home ?? mkdtempSync(join(tmpdir(), "omega-wf-"))
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "omega-wf-leaf-"))
  const prev = process.env.OMEGACODE_HOME
  process.env.OMEGACODE_HOME = home
  const worker = new TestWorker()
  const sink = new MemSink()
  const journal = new Journal(opts.runId ?? "run_wf")
  const ac = new AbortController()
  const runtime = new Runtime({
    runId: opts.runId ?? "run_wf",
    defaults: fullDefaults(opts.defaults),
    factory: new SingleFactory(worker),
    journal,
    loaded: opts.loaded ?? { results: new Map(), indexByKey: new Map() },
    events: sink,
    args: undefined,
    seed: 999,
    baseTimeMs: 1_000_000,
    signal: ac.signal,
  })
  return {
    runtime,
    sink,
    worker,
    home,
    dir,
    cleanup: () => {
      if (prev === undefined) delete process.env.OMEGACODE_HOME
      else process.env.OMEGACODE_HOME = prev
      if (!opts.home) rmSync(home, { recursive: true, force: true })
      if (!opts.dir) rmSync(dir, { recursive: true, force: true })
    },
  }
}

function leaf(dir: string, name: string, body: string, metaExtra = ""): string {
  const file = join(dir, `${name}.workflow.js`)
  writeFileSync(
    file,
    `export const meta = { name: "${name}", description: "leaf", phases: [{ title: "Deep" }]${metaExtra} }\n${body}\n`,
  )
  return file
}

async function runBody(b: Built, body: string): Promise<unknown> {
  const out = await runInSandbox({ body, filename: "conductor.js", globals: b.runtime.globals() })
  await b.runtime.settle()
  return out
}

// ---------------------------------------------------------------------------

test("leaf runs inline: result returned, child args arrive, phases prefixed", async () => {
  const b = build()
  try {
    const lf = leaf(b.dir, "echo-leaf", `phase("Deep")\nconst a = await agent("deep work")\nreturn { said: a, n: args.n }`)
    const out = (await runBody(b, `return await workflow(${JSON.stringify(lf)}, { n: 7 })`)) as { said: string; n: number }
    assert.equal(out.said, "echo:deep work")
    assert.equal(out.n, 7)
    assert.equal(b.worker.calls.length, 1)
    // Child phases group visibly under the leaf name; the start/end narrate the call.
    const titles = b.sink.events.filter((e) => e.type === "phase").map((e) => (e as { title: string }).title)
    assert.ok(titles.includes("echo-leaf › Deep"), `titles: ${titles}`)
    const logs = b.sink.events.filter((e) => e.type === "log").map((e) => (e as { message: string }).message)
    assert.ok(logs.some((m) => m.includes('→ workflow "echo-leaf"')))
    assert.ok(logs.some((m) => m.includes('← workflow "echo-leaf" → done (1 agent calls)')))
  } finally {
    b.cleanup()
  }
})

test("nesting stops at one level: a leaf calling workflow() fails the run", async () => {
  const b = build()
  try {
    const inner = leaf(b.dir, "inner", `return "inner"`)
    const outer = leaf(b.dir, "outer", `return await workflow(${JSON.stringify(inner)}, {})`)
    await assert.rejects(runBody(b, `return await workflow(${JSON.stringify(outer)}, {})`), /one level deep/)
  } finally {
    b.cleanup()
  }
})

test("unknown refs fail loudly (registry miss and missing file)", async () => {
  const b = build()
  try {
    await assert.rejects(runBody(b, `return await workflow("no-such-workflow-xyz", {})`), /no-such-workflow-xyz/)
    await assert.rejects(runBody(b, `return await workflow("./missing-leaf.js", {})`), /not found/)
  } finally {
    b.cleanup()
  }
})

test("sequential identical calls stay distinct; different args stay distinct", async () => {
  const b = build()
  try {
    const lf = leaf(b.dir, "args-leaf", `const a = await agent("w")\nreturn args.n`)
    const out = (await runBody(
      b,
      `const a = await workflow(${JSON.stringify(lf)}, { n: 1 })\n` +
        `const c = await workflow(${JSON.stringify(lf)}, { n: 1 })\n` +
        `const d = await workflow(${JSON.stringify(lf)}, { n: 2 })\n` +
        `return [a, c, d]`,
    )) as number[]
    looseDeepEqual(out, [1, 1, 2])
    // Same args twice = two separate executions (the call index is in the lineage);
    // different args = different namespace (args hash is in the lineage).
    assert.equal(b.worker.calls.length, 3)
  } finally {
    b.cleanup()
  }
})

test("resume replays an unchanged subtree; a leaf edit re-runs it", async () => {
  const b1 = build({ runId: "run_resume" })
  try {
    const lf = leaf(b1.dir, "stable-leaf", `const a = await agent("v1")\nreturn a`)
    const body = `return await workflow(${JSON.stringify(lf)}, {})`
    const r1 = await runBody(b1, body)
    assert.equal(r1, "echo:v1")
    assert.equal(b1.worker.calls.length, 1)

    // Same everything → full replay, worker silent.
    process.env.OMEGACODE_HOME = b1.home
    const loaded = Journal.load("run_resume")
    const b2 = build({ runId: "run_resume", loaded, home: b1.home, dir: b1.dir })
    try {
      const r2 = await runBody(b2, body)
      assert.equal(r2, "echo:v1")
      assert.equal(b2.worker.calls.length, 0)
    } finally {
      b2.cleanup()
    }

    // Same ref, edited leaf (new file hash) → cache misses, worker runs again.
    writeFileSync(lf, `export const meta = { name: "stable-leaf", description: "leaf" }\nconst a = await agent("v2")\nreturn a\n`)
    process.env.OMEGACODE_HOME = b1.home
    const loaded2 = Journal.load("run_resume")
    const b3 = build({ runId: "run_resume", loaded: loaded2, home: b1.home, dir: b1.dir })
    try {
      const r3 = await runBody(b3, body)
      assert.equal(r3, "echo:v2")
      assert.equal(b3.worker.calls.length, 1)
    } finally {
      b3.cleanup()
    }
  } finally {
    b1.cleanup()
  }
})

test("shared budget: leaf spend counts against the parent ceiling", async () => {
  const b = build({ defaults: { budget: 1 } })
  try {
    const lf = leaf(b.dir, "spendy-leaf", `const a = await agent("one")\nreturn a`)
    // Parent agent spends the single token; the leaf's admission then exceeds the ceiling.
    await assert.rejects(
      runBody(b, `const p = await agent("parent")\nreturn await workflow(${JSON.stringify(lf)}, {})`),
      /token budget exceeded/,
    )
  } finally {
    b.cleanup()
  }
})

test("workflow({schema}) validates the child result, no retry on mismatch", async () => {
  const b = build()
  try {
    const lf = leaf(b.dir, "shaped-leaf", `return { n: 3 }`)
    const schema = { type: "object", properties: { n: { type: "number" } }, required: ["n"] }
    const ok = await runBody(b, `return await workflow(${JSON.stringify(lf)}, {}, { schema: ${JSON.stringify(schema)} })`)
    looseDeepEqual(ok, { n: 3 })
    const badSchema = { type: "object", properties: { n: { type: "string" } }, required: ["n"] }
    await assert.rejects(
      runBody(b, `return await workflow(${JSON.stringify(lf)}, {}, { schema: ${JSON.stringify(badSchema)} })`),
      /failed schema/,
    )
  } finally {
    b.cleanup()
  }
})

test("leaf meta defaults override the subtree (effort observed by the worker)", async () => {
  const b = build()
  try {
    const lf = leaf(b.dir, "effort-leaf", `const a = await agent("x")\nreturn a`, `, defaultEffort: "xhigh"`)
    await runBody(b, `return await workflow(${JSON.stringify(lf)}, {})`)
    assert.equal(b.worker.calls[0]!.effort, "xhigh")
  } finally {
    b.cleanup()
  }
})
