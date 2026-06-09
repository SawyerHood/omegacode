// Acceptance tests for the per-branch key-lineage fix (C1) + resume preconditions (rec #4).
//
// The headline test (report rec #2/#3): a parallel() workflow whose branches complete in a
// DELIBERATELY STAGGERED, run-to-run-DIFFERENT order must still get 100% cache hits on resume.
// Under the old global-prevKey design the journal key of each agent chained off whichever sibling
// finished first, so a different completion order on resume reshuffled every key → cache misses and
// silent re-billing. With per-branch lineage the key depends only on call-tree position, so the
// completion order is irrelevant.

import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Runtime } from "../src/runtime/primitives.ts"
import { runWorkflow } from "../src/runtime/run.ts"
import { Journal, JournalNotFoundError, ResumePreconditionError, type LoadedJournal } from "../src/runtime/journal.ts"
import { runInSandbox } from "../src/runtime/sandbox.ts"
import type { EventSink, WorkflowEventInput } from "../src/runtime/events.ts"
import type { Worker, WorkerContext, WorkerFactory } from "../src/worker/index.ts"
import { DEFAULTS, emptyUsage, type AgentResult, type AgentSpec, type RunDefaults } from "../src/dsl/types.ts"

// ---- harness ---------------------------------------------------------------------------------

/** A worker whose per-prompt completion delay is controllable, so we can force a completion order. */
class StaggeredWorker implements Worker {
  readonly id = "codex" as const
  calls: string[] = []
  constructor(
    private readonly delayFor: (prompt: string) => number,
    /** Optional per-call result override (return undefined for the default echo). */
    private readonly respond?: (prompt: string) => AgentResult | undefined,
  ) {}
  async runAgent(spec: AgentSpec, _ctx: WorkerContext): Promise<AgentResult> {
    this.calls.push(spec.prompt)
    const ms = this.delayFor(spec.prompt)
    if (ms > 0) await new Promise((r) => setTimeout(r, ms))
    return this.respond?.(spec.prompt) ?? { text: `done:${spec.prompt}`, status: "completed", usage: { ...emptyUsage(), outputTokens: 1 } }
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

interface RunResult {
  out: unknown
  loaded: LoadedJournal
  worker: StaggeredWorker
  sink: MemSink
}

/**
 * Run a workflow body against a fresh runtime sharing the given run id (so resume reads the journal
 * appended by a prior call). `delayFor` controls per-prompt completion latency.
 */
async function runOnce(
  home: string,
  runId: string,
  body: string,
  delayFor: (p: string) => number,
  resume: boolean,
  opts: { overrides?: Partial<RunDefaults>; respond?: (prompt: string) => AgentResult | undefined } = {},
): Promise<RunResult> {
  const loaded: LoadedJournal = resume ? Journal.load(runId) : { results: new Map(), indexByKey: new Map() }
  const worker = new StaggeredWorker(delayFor, opts.respond)
  const sink = new MemSink()
  const journal = new Journal(runId)
  const runtime = new Runtime({
    runId,
    defaults: defaults(opts.overrides),
    factory: new SingleFactory(worker),
    journal,
    loaded,
    events: sink,
    args: undefined,
    seed: 42,
    baseTimeMs: 1_000_000,
    signal: new AbortController().signal,
  })
  const out = await runInSandbox({ body, filename: "wf.js", globals: runtime.globals() })
  await runtime.settle()
  return { out, loaded: Journal.load(runId), worker, sink }
}

function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "omega-resume-"))
  const prev = process.env.OMEGACODE_HOME
  process.env.OMEGACODE_HOME = home
  return fn(home).finally(() => {
    if (prev === undefined) delete process.env.OMEGACODE_HOME
    else process.env.OMEGACODE_HOME = prev
    rmSync(home, { recursive: true, force: true })
  })
}

const PARALLEL_BODY = `return await parallel([
  () => agent("alpha"),
  () => agent("beta"),
  () => agent("gamma"),
  () => agent("delta"),
])`

// Two agents PER branch: the second agent in each branch is submitted only AFTER the first one in
// that branch completes. Under the old global prevKey, the SUBMIT ORDER of the second agents is
// therefore determined by COMPLETION order — so a different completion order on resume reshuffles
// their keys → cache misses. This is the exact pattern the C1 fix targets.
const STAGGERED_BODY = `return await parallel([
  async () => { const a = await agent("alpha1"); return await agent("alpha2:" + a) },
  async () => { const b = await agent("beta1"); return await agent("beta2:" + b) },
  async () => { const c = await agent("gamma1"); return await agent("gamma2:" + c) },
  async () => { const d = await agent("delta1"); return await agent("delta2:" + d) },
])`

