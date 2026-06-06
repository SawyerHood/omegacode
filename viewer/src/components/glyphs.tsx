import type { ReactNode } from "react"

import { ClaudeIcon } from "@/components/icons/ClaudeIcon"
import { OpenAiIcon } from "@/components/icons/OpenAiIcon"
import { Icon } from "@/components/ui/icon"
import type { AgentState, ProviderId, RunStatus } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * Status glyph: spinning dashed circle for in-progress (bb's sidebar idiom), red X for failed,
 * dim dashed circle for queued, green check for done. Pass `quiet` to suppress the done check
 * (used by the run list, where a check per row would be a sea — phases collapse, so they show it).
 */
export function StatusGlyph({ state, className, quiet }: { state: AgentState | RunStatus; className?: string; quiet?: boolean }) {
  if (state === "running" || state === "started") {
    return <Icon name="Spinner" className={cn("size-3.5 animate-spin text-muted-foreground", className)} aria-label="in progress" />
  }
  if (state === "failed" || state === "interrupted") {
    return <Icon name="CircleX" className={cn("size-3.5 text-destructive", className)} aria-label="failed" />
  }
  if (state === "queued") {
    return <Icon name="Spinner" className={cn("size-3.5 text-muted-foreground/35", className)} aria-label="queued" />
  }
  if (state === "skipped") return null
  // done / completed
  if (quiet) return null
  return <Icon name="CircleCheck" className={cn("size-3.5 text-success", className)} aria-label="done" />
}

/** Provider brand mark (OpenAI for codex, Anthropic/Claude for claude-code). */
export function ProviderIcon({ provider, className }: { provider: ProviderId; className?: string }) {
  const Brand = provider === "claude-code" ? ClaudeIcon : OpenAiIcon
  return <Brand className={cn("size-3.5 shrink-0 text-muted-foreground", className)} />
}

/** Shimmering in-progress text (bb's animate-shine). */
export function Working({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("animate-shine font-mono text-xs", className)}>{children}</span>
}
