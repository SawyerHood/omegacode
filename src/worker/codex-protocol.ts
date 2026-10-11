// Minimal hand-written subset of the `codex app-server` JSON-RPC 2.0 protocol.
// Only the methods / params / notifications the CodexWorker actually uses are
// modeled here. Field names match the codex app-server v2 schema exactly.
//
// Reference: openai/codex codex-rs/app-server-protocol (schema/v2/*).

import type { Sandbox, Approval, Effort, JSONSchema } from "../dsl/types.js"

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 envelopes
// ---------------------------------------------------------------------------

export type JsonRpcId = string | number

export interface JsonRpcRequest {
  jsonrpc: "2.0"
  id: JsonRpcId
  method: string
  params?: unknown
}

export interface JsonRpcNotification {
  jsonrpc: "2.0"
  method: string
  params?: unknown
}

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: JsonRpcId
  result?: unknown
  error?: JsonRpcError
}

/** A parsed inbound line: a response to one of our requests, a server-initiated
 *  request (which we must answer), or a notification. */
export type InboundMessage =
  | { kind: "response"; id: JsonRpcId; result?: unknown; error?: JsonRpcError }
  | { kind: "request"; id: JsonRpcId; method: string; params: unknown }
  | { kind: "notification"; method: string; params: unknown }

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || typeof value === "number"
}

/** Parse one newline-delimited JSON-RPC frame. Returns null for non-JSON or
 *  structurally-invalid lines (which should be ignored). */
export function parseInbound(line: string): InboundMessage | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (!isObject(parsed)) return null

  const { id, method, params, result, error } = parsed
  if (isId(id) && typeof method !== "string") {
    // No method + has id → response to one of our requests.
    return { kind: "response", id, result, error: isObject(error) ? (error as unknown as JsonRpcError) : undefined }
  }
  if (isId(id) && typeof method === "string") {
    // Has method + id → server-initiated request we must answer.
    return { kind: "request", id, method, params }
  }
  if (typeof method === "string") {
    return { kind: "notification", method, params }
  }
  return null
}

export function encodeRequest(id: JsonRpcId, method: string, params?: unknown): string {
  const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) }
  return JSON.stringify(msg)
}

export function encodeNotification(method: string, params?: unknown): string {
  const msg: JsonRpcNotification = { jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) }
  return JSON.stringify(msg)
}

export function encodeResult(id: JsonRpcId, result: unknown): string {
  const msg: JsonRpcResponse = { jsonrpc: "2.0", id, result }
  return JSON.stringify(msg)
}

// ---------------------------------------------------------------------------
// Sandbox / approval mapping (spec policy → codex types)
// ---------------------------------------------------------------------------

export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access"

export type CodexSandboxPolicy =
  | { type: "dangerFullAccess" }
  | { type: "readOnly"; networkAccess: boolean }
  | {
      type: "workspaceWrite"
      writableRoots: string[]
      networkAccess: boolean
      excludeTmpdirEnvVar: boolean
      excludeSlashTmp: boolean
    }

export type CodexAskForApproval = "untrusted" | "on-failure" | "on-request" | "never"

export type CodexReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh"

export function toCodexSandboxMode(sandbox: Sandbox): CodexSandboxMode {
  switch (sandbox) {
    case "read-only":
      return "read-only"
    case "workspace-write":
      return "workspace-write"
    case "danger-full-access":
      return "danger-full-access"
  }
}

export function toCodexSandboxPolicy(sandbox: Sandbox, cwd: string): CodexSandboxPolicy {
  switch (sandbox) {
    case "read-only":
      return { type: "readOnly", networkAccess: false }
    case "workspace-write":
      return {
        type: "workspaceWrite",
        writableRoots: [cwd],
        // Default to no network for workspace-write, matching codex's own default;
        // network is an explicit opt-in concern, not silently granted here.
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      }
    case "danger-full-access":
      return { type: "dangerFullAccess" }
  }
}

export function toCodexApprovalPolicy(sandbox: Sandbox, approval: Approval): CodexAskForApproval {
  // danger-full-access always runs without prompts; otherwise honor the spec.
  if (sandbox === "danger-full-access") return "never"
  return approval === "never" ? "never" : "on-request"
}

export function toCodexEffort(effort: Effort | undefined): CodexReasoningEffort | undefined {
  if (!effort) return undefined
  switch (effort) {
    case "none":
      return "none"
    case "minimal":
      return "minimal"
    case "low":
      return "low"
    case "medium":
      return "medium"
    case "high":
      return "high"
    case "xhigh":
      return "xhigh"
    case "max":
      // codex has no "max"; map to its top supported tier.
      return "xhigh"
    case "ultra":
      // Likewise above codex's range (a muse-client-side tier) — top tier, never a failure.
      return "xhigh"
  }
}

// ---------------------------------------------------------------------------
// Request params we send
// ---------------------------------------------------------------------------

export interface InitializeParams {
  clientInfo: { name: string; version: string }
  capabilities: { experimentalApi: boolean }
}

export interface ThreadStartParams {
  cwd: string
  model?: string
  approvalPolicy: CodexAskForApproval
  sandbox: CodexSandboxMode
  developerInstructions?: string
  experimentalRawEvents: boolean
  persistExtendedHistory: boolean
}

export interface CodexTextUserInput {
  type: "text"
  text: string
  text_elements: never[]
}

export interface TurnStartParams {
  threadId: string
  input: CodexTextUserInput[]
  approvalPolicy: CodexAskForApproval
  sandboxPolicy: CodexSandboxPolicy
  model?: string
  effort?: CodexReasoningEffort
  outputSchema?: JSONSchema
}

