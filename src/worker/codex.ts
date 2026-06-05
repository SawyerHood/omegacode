// CodexWorker — drives the local `codex app-server` over newline-delimited
// JSON-RPC 2.0 (stdio). One child process is spawned lazily and shared across
// runAgent() calls. Each runAgent does: thread/start → turn/start → stream
// notifications → resolve on turn/completed.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"

import type { AgentResult, AgentSpec, AgentUsage } from "../dsl/types.js"
import { emptyUsage } from "../dsl/types.js"
import type { Worker, WorkerContext } from "./index.js"
import { AgentError, AgentInterrupted } from "./index.js"
import { toCodexOutputSchema, parseJsonLoose } from "./schema.js"
import {
  parseInbound,
  encodeRequest,
  encodeNotification,
  encodeResult,
  toCodexSandboxMode,
  toCodexSandboxPolicy,
  toCodexApprovalPolicy,
  toCodexEffort,
  readThreadId,
  codexErrorCode,
  isRetryableCodexError,
  type JsonRpcId,
  type InitializeParams,
  type ThreadStartParams,
  type TurnStartParams,
  type CodexTurnCompletedParams,
  type CodexAgentMessageDeltaParams,
  type CodexItemParams,
  type CodexTokenUsageParams,
  type CodexApprovalRequestParams,
} from "./codex-protocol.js"

export interface CodexWorkerOpts {
  bin?: string
}

interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
}

const PROVIDER = "codex" as const

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Per-thread turn state accumulated while a turn streams. */
interface TurnState {
  threadId: string
  deltaText: string
  finalMessage?: string
  usage: AgentUsage
  resolve: (result: AgentResult) => void
  reject: (err: Error) => void
  settled: boolean
  ctx: WorkerContext
  sandbox: AgentSpec["sandbox"]
  /** Whether the spec carried a schema → parse final text into `structured`. */
  wantsStructured: boolean
}

export class CodexWorker implements Worker {
  readonly id = PROVIDER
  private readonly bin: string
  private child: ChildProcessWithoutNullStreams | null = null
  private initPromise: Promise<void> | null = null
  private stdoutBuf = ""
  private nextId = 1
  private readonly pending = new Map<JsonRpcId, PendingRequest>()
  /** Active turns keyed by providerThreadId. */
  private readonly turns = new Map<string, TurnState>()
  private shuttingDown = false

  constructor(opts: CodexWorkerOpts = {}) {
    this.bin = opts.bin ?? "codex"
  }

