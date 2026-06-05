// Port of bb's tool-call bundling/collapse logic, adapted to the viewer's
// trimmed `ThreadEventItem` model. Combines a sensible subset of bb's
// tool-call-parsing.ts (shell command → exploration intent classification),
// timeline-activity-intents.ts (intent → verb/detail + dedupe key), and
// timeline-view.ts / timeline-row-title.ts (summarizeTimelineWork → counts →
// human label with bb's verbs + pluralization).
//
// Reference (read-only): /Users/sawyerhood/bb/packages/thread-view/src/
//   - tool-call-parsing.ts        (parseShellCommandIntents subset)
//   - timeline-activity-intents.ts (verb/detail formatting + dedupe)
//   - timeline-view.ts            (summarizeTimelineWork + grouping)
//   - timeline-row-title.ts       (label verbs/tense)
//   - format-helpers.ts           (plural)

import type { ThreadEventItem } from "@/lib/thread-events"
import {
  getFileChangeAction,
  type FileChangeAction,
} from "@/lib/thread-view/file-change-summary"

// ---------------------------------------------------------------------------
// plural — from bb format-helpers.ts
// ---------------------------------------------------------------------------

export function plural(count: number, singular: string, pluralName?: string): string {
  return `${count} ${count === 1 ? singular : (pluralName ?? `${singular}s`)}`
}

// ---------------------------------------------------------------------------
// Activity intents — what a command/tool "really did" (exploration vs work).
// Mirrors bb's TimelineActivityIntent union (read / list_files / search /
// unknown). `unknown` means "a real command that ran", not exploration.
// ---------------------------------------------------------------------------

export type ActivityIntent =
  | { type: "read"; name: string; path: string | null }
  | { type: "list_files"; path: string | null }
  | { type: "search"; query: string | null; path: string | null }
  | { type: "unknown" }

export function isExplorationIntent(intent: ActivityIntent): boolean {
  return intent.type !== "unknown"
}

/** bb timeline-activity-intents.ts: dedupe key per intent (null = not dedupable). */
export function intentDedupeKey(intent: ActivityIntent): string | null {
  switch (intent.type) {
    case "read":
      return `read:${intent.path ?? intent.name}`
    case "list_files":
      return `list:${intent.path ?? ""}`
    case "search":
      return `search:${intent.query ?? ""}|${intent.path ?? ""}`
    case "unknown":
      return null
  }
}

export interface IntentDetailParts {
  prefix: string | null
  content: string
}

function fileNameFromPath(path: string): string {
  const normalized = path.replaceAll("\\", "/")
  const segments = normalized.split("/")
  const candidate = segments[segments.length - 1]
  return candidate && candidate.length > 0 ? candidate : path
}

/** bb timeline-activity-intents.ts: intent → verb prefix + detail content. */
export function formatIntentDetail(intent: ActivityIntent, pending: boolean): IntentDetailParts {
  switch (intent.type) {
    case "read":
      return {
        prefix: pending ? "Reading" : "Read",
        content: intent.path ? fileNameFromPath(intent.path) : intent.name,
      }
    case "list_files": {
      const verb = pending ? "Listing" : "Listed"
      return { prefix: verb, content: intent.path ? `files in ${intent.path}` : "files" }
    }
    case "search": {
      const verb = pending ? "Searching" : "Searched"
      if (intent.query && intent.path) return { prefix: verb, content: `for ${intent.query} in ${intent.path}` }
      if (intent.query) return { prefix: verb, content: `for ${intent.query}` }
      if (intent.path) return { prefix: verb, content: `in ${intent.path}` }
      return { prefix: verb, content: "files" }
    }
    case "unknown":
      return { prefix: null, content: "" }
  }
}

// ---------------------------------------------------------------------------
// Shell command classification — a focused port of bb tool-call-parsing.ts.
// We tokenize, split on &&/||/|/;, and classify the leading binary of each
// segment. Any write-shape (redirect to a real file, tee, sed -i) disqualifies
// the whole command from "exploration" → it's a real "Ran command".
// ---------------------------------------------------------------------------

interface ShellToken {
  value: string
  quoted: boolean
}

const SHELL_SEGMENT_BREAK = new Set(["&&", "||", "|", ";", "\n"])
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u

