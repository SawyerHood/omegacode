import { test } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runWorkflow } from "../src/runtime/run.ts"

test("PI_PROVIDER and PI_MODEL env vars are forwarded to pi when no per-agent model is set", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omega-pi-env-"))
  const prevHome = process.env.OMEGACODE_HOME
  const prevBin = process.env.PI_BIN
  const prevProvider = process.env.PI_PROVIDER
  const prevModel = process.env.PI_MODEL
  const prevRecord = process.env.RECORD
  const repoCwd = process.cwd()
  try {
    const record = join(dir, "record.json")
    const bin = join(dir, "pi-fake.cjs")
    writeFileSync(
      bin,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        "let stdin = '';",
        'process.stdin.setEncoding("utf8");',
        "process.stdin.on('data', (chunk) => { stdin += chunk; });",
        "process.stdin.on('end', () => {",
        "  fs.writeFileSync(process.env.RECORD, JSON.stringify({ argv: process.argv.slice(2), stdin, cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR, sessionDir: process.env.PI_CODING_AGENT_SESSION_DIR }));",
        '  console.log(JSON.stringify({ type: "text", text: "ok" }));',
        "});",
      ].join("\n"),
    )
    chmodSync(bin, 0o755)

    const wf = join(dir, "pi-env.workflow.js")
    writeFileSync(
      wf,
      [
        'export const meta = { name: "pi-env-test", description: "env wiring", defaultProvider: "pi" }',
        'return await agent("hello from workflow")',
      ].join("\n"),
    )

    process.env.OMEGACODE_HOME = join(dir, "home")
    process.env.PI_BIN = bin
    process.env.PI_PROVIDER = "anthropic"
    process.env.PI_MODEL = "claude-test"
    process.env.RECORD = record

    const outcome = await runWorkflow({ file: wf, quiet: true })
    assert.equal(outcome.status, "completed")
    const launch = JSON.parse(readFileSync(record, "utf8")) as { argv: string[]; stdin: string; cwd: string; agentDir: string; sessionDir: string }
    assert.deepEqual(launch.argv.slice(0, 9), [
      "--mode", "json",
      "--print",
      "--no-session",
      "--no-approve",
      "--session-dir", launch.argv[6]!,
      "--tools", "read,grep,find,ls",
    ])
    assert.equal(launch.argv.includes("--no-tools"), false)
    assert.deepEqual(launch.argv.slice(9, 13), ["--provider", "anthropic", "--model", "claude-test"])
    assert.notEqual(launch.cwd, repoCwd)
    assert.match(launch.cwd, /omegacode-pi-/)
    assert.match(launch.agentDir, /omegacode-pi-/)
    assert.match(launch.sessionDir, /omegacode-pi-/)
    assert.equal(launch.stdin, "hello from workflow")
  } finally {
    restoreEnv("OMEGACODE_HOME", prevHome)
    restoreEnv("PI_BIN", prevBin)
    restoreEnv("PI_PROVIDER", prevProvider)
    restoreEnv("PI_MODEL", prevModel)
    restoreEnv("RECORD", prevRecord)
    rmSync(dir, { recursive: true, force: true })
  }
})

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}
