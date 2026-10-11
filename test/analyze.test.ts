// Unit tests for static workflow analysis: missing refs fail, smells warn, blessed
// patterns (dedup barriers, loop-until-dry, conditional phases, dynamic refs) stay clean.

import { test } from "node:test"
import assert from "node:assert/strict"
import { analyzeWorkflow } from "../src/runtime/analyze.ts"

const META = `export const meta = { name: "t", description: "t", phases: [{ title: "Build" }] }\n`

test("literal workflow() refs to nothing fail with line numbers", () => {
  const { errors, warnings } = analyzeWorkflow(META + `return await workflow("no-such-wf-xyz", {})\n`)
  assert.equal(errors.length, 1)
  assert.equal(errors[0]!.code, "missing-workflow-ref")
  assert.ok((errors[0]!.line ?? 0) > 0)
  assert.deepEqual(warnings, [])
})

test("builtin names and dynamic refs pass", () => {
  const builtin = analyzeWorkflow(META + `return await workflow("deep-research", "q")\n`)
  assert.deepEqual(builtin.errors, [])
  const dynamic = analyzeWorkflow(META + `const r = "deep-" + "research"\nreturn await workflow(r, {})\n`)
  assert.deepEqual(dynamic.errors, [])
  const tpl = analyzeWorkflow(META + "const n = 'x'\nreturn await workflow(`wf-${n}`, {})\n")
  assert.deepEqual(tpl.errors, [])
})

test("while(true) with agent() warns; bounded loops stay clean", () => {
  const bad = analyzeWorkflow(META + `while (true) {\n  const a = await agent("x")\n}\nreturn 1\n`)
  assert.equal(bad.errors.length, 0)
  assert.equal(bad.warnings.length, 1)
  assert.equal(bad.warnings[0]!.code, "unbounded-loop")

  const dry = analyzeWorkflow(
    META + `let dry = 0\nwhile (dry < 2) {\n  const a = await agent("x")\n  dry++\n}\nreturn 1\n`,
  )
  assert.deepEqual(dry.warnings, [])

  const noAgent = analyzeWorkflow(META + `while (true) { log("spin") }\nreturn 1\n`)
  assert.deepEqual(noAgent.warnings, [])
})

test("phase titles outside meta.phases warn; declared/used and plan-less stay clean", () => {
  const typo = analyzeWorkflow(META + `phase("Build")\nphase("Biuld")\nreturn 1\n`)
  assert.equal(typo.warnings.length, 1)
  assert.equal(typo.warnings[0]!.code, "undeclared-phase")
  assert.match(typo.warnings[0]!.message, /Biuld/)

  const clean = analyzeWorkflow(META + `phase("Build")\nreturn 1\n`)
  assert.deepEqual(clean.warnings, [])

  const noPlan = analyzeWorkflow(
    `export const meta = { name: "t", description: "t" }\nphase("Anything")\nreturn 1\n`,
  )
  assert.deepEqual(noPlan.warnings, [])
})