// ---- ACCEPTANCE: staggered parallel resume → 100% cache hits ----------------------------------

test("ACCEPTANCE (C1): parallel() with staggered completion resumes at 100% cache hits", async () => {
  await withHome(async (home) => {
    const runId = "wf_stagger"
    // First run: the FIRST-stage agents complete in reverse-submit order (delta1, gamma1, ...),
    // which (under the buggy design) decides the submit/key order of the SECOND-stage agents.
    const order1 = (p: string): number => (p.endsWith("1") ? { alpha1: 40, beta1: 30, gamma1: 20, delta1: 10 }[p] ?? 0 : 0)
    const first = await runOnce(home, runId, STAGGERED_BODY, order1, false)
    assert.equal(first.worker.calls.length, 8) // 4 branches x 2 stages

    // Resume with the OPPOSITE first-stage completion order. With the old completion-ordered global
    // prevKey, the second-stage agents' keys would not match the journal → every one re-runs. With
    // per-branch lineage the keys depend only on (branch, position), so all 8 are cache hits.
    const order2 = (p: string): number => (p.endsWith("1") ? { alpha1: 10, beta1: 20, gamma1: 30, delta1: 40 }[p] ?? 0 : 0)
    const second = await runOnce(home, runId, STAGGERED_BODY, order2, true)
    assert.equal(second.worker.calls.length, 0, "resume re-ran agents — cache miss (the C1 bug)")
    assert.deepEqual(JSON.parse(JSON.stringify(first.out)), JSON.parse(JSON.stringify(second.out)))

    // every replayed agent event is flagged cached (8 total)
    const cached = second.sink.events.filter((e) => e.type === "agent" && e.state === "done" && (e as { cached?: boolean }).cached)
    assert.equal(cached.length, 8)
  })
})

test("ACCEPTANCE: nested parallel-in-pipeline resumes at 100% cache hits despite staggering", async () => {
  await withHome(async (home) => {
    const runId = "wf_nested"
    const body = `return await pipeline([1, 2],
      async (n) => await parallel([() => agent("p" + n + "a"), () => agent("p" + n + "b")]),
    )`
    const first = await runOnce(home, runId, body, (p) => (p.endsWith("a") ? 30 : 5), false)
    assert.equal(first.worker.calls.length, 4)

    // resume with inverted staggering
    const second = await runOnce(home, runId, body, (p) => (p.endsWith("a") ? 5 : 30), true)
    assert.equal(second.worker.calls.length, 0, "nested resume re-ran agents")
    assert.deepEqual(JSON.parse(JSON.stringify(first.out)), JSON.parse(JSON.stringify(second.out)))
  })
})

// ---- proof the OLD design is order-dependent (documents WHY C1 was a bug) ----------------------

test("the OLD global-prevKey scheme produces DIFFERENT keys under different completion order", () => {
  // Reproduces the v1 algorithm: a single mutable prevKey advanced in COMPLETION order.
  const V = "v1"
  const oldChain = (prev: string, prompt: string): string =>
    createHash("sha256").update(V).update(prev).update("\0").update(prompt).update("\0").digest("hex")

  const keysInOrder = (completionOrder: string[]): string[] => {
    let prev = "root"
    const keys: string[] = []
    for (const prompt of completionOrder) {
      prev = oldChain(prev, prompt)
      keys.push(prev)
    }
    return keys
  }

  // Same set of agents, two different completion orders (as concurrency would produce).
  const a = keysInOrder(["alpha", "beta", "gamma", "delta"])
  const b = keysInOrder(["delta", "gamma", "beta", "alpha"])
  // The multiset of keys differs → on resume, lookups miss → re-billing. This is the C1 bug.
  assert.notDeepEqual([...a].sort(), [...b].sort())
})

test("the NEW per-branch scheme is INVARIANT to completion order (keys depend on position only)", async () => {
  await withHome(async (home) => {
    // Run twice in two fresh run ids with opposite completion staggering; the journaled key SETS
    // must be identical because keys depend on call-tree position, not completion order.
    const a = await runOnce(home, "wf_a", PARALLEL_BODY, (p) => ({ alpha: 40, beta: 30, gamma: 20, delta: 10 })[p] ?? 0, false)
    const b = await runOnce(home, "wf_b", PARALLEL_BODY, (p) => ({ alpha: 10, beta: 20, gamma: 30, delta: 40 })[p] ?? 0, false)
    assert.deepEqual([...a.loaded.results.keys()].sort(), [...b.loaded.results.keys()].sort())
  })
})

