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

test("meta.defaultProvider/defaultModel are both-or-neither at parse time", () => {
  // A lone defaultModel would pair with a provider chosen elsewhere (CLI or the built-in default)
  // — a model meant for a different provider. `omegacode validate` must catch it without a run.
  const lead = `export const meta = { name: "n", description: "d", `
  assert.throws(() => parseWorkflow(`${lead}defaultProvider: "claude-code" }\nreturn 1\n`), /defaultProvider and meta\.defaultModel must be specified together/)
  assert.throws(() => parseWorkflow(`${lead}defaultModel: "gpt-5.5" }\nreturn 1\n`), /defaultProvider and meta\.defaultModel must be specified together/)
  // Both together (or neither) still parse.
  const both = parseWorkflow(`${lead}defaultProvider: "claude-code", defaultModel: "claude-fable-5" }\nreturn 1\n`)
  assert.equal(both.meta.defaultProvider, "claude-code")
  assert.equal(both.meta.defaultModel, "claude-fable-5")
  assert.equal(parseWorkflow(`export const meta = { name: "n", description: "d" }\nreturn 1\n`).meta.defaultProvider, undefined)
})

test("a non-array meta.phases fails at parse time, not as a TypeError mid-run", () => {
  // A non-iterable container would otherwise crash the Runtime constructor's declared-phase
  // loop after the run dir/journal already exist (burned run id, no terminal run event).
  const bad = `export const meta = { name: "n", description: "d", phases: { title: "Plan" } }\nreturn 1\n`
  assert.throws(() => parseWorkflow(bad), /meta\.phases must be an array/)
  assert.throws(() => parseWorkflow(`export const meta = { name: "n", description: "d", phases: "Plan" }\n`), WorkflowSyntaxError)
  // A well-formed array (even with unusable entries — the runtime skips those) still parses.
  // The strict parser builds null-prototype objects, so compare structurally via JSON rather than
  // prototype-strict deepEqual.
  const ok = `export const meta = { name: "n", description: "d", phases: [{ title: "Plan" }, {}] }\nreturn 1\n`
  assert.equal(JSON.stringify(parseWorkflow(ok).meta.phases), JSON.stringify([{ title: "Plan" }, {}]))
})

// The meta literal is parsed by a strict validate-then-build parser, NOT executed. These cover the
// full accepted grammar and reject every expression form the old vm-eval used to run.
// A rejected meta must throw WorkflowSyntaxError whose message names the offending construct.
function rejectsMeta(literal: string, re: RegExp): void {
  const src = `export const meta = ${literal}\nreturn 1\n`
  assert.throws(
    () => parseWorkflow(src),
    (e: unknown) => e instanceof WorkflowSyntaxError && re.test((e as Error).message),
    `expected a WorkflowSyntaxError matching ${re} for meta = ${literal}`,
  )
}

test("strict meta parser accepts every scalar type, nested objects/arrays, comments, trailing commas", () => {
  // One literal exercising the whole accepted grammar: identifier + string keys, string/number/
  // negative-number/boolean/null scalars, a nested object, an array of mixed accepted values, a
  // no-interpolation backtick string, a line comment, a block comment, and trailing commas.
  const src = [
    `export const meta = {`,
    `  name: "n", // a line comment`,
    `  description: "d",`,
    `  /* a block comment */`,
    `  "quoted-key": "v",`,
    `  count: -3,`,
    `  ratio: 1.5e-2,`,
    `  flagT: true,`,
    `  flagF: false,`,
    `  nothing: null,`,
    "  back: `plain backtick, no interpolation`,",
    `  nested: { a: 1, b: [ "x", 2, false, { c: null }, ], },`,
    `  list: [{ title: "Plan" }, {}],`,
    `}`,
    `return 1`,
    ``,
  ].join("\n")
  const { meta } = parseWorkflow(src)
  const m = meta as Record<string, unknown>
  assert.equal(m.name, "n")
  assert.equal(m["quoted-key"], "v")
  assert.equal(m.count, -3)
  assert.equal(m.ratio, 0.015)
  assert.equal(m.flagT, true)
  assert.equal(m.flagF, false)
  assert.equal(m.nothing, null)
  assert.equal(m.back, "plain backtick, no interpolation")
  // Compare nested structure by JSON (parser builds null-proto objects, so deepEqual would differ).
  assert.equal(JSON.stringify(m.nested), JSON.stringify({ a: 1, b: ["x", 2, false, { c: null }] }))
  assert.equal(JSON.stringify(m.list), JSON.stringify([{ title: "Plan" }, {}]))
})