  async runAgent(spec: AgentSpec, ctx: WorkerContext): Promise<AgentResult> {
    if (ctx.signal.aborted) throw new AgentInterrupted()
    await this.ensureStarted()

    // 1. thread/start → obtain providerThreadId.
    const startParams: ThreadStartParams = {
      cwd: spec.cwd,
      ...(spec.model ? { model: spec.model } : {}),
      approvalPolicy: toCodexApprovalPolicy(spec.sandbox, spec.approval),
      sandbox: toCodexSandboxMode(spec.sandbox),
      ...(spec.instructions ? { developerInstructions: spec.instructions } : {}),
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    }
    const startResult = await this.request("thread/start", startParams)
    const threadId = readThreadId(startResult)
    if (!threadId) {
      throw new AgentError({
        provider: PROVIDER,
        code: "no_thread_id",
        message: "codex thread/start did not return a thread id",
      })
    }

    // 2. Register turn state + wire abort/cleanup, then send turn/start.
    return await new Promise<AgentResult>((resolve, reject) => {
      const state: TurnState = {
        threadId,
        deltaText: "",
        usage: emptyUsage(),
        resolve,
        reject,
        settled: false,
        ctx,
        sandbox: spec.sandbox,
        wantsStructured: spec.schema !== undefined,
      }
      this.turns.set(threadId, state)

      const onAbort = () => {
        this.send(encodeRequest(this.allocId(), "turn/interrupt", { threadId }))
        this.settleReject(threadId, new AgentInterrupted())
      }
      if (ctx.signal.aborted) {
        onAbort()
        return
      }
      ctx.signal.addEventListener("abort", onAbort, { once: true })

      const turnParams: TurnStartParams = {
        threadId,
        input: [{ type: "text", text: spec.prompt, text_elements: [] }],
        approvalPolicy: toCodexApprovalPolicy(spec.sandbox, spec.approval),
        sandboxPolicy: toCodexSandboxPolicy(spec.sandbox, spec.cwd),
        ...(spec.model ? { model: spec.model } : {}),
        ...(toCodexEffort(spec.effort) ? { effort: toCodexEffort(spec.effort) } : {}),
        ...(spec.schema ? { outputSchema: toCodexOutputSchema(spec.schema) } : {}),
      }

      this.request("turn/start", turnParams).catch((err: unknown) => {
        // A failed turn/start request (e.g. transport) aborts the turn.
        this.settleReject(threadId, this.toAgentError(err))
      })
    }).finally(() => {
      this.turns.delete(threadId)
    })
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    const child = this.child
    this.child = null
    this.initPromise = null
    // Reject any in-flight requests / turns.
    const closeErr = new AgentError({
      provider: PROVIDER,
      code: "shutdown",
      message: "codex worker shut down",
      retryable: true,
    })
    for (const [id, p] of this.pending) {
      this.pending.delete(id)
      p.reject(closeErr)
    }
    for (const threadId of [...this.turns.keys()]) {
      this.settleReject(threadId, closeErr)
    }
    if (child) {
      child.removeAllListeners()
      child.kill()
    }
  }

  // -------------------------------------------------------------------------
  // Process lifecycle + handshake
  // -------------------------------------------------------------------------

  private ensureStarted(): Promise<void> {
    if (this.initPromise) return this.initPromise
    this.initPromise = this.startAndHandshake().catch((err: unknown) => {
      this.initPromise = null
      throw err
    })
    return this.initPromise
  }

