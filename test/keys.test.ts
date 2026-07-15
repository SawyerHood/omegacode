import { test } from "node:test"
import assert from "node:assert/strict"
import {
  branchKey,
  canonical,
  chainKey,
  determinismLint,
  explicitKey,
  KEY_VERSION,
  keyedOpts,
  keyedSpec,
  ROOT_KEY,
  sandboxLint,
} from "../src/runtime/keys.ts"
import type { AgentOpts } from "../src/dsl/types.ts"

// helper: build the keyed-fields object the way chainKey now expects it
const fields = (opts?: AgentOpts) => keyedOpts(opts)

test("KEY_VERSION is v3 (bumped for the per-branch fan-out call counter, C1)", () => {
  // v2 (per-branch lineage, no call counter) derived identical child keys for two sequential
  // identical fan-outs — wrong-result replay. The derivation changed, so the version must change
  // too: resuming a v2 journal must fail fast rather than silently miss every key and re-bill.
  assert.equal(KEY_VERSION, "v3")
})

test("canonical sorts object keys recursively and drops __proto__", () => {
  const a = canonical({ b: 1, a: { d: 2, c: 3 } })
  const b = canonical({ a: { c: 3, d: 2 }, b: 1 })
  assert.equal(a, b)
  const proto = JSON.parse('{"__proto__": 1, "x": 2}')
  assert.equal(canonical(proto), '{"x":2}')
})

test("canonical is stable for arrays (order-preserving) and primitives", () => {
  assert.equal(canonical([3, 1, 2]), "[3,1,2]")
  assert.equal(canonical("s"), '"s"')
  assert.equal(canonical(null), "null")
})

test("keyedOpts captures semantic fields incl. worktree and approval (H8)", () => {
  const o = keyedOpts({ sandbox: "workspace-write", worktree: true, approval: "on-request" })
  assert.equal(o.sandbox, "workspace-write")
  assert.equal(o.worktree, true)
  assert.equal(o.approval, "on-request")
  // unset semantic fields default to null
  assert.equal(o.provider, null)
  assert.equal(o.model, null)
  // non-semantic fields (label/phase/key) are NOT in the key
  assert.ok(!("label" in o))
  assert.ok(!("phase" in o))
  assert.ok(!("key" in o))
})

test("changing worktree changes the key (was silently ignored in v1)", () => {
  const b = branchKey(ROOT_KEY, "root", 0)
  const without = chainKey(b, 0, "do x", fields())
  const withWt = chainKey(b, 0, "do x", fields({ worktree: true }))
  assert.notEqual(without, withWt)
})

test("changing approval changes the key", () => {
  const b = branchKey(ROOT_KEY, "root", 0)
  const a = chainKey(b, 0, "p", fields({ approval: "never" }))
  const c = chainKey(b, 0, "p", fields({ approval: "on-request" }))
  assert.notEqual(a, c)
})

test("keyedSpec captures RESOLVED provider/model so default/CLI overrides invalidate (H8)", () => {
  const b = branchKey(ROOT_KEY, "root", 0)
  // resolved spec with provider codex vs claude-code → different keys, even with no opts
  const k1 = chainKey(b, 0, "p", keyedSpec({ provider: "codex", model: "m1" }, undefined))
  const k2 = chainKey(b, 0, "p", keyedSpec({ provider: "claude-code", model: "m1" }, undefined))
  const k3 = chainKey(b, 0, "p", keyedSpec({ provider: "codex", model: "m2" }, undefined))
  assert.notEqual(k1, k2)
  assert.notEqual(k1, k3)
})

test("keyedSpec distinguishes every provider id", () => {
  const b = branchKey(ROOT_KEY, "root", 0)
  const keys = (["codex", "claude-code", "opencode", "pi"] as const).map((provider) =>
    chainKey(b, 0, "p", keyedSpec({ provider, model: "m1" }, undefined)),
  )
  assert.equal(new Set(keys).size, keys.length)
})

test("chainKey depends on branch lineage, local index, prompt and fields", () => {
  const b1 = branchKey(ROOT_KEY, "parallel", 0)
  const b2 = branchKey(ROOT_KEY, "parallel", 1)
  // same local position, different branch → different key
  assert.notEqual(chainKey(b1, 0, "p", fields()), chainKey(b2, 0, "p", fields()))
  // same branch, different local index → different key
  assert.notEqual(chainKey(b1, 0, "p", fields()), chainKey(b1, 1, "p", fields()))
  // same everything → identical (deterministic)
  assert.equal(chainKey(b1, 0, "p", fields()), chainKey(b1, 0, "p", fields()))
})

test("branchKey distinguishes kind and index", () => {
  assert.notEqual(branchKey(ROOT_KEY, "parallel", 0), branchKey(ROOT_KEY, "pipeline", 0))
  assert.notEqual(branchKey(ROOT_KEY, "parallel", 0), branchKey(ROOT_KEY, "parallel", 1))
  assert.equal(branchKey(ROOT_KEY, "parallel", 0), branchKey(ROOT_KEY, "parallel", 0))
})

test("explicitKey is stable regardless of position/prompt/opts", () => {
  // explicit keys are resolved by the caller via explicitKey() (not chainKey).
  assert.equal(explicitKey("stable"), explicitKey("stable"))
  assert.notEqual(explicitKey("a"), explicitKey("b"))
})

