import { useEffect, useMemo, useRef } from "react"
import { useNavigate, useParams } from "react-router-dom"

import { ProviderIcon, StatusGlyph } from "@/components/glyphs"
import { ConversationMessageContent } from "@/components/timeline/ConversationMessageContent"
import { ThreadTimelineFeed } from "@/components/timeline/ThreadTimelineFeed"
import { useAgentStream } from "@/lib/hooks"
import { fmtCost, fmtDuration, fmtTokens } from "@/lib/format"
import { toThreadFeed } from "@/lib/to-thread-events"
import type { AgentSnapshot } from "@/lib/types"

export function AgentChat({ agent }: { agent?: AgentSnapshot }) {
  const { id, index } = useParams<{ id: string; index: string }>()
  const navigate = useNavigate()
  const idx = index != null ? Number(index) : null
  const { chunks, live } = useAgentStream(id ?? null, idx)
  const { meta, items, status, error } = useMemo(() => toThreadFeed(chunks), [chunks])

  const bottomRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (live) bottomRef.current?.scrollIntoView({ block: "end" })
  }, [chunks.length, live])

  const provider = agent?.provider ?? meta?.provider ?? "codex"
  const label = agent?.label ?? meta?.label ?? `agent ${idx ?? ""}`
  const model = agent?.model ?? meta?.model
  const state = agent?.state ?? (status === "done" ? "done" : status === "failed" ? "failed" : "running")
  const stats = [
    agent?.outputTokens ? `${fmtTokens((agent.inputTokens ?? 0) + agent.outputTokens)} tok` : null,
    fmtDuration(agent?.durationMs),
    fmtCost(agent?.costUsd),
  ].filter(Boolean)

  // Working indicator: show while live and not yet terminal. "Thinking" when the
  // last activity was reasoning, "Working" otherwise — matching bb.
  const showWorking = live && status !== "done" && status !== "failed"
  const workingIsThinking = items.length > 0 && items[items.length - 1]?.type === "reasoning"

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{label}</span>
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <ProviderIcon provider={provider} />
          {provider}
          {model && <span className="text-subtle-foreground">· {model}</span>}
        </span>
        {stats.length > 0 && <span className="shrink-0 font-mono text-[11px] text-subtle-foreground">{stats.join(" · ")}</span>}
        <StatusGlyph state={state} className="shrink-0" />
        <button
          onClick={() => navigate(`/run/${id}`)}
          className="ml-2 shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground"
          aria-label="Close"
        >
          ✕
        </button>
      </header>

      <div className="scroll-bottom-anchor-content min-h-0 flex-1 overflow-auto px-4 py-3">
        {meta?.prompt ? (
          <div className="mb-4">
            <ConversationMessageContent role="user" text={meta.prompt} />
          </div>
        ) : null}

        <ThreadTimelineFeed
          items={items}
          streaming={live}
          showWorking={showWorking}
          workingIsThinking={workingIsThinking}
        />

        {state === "failed" && error ? (
          <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        ) : null}

        <div ref={bottomRef} className="scroll-bottom-anchor" />
      </div>
    </div>
  )
}
