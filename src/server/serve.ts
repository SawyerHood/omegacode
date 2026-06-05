// Read-only viewer server. It NEVER executes workflows — it only projects on-disk
// state from the runs directory (events.jsonl / result.json) into JSON + an SSE stream,
// and serves a tiny no-build SPA. node:http only; no extra deps.

import { createReadStream } from "node:fs"
import { open, readFile, readdir, stat, watch } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { basename, dirname, extname, join, normalize, sep } from "node:path"
import { fileURLToPath } from "node:url"
import type { ServerResponse as HttpServerResponse } from "node:http"

import { dataRoot } from "../runtime/journal.js"
import type { AgentState, WorkflowEvent } from "../runtime/events.js"
import type { ChatChunk } from "../runtime/transcript.js"
import type { ProviderId } from "../dsl/types.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const WEB_DIR = join(__dirname, "web")

function runsDir(): string {
  return join(dataRoot(), "runs")
}

// ---------------------------------------------------------------------------
// JSONL parsing
// ---------------------------------------------------------------------------

/** Parse a JSONL blob into WorkflowEvents, skipping blank/unparseable lines. */
function parseEvents(text: string): WorkflowEvent[] {
  const out: WorkflowEvent[] = []
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      out.push(JSON.parse(trimmed) as WorkflowEvent)
    } catch {
      // skip a partial / malformed line (e.g. a half-written tail)
    }
  }
  return out
}

