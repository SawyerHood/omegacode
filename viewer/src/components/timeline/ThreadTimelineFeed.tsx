// Driver that renders a `ThreadEventItem[]` through bb's leaf timeline
// components, replicating bb's thread-timeline step grouping + collapse.
//
// bb (packages/thread-view/src/timeline-view.ts → buildTimelineViewRows) walks
// its rows and groups consecutive summarizable *work* (commands / tools /
// file-changes) into "steps", split by assistant-message / reasoning
// boundaries. A step that's closed (an assistant message follows it, or the run
// has finished past it) collapses into a one-line **step-summary** ("Ran 3
// commands · Read 5 files · Edited 2 files") that expands to the individual
// rows; the trailing step of a live run — or any step still holding a pending
// row — stays expanded so the active frontier is visible. A step with a single
// work row stays bare (bb only summarizes multi-row bundles).
//
// This file mirrors that algorithm against the viewer's trimmed item model.
// The per-item leaf rendering (TerminalOutputBlock, ToolCallDetailBlock,
// TimelineFileDiffBlock, ConversationMessageContent, ExpandableTimelineRow) is
// bb's ported components; the label/verb/count logic lives in
// lib/thread-view/work-summary.ts (a port of bb's summarizeTimelineWork +
// timeline-row-title verbs).
import { Fragment, useCallback, useMemo, useState, type ReactNode } from "react"
import type { ThreadEventItem } from "@/lib/thread-events"
import {
  getFileChangeAction,
  getFileChangeActionPastTense,
  getFileChangeDiffStats,
  fileNameFromPath,
} from "@/lib/thread-view/file-change-summary"
import { buildWorkSummaryLabel } from "@/lib/thread-view/work-summary"
import { cn } from "@/lib/utils"
import { AutoHeightContainer } from "@/components/ui/height-transition"
import { DiffStatsTally } from "@/components/ui/diff-stats-tally"
import { Icon, type IconName } from "@/components/ui/icon"
import { ConversationMessageContent } from "./ConversationMessageContent"
import { ExpandableTimelineRow } from "./ExpandableTimelineRow"
import { ExpandablePanel } from "@/components/ui/disclosure"
import { TerminalOutputBlock } from "./TerminalOutputBlock"
import { ToolCallDetailBlock } from "./ToolCallDetailBlock"
import { TimelineFileDiffBlock } from "./TimelineFileDiffBlock"
import { TimelineWorkingIndicator } from "./TimelineWorkingIndicator"

const NESTED_ROWS_GROUP_LINE_CLASS = "relative my-0"

// bb's left guide/indent for nested grouped rows (ThreadTimelineRows.tsx
// NESTED_ROWS_GROUP_LINE_CLASS): a hairline rule down the left edge.
const STEP_CHILDREN_GUIDE_CLASS =
  "relative pl-3 pr-2 before:pointer-events-none before:absolute before:bottom-1 before:left-1.5 before:top-0 before:w-px before:bg-border-hairline before:content-['']"

export interface ThreadTimelineFeedProps {
  items: ThreadEventItem[]
  /** Live runs auto-expand the active (last) row and stream its output. */
  streaming?: boolean
  workspaceRootPath?: string
  /** Shown as the trailing working indicator while the run is in progress. */
  workingLabel?: string
  showWorking?: boolean
  workingIsThinking?: boolean
}

interface RowTitleProps {
  icon?: IconName
  verb?: string
  text: ReactNode
  trailing?: ReactNode
  mono?: boolean
}

function RowTitle({ icon, verb, text, trailing, mono }: RowTitleProps) {
  return (
    <span className={cn("inline-flex min-w-0 max-w-full items-center gap-1.5", mono && "font-mono text-xs")}>
      {icon ? <Icon name={icon} className="size-3.5 shrink-0 text-muted-foreground" aria-hidden /> : null}
      {verb ? <span className="shrink-0 text-foreground">{verb}</span> : null}
      <span className="min-w-0 truncate">{text}</span>
      {trailing ? <span className="ml-1 shrink-0">{trailing}</span> : null}
    </span>
  )
}

function commandTitleText(command: string): string {
  // First non-empty line is the row title; the body holds the full command.
  const line = command.split("\n").find((l) => l.trim().length > 0) ?? command
  return line.trim()
}

function fileChangeActionIcon(action: ReturnType<typeof getFileChangeAction>): IconName {
  switch (action) {
    case "created":
      return "FilePlus"
    case "deleted":
      return "Trash2"
    case "renamed":
      return "FileText"
    case "edited":
      return "FileDiff"
  }
}

interface TimelineItemRowProps {
  item: ThreadEventItem
  autoExpanded: boolean
  streaming: boolean
  workspaceRootPath?: string
}

