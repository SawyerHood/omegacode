// End-to-end budget-exhaustion semantics through runWorkflow (fake worker): a fan-out that runs
// out of budget COMPLETES with partial results (over-budget branches null, siblings survive),
// while a bare top-level breach rejects the whole run. Both outcomes now persist a machine-readable
// result.json so tooling can read the verdict instead of scraping the thrown message. Complements
// the unit-level fan-out semantics in primitives.test.ts.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runWorkflow } from "../src/runtime/run.ts"

function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "omega-budget-"))
  const prev = process.env.OMEGACODE_HOME
  process.env.OMEGACODE_HOME = home
  return fn(home).finally(() => {
    if (prev === undefined) delete process.env.OMEGACODE_HOME
    else process.env.OMEGACODE_HOME = prev
    rmSync(home, { recursive: true, force: true })
  })
}

const META = `export const meta = { name: "t", description: "budget test" }\n`

test("e2e: a fan-out that exhausts its budget COMPLETES with partial results", async () => {
  await withHome(async (home) => {
    const file = join(home, "wf.js")
    // concurrency 1 so admissions are FIFO: the first agent spends past the tiny ceiling, then every
    // queued sibling breaches at admission and nulls. The run must still finish "completed".
    writeFileSync(file, META + `return await parallel([() => agent("a"), () => agent("b"), () => agent("c")])`)
    const events: Array<Record<string, unknown>> = []
    const outcome = await runWorkflow({
      file,
      fake: true,
      quiet: true,
      overrides: { budget: 1, concurrency: 1 },
      onEvent: (e) => events.push(e as unknown as Record<string, unknown>),
    })
    assert.equal(outcome.status, "completed", "an exhausted fan-out aborted the run instead of degrading to nulls")
    const result = outcome.result as unknown[]
    assert.equal(result.length, 3)
    // budget 1 with a non-empty first output: exactly one branch runs, the rest null.
    assert.equal(typeof result[0], "string")
    assert.equal(result[1], null)
    assert.equal(result[2], null)
    // The ceiling is hard: exactly one agent reached "done"; the others emitted a terminal "skipped".
    const done = events.filter((e) => e.type === "agent" && e.state === "done")
    const skipped = events.filter((e) => e.type === "agent" && e.state === "skipped")
    assert.equal(done.length, 1, "an agent was admitted past the budget ceiling")
    assert.equal(skipped.length, 2)
    // The completed run's result.json holds the bare partial array (unchanged success shape).
    assert.deepEqual(JSON.parse(readFileSync(join(home, "runs", outcome.runId, "result.json"), "utf8")), result)
  })
})

test("e2e: a bare top-level budget breach fails the run and writes result.json with the error", async () => {
  await withHome(async (home) => {
    const file = join(home, "wf.js")
    // Not inside a fan-out: the second agent's breach has no catch, so it rejects the whole run.
    writeFileSync(file, META + `await agent("one"); return await agent("two")`)
    const outcome = await runWorkflow({ file, fake: true, quiet: true, overrides: { budget: 1 } })
    assert.equal(outcome.status, "failed")
    assert.match(outcome.error ?? "", /budget/)
    // The failed run persists a {status, error} envelope so tooling reads a verdict, not a thrown string.
    const written = JSON.parse(readFileSync(join(home, "runs", outcome.runId, "result.json"), "utf8"))
    assert.equal(written.status, "failed")
    assert.match(written.error, /budget/)
  })
})

test("e2e: resuming a budget-exhausted COMPLETED fan-out replays the identical partial array", async () => {
  // Determinism/journal-replay guard for the per-branch-null feature: a completed run with partial
  // results must resume to the SAME partial array. The one admitted branch is journaled COMPLETED,
  // so on resume its cache-hit short-circuits BEFORE the in-slot budget check — it is never
  // re-decided. The budget-skipped branches carry no journal entry and re-run, but the completed
  // branch's usage front-loads synchronously during parallel()'s map (cache-hits add usage before
  // any fresh branch's deferred sem.run body checks the budget), so spent >= ceiling at their
  // admission and they re-skip. The partial array is therefore identical across resume — refuting
  // the "over-budget fan-out is non-replayable across resume" concern for the documented
  // completed-run case (a completed branch's terminal result is always journal-stable; nothing is
  // journaled as a budget-skip, so no journaled outcome can flip on resume).
  await withHome(async (home) => {
    const file = join(home, "wf.js")
    writeFileSync(file, META + `return await parallel([() => agent("a"), () => agent("b"), () => agent("c")])`)
    const first = await runWorkflow({ file, fake: true, quiet: true, overrides: { budget: 1, concurrency: 1 } })
    assert.equal(first.status, "completed")
    const firstResult = first.result as unknown[]
    assert.equal(typeof firstResult[0], "string")
    assert.equal(firstResult[1], null)
    assert.equal(firstResult[2], null)
    // Resume the SAME run id with the same file/args/budget.
    const second = await runWorkflow({
      file,
      fake: true,
      quiet: true,
      overrides: { budget: 1, concurrency: 1 },
      resumeRunId: first.runId,
    })
    assert.equal(second.status, "completed", "resuming a budget-exhausted completed run diverged from a clean completion")
    assert.deepEqual(second.result, firstResult, "resume produced a different partial-result set — over-budget fan-out was non-replayable")
    // result.json is overwritten with the same partial array (the success shape).
    assert.deepEqual(JSON.parse(readFileSync(join(home, "runs", second.runId, "result.json"), "utf8")), firstResult)
  })
})
