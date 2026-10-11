import { test } from "node:test"
import assert from "node:assert/strict"

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
  readInitializeUserAgent,
  isThreadDelta,
  isThreadItem,
  isTokenUsage,
  isTurnCompleted,
  readErrorNotificationThreadId,
  readErrorNotificationMessage,
} from "../src/worker/codex-protocol.js"

// ---------------------------------------------------------------------------
// parseInbound — framing classifier
// ---------------------------------------------------------------------------

test("parseInbound: response (id, no method)", () => {
  const msg = parseInbound(JSON.stringify({ jsonrpc: "2.0", id: 7, result: { ok: true } }))
  assert.equal(msg?.kind, "response")
  if (msg?.kind === "response") {
    assert.equal(msg.id, 7)
    assert.deepEqual(msg.result, { ok: true })
    assert.equal(msg.error, undefined)
  }
})

test("parseInbound: response with error member", () => {
  const msg = parseInbound(JSON.stringify({ jsonrpc: "2.0", id: "a", error: { code: -1, message: "boom" } }))
  assert.equal(msg?.kind, "response")
  if (msg?.kind === "response") {
    assert.equal(msg.error?.message, "boom")
  }
})

test("parseInbound: server request (id + method)", () => {
  const msg = parseInbound(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "item/commandExecution/requestApproval", params: { threadId: "t" } }))
  assert.equal(msg?.kind, "request")
  if (msg?.kind === "request") {
    assert.equal(msg.method, "item/commandExecution/requestApproval")
    assert.deepEqual(msg.params, { threadId: "t" })
  }
})

test("parseInbound: notification (method, no id)", () => {
  const msg = parseInbound(JSON.stringify({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "t" } }))
  assert.equal(msg?.kind, "notification")
  if (msg?.kind === "notification") assert.equal(msg.method, "turn/completed")
})

test("parseInbound: invalid JSON → null", () => {
  assert.equal(parseInbound("not json {"), null)
})

test("parseInbound: non-object JSON → null", () => {
  assert.equal(parseInbound("42"), null)
  assert.equal(parseInbound('"a string"'), null)
  assert.equal(parseInbound("[1,2,3]"), null)
})

test("parseInbound: object with neither id nor method → null", () => {
  assert.equal(parseInbound(JSON.stringify({ jsonrpc: "2.0", foo: "bar" })), null)
})

// ---------------------------------------------------------------------------
// encode helpers
// ---------------------------------------------------------------------------

test("encodeRequest round-trips through parseInbound as a request", () => {
  const line = encodeRequest(1, "thread/start", { cwd: "/x" })
  const parsed = parseInbound(line)
  assert.equal(parsed?.kind, "request")
})

test("encodeRequest omits params when undefined", () => {
  const obj = JSON.parse(encodeRequest(1, "ping"))
  assert.equal("params" in obj, false)
})

test("encodeNotification has no id", () => {
  const obj = JSON.parse(encodeNotification("initialized"))
  assert.equal("id" in obj, false)
  assert.equal(obj.method, "initialized")
})

test("encodeResult carries id + result", () => {
  const obj = JSON.parse(encodeResult(5, { decision: "decline" }))
  assert.equal(obj.id, 5)
  assert.deepEqual(obj.result, { decision: "decline" })
})

// ---------------------------------------------------------------------------
// sandbox / approval / effort mapping
// ---------------------------------------------------------------------------

test("toCodexSandboxMode passthrough", () => {
  assert.equal(toCodexSandboxMode("read-only"), "read-only")
  assert.equal(toCodexSandboxMode("workspace-write"), "workspace-write")
  assert.equal(toCodexSandboxMode("danger-full-access"), "danger-full-access")
})

test("toCodexSandboxPolicy: read-only has no network", () => {
  const policy = toCodexSandboxPolicy("read-only", "/work")
  assert.deepEqual(policy, { type: "readOnly", networkAccess: false })
})

test("L1: workspace-write does NOT silently grant network access", () => {
  const policy = toCodexSandboxPolicy("workspace-write", "/work")
  assert.equal(policy.type, "workspaceWrite")
  if (policy.type === "workspaceWrite") {
    assert.equal(policy.networkAccess, false)
    assert.deepEqual(policy.writableRoots, ["/work"])
  }
})

test("toCodexSandboxPolicy: danger-full-access", () => {
  assert.deepEqual(toCodexSandboxPolicy("danger-full-access", "/work"), { type: "dangerFullAccess" })
})

test("toCodexApprovalPolicy: danger-full-access is never", () => {
  assert.equal(toCodexApprovalPolicy("danger-full-access", "on-request"), "never")
})

test("toCodexApprovalPolicy: read-only honors approval", () => {
  assert.equal(toCodexApprovalPolicy("read-only", "never"), "never")
  assert.equal(toCodexApprovalPolicy("read-only", "on-request"), "on-request")
})

test("toCodexEffort maps every level (max → xhigh)", () => {
  assert.equal(toCodexEffort(undefined), undefined)
  assert.equal(toCodexEffort("none"), "none")
  assert.equal(toCodexEffort("minimal"), "minimal")
  assert.equal(toCodexEffort("low"), "low")
  assert.equal(toCodexEffort("medium"), "medium")
  assert.equal(toCodexEffort("high"), "high")
  assert.equal(toCodexEffort("xhigh"), "xhigh")
  assert.equal(toCodexEffort("max"), "xhigh")
  assert.equal(toCodexEffort("ultra"), "xhigh") // above codex's range — top tier, never a failure
})

