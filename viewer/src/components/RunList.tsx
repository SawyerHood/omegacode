import { NavLink } from "react-router-dom"

import { StatusGlyph } from "@/components/glyphs"
import { OmegaIcon } from "@/components/icons/OmegaIcon"
import { timeAgo } from "@/lib/format"
import { useRuns } from "@/lib/hooks"
import { cn } from "@/lib/utils"

export function RunList() {
  const { data: runs = [], isError } = useRuns()
  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <OmegaIcon className="size-5 shrink-0 text-foreground" />
        <span className="text-sm font-semibold tracking-tight">omegacode</span>
      </div>
      <div className="flex items-center justify-between px-3 pt-3 pb-1 text-[11px] tracking-wide text-subtle-foreground uppercase">
        <span>Runs</span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-normal">{runs.length}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-1.5 pb-2">
        {isError && <div className="px-2 py-1 text-xs text-destructive">API unreachable — is the server running?</div>}
        {runs.map((r) => (
          <NavLink
            key={r.runId}
            to={`/run/${r.runId}`}
            className={({ isActive }) =>
              cn(
                "flex flex-col gap-0.5 rounded-md px-2 py-1.5 transition-colors hover:bg-state-hover",
                isActive && "bg-surface-selected",
              )
            }
          >
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-medium">{r.name ?? r.runId}</span>
              <StatusGlyph state={r.status} quiet className="ml-auto shrink-0" />
            </div>
            <div className="font-mono text-[11px] text-subtle-foreground">
              {r.agents} {r.agents === 1 ? "agent" : "agents"} · {timeAgo(r.startedAt) || "—"}
            </div>
          </NavLink>
        ))}
      </div>
    </div>
  )
}
