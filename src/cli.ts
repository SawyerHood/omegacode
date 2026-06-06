#!/usr/bin/env node
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { get as httpGet } from "node:http"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
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
    case "install-skill":
      return cmdInstallSkill(flags)
    case "guide":
      return cmdGuide()
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
  const idleShutdown = flags["idle-shutdown"] === true
  const { url } = await startViewer({ port, host, idleShutdown })
  process.stderr.write(`viewer: ${url}  (reading ${join(dataRoot(), "runs")})\n${idleShutdown ? "idle-shutdown on; " : ""}ctrl-c to stop\n`)
  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => resolve())
    process.once("SIGTERM", () => resolve())
  })
}

/** Is a viewer already serving on this port? */
function viewerUp(port: number): Promise<boolean> {
  return new Promise((res) => {
    const req = httpGet({ host: "127.0.0.1", port, path: "/api/runs", timeout: 500 }, (r) => {
      r.resume()
      res(r.statusCode === 200)
    })
    req.on("error", () => res(false))
    req.on("timeout", () => {
      req.destroy()
      res(false)
    })
  })
}

/** Ensure a viewer is running on `port` (reuse if up, else spawn one detached with idle-shutdown). Returns the base URL. */
async function ensureViewer(port: number): Promise<string> {
  const url = `http://127.0.0.1:${port}/`
  if (await viewerUp(port)) return url
  const child = spawn(process.execPath, [process.argv[1]!, "serve", "--port", String(port), "--idle-shutdown"], {
    detached: true,
    stdio: "ignore",
  })
  child.unref()
  for (let i = 0; i < 50; i++) {
    if (await viewerUp(port)) break
    await new Promise((r) => setTimeout(r, 100))
  }
  return url
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
  try {
    spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref()
  } catch {
    // ignore — the URL is already printed
  }
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
    console.error("usage: omegacode run <file.workflow.js> [--args <json>] [--provider codex|claude-code] [--fake] [--json]")
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

  // Auto-start the viewer (unless --no-serve) and surface the run's URL. Under --json the
  // viewer still comes up, but stdout stays pure JSON: the `view:` line is suppressed and the
  // URL is returned in the JSON `url` field instead.
  const wantServe = flags["no-serve"] !== true
  const port = flags.port ? Number(str(flags.port)) : 4123
  const base = wantServe ? await ensureViewer(port).catch(() => undefined) : undefined
  const onStart = base
    ? (runId: string) => {
        const u = `${base}#/run/${runId}`
        if (flags.json !== true) process.stderr.write(`view: ${u}\n`)
        if (flags.open === true) openBrowser(u)
      }
    : undefined

  const outcome = await runWorkflow({
    file,
    args,
    overrides,
    resumeRunId: str(flags.resume),
    fake: flags.fake === true,
    quiet: flags.json === true,
    onStart,
  })

  if (flags.json === true) {
    const url = base ? `${base}#/run/${outcome.runId}` : undefined
    process.stdout.write(JSON.stringify({ runId: outcome.runId, status: outcome.status, url, result: outcome.result, error: outcome.error }, null, 2) + "\n")
  } else if (outcome.status === "completed") {
    const r = outcome.result
    process.stdout.write((typeof r === "string" ? r : JSON.stringify(r, null, 2)) + "\n")
    process.stderr.write(`\nrunId: ${outcome.runId} — resume with: omegacode run ${file} --resume ${outcome.runId}\n`)
  } else {
    process.stderr.write(`\n${outcome.status}: ${outcome.error ?? ""}\nresume with: omegacode run ${file} --resume ${outcome.runId}\n`)
    process.exitCode = 1
  }
}

