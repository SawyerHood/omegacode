import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process"
import { addUsage, emptyUsage, type AgentResult, type AgentSpec, type AgentUsage, type ProviderId, type Sandbox } from "../dsl/types.js"
import { AgentError, AgentInterrupted, type WorkerContext, type WorkerProgress } from "./index.js"
import { assertValidSchema, parseJsonLoose, stripNullOptionals, validate } from "./schema.js"

export type SubprocessSpawn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcessWithoutNullStreams

export interface SubprocessTurn {
  command: string
  args: string[]
  cwd: string
  stdin?: string
  env?: NodeJS.ProcessEnv
  cleanup?: () => void
}

export interface SubprocessJsonlWorkerOpts {
  provider: ProviderId
  buildTurn: (spec: AgentSpec, prompt: string) => SubprocessTurn
  spawnChild?: SubprocessSpawn
  allowedSandboxes?: readonly Sandbox[]
}

const STDERR_LIMIT = 16 * 1024

const EXTRACTION_PROMPT = (text: string, schema: unknown): string =>
  [
    "Convert the assistant output below into a single JSON value that conforms to this JSON Schema.",
    "Output only JSON. Do not include prose or code fences.",
    "",
    "JSON Schema:",
    JSON.stringify(schema),
    "",
    "Assistant output:",
    text,
  ].join("\n")

export class SubprocessJsonlWorker {
  private readonly provider: ProviderId
  private readonly buildTurn: (spec: AgentSpec, prompt: string) => SubprocessTurn
  private readonly spawnChild: SubprocessSpawn
  private readonly allowedSandboxes: readonly Sandbox[]
  private readonly children = new Set<ChildProcessWithoutNullStreams>()
  private readonly childCleanups = new Map<ChildProcessWithoutNullStreams, () => void>()

  constructor(opts: SubprocessJsonlWorkerOpts) {
    this.provider = opts.provider
    this.buildTurn = opts.buildTurn
    this.spawnChild = opts.spawnChild ?? ((command, args, options) => spawn(command, args, options) as ChildProcessWithoutNullStreams)
    this.allowedSandboxes = opts.allowedSandboxes ?? ["danger-full-access"]
  }

  async runSubprocessAgent(spec: AgentSpec, ctx: WorkerContext): Promise<AgentResult> {
    this.validateCommonOptions(spec)
    if (spec.schema) {
      try {
        assertValidSchema(spec.schema)
      } catch (err) {
        throw new AgentError({ provider: this.provider, code: "invalid_schema", message: `output schema does not compile: ${(err as Error).message}` })
      }
    }

    const working = await this.runTurn(spec, spec.prompt, ctx, true)
    if (!spec.schema) return working

    const extraction = await this.runTurn(spec, EXTRACTION_PROMPT(working.text, spec.schema), ctx, false)
    let structured: unknown
    try {
      structured = stripNullOptionals(parseJsonLoose(extraction.text), spec.schema)
    } catch (err) {
      throw new AgentError({ provider: this.provider, code: "invalid_structured_output", message: `structured output was not valid JSON: ${(err as Error).message}`, usage: addUsage(working.usage, extraction.usage) })
    }
    const verdict = validate(spec.schema, structured)
    if (!verdict.ok) {
      throw new AgentError({ provider: this.provider, code: "invalid_structured_output", message: `structured output did not match schema: ${verdict.errors}`, usage: addUsage(working.usage, extraction.usage) })
    }
    return {
      text: extraction.text,
      structured,
      status: "completed",
      usage: addUsage(working.usage, extraction.usage),
    }
  }

  async shutdown(): Promise<void> {
    for (const child of this.children) {
      try {
        child.kill()
      } catch {
        // best-effort
      }
      this.cleanupTurn(child)
    }
    this.children.clear()
  }

