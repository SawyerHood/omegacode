// Read-only viewer server. It NEVER executes workflows — it only projects on-disk
// state from the runs directory (events.jsonl / result.json) into JSON + an SSE stream,
// and serves a tiny no-build SPA. node:http only; no extra deps.

import { createReadStream, existsSync } from "node:fs"
import { readFile, readdir, realpath, stat, watch } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { basename, dirname, extname, join, normalize, sep } from "node:path"
import { fileURLToPath } from "node:url"
import type { ServerResponse as HttpServerResponse } from "node:http"

import { dataRoot } from "../runtime/journal.js"
import type { AgentState, WorkflowEvent } from "../runtime/events.js"
import type { ChatChunk } from "../runtime/transcript.js"
import type { ProviderId } from "../dsl/types.js"
import { nearestExistingDir, parseLastEventId, readNewLines } from "./tail.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
// Built viewer assets: dist/web when bundled (tsup copies viewer/dist there), or the live
// viewer/dist when running from source (tsx src/server/serve.ts → repo/viewer/dist).
const WEB_CANDIDATES = [join(__dirname, "web"), join(__dirname, "..", "..", "viewer", "dist")]
const WEB_DIR = WEB_CANDIDATES.find((p) => existsSync(p)) ?? WEB_CANDIDATES[0]!

/** Live SSE connection count — drives idle self-shutdown for an auto-started viewer. */
let sseClients = 0

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

type RunStatus = "started" | "completed" | "failed" | "interrupted" | "unknown" | "stale"

/** A "started" run whose heartbeat is older than this is treated as dead (deadman switch). */
const STALE_MS = 20_000

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

/**
 * Fold a run's events into a full snapshot with its RAW status (no deadman applied), so the
 * result is cacheable. Latest agent per index + phases + logs. Pure (no fs).
 */
function foldSnapshotRaw(runId: string, events: WorkflowEvent[]): RunSnapshot {
  return foldSnapshot(runId, events, undefined, true)
}

/**
 * Fold a run's events into a full snapshot: latest agent per index + phases + logs.
 * `lastBeat` is the run's most recent heartbeat mtime (ms); when omitted, staleness falls
 * back to `startedAt`. Pass `raw=true` to skip the deadman entirely (for caching). Pure
 * (no fs) so callers can supply an async-stat'd heartbeat value (M25).
 */
function foldSnapshot(runId: string, events: WorkflowEvent[], lastBeat?: number, raw = false): RunSnapshot {
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

  // The deadman switch is skipped when `raw` (so the fold is cacheable); otherwise applied
  // with the supplied live heartbeat. Callers that cache fold raw and re-derive staleness from
  // the live heartbeat on every poll, so a run that goes stale after caching never sticks at
  // "started" (M25).
  const finalStatus = raw ? status : applyDeadman(status, startedAt, lastBeat)

  return { runId, status: finalStatus, name, workflowFile, error, startedAt, endedAt, phases, agents, logs }
}

/**
 * Deadman switch: a run still marked "started" whose most recent heartbeat (or startedAt,
 * if no beat is known) has gone stale is treated as dead — its process was SIGKILLed /
 * crashed / the terminal closed before a terminal event. `lastBeat` undefined means "no
 * heartbeat info supplied" and falls back to startedAt.
 */
function applyDeadman(status: RunStatus, startedAt: number | undefined, lastBeat: number | undefined): RunStatus {
  if (status !== "started") return status
  const beat = Math.max(startedAt ?? 0, lastBeat ?? 0)
  if (beat > 0 && Date.now() - beat > STALE_MS) return "stale"
  return status
}

/** Most recent heartbeat mtime (ms) for a run, or 0 if there is no heartbeat file (async — M25). */
async function heartbeatMtime(runId: string): Promise<number> {
  try {
    return (await stat(join(runsDir(), runId, ".heartbeat"))).mtimeMs
  } catch {
    return 0
  }
}

/** Summarize a run for the list view (raw status; caller applies the deadman). */
function foldSummary(runId: string, events: WorkflowEvent[]): RunSummary {
  const snap = foldSnapshotRaw(runId, events)
  return {
    runId,
    name: snap.name,
    status: snap.status,
    agents: snap.agents.length,
    startedAt: snap.startedAt,
    endedAt: snap.endedAt,
  }
}