function tokenizeShell(command: string): ShellToken[] {
  const tokens: ShellToken[] = []
  let current = ""
  let hasQuoted = false
  let hasUnquoted = false
  let quote: "'" | '"' | null = null
  let escaping = false

  const flush = () => {
    const fullyQuoted = hasQuoted && !hasUnquoted
    if (current.length === 0 && !fullyQuoted) {
      hasQuoted = false
      hasUnquoted = false
      return
    }
    tokens.push({ value: current, quoted: fullyQuoted })
    current = ""
    hasQuoted = false
    hasUnquoted = false
  }

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!
    if (escaping) {
      current += ch
      if (quote !== null) hasQuoted = true
      else hasUnquoted = true
      escaping = false
      continue
    }
    if (ch === "\\") {
      if (quote === "'") {
        current += ch
        hasQuoted = true
        continue
      }
      escaping = true
      continue
    }
    if (quote) {
      if (ch === quote) {
        quote = null
        if (current.length === 0) hasQuoted = true
        continue
      }
      current += ch
      hasQuoted = true
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (ch === "\n") {
      flush()
      tokens.push({ value: "\n", quoted: false })
      continue
    }
    if (/\s/u.test(ch)) {
      flush()
      continue
    }
    if (ch === "|" || ch === "&" || ch === ";") {
      flush()
      const next = command[i + 1]
      if (next && ((ch === "|" && next === "|") || (ch === "&" && next === "&"))) {
        tokens.push({ value: `${ch}${next}`, quoted: false })
        i += 1
        continue
      }
      tokens.push({ value: ch, quoted: false })
      continue
    }
    if (ch === "<" || ch === ">") {
      flush()
      const next = command[i + 1]
      let op = ch
      let consumed = 1
      if (ch === ">" && next === ">") {
        op = ">>"
        consumed = 2
      }
      tokens.push({ value: op, quoted: false })
      i += consumed - 1
      continue
    }
    current += ch
    hasUnquoted = true
  }
  if (escaping) {
    current += "\\"
    hasUnquoted = true
  }
  flush()
  return tokens
}

function splitSegments(command: string): ShellToken[][] {
  const tokens = tokenizeShell(command)
  const segments: ShellToken[][] = []
  let current: ShellToken[] = []
  for (const token of tokens) {
    if (!token.quoted && SHELL_SEGMENT_BREAK.has(token.value)) {
      if (current.length > 0) {
        segments.push(current)
        current = []
      }
      continue
    }
    current.push(token)
  }
  if (current.length > 0) segments.push(current)
  return segments
}

function baseExecutable(token: string): string {
  const slash = token.lastIndexOf("/")
  return slash >= 0 ? token.slice(slash + 1) : token
}

function commandTokenIndex(tokens: ShellToken[]): number {
  let i = 0
  while (i < tokens.length) {
    const t = tokens[i]
    if (!t || t.quoted) break
    if (!ENV_ASSIGNMENT.test(t.value)) break
    i += 1
  }
  return i
}

function isSedInPlace(token: string): boolean {
  if (token === "--in-place" || token.startsWith("--in-place=")) return true
  return /^-i(?:$|[^-])/u.test(token)
}

/** Real-file write redirect (not /dev/null, not stderr-only) → disqualifies exploration. */
function segmentHasWrite(argTokens: ShellToken[]): boolean {
  for (let i = 0; i < argTokens.length; i += 1) {
    const t = argTokens[i]!
    if (t.quoted) continue
    if (t.value === ">" || t.value === ">>") {
      const target = argTokens[i + 1]?.value
      if (target && target !== "/dev/null") return true
    }
  }
  return false
}

const SEARCH_FLAGS_WITH_VALUE = new Set([
  "-g",
  "--glob",
  "-t",
  "--type",
  "-T",
  "--type-not",
  "-A",
  "--after-context",
  "-B",
  "--before-context",
  "-C",
  "--context",
  "-m",
  "--max-count",
])
const FIND_FLAGS_WITH_VALUE = new Set([
  "-name",
  "-iname",
  "-path",
  "-ipath",
  "-type",
  "-maxdepth",
  "-mindepth",
  "-size",
  "-mtime",
  "-mmin",
  "-regex",
  "-iregex",
])
const HEAD_TAIL_FLAGS = new Set(["-n", "-c"])
const NO_VALUE_FLAGS = new Set<string>()

