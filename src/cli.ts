#!/usr/bin/env node
import { spawn } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { get as httpGet } from "node:http"
import { homedir } from "node:os"
import { dirname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { runWorkflow, type RunOverrides } from "./runtime/run.js"
import { parseWorkflow, WorkflowSyntaxError } from "./runtime/sandbox.js"
import { listWorkflows, resolveWorkflowName, WorkflowNotFoundError } from "./runtime/registry.js"
import { dataRoot, Journal, JournalNotFoundError, ResumePreconditionError } from "./runtime/journal.js"
import { WorkflowError } from "./runtime/primitives.js"
import { startViewer } from "./server/serve.js"
import { AgentError, AgentInterrupted } from "./worker/index.js"
import { DEFAULTS, PROVIDER_IDS, type Effort, type Sandbox } from "./dsl/types.js"

export interface Flags {
  _: string[]
  [k: string]: string | boolean | string[]
}

/** Raised for malformed CLI input; main() prints `.message` cleanly (no stack). */
export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UsageError"
  }
}

/**
 * Flags that are pure booleans — they never take a value, so the token after them is NEVER
 * consumed. Without this set, `--fake <file>` would silently swallow the file (running REAL
 * billed agents), and `--json <x>`/`--open <x>`/`--no-serve <x>` would silently disable the
 * flag. `--flag=true`/`--flag=false` is still accepted for explicitness.
 */
const BOOLEAN_FLAGS = new Set([
  "fake",
  "json",
  "open",
  "no-serve",
  "prune",
  "prune-stale",
  "idle-shutdown",
  "claude",
  "agents",
  "help",
  "project",
  "force",
])

/**
 * Parse `argv` into positionals (`_`) and flags. Supports `--flag value`, `--flag=value`, and
 * bare booleans. Known boolean flags (BOOLEAN_FLAGS) never consume the next token. A value-taking
 * flag with no value (end of argv, or followed by another `--flag`) throws a UsageError rather
 * than silently becoming `true` (which previously e.g. turned `--resume` into a fresh run).
 */
export function parseArgs(argv: string[]): Flags {
  const flags: Flags = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === "--") {
      // everything after `--` is positional
      for (let j = i + 1; j < argv.length; j++) (flags._ as string[]).push(argv[j]!)
      break
    }
    if (a.startsWith("--")) {
      const body = a.slice(2)
      const eq = body.indexOf("=")
      if (eq >= 0) {
        const key = body.slice(0, eq)
        const value = body.slice(eq + 1)
        if (BOOLEAN_FLAGS.has(key)) flags[key] = parseBool(key, value)
        else flags[key] = value
        continue
      }
      const key = body
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true
        continue
      }
      const next = argv[i + 1]
      if (next === undefined || next === "--" || next.startsWith("--")) {
        throw new UsageError(`--${key} requires a value`)
      }
      flags[key] = next
      i++
    } else {
      ;(flags._ as string[]).push(a)
    }
  }
  return flags
}

function parseBool(key: string, value: string): boolean {
  if (value === "true" || value === "") return true
  if (value === "false") return false
  throw new UsageError(`--${key} is a boolean flag; expected true/false, got "${value}"`)
}

function str(v: string | boolean | string[] | undefined): string | undefined {
  return typeof v === "string" ? v : undefined
}

/** Number() but empty/whitespace is NaN, not 0 — `--keep=` must not parse as 0 (= prune ALL runs). */
function toNumber(raw: string): number {
  return raw.trim() === "" ? NaN : Number(raw)
}

/** Parse a flag as a non-negative integer, throwing a friendly UsageError otherwise. */
function intFlag(flags: Flags, name: string): number | undefined {
  const raw = str(flags[name])
  if (raw === undefined) return undefined
  const n = toNumber(raw)
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`--${name} must be a non-negative integer, got "${raw}"`)
  return n
}

/** Parse a flag as a positive integer (>= 1). */
function positiveIntFlag(flags: Flags, name: string): number | undefined {
  const n = intFlag(flags, name)
  if (n !== undefined && n < 1) throw new UsageError(`--${name} must be a positive integer (>= 1), got "${str(flags[name])}"`)
  return n
}

