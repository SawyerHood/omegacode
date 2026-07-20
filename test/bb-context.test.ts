import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bbRunContextFromEnv } from "../src/runtime/bb-context.ts"
import { Journal } from "../src/runtime/journal.ts"
import { runWorkflow } from "../src/runtime/run.ts"

test("captures BB thread ownership from the process environment", () => {
  assert.deepEqual(
    bbRunContextFromEnv({
      BB_THREAD_ID: "thr_123",
      BB_ENVIRONMENT_ID: "env_123",
      BB_PROJECT_ID: "proj_123",
    }),
    {
      threadId: "thr_123",
      environmentId: "env_123",
      projectId: "proj_123",
    },
  )
})

test("requires both a BB thread and environment", () => {
  assert.equal(bbRunContextFromEnv({ BB_THREAD_ID: "thr_123" }), null)
  assert.equal(bbRunContextFromEnv({ BB_ENVIRONMENT_ID: "env_123" }), null)
  assert.equal(
    bbRunContextFromEnv({ BB_THREAD_ID: "  ", BB_ENVIRONMENT_ID: "env_123" }),
    null,
  )
})

test("keeps the project optional", () => {
  assert.deepEqual(
    bbRunContextFromEnv({
      BB_THREAD_ID: "thr_123",
      BB_ENVIRONMENT_ID: "env_123",
    }),
    { threadId: "thr_123", environmentId: "env_123" },
  )
})

test("new run journals include the BB owner automatically", async () => {
  const home = mkdtempSync(join(tmpdir(), "omegacode-bb-context-"))
  const workflow = join(home, "owner.workflow.js")
  writeFileSync(
    workflow,
    `export const meta = { name: "owner", description: "owner" }; return "ok";`,
  )

  const previous = {
    home: process.env.OMEGACODE_HOME,
    thread: process.env.BB_THREAD_ID,
    environment: process.env.BB_ENVIRONMENT_ID,
    project: process.env.BB_PROJECT_ID,
  }
  process.env.OMEGACODE_HOME = home
  process.env.BB_THREAD_ID = "thr_123"
  process.env.BB_ENVIRONMENT_ID = "env_123"
  process.env.BB_PROJECT_ID = "proj_123"

  try {
    const outcome = await runWorkflow({ file: workflow, fake: true, quiet: true })
    assert.deepEqual(Journal.load(outcome.runId).meta?.bbContext, {
      threadId: "thr_123",
      environmentId: "env_123",
      projectId: "proj_123",
    })
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      const envKey =
        key === "home"
          ? "OMEGACODE_HOME"
          : key === "thread"
            ? "BB_THREAD_ID"
            : key === "environment"
              ? "BB_ENVIRONMENT_ID"
              : "BB_PROJECT_ID"
      if (value === undefined) delete process.env[envKey]
      else process.env[envKey] = value
    }
    rmSync(home, { recursive: true, force: true })
  }
})