  private validateCommonOptions(spec: AgentSpec): void {
    if (spec.maxTurns !== undefined) {
      throw new AgentError({
        provider: this.provider,
        code: "unsupported_option",
        message: `${this.provider} does not support maxTurns; omit maxTurns for this provider`,
      })
    }
    if (spec.approval !== "never") {
      throw new AgentError({
        provider: this.provider,
        code: "unsupported_option",
        message: `${this.provider} only supports approval "never"; approval "${spec.approval}" is not supported`,
      })
    }
    if (!this.allowedSandboxes.includes(spec.sandbox)) {
      throw new AgentError({
        provider: this.provider,
        code: "unsupported_option",
        message: `${this.provider} cannot enforce sandbox "${spec.sandbox}" in subprocess mode; supported sandbox values for this provider: ${this.allowedSandboxes.join(", ")}`,
      })
    }
  }

  private runTurn(spec: AgentSpec, prompt: string, ctx: WorkerContext, forwardProgress: boolean): Promise<AgentResult> {
    if (ctx.signal.aborted) return Promise.reject(new AgentInterrupted())
    const turn = this.buildTurn(spec, prompt)

    return new Promise<AgentResult>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams
      try {
        child = this.spawnChild(turn.command, turn.args, {
          cwd: turn.cwd,
          env: turn.env,
          stdio: (turn.stdin === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"]) as SpawnOptions["stdio"],
        })
      } catch (err) {
        runCleanup(turn.cleanup)
        reject(processSpawnError(this.provider, turn.command, err))
        return
      }

      this.children.add(child)
      if (turn.cleanup) this.childCleanups.set(child, turn.cleanup)
      child.stdout.setEncoding("utf8")
      child.stderr.setEncoding("utf8")
      let stdoutBuf = ""
      let rawStdout = ""
      let text = ""
      let usage = emptyUsage()
      let stderr = ""
      let settled = false
      let killTimer: ReturnType<typeof setTimeout> | undefined

      const cleanupChild = (): void => {
        this.children.delete(child)
        this.cleanupTurn(child)
        if (killTimer) {
          clearTimeout(killTimer)
          killTimer = undefined
        }
      }

      const terminateChild = (): void => {
        try {
          child.kill()
        } catch {
          // best-effort
        }
        killTimer ??= setTimeout(() => {
          try {
            child.kill("SIGKILL")
          } catch {
            // best-effort
          }
        }, 5000)
        killTimer.unref?.()
      }

      const settle = (fn: () => void, opts: { keepChild?: boolean } = {}): void => {
        if (settled) return
        settled = true
        if (!opts.keepChild) cleanupChild()
        ctx.signal.removeEventListener("abort", onAbort)
        fn()
      }

      const onAbort = (): void => {
        terminateChild()
        settle(() => reject(new AgentInterrupted()), { keepChild: true })
      }

      ctx.signal.addEventListener("abort", onAbort, { once: true })
      if (turn.stdin !== undefined) {
        try {
          child.stdin.end(turn.stdin)
        } catch (err) {
          terminateChild()
          settle(() => reject(new AgentError({ provider: this.provider, code: "stdin_write_failed", message: `failed to write stdin for ${turn.command}: ${(err as Error).message}`, retryable: true })), { keepChild: true })
          return
        }
      }
      child.stdout.on("data", (chunk: string) => {
        if (settled) return
        rawStdout += chunk
        stdoutBuf += chunk
        let nl = stdoutBuf.indexOf("\n")
        while (nl !== -1) {
          const line = stdoutBuf.slice(0, nl)
          stdoutBuf = stdoutBuf.slice(nl + 1)
          let folded: { text: string; usage: AgentUsage }
          try {
            folded = this.consumeLine(line, ctx, forwardProgress)
          } catch (err) {
            terminateChild()
            settle(() => reject(err instanceof Error ? err : new Error(String(err))), { keepChild: true })
            return
          }
          text += folded.text
          usage = addUsage(usage, folded.usage)
          nl = stdoutBuf.indexOf("\n")
        }
      })
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-STDERR_LIMIT)
      })
      child.on("error", (err) => {
        settle(() => reject(processRuntimeError(this.provider, turn.command, err)))
      })
      if (turn.stdin !== undefined) {
        child.stdin.on("error", (err) => {
          if (settled) return
          terminateChild()
          settle(() => reject(new AgentError({ provider: this.provider, code: "stdin_write_failed", message: `failed to write stdin for ${turn.command}: ${err.message}`, retryable: true })), { keepChild: true })
        })
      }
      child.on("exit", (code, signal) => {
        cleanupChild()
        if (settled) return
        if (stdoutBuf.trim()) {
          let folded: { text: string; usage: AgentUsage }
          try {
            folded = this.consumeLine(stdoutBuf, ctx, forwardProgress)
          } catch (err) {
            settle(() => reject(err instanceof Error ? err : new Error(String(err))))
            return
          }
          text += folded.text
          usage = addUsage(usage, folded.usage)
          stdoutBuf = ""
        }
        if (ctx.signal.aborted) {
          settle(() => reject(new AgentInterrupted()))
          return
        }
        if (code !== 0) {
          const tail = stderr.trim() ? `: ${stderr.trim()}` : ""
          settle(() => reject(new AgentError({ provider: this.provider, code: "process_exited", message: `${this.provider} exited with code ${code ?? "null"} signal ${signal ?? "null"}${tail}`, retryable: true, usage })))
          return
        }
        const finalText = text.length > 0 ? text : rawStdout.trim()
        settle(() => resolve({ text: finalText, status: "completed", usage }))
      })
    })
  }

  private consumeLine(line: string, ctx: WorkerContext, forwardProgress: boolean): { text: string; usage: AgentUsage } {
    const trimmed = line.trim()
    if (!trimmed) return { text: "", usage: emptyUsage() }
    try {
      const event = JSON.parse(trimmed)
      const error = eventError(event)
      if (error) throw new AgentError({ provider: this.provider, code: "provider_error", message: error })
      const folded = foldEvent(event, ctx, forwardProgress)
      if (isSilentUnknownJson(event, folded)) {
        return { text: forwardProgress ? "" : trimmed, usage: emptyUsage() }
      }
      return folded
    } catch (err) {
      if (err instanceof AgentError) throw err
      const text = line.endsWith("\n") ? line : line + "\n"
      if (forwardProgress) ctx.onProgress({ kind: "text", text })
      return { text, usage: emptyUsage() }
    }
  }

  private cleanupTurn(child: ChildProcessWithoutNullStreams): void {
    const cleanup = this.childCleanups.get(child)
    if (!cleanup) return
    this.childCleanups.delete(child)
    runCleanup(cleanup)
  }
}

