// End-to-end factory→spawn→stdin wiring for the subprocess workers: a real workflow run drives a
// real spawned fake binary that records its argv/stdin/env/cwd. Complements the worker unit tests,
// which exercise the same logic only through the injectable spawn seam. POSIX-only (shebang bins).

import { test } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runWorkflow } from "../src/runtime/run.ts"

const posixOnly = { skip: process.platform === "win32" }

interface Launch {
  argv: string[]
  stdin: string
  cwd: string
  env: Record<string, string | undefined>
}

/** A fake provider CLI: answers --version, records the run invocation, emits one happy event. */
function writeFakeBin(path: string, version: string, eventJson: string): void {
  writeFileSync(
    path,
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      "const args = process.argv.slice(2);",
      'if (args[0] === "--version") { console.log("' + version + '"); process.exit(0); }',
      'let stdin = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (c) => (stdin += c));',
      'process.stdin.on("end", () => {',
      "  fs.writeFileSync(process.env.RECORD, JSON.stringify({ argv: args, stdin, cwd: process.cwd(), env: { OPENCODE_DISABLE_AUTOUPDATE: process.env.OPENCODE_DISABLE_AUTOUPDATE, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR } }));",
      "  console.log('" + eventJson + "');",
      "});",
    ].join("\n"),
  )
  chmodSync(path, 0o755)
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

test("pi: overrides.piBin drives a real spawn with the exact argv/stdin contract", posixOnly, async () => {
  const dir = mkdtempSync(join(tmpdir(), "omega-pi-env-"))
  const prev = { OMEGACODE_HOME: process.env.OMEGACODE_HOME, RECORD: process.env.RECORD }
  try {
    const record = join(dir, "record.json")
    const bin = join(dir, "pi-fake.cjs")
    writeFakeBin(
      bin,
      "0.79.1",
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0.01 } }, stopReason: "stop" },
      }).replace(/'/g, "\\'"),
    )
    const wf = join(dir, "pi-env.workflow.js")
    writeFileSync(
      wf,
      `export const meta = { name: "pi-env-smoke", description: "e2e env wiring", defaultProvider: "pi", defaultModel: "openrouter/foo/bar" }\n` +
        `return await agent("hello from workflow", { sandbox: "danger-full-access", effort: "high", instructions: "be terse", cwd: ${JSON.stringify(dir)} })\n`,
    )
    process.env.OMEGACODE_HOME = join(dir, "home")
    process.env.RECORD = record

    const outcome = await runWorkflow({ file: wf, quiet: true, overrides: { piBin: bin } })
    assert.equal(outcome.status, "completed", `error=${outcome.error}`)
    assert.equal(outcome.result, "ok")

    const launch = JSON.parse(readFileSync(record, "utf8")) as Launch
    assert.deepEqual(launch.argv, [
      "--mode",
      "json",
      "--no-session",
      "--model",
      "openrouter/foo/bar",
      "--thinking",
      "high",
      "--append-system-prompt",
      "be terse",
    ])
    assert.equal(launch.stdin, "hello from workflow")
    assert.equal(realpathSync(launch.cwd), realpathSync(dir))
    // The RUN inherits the user's agent dir (auth lives there) — no scratch isolation here.
    assert.equal(launch.env.PI_CODING_AGENT_DIR, undefined)
  } finally {
    restoreEnv("OMEGACODE_HOME", prev.OMEGACODE_HOME)
    restoreEnv("RECORD", prev.RECORD)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("opencode: OPENCODE_BIN env drives a real spawn with the exact argv/stdin contract", posixOnly, async () => {
  const dir = mkdtempSync(join(tmpdir(), "omega-oc-env-"))
  const prev = { OMEGACODE_HOME: process.env.OMEGACODE_HOME, RECORD: process.env.RECORD, OPENCODE_BIN: process.env.OPENCODE_BIN }
  try {
    const record = join(dir, "record.json")
    const bin = join(dir, "opencode-fake.cjs")
    writeFakeBin(bin, "1.16.2", JSON.stringify({ type: "text", sessionID: "ses_x", part: { text: "ok" } }))
    const wf = join(dir, "oc-env.workflow.js")
    writeFileSync(
      wf,
      `export const meta = { name: "oc-env-smoke", description: "e2e env wiring", defaultProvider: "opencode", defaultModel: "openrouter/foo/bar" }\n` +
        `return await agent("hello from workflow", { sandbox: "danger-full-access", instructions: "be terse", cwd: ${JSON.stringify(dir)} })\n`,
    )
    process.env.OMEGACODE_HOME = join(dir, "home")
    process.env.RECORD = record
    process.env.OPENCODE_BIN = bin

    const outcome = await runWorkflow({ file: wf, quiet: true })
    assert.equal(outcome.status, "completed", `error=${outcome.error}`)
    assert.equal(outcome.result, "ok")

    const launch = JSON.parse(readFileSync(record, "utf8")) as Launch
    // DEFAULTS.effort (xhigh) rides along: on this 1.16.2 fake that means --variant.
    assert.deepEqual(launch.argv, ["run", "--format", "json", "--thinking", "--variant", "xhigh", "--model", "openrouter/foo/bar", "--dangerously-skip-permissions"])
    // Instructions arrive as a delimited stdin preamble (opencode run has no system-prompt flag).
    assert.equal(launch.stdin, "<instructions>\nbe terse\n</instructions>\n\nhello from workflow")
    assert.equal(realpathSync(launch.cwd), realpathSync(dir))
    assert.equal(launch.env.OPENCODE_DISABLE_AUTOUPDATE, "1")
  } finally {
    restoreEnv("OMEGACODE_HOME", prev.OMEGACODE_HOME)
    restoreEnv("RECORD", prev.RECORD)
    restoreEnv("OPENCODE_BIN", prev.OPENCODE_BIN)
    rmSync(dir, { recursive: true, force: true })
  }
})
