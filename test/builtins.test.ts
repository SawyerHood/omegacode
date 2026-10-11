// Builtin catalog contract: every shipped workflow parses, analyzes clean (no errors,
// no warnings — the analyzer must stay false-positive-free on real files), and the
// feature-factory conductor completes end-to-end under --fake (proving nested workflow()
// mechanics without spending on real agents).

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { analyzeWorkflow } from "../src/runtime/analyze.ts"
import { parseWorkflow } from "../src/runtime/sandbox.ts"
import { runWorkflow } from "../src/runtime/run.ts"

const BUILTINS = join(fileURLToPath(new URL(".", import.meta.url)), "..", "builtins")

test("every builtin parses and analyzes clean", () => {
  const files = readdirSync(BUILTINS).filter((f) => f.endsWith(".workflow.js")).sort()
  assert.ok(files.length >= 9, `expected 9 builtins, saw ${files}`)
  for (const f of files) {
    const src = readFileSync(join(BUILTINS, f), "utf8")
    parseWorkflow(src) // throws on malformed meta
    const { errors, warnings } = analyzeWorkflow(src, { cwd: BUILTINS })
    assert.deepEqual(errors, [], `${f}: errors`)
    assert.deepEqual(warnings, [], `${f}: warnings`)
  }
})

test("feature-factory completes under --fake with modules + blocked shape", async () => {
  const prev = process.env.OMEGACODE_HOME
  const home = mkdtempSync(join(tmpdir(), "omega-builtin-"))
  process.env.OMEGACODE_HOME = home
  try {
    const outcome = await runWorkflow({
      file: join(BUILTINS, "feature-factory.workflow.js"),
      args: {
        task: "Add a health endpoint",
        modules: [
          { name: "endpoint", brief: "Add GET /health returning status" },
          { name: "tests", brief: "Test the endpoint" },
        ],
      },
      fake: true,
      quiet: true,
    })
    assert.equal(outcome.status, "completed", `error=${outcome.error}`)
    const result = outcome.result as { task: string; modules: unknown[]; blocked: unknown[] }
    assert.equal(result.task, "Add a health endpoint")
    assert.equal(result.modules.length, 2)
    assert.ok(Array.isArray(result.blocked))
  } finally {
    if (prev === undefined) delete process.env.OMEGACODE_HOME
    else process.env.OMEGACODE_HOME = prev
    rmSync(home, { recursive: true, force: true })
  }
})