function collectPositionals(argTokens: ShellToken[], flagsWithValue: ReadonlySet<string>): string[] {
  const out: string[] = []
  let i = 0
  while (i < argTokens.length) {
    const t = argTokens[i]!
    if (!t.quoted && (t.value === ">" || t.value === ">>" || t.value === "<")) {
      i += 2
      continue
    }
    if (!t.quoted && t.value.startsWith("-") && t.value !== "-") {
      i += flagsWithValue.has(t.value) ? 2 : 1
      continue
    }
    out.push(t.value)
    i += 1
  }
  return out
}

function classifySegment(tokens: ShellToken[]): ActivityIntent | "write" | null {
  const cmdIndex = commandTokenIndex(tokens)
  const cmdToken = tokens[cmdIndex]
  if (!cmdToken) return null
  const argTokens = tokens.slice(cmdIndex + 1)
  const name = baseExecutable(cmdToken.value)

  if (name === "tee") return "write"
  if (name === "sed" && argTokens.some((t) => !t.quoted && isSedInPlace(t.value))) return "write"
  if (segmentHasWrite(argTokens)) return "write"

  switch (name) {
    case "rg":
    case "grep":
    case "ag": {
      const pos = collectPositionals(argTokens, SEARCH_FLAGS_WITH_VALUE)
      return {
        type: "search",
        query: pos[0] ?? null,
        path: pos.length > 1 ? pos[pos.length - 1]! : null,
      }
    }
    case "find": {
      const pos = collectPositionals(argTokens, FIND_FLAGS_WITH_VALUE)
      const path = pos[0]
      return { type: "search", query: null, path: path ?? null }
    }
    case "ls": {
      const pos = collectPositionals(argTokens, NO_VALUE_FLAGS)
      return { type: "list_files", path: pos[0] ?? "." }
    }
    case "cat":
    case "nl":
    case "bat":
    case "less":
    case "more": {
      const pos = collectPositionals(argTokens, NO_VALUE_FLAGS)
      const path = pos[0]
      if (!path) return null
      return { type: "read", name, path }
    }
    case "head":
    case "tail": {
      const pos = collectPositionals(argTokens, HEAD_TAIL_FLAGS)
      const path = pos[0]
      if (!path) return null
      return { type: "read", name, path }
    }
    case "sed": {
      if (!argTokens.some((t) => !t.quoted && t.value === "-n")) return null
      const pos = collectPositionals(argTokens, NO_VALUE_FLAGS)
      const path = pos[1] // [script, file]
      if (!path) return null
      return { type: "read", name: "sed", path }
    }
    default:
      return null
  }
}

/** bb parseShellCommandIntents: first exploration intent across segments, or
 * none if any segment writes. */
export function parseShellCommandIntents(command: string | undefined): ActivityIntent[] {
  if (!command) return []
  const segments = splitSegments(command)
  const classifications = segments.map(classifySegment)
  if (classifications.some((c) => c === "write")) return []
  for (const c of classifications) {
    if (c && c !== "write") return [c]
  }
  return []
}

// ---------------------------------------------------------------------------
// Per-item activity intents. Commands parse their shell; structured claude
// tools (Read/Glob/Grep) map directly. Edit/Write/etc. surface as fileChange
// items, so they aren't classified here.
// ---------------------------------------------------------------------------

const STRUCTURED_READ = new Set(["Read", "read"])
const STRUCTURED_SEARCH = new Set(["Grep", "grep"])
const STRUCTURED_LIST = new Set(["Glob", "glob", "LS", "ls"])

function baseToolName(name: string): string {
  const segs = name.split(/[:/]/)
  return segs[segs.length - 1] ?? name
}

function toolArgString(args: Record<string, unknown> | undefined, keys: readonly string[]): string | null {
  if (!args) return null
  for (const k of keys) {
    const v = args[k]
    if (typeof v === "string" && v.length > 0) return v
  }
  return null
}

/**
 * Activity intents for a work item. Returns `[]` when the item is a plain
 * command/tool (no exploration) — those count as "Ran command" / "Ran tool".
 */