test("strict meta parser decodes standard string escapes without executing", () => {
  const src = `export const meta = { name: "a\\tb", description: "line1\\nline2\\u0041" }\nreturn 1\n`
  const { meta } = parseWorkflow(src)
  assert.equal(meta.name, "a\tb")
  assert.equal(meta.description, "line1\nline2A")
})

test("strict meta parser rejects a method call in a value (the old vm-eval EXECUTED this)", () => {
  // `"x".repeat(1e9)` used to run under only a 1s timeout — a memory-blowup DoS. Now it's rejected
  // structurally: the string parses, then the trailing `.repeat(...)` is not a pure literal.
  rejectsMeta(`{ name: "x".repeat(1000000000), description: "d" }`, /method calls and property access are not allowed.*pure literal/s)
})

test("strict meta parser rejects a getter (would have run arbitrary code on access)", () => {
  rejectsMeta(`{ name: "n", get description() { return "d" } }`, /getters\/setters are not allowed.*pure literal/s)
})

test("strict meta parser rejects a setter", () => {
  rejectsMeta(`{ name: "n", set description(v) {} }`, /getters\/setters are not allowed.*pure literal/s)
})

test("strict meta parser rejects a method shorthand", () => {
  rejectsMeta(`{ name: "n", description() { return "d" } }`, /method definitions are not allowed.*pure literal/s)
})

test("strict meta parser rejects __proto__ and does NOT pollute Object.prototype", () => {
  // The old throwaway-context evaluator could pollute via `__proto__`; the strict parser both
  // rejects the key AND builds null-prototype objects so nothing reaches Object.prototype.
  rejectsMeta(`{ name: "n", description: "d", __proto__: { polluted: true } }`, /reserved key "__proto__" is not allowed.*pure literal/s)
  // A value nested under __proto__ must never leak onto the global prototype.
  rejectsMeta(`{ name: "n", __proto__: { polluted: true }, description: "d" }`, /__proto__/)
  assert.equal(({} as Record<string, unknown>).polluted, undefined)
})

test("strict meta parser rejects constructor and prototype keys", () => {
  rejectsMeta(`{ name: "n", description: "d", constructor: 1 }`, /reserved key "constructor" is not allowed/)
  rejectsMeta(`{ name: "n", description: "d", prototype: 1 }`, /reserved key "prototype" is not allowed/)
})

test("strict meta parser rejects computed keys", () => {
  rejectsMeta(`{ ["na" + "me"]: "n", description: "d" }`, /computed keys are not allowed.*pure literal/s)
})

test("strict meta parser rejects object and array spreads", () => {
  rejectsMeta(`{ ...base, name: "n", description: "d" }`, /spread syntax is not allowed.*pure literal/s)
  rejectsMeta(`{ name: "n", description: "d", phases: [...other] }`, /spread syntax is not allowed.*pure literal/s)
})

test("strict meta parser rejects function and arrow values", () => {
  rejectsMeta(`{ name: "n", description: function () { return "d" } }`, /function values are not allowed.*pure literal/s)
  rejectsMeta(`{ name: "n", description: () => "d" }`, /arrow functions.*not allowed.*pure literal/s)
})

test("strict meta parser rejects template interpolation, accepts plain backticks", () => {
  rejectsMeta("{ name: `hi ${1 + 1}`, description: \"d\" }", /template interpolation.*not allowed.*pure literal/s)
  // A backtick with NO interpolation is a plain string and is accepted.
  const ok = parseWorkflow("export const meta = { name: `plain`, description: \"d\" }\nreturn 1\n")
  assert.equal(ok.meta.name, "plain")
})

test("strict meta parser rejects bare identifier values (references/expressions)", () => {
  rejectsMeta(`{ name: someVar, description: "d" }`, /bare identifier `someVar` is not allowed.*pure literal/s)
  rejectsMeta(`{ name: "n", description: undefined }`, /`undefined` is not a literal.*pure literal/s)
})

test("strict meta parser rejects shorthand properties", () => {
  rejectsMeta(`{ name, description: "d" }`, /shorthand properties are not allowed.*pure literal/s)
})

test("strict meta parser rejects template-literal keys", () => {
  rejectsMeta("{ `name`: \"n\", description: \"d\" }", /template-literal keys are not allowed.*pure literal/s)
})

test("strict meta parser rejects deeply nested literals instead of stack-overflowing", () => {
  // Untrusted input has no execution timeout anymore, so nesting is depth-bounded to keep a
  // pathological `[[[[…]]]]` from overflowing the recursive-descent stack.
  const deep = "[".repeat(200) + "]".repeat(200)
  rejectsMeta(`{ name: "n", description: "d", phases: ${deep} }`, /nested too deeply/)
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
