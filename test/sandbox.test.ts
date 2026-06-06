import { after, test } from "node:test"
import assert from "node:assert/strict"
import {
  parseWorkflow,
  runInSandbox,
  WorkflowSyntaxError,
  WorkflowAbortedError,
  WorkflowTimeoutError,
} from "../src/runtime/sandbox.ts"
import type { WorkflowGlobals } from "../src/dsl/types.ts"

// The execTimeoutMs tests await a rejection driven by an UNREF'D timer (sandbox.ts) while the
// runaway workflow holds no live handles, so nothing keeps the event loop referenced. node:test
// on Node 20/22 drains the loop mid-await and cancels the rest of the file; Node 24+ pins the
// loop itself. A ref'd keep-alive makes the file behave identically on every supported line.
const keepAlive = setInterval(() => {}, 60_000)
after(() => clearInterval(keepAlive))

function fakeGlobals(over: Partial<WorkflowGlobals> = {}): WorkflowGlobals {
  return {
    agent: (async () => "x") as WorkflowGlobals["agent"],
    parallel: (async (ts) => Promise.all(ts.map((t) => t()))) as WorkflowGlobals["parallel"],
    pipeline: (async (items) => items) as WorkflowGlobals["pipeline"],
    phase: () => {},
    log: () => {},
    now: () => 0,
    random: () => 0,
    budget: { total: null, spent: () => 0, remaining: () => Infinity },
    args: undefined,
    ...over,
  }
}

test("parseWorkflow extracts a leading meta literal and returns the body", () => {
  const src = `export const meta = { name: "n", description: "d" }\nconst x = 1\nreturn x\n`
  const { meta, body } = parseWorkflow(src)
  assert.equal(meta.name, "n")
  assert.equal(meta.description, "d")
  assert.match(body, /const x = 1/)
  assert.match(body, /return x/)
})

test("parseWorkflow allows leading line and block comments before meta", () => {
  const src = `// a leading comment\n/* block\n comment */\nexport const meta = { name: "n", description: "d" }\nreturn 1\n`
  const { meta } = parseWorkflow(src)
  assert.equal(meta.name, "n")
})

test("M14: code before a non-leading meta is rejected, never silently discarded", () => {
  const src = `const sneaky = doSomething()\nexport const meta = { name: "n", description: "d" }\nreturn 1\n`
  assert.throws(() => parseWorkflow(src), WorkflowSyntaxError)
})

test("M14: meta must exist at all", () => {
  assert.throws(() => parseWorkflow(`return 1\n`), WorkflowSyntaxError)
})

test("M15: body content keeps its original 1-based line numbers", () => {
  // meta on line 1, blank line 2, target content on line 3.
  const src = `export const meta = { name: "n", description: "d" }\n\nconst marker = 1\n`
  const { body } = parseWorkflow(src)
  const lines = body.split("\n")
  // line 3 (index 2) must hold the marker, with blanks preserving line 1 + 2.
  assert.equal(lines[2], "const marker = 1")
  assert.equal(lines[0], "")
  assert.equal(lines[1], "")
})

test("M15: a multi-line meta literal still preserves downstream line numbers", () => {
  const src = `export const meta = {\n  name: "n",\n  description: "d",\n}\nconst onLineFive = 5\n`
  const { body } = parseWorkflow(src)
  const lines = body.split("\n")
  assert.equal(lines[4], "const onLineFive = 5")
})

test("M15: runtime stack trace reports the true workflow line number", async () => {
  // meta(1), blank(2), throw on line 3.
  const src = `export const meta = { name: "n", description: "d" }\n\nthrow new Error("boom")\n`
  const { body } = parseWorkflow(src)
  let caught: Error | undefined
  try {
    await runInSandbox({ body, filename: "wf.js", globals: fakeGlobals() })
  } catch (e) {
    caught = e as Error
  }
  assert.ok(caught)
  assert.match(caught!.message, /boom/)
  assert.match(caught!.stack ?? "", /wf\.js:3/)
})

test("meta must be an object literal with name/description", () => {
  assert.throws(() => parseWorkflow(`export const meta = { name: "n" }\n`), WorkflowSyntaxError)
  assert.throws(() => parseWorkflow(`export const meta = 5\n`), WorkflowSyntaxError)
})