test("keyedOpts still works as a KeyedFields builder for callers without a resolved spec", () => {
  const o = keyedOpts({ provider: "codex", model: "gpt-5.5", worktree: true })
  assert.equal(o.provider, "codex")
  assert.equal(o.worktree, true)
  assert.equal(o.model, "gpt-5.5")
})

test("ROOT_KEY is version-tagged (changes with KEY_VERSION)", () => {
  assert.match(ROOT_KEY, /^[0-9a-f]{64}$/)
})

test("determinismLint flags real code references", () => {
  assert.deepEqual(
    determinismLint("const t = Date.now()").map((f) => f.token),
    ["Date.now()"],
  )
  assert.deepEqual(
    determinismLint("Math.random()").map((f) => f.token),
    ["Math.random()"],
  )
  assert.deepEqual(
    determinismLint("const d = new Date()").map((f) => f.token),
    ["new Date()"],
  )
})

test("determinismLint does NOT false-positive on strings (L10)", () => {
  assert.deepEqual(determinismLint('await agent("audit any Date.now() usage in the repo")'), [])
  assert.deepEqual(determinismLint("const p = `look for Math.random() calls`"), [])
  assert.deepEqual(determinismLint("const p = 'mention new Date() here'"), [])
})

test("determinismLint does NOT false-positive on comments (L10)", () => {
  assert.deepEqual(determinismLint("// avoid Date.now() in workflows"), [])
  assert.deepEqual(determinismLint("/* Math.random() and new Date() are banned */"), [])
})

test("determinismLint still flags code even when a string also mentions it", () => {
  const findings = determinismLint('const note = "Date.now is fine in prose"\nconst x = Math.random()')
  assert.deepEqual(
    findings.map((f) => f.token),
    ["Math.random()"],
  )
})

test("determinismLint handles escaped quotes inside strings", () => {
  assert.deepEqual(determinismLint('const s = "a \\" Date.now() still in string"'), [])
})

test("sandboxLint flags sandbox-unavailable globals in real code", () => {
  // require()/process.*/module.exports throw ReferenceError only when the branch is reached —
  // possibly after paid agents ran. Flag them statically at submit/validate time.
  assert.deepEqual(
    sandboxLint('const fs = require("fs")').map((f) => f.token),
    ["require()"],
  )
  assert.deepEqual(
    sandboxLint("const key = process.env.FOO").map((f) => f.token),
    ["process.*"],
  )
  assert.deepEqual(
    sandboxLint("module.exports = 1").map((f) => f.token),
    ["module.exports"],
  )
})

test("sandboxLint does NOT false-positive on strings, templates or comments (L10)", () => {
  assert.deepEqual(sandboxLint('await agent("use require(x) not process.env.FOO or module.exports")'), [])
  assert.deepEqual(sandboxLint("const p = `require(x) process.env.Y module.exports`"), [])
  assert.deepEqual(sandboxLint("// require(x) process.env.Z module.exports = 1"), [])
  assert.deepEqual(sandboxLint("/* require(x) process.env.Z module.exports */"), [])
})

test("sandboxLint does NOT false-positive on words that merely contain the tokens", () => {
  // `reprocess.env` is not a `process.*` reference; a function named `requires(` is not `require(`.
  assert.deepEqual(sandboxLint("const a = reprocess.env"), [])
  assert.deepEqual(sandboxLint("function requires(x){ return x }\nrequires(1)"), [])
})

test("sandboxLint's process rule is narrowed to known Node members (no user-object false-positive)", () => {
  // `obj.process.status` is a user object, not the Node global — the old broad `process.\w+` rule
  // wrongly flagged it. Only the known members (env/argv/exit/cwd/platform/stdout/stderr/version) count.
  assert.deepEqual(sandboxLint("const s = obj.process.status"), [])
  assert.deepEqual(sandboxLint("const r = result.process.output"), [])
  // Real Node members are still flagged.
  assert.deepEqual(sandboxLint("const k = process.env.FOO").map((f) => f.token), ["process.*"])
  assert.deepEqual(sandboxLint("process.exit(1)").map((f) => f.token), ["process.*"])
})

test("lint sees code inside template-literal interpolations (${...} is real code)", () => {
  // (a) a sandbox-unavailable global inside an interpolation must be flagged.
  assert.deepEqual(sandboxLint("const x = `${process.env.HOME}`").map((f) => f.token), ["process.*"])
  // (b) a nondeterministic call inside an interpolation must be flagged.
  assert.deepEqual(determinismLint("const t = `${Date.now()}`").map((f) => f.token), ["Date.now()"])
})

test("lint does NOT false-positive on a nested template literal's text inside an interpolation", () => {
  // (c) `require(y)` and `Date.now()` here are TEXT of nested templates (strings), not code — the
  // interpolation's own code (`cond ? … : …`) is preserved, but the nested template text is blanked.
  const src = "await agent(`a ${cond ? `require(y)` : `b`} c`)"
  assert.deepEqual(sandboxLint(src), [])
  assert.deepEqual(determinismLint("const s = `x ${flag ? `Date.now()` : `y`} z`"), [])
})