// Summary cache keyed by (runId, size, mtime) of events.jsonl — a 4s poll over many runs
// otherwise re-reads and JSON-parses every run's full events.jsonl every time (M25). The
// cached summary stores the RAW (pre-deadman) status; staleness is re-derived from the live
// heartbeat on every poll, so a run that goes stale after being cached is never stuck showing
// "started".
interface CachedSummary {
  size: number
  mtimeMs: number
  summary: RunSummary
}
const summaryCache = new Map<string, CachedSummary>()

/** List all runs (newest first), folding each run's events.jsonl into a summary. */
async function listRuns(): Promise<RunSummary[]> {
  let entries: Array<{ name: string; isDirectory: () => boolean }>
  try {
    entries = await readdir(runsDir(), { withFileTypes: true })
  } catch {
    return []
  }
  const seen = new Set<string>()
  const summaries: Array<{ summary: RunSummary; mtime: number }> = []
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    const runId = ent.name
    seen.add(runId)

    // Stat events.jsonl once; the (size, mtime) pair is the cache key.
    let eventsStat: { size: number; mtimeMs: number } | undefined
    try {
      eventsStat = await stat(join(runsDir(), runId, "events.jsonl"))
    } catch {
      eventsStat = undefined
    }

    let rawSummary: RunSummary | undefined
    if (eventsStat) {
      const cached = summaryCache.get(runId)
      if (cached && cached.size === eventsStat.size && cached.mtimeMs === eventsStat.mtimeMs) {
        rawSummary = cached.summary // file unchanged — reuse the cached raw fold
      }
    }

    if (!rawSummary) {
      const events = await readEvents(runId)
      if (events.length === 0) {
        // Surface dirs that exist but have no events yet (use dir mtime for ordering).
        let mtime = 0
        try {
          mtime = (await stat(join(runsDir(), runId))).mtimeMs
        } catch {
          // ignore
        }
        summaries.push({ summary: { runId, status: "unknown", agents: 0 }, mtime })
        continue
      }
      rawSummary = foldSummary(runId, events) // raw (pre-deadman) status
      if (eventsStat) summaryCache.set(runId, { size: eventsStat.size, mtimeMs: eventsStat.mtimeMs, summary: rawSummary })
    }

    // Always re-derive the deadman from the LIVE heartbeat so a cached "started" run that has
    // since gone stale never sticks (M25).
    let summary = rawSummary
    if (rawSummary.status === "started") {
      const status = applyDeadman("started", rawSummary.startedAt, await heartbeatMtime(runId))
      if (status !== "started") summary = { ...rawSummary, status }
    }
    summaries.push({ summary, mtime: summary.startedAt ?? 0 })
  }

  // Drop cache entries for runs that disappeared (e.g. pruned) so the map can't grow forever.
  for (const key of summaryCache.keys()) if (!seen.has(key)) summaryCache.delete(key)

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
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".png": "image/png",
  ".ico": "image/x-icon",
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

/**
 * Decode a percent-encoded path segment, returning null on malformed input (a lone `%`,
 * `%zz`, etc.) instead of letting decodeURIComponent throw a URIError → 500 (L20). Callers
 * treat null as a 400 bad-request.
 */
