// ClaudeWorker — drives Claude Code via @anthropic-ai/claude-agent-sdk `query()`.
// Structured output uses the SDK's native `outputFormat: { type: "json_schema" }`; sandbox maps to a
// canUseTool gate. Claude has no OS-level sandbox like codex, so the gate is the only enforcement:
//   read-only           → no write tools; Bash limited to a read-only allowlist.
//   workspace-write      → write tools allowed only for paths inside spec.cwd; Bash allowed.
//   danger-full-access   → everything allowed.
// One query() per agent turn.

import { readlinkSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { query, type Options, type PermissionResult, type SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { addUsage, emptyUsage, type AgentResult, type AgentSpec, type AgentUsage, type Effort, type Sandbox } from "../dsl/types.js"
import type { Worker, WorkerContext } from "./index.js"
import { AgentError, AgentInterrupted } from "./index.js"
import { assertValidSchema, toClaudeOutputFormat } from "./schema.js"

const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"])
// Tool input keys that name a filesystem target a write tool will modify.
const PATH_KEYS = ["file_path", "filePath", "path", "notebook_path", "notebookPath"]
// Read-only shell programs we permit under the read-only sandbox so agents can still
// inspect the repo (git log/grep, ls, cat, …). argv[0] of the resolved command must match.
// Deliberately excludes interpreters (node/python/perl/sh/bash) — they can execute arbitrary code
// that writes to disk, which would defeat the read-only boundary.
const READONLY_BASH = new Set([
  "ls", "cat", "head", "tail", "grep", "rg", "find", "fd", "wc", "echo", "pwd", "which", "type",
  "stat", "file", "tree", "sort", "uniq", "cut", "diff", "git", "jq", "date", "basename",
  "dirname", "realpath", "true", "false", "test",
])
// git subcommands that mutate; everything else (log, status, diff, show, …) is read-only.
const GIT_WRITE = new Set([
  "add", "commit", "push", "pull", "fetch", "merge", "rebase", "reset", "checkout", "switch",
  "branch", "tag", "clean", "rm", "mv", "stash", "apply", "cherry-pick", "revert", "restore",
  "init", "clone", "worktree", "config",
])
// Pre-subcommand git global flags that consume a SEPARATE following token. Their value must not be
// mistaken for the subcommand — e.g. `git -C dir reset` writes via `reset`, not the directory `dir`.
const GIT_VALUE_FLAGS = new Set([
  "-C", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--attr-source",
])

/**
 * The slice of the SDK's query() the worker consumes (the message stream). Injectable via
 * ClaudeWorkerOpts so tests can script turns — the claude analogue of CodexWorker's spawnChild.
 */
export type QueryFn = (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>

export interface ClaudeWorkerOpts {
  model?: string
  pathToClaudeCodeExecutable?: string
  /** Test seam: replaces the SDK's query(). Production (the factory) never sets this. */
  queryFn?: QueryFn
}

// The SDK supports low/medium/high/xhigh/max. The codex-only tiers ("none", "minimal") have no
// Claude equivalent, so they map to the SDK's lowest level; the rest pass through unchanged.
type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max"
function toClaudeEffort(effort: Effort): ClaudeEffort {
  return effort === "none" || effort === "minimal" ? "low" : effort
}

export class ClaudeWorker implements Worker {
  readonly id = "claude-code" as const
  constructor(private readonly opts: ClaudeWorkerOpts = {}) {}

  async runAgent(spec: AgentSpec, ctx: WorkerContext): Promise<AgentResult> {
    if (ctx.signal.aborted) throw new AgentInterrupted()
    if (spec.schema) {
      // Surface author schema errors (bad $ref, typo'd type) BEFORE the paid turn.
      try {
        assertValidSchema(spec.schema)
      } catch (err) {
        throw new AgentError({ provider: "claude-code", code: "invalid_schema", message: `output schema does not compile: ${(err as Error).message}` })
      }
    }
    const abort = new AbortController()
    const onAbort = () => abort.abort()
    ctx.signal.addEventListener("abort", onAbort, { once: true })

    const options: Options = {
      cwd: spec.cwd,
      model: spec.model ?? this.opts.model,
      maxTurns: spec.maxTurns,
      settingSources: [],
      permissionMode: "default",
      abortController: abort,
      canUseTool: (toolName: string, input: Record<string, unknown>): Promise<PermissionResult> => {
        const verdict = checkTool(spec.sandbox, spec.cwd, toolName, input)
        if (verdict) return Promise.resolve({ behavior: "deny", message: verdict })
        return Promise.resolve({ behavior: "allow", updatedInput: input })
      },
    }
    // codex-only "none"/"minimal" map to the SDK's lowest; the rest match the SDK effort levels.
    if (spec.effort) options.effort = toClaudeEffort(spec.effort)
    if (spec.schema) options.outputFormat = toClaudeOutputFormat(spec.schema)
    if (spec.instructions) options.systemPrompt = { type: "preset", preset: "claude_code", append: spec.instructions }
    if (this.opts.pathToClaudeCodeExecutable) options.pathToClaudeCodeExecutable = this.opts.pathToClaudeCodeExecutable

    try {
      // The CLI normally ends the stream with a `result` message carrying the final text, usage,
      // and structured output. When background tasks (Monitor / Bash run_in_background) straddle
      // the end of the turn, that contract breaks two ways: the stream can end with no result
      // message at all, or a task-notification turn appended after the real answer can emit its
      // own result that lacks the structured output an earlier turn already provided (and whose
      // text is watcher chatter, not the answer). So: prefer the last NON-notification result
      // (`origin.kind` discriminates), and capture the accepted StructuredOutput tool payload
      // from the stream as the recovery source — otherwise finished agents get marked failed.
      let primaryResult: Extract<SDKMessage, { type: "result" }> | undefined
      let anyResult: Extract<SDKMessage, { type: "result" }> | undefined
      let lastText = ""
      let structuredFromTool: unknown
      let pendingStructuredId: string | undefined
      let pendingStructuredInput: unknown
      let lastUsageId: string | undefined
      let streamUsage = emptyUsage()
      const runQuery = this.opts.queryFn ?? query
      for await (const message of runQuery({ prompt: spec.prompt, options })) {
        if (message.type === "result") {
          anyResult = message
          if (message.origin?.kind !== "task-notification") primaryResult = message
        } else if (message.type === "assistant") {
          const m = message.message as { id?: unknown; usage?: unknown; content?: unknown }
          // Subagent (Task) messages relay through the same stream with parent_tool_use_id set —
          // keep them out of the recovery bookkeeping (progress events still flow below).
          const topLevel = message.parent_tool_use_id == null
          // Best-effort usage for the no-result recovery path (a result message supersedes this).
          // The SDK repeats one API message across consecutive assistant events with the same
          // (final) usage, so count each id once; cost stays 0 — only a result message knows it.
          if (topLevel && typeof m.id === "string" && m.id !== lastUsageId) {
            lastUsageId = m.id
            streamUsage = addUsage(streamUsage, usageFromResult({ usage: m.usage }))
          }
          for (const block of asBlocks(m.content)) {
            if (block.type === "text" && typeof block.text === "string") {
              if (topLevel) lastText = block.text
              ctx.onProgress({ kind: "text", text: block.text })
            } else if (block.type === "thinking" && typeof block.thinking === "string") {
              ctx.onProgress({ kind: "reasoning", text: block.thinking })
            } else if (block.type === "tool_use" && typeof block.name === "string") {
              if (topLevel && block.name === "StructuredOutput" && typeof block.id === "string") {
                pendingStructuredId = block.id
                pendingStructuredInput = block.input
              }
              ctx.onProgress({ kind: "tool", id: typeof block.id === "string" ? block.id : undefined, name: block.name, input: block.input })
            }
          }
        } else if (message.type === "user") {
          for (const block of asBlocks((message.message as { content?: unknown }).content)) {
            if (block.type === "tool_result") {
              // Commit the payload only once the CLI accepted it — a rejected call gets retried
              // by the model and must not shadow the eventual good one.
              if (pendingStructuredId !== undefined && block.tool_use_id === pendingStructuredId && block.is_error !== true) {
                structuredFromTool = pendingStructuredInput
                pendingStructuredId = pendingStructuredInput = undefined
              }
              const out = typeof block.content === "string" ? block.content : JSON.stringify(block.content)
              ctx.onProgress({ kind: "tool-result", id: typeof block.tool_use_id === "string" ? block.tool_use_id : undefined, output: out, isError: block.is_error === true })
            }
          }
        }
      }

      if (!primaryResult && spec.schema && structuredFromTool !== undefined && pendingStructuredId === undefined) {
        // The real turn's result never arrived (at most a notification turn's did), but the agent
        // demonstrably finished its deliverable — the CLI accepted its StructuredOutput call.
        // Recover instead of discarding finished work; schema validation still happens downstream
        // in finalizeResult. A still-pending call is evidence of the opposite — the agent was
        // superseding the accepted payload when the stream cut — so it disables recovery rather
        // than deliver stale data. An abort can truncate the stream into this same shape — that
        // must stay an interruption, not a success with a possibly-superseded payload.
        if (ctx.signal.aborted) throw new AgentInterrupted()
        // Tokens come from the stream; cost only a result message knows — take what we have.
        if (anyResult) streamUsage.costUsd = usageFromResult(anyResult).costUsd
        return { text: lastText, structured: structuredFromTool, status: "completed", usage: streamUsage }
      }
      // A lone notification-turn result is still a better last resort than no_result for
      // free-form agents; with a schema the recovery branch above already outranked it.
      const lastResult = primaryResult ?? anyResult
      if (!lastResult) {
        // Free-form agents have no completion marker (partial text from a truncated stream must
        // not pass as an answer), so without the StructuredOutput evidence the error stays hard.
        throw new AgentError({ provider: "claude-code", code: "no_result", message: "claude query ended without a result" })
      }
      const usage = usageFromResult(lastResult)
      if (lastResult.subtype !== "success") {
        // error_max_turns is a terminal cap, not a transient fault — never retry it. Carry the
        // usage on the error: failed turns still bill, so budget ceilings must see them.
        const retryable = lastResult.subtype !== "error_max_turns" && /rate|overload|529|429/i.test(lastResult.subtype)
        throw new AgentError({ provider: "claude-code", code: lastResult.subtype, message: `claude result: ${lastResult.subtype}`, retryable, usage })
      }
      return {
        text: lastResult.result,
        structured: spec.schema ? (lastResult.structured_output ?? structuredFromTool) : undefined,
        status: "completed",
        usage,
      }
    } catch (err) {
      if (ctx.signal.aborted) throw new AgentInterrupted()
      if (err instanceof AgentError || err instanceof AgentInterrupted) throw err
      throw new AgentError({ provider: "claude-code", code: "sdk_error", message: (err as Error).message, retryable: true })
    } finally {
      ctx.signal.removeEventListener("abort", onAbort)
    }
  }

  async shutdown(): Promise<void> {}
}

/**
 * Sandbox enforcement for the canUseTool gate. Returns a deny message, or `undefined` to allow.
 * Exported for tests; the write boundary (paths inside spec.cwd) is the security-critical part.
 */
export function checkTool(sandbox: Sandbox, cwd: string, toolName: string, input: Record<string, unknown>): string | undefined {
  if (sandbox === "danger-full-access") return undefined

  if (WRITE_TOOLS.has(toolName)) {
    if (sandbox === "read-only") return `${toolName} not allowed in read-only mode`
    // workspace-write: target path(s) must stay inside cwd; a write tool naming no recognizable
    // target fails closed rather than slipping through the boundary.
    const targets = writeTargets(input)
    if (targets.length === 0) return `${toolName} write target could not be determined`
    for (const p of targets) {
      if (!withinCwd(cwd, p)) return `${toolName} target ${p} is outside the workspace`
    }
    return undefined
  }

  if (toolName === "Bash") {
    const command = typeof input.command === "string" ? input.command : ""
    if (sandbox === "read-only") {
      return isReadOnlyBash(command) ? undefined : `Bash command not allowed in read-only mode: ${command}`
    }
    // workspace-write: Claude has no OS sandbox, so arbitrary shell can't be hard-confined the
    // way file tools are. Catch the unambiguous escapes (redirect targets / well-known write
    // programs naming paths outside cwd); the file-tool gate carries the hard boundary.
    const escape = bashWriteOutsideCwd(cwd, command)
    if (escape) return `Bash writes outside the workspace: ${escape}`
    return undefined
  }

  return undefined
}

/**
 * Resolve a candidate path against cwd and test containment. The lexical resolve alone is not
 * sound: a symlink INSIDE cwd pointing outside would pass it while the write lands outside the
 * workspace. Both sides are therefore realpath'd (of the deepest existing ancestor — a Write
 * target usually doesn't exist yet) before comparing.
 */
function withinCwd(cwd: string, candidate: string): boolean {
  const base = realpathUpward(resolve(cwd))
  const target = realpathUpward(isAbsolute(candidate) ? resolve(candidate) : resolve(resolve(cwd), candidate))
  if (target === base) return true
  const rel = relative(base, target)
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)
}

/**
 * realpath that tolerates non-existent suffixes: resolve symlinks in the deepest existing
 * ancestor, then re-append the (necessarily symlink-free, because nonexistent) remainder. A
 * BROKEN symlink still redirects a write to its target, so those are followed manually —
 * realpathSync refuses them. Falls back to the lexical path when nothing along it exists (e.g.
 * fictional roots in unit tests) or on a pathological link cycle (the OS rejects such writes
 * with ELOOP anyway, so the lexical answer cannot enable an escape).
 */
function realpathUpward(p: string): string {
  let existing = p
  let suffix = ""
  for (let hops = 0; hops < 40; hops++) {
    try {
      const real = realpathSync(existing)
      return suffix ? join(real, suffix) : real
    } catch {
      // fall through: `existing` doesn't fully resolve
    }
    try {
      // A broken symlink: follow it to where the write would actually land.
      const link = readlinkSync(existing)
      existing = isAbsolute(link) ? resolve(link) : resolve(dirname(existing), link)
      continue
    } catch {
      // not a symlink — peel one lexical component and retry the parent
    }
    const parent = dirname(existing)
    if (parent === existing) return p // unresolvable all the way to the root — keep the lexical path
    suffix = suffix ? join(basename(existing), suffix) : basename(existing)
    existing = parent
  }
  return p
}

/** Pull every filesystem target a write tool's input names. */
function writeTargets(input: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const key of PATH_KEYS) {
    const v = input[key]
    if (typeof v === "string" && v.length > 0) out.push(v)
  }
  return out
}

/**
 * Conservatively decide whether a shell command only reads. Splits on shell operators and requires
 * EVERY segment's program to be a known read-only command (git limited to read-only subcommands).
 * Any redirection to a real file, command substitution, or an unknown program fails closed.
 */
export function isReadOnlyBash(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed) return false
  // Command/process substitution executes arbitrary programs regardless of argv[0].
  if (/\$\(|`|<\(|>\(/.test(trimmed)) return false
  // Strip harmless redirects (fd dups like 2>&1 / >&2, redirects to /dev sinks), then treat any
  // remaining `>` as a disk write — `2>err.txt` writes a file just like `> err.txt` does.
  const sanitized = trimmed
    .replace(/\d*>&\s*\d+/g, " ")
    .replace(/\d*>>?\s*\/dev\/(?:null|stdout|stderr|tty)\b/g, " ")
  if (sanitized.includes(">")) return false
  for (const seg of sanitized.split(/&&|\|\||\||;|&|\r?\n/)) {
    const tokens = seg.trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) continue
    let i = 0
    // Skip leading VAR=value assignments and transparent `env` prefixes — `env cmd` executes cmd,
    // so the program under env is what must be classified.
    while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!) || tokens[i] === "env")) i++
    const prog = tokens[i]
    if (!prog) continue // assignment-only / bare `env` segment is harmless
    const base = prog.split("/").pop()!
    if (!READONLY_BASH.has(base)) return false
    const args = tokens.slice(i + 1)
    // Flags that turn read-only programs into writers.
    if (args.some((t) => t.startsWith("--output"))) return false
    // sort/tree `-o FILE` write to a file — catch both the separate (`-o f`) and attached (`-of`) forms.
    if ((base === "sort" || base === "tree") && args.some((t) => t.startsWith("-o"))) return false
    if (base === "git") {
      const sub = gitSubcommand(args)
      // null = pre-subcommand config injection (-c / --config-env), which can run arbitrary commands
      // via pagers/hooks (core.fsmonitor, …); undefined = no subcommand (e.g. `git --version`).
      if (sub === null) return false
      if (sub && GIT_WRITE.has(sub)) return false
    }
    if (base === "find") {
      // find can write/execute: -delete, -exec/-execdir, -fprint…/-fls (write to a file), -ok…
      if (args.some((t) => t === "-delete" || t === "-fls" || t.startsWith("-exec") || t.startsWith("-ok") || t.startsWith("-fprint"))) return false
    }
    // `uniq IN OUT` writes OUT; `date -s` sets the clock.
    if (base === "uniq" && args.filter((t) => !t.startsWith("-")).length >= 2) return false
    if (base === "date" && args.some((t) => t === "-s" || t.startsWith("--set"))) return false
  }
  return true
}

/**
 * Find a git invocation's subcommand, skipping pre-subcommand global options and the value tokens
 * they consume (`git -C dir reset` → `reset`, not `dir`). Returns the subcommand, `undefined` when
 * there is none (`git --version`), or `null` when a config-injection flag (`-c key=val` /
 * `--config-env`, which can run arbitrary commands via pagers/hooks) appears before the subcommand.
 * `git log -c` is a read-only combined-diff flag, so only PRE-subcommand `-c` counts as injection.
 */
function gitSubcommand(args: string[]): string | null | undefined {
  for (let j = 0; j < args.length; j++) {
    const t = args[j]!
    if (!t.startsWith("-")) return t // first non-flag token is the subcommand
    // Config injection: -c key=val, -ckey=val, --config-env / --config-env=VAR.
    if (t === "-c" || /^-c./.test(t) || t === "--config-env" || t.startsWith("--config-env=")) return null
    // A global flag taking a separate-token value consumes the next token (the =form is self-contained).
    if (GIT_VALUE_FLAGS.has(t)) j++
  }
  return undefined
}

// Programs whose positional arguments name filesystem write targets (best-effort workspace-write
// Bash confinement). For cp/mv/ln/install only the final positional (the destination) is a write.
const WRITE_ARG_PROGS = new Set(["rm", "rmdir", "mkdir", "touch", "truncate", "tee", "chmod", "chown", "mv", "cp", "ln", "install"])
const DEST_ONLY_PROGS = new Set(["mv", "cp", "ln", "install"])
const DEV_SINKS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"])

/**
 * Best-effort detection of a Bash command writing outside `cwd` (workspace-write mode). Arbitrary
 * shell cannot be fully confined without an OS sandbox — this catches the common accidental
 * escapes: redirect targets and well-known write programs naming paths that resolve outside the
 * workspace. Returns the offending target, or undefined if no escape is detected.
 */
export function bashWriteOutsideCwd(cwd: string, command: string): string | undefined {
  // Redirect targets are unambiguous write targets regardless of the program.
  for (const m of command.matchAll(/\d*>>?\s*([^\s|;&<>]+)/g)) {
    const target = unquote(m[1]!)
    if (!target || DEV_SINKS.has(target)) continue
    if (!withinCwd(cwd, expandHome(target))) return target
  }
  for (const seg of command.split(/&&|\|\||\||;|&|\r?\n/)) {
    const tokens = seg.trim().split(/\s+/).filter(Boolean)
    let i = 0
    while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!) || tokens[i] === "env")) i++
    const prog = tokens[i]
    if (!prog) continue
    const base = prog.split("/").pop()!
    const args = tokens.slice(i + 1)
    if (base === "dd") {
      for (const a of args) {
        if (!a.startsWith("of=")) continue
        const target = unquote(a.slice(3))
        if (target && !DEV_SINKS.has(target) && !withinCwd(cwd, expandHome(target))) return target
      }
      continue
    }
    if (!WRITE_ARG_PROGS.has(base)) continue
    // Skip flags and redirect fragments (the redirect scan above already covered those).
    let positionals = args.filter((t) => !t.startsWith("-") && !/[<>]/.test(t))
    if (DEST_ONLY_PROGS.has(base)) positionals = positionals.slice(-1)
    for (const p of positionals) {
      const target = unquote(p)
      if (target && !withinCwd(cwd, expandHome(target))) return target
    }
  }
  return undefined
}

function unquote(s: string): string {
  return s.replace(/^['"]|['"]$/g, "")
}

// Known limitation (pinned in factory.test.ts): only `~` is expanded here. `$HOME`/`${HOME}`
// expand in the shell, not in this gate, so a `$HOME/...` target resolves lexically under cwd
// and slips the best-effort Bash confinement. The file-tool boundary stays the hard guarantee.
function expandHome(p: string): string {
  if (p === "~") return homedir()
  if (p.startsWith("~/")) return join(homedir(), p.slice(2))
  return p
}

/**
 * Sum an SDK result message's usage into AgentUsage. Cache reads/creation are billed input
 * tokens — dropping them undercounts budget ceilings. Exported for tests.
 */
export function usageFromResult(last: { usage?: unknown; total_cost_usd?: unknown }): AgentUsage {
  const u = (last.usage && typeof last.usage === "object" ? last.usage : {}) as Record<string, unknown>
  return {
    ...emptyUsage(),
    inputTokens: numOr(u.input_tokens) + numOr(u.cache_read_input_tokens) + numOr(u.cache_creation_input_tokens),
    outputTokens: numOr(u.output_tokens),
    costUsd: numOr(last.total_cost_usd),
  }
}

/** Coerce SDK message content into an array of block-like records. */
function asBlocks(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) return []
  return content.filter((b): b is Record<string, unknown> => b !== null && typeof b === "object")
}

function numOr(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0
}