// ---- C1 regression: repeated identical fan-outs in one branch must not collide -----------------
// v2's branch keys were hash(parent, kind, thunkIndex) with nothing advancing per-branch state
// across sibling fan-out CALLS, so two sequential identical parallel()/pipeline() calls derived
// identical child lineages → one journal slot for two live agents → wrong-result replay on resume.

test("C1 regression: two sequential identical parallel() calls journal distinct keys and replay their OWN results", async () => {
  await withHome(async (home) => {
    const runId = "wf_refanout"
    const body = `const r1 = await parallel([() => agent("same prompt")])
const r2 = await parallel([() => agent("same prompt")])
return [r1[0], r2[0]]`
    // Stamp each live call so a wrong-slot replay is visible in the output.
    let n = 0
    const first = await runOnce(home, runId, body, () => 0, false, {
      respond: () => ({ text: `run1:${n++}`, status: "completed", usage: { ...emptyUsage(), outputTokens: 1 } }),
    })
    assert.equal(first.worker.calls.length, 2)
    // Two live agents → two journal slots. Under the v2 collision this was 1 (last-write-wins).
    assert.equal(first.loaded.results.size, 2, "identical re-issued fan-outs collided on one journal key")
    assert.deepEqual(JSON.parse(JSON.stringify(first.out)), ["run1:0", "run1:1"])

    // Resume: both replay from cache, each its OWN result. Under the collision, resume returned
    // the second call's result for BOTH positions (["run1:1", "run1:1"]).
    const second = await runOnce(home, runId, body, () => 0, true, {
      respond: () => ({ text: "run2:LIVE", status: "completed", usage: emptyUsage() }),
    })
    assert.equal(second.worker.calls.length, 0, "re-issued identical fan-out re-ran on resume")
    assert.deepEqual(JSON.parse(JSON.stringify(second.out)), ["run1:0", "run1:1"])
  })
})

test("C1 regression: two sequential identical pipeline() calls journal distinct keys and replay their OWN results", async () => {
  await withHome(async (home) => {
    const runId = "wf_repipe"
    const body = `const a = await pipeline(["x"], async (p) => await agent("stage:" + p))
const b = await pipeline(["x"], async (p) => await agent("stage:" + p))
return [a[0], b[0]]`
    let n = 0
    const first = await runOnce(home, runId, body, () => 0, false, {
      respond: () => ({ text: `run1:${n++}`, status: "completed", usage: { ...emptyUsage(), outputTokens: 1 } }),
    })
    assert.equal(first.worker.calls.length, 2)
    assert.equal(first.loaded.results.size, 2, "identical re-issued pipelines collided on one journal key")

    const second = await runOnce(home, runId, body, () => 0, true)
    assert.equal(second.worker.calls.length, 0)
    assert.deepEqual(JSON.parse(JSON.stringify(second.out)), ["run1:0", "run1:1"])
  })
})

test("C1 regression: a loop-until-dry pattern re-issuing the same fan-out per round resumes at 100% cache hits", async () => {
  await withHome(async (home) => {
    const runId = "wf_dryloop"
    const body = `const rounds = []
for (let i = 0; i < 3; i++) {
  const found = await parallel([() => agent("probe")])
  rounds.push(found[0])
}
return rounds`
    let n = 0
    const first = await runOnce(home, runId, body, () => 0, false, {
      respond: () => ({ text: `round${n++}`, status: "completed", usage: { ...emptyUsage(), outputTokens: 1 } }),
    })
    assert.equal(first.worker.calls.length, 3)
    assert.equal(first.loaded.results.size, 3)
    assert.deepEqual(JSON.parse(JSON.stringify(first.out)), ["round0", "round1", "round2"])

    const second = await runOnce(home, runId, body, () => 0, true)
    assert.equal(second.worker.calls.length, 0, "per-round identical fan-outs re-ran on resume")
    assert.deepEqual(JSON.parse(JSON.stringify(second.out)), ["round0", "round1", "round2"])
  })
})

// ---- L12 regression: journal-stable indices keep transcripts associated across attempts --------
// Transcripts are agents/<index>.jsonl — the address the server/viewer resolve from agent events.
// The index must therefore be stable per logical agent across resume attempts: a purely positional
// index shifts with submit order (cached replays resolve instantly), making a re-run truncate a
// DIFFERENT agent's transcript and leaving events pointing at the wrong files.