/** Read events.jsonl for a run; returns [] if the file is missing/unreadable. */
async function readEvents(runId: string): Promise<WorkflowEvent[]> {
  try {
    const text = await readFile(join(runsDir(), runId, "events.jsonl"), "utf8")
    return parseEvents(text)
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Folding events → snapshots
// ---------------------------------------------------------------------------

type AgentSnapshot = {
  index: number
  phaseIndex?: number
  phaseTitle?: string
  label: string
  provider: ProviderId
  model?: string
  state: AgentState
  cached?: boolean
  durationMs?: number
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  lastTool?: string
  promptPreview?: string
  resultPreview?: string
  error?: string
  t: number
}

type RunStatus = "started" | "completed" | "failed" | "interrupted" | "unknown"

interface PhaseSnapshot {
  index: number
  title: string
  agents: AgentSnapshot[]
}

interface RunSnapshot {
  runId: string
  status: RunStatus
  name?: string
  workflowFile?: string
  error?: string
  startedAt?: number
  endedAt?: number
  phases: PhaseSnapshot[]
  agents: AgentSnapshot[]
  logs: Array<{ t: number; message: string }>
}

interface RunSummary {
  runId: string
  name?: string
  status: RunStatus
  agents: number
  startedAt?: number
  endedAt?: number
}

/** Fold a run's events into a full snapshot: latest agent per index + phases + logs. */
function foldSnapshot(runId: string, events: WorkflowEvent[]): RunSnapshot {
  const agentByIndex = new Map<number, AgentSnapshot>()
  const phaseByIndex = new Map<number, PhaseSnapshot>()
  const logs: Array<{ t: number; message: string }> = []
  let status: RunStatus = "unknown"
  let startedAt: number | undefined
  let endedAt: number | undefined
  let workflowFile: string | undefined
  let error: string | undefined

  for (const ev of events) {
    switch (ev.type) {
      case "run": {
        if (ev.status === "started") {
          status = "started"
          if (startedAt === undefined) startedAt = ev.t
          if (ev.workflowFile) workflowFile = ev.workflowFile
        } else {
          status = ev.status
          endedAt = ev.t
          if (ev.error) error = ev.error
        }
        break
      }
      case "phase": {
        const existing = phaseByIndex.get(ev.index)
        if (existing) existing.title = ev.title
        else phaseByIndex.set(ev.index, { index: ev.index, title: ev.title, agents: [] })
        break
      }
      case "agent": {
        // Latest event for this index wins; merge so earlier fields (preview, tokens)
        // survive when a later event omits them.
        const prev = agentByIndex.get(ev.index)
        const next: AgentSnapshot = {
          index: ev.index,
          phaseIndex: ev.phaseIndex ?? prev?.phaseIndex,
          phaseTitle: ev.phaseTitle ?? prev?.phaseTitle,
          label: ev.label ?? prev?.label ?? "",
          provider: ev.provider ?? prev?.provider ?? "codex",
          model: ev.model ?? prev?.model,
          state: ev.state,
          cached: ev.cached ?? prev?.cached,
          durationMs: ev.durationMs ?? prev?.durationMs,
          inputTokens: ev.inputTokens ?? prev?.inputTokens,
          outputTokens: ev.outputTokens ?? prev?.outputTokens,
          costUsd: ev.costUsd ?? prev?.costUsd,
          lastTool: ev.lastTool ?? prev?.lastTool,
          promptPreview: ev.promptPreview ?? prev?.promptPreview,
          resultPreview: ev.resultPreview ?? prev?.resultPreview,
          error: ev.error ?? prev?.error,
          t: ev.t,
        }
        agentByIndex.set(ev.index, next)
        break
      }
      case "log": {
        logs.push({ t: ev.t, message: ev.message })
        break
      }
    }
  }

  const agents = [...agentByIndex.values()].sort((a, b) => a.index - b.index)

  // Ensure phases referenced by agents exist even if no phase event was seen.
  for (const a of agents) {
    if (a.phaseIndex !== undefined && !phaseByIndex.has(a.phaseIndex)) {
      phaseByIndex.set(a.phaseIndex, { index: a.phaseIndex, title: a.phaseTitle ?? `Phase ${a.phaseIndex}`, agents: [] })
    }
  }
  for (const a of agents) {
    if (a.phaseIndex !== undefined) phaseByIndex.get(a.phaseIndex)?.agents.push(a)
  }
  const phases = [...phaseByIndex.values()].sort((p, q) => p.index - q.index)
  for (const p of phases) p.agents.sort((a, b) => a.index - b.index)

  const name = workflowFile ? basename(workflowFile).replace(/\.workflow\.[cm]?[jt]s$/i, "").replace(/\.[cm]?[jt]s$/i, "") : undefined

  return { runId, status, name, workflowFile, error, startedAt, endedAt, phases, agents, logs }
}

/** Summarize a run for the list view. */
function foldSummary(runId: string, events: WorkflowEvent[]): RunSummary {
  const snap = foldSnapshot(runId, events)
  return {
    runId,
    name: snap.name,
    status: snap.status,
    agents: snap.agents.length,
    startedAt: snap.startedAt,
    endedAt: snap.endedAt,
  }
}

/** List all runs (newest first), folding each run's events.jsonl into a summary. */
async function listRuns(): Promise<RunSummary[]> {
  let entries: Array<{ name: string; isDirectory: () => boolean }>
  try {
    entries = await readdir(runsDir(), { withFileTypes: true })
  } catch {
    return []
  }
  const summaries: Array<{ summary: RunSummary; mtime: number }> = []
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    const runId = ent.name
    const events = await readEvents(runId)
    if (events.length === 0) {
      // Surface dirs that exist but have no events yet (use mtime for ordering).
      let mtime = 0
      try {
        mtime = (await stat(join(runsDir(), runId))).mtimeMs
      } catch {
        // ignore
      }
      summaries.push({ summary: { runId, status: "unknown", agents: 0 }, mtime })
      continue
    }
    const summary = foldSummary(runId, events)
    summaries.push({ summary, mtime: summary.startedAt ?? 0 })
  }
  summaries.sort((a, b) => {
    const ta = a.summary.startedAt ?? a.mtime
    const tb = b.summary.startedAt ?? b.mtime
    return tb - ta
  })
  return summaries.map((s) => s.summary)
}

// ---------------------------------------------------------------------------
// Static assets
// ---------------------------------------------------------------------------

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
}

/** Serve a file from WEB_DIR, guarding against path traversal. */
function serveStatic(res: ServerResponse, fileName: string): void {
  const safe = normalize(fileName).replace(/^(\.\.(?:[/\\]|$))+/, "")
  const full = join(WEB_DIR, safe)
  if (!full.startsWith(WEB_DIR + sep) && full !== WEB_DIR) {
    sendText(res, 403, "forbidden")
    return
  }
  const type = CONTENT_TYPES[extname(full).toLowerCase()] ?? "application/octet-stream"
  const stream = createReadStream(full)
  stream.on("open", () => {
    res.writeHead(200, { "content-type": type, "cache-control": "no-cache" })
  })
  stream.on("error", () => {
    if (!res.headersSent) sendText(res, 404, "not found")
    else res.end()
  })
  stream.pipe(res)
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-cache",
  })
  res.end(text)
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" })
  res.end(body)
}

