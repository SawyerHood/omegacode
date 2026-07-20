import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Journal } from "../src/runtime/journal.ts"
import { bbContextFromEnvironment, runWorkflow } from "../src/runtime/run.ts"

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

test("new runs record the owning bb thread and environment from the launch shell", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omegacode-bb-context-"))
  const previous = {
    OMEGACODE_HOME: process.env.OMEGACODE_HOME,
    BB_THREAD_ID: process.env.BB_THREAD_ID,
    BB_ENVIRONMENT_ID: process.env.BB_ENVIRONMENT_ID,
    BB_PROJECT_ID: process.env.BB_PROJECT_ID,
  }

  try {
    process.env.OMEGACODE_HOME = join(dir, "home")
    process.env.BB_THREAD_ID = "thr_owner"
    process.env.BB_ENVIRONMENT_ID = "env_owner"
    process.env.BB_PROJECT_ID = "proj_owner"

    const workflow = join(dir, "context.workflow.js")
    writeFileSync(
      workflow,
      'export const meta = { name: "context", description: "bb context regression" }\nreturn "ok"\n',
    )

    const outcome = await runWorkflow({ file: workflow, fake: true, quiet: true })
    const meta = Journal.load(outcome.runId).meta

    assert.deepEqual(meta?.bbContext, {
      threadId: "thr_owner",
      environmentId: "env_owner",
      projectId: "proj_owner",
    })
  } finally {
    restoreEnv("OMEGACODE_HOME", previous.OMEGACODE_HOME)
    restoreEnv("BB_THREAD_ID", previous.BB_THREAD_ID)
    restoreEnv("BB_ENVIRONMENT_ID", previous.BB_ENVIRONMENT_ID)
    restoreEnv("BB_PROJECT_ID", previous.BB_PROJECT_ID)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("bb ownership is omitted unless both the thread and environment are present", () => {
  assert.equal(bbContextFromEnvironment({ BB_THREAD_ID: "thr_only" }), undefined)
  assert.equal(bbContextFromEnvironment({ BB_ENVIRONMENT_ID: "env_only" }), undefined)
  assert.deepEqual(
    bbContextFromEnvironment({
      BB_THREAD_ID: " thr_owner ",
      BB_ENVIRONMENT_ID: " env_owner ",
    }),
    {
      threadId: "thr_owner",
      environmentId: "env_owner",
    },
  )
})
