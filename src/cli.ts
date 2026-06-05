#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { runWorkflow, type RunOverrides } from "./runtime/run.js"
import { parseWorkflow } from "./runtime/sandbox.js"
import { dataRoot, Journal } from "./runtime/journal.js"
import { startViewer } from "./server/serve.js"
import type { Effort, ProviderId, Sandbox } from "./dsl/types.js"

interface Flags {
  _: string[]
  [k: string]: string | boolean | string[]
}

function parseArgs(argv: string[]): Flags {
  const flags: Flags = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith("--")) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith("--")) flags[key] = true
      else {
        flags[key] = next
        i++
      }
    } else {
      ;(flags._ as string[]).push(a)
    }
  }
  return flags
}

function str(v: string | boolean | string[] | undefined): string | undefined {
  return typeof v === "string" ? v : undefined
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const flags = parseArgs(argv)
  const cmd = (flags._ as string[])[0]

  switch (cmd) {
    case "run":
      return cmdRun(flags)
    case "serve":
      return cmdServe(flags)
    case "runs":
      return cmdRuns(flags)
    case "validate":
      return cmdValidate(flags)
    case "doctor":
      return cmdDoctor()
    case undefined:
    case "help":
    case "--help":
      return printHelp()
    default:
      console.error(`Unknown command: ${cmd}`)
      printHelp()
      process.exitCode = 1
  }
}

async function cmdServe(flags: Flags): Promise<void> {
  const port = flags.port ? Number(str(flags.port)) : 4123
  const host = str(flags.host)
  const { url } = await startViewer({ port, host })
  process.stderr.write(`viewer: ${url}  (reading ${join(dataRoot(), "runs")})\nctrl-c to stop\n`)
  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => resolve())
    process.once("SIGTERM", () => resolve())
  })
}

async function cmdRuns(flags: Flags): Promise<void> {
  const dir = join(dataRoot(), "runs")
  if (!existsSync(dir)) {
    console.log("(no runs yet)")
    return
  }
  const ids = readdirSync(dir).filter((d) => d.startsWith("wf_"))

  if (flags.prune === true) {
    const keep = flags.keep ? Math.max(0, Number(str(flags.keep))) : 50
    const byAge = ids
      .map((id) => ({ id, at: statSync(join(dir, id)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
    const remove = byAge.slice(keep)
    let bytes = 0
    for (const r of remove) {
      bytes += dirSize(join(dir, r.id))
      rmSync(join(dir, r.id), { recursive: true, force: true })
    }
    console.log(`pruned ${remove.length} run(s) (${(bytes / 1e6).toFixed(1)} MB); kept ${Math.min(keep, byAge.length)} newest`)
    return
  }

  const rows = ids.map((id) => {
    const loaded = Journal.load(id)
    const name = loaded.meta?.workflowFile?.split("/").pop() ?? ""
    const agents = loaded.results.size
    const resultPath = join(dir, id, "result.json")
    const done = existsSync(resultPath)
    return { id, name, agents, status: done ? "completed" : "?", at: loaded.meta?.createdAt ?? 0 }
  })
  rows.sort((a, b) => b.at - a.at)
  for (const r of rows) console.log(`${r.id}  ${r.status.padEnd(10)} ${String(r.agents).padStart(3)} agents  ${r.name}`)
}

function dirSize(dir: string): number {
  let total = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    total += e.isDirectory() ? dirSize(p) : statSync(p).size
  }
  return total
}

async function cmdRun(flags: Flags): Promise<void> {
  const file = (flags._ as string[])[1]
  if (!file) {
    console.error("usage: agent-workflows run <file.workflow.js> [--args <json>] [--provider codex|claude-code] [--fake] [--json]")
    process.exitCode = 1
    return
  }
  const overrides: RunOverrides = {}
  const provider = str(flags.provider)
  if (provider) overrides.provider = provider as ProviderId
  const model = str(flags.model)
  if (model) overrides.model = model
  const effort = str(flags.effort)
  if (effort) overrides.effort = effort as Effort
  const sandbox = str(flags.sandbox)
  if (sandbox) overrides.sandbox = sandbox as Sandbox
  const cwd = str(flags.cwd)
  if (cwd) overrides.cwd = resolve(cwd)
  const concurrency = str(flags.concurrency)
  if (concurrency) overrides.concurrency = Number(concurrency)
  const budget = str(flags.budget)
  if (budget) overrides.budget = Number(budget)

  let args: unknown
  const argsStr = str(flags.args)
  if (argsStr) args = JSON.parse(argsStr)
  const argsFile = str(flags["args-file"])
  if (argsFile) args = JSON.parse(readFileSync(resolve(argsFile), "utf8"))

  const outcome = await runWorkflow({
    file,
    args,
    overrides,
    resumeRunId: str(flags.resume),
    fake: flags.fake === true,
    quiet: flags.json === true,
  })

  if (flags.json === true) {
    process.stdout.write(JSON.stringify({ runId: outcome.runId, status: outcome.status, result: outcome.result, error: outcome.error }, null, 2) + "\n")
  } else if (outcome.status === "completed") {
    const r = outcome.result
    process.stdout.write((typeof r === "string" ? r : JSON.stringify(r, null, 2)) + "\n")
    process.stderr.write(`\nrunId: ${outcome.runId} — resume with: agent-workflows run ${file} --resume ${outcome.runId}\n`)
  } else {
    process.stderr.write(`\n${outcome.status}: ${outcome.error ?? ""}\nresume with: agent-workflows run ${file} --resume ${outcome.runId}\n`)
    process.exitCode = 1
  }
}

async function cmdValidate(flags: Flags): Promise<void> {
  const file = (flags._ as string[])[1]
  if (!file) {
    console.error("usage: agent-workflows validate <file.workflow.js>")
    process.exitCode = 1
    return
  }
  const source = readFileSync(resolve(file), "utf8")
  const { meta } = parseWorkflow(source)
  console.log(`ok: "${meta.name}" — ${meta.description}`)
  if (meta.phases) console.log("phases: " + meta.phases.map((p) => p.title).join(" → "))
}

async function cmdDoctor(): Promise<void> {
  const { execFileSync } = await import("node:child_process")
  const check = (bin: string, args: string[]): string => {
    try {
      return execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n")[0] ?? "ok"
    } catch {
      return "NOT FOUND"
    }
  }
  console.log("agent-workflows doctor")
  console.log(`  fake worker  : ok`)
  console.log(`  codex        : ${check("codex", ["--version"])}`)
  console.log(`  claude-code  : ${check("claude", ["--version"])}`)
  console.log(`  data dir     : ${dataRoot()}`)
}

function printHelp(): void {
  console.log(`agent-workflows — run JS workflows that orchestrate Codex and Claude Code agents

Usage:
  agent-workflows run <file.workflow.js> [--args <json>] [--provider codex|claude-code]
                                         [--model m] [--sandbox s] [--cwd dir]
                                         [--concurrency N] [--resume <runId>] [--fake] [--json]
  agent-workflows validate <file.workflow.js>
  agent-workflows doctor

Other commands (serve, runs, tail, list) are added by the viewer/CLI fan-out.`)
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err)
  // Expected user errors (lint/syntax/usage) print clean; unexpected print the stack.
  const expected = /determinism lint|must be the first statement|meta\.|not a valid literal|requires the cwd|exceeds the/.test(msg)
  console.error(expected || !(err instanceof Error) ? msg : (err.stack ?? msg))
  process.exitCode = 1
})