  private async startAndHandshake(): Promise<void> {
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(this.bin, ["app-server"], { stdio: ["pipe", "pipe", "pipe"] })
    } catch (err) {
      throw new AgentError({
        provider: PROVIDER,
        code: "spawn_failed",
        message: `failed to spawn ${this.bin} app-server: ${errMessage(err)}`,
        retryable: true,
      })
    }
    this.child = child
    this.shuttingDown = false

    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk))
    child.on("error", (err) => this.onProcessGone(err))
    child.on("exit", (code, signal) =>
      this.onProcessGone(new Error(`codex app-server exited (code=${code ?? "null"} signal=${signal ?? "null"})`)),
    )

    const initParams: InitializeParams = {
      clientInfo: { name: "agent-workflows", version: "0.0.1" },
      capabilities: { experimentalApi: true },
    }
    await this.request("initialize", initParams)
    this.send(encodeNotification("initialized"))
  }

  private onProcessGone(err: Error): void {
    if (this.shuttingDown) return
    const wrapped = new AgentError({
      provider: PROVIDER,
      code: "process_exited",
      message: err.message,
      retryable: true,
    })
    this.child = null
    this.initPromise = null
    for (const [id, p] of this.pending) {
      this.pending.delete(id)
      p.reject(wrapped)
    }
    for (const threadId of [...this.turns.keys()]) {
      this.settleReject(threadId, wrapped)
    }
  }

  // -------------------------------------------------------------------------
  // Framing
  // -------------------------------------------------------------------------

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk
    let nl = this.stdoutBuf.indexOf("\n")
    while (nl !== -1) {
      const line = this.stdoutBuf.slice(0, nl)
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1)
      const trimmed = line.trim()
      if (trimmed.length > 0) this.dispatch(trimmed)
      nl = this.stdoutBuf.indexOf("\n")
    }
  }

  private dispatch(line: string): void {
    const msg = parseInbound(line)
    if (!msg) return
    switch (msg.kind) {
      case "response": {
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        if (msg.error) {
          p.reject(
            new AgentError({
              provider: PROVIDER,
              code: "rpc_error",
              message: msg.error.message,
            }),
          )
        } else {
          p.resolve(msg.result)
        }
        return
      }
      case "request":
        this.handleServerRequest(msg.id, msg.method, msg.params)
        return
      case "notification":
        this.handleNotification(msg.method, msg.params)
        return
    }
  }

  // -------------------------------------------------------------------------
  // Server-initiated requests (approvals)
  // -------------------------------------------------------------------------

  private handleServerRequest(id: JsonRpcId, method: string, params: unknown): void {
    switch (method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
      case "item/permissions/requestApproval": {
        const p = (isObject(params) ? params : {}) as Partial<CodexApprovalRequestParams>
        const state = typeof p.threadId === "string" ? this.turns.get(p.threadId) : undefined
        const isWriteAction = method !== "item/commandExecution/requestApproval"
        // Decline write actions in read-only sandboxes; otherwise accept.
        const decline = isWriteAction && state?.sandbox === "read-only"
        if (method === "item/permissions/requestApproval") {
          // Permission grants take a grant-shaped response; grant nothing extra.
          this.send(encodeResult(id, { permissions: {}, scope: "turn" }))
        } else {
          this.send(encodeResult(id, { decision: decline ? "decline" : "accept" }))
        }
        return
      }
      default:
        // Unknown server request: answer with an empty result so the server
        // does not block waiting on us.
        this.send(encodeResult(id, {}))
        return
    }
  }

  // -------------------------------------------------------------------------
  // Notifications
  // -------------------------------------------------------------------------

  private handleNotification(method: string, params: unknown): void {
    if (!isObject(params)) return
    switch (method) {
      case "item/agentMessage/delta": {
        const p = params as unknown as CodexAgentMessageDeltaParams
        const state = this.turns.get(p.threadId)
        if (!state || typeof p.delta !== "string") return
        state.deltaText += p.delta
        state.ctx.onProgress({ kind: "text", text: p.delta })
        return
      }
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta": {
        const state = typeof params.threadId === "string" ? this.turns.get(params.threadId) : undefined
        if (state && typeof params.delta === "string") state.ctx.onProgress({ kind: "reasoning", text: params.delta })
        return
      }
      case "item/started": {
        const p = params as unknown as CodexItemParams
        const state = this.turns.get(p.threadId)
        if (!state || !isObject(p.item)) return
        const item = p.item as Record<string, unknown>
        const name = toolName(p.item)
        if (name) state.ctx.onProgress({ kind: "tool", id: typeof item.id === "string" ? item.id : undefined, name, input: codexToolInput(item) })
        return
      }
      case "item/completed": {
        const p = params as unknown as CodexItemParams
        const state = this.turns.get(p.threadId)
        if (!state || !isObject(p.item)) return
        const item = p.item as Record<string, unknown>
        if (item.type === "agentMessage" && typeof item.text === "string") {
          state.finalMessage = item.text
          return
        }
        const name = toolName(p.item)
        if (name) {
          const output =
            typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : typeof item.result === "string" ? item.result : undefined
          state.ctx.onProgress({
            kind: "tool-result",
            id: typeof item.id === "string" ? item.id : undefined,
            name,
            output,
            isError: item.status === "failed" || typeof item.error === "string",
          })
        }
        return
      }
      case "thread/tokenUsage/updated": {
        const p = params as unknown as CodexTokenUsageParams
        const state = this.turns.get(p.threadId)
        if (!state || !isObject(p.tokenUsage)) return
        const total = p.tokenUsage.total
        if (isObject(total)) {
          state.usage = {
            inputTokens: numberOr(total.inputTokens, state.usage.inputTokens),
            outputTokens: numberOr(total.outputTokens, state.usage.outputTokens),
            costUsd: state.usage.costUsd,
          }
          state.ctx.onProgress({
            kind: "usage",
            usage: { inputTokens: state.usage.inputTokens, outputTokens: state.usage.outputTokens },
          })
        }
        return
      }
      case "turn/completed": {
        const p = params as unknown as CodexTurnCompletedParams
        this.onTurnCompleted(p)
        return
      }
      default:
        return
    }
  }

  private onTurnCompleted(p: CodexTurnCompletedParams): void {
    const state = this.turns.get(p.threadId)
    if (!state) return
    const status = isObject(p.turn) ? p.turn.status : undefined
    if (status === "completed") {
      const text = state.finalMessage ?? state.deltaText
      const result: AgentResult = {
        text,
        status: "completed",
        usage: state.usage,
        structured: this.maybeStructured(state, text),
      }
      this.settleResolve(p.threadId, result)
      return
    }
    if (status === "interrupted") {
      this.settleReject(p.threadId, new AgentInterrupted())
      return
    }
    // failed (or unexpected) → AgentError.
    const turnError = isObject(p.turn) ? p.turn.error : undefined
    const info = isObject(turnError) ? turnError.codexErrorInfo : undefined
    const code = codexErrorCode(info) ?? "turn_failed"
    const message = (isObject(turnError) && typeof turnError.message === "string" && turnError.message) || `codex turn ${status ?? "failed"}`
    this.settleReject(
      p.threadId,
      new AgentError({
        provider: PROVIDER,
        code,
        message,
        retryable: isRetryableCodexError(codexErrorCode(info)),
      }),
    )
  }

  /** When the spec carried a schema, best-effort parse the final assistant
   *  text as JSON. The runtime re-validates, so failures swallow to undefined. */
  private maybeStructured(state: TurnState, text: string): unknown {
    if (!state.wantsStructured) return undefined
    try {
      return parseJsonLoose(text)
    } catch {
      return undefined
    }
  }

  private settleResolve(threadId: string, result: AgentResult): void {
    const state = this.turns.get(threadId)
    if (!state || state.settled) return
    state.settled = true
    state.resolve(result)
  }

  private settleReject(threadId: string, err: Error): void {
    const state = this.turns.get(threadId)
    if (!state || state.settled) return
    state.settled = true
    state.reject(err)
  }

  // -------------------------------------------------------------------------
  // Low-level send / request
  // -------------------------------------------------------------------------

  private allocId(): number {
    return this.nextId++
  }

  private send(line: string): void {
    const child = this.child
    if (!child || !child.stdin.writable) return
    child.stdin.write(line + "\n", (err) => {
      if (err) this.onProcessGone(err instanceof Error ? err : new Error(String(err)))
    })
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const id = this.allocId()
      this.pending.set(id, { resolve, reject })
      try {
        this.send(encodeRequest(id, method, params))
      } catch (err) {
        this.pending.delete(id)
        reject(this.toAgentError(err))
      }
    })
  }

  private toAgentError(err: unknown): AgentError {
    if (err instanceof AgentError) return err
    return new AgentError({
      provider: PROVIDER,
      code: "transport",
      message: errMessage(err),
      retryable: true,
    })
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function toolName(item: Record<string, unknown>): string | undefined {
  switch (item.type) {
    case "commandExecution":
      return "command"
    case "mcpToolCall":
      return typeof item.tool === "string" ? item.tool : "mcpToolCall"
    case "dynamicToolCall":
      return typeof item.tool === "string" ? item.tool : "dynamicToolCall"
    case "webSearch":
      return "webSearch"
    case "fileChange":
      return "fileChange"
    default:
      return undefined
  }
}

/** Best-effort extraction of a tool/command item's "input" for the chat feed. */
function codexToolInput(item: Record<string, unknown>): unknown {
  if (typeof item.command === "string" || Array.isArray(item.command)) return item.command
  if (item.arguments !== undefined) return item.arguments
  if (Array.isArray(item.changes)) return item.changes
  if (Array.isArray(item.queries)) return item.queries
  return undefined
}