export interface TurnInterruptParams {
  threadId: string
  turnId?: string
}

// ---------------------------------------------------------------------------
// Notification / result payload shapes we read
// ---------------------------------------------------------------------------

export type CodexTurnStatus = "completed" | "interrupted" | "failed" | "inProgress"

export interface CodexThreadStartResult {
  thread?: { id?: string }
  threadId?: string
  providerThreadId?: string
}

/** Read the provider thread id from a thread/start result, tolerating the
 *  several shapes the app-server has used. */
export function readThreadId(result: unknown): string | undefined {
  if (!isObject(result)) return undefined
  const thread = result.thread
  if (isObject(thread) && typeof thread.id === "string") return thread.id
  if (typeof result.threadId === "string") return result.threadId
  if (typeof result.providerThreadId === "string") return result.providerThreadId
  return undefined
}

export interface CodexTurnError {
  message?: string
  codexErrorInfo?: unknown
  additionalDetails?: string | null
}

export interface CodexTurnCompletedParams {
  threadId: string
  turn: { id?: string; status: CodexTurnStatus; error?: CodexTurnError | null }
}

export interface CodexAgentMessageDeltaParams {
  threadId: string
  turnId: string
  itemId: string
  delta: string
}

export interface CodexThreadItem {
  type: string
  id: string
  text?: string
  command?: string
  tool?: string
  server?: string
}

export interface CodexItemParams {
  threadId: string
  turnId: string
  item: CodexThreadItem
}

export interface CodexTokenUsageBreakdown {
  totalTokens: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
}

export interface CodexTokenUsageParams {
  threadId: string
  turnId: string
  tokenUsage: {
    total: CodexTokenUsageBreakdown
    last: CodexTokenUsageBreakdown
    modelContextWindow: number | null
  }
}

/** Server-initiated approval request params (item requestApproval methods). */
export interface CodexApprovalRequestParams {
  threadId: string
  turnId: string
  itemId: string
}

// ---------------------------------------------------------------------------
// Inbound shape guards — protocol drift must surface as a typed failure, never
// a silent permanent hang. The CodexWorker validates each notification's shape
// before acting on it.
// ---------------------------------------------------------------------------

export interface InitializeResult {
  /** "<originator>/<server version> (<os>) <terminal> (<client name>; <client version>)".
   *  The InitializeResponse's one required field and the protocol's only version
   *  surface — there is no protocol-version field or capability echo to negotiate
   *  on. (Verified live against codex-cli 0.137.0, which returns
   *  { userAgent, codexHome, platformFamily, platformOs }.) */
  userAgent: string
}

/** Validate an initialize result against the app-server InitializeResponse and
 *  return its `userAgent` (which embeds the server version, e.g. "…/0.137.0 (…)").
 *  Returns undefined when the shape does not match — the peer is not a codex
 *  app-server (or speaks a drifted protocol), and the handshake must fail loudly
 *  here rather than wedge later when a turn never settles. */
export function readInitializeUserAgent(result: unknown): string | undefined {
  if (!isObject(result)) return undefined
  const ua = result.userAgent
  return typeof ua === "string" && ua.length > 0 ? ua : undefined
}

/** A notification carrying a string `threadId` and a string `delta`. */
export function isThreadDelta(params: unknown): params is { threadId: string; delta: string } {
  return isObject(params) && typeof params.threadId === "string" && typeof params.delta === "string"
}

/** A notification carrying a string `threadId` and an `item` object. */
export function isThreadItem(params: unknown): params is { threadId: string; item: Record<string, unknown> } {
  return isObject(params) && typeof params.threadId === "string" && isObject(params.item)
}

/** A notification carrying a string `threadId` and a `tokenUsage` object. */
export function isTokenUsage(
  params: unknown,
): params is { threadId: string; tokenUsage: Record<string, unknown> } {
  return isObject(params) && typeof params.threadId === "string" && isObject(params.tokenUsage)
}

/** A turn/completed notification carrying a string `threadId` and a `turn` object. */
export function isTurnCompleted(
  params: unknown,
): params is { threadId: string; turn: Record<string, unknown> } {
  return isObject(params) && typeof params.threadId === "string" && isObject(params.turn)
}

/** An `error` notification (no following turn/completed) we must settle on. */
export function readErrorNotificationThreadId(params: unknown): string | undefined {
  if (!isObject(params)) return undefined
  return typeof params.threadId === "string" ? params.threadId : undefined
}

export function readErrorNotificationMessage(params: unknown): string {
  if (!isObject(params)) return "codex error"
  if (typeof params.message === "string") return params.message
  const err = params.error
  if (typeof err === "string") return err
  if (isObject(err) && typeof err.message === "string") return err.message
  return "codex error"
}

// ---------------------------------------------------------------------------
// codexErrorInfo → retry classification
// ---------------------------------------------------------------------------

/** Extract a string code from a codexErrorInfo (string variant or single-key object). */
export function codexErrorCode(info: unknown): string | undefined {
  if (typeof info === "string") return info
  if (isObject(info)) {
    const keys = Object.keys(info)
    if (keys.length > 0) return keys[0]
  }
  return undefined
}

/** Rate/usage/overload/connection failures are worth retrying. */
export function isRetryableCodexError(code: string | undefined): boolean {
  if (!code) return false
  switch (code) {
    case "usageLimitExceeded":
    case "serverOverloaded":
    case "internalServerError":
    case "httpConnectionFailed":
    case "responseStreamConnectionFailed":
    case "responseStreamDisconnected":
    case "responseTooManyFailedAttempts":
      return true
    default:
      return false
  }
}
