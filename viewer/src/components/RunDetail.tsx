import { useEffect, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"

import { ProviderIcon, StatusGlyph } from "@/components/glyphs"
import { fmtClock, fmtCost, fmtDuration, fmtTokens } from "@/lib/format"
import { type AgentSnapshot, type AgentState, isTerminalAgent, type PhaseSnapshot, type RunSnapshot } from "@/lib/types"
import { cn } from "@/lib/utils"

/** Re-render every second while `active`, for live elapsed clocks. */
function useTick(active: boolean): number {
  const [, setN] = useState(0)
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setN((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [active])
  return Date.now()
}

function rollup(agents: AgentSnapshot[]): AgentState {
  if (agents.some((a) => a.state === "running")) return "running"
  if (agents.some((a) => a.state === "failed")) return "failed"
  if (agents.length > 0 && agents.every((a) => isTerminalAgent(a.state))) return "done"
  return "queued"
}

function AgentRow({ agent, active, onClick }: { agent: AgentSnapshot; active: boolean; onClick: () => void }) {
  const meta = [
    agent.model,
    agent.outputTokens ? `${fmtTokens((agent.inputTokens ?? 0) + agent.outputTokens)} tok` : null,
    agent.lastTool,
    fmtDuration(agent.durationMs),
    fmtCost(agent.costUsd),
  ].filter(Boolean)

  return (
    <button
      onClick={onClick}
      className={cn(
        "group flex w-full items-start gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-state-hover",
        active && "bg-surface-selected",
      )}
    >
      <StatusGlyph state={agent.state} className="mt-0.5 size-3.5" />
      <ProviderIcon provider={agent.provider} className="mt-0.5" />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5">
          <span className="truncate text-sm">{agent.label || `agent ${agent.index}`}</span>
          {agent.cached && <span className="shrink-0 text-[11px] text-subtle-foreground italic">(cached)</span>}
        </span>
        {meta.length > 0 && <span className="block truncate font-mono text-[11px] text-subtle-foreground">{meta.join(" · ")}</span>}
        {agent.state === "failed" && agent.error && (
          <span className="mt-0.5 block font-mono text-[11px] break-words text-destructive">└ {agent.error}</span>
        )}
      </span>
      <span className="mt-0.5 shrink-0 text-xs text-transparent group-hover:text-muted-foreground">›</span>
    </button>
  )
}

function PhaseGroup({
  phase,
  activeIndex,
  onPick,
}: {
  phase: PhaseSnapshot
  activeIndex: number | null
  onPick: (i: number) => void
}) {
  const done = phase.agents.filter((a) => isTerminalAgent(a.state)).length
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card/40">
      <div className="flex items-center gap-2 border-b border-border/60 bg-surface-raised px-3 py-1.5">
        <StatusGlyph state={rollup(phase.agents)} className="text-xs" />
        <span className="text-sm font-semibold">{phase.title}</span>
        <span className="ml-auto font-mono text-[11px] text-subtle-foreground">
          {done}/{phase.agents.length}
        </span>
      </div>
      <div className="flex flex-col gap-0.5 p-1.5">
        {phase.agents.map((a) => (
          <AgentRow key={a.index} agent={a} active={a.index === activeIndex} onClick={() => onPick(a.index)} />
        ))}
      </div>
    </div>
  )
}

export function RunDetail({ snap }: { snap: RunSnapshot | null }) {
  const { id, index } = useParams<{ id: string; index?: string }>()
  const navigate = useNavigate()
  const activeIndex = index != null ? Number(index) : null
  const live = snap ? snap.status === "started" : false
  const now = useTick(live)

  if (!snap) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading run…</div>
  }

  const total = snap.agents.length
  const done = snap.agents.filter((a) => isTerminalAgent(a.state)).length
  const tokens = snap.agents.reduce((s, a) => s + (a.outputTokens ?? 0) + (a.inputTokens ?? 0), 0)
  const cost = snap.agents.reduce((s, a) => s + (a.costUsd ?? 0), 0)
  const elapsed = snap.startedAt ? (snap.endedAt ?? now) - snap.startedAt : undefined
  const lastLog = snap.logs.at(-1)
  const ungrouped = snap.agents.filter((a) => a.phaseIndex === undefined)

  const stats = [
    `${done}/${total} agents`,
    tokens ? `${fmtTokens(tokens)} tok` : null,
    cost ? fmtCost(cost) : null,
    elapsed ? fmtClock(elapsed) : null,
  ].filter(Boolean)

  const pick = (i: number) => navigate(`/run/${id}/agent/${i}`)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2">
          <StatusGlyph state={snap.status} className="text-sm" />
          <span className="truncate font-mono text-sm font-semibold">{snap.name ?? snap.runId}</span>
          <span
            className={cn(
              "rounded px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase",
              snap.status === "completed" && "bg-success/15 text-success",
              snap.status === "started" && "bg-primary/15 text-primary",
              (snap.status === "failed" || snap.status === "interrupted") && "bg-destructive/15 text-destructive",
              snap.status === "unknown" && "bg-muted text-muted-foreground",
            )}
          >
            {snap.status}
          </span>
          <span className="ml-auto shrink-0 font-mono text-[11px] text-subtle-foreground">{stats.join(" · ")}</span>
        </div>
        {lastLog && <div className="mt-1.5 truncate font-mono text-[11px] text-muted-foreground">❯ {lastLog.message}</div>}
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
        {snap.phases.map((p) => (
          <PhaseGroup key={p.index} phase={p} activeIndex={activeIndex} onPick={pick} />
        ))}
        {ungrouped.length > 0 && (
          <div className="flex flex-col gap-0.5 rounded-lg border border-border bg-card/40 p-1.5">
            {ungrouped.map((a) => (
              <AgentRow key={a.index} agent={a} active={a.index === activeIndex} onClick={() => pick(a.index)} />
            ))}
          </div>
        )}
        {total === 0 && <div className="px-2 py-6 text-center text-sm text-muted-foreground">No agents yet.</div>}
      </div>
    </div>
  )
}