test("L12 regression: resume reuses journaled indices — a re-run truncates only its OWN transcript", async () => {
  await withHome(async (home) => {
    const runId = "wf_transcripts"
    const body = `return await parallel([
  async () => { await agent("a1"); return await agent("a2") },
  async () => { await agent("b1"); return await agent("b2") },
])`
    // First run: a1 completes LAST (60ms), so the second-stage submit order is b2 then a2:
    // indices a1=1, b1=2, b2=3, a2=4. a2 FAILS, so it (and only it) re-runs on resume.
    const first = await runOnce(home, runId, body, (p) => (p === "a1" ? 60 : 0), false, {
      respond: (p) => (p === "a2" ? { text: "boom", status: "failed", usage: emptyUsage() } : undefined),
    })
    const firstIdx = new Map(
      first.sink.events
        .filter((e) => e.type === "agent" && e.state === "queued")
        .map((e) => [(e as { promptPreview?: string }).promptPreview, (e as { index: number }).index]),
    )
    assert.deepEqual(
      [firstIdx.get("a1"), firstIdx.get("b1"), firstIdx.get("b2"), firstIdx.get("a2")],
      [1, 2, 3, 4],
      "precondition: first-run submit order should interleave the branches",
    )

    // Resume: a1/b1/b2 replay from cache; a2 re-runs. WITHOUT index reuse a2 would be (re)submitted
    // BEFORE b2's cached replay and claim index 3 — truncating b2's transcript (flags "w") while
    // b2's cached event pointed at a2's stale file. With reuse, every agent keeps its index.
    const second = await runOnce(home, runId, body, () => 0, true)
    assert.deepEqual(second.worker.calls, ["a2"], "only the journaled failure should re-run")

    const metaOf = (i: number) =>
      JSON.parse(readFileSync(join(home, "runs", runId, "agents", `${i}.jsonl`), "utf8").split("\n")[0]!) as { prompt: string }
    assert.equal(metaOf(1).prompt, "a1")
    assert.equal(metaOf(2).prompt, "b1")
    assert.equal(metaOf(3).prompt, "b2", "the re-run truncated an unrelated agent's transcript (L12)")
    assert.equal(metaOf(4).prompt, "a2")

    // Event ↔ file association holds for the resumed attempt: cached b2 still advertises index 3,
    // and the re-run a2 advertises index 4 — exactly where their transcripts live.
    const done = second.sink.events.filter((e) => e.type === "agent" && e.state === "done") as Array<{
      label: string
      index: number
      cached?: boolean
    }>
    assert.equal(done.find((e) => e.label === "b2")?.index, 3)
    assert.equal(done.find((e) => e.label === "b2")?.cached, true)
    assert.equal(done.find((e) => e.label === "a2")?.index, 4)
  })
})

// ---- resume preconditions / replay honoring ---------------------------------------------------

test("resume re-runs only the CHANGED suffix when one branch's prompt changes", async () => {
  await withHome(async (home) => {
    const runId = "wf_partial"
    await runOnce(home, runId, PARALLEL_BODY, () => 0, false)
    // change only the third branch's prompt; the other three must still be cache hits.
    const changed = `return await parallel([
      () => agent("alpha"),
      () => agent("beta"),
      () => agent("CHANGED"),
      () => agent("delta"),
    ])`
    const second = await runOnce(home, runId, changed, () => 0, true)
    assert.deepEqual(second.worker.calls, ["CHANGED"]) // only the edited branch re-ran
  })
})

test("sequential resume is a full cache hit (sanity)", async () => {
  await withHome(async (home) => {
    const runId = "wf_seq"
    const body = `const a = await agent("one"); const b = await agent("two:" + a); return b`
    const first = await runOnce(home, runId, body, () => 0, false)
    assert.equal(first.worker.calls.length, 2)
    const second = await runOnce(home, runId, body, () => 0, true)
    assert.equal(second.worker.calls.length, 0)
  })
})

// ---- runWorkflow-level: resume preconditions, unknown run ids, invalid concurrency ------------

const WF = `export const meta = { name: "t", description: "test workflow" }
return await parallel([() => agent("one"), () => agent("two")])`

interface E2E {
  outcome: Awaited<ReturnType<typeof runWorkflow>>
  cachedCount: number
  ranCount: number
}