/** A run id is one path segment, no separators or traversal. */
function isValidRunId(id: string): boolean {
  return id.length > 0 && !id.includes("/") && !id.includes("\\") && !id.includes("..") && !id.includes("\0")
}

// ---------------------------------------------------------------------------
// SSE stream: send current JSONL lines, then tail the file via fs.watch.
//
// `tailJsonl` is the shared engine for every streaming endpoint: it opens the
// SSE response, replays whole lines already on disk, then watches the file's
// directory (so it catches the file being created later, plus appends),
// pushing each newly-completed JSON line to the client. It tolerates a missing
// file (sends nothing, keeps watching for it to appear) and a partial last
// line (carried over until its newline arrives). The watcher + heartbeat are
// torn down when the request closes.
// ---------------------------------------------------------------------------

async function tailJsonl(req: IncomingMessage, res: HttpServerResponse, filePath: string): Promise<void> {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  })
  res.write(": connected\n\n")

  // Track byte offset consumed so we only emit newly-appended whole lines.
  let offset = 0
  let pending = "" // carry over a partial last line between reads
  let closed = false

  const sendEvent = (ev: unknown): void => {
    if (closed) return
    res.write(`data: ${JSON.stringify(ev)}\n\n`)
  }

  // Read from `offset` to EOF, emit complete lines, retain a trailing partial.
  let reading = false
  let rereadRequested = false
  const drain = async (): Promise<void> => {
    if (closed) return
    if (reading) {
      rereadRequested = true
      return
    }
    reading = true
    try {
      let fh
      try {
        fh = await open(filePath, "r")
      } catch {
        // File not created yet — nothing to read.
        return
      }
      try {
        const { size } = await fh.stat()
        if (size < offset) {
          // File shrank/rotated; restart from the top.
          offset = 0
          pending = ""
        }
        if (size > offset) {
          const length = size - offset
          const buf = Buffer.alloc(length)
          const { bytesRead } = await fh.read(buf, 0, length, offset)
          offset += bytesRead
          pending += buf.subarray(0, bytesRead).toString("utf8")
          let nl = pending.indexOf("\n")
          while (nl !== -1) {
            const line = pending.slice(0, nl).trim()
            pending = pending.slice(nl + 1)
            if (line) {
              try {
                sendEvent(JSON.parse(line))
              } catch {
                // skip malformed line
              }
            }
            nl = pending.indexOf("\n")
          }
        }
      } finally {
        await fh.close()
      }
    } finally {
      reading = false
      if (rereadRequested && !closed) {
        rereadRequested = false
        void drain()
      }
    }
  }

  // Initial flush of existing content.
  await drain()

  // Watch the file's directory so we catch the file being created later, plus appends.
  const ac = new AbortController()
  let heartbeat: ReturnType<typeof setInterval> | undefined
  const cleanup = (): void => {
    if (closed) return
    closed = true
    ac.abort()
    if (heartbeat) clearInterval(heartbeat)
    res.end()
  }

  req.on("close", cleanup)
  req.on("error", cleanup)

  // Keep the connection alive through proxies / idle periods.
  heartbeat = setInterval(() => {
    if (!closed) res.write(": ping\n\n")
  }, 20_000)

  const watchDir = dirname(filePath)
  const targetName = basename(filePath)
  void (async () => {
    try {
      const watcher = watch(watchDir, { signal: ac.signal })
      for await (const change of watcher) {
        if (closed) break
        if (!change.filename || change.filename === targetName) {
          await drain()
        }
      }
    } catch {
      // AbortError on cleanup or watch failure — nothing to do.
    }
  })()
}

/** SSE: replay + tail a run's events.jsonl. */
function streamRun(req: IncomingMessage, res: HttpServerResponse, runId: string): Promise<void> {
  return tailJsonl(req, res, join(runsDir(), runId, "events.jsonl"))
}

/**
 * SSE: replay + tail one agent's transcript jsonl. The agents dir / file may
 * not exist yet (agent not started) — tailJsonl tolerates that and starts
 * watching for the file to appear.
 */
function streamAgent(req: IncomingMessage, res: HttpServerResponse, runId: string, index: number): Promise<void> {
  return tailJsonl(req, res, join(runsDir(), runId, "agents", `${index}.jsonl`))
}