function safeDecode(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
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
  // Register lifecycle teardown BEFORE any awaited replay work (H15). If the client
  // disconnects mid-replay (e.g. a large file), `close` must already have a listener or
  // the connection leaks: sseClients stays inflated (idle shutdown never fires), the
  // heartbeat keeps writing to a destroyed response, and the watcher is never aborted.
  let closed = false
  const ac = new AbortController()
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let pollTimer: ReturnType<typeof setInterval> | undefined
  const cleanup = (): void => {
    if (closed) return
    closed = true
    sseClients = Math.max(0, sseClients - 1)
    ac.abort()
    if (heartbeat) clearInterval(heartbeat)
    if (pollTimer) clearInterval(pollTimer)
    res.end()
  }
  req.on("close", cleanup)
  req.on("error", cleanup)
  // ServerResponse 'close' is the spec-guaranteed signal for "connection terminated before
  // the response completed" — for an SSE response that never completes, it fires exactly on
  // disconnect, on every Node version. cleanup is idempotent, so listening on both is safe.
  res.on("close", cleanup)

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  })
  res.write(": connected\n\n")
  sseClients += 1

  // Resume support (H17): Last-Event-ID carries the byte offset the client already has.
  // Each `id:` frame we emit is the byte offset *after* that line, so on reconnect the
  // client tells us where it left off and we replay only what's new — no duplicate
  // transcripts/logs. A shrink/rotation resets `id:` back to 0 and the client (which
  // resets its buffers on `onopen`) re-syncs from the top.
  let offset = parseLastEventId(req.headers["last-event-id"])
  let pending: Buffer = Buffer.alloc(0)

  const sendEvent = (ev: unknown, id: number): void => {
    if (closed) return
    res.write(`id: ${id}\ndata: ${JSON.stringify(ev)}\n\n`)
  }

  // Read from `offset` to EOF in bounded chunks, emit complete lines, retain a partial.
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
      const result = await readNewLines(filePath, offset, pending)
      offset = result.offset
      pending = result.pending
      // After a shrink/rotation we restarted from byte 0; the client resets on `onopen`,
      // so re-emitting from the top with offsets starting at 0 is dedup-correct.
      for (const { line, offset: id } of result.lines) {
        try {
          sendEvent(JSON.parse(line), id)
        } catch {
          // skip malformed line
        }
      }
    } finally {
      reading = false
      if (rereadRequested && !closed) {
        rereadRequested = false
        drain().catch(() => {
          // best-effort re-read; the watcher loop will drain again on the next change
        })
      }
    }
  }

  // Initial flush of existing content.
  await drain()
  if (closed) return // client may have disconnected during the initial drain

  // Keep the connection alive through proxies / idle periods.
  heartbeat = setInterval(() => {
    if (!closed) res.write(": ping\n\n")
  }, 20_000)

  // Belt-and-braces poll: fs.watch delivery is not a correctness guarantee across
  // platforms/Node lines (missed events hung the suite on linux/node 20). A slow drain
  // turns any missed event into a ≤1s delay instead of a stream that never delivers.
  // drain() is offset-based and self-serializing, so overlap with watch events is safe.
  pollTimer = setInterval(() => {
    if (!closed) void drain().catch(() => {})
  }, TAIL_POLL_MS)

  // Watch the file's directory so we catch the file being created later, plus appends.
  // The directory may not exist yet (the runtime emits the "running" agent event before
  // creating runs/<id>/agents/), so poll for the directory to appear before watching it
  // (M23) — otherwise the stream pings forever and never delivers.
  const targetDir = dirname(filePath)
  const targetName = basename(filePath)
  void (async () => {
    // Phase 1: wait for the target directory to exist. fs.watch can't watch a missing dir
    // (M23) and subdirectory-creation events aren't reliably reported across platforms, so
    // poll until the directory appears (the run dir / agents dir is created shortly after
    // the agent's "running" event). Cheap: a stat every DIR_POLL_MS.
    while (!closed && !(await dirNowExists(targetDir))) {
      if (await sleepUnlessClosed(DIR_POLL_MS, () => closed)) return
    }
    if (closed) return
    // The dir may have been populated between the poll and now — drain before watching.
    await drain()

    // Phase 2: watch the (now-existing) target directory for appends. If the directory is
    // ever removed, fall back to re-running phase 1 from the top.
    while (!closed) {
      try {
        // Watch the REAL path: on Windows a watched path containing an 8.3 short segment
        // (e.g. RUNNER~1 in %TEMP%) trips a libuv assert in fs-event.c — a process abort,
        // not a catchable error — when events report the long-form name.
        const watchDir = await realpath(targetDir).catch(() => targetDir)
        const watcher = watch(watchDir, { signal: ac.signal })
        // Drain once more: the file may have been (re)written between the last drain and
        // this watch being armed, in which case no change event would ever fire for it.
        await drain()
        if (closed) return
        for await (const change of watcher) {
          if (closed) return
          if (!change.filename || change.filename === targetName) await drain()
        }
      } catch {
        if (closed) return
        // The watched dir vanished (rotation/cleanup) — re-resolve from phase 1.
        while (!closed && !(await dirNowExists(targetDir))) {
          if (await sleepUnlessClosed(DIR_POLL_MS, () => closed)) return
        }
        if (closed) return
        await drain()
      }
    }
  })().catch(() => {
    // The tail loop is best-effort: an unexpected fs error must not become an
    // unhandledRejection that kills the server. cleanup() owns teardown.
  })
}

/** Poll interval while waiting for a not-yet-created directory to appear. */
const DIR_POLL_MS = 250
/** Fallback drain cadence for SSE tails — bounds staleness when fs.watch misses an event. */
const TAIL_POLL_MS = 1000

async function dirNowExists(dir: string): Promise<boolean> {
  return (await nearestExistingDir(dir)) === dir
}