function TimelineItemRow({ item, autoExpanded, streaming, workspaceRootPath }: TimelineItemRowProps) {
  switch (item.type) {
    case "userMessage":
      return <ConversationMessageContent role="user" text={item.text} />

    case "agentMessage":
      return <ConversationMessageContent role="assistant" text={item.text} />

    case "reasoning": {
      const detail = item.content.join("\n\n") || item.summary.join("\n")
      return (
        <ExpandableTimelineRow
          title={<RowTitle text="Thought" />}
          tone="summary"
          autoExpanded={autoExpanded}
          renderBody={() => (
            <div className="whitespace-pre-wrap text-sm italic leading-relaxed text-muted-foreground">{detail}</div>
          )}
        />
      )
    }

    case "commandExecution": {
      const pending = item.status === "pending"
      const output = item.aggregatedOutput ?? ""
      const exitCode = item.status === "pending" ? null : (item.exitCode ?? null)
      return (
        <ExpandableTimelineRow
          title={
            <RowTitle
              icon="Terminal"
              text={<span className="font-mono text-xs">{commandTitleText(item.command) || "command"}</span>}
              trailing={
                item.status === "failed" ? (
                  <Icon name="CircleX" className="size-3.5 text-destructive" aria-hidden />
                ) : null
              }
            />
          }
          autoExpanded={autoExpanded}
          renderBody={() => (
            <TerminalOutputBlock commandLine={item.command} output={output} exitCode={exitCode} streaming={streaming && pending} />
          )}
        />
      )
    }

    case "fileChange": {
      if (item.changes.length === 0) {
        return <RowTitle icon="FileDiff" text="File change" />
      }
      const primary = item.changes[0]!
      const action = getFileChangeAction(primary)
      const stats = item.changes.reduce(
        (acc, c) => {
          const s = getFileChangeDiffStats(c)
          return { added: acc.added + s.added, removed: acc.removed + s.removed }
        },
        { added: 0, removed: 0 },
      )
      const label =
        item.changes.length === 1
          ? fileNameFromPath(primary.movePath ?? primary.path)
          : `${item.changes.length} files`
      return (
        <ExpandableTimelineRow
          title={
            <RowTitle
              icon={fileChangeActionIcon(action)}
              verb={getFileChangeActionPastTense(action)}
              text={<span className="font-mono text-xs">{label}</span>}
              trailing={
                stats.added > 0 || stats.removed > 0 ? (
                  <DiffStatsTally insertions={stats.added} deletions={stats.removed} hideZero />
                ) : null
              }
            />
          }
          autoExpanded={autoExpanded}
          renderBody={() => (
            <div className="flex flex-col gap-1">
              {item.changes.map((change, index) => (
                <TimelineFileDiffBlock key={index} change={change} workspaceRootPath={workspaceRootPath} />
              ))}
            </div>
          )}
        />
      )
    }

    case "toolCall": {
      const toolLabel = item.server ? `${item.server}/${item.tool}` : item.tool
      const result =
        typeof item.result === "string"
          ? item.result
          : item.result !== undefined
            ? JSON.stringify(item.result, null, 2)
            : ""
      const output = item.error ? item.error : result
      const pending = item.status === "pending"
      return (
        <ExpandableTimelineRow
          title={
            <RowTitle
              icon="Info"
              text={<span className="font-mono text-xs">{toolLabel}</span>}
              trailing={
                item.status === "failed" ? (
                  <Icon name="CircleX" className="size-3.5 text-destructive" aria-hidden />
                ) : null
              }
            />
          }
          autoExpanded={autoExpanded}
          renderBody={() => (
            <ToolCallDetailBlock toolName={toolLabel} args={item.arguments} output={output} streaming={streaming && pending} />
          )}
        />
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Step grouping. A "rendered unit" is either a standalone boundary row
// (userMessage / agentMessage / reasoning) or a step: a run of consecutive
// work items (commandExecution / toolCall / fileChange). Mirrors bb's
// buildTimelineViewRows boundary handling.
// ---------------------------------------------------------------------------

const WORK_TYPES = new Set(["commandExecution", "toolCall", "fileChange"])

function isWorkItem(item: ThreadEventItem): boolean {
  return WORK_TYPES.has(item.type)
}

function isPendingWork(item: ThreadEventItem): boolean {
  return (
    (item.type === "commandExecution" || item.type === "toolCall" || item.type === "fileChange") &&
    item.status === "pending"
  )
}

interface BoundaryUnit {
  kind: "boundary"
  item: ThreadEventItem
}
interface StepUnit {
  kind: "step"
  id: string
  items: ThreadEventItem[]
}
type RenderedUnit = BoundaryUnit | StepUnit

function groupIntoUnits(items: ThreadEventItem[]): RenderedUnit[] {
  const units: RenderedUnit[] = []
  let step: ThreadEventItem[] = []
  const flush = () => {
    if (step.length > 0) {
      units.push({ kind: "step", id: `step-${step[0]!.id}`, items: step })
      step = []
    }
  }
  for (const item of items) {
    if (isWorkItem(item)) {
      step.push(item)
    } else {
      // agentMessage / reasoning / userMessage close the open step and render
      // as their own boundary row (bb: isTimelineStepBoundary).
      flush()
      units.push({ kind: "boundary", item })
    }
  }
  flush()
  return units
}

// ---------------------------------------------------------------------------
// A collapsed step renders as a single summary row (bb step-summary, muted
// "background" tone) that expands to its individual leaf rows.
// ---------------------------------------------------------------------------

interface CollapsedStepProps {
  items: ThreadEventItem[]
  streaming: boolean
  workspaceRootPath?: string
}

function CollapsedStep({ items, streaming, workspaceRootPath }: CollapsedStepProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const onToggle = useCallback(() => setIsExpanded((v) => !v), [])
  // Completed step → past-tense verbs ("Ran 3 commands · Read 5 files").
  const label = useMemo(() => buildWorkSummaryLabel(items, false), [items])

  return (
    <ExpandablePanel
      isExpanded={isExpanded}
      onToggle={onToggle}
      headerToneClass="text-subtle-foreground transition-colors hover:text-muted-foreground focus-visible:text-muted-foreground"
      summaryContent={<span className="truncate text-sm">{label}</span>}
      className="w-full"
      headerClassName="timeline-row-header flex w-full max-w-full justify-start py-0 leading-5 px-2"
      contentClassName="px-0 pb-1 pt-0.5"
      renderBody={() => (
        <div className={cn("flex min-w-0 flex-col gap-1", STEP_CHILDREN_GUIDE_CLASS)} data-timeline-row-list="bundle">
          {items.map((item) => (
            <div key={item.id} data-timeline-row-id={item.id}>
              <TimelineItemRow
                item={item}
                autoExpanded={false}
                streaming={streaming}
                workspaceRootPath={workspaceRootPath}
              />
            </div>
          ))}
        </div>
      )}
    />
  )
}

export function ThreadTimelineFeed({
  items,
  streaming = false,
  workspaceRootPath,
  workingLabel,
  showWorking = false,
  workingIsThinking = false,
}: ThreadTimelineFeedProps) {
  const units = useMemo(() => groupIntoUnits(items), [items])

  // Mirror bb: while the run is live, the active (last) pending row auto-expands
  // and streams its output. Completed rows stay collapsed.
  const lastPendingId = useMemo(() => {
    if (!streaming) return null
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]!
      if (isPendingWork(item)) return item.id
    }
    return null
  }, [items, streaming])

  // Index of the last step unit — bb keeps the trailing step of a live run
  // expanded (it's the activity frontier), collapsing earlier closed steps.
  const lastStepIndex = useMemo(() => {
    for (let i = units.length - 1; i >= 0; i--) {
      if (units[i]!.kind === "step") return i
    }
    return -1
  }, [units])

  return (
    <AutoHeightContainer>
      <div className={cn("flex min-w-0 flex-col gap-4", NESTED_ROWS_GROUP_LINE_CLASS)} data-timeline-row-list="top-level">
        {units.map((unit, index) => {
          if (unit.kind === "boundary") {
            const autoExpanded = unit.item.id === lastPendingId
            return (
              <Fragment key={unit.item.id}>
                <div data-timeline-row-id={unit.item.id}>
                  <TimelineItemRow
                    item={unit.item}
                    autoExpanded={autoExpanded}
                    streaming={streaming}
                    workspaceRootPath={workspaceRootPath}
                  />
                </div>
              </Fragment>
            )
          }

          // A step expands inline (individual rows) when it's the live frontier
          // (last step + streaming) or holds a pending row; otherwise it
          // collapses to a one-line step-summary. A single-row step never gets
          // summarized — it renders bare (bb closeOpenStepAtBoundary).
          const hasPending = unit.items.some(isPendingWork)
          const isLiveFrontier = streaming && index === lastStepIndex
          const expanded = unit.items.length === 1 || hasPending || isLiveFrontier

          if (!expanded) {
            return (
              <Fragment key={unit.id}>
                <div data-timeline-row-id={unit.id}>
                  <CollapsedStep items={unit.items} streaming={streaming} workspaceRootPath={workspaceRootPath} />
                </div>
              </Fragment>
            )
          }

          return (
            <Fragment key={unit.id}>
              <div className="flex min-w-0 flex-col gap-4" data-timeline-row-list="step" data-timeline-row-id={unit.id}>
                {unit.items.map((item) => (
                  <div key={item.id} data-timeline-row-id={item.id}>
                    <TimelineItemRow
                      item={item}
                      autoExpanded={item.id === lastPendingId}
                      streaming={streaming}
                      workspaceRootPath={workspaceRootPath}
                    />
                  </div>
                ))}
              </div>
            </Fragment>
          )
        })}
        {showWorking ? <TimelineWorkingIndicator label={workingLabel} isThinking={workingIsThinking} /> : null}
      </div>
    </AutoHeightContainer>
  )
}