// ---------------------------------------------------------------------------
// Agent transcript snapshot
// ---------------------------------------------------------------------------

/** Parse a JSONL blob into ChatChunks, skipping blank/unparseable lines. */
function parseChunks(text: string): ChatChunk[] {
  const out: ChatChunk[] = []
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      out.push(JSON.parse(trimmed) as ChatChunk)
    } catch {
      // skip a partial / malformed line (e.g. a half-written tail)
    }
  }
  return out
}

/** Read one agent's transcript jsonl; null if the file is missing. */
async function readAgentChunks(runId: string, index: number): Promise<ChatChunk[] | null> {
  try {
    const text = await readFile(join(runsDir(), runId, "agents", `${index}.jsonl`), "utf8")
    return parseChunks(text)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? "GET"
  const url = new URL(req.url ?? "/", "http://localhost")
  const path = url.pathname

  if (method !== "GET" && method !== "HEAD") {
    sendText(res, 405, "method not allowed")
    return
  }

  // Static assets + root.
  if (path === "/" || path === "/index.html") {
    serveStatic(res, "index.html")
    return
  }
  if (path === "/app.js") {
    serveStatic(res, "app.js")
    return
  }
  if (path === "/style.css") {
    serveStatic(res, "style.css")
    return
  }

  // API: list runs.
  if (path === "/api/runs") {
    sendJson(res, 200, await listRuns())
    return
  }

  // API: one agent's transcript stream (replay + live tail).
  const agentStreamMatch = /^\/api\/runs\/([^/]+)\/agents\/(\d+)\/stream$/.exec(path)
  if (agentStreamMatch) {
    const runId = decodeURIComponent(agentStreamMatch[1] ?? "")
    if (!isValidRunId(runId)) {
      sendText(res, 400, "bad run id")
      return
    }
    await streamAgent(req, res, runId, Number(agentStreamMatch[2]))
    return
  }

  // API: one agent's transcript snapshot.
  const agentMatch = /^\/api\/runs\/([^/]+)\/agents\/(\d+)$/.exec(path)
  if (agentMatch) {
    const runId = decodeURIComponent(agentMatch[1] ?? "")
    if (!isValidRunId(runId)) {
      sendText(res, 400, "bad run id")
      return
    }
    const index = Number(agentMatch[2])
    const chunks = await readAgentChunks(runId, index)
    if (chunks === null) {
      sendJson(res, 404, { error: "agent transcript not found", runId, index })
      return
    }
    sendJson(res, 200, { index, chunks })
    return
  }

  // API: single run snapshot or stream.
  const streamMatch = /^\/api\/runs\/([^/]+)\/stream$/.exec(path)
  if (streamMatch) {
    const runId = decodeURIComponent(streamMatch[1] ?? "")
    if (!isValidRunId(runId)) {
      sendText(res, 400, "bad run id")
      return
    }
    await streamRun(req, res, runId)
    return
  }

  const runMatch = /^\/api\/runs\/([^/]+)$/.exec(path)
  if (runMatch) {
    const runId = decodeURIComponent(runMatch[1] ?? "")
    if (!isValidRunId(runId)) {
      sendText(res, 400, "bad run id")
      return
    }
    const events = await readEvents(runId)
    if (events.length === 0) {
      // Distinguish a known-but-empty run dir from a truly missing one.
      try {
        await stat(join(runsDir(), runId))
      } catch {
        sendJson(res, 404, { error: "run not found", runId })
        return
      }
    }
    sendJson(res, 200, foldSnapshot(runId, events))
    return
  }

  sendText(res, 404, "not found")
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function startViewer(opts: { port?: number; host?: string }): Promise<{ url: string; close: () => Promise<void> }> {
  const host = opts.host ?? "127.0.0.1"
  const port = opts.port ?? 0

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      if (!res.headersSent) sendText(res, 500, `internal error: ${message}`)
      else res.end()
    })
  })

  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, host, () => {
      server.removeListener("error", reject)
      const addr = server.address()
      const actualPort = typeof addr === "object" && addr ? addr.port : port
      const displayHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host
      const url = `http://${displayHost.includes(":") ? `[${displayHost}]` : displayHost}:${actualPort}/`
      resolve({
        url,
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()))
            // Closing the server stops accepting new conns; in-flight SSE clients
            // are cleaned up when their sockets close.
          }),
      })
    })
  })
}