async function runFile(file: string, opts: { resume?: string; args?: unknown; concurrency?: number } = {}): Promise<E2E> {
  const events: Array<Record<string, unknown>> = []
  const outcome = await runWorkflow({
    file,
    args: opts.args,
    fake: true,
    quiet: true,
    resumeRunId: opts.resume,
    overrides: opts.concurrency !== undefined ? { concurrency: opts.concurrency } : undefined,
    onEvent: (e) => events.push(e as unknown as Record<string, unknown>),
  })
  const done = events.filter((e) => e.type === "agent" && e.state === "done")
  return {
    outcome,
    cachedCount: done.filter((e) => e.cached).length,
    ranCount: done.filter((e) => !e.cached).length,
  }
}

test("e2e: runWorkflow --resume replays a fake run at 100% cache hits", async () => {
  await withHome(async (home) => {
    const file = join(home, "wf.js")
    writeFileSync(file, WF)
    const first = await runFile(file)
    assert.equal(first.outcome.status, "completed")
    assert.equal(first.ranCount, 2)
    assert.equal(first.cachedCount, 0)

    const second = await runFile(file, { resume: first.outcome.runId })
    assert.equal(second.outcome.status, "completed")
    assert.equal(second.outcome.runId, first.outcome.runId)
    assert.equal(second.ranCount, 0, "resume re-ran agents instead of replaying")
    assert.equal(second.cachedCount, 2)
    assert.deepEqual(second.outcome.result, first.outcome.result)
  })
})

test("M21: resuming an unknown run id fails loudly and names known runs", async () => {
  await withHome(async (home) => {
    const file = join(home, "wf.js")
    writeFileSync(file, WF)
    const real = await runFile(file)
    await assert.rejects(
      runFile(file, { resume: "wf_typo" }),
      (e: unknown) =>
        e instanceof JournalNotFoundError &&
        e.runId === "wf_typo" &&
        e.message.includes(real.outcome.runId),
    )
    // and it must NOT have minted a fresh run under the typo'd id
    assert.equal(Journal.exists("wf_typo"), false)
  })
})

test("rec #4: resume rejects when the workflow file changed (fileHash precondition)", async () => {
  await withHome(async (home) => {
    const file = join(home, "wf.js")
    writeFileSync(file, WF)
    const first = await runFile(file)
    writeFileSync(file, WF + `\n// edited`)
    await assert.rejects(runFile(file, { resume: first.outcome.runId }), ResumePreconditionError)
  })
})

test("rec #4: resume rejects when args changed", async () => {
  await withHome(async (home) => {
    const file = join(home, "wf.js")
    writeFileSync(file, WF)
    const first = await runFile(file, { args: { topic: "a" } })
    await assert.rejects(runFile(file, { resume: first.outcome.runId, args: { topic: "b" } }), ResumePreconditionError)
    // unchanged args resume fine
    const ok = await runFile(file, { resume: first.outcome.runId, args: { topic: "a" } })
    assert.equal(ok.cachedCount, 2)
  })
})

test("M13 e2e: aborting a run interrupts a workflow hung after its first await (finally still runs)", async () => {
  await withHome(async (home) => {
    const file = join(home, "hang.js")
    writeFileSync(
      file,
      `export const meta = { name: "hang", description: "hangs after the first await" }
await agent("one")
await new Promise(() => {})`,
    )
    const events: Array<Record<string, unknown>> = []
    const ac = new AbortController()
    // Abort once the first agent is done — the body is then parked on the forever-pending await,
    // which the vm sync timeout cannot bound. Only the signal threaded into runInSandbox can.
    const onEvent = (e: unknown): void => {
      const ev = e as Record<string, unknown>
      events.push(ev)
      if (ev.type === "agent" && ev.state === "done") setTimeout(() => ac.abort(), 20)
    }
    const run = runWorkflow({ file, fake: true, quiet: true, signal: ac.signal, onEvent })
    // A regression here means runWorkflow never settles; fail loudly instead of hanging the suite.
    const guard = new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error("runWorkflow hung after abort — the signal is not wired into runInSandbox (M13)")), 10_000)
      t.unref()
    })
    const outcome = await Promise.race([run, guard])
    assert.equal(outcome.status, "interrupted")
    // the finally ran: the terminal run event reached the sink before events.close()
    assert.ok(
      events.some((e) => e.type === "run" && e.status === "interrupted"),
      "no terminal run event — the run's finally never executed",
    )
  })
})