/** Resolve after `ms` unless `isClosed()` flips true first; returns true if closed. */
function sleepUnlessClosed(ms: number, isClosed: () => boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(isClosed()), ms)
    timer.unref?.()
  })
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

  // API: list runs.
  if (path === "/api/runs") {
    sendJson(res, 200, await listRuns())
    return
  }

  // API: one agent's transcript stream (replay + live tail).
  const agentStreamMatch = /^\/api\/runs\/([^/]+)\/agents\/(\d+)\/stream$/.exec(path)
  if (agentStreamMatch) {
    const runId = safeDecode(agentStreamMatch[1] ?? "")
    if (runId === null || !isValidRunId(runId)) {
      sendText(res, 400, "bad run id")
      return
    }
    await streamAgent(req, res, runId, Number(agentStreamMatch[2]))
    return
  }

  // API: one agent's transcript snapshot.
  const agentMatch = /^\/api\/runs\/([^/]+)\/agents\/(\d+)$/.exec(path)
  if (agentMatch) {
    const runId = safeDecode(agentMatch[1] ?? "")
    if (runId === null || !isValidRunId(runId)) {
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
    const runId = safeDecode(streamMatch[1] ?? "")
    if (runId === null || !isValidRunId(runId)) {
      sendText(res, 400, "bad run id")
      return
    }
    await streamRun(req, res, runId)
    return
  }

  const runMatch = /^\/api\/runs\/([^/]+)$/.exec(path)
  if (runMatch) {
    const runId = safeDecode(runMatch[1] ?? "")
    if (runId === null || !isValidRunId(runId)) {
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
    sendJson(res, 200, foldSnapshot(runId, events, await heartbeatMtime(runId)))
    return
  }

  // Unmatched API path → 404 JSON; everything else → static SPA assets (HashRouter, so no
  // server-side route fallback is needed beyond serving index.html at "/").
  if (path.startsWith("/api/")) {
    sendJson(res, 404, { error: "not found" })
    return
  }
  serveStatic(res, path === "/" ? "index.html" : path)
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface ViewerHandle {
  url: string
  close: () => Promise<void>
}

export function startViewer(opts: {
  port?: number
  host?: string
  /** Watch for idle (no SSE client, no "started" run) and fire `onIdle` after `idleMs`. */
  idleShutdown?: boolean
  idleMs?: number
  /** How often to evaluate idleness (ms). Defaults to 15s; lowered in tests. */
  idleCheckMs?: number
  /**
   * Called once when the viewer has been idle for `idleMs`. The library never calls
   * `process.exit` itself (L21): supply this to decide what to do (the CLI passes a
   * handler that closes the server and exits the auto-started viewer process). When
   * omitted while `idleShutdown` is true, the viewer self-closes its HTTP server but does
   * not exit the host process.
   */
  onIdle?: (handle: ViewerHandle) => void
}): Promise<ViewerHandle> {
  const host = opts.host ?? "127.0.0.1"
  const port = opts.port ?? 0

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      if (!res.headersSent) sendText(res, 500, `internal error: ${message}`)
      else res.end()
    })
  })

  let idleTimer: ReturnType<typeof setInterval> | undefined

  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, host, () => {
      server.removeListener("error", reject)
      const addr = server.address()
      const actualPort = typeof addr === "object" && addr ? addr.port : port
      const displayHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host
      const url = `http://${displayHost.includes(":") ? `[${displayHost}]` : displayHost}:${actualPort}/`

      const close = (): Promise<void> =>
        new Promise<void>((res, rej) => {
          if (idleTimer) clearInterval(idleTimer)
          server.close((err) => (err ? rej(err) : res()))
          // Closing the server stops accepting new conns; in-flight SSE clients
          // are cleaned up when their sockets close.
        })

      const viewerHandle: ViewerHandle = { url, close }

      if (opts.idleShutdown) {
        // Fire onIdle once there's been no SSE client and no "started" run for idleMs.
        const idleMs = opts.idleMs ?? 60_000
        let lastActive = Date.now()
        idleTimer = setInterval(() => {
          void (async () => {
            let active = sseClients > 0
            if (!active) {
              try {
                active = (await listRuns()).some((r) => r.status === "started")
              } catch {
                active = false
              }
            }
            if (active) {
              lastActive = Date.now()
              return
            }
            if (Date.now() - lastActive >= idleMs) {
              if (idleTimer) clearInterval(idleTimer)
              idleTimer = undefined
              if (opts.onIdle) opts.onIdle(viewerHandle)
              else void close()
            }
          })()
        }, opts.idleCheckMs ?? 15_000)
        idleTimer.unref() // don't keep the process alive on the timer alone
      }

      resolve(viewerHandle)
    })
  })
}
