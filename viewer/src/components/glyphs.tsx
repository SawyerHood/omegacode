import type { ReactNode } from "react"

import { ClaudeIcon } from "@/components/icons/ClaudeIcon"
import { OpenAiIcon } from "@/components/icons/OpenAiIcon"
import { Icon } from "@/components/ui/icon"
import type { AgentState, ProviderId, RunStatus } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * Status glyph — quiet by design: success shows NOTHING (returns null), only states that
 * need attention render. Running = spinning dashed circle (bb's sidebar idiom), failed = red
 * X, queued = a dim static dashed circle.
 */
export function StatusGlyph({ state, className }: { state: AgentState | RunStatus; className?: string }) {
  if (state === "running" || state === "started") {
    return <Icon name="Spinner" className={cn("size-3.5 animate-spin text-muted-foreground", className)} aria-label="in progress" />
  }
  if (state === "failed" || state === "interrupted") {
    return <Icon name="CircleX" className={cn("size-3.5 text-destructive", className)} aria-label="failed" />
  }
  if (state === "queued") {
    return <Icon name="Spinner" className={cn("size-3.5 text-muted-foreground/35", className)} aria-label="queued" />
  }
  // done / completed / skipped — success is silent.
  return null
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