/** Parse a flag as a non-negative finite number. */
function numberFlag(flags: Flags, name: string): number | undefined {
  const raw = str(flags[name])
  if (raw === undefined) return undefined
  const n = toNumber(raw)
  if (!Number.isFinite(n) || n < 0) throw new UsageError(`--${name} must be a non-negative number, got "${raw}"`)
  return n
}

const PROVIDERS = PROVIDER_IDS
const SANDBOXES: Sandbox[] = ["read-only", "workspace-write", "danger-full-access"]
const EFFORTS: Effort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]

function enumFlag<T extends string>(flags: Flags, name: string, allowed: readonly T[]): T | undefined {
  const raw = str(flags[name])
  if (raw === undefined) return undefined
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new UsageError(`--${name} must be one of ${allowed.join(", ")}, got "${raw}"`)
  }
  return raw as T
}

/** Resolve --port, defaulting to 4123. Must be a valid TCP port (1-65535). */
function portFlag(flags: Flags): number {
  const raw = str(flags.port)
  if (raw === undefined) return 4123
  const n = toNumber(raw)
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new UsageError(`--port must be an integer 1-65535, got "${raw}"`)
  return n
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const flags = parseArgs(argv)
  const cmd = (flags._ as string[])[0]

  switch (cmd) {
    case "run":
      return cmdRun(flags)
    case "serve":
      return cmdServe(flags)
    case "runs":
      return cmdRuns(flags)
    case "workflows":
      return cmdWorkflows(flags)
    case "save":
      return cmdSave(flags)
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
  const port = portFlag(flags)
  const host = str(flags.host)
  const idleShutdown = flags["idle-shutdown"] === true
  const { url, close } = await startViewer({
    port,
    host,
    idleShutdown,
    // The library never exits the process itself (L21) — without this handler an --idle-shutdown
    // viewer (what ensureViewer auto-spawns per run) closes its server when idle but lingers
    // forever as a zombie process, kept alive by the SIGINT/SIGTERM listeners below.
    onIdle: (h) => {
      void h
        .close()
        .catch(() => {})
        .finally(() => process.exit(0))
    },
  })
  process.stderr.write(`viewer: ${url}  (reading ${join(dataRoot(), "runs")})\n${idleShutdown ? "idle-shutdown on; " : ""}ctrl-c to stop\n`)
  // Stop on the first SIGINT/SIGTERM: close the server and exit so supervisors can terminate us.
  await new Promise<void>((resolveStop) => {
    const stop = (): void => {
      void close()
        .catch(() => {})
        .finally(() => resolveStop())
    }
    process.once("SIGINT", stop)
    process.once("SIGTERM", stop)
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

/**
 * Ensure a viewer is running on `port` (reuse if up, else spawn one detached with idle-shutdown).
 * Returns the base URL, or undefined if the viewer never came up — callers must NOT claim a URL on
 * undefined (a dead URL is worse than none). Under tsx (dev / running from source via the loader)
 * the detached `node dist/cli.js` spawn can't be relied on, so we skip the spawn and only reuse an
 * already-running viewer.
 */
async function ensureViewer(port: number): Promise<string | undefined> {
  const url = `http://127.0.0.1:${port}/`
  if (await viewerUp(port)) return url
  // Spawn this module's own on-disk path — NOT process.argv[1], which npm installs as a bin
  // SYMLINK (the child must be the real runnable .js however we were invoked). Running from a .ts
  // entrypoint means we're under a loader (tsx) that the detached node child won't have; spawning
  // `node <thisfile.ts>` would fail. Don't promise a URL we can't deliver.
  const entry = fileURLToPath(import.meta.url)
  if (entry.endsWith(".ts")) return undefined

  const child = spawn(process.execPath, [entry, "serve", "--port", String(port), "--idle-shutdown"], {
    detached: true,
    stdio: "ignore",
  })
  child.on("error", () => {}) // spawn ENOENT etc. arrive async; swallow so we don't crash the run
  child.unref()
  for (let i = 0; i < 50; i++) {
    if (await viewerUp(port)) return url
    await new Promise((r) => setTimeout(r, 100))
  }
  // Never came up — report failure so the caller doesn't print a dead URL.
  return undefined
}

/**
 * The opener command for a platform. win32: `start` is a cmd.exe builtin, not an executable, so it
 * must go through `cmd /c start "" <url>` (the empty "" is the window-title arg `start` expects
 * before the URL); spawning `start` directly always ENOENTs.
 */
export function browserOpenCommand(platform: NodeJS.Platform, url: string): [string, string[]] {
  if (platform === "darwin") return ["open", [url]]
  if (platform === "win32") return ["cmd", ["/c", "start", "", url]]
  return ["xdg-open", [url]]
}

export function openBrowser(url: string): void {
  const [cmd, args] = browserOpenCommand(process.platform, url)
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" })
    // ENOENT (no `xdg-open`, etc.) is delivered as an async 'error' event that the try/catch can't
    // see — without this listener it becomes an uncaught exception that crashes the CLI mid-run.
    child.on("error", () => {})
    child.unref()
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
    // A non-numeric/negative --keep used to become NaN → slice(NaN) → delete EVERY run (journals
    // and all). Validate it as a non-negative integer first.
    const keep = intFlag(flags, "keep") ?? 50
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

  if (flags["prune-stale"] === true) {
    const stale = ids.filter((id) => isStaleRun(dir, id))
    let bytes = 0
    for (const id of stale) {
      bytes += dirSize(join(dir, id))
      rmSync(join(dir, id), { recursive: true, force: true })
    }
    console.log(`pruned ${stale.length} stale run(s) (${(bytes / 1e6).toFixed(1)} MB)`)
    return
  }

  const rows = ids.map((id) => {
    const loaded = Journal.load(id)
    const name = loaded.meta?.workflowFile?.split("/").pop() ?? ""
    const agents = loaded.results.size
    const resultPath = join(dir, id, "result.json")
    const done = existsSync(resultPath)
    const status = done ? "completed" : isStaleRun(dir, id) ? "stale" : "?"
    return { id, name, agents, status, at: loaded.meta?.createdAt ?? 0 }
  })
  rows.sort((a, b) => b.at - a.at)
  for (const r of rows) console.log(`${r.id}  ${r.status.padEnd(10)} ${String(r.agents).padStart(3)} agents  ${r.name}`)
}

/**
 * A run stuck at "started" whose heartbeat is missing or older than 20s — its process died
 * (SIGKILL / crash / closed terminal) without writing a terminal event. The deadman switch.
 */
function isStaleRun(runsBase: string, id: string): boolean {
  const rd = join(runsBase, id)
  let lastRunStatus: string | undefined
  try {
    const lines = readFileSync(join(rd, "events.jsonl"), "utf8").trim().split("\n")
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i]!.match(/"type":"run","status":"([a-z]+)"/)
      if (m) {
        lastRunStatus = m[1]
        break
      }
    }
  } catch {
    return false
  }
  if (lastRunStatus !== "started") return false
  let beat = 0
  try {
    beat = statSync(join(rd, ".heartbeat")).mtimeMs
  } catch {
    // no heartbeat file
  }
  return Date.now() - beat > 20_000
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
    console.error("usage: omegacode run <file.workflow.js | name> [--args <json>] [--provider codex|claude-code|opencode|pi] [--fake] [--json]")
    process.exitCode = 1
    return
  }
  // Resolve now, not in runWorkflow: a registry name (e.g. `omegacode run code-review`) must
  // become a real file path before the run starts. The resume hints below keep printing the
  // user's original arg — names re-resolve on the next invocation.
  const resolvedFile = resolveFileOrName(file)
  const overrides: RunOverrides = {}
  const provider = enumFlag(flags, "provider", PROVIDERS)
  if (provider) overrides.provider = provider
  const model = str(flags.model)
  if (model) overrides.model = model
  const effort = enumFlag(flags, "effort", EFFORTS)
  if (effort) overrides.effort = effort
  const sandbox = enumFlag(flags, "sandbox", SANDBOXES)
  if (sandbox) overrides.sandbox = sandbox
  const cwd = str(flags.cwd)
  if (cwd) overrides.cwd = resolve(cwd)
  const concurrency = positiveIntFlag(flags, "concurrency")
  if (concurrency !== undefined) overrides.concurrency = concurrency
  const budget = numberFlag(flags, "budget")
  if (budget !== undefined) overrides.budget = budget

  // --resume, if present, must carry a runId — a bare `--resume` used to silently start a fresh run.
  const resumeRunId = str(flags.resume)
  if (resumeRunId !== undefined && resumeRunId.length === 0) throw new UsageError("--resume requires a runId")

  let args: unknown
  const argsStr = str(flags.args)
  if (argsStr !== undefined) {
    try {
      args = JSON.parse(argsStr)
    } catch (err) {
      throw new UsageError(`--args is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const argsFile = str(flags["args-file"])
  if (argsFile) {
    let raw: string
    try {
      raw = readFileSync(resolve(argsFile), "utf8")
    } catch {
      throw new UsageError(`--args-file not found: ${argsFile}`)
    }
    try {
      args = JSON.parse(raw)
    } catch (err) {
      throw new UsageError(`--args-file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Auto-start the viewer (unless --no-serve) and surface the run's URL. Under --json the
  // viewer still comes up, but stdout stays pure JSON: the `view:` line is suppressed and the
  // URL is returned in the JSON `url` field instead.
  const wantServe = flags["no-serve"] !== true
  const port = portFlag(flags)
  // ensureViewer returns undefined when the viewer never came up — never claim a dead URL.
  const base = wantServe ? await ensureViewer(port).catch(() => undefined) : undefined
  const onStart = base
    ? (runId: string) => {
        const u = `${base}#/run/${runId}`
        if (flags.json !== true) process.stderr.write(`view: ${u}\n`)
        if (flags.open === true) openBrowser(u)
      }
    : undefined

  const outcome = await runWorkflow({
    file: resolvedFile,
    args,
    overrides,
    resumeRunId,
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
    console.error("usage: omegacode validate <file.workflow.js | name>")
    process.exitCode = 1
    return
  }
  const source = readFileSync(resolveFileOrName(file), "utf8")
  const { meta } = parseWorkflow(source)
  console.log(`ok: "${meta.name}" — ${meta.description}`)
  if (meta.phases) console.log("phases: " + meta.phases.map((p) => p.title).join(" → "))
}

/**
 * Resolve a `run`/`validate` positional that is either a file path or a registry name. An
 * existing path always wins. An arg that LOOKS like a path (separator, or a .js suffix) but
 * doesn't exist is an error — it must not silently fall through to a registry lookup, which
 * would run some same-named workflow instead of the file the user meant.
 */
function resolveFileOrName(arg: string): string {
  const abs = resolve(arg)
  if (existsSync(abs)) return abs
  if (arg.includes("/") || arg.includes(sep) || arg.endsWith(".js")) {
    throw new UsageError(`workflow file not found: ${arg}`)
  }
  return resolveWorkflowName(arg)
}

async function cmdWorkflows(flags: Flags): Promise<void> {
  const entries = listWorkflows()
  if (flags.json === true) {
    process.stdout.write(JSON.stringify(entries, null, 2) + "\n")
    return
  }
  if (entries.length === 0) {
    console.log("(no saved workflows — use `omegacode save <file>` to add one)")
    return
  }
  const width = Math.max(...entries.map((e) => e.name.length))
  for (const e of entries) {
    console.log(`${e.name.padEnd(width)}  ${`[${e.tier}]`.padEnd(9)}  ${e.description}`)
  }
}

async function cmdSave(flags: Flags): Promise<void> {
  const file = (flags._ as string[])[1]
  if (!file) {
    console.error("usage: omegacode save <file.workflow.js> [--project] [--force]")
    process.exitCode = 1
    return
  }
  const absFile = resolve(file)
  if (!existsSync(absFile)) throw new UsageError(`file not found: ${file}`)

  // Parse to validate the workflow AND to get its name — the registry resolves by meta.name,
  // so meta.name IS the saved name (there is deliberately no --name flag: a filename-only
  // rename would not change what `omegacode run <name>` matches).
  const { meta } = parseWorkflow(readFileSync(absFile, "utf8"))
  const name = meta.name
  if (name.includes("/") || name.includes("\\") || name.includes("..") || name.startsWith(".") || name.includes("\0")) {
    throw new UsageError(`meta.name is not a safe filename: "${name}"`)
  }

  const useProject = flags.project === true
  const destDir = useProject ? join(process.cwd(), ".omegacode", "workflows") : join(dataRoot(), "workflows")
  const dest = join(destDir, name + ".workflow.js")
  if (existsSync(dest) && flags.force !== true) {
    throw new UsageError(`${useProject ? "project" : "user"} workflow "${name}" already exists at ${dest} — use --force to overwrite`)
  }
  mkdirSync(destDir, { recursive: true })
  copyFileSync(absFile, dest)
  console.log(`saved "${name}" → ${dest}`)
}

async function cmdDoctor(): Promise<void> {
  const { execFileSync } = await import("node:child_process")
  const { mkdtempSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { versionAtLeast } = await import("./worker/subprocess-jsonl.js")
  const { OPENCODE_MIN_VERSION } = await import("./worker/opencode.js")
  const { PI_MIN_VERSION } = await import("./worker/pi.js")

  const check = (bin: string, args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): string => {
    try {
      return (
        execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: opts.env, cwd: opts.cwd, timeout: 10_000 })
          .trim()
          .split("\n")[0] ?? "ok"
      )
    } catch {
      return "NOT FOUND"
    }
  }
  // Flag below-minimum versions: the workers refuse them at runtime (provider_outdated), so the
  // doctor row should say so up front rather than let the first paid run discover it.
  const withMin = (out: string, min: string, hint: string): string => {
    if (out === "NOT FOUND" || versionAtLeast(out, min)) return out
    return `${out} — OUTDATED (< ${min}); ${hint}`
  }

  // Doctor must resolve binaries the same way the runtime does (env overrides), or it reports
  // NOT FOUND for a binary the factory would happily spawn.
  const codexBin = process.env.CODEX_BIN ?? "codex"
  const opencodeBin = process.env.OPENCODE_BIN ?? "opencode"
  const piBin = process.env.PI_BIN ?? "pi"

  // pi probes run isolated (scratch agent dir, neutral cwd): old binaries wrote lock files and a
  // repo-local .pi even on --version, and 0.79.1 is not confirmed clean.
  const piScratch = mkdtempSync(join(tmpdir(), "omegacode-doctor-pi-"))
  let piOut: string
  try {
    piOut = check(piBin, ["--version"], { env: { ...process.env, PI_CODING_AGENT_DIR: piScratch }, cwd: tmpdir() })
  } finally {
    rmSync(piScratch, { recursive: true, force: true })
  }

  console.log("omegacode doctor")
  console.log(`  fake worker  : ok`)
  console.log(`  codex        : ${check(codexBin, ["--version"])}`)
  console.log(`  claude-code  : ${check("claude", ["--version"])}`)
  console.log(`  opencode     : ${withMin(check(opencodeBin, ["--version"]), OPENCODE_MIN_VERSION, "upgrade the opencode CLI")}`)
  console.log(`  pi           : ${withMin(piOut, PI_MIN_VERSION, "npm i -g @earendil-works/pi-coding-agent")}`)
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
  omegacode run <file.workflow.js | name> [options]   Run a workflow (by path or saved name)
      --args '<json>' | --args-file <f>    input exposed as the \`args\` global
      --provider codex|claude-code|opencode|pi   default provider (per-agent opts override)
      --model <m>  --effort <e>  --sandbox read-only|workspace-write|danger-full-access
      --cwd <dir>  --concurrency <N>       working dir; max concurrent agents (default ${DEFAULTS.concurrency})
      --budget <N>                         output-token ceiling (enables budget.*)
      --resume <runId>                     replay unchanged prefix, re-run the rest
      --fake                               run with a fake worker (no real agents)
      --json                               print {runId,status,url,result,error} as JSON (viewer still starts)
      --open                               also open the browser to this run
      --no-serve                           don't auto-start the viewer

  By default \`run\` auto-starts the viewer (if not already up) and prints the run's URL
  (with --json the URL is in the JSON \`url\` field and the \`view:\` line is suppressed).

  omegacode serve [--port 4123] [--host h] [--idle-shutdown]   Live read-only web viewer of all runs
  omegacode runs [--prune --keep <N>] [--prune-stale]   List runs (--prune old, --prune-stale dead)
  omegacode workflows [--json]                  List saved/named workflows (project, user, builtin)
  omegacode save <file.workflow.js> [--project] [--force]   Save a workflow under its meta.name
  omegacode validate <file.workflow.js | name>  Parse + check meta without running
  omegacode doctor                              Check codex/claude availability + data dir
  omegacode guide                               Print the full authoring guide (the skill text)
  omegacode install-skill [--claude] [--agents] Install the authoring skill into agent skill dirs

Named workflows resolve by meta.name across three tiers (highest first): project
(.omegacode/workflows/ from cwd up to the repo root), user (~/.omegacode/workflows/), and the
package built-ins. \`run\`/\`validate\` accept a bare name — anything with a path separator or
.js suffix is treated as a file path. Workflows read their parameters from --args:
  omegacode run deep-research --args '"<question>"'
  omegacode run code-review [--args '{"target": "<ref|path>", "level": "high|xhigh|max"}']

Runs persist to ~/.omegacode/runs/<id>/. The guide, the install-skill skill, and skill/SKILL.md
are the same single source of truth — run \`omegacode guide\` to read it.`)
}

/**
 * Decide whether an error is an expected, user-facing message (print clean) vs. an internal bug
 * (print the stack). Classify by typed error class — not by matching the prose of `.message`,
 * which silently regressed every time a message was reworded.
 */
export function isUserFacingError(err: unknown): boolean {
  if (
    err instanceof UsageError ||
    err instanceof WorkflowSyntaxError ||
    err instanceof WorkflowNotFoundError ||
    err instanceof WorkflowError ||
    err instanceof AgentError ||
    err instanceof AgentInterrupted ||
    err instanceof JournalNotFoundError ||
    err instanceof ResumePreconditionError
  ) {
    return true
  }
  // The determinism lint is the one user-facing message still thrown as a bare Error (from run.ts,
  // which this subsystem doesn't own). Match its stable prefix until it gets its own error class.
  return err instanceof Error && err.message.startsWith("determinism lint failed:")
}

/**
 * Are we the CLI entrypoint (vs. imported as a module, e.g. from tests)? npm installs `bin`
 * entries as SYMLINKS, and Node realpath-resolves the entry module — so import.meta.url is the
 * real dist/cli.js while argv[1] keeps the symlink path. A plain path comparison never matches
 * there, turning the installed CLI into a silent no-op; compare against the realpath of argv[1].
 */
function invokedDirectly(): boolean {
  const argv1 = process.argv[1]
  if (argv1 === undefined) return false
  const self = fileURLToPath(import.meta.url)
  if (self === resolve(argv1)) return true // direct invocation (also covers --preserve-symlinks-main)
  try {
    return self === realpathSync(argv1)
  } catch {
    return false // argv[1] isn't on disk — definitely not this module
  }
}

// Only run main() when invoked as the CLI entrypoint — importing this module must not start the program.
if (invokedDirectly()) {
  main().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err)
    // Expected user errors (usage / lint / syntax / provider) print clean; unexpected print the stack.
    console.error(isUserFacingError(err) || !(err instanceof Error) ? msg : (err.stack ?? msg))
    process.exitCode = 1
  })
}