function eventError(value: unknown): string | undefined {
  if (!isObject(value)) return undefined
  const type = typeof value.type === "string" ? value.type : typeof value.kind === "string" ? value.kind : undefined
  if (type !== "error") return undefined
  if (typeof value.message === "string") return value.message
  if (typeof value.error === "string") return value.error
  if (isObject(value.error) && typeof value.error.message === "string") return value.error.message
  return undefined
}

function processSpawnError(provider: ProviderId, command: string, err: unknown): AgentError {
  const code = (err as NodeJS.ErrnoException).code
  if (code === "ENOENT") {
    return new AgentError({ provider, code: "binary_not_found", message: `${command} executable was not found`, retryable: false })
  }
  if (code === "EACCES") {
    return new AgentError({ provider, code: "binary_not_executable", message: `${command} executable is not executable`, retryable: false })
  }
  return new AgentError({ provider, code: "spawn_failed", message: `failed to spawn ${command}: ${(err as Error).message}`, retryable: true })
}

function processRuntimeError(provider: ProviderId, command: string, err: NodeJS.ErrnoException): AgentError {
  if (err.code === "ENOENT") {
    return new AgentError({ provider, code: "binary_not_found", message: `${command} executable was not found`, retryable: false })
  }
  if (err.code === "EACCES") {
    return new AgentError({ provider, code: "binary_not_executable", message: `${command} executable is not executable`, retryable: false })
  }
  return new AgentError({ provider, code: "process_error", message: err.message, retryable: true })
}

function runCleanup(cleanup: (() => void) | undefined): void {
  if (!cleanup) return
  try {
    cleanup()
  } catch {
    // best-effort
  }
}