// ---------------------------------------------------------------------------
// readThreadId — tolerant shapes
// ---------------------------------------------------------------------------

test("readThreadId: thread.id", () => {
  assert.equal(readThreadId({ thread: { id: "abc" } }), "abc")
})

test("readThreadId: threadId", () => {
  assert.equal(readThreadId({ threadId: "xyz" }), "xyz")
})

test("readThreadId: providerThreadId", () => {
  assert.equal(readThreadId({ providerThreadId: "pid" }), "pid")
})

test("readThreadId: missing → undefined", () => {
  assert.equal(readThreadId({}), undefined)
  assert.equal(readThreadId(null), undefined)
  assert.equal(readThreadId("nope"), undefined)
})

// ---------------------------------------------------------------------------
// error classification
// ---------------------------------------------------------------------------

test("codexErrorCode: string variant", () => {
  assert.equal(codexErrorCode("serverOverloaded"), "serverOverloaded")
})

test("codexErrorCode: single-key object variant", () => {
  assert.equal(codexErrorCode({ usageLimitExceeded: { resetsAt: 1 } }), "usageLimitExceeded")
})

test("codexErrorCode: empty/invalid → undefined", () => {
  assert.equal(codexErrorCode({}), undefined)
  assert.equal(codexErrorCode(42), undefined)
})

test("isRetryableCodexError: retryable set", () => {
  for (const c of [
    "usageLimitExceeded",
    "serverOverloaded",
    "internalServerError",
    "httpConnectionFailed",
    "responseStreamConnectionFailed",
    "responseStreamDisconnected",
    "responseTooManyFailedAttempts",
  ]) {
    assert.equal(isRetryableCodexError(c), true, c)
  }
})

test("isRetryableCodexError: non-retryable / unknown / undefined", () => {
  assert.equal(isRetryableCodexError("badRequest"), false)
  assert.equal(isRetryableCodexError(undefined), false)
})

// ---------------------------------------------------------------------------
// M30 — inbound shape guards
// ---------------------------------------------------------------------------

test("M30: readInitializeUserAgent accepts the live InitializeResponse shape", () => {
  // Exact shape returned by codex-cli 0.137.0 (captured live); extra fields tolerated.
  const live = {
    userAgent: "omegacode/0.137.0 (Mac OS 26.5.1; arm64) ghostty/1.3.1 (omegacode; 0.0.1)",
    codexHome: "/home/u/.codex",
    platformFamily: "unix",
    platformOs: "macos",
  }
  assert.equal(readInitializeUserAgent(live), live.userAgent)
  assert.equal(readInitializeUserAgent({ userAgent: "codex/1.0.0" }), "codex/1.0.0")
})

test("M30: readInitializeUserAgent rejects drifted / not-an-app-server results", () => {
  // The is-object-only check these replace let all of the below through, which
  // deferred the mismatch to a turn that never settles.
  assert.equal(readInitializeUserAgent({}), undefined)
  assert.equal(readInitializeUserAgent({ userAgent: 42 }), undefined)
  assert.equal(readInitializeUserAgent({ userAgent: "" }), undefined)
  assert.equal(readInitializeUserAgent({ user_agent: "codex/1.0.0" }), undefined)
  assert.equal(readInitializeUserAgent(null), undefined)
  assert.equal(readInitializeUserAgent("hi"), undefined)
  assert.equal(readInitializeUserAgent(undefined), undefined)
})

test("isThreadDelta", () => {
  assert.equal(isThreadDelta({ threadId: "t", delta: "x" }), true)
  assert.equal(isThreadDelta({ threadId: "t" }), false)
  assert.equal(isThreadDelta({ delta: "x" }), false)
  assert.equal(isThreadDelta({ threadId: 1, delta: "x" }), false)
  assert.equal(isThreadDelta(null), false)
})

test("isThreadItem", () => {
  assert.equal(isThreadItem({ threadId: "t", item: { type: "agentMessage" } }), true)
  assert.equal(isThreadItem({ threadId: "t", item: "nope" }), false)
  assert.equal(isThreadItem({ threadId: "t" }), false)
})

test("isTokenUsage", () => {
  assert.equal(isTokenUsage({ threadId: "t", tokenUsage: { total: {}, last: {} } }), true)
  assert.equal(isTokenUsage({ threadId: "t", tokenUsage: 5 }), false)
})

test("isTurnCompleted", () => {
  assert.equal(isTurnCompleted({ threadId: "t", turn: { status: "completed" } }), true)
  assert.equal(isTurnCompleted({ threadId: "t", turn: null }), false)
  assert.equal(isTurnCompleted({ turn: {} }), false)
})

test("readErrorNotification helpers", () => {
  assert.equal(readErrorNotificationThreadId({ threadId: "t", message: "m" }), "t")
  assert.equal(readErrorNotificationThreadId({ message: "m" }), undefined)
  assert.equal(readErrorNotificationMessage({ message: "boom" }), "boom")
  assert.equal(readErrorNotificationMessage({ error: "estr" }), "estr")
  assert.equal(readErrorNotificationMessage({ error: { message: "eobj" } }), "eobj")
  assert.equal(readErrorNotificationMessage({}), "codex error")
})
