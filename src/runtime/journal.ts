// journal.jsonl — the resume log. Each completed agent() result is appended, keyed by a chained
// hash so re-running replays the unchanged prefix. See keys.ts for the hashing scheme.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import type { AgentStatus, AgentUsage, ProviderId } from "../dsl/types.js"

export interface JournalMeta {
  type: "meta"
  runId: string
  workflowFile: string
  fileHash: string
  args: unknown
  seed: number
  createdAt: number
}

export interface JournalStarted {
  type: "started"
  key: string
  index: number
  label: string
  provider: ProviderId
}

export interface JournalResult {
  type: "result"
  key: string
  index: number
  status: AgentStatus
  /** The agent's return value: final text, or the validated structured object. */
  result: unknown
  usage: AgentUsage
  provider: ProviderId
  worktreeBranch?: string
  durationMs: number
}

export type JournalEntry = JournalMeta | JournalStarted | JournalResult

export interface LoadedJournal {
  meta?: JournalMeta
  /** key -> result (last one wins on duplicates). */
  results: Map<string, JournalResult>
  /** keys that started but never produced a result (re-run on resume). */
  startedOnly: Set<string>
}

/** Root data dir: ~/.agent-workflows (override with AGENT_WORKFLOWS_HOME). */
export function dataRoot(): string {
  return process.env.AGENT_WORKFLOWS_HOME ?? join(homedir(), ".agent-workflows")
}

export function runDir(runId: string): string {
  return join(dataRoot(), "runs", runId)
}

export function journalPath(runId: string): string {
  return join(runDir(runId), "journal.jsonl")
}

export function ensureRunDir(runId: string): string {
  const dir = runDir(runId)
  mkdirSync(dir, { recursive: true })
  return dir
}

export class Journal {
  private readonly path: string
  constructor(private readonly runId: string) {
    this.path = journalPath(runId)
    mkdirSync(dirname(this.path), { recursive: true })
  }

  append(entry: JournalEntry): void {
    appendFileSync(this.path, JSON.stringify(entry) + "\n", "utf8")
  }

  static load(runId: string): LoadedJournal {
    const path = journalPath(runId)
    const out: LoadedJournal = { results: new Map(), startedOnly: new Set() }
    if (!existsSync(path)) return out
    const text = readFileSync(path, "utf8")
    for (const line of text.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let entry: JournalEntry
      try {
        entry = JSON.parse(trimmed) as JournalEntry
      } catch {
        continue // skip unparseable line
      }
      if (entry.type === "meta") out.meta = entry
      else if (entry.type === "started") out.startedOnly.add(entry.key)
      else if (entry.type === "result") {
        out.results.set(entry.key, entry)
        out.startedOnly.delete(entry.key)
      }
    }
    return out
  }
}

/** A best-effort "latest run for this workflow file" lookup for --resume-last. */
export function latestRunIdForFile(fileHashOrPath: string): string | undefined {
  const dir = join(dataRoot(), "runs")
  if (!existsSync(dir)) return undefined
  // Implemented by run-listing in cli/runs; kept here as a stable signature.
  void fileHashOrPath
  return undefined
}

export function writeResult(runId: string, value: unknown): void {
  const dir = ensureRunDir(runId)
  writeFileSync(join(dir, "result.json"), JSON.stringify(value, null, 2), "utf8")
}
