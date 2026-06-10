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
  if (state === "stale") {
    // Deadman switch: the run's process died without finishing — not a live spinner.
    return <Icon name="AlertCircle" className={cn("size-3.5 text-muted-foreground", className)} aria-label="stale (run died)" />
  }
  if (state === "skipped") return null
  if (state === "unknown") {
    // A run dir with no terminal/started event yet — neutral, not a green "done" check (L26).
    return <Icon name="Info" className={cn("size-3.5 text-muted-foreground/50", className)} aria-label="unknown" />
  }
  if (state === "done" || state === "completed") {
    if (quiet) return null
    return <Icon name="CircleCheck" className={cn("size-3.5 text-success", className)} aria-label="done" />
  }
  // Exhaustiveness guard: any new status renders neutral instead of a misleading done-check (L26).
  return <Icon name="Info" className={cn("size-3.5 text-muted-foreground/50", className)} aria-label="unknown" />
}

/** Neutral monogram badge for providers without a bundled brand icon. */
function MonogramBadge({ label, className }: { label: string; className?: string }) {
  return (
    <span
      className={cn(
        "flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border border-muted-foreground/40 font-mono text-[8px] leading-none text-muted-foreground",
        className,
      )}
      aria-hidden
    >
      {label}
    </span>
  )
}

/** Provider mark: brand icons for codex/claude-code, monogram badges for opencode/pi.
 *  Unknown provider ids render a neutral badge — never someone else's brand. */
export function ProviderIcon({ provider, className }: { provider: ProviderId; className?: string }) {
  if (provider === "claude-code") return <ClaudeIcon className={cn("size-3.5 shrink-0 text-muted-foreground", className)} />
  if (provider === "codex") return <OpenAiIcon className={cn("size-3.5 shrink-0 text-muted-foreground", className)} />
  if (provider === "opencode") return <MonogramBadge label="OC" className={className} />
  if (provider === "pi") return <MonogramBadge label="π" className={className} />
  return <MonogramBadge label="·" className={className} />
}

/** Shimmering in-progress text (bb's animate-shine). */
export function Working({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("animate-shine font-mono text-xs", className)}>{children}</span>
}