export function itemActivityIntents(item: ThreadEventItem): ActivityIntent[] {
  if (item.type === "commandExecution") {
    return parseShellCommandIntents(item.command)
  }
  if (item.type === "toolCall") {
    const base = baseToolName(item.server ? `${item.server}/${item.tool}` : item.tool)
    if (STRUCTURED_READ.has(base)) {
      const path = toolArgString(item.arguments, ["file_path", "path", "filePath", "notebook_path"])
      return [{ type: "read", name: "Read", path }]
    }
    if (STRUCTURED_SEARCH.has(base)) {
      const query = toolArgString(item.arguments, ["pattern", "query", "regex"])
      const path = toolArgString(item.arguments, ["path", "glob"])
      return [{ type: "search", query, path }]
    }
    if (STRUCTURED_LIST.has(base)) {
      const path = toolArgString(item.arguments, ["pattern", "path", "glob"])
      return [{ type: "list_files", path }]
    }
  }
  return []
}

export function hasExplorationIntent(item: ThreadEventItem): boolean {
  return itemActivityIntents(item).some(isExplorationIntent)
}

// ---------------------------------------------------------------------------
// Concept / category — same-concept consecutive leaves bundle together, and
// the summary phrase aggregates per category. Mirrors bb timeline-view.ts.
// ---------------------------------------------------------------------------

export type WorkConcept = "exploration" | "commands" | "tools" | "fileChanges"

export function rowConcept(item: ThreadEventItem): WorkConcept {
  switch (item.type) {
    case "commandExecution":
      return hasExplorationIntent(item) ? "exploration" : "commands"
    case "toolCall":
      return hasExplorationIntent(item) ? "exploration" : "tools"
    case "fileChange":
      return "fileChanges"
    default:
      return "tools"
  }
}

// ---------------------------------------------------------------------------
// Counts + label — port of summarizeTimelineWork + the row-title verb logic.
// ---------------------------------------------------------------------------

export type ExplorationKind = "files" | "searches" | "lists"

export interface WorkSummaryCounts {
  commands: number
  tools: number
  files: number
  searches: number
  lists: number
  createdFiles: number
  deletedFiles: number
  editedFiles: number
  renamedFiles: number
  explorationKindOrder: ExplorationKind[]
}

function fileChangeIdentity(item: Extract<ThreadEventItem, { type: "fileChange" }>): string[] {
  return item.changes.map((c) => c.movePath ?? c.path)
}

export function summarizeWork(items: ThreadEventItem[]): WorkSummaryCounts {
  const explorationKindOrder: ExplorationKind[] = []
  const seenKinds = new Set<ExplorationKind>()
  const noteKind = (kind: ExplorationKind) => {
    if (!seenKinds.has(kind)) {
      seenKinds.add(kind)
      explorationKindOrder.push(kind)
    }
  }

  const counts: WorkSummaryCounts = {
    commands: 0,
    tools: 0,
    files: 0,
    searches: 0,
    lists: 0,
    createdFiles: 0,
    deletedFiles: 0,
    editedFiles: 0,
    renamedFiles: 0,
    explorationKindOrder,
  }
  const exploredFiles = new Set<string>()
  const created = new Set<string>()
  const deleted = new Set<string>()
  const edited = new Set<string>()
  const renamed = new Set<string>()

  for (const item of items) {
    if (item.type === "commandExecution" || item.type === "toolCall") {
      const intents = itemActivityIntents(item)
      if (intents.some(isExplorationIntent)) {
        for (const intent of intents) {
          switch (intent.type) {
            case "read":
              if (intent.path) {
                exploredFiles.add(intent.path)
                noteKind("files")
              } else {
                exploredFiles.add(intent.name)
                noteKind("files")
              }
              break
            case "list_files":
              counts.lists += 1
              noteKind("lists")
              break
            case "search":
              counts.searches += 1
              noteKind("searches")
              break
            case "unknown":
              break
          }
        }
      } else if (item.type === "commandExecution") {
        counts.commands += 1
      } else {
        counts.tools += 1
      }
    } else if (item.type === "fileChange") {
      for (let i = 0; i < item.changes.length; i += 1) {
        const change = item.changes[i]!
        const identity = fileChangeIdentity(item)[i]!
        switch (getFileChangeAction(change)) {
          case "created":
            created.add(identity)
            break
          case "deleted":
            deleted.add(identity)
            break
          case "edited":
            edited.add(identity)
            break
          case "renamed":
            renamed.add(identity)
            break
        }
      }
    }
  }

  counts.files = exploredFiles.size
  counts.createdFiles = created.size
  counts.deletedFiles = deleted.size
  counts.editedFiles = edited.size
  counts.renamedFiles = renamed.size
  return counts
}

type SummaryCategory = "exploration" | "commands" | "tools" | "fileChanges"