test("H14: an invalid meta.defaultSandbox fails the run at startup (no silent policy bypass)", async () => {
  await withHome(async (home) => {
    const file = join(home, "wf.js")
    writeFileSync(
      file,
      `export const meta = { name: "t", description: "d", defaultSandbox: "readonly" }
return await agent("one")`,
    )
    await assert.rejects(runFile(file), /invalid sandbox "readonly"/)
  })
})

test("H14: an invalid meta.defaultProvider fails the run at startup", async () => {
  await withHome(async (home) => {
    const file = join(home, "wf.js")
    writeFileSync(
      file,
      `export const meta = { name: "t", description: "d", defaultProvider: "open-code" }
return await agent("one")`,
    )
    await assert.rejects(runFile(file), /invalid provider "open-code"/)
  })
})

test("rec #4: a v1 journal (meta WITHOUT keyVersion) is rejected on resume", async () => {
  await withHome(async (home) => {
    const file = join(home, "wf.js")
    writeFileSync(file, WF)
    const first = await runFile(file)
    // Rewrite the journal meta as a baseline v1 journal — the keyVersion field did not exist yet.
    // Resuming it would silently miss 100% of keys and re-bill the whole run (the C1 failure mode).
    const loaded = Journal.load(first.outcome.runId)
    const { keyVersion: _dropped, ...v1Meta } = loaded.meta!
    const { journalPath } = await import("../src/runtime/journal.ts")
    writeFileSync(journalPath(first.outcome.runId), JSON.stringify(v1Meta) + "\n")
    await assert.rejects(runFile(file, { resume: first.outcome.runId }), ResumePreconditionError)
  })
})

test("rec #4: resume rejects a journal written under a different KEY_VERSION", async () => {
  await withHome(async (home) => {
    const file = join(home, "wf.js")
    writeFileSync(file, WF)
    const first = await runFile(file)
    // rewrite the journal meta as if it came from the old v1 scheme
    const loaded = Journal.load(first.outcome.runId)
    const meta = { ...loaded.meta!, keyVersion: "v1" }
    const { journalPath } = await import("../src/runtime/journal.ts")
    writeFileSync(journalPath(first.outcome.runId), JSON.stringify(meta) + "\n")
    await assert.rejects(runFile(file, { resume: first.outcome.runId }), ResumePreconditionError)
  })
})

test("M12: invalid concurrency fails fast instead of hanging the run", async () => {
  await withHome(async (home) => {
    const file = join(home, "wf.js")
    writeFileSync(file, WF)
    await assert.rejects(runFile(file, { concurrency: 0 }), /invalid concurrency/)
    await assert.rejects(runFile(file, { concurrency: NaN }), /invalid concurrency/)
    await assert.rejects(runFile(file, { concurrency: 1.5 }), /invalid concurrency/)
    // a valid value still runs
    const ok = await runFile(file, { concurrency: 2 })
    assert.equal(ok.outcome.status, "completed")
  })
})

test("a journaled failure in a parallel branch re-runs on resume (rec #4)", async () => {
  await withHome(async (home) => {
    const runId = "wf_fail"
    // first run: 'beta' fails (worker throws → parallel nulls it, journal records FAILED).
    const failWorkerBody = PARALLEL_BODY
    const loaded: LoadedJournal = { results: new Map(), indexByKey: new Map() }
    const journal = new Journal(runId)
    let calls: string[] = []
    const runtime = new Runtime({
      runId,
      defaults: defaults(),
      factory: new SingleFactory({
        id: "codex",
        async runAgent(spec) {
          calls.push(spec.prompt)
          if (spec.prompt === "beta") return { text: "", status: "failed", usage: emptyUsage() }
          return { text: "ok:" + spec.prompt, status: "completed", usage: emptyUsage() }
        },
        async shutdown() {},
      }),
      journal,
      loaded,
      events: new MemSink(),
      args: undefined,
      seed: 1,
      baseTimeMs: 1,
      signal: new AbortController().signal,
    })
    await runInSandbox({ body: failWorkerBody, filename: "wf.js", globals: runtime.globals() })
    await runtime.settle()
    const after = Journal.load(runId)
    const beta = [...after.results.values()].find((r) => r.status === "failed")
    assert.ok(beta, "expected a journaled FAILED result for beta")

    // resume: only beta must re-run (its failure must not replay as success).
    const second = await runOnce(home, runId, PARALLEL_BODY, () => 0, true)
    assert.deepEqual(second.worker.calls, ["beta"])
  })
})