test("runInSandbox runs the body and resolves its return value", async () => {
  const src = `export const meta = { name: "n", description: "d" }\nreturn 1 + 2\n`
  const { body } = parseWorkflow(src)
  const out = await runInSandbox({ body, filename: "wf.js", globals: fakeGlobals() })
  assert.equal(out, 3)
})

test("runInSandbox exposes the injected globals", async () => {
  const calls: string[] = []
  const src = `export const meta = { name: "n", description: "d" }\nlog("hi")\nreturn await agent("p")\n`
  const { body } = parseWorkflow(src)
  const out = await runInSandbox({
    body,
    filename: "wf.js",
    globals: fakeGlobals({
      log: (m: string) => calls.push(m),
      agent: (async (p: string) => `ran:${p}`) as WorkflowGlobals["agent"],
    }),
  })
  assert.deepEqual(calls, ["hi"])
  assert.equal(out, "ran:p")
})

test("determinism: Date.now() and Math.random() throw inside a workflow", async () => {
  const src1 = `export const meta = { name: "n", description: "d" }\nreturn Date.now()\n`
  await assert.rejects(
    runInSandbox({ body: parseWorkflow(src1).body, filename: "wf.js", globals: fakeGlobals() }),
    /Date\.now/,
  )
  const src2 = `export const meta = { name: "n", description: "d" }\nreturn Math.random()\n`
  await assert.rejects(
    runInSandbox({ body: parseWorkflow(src2).body, filename: "wf.js", globals: fakeGlobals() }),
    /Math\.random/,
  )
})

test("eval and Function are unavailable (codegen disabled)", async () => {
  const src = `export const meta = { name: "n", description: "d" }\nreturn eval("1")\n`
  await assert.rejects(runInSandbox({ body: parseWorkflow(src).body, filename: "wf.js", globals: fakeGlobals() }))
})

test("M13: an async hang is aborted by the signal instead of running forever", async () => {
  const src = `export const meta = { name: "n", description: "d" }\nawait new Promise(() => {})\nreturn 1\n`
  const { body } = parseWorkflow(src)
  const ac = new AbortController()
  const p = runInSandbox({ body, filename: "wf.js", globals: fakeGlobals(), signal: ac.signal })
  setTimeout(() => ac.abort(), 20)
  await assert.rejects(p, WorkflowAbortedError)
})

test("M13: an already-aborted signal rejects immediately", async () => {
  const src = `export const meta = { name: "n", description: "d" }\nawait new Promise(() => {})\nreturn 1\n`
  const { body } = parseWorkflow(src)
  const ac = new AbortController()
  ac.abort()
  await assert.rejects(
    runInSandbox({ body, filename: "wf.js", globals: fakeGlobals(), signal: ac.signal }),
    WorkflowAbortedError,
  )
})

test("M13: execTimeoutMs caps a runaway async workflow", async () => {
  const src = `export const meta = { name: "n", description: "d" }\nawait new Promise(() => {})\nreturn 1\n`
  const { body } = parseWorkflow(src)
  await assert.rejects(
    runInSandbox({ body, filename: "wf.js", globals: fakeGlobals(), execTimeoutMs: 20 }),
    WorkflowTimeoutError,
  )
})

test("M13: a normal workflow still resolves when a signal is supplied", async () => {
  const src = `export const meta = { name: "n", description: "d" }\nreturn await agent("p")\n`
  const { body } = parseWorkflow(src)
  const ac = new AbortController()
  const out = await runInSandbox({
    body,
    filename: "wf.js",
    globals: fakeGlobals({ agent: (async () => "ok") as WorkflowGlobals["agent"] }),
    signal: ac.signal,
  })
  assert.equal(out, "ok")
})

test("M13: an async error still propagates with a signal attached", async () => {
  const src = `export const meta = { name: "n", description: "d" }\nawait Promise.resolve()\nthrow new Error("late")\n`
  const { body } = parseWorkflow(src)
  await assert.rejects(
    runInSandbox({ body, filename: "wf.js", globals: fakeGlobals(), signal: new AbortController().signal }),
    /late/,
  )
})

test("dynamic import is unavailable inside a workflow", async () => {
  const src = `export const meta = { name: "n", description: "d" }\nreturn await import("node:fs")\n`
  const { body } = parseWorkflow(src)
  await assert.rejects(runInSandbox({ body, filename: "wf.js", globals: fakeGlobals() }))
})