async function cmdValidate(flags: Flags): Promise<void> {
  const file = (flags._ as string[])[1]
  if (!file) {
    console.error("usage: omegacode validate <file.workflow.js>")
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
  console.log("omegacode doctor")
  console.log(`  fake worker  : ok`)
  console.log(`  codex        : ${check("codex", ["--version"])}`)
  console.log(`  claude-code  : ${check("claude", ["--version"])}`)
  console.log(`  data dir     : ${dataRoot()}`)
}

/**
 * The single source of truth for the skill + guide: skill/SKILL.md, resolved relative to
 * the CLI — true both from source (src/cli.ts → repo/skill) and the build (dist/cli.js →
 * package/skill). `install-skill` and `guide` both read it through here.
 */
function readSkill(): string {
  const src = join(dirname(fileURLToPath(import.meta.url)), "..", "skill", "SKILL.md")
  if (!existsSync(src)) throw new Error(`skill source not found at ${src}`)
  return readFileSync(src, "utf8")
}

async function cmdGuide(): Promise<void> {
  // Print the authoring guide (the skill body, minus the YAML frontmatter).
  process.stdout.write(readSkill().replace(/^---\n[\s\S]*?\n---\n+/, ""))
}

async function cmdInstallSkill(flags: Flags): Promise<void> {
  let body: string
  try {
    body = readSkill()
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
    return
  }
  const wantClaude = flags.claude === true
  const wantAgents = flags.agents === true
  const both = !wantClaude && !wantAgents // default: install to both
  const targets: string[] = []
  if (both || wantClaude) targets.push(join(homedir(), ".claude", "skills"))
  if (both || wantAgents) targets.push(join(homedir(), ".agents", "skills"))
  for (const base of targets) {
    const dest = join(base, "omegacode")
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, "SKILL.md"), body)
    console.log(`installed skill → ${join(dest, "SKILL.md")}`)
  }
}

function printHelp(): void {
  console.log(`omegacode — run JS workflow files that orchestrate Codex and Claude Code agents

A workflow is a .js file: \`export const meta = {...}\` then a body using the injected
DSL — agent() / parallel() / pipeline() / phase() / log() / now() / random() / budget / args.
Each agent() spawns a real Codex (gpt-5.x) or Claude Code agent; you pick the provider per call.

Usage:
  omegacode run <file.workflow.js> [options]   Run a workflow
      --args '<json>' | --args-file <f>    input exposed as the \`args\` global
      --provider codex|claude-code         default provider (per-agent opts override)
      --model <m>  --effort <e>  --sandbox read-only|workspace-write|danger-full-access
      --cwd <dir>  --concurrency <N>       working dir; max concurrent agents (default 8)
      --budget <N>                         output-token ceiling (enables budget.*)
      --resume <runId>                     replay unchanged prefix, re-run the rest
      --fake                               run with a fake worker (no real agents)
      --json                               print {runId,status,url,result,error} as JSON (viewer still starts)
      --open                               also open the browser to this run
      --no-serve                           don't auto-start the viewer

  By default \`run\` auto-starts the viewer (if not already up) and prints the run's URL
  (with --json the URL is in the JSON \`url\` field and the \`view:\` line is suppressed).

  omegacode serve [--port 4123] [--host h] [--idle-shutdown]   Live read-only web viewer of all runs
  omegacode runs [--prune --keep <N>]           List runs (or prune old ones)
  omegacode validate <file.workflow.js>         Parse + check meta without running
  omegacode doctor                              Check codex/claude availability + data dir
  omegacode guide                               Print the full authoring guide (the skill text)
  omegacode install-skill [--claude] [--agents] Install the authoring skill into agent skill dirs

Runs persist to ~/.omegacode/runs/<id>/. The guide, the install-skill skill, and skill/SKILL.md
are the same single source of truth — run \`omegacode guide\` to read it.`)
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err)
  // Expected user errors (lint/syntax/usage) print clean; unexpected print the stack.
  const expected = /determinism lint|must be the first statement|meta\.|not a valid literal|requires the cwd|exceeds the/.test(msg)
  console.error(expected || !(err instanceof Error) ? msg : (err.stack ?? msg))
  process.exitCode = 1
})
