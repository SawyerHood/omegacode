// No-build SPA for the agent-workflows viewer, styled after Claude Code's
// workflow progress display: a dark terminal aesthetic with a tree of phase
// group-boxes. Hash routing (#/run/<id>), SSE-driven live updates folded into
// the same snapshot shape the server uses, and in-place tree patching so a
// running run animates without full-render flicker.

const runListEl = document.getElementById("run-list")
const runCountEl = document.getElementById("run-count")
const detailEl = document.getElementById("detail")
const topStatusEl = document.getElementById("topstatus")
const drilldownEl = document.getElementById("drilldown")
const scrimEl = document.getElementById("drilldown-scrim")

let runs = [] // latest /api/runs payload
let activeRunId = null
let source = null // active EventSource
let snapshot = null // current run snapshot (folded client-side)
let elapsedTimer = null // ticks the header elapsed clock for running runs

let activeAgentIndex = null // open drilldown agent index, or null
let agentSource = null // active EventSource for the agent transcript
let agentChunks = [] // ChatChunk[] for the open agent
let agentFeedDirty = false // a frame is scheduled to flush appended chunks

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined && text !== null) node.textContent = String(text)
  return node
}

function fmtTokens(n) {
  if (n === undefined || n === null) return null
  if (n < 1000) return `${n}`
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

function fmtDuration(ms) {
  if (ms === undefined || ms === null) return null
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const rem = Math.round(s % 60)
  return `${m}m${String(rem).padStart(2, "0")}s`
}

function fmtElapsed(start, end) {
  if (!start) return null
  const ms = (end ?? Date.now()) - start
  return fmtDuration(Math.max(0, ms))
}

function fmtCost(usd) {
  if (typeof usd !== "number" || usd <= 0) return null
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}

function fmtRelative(t) {
  if (!t && t !== 0) return ""
  const diff = Date.now() - t
  if (diff < 0) return "just now"
  const s = Math.floor(diff / 1000)
  if (s < 60) return "just now"
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

// Provider accent colors for the tiny leading dot.
const PROVIDER_CLASS = {
  codex: "prov-codex",
  "claude-code": "prov-claude",
  claude: "prov-claude",
  anthropic: "prov-claude",
}
function providerClass(p) {
  return PROVIDER_CLASS[p] || "prov-other"
}

// ---------------------------------------------------------------------------
// Status derivation
// ---------------------------------------------------------------------------

// A run is "live" when its on-disk status is still started and nothing ended it.
function isRunActive(status) {
  return status === "started" || status === "unknown"
}

// Per-phase rollup glyph.
function phaseStatus(agents) {
  if (!agents.length) return "queued"
  if (agents.some((a) => a.state === "failed")) return "failed"
  if (agents.some((a) => a.state === "running")) return "running"
  if (agents.every((a) => a.state === "done" || a.state === "skipped")) return "done"
  return "running"
}

const STATE_GLYPH = {
  done: "✓",
  failed: "✗",
  running: "⟳",
  queued: "◌",
  skipped: "⊘",
  started: "⟳",
  completed: "✓",
  interrupted: "✗",
  unknown: "◌",
}

function glyphFor(state) {
  return STATE_GLYPH[state] || "·"
}

// Map a run-summary status to a state-style class.
function runStateClass(status) {
  if (status === "completed") return "done"
  if (status === "failed" || status === "interrupted") return "failed"
  if (status === "started") return "running"
  return "queued"
}

// ---------------------------------------------------------------------------
// Aggregate stats for a snapshot/summary
// ---------------------------------------------------------------------------

function aggregate(agents) {
  let inTok = 0
  let outTok = 0
  let cost = 0
  let tools = 0
  let done = 0
  let failed = 0
  let running = 0
  for (const a of agents) {
    inTok += a.inputTokens || 0
    outTok += a.outputTokens || 0
    cost += a.costUsd || 0
    if (a.lastTool) tools += 1
    if (a.state === "done") done += 1
    else if (a.state === "failed") failed += 1
    else if (a.state === "running") running += 1
  }
  return { inTok, outTok, totalTok: inTok + outTok, cost, tools, done, failed, running, total: agents.length }
}

// ---------------------------------------------------------------------------
// Run list (left pane)
// ---------------------------------------------------------------------------

async function loadRuns() {
  try {
    const res = await fetch("/api/runs")
    runs = await res.json()
  } catch (err) {
    runListEl.replaceChildren(el("li", "empty", "Failed to load runs."))
    return
  }
  renderRunList()
}

function renderRunList() {
  if (!Array.isArray(runs) || runs.length === 0) {
    runCountEl.textContent = ""
    runListEl.replaceChildren(el("li", "empty", "No runs yet."))
    return
  }
  runCountEl.textContent = String(runs.length)
  const items = runs.map((r) => {
    const li = el("li", "run-item")
    li.dataset.runId = r.runId
    if (r.runId === activeRunId) li.classList.add("active")

    const stateClass = runStateClass(r.status)
    const glyph = el("span", `run-glyph st-${stateClass}`, glyphFor(r.status))
    if (stateClass === "running") glyph.classList.add("spin")
    li.append(glyph)

    const body = el("div", "run-body")
    const top = el("div", "run-top")
    top.append(el("span", "run-name", r.name || r.runId))
    body.append(top)

    const metaBits = []
    metaBits.push(`${r.agents} agent${r.agents === 1 ? "" : "s"}`)
    const dur = fmtElapsed(r.startedAt, r.endedAt)
    if (dur) metaBits.push(dur)
    const rel = r.startedAt ? fmtRelative(r.startedAt) : null
    if (rel) metaBits.push(rel)
    body.append(el("div", "run-meta", metaBits.join("  ·  ")))
    li.append(body)

    li.addEventListener("click", () => {
      location.hash = `#/run/${encodeURIComponent(r.runId)}`
    })
    return li
  })
  runListEl.replaceChildren(...items)
}

function highlightActive() {
  for (const li of runListEl.querySelectorAll(".run-item")) {
    li.classList.toggle("active", li.dataset.runId === activeRunId)
  }
}

// ---------------------------------------------------------------------------
// Phase grouping (mirrors the server fold)
// ---------------------------------------------------------------------------

function rebuildPhases(snap) {
  const phaseMap = new Map()
  for (const p of snap.phases || []) {
    phaseMap.set(p.index, { index: p.index, title: p.title, agents: [] })
  }
  const loose = []
  for (const a of snap.agents || []) {
    if (a.phaseIndex !== undefined && a.phaseIndex !== null) {
      if (!phaseMap.has(a.phaseIndex)) {
        phaseMap.set(a.phaseIndex, {
          index: a.phaseIndex,
          title: a.phaseTitle || `Phase ${a.phaseIndex}`,
          agents: [],
        })
      }
      phaseMap.get(a.phaseIndex).agents.push(a)
    } else {
      loose.push(a)
    }
  }
  const phases = [...phaseMap.values()].sort((x, y) => x.index - y.index)
  for (const p of phases) p.agents.sort((x, y) => x.index - y.index)
  if (loose.length) {
    loose.sort((x, y) => x.index - y.index)
    phases.push({ index: Infinity, title: "Ungrouped", agents: loose })
  }
  return phases
}

// ---------------------------------------------------------------------------
// Agent row rendering (the tree leaves)
// ---------------------------------------------------------------------------

function metaLine(a) {
  const bits = []
  if (a.model) bits.push(a.model)
  else if (a.provider) bits.push(a.provider)
  const tok = fmtTokens((a.inputTokens || 0) + (a.outputTokens || 0))
  if (tok && tok !== "0") bits.push(`${tok} tok`)
  if (a.lastTool) bits.push(a.lastTool)
  const dur = fmtDuration(a.durationMs)
  if (dur) bits.push(dur)
  const cost = fmtCost(a.costUsd)
  if (cost) bits.push(cost)
  return bits.join("  ·  ")
}

// Build an agent row element. `connector` is "├─" or "└─".
function buildAgentRow(a, connector) {
  const row = el("div", "agent agent-clickable")
  row.dataset.index = a.index
  row.setAttribute("role", "button")
  row.setAttribute("tabindex", "0")
  row.title = "Open conversation"

  row.append(el("span", "tree-connector", connector))

  const glyph = el("span", `agent-glyph st-${a.state}`, glyphFor(a.state))
  if (a.state === "running") glyph.classList.add("spin")
  row.append(glyph)

  const body = el("div", "agent-body")

  const head = el("div", "agent-head")
  const dot = el("span", `prov-dot ${providerClass(a.provider)}`)
  head.append(dot)
  head.append(el("span", "agent-label", a.label || `agent #${a.index}`))
  if (a.cached) head.append(el("span", "agent-cached", "(cached)"))
  body.append(head)

  const meta = metaLine(a)
  if (meta) body.append(el("div", "agent-meta", meta))

  if (a.state === "failed" && a.error) {
    body.append(el("div", "agent-error", `└ ${firstLine(a.error)}`))
  }

  row.append(body)
  row.append(el("span", "agent-chevron", "›"))
  return row
}

function firstLine(s) {
  if (!s) return ""
  const text = String(s).trim()
  const nl = text.indexOf("\n")
  let line = nl === -1 ? text : text.slice(0, nl)
  if (line.length > 160) line = line.slice(0, 157) + "…"
  return line
}

// Reconcile an existing row's mutable parts in place (no node churn) so live
// updates animate smoothly. Returns true if the row was patched.
function patchAgentRow(row, a) {
  const glyph = row.querySelector(".agent-glyph")
  if (glyph) {
    glyph.textContent = glyphFor(a.state)
    glyph.className = `agent-glyph st-${a.state}`
    if (a.state === "running") glyph.classList.add("spin")
  }
  const dot = row.querySelector(".prov-dot")
  if (dot) dot.className = `prov-dot ${providerClass(a.provider)}`
  const label = row.querySelector(".agent-label")
  if (label) label.textContent = a.label || `agent #${a.index}`

  const head = row.querySelector(".agent-head")
  let cached = head.querySelector(".agent-cached")
  if (a.cached && !cached) head.append(el("span", "agent-cached", "(cached)"))
  else if (!a.cached && cached) cached.remove()

  const body = row.querySelector(".agent-body")
  let meta = body.querySelector(".agent-meta")
  const metaText = metaLine(a)
  if (metaText) {
    if (!meta) {
      meta = el("div", "agent-meta")
      // keep ordering: after head, before error
      const err = body.querySelector(".agent-error")
      if (err) body.insertBefore(meta, err)
      else body.append(meta)
    }
    meta.textContent = metaText
  } else if (meta) {
    meta.remove()
  }

  let err = body.querySelector(".agent-error")
  if (a.state === "failed" && a.error) {
    if (!err) {
      err = el("div", "agent-error")
      body.append(err)
    }
    err.textContent = `└ ${firstLine(a.error)}`
  } else if (err) {
    err.remove()
  }
  return true
}

// ---------------------------------------------------------------------------
// Detail header + narrator + phase tree
// ---------------------------------------------------------------------------

function buildHeader(snap) {
  const agg = aggregate(snap.agents || [])
  const stateClass = runStateClass(snap.status)

  const header = el("div", "run-header")

  const titleRow = el("div", "run-header-top")
  const glyph = el("span", `run-header-glyph st-${stateClass}`, glyphFor(snap.status))
  if (stateClass === "running") glyph.classList.add("spin")
  titleRow.append(glyph)
  titleRow.append(el("span", "run-header-title", snap.name || snap.runId))
  const statusLabel = isRunActive(snap.status) ? "running" : snap.status
  titleRow.append(el("span", `run-header-status st-${stateClass}`, statusLabel))
  header.append(titleRow)

  const statsRow = el("div", "run-header-stats")
  statsRow.dataset.role = "header-stats"
  header.append(statsRow)
  fillHeaderStats(statsRow, snap, agg)

  if (snap.error && snap.status !== "started") {
    header.append(el("div", "run-error", firstLine(snap.error)))
  }
  return header
}

function fillHeaderStats(statsRow, snap, agg) {
  const bits = []
  bits.push(`${agg.done}/${agg.total} agents`)
  if (agg.failed) bits.push(`${agg.failed} failed`)
  const tok = fmtTokens(agg.totalTok)
  if (tok && tok !== "0") bits.push(`${tok} tok`)
  const cost = fmtCost(agg.cost)
  if (cost) bits.push(cost)
  const elapsed = fmtElapsed(snap.startedAt, isRunActive(snap.status) ? undefined : snap.endedAt)
  if (elapsed) bits.push(elapsed)
  statsRow.replaceChildren()
  bits.forEach((b, i) => {
    if (i) statsRow.append(el("span", "sep", "·"))
    statsRow.append(el("span", "stat", b))
  })
}

function latestLog(snap) {
  const logs = snap.logs || []
  return logs.length ? logs[logs.length - 1].message : null
}

function buildNarrator(snap) {
  const msg = latestLog(snap)
  const narr = el("div", "narrator")
  narr.dataset.role = "narrator"
  const prompt = el("span", "narrator-prompt", "❯")
  narr.append(prompt)
  narr.append(el("span", "narrator-msg", msg ? firstLine(msg) : "waiting for output…"))
  if (!msg) narr.classList.add("narrator-empty")
  return narr
}

function buildPhaseBox(phase) {
  const status = phaseStatus(phase.agents)
  const box = el("div", "phase")
  box.dataset.index = String(phase.index)

  const head = el("div", "phase-head")
  const glyph = el("span", `phase-glyph st-${status}`, glyphFor(status))
  if (status === "running") glyph.classList.add("spin")
  head.append(glyph)
  head.append(el("span", "phase-title", phase.title))
  const done = phase.agents.filter((a) => a.state === "done" || a.state === "skipped").length
  head.append(el("span", "phase-count", `${done}/${phase.agents.length}`))
  box.append(head)

  const tree = el("div", "phase-tree")
  phase.agents.forEach((a, i) => {
    const last = i === phase.agents.length - 1
    tree.append(buildAgentRow(a, last ? "└─" : "├─"))
  })
  box.append(tree)
  return box
}

// Patch an existing phase box's header + agent rows in place.
function patchPhaseBox(box, phase) {
  const status = phaseStatus(phase.agents)
  const glyph = box.querySelector(".phase-glyph")
  if (glyph) {
    glyph.textContent = glyphFor(status)
    glyph.className = `phase-glyph st-${status}`
    if (status === "running") glyph.classList.add("spin")
  }
  const title = box.querySelector(".phase-title")
  if (title) title.textContent = phase.title
  const count = box.querySelector(".phase-count")
  if (count) {
    const done = phase.agents.filter((a) => a.state === "done" || a.state === "skipped").length
    count.textContent = `${done}/${phase.agents.length}`
  }

  const tree = box.querySelector(".phase-tree")
  const existing = new Map()
  for (const row of tree.querySelectorAll(".agent")) existing.set(row.dataset.index, row)

  phase.agents.forEach((a, i) => {
    const connector = i === phase.agents.length - 1 ? "└─" : "├─"
    const key = String(a.index)
    let row = existing.get(key)
    if (row) {
      patchAgentRow(row, a)
      const conn = row.querySelector(".tree-connector")
      if (conn) conn.textContent = connector
      existing.delete(key)
    } else {
      row = buildAgentRow(a, connector)
    }
    // ensure correct order
    const target = tree.children[i]
    if (target !== row) tree.insertBefore(row, target || null)
  })
  // remove rows no longer present
  for (const row of existing.values()) row.remove()
}

// ---------------------------------------------------------------------------
// Full render vs. in-place patch
// ---------------------------------------------------------------------------

function renderSnapshotFull(snap) {
  snapshot = snap
  const frag = document.createDocumentFragment()
  frag.append(buildHeader(snap))
  frag.append(buildNarrator(snap))

  const phases = rebuildPhases(snap)
  const tree = el("div", "tree")
  tree.dataset.role = "tree"
  if (phases.length === 0) {
    tree.append(el("div", "placeholder", "No agents recorded yet."))
  }
  for (const p of phases) tree.append(buildPhaseBox(p))
  frag.append(tree)

  detailEl.replaceChildren(frag)
  detailEl.scrollTop = 0
  highlightActiveAgent()
  if (activeAgentIndex !== null) fillDrilldownHeader(activeAgentIndex)
}

// Reconcile the already-rendered detail with a new snapshot, without rebuilding
// the whole DOM. Falls back to a full render if structure changed drastically.
function patchSnapshot(snap) {
  snapshot = snap
  const treeContainer = detailEl.querySelector('[data-role="tree"]')
  if (!treeContainer) {
    renderSnapshotFull(snap)
    return
  }

  // header stats + status
  const agg = aggregate(snap.agents || [])
  const stateClass = runStateClass(snap.status)
  const hg = detailEl.querySelector(".run-header-glyph")
  if (hg) {
    hg.textContent = glyphFor(snap.status)
    hg.className = `run-header-glyph st-${stateClass}`
    if (stateClass === "running") hg.classList.add("spin")
  }
  const hs = detailEl.querySelector(".run-header-status")
  if (hs) {
    hs.textContent = isRunActive(snap.status) ? "running" : snap.status
    hs.className = `run-header-status st-${stateClass}`
  }
  const statsRow = detailEl.querySelector('[data-role="header-stats"]')
  if (statsRow) fillHeaderStats(statsRow, snap, agg)

  // run-level error appearing on completion
  if (snap.error && !isRunActive(snap.status)) {
    let errEl = detailEl.querySelector(".run-header .run-error")
    if (!errEl) {
      errEl = el("div", "run-error")
      detailEl.querySelector(".run-header").append(errEl)
    }
    errEl.textContent = firstLine(snap.error)
  }

  // narrator
  const narr = detailEl.querySelector('[data-role="narrator"]')
  if (narr) {
    const msg = latestLog(snap)
    const msgEl = narr.querySelector(".narrator-msg")
    if (msgEl) msgEl.textContent = msg ? firstLine(msg) : "waiting for output…"
    narr.classList.toggle("narrator-empty", !msg)
  }

  // phases
  const phases = rebuildPhases(snap)
  const placeholder = treeContainer.querySelector(".placeholder")
  if (placeholder && phases.length) placeholder.remove()

  const existing = new Map()
  for (const box of treeContainer.querySelectorAll(".phase")) existing.set(box.dataset.index, box)

  phases.forEach((p, i) => {
    const key = String(p.index)
    let box = existing.get(key)
    if (box) {
      patchPhaseBox(box, p)
      existing.delete(key)
    } else {
      box = buildPhaseBox(p)
    }
    const target = treeContainer.children[i]
    if (target !== box) treeContainer.insertBefore(box, target || null)
  })
  for (const box of existing.values()) box.remove()

  highlightActiveAgent()
  // Keep the open drilldown's header in step with the live run snapshot
  // (state running→done, tokens, duration, cost as they land).
  if (activeAgentIndex !== null) fillDrilldownHeader(activeAgentIndex)
}

// ---------------------------------------------------------------------------
// Live event folding (mirrors the server's foldSnapshot)
// ---------------------------------------------------------------------------

function applyEvent(snap, ev) {
  switch (ev.type) {
    case "run": {
      if (ev.status === "started") {
        snap.status = "started"
        if (snap.startedAt === undefined) snap.startedAt = ev.t
        if (ev.workflowFile) snap.workflowFile = ev.workflowFile
      } else {
        snap.status = ev.status
        snap.endedAt = ev.t
        if (ev.error) snap.error = ev.error
      }
      break
    }
    case "phase": {
      let p = snap.phases.find((x) => x.index === ev.index)
      if (p) p.title = ev.title
      else snap.phases.push({ index: ev.index, title: ev.title, agents: [] })
      break
    }
    case "agent": {
      const prev = snap.agents.find((x) => x.index === ev.index)
      const merged = {
        index: ev.index,
        phaseIndex: ev.phaseIndex ?? prev?.phaseIndex,
        phaseTitle: ev.phaseTitle ?? prev?.phaseTitle,
        label: ev.label ?? prev?.label ?? "",
        provider: ev.provider ?? prev?.provider,
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
      if (prev) Object.assign(prev, merged)
      else snap.agents.push(merged)
      break
    }
    case "log": {
      snap.logs.push({ t: ev.t, message: ev.message })
      break
    }
    default:
      break
  }
}

// ---------------------------------------------------------------------------
// Header elapsed clock (ticks for running runs)
// ---------------------------------------------------------------------------

function stopElapsedTimer() {
  if (elapsedTimer) {
    clearInterval(elapsedTimer)
    elapsedTimer = null
  }
}

function startElapsedTimer() {
  stopElapsedTimer()
  elapsedTimer = setInterval(() => {
    if (!snapshot || !isRunActive(snapshot.status)) {
      stopElapsedTimer()
      return
    }
    const statsRow = detailEl.querySelector('[data-role="header-stats"]')
    if (statsRow) fillHeaderStats(statsRow, snapshot, aggregate(snapshot.agents || []))
  }, 1000)
}

// ---------------------------------------------------------------------------
// Selection + streaming
// ---------------------------------------------------------------------------

function closeStream() {
  if (source) {
    source.close()
    source = null
  }
}

function setTopStatus(text, cls) {
  topStatusEl.className = `topstatus ${cls || ""}`.trim()
  topStatusEl.textContent = text
}

async function selectRun(runId) {
  activeRunId = runId
  highlightActive()
  closeStream()
  stopElapsedTimer()
  detailEl.replaceChildren(el("div", "placeholder", "Loading run…"))
  setTopStatus("connecting", "topstatus-idle")

  // The stream replays existing events first, so we build purely from the stream
  // and avoid double-counting against the snapshot endpoint.
  const fresh = { runId, status: "unknown", phases: [], agents: [], logs: [] }
  let firstFrame = true
  let pendingFrame = false

  const scheduleRender = () => {
    if (pendingFrame) return
    pendingFrame = true
    requestAnimationFrame(() => {
      pendingFrame = false
      if (activeRunId !== runId) return
      if (firstFrame) {
        firstFrame = false
        renderSnapshotFull(fresh)
        if (isRunActive(fresh.status)) startElapsedTimer()
      } else {
        patchSnapshot(fresh)
      }
    })
  }

  try {
    source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/stream`)
  } catch (err) {
    await loadSnapshotOnce(runId)
    return
  }

  source.onopen = () => {
    if (activeRunId === runId) setTopStatus("live", "topstatus-live")
  }

  source.onmessage = (msg) => {
    if (activeRunId !== runId) return
    let ev
    try {
      ev = JSON.parse(msg.data)
    } catch {
      return
    }
    applyEvent(fresh, ev)
    if (!isRunActive(fresh.status)) {
      setTopStatus(fresh.status, fresh.status === "completed" ? "topstatus-live" : "topstatus-closed")
    } else {
      setTopStatus("live", "topstatus-live")
    }
    scheduleRender()
  }

  source.onerror = () => {
    if (activeRunId !== runId) return
    // For finished runs the server closes the stream after replaying; that's fine.
    if (snapshot && !isRunActive(snapshot.status)) {
      setTopStatus(snapshot.status, snapshot.status === "completed" ? "topstatus-live" : "topstatus-closed")
      closeStream()
      return
    }
    setTopStatus("disconnected", "topstatus-closed")
    if (firstFrame) loadSnapshotOnce(runId)
  }
}

async function loadSnapshotOnce(runId) {
  try {
    const res = await fetch(`/api/runs/${encodeURIComponent(runId)}`)
    if (!res.ok) {
      detailEl.replaceChildren(el("div", "placeholder", `Run not available (${res.status}).`))
      return
    }
    const snap = await res.json()
    if (activeRunId === runId) {
      renderSnapshotFull(snap)
      setTopStatus(isRunActive(snap.status) ? "running" : snap.status, "topstatus-idle")
    }
  } catch (err) {
    detailEl.replaceChildren(el("div", "placeholder", "Failed to load run."))
  }
}

// ===========================================================================
// Agent drilldown — a live chat-feed view of one agent's conversation.
// ===========================================================================

// Find the open agent's snapshot (label/provider/model/state/tokens/duration)
// from the run snapshot we already track.
function agentSnapshot(index) {
  if (!snapshot || !Array.isArray(snapshot.agents)) return null
  return snapshot.agents.find((a) => a.index === index) || null
}

function highlightActiveAgent() {
  for (const row of detailEl.querySelectorAll(".agent")) {
    row.classList.toggle("agent-active", activeAgentIndex !== null && row.dataset.index === String(activeAgentIndex))
  }
}

function closeAgentStream() {
  if (agentSource) {
    agentSource.close()
    agentSource = null
  }
}

function closeDrilldown() {
  closeAgentStream()
  activeAgentIndex = null
  agentChunks = []
  agentFeedDirty = false
  drilldownEl.hidden = true
  drilldownEl.replaceChildren()
  scrimEl.hidden = true
  document.body.classList.remove("drilldown-open")
  highlightActiveAgent()
}

function navigateToRun() {
  // Drop the /agent/<i> suffix → back/forward friendly close.
  if (activeRunId) location.hash = `#/run/${encodeURIComponent(activeRunId)}`
}

async function openDrilldown(runId, index) {
  closeAgentStream()
  activeAgentIndex = index
  agentChunks = []
  agentFeedDirty = false

  drilldownEl.hidden = false
  scrimEl.hidden = false
  document.body.classList.add("drilldown-open")
  renderDrilldownShell(index)
  highlightActiveAgent()

  // If the agent is still running, subscribe to its live transcript stream;
  // otherwise a one-shot snapshot is enough (and avoids a dangling watcher).
  const snap = agentSnapshot(index)
  const live = !snap || snap.state === "running"
  if (live) {
    subscribeAgentStream(runId, index)
  } else {
    await loadAgentSnapshot(runId, index)
  }
}

// The drilldown chrome: a header (label / provider•model / state / stats) and
// an empty scrolling feed that chunks are appended into.
function renderDrilldownShell(index) {
  const panel = el("div", "dd-panel")

  const header = el("div", "dd-header")
  header.dataset.role = "dd-header"
  const top = el("div", "dd-header-top")
  const back = el("button", "dd-close")
  back.type = "button"
  back.title = "Close conversation"
  back.setAttribute("aria-label", "Close conversation")
  back.textContent = "✕"
  back.addEventListener("click", navigateToRun)
  top.append(el("div", "dd-title", `agent #${index}`))
  top.append(back)
  header.append(top)
  header.append(el("div", "dd-sub"))
  header.append(el("div", "dd-stats"))
  panel.append(header)

  const feed = el("div", "dd-feed")
  feed.dataset.role = "dd-feed"
  feed.append(el("div", "dd-loading", "Loading conversation…"))
  panel.append(feed)

  drilldownEl.replaceChildren(panel)
  fillDrilldownHeader(index)
}

// Header reflects the agent snapshot (which can update live as the run streams).
function fillDrilldownHeader(index) {
  const header = drilldownEl.querySelector('[data-role="dd-header"]')
  if (!header) return
  const snap = agentSnapshot(index)
  const meta = agentChunks.find((c) => c.kind === "meta")
  const statusChunk = lastStatus()

  // Resolve the agent's lifecycle state: prefer the run snapshot, fall back to
  // the transcript's own status chunks (e.g. when no run snapshot exists yet).
  let state = snap?.state
  if (!state && statusChunk) state = statusChunk.state === "done" ? "done" : statusChunk.state === "failed" ? "failed" : "running"
  if (!state) state = "running"

  const label = snap?.label || meta?.label || `agent #${index}`
  const provider = snap?.provider || meta?.provider
  const model = snap?.model || meta?.model

  const titleEl = header.querySelector(".dd-title")
  titleEl.replaceChildren()
  const glyph = el("span", `dd-state-glyph st-${state}`, glyphFor(state))
  if (state === "running") glyph.classList.add("spin")
  titleEl.append(glyph)
  titleEl.append(el("span", "dd-label", label))

  const sub = header.querySelector(".dd-sub")
  sub.replaceChildren()
  const dot = el("span", `prov-dot ${providerClass(provider)}`)
  sub.append(dot)
  const provBits = []
  if (provider) provBits.push(provider)
  if (model) provBits.push(model)
  sub.append(el("span", "dd-prov", provBits.join(" • ") || "agent"))
  const stateLabel = state === "running" ? "running" : state
  sub.append(el("span", `dd-state-badge st-${state}`, stateLabel))
  if (snap?.cached || (statusChunk && statusChunk.cached)) sub.append(el("span", "dd-cached", "cached"))

  const stats = header.querySelector(".dd-stats")
  stats.replaceChildren()
  const bits = []
  const tok = fmtTokens((snap?.inputTokens || 0) + (snap?.outputTokens || 0))
  if (tok && tok !== "0") bits.push(`${tok} tok`)
  const dur = fmtDuration(snap?.durationMs)
  if (dur) bits.push(dur)
  const cost = fmtCost(snap?.costUsd)
  if (cost) bits.push(cost)
  const toolCount = agentChunks.filter((c) => c.kind === "tool").length
  if (toolCount) bits.push(`${toolCount} tool${toolCount === 1 ? "" : "s"}`)
  bits.forEach((b, i) => {
    if (i) stats.append(el("span", "sep", "·"))
    stats.append(el("span", "stat", b))
  })
}

function lastStatus() {
  for (let i = agentChunks.length - 1; i >= 0; i--) {
    if (agentChunks[i].kind === "status") return agentChunks[i]
  }
  return null
}

async function loadAgentSnapshot(runId, index) {
  try {
    const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/agents/${index}`)
    if (activeAgentIndex !== index) return
    if (!res.ok) {
      showAgentFeedMessage(res.status === 404 ? "No transcript recorded for this agent." : `Transcript unavailable (${res.status}).`)
      return
    }
    const data = await res.json()
    if (activeAgentIndex !== index) return
    agentChunks = Array.isArray(data.chunks) ? data.chunks : []
    renderAgentFeedFull()
    fillDrilldownHeader(index)
  } catch {
    if (activeAgentIndex === index) showAgentFeedMessage("Failed to load transcript.")
  }
}

function subscribeAgentStream(runId, index) {
  let firstFrame = true
  let es
  try {
    es = new EventSource(`/api/runs/${encodeURIComponent(runId)}/agents/${index}/stream`)
  } catch {
    loadAgentSnapshot(runId, index)
    return
  }
  agentSource = es

  es.onmessage = (msg) => {
    if (activeAgentIndex !== index) return
    let chunk
    try {
      chunk = JSON.parse(msg.data)
    } catch {
      return
    }
    if (firstFrame) {
      firstFrame = false
      const feed = drilldownEl.querySelector('[data-role="dd-feed"]')
      const loading = feed && feed.querySelector(".dd-loading")
      if (loading) loading.remove()
    }
    agentChunks.push(chunk)
    appendChunkLive(chunk)
    // A terminal status means the agent finished while we watched — the server
    // keeps the stream open, but we no longer need live updates.
    if (chunk.kind === "status" && (chunk.state === "done" || chunk.state === "failed")) {
      fillDrilldownHeader(index)
    }
  }

  es.onerror = () => {
    if (activeAgentIndex !== index) return
    // Finished agents: server may close after replay. Fall back to a snapshot
    // only if we never received anything.
    if (firstFrame) {
      closeAgentStream()
      loadAgentSnapshot(runId, index)
    }
  }
}

function showAgentFeedMessage(text) {
  const feed = drilldownEl.querySelector('[data-role="dd-feed"]')
  if (feed) feed.replaceChildren(el("div", "dd-loading", text))
}

// ---------------------------------------------------------------------------
// Feed rendering
//
// The feed is a sequence of "blocks". Consecutive `text` chunks fold into one
// assistant bubble; consecutive `reasoning` chunks fold into one thinking
// block; a `tool` makes a card that its later `tool-result` (matched by id)
// fills in. We keep a small amount of append state on the feed element so live
// streaming can mutate the last open block in place instead of re-rendering.
// ---------------------------------------------------------------------------

function ddFeed() {
  return drilldownEl.querySelector('[data-role="dd-feed"]')
}

// Sticky-bottom: only autoscroll if the user is already near the bottom.
function feedNearBottom(feed) {
  return feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80
}
function feedAutoscroll(feed, wasNear) {
  if (wasNear) feed.scrollTop = feed.scrollHeight
}

// Full (re)render from agentChunks — used for snapshots / when not streaming.
function renderAgentFeedFull() {
  const feed = ddFeed()
  if (!feed) return
  feed.replaceChildren()
  // Reset per-feed append state.
  feed._openText = null
  feed._openReasoning = null
  feed._toolCards = new Map()
  for (const chunk of agentChunks) renderChunkInto(feed, chunk)
  feed.scrollTop = feed.scrollHeight
}

// Append a single live chunk, preserving sticky-bottom.
function appendChunkLive(chunk) {
  const feed = ddFeed()
  if (!feed) return
  if (!feed._toolCards) feed._toolCards = new Map()
  const wasNear = feedNearBottom(feed)
  renderChunkInto(feed, chunk)
  feedAutoscroll(feed, wasNear)
}

// Render/merge one chunk into the feed, mutating open blocks where possible.
function renderChunkInto(feed, chunk) {
  switch (chunk.kind) {
    case "meta": {
      feed._openText = null
      feed._openReasoning = null
      if (chunk.prompt && chunk.prompt.trim()) {
        feed.append(buildPromptBlock(chunk.prompt))
      }
      break
    }
    case "text": {
      if (!chunk.text) break
      feed._openReasoning = null
      if (!feed._openText) {
        feed._openText = buildAssistantBlock()
        feed.append(feed._openText.el)
      }
      feed._openText.append(chunk.text)
      break
    }
    case "reasoning": {
      if (!chunk.text) break
      feed._openText = null
      if (!feed._openReasoning) {
        feed._openReasoning = buildReasoningBlock()
        feed.append(feed._openReasoning.el)
      }
      feed._openReasoning.append(chunk.text)
      break
    }
    case "tool": {
      feed._openText = null
      feed._openReasoning = null
      const card = buildToolCard(chunk)
      feed.append(card.el)
      if (chunk.id) feed._toolCards.set(chunk.id, card)
      break
    }
    case "tool-result": {
      const card = chunk.id ? feed._toolCards.get(chunk.id) : null
      if (card) {
        card.setResult(chunk)
      } else {
        // Orphan result (no matching id) — show as a standalone output block.
        feed._openText = null
        feed._openReasoning = null
        feed.append(buildOrphanResult(chunk))
      }
      break
    }
    case "status": {
      feed._openText = null
      feed._openReasoning = null
      updateStatusBlock(feed, chunk)
      break
    }
    default:
      break
  }
}

// Leading user/instruction bubble (the agent's prompt).
function buildPromptBlock(prompt) {
  const wrap = el("div", "msg msg-user")
  const role = el("div", "msg-role", "Instruction")
  wrap.append(role)
  const bubble = el("div", "msg-user-bubble")
  bubble.append(buildProse(prompt))
  wrap.append(bubble)
  return wrap
}

// Assistant text bubble. Returns a handle that concatenates streamed text and
// re-renders its (markdown-ish) body. Text arrives in many tiny chunks.
function buildAssistantBlock() {
  const wrap = el("div", "msg msg-assistant")
  const body = el("div", "msg-assistant-body")
  wrap.append(body)
  let raw = ""
  let pending = false
  const flush = () => {
    pending = false
    body.replaceChildren(buildProse(raw))
  }
  return {
    el: wrap,
    append(text) {
      raw += text
      // Coalesce many tiny text chunks into one render per frame to avoid
      // re-parsing markdown on every byte.
      if (!pending) {
        pending = true
        requestAnimationFrame(() => {
          if (pending) flush()
        })
      }
    },
  }
}

// Collapsible "Thinking" section (dimmed + italic). Open while streaming so the
// reasoning is visible live; the user can collapse it.
function buildReasoningBlock() {
  const wrap = el("div", "msg msg-reasoning")
  const head = el("button", "reasoning-head")
  head.type = "button"
  const chev = el("span", "chev", "▾")
  head.append(chev)
  head.append(el("span", "reasoning-head-label", "Thinking"))
  const bodyWrap = el("div", "reasoning-body")
  const body = el("div", "reasoning-text")
  bodyWrap.append(body)
  wrap.append(head)
  wrap.append(bodyWrap)
  let expanded = true
  wrap.classList.add("expanded")
  head.addEventListener("click", () => {
    expanded = !expanded
    wrap.classList.toggle("expanded", expanded)
    chev.textContent = expanded ? "▾" : "▸"
  })
  let raw = ""
  return {
    el: wrap,
    append(text) {
      raw += text
      body.textContent = raw
    },
  }
}

// A tool/command call card paired with its (later) result block.
function buildToolCard(chunk) {
  const wrap = el("div", "tool-card")
  const head = el("div", "tool-card-head")

  const { command, header, argsText } = describeTool(chunk)
  if (command) {
    const prompt = el("span", "tool-dollar", "$")
    head.append(prompt)
    head.append(el("span", "tool-cmd", command))
    wrap.append(head)
  } else {
    head.append(el("span", "tool-name", header))
    wrap.append(head)
    if (argsText) {
      const args = buildClampedText(argsText, "tool-args")
      wrap.append(args)
    }
  }

  const resultSlot = el("div", "tool-result-slot")
  wrap.append(resultSlot)

  // Until the result lands, show a running shimmer line.
  const pending = el("div", "tool-pending")
  pending.append(el("span", "tool-pending-text", "running"))
  resultSlot.append(pending)

  return {
    el: wrap,
    setResult(result) {
      resultSlot.replaceChildren()
      const out = (result.output ?? "").toString()
      if (result.isError) wrap.classList.add("tool-error")
      const block = buildTerminalOutput(out, result.isError)
      resultSlot.append(block)
    },
  }
}

// Result with no matching tool id.
function buildOrphanResult(chunk) {
  const wrap = el("div", "tool-card")
  if (chunk.name) {
    const head = el("div", "tool-card-head")
    head.append(el("span", "tool-name", chunk.name))
    wrap.append(head)
  }
  const out = (chunk.output ?? "").toString()
  if (chunk.isError) wrap.classList.add("tool-error")
  wrap.append(buildTerminalOutput(out, chunk.isError))
  return wrap
}

// Terminal-style output block (mono, subtle bg, red text on error).
function buildTerminalOutput(text, isError) {
  const block = el("div", `terminal-output${isError ? " is-error" : ""}`)
  if (!text.trim()) {
    block.append(el("span", "terminal-empty", isError ? "(error — no output)" : "(no output)"))
    return block
  }
  const pre = el("pre", "terminal-pre")
  // Clamp very long output to keep the feed responsive; expandable.
  const LIMIT = 4000
  if (text.length > LIMIT) {
    pre.textContent = text.slice(0, LIMIT)
    block.append(pre)
    const more = el("button", "show-more")
    more.type = "button"
    more.textContent = `Show ${(text.length - LIMIT).toLocaleString()} more chars`
    more.addEventListener("click", () => {
      pre.textContent = text
      more.remove()
    })
    block.append(more)
  } else {
    pre.textContent = text
    block.append(pre)
  }
  return block
}

// Describe a tool chunk → { command?, header, argsText } per the task's rules:
//  - codex `command` tools (or string input) → `$ <command>`
//  - object input with a `command` field (e.g. Bash) → `$ <command>`
//  - everything else → `name` header + collapsed args
function describeTool(chunk) {
  const name = chunk.name || "tool"
  const input = chunk.input
  if (name === "command" || typeof input === "string") {
    return { command: typeof input === "string" ? input : stringifyArgs(input), header: name }
  }
  if (input && typeof input === "object" && typeof input.command === "string") {
    return { command: input.command, header: name }
  }
  return { command: null, header: name, argsText: stringifyArgs(input) }
}

function stringifyArgs(input) {
  if (input === undefined || input === null) return ""
  if (typeof input === "string") return input
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return String(input)
  }
}

// A text block clamped to ~3 lines with a "Show more" toggle.
function buildClampedText(text, className) {
  const wrap = el("div", className)
  const pre = el("pre", "clamp-pre clamped")
  pre.textContent = text
  wrap.append(pre)
  // Defer overflow check to layout.
  requestAnimationFrame(() => {
    if (pre.scrollHeight > pre.clientHeight + 2) {
      const toggle = el("button", "show-more")
      toggle.type = "button"
      toggle.textContent = "Show more"
      let expanded = false
      toggle.addEventListener("click", () => {
        expanded = !expanded
        pre.classList.toggle("clamped", !expanded)
        toggle.textContent = expanded ? "Show less" : "Show more"
      })
      wrap.append(toggle)
    }
  })
  return wrap
}

// In-flight / terminal status indicator at the tail of the feed.
function updateStatusBlock(feed, chunk) {
  let block = feed.querySelector(".dd-status")
  if (chunk.state === "running") {
    if (!block) {
      block = el("div", "dd-status")
      block.append(el("span", "dd-status-shimmer", "Working…"))
      feed.append(block)
    } else {
      // keep it at the bottom
      feed.append(block)
    }
    return
  }
  // done / failed — remove the working indicator; surface errors.
  if (block) block.remove()
  if (chunk.state === "failed" && chunk.error) {
    feed.append(el("div", "dd-fail", firstLine(chunk.error)))
  }
}

// ---------------------------------------------------------------------------
// Light markdown-ish prose rendering (no external libs).
//
// Handles: fenced ``` code blocks (mono), `inline code`, and otherwise
// whitespace-preserving prose. Deliberately small — readable, not a parser.
// ---------------------------------------------------------------------------

function buildProse(text) {
  const frag = document.createDocumentFragment()
  const raw = String(text)

  // A pure JSON-ish answer (codex structured output) reads far better as a
  // code block than as a paragraph of escaped braces.
  const trimmed = raw.trim()
  if (trimmed.length > 1 && (trimmed[0] === "{" || trimmed[0] === "[")) {
    let pretty = trimmed
    try {
      pretty = JSON.stringify(JSON.parse(trimmed), null, 2)
    } catch {
      // streaming / partial JSON — show as-is
    }
    const pre = el("pre", "prose-code")
    pre.textContent = pretty
    frag.append(pre)
    return frag
  }

  const parts = raw.split(/```/)
  parts.forEach((part, i) => {
    const isCode = i % 2 === 1
    if (isCode) {
      // Drop an optional language line.
      let code = part
      const nl = code.indexOf("\n")
      if (nl !== -1) {
        const first = code.slice(0, nl).trim()
        if (first && !/\s/.test(first) && first.length < 20) code = code.slice(nl + 1)
      }
      const pre = el("pre", "prose-code")
      pre.textContent = code.replace(/\n$/, "")
      frag.append(pre)
    } else if (part) {
      const block = el("div", "prose")
      renderBlockMarkdown(block, part)
      frag.append(block)
    }
  })
  if (!frag.childNodes.length) frag.append(el("div", "prose", ""))
  return frag
}

// Render lightweight block markdown: ATX headings (#…) become bold lines and
// `- `/`* ` bullets get a • glyph; everything else keeps its whitespace. Inline
// `code`, **bold**, and *italic* are handled by renderInline.
function renderBlockMarkdown(container, text) {
  const lines = String(text).split("\n")
  lines.forEach((line, i) => {
    if (i) container.append(document.createTextNode("\n"))
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const h = el("span", "prose-heading")
      renderInline(h, heading[2])
      container.append(h)
      return
    }
    const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line)
    if (bullet) {
      container.append(document.createTextNode(bullet[1] + "• "))
      renderInline(container, bullet[2])
      return
    }
    renderInline(container, line)
  })
}

// Inline rendering: `code` spans, **bold**, *italic*, plain text.
function renderInline(container, text) {
  // Split on inline tokens while keeping the delimiters.
  const segs = String(text).split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*)/)
  for (const seg of segs) {
    if (!seg) continue
    if (seg.length > 1 && seg.startsWith("`") && seg.endsWith("`")) {
      container.append(el("code", "prose-inline-code", seg.slice(1, -1)))
    } else if (seg.length > 4 && seg.startsWith("**") && seg.endsWith("**")) {
      container.append(el("strong", "prose-bold", seg.slice(2, -2)))
    } else if (seg.length > 2 && seg.startsWith("*") && seg.endsWith("*")) {
      container.append(el("em", "prose-em", seg.slice(1, -1)))
    } else {
      container.append(document.createTextNode(seg))
    }
  }
}

// ---------------------------------------------------------------------------
// Hash routing
// ---------------------------------------------------------------------------

// #/run/<id>                  → run view
// #/run/<id>/agent/<index>    → run view + agent drilldown
function parseHash() {
  const agentM = /^#\/run\/(.+)\/agent\/(\d+)$/.exec(location.hash)
  if (agentM) return { runId: decodeURIComponent(agentM[1]), agentIndex: Number(agentM[2]) }
  const m = /^#\/run\/(.+)$/.exec(location.hash)
  if (m) return { runId: decodeURIComponent(m[1]), agentIndex: null }
  return { runId: null, agentIndex: null }
}

function handleRoute() {
  const { runId, agentIndex } = parseHash()
  if (!runId) {
    activeRunId = null
    highlightActive()
    closeStream()
    stopElapsedTimer()
    closeDrilldown()
    snapshot = null
    setTopStatus("", "")
    detailEl.replaceChildren(buildEmptyDetail())
    return
  }
  if (runId !== activeRunId || !source) selectRun(runId)

  // Drilldown follows the route. Opening/closing is idempotent per index.
  if (agentIndex === null) {
    closeDrilldown()
  } else if (agentIndex !== activeAgentIndex) {
    openDrilldown(runId, agentIndex)
  }
  highlightActiveAgent()
}

function buildEmptyDetail() {
  const ph = el("div", "placeholder")
  ph.append(el("div", "placeholder-star", "✦"))
  ph.append(el("div", null, "Select a run to view its phase tree."))
  return ph
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

window.addEventListener("hashchange", handleRoute)
window.addEventListener("beforeunload", () => {
  closeStream()
  closeAgentStream()
  stopElapsedTimer()
})

// Open an agent's conversation when its row (or chevron) is clicked.
detailEl.addEventListener("click", (e) => {
  const row = e.target.closest(".agent")
  if (!row || !activeRunId) return
  const index = row.dataset.index
  if (index === undefined) return
  location.hash = `#/run/${encodeURIComponent(activeRunId)}/agent/${index}`
})
detailEl.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return
  const row = e.target.closest(".agent")
  if (!row || !activeRunId) return
  e.preventDefault()
  location.hash = `#/run/${encodeURIComponent(activeRunId)}/agent/${row.dataset.index}`
})

// Scrim (narrow-screen overlay) + Escape close the drilldown.
scrimEl.addEventListener("click", navigateToRun)
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && activeAgentIndex !== null) navigateToRun()
})

loadRuns().then(handleRoute)
// Light polling of the run list so new runs appear without a manual refresh.
setInterval(loadRuns, 5000)