function itemCategory(item: ThreadEventItem): SummaryCategory | null {
  switch (item.type) {
    case "commandExecution":
      return hasExplorationIntent(item) ? "exploration" : "commands"
    case "toolCall":
      return hasExplorationIntent(item) ? "exploration" : "tools"
    case "fileChange":
      return "fileChanges"
    default:
      return null
  }
}

function orderedCategories(items: ThreadEventItem[]): SummaryCategory[] {
  const out: SummaryCategory[] = []
  for (const item of items) {
    const c = itemCategory(item)
    if (c && !out.includes(c)) out.push(c)
  }
  return out
}

function explorationDetail(counts: WorkSummaryCounts): string | null {
  const parts = counts.explorationKindOrder
    .map((kind): string | null => {
      switch (kind) {
        case "files":
          return counts.files > 0 ? plural(counts.files, "file") : null
        case "searches":
          return counts.searches > 0 ? plural(counts.searches, "search", "searches") : null
        case "lists":
          return counts.lists > 0 ? plural(counts.lists, "list") : null
      }
    })
    .filter((p): p is string => p !== null)
  return parts.length === 0 ? null : parts.join(", ")
}

const FILE_CHANGE_VERBS_PAST: Record<FileChangeAction, string> = {
  created: "Created",
  deleted: "Deleted",
  edited: "Edited",
  renamed: "Renamed",
}
const FILE_CHANGE_VERBS_PRESENT: Record<FileChangeAction, string> = {
  created: "Creating",
  deleted: "Deleting",
  edited: "Editing",
  renamed: "Renaming",
}

function fileChangePhrase(counts: WorkSummaryCounts, active: boolean): string | null {
  const present = (
    [
      ["created", counts.createdFiles],
      ["deleted", counts.deletedFiles],
      ["edited", counts.editedFiles],
      ["renamed", counts.renamedFiles],
    ] as const
  )
    .filter(([, n]) => n > 0)
    .map(([action, count]) => ({ action, count }))
  if (present.length === 0) return null
  if (present.length === 1) {
    const { action, count } = present[0]!
    const verb = active ? FILE_CHANGE_VERBS_PRESENT[action] : FILE_CHANGE_VERBS_PAST[action]
    return `${verb} ${plural(count, "file")}`
  }
  const total = present.reduce((s, p) => s + p.count, 0)
  return `${active ? "Editing" : "Edited"} ${plural(total, "file")}`
}

function completedPhrase(category: SummaryCategory, counts: WorkSummaryCounts, exploration: string | null): string | null {
  switch (category) {
    case "exploration":
      return exploration ? `Explored ${exploration}` : null
    case "commands":
      return counts.commands > 0 ? `Ran ${plural(counts.commands, "command")}` : null
    case "fileChanges":
      return fileChangePhrase(counts, false)
    case "tools":
      return counts.tools > 0 ? `Ran ${plural(counts.tools, "tool")}` : null
  }
}

function activePhrase(category: SummaryCategory, counts: WorkSummaryCounts, exploration: string | null): string | null {
  switch (category) {
    case "exploration":
      return exploration ? `Exploring ${exploration}` : null
    case "commands":
      return counts.commands > 0 ? `Running ${plural(counts.commands, "command")}` : null
    case "fileChanges":
      return fileChangePhrase(counts, true)
    case "tools":
      return counts.tools > 0 ? `Running ${plural(counts.tools, "tool")}` : null
  }
}

function lowerFirst(value: string): string {
  return value.length === 0 ? value : `${value.charAt(0).toLowerCase()}${value.slice(1)}`
}

function joinPhrases(phrases: string[]): string {
  return phrases.map((p, i) => (i === 0 ? p : lowerFirst(p))).join(", ")
}

/**
 * bb buildTimelineWorkSummaryLabel: per-category phrases joined, e.g.
 * "Ran 3 commands, explored 5 files, edited 2 files". Past tense by default;
 * gerund when `active`.
 */
export function buildWorkSummaryLabel(items: ThreadEventItem[], active: boolean): string {
  const counts = summarizeWork(items)
  const exploration = explorationDetail(counts)
  const phrases = orderedCategories(items)
    .map((category) => (active ? activePhrase(category, counts, exploration) : completedPhrase(category, counts, exploration)))
    .filter((p): p is string => p !== null)
  if (phrases.length === 0) return active ? "Working" : "Worked"
  return joinPhrases(phrases)
}
