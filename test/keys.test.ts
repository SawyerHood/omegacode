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
  const keys = ["codex", "claude-code", "opencode", "pi"].map((provider) =>
    chainKey(b, 0, "p", keyedSpec({ provider: provider as AgentOpts["provider"], model: "m1" }, undefined)),
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
  const o = keyedOpts({ provider: "codex", worktree: true })
  assert.equal(o.provider, "codex")
  assert.equal(o.worktree, true)
  assert.equal(o.model, null)
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