function foldEvent(event: unknown, ctx: WorkerContext, forwardProgress: boolean): { text: string; usage: AgentUsage } {
  const progress: WorkerProgress[] = []
  let text = ""
  let usage = emptyUsage()
  walk(event, (obj, key) => {
    const u = usageFromObject(obj, key)
    if (u) {
      usage = addUsage(usage, u)
      progress.push({ kind: "usage", usage: u })
    }
    const type = typeof obj.type === "string" ? obj.type : typeof obj.kind === "string" ? obj.kind : ""
    if ((type === "text" || type === "output_text") && typeof obj.text === "string") {
      text += obj.text
      progress.push({ kind: "text", text: obj.text })
    } else if ((type === "reasoning" || type === "thinking") && typeof (obj.text ?? obj.thinking) === "string") {
      progress.push({ kind: "reasoning", text: String(obj.text ?? obj.thinking) })
    } else if (type === "tool_use" && typeof obj.name === "string") {
      progress.push({ kind: "tool", id: typeof obj.id === "string" ? obj.id : undefined, name: obj.name, input: obj.input })
    } else if (type === "tool_result") {
      const output = typeof obj.output === "string" ? obj.output : typeof obj.content === "string" ? obj.content : undefined
      progress.push({ kind: "tool-result", id: typeof obj.id === "string" ? obj.id : typeof obj.tool_use_id === "string" ? obj.tool_use_id : undefined, output, isError: obj.is_error === true || obj.isError === true })
    } else if ((type === "message_delta" || type === "agent_end") && typeof obj.text === "string") {
      text += obj.text
      progress.push({ kind: "text", text: obj.text })
    }
  })
  if (forwardProgress) {
    for (const p of progress) ctx.onProgress(p)
  }
  return { text, usage }
}

function isSilentUnknownJson(event: unknown, folded: { text: string; usage: AgentUsage }): boolean {
  if (folded.text !== "" || folded.usage.inputTokens !== 0 || folded.usage.outputTokens !== 0 || folded.usage.costUsd !== 0) {
    return false
  }
  if (!isObject(event)) return false
  const type = typeof event.type === "string" ? event.type : typeof event.kind === "string" ? event.kind : undefined
  if (type) return false
  return true
}

function walk(value: unknown, visit: (obj: Record<string, unknown>, key?: string) => void, key?: string): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit, key)
    return
  }
  if (!isObject(value)) return
  visit(value, key)
  for (const [childKey, v] of Object.entries(value)) walk(v, visit, childKey)
}

function usageFromObject(obj: Record<string, unknown>, key?: string): AgentUsage | undefined {
  const conventionalInput = numberField(obj, "inputTokens") ?? numberField(obj, "input_tokens") ?? numberField(obj, "prompt_tokens")
  const conventionalOutput = numberField(obj, "outputTokens") ?? numberField(obj, "output_tokens") ?? numberField(obj, "completion_tokens")
  const piInput = numberField(obj, "input")
  const piOutput = numberField(obj, "output")
  const cacheRead = numberField(obj, "cacheRead") ?? numberField(obj, "cache_read")
  const cacheWrite = numberField(obj, "cacheWrite") ?? numberField(obj, "cache_write")
  const costObject = isObject(obj.cost) ? obj.cost : undefined
  const piCost = costObject ? numberField(costObject, "total") : undefined
  const canUsePiShape = key === "usage" || cacheRead !== undefined || cacheWrite !== undefined || piCost !== undefined
  const input =
    conventionalInput ??
    (canUsePiShape && (piInput !== undefined || cacheRead !== undefined || cacheWrite !== undefined)
      ? (piInput ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
      : undefined)
  const output = conventionalOutput ?? (canUsePiShape ? piOutput : undefined)
  const cost = numberField(obj, "costUsd") ?? numberField(obj, "cost_usd") ?? piCost ?? 0
  if (input === undefined && output === undefined) return undefined
  return { inputTokens: input ?? 0, outputTokens: output ?? 0, costUsd: cost }
}

function numberField(obj: Record<string, unknown>, key: string): number | undefined {
  const value = obj[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
